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
| `pipeline.rs` | Builds backend requests, post-processes results (crop back, upscaler tiling, composite) |
| `sdcpp.rs` | Inference adapter — the only code that knows sd-server's schema |
| `process.rs` | sd-server launch/reuse/stop, log capture, truthful progress parsing |
| `engine.rs` | Async job queue, cancellation, OOM retry, saving |
| `speed.rs` | Per-machine speed calibration of time estimates |
| `diagnostics.rs` | GPU detection (nvidia-smi, DXGI, sysctl on macOS), readiness checks |
| `store.rs` | SQLite gallery + content-addressed inputs |
| `projects.rs` | The project list every device shares (`projects.json`): merged saves, tombstones, finished jobs |
| `paths.rs` | Path validation (no UNC/device/ADS/traversal, never overwrite) |
| `catalog.rs`, `installer.rs` | Pinned downloads (URLs, sizes, SHA-256), hardware presets, parallel resumable downloader |
| `config.rs` | Settings and model profiles: the official files (derived from folder + preset) and the user's own files, each recording its model and source |
| `modelfile.rs` | What a `.gguf` / `.safetensors` file is, read from its header only (role, Qwen-Image 2.1 or not, quantization, vision weights); folder scan for the user's own files |
| `crates/qls-service` | Headless service and stable HTTP API; single instance; lifecycle. `remote.rs`: the embedded browser UI, password sign-in and the network listener (rules in `qls_core::remote`) |
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
| macOS, Apple Silicon | Metal build (macOS 15+) | `<sdcpp>/engine-metal` | `--backend mtl0 --mmap`; 24 GB+: `--auto-fit off` (all weights on the GPU, zero-copy); 16 GB: `--params-backend disk` |

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
  (`{image, upscaler, tile_size}`) runs the upscaler model synchronously, up to 8192 px per side.
- Editing an image with the seed it was generated with, at the same working size, starts from
  the noise that made it: the result is over-sharpened and often ignores the prompt (RTX 5070 Ti,
  engine kokon-992, Q4_K: 2368×1760 and 2048² sources; other seeds were clean, Fast's ~1 MP size
  was not affected). The engine swaps a requested seed that made any reference (gallery record,
  PNG metadata) for a fixed mix of it and adds a note (`avoid_reference_seeds`).
- Qwen-Image 2.1 always decodes an alpha channel (≈1 % of pixels at alpha 247–254 on opaque
  images); outputs are made opaque unless transparency is requested.

## Resolution and upscaling policy

Every job runs a single diffusion pass at the working size (Auto: ~1 MP for Fast, ~1.5K for
Balanced, native 2K for Quality; or the 1K/1.5K/2K/Source/Custom choice), capped by the VRAM token budget
that the target shares with its reference images. The earlier two-pass mode (≈1 MP render →
ESRGAN → low-denoise refine at 2K) was removed on 2026-10-06: in A/B tests the refine made
edits look worse than a single pass.

Whenever a result is larger than what the model rendered (edits restored to the source size,
outpaint, sizes above the VRAM budget) it is enlarged with the upscaler model (×4) and then
resized down to the exact size; Lanczos is only used for shrinking or factors below 1.1×.

### Upscalers (2026-10-12)

Default: Superscale-SP (ESRGAN, WTFPL, setup download), 128 px tiles with direct convolutions
(13.2 s / +455 MB for 1472² on an RTX 5070 Ti, vs 24.7 s / +747 MB without). Also offered:
MoSR (experimental, bundled), UltraSharp (optional download, non-commercial), Lanczos.
Macs default to Lanczos and skip the Superscale download: on an M2 Pro (Metal) Superscale-SP
took 5 min 45 s for 1024² → 2048² (~345 s/MP) against ~1 s for Lanczos; MoSR ~25 s/MP.
`upscaleBlend` mixes the result with Lanczos; `upscalePrescale` shrinks the input so x4 lands
~1.41x the target. Why MoSR is not the default: on clean full-size renders enlarged < ~2.8x it
invents a fine crosshatch that the final downscale turns into a visible grid (the port matches
PyTorch; the model does it). Superscale shows the same on JPEG blocks and dark areas; UltraSharp
over-smooths skin and invents lines. A/B crops: `bench/out/upscale_ab-20261012-141057` (sdcpp
workspace); the in-app comparison uses crops from it (`src/assets/upscalers`).

