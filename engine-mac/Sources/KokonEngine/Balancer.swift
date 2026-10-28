import Foundation

/// **The balancing loop.** After each evaluation the timeline gives each unit's rate on each kind of operation,
/// measured beside the others (the AMX runs at about half its solo rate there), and the next evaluation's shares are
/// set so the units finish together:
///
///   - products: the Neural Engine's rows are one count for every product (its programs are compiled per count, in
///     steps of 256), chosen to minimize the predicted time of all products; the AMX's rows per kind of product (steps
///     of 64) split the rest with the GPU in proportion to their rates;
///   - the target's attention: every (Neural Engine in groups of 4, CPU, GPU) cut of the 32 heads, the one whose
///     slowest unit is fastest.
///
/// A new cut is taken only when it is predicted 1.5 % faster, so the shares settle instead of flickering. Rates are
/// smoothed over evaluations and start from the M2 Pro's, so a unit without a share keeps an estimate. Moving a
/// share moves which rows go through the Neural Engine's fp16: images stay within its accuracy, not bit for bit.
///
/// The shares and rates are remembered per Mac and shape (`Memory`), so the next run starts balanced: at 1024² on the
/// M2 Pro the first evaluation took ~11.5 s at the starting shares against ~8.9 balanced.
struct Balancer: Codable {
    /// Rows (heads, for attention) per millisecond.
    struct Rates: Codable { var gpu: Double, amx: Double, ane: Double }
    var rates: [String: Rates]
    /// The AMX's measured rate at each row count tried, per kind: it is not linear in rows (MLP out on the M2 Pro:
    /// 320 rows 31 ms, 384 rows 43 ms), so a measured count beats the extrapolated rate.
    var amxAt: [String: [Int: Double]] = [:]
    let aneAttention: Bool
    static let smoothing = 0.5, margin = 0.985

    /// Seeds from `time-dit` at 1024² (1856 / 256 / 2048 rows; attention 19 GPU / 13 CPU heads) and `probe-attention`
    /// (the Neural Engine's heads), M2 Pro, 2026-10-25; on another chip scaled by `Chip.unitScale` (estimates).
    init(aneAttention: Bool, chip: Chip? = nil) {
        self.aneAttention = aneAttention
        rates = ["4096×4096": Rates(gpu: 149, amx: 28, ane: 172), "4096×12288": Rates(gpu: 48, amx: 9.8, ane: 58),
                 "12288×4096": Rates(gpu: 43.5, amx: 8.8, ane: 57.5), "attention": Rates(gpu: 0.224, amx: 0.142, ane: 0.195)]
        if let scale = chip?.unitScale {
            for (kind, r) in rates { rates[kind] = Rates(gpu: r.gpu * scale.gpu, amx: r.amx * scale.amx, ane: r.ane * scale.ane) }
        }
    }

    /// The products of one DiT evaluation, by kind: per layer q, k, v, out (4096 × 4096), gate, proj, MLP out.
    static let evaluationCounts = ["4096×4096": 4 * QwenDiT.layers, "4096×12288": 2 * QwenDiT.layers, "12288×4096": QwenDiT.layers]

    /// The Neural Engine's rows (steps of 256, from 1 024 to `rows` − 512) minimizing the predicted products of an
    /// evaluation with `counts` products of each kind.
    func bestAneRows(rows: Int, amx: Bool, counts: [String: Int] = Balancer.evaluationCounts) -> Int? {
        stride(from: 1024, through: rows - 512, by: 256).min {
            productCost(rows: rows, ane: $0, amx: amx, counts: counts) < productCost(rows: rows, ane: $1, amx: amx, counts: counts)
        }
    }

    /// The AMX's rows of a product of `kind` (a multiple of 64) for `rest` rows shared with the GPU.
    func amxRows(kind: String, rest: Int) -> Int? {
        guard let r = rates[kind] else { return nil }
        // Of the two multiples of 64 around the ideal cut, the one whose slower unit is faster.
        let ideal = Double(rest) * r.amx / (r.gpu + r.amx)
        let low = Int(ideal / 64) * 64
        func time(_ a: Int) -> Double {
            max(a > 0 ? Double(a) / (amxAt[kind]?[a] ?? r.amx) : 0, Double(rest - a) / r.gpu)
        }
        return [low - 64, low, low + 64].filter { $0 >= 0 && $0 <= rest }.min { time($0) < time($1) }
    }

    /// The cut of the 32 heads whose slowest unit is fastest (the GPU keeps at least one: its text segments run there).
    func bestHeads(ane: Bool, cpu: Bool) -> HeadSplit {
        let maxAne = ane && aneAttention ? QwenDiT.heads - Coexecutor.aneHeadGroup : 0
        var best = HeadSplit(gpu: QwenDiT.heads, ane: 0, cpu: 0)
        for a in stride(from: 0, through: maxAne, by: Coexecutor.aneHeadGroup) {
            for c in 0...(cpu ? QwenDiT.heads - 1 - a : 0) {
                let h = HeadSplit(gpu: QwenDiT.heads - a - c, ane: a, cpu: c)
                if attentionCost(h) < attentionCost(best) { best = h }
            }
        }
        return best
    }

