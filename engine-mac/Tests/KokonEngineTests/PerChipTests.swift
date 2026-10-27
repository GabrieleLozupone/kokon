import CoreVideo
import Metal
import XCTest
@testable import KokonEngine

/// The per-chip paths, checked for correctness on whatever Mac runs the tests: their speed needs the chip they are
/// for (`kokon-engine-mac bench`), their results do not.
final class PerChipTests: XCTestCase {
    /// `na_matmul` (the M5's neural accelerators; shader cores on older Metal 4 GPUs) against a product in double of
    /// the same fp16 operands, on shapes with several tiles along m and n and a K that is not a power of two.
    func testNeuralAcceleratorProduct() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        guard let na = NeuralAccelerators.make(device: device) else {
            throw XCTSkip("Metal 4 tensor operations unavailable: \(NeuralAccelerators.unavailable ?? "?")")
        }
        let context = try MetalContext()
        let (m, k, n) = (192, 320, 128)
        var seed: UInt64 = 11
        func random() -> Float16 {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Float16(Float(seed >> 40) / Float(1 << 24) - 0.5)
        }
        let a = (0..<(m * k)).map { _ in random() }, b = (0..<(k * n)).map { _ in random() }
        let ab = try context.scratch(a.count * 2, label: "A"), bb = try context.scratch(b.count * 2, label: "B")
        ab.contents().copyMemory(from: a, byteCount: a.count * 2)
        bb.contents().copyMemory(from: b, byteCount: b.count * 2)
        let cb = try context.scratch(m * n * 4, label: "C")
        let commands = context.queue.makeCommandBuffer()!
        try na.encode(a: (ab, 0), b: (bb, 0), c: (cb, 0), m: m, n: n, k: k, commands: commands)
        try MetalContext.finish(commands, "na_matmul")
        let c = cb.contents().assumingMemoryBound(to: Float.self)
        var worst = 0.0, scale = 0.0
        for i in 0..<m {
            for j in 0..<n {
                var s = 0.0
                for l in 0..<k { s += Double(a[i * k + l]) * Double(b[l * n + j]) }
                worst = max(worst, abs(Double(c[i * n + j]) - s))
                scale = max(scale, abs(s))
            }
        }
        XCTAssertLessThan(worst / scale, 1e-5, "fp16 products accumulated in fp32")
    }

    func testChipNames() {
        XCTAssertEqual(Chip.generation(of: "Apple M2 Pro"), 2)
        XCTAssertEqual(Chip.generation(of: "Apple M4 Max"), 4)
        XCTAssertEqual(Chip.generation(of: "Apple M10"), 10)
        XCTAssertNil(Chip.generation(of: "Intel(R) Core(TM) i9"))
        let here = Chip.current
        XCTAssertGreaterThan(here.performanceCores, 0)
        // A virtual Mac (GitHub's runners) has a paravirtual GPU that reports no Apple family.
        if MTLCreateSystemDefaultDevice()?.name.contains("Paravirtual") != true {
            XCTAssertGreaterThan(here.gpuFamily, 6)
        }
    }

    /// The first evaluation's shares from the cost model: on any chip they add up and keep each unit in its range.
    func testStartingShares() throws {
        let balancer = Balancer(aneAttention: false, chip: Chip.current)
        let rows = 4096
        let ane = try XCTUnwrap(balancer.bestAneRows(rows: rows, amx: true))
        XCTAssertTrue((1024...(rows - 512)).contains(ane) && ane % 256 == 0, "\(ane)")
        for kind in Balancer.evaluationCounts.keys {
            let amx = try XCTUnwrap(balancer.amxRows(kind: kind, rest: rows - ane))
            XCTAssertTrue(amx % 64 == 0 && amx >= 0 && amx < rows - ane, "\(kind): \(amx)")
        }
        let heads = balancer.bestHeads(ane: true, cpu: true)
        XCTAssertEqual(heads.gpu + heads.ane + heads.cpu, QwenDiT.heads)
        XCTAssertGreaterThan(heads.gpu, 0)
    }
}

extension PerChipTests {
    /// The int8 Neural Engine program (the M3/M4 path) against the exact product of its int8 operands, with K in one
    /// piece and cut in two (over 2 688).
    func testNeuralEngineInt8Product() throws {
        guard #available(macOS 26, *) else { throw XCTSkip("the int8 program needs macOS 26") }
        for (rows, k, n) in [(256, 512, 128), (256, 3072, 128)] {
            let p = try NeuralEngineProduct(rows: rows, k: k, n: n, int8: true)
            var seed = UInt64(k)
            func random() -> Int8 {
                seed = seed &* 6364136223846793005 &+ 1442695040888963407
                return Int8(Int(seed >> 56) - 128 == -128 ? 0 : Int(seed >> 56) - 128)
            }
            let x = (0..<(rows * k)).map { _ in random() }, w = (0..<(k * n)).map { _ in random() }
            for (surface, values) in [(p.x, x), (p.w, w)] {
                CVPixelBufferLockBaseAddress(surface, [])
                CVPixelBufferGetBaseAddress(surface)!.copyMemory(from: values, byteCount: values.count)
                CVPixelBufferUnlockBaseAddress(surface, [])
            }
            try p.run()
            var worst = 0.0
            p.read { y in
                for i in stride(from: 0, to: rows, by: 17) {
                    for j in 0..<n {
                        var s = 0
                        for l in 0..<k { s += Int(x[i * k + l]) * Int(w[l * n + j]) }
                        let want = Double(s) / Double(k)   // the program's 1/√K on each operand
                        worst = max(worst, abs(Double(y[i * n + j]) - want) / 16129)
                    }
                }
            }
            XCTAssertLessThan(worst, 2e-3, "\(rows)×\(k)×\(n): fp16 output of a sum bounded by 127²")
        }
    }
}
