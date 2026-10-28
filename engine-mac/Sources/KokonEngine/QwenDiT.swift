import Accelerate
import Foundation
import Metal
import MetalPerformanceShaders

/// **The Qwen-Image 2.1 DiT** (`QwenImage21Transformer2DModel`, diffusers 0.42) on the GPU, fp32 activations, the
/// GGUF weights unpacked on the GPU just before each product.
///
///     encoder rows ─ txt_in (zero-centred RMSNorm, Linear, GELU tanh, Linear) ─┐
///     latent tokens ─ img_in ─────────────────────────────────────────────────┴ joint sequence x
///     σ ─ sinusoid [cos | sin] ─ timestep MLP ─ temb ─ SiLU ─ modulation.1 → [scale₁, gate₁, scale₂, gate₂]
///                                                    └ SiLU ─ norm_out.linear → final scale
///     32 × { x += tanh g₁ · to_out(SDPA(RoPE(RMS(q)), RoPE(RMS(k)), v))   on LN(x)·(1 + s₁)
///            x += tanh g₂ · out(SiLU(gate) ⊙ proj)                         on LN(x)·(1 + s₂) }
///     LN(x)·(1 + s_final) ─ proj_out → velocity of the target rows
///
/// Text and condition images read the modulation of t = 0, the target the one of σ (`causal_condition`).
/// Attention is block-causal: each prefix segment sees the keys before its end (a text segment with a causal
/// triangle), the target sees every key.
///
/// An edit's condition images are prefix too: their latent tokens go through img_in like the target's and sit in
/// their slots of the encoder's sequence (`QwenSequence`), modulated from t = 0.
public final class QwenDiT {
    public static let dim = 4096, heads = 32, headDim = 128, hidden = 12288, layers = 32, channels = 64
    static let eps: Float = 1e-6
    static let prefix = "model.diffusion_model."

    /// **Every product is submitted on a multiple of 64 rows, at least 64.** One MPS fp32 product of 8 to 32
    /// rows slows every later MPS product of the process: a 1024² evaluation with 32 text rows took 18.5 s of
    /// products against 11.4–11.6 s with 0 or 64 (M2 Pro, macOS 27, `time-dit`, 2026-10-25; Siliconed found the
    /// same on an M1 Pro). The padding rows stay zero: row kernels cover the real rows only, and the product of a
    /// zero row is zero. Slices therefore hold `padded(rows) + 64` rows.
    static func padded(_ rows: Int) -> Int { max(64, (rows + 63) / 64 * 64) }

    public let file: GGUFFile
    let context: MetalContext
    let dequant: GPUDequant
    public let sequence: QwenSequence

    /// **The working memory** and its slices, addressed by row of the joint sequence (N = prefix + target). Slices
    /// that share storage: `attended` is `normed` (free from the last q/k/v product to `to_out`), and the MLP's `h1`
    /// is q, k and v laid end to end (free from `to_out` on). With the prefix cache, the evaluations that run the
    /// target's rows alone get a memory of their own (`firstRow` = the prefix): the row slices hold rows
    /// `[prefix, N)` and start `prefix` rows before their storage, so every row index stays the joint sequence's;
    /// only K and V (the cached prefix is restored into them) and the packed K and V keep every row.
    struct Memory {
        let arena: Arena
        let firstRow: Int
        let x, normed, attended, q, k, v, o, h1, h2: Arena.Slice
        let reserves: [Arena.Slice]
        let rope, modulation, qkNorms, textNorm, textIn, textOut, latent, output, referenceLatent: Arena.Slice
        /// K and V packed for the flash kernel (`attention_pack_kv`): fp16, heads first, keys padded to 64.
        let kPacked, vPacked: Arena.Slice

        /// Floats of each slice that has storage, in order: x, normed, q, k, v, o, h2, the two reserves, then the small ones.
        static func sizes(_ sequence: QwenSequence, firstRow: Int, halfWeights: Bool) -> [Int] {
            let d = QwenDiT.dim
            let n = QwenDiT.padded(sequence.count) + 64, r = QwenDiT.padded(sequence.count - firstRow) + 64
            let s = QwenDiT.padded(sequence.target) + 64, t = QwenDiT.padded(sequence.textRows.count)
            let packed = QwenDiT.heads * (n + 63) / 64 * 64 * QwenDiT.headDim / 2
            let reserve = d * QwenDiT.hidden / (halfWeights ? 2 : 1)
            return [r * d, r * d, r * d, n * d, n * d, r * d, r * QwenDiT.hidden, reserve, reserve,
                    n * 128, 2 * 5 * d, QwenDiT.layers * 2 * QwenDiT.headDim, d, t * d, t * d,
                    s * QwenDiT.channels, s * QwenDiT.channels, packed, packed,
                    (QwenDiT.padded(sequence.images.dropLast().reduce(0) { $0 + $1.tokens }) + 64) * QwenDiT.channels]
        }

        static func bytes(_ sequence: QwenSequence, firstRow: Int, halfWeights: Bool) -> Int {
            Arena.bytes(sizes(sequence, firstRow: firstRow, halfWeights: halfWeights).map { $0 * 4 })
        }

