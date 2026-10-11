# Engineering notes

How Kokon works inside, and the backend facts its design depends on. For using the app, see the
[README](../README.md).

## Architecture

```
Kokon.exe (Tauri 2 + React)      kokon-mcp.exe (MCP, stdio)      scripts
        │  loopback HTTP + SSE, token               │                        │
        └──────────────────────────────┬────────────┴────────────────────────┘
                                       ▼
                     kokon-service.exe  —  stable API  http://127.0.0.1:39151/api/v1
                     (engine: planner · preprocessing · job queue · gallery)
                                       │  native async API /sdcpp/v1/*
                                       ▼
                     sd-server.exe (stable-diffusion.cpp)  127.0.0.1:39150
```

| Crate / package | Responsibility |
| --- | --- |
| `crates/qls-core/src/geometry.rs` | Pure dimension math: 32-alignment, working canvas, outpaint/inpaint geometry |
| `imaging.rs` | EXIF orientation, alpha-safe resize, padding, masks, compositing, PNG metadata/ICC |
| `planner.rs` | Mode detection, resolution policy, upscale targets, memory budget (incl. Apple unified memory) |
| `pipeline.rs` | Builds backend requests, post-processes results (crop back, ESRGAN tiling, composite) |
| `sdcpp.rs` | Inference adapter — the only code that knows sd-server's schema |
| `process.rs` | sd-server launch/reuse/stop, log capture, truthful progress parsing |
| `engine.rs` | Async job queue, cancellation, OOM retry, saving |
| `speed.rs` | Per-machine speed calibration of time estimates |
| `diagnostics.rs` | GPU detection (nvidia-smi, DXGI, sysctl on macOS), readiness checks |
| `store.rs` | SQLite gallery + content-addressed inputs |
| `paths.rs` | Path validation (no UNC/device/ADS/traversal, never overwrite) |
| `catalog.rs`, `installer.rs` | Pinned downloads (URLs, sizes, SHA-256), hardware presets, parallel resumable downloader |
| `crates/qls-service` | Headless service and stable HTTP API; single instance; lifecycle |
| `src-tauri`, `src/` | Desktop shell (Rust) and UI (React + TypeScript); in-app updates in `src/lib/updates.ts` |
| `mcp/` | MCP server (TypeScript, official SDK) |

Internal names (`qls-core`, `qls-service`, `QLS_*` environment variables) come from the working title used
during development (Qwen Local Studio) and are kept on purpose. Executables carry `.exe` only on
Windows.

## Platforms and engines

Details and the reasoning are in [platforms.md](platforms.md); the short version:

| Platform | Engine (stable-diffusion.cpp `3f8527a`) | Folder | Launch differences |
| --- | --- | --- | --- |
| Windows + NVIDIA | CUDA 12 build | `<sdcpp>` | `--backend cuda0 --params-backend te=cpu`, SageAttention |
| Windows + AMD / Intel (also NVIDIA) | Vulkan build | `<sdcpp>/engine-vulkan` | `--backend vulkan0`, no SageAttention |
| macOS, Apple Silicon | Metal build (macOS 26+) | `<sdcpp>/engine-metal` | `--backend mtl0 --mmap`; 24 GB+: `--auto-fit off` (all weights on the GPU, zero-copy); 16 GB: `--params-backend disk` |

- `GpuBackend` in `config.rs` picks the engine, its folder, device name and flags. Each engine
  is a pinned download in `catalog.rs`, so both Windows engines can stay installed.
- GPU detection: `nvidia-smi`, then DXGI for other cards (name, vendor, dedicated VRAM), then
  `sysctl` on a Mac (chip, unified memory). A Mac's memory becomes the "VRAM" the planner uses
  through `planner::unified_memory_planning_mib`: Metal's share (~2/3, ~3/4 from 64 GB) minus
  the text encoder, which shares the same memory. Presets are labelled by Mac memory there.
- macOS paging does not relieve GPU memory: ggml keeps Metal buffers wired (residency sets), so
  16 GB Macs release each model after use instead (`--params-backend disk`).
- Time estimates: the time model was measured on an RTX 5070 Ti. `speed.rs` compares every
  finished backend job with the uncalibrated prediction and keeps a smoothed ratio per engine,
  GPU and memory mode (`<data>/speed.json`). Uncalibrated non-CUDA machines show no estimate
  until their first image.
- Startup: the window starts hidden and `public/boot.js` shows it once the splash in
  `index.html` is painted (the shell shows it after 4 s regardless).
- Updates: Tauri updater with a signed `latest.json` in the latest GitHub release; the shell
  stops the service before installing and replaces a running service of another version.
  Release steps in [releasing.md](releasing.md).

## Verified backend facts (stable-diffusion.cpp commit `3f8527a`)

