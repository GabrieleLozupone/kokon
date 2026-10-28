#include <metal_stdlib>
using namespace metal;

// The Neural Engine's side of a product C[m, n] = A[m, k] · W[k, n], packed and unpacked on the GPU so the CPU
// stays free for the AMX. The Neural Engine computes in fp16 and flushes values under fp16's smallest normal,
// so (scheme from Siliconed):
//   each weight column j is lifted by λ_j = 2^-floor(log2 max_k |W_kj|), its absmax into [1, 2): exact;
//   each activation row i by σ_i = 2^floor(log2(2^15 / (max_k |A_ik| · L))), L = max_j Σ_k |W_kj| λ_j,
//   so every output |Y_ij| <= max|A_i| σ_i L <= 2^15 stays under fp16's 65 504;
//   C_ij = Y_ij / (σ_i λ_j) in fp32.
// The product runs in tiles of at most 4 096 × 4 096 (one Core ML program each, the Neural Engine's fast range);
// tiles along K are summed here in fp32.

// A few milliseconds of arithmetic per thread and nothing else: the GPU work around the probe's signal
// (`Coexecutor.signalArrivesLate`).
kernel void spin(device float *o [[buffer(0)]], constant uint &n [[buffer(1)]], uint i [[thread_position_in_grid]]) {
    float x = float(i);
    for (uint k = 0; k < n; k++) x = fma(x, 1.0000001f, 0.5f);
    o[i] = x;
}

// fp32 -> fp16 (check-ane).
kernel void pack_half(device const float *src [[buffer(0)]], device half *dst [[buffer(1)]],
                      constant uint &count [[buffer(2)]], uint i [[thread_position_in_grid]]) {
    if (i < count) dst[i] = half(src[i]);
}

struct AneShape {
    uint k;        // full K of the product
    uint n;        // full N
    uint k0, kPart;  // this tile's K range
    uint n0, nPart;  // this tile's N range
    uint row0;     // first row of A / C the Neural Engine takes
    uint rows;     // its rows
    uint kParts;   // tiles along K (unpack)
};

// Per column of W [k, n]: λ_j and the lifted column's L1 norm. A threadgroup takes 64 columns, 16 row slices of
// each (coalesced rows), combined in threadgroup memory: one thread per column walking every row took ~8 ms per
// 4096 × 12288 weight (M2 Pro).
template <typename T>
kernel void ane_columns(device const T *w [[buffer(0)]], device float *lambda [[buffer(1)]],
                        device float *norm [[buffer(2)]], constant AneShape &s [[buffer(3)]],
                        uint2 tg [[threadgroup_position_in_grid]], uint2 t [[thread_position_in_threadgroup]]) {
    threadgroup float peaks[16][64], sums[16][64];
    uint j = tg.x * 64 + t.x;
    float peak = 0, sum = 0;
    if (j < s.n) {
        for (uint r = t.y; r < s.k; r += 16) {
            float v = fabs(float(w[(ulong)r * s.n + j]));
            peak = max(peak, v);
            sum += v;
        }
    }
    peaks[t.y][t.x] = peak;
    sums[t.y][t.x] = sum;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (t.y == 0 && j < s.n) {
        for (uint i = 1; i < 16; i++) { peak = max(peak, peaks[i][t.x]); sum += sums[i][t.x]; }
        float l = (peak > 0 && isfinite(peak)) ? exp2(-floor(log2(peak))) : 1.0f;
        lambda[j] = l;
        norm[j] = sum * l;
    }
}

template [[host_name("ane_columns")]] kernel void ane_columns<float>(device const float *, device float *, device float *,
    constant AneShape &, uint2, uint2);
template [[host_name("ane_columns_h")]] kernel void ane_columns<half>(device const half *, device float *, device float *,
    constant AneShape &, uint2, uint2);

// L = max_j norm[j], into state[0]. One threadgroup of 1 024.
kernel void ane_norm(device const float *norm [[buffer(0)]], device float *state [[buffer(1)]],
                     constant AneShape &s [[buffer(2)]], uint tid [[thread_index_in_threadgroup]]) {
    threadgroup float shared[32];
    float m = 0;
    for (uint j = tid; j < s.n; j += 1024) m = max(m, norm[j]);
    m = simd_max(m);
    if (tid % 32 == 0) shared[tid / 32] = m;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        float total = 0;
        for (uint i = 0; i < 32; i++) total = max(total, shared[i]);
        state[0] = total;
    }
}

// One weight tile, lifted, into its surface [kPart, nPart] fp16. W fp32 or fp16 (`_h`).
template <typename T>
kernel void ane_pack_weight(device const T *w [[buffer(0)]], device const float *lambda [[buffer(1)]],
                            device half *tile [[buffer(2)]], constant AneShape &s [[buffer(3)]],
                            uint2 g [[thread_position_in_grid]]) {
    uint jj = g.x, kk = g.y;
    if (jj >= s.nPart || kk >= s.kPart) return;
    uint j = s.n0 + jj;
    tile[(ulong)kk * s.nPart + jj] = half(float(w[(ulong)(s.k0 + kk) * s.n + j]) * lambda[j]);
}
template [[host_name("ane_pack_weight")]] kernel void ane_pack_weight<float>(device const float *, device const float *,
    device half *, constant AneShape &, uint2);