        /// `fill`: the rows written once (RoPE table, QK norms, txt_in's norm), copied in.
        init(device: MTLDevice, sequence: QwenSequence, firstRow: Int, halfWeights: Bool,
             fill: (rope: [Float], qkNorms: [Float], textNorm: [Float])) throws {
            let sizes = Memory.sizes(sequence, firstRow: firstRow, halfWeights: halfWeights)
            let arena = try Arena(device: device, bytes: Arena.bytes(sizes.map { $0 * 4 }))
            var slices = try sizes.map { try arena.slice(floats: $0) }.makeIterator()
            let row = QwenDiT.dim * 4
            func shifted(_ s: Arena.Slice, _ rowBytes: Int) -> Arena.Slice {
                Arena.Slice(offset: s.offset - firstRow * rowBytes, bytes: s.bytes + firstRow * rowBytes)
            }
            self.arena = arena
            self.firstRow = firstRow
            x = shifted(slices.next()!, row); normed = shifted(slices.next()!, row); attended = normed
            let qStored = slices.next()!
            q = shifted(qStored, row); k = slices.next()!; v = slices.next()!
            // q, k and v are adjacent and page-sized per row: the MLP's rows fit in them (r ≤ n).
            h1 = shifted(Arena.Slice(offset: qStored.offset, bytes: qStored.bytes + k.bytes + v.bytes), QwenDiT.hidden * 4)
            o = shifted(slices.next()!, row); h2 = shifted(slices.next()!, QwenDiT.hidden * 4)
            reserves = [slices.next()!, slices.next()!]
            rope = slices.next()!; modulation = slices.next()!; qkNorms = slices.next()!; textNorm = slices.next()!
            textIn = slices.next()!; textOut = slices.next()!; latent = slices.next()!; output = slices.next()!
            kPacked = slices.next()!; vPacked = slices.next()!; referenceLatent = slices.next()!
            arena.pointer(rope).update(from: fill.rope, count: fill.rope.count)
            arena.pointer(qkNorms).update(from: fill.qkNorms, count: fill.qkNorms.count)
            arena.pointer(textNorm).update(from: fill.textNorm, count: fill.textNorm.count)
        }
    }
    /// nil only while one memory is released before the next is taken.
    private var current: Memory?
    var memory: Memory { current! }
    var arena: Arena { memory.arena }
    var x: Arena.Slice { memory.x }
    var normed: Arena.Slice { memory.normed }
    var attended: Arena.Slice { memory.attended }
    var q: Arena.Slice { memory.q }
    var k: Arena.Slice { memory.k }
    var v: Arena.Slice { memory.v }
    var o: Arena.Slice { memory.o }
    var h1: Arena.Slice { memory.h1 }
    var h2: Arena.Slice { memory.h2 }
    var reserves: [Arena.Slice] { memory.reserves }
    var rope: Arena.Slice { memory.rope }
    var modulation: Arena.Slice { memory.modulation }
    var qkNorms: Arena.Slice { memory.qkNorms }
    var textNorm: Arena.Slice { memory.textNorm }
    var textIn: Arena.Slice { memory.textIn }
    var textOut: Arena.Slice { memory.textOut }
    var latent: Arena.Slice { memory.latent }
    var output: Arena.Slice { memory.output }
    var referenceLatent: Arena.Slice { memory.referenceLatent }
    var kPacked: Arena.Slice { memory.kPacked }
    var vPacked: Arena.Slice { memory.vPacked }
    private let fill: (rope: [Float], qkNorms: [Float], textNorm: [Float])
    /// **The target's own memory for the cached evaluations** when it is at least 256 MB smaller than the whole
    /// sequence's (an edit: the references are as long as the target), so the steps after the first leave that much
    /// more room to the DiT's file pages (`KOKON_TARGET_MEMORY=0`: one memory for every evaluation; `=1`: always).
    let targetMemory: Bool
    let paddedKeys: Int
    /// **The prefix's K and V, kept per layer** (text, later reference images): the prefix sees only its own keys and
    /// the modulation of t = 0, so its rows do not change from one evaluation of an image to the next. They are
    /// saved during the first evaluation of a conditioning and every later one runs only the target's rows
    /// (`KOKON_PREFIX_CACHE=0`: the whole sequence every time). nil when off or when it would exceed `prefixCacheLimit`.
    /// **fp16** when the attention reads K and V as fp16 anyway (the packed kernel, the default): the same values to
    /// the bit for the GPU's heads (the CPU's heads read them rounded). **int8** (`q8`, one scale per 32 values) when
    /// fp16 does not fit the limit and int8 does: an edit with a 1 MP reference on 16 GB (Gabriele, 2026-10-26, below).
    /// fp32 with any `KOKON_ATTENTION` (the checks; then nothing smaller). `KOKON_PREFIX_CACHE=fp32|fp16|q8` chooses,
    /// `KOKON_PREFIX_CACHE_MB` sets the limit.
    ///
    /// int8 against fp16, the cat edit at 384 × 256 against diffusers (default path): the image within 2.4e-3, at most
    /// 7 levels off (one scale per 128 values: 3.2e-3, 16 levels, at the same speed), fp16 3.6e-4 and 2 levels.
    let prefixCache: MTLBuffer?
    public enum CacheFormat: String { case fp32, fp16, q8 }
    public let cacheFormat: CacheFormat
    /// The cache's bytes per prefix row of one layer's K or V.
    static func cacheRowBytes(_ format: CacheFormat) -> Int {
        switch format {
        case .fp32: return dim * 4
        case .fp16: return dim * 2
        case .q8: return dim + dim / (4 * q8Lanes) * 4
        }
    }
    /// SIMD lanes (4 values each) per int8 scale: 8, one scale per 32 values.
    static let q8Lanes = 8
    /// Up to 1.5 GB below 32 GB of memory, an eighth of it from there. M2 Pro 16 GB, edits with the target's own memory,
    /// alternated (2026-10-26): a 1344 × 768 reference with the int8 cache (1.20 GB) made the image 152–153 → 106–107 s
    /// (steps 17 → 10.4 s); the fp16 one (2.13 GB) 146–154 → 136–157 s, the DiT's file pages evicted and read again.
    /// 2026-10-25, fp16: a 768 × 448 reference (0.72 GB) made the steps 4.95 → 3.48 s. The value from 32 GB is not measured.
    static var prefixCacheLimit: Int { Chip.current.memoryGB < 30 ? 3 << 29 : Int(Chip.current.memoryGB * Double(1 << 30)) / 8 }
    /// The conditioning (encoder rows, then the references' tokens) whose prefix the cache holds.
    private var cachedConditioning: [Float]?
    /// Latent tokens of the condition images (every image but the last), in order.
    public var referenceTokens: Int { sequence.images.dropLast().reduce(0) { $0 + $1.tokens } }
    private var nextReserve = 0
    private var products: [String: MPSMatrixMultiplication] = [:]
    /// The AMX and the Neural Engine beside the GPU on the large products and the target's attention
    /// (`Coexecution.swift`, `AttentionSplit.swift`); nil: GPU alone. `KOKON_COEXEC=0` turns it off, `KOKON_ANE=0` /
    /// `KOKON_AMX=0` one unit, `KOKON_ANE_ATTENTION=1` heads on the Neural Engine too, `KOKON_BALANCE=0` the balancing loop.
    let coexecutor: Coexecutor?
    /// **Weights unpacked to fp16** (`KOKON_WEIGHTS=fp32`: fp32, for the accuracy checks): half the bytes the unpacking
    /// writes and every unit reads; the GPU's products are MPS fp32 × fp16 with fp32 accumulation, the AMX's BNNS the same.
    let halfWeights = ProcessInfo.processInfo.environment["KOKON_WEIGHTS"] != "fp32"
    /// The split products' GPU rows on the GPU's neural accelerators (M5; `NeuralAccelerators.swift`), else MPS.
    lazy var accelerators: NeuralAccelerators? = halfWeights && NeuralAccelerators.selected(device: context.device)
        ? NeuralAccelerators.make(device: context.device) : nil
    private var attentions: [String: GraphAttention] = [:]
    /// Seconds per phase of the last evaluation.
    public private(set) var timings: [String: Double] = [:]
    /// Checked after each layer is encoded: true stops the evaluation (`Cancelled`) once the GPU has finished what was
    /// committed, so a cancel takes effect within a layer (~0.25 s at 1024² on the M2 Pro).
    public var cancelled: () -> Bool = { false }
    public struct Cancelled: Error {}

    public init(file: GGUFFile, context: MetalContext, sequence: QwenSequence) throws {
        self.file = file
        self.context = context
        self.dequant = GPUDequant(context: context)
        self.sequence = sequence
        let d = QwenDiT.dim
        paddedKeys = (QwenDiT.padded(sequence.count) + 64 + 63) / 64 * 64

        let environment = ProcessInfo.processInfo.environment
        let limit = Int(environment["KOKON_PREFIX_CACHE_MB"] ?? "").map { $0 << 20 } ?? QwenDiT.prefixCacheLimit
        func bytes(_ format: CacheFormat) -> Int { QwenDiT.layers * 2 * sequence.prefix * QwenDiT.cacheRowBytes(format) }
        if let chosen = environment["KOKON_PREFIX_CACHE"].flatMap(CacheFormat.init(rawValue:)) {
            cacheFormat = chosen
        } else if environment["KOKON_ATTENTION"] != nil {
            cacheFormat = .fp32
        } else {
            cacheFormat = bytes(.fp16) <= limit ? .fp16 : .q8
        }
        let cacheBytes = bytes(cacheFormat)
        if environment["KOKON_PREFIX_CACHE"] != "0", sequence.prefix > 0, cacheBytes <= limit {
            prefixCache = try context.scratch(cacheBytes, label: "prefix K/V")
        } else {
            prefixCache = nil
        }
        let half = environment["KOKON_WEIGHTS"] != "fp32"   // `halfWeights`
        targetMemory = prefixCache != nil && environment["KOKON_TARGET_MEMORY"] != "0"
            && (environment["KOKON_TARGET_MEMORY"] == "1" || Memory.bytes(sequence, firstRow: 0, halfWeights: half)
                - Memory.bytes(sequence, firstRow: sequence.prefix, halfWeights: half) >= 256 << 20)
        // With the cache the split products are the target's rows; without it, the whole sequence's.
        let splitRows = QwenDiT.padded(prefixCache != nil ? sequence.target : sequence.count)
        if environment["KOKON_COEXEC"] != "0", splitRows >= 1024 {
            coexecutor = try Coexecutor(context: context, rows: splitRows, maxRows: QwenDiT.padded(sequence.count),
                                        ane: environment["KOKON_ANE"] != "0", amx: environment["KOKON_AMX"] != "0",
                                        aneAttention: environment["KOKON_ANE_ATTENTION"] == "1", halfWeights: halfWeights)
        } else {
            coexecutor = nil
        }
        if let coexecutor, environment["KOKON_BALANCE"] != "0" { try coexecutor.recall() }
        if let coexecutor, coexecutor.attentionApplies(queries: sequence.target) {
            try coexecutor.prepareAttention(queries: sequence.target, keys: sequence.count)
        }
        // Small weights unpacked once on the CPU: the QK norms of every layer, txt_in's norm as (w + 1).
        var norms: [Float] = []
        for layer in 0..<QwenDiT.layers {
            for which in ["norm_q", "norm_k"] {
                norms += try Dequant.array(file, QwenDiT.prefix + "transformer_blocks.\(layer).attn.\(which).weight").prefix(QwenDiT.headDim)
            }
        }
        let tn = try Dequant.array(file, QwenDiT.prefix + "txt_in.text_norm.weight")
        fill = (sequence.ropeTable(), norms, (0..<d).map { tn[$0] + 1 })
        current = try Memory(device: context.device, sequence: sequence, firstRow: 0, halfWeights: half, fill: fill)
    }

