// Before / after views for results made from another image (edit, inpaint, expand, upscale).

import { ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { urls } from "../lib/api";
import { diffPixels, type CompareBase, type CompareMode } from "../lib/logic";
import { setState, useStore } from "../lib/store";
import type { GenerationRecord } from "../lib/types";
import { calculateSplitFraction } from "../lib/zoomMath";
import { Seg } from "./ui";
import { FullscreenButton } from "./Viewer";
import { ZoomPan } from "./ZoomPan";

const MODES: { value: CompareMode; label: string }[] = [
  { value: "off", label: "Result" },
  { value: "slider", label: "Slider" },
  { value: "flicker", label: "Flicker" },
  { value: "diff", label: "Changes" },
];
const SPEEDS: { value: string; label: string }[] = [
  { value: "250", label: "Fast" },
  { value: "500", label: "Normal" },
  { value: "1000", label: "Slow" },
];
/** Long side of the difference map; downscaling also averages out the VAE re-encode noise. */
const DIFF_SIDE = 1024;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export interface CompareFrameProps {
  g: GenerationRecord;
  base: CompareBase;
  fullscreen?: boolean;
  onFullscreen?: () => void;
  showControls?: boolean;
  onToggleControls?: () => void;
  beforeSrc?: string;
  afterSrc?: string;
  onChange?: (transform: import("../lib/zoomMath").ZoomTransform) => void;
}

/** The result with the selected comparison view, wrapped in ZoomPan for lockstep inspection. */
export function CompareFrame({
  g,
  base,
  fullscreen = false,
  onFullscreen,
  showControls = true,
  onToggleControls,
  beforeSrc,
  afterSrc,
  onChange,
}: CompareFrameProps) {
  const mode = useStore((s) => s.compare);
  const flickerMs = useStore((s) => s.flickerMs);
  const [split, setSplit] = useState(0.5);
  const [holding, setHolding] = useState(false);
  const [phase, setPhase] = useState<"before" | "after">("after");
  const boxRef = useRef<HTMLDivElement>(null);
  const draggingSlider = useRef(false);
  const after = afterSrc ?? urls.gen(g.id);
  const before = beforeSrc ?? urls.input(base.inputId);
  const contentSize = useMemo(() => ({ width: g.width, height: g.height }), [g.width, g.height]);

  useEffect(() => {
    draggingSlider.current = false;
    setHolding(false);
  }, [mode, g.id]);

  useEffect(() => {
    const handleUp = () => {
      draggingSlider.current = false;
    };
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, []);

  useEffect(() => {
    if (mode !== "flicker") return;
    setPhase("before");
    const t = window.setInterval(() => setPhase((p) => (p === "before" ? "after" : "before")), flickerMs);
    return () => window.clearInterval(t);
  }, [mode, flickerMs, g.id]);

  // Hold B to peek at the original from any view.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) setHolding(true);
    };
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === "b" && setHolding(false);
    const blur = () => setHolding(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const updateFromPointer = useCallback((clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const r = box.getBoundingClientRect();
    setSplit(calculateSplitFraction(clientX, r));
  }, []);

  const showBefore = holding || (mode === "flicker" && phase === "before");
  const label = holding || mode === "flicker" ? (showBefore ? "Before" : "After") : null;
  const pct = (v: number) => `${v * 100}%`;
  const { x, y, w, h } = base.rect;

  return (
    <div className={fullscreen ? "viewer-frame" : "stage-frame"}>
      <ZoomPan
        contentSize={contentSize}
        resetKey={g.id}
        showControls={showControls}
        enableToggleZoom={false}
        onChange={onChange}
        className={fullscreen ? "compare-fullscreen" : "compare-stage"}
        overlay={
          !fullscreen && (
            <>
              <div
                className="stage-overlay-btns"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {onToggleControls && (
                  <button
                    className={`stage-overlay-btn ${showControls ? "active" : ""}`}
                    title={showControls ? "Hide zoom controls" : "Show zoom controls"}
                    aria-label="Toggle zoom controls"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleControls();
                    }}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <ZoomIn size={15} />
                  </button>
                )}
                <FullscreenButton hint="Hold B for the original" onOpen={onFullscreen} content={<CompareFullscreen g={g} base={base} />} />
              </div>
              <div
                className="compare-overlay"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <CompareBar />
              </div>
            </>
          )
        }
      >
        {({ transform, isZoomed }) => {
          const counterScale = Math.min(3, Math.max(0.25, 1 / transform.scale));
          const lineWidth = Math.min(10, Math.max(1, 2 / transform.scale));
          const lineMargin = -lineWidth / 2;

          return (
            <div
              ref={boxRef}
              className={`compare-box ${mode === "slider" ? "slider" : ""} ${isZoomed ? "zoomed" : ""}`}
              style={{ width: g.width, height: g.height }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                if (mode === "slider") {
                  if (!isZoomed) {
                    e.stopPropagation();
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {}
                    draggingSlider.current = true;
                    updateFromPointer(e.clientX);
                  }
                } else if (mode === "off") {
                  if (!isZoomed) {
                    e.stopPropagation();
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {}
                    setHolding(true);
                  }
                }
              }}
              onPointerMove={(e) => {
                if (draggingSlider.current) {
                  e.stopPropagation();
                  updateFromPointer(e.clientX);
                }
              }}
              onPointerUp={(e) => {
                if (draggingSlider.current) {
                  e.stopPropagation();
                  draggingSlider.current = false;
                  try {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  } catch {}
                }
                if (mode === "off") {
                  e.stopPropagation();
                  setHolding(false);
                  try {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  } catch {}
                }
              }}
              onPointerCancel={(e) => {
                if (draggingSlider.current) {
                  draggingSlider.current = false;
                  try {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  } catch {}
                }
                if (mode === "off") {
                  setHolding(false);
                  try {
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    }
                  } catch {}
                }
              }}
              onDoubleClick={() => setState({ overlay: null })}
              title={mode === "off" ? "Press and hold (or hold B) to see the original" : undefined}
            >
              <img className="compare-img" src={after} alt={g.prompt} draggable={false} />
              {mode === "diff" && !holding && <DiffCanvas after={after} before={before} rect={base.rect} transformScale={transform.scale} />}
              {/* The original stays mounted (hidden) so switching is instant. */}
              <div
                className="compare-before"
                style={{
                  visibility: showBefore || mode === "slider" ? "visible" : "hidden",
                  clipPath: mode === "slider" && !holding ? `inset(0 ${pct(1 - split)} 0 0)` : undefined,
                }}
              >
                <img src={before} alt="Original" draggable={false} style={{ left: pct(x), top: pct(y), width: pct(w), height: pct(h) }} />
              </div>
              {mode === "slider" && !holding && (
                <>
                  <div
                    className="compare-handle"
                    style={{
                      left: pct(split),
                      width: `${lineWidth}px`,
                      marginLeft: `${lineMargin}px`,
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {}
                      draggingSlider.current = true;
                      updateFromPointer(e.clientX);
                    }}
                    onPointerMove={(e) => {
                      if (draggingSlider.current) {
                        e.stopPropagation();
                        updateFromPointer(e.clientX);
                      }
                    }}
                    onPointerUp={(e) => {
                      if (draggingSlider.current) {
                        e.stopPropagation();
                        draggingSlider.current = false;
                        try {
                          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                          }
                        } catch {}
                      }
                    }}
                    onPointerCancel={(e) => {
                      draggingSlider.current = false;
                      try {
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                      } catch {}
                    }}
                  >
                    <span style={{ transform: `scale(${counterScale})` }} />
                  </div>
                  <span className="compare-tag left" style={{ transform: `scale(${counterScale})`, transformOrigin: "top left" }}>
                    Before
                  </span>
                  <span className="compare-tag right" style={{ transform: `scale(${counterScale})`, transformOrigin: "top right" }}>
                    After
                  </span>
                </>
              )}
              {label && (
                <span className="compare-tag left" style={{ transform: `scale(${counterScale})`, transformOrigin: "top left" }}>
                  {label}
                </span>
              )}
            </div>
          );
        }}
      </ZoomPan>
    </div>
  );
}

