#include <metal_stdlib>
#include <metal_tensor>
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
using namespace metal;
using namespace mpp::tensor_ops;

// The target's attention with its two products, Q·Kᵀ and P·V, on Metal 4 tensor operations (MetalPerformancePrimitives'
// matmul2d): on the M5 they run on the GPU's neural accelerators, where `flash_attention_packed`'s 8×8 SIMD-group
// matrices run on the shader cores. Compiled apart from the other kernels (Metal 4, `NeuralAccelerators.swift`).
//
// The same interface as `flash_attention_packed` (`attention.metal`), not causal: q fp32 rows of `stride` floats (head
// h at columns [128 h, 128 h + 128)), K and V packed by `attention_pack_kv` (fp16, `[head][key][128]`, keys padded with
// zeros to `paddedKeys`, a multiple of 64), out fp32 rows like q. The same arithmetic too: q, K, V and the
// probabilities in fp16, scores, softmax and O accumulated in fp32, an online softmax over tiles of 64 keys.
//
// Each SIMD group owns 16 query rows (MPP's row reductions work within one SIMD group), 4 per threadgroup: 64 rows,
// as `flash_attention_packed` (rows past `queries` are computed, never stored). Its Q rows (fp16) and probabilities sit
// in threadgroup memory as tensor operands; the scores and O stay in cooperative tensors, in registers; each row's
// running max, sum and rescale in threadgroup memory, read back by the elements of that row.
//
// M5 Pro 20-core, macOS 27.2, 1024² (4 096 queries × 4 128 keys, 32 heads): 27.4 ms against 59.7 for
// `flash_attention_packed` with its packing, 4.8e-4 from an fp64 attention of the same fp16 K and V. 2 SIMD groups of
// 32 rows 48.0 ms, 8 of 8 81.6, tiles of 32 keys 48.8 (median of 7).

struct FlashParams {
    uint queries;
    uint keys;
    uint causal;
    uint stride;
    float scale;     // 1/sqrt(head_dim) * log2(e)
    uint headBase;
};

constant constexpr int ND = 128;

