# Kokon — Agent Onboarding Document

**Read this file at the start of every session.**  
Last updated: 2026-10-15  
Version: 0.9.2

---

## 🎯 Project in One Sentence

**Kokon** is a native desktop app (Windows/macOS) that lets you edit photos by describing changes in natural language — "remove the person", "make it golden hour", "add a lighthouse" — running 100% locally on your GPU via Qwen-Image 2.1 Turbo, with no cloud, no Python, no ComfyUI.

---

## 🏗️ Architecture Overview

```
┌──────────────┐    HTTP+SSE    ┌────────────────────┐    native async    ┌──────────────┐
│   Kokon UI   │◄──────────────►│   kokon-service    │◄──────────────────►│  sd-server   │
│  (Tauri 2 +  │  token auth    │   (qls-service)    │   (stable-diffusion.cpp)   │
│   React 19)  │                │  planner · queue   │  CUDA / Vulkan / Metal       │
└──────────────┘                │  gallery · prep    └──────────────┘
       ▲                        └────────────────────┘
       │ HTTP+SSE                      ▲
       │                               │ native async
       │ MCP (stdio)                   │
┌──────┴──────┐                ┌────────┴────────┐
│ kokon-mcp   │                │ Your scripts    │
│ (MCP over   │                │ (curl, node,    │
│  stdio)     │                │  python, etc)   │
└─────────────┘                └─────────────────┘
```

### Three Rust Crates (Cargo Workspace)

| Crate | Binary | Responsibility |
|-------|--------|----------------|
| `qls-core` | — | **All logic**: planning, geometry, imaging, pipeline, engine, store, config, installer, diagnostics |
| `qls-service` | `kokon-service` | Headless HTTP service (127.0.0.1:39151), job queue, owns `sd-server`, SSE events |
| `src-tauri` | `kokon` | Tauri shell + React UI (desktop app) |

### TypeScript Packages

| Package | Purpose |
|---------|---------|
| `src/` | React UI (components, store, logic, api) |
| `mcp/` | MCP server (`kokon-mcp`), stdio transport, tools |

---

## 📁 Key Directories

```
kokon/
├── crates/
│   ├── qls-core/
│   │   └── src/
│   │       ├── planner.rs      # Request → Plan (mode, resolution, steps, VRAM budget)
│   │       ├── geometry.rs     # Canvas math, outpaint/inpaint geometry
│   │       ├── pipeline.rs     # Plan → backend request + post-process (crop, upscale, composite)
│   │       ├── engine.rs       # Job queue, cancellation, OOM retry, gallery persistence
│   │       ├── store.rs        # SQLite gallery (generations, inputs, refs, pipelines)
│   │       ├── sdcpp.rs        # Async client for sd-server (/sdcpp/v1/*)
│   │       ├── process.rs      # sd-server subprocess management, progress parsing
│   │       ├── config.rs       # User settings, presets, VRAM overrides
│   │       ├── catalog.rs      # Pinned downloads (models, engines, upscalers)
│   │       ├── installer.rs    # First-run setup, GPU detection, verified downloads
│   │       └── diagnostics.rs  # GPU query (nvidia-smi, DXGI, sysctl)
│   └── qls-service/
│       └── src/
│           ├── main.rs         # Service entry, lifecycle, leases, idle exit
│           └── api.rs          # Axum routes (/api/v1/*)
├── src/
│   ├── components/             # React UI (Stage, Composer, InpaintEditor, Gallery, etc.)
│   ├── lib/
│   │   ├── api.ts              # HTTP client + SSE subscription
│   │   ├── store.ts            # Global state (useSyncExternalStore)
│   │   ├── logic.ts            # Request building, version labels, timeline
│   │   └── types.ts            # TypeScript ↔ Rust type mirror
│   └── styles.css
├── src-tauri/
│   ├── src/main.rs             # Tauri entry point
│   └── tauri.conf.json         # Tauri config
├── mcp/
│   └── src/
│       ├── index.ts            # MCP server entry, tool registration
│       ├── tools.ts            # Tool handlers + Zod schemas
│       └── service.ts          # ServiceClient (HTTP + token)
└── docs/
    ├── engineering-notes.md    # Deep architecture, measured backend facts
    ├── prompting.md            # Prompt guide (also at kokon.app/prompt-guide)
    ├── zoom-roadmap.md         # Central zoom/pan implementation plan
    └── ...
```

---

## 🔄 Core Data Flow: User Request → Result

```
1. Composer (React) → buildRequest() in logic.ts
2. POST /api/v1/jobs { prompt, images[], mask?, mode, quality, ... }
3. kokon-service: Engine.enqueue()
   → planner.plan() → Plan { mode, workingSize, steps, CFG, sigmas, vaeTiling, ... }
   → pipeline.prepare() → PreparedJob { ImgGenRequest, PostProcess }
   → sdcpp.generate() → sd-server (GPU inference)
   → pipeline.finish() → crop/composite/upscale → final PNG
4. Engine persists GenerationRecord to SQLite gallery
5. SSE: Job { status: Done } → UI updates Stage/Composer
```

**MCP / scripts** hit the same `/api/v1/jobs` endpoint via `ServiceClient`.

---

## ⚙️ Key Conventions

