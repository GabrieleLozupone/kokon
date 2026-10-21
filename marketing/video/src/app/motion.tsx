// Shared motion: easing, keyframes, the camera that frames the app window, the pointer and
// the captions. Window coordinates are CSS pixels of the 1440×900 window.
import type { CSSProperties, ReactNode } from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";

export const WIN = { w: 1440, h: 900 };
export const out = Easing.bezier(0.16, 1, 0.3, 1);
export const inOut = Easing.bezier(0.65, 0, 0.35, 1);

/** Piecewise interpolation through [frame, value] pairs, eased per segment. */
export function kf(frame: number, points: [number, number][], easing = inOut): number {
  if (frame <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [f1, v1] = points[i];
    const [f0, v0] = points[i - 1];
    if (frame <= f1) return interpolate(frame, [f0, f1], [v0, v1], { easing, extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  }
  return points[points.length - 1][1];
}

/** 0 → 1 from `start` over `dur` frames. */
export const prog = (frame: number, start: number, dur: number, easing = out) =>
  interpolate(frame, [start, start + dur], [0, 1], { easing, extrapolateLeft: "clamp", extrapolateRight: "clamp" });

/** The part of `text` typed by `frame` (natural rhythm: a little faster mid-word). */
export function typed(text: string, frame: number, start: number, cps = 32, fps = 30): string {
  const n = Math.floor(Math.max(0, frame - start) * (cps / fps));
  return text.slice(0, Math.min(text.length, n));
}
export const typingDone = (text: string, start: number, cps = 32, fps = 30) => start + Math.ceil((text.length * fps) / cps);

export interface Cam { x: number; y: number; s: number }

/**
 * Puts window point (x, y) at the centre of the 1920×1080 frame, scaled by s. `free` lets a
 * macro shot show past the window's edges; `blur` (px) smears fast moves.
 */
export function Camera({ cam, children, tilt = 0, lift = 0, opacity = 1, free = false, blur = 0, turn }: { cam: Cam; children: ReactNode; tilt?: number; lift?: number; opacity?: number; free?: boolean; blur?: number; turn?: { x: number; y: number } }) {
  // Zoomed in further than the frame: never show past the window's edges.
  const clamp = (v: number, half: number, size: number) => (!free && cam.s * size >= half * 2 ? Math.min(Math.max(v, half / cam.s), size - half / cam.s) : v);
  const x = clamp(cam.x, 960, WIN.w);
  const y = clamp(cam.y, 540, WIN.h);
  const px = 960 - cam.s * x;
  const py = 540 - cam.s * y + lift;
  return (
    <div style={{ position: "absolute", inset: 0, perspective: 2400, perspectiveOrigin: "50% 40%" }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: WIN.w,
          height: WIN.h,
          transformOrigin: "0 0",
          transform: `translate(${px}px, ${py}px) scale(${cam.s}) rotateX(${tilt}deg)`,
          opacity,
          filter: blur > 0.3 ? `blur(${blur / cam.s}px)` : undefined,
          perspective: turn ? 2000 / cam.s : undefined,
        }}
      >
        {turn ? (
          // An angled view, turning about the point the camera looks at.
          <div style={{ position: "absolute", inset: 0, transformOrigin: `${x}px ${y}px`, transform: `rotateX(${turn.x}deg) rotateY(${turn.y}deg)` }}>{children}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

/**
 * Shallow depth of field: the frame stays sharp in the band `focus` (frame y, px) and goes soft
 * above and below, like a macro lens. Renders `children` twice (soft copy under a sharp one).
 */
export function DepthOfField({ focus, blur = 7, feather = 150, children }: { focus: [number, number]; blur?: number; feather?: number; children: ReactNode }) {
  const [a, b] = focus;
  const mask = `linear-gradient(to bottom, transparent ${a - feather}px, #000 ${a}px, #000 ${b}px, transparent ${b + feather}px)`;
  return (
    <>
      <div style={{ position: "absolute", inset: 0, filter: `blur(${blur}px)` }}>{children}</div>
      <div style={{ position: "absolute", inset: 0, maskImage: mask, WebkitMaskImage: mask }}>{children}</div>
    </>
  );
}

/** How fast a camera moves at `frame` (frame px per frame), for motion blur. */
export function camSpeed(frame: number, at: (f: number) => Cam): number {
  const a = at(frame - 0.5);
  const b = at(frame + 0.5);
  const scale = Math.abs(Math.log(b.s / a.s)) * 900; // zoom: how far the frame edge travels
  return Math.hypot((b.x - a.x) * b.s, (b.y - a.y) * b.s) + scale;
}

/**
 * Monotone cubic (Fritsch–Carlson) through [frame, value] keys: glides through the inner keys
 * instead of stopping at each one, never overshoots, rests at the first and last key and
 * wherever a value turns or holds.
 */
export function glide(frame: number, points: [number, number][]): number {
  const n = points.length;
  if (frame <= points[0][0]) return points[0][1];
  if (frame >= points[n - 1][0]) return points[n - 1][1];
  const d = points.slice(1).map(([f1, v1], i) => (v1 - points[i][1]) / (f1 - points[i][0]));
  const m = points.map((_, i) => {
    if (i === 0 || i === n - 1) return 0;
    const a = d[i - 1];
    const b = d[i];
    if (a * b <= 0) return 0;
    const h0 = points[i][0] - points[i - 1][0];
    const h1 = points[i + 1][0] - points[i][0];
    return (3 * (h0 + h1)) / ((2 * h1 + h0) / a + (h1 + 2 * h0) / b);
  });
  let i = 1;
  while (frame > points[i][0]) i++;
  const [f0, v0] = points[i - 1];
  const [f1, v1] = points[i];
  const h = f1 - f0;
  const t = (frame - f0) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * h * m[i - 1] + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * h * m[i];
}

/** Moves a camera smoothly through keyframes [frame, cam]. */
export function camAt(frame: number, keys: [number, Cam][]): Cam {
  const k = (sel: (c: Cam) => number) => glide(frame, keys.map(([f, c]) => [f, sel(c)] as [number, number]));
  return { x: k((c) => c.x), y: k((c) => c.y), s: k((c) => c.s) };
}

/**
 * Renders `view(frame)`; for `dur` frames after each frame in `cuts`, the view from just
 * before the cut stays on top and fades out, so a new screen state dissolves in instead of
 * replacing the old one in a single frame.
 */
export function Dissolve({ frame, cuts, view, dur = 9 }: { frame: number; cuts: number[]; view: (t: number) => ReactNode; dur?: number }) {
  const cut = cuts.find((c) => frame >= c && frame < c + dur);
  return (
    <>
      {view(frame)}
      {cut !== undefined && <div style={{ position: "absolute", inset: 0, opacity: 1 - prog(frame, cut, dur, inOut) }}>{view(cut - 1)}</div>}
    </>
  );
}

/** A mouse pointer in window coordinates; `clicks` are frames where it presses. */
export function Pointer({ path, clicks = [], hideBefore = -1, hideAfter = 1e9 }: { path: [number, number, number][]; clicks?: number[]; hideBefore?: number; hideAfter?: number }) {
  const f = useCurrentFrame();
  if (f < hideBefore || f > hideAfter) return null;
  const x = kf(f, path.map(([fr, x]) => [fr, x]));
  const y = kf(f, path.map(([fr, , y]) => [fr, y]));
  const press = clicks.reduce((m, c) => Math.max(m, 1 - Math.min(1, Math.abs(f - c) / 4)), 0);
  const ring = clicks.map((c) => f - c).find((d) => d >= 0 && d < 14);
  const fade = Math.min(prog(f, hideBefore, 6), 1 - prog(f, hideAfter - 6, 6));
  return (
    <div style={{ position: "absolute", left: x, top: y, zIndex: 100, pointerEvents: "none", opacity: fade }}>
      {ring !== undefined && (
        <div
          style={{
            position: "absolute",
            left: -18,
            top: -18,
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "2px solid rgba(255,255,255,0.9)",
            transform: `scale(${0.4 + ring / 10})`,
            opacity: 1 - ring / 14,
          }}
        />
      )}
      <svg width="26" height="26" viewBox="0 0 24 24" style={{ transform: `scale(${1 - press * 0.15})`, transformOrigin: "3px 2px", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }}>
        <path d="M3 2 L3 19 L7.6 14.8 L10.6 21.4 L13.4 20.2 L10.5 13.7 L16.8 13.7 Z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

const captionBase: CSSProperties = { position: "absolute", fontFamily: '"Inter Variable", Inter, sans-serif', color: "#f2f2f2", pointerEvents: "none" };

/** Big title + small line, words rising in one after another; fades out at `end`. */
export function Caption({ title, sub, start, end, x = 96, y = 820, align = "left", size = 64, maxWidth }: { title: string; sub?: string; start: number; end: number; x?: number; y?: number; align?: "left" | "center"; size?: number; maxWidth?: number }) {
  const f = useCurrentFrame();
  const gone = prog(f, end - 10, 10, inOut);
  if (f < start || f > end) return null;
  const words = title.split(" ");
  return (
    <div style={{ ...captionBase, left: align === "center" ? 0 : x, right: align === "center" ? 0 : undefined, top: y, maxWidth, textAlign: align, opacity: 1 - gone, transform: `translateY(${-gone * 16}px)` }}>
      <div style={{ fontSize: size, fontWeight: 650, letterSpacing: "-0.035em", lineHeight: 1.05, textShadow: "0 4px 30px rgba(0,0,0,0.55)" }}>
        {words.map((w, i) => {
          const p = prog(f, start + i * 3, 16);
          return (
            <span key={i} style={{ display: "inline-block", opacity: p, transform: `translateY(${(1 - p) * 26}px)`, filter: `blur(${(1 - p) * 8}px)`, marginRight: "0.24em" }}>
              {w}
            </span>
          );
        })}
      </div>
      {sub && (
        <div style={{ marginTop: 14, lineHeight: maxWidth ? 1.35 : undefined, fontSize: size * 0.36, fontWeight: 450, color: "rgba(240,240,240,0.72)", letterSpacing: "-0.01em", opacity: prog(f, start + words.length * 3 + 4, 16), textShadow: "0 2px 18px rgba(0,0,0,0.6)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/** Soft dark backdrop with a faint light behind the window. */
export function Backdrop({ glow = 1 }: { glow?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(ellipse 70% 60% at 50% 45%, rgba(255,255,255,${0.07 * glow}) 0%, rgba(255,255,255,0) 60%), #050505`,
      }}
    />
  );
}

/** Darkens the frame edge under captions so text stays readable over the app. */
export function Vignette({ strength = 1, side = "bottom", reach = 1 }: { strength?: number; side?: "bottom" | "top" | "left"; reach?: number }) {
  const dir = side === "bottom" ? "to top" : side === "top" ? "to bottom" : "to right";
  return <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: `linear-gradient(${dir}, rgba(0,0,0,${0.94 * strength}) 0%, rgba(0,0,0,${0.78 * strength}) ${24 * reach}%, rgba(0,0,0,${0.35 * strength}) ${40 * reach}%, rgba(0,0,0,0) ${55 * reach}%)` }} />;
}
