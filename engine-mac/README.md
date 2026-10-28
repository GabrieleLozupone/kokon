# kokon-engine-mac

**New here? Read [docs/mac-engine.md](docs/mac-engine.md) first**: the whole engine explained from zero, chapter by
chapter, with diagrams. This README is the lab notebook: every measurement, A/B run and check command.

Kokon's own engine for Apple Silicon (in development). Goal: Qwen-Image 2.1 Turbo with the GPU, the CPU's
matrix unit (AMX) and the Neural Engine all busy for the whole render, reading the same GGUF files Kokon
already downloads for sd.cpp, and answering the same `/sdcpp/v1` API so the service, the app and MCP do not
change. sd.cpp stays the engine on Windows and Linux and the fallback on Macs.

```bash
cd engine-mac
swift build -c release
swift test                                   # no model needed
.build/release/kokon-engine-mac probe        # this Mac's matrix throughput, ~1 min, no model
.build/release/kokon-engine-mac probe-attention   # the target's attention at 1024² on the GPU, Neural Engine, CPU
.build/release/kokon-engine-mac inspect <file.gguf>
.build/release/kokon-engine-mac check-dequant <file.gguf> [tensor...]
.build/release/kokon-engine-mac generate <encoder.gguf> <dit.gguf> <vae.safetensors> "a red fox in the snow" \
    [--size 1024x1024] [--seed 42] [--out out.png] [--ref in.png --mmproj <mmproj.gguf>]
.build/release/kokon-engine-mac serve --diffusion-model <dit.gguf> --vae <vae.safetensors> --llm <encoder.gguf> \
    [--llm_vision <mmproj.gguf>] [--listen-port 1234]   # sd-server's /sdcpp/v1 API: text to image, edits, Prompt+
.build/release/kokon-engine-mac bench        # a few minutes: speed and accuracy of this Mac's paths, a report
.build/release/kokon-engine-mac check-na     # the Metal 4 matrix product against MPS
.build/release/kokon-engine-mac check-ane8   # the int8 Neural Engine programs against the fp16 one
bash tools/ab.sh snapshot base; bash tools/ab.sh run 2 "base|base|X=1" "new|new|X=1" -- time-dit <dit.gguf> 64 32
bash tools/testset.sh 3 "base|base|" "new|new|"   # the fixed test set of an engine PR (see AGENTS.md)
python3 -I tools/compare_bench.py baseline-report.json kokon-bench-report.json   # two bench reports → PR tables
                                             # alternated A/B of build snapshots and settings (steps, page-ins)
```

In the app: Kokon.app carries the engine (1.7 MB: `Contents/MacOS/kokon-engine-mac`, the kernels in
`Contents/Resources/engine-mac/`; `tools/stage-app.sh`, called by `scripts/dev/mac-dev.sh` and
`scripts/build-release-mac.sh`), and Settings → Performance → "Kokon's Mac engine (experimental)" turns it on. Off by
default; at the first start on a Mac with 16 GB or more Kokon offers it once, before the model loads. sd.cpp stays the
default, the fallback, and the engine on Windows and Linux. Without the app's copy (a service run with `cargo run`),
`bash tools/install-dev.sh` puts the build in the stable-diffusion.cpp folder; `kokon-engine-mac kernels` prints where
the kernels were found.

## What is here

| File | What |
|---|---|
| `GGUF.swift` | GGUF reader; the file is mapped, never copied |
| `Quant.swift` | ggml's unpacking on the CPU (F32, F16, BF16, Q4_0, Q8_0, Q4_K, Q5_K, Q6_K), the reference |
| `Kernels/dequant.metal`, `GPUDequant.swift` | the same on the GPU, to `[n, k]` or `[k, n]`, fp32 or fp16 |
| `NeuralEngine.swift` | a matrix product on the Neural Engine: a small Core ML program written at run time, weight as an input |
| `Probe.swift` | GPU (MPS), AMX (Accelerate) and Neural Engine (Core ML) on Qwen's product shapes, alone and together |
| `QwenSequence.swift` | the joint text/image sequence, block-causal segments and RoPE positions |
| `QwenDiT.swift`, `Kernels/dit.metal`, `Attention.swift`, `Arena.swift` | the DiT: modulation on the CPU, everything per token on the GPU |
| `Coexecution.swift`, `Kernels/ane.metal` | the AMX and the Neural Engine beside the GPU on the DiT's products; the timeline of each split operation |
| `CPUProduct.swift` | the AMX's products: BNNS, fp32 or fp16 operands |
| `Balancer.swift` | the balancing loop: each evaluation's timeline sets the next one's rows and heads per unit |
| `Kernels/attention.metal` | fused block-causal attention |
| `AttentionSplit.swift`, `CPUAttention.swift` | the target's attention cut by heads: GPU, CPU (AMX + cores), optionally the Neural Engine |
| `AttentionProbe.swift` | `probe-attention`: the target's attention on each unit alone |
| `QwenVAE.swift`, `Safetensors.swift` | the VAE decoder as one MPSGraph, from Kokon's VAE file (Wan 2.2 names) |
| `QwenVAEEncoder.swift` | the VAE encoder (edits' reference images), checked against diffusers |
| `QwenVisionTower.swift`, `Kernels/vision.metal` | Qwen3-VL's vision tower from the mmproj GGUF (edits' reference images): patches, 27 blocks, merger and deepstack outputs |
| `QwenTokenizer.swift` | Qwen's byte-level BPE tokenizer, read from the encoder GGUF's metadata |
| `QwenTextEncoder.swift`, `Kernels/text.metal` | the text encoder: Qwen3-VL-8B's text decoder on the GPU, diffusers' prompt template |
| `QwenPipeline.swift` | text to image: noise, Turbo's 8 flow-Euler steps (`planner::TURBO_SIGMAS`), VAE, PNG; models kept loaded for the server |
| `EngineServer.swift`, `HTTPServer.swift` | `serve`: sd-server's `/sdcpp/v1` API (capabilities, img_gen, jobs, cancel, text_gen) and its log lines |
| `QwenTextGeneration.swift`, `Kernels/decode.metal` | Prompt+: the text encoder's LLM writes, K/V cache, products on the Q4_K / Q6_K blocks, sd.cpp's sampler |
| `Chip.swift` | this Mac's chip, GPU family, cores and memory; each unit's estimated speed against the M2 Pro's |
| `NeuralAccelerators.swift`, `Kernels/metal4/na_matmul.metal` | the GPU's rows of a product on Metal 4 tensor operations (the M5's neural accelerators) |
| `Bench.swift` | `bench`: the report testers paste in GitHub |

Tests check the CPU and GPU unpacking against gguf-py's values (`tools/make_quant_fixtures.py` writes the
fixture), and the sequence layout against diffusers' rules worked out by hand.

**The DiT against diffusers.** `tools/reference_dit.py` runs diffusers' own Qwen-Image 2.1 modules in fp32 on the
CPU, on Kokon's GGUF weights unpacked by gguf-py, and saves every stage; `check-dit` compares the engine with it:

```bash
python3 -m venv ~/kokon-bench/venv-oracle && ~/kokon-bench/venv-oracle/bin/pip install torch diffusers transformers gguf numpy
~/kokon-bench/venv-oracle/bin/python -I tools/reference_dit.py <dit.gguf> ~/kokon-bench/ref/dit-t2i-256   # ~30 s
.build/release/kokon-engine-mac check-dit <dit.gguf> ~/kokon-bench/ref/dit-t2i-256
.build/release/kokon-engine-mac time-dit <dit.gguf> 64 32        # 1024², 32 text rows, plus a profile
```

256² text-to-image, σ 0.7, 2026-10-25: every stage within 2e-5 relative of diffusers fp32 (velocity 6e-6).
unsloth's Qwen-Image 2.1 Turbo Q4_K_M (the file Kokon will ship with this engine; ComfyUI layout, each block's MLP
`gate_up` fused, read as two views): **check it against an fp64 reference** (`--dtype float64 --all-layers`, ~1 min).
On this file torch's own fp32 run drifts from layer 6 on, to 7.3e-5 of fp64 at the velocity, while the engine stays
within 3.9e-6 (every layer within 6.3e-6); on the old uniform Q4_K file both are within 4.1e-6 of fp64. The 7.2e-5
once measured against the fp32 reference was the reference's error, not the engine's.

**The text encoder against transformers.** The reference tokenizes with the processor of the official
Qwen/Qwen-Image-2.1-Turbo repository (`processor/` and `text_encoder/config.json`, a few MB) and runs transformers'
Qwen3-VL decoder layers in fp32 on the GGUF's weights, one layer at a time; `--sanity` checks the language model
head answers " Paris" to a factual prompt (it does), so the weights are read right and not only read alike.

```bash
~/kokon-bench/venv-oracle/bin/pip install torchvision huggingface_hub   # the processor needs torchvision
~/kokon-bench/venv-oracle/bin/python -I tools/reference_tokenizer.py <processor dir> ~/kokon-bench/ref/text/tokenizer.json
.build/release/kokon-engine-mac check-tokenizer <encoder.gguf> ~/kokon-bench/ref/text/tokenizer.json
~/kokon-bench/venv-oracle/bin/python -I tools/reference_text_encoder.py <encoder.gguf> <processor dir> <text_encoder dir> ~/kokon-bench/ref/text/fox --sanity   # ~50 s
.build/release/kokon-engine-mac check-text <encoder.gguf> ~/kokon-bench/ref/text/fox
```

2026-10-25: tokenizer identical on 42 cases (accents, CJK, emoji, decomposed Unicode, special tokens in the text);
conditioning within 5.1e-6 relative (37 tokens) and 5.6e-6 (144 tokens). One encode: 0.45 s (37 tokens), 0.8 s (144).

