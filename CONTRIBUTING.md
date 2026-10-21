# Contributing to Kokon

Thanks for helping. Bug reports, docs fixes, example prompts and pull requests are all welcome.
Kokon is a small project maintained by one person, so short, focused changes are the easiest to
review.

## Before you start

- **Bugs and install problems:** open an issue with the template. The **Settings → Diagnostics →
  Copy** output saves a lot of back-and-forth.
- **New features or larger changes:** open an issue or a
  [discussion](https://github.com/GabrieleLozupone/kokon/discussions) first, so we can agree on
  the approach before you write the code.
- **Security issues:** don't open a public issue; see [SECURITY.md](SECURITY.md).

## Build from source

**Windows:** Rust (stable, MSVC), Node 22+, Visual Studio Build Tools and WebView2.

```powershell
npm install
npx tauri dev                     # run the desktop app in development
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1   # installer
```

**Mac (Apple Silicon, macOS 15+):** Xcode Command Line Tools, Rust and Node 22+.

```bash
bash scripts/dev/mac-dev.sh --check   # check the prerequisites
bash scripts/dev/mac-dev.sh           # build and run the app in development
bash scripts/build-release-mac.sh     # Kokon.app + .dmg in dist-release/
```

To generate images you need the models. The app's first-run setup screen downloads them, or you
can point it at an existing stable-diffusion.cpp folder. Most code changes (planner, geometry,
UI logic, MCP) can be tested without a GPU through the unit tests.

Publishing a release is described in [docs/releasing.md](docs/releasing.md) and is done by the
maintainer.

## Tests

Run these before opening a pull request:

```bash
cargo test -p qls-core         # Rust core: geometry, planner, imaging, catalog, store
npm test                       # UI logic (vitest)
cd mcp && npm test             # MCP server, including a stdio protocol test
```

The MCP server has its own `package.json`: run `npm install` in `mcp/` once before its tests.

GitHub Actions runs the UI and MCP TypeScript checks and unit tests on pull requests and pushes
to `master`, using Node 22. To run the MCP unit tests without the protocol test, use
`cd mcp && npm test -- test/paths.test.ts test/tools.test.ts test/version.test.ts`. The protocol test is excluded
from CI for now: it requires a built `kokon-service` (`cargo build -p qls-service`) and the
MCP bundle (`cd mcp && npm run build`).

## Where things live

- `crates/qls-core`: all the logic (geometry, imaging, planner, inference adapter, job queue,
  gallery, pinned downloads in `catalog.rs`).
- `crates/qls-service`: the local HTTP service on `127.0.0.1`.
- `src-tauri/` and `src/`: the desktop shell (Rust) and the UI (React + TypeScript).
- `mcp/`: the MCP server (TypeScript, official SDK).

[docs/engineering-notes.md](docs/engineering-notes.md) has a module map and the measured backend
facts behind each default. Internal names such as `qls-core` and `QLS_*` come from the project's
working title and are kept on purpose.

## Code style

- Follow the style of the file you are editing. Rust: `cargo fmt` defaults. TypeScript: strict
  mode, function components and hooks.
- Keep logic in `qls-core` (or `src/lib/logic.ts` for the UI) where it can be unit-tested, and
  keep the service, the app shell and the MCP server thin.
- Only `sdcpp.rs` should know sd-server's request format.
- Add or update a test for behavior you change.
- Comments explain *why*, especially for defaults that come from measurements. If you change a
  measured default (sizes, memory budget, backend flags), say what you measured it on.
- UI text and docs: plain, short English.

## Good places to start

Issues labeled
[good first issue](https://github.com/GabrieleLozupone/kokon/labels/good%20first%20issue) are
picked to be approachable. Also welcome:

- **Docs:** clearer install steps, FAQ entries, fixes to anything that is wrong or out of date.
- **Example prompts:** prompts that work well, with before/after results
  ([docs/showcase-prompts.md](docs/showcase-prompts.md)).
- **Hardware reports:** how Kokon runs on AMD and Intel cards (Vulkan) or on Macs other than
  an M2 Pro. These are still unverified.
- **Small UI fixes:** layout glitches, keyboard shortcuts, accessibility labels.
- **Translations:** the UI is English only today. Please open an issue before starting, since
  there is no translation system yet.

## Licenses

Kokon's code is licensed under the [GNU AGPL-3.0](LICENSE). Before your first pull request is
merged, a bot asks you to sign the [Contributor License Agreement](CLA.md) with a one-line
comment. You keep the copyright on your work; the CLA lets the project ship it under the
AGPL and, if needed, under a commercial license too. Contributions are always also available
under the AGPL.

Model weights are not part of this repository. Kokon downloads them from their authors, and
they keep their own licenses (see [NOTICE](NOTICE)). Please don't commit model files or other
large binaries.
