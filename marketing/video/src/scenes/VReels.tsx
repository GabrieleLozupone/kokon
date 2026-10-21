// Vertical reels with voice (1080×1920): each one shows what only a local app can show.
// - ReelOffline: Wi-Fi off, then a real edit in Kokon (storyboard until Gabriele records the screen).
// - ReelSetup: installer → GPU found, model downloading → first edit (storyboard, same).
// - ReelTour: twenty seconds inside the app, from its own components (final).
// - ReelFounder: face to camera, then the screen (placeholder avatar until Gabriele films himself).
// The voice is the 0.10 video's (marketing/audio/gen_reel_voice.py → public/voice-reels, spans in
// app/voice-reels.json); captions follow it word by word; the 0.10 music sits low underneath.
import type { ReactNode } from "react";
import { AbsoluteFill, Html5Audio, Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { AppWindow } from "../app/AppWindow";
import { appState, gen, genItem, jobItem, PROJECTS, PROMPTS, ref } from "../app/fixtures";
import { InpaintOverlay } from "../app/InpaintOverlay";
import { Mark } from "../app/Mark";
import { inOut, kf, Pointer, prog, typed } from "../app/motion";
import { Send, Sfx } from "../app/sound";
import voice from "../app/voice-reels.json";
import type { CardMotion } from "../mocks/card";
import type { State } from "../mocks/store";
import { CAT, promptPlusCard, promptPlusView, type PromptPlusTimes, REMOVED, STREET } from "./AppScenes";
import { STREET_STROKE } from "./Reels";

const FPS = 30;
const font = '"Inter Variable", Inter, sans-serif';
const INK = "#f6f6f3";
const SPANS = voice as unknown as Record<string, { dur: number; sentences: [number, number][] }>;
const LEAD = 10;

// ---------------------------------------------------------------------------------------------
// Timing: a reel is a list of segments, each spoken by one or more script lines.
// ---------------------------------------------------------------------------------------------
interface Seg {
  lines: number[];
  /** Frames after the last line's voice before the next segment. */
  pad?: number;
  /** At least this many frames. */
  min?: number;
  shot: (t: number, s: Timed) => ReactNode;
}
interface Timed {
  start: number;
  len: number;
  /** Start frame (reel time) of each of the segment's lines. */
  at: Record<number, number>;
}
interface VReel {
  headline?: string;
  /** Storyboard or placeholder: a label so it is never posted by mistake. */
  preview?: string;
  segs: Seg[];
}

const lineFrames = (n: number) => Math.ceil((SPANS[String(n)]?.dur ?? 2) * FPS);

function layout(r: VReel): { segs: Timed[]; total: number } {
  let pos = LEAD;
  const segs = r.segs.map((s) => {
    const at: Record<number, number> = {};
    let p = pos;
    s.lines.forEach((n, i) => {
      at[n] = p;
      p += lineFrames(n) + (i < s.lines.length - 1 ? 8 : 0);
    });
    const len = Math.max(s.min ?? 0, p - pos + (s.pad ?? 12));
    const t = { start: pos, len, at };
    pos += len;
    return t;
  });
  return { segs, total: pos };
}

/** Reel frame where sentence `i` of line `n` starts (and ends). */
const said = (s: Timed, n: number, i = 0) => s.at[n] + Math.round((SPANS[String(n)]?.sentences[i]?.[0] ?? 0) * FPS);
const saidEnd = (s: Timed, n: number, i = 0) => s.at[n] + Math.round((SPANS[String(n)]?.sentences[i]?.[1] ?? 1) * FPS);

// ---------------------------------------------------------------------------------------------
// Pieces shared by the reels.
// ---------------------------------------------------------------------------------------------
interface Cam {
  x: number;
  y: number;
  s: number;
}
const SCREEN = { top: 330, h: 1120 };

/** The Kokon window seen through the phone frame: window point (x, y) at the centre, scaled. */
function Screen({ cam, children, top = SCREEN.top, h = SCREEN.h }: { cam: Cam; children: ReactNode; top?: number; h?: number }) {
  return (
    <div style={{ position: "absolute", left: 0, top, width: 1080, height: h, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900, transformOrigin: "0 0", transform: `translate(${540 - cam.s * cam.x}px, ${h / 2 - cam.s * cam.y}px) scale(${cam.s})` }}>
        {children}
      </div>
    </div>
  );
}

const camAt = (t: number, keys: [number, Cam][]): Cam => ({
  x: kf(t, keys.map(([f, c]) => [f, c.x])),
  y: kf(t, keys.map(([f, c]) => [f, c.y])),
  s: kf(t, keys.map(([f, c]) => [f, c.s])),
});

const PROJECT = (count: number, cover: string) => ({ projects: [{ id: "current", title: "Italian street café", updatedAt: Date.now() - 20_000, cover, count }, ...PROJECTS], projectId: "current" });
const CABIN = gen("cabin", "generate", "A wooden cabin by a mountain lake on a clear summer day");
const WINTER = gen("cabin-winter", "edit", PROMPTS.winter, "cabin");
const CABIN_PROJECT = { projects: [{ id: "current", title: "Cabin by the lake", updatedAt: Date.now() - 20_000, cover: "gen:cabin", count: 1 }, ...PROJECTS.filter((p) => p.id !== "p2")], projectId: "current" };

/** The window on the street photo, painting the scooter (p: 0–1 of the stroke). */
function paintWindow(p: number) {
  const state = appState({ session: [genItem(STREET)], selected: "street", composer: { ...appState().composer, refs: [ref("street")] }, ...PROJECT(1, "gen:street") });
  return <AppWindow state={state} width={1440} height={900} hideComposer overlay={<InpaintOverlay id="street" aspect={2752 / 1536} points={STREET_STROKE} p={p} brush={74} />} />;
}

/** The composer with Remove picked and the words typed, on the painted street. */
function removeWindow(chars: number) {
  const base = appState();
  const state = appState({
    session: [genItem(STREET)],
    selected: "street",
    composer: { ...base.composer, refs: [ref("street")], mask: { inputId: "mask", refKey: "ref-street" }, inpaintAction: "remove", prompt: PROMPTS.remove.slice(0, chars) },
    ...PROJECT(1, "gen:street"),
  });
  return <AppWindow state={state} width={1440} height={900} />;
}

/** The result selected, with the before/after slider at `split` (null: no compare). */
function resultWindow(id: "street-removed" | "street-cat", split: number | null) {
  const items = id === "street-cat" ? [genItem(STREET), genItem(REMOVED), genItem(CAT)] : [genItem(STREET), genItem(REMOVED)];
  const state = appState({ session: items, selected: id, compare: split === null ? "off" : "slider", composer: { ...appState().composer, refs: [ref(id)] }, ...PROJECT(items.length, `gen:${id}`) });
  return <AppWindow state={state} width={1440} height={900} split={split ?? 0.5} />;
}

/** An edit of the cabin: typing (t < job), the job card working, then the result hatching. */
function cabinEdit(t: number, T: { type: number; job: number; hatch: number }) {
  const base = appState();
  let state: State;
  let card: CardMotion | undefined;
  if (t < T.job) {
    state = appState({ session: [genItem(CABIN)], selected: "cabin", composer: { ...base.composer, refs: [ref("cabin")], prompt: typed(PROMPTS.winter, t, T.type, 60) }, ...CABIN_PROJECT });
  } else if (t < T.hatch) {
    const pct = kf(t, [[T.job, 0], [T.hatch - 4, 100]]);
    const j = jobItem("j-winter", "edit", PROMPTS.winter, "cabin-winter", "cabin", Math.min(8, Math.floor((pct / 100) * 8)));
    state = appState({ session: [genItem(CABIN), j.item], selected: "j-winter", jobs: { "j-winter": j.job }, composer: { ...base.composer, refs: [ref("cabin")] }, ...CABIN_PROJECT });
    card = { t: (t - T.job) / FPS, pctAt: (s) => kf(T.job + s * FPS, [[T.job, 0], [T.hatch - 4, 100]]) };
  } else {
    state = appState({ session: [genItem(CABIN), genItem(WINTER)], selected: "cabin-winter", composer: { ...base.composer, refs: [ref("cabin-winter")] }, ...CABIN_PROJECT });
    card = { t: (t - T.job) / FPS, pctAt: () => 100, hatchMs: ((t - T.hatch) * 1000) / FPS };
  }
  return <AppWindow state={state} width={1440} height={900} card={card} />;
}

/** Words of the voice, a sentence at a time, each lighting up as it is said. */
function Captions({ segs, reel, y = 1500 }: { segs: Timed[]; reel: VReel; y?: number }) {
  const f = useCurrentFrame();
  for (const [k, s] of segs.entries()) {
    for (const n of reel.segs[k].lines) {
      const sp = SPANS[String(n)];
      if (!sp) continue;
      const line = scriptWords(n);
      for (const [i, [a, b]] of sp.sentences.entries()) {
        const from = s.at[n] + Math.round(a * FPS) - 3;
        const to = s.at[n] + Math.round(b * FPS) + 6;
        if (f < from || f > to) continue;
        const words = line[i] ?? [];
        const per = ((b - a) * FPS) / Math.max(1, words.length);
        return (
          <div style={{ position: "absolute", left: 50, right: 50, top: y, textAlign: "center", fontFamily: font, fontSize: 68, fontWeight: 760, lineHeight: 1.12, letterSpacing: "-0.03em" }}>
            {words.map((w, j) => {
              const on = f >= from + 3 + j * per;
              return (
                <span key={j} style={{ display: "inline-block", marginRight: "0.24em", color: on ? INK : "rgba(246,246,243,0.35)", transform: `scale(${on ? 1 : 0.96})`, textShadow: "0 4px 24px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)" }}>
                  {w}
                </span>
              );
            })}
          </div>
        );
      }
    }
  }
  return null;
}

// The script's lines, as in marketing/audio/voiceover-reels.md (the captions show these words).
const SCRIPT: Record<number, string> = {
  1: "I turned off the internet.",
  2: "And I'm still editing photos with AI. Paint it. Remove. Done.",
  3: "Nothing was uploaded. It all runs on my own graphics card.",
  4: "It's called Kokon. Free, and open source.",
  5: "This is everything you need to edit photos with AI on your own PC.",
  6: "One installer. It finds your graphics card and downloads the model for you.",
  7: "No Python. No ComfyUI. No settings. Then you just say what you want.",
  8: "Kokon. Free, for Windows, Mac and Linux.",
  9: "Twenty seconds inside Kokon.",
  10: "Type a few words. Prompt+ writes the full prompt.",
  11: "Then your image hatches, on your own GPU.",
  12: "Paint an area, and only that area changes.",
  13: "Every version is kept. Compare them with a slider.",
  14: "Free and open source. kokon.app",
  15: "I built a free app that edits photos like Nano Banana, but on your own PC.",
  16: "No cloud. No subscription. No limits.",
  17: "Watch. I paint the scooter, and it's gone.",
  18: "Or I just say: make it a snowy night.",
  19: "It picks the model and sets everything up for you.",
  20: "It's called Kokon. It's free and open source. Link in bio.",
};
const scriptWords = (n: number) => (SCRIPT[n] ?? "").split(/(?<=[.?!])\s+(?=[A-Z])/).map((s) => s.split(" "));

function EndCard({ t, sub = "AI photo editing on your own computer." }: { t: number; sub?: string }) {
  const p = prog(t, 0, 14);
  return (
    <AbsoluteFill style={{ background: "#050505", opacity: p }}>
      <div style={{ position: "absolute", left: 0, right: 0, top: 560, textAlign: "center", fontFamily: font, color: INK, transform: `translateY(${(1 - p) * 30}px)` }}>
        <div style={{ display: "inline-block" }}>
          <Mark size={150} color={INK} />
        </div>
        <div style={{ marginTop: 34, fontSize: 112, fontWeight: 700, letterSpacing: "-0.05em" }}>Kokon</div>
        <div style={{ marginTop: 18, fontSize: 40, lineHeight: 1.35, color: "rgba(240,240,240,0.8)", padding: "0 80px" }}>
          {sub}
          <br />
          Free · open source · offline.
        </div>
        <div style={{ marginTop: 56, display: "inline-block", padding: "18px 40px", borderRadius: 999, background: INK, color: "#0a0a0a", fontSize: 46, fontWeight: 650 }}>kokon.app</div>
        <div style={{ marginTop: 36, fontSize: 28, color: "rgba(240,240,240,0.55)" }}>Windows · Mac · Linux · 12 GB GPU or Apple Silicon</div>
      </div>
    </AbsoluteFill>
  );
}

/** "No internet" as Windows shows it, kept on screen while the app works. */
function NoInternet({ opacity = 1, top = 248 }: { opacity?: number; top?: number }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top, display: "flex", justifyContent: "center", opacity }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 24px", borderRadius: 999, background: "rgba(30,30,30,0.92)", boxShadow: "0 0 0 1px rgba(255,255,255,0.14)", fontFamily: font, fontSize: 30, fontWeight: 600, color: INK }}>
        <GlobeOff size={34} />
        No internet
      </div>
    </div>
  );
}

