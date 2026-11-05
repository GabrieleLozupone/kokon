import Foundation
import Metal
import MetalPerformanceShaders
import CoreVideo

/// Developer checks on real files, printed (the unit tests use small synthetic files instead).
public enum Checks {
    /// Each tensor (or one of each type when `names` is empty) unpacked on the GPU, in both layouts and
    /// both precisions, against the CPU reference.
    public static func dequant(path: String, names: [String]) throws {
        let file = try GGUFFile(path: path)
        let context = try MetalContext()
        let gpu = GPUDequant(context: context)
        var chosen = names
        if chosen.isEmpty {
            var seen = Set<UInt32>()
            for name in file.order {
                let t = file.tensors[name]!
                if t.type != nil, t.count >= 256, seen.insert(t.typeID).inserted { chosen.append(name) }
            }
        }
        for name in chosen {
            let t = try file.tensor(name)
            var reference = [Float](repeating: 0, count: t.count)
            try reference.withUnsafeMutableBufferPointer { try Dequant.tensor(file, t, into: $0.baseAddress!) }
            for output in [GPUDequant.Output.f32, .f16] {
                for transposed in [false, true] {
                    let out = try context.scratch(t.count * output.bytes, label: "check")
                    let commands = context.queue.makeCommandBuffer()!
                    try gpu.encode(t, of: file, into: out, transposed: transposed, output: output, commands: commands)
                    let seconds = try MetalContext.finish(commands, "dequant \(name)")
                    var worst: Float = 0
                    let (rows, columns) = (t.rows, t.columns)
                    for r in 0..<rows {
                        for c in 0..<columns {
                            let i = transposed ? c * rows + r : r * columns + c
                            let got: Float = output == .f32
                                ? out.contents().assumingMemoryBound(to: Float.self)[i]
                                : Float(out.contents().assumingMemoryBound(to: Float16.self)[i])
                            let want = output == .f32 ? reference[r * columns + c] : Float(Float16(reference[r * columns + c]))
                            worst = max(worst, abs(got - want))
                        }
                    }
                    let gbps = Double(t.count * output.bytes + t.bytes) / seconds / 1e9
                    print(String(format: "%@ %@ %@ %@: max |GPU - CPU| = %g, %.2f ms (%.0f GB/s)",
                                 name, t.type!.name, output == .f32 ? "f32" : "f16",
                                 transposed ? "[k,n]" : "[n,k]", worst, seconds * 1e3, gbps))
                }
            }
        }
    }
}

extension Checks {
    /// Reads a reference tensor written by `tools/reference_dit.py`.
    static func reference(_ directory: String, _ name: String) throws -> [Float] {
        let data = try Data(contentsOf: URL(fileURLWithPath: directory).appendingPathComponent(name + ".f32"))
        return data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    /// ‖a − b‖ / ‖b‖ and the largest |a − b|.
    static func compare(_ a: UnsafePointer<Float>, _ b: [Float]) -> (relative: Double, maxAbs: Float, finite: Bool) {
        var diff = 0.0, norm = 0.0, worst: Float = 0, finite = true
        for i in b.indices {
            let e = a[i] - b[i]
            if !a[i].isFinite { finite = false }
            diff += Double(e) * Double(e); norm += Double(b[i]) * Double(b[i]); worst = max(worst, abs(e))
        }
        return ((diff / max(norm, 1e-30)).squareRoot(), worst, finite)
    }

    /// One DiT evaluation against the diffusers reference in `directory` (`tools/reference_dit.py`).
    public static func dit(path: String, reference directory: String) throws {
        let meta = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: directory)
            .appendingPathComponent("meta.json"))) as! [String: Any]
        let grid = meta["grid"] as! [Int], text = meta["text"] as! Int, sigma = Float(meta["sigma"] as! Double)
        let file = try GGUFFile(path: path)
        let context = try MetalContext()
        let sequence = try QwenSequence.textToImage(text: text, target: .init(height: grid[0], width: grid[1]))
        let dit = try QwenDiT(file: file, context: context, sequence: sequence)
        print("sequence: \(sequence.count) rows (\(sequence.prefix) prefix, \(sequence.target) target), σ = \(sigma)")

        func report(_ name: String, _ got: UnsafePointer<Float>, _ want: [Float]) {
            let r = compare(got, want)
            print(String(format: "  %-22@ rel %.2e   max |Δ| %.3g%@", name as NSString, r.relative, r.maxAbs, r.finite ? "" : "   NON-FINITE"))
        }
        let rope = sequence.ropeTable()
        rope.withUnsafeBufferPointer { report("rope", $0.baseAddress!, try! reference(directory, "rope")) }
        let m = try dit.modulationRows(timesteps: [sigma, 0])
        (m.temb[0] + m.temb[1]).withUnsafeBufferPointer { report("temb", $0.baseAddress!, try! reference(directory, "temb")) }
        (m.raw[0] + m.raw[1]).withUnsafeBufferPointer { report("modulation", $0.baseAddress!, try! reference(directory, "modulation")) }

        let encoder = try reference(directory, "in_encoder"), latent = try reference(directory, "in_latent")
        _ = try dit.forward(encoder: encoder, target: latent, sigma: sigma) { name, pointer, count in
            guard let want = try? reference(directory, name) else { return }
            precondition(want.count == count, "\(name): \(count) floats, reference \(want.count)")
            report(name, pointer, want)
        }
        // Without the stage waits (and with the prefix cache, when on): timed, and its velocity checked too.
        for run in 1...2 {
            let started = DispatchTime.now().uptimeNanoseconds
            let out = try dit.forward(encoder: encoder, target: latent, sigma: sigma)
            let seconds = Double(DispatchTime.now().uptimeNanoseconds - started) * 1e-9
            out.withUnsafeBufferPointer { report("model_out, unprobed \(run)", $0.baseAddress!, try! reference(directory, "model_out")) }
            print(String(format: "evaluation: %.3f s (modulation on the CPU %.3f s)", seconds, dit.timings["modulation"] ?? 0))
        }
    }
}