    /// Folds an evaluation's timeline into the rates: per kind, each unit's rows over its seconds.
    mutating func observe(_ entries: [Timeline.Entry]) {
        var sums: [String: (rows: Rates, ms: Rates)] = [:]
        for e in entries {
            var s = sums[e.kind] ?? (Rates(gpu: 0, amx: 0, ane: 0), Rates(gpu: 0, amx: 0, ane: 0))
            s.rows.gpu += Double(e.shares.gpu); s.ms.gpu += (e.gpu - e.released) * 1e3
            s.rows.amx += Double(e.shares.amx); s.ms.amx += e.amx.seconds * 1e3
            s.rows.ane += Double(e.shares.ane); s.ms.ane += e.ane.seconds * 1e3
            sums[e.kind] = s
        }
        for (kind, s) in sums {
            var r = rates[kind] ?? Rates(gpu: s.rows.gpu / max(s.ms.gpu, 1e-3), amx: 0, ane: 0)
            func fold(_ old: Double, _ rows: Double, _ ms: Double) -> Double {
                rows > 0 && ms > 0 ? Balancer.smoothing * old + (1 - Balancer.smoothing) * rows / ms : old
            }
            r.gpu = fold(r.gpu, s.rows.gpu, s.ms.gpu)
            r.amx = fold(r.amx, s.rows.amx, s.ms.amx)
            r.ane = fold(r.ane, s.rows.ane, s.ms.ane)
            rates[kind] = r
            if kind != "attention", s.rows.amx > 0, s.ms.amx > 0, let first = entries.first(where: { $0.kind == kind }) {
                amxAt[kind, default: [:]][first.shares.amx] = s.rows.amx / s.ms.amx
            }
        }
    }

    /// Predicted milliseconds of `counts` products of each kind with `ane` rows of `rows` on the Neural Engine and the
    /// rest cut ideally between the GPU and (when `amx`) the AMX.
    func productCost(rows: Int, ane: Int, amx: Bool, counts: [String: Int]) -> Double {
        counts.reduce(0) { sum, kc in
            guard let r = rates[kc.key] else { return sum }
            let rest = Double(rows - ane) / (r.gpu + (amx ? r.amx : 0))
            return sum + Double(kc.value) * max(ane > 0 ? Double(ane) / r.ane : 0, rest)
        }
    }

    /// Predicted milliseconds of one cut attention.
    func attentionCost(_ h: HeadSplit) -> Double {
        guard let r = rates["attention"] else { return .infinity }
        return max(Double(h.gpu) / r.gpu, h.ane > 0 ? Double(h.ane) / r.ane : 0, h.cpu > 0 ? Double(h.cpu) / r.amx : 0)
    }
}

extension Coexecutor {
    /// Reads the last evaluation's timeline and sets the next one's shares. Between evaluations only.
    func rebalance() throws {
        lastTimeline = timeline.drain()
        balancer.observe(lastTimeline)

        var counts: [String: Int] = [:]
        for e in lastTimeline where e.kind != "attention" { counts[e.kind, default: 0] += 1 }
        if !counts.isEmpty {
            if aneEnabled {
                func cost(_ e: Int) -> Double { balancer.productCost(rows: rows, ane: e, amx: amxEnabled, counts: counts) }
                let best = balancer.bestAneRows(rows: rows, amx: amxEnabled, counts: counts) ?? aneRows
                if cost(best) < cost(aneRows) * Balancer.margin { try setAneRows(best) }
            }
            for kind in counts.keys where amxEnabled {
                if let a = balancer.amxRows(kind: kind, rest: rows - aneRows) { amxRows[kind] = a }
            }
        }

        if lastTimeline.contains(where: { $0.kind == "attention" }), HeadSplit.fromEnvironment() == nil {
            let best = balancer.bestHeads(ane: aneEnabled, cpu: amxEnabled)
            if balancer.attentionCost(best) < balancer.attentionCost(heads) * Balancer.margin {
                heads = best
                try prepareAttention(queries: attentionShape.queries, keys: attentionShape.keys)
            }
        }
        remember()
    }

    /// The shares the next evaluation takes.
    var shares: String {
        let amx = amxRows.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ")
        return "products ANE \(aneRows) rows, AMX \(amx.isEmpty ? "default" : amx); attention \(heads)"
    }
}

extension Coexecutor {
    /// What the balancing loop learned, per Mac, shape and units on: `~/Library/Caches/kokon-engine-mac/balance.json`.
    struct Memory: Codable {
        var aneRows: Int
        var amxRows: [String: Int]
        var heads: [Int]
        var balancer: Balancer

        static let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("kokon-engine-mac/balance.json")

        static func all() -> [String: Memory] {
            guard let data = try? Data(contentsOf: url) else { return [:] }
            return (try? JSONDecoder().decode([String: Memory].self, from: data)) ?? [:]
        }
    }

    var memoryKey: String {
        "\(context.device.name) rows \(rows) ane \(aneEnabled)\(aneInt8 ? " int8" : "") amx \(amxEnabled) ane-attention \(balancer.aneAttention)\(flushRelease ? " flush" : "")"
    }

    /// Takes the remembered shares for this Mac and shape, if any.
    func recall() throws {
        guard let m = Memory.all()[memoryKey], m.heads.count == 3, m.heads.reduce(0, +) == QwenDiT.heads else { return }
        balancer = m.balancer
        amxRows = m.amxRows.filter { Balancer.evaluationCounts[$0.key] != nil }   // kinds this engine still runs
        if HeadSplit.fromEnvironment() == nil { heads = HeadSplit(gpu: m.heads[0], ane: m.heads[1], cpu: m.heads[2]) }
        if aneEnabled, m.aneRows >= 1024, m.aneRows <= rows - 512 { try setAneRows(m.aneRows) }
    }

    /// Writes the current shares (failures only cost the next run its head start).
    func remember() {
        var all = Memory.all()
        all[memoryKey] = Memory(aneRows: aneRows, amxRows: amxRows, heads: [heads.gpu, heads.ane, heads.cpu], balancer: balancer)
        try? FileManager.default.createDirectory(at: Memory.url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(all) { try? data.write(to: Memory.url, options: .atomic) }
    }
}
