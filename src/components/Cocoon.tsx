// The cocoon: Kokon's mark as motion, ink on paper only (the theme's text colour), like the brand.
//
// While an image is made, silk threads wind around a capsule shaped like the logo's stem, loose
// at first, tighter and denser as the job advances, until the cocoon fills in and is the stem of
// the K, solid. Just before the image is ready the stem steps left and the two wings grow out
// of it: the whole logo, centred on the canvas. When the image arrives it appears inside the
// logo, and the logo grows until it is the image. The canvas (the image's space) stays visible
// throughout.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The mark in its 1024 grid (assets/brand, variant C): the stem (the cocoon) and two wings. */
const STEM = "M0.00 242.81 C0.00 112.17 70.23 25.08 175.59 25.08 C280.94 25.08 351.17 112.17 351.17 242.81 L351.17 781.19 C351.17 911.83 280.94 998.92 175.59 998.92 C70.23 998.92 0.00 911.83 0.00 781.19 Z";
const WING_UP = "M389.53 548.95 C389.53 250.35 662.35 25.08 1024.00 25.08 C1024.00 323.68 751.18 548.95 389.53 548.95 Z";
const WING_DOWN = "M389.53 587.31 C389.53 821.93 618.71 998.92 922.49 998.92 C922.49 764.30 693.31 587.31 389.53 587.31 Z";
const STEM_W = 351.17;
const STEM_TOP = 25.08;
const STEM_H = 973.84;
const STEM_RATIO = STEM_W / STEM_H;
/** Where the wings grow from. */
const UP_ROOT: [number, number] = [389.5, 549];
const DOWN_ROOT: [number, number] = [389.5, 587];
/** How much the logo grows while the image completes around it. */
const ZOOM_TO = 6;

export const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Where the mark sits on a `w`×`h` canvas: the stem ~48 % of the height, a little above the
 * middle (the percentage sits under it); the whole mark never wider than 80 % of the canvas. */
interface MarkLayout {
  /** Mark grid → pixels. */
  scale: number;
  top: number;
  /** Left of the mark's grid with the stem centred (the cocoon), and with the whole mark centred. */
  leftCocoon: number;
  leftLogo: number;
  /** The capsule (stem) with the stem centred. */
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export function markLayout(w: number, h: number): MarkLayout {
  let sh = h * 0.48;
  sh = Math.min(sh, (w * 0.8 * STEM_H) / 1024, (w * 0.5) / STEM_RATIO);
  const scale = sh / STEM_H;
  const cy = h * 0.43;
  return { scale, top: cy - sh / 2 - STEM_TOP * scale, leftCocoon: w / 2 - (STEM_W * scale) / 2, leftLogo: w / 2 - 512 * scale, cx: w / 2, cy, w: STEM_W * scale, h: sh };
}

/** `d` (absolute M/C/L/Z only) with every point mapped by `f`. */
function mapPath(d: string, f: (x: number, y: number) => [number, number]): string {
  const tok = d.match(/[MCLZ]|-?\d*\.?\d+/g) ?? [];
  let out = "";
  for (let i = 0; i < tok.length; ) {
    if (/[MCLZ]/.test(tok[i])) {
      out += tok[i++] + " ";
      continue;
    }
    const [x, y] = f(Number(tok[i]), Number(tok[i + 1]));
    out += `${x.toFixed(1)} ${y.toFixed(1)} `;
    i += 2;
  }
  return out;
}

/** The mark at `left`/`top`/`scale` with its wings grown to `up`/`down` (0..1): one path. */
export function markPath(left: number, top: number, scale: number, up: number, down: number): string {
  const toPx = (x: number, y: number): [number, number] => [left + x * scale, top + y * scale];
  const grow = (root: [number, number], k: number) => (x: number, y: number) => toPx(root[0] + (x - root[0]) * k, root[1] + (y - root[1]) * k);
  return mapPath(STEM, toPx) + (up > 0.001 ? mapPath(WING_UP, grow(UP_ROOT, up)) : "") + (down > 0.001 ? mapPath(WING_DOWN, grow(DOWN_ROOT, down)) : "");
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeOut = (v: number) => 1 - Math.pow(1 - v, 3);
const easeInOut = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);
/** Ease out with a small overshoot, for the wings opening. */
const easeOutBack = (v: number) => 1 + 2.2 * Math.pow(v - 1, 3) + 1.2 * Math.pow(v - 1, 2);

/** The logo forming: the stem steps left while the wings grow (ms). */
export const FORM_MS = 700;
/** Shift and wing growth at `ms` after the logo started forming. */
export function formingAt(ms: number) {
  return {
    shift: easeInOut(clamp01(ms / FORM_MS)),
    up: easeOutBack(clamp01((ms - 120) / (FORM_MS - 120))),
    down: easeOutBack(clamp01((ms - 210) / (FORM_MS - 120))),
  };
}

/** When a cocoon last finished forming the logo: the hatching then starts from the logo. */
let logoFormedAt = -Infinity;

/** Radius of the capsule (a stadium turned around its axis) at height `u` in -1..1. */
function radiusAt(u: number, m: MarkLayout): number {
  const r = m.w / 2;
  const y = Math.abs(u) * (m.h / 2);
  const straight = m.h / 2 - r;
  if (y <= straight) return r;
  const d = y - straight;
  return Math.sqrt(Math.max(0, r * r - d * d));
}

export interface Thread { turns: number; dir: number; phase: number; spin: number; u0: number; u1: number; birth: number; loose: number; width: number; alpha: number; born: number | null }

/** Same threads on every render: a small seeded generator. */
export function makeThreads(n: number): Thread[] {
  let seed = 0x4b6f6b6f; // "Koko"
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, (_, i) => ({
    // Few turns over a long span: threads cross diagonally, like silk, not like a spring.
    turns: 0.3 + rnd() * 1.1,
    dir: rnd() < 0.5 ? -1 : 1,
    phase: rnd() * Math.PI * 2,
    spin: 0.18 + rnd() * 0.16,
    u0: -1 + rnd() * 0.3,
    u1: 1 - rnd() * 0.3,
    // A few threads from the start, the rest spun in as the percentage grows.
    birth: i < 10 ? 0 : (i / n) * 88 + rnd() * 4,
    loose: 0.35 + rnd() * 0.65,
    width: 0.4 + rnd() * 0.55,
    // Mostly faint silk with a few brighter strands.
    alpha: rnd() < 0.15 ? 0.55 + rnd() * 0.25 : 0.1 + rnd() * 0.22,
    born: null,
  }));
}