extension Checks {
    /// Times DiT evaluations on random inputs at a `grid` × `grid` target (64 = 1024²) after `text` text rows.
    public static func timeDiT(path: String, grid: Int, text: Int, runs: Int) throws {
        let file = try GGUFFile(path: path)
        let context = try MetalContext()
        let sequence = try QwenSequence.textToImage(text: text, target: .init(height: grid, width: grid))
        let dit = try QwenDiT(file: file, context: context, sequence: sequence)
        var seed: UInt64 = 1
        func random(_ n: Int, _ scale: Float) -> [Float] {
            (0..<n).map { _ in
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                return (Float(seed >> 40) / Float(1 << 24) - 0.5) * scale
            }
        }
        let encoder = random(text * QwenDiT.dim, 8), latent = random(sequence.target * QwenDiT.channels, 2)
        print("sequence: \(sequence.count) rows (\(sequence.prefix) text, \(sequence.target) target)"
              + (dit.coexecutor.map { ", products split \($0.split(m: $0.rows, k: 4096, n: 4096)), attention \($0.heads)" } ?? ", GPU only"))
        for run in 0..<runs {
            let started = DispatchTime.now().uptimeNanoseconds
            let out = try dit.forward(encoder: encoder, target: latent, sigma: 0.5)
            let seconds = Double(DispatchTime.now().uptimeNanoseconds - started) * 1e-9
            if let dump = ProcessInfo.processInfo.environment["KOKON_DUMP"] {   // each evaluation's velocity, to compare builds
                try out.withUnsafeBytes { try Data($0).write(to: URL(fileURLWithPath: "\(dump).\(run + 1)")) }
            }
            print(String(format: "evaluation %d: %.2f s%@%@", run + 1, seconds, dit.timings["prefix"].map { String(format: " (prefix pass %.2f s)", $0) } ?? "",
                         out.allSatisfy(\.isFinite) ? "" : "  NON-FINITE OUTPUT"))
            if let c = dit.coexecutor {
                print(String(format: "  AMX/CPU busy %.2f s, Neural Engine busy %.2f s%@", c.amxSeconds, c.aneSeconds,
                             c.failures.isEmpty ? "" : "; FAILURES: \(c.failures.prefix(3))"))
                print(Timeline.summary(dit.balancing ? c.lastTimeline : c.timeline.drain()))
                if dit.balancing { print("  next: \(c.shares)") }
                c.resetTimings()
            }
        }
        guard ProcessInfo.processInfo.environment["KOKON_PROFILE"] != "0" else { return }
        dit.profiling = true
        _ = try dit.forward(encoder: encoder, target: latent, sigma: 0.5)
        print("profile (each operation alone, GPU seconds):")
        for (kind, seconds) in dit.timings.sorted(by: { $0.value > $1.value }) {
            print(String(format: "  %-24@ %6.2f s", kind as NSString, seconds))
        }
    }
}