/** What full screen shows for a result with an original: the comparison and its controls. */
export function CompareFullscreen({ g, base }: { g: GenerationRecord; base: CompareBase }) {
  return (
    <>
      <CompareFrame g={g} base={base} fullscreen showControls={true} />
      <div className="viewer-compare-bar">
        <CompareBar />
      </div>
    </>
  );
}

/** Highlights what changed: dimmed result, changed pixels in red. */
function DiffCanvas({
  after,
  before,
  rect,
  transformScale = 1,
}: {
  after: string;
  before: string;
  rect: CompareBase["rect"];
  transformScale?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [share, setShare] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const counterScale = Math.min(3, Math.max(0.25, 1 / transformScale));

  useEffect(() => {
    let alive = true;
    setShare(null);
    setError(false);
    const load = (src: string) =>
      new Promise<HTMLImageElement>((ok, fail) => {
        const im = new Image();
        const isCrossOrigin = src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//");
        if (isCrossOrigin) {
          im.crossOrigin = "anonymous";
          im.src = src.includes("?") ? `${src}&cors=1` : `${src}?cors=1`;
        } else {
          im.src = src;
        }
        im.onload = () => ok(im);
        im.onerror = () => {
          if (im.crossOrigin) {
            const retry = new Image();
            retry.onload = () => ok(retry);
            retry.onerror = fail;
            retry.src = src;
          } else {
            fail(new Error("Failed to load image: " + src));
          }
        };
      });
    Promise.all([load(after), load(before)])
      .then(([a, b]) => {
        const cv = ref.current;
        if (!alive || !cv) return;
        const k = Math.min(1, DIFF_SIDE / Math.max(a.naturalWidth, a.naturalHeight));
        const W = Math.max(1, Math.round(a.naturalWidth * k));
        const H = Math.max(1, Math.round(a.naturalHeight * k));
        cv.width = W;
        cv.height = H;
        const ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          if (alive) setError(true);
          return;
        }
        ctx.drawImage(a, 0, 0, W, H);
        const A = ctx.getImageData(0, 0, W, H);
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(b, rect.x * W, rect.y * H, rect.w * W, rect.h * H);
        const B = ctx.getImageData(0, 0, W, H);
        const out = ctx.createImageData(W, H);
        const s = diffPixels(A.data, B.data, out.data);
        ctx.putImageData(out, 0, 0);
        setShare(s);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [after, before, rect.x, rect.y, rect.w, rect.h]);

  return (
    <>
      <canvas ref={ref} className="compare-diff" />
      <span className="compare-tag left" style={{ transform: `scale(${counterScale})`, transformOrigin: "top left" }}>
        {error ? "Could not compare the images" : share === null ? "Comparing…" : share < 0.001 ? "No visible change" : `≈${share < 0.01 ? "<1" : Math.round(share * 100)}% of the image changed`}
      </span>
    </>
  );
}

/** View switch shown under a result that has an original to compare with. */
export function CompareBar() {
  const mode = useStore((s) => s.compare);
  const flickerMs = useStore((s) => s.flickerMs);
  return (
    <div className="compare-bar">
      <Seg value={mode} options={MODES} onChange={(v) => setState({ compare: v })} />
      {mode === "flicker" && <Seg value={String(flickerMs)} options={SPEEDS} onChange={(v) => setState({ flickerMs: Number(v) })} />}
    </div>
  );
}