**With images** (an edit's prompt, `prompt_template_ti2i`): `<image1><|vision_start|><|image_pad|><|vision_end|>` before
the prompt, each `<|image_pad|>` expanded to the image's slots (one per 32 × 32 pixels), those rows the vision tower's
merged rows, Qwen3-VL's 3D M-RoPE positions (`get_rope_index`; interleaved sections 24/20/20), the three deepstack outputs
added to the image rows after layers 0–2, and the DiT told which conditioning rows are image slots (`image_pad_mask`).
`reference_text_encoder.py --image <png> --mmproj <mmproj.gguf>` runs the same in transformers; `--sanity` then also asks
the model the color of a red disk (it answers "Red": the mmproj is read right). `check-text <encoder> <dir> <mmproj>`,
the street cat at 384 × 256 (96 slots, 139 tokens; M2 Pro, 2026-10-25): ids, positions and image slots identical; the
conditioning within 7.5e-6 with the reference's own vision rows, 3.3e-5 with the engine's, whose tower is 7.9e-6 from fp64
on this photo where torch's fp32 is 3.0e-5 from it. One encode with the image: 0.82 s, its vision tower 0.56 s.

**Text to image against diffusers.** `tools/reference_generate.py` runs QwenImage21Pipeline's loop with the
references above (diffusers' scheduler on the checkpoint's sigmas, the DiT layer by layer, the VAE, the image
processor) and saves its noise; `check-generate` starts the engine from that noise:

```bash
~/kokon-bench/venv-oracle/bin/python -I tools/reference_generate.py <dit.gguf> <vae.safetensors> ~/kokon-bench/ref/text/fox <repo dir> ~/kokon-bench/ref/generate-256   # ~5 min
.build/release/kokon-engine-mac check-generate <encoder.gguf> <dit.gguf> <vae.safetensors> ~/kokon-bench/ref/generate-256 [~/kokon-bench/ref/text/fox]
.build/release/kokon-engine-mac check-steps <dit.gguf> ~/kokon-bench/ref/generate-256 ~/kokon-bench/ref/text/fox
```

`check-generate` with the text reference starts from its conditioning instead of the engine's encoder;
`check-steps` runs each step alone on the reference's own latent, so one evaluation's error is not mixed with what
the trajectory makes of the steps before.

Unsloth's DiT + the texture-fix VAE, 256², fp64 reference (`--dtype float64`), 2026-10-25: each step alone within
1.4–2.9e-6 of fp64 except step 4 (σ 0.93) at 6.6e-5, an ill-conditioned evaluation (torch's fp32: 2.7e-5 there).
Along the trajectory the final latent ends within 5.8e-5 (torch fp32 1.2e-5), the image within 7.6e-5, 782 of
262 144 8-bit values off by 1; with the engine's own text encoder (5e-6 off) the same order. These shift by a few
times with any change of rounding order (the old flash kernel: 1.9e-5), as torch's fp32 shifts from fp64.

Old uniform Q4_K DiT + original VAE, 256², fp32 reference: each step's latent within 6.7e-6 relative, the image within 1.0e-5, 97 of 262 144 8-bit values
differ by 1. **First 1024² image (M2 Pro, `generate`): 100.7 s in all**, text encoder 1.7 s, 8 steps of 11.4–12.9 s,
VAE 5.4 s with its graph build; peak memory 4.1 GB (Kokon's sd.cpp: ~4.5 min).

**The seed's noise is sd.cpp's** (`Noise.swift`: its default Philox generator, the latent filled in the same
order), so a seed starts from the same latent as in Kokon today. Bit for bit against sd.cpp's own code compiled as
Kokon's macOS engine is (Apple clang, Release: `x · a + b` fused), 8 seeds × 263 144 values; without the fused
multiply-add 0.7 % of the values differ in the last bit:

```bash
clang++ -std=c++17 -O3 -I <stable-diffusion.cpp>/src tools/philox_reference.cpp -o philox && ./philox > philox.bin
.build/release/kokon-engine-mac check-noise philox.bin
```

## First measurements (M2 Pro 19-core GPU, 16 GB, macOS 27, 2026-10-25, `probe`)

m = 4 096 rows (a 1024² image), TFLOP/s:

| Product k × n | GPU fp32 (MPS) | AMX fp32 | Neural Engine fp16 | All three, cut by rows |
|---|---|---|---|---|
| 4096 × 4096 (q, k, v, out) | 5.1 | 1.7 | 7.4 | 11.0 |
| 4096 × 12288 (MLP gate, proj) | 5.1 | 1.9 | 7.4 | 11.5 |
| 12288 × 4096 (MLP out) | 4.8 | 1.6 | 7.4 | 9.4 |

- The Neural Engine must get its products in pieces of at most 4096 × 4096: a 4096 × 12288 weight in one
  program ran at 2.7.
- The products of a DiT step at 1024² (57 TFLOP) take 11.3 s on the GPU alone and 5.3 s on all three
  (sd.cpp today: 27.4 s per step, all included). The AMX is the one the others wait for: the split by rows needs
  the balancing loop.
- Neural Engine numbers leave out the fp32 ↔ fp16 conversions and scaling it needs; the plan is to have the
  GPU write its inputs straight into the Neural Engine's buffers.

**One DiT evaluation at 1024² (32 text rows), GPU only: 16.2 s** (sd.cpp: 27.4 s): products 11.6 s, attention
(MPSGraph) 4.1 s, unpacking 0.2 s, the rest 0.3 s. Every product goes to MPS on a multiple of 64 rows: one product
of 32 rows (the text projection) slowed all later ones to 18.5 s.

**With the AMX and the Neural Engine on the products** (`Coexecution.swift`; rows GPU 1856 / AMX 256 / Neural
Engine 2048 at 1024²): **11.3 s per evaluation at 1024²**, 8.8 s at 896². The GPU packs the Neural Engine's fp16
operands straight into its IOSurfaces and unpacks its output, so the CPU only runs the AMX. Accuracy at 896²
against diffusers fp32: the velocity within 3.6e-4 relative (GPU alone 4.4e-6); running the model in bf16, as
most tools do, deviates by roughly 1e-2. 
**Attention** is a fused (flash) kernel of our own (`Kernels/attention.metal`, fp32, online softmax in registers,
block-causal mask, 64 keys a tile): 120 ms for the target's 32 heads at 1024² alone (2.3 TFLOP/s; the first version
145 ms, MPSGraph ~128 ms) and without MPSGraph's score matrix (2.2 GB at 1 MP, ~34 GB at 4 MP).
`KOKON_ATTENTION=graph` keeps MPSGraph for comparison.

**The target's attention is cut by heads** (`AttentionSplit.swift`) as the products are by rows: GPU heads in the
flash kernel, CPU heads in `CPUAttention` (AMX for the two products, vvexpf on 8 threads for the softmax, fp32,
written straight into the GPU's output). `probe-attention`, ms per head alone: GPU 3.8, CPU 6.6, Neural Engine 5.1
in programs of 4 heads × 1 024 queries (head 0 within 2.2e-3 of exact: fp16). Together at 1024², per layer: GPU
alone 145 ms; GPU 19 / CPU 13 91 ms at no cost in accuracy; with Neural Engine heads ~1.5 % more, because the GPU's
heads slow from 4.5 to 6.3–7.0 ms beside it (memory and cache), for 2.5× the velocity error (9.3e-4 against 3.6e-4
at 896²): Neural Engine heads only with `KOKON_ANE_ATTENTION=1`.

**The balancing loop** (`Balancer.swift`): each evaluation's timeline (when the GPU released each split operation,
when each unit finished its share) gives each unit's rate per kind of operation beside the others, and the next
evaluation's shares follow: the AMX's rows per product shape (steps of 64, remembering measured counts: its rate
is not linear in rows), the Neural Engine's rows (steps of 256, a program set per count), the heads. On the M2 Pro at
1024² it moves from 1856 / 256 / 2048 rows and 19 / 13 heads to about 1728 / 320–448 / 2048 and 21 / 11 in two
evaluations; every product's units then finish within ~0.3 ms of each other (before: the GPU 3–15 ms after the
AMX). `KOKON_BALANCE=0` keeps the starting shares; `KOKON_HEADS=g,a,c` fixes the heads.

**One evaluation at 1024², all three units, unsloth's DiT: 8.7–8.9 s** (start of this pass 11.6 s): products ~5.3 s
(≈11 TFLOP/s across the units, the probe's ceiling), attention 32 × 78 ms, the GPU alone between operations 0.6 s
(`time-dit` prints it by transition). The Neural Engine's per-column weight scales are computed once per weight, the
next product's weight is unpacked and packed for the Neural Engine while the current one runs (between operations
1.12 → 0.60 s, the evaluation ~0.1 s faster: the units were already full), and the modulation of all of the
pipeline's timesteps is computed once (it was 0.2 s of CPU per evaluation). The balanced shares are remembered per
Mac and shape (`~/Library/Caches/kokon-engine-mac/balance.json`), so the first step starts balanced.

**1024² image, M2 Pro, unsloth's DiT + texture-fix VAE (`generate`), 2026-10-25: 79.9 s** (text encoder 2.0 s, step 1
10.2 s, steps 2–8 8.8–9.1 s, VAE 5.2 s); at the start of this pass 100.2 s; Kokon's sd.cpp ~4.5 min. With
fp16 operands in the flash kernel, **the default since 2026-10-25** (`KOKON_ATTENTION=fp32` for the checks): 76.0 s,
the velocity within 6.0e-4 of fp64 at 256² (fp32 kernel 1.0e-5; bf16 tools ~1e-2); the two 1024² images differ by 0.25
levels on average, 0.18 % of values by more than 8. The accuracy figures above are the fp32 kernel's.

