import Accelerate
import Foundation
import Metal
import QuartzCore

/// **One product on the GPU, the AMX and the Neural Engine at the same time**, cut by rows:
///
///     C[m, n] = A[m, k] · W[k, n]       W already unpacked to fp32 [k, n] (the reserve) by the GPU
///       rows [0, g)            GPU, MPS fp32
///       rows [g, g + a)        AMX, BNNS fp32 on the same reserve (unified memory)
///       rows [g + a, m)        Neural Engine, fp16 in tiles of 4 096 × 4 096 (`ane.metal` packs and unpacks)
///
/// GPU timeline per product p: unpack W → pack the Neural Engine's tiles → signal `ready` = p → its own rows →
/// wait `amxDone` ≥ p and `aneDone` ≥ p → unpack the Neural Engine's rows. The two CPU workers wait on `ready`,
/// compute, signal. Each output row is computed by exactly one unit, so the split never reorders a sum.
///
/// Nothing waits on the CPU while the GPU runs: the GPU encodes ahead, the workers follow the events. A reserve
/// or a surface is rewritten only after the GPU has waited for the product that read it.
final class Coexecutor {
    struct Split: CustomStringConvertible { var gpu: Int, amx: Int, ane: Int
        var description: String { "GPU \(gpu) / AMX \(amx) / ANE \(ane) rows" }
    }

    static let tile = 4096
    let context: MetalContext
    /// The rows of every split product (the DiT's padded sequence).
    let rows: Int
    /// The Neural Engine's rows, the same for every product (its programs are compiled per row count), and the
    /// AMX's per kind of product (`"k×n"`): set by the balancing loop (`Balancer.swift`).
    private(set) var aneRows: Int
    var amxRows: [String: Int] = [:]
    typealias ProductSlot = (product: NeuralEngineProduct, x: MTLBuffer, w: MTLBuffer, y: MTLBuffer)
    /// Two sets of the three tile programs, alternating product by product: the next product's weight is packed into
    /// one set while the Neural Engine reads the other (`prepareWeight`). The sets share their input surfaces; each has
    /// its own outputs, so gate's stay beside proj's for the SwiGLU (`keepOutput`).
    private(set) var slots: [[ProductSlot]]
    /// Programs of other row counts, kept while the balancing loop may come back to them.
    private var spareSlots: [Int: [[ProductSlot]]] = [:]
    /// The set of the last product encoded; the weight packed ahead and its set.
    private var currentSet = 0
    private var packedAhead: (weight: String, set: Int)?
    /// **The Neural Engine's rows packed once per input**: q, k, v read the same rows, and so do gate and proj. Once the
    /// L of all of an input's readers is known (from their first use), its rows are scaled with one σ, from the largest L
    /// (the bound holds for each; a power of two less only moves where fp16 flushes, far below the row's values), and
    /// packed for the first reader only: the others find them in the row surfaces, which both sets share.
    /// `KOKON_SHARED_ROWS=0`: every product packs its own.
    let sharedRows = ProcessInfo.processInfo.environment["KOKON_SHARED_ROWS"] != "0"
    /// The input the row surfaces hold for its readers (A's offset), when packed with their shared σ.
    private var packedRows: (offset: Int, readers: [String])?
    var balancer: Balancer
    /// The timeline of the last evaluation, once the balancing loop has read it.
    var lastTimeline: [Timeline.Entry] = []
    let ready: MTLSharedEvent, amxDone: MTLSharedEvent, aneDone: MTLSharedEvent
    /// Signaled after the GPU's own share of each operation, for the timeline only.
    let gpuDone: MTLSharedEvent
    let listener = MTLSharedEventListener(dispatchQueue: DispatchQueue(label: "kokon.timeline"))
    let timeline = Timeline()
    var counter: UInt64 = 0
    let amxWorker = Worker(name: "kokon.amx"), aneWorker = Worker(name: "kokon.ane")
    /// σ of the Neural Engine's rows (`rows` at most).
    private let scales: MTLBuffer
    /// Per weight, its columns' λ, their lifted norms and L (`[λ (n) | norms (n) | L]`): they depend on the weight
    /// alone, so they are computed the first time it is used and kept (~11 MB for the DiT). Two full reads of every
    /// weight per evaluation, by only n threads, were most of the GPU's time alone between products.
    private var columnScales: [String: MTLBuffer] = [:]
    let aneEnabled: Bool, amxEnabled: Bool
    /// **int8 products on the Neural Engine** (`NeuralEngineProduct.int8Program`, `ane8_*` in `ane.metal`), the path
    /// libnnc (ccv) takes on the M3 and M4: W per column (its scales once per weight, the weight at each use as in
    /// fp16) and, with `KOKON_ANE_INT8=1`, A per row too; `KOKON_ANE_INT8=w8` keeps the rows fp16. Opt-in on every
    /// chip: the error does not depend on the chip, and on the M2 Pro (2026-10-25) one 1792 × 4096 × 4096 tile ran
    /// 7.0 ms in int8, 8.3 ms with int8 weights, 10.1 ms in fp16 (`check-ane8`), but the velocity at 896² went from
    /// 7.6e-4 to 4.1e-2 (int8) and 1.1e-2 (int8 weights; one scale per 4 096 values where Q4_K has one per 32).
    /// Finer scales do not close the gap (README, "Tried and not kept": 4.8e-3 with one per 32, and scales given as
    /// program inputs run slower than fp16).
    /// `bench` measures both on M3 and later. Falls back to fp16 when its programs cannot be built (macOS 26+).
    private(set) var aneInt8: Bool
    /// With `aneInt8`, the rows stay fp16 (int8 weights only, W8A16: `KOKON_ANE_INT8=w8`).
    let aneHalfRows: Bool
    static func int8Selected(_ chip: Chip) -> Bool {
        switch ProcessInfo.processInfo.environment["KOKON_ANE_INT8"] {
        case "1", "w8": return true
        default: return false
        }
    }
    static var int8Rows: Bool { ProcessInfo.processInfo.environment["KOKON_ANE_INT8"] != "w8" }
    /// **The release made visible at once**: a wait on `ready` right after its signal. On the M5 Pro (macOS 26.6) a
    /// signal inside a command buffer reaches the CPU only at the command buffer's end or at the next wait it encodes
    /// (a 3 × 20 ms test: the CPU saw the three signals at 60 / 60 / 60 ms, with a wait after each at 20 / 40 / 60).
    /// Here the next wait is after the GPU's own rows, so the AMX and the Neural Engine started only when the GPU was
    /// done, one after the other instead of together, and the timeline read the GPU's rows as ~1 ms. The wait is on a
    /// value already reached, but it is not free where signals arrive on time: on the M2 Pro (macOS 27.2) an
    /// evaluation 6.83 → 7.00 s. So it is chosen by measuring (`signalArrivesLate`), not by chip: the M5 Pro on
    /// macOS 26.6 and an M2 Max on 26.2 show the late signal, the Macs on macOS 27 did not. `KOKON_FLUSH_READY=0` / `=1`.
    let flushRelease: Bool
    static func flushReleaseSelected(_ context: MetalContext) -> Bool {
        switch ProcessInfo.processInfo.environment["KOKON_FLUSH_READY"] {
        case "0": return false
        case "1": return true
        default: return signalArrivesLate(context)
        }
    }

