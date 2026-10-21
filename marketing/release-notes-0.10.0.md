## Kokon 0.10.0

**Prompt+** ([Discussion #20](https://github.com/GabrieleLozupone/kokon/discussions/20), [#21](https://github.com/GabrieleLozupone/kokon/issues/21)). Turn on **Prompt+** next to Quality and type a short idea, in any language: Kokon writes a detailed prompt from it first (for edits it looks at your photo), you watch it being written, then the image is made from it. The result keeps both your words and the written prompt. The prompt is written by Qwen3-VL 8B, the text encoder Qwen-Image 2.1 already loads, so there is no second model to download and nothing extra in memory. On an RTX 5070 Ti it adds about 2 seconds per image (about 13 seconds on an M2 Pro); it also fits on 8 GB cards. Both system prompts can be edited in Settings → General.

To make this possible, Kokon now runs its own build of stable-diffusion.cpp, from [our fork](https://github.com/GabrieleLozupone/stable-diffusion.cpp/tree/kokon), on Windows, macOS and Linux: upstream plus text generation on the loaded text encoder (about 127 tokens/s on an RTX 5070 Ti, the same tokens as llama.cpp). The image side is upstream's code and makes bit-identical images. Upstream prefers to leave text generation to llama.cpp ([#2155](https://github.com/leejet/stable-diffusion.cpp/issues/2155)), which is fair, so it lives in the fork, kept close to upstream.

- **Your own LoRAs (beta)** ([#21](https://github.com/GabrieleLozupone/kokon/issues/21)): load a Qwen-Image 2.1 LoRA (`.safetensors`) in Settings → LoRA, set its strength and trigger words, then turn it on or off for each project with the **LoRA** button next to the prompt, up to 3 at once. Kokon checks each file and keeps its own prepared copy; your file is not changed. LoRAs for older Qwen-Image versions (1.0, 2512, Edit 2509/2511) are refused, because they don't work on 2.1. Tested on Windows with an NVIDIA card; please tell us how it goes on Mac and Linux. About the **curated LoRA list** announced in 0.9.4: we tested the popular 2.1 LoRAs on the Turbo model Kokon runs, and today they don't improve on what Turbo does with a good prompt, so there is no catalog for now. It comes when a LoRA earns its place.
- **A new look**: a calmer, deeper design in light and dark, with Kokon's own window bar. Images hatch out of the Kokon mark when they are done, and one percentage covers the whole job, upscaling included. Settings is now at the bottom of the sidebar.
- **Clean up in one go**: press **Select** above your projects or in All images to remove several at once (or Ctrl/⌘-click, Shift-click for a range).
- **Faster on big cards** ([#27](https://github.com/GabrieleLozupone/kokon/pull/27)): with 24 GB of graphics memory or more, Fast images (and Balanced from 32 GB) finish a little sooner.
- **Fixes**
  - On Linux and macOS a crashed engine no longer leaves an image waiting forever ([#28](https://github.com/GabrieleLozupone/kokon/pull/28)).
  - Kokon starts even when Windows reserves its ports (WSL, Docker or Hyper-V).
  - 8 GB cards keep some memory free for the engine, so the first image no longer crashes it.

**Updating from 0.9.4**: your images, models and settings stay as they are. What's New offers the new engine, a one-time download: about 344 MB on Windows with NVIDIA, 29 MB with AMD or Intel, 352 MB on Linux with NVIDIA, 38 MB with AMD or Intel, 37 MB on a Mac. If you press Later, everything works as before and Prompt+ stays hidden until you install it (Settings → Set up models).

On macOS, if the first launch only says **The application "Kokon" can't be opened**, with just an OK button and no *Open Anyway* in System Settings, run `xattr -dr com.apple.quarantine /Applications/Kokon.app` in Terminal, then open Kokon. Details in the [README](https://github.com/GabrieleLozupone/kokon#macos-says-kokon-cannot-be-opened).

### Installing on Linux

```bash
sudo apt install ./Kokon_0.10.0_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.10.0-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Thanks

- @badraymen, for the idea of writing prompts with the model's own text encoder and the list of LoRAs to test (#21).
- @ukrolelo, who asked for a prompt enhancer (Discussion #20).
- @giveen, for the faster decodes on big cards (#27) and the crashed-engine fix on Linux and macOS (#28).

### Downloads

| File | SHA-256 |
|---|---|
| `Kokon_0.10.0_x64-setup.exe` (Windows) | `df9702218d595c7c2df89410112f15b6b101f5a55aa693c2b5aaa4e8223d6860` |
| `Kokon_0.10.0_aarch64.dmg` (Mac, macOS 15+) | `9605d10a71dc7e1d40fb0f05f78cf4f211d490d8cf14674a22ceffe2b3d60852` |
| `Kokon_0.10.0_amd64.deb` (Ubuntu, Debian, Mint) | `f55c6fea1ede350db4782823144e911e3754f0bb6dfbd5ed46c0b200eab7f998` |
| `Kokon-0.10.0-1.x86_64.rpm` (Fedora) | `cf8207312f356e6bf319c7b3cdcddbe06c1e41d80467070642976b8815be0175` |
