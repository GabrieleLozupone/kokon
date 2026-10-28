import Foundation
import Metal

/// **`kokon-engine-mac bench`: a few minutes that measure the per-chip paths on the Mac that runs it**, for testers
/// to paste in a GitHub issue or discussion. Needs only Kokon's model files.
///
/// The engine reads its settings (`KOKON_*`) once at start, so each configuration runs in a child process
/// (`bench-run`) and prints one JSON line; the parent compares them and prints the report:
///
///   - accuracy at 512² (1 024 target rows, so every unit and path is in use): the first step's velocity and the
///     8-step image, against the engine's own fp32 path on the GPU alone, on the same Mac, the same noise and prompt;
///   - speed at 1024²: two images in one process (the first pays the loading and the Neural Engine's programs),
///     time per step and per image, peak memory;
///   - the same with each experimental path this Mac selected turned off, one at a time.
public enum Bench {
    public static let prompt = "A red fox in fresh snow at dawn, a wooden sign that says KOKON, soft golden light, photo"

    /// A configuration: its name in the report and the settings it changes.
    struct Run { let name: String; let environment: [String: String] }

    /// The experimental paths this Mac selects, as (what, the setting that turns it off).
    static func selectedPaths(context: MetalContext) -> [(String, String, String)] {
        let (chip, device) = (Chip.current, context.device)
        var paths: [(String, String, String)] = []
        if Coexecutor.int8Selected(chip), #available(macOS 26, *) {
            paths.append(("int8 products on the Neural Engine (M3/M4 path)", "KOKON_ANE_INT8", "0"))
        }
        if NeuralAccelerators.selected(device: device), NeuralAccelerators.make(device: device) != nil {
            paths.append(("GPU products on Metal 4 tensor operations (the M5's neural accelerators; shader cores before)", "KOKON_NA", "0"))
        }
        if Coexecutor.flushReleaseSelected(context) {
            paths.append(("each product released to the AMX and the Neural Engine at once (this Mac's signals arrive late)", "KOKON_FLUSH_READY", "0"))
        }
        if QwenDiT.directAttention(device: device) {
            paths.append(("attention reading K/V straight from memory", "KOKON_ATTENTION_DIRECT", "0"))
        }
        return paths
    }

    /// Seconds between image 1 and image 2.
    static let pause = 10.0

    /// The fp32 path, GPU only: the reference for accuracy.
    static let reference = ["KOKON_WEIGHTS": "fp32", "KOKON_ACTIVATIONS": "fp32", "KOKON_ATTENTION": "fp32",
                            "KOKON_COEXEC": "0", "KOKON_NA": "0"]

    // MARK: - parent

    public static func run(encoder: String, dit: String, vae: String, quick: Bool, out: String?) throws {
        let context = try MetalContext()
        let chip = Chip.current
        let paths = selectedPaths(context: context)
        print("kokon-engine-mac bench: \(chip)")
        print("selected: " + (paths.isEmpty ? "the M2 path (nothing chip-specific)" : paths.map(\.0).joined(separator: "; ")))
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("kokon-bench-\(ProcessInfo.processInfo.processIdentifier)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }

        var runs = [Run(name: "default (paths above)", environment: [:])]
        for path in paths { runs.append(Run(name: "\(path.1)=\(path.2)", environment: [path.1: path.2])) }
        // The opt-in int8 Neural Engine path where it may pay (libnnc's M3/M4 path; less accurate everywhere).
        if (chip.generation ?? 5) >= 3, #available(macOS 26, *) {
            runs.append(Run(name: "KOKON_ANE_INT8=1", environment: ["KOKON_ANE_INT8": "1"]))
        }

        // `PROGRESS k/N <what>` before each child, for Kokon's Benchmark button (stdout is a pipe there).
        let total = 1 + 2 * runs.count
        var done = 0
        func progress(_ label: String) {
            done += 1
            print("PROGRESS \(done)/\(total) \(label)")
            fflush(stdout)
        }

        func child(_ mode: String, _ environment: [String: String], tag: String) throws -> [String: Any] {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: Bundle.main.executablePath ?? CommandLine.arguments[0])
            process.arguments = ["bench-run", mode, encoder, dit, vae, scratch.appendingPathComponent(tag).path] + (quick ? ["--quick"] : [])
            process.environment = ProcessInfo.processInfo.environment.merging(environment) { $1 }
            let pipe = Pipe()
            process.standardOutput = pipe
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let text = String(decoding: data, as: UTF8.self)
            guard process.terminationStatus == 0, let line = text.split(separator: "\n").last(where: { $0.hasPrefix("BENCH ") }),
                  let json = try JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any] else {
                throw MetalContext.Failure.kernel("bench-run \(mode) \(environment) failed (status \(process.terminationStatus)):\n" + text.suffix(2000))
            }
            return json
        }

        print("accuracy at 512²: the fp32 reference (GPU alone, ~1 min)…")
        progress("Accuracy reference (512², most accurate path)")
        let reference = try child("accuracy", Bench.reference, tag: "reference")
        var rows: [[String: Any]] = []
        for (i, run) in runs.enumerated() {
            print("[\(i + 1)/\(runs.count)] \(run.name): accuracy at 512², then two images at 1024²…")
            progress("\(run.name): accuracy at 512²")
            var row = try child("accuracy", run.environment, tag: "run\(i)")
            progress("\(run.name): " + (quick ? "one image" : "two images") + " at 1024²")
            row.merge(try child("timing", run.environment, tag: "run\(i)")) { a, _ in a }
            row["name"] = run.name
            rows.append(row)
        }
        let report = Bench.report(chip: chip, paths: paths, reference: reference, rows: rows, quick: quick)
        print("\n" + report)
        if let out {
            try report.write(toFile: out, atomically: true, encoding: .utf8)
            // The same numbers for tools/compare_bench.py, which writes a pull request's tables from two reports.
            let json = (out as NSString).deletingPathExtension + ".json"
            let summary = Bench.summary(chip: chip, paths: paths, reference: reference, rows: rows, quick: quick)
            // Never fails the bench: the report above is what testers and the app need.
            if JSONSerialization.isValidJSONObject(summary),
               let data = try? JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]),
               (try? data.write(to: URL(fileURLWithPath: json))) != nil {
                print("(written to \(out) and \(json))")
            } else {
                print("(written to \(out); \(json) could not be written)")
            }
        }
    }

    static func report(chip: Chip, paths: [(String, String, String)], reference: [String: Any], rows: [[String: Any]], quick: Bool) -> String {
        func number(_ row: [String: Any], _ key: String) -> Double { (row[key] as? NSNumber)?.doubleValue ?? .nan }
        let refVelocity = reference["velocity"] as? String, refImage = reference["image"] as? String
        var lines = [
            "### Kokon Mac engine bench",
            "",
            "- Chip: \(chip.name), \(chip.gpuCores) GPU cores (GPU family Apple\(chip.gpuFamily)\(chip.supportsMetal4 ? ", Metal 4" : "")), "
                + "\(chip.performanceCores) performance + \(chip.efficiencyCores) efficiency cores, \(Int(chip.memoryGB.rounded())) GB",
            "- Mac \(chip.model), macOS \(chip.macOS); engine \(EngineVersion.string)",
            "- Paths selected: " + (paths.isEmpty ? "none chip-specific (the M2 path)" : paths.map(\.0).joined(separator: "; ")),
            "- Shares after the run (1024²): \(rows.first?["shares"] as? String ?? "?")",
            "",
            "| Run | Image 1 | Image 2 | Step (2–8) | VAE | Peak memory | Velocity vs fp32 | Image vs fp32 |",
            "|---|---|---|---|---|---|---|---|",
        ]
        for row in rows {
            var velocity = "?", image = "?"
            if let a = refVelocity, let b = row["velocity"] as? String, let e = Bench.relativeError(b, a) { velocity = String(format: "%.1e", e) }
            if let a = refImage, let b = row["image"] as? String, let d = Bench.levels(b, a) {
                image = String(format: "mean %.2f, max %d levels", d.mean, d.max)
            }
            let second = number(row, "image2")
            lines.append(String(format: "| %@ | %.1f s | %@ | %.2f s | %.2f s | %.1f GB | %@ | %@ |", row["name"] as? String ?? "?",
                                number(row, "image1"), second.isNaN ? "–" : String(format: "%.1f s", second), number(row, "step"),
                                number(row, "vae"), number(row, "peak"), velocity, image))
        }
        lines += ["", "Where the time goes at 1024² (s): text encoder, DiT load, step 1, steps 2–8, VAE, total",
                  "", "| Run | Image | Encoder | DiT load | Step 1 | Steps 2–8 | VAE | Total |", "|---|---|---|---|---|---|---|---|"]
        for row in rows {
            for (i, p) in ((row["parts"] as? [[String: Any]]) ?? []).enumerated() {
                lines.append(String(format: "| %@ | %d | %.2f | %.2f | %.2f | %.1f | %.2f | %.1f |", row["name"] as? String ?? "?", i + 1,
                                    number(p, "encode"), number(p, "load"), number(p, "step1"), number(p, "steps"), number(p, "vae"), number(p, "total")))
            }
        }
        lines += ["", "Image 1 includes loading the models and building the Neural Engine's programs; image 2 is the engine "
                  + "already running, as in the app, \(Int(Bench.pause)) s after image 1 (below 32 GB the models are loaded again for "
                  + "every image). Accuracy at 512² against the engine's fp32 GPU path"
                  + (quick ? "; --quick: one image per run." : ".")]
        return lines.joined(separator: "\n")
    }

    /// The report's numbers as JSON: the Mac, the paths, and per run its times, peak memory and accuracy (the files
    /// the children wrote are read here, before they are deleted).
    static func summary(chip: Chip, paths: [(String, String, String)], reference: [String: Any], rows: [[String: Any]],
                        quick: Bool) -> [String: Any] {
        let runs: [[String: Any]] = rows.map { row in
            var run = row.filter { ["name", "image1", "image2", "step", "vae", "peak", "parts", "shares"].contains($0.key) }
            if let a = reference["velocity"] as? String, let b = row["velocity"] as? String, let e = Bench.relativeError(b, a), e.isFinite {
                run["velocityError"] = e
            }
            if let a = reference["image"] as? String, let b = row["image"] as? String, let d = Bench.levels(b, a) {
                run["imageMeanLevels"] = d.mean
                run["imageMaxLevels"] = d.max
            }
            return run
        }
        return ["chip": chip.name, "model": chip.model, "gpuCores": chip.gpuCores, "gpuFamily": chip.gpuFamily,
                "performanceCores": chip.performanceCores, "efficiencyCores": chip.efficiencyCores,
                "memoryGB": Int(chip.memoryGB.rounded()), "macOS": chip.macOS, "engine": EngineVersion.string,
                "paths": paths.map(\.0), "quick": quick, "runs": runs]
    }

    /// ‖a − b‖ / ‖b‖ of two files of floats.
    static func relativeError(_ a: String, _ b: String) -> Double? {
        guard let x = try? Data(contentsOf: URL(fileURLWithPath: a)), let y = try? Data(contentsOf: URL(fileURLWithPath: b)),
              x.count == y.count, !x.isEmpty else { return nil }
        return x.withUnsafeBytes { xb in y.withUnsafeBytes { yb in
            let p = xb.bindMemory(to: Float.self), q = yb.bindMemory(to: Float.self)
            var d = 0.0, n = 0.0
            for i in 0..<p.count { d += Double(p[i] - q[i]) * Double(p[i] - q[i]); n += Double(q[i]) * Double(q[i]) }
            return (d / max(n, 1e-30)).squareRoot()
        } }
    }

    /// Mean and largest difference of two files of 8-bit values.
    static func levels(_ a: String, _ b: String) -> (mean: Double, max: Int)? {
        guard let x = try? Data(contentsOf: URL(fileURLWithPath: a)), let y = try? Data(contentsOf: URL(fileURLWithPath: b)),
              x.count == y.count, !x.isEmpty else { return nil }
        var sum = 0, worst = 0
        for i in 0..<x.count { let d = abs(Int(x[i]) - Int(y[i])); sum += d; worst = max(worst, d) }
        return (Double(sum) / Double(x.count), worst)
    }

    // MARK: - child

    /// `bench-run accuracy|timing <encoder> <dit> <vae> <file prefix> [--quick]`: prints `BENCH {json}`.
    public static func child(mode: String, encoder: String, dit: String, vae: String, prefix: String, quick: Bool) throws {
        // Ends with the bench: when Kokon cancels it, the parent is killed and this child is handed to launchd.
        let parent = getppid()
        Thread.detachNewThread {
            while getppid() == parent { Thread.sleep(forTimeInterval: 1) }
            exit(1)
        }
        let pipeline = try QwenPipeline(encoder: encoder, dit: dit, vae: vae)
        pipeline.keepModels = true
        pipeline.log = { _ in }
        var result: [String: Any] = [:]
        if mode == "accuracy" {
            // The first step's velocity from the noise, and the image.
            let (w, h, seed) = (512, 512, UInt64(42))
            let noise = QwenPipeline.pack(Noise.philox(seed: seed, count: QwenDiT.channels * (h / 16) * (w / 16)), height: h / 16, width: w / 16)
            var velocity: [Float] = []
            let sigmas = QwenPipeline.turboSigmas
            let image = try pipeline.textToImage(prompt: Bench.prompt, width: w, height: h, seed: seed) { i, x in
                if i == 0 { velocity = zip(x, noise).map { ($0 - $1) / (sigmas[1] - sigmas[0]) } }
            }
            let pixels = QwenPipeline.pixels(image, width: w, height: h)
            try velocity.withUnsafeBytes { try Data($0).write(to: URL(fileURLWithPath: prefix + "-velocity.f32")) }
            try Data(pixels).write(to: URL(fileURLWithPath: prefix + "-image.u8"))
            result = ["velocity": prefix + "-velocity.f32", "image": prefix + "-image.u8"]
        } else {
            var images: [Double] = [], steps: [Double] = [], vae = 0.0, parts: [[String: Double]] = []
            for i in 0..<(quick ? 1 : 2) {
                // Image 2 after a pause, like someone looking at image 1.
                if i > 0 { Thread.sleep(forTimeInterval: Bench.pause) }
                _ = try pipeline.textToImage(prompt: Bench.prompt, width: 1024, height: 1024, seed: 42 + UInt64(i))
                let t = pipeline.timings
                images.append(t["total"] ?? .nan)
                vae = t["vae"] ?? .nan
                steps = (2...8).compactMap { t["step \($0)"] }
                // Where each image's time goes: on 16 GB the models are loaded again for every image.
                parts.append(["encode": t["encode"] ?? .nan, "load": t["dit load"] ?? .nan, "step1": t["step 1"] ?? .nan,
                              "steps": steps.reduce(0, +), "vae": vae, "total": t["total"] ?? .nan])
            }
            let memory = MemoryUsage.now()
            result = ["parts": parts, "image1": images[0], "step": steps.reduce(0, +) / Double(max(1, steps.count)), "vae": vae,
                      "peak": memory.footprintPeak, "shares": pipeline.shares ?? "GPU only"]
            if images.count > 1 { result["image2"] = images[1] }
        }
        let data = try JSONSerialization.data(withJSONObject: result)
        print("BENCH " + String(decoding: data, as: UTF8.self))
    }
}

/// The engine's version in reports (the bench script adds the commit).
public enum EngineVersion {
    public static let string = ProcessInfo.processInfo.environment["KOKON_ENGINE_VERSION"] ?? "0.1.1 (experimental)"
}