extension Checks {
    /// The GPU writes the Neural Engine's operands straight into its surfaces; the product is compared with the CPU.
    public static func aneSurfaces() throws {
        let context = try MetalContext()
        let (rows, k, n) = (512, 512, 256)
        let product = try NeuralEngineProduct(rows: rows, k: k, n: n)
        let xb = try product.gpuBuffer(product.x, device: context.device)
        let wb = try product.gpuBuffer(product.w, device: context.device)
        var a = [Float](repeating: 0, count: rows * k), w = [Float](repeating: 0, count: k * n)
        for i in a.indices { a[i] = Float((i * 7919) % 97) / 97 - 0.5 }
        for i in w.indices { w[i] = Float((i * 104729) % 89) / 89 - 0.5 }
        let src = try context.scratch((a.count + w.count) * 4, label: "src")
        src.contents().copyMemory(from: a, byteCount: a.count * 4)
        (src.contents() + a.count * 4).copyMemory(from: w, byteCount: w.count * 4)
        let commands = context.queue.makeCommandBuffer()!
        let encoder = commands.makeComputeCommandEncoder()!
        encoder.setComputePipelineState(try context.pipeline("pack_half"))
        for (offset, count, target) in [(0, a.count, xb), (a.count * 4, w.count, wb)] {
            var c = UInt32(count)
            encoder.setBuffer(src, offset: offset, index: 0)
            encoder.setBuffer(target, offset: 0, index: 1)
            encoder.setBytes(&c, length: 4, index: 2)
            encoder.dispatchThreads(MTLSize(width: count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
        encoder.endEncoding()
        try MetalContext.finish(commands, "pack")
        try product.run()
        var worst: Float = 0, scale: Float = 0
        product.read { y in
            for i in 0..<rows {
                for j in 0..<n {
                    var s: Float = 0
                    for l in 0..<k { s += Float(Float16(a[i * k + l])) * Float(Float16(w[l * n + j])) }
                    worst = max(worst, abs(Float(y[i * n + j]) - s)); scale = max(scale, abs(s))
                }
            }
        }
        print(String(format: "Neural Engine on GPU-written surfaces: max |Δ| %.4g of max |y| %.4g (fp16 output)", worst, scale))
    }
}

extension Checks {
    /// The VAE decoder against `tools/reference_vae.py` (in tiles when the image needs them), then tiles against the
    /// whole graph on a random latent of `grid` × 1.4 `grid` (default 40), at the default tile and at a small one.
    public static func vae(path: String, reference directory: String, timeGrid: Int?) throws {
        let meta = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: directory)
            .appendingPathComponent("meta.json"))) as! [String: Any]
        let grid = meta["grid"] as! Int
        let context = try MetalContext()
        let vae = try QwenVAE(path: path, context: context)
        let latent = try reference(directory, "latent"), want = try reference(directory, "image")
        let started = DispatchTime.now().uptimeNanoseconds
        let got = try vae.decode(latent, height: grid, width: grid)
        let first = Double(DispatchTime.now().uptimeNanoseconds - started) * 1e-9
        let r = got.withUnsafeBufferPointer { compare($0.baseAddress!, want) }
        print(String(format: "VAE %d² → %d² (%@): rel %.2e, max |Δ| %.3g, %d levels off at most%@ (%.2f s with the graph build)",
                     grid, grid * 16, tiles(vae, grid, grid), r.relative, r.maxAbs, levels(got, want, grid * 16, grid * 16),
                     r.finite ? "" : " NON-FINITE", first))
        let (h, w) = (timeGrid ?? 40, (timeGrid ?? 40) * 7 / 5)
        let random = (0..<(64 * h * w)).map { Float(($0 * 7919) % 1000) / 500 - 1 }
        let (saved, split) = (vae.tiles, vae.split)
        (vae.tiles, vae.split) = ([], [])
        let whole = try vae.decode(random, height: h, width: w)
        for small in [false, true] {
            // The small tiles: 3–4 times each stage's halo, many seams.
            vae.split = split
            vae.tiles = small ? vae.stages.map { $0.stage.halo * 4 } : saved
            let tiled = try vae.decode(random, height: h, width: w)
            let r = tiled.withUnsafeBufferPointer { compare($0.baseAddress!, whole) }
            print(String(format: "%@ against one graph, %d × %d: rel %.2e, max |Δ| %.3g, %d levels off at most",
                         tiles(vae, h, w), h * 16, w * 16, r.relative, r.maxAbs, levels(tiled, whole, h * 16, w * 16)))
        }
        (vae.tiles, vae.split) = (saved, split)
    }