**fp16 operands in the products, the default since 2026-10-25** (`KOKON_WEIGHTS=fp32` and `KOKON_ACTIVATIONS=fp32`
for the checks): the weights are unpacked to fp16 (half the bytes written and read by every unit), the GPU casts
the GPU's and the AMX's rows of each input to fp16 once (shared by q, k, v and by gate, proj), MPS multiplies fp16 ×
fp16 into fp32 and the AMX runs BNNS instead of `cblas_sgemm` (alone, on its shares: fp32 1.3–1.9× faster, fp16
inputs 2–2.7×). The three units share one limit when they run together (memory or power: BNNS in fp32 alone moved
an evaluation only 8.54 → 8.3–8.5 s), so halving the bytes is what pays. One evaluation at 1024²: **8.54 → 7.45–7.55
s** (fp16 weights alone 8.0–8.1). The velocity at 896² against diffusers fp32 (old Q4_K file, `dit-t2i-896`): 7.0e-4,
against 5.1e-4 before (fp16 weights alone 5.7e-4; the Neural Engine's rows were already fp16); 256² end to end
(GPU only, fp16 weights and attention) against fp64: image within 2.4e-3, at most 13 levels off (fp32 path 7.6e-5);
re-measured at f4a8334 and after this pass (2026-10-25): 6.9e-3, at most 35 levels, the fp32 path 9.6e-5 (914 values
off by 1), the same at both.
The 1024² image against the previous precision: 0.05 levels on average, at most 6. **1024² image: 69.8 s** (text
encoder 2.0 s, step 1 8.4 s, steps 2–8 7.4–8.0 s, VAE 6.0 s).

**Attention retune after MFA's tables** (`probe-attention`, 1024², 32 heads, M2 Pro, 2026-10-25): K and V are
packed once per layer to fp16, heads first (`attention_pack_kv`, 1.1 ms), and the kernel reads them unconverted:
91.0 ms with the packing against 95.2, the same accuracy; per layer in the DiT the attention's wall 66.5–67.3 →
64.7–65.6 ms, an evaluation ~1 % (A/B in alternating runs; `KOKON_ATTENTION=unpacked` for the comparison). MFA's
M1/M2 shape (4 SIMD groups × 8 rows, 128-key tiles, the head in chunks of 32) on the same packed operands: 105 ms;
8 × 8 rows with 128-key tiles in chunks of 32: 94; 64-key tiles in chunks of 64: 104; so the kernel keeps 8 × 8
rows, 64-key tiles, K and V loaded together. MFA's shapes rest on its async copies, which run-time compiled Metal
cannot use. `flash_attention_direct` (`KOKON_ATTENTION_DIRECT=1`), each SIMD group reading the packed K and V
straight from memory as MFA's tables prefer on Apple9+ GPUs, is off on every chip since engine 0.1.1: 142 ms on the
M2 Pro, and slower on every M3, M4 and M5 measured (a step at 1024² in the bench reports of [Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43): M3 Max 5.45 → 4.83 s without it, M4 Pro 7.27 → 5.96, M4 Max 4.57 → 3.88, M5 Pro 5.79 → 5.34).

**Prefix K/V cache** (`KOKON_PREFIX_CACHE=0` turns it off): the prefix (text; later the reference images) sees only
its own keys and the modulation of t = 0, so its K and V are saved per layer during the first evaluation of a
conditioning (33 MB for 32 text rows) and every later evaluation runs only the target's rows, its attention reading
the saved prefix. `check-steps` and `check-generate` give the same numbers with and without it. 1024², alternated
runs (M2 Pro, 2026-10-25): evaluations after the first 7.35 s against 7.53 (−2.4 %: text-to-image has 32 prefix
rows of 4 128, and the products drop from 4 160 padded rows to 4 096); for an edit, whose reference image is a prefix
as long as the target, about half of each step. A pass of the prefix alone, before the first evaluation, took
1.86 s (products of 64 rows run far below the GPU's rate), so the first evaluation carries the prefix instead.

**The row kernels write the products' fp16 input** (`KOKON_FUSED_CAST=0` for the comparison): `layernorm_modulate`
(before q/k/v and gate/proj) and `swiglu` (before the MLP's out) write the GPU's and the AMX's rows straight to fp16
and fp32 only for the Neural Engine's rows, so the separate `pack_half` pass, which read the fp32 rows back, is gone.
The same values to the bit (check-dit at 896²: velocity 6.74e-4 either way). 1024², 3 alternated pairs of 4
evaluations (M2 Pro, 2026-10-25): 7.67 → 7.58 s per evaluation, the GPU alone between operations 0.71 → 0.64 s.

**q/k/v and gate/proj released as one operation each: measured, not kept.** Each unit ran its rows of the group's
products back to back (one release, one rendezvous; the Neural Engine on one program with pooled surfaces, the
group's weights unpacked side by side, one σ per row from the group's largest L: velocity at 896² 6.36e-4, no
worse). Between operations 0.60 → 0.53 s, but per evaluation, 3 alternated rounds of 4 at 1024²: 7.55 s without,
7.52 with gate/proj unpacked during `to_out`, 7.56 with them unpacked during the attention (which then took 78 ms
instead of 66). With the three units at their shared limit, the GPU-alone time moved into the products; what pays
is fewer bytes moved, as with the fp16 cast above.

**The row kernels pack the Neural Engine's rows, and the residual goes with the LN after it** (2026-10-26;
`KOKON_FUSED_PACK=0`, `KOKON_FUSED_RESIDUAL=0` for the comparison). From the second evaluation (every weight's L known):
the LNs and the SwiGLU compute the Neural Engine's rows' σ themselves and write them scaled and packed into its input
surfaces (`layernorm_modulate_ane`, `swiglu_ane`), where they wrote fp32 rows that `ane_row_scales` and `ane_pack_rows`
read back; gate's and proj's Neural Engine rows stay in their output surfaces (each program set has its own now) and the
SwiGLU reads them there instead of two fp32 unpackings; the residual after to_out and the one after the MLP out (carried
into the next layer's LN1) run in the LN's pass (`residual_layernorm`, `residual_layernorm_ane`), x read once and the
Neural Engine's rows of `o` taken from the product's surfaces. The velocity is the same to the bit (1024², fixed shares,
three evaluations, `KOKON_DUMP=<file> time-dit` with each switch; `check-generate` unchanged to every digit). Between operations an evaluation: 0.60–0.66 → 0.41–0.45
s (proj → MLP out 5.4 → 3.3 ms, gate → proj 1.3–2.6 → 0.07, to_out → gate 3.3 → 1.7–2.0, MLP out → q 3.4 → 2.5). Per
evaluation at 1024², 5 alternated rounds of 4 (M2 Pro, other apps open, ~4.5 GB of page-ins a run): median 7.71 → 7.34 s.

**The Neural Engine's rows packed once per input** (`KOKON_SHARED_ROWS=0` for the comparison): q, k and v read the
same rows, and so do gate and proj, but each product scaled and packed them again with its own σ. From the second
evaluation on (when every weight's L is known), an input's rows get one σ from the largest L of its readers and are
packed for the first only. Velocity at 896²: 6.36–7.02e-4 (6.74–6.88e-4 before). 1024², 3 alternated rounds of 4
evaluations (M2 Pro, 2026-10-25): 7.64 → 7.58 s, between operations 0.65 → 0.60 s.

**1024² image after this pass (M2 Pro, `generate`, 2026-10-25): 67.3–68.0 s** (text encoder 2.0 s, step 1 8.35 s,
steps 2–8 7.3–7.7 s, VAE 5.0–5.3 s with its first run at the size; 79.9 s at the start of the fp16 work, 76.0 with
fp16 attention). `MTLBinaryArchive` was not added: the engine's kernels compile from source in 0.1 s at start (macOS
caches compiled shaders), and the first image's real extra costs, the VAE's first run at a size and the Neural
Engine's programs, are not pipelines an archive holds. Only an M2 Pro has been measured.

## The engine as a server (`serve`)

`kokon-engine-mac serve` answers sd-server's `/sdcpp/v1` API (capabilities, img_gen, jobs/{id}, cancel), so
qls-core, the app, remote access and MCP use it as they use sd-server; it prints the log lines qls-core's
`ProgressParser` reads. Text to image, edits with reference images when started with `--llm_vision` (qls-core passes
the mmproj; below), and an init image with a mask (brushed edits, extending an image; below); LoRAs and second passes are
refused with 400 (qls-core says so before submitting), upscaling falls back to Lanczos. Prompt+ works on every prompt (`text_gen`,
below), looking at the images of an edit with the vision tower. A running image
cancels within a DiT layer (sd-server answers 409 and qls-core restarts it). A new prompt length rebuilds the DiT's
working memory in ~0.5 s.

What stays loaded between images depends on the Mac (`QwenPipeline.keep*`): from 32 GB everything; below, only the
files' mappings. Through the API (`tools/api_check.py`, M2 Pro 16 GB, 1024², 2026-10-25), with the VAE as single
operations and tiles (below): **first image 67.0 s, the next ones 63.9–64.5 s, peak 5.0 GB** (before it: 71.1 s, 73.7 s,
peak 9.6 GB). Keeping the compiled VAE between images now costs only 1.7 GB, but it did not pay on 16 GB: its decode
3.2 s instead of 4.0, the images 68.4–70.3 s (with the DiT kept too 70.8 / 68.3 s; single runs in a row, not alternated).

**Prompt+ (`POST /sdcpp/v1/text_gen`)**: the text encoder's LLM writes the prompt, as Kokon's sd.cpp does, on the same
Qwen3-VL Q4_K_M file (`QwenTextGeneration.swift`, `Kernels/decode.metal`): sd.cpp's chat template and stop tokens, its
sampler step for step (presence penalty, top-k, temperature, top-p, one draw from mt19937_64: a seed writes the same
text where no two logits nearly tie), its stream of whole UTF-8 characters, its Server-Sent Events, and a dropped
connection stops it. The prompt runs through the encoder's forward, which keeps each layer's K and V in an fp16 cache
(144 KB a token); then each token reads every weight once, so the decode's matrix-vector products read the Q4_K and
Q6_K blocks where they lie in the mapped file. Text and image generation take turns on the GPU.

Against transformers (`check-textgen` + `tools/reference_text_generation.py`: the engine writes greedily, transformers'
fp32 decoder layers then run once on the prompt and those tokens; 68-token prompt, 48 tokens, M2 Pro, 2026-10-25): the
prompt's ids identical, the first token's logits within 3.2e-6, the next ones within 4.6e-4 (the fp16 cache: with an fp32
cache every step within 3.2e-6), the greedy choice the same at all 48 (one near-tie at 0.04 among them).

```bash
.build/release/kokon-engine-mac check-textgen <encoder.gguf> ~/kokon-bench/ref/textgen-cat     # writes engine.json
~/kokon-bench/venv-oracle/bin/python -I tools/reference_text_generation.py <encoder.gguf> <processor dir> <text_encoder dir> ~/kokon-bench/ref/textgen-cat
.build/release/kokon-engine-mac check-textgen <encoder.gguf> ~/kokon-bench/ref/textgen-cat     # compares
.build/release/kokon-engine-mac time-matvec <encoder.gguf>      # the decode's products alone, GB/s
```

Speed (M2 Pro 16 GB, 2026-10-25): **a token in 32 ms (31 tokens/s; ~4.9 GB read a token, ~155 GB/s)**; Kokon's
built-in system prompt and a short request, through the server: 481 prompt tokens, 142 written, 6.6–7.8 s (prefill
1.8–2.4 s, 26.8–29.5 tokens/s as the cache grows; 8.2 s while the sampler looked the presence penalty up in a set for
each of the 151 936 tokens, a dense array now as sd.cpp's). The products' kernels (`time-matvec`, GB/s on the file's weights): one lane per 64
values, one row per SIMD group: Q4_K 25–49, Q6_K 39–53, 10.5 tokens/s; 8 lanes a block with wide loads, 2 rows: Q6_K
115–182; Q4_K 4 rows: 51–68; its scales and mins unpacked from one 16-byte load without a branch (they were half its
time): 112–120. One compute encoder per token instead of one per kernel (~500): no change (32.5–34.9 ms against
31.8–32.5), not kept. Of a 12-token prefill's 2.2–2.5 s, ~2 s is opening the encoder (0.46 s with it warm): when the
encoder is not kept between images (below 32 GB), the one Prompt+ opened is handed to the next image's encode. Through
the API at 1024², alternated (`tools/api_check.py --enhance`): the image's text encoder 0.88 s after Prompt+ against
2.1–2.65 s for a plain image, peak footprint 5.1 GB either way; Prompt+ adds 8.7–9.0 s to an image (75.4–77.2 s against
65.6–71.3).

## Edits (reference images)

As `QwenImage21Pipeline` with `image`: each reference goes through the vision tower into the text encoder's slots (the
ti2i template, deepstack, 3D positions; above) and through the VAE encoder (`_encode_vae_image`) into the DiT's prefix:
its latent tokens sit in the encoder's slots of that image (2 × 2 tokens a slot, `QwenSequence`), are modulated from
t = 0 like the text, and see only what precedes them plus themselves (block-causal), the target last. sd-server's
`ref_images` as Kokon sends them: Standard detail (`resize_before_vae=false`) encodes each reference at its own size;
otherwise sd.cpp's rule, resized to the output's area at its aspect, sides rounded to 32, nearest neighbour; the vision
tower sees what the VAE encodes (sd.cpp's `vlm_use_vae_input`). Sides must be multiples of 32.

Against diffusers (`reference_generate.py` on a `reference_text_encoder.py --image` directory: the street cat at
384 × 256, "Turn the cat into a small red fox, keep the street and the light", output 384 × 256, fp32, M2 Pro,
2026-10-25), `check-generate <encoder> <dit> <vae> <dir> <text dir> [mmproj]`:

| | final latent | image | 8-bit values off |
|---|---|---|---|
| the reference's conditioning and latents, fp32 path | 1.7e-6 | 4.0e-6 | 68 of 393 216, by 1 |
| the engine's vision tower, text encoder, VAE encoder, fp32 path | 2.3e-6 | 4.8e-6 | 89, by 1 |
| the same, default path (fp16 products and attention) | 1.8e-4 | 3.6e-4 | 5 083, by at most 2 |

**The prefix K/V cache holds the references' rows too**, in fp16 when the attention reads fp16 (the default): the same
values to the bit for the GPU's heads. A 1 MP reference is ~4 100 prefix rows, 2.1 GB of fp16 cache. When fp16 does not fit
the limit (1.5 GB below 32 GB of memory, an eighth of it from 32 GB, not measured there; `KOKON_PREFIX_CACHE_MB`), the cache
is **int8**, one scale per 32 values (`pack_q8`/`widen_q8`), if that fits: 1.2 GB at 1 MP. Its cost, the cat edit at
384 × 256 against diffusers on the default path: the image within 2.4e-3, at most 7 levels off, against 3.6e-4 and 2 levels
with fp16 (one scale per 128 values: 3.2e-3, 16 levels, no faster). Chosen as the default for 16 GB Macs (Gabriele,
2026-10-26); `KOKON_PREFIX_CACHE=fp32|fp16|q8|0` to choose.

**The working memory** (`QwenDiT.Memory`): `attended` shares `normed`'s storage, the MLP's first half lives in q, k and v
(free by then), and the weights' reserves are sized for fp16: 2.3 → 1.55 GB at 8.1k rows, the same values to the bit. The
evaluations that run the target alone (with the cache) get a memory of their own, rows from the prefix on (1.08 GB at 1 MP),
the other released first, when that saves at least 256 MB (`KOKON_TARGET_MEMORY=0|1`).

M2 Pro 16 GB, edits with the reference at the output's size, alternated:

| reference and output | cache | steps 2–8 | image | page-ins an image |
|---|---|---|---|---|
| 768 × 448 | off | 4.9–5.0 s | 46.2 s | 12.1 GB |
| 768 × 448 | 0.72 GB fp16 | 3.5 s | 38.1 s | 13.3 GB |
| 1344 × 768 (2026-10-25) | off | 16.6–17.1 s | 147.7–150.1 s | 20.9 GB |
| 1344 × 768 (2026-10-25) | 2.13 GB fp16 | 14.8–20.4 s | 144.2–158.7 s | 40.4 GB |
| 1344 × 768, working memory above (2026-10-26) | off | 16.4–18.8 s | 145.9–154.3 s | 13–41 GB |
| 1344 × 768, working memory above | 2.13 GB fp16, target's memory | 13.4–19.7 s | 136.3–156.9 s | 42–53 GB |
| 1344 × 768, working memory above | **1.20 GB int8**, target's memory | **10.2–11.3 s** | **106.1–107.4 s** | 29–32 GB |
| 1344 × 768, working memory above | 1.10 GB int8 per 128 values | 10.2–13.0 s | 105.0–109.6 s | 26–31 GB |

Page-ins vary with what else the Mac runs: during these runs free memory sat near zero (12.5 of 16 GB used, 4.6 GB of swap),
and every configuration still reads ~2 GB of the DiT's pages a step. A 1 MP
edit: vision tower 2.5 s (1.6–1.8 s since 2026-10-26, below), text encoder 3.7 s (1 037 tokens), VAE encoder 0.8 s, step 1 ~20 s, then ~10.4 s, VAE 4.6–5 s; peak footprint
5.0 GB. Through the server (`tools/api_check.py --ref … --enhance`, 768 × 448): Prompt+ looking at the reference 5.5–6.8 s
(vision 0.6 s, 742 prompt tokens), the edit 36.4–37.3 s, peak footprint 3.6 GB.

**Prompt+ with images**: sd.cpp's template (`<|vision_start|><|image_pad|><|vision_end|>` before the prompt, `<imageN>`
labels when several, each side rounded to 32), the prefill with the images' rows, positions and deepstack, then the
decode at positions offset from the cache slots (an image's slots advance the position by max(rows, columns), not by
their count). `check-textgen <encoder> <dir> 48 <image> <mmproj>` against `reference_text_generation.py --mmproj` (the
cat, Kokon's edit system prompt, "make the cat a small red fox"): the first token's logits within 2.5e-6, every step
within 6.8e-4 (the fp16 cache), the greedy choice the same at 23 of 23.

```bash
~/kokon-bench/venv-oracle/bin/python -I tools/reference_text_encoder.py <encoder.gguf> <processor> <text_encoder> ~/kokon-bench/ref/text/cat-edit --prompt "..." --image cat-384x256.png --mmproj <mmproj.gguf> --sanity
~/kokon-bench/venv-oracle/bin/python -I tools/reference_generate.py <dit.gguf> <vae> ~/kokon-bench/ref/text/cat-edit <repo dir> ~/kokon-bench/ref/edit-cat-384 --size 384x256   # ~6 min
.build/release/kokon-engine-mac check-generate <encoder.gguf> <dit.gguf> <vae> ~/kokon-bench/ref/edit-cat-384 ~/kokon-bench/ref/text/cat-edit [<mmproj.gguf>]
.build/release/kokon-engine-mac generate <encoder.gguf> <dit.gguf> <vae> "make the cat a fox" --ref in.png --mmproj <mmproj.gguf>
```

**Brushed edits and extending an image** (`init_image`, `mask_image`, `strength`; Kokon sends them with its references,
both at the output's size): as Kokon's sd.cpp runs Qwen-Image 2.1 (pipeline/image.cpp, diffusion_engine.cpp). The init
image goes through the VAE encoder as a reference does; `strength` cuts the schedule (`t_enc = int(8 · strength)`, at most
7, from sigma index `7 − t_enc`: strength 1 runs all 8 steps, 0.6 runs 5); the start is `(1 − σ₀) · init + σ₀ · noise`
(the noise itself at σ₀ = 1); the mask is read as stb_image reads it (8-bit gray as stored), each value / 255 rounded,
then the largest of each 16 × 16 block (`NearestMax`), and outside it each step's x₀ prediction is the init, so the latent
there stays the init's own noising and ends on the init.

`reference_generate.py --init --mask --strength` writes it as diffusers' inpaint pipelines loop (`scale_noise` start, the
init noised to the next σ blended in after each step: the same latent algebraically, written independently) with sd.cpp's
schedule and mask rules. The street cat at 384 × 256 as init and reference, a feathered mask over the cat, "Turn the cat
into a small red fox…" (M2 Pro, 2026-10-26):

| | strength 1 (8 steps) | strength 0.6 (5 steps) |
|---|---|---|
| the reference's conditioning and latents, fp32 path | image 1.9e-6, 34 values off by 1 | 1.7e-6, 34 by 1 |
| the engine's vision tower, text encoder, VAE encoder, fp32 path | 3.2e-6, 60 by 1 | 3.1e-6, 67 by 1 |
| the same, default path | 2.1e-4, 1 384 by at most 2 | 1.6e-4, 1 181 by 1 |

```bash
~/kokon-bench/venv-oracle/bin/python -I tools/reference_generate.py <dit.gguf> <vae> ~/kokon-bench/ref/text/cat-edit <repo dir> ~/kokon-bench/ref/inpaint-cat-384 --size 384x256 --init cat-384x256.png --mask mask-cat-384x256.png --strength 1
.build/release/kokon-engine-mac check-generate <encoder.gguf> <dit.gguf> <vae> ~/kokon-bench/ref/inpaint-cat-384 ~/kokon-bench/ref/text/cat-edit [<mmproj.gguf>]
```

## Per-chip paths

Selected at run time from the GPU family and the chip (`Chip.swift`), each with the M2 path as its fallback and a
correctness test that runs on any Mac (`PerChipTests`). Only the M2 Pro has measured them; `bench` measures the rest.

- **GPU products on Metal 4 tensor operations** (`na_matmul`, MetalPerformancePrimitives' `matmul2d`; on the M5 they
  run on the GPU's neural accelerators, before it on the shader cores). Its source compiles at run time on macOS 27,
  so it is on wherever Metal 4 runs (`KOKON_NA=0` off). M2 Pro: 6.3 TFLOP/s against MPS's 5.6 at 1536 × 4096 × 4096,
  bit for bit the same result (`check-na`); per evaluation at 1024², 3 alternated rounds: 7.57 → 7.48 s.
- **int8 products on the Neural Engine** (libnnc's M3/M4 path; `KOKON_ANE_INT8=w8` int8 weights, `=1` int8 weights and
  rows). Opt-in on every chip, as their error does not depend on the chip. M2 Pro: one 1792 × 4096 × 4096 tile 10.1 ms
  in fp16, 8.3 ms with int8 weights, 7.0 ms in int8 (`check-ane8`); per evaluation 7.42 → 7.20 / 7.00 s; but the
  velocity at 896² goes from 7.6e-4 to 1.1e-2 / 4.1e-2 (one int8 scale per 4 096 weights where Q4_K has one per 32;
  activation rows with outliers). **Finer scales do not fix it** (2026-10-25, below): int8 stays opt-in.
- **int8 weights alone** (`KOKON_ANE_INT8=w8`) are broken in a whole generation: on every Mac in the bench reports and
  on the M2 Pro (2026-10-28) the image comes out black (non-finite) at 512² to 1024², with either DiT file, while one tile
  (`check-ane8`, 5.8e-3), `check-dit` at 896² (1.1e-2) and `time-dit` stay finite; turning off the prefix cache, the
  fused kernels, shared rows, the AMX, fp16 activations or Metal 4 does not fix it. Cause not found; out of the bench.
- **Each product released at once** where signals arrive late (`KOKON_FLUSH_READY=0` off, `=1` on): a wait on
  `ready` right after its signal, chosen by a ~50 ms measurement at the engine's start (`Coexecutor.signalArrivesLate`),
  every start, so a macOS update is seen. On the M5 Pro (macOS 26.6) a signal inside a command buffer reaches the CPU only at the next wait the
  command buffer encodes, which was after the GPU's own rows: the AMX and the Neural Engine ran after the GPU instead of
  beside it, and the balancer, reading ~1 ms for the GPU's rows, gave them almost nothing. M5 Pro 20-core, 24 GB,
  `time-dit` at 1024², 3 alternated rounds (third evaluation): 5.50–5.89 → 4.44–4.46 s. An M2 Max on macOS 26.2 shows
  the same starved shares; the Macs on macOS 27 do not, and there the wait costs ~2.5 % (M2 Pro, macOS 27.2: 6.83 →
  7.00 s), so it is not on by default.
- **Attention reading K and V straight from memory** (`flash_attention_direct`): off on every chip since engine 0.1.1
  (`KOKON_ATTENTION_DIRECT=1` to try it); a step at 1024² in the bench reports of [Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43): M3 Max 5.45 → 4.83 s without it, M4 Pro 7.27 → 5.96, M4 Max 4.57 → 3.88, M5 Pro 5.79 → 5.34.
- **Starting shares per chip**: the balancer's M2 Pro rates scaled by the chip's estimated units (GPU cores × clock,
  the Neural Engine's published TOPS, performance cores; `Chip.unitScale`), so the first image starts near balanced;
  the loop measures the real rates from the first evaluation on.

## Testing on your Mac (`bench`)

For anyone with an Apple Silicon Mac, to measure these paths on hardware we do not have (M1, M3, M4, M5, base chips).
In Kokon: Settings → Performance, turn on Kokon's Mac engine and save, then **Benchmark this Mac → Run** (~10 min; the
server is stopped while it runs and images wait). It runs the same `bench` on the app's engine and model files, shows
the step it is on, and gives the report with Copy report and a link to
[Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43). From the source:

```bash
git clone https://github.com/GabrieleLozupone/kokon.git && cd kokon && git checkout macos-optimization
bash engine-mac/tools/bench.sh            # ~10 min; --quick: one image per run
```

It needs the Xcode command line tools and Kokon's model files (Kokon set up once, or `--encoder`, `--dit`, `--vae`),
and writes `kokon-bench-report.md`: chip, GPU family and cores, memory, macOS, the paths selected, the units' shares,
time per step and per image at 1024² (image 1 with the loading, image 2 with the engine already running, 10 s after image 1; each split into text encoder, DiT load, step 1, steps 2–8 and VAE), peak memory, and accuracy at
512² against the engine's own fp32 GPU path on the same Mac (the first step's velocity and the image, in 8-bit
levels), then the same with each chip-specific path off (and the int8 path on, on M3 and later). Paste it in
[Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43). A row with a path off that is faster than the default means that path should not be on for that
chip. Close other apps and keep the Mac plugged in: the units share one power and memory limit.

## Tried and not kept, the VAE, credits

**Reading the models back into the file cache after each image (prefetch): measured, not kept** (M2 Pro 16 GB,
Benchmark button, 2026-10-26; commit ce9185f). Below 32 GB a second image takes 3–7 s more than the first, with the steps
unchanged: text encoder ~2 s, step 1 0.5–3 s, VAE 0.3–0.8 s. Tried: after the decode, the files not kept (encoder, DiT,
VAE, ~10 GB) read on a utility thread, 10 s before the next image. Image 2's text encoder 4.24 → 3.93–4.00 s only, step 1
8.68 → 9.84–11.00 s and VAE 3.54 → 3.98–4.25 s: on 16 GB the files do not all fit with the engine's own memory, so the
later files push out the earlier ones and the engine's memory. Where image 2's extra time goes is not measured yet.

**The Neural Engine on its own rows through the layer while the GPU attends (lanes): measured, not kept** (M2 Pro,
2026-10-26; patch in `~/kokon-bench/patches/lanes-2026-10-26.patch`). In the joint split the Neural Engine idles through
each layer's attention (~66 ms of ~230 at 1024²). Tried: the Neural Engine takes the target's last r rows through every
product of the layer (to_out, gate, proj, MLP out, the next q, k, v), its rows' attention computed first and its glue
(unpack, residual, LN, SwiGLU, packing, its weights unpacked straight from Q4_K into lifted tiles) on the GPU; the GPU and
the AMX take the other rows; the two meet only at the attention. The velocity is the joint split's to the bit with the
same shares, so only speed decided. A first experiment said it could pay: N product tiles on the Neural Engine during
each attention slowed the GPU's heads 66 → 67–68 ms and the CPU's 70 → 72–87.
- Glue on a second Metal queue: its kernels got the GPU only between the main queue's long ones, 10–40 ms late each
  (cutting the products into 256-row pieces and the attention into 4-head pieces changed nothing): 8.1–8.2 s an
  evaluation against 7.4 joint.
- Glue on the one queue, each step placed where the Neural Engine is predicted done: the Neural Engine still idles
  31–45 ms a layer while its rows are attended, its weights must be unpacked again mid-attention, and each unit's rate
  per row barely changes (during the products the units were already full). Alternated in one process at each one's
  shares (`check-lanes`): r = 2304 8.20 s against 7.88 joint (1792 rows), r = 2048 8.32 against 8.03.

**int8 on the Neural Engine with finer scales: measured, not kept** (M2 Pro, 2026-10-25). First the accuracy, with
int8 rounding simulated on the fp16 path (each column's weights, or each row's values, rounded to 127 levels of its
own piece of K, then packed as fp16), velocity at 896² against diffusers fp32 (`dit-t2i-896`; fp16 path 7.6e-4):

| int8 grid | weights | rows |
|---|---|---|
| one scale per column / row (today's int8 path) | 1.1e-2 (the measured int8 program's) | 3.0e-2 |
| pieces of 512 / 256 / 128 | 1.3e-2 / 6.4e-3 / 7.7e-3 | – / 1.4e-2 / – |
| pieces of 64 / 32 | – / 4.8e-3 | 8.1e-3 / – |
| weights and rows, pieces of 256 | 1.7e-2 | |

So even one scale per 32 weights stays 6× fp16's error: Q4_K's 4-bit grid rounded again to 127 levels. Only Q4_K's own
codes with its per-32 scale and offset would be exact, and the scales of a weight given at run time must be program
inputs; timed on one 1792 × 4096 × 4096 tile, the Neural Engine then runs slower than in fp16: fp16 8.2 ms, int8 with
one constant scale 4.8, int8 with scales per 256 as an input 10.0, per 32 10.6, per 32 with offsets 11.2 (K in two
pieces of 2 048: 10.9 / 11.7). The int8 path stays opt-in (`KOKON_ANE_INT8`); activation smoothing was not tried,
since the weights alone already miss the target.

MFA's GEMM (libnnc, 48 × 48 blocks, 2 × 2 SIMD groups) was tried against MPS: its async copies are an AIR intrinsic
that macOS 27's run-time compiler refuses (libnnc ships prebuilt metallibs for it), and without them it ran at
3.6–4.0 TFLOP/s against MPS's 5.1–5.6 at 1472 × 4096 × 4096, so MPS stays.

**VAE decoder** (`check-vae`, against `tools/reference_vae.py`, diffusers fp32): within 1.0–1.4e-5 at 256² and 768²,
1 level off at most. As one MPSGraph it took 2.78 s at 1024² (first run 4.5–5.0 s) but **kept 8.5 GB after the decode**
(peak 9.7 GB): a compiled graph keeps every intermediate tensor (up blocks 1 and 2 alone 2.4 and 4.1 GB). A graph that is
a single convolution keeps nothing beyond the buffers it is given, so the up blocks now run as single operations: each
convolution a graph with its bias, skip and shortcut fused and the weights as inputs (as fast as constants, shared across
sizes), norm + SiLU, nearest 2× and the DupUp shortcut as kernels (`vae.metal`), on pooled buffers, all in one command
buffer. Up blocks 3–4 and the head run in tiles of 288 (2 × 2 at 1024²) that read 10 pixels beyond their share, their
reach: the result is the whole graph's (1.2e-7; a 2-pixel halo is 17 levels off). M2 Pro, 1024², `time-vae`, alternated:

| VAE | decode (first) | kept after | peak |
|---|---|---|---|
| one graph | 2.78 s (4.5–5.0) | 8.5 GB | 9.7 GB |
| operations, untiled | 2.70 s (3.5) | 2.25 GB | 6.9 GB |
| **operations, blocks 3–4 in tiles of 288 (default)** | **3.0 s (3.25)** | **1.67 GB** | **4.6 GB** |
| operations, tiles of 144 | 3.9 s | 1.47 GB | 3.85 GB |
| graphs per block, every block tiled | 3.45 s | 3.8–5 GB | 6.25 GB |

**The mid stage as operations too, the compiled operations shared by every instance** (2026-10-26; `KOKON_VAE_MID_OPS=0`
for the graph): below 32 GB the pipeline makes a new VAE for each image, which converted its ~260 M weights bf16 → fp32
one value at a time and compiled every graph again (the mid stage's with its ~54 M weights as constants). Now the weights
are widened 8 at a time on every core straight into their buffers, the convolution and attention graphs (weights as
inputs) are cached across instances, and the mid stage runs as the up blocks do (its one-head attention a graph of its
own). `time-vae` at 1024², M2 Pro: a new instance's decode 3.9–4.1 → 3.1 s, the first 4.2 → 3.2, the next ones 3.05
either way (the up blocks run at the GPU's fp32 rate, ~16 TFLOP in ~3 s), 1.67 → 1.52 GB kept after it, peak 4.6 → 4.5.
`check-vae` against diffusers: 1.11e-5 at 256² (graph mid stage 1.04e-5), 1.37e-5 at 768², 1 level off at most.

The untiled peak grows with the image; the tiles keep it bounded. Buffers the GPU used leave the footprint up to a second
after their release (`time-vae` waits 1.5 s). `KOKON_VAE_OPS=0`, `KOKON_VAE_SPLIT`, `KOKON_VAE_TILES` to compare.
fp16 up blocks (norms and the mid block kept fp32) are wrong (2.7e-1) and 3–11× slower only when MPSGraph may place
them on the Neural Engine (optimization level 1, its default); at level 0 they stay on the GPU and are right but
gain little: all five 2.43 s against 2.77 at 1024², for 2.7e-3 of diffusers instead of 1.1e-5 (up to ~19 levels off).
The VAE stays fp32 (2026-10-25).

**VAE encoder** (`QwenVAEEncoder.swift`; for the reference images of edits): the down blocks as single operations as
the decoder's up blocks (its convolution graphs, one with stride 2 and the zero row and column after the input; the
AvgDown shortcut as a kernel, with the zero frame the single image is padded by counted in its average), the mid block
and the head as one graph at 1/16 of the image, then the posterior's mode normalized as the edit pipeline does.
`check-vae-encoder` against `tools/reference_vae_encoder.py` (diffusers fp32, a smooth random RGBA image, 256 × 192,
texture-fix VAE, M2 Pro, 2026-10-25): the latent within 6.5e-6. 1024²: 0.59 s an encode, peak 2.4 GB, 0.87 GB kept after
(its weights); in its own autorelease pool (without one, a loop on a thread without a pool kept 1.5 GB per encode).

**Vision tower** (`QwenVisionTower.swift`; what an edit's reference image becomes in the text encoder's
`<|image_pad|>` slots): Qwen3-VL's ViT from Kokon's mmproj GGUF (llama.cpp's layout: the Conv3d as one kernel per frame,
fused q/k/v, `mm.0`/`mm.2` the merger, `v.deepstack.8/16/24`), fp32 on the GPU with the F16 weights unpacked before each
product. The patches in the processor's 2 × 2 merge-block order, the two frames' kernels summed (both frames are the
image), the 48 × 48 position table resampled bilinearly, axial 2D RoPE, the 72-dimension heads on the DiT's fp32 flash
kernel built for 72 (`flash_attention_72`). Its input is the processor's: alpha over white as PIL's paste, and below 65 536 pixels the processor's
resize (torchvision's uint8 antialiased bicubic: PIL's kernel with int16 weights, horizontal pass first; bit for bit).
`check-vision` against `tools/reference_vision.py` (transformers' `Qwen3VLVisionModel`, M2 Pro, 2026-10-25), 320 × 224:
the pixels within 1.6e-7 (float rounding), the merged rows within 1.35e-5 of torch fp32 and **7.6e-6 of fp64**
(`--dtype float64`; torch's own fp32 is 1.55e-5 from it), deepstack 3.8–9.4e-6; 256 × 192 (resized to 320 × 224) and
an RGBA image the same. 1024²: 1.6–1.8 s an encode (4 096 patches), 2.6–2.7 s while the heads were zero-padded to 128
(~1.8× the attention's work; the same values to the bit, `check-vision` and `check-text` with the cat unchanged to every
digit; M2 Pro, 2026-10-26, other apps open).

```bash
~/kokon-bench/venv-oracle/bin/python -I tools/reference_vision.py <mmproj.gguf> <processor dir> <text_encoder dir> ~/kokon-bench/ref/vision-320 [--dtype float64]
.build/release/kokon-engine-mac check-vision <mmproj.gguf> ~/kokon-bench/ref/vision-320
```

Credits: the Neural Engine program technique and the GPU + AMX + Neural Engine split come from
[Siliconed](https://github.com/gwenn-ha-dev/Siliconed) (Apache-2.0), written again here.
