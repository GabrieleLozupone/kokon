// The app's cocoon and hatching (src/components/Cocoon.tsx) drawn from the frame clock: the same
// drawing (drawCocoon) and hatching step (paintHatch), called once per frame with the card's
// time instead of from requestAnimationFrame. Markup and classes are unchanged.
import { useLayoutEffect, useRef, useState } from "react";
import { clearMask, drawCocoon, FORM_MS, hatchEnd, makeThreads, markLayout, paintHatch, THREADS } from "../../../../src/components/Cocoon";
import { reachedAt, useCard } from "./card";

export { markFresh, reducedMotion, SilkSpin } from "../../../../src/components/Cocoon";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);
const INK = "#f2f2f2"; // --text of the dark theme (app/theme.css)

export function Cocoon({ src, pct, dim }: { src?: string; pct: number; form?: boolean; dim?: boolean }) {
  const c = useCard();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const formAt = reachedAt(c, 92);
  const formMs = formAt === null ? null : (c.t - formAt) * 1000;

  useLayoutEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    if (!el || !cv) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w !== size.w || h !== size.h) setSize({ w, h });
    if (!w || !h) return;
    const dpr = 2;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    // Each thread spun in when the percentage reached its birth.
    const threads = makeThreads(THREADS).map((th) => ({ ...th, born: reachedAt(c, th.birth) }));
    drawCocoon(ctx, threads, { w, h, dpr, ink: INK, t: c.t, pct, formMs, still: false });
  });

  const p = clamp01(pct / 100);
  const m = markLayout(size.w || 1, size.h || 1);
  const capsule = `inset(${m.cy - m.h / 2}px ${size.w - m.leftCocoon - m.w}px ${size.h - m.cy - m.h / 2}px ${m.leftCocoon}px round ${m.w / 2}px)`;
  // .cocoon.dim (0.32) eases back to full as the prompt leaves.
  const opacity = dim ? 0.32 + 0.68 * easeInOut(clamp01(c.leave ?? 0)) : 1;
  return (
    <div className="cocoon" ref={wrap} aria-hidden style={{ opacity }}>
      {src && size.w > 0 && formMs === null && (
        <img
          className="cocoon-src"
          src={src}
          alt=""
          draggable={false}
          style={{ clipPath: capsule, filter: `grayscale(1) blur(${(16 - 13 * p).toFixed(1)}px)`, opacity: (0.18 + 0.4 * p) * (1 - easeInOut(clamp01((p - 0.5) / 0.4))) }}
        />
      )}
      <canvas ref={canvas} style={{ width: size.w, height: size.h }} />
    </div>
  );
}

/** The result hatching from the formed logo, at the card's `hatchMs`; a plain frame otherwise.
 * `fill`: over a whole positioned box (the video's full frame) instead of a flex layout. */
export function Hatch({ aspect, children, fill }: { id?: string; aspect: number; children: React.ReactNode; fill?: boolean }) {
  const c = useCard();
  const ms = c.hatchMs ?? null;
  const running = ms !== null && ms < hatchEnd(FORM_MS);
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const ink = useRef<SVGPathElement>(null);
  const veilBox = useRef<HTMLDivElement>(null);
  const veil = useRef<SVGSVGElement>(null);
  const veilPath = useRef<SVGPathElement>(null);
  // The frame may be laid out only after the first commit: paint again once it has a size.
  const [, setSized] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSized((n) => n + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    const b = body.current;
    if (!el || !b) return;
    if (!running) return clearMask(b);
    paintHatch({ el, body: b, canvasBox: canvasBox.current, veilBox: veilBox.current, veil: veil.current, veilPath: veilPath.current, ink: ink.current }, aspect, ms!, FORM_MS);
  });

  return (
    <div className="hatch" ref={ref} style={fill ? { position: "absolute", inset: 0 } : undefined}>
      {running && <div className="hatch-canvas" ref={canvasBox} />}
      <div className="hatch-body" ref={body} style={fill ? { position: "absolute", inset: 0 } : undefined}>
        {children}
      </div>
      {running && (
        <div className="hatch-veil" ref={veilBox} aria-hidden>
          <svg ref={veil}>
            <path ref={veilPath} fillRule="evenodd" />
          </svg>
        </div>
      )}
      {running && (
        <svg className="hatch-ink" aria-hidden>
          <path ref={ink} />
        </svg>
      )}
    </div>
  );
}