template [[host_name("ane_pack_weight_h")]] kernel void ane_pack_weight<half>(device const half *, device const float *,
    device half *, constant AneShape &, uint2);

// σ_i of each Neural Engine row, for up to three weights reading the same rows (their L in `state`, `state1`,
// `state2`; the same buffer again for fewer): the largest L bounds them all. One threadgroup of 256 per row.
kernel void ane_row_scales(device const float *a [[buffer(0)]], device const float *state [[buffer(1)]],
                           device float *sigma [[buffer(2)]], constant AneShape &s [[buffer(3)]],
                           device const float *state1 [[buffer(4)]], device const float *state2 [[buffer(5)]],
                           uint i [[threadgroup_position_in_grid]], uint tid [[thread_index_in_threadgroup]]) {
    threadgroup float shared[8];
    device const float *row = a + (ulong)(s.row0 + i) * s.k;
    float m = 0;
    for (uint c = tid; c < s.k; c += 256) m = max(m, fabs(row[c]));
    m = simd_max(m);
    if (tid % 32 == 0) shared[tid / 32] = m;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        float peak = 0;
        for (uint q = 0; q < 8; q++) peak = max(peak, shared[q]);
        float bound = peak * max(state[0], max(state1[0], state2[0]));
        sigma[i] = (bound > 0 && isfinite(bound)) ? exp2(floor(log2(32768.0f / bound))) : 1.0f;
    }
}

// The Neural Engine's rows of A, scaled, into a tile's input surface [rows, kPart] fp16.
kernel void ane_pack_rows(device const float *a [[buffer(0)]], device const float *sigma [[buffer(1)]],
                          device half *x [[buffer(2)]], constant AneShape &s [[buffer(3)]],
                          uint2 g [[thread_position_in_grid]]) {
    uint kk = g.x, i = g.y;
    if (kk >= s.kPart || i >= s.rows) return;
    x[(ulong)i * s.kPart + kk] = half(a[(ulong)(s.row0 + i) * s.k + s.k0 + kk] * sigma[i]);
}

// C rows from the outputs of the K tiles of one N range (up to 3), summed in fp32, unscaled.
kernel void ane_unpack(device const half *y0 [[buffer(0)]], device const half *y1 [[buffer(1)]],
                       device const half *y2 [[buffer(2)]], device const float *lambda [[buffer(3)]],
                       device const float *sigma [[buffer(4)]], device float *c [[buffer(5)]],
                       constant AneShape &s [[buffer(6)]], uint2 g [[thread_position_in_grid]]) {
    uint jj = g.x, i = g.y;
    if (jj >= s.nPart || i >= s.rows) return;
    ulong at = (ulong)i * s.nPart + jj;
    float sum = float(y0[at]);
    if (s.kParts > 1) sum += float(y1[at]);
    if (s.kParts > 2) sum += float(y2[at]);
    uint j = s.n0 + jj;
    c[(ulong)(s.row0 + i) * s.n + j] = (sum / lambda[j]) / sigma[i];
}

// Attention heads to and from the Neural Engine's surfaces [heads, rows, 128] fp16 (heads first), from the rows of
// `stride` floats the products write (head h at columns column0 + 128 h). Surface rows past `valid` are zeros.
struct HeadsShape {
    uint stride;
    uint column0;
    uint rows;      // rows per head in the surface
    uint valid;     // of which exist in the fp32 tensor, from row0
    uint row0;
    uint heads;
    float factor;   // q: 1/sqrt(128)
};

kernel void ane_heads_pack(device const float *src [[buffer(0)]], device half *dst [[buffer(1)]],
                           constant HeadsShape &s [[buffer(2)]], uint3 g [[thread_position_in_grid]]) {
    uint c = g.x, r = g.y, h = g.z;
    if (c >= 128 || r >= s.rows || h >= s.heads) return;
    float x = r < s.valid ? src[(ulong)(s.row0 + r) * s.stride + s.column0 + h * 128 + c] * s.factor : 0.0f;
    dst[((ulong)h * s.rows + r) * 128 + c] = half(x);
}

kernel void ane_heads_unpack(device const half *src [[buffer(0)]], device float *dst [[buffer(1)]],
                             constant HeadsShape &s [[buffer(2)]], uint3 g [[thread_position_in_grid]]) {
    uint c = g.x, r = g.y, h = g.z;
    if (c >= 128 || r >= s.valid || h >= s.heads) return;
    dst[(ulong)(s.row0 + r) * s.stride + s.column0 + h * 128 + c] = float(src[((ulong)h * s.rows + r) * 128 + c]);
}

// The int8 products (`NeuralEngineProduct.int8Program`, for the Neural Engines with an int8 path): W quantized per
// column, s_j = max_k |W_kj| / 127; A per row, t_i = max_k |A_ik| / 127; the program returns y = (A_q · W_q) / K per
// 4 096 × 4 096 tile; C_ij = K · t_i · s_j · Σ_tiles y_ij in fp32. Following libnnc's row-wise int8 GEMM (ccv, BSD-3).