    static func tiles(_ vae: QwenVAE, _ h: Int, _ w: Int) -> String {
        vae.stages.map { stage, tile in
            let scale = QwenVAE.Stage.scale(stage.first)
            guard tile > 2 * stage.halo, scale * max(h, w) > tile else { return "\(stage)" }
            let (y, x) = (QwenVAE.spans(scale * h, tile: tile, halo: stage.halo).count,
                          QwenVAE.spans(scale * w, tile: tile, halo: stage.halo).count)
            return "\(stage) in \(y)×\(x) tiles of \(tile)"
        }.joined(separator: ", ")
    }

    /// The largest difference between two decoded images once made 8-bit.
    static func levels(_ a: [Float], _ b: [Float], _ height: Int, _ width: Int) -> Int {
        zip(QwenPipeline.pixels(a, width: width, height: height), QwenPipeline.pixels(b, width: width, height: height))
            .reduce(0) { max($0, abs(Int($1.0) - Int($1.1))) }
    }

    /// The decoder's time and memory at `grid` (64 = 1024²) as the pipeline runs it (`KOKON_VAE_TILE` to choose): the
    /// first decode with its graph builds, then two more; the footprint 1.5 s after each, and the process's peak.
    public static func timeVAE(path: String, grid: Int) throws {
        let context = try MetalContext()
        var vae = try QwenVAE(path: path, context: context)
        let random = (0..<(64 * grid * grid)).map { Float(($0 * 7919) % 1000) / 500 - 1 }
        print("VAE \(grid * 16)² in \(tiles(vae, grid, grid)), \(String(format: "footprint %.2f GB", MemoryUsage.now().footprint))")
        for run in 0..<4 {
            // The last one on a new instance, as the pipeline decodes below 32 GB (weights read, graphs compiled again).
            if run == 3 { vae = try QwenVAE(path: path, context: context) }
            let started = DispatchTime.now().uptimeNanoseconds
            try autoreleasepool { _ = try vae.decode(random, height: grid, width: grid) }
            let seconds = Double(DispatchTime.now().uptimeNanoseconds - started) * 1e-9
            // Buffers the GPU used leave the footprint within a second of their release.
            Thread.sleep(forTimeInterval: 1.5)
            let m = MemoryUsage.now()
            print(String(format: "decode %d%@: %.2f s, then footprint %.2f GB (peak %.2f GB)", run + 1, run == 3 ? " (new instance)" : "",
                         seconds, m.footprint, m.footprintPeak))
        }
    }
}

extension Checks {
    /// `na_matmul` (Metal 4 tensor operations, the M5's neural accelerators) against MPS on one of the DiT's products,
    /// fp16 operands, fp32 results: the largest difference and both timings.
    public static func neuralAccelerators(m: Int = 1536, k: Int = 4096, n: Int = 4096) throws {
        let context = try MetalContext()
        print(Chip.current)
        guard let na = NeuralAccelerators.make(device: context.device) else {
            print("na_matmul unavailable: \(NeuralAccelerators.unavailable ?? "?")")
            return
        }
        let a = try context.scratch(m * k * 2, label: "A"), b = try context.scratch(k * n * 2, label: "B")
        let c1 = try context.scratch(m * n * 4, label: "C na"), c2 = try context.scratch(m * n * 4, label: "C mps")
        var seed: UInt64 = 7
        for (buffer, count) in [(a, m * k), (b, k * n)] {
            let p = buffer.contents().assumingMemoryBound(to: Float16.self)
            for i in 0..<count {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                p[i] = Float16((Float(seed >> 40) / Float(1 << 24) - 0.5) * (buffer === a ? 4 : 0.05))
            }
        }
        let product = MPSMatrixMultiplication(device: context.device, transposeLeft: false, transposeRight: false,
                                              resultRows: m, resultColumns: n, interiorColumns: k, alpha: 1, beta: 0)
        func run(_ body: (MTLCommandBuffer) throws -> Void) throws -> Double {
            var best = Double.infinity
            for _ in 0..<5 {
                let commands = context.queue.makeCommandBuffer()!
                try body(commands)
                best = min(best, try MetalContext.finish(commands, "check-na"))
            }
            return best
        }
        let tMPS = try run {
            product.encode(commandBuffer: $0,
                           leftMatrix: MPSMatrix(buffer: a, descriptor: MPSMatrixDescriptor(rows: m, columns: k, rowBytes: k * 2, dataType: .float16)),
                           rightMatrix: MPSMatrix(buffer: b, descriptor: MPSMatrixDescriptor(rows: k, columns: n, rowBytes: n * 2, dataType: .float16)),
                           resultMatrix: MPSMatrix(buffer: c2, descriptor: MPSMatrixDescriptor(rows: m, columns: n, rowBytes: n * 4, dataType: .float32)))
        }
        let flops = 2.0 * Double(m) * Double(n) * Double(k)
        // Both tile variants (`NeuralAccelerators.simdgroups`), this chip's choice marked.
        for groups in [4, 2] {
            guard let variant = NeuralAccelerators.make(device: context.device, simdgroups: groups) else { continue }
            let tNA = try run { try variant.encode(a: (a, 0), b: (b, 0), c: (c1, 0), m: m, n: n, k: k, commands: $0) }
            let x = c1.contents().assumingMemoryBound(to: Float.self), y = c2.contents().assumingMemoryBound(to: Float.self)
            var diff = 0.0, norm = 0.0
            for i in 0..<(m * n) { diff += Double(x[i] - y[i]) * Double(x[i] - y[i]); norm += Double(y[i]) * Double(y[i]) }
            print(String(format: "%d×%d×%d: na_matmul, %d SIMD groups%@ %.2f ms (%.1f TFLOP/s), MPS %.2f ms (%.1f TFLOP/s), relative difference %.2e",
                         m, k, n, groups, groups == na.simdgroups ? " (selected)" : "", tNA * 1e3, flops / tNA / 1e12,
                         tMPS * 1e3, flops / tMPS / 1e12, (diff / norm).squareRoot()))
        }
    }
}