    /// The memory for an evaluation from joint row `firstRow` on (0, or the prefix with `targetMemory`); the other is
    /// released first, so the two never take memory at once. Between evaluations only.
    func useMemory(firstRow: Int) throws {
        guard memory.firstRow != firstRow else { return }
        current = nil
        current = try Memory(device: context.device, sequence: sequence, firstRow: firstRow, halfWeights: halfWeights, fill: fill)
        unpackedAhead = nil
    }

    /// Bytes of working memory for every row, and for the target's rows alone (nil: one memory).
    public var memoryBytes: (all: Int, target: Int?) {
        (Memory.bytes(sequence, firstRow: 0, halfWeights: halfWeights),
         targetMemory ? Memory.bytes(sequence, firstRow: sequence.prefix, halfWeights: halfWeights) : nil)
    }

    // MARK: - modulation (CPU, fp32)

    /// `[cos | sin]` of `1000 · t · ω_j`, `ω_j = exp(−ln(10⁴) · j / 128)`: QwenImage21TemporalTimesteps in fp32.
    static func sinusoid(_ t: Float) -> [Float] {
        let half = 128
        var out = [Float](repeating: 0, count: 2 * half)
        let scaled = 1000 * t
        for j in 0..<half {
            let omega = expf(-Float(log(10000.0)) * Float(j) / Float(half))
            let angle = scaled * omega
            out[j] = cosf(angle)
            out[half + j] = sinf(angle)
        }
        return out
    }

    static func silu(_ x: [Float]) -> [Float] { x.map { $0 / (1 + expf(-$0)) } }

    /// `y = W x` for each `x`, W a Linear weight `[out, in]` of the file unpacked once on the CPU.
    func linearCPU(_ name: String, _ xs: [[Float]]) throws -> [[Float]] {
        let t = try file.tensor(QwenDiT.prefix + name)
        let w = try Dequant.array(file, t.name)
        return xs.map { x in
            var y = [Float](repeating: 0, count: t.rows)
            cblas_sgemv(CblasRowMajor, CblasNoTrans, Int32(t.rows), Int32(t.columns), 1, w, Int32(t.columns), x, 1, 0, &y, 1)
            return y
        }
    }

    /// The stored modulation rows of each timestep seen (`modulationRows`): unpacking the four weights takes ~0.1 s
    /// (`modulation.1` is 268 MB in fp32), so the pipeline prepares all its timesteps at once.
    private var modulationCache: [Float: [Float]] = [:]

    /// Computes and keeps the modulation rows of `timesteps` not yet seen.
    public func prepareModulation(_ timesteps: [Float]) throws {
        let missing = Array(Set(timesteps.filter { modulationCache[$0] == nil }))
        guard !missing.isEmpty else { return }
        for (t, row) in zip(missing, try modulationRows(timesteps: missing).stored) { modulationCache[t] = row }
    }

    /// The temb, block modulation and final scale of each timestep, as stored for the kernels:
    /// `[1 + s₁, tanh g₁, 1 + s₂, tanh g₂, 1 + s_final]`, `dim` floats each.
    public func modulationRows(timesteps: [Float]) throws -> (temb: [[Float]], raw: [[Float]], stored: [[Float]]) {
        let d = QwenDiT.dim
        var raws: [[Float]] = [], stored: [[Float]] = []
        let h = try linearCPU("time_text_embed.timestep_embedder.linear_1.weight", timesteps.map(QwenDiT.sinusoid)).map(QwenDiT.silu)
        let tembs = try linearCPU("time_text_embed.timestep_embedder.linear_2.weight", h)
        let active = tembs.map(QwenDiT.silu)
        let ms = try linearCPU("modulation.1.weight", active), fs = try linearCPU("norm_out.linear.weight", active)
        for (m, f) in zip(ms, fs) {
            var row = [Float](repeating: 0, count: 5 * d)
            for j in 0..<d {
                row[j] = 1 + m[j]
                row[d + j] = tanhf(m[d + j])
                row[2 * d + j] = 1 + m[2 * d + j]
                row[3 * d + j] = tanhf(m[3 * d + j])
                row[4 * d + j] = 1 + f[j]
            }
            raws.append(m); stored.append(row)
        }
        return (tembs, raws, stored)
    }

    // MARK: - one evaluation

    /// Called with a stage's name and its rows (CPU pointer, floats) when `probe` is set; the pass then waits on
    /// the GPU at each stage. Stages: joint_in, l0_* (inside layer 0), layer0_out … layer31_out, norm_out, model_out.
    public typealias Probe = (String, UnsafePointer<Float>, Int) -> Void

    /// One evaluation: `encoder` the encoder's last layer `[T, 4096]` (all positions, image slots included),
    /// `references` the condition images' packed latent tokens `[R, 64]` (an edit; in order), `target` the target
    /// latent `[S, 64]` as packed tokens, `sigma` in [0, 1]. Returns the velocity `[S, 64]`.
    public func forward(encoder: [Float], references: [Float] = [], target: [Float], sigma: Float, probe: Probe? = nil) throws -> [Float] {
        let d = QwenDiT.dim, n = sequence.count, p = sequence.prefix, s = sequence.target
        guard references.count == referenceTokens * QwenDiT.channels else {
            throw QwenSequence.Failure.layout("\(references.count / QwenDiT.channels) reference tokens for \(referenceTokens)")
        }
        let started = DispatchTime.now().uptimeNanoseconds
        timings = [:]
        castInput = nil
        deferredResidual = nil
        // The cached path when there is a cache and no probe (the probes compare every row of every stage).
        // A new conditioning: the whole sequence once, the prefix's K and V saved on the way. A pass of the prefix
        // alone took 1.86 s at 1024² (products of 64 rows run far below the GPU's rate); riding along the first
        // evaluation it costs its 64 rows.
        let cached = prefixCache != nil && probe == nil
        let conditioning = encoder + references
        let saving = cached && cachedConditioning != conditioning
        try useMemory(firstRow: cached && !saving && targetMemory ? p : 0)
        try prepareModulation([0, sigma])
        arena.pointer(modulation).update(from: modulationCache[0]! + modulationCache[sigma]!, count: 10 * d)
        timings["modulation"] = elapsed(since: started)

        // Inputs: the text rows gathered in encoder order, the target tokens.
        for (i, row) in sequence.textRows.enumerated() {
            arena.pointer(textIn, floatOffset: i * d).update(from: Array(encoder[row.encoder * d..<(row.encoder + 1) * d]), count: d)
        }
        arena.pointer(latent).update(from: target, count: s * QwenDiT.channels)
        arena.pointer(referenceLatent).update(from: references, count: references.count)

        probing = probe != nil
        var commands = try begin()
        if !cached || saving { try embedText(commands: commands); try embedReferences(commands: commands) }
        try linear("img_in.weight", a: latent, c: x, m: s, cRow: p, commands: commands)
        if let probe { try finish(commands); probe("joint_in", arena.pointer(x), n * d); commands = try begin() }

        let rows = cached && !saving ? p..<n : 0..<n
        let mode: Pass = !cached ? .full : saving ? .saving : .target
        for layer in 0..<QwenDiT.layers {
            var stage: Stage?
            if let probe, layer == 0 {
                stage = { name, slice, current in
                    try self.finish(current)
                    probe("l0_" + name, self.arena.pointer(slice), n * d)
                    return try self.begin()
                }
            }
            try encodeLayer(layer, rows: rows, mode: mode, commands: &commands, stage: stage)
            if let probe {
                try finish(commands); probe("layer\(layer)_out", arena.pointer(x), n * d); commands = try begin()
            } else {
                commands.commit()
                if cancelled() {
                    commands.waitUntilCompleted()   // the queue runs in order: everything committed is done
                    throw Cancelled()
                }
                commands = try begin()
            }
        }
        try layerNorm(x, into: normed, rows: rows, prefixMod: 4 * d, targetMod: 5 * d + 4 * d, commands: commands)
        if let probe { try finish(commands); probe("norm_out", arena.pointer(normed), n * d); commands = try begin() }
        try linear("proj_out.weight", a: normed, aRow: p, c: output, m: s, commands: commands)
        if saving { cachedConditioning = conditioning }
        try finish(commands)
        if let coexecutor, !profiling, balancing { try coexecutor.rebalance() }
        let out = Array(UnsafeBufferPointer(start: arena.pointer(output), count: s * QwenDiT.channels))
        probe?("model_out", arena.pointer(output), s * QwenDiT.channels)
        timings["total"] = elapsed(since: started)
        return out
    }

