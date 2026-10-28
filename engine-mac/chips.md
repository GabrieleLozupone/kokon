# Macs measured

One row per Mac the engine has been measured on: what it selects, how fast and how exact. Add yours with your pull
request or bench report ([engine-mac/AGENTS.md](AGENTS.md)); every number links to where it comes from.

Before working on a chip, look here and in [docs/mac-engine.md](docs/mac-engine.md) chapter 29 (tried and not kept).

| Chip | Mac (model, cooling) | Memory | macOS | Paths on by default | 1024² text to image | Velocity error (default) | Source |
|---|---|---|---|---|---|---|---|
| M2 Pro, 19-core GPU | MacBook Pro (Mac14,10), fans | 16 GB | 27 | Metal 4 products (7.57 → 7.48 s per evaluation); direct attention off (142 ms vs 91) | ~64–67 s; 1 MP edit ~106 s, peak 5 GB | ~6–7 · 10⁻⁴ | [README.md](README.md), [docs/mac-engine.md](docs/mac-engine.md) chapters 26, 28, 30 |
| M5 Pro, 20-core GPU | MacBook Pro 16" (Mac17,8), fans | 24 GB | 26.6.2 | Metal 4 products; each product released at once (signals arrive late: macOS 26) | ~40 s (test set, median of 3; master 49.0 s); edit ~43 s, peak 4.3–4.6 GB | 3.1 · 10⁻⁴ (bench, vs the engine's fp32 path) | [README.md](README.md) "Per-chip paths", [docs/mac-engine.md](docs/mac-engine.md) chapters 13, 26 |

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
- `KOKON_ANE_INT8=1` works here (1.7 · 10⁻²).