export const THREADS = 120;
const POINTS = 72;

/** One frame of the cocoon on `ctx`: `t` seconds since the card appeared, `formMs` since the
 * logo started forming (null: not yet). Threads remember when they were spun in (`born`). */
export function drawCocoon(ctx: CanvasRenderingContext2D, threads: Thread[], o: { w: number; h: number; dpr: number; ink: string; t: number; pct: number; formMs: number | null; still: boolean }) {
  const { t, still, dpr, ink } = o;
  const pctNow = o.pct;
  const size = { w: o.w, h: o.h };
  const p = clamp01(pctNow / 100);
  const formed = o.formMs !== null;
  const f = !formed ? { shift: 0, up: 0, down: 0 } : still ? { shift: 1, up: 1, down: 1 } : formingAt(o.formMs!);
  // Tightness eases in: loose orbits at the start, a closed cocoon near the end; past half
  // way the silk fills in until the cocoon is the solid stem (at ~90 %, or when forming).
  const tight = 1 - Math.pow(1 - p, 1.6);
  const solid = formed ? 1 : easeInOut(clamp01((p - 0.5) / 0.4));
  const m = markLayout(size.w, size.h);
  const left = m.leftCocoon + (m.leftLogo - m.leftCocoon) * f.shift;
  const dx = left - m.leftCocoon;
  const breathe = still ? 1 : 1 + Math.sin(t * 1.3) * 0.008 * (1 - solid);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = "round";

  // The body: a faint fill that thickens with the silk, solid at the end; then the wings.
  ctx.globalAlpha = 0.025 + 0.06 * tight + (1 - 0.025 - 0.06 * tight) * solid;
  ctx.fill(new Path2D(markPath(left, m.top, m.scale, f.up, f.down)));

  const threadAlpha = 1 - solid;
  if (threadAlpha > 0.01) {
    for (const th of threads) {
      if (pctNow < th.birth && !still) continue;
      if (th.born === null) th.born = t;
      const grow = still ? 1 : Math.min(1, (t - th.born) / 1.8);
      const slack = (1 - tight) * th.loose;
      const rMul = (1 + slack * 1.1) * breathe;
      const yMul = 1 + slack * 0.35;
      const front = new Path2D();
      const back = new Path2D();
      let side = 0;
      let hx = 0;
      let hy = 0;
      for (let k = 0; k <= POINTS; k++) {
        const s = (k / POINTS) * grow;
        const u = th.u0 + (th.u1 - th.u0) * s;
        const phi = th.phase + th.dir * th.turns * Math.PI * 2 * s + th.spin * t;
        const r = radiusAt(u, m) * rMul + slack * m.w * 0.15 * Math.sin(phi * 2 + th.phase);
        const x = m.cx + dx + r * Math.cos(phi);
        const y = m.cy + u * (m.h / 2) * yMul;
        const z = Math.sin(phi) >= 0 ? 1 : -1;
        const path = z > 0 ? front : back;
        if (k === 0) path.moveTo(x, y);
        else if (z !== side) path.moveTo(hx, hy); // join front and back across the edge
        path.lineTo(x, y);
        side = z;
        hx = x;
        hy = y;
      }
      ctx.lineWidth = th.width;
      ctx.globalAlpha = th.alpha * 0.35 * threadAlpha;
      ctx.stroke(back);
      ctx.globalAlpha = th.alpha * (0.7 + 0.3 * tight) * threadAlpha;
      ctx.stroke(front);
      // The spinning end of a thread still being laid: a small glint.
      if (grow < 1) {
        ctx.globalAlpha = 0.8 * threadAlpha;
        ctx.beginPath();
        ctx.arc(hx, hy, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.globalAlpha = 1;
}

/** The cocoon behind a job in progress (`pct` 0..100). For an edit the source shows in black
 * and white inside it, coming into focus, until the silk fills in. `form` turns the filled
 * cocoon into the whole logo (set just before the image is ready). */
export function Cocoon({ src, pct, form, dim }: { src?: string; pct: number; form?: boolean; dim?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const live = useRef({ pct, form: !!form });
  live.current = { pct, form: !!form };

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !size.w || !size.h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(size.w * dpr);
    c.height = Math.round(size.h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const threads = makeThreads(THREADS);
    const still = reducedMotion();
    let ink = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#ffffff";
    let lastInk = 0;
    let formStart: number | null = null;
    let raf = 0;
    const t0 = performance.now();

    const draw = (now: number) => {
      const t = still ? 0 : (now - t0) / 1000;
      if (now - lastInk > 1000) {
        ink = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || ink;
        lastInk = now;
      }
      const { pct: pctNow, form: formNow } = live.current;
      if (formNow && formStart === null) formStart = now;
      if (formStart !== null && now - formStart >= FORM_MS) logoFormedAt = now;
      drawCocoon(ctx, threads, { w: size.w, h: size.h, dpr, ink, t, pct: pctNow, formMs: formStart === null ? null : now - formStart, still });
      if (!still || formStart === null) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size.w, size.h]);

  const p = clamp01(pct / 100);
  const m = markLayout(size.w || 1, size.h || 1);
  const capsule = `inset(${m.cy - m.h / 2}px ${size.w - m.leftCocoon - m.w}px ${size.h - m.cy - m.h / 2}px ${m.leftCocoon}px round ${m.w / 2}px)`;
  return (
    <div className={`cocoon ${dim ? "dim" : ""}`} ref={wrap} aria-hidden>
      {src && size.w > 0 && !form && (
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

/** The cocoon in small, for the status capsule and the timeline: silk threads winding round a
 * capsule (the logo's stem). `fill` (0..1) fills the capsule from the bottom, like the job's
 * percentage; without it the capsule stays faint. `size` is the height in px. */
export function SilkSpin({ size = 18, fill }: { size?: number; fill?: number }) {
  const f = fill === undefined ? null : clamp01(fill);
  return (
    <svg className="silk-spin" width={(size * 2) / 3} height={size} viewBox="0 0 16 24" aria-hidden>
      <rect x="4.5" y="3.5" width="7" height="17" rx="3.5" fill="currentColor" opacity="0.16" />
      {f !== null && <rect className="silk-fill" x="4.5" y={3.5 + 17 * (1 - f)} width="7" height={17 * f} rx="3.5" fill="currentColor" opacity="0.5" />}
      <ellipse cx="8" cy="12" rx="4.6" ry="9.6" strokeWidth="0.9" />
      <ellipse cx="8" cy="12" rx="4" ry="9.9" strokeWidth="0.7" />
      <ellipse cx="8" cy="12" rx="5.1" ry="9.2" strokeWidth="0.7" />
      <ellipse cx="8" cy="12" rx="3.6" ry="10" strokeWidth="0.6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------
// Hatching: a result made a moment ago comes out of the logo once, when first shown.
// ---------------------------------------------------------------------------------------

const fresh = new Map<string, number>();

/** Results of a job that just finished in this window (shown with the hatching once). */
export function markFresh(ids: string[]) {
  const now = Date.now();
  for (const id of ids) fresh.set(id, now);
}

function takeFresh(id: string): boolean {
  const at = fresh.get(id);
  fresh.delete(id);
  return at !== undefined && Date.now() - at < 8000;
}

export function clearMask(b: HTMLElement) {
  b.style.clipPath = "";
  b.style.filter = "";
  for (const p of ["mask-image", "-webkit-mask-image", "mask-size", "-webkit-mask-size", "mask-repeat", "-webkit-mask-repeat"]) b.style.removeProperty(p);
}

/** Timeline of the hatching (ms, after the logo has formed). */
const FILL_MS = 450;
const HOLD_MS = 350;
const ZOOM_MS = 950;

/** The parts of a hatching result frame (the markup of `Hatch`). */
export interface HatchEls {
  el: HTMLDivElement;
  body: HTMLDivElement;
  canvasBox: HTMLDivElement | null;
  veilBox: HTMLDivElement | null;
  veil: SVGSVGElement | null;
  veilPath: SVGPathElement | null;
  ink: SVGPathElement | null;
}

/** Where the hatching timeline ends (ms), when it starts `formFrom` ms into the logo forming. */
export const hatchEnd = (formFrom: number) => FORM_MS - formFrom + FILL_MS + HOLD_MS + ZOOM_MS;

/** The hatching at `tl` ms on its timeline (which waits while the image decodes), started
 * `formFrom` ms into the logo forming. The canvas is the frame's own image box, measured on
 * each call since the frame sizes itself after mounting; until then the same fit computed. The
 * mark sits on it like on the card. */
export function paintHatch(e: HatchEls, aspect: number, tl: number, formFrom: number) {
  const { el, body: b } = e;
  const W = el.clientWidth;
  const H = el.clientHeight;
  let r = { w: Math.min(W, H * aspect), h: 0, x: 0, y: 0 };
  r = { ...r, h: r.w / aspect, x: (W - r.w) / 2, y: (H - r.w / aspect) / 2 };
  const shown = b.querySelector<HTMLElement>(".image-box, .compare-box");
  if (shown && shown.offsetWidth > 0) {
    // Client rects include any scaling of an ancestor; the styles set below are layout pixels.
    const a = shown.getBoundingClientRect();
    const o = el.getBoundingClientRect();
    const k = el.offsetWidth > 0 ? o.width / el.offsetWidth : 1;
    r = { w: a.width / k, h: a.height / k, x: (a.left - o.left) / k, y: (a.top - o.top) / k };
  }
  const { w: iw, h: ih, x: ox, y: oy } = r;
  const m = markLayout(iw, ih);
  for (const box of [e.canvasBox, e.veilBox]) if (box) Object.assign(box.style, { left: `${ox}px`, top: `${oy}px`, width: `${iw}px`, height: `${ih}px` });
  const fillAt = FORM_MS - formFrom;
  const zoomAt = fillAt + FILL_MS + HOLD_MS;
  const f = formingAt(formFrom + tl);
  const z = easeInOut(clamp01((tl - zoomAt) / ZOOM_MS));
  const left = ox + m.leftCocoon + (m.leftLogo - m.leftCocoon) * f.shift;
  const top = oy + m.top;
  let d: string;
  if (z <= 0) {
    d = markPath(left, top, m.scale, f.up, f.down);
    b.style.clipPath = `path('${d}')`;
  } else {
    // The logo grows while drifting to the canvas centre, and the canvas around it (a veil
    // with the logo cut out) softens at the edge and fades away: the image dissolves out of
    // the logo instead of being cut by it. A path, not a mask image, so no frame waits on a
    // decode.
    const k = 1 + (ZOOM_TO - 1) * z;
    const c0x = left + 512 * m.scale;
    const c0y = top + 512 * m.scale;
    const cx = c0x + (ox + iw / 2 - c0x) * z;
    const cy = c0y + (oy + ih / 2 - c0y) * z;
    const s = m.scale * k;
    d = markPath(cx - 512 * s, cy - 512 * s, s, 1, 1);
    b.style.clipPath = "";
    const v = e.veil;
    const vp = e.veilPath;
    if (v && vp) {
      const feather = Math.min(iw, ih) * 0.05 * easeOut(z);
      const pad = feather * 3 + 2;
      const hole = markPath(cx - ox - 512 * s, cy - oy - 512 * s, s, 1, 1);
      vp.setAttribute("d", `M${-pad} ${-pad} H${iw + pad} V${ih + pad} H${-pad} Z ` + hole);
      v.style.display = "block";
      v.style.opacity = String(1 - easeInOut(clamp01((z - 0.15) / 0.85)));
      v.style.filter = feather > 0.3 ? `blur(${feather.toFixed(1)}px)` : "";
    }
  }
  // The solid logo gives way to the image inside it.
  const fill = easeOut(clamp01((tl - fillAt) / FILL_MS));
  if (e.ink) {
    e.ink.setAttribute("d", d);
    e.ink.style.opacity = String(1 - fill);
  }
  const blur = 6 * (1 - easeOut(clamp01((tl - fillAt) / (FILL_MS + HOLD_MS + ZOOM_MS * 0.5))));
  b.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
}

/** Wraps a result frame. The first time a fresh result is shown it hatches, on the canvas the
 * job was made on: from the solid logo (formed here first if the job ended before its card
 * showed it), the image appears inside the logo, then the logo grows evenly from its centre
 * while the rest of the image fades in around it, until only the image is left. `aspect` is the image's, to find its canvas. */
export function Hatch({ id, aspect, children }: { id?: string; aspect: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const canvasBox = useRef<HTMLDivElement>(null);
  const ink = useRef<SVGPathElement>(null);
  const veilBox = useRef<HTMLDivElement>(null);
  const veil = useRef<SVGSVGElement>(null);
  const veilPath = useRef<SVGPathElement>(null);
  const [on] = useState(() => !!id && takeFresh(id) && !reducedMotion());
  const [running, setRunning] = useState(on);

  useLayoutEffect(() => {
    const el = ref.current;
    const b = body.current;
    if (!on || !el || !b) return;
    const formed = performance.now() - logoFormedAt < 4000;
    const formFrom = formed ? FORM_MS : 0;
    const fillAt = FORM_MS - formFrom;
    const start = performance.now();
    // The solid logo holds until the image inside it is decoded: otherwise the ink fades onto an
    // empty canvas and the image pops in afterwards (the logo seems to appear twice).
    let readyAt: number | null = null;
    const imgs = Array.from(b.querySelectorAll("img"));
    const ready = () => (readyAt ??= performance.now());
    Promise.all(imgs.map((i) => i.decode().catch(() => {}))).then(ready);
    const giveUp = window.setTimeout(ready, 5000);
    let raf = 0;
    const frame = (now: number) => {
      const t = now - start;
      // The timeline after the logo has formed, paused while the image is not ready.
      const wait = readyAt === null ? Math.max(0, t - fillAt) : Math.max(0, readyAt - start - fillAt);
      const tl = t <= fillAt ? t : Math.max(fillAt, t - wait);
      paintHatch({ el, body: b, canvasBox: canvasBox.current, veilBox: veilBox.current, veil: veil.current, veilPath: veilPath.current, ink: ink.current }, aspect, tl, formFrom);
      if (tl < hatchEnd(formFrom)) raf = requestAnimationFrame(frame);
      else {
        clearMask(b);
        setRunning(false);
      }
    };
    frame(start);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(giveUp);
      clearMask(b);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="hatch" ref={ref}>
      {/* The canvas stays visible while the logo opens on it. */}
      {running && <div className="hatch-canvas" ref={canvasBox} />}
      <div className="hatch-body" ref={body}>
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
