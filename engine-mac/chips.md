# Macs measured

One row per Mac the engine has been measured on: what it selects, how fast and how exact. Add yours with your pull
request or bench report ([engine-mac/AGENTS.md](AGENTS.md)); every number links to where it comes from.

Before working on a chip, look here and in [docs/mac-engine.md](docs/mac-engine.md) chapter 29 (tried and not kept).

| Chip | Mac (model, cooling) | Memory | macOS | Paths on by default | 1024² text to image | Velocity error (default) | Source |
|---|---|---|---|---|---|---|---|
| M2 Pro, 19-core GPU | MacBook Pro (Mac14,10), fans | 16 GB | 27 | Metal 4 products (7.57 → 7.48 s per evaluation); direct attention off (142 ms vs 91) | ~64–67 s; 1 MP edit ~106 s, peak 5 GB | ~6–7 · 10⁻⁴ | [README.md](README.md), [docs/mac-engine.md](docs/mac-engine.md) chapters 26, 28, 30 |

## Per-chip notes

### M2 Pro, 19-core GPU, 16 GB

- The engine was built and tuned on it, at 1024² only: other sizes are not tuned yet.
- int8 on the Neural Engine: an evaluation 7.42 → 7.00 s, but 1.1–4.1 · 10⁻² velocity error: opt-in.
- Neural Engine heads in attention: ~1.5 % faster, 2.5× the error: opt-in.
