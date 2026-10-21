// Vertical reels (1080×1920) for TikTok, Instagram Reels and YouTube Shorts: one edit each,
// result first. The hook sits over the finished image for the first second and a half, then the
// clip rewinds to the original, paints or types the change in a Kokon-style prompt bar, "works"
// (sped up, said on screen with the real time) and wipes the result in; a before/after handle
// sweeps across, and an end card gives the name and the address. No music in the master: the
// platforms' trending sound goes on top at upload, so only soft effects are mixed in.
import { AbsoluteFill, Img, staticFile, useCurrentFrame } from "remotion";
import { PROMPTS } from "../app/fixtures";
import { strokePoints } from "../app/InpaintOverlay";
import { Mark } from "../app/Mark";
import { inOut, kf, prog, typed, typingDone } from "../app/motion";
import { Send, Sfx } from "../app/sound";

interface Reel {
  /** Words of the hook, shown one by one over the result. */
  hook: string;
  before: string;
  after: string;
  /** Image width / height. */
  ar: number;
  /** The reel shows a square crop of the (wide) image; 0–1: where it sits from left to right. */
  focus: number;
  mode: string;
  prompt: string;
  /** Brush path in image fractions (inpaint reels). */
  stroke?: [number, number][];
  /** The line under the picture while the handle sweeps. */
  proof: string;
  /** Real time of this edit, said while it "works". */
  real: string;
}

export const STREET_STROKE: [number, number][] = [
  [0.47, 0.52], [0.62, 0.49], [0.665, 0.58], [0.475, 0.6], [0.455, 0.7], [0.67, 0.68], [0.68, 0.78], [0.46, 0.8], [0.465, 0.9], [0.665, 0.88], [0.62, 0.965], [0.5, 0.965],
];

export const REELS = {
  ReelRemove: {
    hook: "This edit never left my PC.",
    before: "street",
    after: "street-removed",
    ar: 2752 / 1536,
    focus: 0.6,
    mode: "Remove",
    prompt: PROMPTS.remove,
    stroke: STREET_STROKE,
    proof: "Only the painted area changed.",
    real: "about 24 s on an RTX 5070 Ti",
  },
  ReelSeason: {
    hook: "Summer → winter. One sentence.",
    before: "cabin",
    after: "cabin-winter",
    ar: 2200 / 1228,
    focus: 0.78,
    mode: "Edit",
    prompt: PROMPTS.winter,
    proof: "No upload. No subscription. No limit.",
    real: "about 24 s on an RTX 5070 Ti",
  },
  ReelText: {
    hook: "It even spells the sign right. Offline.",
    before: "bakery",
    after: "bakery-text",
    ar: 2200 / 1635,
    focus: 0.5,
    mode: "Edit",
    prompt: PROMPTS.text,
    proof: "Same lettering. Same photo. Free.",
    real: "about 24 s on an RTX 5070 Ti",
  },
} satisfies Record<string, Reel>;

const font = '"Inter Variable", Inter, sans-serif';
const W = 1080;
const CARD = 1032;
const END = 84;

/** Frame marks of one reel (they depend on whether it paints and how long the prompt is). */
function marks(r: Reel) {
  const rewind = 48;
  const paint = rewind + 18;
  const paint1 = r.stroke ? paint + 42 : paint;
  const type = paint1 + 8;
  const send = typingDone(r.prompt, type, 40) + 8;
  const reveal = send + 34;
  const sweep = reveal + 40;
  const end = sweep + 72;
  return { rewind, paint, paint1, type, send, reveal, sweep, end, total: end + END };
}

export const reelFrames = (r: Reel) => marks(r).total;

function Hook({ text, f }: { text: string; f: number }) {
  const words = text.split(" ");
  return (
    <div style={{ position: "absolute", left: 60, right: 60, top: 150, textAlign: "center", fontFamily: font, fontSize: 98, fontWeight: 720, lineHeight: 1.04, letterSpacing: "-0.04em", color: "#f6f6f3", textShadow: "0 6px 40px rgba(0,0,0,0.65)" }}>
      {words.map((w, i) => {
        const p = prog(f, 3 + i * 3, 8);
        return (
          <span key={i} style={{ display: "inline-block", marginRight: "0.26em", opacity: p, transform: `translateY(${(1 - p) * 24}px) scale(${0.92 + p * 0.08})`, filter: `blur(${(1 - p) * 8}px)` }}>
            {w}
          </span>
        );
      })}
    </div>
  );
}

