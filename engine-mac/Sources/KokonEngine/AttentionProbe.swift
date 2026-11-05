import Accelerate
import Foundation
import Metal

/// **Where the target's attention can run** at 1024² (4 096 queries on 4 128 keys, 32 heads of 128): the GPU's flash
/// kernel, the Neural Engine (one Core ML program per shape) and the CPU (`CPUAttention`), each timed alone, ms per
/// head, and the Neural Engine and the CPU compared with an exact attention of head 0. q and k uniform in ±3 so the
/// scores spread over ±12 and the softmax is peaked as a model's is.
extension Probe {
    public static func attention() throws {
        let context = try MetalContext()
        let (heads, queries, keys, d) = (32, 4096, 4128, 128)
        let stride = heads * d
        let scale = 1 / Float(d).squareRoot()
        var seed: UInt64 = 7
        func fill(_ p: UnsafeMutablePointer<Float>, _ count: Int, _ range: Float) {
            for i in 0..<count {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                p[i] = (Float(seed >> 40) / Float(1 << 24) * 2 - 1) * range
            }
        }
        // q holds the keys' rows too (the target's queries are the last 4 096 rows); 64 rows of slack after each.
        let rows = keys + 64
        let qb = try context.scratch(rows * stride * 4, label: "q"), kb = try context.scratch(rows * stride * 4, label: "k")
        let vb = try context.scratch(rows * stride * 4, label: "v"), ob = try context.scratch(rows * stride * 4, label: "out")
        func f(_ b: MTLBuffer) -> UnsafeMutablePointer<Float> { b.contents().assumingMemoryBound(to: Float.self) }
        fill(f(qb), keys * stride, 3); fill(f(kb), keys * stride, 3); fill(f(vb), keys * stride, 1)
        let offset = keys - queries

        // Exact head 0 (fp64 sums) for the accuracy columns.
        let checkRows = 64
        var exact = [Double](repeating: 0, count: checkRows * d)
        for i in 0..<checkRows {
            let qi = f(qb) + (offset + i) * stride
            var s = [Double](repeating: 0, count: keys), peak = -Double.infinity
            for j in 0..<keys {
                var dot = 0.0
                for c in 0..<d { dot += Double(qi[c]) * Double(f(kb)[j * stride + c]) }
                s[j] = dot * Double(scale); peak = max(peak, s[j])
            }
            var sum = 0.0
            for j in 0..<keys { s[j] = exp(s[j] - peak); sum += s[j] }
            for j in 0..<keys { for c in 0..<d { exact[i * d + c] += s[j] * Double(f(vb)[j * stride + c]) / sum } }
        }
        func error(_ got: (Int, Int) -> Float) -> Double {
            var diff = 0.0, norm = 0.0
            for i in 0..<checkRows { for c in 0..<d { let e = Double(got(i, c)) - exact[i * d + c]; diff += e * e; norm += exact[i * d + c] * exact[i * d + c] } }
            return (diff / norm).squareRoot()
        }
        print("target attention at 1024²: \(queries) queries × \(keys) keys, \(heads) heads of \(d); ms per head, best of 3")

        // The GPU's flash kernel, all heads.
        struct FlashParams { var queries, keys, causal, stride: UInt32; var scale: Float; var headBase: UInt32 }
        // Packed fp16 K and V (`attention_pack_kv`) for the kernels that read them, keys padded to 128.
        struct PackParams { var keys, paddedKeys, stride, heads: UInt32 }
        let paddedKeys = (keys + 127) / 128 * 128
        let kp = try context.scratch(heads * paddedKeys * d * 2, label: "k fp16"), vp = try context.scratch(heads * paddedKeys * d * 2, label: "v fp16")
        func pack(_ commands: MTLCommandBuffer) throws {
            let e = commands.makeComputeCommandEncoder()!
            e.setComputePipelineState(try context.pipeline("attention_pack_kv"))
            e.setBuffer(kb, offset: 0, index: 0); e.setBuffer(vb, offset: 0, index: 1)
            e.setBuffer(kp, offset: 0, index: 2); e.setBuffer(vp, offset: 0, index: 3)
            var pp = PackParams(keys: UInt32(keys), paddedKeys: UInt32(paddedKeys), stride: UInt32(stride), heads: UInt32(heads))
            e.setBytes(&pp, length: MemoryLayout<PackParams>.stride, index: 4)
            e.dispatchThreads(MTLSize(width: d / 4, height: paddedKeys, depth: heads), threadsPerThreadgroup: MTLSize(width: 32, height: 8, depth: 1))
            e.endEncoding()
        }
        let packTime = try best(3) {
            let commands = context.queue.makeCommandBuffer()!
            try pack(commands)
            return try MetalContext.finish(commands, "pack")
        }
        print(String(format: "GPU attention_pack_kv, 32 heads: %.2f ms", packTime * 1e3))
        let kernels = [("flash_attention", false, 64, 256), ("flash_attention_half", false, 64, 256),
                       ("flash_attention_packed", true, 64, 256), ("flash_attention_direct", true, 64, 256)]
        for (kernel, packed, rowsPerGroup, threads) in kernels {
        let gpu = try best(3) {
            let commands = context.queue.makeCommandBuffer()!
            if packed { try pack(commands) }
            let e = commands.makeComputeCommandEncoder()!
            e.setComputePipelineState(try context.pipeline(kernel))
            e.setBuffer(qb, offset: offset * stride * 4, index: 0)
            e.setBuffer(packed ? kp : kb, offset: 0, index: 1); e.setBuffer(packed ? vp : vb, offset: 0, index: 2)
            e.setBuffer(ob, offset: offset * stride * 4, index: 3)
            var p = FlashParams(queries: UInt32(queries), keys: UInt32(keys), causal: 0, stride: UInt32(stride),
                                scale: scale * Float(M_LOG2E), headBase: 0)
            e.setBytes(&p, length: MemoryLayout<FlashParams>.stride, index: 4)
            var padded = UInt32(paddedKeys)
            if packed { e.setBytes(&padded, length: 4, index: 5) }
            e.dispatchThreadgroups(MTLSize(width: (queries + rowsPerGroup - 1) / rowsPerGroup, height: heads, depth: 1),
                                   threadsPerThreadgroup: MTLSize(width: threads, height: 1, depth: 1))
            e.endEncoding()
            return try MetalContext.finish(commands, "flash")
        }
        let gpuError = error { i, c in f(ob)[(offset + i) * stride + c] }
        // In parts: Xcode 26's compiler times out on the whole expression.
        let flops: Double = 4 * Double(queries) * Double(keys) * Double(d) * Double(heads)
        let note = packed ? " (with packing)" : ""
        print(String(format: "GPU %@%@, 32 heads: %.1f ms, %.2f ms/head, %.2f TFLOP/s; head 0 rel %.1e", kernel, note,
                     gpu * 1e3, gpu * 1e3 / Double(heads), flops / gpu / 1e12, gpuError))
        }
        // The same packed attention on Metal 4 tensor operations (the M5's neural accelerators), where it compiles.
        if let na = NeuralAttention.make(device: context.device) {
            let gpu = try best(3) {
                let commands = context.queue.makeCommandBuffer()!
                try pack(commands)
                try na.encode(q: (qb, offset * stride * 4), kp: (kp, 0), vp: (vp, 0), out: (ob, offset * stride * 4),
                              queries: queries, keys: keys, paddedKeys: paddedKeys, heads: heads, stride: stride,
                              scale: scale * Float(M_LOG2E), commands: commands)
                return try MetalContext.finish(commands, "na attention")
            }
            let flops: Double = 4 * Double(queries) * Double(keys) * Double(d) * Double(heads)
            print(String(format: "GPU na_flash_attention (with packing)%@, 32 heads: %.1f ms, %.2f ms/head, %.2f TFLOP/s; head 0 rel %.1e",
                         NeuralAttention.selected(device: context.device) ? " (selected)" : "", gpu * 1e3, gpu * 1e3 / Double(heads),
                         flops / gpu / 1e12, error { i, c in f(ob)[(offset + i) * stride + c] }))
        } else {
            print("GPU na_flash_attention unavailable: \(NeuralAttention.unavailable ?? "?")")
        }
        if ProcessInfo.processInfo.environment["KOKON_PROBE_GPU_ONLY"] == "1" { return }

        // The Neural Engine.
        for (h, l) in [(1, 4096), (4, 4096), (8, 4096), (1, 1024), (4, 1024), (8, 1024), (16, 512)] {
            let name = "Neural Engine \(h) heads × \(l) queries"
            do {
                let a = try NeuralEngineAttention(heads: h, queries: l, keys: keys)
                func write(_ surface: CVPixelBuffer, _ source: UnsafeMutablePointer<Float>, _ first: Int, _ count: Int, _ factor: Float) {
                    CVPixelBufferLockBaseAddress(surface, [])
                    let dst = CVPixelBufferGetBaseAddress(surface)!.assumingMemoryBound(to: Float16.self)
                    for hh in 0..<h { for r in 0..<count { for c in 0..<d {
                        dst[(hh * count + r) * d + c] = Float16(source[(first + r) * stride + hh * d + c] * factor)
                    } } }
                    CVPixelBufferUnlockBaseAddress(surface, [])
                }
                write(a.q, f(qb), offset, l, scale); write(a.k, f(kb), 0, keys, 1); write(a.v, f(vb), 0, keys, 1)
                try a.run()
                let t = try best(3) { let s = now(); try a.run(); return now() - s }
                CVPixelBufferLockBaseAddress(a.y, .readOnly)
                let y = CVPixelBufferGetBaseAddress(a.y)!.assumingMemoryBound(to: Float16.self)
                let e = error { i, c in Float(y[i * d + c]) }
                CVPixelBufferUnlockBaseAddress(a.y, .readOnly)
                let perHead = t * 1e3 / Double(h) * Double(queries) / Double(l)
                print(String(format: "%-48@ %7.1f ms a run, %.2f ms/head (all queries); head 0 rel %.1e", name as NSString, t * 1e3, perHead, e))
            } catch {
                print("\(name): \(error)")
            }
        }

        // The CPU.
        for (threads, single) in [(8, true), (12, true), (8, false), (4, true)] {
            BLASSetThreading(single ? BLAS_THREADING_SINGLE_THREADED : BLAS_THREADING_MULTI_THREADED)
            let h = 4
            let t = best(3) {
                let s = now()
                CPUAttention.attend(q: f(qb) + offset * stride, k: f(kb), v: f(vb), out: f(ob) + offset * stride, stride: stride,
                                    queries: queries, keys: keys, heads: 0..<h, scale: scale, threads: threads)
                return now() - s
            }
            let e = error { i, c in f(ob)[(offset + i) * stride + c] }
            print(String(format: "CPU %2d threads, BLAS %@: %.1f ms for %d heads, %.2f ms/head; head 0 rel %.1e",
                         threads, single ? "single-threaded" : "multi-threaded ", t * 1e3, h, t * 1e3 / Double(h), e))
        }
        BLASSetThreading(BLAS_THREADING_MULTI_THREADED)
    }
}
