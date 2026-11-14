## Kokon 0.12.1

More like this, sharp objects after resizing them in the Layers lab, and the GPU freed when Kokon is idle.

- **More like this** ([#55](https://github.com/GabrieleLozupone/kokon/issues/55)): under a new image, **More like this** makes another one from it. **Subtle** keeps the picture and changes the details; **Strong** keeps the idea and changes more. **Regenerate** still starts over with a new seed. About as fast as Regenerate.
- **Redraw at this size** (Layers lab): an object made bigger with the corner handle is drawn from stretched pixels, so past about 1.2x it looks soft. **Redraw at this size** has the model draw it again at the size it has on the canvas; the stretched version stays under Versions.
- **The GPU is freed when Kokon is idle** ([#52](https://github.com/GabrieleLozupone/kokon/discussions/52)): after 10 idle minutes the model leaves the GPU even with a Kokon window or browser tab open, so other programs can use it. It loads again with the next image. If you had kept the old default (15 minutes), it moves to 10; a time you set yourself, or 0 (never), stays.
- **A folder for each project** (optional): Settings → General → **A folder for each project**. New images are saved in a folder named after their project instead of one folder per day. Off unless you turn it on.
- **Local time in the image's file**: the creation time saved in each image is now your local time. It was written in UTC, so Windows and many photo viewers showed it an hour early in Europe.
- **A clear message when Kokon cannot start** ([#53](https://github.com/GabrieleLozupone/kokon/issues/53)): on a processor without AVX, Kokon now says so instead of pointing to a log that does not exist. If the service fails while starting for another reason, its output is saved to `kokon-service-start.log` in the temp folder and the last lines are shown.

**Updating from 0.12.0**: the app updates itself; your images, settings and models are kept.

On macOS, if the first launch only says **The application "Kokon" can't be opened**, with just an OK button and no *Open Anyway* in System Settings, run `xattr -dr com.apple.quarantine /Applications/Kokon.app` in Terminal, then open Kokon. Details in the [README](https://github.com/GabrieleLozupone/kokon#macos-says-kokon-cannot-be-opened).

### Installing on Linux

```bash
sudo apt install ./Kokon_0.12.1_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.12.1-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Known issue

AMD RX 6000 (RDNA2) cards: turn flash attention off in Settings → Performance (about 5x faster steps on an RX 6700 XT).

### Thanks

- @MangoMonger2k for the More like this idea ([#55](https://github.com/GabrieleLozupone/kokon/issues/55)), @almirjakubaitis for the report behind the clearer start errors ([#53](https://github.com/GabrieleLozupone/kokon/issues/53)), and a Ko-fi supporter for the local time and project folders.

### Downloads

| File | SHA-256 |
|---|---|
| `Kokon_0.12.1_x64-setup.exe` (Windows) | `8728fb2d3c4847f22a95bcbf068c6cd34b0a571d9411caee16bce5795157fcea` |
| `Kokon_0.12.1_aarch64.dmg` (Mac, macOS 15+) | `6fdff646145e53301e76aada296172cd2cdaf114719e980b07b090e6be769d3b` |
| `Kokon_0.12.1_amd64.deb` (Ubuntu, Debian, Mint) | `f79227667465b0346ad4bec4a35b99dd2c4364f0a550e30a5a9ea7f57ceb7576` |
| `Kokon-0.12.1-1.x86_64.rpm` (Fedora) | `72e6e2ff0644c2bc82b51ae28762f8da3177ff0301fbb4aa5ac6c3c45dd8da8b` |