#### MoSR in sd.cpp

MoSR by Philip Hofmann (CC BY 4.0), 17 MB. Ported by Kokon (`src/model/upscaler/mosr.hpp`),
merged upstream as PR #2128 on 2026-10-12; since 0.9.2 the engine is the official release
`master-964-1d0a58a` (0.9.1 used the fork release `kokon-mosr-1`). Port vs PyTorch: mean error
0.04–0.16/255.

#### Engine updates (`engine.json`)

`engine.json` at the repository root names the newest engine release tested with Kokon. Since
0.10 every engine is Kokon's own build (fork branch `kokon`, workflow `kokon.yml`, release
`kokon-<n>-<commit>`; see "Prompt+" below), listed under the `kokon` key: tag, `min_app`,
URL + size + SHA-256 of `win_cuda`, `win_vulkan`, `linux_cuda`, `linux_vulkan`, `macos`. The
file's other keys are an upstream release for apps up to 0.9.4, which ignore `kokon`. The service
reads its cached copy at start and fetches it again when older than 2.5 days
(`engine_manifest.rs`). A valid release newer than the built-in pin (`catalog::ENGINE_TAG`)
replaces the engine downloads, so the status reports `engine.update_needed` and What's new offers
the download. Only `sd-kokon-<commit>-bin-*.zip` files of that tag in the fork are accepted, and a
manifest with any bad entry is ignored as a whole. To ship an engine: push to the fork's `kokon`
branch (a run where every job passes publishes the prerelease), test on Windows (CUDA + Vulkan),
Linux and a Mac, then edit `engine.json` on master (digests: `gh release view <tag> -R GabrieleLozupone/stable-diffusion.cpp --json assets`).
Since master-964 `--fa` and `--diffusion-conv-direct` are deprecated aliases (still accepted, so
older engines keep working); convolutions default to `auto`, which turns implicit-GEMM direct
convolutions on for CUDA (RTX 20xx+) and Vulkan, VAE included.

- Launch: `--diffusion-conv-direct` on CUDA and Vulkan only (in sd.cpp it affects UNet/ControlNet
  and this upscaler, never Qwen). On Metal it is ~4× slower. `--vae-conv-direct` makes Qwen's
  decode ~1 s slower: not used.
- Tile size per request (`planner::upscale_tile`): 768 px with ≥ 14 GiB of planning memory, 256 px
  below (12 GB cards, 16–24 GB Macs); `upscaleTileSize` overrides it.
- 1472² edit, ×4 (2026-10-12): RTX 5070 Ti CUDA 3.1 s / +1.55 GB at 768 px (3.8 s / +2.4 GB
  without direct), ~5 s / +0.5 GB at 256 px; UltraSharp at 128 px took 24.5 s. Vulkan 3.3–3.55 s
  / +1.25 GB (+4.2 GB without direct). M2 Pro Metal 54.6 s at 768 px, 78 s at 128 px.
- The model ships inside the app (Tauri resource `bundled/`, fetched at build time by
  `scripts/release/fetch-bundled.mjs`) and is copied into `<sdcpp>/models/upscalers/` at start;
  Setup downloads it (mirror on this repo's `models-1` release, then the author's) only if that
  fails.
- Engine folders carry `kokon-engine.txt` with the release tag; without it (or with another
  tag) Setup offers the engine download, and the app opens Setup once per release.

Apple Silicon renders Fast at its full ~1 MP like a PC. Rendering 768² and enlarging it was
removed on 2026-10-10: on the M2 Pro 16 GB it took 5 min 25 s against 4 min 20 s for a direct
1376×768 render (the upscaler pass on Metal costs more than the smaller render saves).

### Model profiles and the user's own files (#14, config schema 9)

- A profile is a set of model files plus `model` (which model they are: `qwen-image-2.1`, the key
  future model definitions will use) and `source`. The **official** profile always points at the
  catalog files in `<install folder>/models/qwen21` for the chosen preset (`AppConfig::normalize`);
  presets change only runtime settings and never the files of the **user** profile
  (`qwen-image-2.1-user`). Model paths edited by hand on the official profile (≤ 0.9.2) move to the
  user profile when their files exist.
