# Releasing Kokon

How to publish a version that installed copies update to, on Windows, macOS and Linux. Every release ships
all three from the same code.

## How updates work

- Once a day (unless turned off), the app reads
  `https://github.com/GabrieleLozupone/kokon/releases/latest/download/latest.json`.
- If its `version` is newer than the app's, a **Update to x.y.z** pill appears in the top bar.
- One click downloads the installer (Windows) or the app archive (Mac) and checks its
  signature against the public key in `src-tauri/tauri.conf.json`. Then it stops the local
  service, installs, and restarts Kokon. Settings, gallery and models are kept.
- The check needs the repository to be public (it is since 2026-10-11): GitHub serves the
  release files of a private repo only to signed-in users.

## The signing key (do this once)

- **The private key** lives in `~/.tauri/kokon-updater.key` (on Windows
  `%USERPROFILE%\.tauri\kokon-updater.key`), and its public half is in `tauri.conf.json`.
- **Back it up** (password manager, encrypted drive). If it's lost, already installed copies
  can never be updated again: you'd need a new key and every user would have to reinstall
  by hand.
- **Never commit it.** It lives outside the repo on purpose.
- **Mac:** copy it to `~/.tauri/kokon-updater.key` (for example over AirDrop, then
  `chmod 600 ~/.tauri/kokon-updater.key`). Both build scripts read it from there, or from the
  `TAURI_SIGNING_PRIVATE_KEY` environment variable.

## Publishing a version

1. **Bump the version** in `src-tauri/tauri.conf.json`, `Cargo.toml` (workspace) and
   `package.json`, all to the same value. The updater only offers versions *higher* than the
   installed one. Also bump the MCP server: `cd mcp && npm version <x.y.z> --no-git-tag-version`,
   then both `"version"` fields in `mcp/server.json` (`npm test` in `mcp/` fails until all match;
   `kokon-mcp --version` reads `mcp/package.json`).
   Update **What's new** too: `WHATS_NEW_VERSION` and the notes in `src/components/WhatsNew.tsx`
   (shown once after the update; with the old version there it never appears).
2. **Windows:** `powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1`
3. **Mac:** `bash scripts/build-release-mac.sh`.
   **Linux:** in WSL Ubuntu 22.04 (clone in `~/kokon`, see [linux.md](linux.md)),
   `bash scripts/build-release-linux.sh` → `.deb`, `.rpm` and `updater-linux-x86_64-{deb,rpm}.json`.
   Then copy each machine's `dist-release/` files to the PC so that one folder holds every platform's files.

   The Windows and Linux scripts link the **portable ONNX Runtime** instead of `ort`'s
   prebuilt one, which needs AVX2 and stops with `SIGILL` on SSE4.2 CPUs (a Xeon X5670, #53).
   Build it once per machine before the first release:
   `tools\ort-portable\build-ort-portable.ps1` on Windows,
   `bash tools/ort-portable/build-ort-portable.sh` on Linux; or point `ORT_LIB_LOCATION` at an
   existing build. The scripts stop with a clear message if it is missing
   ([tools/ort-portable/README.md](../tools/ort-portable/README.md)).

   As an alternative to a local machine, the manual **Portable CPU release** workflow
   (`.github/workflows/portable-cpu.yml`) builds the same Linux packages on Ubuntu 22.04 and the
   Windows installer on `windows-2022` (the image with the Visual Studio 2022 C++ toolchain),
   caching the portable runtime and uploading both as artifacts. Without the
   `TAURI_SIGNING_PRIVATE_KEY` secret they are signed with a throwaway key and cannot update
   official installs.
4. **Write the manifest:**
   `node scripts/release/updater.mjs manifest --notes "What changed, in one or two lines"`
   (`latest.json` must list Windows, macOS and both Linux packages).
   Release notes go in `marketing/release-notes-<version>.md`, with each installer's SHA-256.
5. **Publish** (the tag must be `v` + the version):
   ```bash
   gh release create v0.9.1 --draft --target master --title "Kokon 0.9.1" --notes-file notes.md \
     dist-release/Kokon_0.9.1_x64-setup.exe dist-release/Kokon_0.9.1_aarch64.dmg \
     dist-release/Kokon_0.9.1_aarch64.app.tar.gz dist-release/latest.json
   ```
   - **What people download:** `Kokon_<version>_x64-setup.exe` on Windows (`Kokon Setup.exe`
     in dist-release is an identical copy, not uploaded) and the `.dmg` on a Mac.
   - **What the updater downloads:** the `_x64-setup.exe` and the `.app.tar.gz`, which
     `latest.json` points to.
   - Put the installer's SHA-256 in the notes.
   - A release marked *pre-release* is not "latest", so the updater ignores it.
   - Review the draft on GitHub, then press **Publish**.
6. **Adding the other platform later** (e.g. the Mac build after the Windows one):
   1. Copy its files and its `updater-<platform>.json` into the same `dist-release/`.
   2. Run the manifest step again.
   3. Upload with `gh release upload v0.9.1 <files> dist-release/latest.json --clobber`.
7. **Docker image**: publishing the release starts `.github/workflows/docker.yml`, which builds
   `docker/Dockerfile` and pushes `ghcr.io/gabrielelozupone/kokon` with the tags `<x.y.z>`, `<x.y>`
   and (not for a pre-release) `latest`. Check the run in the Actions tab. To build a tag again:
   `gh workflow run docker.yml -f tag=v<x.y.z>`. The first push creates the package as private:
   once, on GitHub → Packages → kokon → Package settings, set its visibility to **Public**.
8. **MCP server** (after the GitHub release is out): `cd mcp && npm login && npm whoami && npm publish`
   (`npm login` first: an expired login makes `npm publish` fail with a misleading **E404 Not Found**; it runs the build and
   tests first), then `mcp-publisher login github` and `mcp-publisher publish` from `mcp/` so the
   MCP Registry lists the new version. Glama (https://glama.ai/mcp/servers/GabrieleLozupone/kokon):
   Admin → Repository → **Sync Server**, then Admin → Dockerfile → **Build** (the saved spec:
   build `cd mcp && npm ci && npm run build`, CMD `mcp-proxy -- node ./mcp/build/kokon-mcp.cjs`;
   no Kokon app needed to list the tools), and on the passed test **Create Release** with the
   new version. The release is what Glama grades the tools on.

## Testing an update

1. Install version A (for example 0.9.0) from its installer.
2. Publish version B (0.9.1) as above.
3. Open A. The check runs at startup, at most once a day; to force it, use Settings → General →
   **Check now**. Then click **Update to 0.9.1**. Kokon restarts as 0.9.1, and Settings →
   General shows the new version.