- Native async API: `POST /sdcpp/v1/img_gen` → `GET /sdcpp/v1/jobs/{id}`; cancel works only for
  queued jobs (`cancel_generating: false`). Cancelling a running job therefore restarts the
  server when this app launched it.
- Qwen-Image 2.1 editing uses `ref_images` (labelled `<image1>`, `<image2>`… in order);
  references and canvas must be multiples of 32. Inpainting uses `init_image` + binary
  `mask_image` (white = regenerate). For Qwen 2.1 that mask is only a latent blend (it
  discards changes outside it; the model never sees it), so the app also sends the area
  marked in color on a second reference and prompts "the area marked in red in `<image2>`"
  (the official 2.1 way to point at a region). Removals blur the content out of `<image1>`
  first so the model rebuilds background instead of copying the object back.
- Sampling follows the official Qwen-Image 2.1 Turbo release (see Turbo below): `euler`,
  **no CFG**, its saved 8-step schedule, native 2K sizes. sd.cpp's own docs use CFG 6, which
  runs a second, unconditional model pass every step; the app used that until 2026-10-07.
  At CFG 1 the negative prompt is ignored, so the UI no longer offers one (the API still
  accepts it and notes that it was ignored).
  Presets (since 2026-10-09, Turbo only): **Fast** ~1 MP (the default), **Balanced** ~1.5K
  (1536²), **Quality** at the official 2K buckets (2048², 2752×1536…; edits share that budget
  with their reference images, so they land near 2 MP on 16 GB). Older preset names map on
  load: `turbo` → Fast, `ultra` → Quality.
- Default launch (CUDA; other engines above): `--backend cuda0 --params-backend te=cpu --fa --sage-attn --vae-tiling
  --vae-tile-size 768 --vae-tile-overlap 0.125 --max-vram -1` plus `--hires-upscalers-dir`
  when the upscalers folder exists (text-encoder weights in RAM, computed on the GPU). Measured
  on an RTX 5070 Ti: running the text encoder fully on the CPU made a one-image edit take 240 s
  versus 61 s; SageAttention makes 2K steps ~32 % faster; untiled 2K VAE decodes OOM and fall
  back to 256 px tiles (~22 s), 768 px tiles take ~4 s.
- Request objects are merged field by field over the server's launch options, so omitted
  fields keep the CLI values (per-request VAE tiling is only sent to turn it off).
- `img_gen` accepts a `hires` object (second pass: upscale with a built-in filter or an ESRGAN
  model from `--hires-upscalers-dir`, then re-sample at `denoising_strength`); reference
  latents and inpaint masks are carried into that pass. `cache_mode`/`cache_option`
  (e.g. `easycache`, `threshold=0.2`) work per request. `POST /sdcpp/v1/upscale`
  (`{image, upscaler}`) runs ESRGAN synchronously, up to 8192 px per side.
- Qwen-Image 2.1 always decodes an alpha channel (≈1 % of pixels at alpha 247–254 on opaque
  images); outputs are made opaque unless transparency is requested.

## Resolution and upscaling policy

Every job runs a single diffusion pass at the working size (Auto: ~1 MP for Fast, ~1.5K for
Balanced, native 2K for Quality; or the 1K/1.5K/2K/Source/Custom choice), capped by the VRAM token budget
that the target shares with its reference images. The earlier two-pass mode (≈1 MP render →
ESRGAN → low-denoise refine at 2K) was removed on 2026-10-06: in A/B tests the refine made
edits look worse than a single pass.

Whenever a result is larger than what the model rendered (edits restored to the source size,
outpaint, sizes above the VRAM budget) it is enlarged with ESRGAN ×4 and then resized down to
the exact size; Lanczos is only used for shrinking or factors below 1.1×.

Apple Silicon renders Fast at its full ~1 MP like a PC. Rendering 768² and enlarging it was
removed on 2026-10-10: on the M2 Pro 16 GB it took 5 min 25 s against 4 min 20 s for a direct
1376×768 render (the ESRGAN pass on Metal costs more than the smaller render saves).

### Turbo (the only image model since 2026-10-09)

Every job runs Qwen's official 8-step distilled model
([Qwen/Qwen-Image-2.1-Turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo), released
2026-10-09, Qwen Research License like the base), as the stable-diffusion.cpp conversion
[DogukanUrker/Qwen-Image-2.1-Turbo-GGUF](https://huggingface.co/DogukanUrker/Qwen-Image-2.1-Turbo-GGUF):
Q4_K (4.05 GB, `catalog::TURBO_Q4_K`) on every preset (the larger presets differ in working
size and text encoder only). t2i and edits. The base Qwen-Image 2.1 weights are no
longer downloaded; config schema 7 points the official profile at the preset's Turbo file (the
old base file stays on disk until the user deletes it).

