# Platforms: engines, requirements and what is verified

Kokon runs Qwen-Image 2.1 through stable-diffusion.cpp. Since 0.10 every platform uses Kokon's own
build from one release of the fork ([kokon-992-dfaab76](https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/tag/kokon-992-dfaab76):
upstream b13a482 plus text generation for Prompt+, branch `kokon`, workflow `kokon.yml`), so model
behaviour is identical everywhere; only speed and memory differ. The image side is upstream's code.
`engine.json` (key `kokon`) can move every platform to a newer release without an app update; see
the engine section of [engineering-notes.md](engineering-notes.md). Apps up to 0.9.4 used upstream's
releases (Windows, macOS 26) and the `kokon-linux` / `kokon-macos` builds (Linux, macOS 15).

| Platform | Engine (kokon-992-dfaab76) | Status |
| --- | --- | --- |
| Windows + NVIDIA | CUDA 12.8 build with CUDA graphs (runtime DLLs from upstream's `cudart-sd-bin-win-cu12-x64.zip`) | ✅ verified (RTX 5070 Ti 16 GB, RTX 5070 12 GB) |
| Windows + AMD / Intel | Vulkan build (29 MB, uses the driver's Vulkan runtime) | 🟡 beta: works on NVIDIA (RTX 5070 Ti, 2K/20 steps, slower than CUDA); first AMD user report: RX 9060 XT 16 GB, 16:9 1080p Balanced ~80 s on the first image (incl. model load), no errors; Intel to verify |
| macOS + Apple Silicon | Metal build, macOS 15.0+, universal binary, shaders embedded (Macs on 26 use it too) | 🟡 beta: packaged 0.9.0 runs on an M2 Pro 16 GB (Turbo: ~1 MP in ~4 min 20 s, lightest mode) |
| Windows + AMD via ROCm | ROCm build (published by the workflow, not used by Kokon) | ✗ not planned: open crashes (#2008), DLL conflicts (#2012), black images with k-quants (#1385) |
| Linux x86-64 (.deb / .rpm) | CUDA 12.8 (CUDA graphs) and Vulkan builds on Ubuntu 22.04 (glibc 2.35); CUDA runtime still from `kokon-linux-1d0a58a` | 🟡 beta from 0.9.4: CUDA verified on an RTX 5070 Ti under WSL; Vulkan loads on Ubuntu 22.04/24.04, Debian 12, Fedora 40/42. Details in [linux.md](linux.md) |

## How the app sizes itself (all platforms)

One number drives everything: the memory the GPU can use for the diffusion model.

- **Discrete GPU** (NVIDIA, AMD, Intel): its VRAM. NVIDIA through `nvidia-smi`; any other card
  through DXGI (dedicated video memory). The text encoder lives in system RAM.
- **Apple Silicon**: unified memory is shared, so the planner uses
  `planner::unified_memory_planning_mib`: Metal's GPU share of RAM (≈ 2/3, ≈ 3/4 from 64 GB)
  minus the text encoder, which sits in the same pool.

From that number the existing logic picks the preset (which weights to download) and the token
budget (largest working size per quality level). Nothing is tuned per platform.

## Windows: AMD and Intel (Vulkan, beta)

- Engine: `sd-kokon-dfaab76-bin-win-vulkan-x64.zip`, installed into `<sdcpp>\engine-vulkan`,
  next to the CUDA build (switching engines needs no re-download).
- Launch: `--backend vulkan0`, flash attention, q8_0 prefix cache. No SageAttention (CUDA only).
- Requirements: a discrete GPU with **12 GB+ VRAM** (RX 6700 XT 12 GB / 7700 XT and up,
  Arc A770 16 GB / B580 12 GB), current driver, 16 GB RAM.
- Known upstream issues:
  - integrated GPUs report 0 MB and fail (#2022), so they are not supported;
  - an edit with 2 reference images can crash (#1991, fix in ggml not yet synced);
  - no published Qwen 2.1 speeds on AMD/Intel yet.

## macOS: Apple Silicon (beta)

Evidence: [qwen-image-studio](https://github.com/sanketshinde3001/qwen-image-studio) runs Qwen 2.1
t2i and edits on a 16 GB M5 with **our exact engine build**. Its numbers: 10–12 GB peak
(`--mmap --params-backend disk`), about 75 s/step at 1024² with CFG 6, so about 37 s per model
pass. Kokon uses CFG 1, which is one pass per step.

### System requirements (as in the README)

| | Minimum | Recommended |
| --- | --- | --- |
| **Chip** | Apple M1 or newer (Intel Macs: no) | M-series Pro / Max / Ultra |
| **macOS** | 15 Sequoia (Kokon's engine build; upstream's needs 26) | latest |

The Mac paragraphs below that say "our exact engine build" or "the same engine build" mean the
upstream release Kokon used up to 0.9.4 (master-929); the measurements were taken on it.
| **Unified memory** | 16 GB: works, but slowly (lightest mode, ~1 MP, ~4–5 min on an M2 Pro) | 32 GB+ (everything stays loaded, Quality 2K) |
| **Disk** | 15 GB free | 25 GB on the internal SSD |

16 GB Macs run in the lightest setup: 1 MP, with each model's weights loaded when it runs and
released afterwards. That costs only a few seconds per image; the GPU compute is what makes it
slow (on the M2 Pro 16 GB with the packaged 0.9.0: 512² ~2 min, 1024² ~10 min). The setup
screen says so before downloading, and recommends 32 GB and a Pro/Max/Ultra chip.

**Fast on a Mac renders 1 MP directly** (2026-10-10). From 2026-10-09 Fast rendered 768² and
the upscaler enlarged it, but on the M2 Pro 16 GB with Turbo that took 5 min 25 s, against
4 min 20 s for rendering 1376×768 directly: the ESRGAN pass on Metal costs more than the
smaller render saves. So Macs now render like PCs.

### Why macOS paging does not help here (verified in the source, 2026-10-09)

macOS compresses and swaps idle memory, and with `--mmap` model files are file-backed pages
it can drop and re-read. That is why ~10 GB LLMs run well on 16 GB Macs. GPU memory is
different:

- ggml's Metal backend puts every buffer, mapped files included, in a residency set and keeps
  it **wired** for 3 minutes after the last GPU use (ggml `ggml-metal-device.m`, heartbeat
  thread). macOS cannot evict, compress or swap wired pages.
- Metal's working-set limit (`recommendedMaxWorkingSetSize`, about 11–12 GiB on 16 GB,
  about 17–18 GiB on 24 GB) is the real ceiling. 10.7 GB of weights, plus several GB of
  activations at 1 MP, plus about 1 GB of prefix cache does not fit under it on 16 GB.
- `--params-backend disk` releases each model's weights after it runs, so the text encoder
  (6.2 GB) is gone during sampling. It disables the zero-copy mapping
  (`ModelManager::can_mmap_storage` needs `ResidencyMode::ParamBackend`), but the reload
  reads from the file cache or the SSD in seconds.
- qwen-image-studio (same engine build, M5 16 GB) saw 4.3 GB of swap and slower steps with
  everything resident; disk mode peaked at 10–12 GB.
- Raising the limit with `sudo sysctl iogpu.wired_limit_mb` is undocumented, resets on
  reboot, and has caused kernel panics on a 24 GB M4 Pro. Not recommended.

Launch flags chosen:

- **16 GB:** `--backend metal --params-backend disk --mmap --fa`, no `--eager-load`.
- **24 GB and up:** `--backend metal --auto-fit off --mmap --fa`. All weights stay on the GPU
  as zero-copy mappings; `--auto-fit off` stops auto-fit from staging the text encoder in
  "RAM", which on a Mac is a second copy in the same memory.

The Neural Engine and the ray-tracing cores are not used by any of these runtimes. The
per-GPU-core "neural accelerators" exist only from M5 (Metal 4 tensor API, which ggml
enables only on M5). What matters is GPU cores and memory bandwidth.

### Memory math

Weights: diffusion Q4_K_M 4.2 GB + text encoder Q4_K_M 5.0 GB + vision projector 1.2 GB +
VAE 0.25 GB ≈ 10.7 GB.

| Unified memory | GPU share | − text encoder | Plans like a | Preset |
| --- | --- | --- | --- | --- |
| 16 GB | ~10.7 GB | ~4.5 GB | 4–6 GB card | lightest, 1 MP |
| 24 GB | ~16 GB | ~9.8 GB | 10 GB card | 12 GB preset |
| 32 GB | ~21 GB | ~15 GB | 16 GB card | 16 GB preset (2K) |
| 48 GB | ~32 GB | ~26 GB | 24 GB+ card | 24 GB preset |
| 64 GB+ | ~48 GB | ~42 GB | 32 GB+ card | 32 GB+ preset |

### Expected speed

These are **estimates, not measured**, for 1 MP, 20 steps, CFG 1 (the base model; Turbo runs 8 steps, so roughly 40 % of the sampling time). They are derived from the
M5 16 GB measurement (about 38 s per model pass at 1024², with the same engine build) and
llama.cpp compute ratios. Our test machines: M2 Pro 16 GB (19-core GPU, 200 GB/s) about
15–25 s per step, 6–9 min per image; M4 Pro 24 GB (20-core, 273 GB/s) about 12–18 s per
step, 4.5–6.5 min. The 16-core M4 Pro is close to the M2 Pro. Benchmark both before setting
the Mac presets' time hints.

| Chip class | GPU cores | Bandwidth | Per image (rough) |
| --- | --- | --- | --- |
| M1–M5 (base) | 7–10 | 68–153 GB/s | 10–15 min |
| Pro | 14–20 | 150–273 GB/s | 4.5–9 min |
| Max | 30–40 | 300–546 GB/s | 2–3 min |
| Ultra | 48–80 | ~800 GB/s | 1–2 min |

The setup screen should show the chip, its memory and this expected time before downloading,
so nobody with a base chip is surprised.

### Work needed (✅ = done 2026-10-09, runs from source with `scripts/dev/mac-dev.sh`)

1. ✅ Detection: `sysctl hw.memsize`, `machdep.cpu.brand_string`, GPU cores from
   `system_profiler SPDisplaysDataType -json`; feed `unified_memory_planning_mib` into the
   planner and presets.
2. ✅ Engine: the macOS zip (`sd-server`, `libstable-diffusion.dylib`) in `<sdcpp>/engine-metal`;
   launch with `--backend metal` (sd-server maps "metal" to ggml's MTL device), `--fa`, `--mmap`,
   no SageAttention; RAM placement becomes "everything on the GPU" (same memory), and Macs
   that plan below 8 GiB (16 GB) get `--params-backend disk`.
3. ✅ Portability fixes (all Rust type-checks for aarch64-apple-darwin):
   - catalog paths use `\` (switch to `/`);
   - HEIC decoding uses Windows WIC (macOS: `sips`);
   - Tauri sidecar names and the `.exe` suffix;
   - data folders (`dirs` already maps them to `~/Library/...`).
4. ✅ Packaging: `scripts/build-release-mac.sh` builds `Kokon.app` + `.dmg` (ad-hoc signed,
   app icon on Apple's grid, in-app updates signed with the updater key). First packaged build
   on a Mac pending. Notes on the options considered: a GitHub Actions `macos-14` (arm64) runner builds the `.dmg`. Without an Apple
   Developer ID ($99/year) the app is unsigned. Since macOS 15, right-click → Open no longer
   bypasses Gatekeeper: users must try to open it, then go to System Settings → Privacy &
   Security → *Open Anyway*. Signing + notarization removes that step. The signature shows
   the developer account's **team name** (individual: the holder's name; organization: its
   legal name), so the account should be one whose name Kokon is meant to carry. The engine
   itself, downloaded by the app over HTTP, carries no quarantine flag and runs, because it
   is ad-hoc signed.
   **Decision 2026-10-09:** the shared Developer Program membership has expired, so the Mac beta
   ships ad-hoc signed (`signingIdentity: "-"`, free): a DMG with "Open Anyway" instructions
   (with a screenshot), plus a one-line `curl … | bash` installer (curl downloads carry no
   quarantine flag, so no warning). Homebrew's official tap requires apps that pass
   Gatekeeper, so it is not an option. Revisit a personal $99 Developer ID if the Mac
   audience is large.
5. Known Metal issue: transparent (RGBA) output decodes as white (#2024, fix not merged).
   Kokon outputs RGB, so only transparency-preserving edits are affected.
6. Testing: runs on the M2 Pro 16 GB (device name `mtl0` fixed from that run); an M4 Pro 24 GB
   run is planned. Originally: needs a real Apple Silicon Mac with 24 GB+ (GitHub's runners have 7 GB: build
   only). Without one, ship as "beta, untested".

### Speed roadmap for Macs

1. ✅ **Turbo**: Qwen's official 8-step model, the only image model since 2026-10-09; the
   largest gain on every platform. See the Turbo notes in `docs/engineering-notes.md`. M2 Pro 16 GB:
   about 4 min 20 s for a 1376×768 image.
2. ✅ Honest requirements: 16 GB works but slowly; 32 GB+ and a Pro/Max/Ultra chip recommended.
3. ❌ Rendering Fast at 768² and enlarging: slower than 1 MP directly, removed (above).
4. **Later: an MLX engine.** Apple's MLX framework (through [mflux](https://github.com/filipstrand/mflux))
   may be faster than ggml's Metal backend; a community 4-bit MLX build of Qwen-Image 2.1
   exists (about 6.7 s/step at 768² on an M1 Max, ~7 GB peak; ~78 s per 1024² image on an
   M5 Max 64 GB, per third-party reports, unverified). Not done now because: the gain over
   sd.cpp Metal is unmeasured (maybe 1.3–2×), it needs a bundled Python runtime and a second
   backend path (request mapping, edits, inpaint semantics, upscaler) to maintain, and it does
   not fix 16 GB Macs, where memory, not the engine, is the limit. Revisit after Turbo ships,
   with a same-machine benchmark of both engines first.
