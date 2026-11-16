## Kokon 0.12.2

Kokon now runs on older processors: x86-64 with SSE4.2 and no AVX.

- **Runs on a CPU without AVX** ([#53](https://github.com/GabrieleLozupone/kokon/issues/53)): on a
  2010 Xeon X5670 the app, the service and the MCP server now start and work. Before this, the
  ONNX Runtime binary that was downloaded had an AVX2 baseline, so the service stopped with
  "Illegal instruction" before it could say anything.
- **One binary for old and new CPUs.** The runtime is built with an SSE4.2 baseline, and its
  AVX/AVX2/AVX-512 kernels are still compiled and chosen at runtime, so the same install uses them
  when the processor has them. Nothing in the build is tuned for one machine.
- **Measured on a Xeon X5670 with a Quadro P6000**: generating 1024² in ~73 s, an edit in ~106 s,
  fast stickers in ~18 s. The Windows and Linux packages are built on clean runners, and the release
  binaries are run there on an emulated CPU without AVX.

**Updating from 0.12.1**: the app updates itself; your images, settings and models are kept.

### Installing on Linux

```bash
sudo apt install ./Kokon_0.12.2_amd64.deb      # Ubuntu 22.04+, Debian 12+, Mint 21+
sudo dnf install ./Kokon-0.12.2-1.x86_64.rpm   # Fedora 40+
```

NVIDIA cards need the proprietary driver (the CUDA runtime comes with Kokon). AMD and Intel cards use Mesa's Vulkan driver.

### Downloads

The SHA-256 of each file is added when the packages are published.

| File | SHA-256 |
|---|---|
| `Kokon_0.12.2_x64-setup.exe` (Windows) | |
| `Kokon_0.12.2_aarch64.dmg` (Mac, macOS 15+) | |
| `Kokon_0.12.2_amd64.deb` (Ubuntu, Debian, Mint) | |
| `Kokon-0.12.2-1.x86_64.rpm` (Fedora) | |