- Schedule: `planner::TURBO_SIGMAS` = `sample_sigmas` of the checkpoint's model_index.json
  ([1, .978453, .95418, .926626, .89508, .845148, .704534, .414568, 0], fixed at every
  resolution), sent as `sample_params.custom_sigmas` (used verbatim, steps = len − 1). sd.cpp's
  default Qwen schedule shifts by resolution and has a 0.02 terminal shift. CFG is always 1.
  Steps, CFG and scheduler are not settable (Qwen evaluated no other schedule); the sampler is.
- Turbo goes no further than native 2K: Qwen trained and published 2K buckets only, and 2048²
  is the measured VRAM limit on 16 GB. Larger outputs come from the upscaler model.
- **Same-seed A/B, RTX 5070 Ti, 1024², 3 t2i + 3 edits** (`scripts/dev/compare-fast-modes.py`):
  Fast (20 steps) 19.1 s t2i / 23.8 s edit; Viggle v0.3 LoRA (6 steps) 10.1 / 13.6 s; official
  Turbo (8 steps) 9.5 / 13.1 s. ~4.5 s per image are fixed (encode, 2.7 s decode), so the
  sampling speed-up (18.4 → 7.8 s) shows less here than on a Mac. The LoRA made every step 30%
  slower (runtime LoRA on GGUF: 1.15 vs 0.85–0.88 s/step). Quality equal by eye; in the poster
  edit ("title → PORTO, tram blue") Fast and Viggle dropped the subtitle, Turbo kept it.
- Candidates rejected or not adopted: Viggle turbo v0.3 LoRA (works, slower per step, third
  party); Turbo8 and Pruna 8-step LoRAs (unofficial; Turbo8 reports text exact-match 75% vs
  95%); Sarvam Tez 2-step (t2i only, precision-sensitive); **Alibaba Fun-Acc 4-step**: a PDD
  bundle, not a plain LoRA (keys without `.weight` that sd.cpp ignores silently, replacement norm
  weights, `proj_out.weight [4,64,4096]` = one output head per step), would need an sd.cpp
  patch. LightX2V Lightning for 2.1: not released (issue #1548).
- Open: Turbo Q6_K / Q8_0 vs Q4_K (the comparison script has `official8_q6_k`,
  `official8_q8_0`); Turbo at 1.5K and 2K on real prompts.

The **Upscale** action runs the upscaler model (ESRGAN) straight on the image. The Detailed
method (a low-denoise img2img pass at about 2K first) was removed on 2026-10-09: Turbo's
schedule leaves only 1–2 steps at strength 0.3. Requests with `"method": "detailed"` run as
the upscaler model only.

## HDR

The source's ISO 21496-1 gain map is reused and faded out where the edit changed brightness by
more than ~¼ stop (gone at 1 stop). Reading the gain map needs `ffmpeg` 7.1+ on PATH; without
it, or when the result's framing differs from the source (outpaint, other aspect ratios), the
result is saved in SDR and the job's notes say why.

## Downloads

Sources, sizes and SHA-256 sums are pinned in `crates/qls-core/src/catalog.rs`. Files ≥ 16 MB
download over 8 parallel connections in 8 MB pieces (HTTP Range, positional writes into a
preallocated `.part`, finished pieces recorded in `.part.segments` so pause or a crash can
resume). When nothing is left to start, idle connections also fetch the piece with the most
left; the first to finish wins. A server without range support falls back to one connection.
A file that fails twice, or a link that moved, is reported with its download page and target
path so it can be fetched by hand.

## Settings not shown in the UI

In `%APPDATA%\Kokon\config.json`: `serverPort` (default 39150; the port the inference
server binds — change it if that port is taken), `hardwarePreset` (`12gb|16gb|24gb|32gb`, written by the
setup screen), `vramOverrideMib` (plan sizes as if the GPU had this much VRAM; 0 = detect;
for testing), `upscalersDir` (null = default folder), `upscalerModel` (`4x-UltraSharp`; configs on the old
`RealESRGAN_x4plus` default move to it), `upscaleTileSize` (0 = backend default 128),
`prefixCacheType`, `eagerLoad`, `sageAttention`.

## Testing smaller cards on a bigger one

`scripts\dev\vram-ballast.py --card-mib 12282` holds the VRAM a 12 GB card does not have (it
writes the memory every 0.5 s so Windows keeps it resident), and `vramOverrideMib` makes the
planner size images for 12 GB. `scripts\dev\test-12gb.ps1` does both and runs text to image,
edit, inpaint, outpaint, multi-reference and upscale through an isolated service, recording
time, working size, peak VRAM, memory spilled to shared GPU memory and out-of-memory retries
into `docs\test-results\`. Bandwidth and compute stay those of the bigger card, so times are
optimistic: a real 12 GB card (RTX 3060/4070) has to confirm them.
