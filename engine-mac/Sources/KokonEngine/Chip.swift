import Foundation
import IOKit
import Metal

/// **This Mac's chip**, read at run time: the per-chip paths (`Coexecutor`, `QwenDiT`) are chosen from it, each with
/// the M2 path as its fallback, and `bench` prints it for the report.
public struct Chip: Sendable, CustomStringConvertible {
    /// `machdep.cpu.brand_string`, e.g. "Apple M2 Pro".
    public let name: String
    /// `hw.model`, e.g. "Mac14,12": tells a fanless MacBook Air from a Mac mini with the same chip, which matters
    /// for timings (the Air slows down when warm).
    public let model: String
    /// 1 for M1 … 5 for M5, from the name; nil for a name the engine does not know (a newer chip: treated as the
    /// newest known one where a path depends on it).
    public let generation: Int?
    public let gpuCores: Int, performanceCores: Int, efficiencyCores: Int
    public let memoryGB: Double
    /// The newest Apple GPU family the device supports: 7 (M1) … 10 (M5).
    public let gpuFamily: Int
    public let supportsMetal4: Bool
    public let macOS: String

    public static let current = Chip(device: MTLCreateSystemDefaultDevice())

    init(device: MTLDevice?) {
        func sysctl(_ key: String) -> String {
            var size = 0
            guard sysctlbyname(key, nil, &size, nil, 0) == 0, size > 0 else { return "" }
            var bytes = [CChar](repeating: 0, count: size)
            guard sysctlbyname(key, &bytes, &size, nil, 0) == 0 else { return "" }
            return String(cString: bytes)
        }
        func number(_ key: String) -> Int {
            var value: Int64 = 0, size = MemoryLayout<Int64>.size
            return sysctlbyname(key, &value, &size, nil, 0) == 0 ? Int(value) : 0
        }
        name = sysctl("machdep.cpu.brand_string")
        model = sysctl("hw.model")
        generation = Chip.generation(of: name)
        performanceCores = number("hw.perflevel0.physicalcpu")
        efficiencyCores = number("hw.perflevel1.physicalcpu")
        memoryGB = Double(number("hw.memsize")) / Double(1 << 30)
        gpuCores = Chip.gpuCoreCount()
        let families: [(MTLGPUFamily, Int)] = [(.apple10, 10), (.apple9, 9), (.apple8, 8), (.apple7, 7)]
        gpuFamily = device.flatMap { d in families.first { d.supportsFamily($0.0) }?.1 } ?? 0
        if #available(macOS 26, *) { supportsMetal4 = device?.supportsFamily(.metal4) ?? false } else { supportsMetal4 = false }
        let v = ProcessInfo.processInfo.operatingSystemVersion
        macOS = "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// "Apple M4 Pro" → 4.
    static func generation(of name: String) -> Int? {
        guard let range = name.range(of: #"\bM(\d+)\b"#, options: .regularExpression) else { return nil }
        return Int(name[range].dropFirst())
    }

    /// The GPU's cores, from the IORegistry (`AGXAccelerator`'s `gpu-core-count`); 0 when not found.
    static func gpuCoreCount() -> Int {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AGXAccelerator"))
        guard service != 0 else { return 0 }
        defer { IOObjectRelease(service) }
        let value = IORegistryEntryCreateCFProperty(service, "gpu-core-count" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        return (value as? NSNumber)?.intValue ?? 0
    }

    public var description: String {
        String(format: "%@, %d GPU cores (Apple%d%@), %d+%d CPU cores, %.0f GB, macOS %@", name, gpuCores, gpuFamily,
               supportsMetal4 ? ", Metal 4" : "", performanceCores, efficiencyCores, memoryGB, macOS)
    }
}

extension Chip {
    /// Each unit's estimated speed on the DiT's products relative to the M2 Pro (19 GPU cores, 8 performance cores, a
    /// 16-core Neural Engine), the only chip measured so far, for the first image's shares: the GPU by cores × clock,
    /// the Neural Engine by Apple's published TOPS (fp16 for M1–M3; the M4's 38 are int8, so ~19 in fp16; the M5's
    /// assumed the same), the AMX by performance cores; an Ultra has two Neural Engines. Estimates: the balancing loop
    /// measures the real rates from the first evaluation on and remembers them. nil for a chip without a known name.
    var unitScale: (gpu: Double, amx: Double, ane: Double)? {
        guard let g = generation, gpuCores > 0, performanceCores > 0 else { return nil }
        let generation = min(g, 5)
        let clock: [Int: Double] = [1: 1.28, 2: 1.40, 3: 1.40, 4: 1.50, 5: 1.55]   // GHz, the GPU's highest, approximate
        let tops: [Int: Double] = [1: 11, 2: 15.8, 3: 18, 4: 19, 5: 19]
        let engines = name.contains("Ultra") ? 2.0 : 1.0
        return (Double(gpuCores) * clock[generation]! / (19 * 1.40), Double(performanceCores) / 8, tops[generation]! * engines / 15.8)
    }
}
