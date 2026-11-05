# Linux: plan, status and engine upkeep

Kokon supports **Linux from 0.9.4** (x86_64, `.deb` + `.rpm`, NVIDIA CUDA and Vulkan for AMD/Intel),
next to Windows and macOS. Every release from now on ships all three.

## The plan (decided 2026-10-16)

The app is already client/server: the UI talks to `kokon-service` only over HTTP (base URL + token,
`src/lib/api.ts`); the desktop shell just starts the service and hands the UI `127.0.0.1` + token
(`src-tauri/src/lib.rs` `connect`). So the three steps are one product started three ways:

1. **Native Linux app** (this document, 0.9.4). Same app as Windows/Mac: local service on 127.0.0.1.
2. **Headless server + browser UI**, then **Docker**. `kokon-service` serves the built UI itself;
   network access is opt-in, off by default, with a real password (rate-limited) before anything
   listens beyond localhost; recommend Tailscale/VPN over exposing it. Docker = the same Linux build
   without a window, model folders mounted as volumes. Planned as 0.11.0.
3. **Kokon as a client**: the desktop app (Windows/Mac/Linux) connects to a Kokon server elsewhere.
   "Connect to a server" in Setup/Settings (address + password); `connect` returns the remote URL.
   Needs: copy-image by bytes instead of a local path (`Stage.tsx` → `copy_image`), hide "Show in
   folder"/"Open logs", import/export by upload/download instead of paths (`api.ts` `importPath`,
   `exportGeneration`), setup's "Use models I already have" picks a folder **on the server**, and a
   client/server version check.

Rough effort for one person: 1 = days, 2 = 3–5 days, 3 = about a week. Order: 1 → 2 (+Docker) → 3.
Public promise: issue #15 comment (2026-10-16). #22 closed as its duplicate.

**Decided (2026-10-22) for 0.11.0:** the first remote client is the **browser UI** served by `kokon-service`
(the desktop app connecting to a server, step 3, comes later). Access is **local network only**, off by default,
behind a password with a limit on attempts; for access from outside, a guide to Tailscale or another VPN, never
direct exposure. **Docker: an NVIDIA (CUDA) image first**; a Vulkan image for AMD/Intel follows once it can be tested.

## Why Kokon builds its own Linux engine

Upstream stable-diffusion.cpp publishes Linux zips for Vulkan, ROCm and CPU only, **no CUDA**, built on
Ubuntu 24.04: they need **glibc 2.38**, so they don't run on Ubuntu 22.04 or Debian 12. Kokon builds its
engine on **Ubuntu 22.04** (glibc 2.35; the Vulkan build needs ≤ 2.34) with upstream's own flags and CUDA
architectures (`61;70;75;80;86;89;90;100;120`, CUDA 12.8).

**Since 0.10 (current):** one workflow builds every platform's engine.

- Fork: `GabrieleLozupone/stable-diffusion.cpp`, branch **`kokon`** = upstream (`UPSTREAM_BASE`, now
  fd21ecf) + the text-generation commits for Prompt+ + workflow **`kokon.yml`**. ggml comes from Kokon's
  ggml fork (branch `sdcpp-cuda-graphs-opt-in`, CUDA graphs only for reused graphs).
