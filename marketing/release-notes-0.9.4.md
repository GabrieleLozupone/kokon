## Kokon 0.9.4

**Kokon on Linux** ([#15](https://github.com/GabrieleLozupone/kokon/issues/15)). Kokon now runs natively on Linux x86-64: a `.deb` for Ubuntu, Debian and Mint, and an `.rpm` for Fedora. NVIDIA cards use a CUDA build of the engine, AMD and Intel cards a Vulkan build. Upstream stable-diffusion.cpp has no Linux CUDA build, and its Linux builds need a newer glibc than Ubuntu 22.04 or Debian 12 have, so Kokon builds the same engine version itself on Ubuntu 22.04. Updates install from inside the app, as on Windows and Mac. This is a beta: so far it has been tested on an RTX 5070 Ti (CUDA, under WSL), and the Vulkan engine has been checked to start on Ubuntu, Debian and Fedora. Reports from real Linux machines, especially with AMD cards, are very welcome.

- **macOS 15 Sequoia** ([#24](https://github.com/GabrieleLozupone/kokon/issues/24)): Kokon used to need macOS 26, because the official stable-diffusion.cpp Mac build does. Kokon now builds its own Mac engine for macOS 15, so Sequoia Macs can run it too.
- **Colour LUTs**: press **LUT** under any image. Choose one of eight built-in looks (**Neutral** takes out the yellowish cast Qwen-Image tends to give, plus Warm, Cool, Teal & Orange, Vivid, Soft Film, Matte and Black & White) or open your own `.cube` files. You see the result live, with an intensity slider; hold **Before** or the B key to compare. Saving makes a new version, so the original stays as it was.
- **Faster inpainting**: the model now gets a lighter copy of the image to look at (at most 1 megapixel, as for edits), and small photos are no longer enlarged to the full 2K canvas. On an RTX 5070 Ti a red-hat edit on a 1024×1024 photo went from 40 s to 17 s with the same quality, and large inpaints no longer slow down by running out of GPU memory. Advanced → Reference detail → **Full** keeps the previous behaviour.
- **Fixes**
  - Square 2K upscales use the upscaler model again instead of plain Lanczos.
  - RTX 20 and older cards no longer try SageAttention, which they don't support (reported on Reddit with a 2080 Ti).
  - Uninstalling on Windows also removes the app's WebView cache, so nothing is left behind.
  - `kokon-mcp --version` reports the app's version ([#6](https://github.com/GabrieleLozupone/kokon/issues/6)).

On macOS, if the first launch only says **The application "Kokon" can't be opened**, with just an OK button and no *Open Anyway* in System Settings, run `xattr -dr com.apple.quarantine /Applications/Kokon.app` in Terminal, then open Kokon. Details in the [README](https://github.com/GabrieleLozupone/kokon#macos-says-kokon-cannot-be-opened).

Updating from 0.9.3: your images, models and settings stay as they are. The engine doesn't need to download again.

### Installing on Linux

```bash
sudo apt install ./Kokon_0.9.4_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.9.4-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Thanks

- @obsolete-pebble-symphony, for #24 and the patch that showed Kokon runs on Sequoia.
- @giveen and @swingtempo, and everyone on Reddit who asked for Linux.
- u/chillahc, who asked for LUTs to fix the yellow tint; u/GfurEnjoyer1488, for the 2080 Ti report; u/janosibaja, for the uninstaller; u/_Antartica, for the inpaint timing on a 5090 that started the speed-up.

### Coming in 0.10.0: LoRA

LoRA support was announced for this version. It moved to 0.10.0 so that Linux could come first, sorry for the change. The plan is the same: your own LoRA files plus a curated list tested with Qwen-Image 2.1 Turbo, up to three at a time, each with its own weight.

### Downloads

| File | SHA-256 |
|---|---|
| `Kokon_0.9.4_x64-setup.exe` (Windows) | `a44254255b4e6078643c565238c7793a6480c0f55cf60d49b5f5342f91f9d911` |
| `Kokon_0.9.4_aarch64.dmg` (Mac, macOS 15+) | `0b978390be59fbeea30760d61180d1a781e3531673946541310f180860549c85` |
| `Kokon_0.9.4_amd64.deb` (Ubuntu, Debian, Mint) | `af66cc93bc432750e69170d5374b10e97e73fe8af749f8b1cf68245ce3703e18` |
| `Kokon-0.9.4-1.x86_64.rpm` (Fedora) | `0b5417f634c7f1022619c3a31c4b2cbce7e1a41fdd175a5e4a0e3db6ae560703` |