function Pill({ children, side, opacity }: { children: string; side: "l" | "r"; opacity: number }) {
  return (
    <span style={{ position: "absolute", top: 22, [side === "l" ? "left" : "right"]: 22, padding: "8px 16px", borderRadius: 999, background: "rgba(10,10,10,0.6)", backdropFilter: "blur(8px)", fontFamily: font, fontSize: 24, fontWeight: 600, color: "#f2f2f0", opacity }}>
      {children}
    </span>
  );
}

export function ReelScene({ r }: { r: Reel }) {
  const f = useCurrentFrame();
  const m = marks(r);
  const cardY = 470;
  // The square crop: the visible part of the image width, and where it starts.
  const vis = 1 / r.ar;
  const left = (1 - vis) * r.focus;
  const fit = { position: "absolute" as const, inset: 0, width: "100%", height: "100%", objectFit: "cover" as const, objectPosition: `${r.focus * 100}% 50%` };
  const img = (id: string) => staticFile(`img/${id}.jpg`);

  // How much of the result shows: all of it under the hook, none after the rewind, wiped back
  // in, then the handle sweeps right → left → centre.
  const showAfter = f < m.rewind ? 1 : f < m.reveal ? 0 : null;
  const wipe = prog(f, m.reveal, 22, inOut);
  const handle = f < m.sweep ? null : kf(f, [[m.sweep, 1], [m.sweep + 24, 0.08], [m.sweep + 50, 0.5]]);
  const split = handle ?? (showAfter ?? wipe);
  const flash = Math.max(0, 1 - Math.abs(f - m.rewind) / 6);
  const working = f >= m.send && f < m.reveal;
  const workP = prog(f, m.send, m.reveal - m.send, (x) => x);
  const strokeP = r.stroke ? prog(f, m.paint, m.paint1 - m.paint, (x) => x) : 0;
  const strokeFade = 1 - prog(f, m.send, 10);
  const pts = r.stroke ? strokePoints(r.stroke, strokeP) : [];
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"} ${((x - left) / vis) * 1000} ${y * 1000}`).join(" ");
  const sentence = typed(r.prompt, f, m.type, 40);
  const ui = prog(f, m.rewind, 10);
  const endP = prog(f, m.end, 14);
  const push = 1 + (f / m.total) * 0.06;

  return (
    <AbsoluteFill style={{ background: "#050505", overflow: "hidden" }}>
      <Img src={img(split > 0.5 ? r.after : r.before)} style={{ position: "absolute", inset: -80, width: W + 160, height: 2080, objectFit: "cover", filter: "blur(60px) brightness(0.42) saturate(1.2)" }} />

      <div style={{ position: "absolute", left: (W - CARD) / 2, top: cardY, width: CARD, height: CARD, borderRadius: 36, overflow: "hidden", boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 40px 120px rgba(0,0,0,0.6)", transform: `scale(${push})` }}>
        <Img src={img(r.before)} style={fit} />
        <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}>
          <Img src={img(r.after)} style={fit} />
        </div>
        {d && (
          <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", mixBlendMode: "difference", opacity: 0.75 * strokeFade }}>
            <path d={d} fill="none" stroke="#fff" strokeWidth={70 * r.ar} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {working && (
          <div style={{ position: "absolute", inset: 0, background: `linear-gradient(100deg, transparent ${workP * 120 - 40}%, rgba(255,255,255,0.18) ${workP * 120 - 20}%, transparent ${workP * 120}%)` }} />
        )}
        {handle !== null && <div style={{ position: "absolute", top: 0, bottom: 0, left: `${split * 100}%`, width: 4, marginLeft: -2, background: "#fff", boxShadow: "0 0 20px rgba(0,0,0,0.5)" }} />}
        <Pill side="l" opacity={f >= m.rewind && f < m.end ? ui * (handle !== null ? 1 : split < 0.5 ? 1 : 0) : 0}>Before</Pill>
        <Pill side="r" opacity={handle !== null ? 1 - endP : 0}>After</Pill>
        <div style={{ position: "absolute", inset: 0, background: "#fff", opacity: flash * 0.5 }} />
      </div>

      {f < m.rewind + 8 && (
        <div style={{ opacity: 1 - prog(f, m.rewind - 6, 12) }}>
          <Hook text={r.hook} f={f} />
        </div>
      )}

      {/* The prompt bar, as in Kokon's composer. */}
      <div style={{ position: "absolute", left: 40, right: 40, top: cardY + CARD + 44, opacity: ui * (1 - endP), transform: `translateY(${(1 - ui) * 30}px)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, padding: "20px 22px", borderRadius: 30, background: "rgba(22,22,22,0.86)", boxShadow: "0 0 0 1px rgba(255,255,255,0.12), 0 20px 60px rgba(0,0,0,0.5)", fontFamily: font }}>
          <span style={{ padding: "8px 16px", borderRadius: 999, background: "rgba(255,255,255,0.1)", fontSize: 24, fontWeight: 600, color: "#e8e8e5", whiteSpace: "nowrap" }}>{r.mode}</span>
          <span style={{ flex: 1, fontSize: 30, lineHeight: 1.3, color: sentence ? "#f2f2f0" : "rgba(240,240,240,0.4)" }}>
            {sentence || (r.stroke ? "Paint the area…" : "Describe the change…")}
            {sentence && sentence.length < r.prompt.length && <span style={{ opacity: 0.6 }}>▍</span>}
          </span>
          <span style={{ width: 58, height: 58, borderRadius: 999, display: "grid", placeItems: "center", background: f >= m.send && f < m.send + 6 ? "#bdbdbd" : "#f2f2f0", flexShrink: 0 }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0a0a0a" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </span>
        </div>
        <div style={{ marginTop: 22, textAlign: "center", fontFamily: font, fontSize: 27, color: "rgba(240,240,240,0.72)", height: 40 }}>
          {working ? (
            <span>
              On my own GPU · sped up (real: {r.real})
              <span style={{ display: "block", margin: "14px auto 0", width: 420, height: 6, borderRadius: 6, background: "rgba(255,255,255,0.15)", overflow: "hidden" }}>
                <span style={{ display: "block", width: `${workP * 100}%`, height: "100%", background: "#f2f2f0" }} />
              </span>
            </span>
          ) : null}
        </div>
      </div>

      {/* The proof line, over the picture's top while the handle sweeps. */}
      <div style={{ position: "absolute", left: 60, right: 60, top: 170, textAlign: "center", fontFamily: font, fontSize: 82, fontWeight: 680, letterSpacing: "-0.035em", lineHeight: 1.08, color: "#f6f6f3", textShadow: "0 6px 40px rgba(0,0,0,0.65)", opacity: prog(f, m.reveal + 6, 12) * (1 - endP) }}>
        {r.proof}
      </div>

      {/* Who made it, for anyone who screen-records and reposts. */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 96, display: "flex", justifyContent: "center", alignItems: "center", gap: 14, fontFamily: font, fontSize: 32, fontWeight: 620, color: "rgba(246,246,243,0.8)", opacity: 1 - endP }}>
        <Mark size={34} color="rgba(246,246,243,0.85)" />
        kokon.app
      </div>

      {/* End card. */}
      <AbsoluteFill style={{ background: `rgba(5,5,5,${0.82 * endP})`, opacity: endP }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 640, textAlign: "center", fontFamily: font, color: "#f6f6f3", transform: `translateY(${(1 - endP) * 30}px)` }}>
          <div style={{ display: "inline-block" }}>
            <Mark size={150} color="#f6f6f3" />
          </div>
          <div style={{ marginTop: 34, fontSize: 112, fontWeight: 700, letterSpacing: "-0.05em" }}>Kokon</div>
          <div style={{ marginTop: 18, fontSize: 38, lineHeight: 1.35, color: "rgba(240,240,240,0.8)", padding: "0 80px" }}>
            AI photo editing on your own computer.
            <br />
            Free · open source · offline.
          </div>
          <div style={{ marginTop: 56, display: "inline-block", padding: "18px 40px", borderRadius: 999, background: "#f6f6f3", color: "#0a0a0a", fontSize: 44, fontWeight: 650, letterSpacing: "-0.02em" }}>kokon.app</div>
          <div style={{ marginTop: 36, fontSize: 28, color: "rgba(240,240,240,0.55)" }}>Windows · Mac · Linux · 12 GB GPU or Apple Silicon</div>
        </div>
      </AbsoluteFill>

      <Sfx name="whoosh" at={m.rewind - 4} />
      {r.stroke && <Sfx name="brush" at={m.paint} dur={m.paint1 - m.paint} />}
      <Sfx name="typing" at={m.type} dur={m.send - 8 - m.type} />
      <Send at={m.send} />
      <Sfx name="reveal" at={m.reveal} />
      <Sfx name="slider" at={m.sweep} dur={50} />
      <Sfx name="hit" at={m.end} gain={0.6} />
    </AbsoluteFill>
  );
}