extension Checks {
    /// The int8 Neural Engine program (`NeuralEngineProduct.int8Program`) against the fp16 one on a tile of the DiT's
    /// products: time per run and the error of each against the exact product of the same fp32 operands.
    public static func aneInt8(rows: Int = 1792, k: Int = 4096, n: Int = 4096) throws {
        print(Chip.current)
        var seed: UInt64 = 5
        func random(_ count: Int, _ scale: Float) -> [Float] {
            (0..<count).map { _ in
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                let u = Float(seed >> 40) / Float(1 << 24) - 0.5
                return u * u * u * 8 * scale   // heavier tails than uniform, as activations
            }
        }
        let a = random(rows * k, 4), w = random(k * n, 0.05)
        // Exact product of a few rows (all columns) in double.
        let check = Array(stride(from: 0, to: rows, by: rows / 16))
        var exact = [Double](repeating: 0, count: check.count * n)
        for (r, i) in check.enumerated() {
            for l in 0..<k { let x = Double(a[i * k + l]); if x != 0 { for j in 0..<n { exact[r * n + j] += x * Double(w[l * n + j]) } } }
        }
        func error(_ value: (Int, Int) -> Double) -> Double {
            var d = 0.0, s = 0.0
            for (r, i) in check.enumerated() { for j in 0..<n { let e = exact[r * n + j]; d += (value(i, j) - e) * (value(i, j) - e); s += e * e } }
            return (d / s).squareRoot()
        }
        func time(_ p: NeuralEngineProduct) throws -> Double {
            try p.run()
            var best = Double.infinity
            for _ in 0..<10 {
                let t = DispatchTime.now().uptimeNanoseconds
                try p.run()
                best = min(best, Double(DispatchTime.now().uptimeNanoseconds - t) * 1e-9)
            }
            return best
        }
        let flops = 2.0 * Double(rows) * Double(k) * Double(n)
        // fp16, lifted as the engine does (powers of two: column max of W into [1, 2), rows bounded).
        let fp16 = try NeuralEngineProduct(rows: rows, k: k, n: n)
        let columnPeak = (0..<n).map { j in (0..<k).reduce(Float(0)) { max($0, abs(w[$1 * n + j])) } }
        let lambda = columnPeak.map { $0 > 0 ? exp2(-floor(log2($0))) : 1 }
        let sigma = (0..<rows).map { i in exp2(floor(log2(32768 / max(1e-30, (0..<k).reduce(Float(0)) { max($0, abs(a[i * k + $1]) ) } * Float(k) * 2)))) }
        fp16.write(fp16.x) { p in for i in 0..<rows { for l in 0..<k { p[i * k + l] = Float16(a[i * k + l] * sigma[i]) } } }
        fp16.write(fp16.w) { p in for l in 0..<k { for j in 0..<n { p[l * n + j] = Float16(w[l * n + j] * lambda[j]) } } }
        let t16 = try time(fp16)
        var y16 = [Float](repeating: 0, count: rows * n)
        fp16.read { y in for i in 0..<(rows * n) { y16[i] = Float(y[i]) } }
        let e16 = error { i, j in Double(y16[i * n + j]) / Double(sigma[i] * lambda[j]) }
        print(String(format: "fp16 program %d×%d×%d: %.2f ms (%.1f TFLOP/s), relative error %.2e", rows, k, n, t16 * 1e3, flops / t16 / 1e12, e16))
        // int8: rows and columns quantized by their absmax / 127.
        let int8 = try NeuralEngineProduct(rows: rows, k: k, n: n, int8: true)
        let rowScale = (0..<rows).map { i in max(1e-30, (0..<k).reduce(Float(0)) { max($0, abs(a[i * k + $1])) }) / 127 }
        let columnScale = columnPeak.map { max(1e-30, $0) / 127 }
        func q(_ v: Float) -> Int8 { Int8(max(-127, min(127, (v).rounded(.toNearestOrEven)))) }
        for (surface, fill) in [(int8.x, { (p: UnsafeMutablePointer<Int8>) in for i in 0..<rows { for l in 0..<k { p[i * k + l] = q(a[i * k + l] / rowScale[i]) } } }),
                                (int8.w, { (p: UnsafeMutablePointer<Int8>) in for l in 0..<k { for j in 0..<n { p[l * n + j] = q(w[l * n + j] / columnScale[j]) } } })] {
            CVPixelBufferLockBaseAddress(surface, [])
            fill(CVPixelBufferGetBaseAddress(surface)!.assumingMemoryBound(to: Int8.self))
            CVPixelBufferUnlockBaseAddress(surface, [])
        }
        let t8 = try time(int8)
        var y8 = [Float](repeating: 0, count: rows * n)
        int8.read { y in for i in 0..<(rows * n) { y8[i] = Float(y[i]) } }
        let e8 = error { i, j in Double(y8[i * n + j]) * Double(k) * Double(rowScale[i]) * Double(columnScale[j]) }
        print(String(format: "int8 program %d×%d×%d: %.2f ms (%.1f TOP/s), relative error %.2e", rows, k, n, t8 * 1e3, flops / t8 / 1e12, e8))
    }
}