    nonisolated(unsafe) private static var lateSignal: Bool?
    private static let lateSignalLock = NSLock()
    /// **Whether this Mac delivers a signal inside a command buffer late** (at the command buffer's next wait or its
    /// end): ~20 ms of GPU work, a signal, ~20 ms more; the CPU sees it about halfway when signals arrive on time, near
    /// the end when they are late. Measured once per process (~50 ms, at the first co-executor), so a macOS update is
    /// seen at the next start. A failed measurement counts as on time (the path before the flush existed).
    static func signalArrivesLate(_ context: MetalContext) -> Bool {
        lateSignalLock.withLock {
            if let late = lateSignal { return late }
            let late = (try? measureLateSignal(context)) ?? false
            lateSignal = late
            return late
        }
    }

    private static func measureLateSignal(_ context: MetalContext) throws -> Bool {
        let pipeline = try context.pipeline("spin")
        let out = try context.scratch(4 << 20, label: "spin")
        func spin(_ commands: MTLCommandBuffer, _ n: UInt32) {
            var n = n
            let e = commands.makeComputeCommandEncoder()!
            e.setComputePipelineState(pipeline); e.setBuffer(out, offset: 0, index: 0); e.setBytes(&n, length: 4, index: 1)
            e.dispatchThreads(MTLSize(width: 1 << 20, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            e.endEncoding()
        }
        // Sized to ~20 ms on this GPU.
        var n: UInt32 = 64
        for _ in 0..<3 {
            guard let c = context.queue.makeCommandBuffer() else { return false }
            spin(c, n)
            let seconds = try MetalContext.finish(c, "spin")
            n = UInt32(min(Double(1 << 24), Double(n) * 0.02 / max(seconds, 1e-5)))
        }
        guard let event = context.device.makeSharedEvent(), let commands = context.queue.makeCommandBuffer() else { return false }
        spin(commands, n)
        release(event, 1, flush: false, commands)
        spin(commands, n)
        let seen = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var at = 0.0
        Thread {
            _ = event.wait(untilSignaledValue: 1, timeoutMS: 10_000)
            at = CACurrentMediaTime()
            seen.signal()
        }.start()
        try MetalContext.finish(commands, "late signal probe")
        guard seen.wait(timeout: .now() + 10) == .success else { return false }
        let (start, end) = (commands.gpuStartTime, commands.gpuEndTime)
        return at > end - 0.25 * (end - start)
    }

    /// Releases operation `p` to the AMX and the Neural Engine.
    func release(_ p: UInt64, _ commands: MTLCommandBuffer) {
        Coexecutor.release(ready, p, flush: flushRelease, commands)
    }
    static func release(_ event: MTLSharedEvent, _ p: UInt64, flush: Bool, _ commands: MTLCommandBuffer) {
        commands.encodeSignalEvent(event, value: p)
        if flush { commands.encodeWaitForEvent(event, value: p) }
    }
    /// The reserves hold fp16 weights (`QwenDiT.halfWeights`): the AMX and the Neural Engine's packing read them so.
    let halfWeights: Bool
    /// **The GPU's and the AMX's rows of A read as fp16**, cast by the GPU into `aHalf` (`KOKON_ACTIVATIONS=fp32`: off).
    /// With fp16 weights, 1024² on the M2 Pro (`time-dit`, 2026-10-25): 7.46 s per evaluation against 8.0–8.1 (fp32 A)
    /// and 8.54 with fp32 weights and `cblas_sgemm`; the AMX runs BNNS fp16 × fp16 at ~2.5 TFLOP/s alone against ~1.0
    /// for `cblas_sgemm`. The velocity at 896² against diffusers: 7.2e-4 (fp32 A 5.7e-4, fp32 weights 5.1e-4; the
    /// Neural Engine's rows are fp16 in every case).
    let halfActivations = ProcessInfo.processInfo.environment["KOKON_ACTIVATIONS"] != "fp32"
    /// The longest split product's rows: the first evaluation of a conditioning carries the prefix's rows too, and
    /// without the Neural Engine they are all cast.
    let maxRows: Int
    private lazy var aHalf: MTLBuffer? = try? context.scratch(maxRows * QwenDiT.hidden * 2, label: "A fp16")
    /// Seconds each worker spent computing (not waiting), and failures (a failure leaves rows unwritten).
    var amxSeconds = 0.0, aneSeconds = 0.0
    var failures: [String] = []
    let lock = NSLock()
    /// The target's attention cut by heads (`AttentionSplit.swift`), and the Neural Engine's programs for it.
    var heads: HeadSplit
    var attentionGroups: [[AttentionSlot]] = []
    var attentionShape = (queries: 0, keys: 0)

    init(context: MetalContext, rows: Int, maxRows: Int? = nil, ane: Bool = true, amx: Bool = true, aneAttention: Bool = false,
         halfWeights: Bool = false) throws {
        self.context = context
        self.halfWeights = halfWeights
        self.rows = rows
        self.maxRows = max(rows, maxRows ?? rows)
        self.aneEnabled = ane
        self.amxEnabled = amx
        aneInt8 = ane && Coexecutor.int8Selected(Chip.current)
        aneHalfRows = !Coexecutor.int8Rows
        flushRelease = Coexecutor.flushReleaseSelected(context)
        // The first evaluation's shares from the cost model on this chip's estimated rates (`Chip.unitScale`; on the
        // M2 Pro its measured ones). Remembered shares replace them (`recall`).
        balancer = Balancer(aneAttention: ane && aneAttention, chip: Chip.current)
        aneRows = ane ? balancer.bestAneRows(rows: rows, amx: amx) ?? min(2048, max(0, (rows - 512) / 256 * 256)) : 0
        if amx {
            for kind in Balancer.evaluationCounts.keys { amxRows[kind] = balancer.amxRows(kind: kind, rest: rows - aneRows) }
        }
        heads = HeadSplit.fromEnvironment() ?? balancer.bestHeads(ane: ane, cpu: amx)
        let device = context.device
        guard let r = device.makeSharedEvent(), let a = device.makeSharedEvent(), let e = device.makeSharedEvent(),
              let g = device.makeSharedEvent() else {
            throw MetalContext.Failure.buffer("shared events")
        }
        (ready, amxDone, aneDone, gpuDone) = (r, a, e, g)
        scales = try context.scratch(rows * 4, label: "ane row scales")
        slots = [[], []]
        do {
            slots = try productSlots(aneRows)
        } catch where aneInt8 {
            FileHandle.standardError.write(Data("int8 Neural Engine programs unavailable (\(error)); fp16 instead\n".utf8))
            aneInt8 = false
            slots = try productSlots(aneRows)
        }
    }

    /// Two sets of three programs of `rows` rows (the tiles of a product, at most 3), compiled and warmed.
    private func productSlots(_ rows: Int) throws -> [[ProductSlot]] {
        guard rows > 0 else { return [[], []] }
        let device = context.device
        let first: [ProductSlot] = try (0..<3).map { _ in
            let p = try NeuralEngineProduct(rows: rows, k: Coexecutor.tile, n: Coexecutor.tile, int8: aneInt8, halfActivations: aneHalfRows)
            try p.run()
            return (p, try p.gpuBuffer(p.x, device: device), try p.gpuBuffer(p.w, device: device), try p.gpuBuffer(p.y, device: device))
        }
        let second: [ProductSlot] = try first.map { f in
            let p = try NeuralEngineProduct(rows: rows, k: Coexecutor.tile, n: Coexecutor.tile, int8: aneInt8, halfActivations: aneHalfRows,
                                            sharing: f.product, sharingOutput: false)
            try p.run()
            return (p, f.x, try p.gpuBuffer(p.w, device: device), try p.gpuBuffer(p.y, device: device))
        }
        return [first, second]
    }

    /// Moves the Neural Engine to `rows` rows per product; between evaluations only (the GPU must be idle).
    func setAneRows(_ rows: Int) throws {
        guard rows != aneRows else { return }
        let next = try spareSlots.removeValue(forKey: rows) ?? productSlots(rows)
        if aneRows > 0 { spareSlots = [aneRows: slots] }   // the last one only: 288 MB of surfaces at 2 048 rows
        (slots, aneRows) = (next, rows)
        packedAhead = nil
        packedRows = nil
    }

    /// Whether a product takes the split: the Neural Engine's tiles need K and N in multiples of 4 096 with at
    /// most 3 tiles; below 1 024 rows the split costs more than it brings.
    func applies(m: Int, k: Int, n: Int) -> Bool {
        m >= 1024 && k % Coexecutor.tile == 0 && n % Coexecutor.tile == 0 && (k / Coexecutor.tile) * (n / Coexecutor.tile) <= 3
    }

    func split(m: Int, k: Int, n: Int) -> Split {
        // Its programs are compiled for `aneRows`: any product of at least `rows` rows (the first evaluation of a
        // conditioning carries the prefix's rows too) gives it the last `aneRows`, the GPU the extra ones.
        let ane = aneEnabled && m >= rows ? aneRows : 0
        let amx = amxEnabled ? amxRows["\(k)×\(n)"] ?? Int((Double(m) / 16 / 64).rounded()) * 64 : 0
        return Split(gpu: m - ane - amx, amx: amx, ane: ane)
    }

    struct Shape { var k, n, k0, kPart, n0, nPart, row0, rows, kParts: UInt32 }

    /// Where the kernel that writes a split product's input writes its fp16 copy, and how many rows of it: the
    /// GPU's and the AMX's (all but the Neural Engine's last ones, whatever the AMX's share). The product then takes
    /// it as cast (`castReady`), so no `pack_half` runs between the two. nil: the product casts for itself, or
    /// reads fp32. `m` padded.
    func halfInput(m: Int, k: Int, n: Int) -> (buffer: MTLBuffer, rows: Int)? {
        guard halfActivations, applies(m: m, k: k, n: n), m <= maxRows, let aHalf else { return nil }
        return (aHalf, m - split(m: m, k: k, n: n).ane)
    }

    /// **The row kernel before a split product packs its Neural Engine rows** (`layernorm_modulate_ane`, `swiglu_ane`):
    /// σ and the scaled fp16 rows straight into the input surfaces, instead of fp32 rows that `ane_row_scales` and
    /// `ane_pack_rows` read back. Once every reader's L is known (from the first evaluation on), fp16, `sharedRows` for
    /// several readers. `KOKON_FUSED_PACK=0`: the separate passes, for comparison.
    struct RowPack {
        let readers: [String], surfaces: [MTLBuffer], bounds: [MTLBuffer], boundOffset: Int, sigma: MTLBuffer
        /// The first Neural Engine row (from the product's first row), their count, K split into the tiles (MLP out).
        let first: Int, rows: Int, kSplit: Bool
    }
    let fusedPack = ProcessInfo.processInfo.environment["KOKON_FUSED_PACK"] != "0"
    /// The input (A's offset) a single-reader product finds packed by its row kernel.
    var prepacked: Int?

    func rowPack(m: Int, k: Int, n: Int, readers: [String]) -> RowPack? {
        guard fusedPack, aneEnabled, !aneInt8, halfActivations, !readers.isEmpty, readers.count == 1 || sharedRows,
              applies(m: m, k: k, n: n), m <= maxRows, m >= rows, k == Coexecutor.tile || n == Coexecutor.tile else { return nil }
        let s = split(m: m, k: k, n: n)
        let bounds = readers.compactMap { columnScales[$0] }
        guard s.ane > 0, bounds.count == readers.count else { return nil }
        let tiles = k / Coexecutor.tile * (n / Coexecutor.tile)
        return RowPack(readers: readers, surfaces: slots[0].prefix(tiles).map(\.x), bounds: bounds, boundOffset: 2 * n * 4, sigma: scales,
                       first: m - s.ane, rows: s.ane, kSplit: k > Coexecutor.tile)
    }

    /// The set of the last product encoded, whose output surfaces hold its Neural Engine rows (`keepOutput`).
    var lastSet: Int { currentSet }
    func columns(_ weight: String) -> MTLBuffer? { columnScales[weight] }

    /// Notes that the rows at `offset` were packed by their row kernel for `readers`.
    func packedByRowKernel(offset: Int, readers: [String]) {
        if readers.count > 1 { packedRows = (offset, readers) } else { prepacked = offset }
    }

    /// Encodes the split product of the weight named `weight`. `gpuRows` encodes the GPU's own rows `[0, g)` into the
    /// command buffer.
    func encode(weight: String, a: (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>),
                w: (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>),
                c: (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>),
                m: Int, k: Int, n: Int, commands: MTLCommandBuffer, readers: [String] = [],
                castReady: Bool = false, keepOutput: Bool = false, ahead: ((MTLCommandBuffer) throws -> Void)? = nil,
                gpuRows: (Int, MTLBuffer?) throws -> Void) throws {
        let s = split(m: m, k: k, n: n)
        counter += 1
        let p = counter
        open(p, kind: "\(k)×\(n)", shares: (s.gpu, s.amx, s.ane))
        let (kParts, nParts) = (k / Coexecutor.tile, n / Coexecutor.tile)
        let (lambda, state, sigma) = (0, 2 * n * 4, 0)
        func shape(kp: Int = 0, np: Int = 0) -> Shape {
            Shape(k: UInt32(k), n: UInt32(n), k0: UInt32(kp * Coexecutor.tile), kPart: UInt32(Coexecutor.tile),
                  n0: UInt32(np * Coexecutor.tile), nPart: UInt32(Coexecutor.tile), row0: UInt32(s.gpu + s.amx),
                  rows: UInt32(s.ane), kParts: UInt32(kParts))
        }
        func kernel(_ name: String, _ body: (MTLComputeCommandEncoder) throws -> Void) throws {
            let e = commands.makeComputeCommandEncoder()!
            e.label = name
            e.setComputePipelineState(try context.pipeline(name))
            try body(e)
            e.endEncoding()
        }
        // (Read only when the Neural Engine takes rows.)
        let columns = s.ane > 0 ? try columnScales(weight, w: w, k: k, n: n, commands: commands) : scales
        let set: Int
        if s.ane > 0, let ahead = packedAhead, ahead.weight == weight {
            set = ahead.set
        } else {
            set = 1 - currentSet
            if s.ane > 0 { try packWeight(w: w, k: k, n: n, columns: columns, set: set, commands: commands) }
        }
        packedAhead = nil
        currentSet = set
        let slots = self.slots[set]
        // int8 rows are scaled per row alone, so any reader's packing serves the others from the first evaluation.
        let shared = sharedRows && readers.count > 1 && readers.count <= 3 && readers.contains(weight)
            && (aneInt8 || readers.allSatisfy { columnScales[$0] != nil })
        let packed = shared && packedRows.map { $0.offset == a.offset && $0.readers == readers } ?? false
            || prepacked == a.offset
        prepacked = nil
        if s.ane > 0, !packed {
            var sh = shape()
            let bounds = shared && !aneInt8 ? readers.map { columnScales[$0]! } : [columns]   // L: fp16 only
            packedRows = shared ? (a.offset, readers) : nil
            if aneInt8 {
                try kernel(aneHalfRows ? "ane8w_row_scales" : "ane8_row_scales") { e in
                    e.setBuffer(a.buffer, offset: a.offset, index: 0); e.setBuffer(scales, offset: sigma, index: 1)
                    e.setBytes(&sh, length: MemoryLayout<Shape>.stride, index: 2)
                    e.dispatchThreadgroups(MTLSize(width: s.ane, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
                }
            } else {
                try kernel("ane_row_scales") { e in
                    e.setBuffer(a.buffer, offset: a.offset, index: 0)
                    for i in 0..<3 { e.setBuffer(bounds[min(i, bounds.count - 1)], offset: state, index: i == 0 ? 1 : 3 + i) }
                    e.setBuffer(scales, offset: sigma, index: 2)
                    e.setBytes(&sh, length: MemoryLayout<Shape>.stride, index: 3)
                    e.dispatchThreadgroups(MTLSize(width: s.ane, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
                }
            }
            for kp in 0..<kParts {
                for np in 0..<nParts {
                    let slot = slots[kp * nParts + np]
                    var t = shape(kp: kp, np: np)
                    try kernel(aneInt8 && !aneHalfRows ? "ane8_pack_rows" : "ane_pack_rows") { e in
                        e.setBuffer(a.buffer, offset: a.offset, index: 0); e.setBuffer(scales, offset: sigma, index: 1)
                        e.setBuffer(slot.x, offset: 0, index: 2)
                        e.setBytes(&t, length: MemoryLayout<Shape>.stride, index: 3)
                        e.dispatchThreads(MTLSize(width: Coexecutor.tile, height: s.ane, depth: 1),
                                          threadsPerThreadgroup: MTLSize(width: 64, height: 4, depth: 1))
                    }
                }
            }
        }
        let half = halfActivations ? aHalf : nil
        // Every row but the Neural Engine's (the same for every product), so the next product on the same A
        // (`castReady`: q, k, v; gate, proj) reuses the cast whatever its AMX share.
        if let half, !castReady {
            var count = UInt32((m - s.ane) * k)
            try kernel("pack_half") { e in
                e.setBuffer(a.buffer, offset: a.offset, index: 0); e.setBuffer(half, offset: 0, index: 1)
                e.setBytes(&count, length: 4, index: 2)
                e.dispatchThreads(MTLSize(width: Int(count), height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
        }
        if s.amx > 0 || s.ane > 0 { release(p, commands) }
        // The next weight's own work while the AMX and the Neural Engine run this product.
        try ahead?(commands)
        if s.amx > 0 {
            nonisolated(unsafe) let (pa, pw, pc) = (half.map { UnsafeRawPointer($0.contents() + s.gpu * k * 2) } ?? UnsafeRawPointer(a.pointer + s.gpu * k),
                                                    UnsafeRawPointer(w.pointer), c.pointer + s.gpu * n)
            let rows = s.amx
            amxWorker.submit { [self] in
                defer { amxDone.signaledValue = p }
                guard wait(ready, p, "AMX") else { return }
                let t = DispatchTime.now().uptimeNanoseconds
                if !CPUProduct.multiply(pa, pw, into: pc, m: rows, k: k, n: n, halfA: half != nil, halfB: halfWeights) { fail("AMX: BNNS refused \(rows)×\(k)×\(n)") }
                finished(p, \.amx, since: t)
            }
        }
        if s.ane > 0 {
            let tiles = Array(slots.prefix(kParts * nParts).map(\.product))
            aneWorker.submit { [self] in
                defer { aneDone.signaledValue = p }
                guard wait(ready, p, "ANE") else { return }
                let t = DispatchTime.now().uptimeNanoseconds
                do { for tile in tiles { try tile.run() } } catch { fail("ANE: \(error)") }
                finished(p, \.ane, since: t)
            }
        }
        try gpuRows(s.gpu, half)
        gpuFinished(p, commands)
        if s.amx > 0 { commands.encodeWaitForEvent(amxDone, value: p) }
        if s.ane > 0 {
            commands.encodeWaitForEvent(aneDone, value: p)
            // Left in its set's output surfaces for the kernel that reads them (gate and proj for the SwiGLU).
            if keepOutput { return }
            for np in 0..<nParts {
                var t = shape(np: np)
                let ys = (0..<3).map { kp in slots[min(kp, kParts - 1) * nParts + np].y }
                try kernel(aneInt8 ? aneHalfRows ? "ane8w_unpack" : "ane8_unpack" : "ane_unpack") { e in
                    for (i, y) in ys.enumerated() { e.setBuffer(y, offset: 0, index: i) }
                    e.setBuffer(columns, offset: lambda, index: 3); e.setBuffer(scales, offset: sigma, index: 4)
                    e.setBuffer(c.buffer, offset: c.offset, index: 5)
                    e.setBytes(&t, length: MemoryLayout<Shape>.stride, index: 6)
                    e.dispatchThreads(MTLSize(width: Coexecutor.tile, height: s.ane, depth: 1),
                                      threadsPerThreadgroup: MTLSize(width: 64, height: 4, depth: 1))
                }
            }
        }
    }

    func fail(_ message: String) { lock.withLock { failures.append(message) } }

    /// Waits for the GPU to reach `value`; false (and a failure) after a minute, so a broken command buffer never
    /// hangs a worker for good.
    func wait(_ event: MTLSharedEvent, _ value: UInt64, _ who: String) -> Bool {
        if event.wait(untilSignaledValue: value, timeoutMS: 60_000) { return true }
        fail("\(who): the GPU never reached product \(value)")
        return false
    }

    func kernel(_ name: String, _ commands: MTLCommandBuffer, _ body: (MTLComputeCommandEncoder) throws -> Void) throws {
        let e = commands.makeComputeCommandEncoder()!
        e.label = name
        e.setComputePipelineState(try context.pipeline(name))
        try body(e)
        e.endEncoding()
    }

    /// The weight's column scales `[λ (n) | norms (n) | L]`, encoded the first time it is used, then kept.
    func columnScales(_ weight: String, w: (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>),
                      k: Int, n: Int, commands: MTLCommandBuffer) throws -> MTLBuffer {
        if let c = columnScales[weight] { return c }
        let columns = try context.scratch((2 * n + 16) * 4, label: "λ \(weight)")
        columnScales[weight] = columns
        var sh = Shape(k: UInt32(k), n: UInt32(n), k0: 0, kPart: 0, n0: 0, nPart: 0, row0: 0, rows: 0, kParts: 0)
        if aneInt8 {   // [s (n)]: each column's int8 scale
            try kernel(halfWeights ? "ane8_columns_h" : "ane8_columns", commands) { e in
                e.setBuffer(w.buffer, offset: w.offset, index: 0); e.setBuffer(columns, offset: 0, index: 1)
                e.setBytes(&sh, length: MemoryLayout<Shape>.stride, index: 2)
                e.dispatchThreadgroups(MTLSize(width: (n + 63) / 64, height: 1, depth: 1),
                                       threadsPerThreadgroup: MTLSize(width: 64, height: 16, depth: 1))
            }
            return columns
        }
        try kernel(halfWeights ? "ane_columns_h" : "ane_columns", commands) { e in
            e.setBuffer(w.buffer, offset: w.offset, index: 0)
            e.setBuffer(columns, offset: 0, index: 1); e.setBuffer(columns, offset: n * 4, index: 2)
            e.setBytes(&sh, length: MemoryLayout<Shape>.stride, index: 3)
            e.dispatchThreadgroups(MTLSize(width: (n + 63) / 64, height: 1, depth: 1),
                                   threadsPerThreadgroup: MTLSize(width: 64, height: 16, depth: 1))
        }
        try kernel("ane_norm", commands) { e in
            e.setBuffer(columns, offset: n * 4, index: 0); e.setBuffer(columns, offset: 2 * n * 4, index: 1)
            e.setBytes(&sh, length: MemoryLayout<Shape>.stride, index: 2)
            e.dispatchThreadgroups(MTLSize(width: 1, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 1024, height: 1, depth: 1))
        }
        return columns
    }

    /// The weight's tiles, lifted, into the weight surfaces of `set`.
    private func packWeight(w: (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>), k: Int, n: Int,
                            columns: MTLBuffer, set: Int, commands: MTLCommandBuffer) throws {
        let (kParts, nParts) = (k / Coexecutor.tile, n / Coexecutor.tile)
        for kp in 0..<kParts {
            for np in 0..<nParts {
                var t = Shape(k: UInt32(k), n: UInt32(n), k0: UInt32(kp * Coexecutor.tile), kPart: UInt32(Coexecutor.tile),
                              n0: UInt32(np * Coexecutor.tile), nPart: UInt32(Coexecutor.tile), row0: 0, rows: 0, kParts: UInt32(kParts))
                try kernel(aneInt8 ? (halfWeights ? "ane8_pack_weight_h" : "ane8_pack_weight")
                                   : halfWeights ? "ane_pack_weight_h" : "ane_pack_weight", commands) { e in
                    e.setBuffer(w.buffer, offset: w.offset, index: 0); e.setBuffer(columns, offset: 0, index: 1)
                    e.setBuffer(slots[set][kp * nParts + np].w, offset: 0, index: 2)
                    e.setBytes(&t, length: MemoryLayout<Shape>.stride, index: 3)
                    e.dispatchThreads(MTLSize(width: Coexecutor.tile, height: Coexecutor.tile, depth: 1),
                                      threadsPerThreadgroup: MTLSize(width: 64, height: 4, depth: 1))
                }
            }
        }
    }

    /// Packs the next product's weight (already unpacked to fp32 [k, n] at `w`) into the set the current product does
    /// not use. Encoded inside the current product, after its release: the set was last read by the product before.
    func prepareWeight(_ weight: String, w: (buffer: MTLBuffer, offset: Int, pointer: UnsafeMutablePointer<Float>),
                       k: Int, n: Int, commands: MTLCommandBuffer) throws {
        guard aneRows > 0, applies(m: rows, k: k, n: n) else { return }
        let set = 1 - currentSet
        try packWeight(w: w, k: k, n: n, columns: try columnScales(weight, w: w, k: k, n: n, commands: commands),
                       set: set, commands: commands)
        packedAhead = (weight, set)
    }

    func resetTimings() { lock.withLock { amxSeconds = 0; aneSeconds = 0 } }

    // MARK: - the timeline

    /// Starts operation `p`'s entry and notes when the GPU releases it (`ready` reaches `p`).
    func open(_ p: UInt64, kind: String, shares: (gpu: Int, amx: Int, ane: Int)) {
        timeline.open(p, kind: kind, shares: shares)
        ready.notify(listener, atValue: p) { [timeline] _, _ in timeline.mark(p, \.released, Timeline.now()) }
    }

    /// Encodes the GPU's end-of-share signal for operation `p` and notes when it fires.
    func gpuFinished(_ p: UInt64, _ commands: MTLCommandBuffer) {
        commands.encodeSignalEvent(gpuDone, value: p)
        gpuDone.notify(listener, atValue: p) { [timeline] _, _ in timeline.mark(p, \.gpu, Timeline.now()) }
    }

    /// A worker's share of `p` done: its busy seconds, and its start and end in the timeline.
    func finished(_ p: UInt64, _ unit: WritableKeyPath<Timeline.Entry, Timeline.Span>, since start: UInt64) {
        let end = DispatchTime.now().uptimeNanoseconds
        let seconds = Double(end - start) * 1e-9
        lock.withLock { if unit == \Timeline.Entry.amx { amxSeconds += seconds } else { aneSeconds += seconds } }
        timeline.mark(p, unit, Timeline.Span(start: Double(start) * 1e-9, end: Double(end) * 1e-9))
    }
}

/// **When each split operation ran on each unit**, from the GPU's release (`ready`) to each unit's end: what the
/// balancing loop reads. Times are seconds of the uptime clock; the GPU's are noted by an event listener (tens of
/// microseconds late, against operations of milliseconds).
final class Timeline: @unchecked Sendable {
    struct Span { var start = 0.0, end = 0.0; var seconds: Double { end - start } }
    struct Entry {
        var kind: String
        var shares: (gpu: Int, amx: Int, ane: Int)
        var released = 0.0, gpu = 0.0
        var amx = Span(), ane = Span()
        /// Seconds from the release to the end of each unit's share (0 for a unit without one).
        var walls: (gpu: Double, amx: Double, ane: Double) {
            (gpu - released, shares.amx > 0 ? amx.end - released : 0, shares.ane > 0 ? ane.end - released : 0)
        }
    }
    private var entries: [UInt64: Entry] = [:]
    private let lock = NSLock()

    static func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) * 1e-9 }

    func open(_ p: UInt64, kind: String, shares: (gpu: Int, amx: Int, ane: Int)) {
        lock.withLock { entries[p] = Entry(kind: kind, shares: shares) }
    }

    func mark<T>(_ p: UInt64, _ field: WritableKeyPath<Entry, T>, _ value: T) {
        lock.withLock { entries[p]?[keyPath: field] = value }
    }

    /// The complete entries, in order, and forgets them all.
    func drain() -> [Entry] {
        lock.withLock {
            defer { entries = [:] }
            return entries.sorted { $0.key < $1.key }.map(\.value).filter { $0.released > 0 && $0.gpu > 0 }
        }
    }

    /// Per kind: operations, mean milliseconds of each unit's share from its own start (GPU: from the release),
    /// and the mean wall from release to the last unit's end.
    static func summary(_ entries: [Entry]) -> String {
        var kinds: [String] = []
        var groups: [String: [Entry]] = [:]
        for e in entries {
            if groups[e.kind] == nil { kinds.append(e.kind) }
            groups[e.kind, default: []].append(e)
        }
        // Between operations: from the last unit's end of one to the GPU's release of the next (the GPU alone:
        // unpacking, the elementwise kernels, the next weight's unpacking and packing, the waits' latency).
        var gaps: [String: (count: Int, seconds: Double)] = [:]
        for (a, b) in zip(entries, entries.dropFirst()) {
            let end = max(a.gpu, a.shares.amx > 0 ? a.amx.end : 0, a.shares.ane > 0 ? a.ane.end : 0)
            let key = "\(a.kind) → \(b.kind)"
            gaps[key] = ((gaps[key]?.count ?? 0) + 1, (gaps[key]?.seconds ?? 0) + max(0, b.released - end))
        }
        let between = gaps.sorted { $0.value.seconds > $1.value.seconds }.map {
            String(format: "    %-26@ ×%3d  %6.2f ms each, %5.2f s", $0.key as NSString, $0.value.count,
                   $0.value.seconds / Double($0.value.count) * 1e3, $0.value.seconds)
        }
        let total = gaps.values.reduce(0) { $0 + $1.seconds }
        return kinds.map { kind in
            let g = groups[kind]!, n = Double(g.count), s = g[0].shares
            func mean(_ f: (Entry) -> Double) -> Double { g.map(f).reduce(0, +) / n * 1e3 }
            return String(format: "  %-12@ ×%3d  shares %d/%d/%d   GPU %6.2f ms   AMX/CPU %6.2f ms (starts +%.2f)   ANE %6.2f ms (starts +%.2f)   wall %6.2f ms",
                          kind as NSString, g.count, s.gpu, s.amx, s.ane, mean { $0.gpu - $0.released },
                          mean { $0.amx.seconds }, mean { $0.shares.amx > 0 ? $0.amx.start - $0.released : 0 },
                          mean { $0.ane.seconds }, mean { $0.shares.ane > 0 ? $0.ane.start - $0.released : 0 },
                          mean { max($0.walls.gpu, $0.walls.amx, $0.walls.ane) })
        }.joined(separator: "\n") + String(format: "\n  between operations %.2f s:\n", total) + between.joined(separator: "\n")
    }
}

/// A thread running submitted jobs in order, at `.userInitiated` like the engine's own work thread (`EngineServer`):
/// under `.userInteractive`, the level of the apps' interface threads, the AMX's and the CPU's products (BNNS and
/// `concurrentPerform` inherit it) competed with every window on the Mac as equals, and the interface stuttered while
/// an image was made. The priority only matters when the CPU is contended; alone, the engine runs as fast.
final class Worker: @unchecked Sendable {
    private var jobs: [() -> Void] = []
    private let lock = NSLock(), available = DispatchSemaphore(value: 0)

    init(name: String) {
        let thread = Thread { [unowned self] in
            while true {
                available.wait()
                let job = lock.withLock { jobs.removeFirst() }
                job()
            }
        }
        thread.name = name
        thread.qualityOfService = .userInitiated
        thread.start()
    }

    func submit(_ job: @escaping () -> Void) {
        lock.withLock { jobs.append(job) }
        available.signal()
    }
}