static inline char quantize8(float v, float scale) { return char(clamp(rint(v / scale), -127.0f, 127.0f)); }

// s_j per column of W [k, n] (as ane_columns: 64 columns, 16 row slices each).
template <typename T>
kernel void ane8_columns(device const T *w [[buffer(0)]], device float *scale [[buffer(1)]],
                         constant AneShape &s [[buffer(2)]],
                         uint2 tg [[threadgroup_position_in_grid]], uint2 t [[thread_position_in_threadgroup]]) {
    threadgroup float peaks[16][64];
    uint j = tg.x * 64 + t.x;
    float peak = 0;
    if (j < s.n) {
        for (uint r = t.y; r < s.k; r += 16) peak = max(peak, fabs(float(w[(ulong)r * s.n + j])));
    }
    peaks[t.y][t.x] = peak;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (t.y == 0 && j < s.n) {
        for (uint i = 1; i < 16; i++) peak = max(peak, peaks[i][t.x]);
        scale[j] = (peak > 0 && isfinite(peak)) ? peak / 127.0f : 1.0f;
    }
}
template [[host_name("ane8_columns")]] kernel void ane8_columns<float>(device const float *, device float *, constant AneShape &, uint2, uint2);
template [[host_name("ane8_columns_h")]] kernel void ane8_columns<half>(device const half *, device float *, constant AneShape &, uint2, uint2);

// One weight tile, quantized, into its surface [kPart, nPart] int8.
template <typename T>
kernel void ane8_pack_weight(device const T *w [[buffer(0)]], device const float *scale [[buffer(1)]],
                             device char *tile [[buffer(2)]], constant AneShape &s [[buffer(3)]],
                             uint2 g [[thread_position_in_grid]]) {
    uint jj = g.x, kk = g.y;
    if (jj >= s.nPart || kk >= s.kPart) return;
    uint j = s.n0 + jj;
    tile[(ulong)kk * s.nPart + jj] = quantize8(float(w[(ulong)(s.k0 + kk) * s.n + j]), scale[j]);
}
template [[host_name("ane8_pack_weight")]] kernel void ane8_pack_weight<float>(device const float *, device const float *, device char *, constant AneShape &, uint2);
template [[host_name("ane8_pack_weight_h")]] kernel void ane8_pack_weight<half>(device const half *, device const float *, device char *, constant AneShape &, uint2);

// t_i of each Neural Engine row. One threadgroup of 256 per row.
kernel void ane8_row_scales(device const float *a [[buffer(0)]], device float *scale [[buffer(1)]],
                            constant AneShape &s [[buffer(2)]],
                            uint i [[threadgroup_position_in_grid]], uint tid [[thread_index_in_threadgroup]]) {
    threadgroup float shared[8];
    device const float *row = a + (ulong)(s.row0 + i) * s.k;
    float m = 0;
    for (uint c = tid; c < s.k; c += 256) m = max(m, fabs(row[c]));
    m = simd_max(m);
    if (tid % 32 == 0) shared[tid / 32] = m;
    threadgroup_barrier(mem_flags::mem_threadgroup);
    if (tid == 0) {
        float peak = 0;
        for (uint q = 0; q < 8; q++) peak = max(peak, shared[q]);
        scale[i] = (peak > 0 && isfinite(peak)) ? peak / 127.0f : 1.0f;
    }
}

// The Neural Engine's rows of A, quantized, into a tile's input surface [rows, kPart] int8.
kernel void ane8_pack_rows(device const float *a [[buffer(0)]], device const float *scale [[buffer(1)]],
                           device char *x [[buffer(2)]], constant AneShape &s [[buffer(3)]],
                           uint2 g [[thread_position_in_grid]]) {
    uint kk = g.x, i = g.y;
    if (kk >= s.kPart || i >= s.rows) return;
    x[(ulong)i * s.kPart + kk] = quantize8(a[(ulong)(s.row0 + i) * s.k + s.k0 + kk], scale[i]);
}

// C rows from the int8 tiles' outputs of one N range (up to 3 along K), scaled back.
kernel void ane8_unpack(device const half *y0 [[buffer(0)]], device const half *y1 [[buffer(1)]],
                        device const half *y2 [[buffer(2)]], device const float *columnScale [[buffer(3)]],
                        device const float *rowScale [[buffer(4)]], device float *c [[buffer(5)]],
                        constant AneShape &s [[buffer(6)]], uint2 g [[thread_position_in_grid]]) {
    uint jj = g.x, i = g.y;
    if (jj >= s.nPart || i >= s.rows) return;
    ulong at = (ulong)i * s.nPart + jj;
    float sum = float(y0[at]);
    if (s.kParts > 1) sum += float(y1[at]);
    if (s.kParts > 2) sum += float(y2[at]);
    uint j = s.n0 + jj;
    c[(ulong)(s.row0 + i) * s.n + j] = sum * float(s.kPart) * rowScale[i] * columnScale[j];
}
