import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZoomPan, type ZoomPanHandle } from "./components/ZoomPan";
import { CompareFrame, CompareFullscreen } from "./components/Compare";
import { InpaintEditor } from "./components/InpaintEditor";
import type { GenerationRecord } from "./lib/types";
import type { CompareBase, CompareMode } from "./lib/logic";
import type { ZoomTransform } from "./lib/zoomMath";
import { setState, useStore } from "./lib/store";
import "./styles.css";

const SAMPLES = [
  {
    name: "Cabin (Winter / Snow)",
    before: "/examples/cabin.jpg",
    after: "/examples/cabin-winter.jpg",
    prompt: "A cozy wooden cabin during a serene winter snowfall",
    width: 1600,
    height: 893,
  },
  {
    name: "Bakery (Custom Sign)",
    before: "/examples/bakery.jpg",
    after: "/examples/bakery-text.jpg",
    prompt: "An artisan bakery storefront with gold leaf typography",
    width: 1600,
    height: 1189,
  },
  {
    name: "Potter (Watercolor)",
    before: "/examples/potter.jpg",
    after: "/examples/potter-watercolor.jpg",
    prompt: "A pottery artisan working at the wheel, vibrant watercolor style",
    width: 1189,
    height: 1600,
  },
  {
    name: "Street (Subject Removal)",
    before: "/examples/street.jpg",
    after: "/examples/street-removed.jpg",
    prompt: "A cobblestone city street with crowds cleanly removed",
    width: 1600,
    height: 893,
  },
];

const COMPARE_MODES: { value: CompareMode; label: string; icon: string }[] = [
  { value: "slider", label: "Slider", icon: "↔️" },
  { value: "flicker", label: "Flicker", icon: "⚡" },
  { value: "diff", label: "Changes", icon: "🔍" },
  { value: "off", label: "Result (Hold B)", icon: "👁️" },
];

