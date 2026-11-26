// Before / after views for results made from another image (edit, inpaint, expand, upscale).

import { ChevronDown, SquareSplitHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { urls } from "../lib/api";
import { diffPixels, type CompareBase, type CompareMode } from "../lib/logic";
import { haptic } from "../lib/haptics";
import { t } from "../lib/i18n";
import { inBrowser, isNarrow, useNarrow } from "../lib/platform";
import { setState, stageImage, useStore } from "../lib/store";
import type { GenerationRecord } from "../lib/types";
import { DevelopImg } from "./Develop";
import { Option, Popover, Seg, useFit } from "./ui";
import { FullscreenButton } from "./Viewer";
import { ZoomPan } from "./ZoomPan";

const modes = (): { value: CompareMode; label: string }[] => [
  { value: "off", label: t("compare.modeResult") },
  { value: "slider", label: t("compare.modeSlider") },
  { value: "flicker", label: t("compare.modeFlicker") },
  { value: "diff", label: t("compare.modeChanges") },
];
const speeds = (): { value: string; label: string }[] => [
  { value: "250", label: t("compare.speedFast") },
  { value: "500", label: t("compare.speedNormal") },
  { value: "1000", label: t("compare.speedSlow") },
];
/** Long side of the difference map; downscaling also averages out the VAE re-encode noise. */
const DIFF_SIDE = 1024;

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** The result with the selected comparison view, sized to fit the stage (or the screen). */
export function CompareFrame({ g, base, fullscreen = false, maskSrc, onFullscreen }: { g: GenerationRecord; base: CompareBase; fullscreen?: boolean; maskSrc?: string; onFullscreen?: () => void }) {
  const mode = useStore((s) => s.compare);
  const flickerMs = useStore((s) => s.flickerMs);
  const { ref, box } = useFit(g.width / g.height);
  const phone = useNarrow();
  const [split, setSplit] = useState(0.5);
  const [holding, setHolding] = useState(false);
  const [phase, setPhase] = useState<"before" | "after">("after");
  const dragging = useRef(false);
  // A finger shows the original only once it rests for a moment: a swipe to the next version
  // (phone) must not flash it.
  const hold = useRef<{ timer: number; x: number; y: number } | null>(null);
  const endHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };
  const boxRef = useRef<HTMLDivElement>(null);
  const contentSize = useMemo(() => ({ width: g.width, height: g.height }), [g.width, g.height]);
  // In a browser both images are previews while they are as sharp as the full ones: on the
  // stage when the box fits (stageImage), in full screen until the zoom passes the preview
  // (`wantsFull`, then the full images stay). The original loads the first time a view shows
  // it, then stays; Changes always compares the previews (its map is 1024 px). The desktop app
  // loads both at full size at once.
  const beforeWanted = useRef(!inBrowser);
  if (mode !== "off" || holding) beforeWanted.current = true;
  const images = (wantsFull: boolean) => {
    if (!inBrowser) return { after: urls.gen(g.id), before: urls.input(base.inputId), diff: [urls.gen(g.id), urls.input(base.inputId)] };
    const pick = (source: string) => (fullscreen ? (wantsFull ? urls.source(source) : urls.sourcePreview(source)) : stageImage(source, box.w, box.h));
    return { after: pick(`gen:${g.id}`), before: beforeWanted.current ? pick(`input:${base.inputId}`) : undefined, diff: [urls.genPreview(g.id), urls.inputPreview(base.inputId)] };
  };

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

  const setFromPointer = (clientX: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (r && r.width > 0) setSplit(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };

  const showBefore = holding || (mode === "flicker" && phase === "before");
  const label = holding || mode === "flicker" ? (showBefore ? t("compare.before") : t("compare.after")) : null;
  const pct = (v: number) => `${v * 100}%`;
  const { x, y, w, h } = base.rect;

  // In full screen the box keeps the image's own size inside ZoomPan, which scales it; `k`
  // undoes that scale for the labels and the slider handle so they stay at screen size.
  // While zoomed in a drag pans the image; the handle still moves the split.
  // Drawn flat (a browser, see ZoomPan) the box is laid out at its drawn size: nothing to undo.
  const frame = (scale: number, zoomed: boolean, flat = false, wantsFull = false) => {
    const k = flat ? 1 : 1 / scale;
    const { after, before, diff } = images(wantsFull);
    const tag = (side: "left" | "right") => ({ transform: `scale(${k})`, transformOrigin: `top ${side}` });
    return (
      <div
        ref={boxRef}
        className={`compare-box ${mode === "slider" ? "slider" : ""} ${zoomed ? "zoomed" : ""}`}
        style={fullscreen ? (flat ? { width: "100%", height: "100%" } : { width: g.width, height: g.height }) : { width: box.w, height: box.h }}
        onPointerDown={(e) => {
          if (e.button !== 0 || zoomed) return;
          e.stopPropagation();
          e.currentTarget.setPointerCapture(e.pointerId);
          if (mode === "slider") {
            dragging.current = true;
            setFromPointer(e.clientX);
          } else if (mode === "off" && e.pointerType === "touch") {
            endHold();
            hold.current = { timer: window.setTimeout(() => setHolding(true), 280), x: e.clientX, y: e.clientY };
          } else if (mode === "off") setHolding(true);
        }}
        onPointerMove={(e) => {
          if (hold.current && Math.hypot(e.clientX - hold.current.x, e.clientY - hold.current.y) > 10) endHold();
          if (!dragging.current) return;
          e.stopPropagation();
          setFromPointer(e.clientX);
        }}
        onPointerUp={() => {
          dragging.current = false;
          endHold();
          if (mode === "off") setHolding(false);
        }}
        onPointerCancel={() => {
          dragging.current = false;
          endHold();
          setHolding(false);
        }}
        onDoubleClick={() => setState({ overlay: null })}
        title={mode === "off" && !zoomed ? t("compare.holdTooltip") : undefined}
      >
        <DevelopImg className="compare-img" src={after} placeholder={urls.genThumb(g.id)} alt={g.prompt} />
        {mode === "diff" && !holding && before && <DiffCanvas after={diff[0]} before={diff[1]} rect={base.rect} tagStyle={tag("left")} />}
        {/* The area painted for the next edit, on the result (the original covers it when shown). */}
        {maskSrc && <img className="stage-mask" src={maskSrc} alt="" draggable={false} />}
        {/* The original stays mounted (hidden) so switching is instant. */}
        <div
          className="compare-before"
          style={{
            visibility: showBefore || mode === "slider" ? "visible" : "hidden",
            clipPath: mode === "slider" && !holding ? `inset(0 ${pct(1 - split)} 0 0)` : undefined,
          }}
        >
          <img src={before} alt={t("compare.original")} draggable={false} style={{ left: pct(x), top: pct(y), width: pct(w), height: pct(h) }} />
        </div>
        {mode === "slider" && !holding && (
          <>
            <div
              className="compare-handle"
              style={{ left: pct(split), width: 2 * k, marginLeft: -k }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                boxRef.current?.setPointerCapture(e.pointerId);
                dragging.current = true;
              }}
            >
              <span style={{ transform: `scale(${k})` }} />
            </div>
            <span className="compare-tag left" style={tag("left")}>{t("compare.before")}</span>
            <span className="compare-tag right" style={tag("right")}>{t("compare.after")}</span>
          </>
        )}
        {label && <span className="compare-tag left" style={tag("left")}>{label}</span>}
        {!fullscreen && phone && <PhoneCompare />}
        {!fullscreen && !phone && (
          <div className="compare-overlay" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <CompareBar />
          </div>
        )}
        {!fullscreen && (
          <FullscreenButton hint={t("compare.holdBHint")} onOpen={onFullscreen} content={<CompareFullscreen g={g} base={base} />} />
        )}
      </div>
    );
  };

  if (fullscreen)
    return (
      <div className="viewer-frame">
        <ZoomPan contentSize={contentSize} resetKey={g.id} enableToggleZoom={false} flat={inBrowser} minimapSrc={inBrowser ? urls.genThumb(g.id) : urls.gen(g.id)}>
          {({ transform, isZoomed, flat, wantsFull }) => frame(transform.scale, isZoomed, flat, wantsFull)}
        </ZoomPan>
      </div>
    );
  return (
    <div className="stage-frame" ref={ref}>
      {frame(1, false)}
    </div>
  );
}

