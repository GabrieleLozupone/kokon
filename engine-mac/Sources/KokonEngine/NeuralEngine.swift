import CoreML
import Metal
import CoreVideo
import Foundation

/// **A matrix product on the Neural Engine**: `Y[rows, n] = X[rows, k] · W[k, n]`, all fp16.
///
/// Core ML is the only public door to the Neural Engine. Instead of shipping compiled models, the engine
/// writes one tiny program per shape at run time (`model.mil` + `coremldata.bin`, the two files a compiled
/// `.mlmodelc` needs) whose **weight is an input**: one program serves every weight of its shape, so no
/// model file is converted or downloaded. The operands live in IOSurface-backed buffers bound once, which
/// Core ML reads and writes in place.
///
/// Technique and the `coremldata.bin` layout from Siliconed (github.com/gwenn-ha-dev/Siliconed,
/// Apache-2.0, `NeuralEngine.swift`); written again here for Kokon.
///
/// What the caller must know (measured by Siliconed on an M1 Pro, to re-measure here with `probe`):
///   - fp16 flushes values under 6e-5 and overflows over 65 504: the caller scales weight columns and
///     activation rows by powers of two before, and undoes it in fp32 after;
///   - past K = 4 096 or a 48 MB weight the rate falls several times: cut K and sum the parts in fp32;
///   - rows in units of 256.
public final class NeuralEngineProduct: @unchecked Sendable {
    public let rows: Int, k: Int, n: Int
    /// int8 `x` and `w` (`int8Program`); the output fp16.
    public let int8: Bool
    private let model: MLModel
    private let features: MLFeatureProvider
    private let options: MLPredictionOptions
    public let x: CVPixelBuffer, w: CVPixelBuffer, y: CVPixelBuffer
    private let directory: URL

    public enum Failure: Error, CustomStringConvertible {
        case surface(String), program(String)
        public var description: String {
            switch self {
            case .surface(let s): return "Neural Engine surface: \(s)"
            case .program(let s): return "Neural Engine program: \(s)"
            }
        }
    }

    /// `sharing`: a program of the same shape whose `x` surface (and `y`, with `sharingOutput`) this one uses too.
    public init(rows: Int, k: Int, n: Int, int8: Bool = false, sharing: NeuralEngineProduct? = nil,
                sharingOutput: Bool = true) throws {
        self.rows = rows; self.k = k; self.n = n; self.int8 = int8
        (model, directory) = try NeuralEngineProduct.compile(
            "\(rows)x\(k)x\(n)\(int8 ? "-int8" : "")",
            program: int8 ? NeuralEngineProduct.int8Program(rows: rows, k: k, n: n) : NeuralEngineProduct.program(rows: rows, k: k, n: n),
            inputs: [("x", [rows, k]), ("w", [k, n])], outputs: [("y", [rows, n])], int8Inputs: int8 ? ["x", "w"] : [])
        x = try sharing?.x ?? NeuralEngineProduct.surface(rows: rows, columns: k, int8: int8)
        w = try NeuralEngineProduct.surface(rows: k, columns: n, int8: int8)
        y = try (sharingOutput ? sharing?.y : nil) ?? NeuralEngineProduct.surface(rows: rows, columns: n)
        func shape(_ dims: Int...) -> [NSNumber] { dims.map { NSNumber(value: $0) } }
        options = MLPredictionOptions()
        options.outputBackings = ["y": MLMultiArray(pixelBuffer: y, shape: shape(rows, n))]
        features = try MLDictionaryFeatureProvider(dictionary: [
            "x": MLFeatureValue(multiArray: MLMultiArray(pixelBuffer: x, shape: shape(rows, k))),
            "w": MLFeatureValue(multiArray: MLMultiArray(pixelBuffer: w, shape: shape(k, n))),
        ])
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    /// Runs the product on what the surfaces hold.
    public func run() throws {
        _ = try model.prediction(from: features, options: options)
    }

    /// Fills a surface through `body`, with its base address as fp16, locked for writing.
    public func write(_ surface: CVPixelBuffer, _ body: (UnsafeMutablePointer<Float16>) -> Void) {
        CVPixelBufferLockBaseAddress(surface, [])
        body(CVPixelBufferGetBaseAddress(surface)!.assumingMemoryBound(to: Float16.self))
        CVPixelBufferUnlockBaseAddress(surface, [])
    }

    /// Reads the output surface through `body`.
    public func read(_ body: (UnsafePointer<Float16>) -> Void) {
        CVPixelBufferLockBaseAddress(y, .readOnly)
        body(CVPixelBufferGetBaseAddress(y)!.assumingMemoryBound(to: Float16.self))
        CVPixelBufferUnlockBaseAddress(y, .readOnly)
    }

    /// A dense fp16 (or int8) surface `rows × columns` (no row padding: the program reads it dense).
    static func surface(rows: Int, columns: Int, int8: Bool = false) throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        let attributes = [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, columns, rows, int8 ? kCVPixelFormatType_OneComponent8 : kCVPixelFormatType_OneComponent16Half,
                                  attributes, &buffer) == kCVReturnSuccess, let buffer,
              CVPixelBufferGetBytesPerRow(buffer) == columns * (int8 ? 1 : 2) else {
            throw Failure.surface("\(rows)×\(columns) is not dense")
        }
        return buffer
    }