function GlobeOff({ size = 28, color = INK }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.7 3.6 5.7 3.6 9s-1.1 6.3-3.6 9c-2.5-2.7-3.6-5.7-3.6-9S9.5 5.7 12 3z" />
      <path d="M4 4l16 16" stroke="#ff5a4e" strokeWidth="2.4" />
    </svg>
  );
}

function Wifi({ size = 28, color = INK }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round">
      <path d="M2 8.5a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19" r="1.2" fill={color} />
    </svg>
  );
}

/** Windows' quick settings over a blurred desktop: the Wi-Fi tile switched off (storyboard). */
function WifiOff({ t, off }: { t: number; off: number }) {
  const on = t < off;
  return (
    <AbsoluteFill>
      <Img src={staticFile("img/street.jpg")} style={{ position: "absolute", inset: -60, width: 1200, height: 2040, objectFit: "cover", filter: "blur(40px) brightness(0.45)" }} />
      <div style={{ position: "absolute", left: 90, right: 90, top: 640, padding: 36, borderRadius: 28, background: "rgba(36,36,38,0.94)", boxShadow: "0 30px 90px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1)", fontFamily: font, color: INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 22 }}>
          {[["Wi-Fi", true], ["Bluetooth", false], ["Airplane mode", false]].map(([label, wifi]) => (
            <div key={String(label)} style={{ height: 150, borderRadius: 18, padding: 22, display: "flex", flexDirection: "column", justifyContent: "space-between", background: wifi && on ? "#4cc2ff" : "rgba(255,255,255,0.09)", color: wifi && on ? "#06121a" : INK, transform: `scale(${wifi ? 1 - 0.05 * Math.max(0, 1 - Math.abs(t - off) / 4) : 1})` }}>
              {wifi ? <Wifi size={40} color={on ? "#06121a" : INK} /> : <span style={{ fontSize: 34 }}>{label === "Bluetooth" ? "ᛒ" : "✈"}</span>}
              <span style={{ fontSize: 26, fontWeight: 600 }}>{wifi ? (on ? "Wi-Fi" : "Wi-Fi off") : String(label)}</span>
            </div>
          ))}
        </div>
      </div>
      {/* The taskbar's tray. */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 110, background: "rgba(28,28,30,0.96)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 26, paddingRight: 50, fontFamily: font, color: INK, fontSize: 28 }}>
        {on ? <Wifi size={36} /> : <GlobeOff size={38} />}
        <span>🔊</span>
        <span style={{ textAlign: "right", lineHeight: 1.2, fontSize: 24 }}>
          16:02
          <br />
          21/10/2026
        </span>
      </div>
      <Pointer path={[[0, 760, 1200], [off - 3, 260, 740], [off + 20, 300, 800]]} clicks={[off]} />
      <Sfx name="click" at={off} />
    </AbsoluteFill>
  );
}

/** A plain card standing in for a screen to record (storyboard reels). */
function Card({ children, top = 520 }: { children: ReactNode; top?: number }) {
  return <div style={{ position: "absolute", left: 70, right: 70, top, padding: 44, borderRadius: 28, background: "rgba(24,24,26,0.95)", boxShadow: "0 30px 90px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.1)", fontFamily: font, color: INK }}>{children}</div>;
}

const Bar = ({ p }: { p: number }) => (
  <div style={{ height: 10, borderRadius: 10, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
    <div style={{ width: `${p * 100}%`, height: "100%", background: INK }} />
  </div>
);

function Installer({ t, len }: { t: number; len: number }) {
  const p = prog(t, 20, len - 40, (x) => x);
  return (
    <Card top={640}>
      <div style={{ display: "flex", alignItems: "center", gap: 22 }}>
        <Mark size={64} color={INK} />
        <div>
          <div style={{ fontSize: 40, fontWeight: 700 }}>Kokon Setup</div>
          <div style={{ fontSize: 26, color: "rgba(240,240,240,0.6)" }}>Kokon_0.10.0_x64-setup.exe · 53 MB</div>
        </div>
      </div>
      <div style={{ marginTop: 40, fontSize: 28, color: "rgba(240,240,240,0.75)" }}>{p < 1 ? "Installing…" : "Done. No admin rights needed."}</div>
      <div style={{ marginTop: 18 }}>
        <Bar p={p} />
      </div>
    </Card>
  );
}

function SetupMock({ t, len }: { t: number; len: number }) {
  const rows: [string, string][] = [
    ["Engine (stable-diffusion.cpp, CUDA)", "344 MB"],
    ["Qwen-Image 2.1 Turbo", "4.1 GB"],
    ["Text encoder (Qwen3-VL 8B)", "5.0 GB"],
    ["VAE + vision", "1.4 GB"],
  ];
  const found = prog(t, 8, 12);
  return (
    <Card top={470}>
      <div style={{ fontSize: 26, color: "rgba(240,240,240,0.6)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Your graphics card</div>
      <div style={{ marginTop: 10, fontSize: 40, fontWeight: 700, opacity: found }}>✓ NVIDIA GeForce RTX 5070 Ti · 16 GB</div>
      <div style={{ marginTop: 6, fontSize: 28, color: "rgba(240,240,240,0.7)", opacity: found }}>Recommended: 16 GB preset, images up to 2K</div>
      <div style={{ marginTop: 40, display: "grid", gap: 26 }}>
        {rows.map(([name, size], i) => {
          const p = prog(t, 24 + i * 10, len - 50 - i * 10, (x) => x);
          return (
            <div key={name}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 27, marginBottom: 10 }}>
                <span>{name}</span>
                <span style={{ color: "rgba(240,240,240,0.6)" }}>{p >= 1 ? "✓ checked" : size}</span>
              </div>
              <Bar p={p} />
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 32, fontSize: 24, color: "rgba(240,240,240,0.5)" }}>Sped up · resumes if interrupted · every file checked with SHA-256</div>
    </Card>
  );
}

/** Words that land one by one and get crossed out ("No Python…"). */
function Nos({ t, at }: { t: number; at: number[] }) {
  return (
    <div style={{ position: "absolute", left: 0, right: 0, top: 640, textAlign: "center", fontFamily: font, fontSize: 92, fontWeight: 760, letterSpacing: "-0.04em", lineHeight: 1.25, color: INK }}>
      {["Python", "ComfyUI", "Settings"].map((w, i) => {
        const p = prog(t, at[i], 8);
        return (
          <div key={w} style={{ opacity: p, transform: `translateY(${(1 - p) * 20}px)`, position: "relative", display: "block" }}>
            <span style={{ position: "relative" }}>
              {w}
              <span style={{ position: "absolute", left: -10, right: -10, top: "52%", height: 10, borderRadius: 6, background: "#ff5a4e", transformOrigin: "0 50%", transform: `scaleX(${prog(t, at[i] + 6, 8)})` }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** A placeholder for Gabriele on camera: a portrait made by Kokon, gently moving. */
function Avatar({ t, box }: { t: number; box: { top: number; h: number } }) {
  return (
    <div style={{ position: "absolute", left: 0, top: box.top, width: 1080, height: box.h, overflow: "hidden" }}>
      <Img src={staticFile("img/avatar-placeholder.jpg")} style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 30%", transform: `scale(${1.04 + 0.012 * Math.sin(t / 9)}) translateY(${2 * Math.sin(t / 5)}px)` }} />
      <div style={{ position: "absolute", left: 24, bottom: 20, padding: "8px 16px", borderRadius: 999, background: "rgba(10,10,10,0.6)", fontFamily: font, fontSize: 22, color: "rgba(240,240,240,0.8)" }}>Placeholder: Gabriele on camera</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The four reels.
// ---------------------------------------------------------------------------------------------
const PP: (s: Timed) => PromptPlusTimes = (s) => {
  const w = said(s, 10, 1);
  return { ask: 0, pill: said(s, 10, 0) + 10 - s.start, send: said(s, 10, 0) + 22 - s.start, job: said(s, 10, 0) + 23 - s.start, write: w - s.start, written: saidEnd(s, 10, 1) + 6 - s.start, leave: saidEnd(s, 10, 1) + 9 - s.start, form: said(s, 11) + 6 - s.start, done: saidEnd(s, 11) - 16 - s.start, hatch: saidEnd(s, 11) - 10 - s.start, typeCps: 40 };
};

export const VREELS: Record<string, VReel> = {
  ReelOffline: {
    headline: "No internet. Still works.",
    preview: "STORYBOARD · replace with a screen recording",
    segs: [
      { lines: [1], pad: 10, shot: (t, s) => <WifiOff t={t} off={Math.round(s.len * 0.45)} /> },
      {
        lines: [2],
        pad: 14,
        shot: (t, s) => {
          const paint = said(s, 2, 1) - s.start;
          const remove = said(s, 2, 2) - s.start;
          const done = said(s, 2, 3) - s.start;
          const view = t < remove ? paintWindow(prog(t, paint - 6, remove - paint, (x) => x)) : t < done ? removeWindow(Math.round((t - remove) * 2)) : resultWindow("street-removed", null);
          const cam = t < remove ? { x: 850, y: 380, s: 1.18 } : t < done ? { x: 850, y: 770, s: 1.36 } : { x: 850, y: 330, s: 1.3 };
          return (
            <>
              <Screen cam={cam}>{view}</Screen>
              <NoInternet />
              {t >= paint - 6 && t < remove && <Sfx name="brush" at={0} dur={remove - paint} />}
              <Send at={done - 4} />
              <Sfx name="reveal" at={done + 2} />
            </>
          );
        },
      },
      {
        lines: [3],
        pad: 12,
        shot: (t, s) => (
          <>
            <Screen cam={{ x: 850, y: 330, s: 1.3 + t * 0.0008 }}>{resultWindow("street-removed", kf(t, [[0, 1], [s.len * 0.5, 0.15], [s.len, 0.55]], inOut))}</Screen>
            <NoInternet />
          </>
        ),
      },
      { lines: [4], min: 80, shot: (t) => <EndCard t={t} /> },
    ],
  },
  ReelSetup: {
    headline: "Zero setup. Really.",
    preview: "STORYBOARD · replace with a screen recording",
    segs: [
      { lines: [5], pad: 6, shot: (t, s) => <Installer t={t} len={s.len} /> },
      { lines: [6], pad: 8, shot: (t, s) => <SetupMock t={t} len={s.len} /> },
      {
        lines: [7],
        pad: 66,
        shot: (t, s) => {
          const say = said(s, 7, 3) - s.start;
          if (t < say) {
            return (
              <>
                <Screen cam={{ x: 720, y: 450, s: 0.75 }}>{cabinEdit(0, { type: 1e9, job: 1e9, hatch: 1e9 })}</Screen>
                <div style={{ position: "absolute", inset: 0, background: "rgba(5,5,5,0.78)" }} />
                <Nos t={t} at={[0, said(s, 7, 1) - s.start, said(s, 7, 2) - s.start]} />
              </>
            );
          }
          const T = { type: say + 2, job: saidEnd(s, 7, 3) - s.start + 4, hatch: s.len - 18 };
          const cam = t < T.job ? { x: 850, y: 770, s: 1.36 } : { x: 850, y: 360, s: 1.25 };
          return (
            <>
              <Screen cam={cam}>{cabinEdit(t, T)}</Screen>
              {t >= T.job && t < T.hatch && (
                <div style={{ position: "absolute", left: 0, right: 0, top: SCREEN.top + SCREEN.h + 20, textAlign: "center", fontFamily: font, fontSize: 26, color: "rgba(240,240,240,0.6)" }}>Sped up · real time about 24 s on an RTX 5070 Ti</div>
              )}
              <Send at={T.job - 1} />
              <Sfx name="reveal" at={T.hatch} />
            </>
          );
        },
      },
      { lines: [8], min: 80, shot: (t) => <EndCard t={t} /> },
    ],
  },
  ReelTour: {
    headline: "20 seconds inside Kokon",
    segs: [
      { lines: [9], pad: 8, shot: (t) => <Screen cam={{ x: 720, y: 450, s: 0.74 + t * 0.0006 }}><AppWindow state={appState({ session: [genItem(STREET), genItem(REMOVED), genItem(CAT)], selected: "street-cat", ...PROJECT(3, "gen:street-cat") })} width={1440} height={900} className="silk" /></Screen> },
      {
        lines: [10, 11],
        pad: 14,
        shot: (t, s) => {
          const C = PP(s);
          const card = promptPlusCard(t, C);
          const cam = camAt(t, [[0, { x: 850, y: 790, s: 1.38 }], [C.job - 2, { x: 850, y: 790, s: 1.38 }], [C.job + 8, { x: 850, y: 380, s: 1.02 }], [C.hatch - 4, { x: 850, y: 370, s: 1.06 }], [s.len, { x: 850, y: 350, s: 1.26 }]]);
          return (
            <>
              <Screen cam={cam}>{promptPlusView(t, C, card)}</Screen>
              <Send at={C.send} />
              <Sfx name="reveal" at={C.hatch} />
            </>
          );
        },
      },
      {
        lines: [12],
        pad: 18,
        shot: (t, s) => {
          const cut = Math.round(s.len * 0.55);
          return t < cut ? (
            <>
              <Screen cam={{ x: 850, y: 380, s: 1.18 }}>{paintWindow(prog(t, 2, cut - 8, (x) => x))}</Screen>
              <Sfx name="brush" at={2} dur={cut - 10} />
            </>
          ) : (
            <>
              <Screen cam={{ x: 850, y: 330, s: 1.3 }}>{resultWindow("street-removed", kf(t, [[cut, 1], [s.len, 0.3]], inOut))}</Screen>
              <Sfx name="reveal" at={cut} />
            </>
          );
        },
      },
      {
        lines: [13],
        pad: 14,
        shot: (t, s) => {
          const cut = said(s, 13, 1) - s.start;
          return t < cut ? (
            <Screen cam={{ x: 850, y: 560, s: 1.7 + t * 0.001 }}>{resultWindow("street-cat", null)}</Screen>
          ) : (
            <>
              <Screen cam={{ x: 850, y: 330, s: 1.3 }}>{resultWindow("street-cat", kf(t, [[cut, 0.9], [cut + 26, 0.12], [s.len, 0.55]], inOut))}</Screen>
              <Sfx name="slider" at={cut} dur={40} />
            </>
          );
        },
      },
      { lines: [14], min: 80, shot: (t) => <EndCard t={t} /> },
    ],
  },
  ReelFounder: {
    preview: "PLACEHOLDER AVATAR · Gabriele films himself",
    segs: [
      { lines: [15], pad: 6, shot: (t) => <Avatar t={t} box={{ top: 0, h: 1920 }} /> },
      { lines: [16], pad: 6, shot: (t) => <Avatar t={t + 200} box={{ top: 0, h: 1920 }} /> },
      {
        lines: [17],
        pad: 10,
        shot: (t, s) => {
          const cut = said(s, 17, 1) - s.start;
          const gone = Math.round(s.len * 0.72);
          return (
            <>
              <Avatar t={t + 400} box={{ top: 0, h: 640 }} />
              <Screen cam={t < gone ? { x: 850, y: 380, s: 1.18 } : { x: 850, y: 330, s: 1.3 }} top={660} h={1260}>
                {t < gone ? paintWindow(prog(t, cut, gone - cut - 4, (x) => x)) : resultWindow("street-removed", null)}
              </Screen>
              <Sfx name="reveal" at={gone} />
            </>
          );
        },
      },
      {
        lines: [18],
        pad: 40,
        shot: (t, s) => {
          const T = { type: 4, job: Math.round(s.len * 0.45), hatch: s.len - 14 };
          return (
            <>
              <Avatar t={t + 600} box={{ top: 0, h: 640 }} />
              <Screen cam={t < T.job ? { x: 850, y: 770, s: 1.36 } : { x: 850, y: 360, s: 1.25 }} top={660} h={1260}>
                {cabinEdit(t, T)}
              </Screen>
              <Sfx name="reveal" at={T.hatch} />
            </>
          );
        },
      },
      { lines: [19], pad: 6, shot: (t) => <Avatar t={t + 800} box={{ top: 0, h: 1920 }} /> },
      { lines: [20], min: 90, shot: (t) => (t < 40 ? <Avatar t={t + 1000} box={{ top: 0, h: 1920 }} /> : <EndCard t={t - 40} />) },
    ],
  },
};

export const vreelFrames = (r: VReel) => layout(r).total + 6;

export function VReelScene({ r }: { r: VReel }) {
  const f = useCurrentFrame();
  const { segs, total } = layout(r);
  const k = Math.max(0, segs.findIndex((s) => f < s.start + s.len));
  const s = segs[k] ?? segs[segs.length - 1];
  const ending = k === segs.length - 1;
  const music = (fr: number) => 0.13 * Math.min(1, fr / 20, Math.max(0, (total + 6 - fr) / 30));
  return (
    <AbsoluteFill style={{ background: "radial-gradient(120% 70% at 50% 35%, #1a1a1c 0%, #050505 70%)", overflow: "hidden" }}>
      <Sequence from={s.start} durationInFrames={s.len} layout="none">
        <AbsoluteFill>{r.segs[k].shot(f - s.start, s)}</AbsoluteFill>
      </Sequence>
      {r.headline && !ending && (
        <div style={{ position: "absolute", left: 50, right: 50, top: 150, textAlign: "center", fontFamily: font, fontSize: 70, fontWeight: 760, letterSpacing: "-0.04em", lineHeight: 1.05, color: INK, textShadow: "0 6px 40px rgba(0,0,0,0.7)", opacity: prog(f, 0, 10) }}>
          {r.headline}
        </div>
      )}
      {!ending && <Captions segs={segs} reel={r} />}
      {!ending && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 70, display: "flex", justifyContent: "center", alignItems: "center", gap: 12, fontFamily: font, fontSize: 30, fontWeight: 620, color: "rgba(246,246,243,0.8)" }}>
          <Mark size={30} color="rgba(246,246,243,0.85)" />
          kokon.app
        </div>
      )}
      {r.preview && (
        <div style={{ position: "absolute", left: 24, top: 40, padding: "8px 16px", borderRadius: 10, background: "rgba(255,90,78,0.92)", fontFamily: font, fontSize: 22, fontWeight: 700, color: "#fff" }}>{r.preview}</div>
      )}
      {segs.flatMap((t, i) =>
        r.segs[i].lines.map((n) => (
          <Sequence key={n} from={t.at[n]} durationInFrames={lineFrames(n) + 4} layout="none">
            <Html5Audio src={staticFile(`voice-reels/${String(n).padStart(2, "0")}.wav`)} />
          </Sequence>
        )),
      )}
      <Html5Audio src={staticFile("music-0.10-long.m4a")} volume={music} />
      {segs.slice(1).map((t) => (
        <Sfx key={t.start} name="whoosh" at={t.start - 3} gain={0.5} />
      ))}
    </AbsoluteFill>
  );
}