- Setup's "Use models I already have" scans a folder (e.g. `ComfyUI/models`) and classifies files the
  way stable-diffusion.cpp does: `txt_in.text_norm.weight` = Qwen-Image 2.1 (older Qwen-Image models
  are refused), VAE latent 64 channels, Qwen3-VL text encoder (QK-norm, hidden size 4096; vision
  tensors inside it make the mmproj unnecessary), mmproj projecting to 4096. Any quantization sd.cpp
  loads is accepted; pickle formats (`.ckpt`, `.pt`, `.bin`) and split files are not. Missing pieces
  can be the official files, downloaded into any folder; existing files are never overwritten.
- Larger own files lower the planning VRAM by their size above the official Q4_K
  (`AppConfig::model_vram_extra_mib`), since the budgets were measured with it.
- Missing files (drive not connected, moved, deleted) are checked when a job is submitted and when it
  starts (sd-server reopens the files for every image), and sd-server's "cannot inspect model source"
  maps to `missing_model`: the UI opens Setup, which looks for them again (also in the folder they were
  found in) or offers to choose, download or switch files. Nothing is switched or downloaded on its own.
- Manual test in an isolated environment: `scripts/dev/test-own-models.ps1`.

### Turbo (the only image model since 2026-10-09)

Every job runs Qwen's official 8-step distilled model
([Qwen/Qwen-Image-2.1-Turbo](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo), released
2026-10-09, Qwen Research License like the base), as
[unsloth/Qwen-Image-2.1-Turbo-GGUF](https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF)
Q4_K_M (4.2 GB, `catalog::TURBO_Q4_K_M`) on every preset since 0.11.1 (the larger presets differ in
working size and text encoder only). Up to 0.11.0 it was DogukanUrker's stable-diffusion.cpp
conversion, Q4_K (4.05 GB, `catalog::TURBO_Q4_K`): a tie on a same-seed vote (2026-10-25, RTX 5070
Ti), the Q4_K_M ~6 % slower per job there. Earlier installs keep the Q4_K until the user accepts
(`catalog::official_dit`, What's new / Settings → Models, `POST /models/dit`); the Q4_K is then
deleted from the app's folder once no profile uses it (`catalog::unused_old_dit`). Own files that
are that Q4_K (size + fingerprint, any folder) only get a suggestion (`catalog::dit_update`). t2i and edits. The base Qwen-Image 2.1 weights are no
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

The **Upscale** action runs the upscaler model straight on the image. The Detailed
method (a low-denoise img2img pass at about 2K first) was removed on 2026-10-09: Turbo's
schedule leaves only 1–2 steps at strength 0.3. Requests with `"method": "detailed"` run as
the upscaler model only.

### Prompt+ (the prompt enhancer, 0.10.0)

Optional, off by default. The Qwen3-VL 8B that Qwen-Image 2.1 already loads as its text encoder
rewrites the user's short instruction into a full English prompt (looking at the input image for
edits) before the image is made, so there is no second model in memory.