    /// The program: MIL text as coremltools writes it for `matmul(x, w)`.
    static func program(rows: Int, k: Int, n: Int) -> String {
        """
        program(1.3)
        [buildInfo = dict<string, string>({{"coremlc-component-MIL", "3600.16.1"}, {"coremlc-version", "3600.25.2"}})]
        {
            func main<ios18>(tensor<fp16, [\(k), \(n)]> w, tensor<fp16, [\(rows), \(k)]> x) {
                    bool tx = const()[name = string("tx"), val = bool(false)];
                    bool ty = const()[name = string("ty"), val = bool(false)];
                    tensor<fp16, [\(rows), \(n)]> y = matmul(transpose_x = tx, transpose_y = ty, x = x, y = w)[name = string("y")];
                } -> (y);
        }
        """
    }

    /// **The int8 product**, for the Neural Engines with an int8 path (M3, M4; `Coexecutor.aneInt8`): `x` and `w` int8,
    /// each dequantized by 1/√K inside the program (a power of two for K = 4 096), so |y| ≤ 127² stays in fp16, and K
    /// cut into pieces of at most 2 688 summed in fp16. The caller quantizes A per row and W per column and scales y back
    /// (`ane8_*` in `ane.metal`). The program's form follows libnnc's Core ML int8 GEMM (ccv, BSD-3, Liu Liu:
    /// `ccv_nnc_mfa_ane_rowwise_coreml.mm`, which measured the K limit on an M4), in this engine's layout: x [rows, K]
    /// and w [K, N] row-major, as the fp16 program, where libnnc multiplies W [N, K] by X [K, M].
    static func int8Program(rows: Int, k: Int, n: Int) -> String {
        let pieces = k <= 2688 ? 1 : (k + 2047) / 2048
        let part = k / pieces
        let (dx, dw) = (1 / Float(k).squareRoot(), 1 / Float(k).squareRoot())
        var body = """
                fp16 dx = const()[name = string("dx"), val = fp16(\(String(format: "%a", dx)))];
                fp16 dw = const()[name = string("dw"), val = fp16(\(String(format: "%a", dw)))];
                bool f = const()[name = string("f"), val = bool(false)];

        """
        func operands(_ x: String, _ w: String, _ suffix: String, _ xRows: Int, _ kk: Int) -> String {
            """
                    tensor<fp16, [\(xRows), \(kk)]> xh\(suffix) = dequantize(input = \(x), scale = dx)[name = string("xh\(suffix)")];
                    tensor<fp16, [\(kk), \(n)]> wh\(suffix) = dequantize(input = \(w), scale = dw)[name = string("wh\(suffix)")];

            """
        }
        if pieces == 1 {
            body += operands("x", "w", "", rows, k) + """
                    tensor<fp16, [\(rows), \(n)]> y = matmul(transpose_x = f, transpose_y = f, x = xh, y = wh)[name = string("y")];

            """
        } else {
            body += """
                    tensor<int32, [2]> xs = const()[name = string("xs"), val = tensor<int32, [2]>([\(rows), \(part)])];
                    tensor<int32, [2]> ws = const()[name = string("ws"), val = tensor<int32, [2]>([\(part), \(n)])];

            """
            for i in 0..<pieces {
                body += """
                        tensor<int32, [2]> xb\(i) = const()[name = string("xb\(i)"), val = tensor<int32, [2]>([0, \(i * part)])];
                        tensor<int32, [2]> wb\(i) = const()[name = string("wb\(i)"), val = tensor<int32, [2]>([\(i * part), 0])];
                        tensor<int8, [\(rows), \(part)]> xq\(i) = slice_by_size(x = x, begin = xb\(i), size = xs)[name = string("xq\(i)")];
                        tensor<int8, [\(part), \(n)]> wq\(i) = slice_by_size(x = w, begin = wb\(i), size = ws)[name = string("wq\(i)")];

                """ + operands("xq\(i)", "wq\(i)", "\(i)", rows, part) + """
                        tensor<fp16, [\(rows), \(n)]> m\(i) = matmul(transpose_x = f, transpose_y = f, x = xh\(i), y = wh\(i))[name = string("m\(i)")];

                """
            }
            var sum = "m0"
            for i in 1..<pieces {
                let out = i == pieces - 1 ? "y" : "s\(i)"
                body += """
                        tensor<fp16, [\(rows), \(n)]> \(out) = add(x = \(sum), y = m\(i))[name = string("\(out)")];

                """
                sum = out
            }
        }
        return """
        program(1.3)
        [buildInfo = dict<string, string>({{"coremlc-component-MIL", "3600.16.1"}, {"coremlc-version", "3600.25.2"}})]
        {
            func main<ios19>(tensor<int8, [\(k), \(n)]> w, tensor<int8, [\(rows), \(k)]> x) {
        \(body)        } -> (y);
        }
        """
    }

