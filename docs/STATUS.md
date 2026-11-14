# Status

**Updated 2026-11-11.** What is in progress, what comes next, and where help is welcome. Kept current at the end
of every task (see [AGENTS.md](../AGENTS.md#keeping-docsstatusmd-current)); GitHub is the source of truth.

## Current version: [0.12.1](https://github.com/GabrieleLozupone/kokon/releases/tag/v0.12.1) (2026-11-11)

More like this (Subtle / Strong, [#55](https://github.com/GabrieleLozupone/kokon/issues/55)), Redraw at this size in the
Layers lab, the GPU freed after 10 idle minutes even with a window open
([#52](https://github.com/GabrieleLozupone/kokon/discussions/52)), an optional folder for each project, local time in
image metadata, a clear message when the service cannot start ([#53](https://github.com/GabrieleLozupone/kokon/issues/53)).

Windows, macOS (Apple Silicon, 15+) and Linux (`.deb`, `.rpm`). Installed copies update from the app.

## Next

- **Edits on edits** ([#44](https://github.com/GabrieleLozupone/kokon/issues/44)): a chain of 4 edits was measured
  on 2K images; most detail goes at the first edit, and starting from the pre-upscale image does not help. No change
  yet; next to try: keeping the parts of the image an edit did not touch.
- **Layers lab** (experimental since 0.12): reports on which images split well or badly are welcome; Blend into scene
  often does not work yet.
- Next: the desktop app as a client of a Kokon server elsewhere, and a Docker image for AMD and Intel
  (Vulkan) once it can be tested.
- On the list, no dates yet: a custom upscaler picker
  ([#34](https://github.com/GabrieleLozupone/kokon/issues/34)), translations (only with contributor help).
- Not planned: a portable build ([#26](https://github.com/GabrieleLozupone/kokon/issues/26)). Kokon removes cleanly
  instead: [kokon.app/uninstall](https://kokon.app/uninstall/).

## Known issues

- **AMD RX 6000 (RDNA2) cards: turn flash attention off** (Settings → Performance). On GPUs without matrix cores
  the flash-attention path is about 10x slower, and Kokon turns it on by default: an RX 6700 XT goes from 21 to
  4.5 s per step at 1024x704. A later update lets the engine choose per card.
- **LoRA is beta** and tested on Windows only; reports from macOS and Linux are welcome
  ([#33](https://github.com/GabrieleLozupone/kokon/issues/33) has a product-shot test).
- **Kokon's Mac engine** (`engine-mac/`, the default on Macs with 16 GB or more since 0.12, switched on once at the
  first start; a choice made earlier is kept): about 65 s for a new 1 MP image and ~106 s for a 1 MP edit on an M2 Pro
  16 GB, four times faster than the standard Metal engine. LoRAs and the upscaler model still need the standard engine
  (Settings → Performance). On M5 Macs it runs on the GPU's neural accelerators (#49, #50). A "Benchmark this Mac"
  button in Settings → Performance gives a report for [Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43).
- The Windows installer is not code-signed: SmartScreen or Smart App Control may block it (README FAQ: Unblock).
- HEIC photos can't be opened on Linux yet.

## Help wanted

- Good first issues: [#2](https://github.com/GabrieleLozupone/kokon/issues/2) gallery keyboard,
  [#3](https://github.com/GabrieleLozupone/kokon/issues/3) site slider keyboard,
  [#4](https://github.com/GabrieleLozupone/kokon/issues/4) reduced-motion video.
- AMD RDNA3/RDNA4 owners who know HIP: compare a ROCm engine with Vulkan
  ([#38](https://github.com/GabrieleLozupone/kokon/issues/38)).
- Hardware reports: AMD and Intel on Windows and Linux, Linux on NVIDIA outside WSL, Macs other than an M2 Pro.
  For the Mac engine: Settings → Performance → Benchmark this Mac in a build of the `macos-optimization` branch, or
  `bash engine-mac/tools/bench.sh` there, gives a report to paste in
  [Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43) (M1, M3, M4 and M5 Macs are the most
  useful; see [engine-mac/README.md](../engine-mac/README.md#testing-on-your-mac-bench)).
- Mac engine optimizations for your own Mac (the chip you develop on, nothing changed on the others): rules,
  measuring and the pull request report in [engine-mac/AGENTS.md](../engine-mac/AGENTS.md).
- Model proposals that meet the switch rule: [Discussion #35](https://github.com/GabrieleLozupone/kokon/discussions/35).

## Recently shipped

- **0.12.0** (2026-11-04): the Layers lab (experimental: click the objects, each on its own layer with the
  background filled behind them, move/hide/edit/expand any layer, Blend into scene, Export PSD), paint with colours
  and one-click Select (its model downloaded on first use), Prompt+ for brushed areas and Expand with a Detail level,
  Kokon's Mac engine on by default on Macs with 16 GB+ and faster on the M5 (@CesareDavidePace,
  [#49](https://github.com/GabrieleLozupone/kokon/pull/49), [#50](https://github.com/GabrieleLozupone/kokon/pull/50)),
  AI marking (IPTC metadata + invisible watermark, Check an image; [ai-marking.md](ai-marking.md)), a project list
  by day and multi-version Delete, video guides in a Help menu.
- **0.11.2** (2026-10-28): Mac engine 0.1.1 (on macOS 26 the matrix unit and the Neural Engine work beside the GPU,
  found by @CesareDavidePace in [#46](https://github.com/GabrieleLozupone/kokon/pull/46); on M3, M4 and M5 Macs 8–18 %
  faster steps), the progress card keeps its place when you come back to it, Settings ask before closing with unsaved
  changes, setup buttons always in view and readable file names while downloading, visible selection on Linux with
  WebKitGTK ([#41](https://github.com/GabrieleLozupone/kokon/issues/41)), Android full screen.
- **0.11.1** (2026-10-26): Kokon's own Mac engine inside Kokon.app, offered once at start on Macs with 16 GB or
  more (experimental, off until tried, rollback in Settings → Performance), with a Benchmark button
  ([Discussion #43](https://github.com/GabrieleLozupone/kokon/discussions/43)); Unsloth's Qwen-Image 2.1 Turbo
  Q4_K_M as the image model of new installs, offered as an update to earlier installs (never switched for own model
  files); visible text selection in the dark theme on Linux ([#41](https://github.com/GabrieleLozupone/kokon/issues/41));
  a ratio lock and 1080p / 1440p / 4K sizes in Expand ([#42](https://github.com/GabrieleLozupone/kokon/issues/42)) and
  in the size menu; a selectable info panel with copy buttons; Reuse keeps a fixed seed.

- **0.11.0** (2026-10-24): Kokon from other devices in a browser, behind a password
  ([#15](https://github.com/GabrieleLozupone/kokon/issues/15), [remote-access.md](remote-access.md)), a phone
  layout of its own, projects shared by every device, headless Linux and a Docker image for NVIDIA
  ([docker.md](docker.md)), faster project opening and lower memory use on phones, a warning for base Qwen-Image
  2.1 files ([#38](https://github.com/GabrieleLozupone/kokon/issues/38)), MCP allowed folders
  ([#39](https://github.com/GabrieleLozupone/kokon/issues/39)).
- **0.10.2** (2026-10-23): new image from reference images (also in MCP and the HTTP API), a Prompt+ menu to
  read and change the prompt first, longer Prompt+ prompts, edits never reuse their source's seed, Vulkan decodes
  in 512 px tiles (AMD: seconds instead of 25-70 s), engine
  [kokon-1013-1814814](https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/tag/kokon-1013-1814814),
  `kokon-mcp --help` ([#36](https://github.com/GabrieleLozupone/kokon/pull/36)) and the full HTTP API reference
  ([#37](https://github.com/GabrieleLozupone/kokon/pull/37)) by shrinivas-sn.
- **0.10.1** (2026-10-22): own model files never take a text-only Qwen3 as the text encoder; Linux NVIDIA blank
  window fixed; the progress card fits small windows ([#32](https://github.com/GabrieleLozupone/kokon/issues/32));
  open the images folder from Settings and the gallery ([#34](https://github.com/GabrieleLozupone/kokon/issues/34));
  `kokon-service --version` ([#31](https://github.com/GabrieleLozupone/kokon/pull/31)); CI on pull requests
  ([#25](https://github.com/GabrieleLozupone/kokon/pull/25)).
- **0.10.0** (2026-10-20): Prompt+ (the text encoder writes the prompt, no second model), your own LoRA files
  (beta), Kokon's own engine on every platform, a new look.
- **0.9.4** (2026-10-16): Linux, macOS 15, colour LUTs. **0.9.3** (2026-10-15): your own model files, GPU picker,
  texture-fix VAE, 8 GB beta.

Full notes: [releases](https://github.com/GabrieleLozupone/kokon/releases) and [marketing/](../marketing/).