- **Inside the engine, not a second llama.cpp process.** Kokon's engine build adds a generation loop
  (KV cache, sampling, streaming detokenizer) on the loaded encoder and `POST /sdcpp/v1/text_gen`
  (SSE `delta` / `done` / `error`; `stream: false` returns one JSON). `/sdcpp/v1/capabilities` reports
  `text_generation`; the app hides the Prompt+ pill on engines without it. A second llama.cpp would
  double the 8B in RAM (+6.6 GB on Windows without mmap). Upstream prefers to leave text generation to
  llama.cpp ([leejet/stable-diffusion.cpp#2155](https://github.com/leejet/stable-diffusion.cpp/issues/2155)),
  so it lives in the fork.
- **Checked against llama.cpp** on the same GGUF: tokenizer round-trips, first-step logits (text
  KL ≤ 0.02 on CUDA, ≤ 0.03 on CPU, images ≤ 0.15) and greedy tokens identical up to the first near-tie.
- **Memory:** the encoder weights live in RAM (`--params-backend te=cpu`). For generation the engine
  moves the DiT/VAE to pinned RAM when the encoder doesn't fit next to them (restore ~0.5 s on the next
  image job), releases the vision tower before decoding, and reuses the decode graph with CUDA graphs
  (ggml patch: only graphs with an id are captured). Below the budget, layers run split CPU/GPU.
  Measured: ~127 tok/s on 16, 12 and 8 GB (RTX 5070 Ti, real and emulated; llama.cpp 133–145).
- **Cost per image** (Fast 1024², same seed on/off): Windows +2.0 s t2i / +1.1 s edit, +2.4 GB peak
  VRAM; Linux (WSL) +1.6 / +0.1 s; 8 GB emulated +3.6 / +1.8 s; M2 Pro 16 GB ~+13 s on ~290 s.
- **System prompts live only in Kokon** (`crates/qls-core/src/enhancer.rs`; Settings can replace
  them). They are our own texts, chosen in blind A/Bs over 20 and then 39 cases × 2 seeds against
  Qwen's official PE prompts (those are under the Qwen Research License, ~2,400 / ~4,900 tokens, and
  on the 8B the edit one wrote edits in Chinese). Rules kept: copy the user's fixed content exactly
  (quoted text, counts, colours), name the medium early, always state the light, no quality tags; for
  edits lead with the operation, describe only what changes and end with one "keep everything else
  unchanged" clause (describing what stays makes the model redraw it). Output is always English.
  Lesson: **any example colour or object in a system prompt leaks** into the outputs.
- **Sampling:** Qwen3-VL's values (temperature 0.7, top-p 0.8, top-k 20, presence penalty 1.5 counted
  on generated tokens only), seeded with a portable RNG, so the same seed gives the same text on every
  platform. Regenerate makes a new prompt and a new seed; greedy is the engine default and test mode.
- **Length:** the prompts ask for a length that fits the request (t2i ~80-150 words, up to ~250 for
  crowded scenes; edits 20-60, up to ~150 for several changes; compose 100-200, up to ~300). The token
  cap is 1024 (was 512, which cut crowded scenes mid-sentence; ~8 s at ~127 tok/s). sd.cpp's Qwen-Image
  conditioning does not truncate the prompt.
- **Three system prompts:** text-to-image, edit (edits and combines, where image 1 is changed) and
  compose (a new image that uses the images as references, `mode: compose`). Compose runs in two
  steps: each reference is labelled alone (a short list of its own features, never its place, pose or
  what it holds), then the scene is written from the request and the labels, without the images. Shown
  the images, the 8B described the references instead of the requested scene with every system prompt
  tried; from labels it follows the request. The image model still gets the references, so identities
  come from them. No "keep … unchanged" sentence (it turns a composition into an edit of image 1).
  Cost: ~0.3 s per reference plus the scene. Still to be A/B-tested on composition cases.
- **Review first:** `enhance_only` runs a job that stops after the prompt (no image, nothing saved); the
  app streams it into the prompt box. The next job sends the text with `enhanced_from` (the user's
  words), so the record keeps both and nothing is rewritten twice.
- **A painted area and Expand (0.12, not A/B-tested yet):** two more built-in prompts (no Settings
  field). For a brushed area the enhancer sees the region as it is with the area highlighted (the
  image model's own copy is blurred there for Remove and Replace) and writes what goes in the area,
  or names what is removed, after the action's words ("Remove", "Change", "Replace with", "Add": the app
  puts them in the prompt, the service takes them off inside its instruction); for Expand it sees the canvas with the new borders empty and writes
  what they show. For an area it writes the whole instruction of the action (Remove: what goes and what
  is seen in its place; a bare name in the removal sentence made Qwen paint the object again), sent in
  `pipeline::written_inpaint_prompt`; Expand's text goes after the outpaint instruction (`pipeline::EnhancerView`). With nothing typed for a removal or an expansion, the app has Prompt+
  write the prompt into the box first (`enhanced_from: ""`), to approve or change.

### New image from references (compose)

`mode: compose` is a new image whose size follows text-to-image (chosen size, ratio, a ratio in the
prompt, else square, at the quality preset), never image 1's: an edit's output takes image 1's shape
and, in Auto, at most its area, so a small reference gave a small result. The references share the
token budget with the output as in edits (`cap_for_sources`), each at most the reference cap
(Standard 1 MP) and never larger than the output. In the app, **New image** with images added sends
compose; **Edit image** keeps today's edit/combine.

