# AGENTS.md

The entry point for anyone working on Kokon: people and coding agents (Claude Code, Codex, Cursor and
others). Read this first, then [docs/STATUS.md](docs/STATUS.md) for what is in progress.

## What Kokon is

Kokon is the simplest local photo editor: **edit photos by describing the change**. One installer sets up an
open image model on the user's own GPU (Windows, macOS, Linux), and the user brushes an area (or not) and
types what they want.

- **We pick the best open model, the user picks nothing.** Today that is Qwen-Image 2.1 Turbo (8 steps, CFG 1)
  with three quality presets. No settings to tune: sizes, memory and presets are decided by the code.
- **Expert controls are opt-in only**, in Settings, off by default, never next to the prompt box.
- **A request fits if it helps someone who has never used ComfyUI.** Power-user options go to the bottom of the list.
- **Changing the default model** needs a model that beats the current one overall on text-to-image, edit,
  multi-image edit and memory use, on the same test set; the old model stays selectable, with a rollback.
  Proposals: [Discussion #35](https://github.com/GabrieleLozupone/kokon/discussions/35).

## Architecture in one minute

```
Kokon app (Tauri 2 + React, src-tauri/ + src/)    kokon-mcp (mcp/, stdio)    scripts
                    └──── loopback HTTP + token ────┬────────────────────────┘
                                                    ▼
             kokon-service (crates/qls-service): stable API on 127.0.0.1, job queue, gallery
                         all logic in crates/qls-core (planner, pipeline, imaging, catalog…)
                                                    │  /sdcpp/v1/*
                                                    ▼
             sd-server (stable-diffusion.cpp, Kokon's own build) on 127.0.0.1
```

- `crates/qls-core`: all the logic. `sdcpp.rs` is the only file that knows sd-server's request format;
  `catalog.rs` pins every download (URL, size, SHA-256); `planner.rs` decides sizes and memory.
- `crates/qls-service`: thin HTTP service. `src-tauri/`: thin desktop shell. `src/`: React UI, logic in
  `src/lib/logic.ts`. `mcp/`: MCP server (TypeScript, official SDK).
- Engine: Kokon's build of stable-diffusion.cpp from the fork `GabrieleLozupone/stable-diffusion.cpp`
  (branch `kokon`); `engine.json` on master ships engine updates without an app release.
- `site/`: kokon.app (static, deploys on push to master). `marketing/`: Remotion videos, showcase images,
  release notes.

Module map and the measured facts behind each default: [docs/engineering-notes.md](docs/engineering-notes.md).

Working on the Mac engine (`engine-mac/`): read [engine-mac/AGENTS.md](engine-mac/AGENTS.md) first: optimize for
your own Mac without changing other chips, how to measure, and the report every engine PR carries.

## Build and test

Setup, prerequisites and the full commands are in [CONTRIBUTING.md](CONTRIBUTING.md). In short:

| | Run in development | Release build |
|---|---|---|
| Windows | `npm install`, `npx tauri dev` | `scripts\build-release.ps1` |
| macOS (Apple Silicon, 15+) | `bash scripts/dev/mac-dev.sh` | `bash scripts/build-release-mac.sh` |
| Linux (Ubuntu 22.04 / WSL, rustup cargo) | see [docs/linux.md](docs/linux.md) | `bash scripts/build-release-linux.sh` |

Tests, before every commit that touches code:

```bash
cargo test -p qls-core
npm test                 # UI logic (vitest)
cd mcp && npm test       # MCP server (the protocol test needs a built kokon-service)
```

Most changes (planner, geometry, UI logic, MCP) are testable without a GPU. Anything that runs the model for
minutes (real inference, benchmarks, release builds) is run by the maintainer: hand over the exact command.

## Conventions

- Logic in `qls-core` (or `src/lib/logic.ts`), where it can be unit-tested; service, shell and MCP stay thin.
- **Measured defaults carry their source.** If you change a size, memory budget or backend flag, say in the
  comment what you measured it on (GPU, OS, bench). Comments explain *why*.
- Add or update a test for behaviour you change. Tests never touch real user folders.
- UI text and docs: plain, short English. Follow the style of the file you edit (`cargo fmt`, strict TypeScript).
- Methods must generalize: no constants tuned on one image; every step falls back safely when it doesn't apply.
- Don't commit model files or large binaries. Code is AGPL-3.0-only; contributors sign the [CLA](CLA.md).

## Where the docs live

| Doc | What |
|---|---|
| [README.md](README.md) | the product for users: install, requirements, FAQ, short roadmap |
| [docs/STATUS.md](docs/STATUS.md) | **what is in progress, next, known issues, help wanted** |
| [CONTRIBUTING.md](CONTRIBUTING.md) | build, tests, code style, licences |
| [docs/engineering-notes.md](docs/engineering-notes.md) | architecture, module map, verified backend facts, engine updates |
| [docs/platforms.md](docs/platforms.md), [docs/linux.md](docs/linux.md) | per-platform notes; Linux plan and the 0.11 server design |
| [docs/releasing.md](docs/releasing.md) | publishing a version (maintainer) |
| [docs/prompting.md](docs/prompting.md), [docs/showcase-prompts.md](docs/showcase-prompts.md) | prompt guide and examples |
| [marketing/](marketing/) | videos, showcase images, release notes per version |

## Keeping docs/STATUS.md current

At the end of every task that changes what users get or what is planned:

1. Move what you finished from "In progress" to "Recently shipped" (or "Done on master, not released yet"),
   with the PR or issue link, and change the "Updated" date at the top.
2. Add new known issues or help-wanted items with their issue link; remove the ones that are closed.
3. Check the items against GitHub (`gh issue list`, `gh pr list`, releases) rather than memory: STATUS must
   never claim something the repo doesn't show.
4. Keep the README roadmap short and in step with it.

`node scripts/dev/agent-context.mjs` prints the STATUS pages; agents can run it at session start (Claude Code:
a SessionStart hook in `.claude/settings.local.json`).

If a `private/` folder exists, read `private/AGENTS.md` next (maintainer only).