    /// One block on all rows of `x`.
    /// A probe point inside a layer: finishes the command buffer, reads, returns the next one.
    typealias Stage = (String, Arena.Slice, MTLCommandBuffer) throws -> MTLCommandBuffer

    /// `.full`: every row. `.saving`: every row, the prefix's K and V saved into the cache. `.target`: the target's
    /// rows, the prefix's K and V restored from the cache for the attention.
    enum Pass { case full, saving, target }

    /// The text rows through txt_in, scattered into their joint rows of x.
    func embedText(commands: MTLCommandBuffer) throws {
        let d = QwenDiT.dim, textCount = sequence.textRows.count
        guard textCount > 0 else { return }
        try rmsNorm(textIn, into: textOut, rows: textCount, weight: textNorm, commands: commands)
        try linear("txt_in.in_layer.weight", a: textOut, c: textIn, m: textCount, commands: commands)
        try elementwise("gelu_tanh", [(textIn, 0)], count: textCount * d, commands: commands)
        try linear("txt_in.out_layer.weight", a: textIn, c: textOut, m: textCount, commands: commands)
        // Scatter to the joint rows, by runs.
        let blit = commands.makeBlitCommandEncoder()!
        var i = 0
        while i < textCount {
            var j = i + 1
            while j < textCount, sequence.textRows[j].joint == sequence.textRows[j - 1].joint + 1 { j += 1 }
            blit.copy(from: arena.buffer, sourceOffset: textOut.offset + i * d * 4, to: arena.buffer,
                      destinationOffset: x.offset + sequence.textRows[i].joint * d * 4, size: (j - i) * d * 4)
            i = j
        }
        blit.endEncoding()
    }

    /// The condition images' tokens through img_in (into `o`, free before the first layer), copied to their joint rows.
    func embedReferences(commands: MTLCommandBuffer) throws {
        let d = QwenDiT.dim, tokens = referenceTokens
        guard tokens > 0 else { return }
        try linear("img_in.weight", a: referenceLatent, c: o, m: tokens, commands: commands)
        let blit = commands.makeBlitCommandEncoder()!
        var at = 0
        for (i, grid) in sequence.images.dropLast().enumerated() {
            blit.copy(from: arena.buffer, sourceOffset: o.offset + at * d * 4, to: arena.buffer,
                      destinationOffset: x.offset + sequence.blockStarts[i] * d * 4, size: grid.tokens * d * 4)
            at += grid.tokens
        }
        blit.endEncoding()
    }

