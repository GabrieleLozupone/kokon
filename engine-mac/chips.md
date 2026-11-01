# Macs measured

One row per Mac the engine has been measured on: what it selects, how fast and how exact. Add yours with your pull
request or bench report ([engine-mac/AGENTS.md](AGENTS.md)); every number links to where it comes from.

Before working on a chip, look here and in [docs/mac-engine.md](docs/mac-engine.md) chapter 29 (tried and not kept).

| Chip | Mac (model, cooling) | Memory | macOS | Paths on by default | 1024² text to image | Velocity error (default) | Source |
|---|---|---|---|---|---|---|---|
| M2 Pro, 19-core GPU | MacBook Pro (Mac14,10), fans | 16 GB | 27 | Metal 4 products (7.57 → 7.48 s per evaluation); direct attention off (142 ms vs 91) | ~64–67 s; 1 MP edit ~106 s, peak 5 GB | ~6–7 · 10⁻⁴ | [README.md](README.md), [docs/mac-engine.md](docs/mac-engine.md) chapters 26, 28, 30 |
| M5 Pro, 20-core GPU | MacBook Pro 16" (Mac17,8), fans | 24 GB | 27.2 | Metal 4 products on 2 SIMD groups per tile; the target's attention on Metal 4 tensor operations; each product released at once (signals arrive late: still on macOS 27.2) | 28.9 s (test set, median of 3, macOS 27.2; 33.3 s with the engine's attention); edit 31.3 s, peak 5.3 GB | 4.4 · 10⁻⁴ (bench, vs the engine's fp32 path) | [README.md](README.md) "Per-chip paths", [docs/mac-engine.md](docs/mac-engine.md) chapters 13, 26 |

## Per-chip notes

### M2 Pro, 19-core GPU, 16 GB

- The engine was built and tuned on it, at 1024² only: other sizes are not tuned yet.
- int8 on the Neural Engine: an evaluation 7.42 → 7.00 s, but 1.1–4.1 · 10⁻² velocity error: opt-in.
- Neural Engine heads in attention: ~1.5 % faster, 2.5× the error: opt-in.

### M5 Pro, 20-core GPU, 24 GB

- A signal inside a command buffer reaches the CPU only at the command buffer's next wait (chapter 13; macOS 26, not
  the chip: an M2 Max on 26.2 too, the Macs on 27 not; measured at every start since 0.1.1): before
  `KOKON_FLUSH_READY` the AMX and the Neural Engine ran after the GPU's rows, and the balancer gave them almost nothing.
  With it, test set (3 alternated rounds, median): 1024² 49.0 → 39.6 s, 1344×768 48.3 → 39.9 s, edit 51.6 → 43.0 s.
- With the release fixed, `bench` still shows `KOKON_NA=0` (3.92 s per step) and `KOKON_ATTENTION_DIRECT=0` (3.86 s)
  ahead of the default (4.08 s): one run each. Direct attention is off on every chip since 0.1.1.
- `KOKON_ANE_INT8=1` works here (1.7 · 10⁻²; 1.6 · 10⁻² on macOS 27.2).
- The GPU's products run on the neural accelerators with MPS as with `na_matmul` (~32 TFLOP/s fp16 either way, MLX
  28–31). `na_matmul` was behind on long K and many rows with 4 SIMD groups per tile; with 2 (`KOKON_NA_SG2`) a step
  at 1024² 4.21 → 3.86 s, level with MPS (3.89), test set 1024² 37.2 → 34.4 s (3 alternated rounds, macOS 27.2).
- On macOS 27.2 the late signal is still measured here (`KOKON_FLUSH_READY` selected), unlike the other Macs on 27.
- The attention on the neural accelerators (`na_flash_attention`): 60.0 → 28.1 ms at 1024², a step 3.64 → 2.99 s; the
  balancer then gives the CPU 3 of 32 heads again.
- The balancer keeps about 2 600 of 4 096 rows on the GPU, 1 280 on the Neural Engine and 192–256 on the AMX, with
  either tile: its remembered shares do not tell the GPU paths apart, so whether a faster GPU should take more rows
  is not measured yet.