    /// Writes `program` and its description as a compiled model in a temporary directory and loads it for the
    /// CPU and the Neural Engine. `tag` names the directory; `int8Inputs`: the inputs are int8 arrays.
    static func compile(_ tag: String, program: String, inputs: [(String, [Int])],
                        outputs: [(String, [Int])], int8Inputs: Set<String> = []) throws -> (MLModel, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("kokon-ane-\(ProcessInfo.processInfo.processIdentifier)-\(tag)-\(UUID().uuidString)")
            .appendingPathExtension("mlmodelc")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try program.write(to: directory.appendingPathComponent("model.mil"), atomically: true, encoding: .utf8)
        try description(inputs: inputs, outputs: outputs, int8Inputs: int8Inputs).write(to: directory.appendingPathComponent("coremldata.bin"))
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .cpuAndNeuralEngine
        do {
            return (try MLModel(contentsOf: directory, configuration: configuration), directory)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw Failure.program("\(tag): \(error.localizedDescription)")
        }
    }

    /// `coremldata.bin`: a fixed header with the description's length (little-endian u64 at 0x4b), the
    /// model description as protobuf (named fp16 multi-arrays in and out), a fixed trailer.
    static func description(inputs: [(String, [Int])], outputs: [(String, [Int])], int8Inputs: Set<String> = []) -> Data {
        func varint(_ value: Int) -> [UInt8] {
            var v = UInt64(value), out: [UInt8] = []
            repeat {
                let low = UInt8(v & 0x7f)
                v >>= 7
                out.append(v == 0 ? low : low | 0x80)
            } while v != 0
            return out
        }
        func field(_ tag: UInt8, _ body: [UInt8]) -> [UInt8] { [tag] + varint(body.count) + body }
        // A feature: name, then a multi-array type of `dims` in FLOAT16 (ArrayDataType 65 552) or INT8 (131 080).
        func feature(_ tag: UInt8, _ name: String, _ dims: [Int], int8: Bool = false) -> [UInt8] {
            let shape = field(0x0a, dims.flatMap(varint))
            let array = field(0x2a, shape + [0x10] + varint(int8 ? 0x20008 : 65_552))
            return field(tag, field(0x0a, Array(name.utf8)) + field(0x1a, array))
        }
        let payload: [UInt8] = inputs.flatMap { feature(0x0a, $0.0, $0.1, int8: int8Inputs.contains($0.0)) } + outputs.flatMap { feature(0x52, $0.0, $0.1) }
            + [0xa2, 0x06, 0x00]
        var header = [UInt8](repeating: 0, count: 0x53)
        header[0] = 0xf6; header[1] = 0x01; header[4] = 0x09; header[0x1c] = 0x07
        for (i, byte) in "generic".utf8.enumerated() { header[0x24 + i] = byte }
        header[0x2b] = 0x09
        withUnsafeBytes(of: UInt64(payload.count).littleEndian) { for (i, b) in $0.enumerated() { header[0x4b + i] = b } }
        var trailer = [UInt8](repeating: 0, count: 16)
        trailer[0] = 0xf6; trailer[1] = 0x01
        return Data(header + payload + trailer)
    }
}