function PocApp() {
  const urlParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const initialTab = (urlParams?.get("tab") as "compare" | "single" | "inpaint") || "compare";
  const [tab, setTab] = useState<"compare" | "single" | "inpaint">(initialTab);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [transform, setTransform] = useState<ZoomTransform>({ x: 0, y: 0, scale: 1 });
  const [showControls, setShowControls] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  const zoomRef = useRef<ZoomPanHandle>(null);

  useEffect(() => {
    if (urlParams?.get("zoomed") === "1") {
      const t = setTimeout(() => {
        zoomRef.current?.zoom100();
      }, 400);
      return () => clearTimeout(t);
    }
  }, [urlParams]);

  const compareMode = useStore((s) => s.compare);
  const sample = SAMPLES[sampleIndex];

  // Default to Slider mode on first mount so the user immediately sees the comparison
  useEffect(() => {
    setState({ compare: "slider" });
  }, []);

  // Synthesize a GenerationRecord with exact natural dimensions and dynamic ID
  const mockGen = useMemo<GenerationRecord>(
    () => ({
      id: sample.after,
      prompt: sample.prompt,
      negative_prompt: "",
      model: "Qwen-Image-2.1-Turbo",
      sampler: "euler",
      scheduler: "turbo",
      steps: 8,
      cfg: 1.0,
      strength: null,
      seed: 42,
      width: sample.width,
      height: sample.height,
      working_width: sample.width,
      working_height: sample.height,
      file_path: sample.after,
      mode: "edit",
      favorite: false,
      notes: [],
      duration_ms: 1250,
      created_at: new Date().toISOString(),
      quality: "fast",
      resolution: "auto",
      mask_input_id: null,
      outpaint: null,
      extra_paths: [],
      parent_id: null,
      request: null,
      pipeline: null,
      references: [
        {
          index: 0,
          input_id: sample.before,
          original_path: sample.before,
          width: sample.width,
          height: sample.height,
        },
      ],
    }),
    [sample],
  );

  const mockBase = useMemo<CompareBase>(
    () => ({
      inputId: sample.before,
      rect: { x: 0, y: 0, w: 1, h: 1 },
    }),
    [sample],
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "Inter Variable, sans-serif" }}>
      {/* Top Header Bar */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: "1px solid var(--border)", background: "var(--surface)", zIndex: 30, gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#10b981", display: "inline-block" }} />
            Kokon Zoom/Pan POC
          </span>
          <span style={{ fontSize: 12, padding: "3px 8px", borderRadius: 6, background: "var(--surface-2)", color: "var(--text-2)" }}>
            Phase 1, 2, 3 & 4
          </span>
        </div>

        {/* Tab switch */}
        <div style={{ display: "flex", background: "var(--surface-2)", borderRadius: 8, padding: 3, gap: 2 }}>
          <button
            onClick={() => setTab("compare")}
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              fontSize: 13,
              fontWeight: tab === "compare" ? 600 : 400,
              background: tab === "compare" ? "var(--surface)" : "transparent",
              color: tab === "compare" ? "var(--text)" : "var(--text-2)",
              cursor: "pointer",
              boxShadow: tab === "compare" ? "0 1px 3px rgba(0,0,0,0.2)" : "none",
            }}
          >
            ⚖️ Before / After (Phase 3)
          </button>
          <button
            onClick={() => setTab("single")}
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              fontSize: 13,
              fontWeight: tab === "single" ? 600 : 400,
              background: tab === "single" ? "var(--surface)" : "transparent",
              color: tab === "single" ? "var(--text)" : "var(--text-2)",
              cursor: "pointer",
              boxShadow: tab === "single" ? "0 1px 3px rgba(0,0,0,0.2)" : "none",
            }}
          >
            🖼️ Single Image (Phase 1 & 2)
          </button>
          <button
            onClick={() => setTab("inpaint")}
            style={{
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              fontSize: 13,
              fontWeight: tab === "inpaint" ? 600 : 400,
              background: tab === "inpaint" ? "var(--surface)" : "transparent",
              color: tab === "inpaint" ? "var(--text)" : "var(--text-2)",
              cursor: "pointer",
              boxShadow: tab === "inpaint" ? "0 1px 3px rgba(0,0,0,0.2)" : "none",
            }}
          >
            🖌️ Inpainting (Phase 4)
          </button>
        </div>

        {/* Compare Mode selector (when on Compare tab) */}
        {tab === "compare" && (
          <div style={{ display: "flex", background: "var(--surface-2)", borderRadius: 8, padding: 3, gap: 2 }}>
            {COMPARE_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setState({ compare: m.value })}
                style={{
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: 12,
                  fontWeight: compareMode === m.value ? 600 : 400,
                  background: compareMode === m.value ? "var(--invert-bg)" : "transparent",
                  color: compareMode === m.value ? "var(--invert-text)" : "var(--text-2)",
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                }}
              >
                {m.icon} {m.label}
              </button>
            ))}
          </div>
        )}

        {/* Navigator MiniMap toggle */}
        {tab === "single" && (
          <button
            onClick={() => setShowMinimap((v) => !v)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              background: showMinimap ? "var(--text)" : "var(--surface-2)",
              color: showMinimap ? "var(--invert-text)" : "var(--text-2)",
              border: "1px solid var(--border)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            🗺️ MiniMap: {showMinimap ? "ON" : "OFF"}
          </button>
        )}

        {/* Sample Image dropdown */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-2)" }}>Image:</span>
          <select
            value={sampleIndex}
            onChange={(e) => setSampleIndex(Number(e.target.value))}
            style={{ padding: "5px 10px", borderRadius: 6, background: "var(--surface-2)", color: "var(--text)", border: "1px solid var(--border)", fontSize: 13, fontWeight: 500 }}
          >
            {SAMPLES.map((s, idx) => (
              <option key={s.name} value={idx}>
                {s.name} ({s.width}×{s.height})
              </option>
            ))}
          </select>
        </div>
      </header>

      {/* Main Interactive Viewport */}
      <main style={{ flex: 1, position: "relative", overflow: "hidden", minHeight: 0 }}>
        {tab === "compare" ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <CompareFrame
              key={`compare-${sampleIndex}`}
              g={mockGen}
              base={mockBase}
              beforeSrc={sample.before}
              afterSrc={sample.after}
              showControls={showControls}
              onToggleControls={() => setShowControls((v) => !v)}
              onChange={setTransform}
            />
          </div>
        ) : tab === "single" ? (
          <div style={{ position: "absolute", inset: 0 }}>
            <ZoomPan
              key={`single-${sample.after}`}
              src={sample.after}
              alt={sample.prompt}
              resetKey={sample.after}
              contentSize={{ width: sample.width, height: sample.height }}
              showControls={showControls}
              showMinimap={showMinimap}
              zoomRef={zoomRef}
              onChange={setTransform}
            />
          </div>
        ) : (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <InpaintEditor
              key={`inpaint-${sampleIndex}`}
              imageSrc={sample.after}
              imageWidth={sample.width}
              imageHeight={sample.height}
              onClose={() => setTab("compare")}
              onSaveMask={(blob) => {
                alert(`Mask saved (${blob.size} bytes)!`);
                setTab("compare");
              }}
            />
          </div>
        )}
      </main>

      {/* Bottom Info Bar */}
      <footer style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 18px", borderTop: "1px solid var(--border)", background: "var(--surface)", fontSize: 12, color: "var(--text-2)", zIndex: 10 }}>
        <div style={{ display: "flex", gap: 16 }}>
          {tab === "inpaint" ? (
            <>
              <span><strong>Painting:</strong> Left Click</span>
              <span><strong>Pan Viewport:</strong> Hold <code>Space</code> + Drag, or Middle Click</span>
              <span><strong>Brush / Eraser / Hand:</strong> <code>B</code> / <code>E</code> / <code>H</code></span>
              <span><strong>Brush Size:</strong> <code>[</code> / <code>]</code></span>
              <span><strong>Undo / Redo:</strong> <code>Ctrl+Z</code> / <code>Ctrl+Y</code></span>
            </>
          ) : (
            <>
              <span><strong>Wheel / Touch Pinch:</strong> Zoom</span>
              <span><strong>Drag / Fling:</strong> Pan with Momentum</span>
              <span><strong>Click:</strong> Toggle 100% / Fit</span>
              <span><strong>Navigator MiniMap:</strong> <code>M</code></span>
              <span><strong>Shortcuts:</strong> <code>+</code> / <code>-</code> / <code>0</code> (Fit) / <code>1</code> (100%)</span>
              {tab === "compare" && <span><strong>Hold B:</strong> Peek Original</span>}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          {tab !== "inpaint" && <span>Zoom: {Math.round(transform.scale * 100)}% ({transform.scale.toFixed(2)}×)</span>}
          <span>Dimensions: {sample.width}×{sample.height}</span>
        </div>
      </footer>

      {urlParams?.get("fullscreen") === "1" && (
        <div className="viewer" role="dialog" aria-label="Full screen">
          <CompareFullscreen g={mockGen} base={mockBase} />
          <div className="viewer-bar">
            <span className="viewer-hint">Hold B for the original · Esc to exit</span>
          </div>
        </div>
      )}
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<PocApp />);
}
