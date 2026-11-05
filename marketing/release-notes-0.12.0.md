## Kokon 0.12.0

[![Kokon 0.12: split any image into layers, move objects, export to PSD](https://i.ytimg.com/vi/eGr9yYe7NVc/maxresdefault.jpg)](https://youtu.be/eGr9yYe7NVc)

Split any image into layers, paint where things go, and Kokon's own engine on by default on Macs.

- **Layers lab (experimental)**: open an image, press **Layers (lab)** and click the things you want on their own layer. Kokon cuts each one out (**Fast**, a few seconds per object, or **Quality**, the AI redraws each edge) and paints the background behind them, so nothing leaves a hole when it moves. Then move, scale, hide or edit each layer on its own, **Expand** a layer to complete an object cut off by the frame, draw new objects with the pencil, and **Save as image** (a new version of your project) or **Export PSD** (every layer, for Photoshop, GIMP or Photopea). Progress and **Stop** for every step. On a phone the lab is off; the layered image is shown as one picture.
- **Blend into scene (experimental)**: after moving objects, Kokon reads where each one stands (you can correct it) and redraws their shadows, or reflections on wet or shiny ground, as one Blend layer you can turn down. It often does not work yet; blending all the objects at once works best.
- **Paint with colours**: in a brushed edit, paint each thing in its own colour and write what goes there, right on the picture: several changes in one go, and only what you painted changes. **Select (S)** picks an object with one click (its model, 44 MB, downloads the first time you use it).
- **Prompt+ for brushed areas and Expand**: Prompt+ now writes the prompt for a painted area (it names what to remove) and for Expand (what the new borders show), for you to check before it runs. A new **Detail** choice in the Prompt+ menu: Standard (short, focused) or Detailed (more context for the image model).
- **Kokon's Mac engine is on by default** on Macs with 16 GB or more: about a minute for a new 1-megapixel image on an M2 Pro (about 106 s for an edit), four times faster than the standard engine. It switches on once at the first start; if you answered *Not now* in 0.11, your choice is kept and it stays one switch away in Settings → Performance. LoRAs and the upscaler model still use the standard engine. On M5 Macs the engine now runs its matrix products and its attention on the GPU's neural accelerators: on an M5 Pro a 1024 × 1024 image went from 37 to 29 s and an edit from 40 to 31 s ([#49](https://github.com/GabrieleLozupone/kokon/pull/49), [#50](https://github.com/GabrieleLozupone/kokon/pull/50)); M1 to M4 Macs run as before.
- **AI marking**: every image Kokon makes says, in its file (IPTC metadata) and in an invisible watermark, that it was made with AI, as the EU AI Act asks; exported PSDs carry the metadata. **Settings → General → Check an image** reads both. What is marked and how: [docs/ai-marking.md](https://github.com/GabrieleLozupone/kokon/blob/master/docs/ai-marking.md).
- **Tidier projects**: the project list is grouped by day with clearer titles, and several versions can be deleted at once (Ctrl- or Shift-click them in the timeline, then Delete).
- **Video guides**: the **?** in the top bar is now a Help menu with the keyboard shortcuts, the prompt tips and short videos on YouTube ([what you can do with Kokon](https://youtu.be/WDbHxkbpU4s), [what's new in 0.12](https://youtu.be/eGr9yYe7NVc), [using it from your phone](https://youtu.be/XnC_7P2_cww)). They open in your browser; nothing is loaded from YouTube until you click.

**Updating from 0.11.2**: the app updates itself; your images, settings and models are kept. The installers are bigger than before (they now carry the cut-out and watermark models): about 136 MB on Windows, 162 MB on a Mac, 170 MB on Linux.

On macOS, if the first launch only says **The application "Kokon" can't be opened**, with just an OK button and no *Open Anyway* in System Settings, run `xattr -dr com.apple.quarantine /Applications/Kokon.app` in Terminal, then open Kokon. Details in the [README](https://github.com/GabrieleLozupone/kokon#macos-says-kokon-cannot-be-opened).

### Installing on Linux

```bash
sudo apt install ./Kokon_0.12.0_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.12.0-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Known issue

AMD RX 6000 (RDNA2) cards: turn flash attention off in Settings → Performance (about 5x faster steps on an RX 6700 XT). Letting the engine choose per card needs a new engine and comes in a later update.

### Thanks

- @CesareDavidePace, for making the Mac engine faster on the M5 ([#49](https://github.com/GabrieleLozupone/kokon/pull/49), [#50](https://github.com/GabrieleLozupone/kokon/pull/50)).

### Downloads

| File | SHA-256 |
|---|---|
| `Kokon_0.12.0_x64-setup.exe` (Windows) | `1df6b48423c0e85c1d80f0c3ed2d32ac18dfcc8a8849703f32f9aee60767a9d4` |
| `Kokon_0.12.0_aarch64.dmg` (Mac, macOS 15+) | `b841c6cdfe0110f634ae675d9bd85c2edde1ddc7b858a6fe1297c27f66101cf4` |
| `Kokon_0.12.0_amd64.deb` (Ubuntu, Debian, Mint) | `a149948649fcc12da5518a6f7039815d001a74049258452b425bb295acdb132b` |
| `Kokon-0.12.0-1.x86_64.rpm` (Fedora) | `782add3c47b71762464b0a829a55128b16ddc597abfa4cf627fcfb032846d014` |