template <int SG, int MQ, int NK>
kernel void na_flash_attention(device const float *q [[buffer(0)]], device half *kp [[buffer(1)]], device half *vp [[buffer(2)]],
                     device float *out [[buffer(3)]], constant FlashParams &p [[buffer(4)]],
                     constant uint &paddedKeys [[buffer(5)]],
                     uint2 tg [[threadgroup_position_in_grid]], uint sg [[simdgroup_index_in_threadgroup]],
                     uint lane [[thread_index_in_simdgroup]]) {
    threadgroup half qsAll[SG * MQ * ND];
    threadgroup half psAll[SG * MQ * NK];
    threadgroup float statsAll[SG * 4 * MQ];   // per row: max, sum, alpha, block value
    threadgroup half *qs = qsAll + sg * MQ * ND;
    threadgroup half *ps = psAll + sg * MQ * NK;
    threadgroup float *rowMax = statsAll + sg * 4 * MQ, *rowSum = rowMax + MQ, *rowAlpha = rowSum + MQ, *block = rowAlpha + MQ;

    const uint head = p.headBase + tg.y, q0 = (tg.x * SG + sg) * MQ;
    for (uint i = lane; i < MQ * ND; i += 32) {
        qs[i] = half(q[(ulong)(q0 + i / ND) * p.stride + head * ND + i % ND]);
    }
    if (lane < MQ) { rowMax[lane] = -INFINITY; rowSum[lane] = 0.0f; }
    simdgroup_barrier(mem_flags::mem_threadgroup);

    auto tQ = tensor<threadgroup half, extents<int32_t, ND, MQ>, tensor_inline>(qs, extents<int32_t, ND, MQ>());
    auto tP = tensor<threadgroup half, extents<int32_t, NK, MQ>, tensor_inline>(ps, extents<int32_t, NK, MQ>());
    device half *kh = kp + (ulong)head * paddedKeys * ND;
    device half *vh = vp + (ulong)head * paddedKeys * ND;
    auto tK = tensor<device half, dextents<int32_t, 2>, tensor_inline>(kh, dextents<int32_t, 2>(ND, paddedKeys));
    auto tV = tensor<device half, dextents<int32_t, 2>, tensor_inline>(vh, dextents<int32_t, 2>(ND, paddedKeys));

    constexpr auto qk = matmul2d_descriptor(MQ, NK, ND, false, true, false, matmul2d_descriptor::mode::multiply);
    matmul2d<qk, execution_simdgroup> opS;
    constexpr auto pv = matmul2d_descriptor(MQ, ND, NK, false, false, false, matmul2d_descriptor::mode::multiply_accumulate);
    matmul2d<pv, execution_simdgroup> opO;
    using KT = remove_addrspace_t<decltype(tK.slice(0, 0))>;
    using VT = remove_addrspace_t<decltype(tV.slice(0, 0))>;

    auto S = opS.template get_destination_cooperative_tensor<decltype(tQ), KT, float>();
    auto rows = opS.template get_row_reduction_destination_cooperative_tensor<decltype(tQ), KT, float>();
    auto O = opO.template get_destination_cooperative_tensor<decltype(tP), VT, float>();
    for (uint16_t i = 0; i < O.get_capacity(); ++i) if (O.is_valid_element(i)) O[i] = 0.0f;

    for (uint j0 = 0; j0 < p.keys; j0 += NK) {
        auto mK = tK.slice(0, int(j0));
        opS.run(tQ, mK, S);
        for (uint16_t i = 0; i < S.get_capacity(); ++i) {
            if (!S.is_valid_element(i)) continue;
            S[i] = j0 + uint(S.get_multidimensional_index(i)[0]) < p.keys ? S[i] * p.scale : -INFINITY;
        }
        reduce_rows(S, rows, reduction_operation::max, reduction_operation_identity<float>::max_identity);
        for (uint16_t i = 0; i < rows.get_capacity(); ++i) {
            if (rows.is_valid_element(i)) block[rows.get_multidimensional_index(i)[0]] = rows[i];
        }
        simdgroup_barrier(mem_flags::mem_threadgroup);
        if (lane < MQ) {
            float mOld = rowMax[lane], mNew = max(mOld, block[lane]);
            rowAlpha[lane] = (mNew == -INFINITY) ? 1.0f : exp2(mOld - mNew);
            rowMax[lane] = mNew;
        }
        simdgroup_barrier(mem_flags::mem_threadgroup);
        for (uint16_t i = 0; i < S.get_capacity(); ++i) {
            if (!S.is_valid_element(i)) continue;
            auto at = S.get_multidimensional_index(i);   // (key, query) within the tile
            float m = rowMax[at[1]];
            float e = (m == -INFINITY) ? 0.0f : exp2(S[i] - m);
            S[i] = e;
            ps[at[1] * NK + at[0]] = half(e);
        }
        reduce_rows(S, rows, reduction_operation::sum, reduction_operation_identity<float>::sum_identity);
        for (uint16_t i = 0; i < rows.get_capacity(); ++i) {
            if (rows.is_valid_element(i)) block[rows.get_multidimensional_index(i)[0]] = rows[i];
        }
        simdgroup_barrier(mem_flags::mem_threadgroup);
        if (lane < MQ) rowSum[lane] = rowSum[lane] * rowAlpha[lane] + block[lane];
        for (uint16_t i = 0; i < O.get_capacity(); ++i) {
            if (O.is_valid_element(i)) O[i] *= rowAlpha[O.get_multidimensional_index(i)[1]];
        }
        auto mV = tV.slice(0, int(j0));
        opO.run(tP, mV, O);
        simdgroup_barrier(mem_flags::mem_threadgroup);
    }

    for (uint16_t i = 0; i < O.get_capacity(); ++i) {
        if (!O.is_valid_element(i)) continue;
        auto at = O.get_multidimensional_index(i);   // (d, query)
        uint qi = q0 + uint(at[1]);
        if (qi < p.queries) out[(ulong)qi * p.stride + head * ND + uint(at[0])] = O[i] / rowSum[at[1]];
    }
}

template [[host_name("na_flash_attention")]] kernel void na_flash_attention<4, 16, 64>(device const float *, device half *,
    device half *, device float *, constant FlashParams &, constant uint &, uint2, uint, uint);
