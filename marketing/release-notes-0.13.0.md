## Kokon 0.13.0

Kokon in Italian, Spanish and French, and the graphics card you chose stays chosen.

- **Kokon speaks your language** ([#60](https://github.com/GabrieleLozupone/kokon/issues/60), [#34](https://github.com/GabrieleLozupone/kokon/issues/34)): the whole app is now in English, Italian, Spanish and French. It follows your computer's language; to change it, Settings → General → **Language**. Error messages from the local service and the prompts sent to the model stay in English for now. Native speakers: if a word sounds wrong, tell us in an issue.
- **Your graphics card stays chosen** ([#61](https://github.com/GabrieleLozupone/kokon/issues/61)): on a PC with two graphics cards, Kokon numbered the chosen card the way the engine listed it, and that order can change between restarts (with Vulkan, the card driving the monitor comes first). So moving the monitor cable could quietly move Kokon to the integrated GPU. Kokon now remembers the card by its name. If you never picked one, it uses the card with the most memory instead of the first one listed. If the chosen card is missing, Kokon runs on the largest one, says so in Settings → Diagnostics, and goes back to yours when it is there again. If you had picked a card before this version, check once in Settings → Performance that it is the right one.

**Updating from 0.12.x**: the app updates itself; your images, settings and models are kept.

On macOS, if the first launch only says **The application "Kokon" can't be opened**, with just an OK button and no *Open Anyway* in System Settings, run `xattr -dr com.apple.quarantine /Applications/Kokon.app` in Terminal, then open Kokon. Details in the [README](https://github.com/GabrieleLozupone/kokon#macos-says-kokon-cannot-be-opened).

### Installing on Linux

```bash
sudo apt install ./Kokon_0.13.0_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.13.0-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Known issue

AMD RX 6000 (RDNA2) cards: turn flash attention off in Settings → Performance (about 5x faster steps on an RX 6700 XT).

### Thanks

- @the-chadley for the detailed report and diagnosis of the GPU order ([#61](https://github.com/GabrieleLozupone/kokon/issues/61)), @fabrazz-eng and @badraymen for asking for other languages ([#60](https://github.com/GabrieleLozupone/kokon/issues/60), [#34](https://github.com/GabrieleLozupone/kokon/issues/34)), and @almirjakubaitis for two fixes to the Windows release script.

### Downloads

| File | SHA-256 |
|---|---|
| `Kokon_0.13.0_x64-setup.exe` (Windows) | `659c294ce7c36b3e8bd573e44ca5bf04189193cd1d9cb851f035efac48433076` |
| `Kokon_0.13.0_aarch64.dmg` (Mac, macOS 15+) | `a3b8dc70591bdefea63d3e4a46cf5db222bdf4d404b3550e400499df0c5315e7` |
| `Kokon_0.13.0_amd64.deb` (Ubuntu, Debian, Mint) | `92d99ee0ef038c59509f96f06a5067477744a53177f4553d5ce7744a95861aac` |
| `Kokon-0.13.0-1.x86_64.rpm` (Fedora) | `1be9202d81bd5fd37d61ebcf2cd491bdab4e7ee2f17d0908f8c6257ffeef0fc0` |