/** What full screen shows for a result with an original: the comparison and its controls. */
export function CompareFullscreen({ g, base }: { g: GenerationRecord; base: CompareBase }) {
  return (
    <>
      <CompareFrame g={g} base={base} fullscreen />
      <div className="viewer-compare-bar">
        <CompareBar />
      </div>
    </>
  );
}

/** Highlights what changed: dimmed result, changed pixels in red. */
function DiffCanvas({ after, before, rect, tagStyle }: { after: string; before: string; rect: CompareBase["rect"]; tagStyle?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [share, setShare] = useState<number | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setShare(null);
    setError(false);
    const load = (src: string) =>
      new Promise<HTMLImageElement>((ok, fail) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => ok(im);
        im.onerror = fail;
        // A separate URL: the displayed <img> loads without CORS, and reusing that cached
        // response for a CORS request would fail.
        im.src = `${src}${src.includes("?") ? "&" : "?"}cors=1`;
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
        const ctx = cv.getContext("2d", { willReadFrequently: true })!;
        ctx.imageSmoothingQuality = "high";
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
      <span className="compare-tag left" style={tagStyle}>
        {error ? t("compare.compareFailed") : share === null ? t("compare.comparing") : share < 0.001 ? t("compare.noChange") : t("compare.changedShare", { pct: share < 0.01 ? "<1" : Math.round(share * 100) })}
      </span>
    </>
  );
}

function modeSub(m: CompareMode): string {
  switch (m) {
    case "off":
      return t("compare.subResult");
    case "slider":
      return t("compare.subSlider");
    case "flicker":
      return t("compare.subFlicker");
    case "diff":
      return t("compare.subChanges");
  }
}

/** A phone: the views behind one small button on the picture (four side by side don't fit a
 * narrow picture); its sheet offers them, and Flicker's speeds. */
function PhoneCompare() {
  const mode = useStore((s) => s.compare);
  const flickerMs = useStore((s) => s.flickerMs);
  const MODES = modes();
  return (
    <div className="compare-pill-wrap" onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      <Popover
        trigger={(open, toggle) => (
          <button className={`compare-pill ${open ? "on" : ""}`} onClick={toggle} title={t("compare.withOriginal")}>
            <SquareSplitHorizontal size={15} />
            {MODES.find((m) => m.value === mode)?.label}
            <ChevronDown size={13} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="label">{t("compare.withOriginal")}</div>
            {MODES.map((m) => (
              <Option
                key={m.value}
                selected={mode === m.value}
                label={m.label}
                sub={modeSub(m.value)}
                onClick={() => {
                  haptic();
                  setState({ compare: m.value });
                  if (m.value !== "flicker") close();
                }}
              />
            ))}
            {mode === "flicker" && (
              <div className="compare-speed">
                <span className="muted">{t("compare.speed")}</span>
                <Seg value={String(flickerMs)} options={speeds()} onChange={(v) => setState({ flickerMs: Number(v) })} />
              </div>
            )}
          </>
        )}
      </Popover>
    </div>
  );
}

/** View switch shown under a result that has an original to compare with. */
export function CompareBar() {
  const mode = useStore((s) => s.compare);
  const flickerMs = useStore((s) => s.flickerMs);
  return (
    <div className="compare-bar">
      <Seg
        value={mode}
        options={modes()}
        onChange={(v) => {
          if (isNarrow()) haptic();
          setState({ compare: v });
        }}
      />
      {mode === "flicker" && <Seg value={String(flickerMs)} options={speeds()} onChange={(v) => setState({ flickerMs: Number(v) })} />}
    </div>
  );
}
