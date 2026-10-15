# Central Zoom and Pan System — Implementation Roadmap

**Last updated:** 2026-10-15  
**Status:** Completed (Phases 1-5 implemented and verified)

---

## 🎯 Objective

Provide a unified, high-performance, gesture-friendly zoom and pan system for all visual surfaces in Kokon:
- **Full-screen image viewer** (`Viewer.tsx`, `Gallery.tsx`)
- **Main stage view** (`Stage.tsx`)
- **Before / After comparison frame** (`Compare.tsx`)
- **Inpainting mask editor** (`InpaintEditor.tsx`)

---

## 🧠 Design Principles

1. **Hardware-Accelerated Transforms**:
   - Use CSS 2D transforms (`transform: translate3d(x, y, 0) scale(s)`) applied to a container wrapper, rather than resizing raster images or manipulating native DOM scroll positions.
   - Smooth 60fps wheel and drag interactions with zero layout thrashing.

2. **Focal-Point Zooming**:
   - Wheel and pinch gestures zoom into and out of the exact pixel beneath the cursor/pointer focal point.

3. **Smart Clamping**:
   - When zoomed beyond container boundaries, content is clamped so it never gets lost outside the viewport.
   - When content is smaller than or fits within the container, it remains elegantly centered.

4. **Multi-Input Support**:
   - Mouse wheel zoom (with Ctrl+wheel / trackpad pinch detection).
   - Click-to-zoom: click to toggle between fit-to-screen and 100% (1:1 actual pixels) at the clicked point.
   - Click-and-drag panning when zoomed.
   - Keyboard shortcuts (`+`/`-`, `0` for fit, `1` for 100%).
   - Floating HUD overlay controls for touch/mouse users with auto-fade on inactivity.

5. **Reusable & Modular**:
   - Pure math utilities (`src/lib/zoomMath.ts`) isolated and covered with unit tests.
   - Standalone React hook (`src/lib/useZoomPan.ts`) managing gesture state, transforms, and interaction handlers.
   - Versatile wrapper component (`src/components/ZoomPan.tsx`) that can wrap an image, a canvas, or complex interactive comparison widgets.

---

## 🗺️ Phased Roadmap

### ✅ Phase 1: Core Hook, Wrapper & Fullscreen Viewer Integration (Active)
- [x] **Pure Math Utilities** (`src/lib/zoomMath.ts`):
  - Zoom-to-focal-point calculations.
  - Scale clamping ($s_{\min}$ to $s_{\max}$, standard zoom step multipliers).
  - Bounds clamping for viewport and content dimensions.
  - Comprehensive unit test suite (`src/lib/zoomMath.test.ts`).
- [x] **Core Hook** (`src/lib/useZoomPan.ts`):
  - Manages transform state: `x`, `y`, `scale`.
  - Wheel event listener with passive prevention and focal point tracking.
  - Pointer drag handling for pan gestures.
  - Double-click / click toggle between fit and 100%.
  - Actions: `zoomIn()`, `zoomOut()`, `zoomFit()`, `zoom100()`, `reset()`.
- [x] **Wrapper Component** (`src/components/ZoomPan.tsx`):
  - Wraps arbitrary children.
  - Optional floating HUD toolbar with zoom percentage pill, zoom in/out, fit, and 1:1 buttons.
  - Keyboard shortcuts (`+`, `-`, `0`, `1`).
  - Drop-in backward compatibility with `ZoomImage` in `Viewer.tsx`.
- [x] **Styles** (`src/styles.css`):
  - Clean styling for `.zoom-pan-viewport`, `.zoom-pan-content`, and `.zoom-controls`.

### ✅ Phase 2: Stage Inline View Integration (Completed)
- [x] Enable zoom and pan directly in `PlainFrame` on the Stage without requiring full-screen mode.
- [x] Reset zoom/pan when switching versions or selecting another timeline item.
- [x] Stage-level zoom controls toggle button and floating HUD controls.
- [x] Keyboard shortcut guards for inputs, modal overlays, and full-screen viewers.
- [x] Comprehensive unit and integration test suite (`src/lib/useZoomPan.test.tsx`).

### ✅ Phase 3: Compare Mode Integration (Completed)
- [x] Wrap `CompareFrame` with `ZoomPan` so both Before and After layers zoom in exact pixel lockstep.
- [x] Retain interactive slider bar position and difference map calculation during zoomed inspection.
- [x] Interactive split slider dragging tracks correctly in content space regardless of zoom scale or pan offset (`calculateSplitFraction` and `screenToSplitFraction`).
- [x] Preserve hold 'B' to peek at the original, automated flicker mode, and DiffCanvas alignment under any zoom level.
- [x] Stage-level zoom controls toggle in the overlay while preserving FullscreenButton and CompareBar controls.
- [x] Fullscreen comparison viewer (`CompareFullscreen`) integration with zoom/pan and HUD controls.
- [x] Comprehensive unit and integration test coverage (`src/lib/zoomMath.test.ts` & `src/lib/useZoomPan.test.tsx`).

### ✅ Phase 4: Inpainting Mask Editor Integration (Completed)
- [x] Wrap `InpaintEditor` stage with `ZoomPan` to enable precision painting on fine details.
- [x] Map screen brush coordinates to mask canvas coordinates via inverse zoom transform.
- [x] Spacebar+drag panning mode, middle-mouse panning, and Hand tool while brush tool is active.
- [x] Dynamic screen-space brush cursor preview scaling inversely with zoom (`brush / transform.scale`).
- [x] Comprehensive test coverage and interactive POC integration.

### ✅ Phase 5: Advanced Gestures & Polishing (Completed)
- [x] Multi-touch pinch-to-zoom gesture handling for touch screens with capture-phase tracking (`pinchTransform`).
- [x] Momentum / inertial panning with decay and bounds-clamping (`releaseVelocity`, `inertiaStep`, rAF loop, respects `prefers-reduced-motion`).
- [x] MiniMap navigator component (`MiniMap` in `ZoomPan.tsx`, `visibleContentRect`, `centerOnContentFraction`, `minimapSize`, toggle via HUD button and `m` key shortcut).
- [x] Middle-mouse panning and pointer gesture cancellation handlers.
- [x] Comprehensive test coverage and interactive POC verification (`zoomMath.test.ts`, `useZoomPan.test.tsx`, `poc.tsx`).
