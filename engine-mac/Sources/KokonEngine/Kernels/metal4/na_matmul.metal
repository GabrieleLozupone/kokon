#include <metal_stdlib>
#include <metal_tensor>
#include <MetalPerformancePrimitives/MetalPerformancePrimitives.h>
using namespace metal;
using namespace mpp::tensor_ops;

// C[m, n] = A[m, k] · B[k, n] through Metal 4's tensor operations (MetalPerformancePrimitives' matmul2d): on the M5's
// GPU they run on its neural accelerators, on older Metal 4 GPUs on the shader cores. Compiled apart from the other
// kernels (Metal 4, `NeuralAccelerators.swift`). The approach follows libnnc's NAMatMul (ccv, BSD-3, Liu Liu); this
// kernel is written for Kokon.
//
// A and B fp16, C fp32, row-major and dense; m and n multiples of 64 (the DiT pads every product to 64 rows, its
// widths are multiples of 4 096). One threadgroup per 64 × 64 tile of C, the whole K in one run, on 4 SIMD groups
// (`na_matmul`) or 2 (`na_matmul_sg2`, the M5 Pro's: `NeuralAccelerators.simdgroups`). Tensor extents list the
// innermost dimension first: A is (k, m), B (n, k), C (n, m).

struct NAParams {
    uint m, n, k;
};

template <int SIMDGROUPS>
kernel void na_matmul(device half *A [[buffer(0)]], device half *B [[buffer(1)]], device float *C [[buffer(2)]],
                      constant NAParams &p [[buffer(3)]], uint2 tg [[threadgroup_position_in_grid]]) {
    auto a = tensor<device half, dextents<int32_t, 2>, tensor_inline>(A, dextents<int32_t, 2>(p.k, p.m));
    auto b = tensor<device half, dextents<int32_t, 2>, tensor_inline>(B, dextents<int32_t, 2>(p.n, p.k));
    auto c = tensor<device float, dextents<int32_t, 2>, tensor_inline>(C, dextents<int32_t, 2>(p.n, p.m));
    constexpr auto descriptor = matmul2d_descriptor(64, 64, dynamic_length_v<int>, false, false, false,
                                                    matmul2d_descriptor::mode::multiply);
    matmul2d<descriptor, execution_simdgroups<SIMDGROUPS>> op;
    auto mA = a.slice(0, int(tg.y) * 64);
    auto mB = b.slice(int(tg.x) * 64, 0);
    auto mC = c.slice(int(tg.x) * 64, int(tg.y) * 64);
    op.run(mA, mB, mC);
}

template [[host_name("na_matmul")]] kernel void na_matmul<4>(device half *, device half *, device float *,
                                                             constant NAParams &, uint2);
template [[host_name("na_matmul_sg2")]] kernel void na_matmul<2>(device half *, device half *, device float *,
                                                                 constant NAParams &, uint2);