    /// The prefix's K and V of `layer` between k, v and the cache (`save`: into the cache).
    func copyPrefix(layer: Int, save: Bool, commands: MTLCommandBuffer) throws {
        guard let prefixCache else { return }
        if cacheFormat == .q8 {
            // Per layer and tensor: the codes, then all the scales after the codes of every layer.
            let units = sequence.prefix * QwenDiT.heads, count = sequence.prefix * QwenDiT.dim
            let scaleBytes = count / (4 * QwenDiT.q8Lanes) * 4
            for (i, slice) in [k, v].enumerated() {
                let codes = (layer * 2 + i) * count, scales = QwenDiT.layers * 2 * count + (layer * 2 + i) * scaleBytes
                try compute(save ? "pack_q8" : "widen_q8", commands: commands) { e in
                    e.setBuffer(arena.buffer, offset: slice.offset, index: 0)
                    e.setBuffer(prefixCache, offset: codes, index: 1)
                    e.setBuffer(prefixCache, offset: scales, index: 2)
                    var u = UInt32(units), lanes = UInt32(QwenDiT.q8Lanes)
                    e.setBytes(&u, length: 4, index: 3)
                    e.setBytes(&lanes, length: 4, index: 4)
                    e.dispatchThreads(MTLSize(width: units * 32, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
                }
            }
            return
        }
        if cacheFormat == .fp16 {
            let count = sequence.prefix * QwenDiT.dim
            for (i, slice) in [k, v].enumerated() {
                let cached = (layer * 2 + i) * count * 2
                try compute(save ? "pack_half" : "widen_half", commands: commands) { e in
                    e.setBuffer(save ? arena.buffer : prefixCache, offset: save ? slice.offset : cached, index: 0)
                    e.setBuffer(save ? prefixCache : arena.buffer, offset: save ? cached : slice.offset, index: 1)
                    var c = UInt32(count)
                    e.setBytes(&c, length: 4, index: 2)
                    e.dispatchThreads(MTLSize(width: count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
                }
            }
            return
        }
        let bytes = sequence.prefix * QwenDiT.dim * 4
        let blit = commands.makeBlitCommandEncoder()!
        for (i, slice) in [k, v].enumerated() {
            let cached = (layer * 2 + i) * bytes
            if save {
                blit.copy(from: arena.buffer, sourceOffset: slice.offset, to: prefixCache, destinationOffset: cached, size: bytes)
            } else {
                blit.copy(from: prefixCache, sourceOffset: cached, to: arena.buffer, destinationOffset: slice.offset, size: bytes)
            }
        }
        blit.endEncoding()
    }

    func encodeLayer(_ layer: Int, rows: Range<Int>, mode: Pass, commands: inout MTLCommandBuffer, stage: Stage? = nil) throws {
        func mark(_ name: String, _ slice: Arena.Slice) throws {
            if let stage { commands = try stage(name, slice, commands) }
        }
        let d = QwenDiT.dim, n = sequence.count, p = sequence.prefix
        let (first, count) = (rows.lowerBound, rows.count)
        let block = "transformer_blocks.\(layer)."
        let band = 5 * d   // the target's modulation row follows the prefix's
        let qkv = ["to_q", "to_k", "to_v"].map { block + "attn.\($0).weight" }
        let qkvPack = rowPack(count: count, k: d, n: d, readers: qkv)
        if let deferred = deferredResidual {   // the layer before's MLP residual, with this LN1
            deferredResidual = nil
            try residualNorm(gate: 3 * d, rows: rows, prefixMod: 0, targetMod: band, half: halfOutput(count: count, k: d, n: d),
                             pack: qkvPack, tiles: deferred.tiles, commands: commands)
        } else {
            try layerNorm(x, into: normed, rows: rows, prefixMod: 0, targetMod: band,
                          half: halfOutput(count: count, k: d, n: d), pack: qkvPack, commands: commands)
        }
        try linear(qkv[0], a: normed, aRow: first, c: q, m: count, cRow: first, next: qkv[1], readers: qkv, commands: commands)
        try linear(qkv[1], a: normed, aRow: first, c: k, m: count, cRow: first, next: qkv[2], readers: qkv, commands: commands)
        try mark("norm1", normed)
        try linear(qkv[2], a: normed, aRow: first, c: v, m: count, cRow: first, next: block + "attn.to_out.0.weight", readers: qkv, commands: commands)
        try headNormRope(q, weightOffset: (layer * 2) * QwenDiT.headDim, rows: rows, commands: commands)
        try headNormRope(k, weightOffset: (layer * 2 + 1) * QwenDiT.headDim, rows: rows, commands: commands)
        try mark("q", q); try mark("k", k); try mark("v", v)
        if mode != .target {
            for segment in sequence.segments {
                try attend(queries: segment.start, count: segment.end - segment.start, keys: segment.end,
                           causal: segment.isText, commands: commands)
            }
        }
        if mode == .saving { try copyPrefix(layer: layer, save: true, commands: commands) }
        if mode == .target { try copyPrefix(layer: layer, save: false, commands: commands) }
        try attend(queries: p, count: n - p, keys: n, causal: false, commands: commands)
        let gateProj = ["gate_layer", "proj"].map { block + "img_mlp.\($0).weight" }
        let toOut = block + "attn.to_out.0.weight"
        let gpPack = rowPack(count: count, k: d, n: QwenDiT.hidden, readers: gateProj)
        // With LN2's rows packed, to_out's Neural Engine rows stay in its output surfaces for the fused residual.
        let fuse = fusedResidual && stage == nil
        try linear(toOut, a: attended, aRow: first, c: o, m: count, cRow: first, next: gateProj[0],
                   keepOutput: fuse && gpPack != nil, commands: commands)
        if fuse {
            try residualNorm(gate: d, rows: rows, prefixMod: 2 * d, targetMod: band + 2 * d,
                             half: halfOutput(count: count, k: d, n: QwenDiT.hidden), pack: gpPack,
                             tiles: gpPack != nil ? (coexecutor!.lastSet, toOut, 1) : nil, commands: commands)
        } else {
            try mark("attn_out", o)
            try residual(gate: d, rows: rows, commands: commands)
            try mark("res1", x)
            try layerNorm(x, into: normed, rows: rows, prefixMod: 2 * d, targetMod: band + 2 * d,
                          half: halfOutput(count: count, k: d, n: QwenDiT.hidden), pack: gpPack, commands: commands)
        }
        try mark("norm2", normed)
        // With the MLP out's rows packed by the SwiGLU, gate's and proj's Neural Engine rows stay in their output
        // surfaces and the SwiGLU reads them there (no fp32 unpacking of 2 × 88 MB at 1024²).
        let mlpOut = block + "img_mlp.out.weight"
        let mlpPack = rowPack(count: count, k: QwenDiT.hidden, n: d, readers: [mlpOut])
        let keep = mlpPack != nil
        try linear(gateProj[0], a: normed, aRow: first, c: h1, m: count, cRow: first, next: gateProj[1], readers: gateProj,
                   keepOutput: keep, commands: commands)
        let gateSet = coexecutor?.lastSet ?? 0
        try linear(gateProj[1], a: normed, aRow: first, c: h2, m: count, cRow: first, next: mlpOut, readers: gateProj,
                   keepOutput: keep, commands: commands)
        try swiglu(first: first, count: count, half: halfOutput(count: count, k: QwenDiT.hidden, n: d), pack: mlpPack,
                   tiles: keep ? (gateSet, coexecutor?.lastSet ?? 0, gateProj) : nil, commands: commands)
        // The MLP's residual goes with the next layer's LN1 (`deferredResidual`), the Neural Engine's rows of the MLP
        // out read there from its output surfaces when that LN1 packs them.
        let nextQKV = ["to_q", "to_k", "to_v"].map { "transformer_blocks.\(layer + 1).attn.\($0).weight" }
        let carry = fuse && layer + 1 < QwenDiT.layers
        let keepMLP = carry && rowPack(count: count, k: d, n: d, readers: nextQKV) != nil
        try linear(mlpOut, a: h1, aRow: first, c: o, m: count, cRow: first,
                   next: layer + 1 < QwenDiT.layers ? nextQKV[0] : nil, keepOutput: keepMLP, commands: commands)
        try mark("mlp", o)
        if carry {
            deferredResidual = Deferred(tiles: keepMLP ? (coexecutor!.lastSet, mlpOut, 3) : nil)
        } else {
            try residual(gate: 3 * d, rows: rows, commands: commands)
        }
    }

    // MARK: - encoders

    /// The balancing loop after each evaluation (`Balancer.swift`); `KOKON_BALANCE=0` keeps the starting shares.
    public var balancing = ProcessInfo.processInfo.environment["KOKON_BALANCE"] != "0"

    /// When set, every operation runs in a command buffer of its own and its GPU time is added to `timings`
    /// under its kind (slower overall: the GPU idles between operations).
    public var profiling = false

    /// Encodes `body` into `commands`, or, when profiling, into its own command buffer, timed.
    func gpu(_ kind: String, _ commands: MTLCommandBuffer, _ body: (MTLCommandBuffer) throws -> Void) throws {
        guard profiling else { return try body(commands) }
        let own = try begin()
        try body(own)
        timings["gpu " + kind, default: 0] += try MetalContext.finish(own, kind)
    }

    func begin() throws -> MTLCommandBuffer {
        MPSCommandBuffer(from: context.queue)
    }

    func finish(_ commands: MTLCommandBuffer) throws {
        try MetalContext.finish(commands, "DiT")
    }

    func elapsed(since start: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start) * 1e-9 }

    /// The file's Linear weight `name` (without the prefix). Files in ComfyUI's layout (unsloth's GGUFs) fuse each
    /// block's `img_mlp.gate_layer` and `img_mlp.proj` into one `img_mlp.gate_up` `[2 · 12288, 4096]`, gate rows
    /// first (diffusers' single_file_utils and sd.cpp's qwen_image_2_1.hpp split it the same way): each half is
    /// then a view of the fused tensor's rows, a quantized row being contiguous, so nothing is copied.
    func weight(_ name: String) throws -> GGUFTensor {
        if let t = file.tensors[QwenDiT.prefix + name] { return t }
        for (part, half) in [("img_mlp.gate_layer.weight", 0), ("img_mlp.proj.weight", 1)] where name.hasSuffix(part) {
            let fused = try file.tensor(QwenDiT.prefix + name.dropLast(part.count) + "img_mlp.gate_up.weight")
            guard let type = fused.type, fused.dims.count == 2, fused.rows % 2 == 0 else {
                throw GGUFFile.Failure.unsupported("\(fused.name): \(fused.dims)")
            }
            let rows = fused.rows / 2
            return GGUFTensor(name: QwenDiT.prefix + name, dims: [fused.columns, rows], typeID: fused.typeID,
                              offset: fused.offset + half * rows * type.bytes(count: fused.columns))
        }
        return try file.tensor(QwenDiT.prefix + name)
    }

    /// The input the last split product cast to fp16 (slice offset, first row, k); forgotten by any kernel or attention.
    private var castInput: (offset: Int, row: Int, k: Int)?
    /// The weight unpacked (and packed for the Neural Engine) during the product before, and its reserve.
    private var unpackedAhead: (name: String, reserve: Int)?

    /// `C[m, n] = A[m, k] · W` with W the file's Linear `[n, k]`, unpacked to `[k, n]` (fp16, or fp32) in a reserve first.
    /// `aRow`, `cRow`: first row of A and C in their slices. `next`: the weight of the product that follows, unpacked
    /// into the other reserve and packed for the Neural Engine while the AMX and the Neural Engine run this one (the
    /// GPU's ~1.8 ms per 4096 × 4096 weight otherwise ran alone between products).
    /// `readers`: every weight that reads this same A (q, k, v; gate, proj), so the Neural Engine's rows are packed once.
    func linear(_ name: String, a: Arena.Slice, aRow: Int = 0, c: Arena.Slice, m: Int, cRow: Int = 0,
                next: String? = nil, readers: [String] = [], keepOutput: Bool = false, commands: MTLCommandBuffer) throws {
        let tensor = try weight(name)
        let (kk, nn) = (tensor.columns, tensor.rows)
        let m = QwenDiT.padded(m)
        guard (aRow + m) * kk * 4 <= a.bytes, (cRow + m) * nn * 4 <= c.bytes else {
            throw MetalContext.Failure.buffer("\(name): no room for \(m) padded rows")
        }
        let index: Int
        if let ahead = unpackedAhead, ahead.name == name {
            index = ahead.reserve
        } else {
            index = nextReserve
            try gpu("dequant", commands) {
                try dequant.encode(tensor, of: file, into: arena.buffer, outOffset: reserves[index].offset, transposed: true,
                                   output: halfWeights ? .f16 : .f32, commands: $0)
            }
        }
        unpackedAhead = nil
        nextReserve = (index + 1) % reserves.count
        let reserve = reserves[index]
        // The GPU's rows: all of them, or its share of a split product.
        func gpuRows(_ rows: Int, _ half: MTLBuffer? = nil) throws {
            if let half, let accelerators, NeuralAccelerators.fits(m: rows, n: nn, k: kk) {
                try accelerators.encode(a: (half, 0), b: (arena.buffer, reserve.offset), c: (arena.buffer, c.offset + cRow * nn * 4),
                                        m: rows, n: nn, k: kk, commands: commands)
                return
            }
            let key = "\(rows)×\(kk)×\(nn)"
            let product: MPSMatrixMultiplication
            if let existing = products[key] { product = existing } else {
                product = MPSMatrixMultiplication(device: context.device, transposeLeft: false, transposeRight: false,
                                                  resultRows: rows, resultColumns: nn, interiorColumns: kk, alpha: 1, beta: 0)
                products[key] = product
            }
            let left = half.map { MPSMatrix(buffer: $0, descriptor: MPSMatrixDescriptor(rows: rows, columns: kk, rowBytes: kk * 2, dataType: .float16)) }
                ?? MPSMatrix(buffer: arena.buffer, offset: a.offset + aRow * kk * 4,
                             descriptor: MPSMatrixDescriptor(rows: rows, columns: kk, rowBytes: kk * 4, dataType: .float32))
            let right = MPSMatrix(buffer: arena.buffer, offset: reserve.offset,
                                  descriptor: MPSMatrixDescriptor(rows: kk, columns: nn, rowBytes: nn * (halfWeights ? 2 : 4),
                                                                  dataType: halfWeights ? .float16 : .float32))
            let result = MPSMatrix(buffer: arena.buffer, offset: c.offset + cRow * nn * 4,
                                   descriptor: MPSMatrixDescriptor(rows: rows, columns: nn, rowBytes: nn * 4, dataType: .float32))
            try gpu(m < 512 ? "products (few rows)" : "products", commands) {
                product.encode(commandBuffer: $0, leftMatrix: left, rightMatrix: right, resultMatrix: result)
            }
        }
        if let coexecutor, !profiling, coexecutor.applies(m: m, k: kk, n: nn) {
            func operand(_ slice: Arena.Slice, _ row: Int, _ width: Int) -> (MTLBuffer, Int, UnsafeMutablePointer<Float>) {
                (arena.buffer, slice.offset + row * width * 4, arena.pointer(slice, floatOffset: row * width))
            }
            var ahead: ((MTLCommandBuffer) throws -> Void)?
            if let next {
                let t = try weight(next), other = nextReserve
                ahead = { [self] commands in
                    try dequant.encode(t, of: file, into: arena.buffer, outOffset: reserves[other].offset, transposed: true,
                                       output: halfWeights ? .f16 : .f32, commands: commands)
                    try coexecutor.prepareWeight(next, w: operand(reserves[other], 0, t.rows), k: t.columns, n: t.rows, commands: commands)
                    unpackedAhead = (next, other)
                }
            }
            let ready = castInput.map { $0 == (a.offset, aRow, kk) } ?? false
            try coexecutor.encode(weight: name, a: operand(a, aRow, kk), w: operand(reserve, 0, nn), c: operand(c, cRow, nn),
                                  m: m, k: kk, n: nn, commands: commands, readers: readers, castReady: ready, keepOutput: keepOutput,
                                  ahead: ahead, gpuRows: gpuRows)
            castInput = c.offset == a.offset ? nil : (a.offset, aRow, kk)
        } else {
            try gpuRows(m)
        }
    }

    func compute(_ name: String, commands: MTLCommandBuffer, _ body: (MTLComputeCommandEncoder) throws -> Void) throws {
        castInput = nil
        try gpu(name, commands) { commands in
            let encoder = commands.makeComputeCommandEncoder()!
            encoder.label = name
            encoder.setComputePipelineState(try context.pipeline(name))
            try body(encoder)
            encoder.endEncoding()
        }
    }

    struct RowParams { var columns: UInt32; var targetStart: UInt32; var eps: Float }
    struct HalfOut { var rows, halfRows, fullFrom: UInt32 }
    struct NormParams { var columns, targetStart: UInt32; var eps: Float; var half: HalfOut }
    struct SwigluParams { var columns: UInt32; var half: HalfOut }

    /// **The row kernels write the next split product's fp16 input** (`layernorm_modulate` before q/k/v and gate/proj,
    /// `swiglu` before the MLP's out): the GPU's and the AMX's rows straight to fp16, fp32 only for the Neural Engine's
    /// rows, instead of fp32 everywhere and a `pack_half` pass that reads it back. The same values to the bit
    /// (`half(v)` of the same fp32 v). `KOKON_FUSED_CAST=0`: the separate cast, for comparison.
    let fusedCast = ProcessInfo.processInfo.environment["KOKON_FUSED_CAST"] != "0"
    /// Set while a probe reads the stages: every row is written in fp32 too.
    private var probing = false

    /// Where a row kernel of `count` real rows writes the fp16 input of the split product `k × n` that follows.
    func halfOutput(count: Int, k: Int, n: Int) -> (buffer: MTLBuffer, out: HalfOut)? {
        guard fusedCast, !profiling, let coexecutor, let h = coexecutor.halfInput(m: QwenDiT.padded(count), k: k, n: n) else { return nil }
        return (h.buffer, HalfOut(rows: UInt32(count), halfRows: UInt32(h.rows), fullFrom: probing ? 0 : UInt32(h.rows)))
    }

    /// Where a row kernel of `count` real rows packs the Neural Engine's rows of the split product that follows
    /// (`Coexecutor.RowPack`); nil: they are written in fp32 and packed by the product.
    func rowPack(count: Int, k: Int, n: Int, readers: [String]) -> Coexecutor.RowPack? {
        guard fusedCast, !profiling, !probing, let coexecutor else { return nil }
        return coexecutor.rowPack(m: QwenDiT.padded(count), k: k, n: n, readers: readers)
    }

    struct AnePack { var row0, real, surfaces, kSplit: UInt32 }

    /// Binds a row pack's σ, bounds and surfaces at `index` on.
    func bind(_ pack: Coexecutor.RowPack, _ e: MTLComputeCommandEncoder, real: Int, from index: Int) {
        var a = AnePack(row0: UInt32(pack.first), real: UInt32(real), surfaces: UInt32(pack.surfaces.count), kSplit: pack.kSplit ? 1 : 0)
        e.setBytes(&a, length: MemoryLayout<AnePack>.stride, index: index)
        e.setBuffer(pack.sigma, offset: 0, index: index + 1)
        for i in 0..<3 { e.setBuffer(pack.bounds[min(i, pack.bounds.count - 1)], offset: pack.boundOffset, index: index + 2 + i) }
        for i in 0..<3 { e.setBuffer(pack.surfaces[min(i, pack.surfaces.count - 1)], offset: 0, index: index + 5 + i) }
    }

    /// **The residual and the LN after it in one pass** (`residual_layernorm`, `residual_layernorm_ane`): x is read
    /// once instead of twice, and the Neural Engine's rows of `o` come from the product's output surfaces (`tiles`: set,
    /// weight, K parts) instead of an fp32 unpacking. After to_out (with LN2) and after the MLP out (with the next
    /// layer's LN1). The same values to the bit. `KOKON_FUSED_RESIDUAL=0`: the separate kernels.
    let fusedResidual = ProcessInfo.processInfo.environment["KOKON_FUSED_RESIDUAL"] != "0"
    struct Deferred { let tiles: (set: Int, weight: String, kParts: Int)? }
    /// The MLP residual of the layer before, encoded with this layer's LN1.
    var deferredResidual: Deferred?

    /// `x += tanh(gate) · o` then `LN(x) · mod` on `rows` (see `fusedResidual`).
    func residualNorm(gate: Int, rows: Range<Int>, prefixMod: Int, targetMod: Int, half: (buffer: MTLBuffer, out: HalfOut)?,
                      pack: Coexecutor.RowPack?, tiles: (set: Int, weight: String, kParts: Int)?, commands: MTLCommandBuffer) throws {
        let d = QwenDiT.dim
        // Packing the Neural Engine's rows needs them from the product's surfaces; otherwise the residual kernel takes
        // every row (the Neural Engine's unpacked in fp32 by the product).
        guard (pack == nil) == (tiles == nil) else {
            try residual(gate: gate, rows: rows, commands: commands)
            return try layerNorm(x, into: normed, rows: rows, prefixMod: prefixMod, targetMod: targetMod, half: half, pack: pack, commands: commands)
        }
        let at = rows.lowerBound * d * 4
        let h = half?.out ?? QwenDiT.fullOnly(rows.count)
        var params = NormParams(columns: UInt32(d), targetStart: UInt32(max(0, sequence.prefix - rows.lowerBound)), eps: QwenDiT.eps, half: h)
        try compute("residual_layernorm", commands: commands) { e in
            e.setBuffer(arena.buffer, offset: x.offset + at, index: 0)
            e.setBuffer(arena.buffer, offset: normed.offset + at, index: 1)
            e.setBuffer(arena.buffer, offset: modulation.offset + prefixMod * 4, index: 2)
            e.setBuffer(arena.buffer, offset: modulation.offset + targetMod * 4, index: 3)
            e.setBytes(&params, length: MemoryLayout<NormParams>.stride, index: 4)
            e.setBuffer(half?.buffer ?? arena.buffer, offset: half == nil ? normed.offset + at : 0, index: 5)
            e.setBuffer(arena.buffer, offset: o.offset + at, index: 6)
            e.setBuffer(arena.buffer, offset: modulation.offset + gate * 4, index: 7)
            e.setBuffer(arena.buffer, offset: modulation.offset + (5 * d + gate) * 4, index: 8)
            e.dispatchThreadgroups(MTLSize(width: pack.map { $0.first } ?? max(rows.count, Int(h.halfRows)), height: 1, depth: 1),
                                   threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
        if let pack, let tiles, let c = coexecutor {
            try compute("residual_layernorm_ane", commands: commands) { e in
                e.setBuffer(arena.buffer, offset: x.offset + at, index: 0)
                e.setBuffer(arena.buffer, offset: modulation.offset + prefixMod * 4, index: 1)
                e.setBuffer(arena.buffer, offset: modulation.offset + targetMod * 4, index: 2)
                e.setBytes(&params, length: MemoryLayout<NormParams>.stride, index: 3)
                bind(pack, e, real: rows.count, from: 4)
                for t in 0..<3 { e.setBuffer(c.slots[tiles.set][min(t, tiles.kParts - 1)].y, offset: 0, index: 12 + t) }
                e.setBuffer(c.columns(tiles.weight), offset: 0, index: 15)
                var parts = UInt32(tiles.kParts)
                e.setBytes(&parts, length: 4, index: 16)
                e.setBuffer(arena.buffer, offset: modulation.offset + gate * 4, index: 17)
                e.setBuffer(arena.buffer, offset: modulation.offset + (5 * d + gate) * 4, index: 18)
                e.dispatchThreadgroups(MTLSize(width: pack.rows, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
            c.packedByRowKernel(offset: normed.offset + at, readers: pack.readers)
        }
        if half != nil { castInput = (normed.offset, rows.lowerBound, d) }
    }

    /// No fp16 copy: every row in fp32.
    static func fullOnly(_ rows: Int) -> HalfOut { HalfOut(rows: UInt32(rows), halfRows: 0, fullFrom: 0) }
    struct HeadParams { var heads: UInt32; var rows: UInt32; var eps: Float }
    struct ResidualParams { var columns: UInt32; var targetStart: UInt32; var count: UInt32 }

    /// `out = LN(x) · mod[band]`, `prefixMod` / `targetMod` floats into the modulation slice; `half`: the next
    /// product's fp16 input too (`halfOutput`).
    func layerNorm(_ input: Arena.Slice, into out: Arena.Slice, rows: Range<Int>, prefixMod: Int, targetMod: Int,
                   half: (buffer: MTLBuffer, out: HalfOut)? = nil, pack: Coexecutor.RowPack? = nil, commands: MTLCommandBuffer) throws {
        let at = rows.lowerBound * QwenDiT.dim * 4
        let h = half?.out ?? QwenDiT.fullOnly(rows.count)
        try compute("layernorm_modulate", commands: commands) { e in
            e.setBuffer(arena.buffer, offset: input.offset + at, index: 0)
            e.setBuffer(arena.buffer, offset: out.offset + at, index: 1)
            e.setBuffer(arena.buffer, offset: modulation.offset + prefixMod * 4, index: 2)
            e.setBuffer(arena.buffer, offset: modulation.offset + targetMod * 4, index: 3)
            var params = NormParams(columns: UInt32(QwenDiT.dim), targetStart: UInt32(max(0, sequence.prefix - rows.lowerBound)),
                                    eps: QwenDiT.eps, half: h)
            e.setBytes(&params, length: MemoryLayout<NormParams>.stride, index: 4)
            e.setBuffer(half?.buffer ?? arena.buffer, offset: half == nil ? out.offset + at : 0, index: 5)
            e.dispatchThreadgroups(MTLSize(width: pack.map { $0.first } ?? max(rows.count, Int(h.halfRows)), height: 1, depth: 1),
                                   threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
        if let pack {
            try compute("layernorm_modulate_ane", commands: commands) { e in
                e.setBuffer(arena.buffer, offset: input.offset + at, index: 0)
                e.setBuffer(arena.buffer, offset: modulation.offset + prefixMod * 4, index: 1)
                e.setBuffer(arena.buffer, offset: modulation.offset + targetMod * 4, index: 2)
                var params = NormParams(columns: UInt32(QwenDiT.dim), targetStart: UInt32(max(0, sequence.prefix - rows.lowerBound)),
                                        eps: QwenDiT.eps, half: h)
                e.setBytes(&params, length: MemoryLayout<NormParams>.stride, index: 3)
                bind(pack, e, real: rows.count, from: 4)
                e.dispatchThreadgroups(MTLSize(width: pack.rows, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
            coexecutor?.packedByRowKernel(offset: out.offset + at, readers: pack.readers)
        }
        if half != nil { castInput = (out.offset, rows.lowerBound, QwenDiT.dim) }
    }

    /// `h1 = SiLU(h1) ⊙ h2` on rows `[first, first + count)`; `half`: the MLP out's fp16 input too.
    /// `tiles`: gate's and proj's Neural Engine rows read from their output surfaces (sets, weights) instead of h1, h2.
    func swiglu(first: Int, count: Int, half: (buffer: MTLBuffer, out: HalfOut)?, pack: Coexecutor.RowPack? = nil,
                tiles: (gate: Int, proj: Int, weights: [String])? = nil, commands: MTLCommandBuffer) throws {
        let w = QwenDiT.hidden
        let h = half?.out ?? QwenDiT.fullOnly(count)
        try compute("swiglu", commands: commands) { e in
            e.setBuffer(arena.buffer, offset: h1.offset + first * w * 4, index: 0)
            e.setBuffer(arena.buffer, offset: h2.offset + first * w * 4, index: 1)
            var params = SwigluParams(columns: UInt32(w), half: h)
            e.setBytes(&params, length: MemoryLayout<SwigluParams>.stride, index: 2)
            e.setBuffer(half?.buffer ?? arena.buffer, offset: half == nil ? h1.offset : 0, index: 3)
            e.dispatchThreads(MTLSize(width: (pack.map { $0.first } ?? max(count, Int(h.halfRows))) * w, height: 1, depth: 1),
                              threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
        if let pack, let tiles, let c = coexecutor {
            try compute("swiglu_ane_tiles", commands: commands) { e in
                for t in 0..<3 { e.setBuffer(c.slots[tiles.gate][t].y, offset: 0, index: t) }
                for t in 0..<3 { e.setBuffer(c.slots[tiles.proj][t].y, offset: 0, index: 3 + t) }
                e.setBuffer(c.columns(tiles.weights[0]), offset: 0, index: 6)
                e.setBuffer(c.columns(tiles.weights[1]), offset: 0, index: 7)
                bind(pack, e, real: count, from: 8)
                e.dispatchThreadgroups(MTLSize(width: pack.rows, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
            c.packedByRowKernel(offset: h1.offset + first * w * 4, readers: pack.readers)
        } else if let pack {
            try compute("swiglu_ane", commands: commands) { e in
                e.setBuffer(arena.buffer, offset: h1.offset + first * w * 4, index: 0)
                e.setBuffer(arena.buffer, offset: h2.offset + first * w * 4, index: 1)
                bind(pack, e, real: count, from: 2)
                e.dispatchThreadgroups(MTLSize(width: pack.rows, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
            }
            coexecutor?.packedByRowKernel(offset: h1.offset + first * w * 4, readers: pack.readers)
        }
        if half != nil { castInput = (h1.offset, first, w) }
    }

    func rmsNorm(_ input: Arena.Slice, into out: Arena.Slice, rows: Int, weight: Arena.Slice, commands: MTLCommandBuffer) throws {
        try compute("rmsnorm_rows", commands: commands) { e in
            e.setBuffer(arena.buffer, offset: input.offset, index: 0)
            e.setBuffer(arena.buffer, offset: out.offset, index: 1)
            e.setBuffer(arena.buffer, offset: weight.offset, index: 2)
            var params = RowParams(columns: UInt32(QwenDiT.dim), targetStart: 0, eps: QwenDiT.eps)
            e.setBytes(&params, length: MemoryLayout<RowParams>.stride, index: 3)
            e.dispatchThreadgroups(MTLSize(width: rows, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
    }

    func headNormRope(_ tensor: Arena.Slice, weightOffset: Int, rows: Range<Int>, commands: MTLCommandBuffer) throws {
        try compute("head_rmsnorm_rope", commands: commands) { e in
            e.setBuffer(arena.buffer, offset: tensor.offset + rows.lowerBound * QwenDiT.dim * 4, index: 0)
            e.setBuffer(arena.buffer, offset: qkNorms.offset + weightOffset * 4, index: 1)
            e.setBuffer(arena.buffer, offset: rope.offset + rows.lowerBound * 128 * 4, index: 2)
            var params = HeadParams(heads: UInt32(QwenDiT.heads), rows: UInt32(rows.count), eps: QwenDiT.eps)
            e.setBytes(&params, length: MemoryLayout<HeadParams>.stride, index: 3)
            let units = rows.count * QwenDiT.heads   // one SIMD group each, 8 per threadgroup
            e.dispatchThreadgroups(MTLSize(width: (units + 7) / 8, height: 1, depth: 1),
                                   threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
    }

    /// `x += tanh(gate) · o`, the gate `gate` floats into each band's modulation row.
    func residual(gate: Int, rows: Range<Int>, commands: MTLCommandBuffer) throws {
        let d = QwenDiT.dim, at = rows.lowerBound * d * 4
        try compute("gated_residual", commands: commands) { e in
            e.setBuffer(arena.buffer, offset: x.offset + at, index: 0)
            e.setBuffer(arena.buffer, offset: o.offset + at, index: 1)
            e.setBuffer(arena.buffer, offset: modulation.offset + gate * 4, index: 2)
            e.setBuffer(arena.buffer, offset: modulation.offset + (5 * d + gate) * 4, index: 3)
            var params = ResidualParams(columns: UInt32(d), targetStart: UInt32(max(0, sequence.prefix - rows.lowerBound)),
                                        count: UInt32(rows.count * d))
            e.setBytes(&params, length: MemoryLayout<ResidualParams>.stride, index: 4)
            e.dispatchThreads(MTLSize(width: rows.count * d, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
    }

    func elementwise(_ name: String, _ buffers: [(Arena.Slice, Int)], count: Int, commands: MTLCommandBuffer) throws {
        try compute(name, commands: commands) { e in
            for (i, (slice, offset)) in buffers.enumerated() { e.setBuffer(arena.buffer, offset: slice.offset + offset * 4, index: i) }
            var c = UInt32(count)
            e.setBytes(&c, length: 4, index: buffers.count)
            e.dispatchThreads(MTLSize(width: count, height: 1, depth: 1), threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
    }

    /// Attention through `Kernels/attention.metal` or MPSGraph (`KOKON_ATTENTION=graph`, the check). The kernel takes
    /// fp16 operands by default (Gabriele 10-25: 76.0 s against 79.9 s per 1024² image, the velocity within 6e-4 of
    /// fp64 instead of 1e-5); `KOKON_ATTENTION=fp32` keeps the fp32 kernel (the accuracy checks).
    let graphAttention = ProcessInfo.processInfo.environment["KOKON_ATTENTION"] == "graph"
    let flashKernel = ProcessInfo.processInfo.environment["KOKON_ATTENTION"] == "fp32" ? "flash_attention" : "flash_attention_half"  // "unpacked": no K/V packing
    struct FlashParams { var queries, keys, causal, stride: UInt32; var scale: Float; var headBase: UInt32 }
    struct PackParams { var keys, paddedKeys, stride, heads: UInt32 }
    /// The target's attention (not causal) on K and V packed first to fp16, heads first: 1024², 32 heads, M2 Pro
    /// (`probe-attention`, 2026-10-25): 91.0 ms with the packing against 95.2 for `flash_attention_half`, the same
    /// accuracy. `flash_attention_direct` reads the packed K and V straight from memory, as MFA's and libnnc's tables
    /// do on Apple9+ GPUs; it was the default there until the bench reports of Discussion #43 (2026-10-27) found it
    /// slower on every one: a step at 1024², direct against packed, M3 Max 5.45 → 4.83 s, M4 Pro 7.27 → 5.96,
    /// M4 Max 4.57 → 3.88, M5 Pro 5.79 → 5.34 (on the M2 Pro 142 ms against 91 for the attention alone). Off by default
    /// on every chip; `KOKON_ATTENTION_DIRECT=1` to try it.
    lazy var packedKernel = QwenDiT.directAttention(device: context.device) ? "flash_attention_direct" : "flash_attention_packed"
    static func directAttention(device: MTLDevice) -> Bool {
        ProcessInfo.processInfo.environment["KOKON_ATTENTION_DIRECT"] == "1"
    }

    /// Queries `[queries, queries + count)` against keys `[0, keys)`, into the same rows of `attended`. The target's
    /// queries are cut by heads with the Neural Engine and the CPU when the co-executor runs (`AttentionSplit.swift`).
    func attend(queries: Int, count: Int, keys: Int, causal: Bool, commands: MTLCommandBuffer) throws {
        castInput = nil
        let row = QwenDiT.dim * 4
        if let coexecutor, !profiling, !graphAttention, !causal, coexecutor.attentionApplies(queries: count) {
            func operand(_ slice: Arena.Slice, _ first: Int) -> Coexecutor.Operand {
                (arena.buffer, slice.offset + first * row, arena.pointer(slice, floatOffset: first * QwenDiT.dim))
            }
            try coexecutor.encodeAttention(q: operand(q, queries), k: operand(k, 0), v: operand(v, 0), out: operand(attended, queries),
                                           queries: count, keys: keys, stride: QwenDiT.dim, commands: commands) { gpuHeads in
                try flash(queries: queries, count: count, keys: keys, causal: false, heads: gpuHeads, commands: commands)
            }
            return
        }
        if !graphAttention {
            try flash(queries: queries, count: count, keys: keys, causal: causal, heads: QwenDiT.heads, commands: commands)
            return
        }
        let key = "\(count)×\(keys)\(causal ? "c" : "")"
        let attention: GraphAttention
        if let a = attentions[key] { attention = a } else {
            attention = try GraphAttention(device: context.device, queries: count, keys: keys, heads: QwenDiT.heads,
                                           headDim: QwenDiT.headDim, causal: causal)
            attentions[key] = attention
        }
        let b = arena.buffer
        try gpu("attention", commands) {
            attention.encode(commands: $0, q: (b, q.offset + queries * row), k: (b, k.offset), v: (b, v.offset),
                             out: (b, attended.offset + queries * row))
        }
    }

    /// `flash_attention` on heads `[0, heads)`.
    func flash(queries: Int, count: Int, keys: Int, causal: Bool, heads: Int, commands: MTLCommandBuffer) throws {
        guard heads > 0 else { return }
        let row = QwenDiT.dim * 4
        let packed = !causal && flashKernel == "flash_attention_half" && ProcessInfo.processInfo.environment["KOKON_ATTENTION"] != "unpacked"
        if packed {
            try compute("attention_pack_kv", commands: commands) { e in
                e.setBuffer(arena.buffer, offset: k.offset, index: 0); e.setBuffer(arena.buffer, offset: v.offset, index: 1)
                e.setBuffer(arena.buffer, offset: kPacked.offset, index: 2); e.setBuffer(arena.buffer, offset: vPacked.offset, index: 3)
                var pp = PackParams(keys: UInt32(keys), paddedKeys: UInt32(paddedKeys), stride: UInt32(QwenDiT.dim), heads: UInt32(heads))
                e.setBytes(&pp, length: MemoryLayout<PackParams>.stride, index: 4)
                e.dispatchThreads(MTLSize(width: QwenDiT.headDim / 4, height: paddedKeys, depth: heads),
                                  threadsPerThreadgroup: MTLSize(width: 32, height: 8, depth: 1))
            }
        }
        try compute(packed ? packedKernel : flashKernel, commands: commands) { e in
            e.setBuffer(arena.buffer, offset: q.offset + queries * row, index: 0)
            e.setBuffer(arena.buffer, offset: packed ? kPacked.offset : k.offset, index: 1)
            e.setBuffer(arena.buffer, offset: packed ? vPacked.offset : v.offset, index: 2)
            e.setBuffer(arena.buffer, offset: attended.offset + queries * row, index: 3)
            var params = FlashParams(queries: UInt32(count), keys: UInt32(keys), causal: causal ? 1 : 0,
                                     stride: UInt32(QwenDiT.dim), scale: 1 / Float(QwenDiT.headDim).squareRoot() * Float(M_LOG2E),
                                     headBase: 0)
            e.setBytes(&params, length: MemoryLayout<FlashParams>.stride, index: 4)
            var padded = UInt32(paddedKeys)
            if packed { e.setBytes(&padded, length: 4, index: 5) }
            e.dispatchThreadgroups(MTLSize(width: (count + 63) / 64, height: heads, depth: 1),
                                   threadsPerThreadgroup: MTLSize(width: 256, height: 1, depth: 1))
        }
    }
}