extension Checks {
    /// The VAE encoder against `tools/reference_vae_encoder.py` (diffusers fp32): the normalized latent of its image;
    /// then the time and memory of an encode at `timeSize` (a smooth random image, as the reference's).
    public static func vaeEncoder(path: String, reference directory: String, timeSize: (width: Int, height: Int) = (1024, 1024)) throws {
        let meta = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: directory)
            .appendingPathComponent("meta.json"))) as! [String: Any]
        let size = meta["size"] as! [Int]
        let (w, h) = (size[0], size[1])
        let context = try MetalContext()
        let vae = try QwenVAE(path: path, context: context)
        let image = try reference(directory, "image"), want = try reference(directory, "latent")
        var started = DispatchTime.now().uptimeNanoseconds
        let got = try vae.encode(image, height: h, width: w)
        var seconds = Double(DispatchTime.now().uptimeNanoseconds - started) * 1e-9
        let r = got.withUnsafeBufferPointer { compare($0.baseAddress!, want) }
        print(String(format: "VAE encoder %d×%d → %d×%d latent: rel %.2e, max |Δ| %.3g%@ (%.2f s with the graphs' build)",
                     w, h, w / 16, h / 16, r.relative, r.maxAbs, r.finite ? "" : " NON-FINITE", seconds))
        let (tw, th) = timeSize
        let random = (0..<(4 * th * tw)).map { i -> Float in
            let (y, x) = ((i / tw) % th, i % tw)
            return sinf(Float(x) * 0.013 + Float(i / (tw * th))) * cosf(Float(y) * 0.021) * 0.9
        }
        for run in 1...3 {
            started = DispatchTime.now().uptimeNanoseconds
            _ = try vae.encode(random, height: th, width: tw)
            seconds = Double(DispatchTime.now().uptimeNanoseconds - started) * 1e-9
            Thread.sleep(forTimeInterval: 1.5)   // buffers the GPU used leave the footprint up to a second after their release
            let m = MemoryUsage.now()
            print(String(format: "encode %d at %d×%d: %.2f s, footprint after %.2f GB (peak %.2f GB)", run, tw, th, seconds, m.footprint, m.footprintPeak))
        }
    }
}