extension NeuralEngineProduct {
    /// A GPU buffer over a surface's memory, no copy: the GPU writes the Neural Engine's operands in place.
    /// The surface stays locked for the product's life (unified memory: the lock only pins the address).
    public func gpuBuffer(_ surface: CVPixelBuffer, device: MTLDevice) throws -> MTLBuffer {
        try NeuralEngineProduct.gpuBuffer(surface, device: device)
    }

    static func gpuBuffer(_ surface: CVPixelBuffer, device: MTLDevice) throws -> MTLBuffer {
        CVPixelBufferLockBaseAddress(surface, [])
        guard let io = CVPixelBufferGetIOSurface(surface)?.takeUnretainedValue(),
              let base = CVPixelBufferGetBaseAddress(surface) else { throw Failure.surface("no IOSurface") }
        // The surface reports its exact size (data + 64 bytes); its memory is whole pages.
        let page = Int(getpagesize())
        let length = (IOSurfaceGetAllocSize(io) + page - 1) / page * page
        guard Int(bitPattern: base) % page == 0,
              let buffer = device.makeBuffer(bytesNoCopy: base, length: length, options: .storageModeShared, deallocator: nil) else {
            throw Failure.surface("surface memory at \(base) is not page-aligned (\(length) bytes)")
        }
        return buffer
    }
}

/// **Attention on the Neural Engine**: `y[h] = softmax(q[h] · k[h]ᵀ) · v[h]` for `heads` heads of 128, fp16, `q`
/// already scaled by 1/√128. One program per shape, operands in surfaces `[heads · rows, 128]` (heads first),
/// bound once, as for the product.
public final class NeuralEngineAttention: @unchecked Sendable {
    public let heads: Int, queries: Int, keys: Int
    public static let headDim = 128
    private let model: MLModel
    private let features: MLFeatureProvider
    private let options: MLPredictionOptions
    public let q: CVPixelBuffer, k: CVPixelBuffer, v: CVPixelBuffer, y: CVPixelBuffer
    private let directory: URL