| Convention | Detail |
|------------|--------|
| **Single source of truth** | Version in `Cargo.toml` workspace; `APP_VERSION` const in `engine.rs` |
| **Auth** | Bearer token from `service.json` (written at service start). All API calls except `/ping` require it. Browser `Origin` rejected. |
| **Images via URLs** | Frontend never handles raw bytes. `<img src="/gallery/{id}/image?token=...">` streams from service. |
| **Private mode** | `?private=true` on upload/import → temp store wiped on exit/window close. Never in gallery. |
| **Undo/Redo = version tree** | Each generation has `parent_id`. Undo = jump to parent. Nothing deleted. |
| **Quality presets** | Fast (~1 MP), Balanced (~1.5K), Quality (native 2K). All use Qwen's 8-step Turbo schedule. |
| **VAE tiling** | Auto-enabled >1.5 MP. Shaped tiles on 16 GB+ (fewer, larger), square 768px on 12 GB/Mac. |
| **Testing** | `cargo test -p qls-core` (pure functions), `npm test` (UI logic), `cd mcp && npm test` (MCP protocol) |

---

## 🚀 Development Commands

```bash
# Windows
npm install
cargo test -p qls-core
npm test
cd mcp && npm install && npm test
npx tauri dev

# Mac (Apple Silicon, macOS 26+)
bash scripts/dev/mac-dev.sh --check
bash scripts/dev/mac-dev.sh
```

---

## 🧠 Mental Models to Keep

### Planner (`planner.rs`)
- **Pure functions** — fully testable. Input: image sizes, mask, VRAM. Output: Plan.
- Decides: mode (generate/edit/inpaint/outpaint/upscale), working resolution, steps, CFG, custom sigmas, VAE tiling.
- Token budget = VRAM-based. Working canvas aligned to 64px (model requirement).

### Pipeline (`pipeline.rs`)
- **Executes Plan at pixel level**.
- Inpaint: creates marked reference image (`<image2>` with colored region) so Qwen "sees" mask.
- Outpaint: expands canvas, generates mask for new areas.
- Upscale: ESRGAN (MoSR/Superscale) with tiling, then Lanczos to exact target.

### Engine (`engine.rs`)
- **Single worker** — one job at a time.
- OOM retry: smaller VAE tile → smaller working res → CPU offload.
- Leases: UI/MCP/scripts send heartbeats. PID-tracked clients hold lease while process alive.
- Idle exit: no leases + no jobs → 60s grace (3s if UI closed) → stop sd-server → exit.

### Store (`store.rs`)
- SQLite (rusqlite). Tables: `generations`, `inputs`, `pipelines`, `references`.
- Private mode = separate in-memory store (`private_store`), wiped by `clear_private()`.

---

## 📋 Active Implementation Plans

| Plan | File | Status |
|------|------|--------|
| Central Zoom/Pan System | `docs/zoom-roadmap.md` | **Completed** — Phases 1-5 fully implemented, tested & verified |
| Vulkan/AMD verification | — | Beta — needs real hardware reports |
| Background removal | — | Roadmap |
| Batch edits | — | Roadmap |
| Editor plugins (Krita/GIMP/PS) | — | Roadmap |
| Linux | — | Roadmap |

---

## 🔗 Essential References

| Doc | Purpose |
|-----|---------|
| `README.md` | User-facing: install, features, FAQ, privacy, license |
| `docs/engineering-notes.md` | **Deep dive**: module map, measured backend facts, Turbo schedule, VRAM math |
| `docs/prompting.md` | Prompt patterns that work (visual guide at kokon.app/prompt-guide) |
| `docs/zoom-roadmap.md` | Central zoom/pan implementation roadmap |
| `CONTRIBUTING.md` | PR process, tests, code style, good first issues |
| `SECURITY.md` | Security reporting (private) |

---

## ⚠️ Common Pitfalls

| Pitfall | Avoidance |
|---------|-----------|
| **Changing planner defaults without measuring** | Document hardware, VRAM, step time in PR/comment |
| **Adding fields to Rust types without updating TS mirror** | Keep `src/lib/types.ts` in sync with `planner.rs` / `engine.rs` |
| **Putting logic in UI components** | Move to `qls-core` or `src/lib/logic.ts` (testable) |
| **Touching `sdcpp.rs` without understanding sd-server schema** | Only this file knows wire format; schemas verified at commit `3f8527a` |
| **Forgetting private mode cleanup** | `Engine.private_store` + `clear_private()` on window close/service exit |
| **Assuming multi-GPU works** | **It doesn't** — single `--backend cuda0` only; no tensor/pipeline parallelism in ggml |

---

## 📝 Session Start Checklist

- [ ] Read this file (`AGENTS.md`)
- [ ] Check `docs/zoom-roadmap.md` for active implementation phase
- [ ] Run `cargo test -p qls-core` to verify baseline
- [ ] Check GitHub issues for assigned work
- [ ] Review `engineering-notes.md` if touching planner/pipeline/engine

---

## 🤝 Contribution Rules (Abbreviated)

1. **Bugs** → Issue with template (Settings → Diagnostics → Copy)
2. **Features** → Issue/Discussion *first*
3. **Tests required**: `cargo test -p qls-core` + `npm test` + `cd mcp && npm test`
4. **Code style**: `cargo fmt` (Rust), strict TS + hooks (TypeScript)
5. **Comments explain *why*** (especially measured defaults)
6. **License**: AGPL-3.0 + CLA (bot asks on first PR)

---

## 🆘 When Stuck

| Problem | Where to Look |
|---------|---------------|
| "How does X work?" | `docs/engineering-notes.md` → module map |
| "Planner chooses wrong size" | `planner.rs::plan()` + `geometry.rs::plan_working_canvas()` |
| "OOM on 16 GB" | `engine.rs` OOM retry logic + `planner.rs` auto-tiling |
| "Compare mode broken" | `Compare.tsx` + `Viewer.tsx` (ZoomImage) |
| "MCP tool not working" | `mcp/src/tools.ts` + `mcp/src/service.ts` |
| "First-run setup fails" | `installer.rs` + `diagnostics.rs` (GPU detection) |

---

**End of onboarding.** Update this file when architecture changes.