## The browser UI on phones (0.11)

Measured on an iPhone 15 (iOS 27, Safari and the home-screen app) and in Playwright at 390x844, dpr 3:

- **Previews.** In a browser the stage, full screen, comparisons and the paint editor show
  `/gallery|inputs/{id}/preview` (at most 1280 px, JPEG) while it is as sharp as the full image there
  (`logic.ts` `stageFitsPreview`, `viewerWantsFull`); the full file loads once the zoom needs more pixels.
  A 30-version project of 2048 px PNGs opened with 0.84 MB instead of 15.1 MB.
- **No image-sized layers.** WebKit backs a composited layer at its untransformed size x the device scale
  (`GraphicsLayerCA::updateRootRelativeScale` is disabled), so a 4096 px image laid out at its own size and
  shrunk by a 3D transform cost ~150 MB per layer at dpr 3, and an edit's full screen (four such layers
  while the image developed in) crashed Safari (WebContent at 744-799 MB in the iPhone's JetsamEvent log).
  In a browser `ZoomPan` lays the content out at its drawn size with a 2D translate (`flat`); the desktop
  app keeps the scaled layer.
- **Status bar.** iOS 26+ ignores `theme-color`: the bar takes the colour of an opaque fixed element at the
  top of the page, read at load; a home-screen app keeps the manifest's `theme_color` for good (so the
  manifest has none). `StatusTint.tsx` is a 6 px strip at the top of the body (a 1 px one was not taken),
  created anew at every colour change, which makes iOS read it again; black while full screen is open.
- **Take Photo.** The file input stays in the page until it answers: iOS drops a detached one while the
  Camera is open. Safari names camera shots `image.jpg`, which is how `PhotoReview.tsx` tells them apart.

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

In `%APPDATA%\Kokon\config.json`: `hardwarePreset` (`12gb|16gb|24gb|32gb`, written by the
setup screen), `vramOverrideMib` (plan sizes as if the GPU had this much VRAM; 0 = detect;
for testing), `upscaleTileSize` (0 = automatic, see the upscaler section; schema 8 reset it),
`ui.engineUpdateSkipped` (engine release whose update was skipped in Setup),
`prefixCacheType`, `eagerLoad`, `sageAttention`, `serverPort` (39150 = default).

## Testing smaller cards on a bigger one

`scripts\dev\vram-ballast.py --card-mib 12282` holds the VRAM a 12 GB card does not have (it
writes the memory every 0.5 s so Windows keeps it resident), and `vramOverrideMib` makes the
planner size images for 12 GB. `scripts\dev\test-12gb.ps1` does both and runs text to image,
edit, inpaint, outpaint, multi-reference and upscale through an isolated service, recording
time, working size, peak VRAM, memory spilled to shared GPU memory and out-of-memory retries
into `docs\test-results\`. Bandwidth and compute stay those of the bigger card, so times are
optimistic: a real 12 GB card (RTX 3060/4070) has to confirm them.

Real RTX 5070 12 GB (a friend's diagnostics, 2026-10-11; 12gb preset, Turbo Q4_K, text encoder on
the CPU, text to image only): 1376×768 at 1.24 s/step (10 s sampling, 1.9 s decode); ~3.2 MP
(2400×1344, 1216×2624) at 4.3 s/step (35 s sampling, 7.2 s tiled decode). No OOM retries and no
prefix-cache fallback; ~5.8 GB VRAM free with the model loaded. About 1.5× the 5070 Ti's step time,
so `planner::step_seconds` (calibrated on the Ti) underestimates on this card.

RTX 5070 Ti 16 GB (app diagnostics, 2026-10-11; 16gb preset, Turbo Q4_K, text encoder on the CPU):
text to image 2048² at 3.67 s/step (29.8 s sampling, 5.9 s tiled decode), 36 s total; edit at
1472² with one reference at 2.0 s/step (1.0 s encode, 1.7 s conditioning, 18.3 s sampling, 2.6 s
decode), 24 s total; ESRGAN 4× of 1448² to 5792² in 22 s.