    /// Measured on the M2 Pro (`probe-attention`, 4 096 queries × 4 128 keys, 2026-10-25): 4 heads × 1 024 queries a
    /// run 5.3 ms per head of all queries, 8 × 1 024 5.5, 1 × 4 096 6.5, 8 × 4 096 10.5 (the score matrix grows past
    /// what the Neural Engine keeps close); MIL's fused `scaled_dot_product_attention` 33 ms per head. Head 0 within
    /// 2.2e-3 of an exact attention (fp16 scores and probabilities).
    ///
    /// `k`, `v`: surfaces of another program of the same heads and keys to share (the query chunks of one head group).
    public init(heads: Int, queries: Int, keys: Int, sharing: NeuralEngineAttention? = nil) throws {
        self.heads = heads; self.queries = queries; self.keys = keys
        let d = NeuralEngineAttention.headDim
        (model, directory) = try NeuralEngineProduct.compile(
            "attention-\(heads)x\(queries)x\(keys)", program: NeuralEngineAttention.program(heads: heads, queries: queries, keys: keys),
            inputs: [("q", [1, heads, queries, d]), ("k", [1, heads, keys, d]), ("v", [1, heads, keys, d])],
            outputs: [("y", [1, heads, queries, d])])
        q = try NeuralEngineProduct.surface(rows: heads * queries, columns: d)
        k = try sharing?.k ?? NeuralEngineProduct.surface(rows: heads * keys, columns: d)
        v = try sharing?.v ?? NeuralEngineProduct.surface(rows: heads * keys, columns: d)
        y = try NeuralEngineProduct.surface(rows: heads * queries, columns: d)
        func shape(_ dims: Int...) -> [NSNumber] { dims.map { NSNumber(value: $0) } }
        options = MLPredictionOptions()
        options.outputBackings = ["y": MLMultiArray(pixelBuffer: y, shape: shape(1, heads, queries, d))]
        features = try MLDictionaryFeatureProvider(dictionary: [
            "q": MLFeatureValue(multiArray: MLMultiArray(pixelBuffer: q, shape: shape(1, heads, queries, d))),
            "k": MLFeatureValue(multiArray: MLMultiArray(pixelBuffer: k, shape: shape(1, heads, keys, d))),
            "v": MLFeatureValue(multiArray: MLMultiArray(pixelBuffer: v, shape: shape(1, heads, keys, d))),
        ])
    }

    deinit { try? FileManager.default.removeItem(at: directory) }

    public func run() throws {
        _ = try model.prediction(from: features, options: options)
    }

    /// A GPU buffer over one of its surfaces (`NeuralEngineProduct.gpuBuffer`).
    public func gpuBuffer(_ surface: CVPixelBuffer, device: MTLDevice) throws -> MTLBuffer {
        try NeuralEngineProduct.gpuBuffer(surface, device: device)
    }

    static func program(heads h: Int, queries l: Int, keys s: Int) -> String {
        let d = NeuralEngineAttention.headDim
        return """
        program(1.3)
        [buildInfo = dict<string, string>({{"coremlc-component-MIL", "3600.16.1"}, {"coremlc-version", "3600.25.2"}})]
        {
            func main<ios18>(tensor<fp16, [1, \(h), \(l), \(d)]> q, tensor<fp16, [1, \(h), \(s), \(d)]> k, tensor<fp16, [1, \(h), \(s), \(d)]> v) {
                    bool f = const()[name = string("f"), val = bool(false)];
                    bool t = const()[name = string("t"), val = bool(true)];
                    tensor<fp16, [1, \(h), \(l), \(s)]> scores = matmul(transpose_x = f, transpose_y = t, x = q, y = k)[name = string("scores")];
                    int32 axis = const()[name = string("axis"), val = int32(-1)];
                    tensor<fp16, [1, \(h), \(l), \(s)]> p = softmax(axis = axis, x = scores)[name = string("p")];
                    tensor<fp16, [1, \(h), \(l), \(d)]> y = matmul(transpose_x = f, transpose_y = f, x = p, y = v)[name = string("y")];
                } -> (y);
        }
        """
    }
}