- A push to `kokon` that passes every job of `kokon.yml` (or a manual run with `create_release`)
  publishes **`kokon-<n>-<commit>`** (now [`kokon-1013-1814814`](https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/tag/kokon-1013-1814814)):
  `sd-kokon-<commit>-bin-Linux-Ubuntu-22.04-x86_64-{cuda12,vulkan,cpu,rocm-10.1.0}.zip`, the Windows and
  macOS 15 zips, `cudart-sd-bin-{linux,win}-cu12-x64.zip` and `SHA256SUMS.txt`. A published release is
  never replaced (rebuilds aren't byte-identical and the app pins SHA-256).
- The app pins it in `crates/qls-core/src/catalog.rs` (`ENGINE_TAG`, Linux `ENGINE_CUDA` / `ENGINE_VULKAN`),
  and `engine.json` lists it under the `kokon` key (`linux_cuda`, `linux_vulkan`), so Linux gets engine
  updates without an app release. The Linux CUDA runtime (`CUDA_RUNTIME`) stays pinned to
  `kokon-linux-1d0a58a`; it is only downloaded once.

**Up to 0.9.4 (history; these releases still serve old apps, don't delete them):** branch `kokon-linux`
(upstream commit + `kokon-linux.yml`) published `kokon-linux-<commit>`, and `kokon-macos.yml` published
`kokon-macos-<commit>` for macOS 15. First build: run 38885751650 (2026-10-16): Vulkan 12 min, CUDA
1 h 32 min. Its CUDA smoke test was wrong (sd-server links libcuda.so.1, which only the NVIDIA driver
provides, so it can't start in CI); the release was published by hand after a real check in WSL. The
workflows now only check libraries for CUDA.

## Engine upkeep: check at every release (and when engine.json moves)

Upstream moves fast. Every platform follows the same release, so:

1. `gh api repos/leejet/stable-diffusion.cpp/compare/<UPSTREAM_BASE>...master` and the upstream releases.
2. In the fork clone: `git fetch upstream`, `git switch kokon`, rebase the Kokon commits onto the new
   upstream commit, set `UPSTREAM_BASE` in `kokon.yml`, push to `fork`.
3. The push runs `kokon.yml`; when every job passes it publishes `kokon-<n>-<new commit>`. Check the glibc report
   in the build log.
4. Test on Windows (CUDA + Vulkan), Linux (WSL: engine download, one image, one Prompt+ job) and a Mac.
5. Ship it: either bump `ENGINE_TAG` and the pins in `catalog.rs` with an app release, or edit the
   `kokon` key in `engine.json` on master (digests: `gh release view <tag> -R
   GabrieleLozupone/stable-diffusion.cpp --json assets`). Details in
   [engineering-notes.md](engineering-notes.md), "Engine updates".

## Building and testing the Linux app

- Build machine: **WSL Ubuntu-22.04** on the dev PC (installed 2026-10-16; sees the RTX 5070 Ti through
  the Windows driver, so CUDA can be tested; windows open through WSLg). Clone on the Linux disk:
  `git clone -b master /mnt/c/AI/qwen-local-studio ~/kokon` (never build from /mnt/c: npm would replace
  the Windows node_modules). Ubuntu's `cargo` package is too old; use rustup (`. ~/.cargo/env`).
- Release: `bash scripts/build-release-linux.sh --setup` once, then `bash scripts/build-release-linux.sh`
  → `dist-release/Kokon_<v>_amd64.deb`, `Kokon-<v>-1.x86_64.rpm`, `updater-linux-x86_64-{deb,rpm}.json`.
  Signed with the same updater key as Windows/Mac (`~/.tauri/kokon-updater.key`, also found under
  /mnt/c/Users/*/.tauri).
- **g++-13** (ubuntu-toolchain-r PPA, `--setup` installs it; since 0.12): the ONNX Runtime that `ort`
  downloads (AI watermark, fast stickers) needs GCC 13's libstdc++ and Ubuntu 22.04 has GCC 11's.
  `crates/qls-core/build.rs` links g++-13's `libstdc++.a` into kokon-service statically, so users need
  nothing new. The Docker image's build stage installs it too.
- Quick run without packaging: `npm run build && cargo build -p kokon --release --features
  tauri/custom-protocol && ./target/release/kokon` (without the feature the window loads the dev server
  and shows "Could not connect to localhost").
- In-app updates work on Linux: tauri-plugin-updater 2.13 installs `.deb`/`.rpm` through pkexec;
  `latest.json` needs `linux-x86_64-deb` and `linux-x86_64-rpm` entries.
- Package dependencies (tauri.linux.conf.json): libssl3 / openssl-libs (reqwest native-tls), libgomp,
  libvulkan1 / vulkan-loader. HEIC photos can't be opened on Linux yet (message shown).

## Status (2026-10-20)

- ✅ **0.9.4** (2026-10-16): first Linux release, `.deb` + `.rpm`, engine `kokon-linux-1d0a58a`.
- ✅ **0.10.0** (2026-10-20): Linux on Kokon's own `kokon-992-dfaab76` like every platform (Prompt+
  included), Linux entries in `engine.json`; crashed engine no longer leaves a job waiting forever (#28).
- Builds: WSL Ubuntu-22.04, `build-release-linux.sh` (section above). CUDA tested in WSL on the
  RTX 5070 Ti; LoRA (beta) not tested on Linux by us.

Later
- [ ] Real-hardware reports: AMD on Linux (swingtempo R9700, alean200), a non-WSL NVIDIA machine.
- [ ] AppImage? Not planned (large, and deb/rpm cover the main distros).
- [x] Step 2 of the plan above (0.11.0, branch `server-0.11`): `kokon-service` serves the UI it embeds
  (`crates/qls-service/src/remote.rs`); a second listener on all interfaces (`remote_port`, 39152) opens only
  with access on and a password set, and refuses the token; rules and tests in `qls_core::remote`. Guides:
  [remote-access.md](remote-access.md), [docker.md](docker.md).
- [ ] Step 3 (the desktop app as a client). Decided 2026-10-23: when it comes, the app keeps two separate
  galleries, "This computer" and the server's, with a button to save a server image locally; no automatic
  sync (conflicts, duplicates, lost images). Away from home the server's gallery is reachable only through
  Tailscale or another VPN.
