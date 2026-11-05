// "Kokon 0.12": the update video for the Layers lab and painting with colours (Reddit, then
// YouTube), built on Gabriele's two screen recordings, shown whole and in order
// (app/timeline012.ts): only OBS is cut at the ends, the waits are sped up with a badge, two
// dialogs are held a moment to be read. The only camera move is a slow zoom on a detail, held,
// then back (scaled about the detail, so nothing pans). The on-screen words carry every message,
// since Reddit plays muted. Then Kokon's Mac engine (measured times) and the end card.
import { FastForward } from "lucide-react";
import { createContext, useContext, type CSSProperties, type ReactNode } from "react";
import { AbsoluteFill, Html5Audio, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";
import { Mark } from "../app/Mark";
import { inOut, prog } from "../app/motion";
import { Sfx, Voice } from "../app/sound";
import { FPS } from "../app/timeline";
import {
  at,
  BADGES,
  CAPTIONS,
  CUES_012,
  MUSIC_PIECES,
  MUSIC_SRC,
  MUSIC_XFADE,
  OPEN,
  PIECES,
  recSrc,
  RESULT_RECT,
  SHOT,
  TITLES,
  UPDATE012_FRAMES,
  ZOOM_EASE,
  ZOOMS,
  type Placed,
} from "../app/timeline012";

export { UPDATE012_FRAMES };
const font = '"Inter Variable", Inter, sans-serif';
const PAPER = "#F7F6F2";
const AMBER = "#f3c969";
/** True in the 4K composition: the 2160p recordings and stills. */
const Uhd = createContext(false);
const still = (rec: number, t: number, uhd = false) => staticFile(`rec-0.12/stills${uhd ? "-2160" : ""}/r${rec}-${Number.isInteger(t) ? t.toFixed(1) : String(Math.round(t * 100) / 100)}.png`);
const rise = (p: number): CSSProperties => ({ opacity: p, transform: `translateY(${(1 - p) * 18}px)` });
const FULL: CSSProperties = { position: "absolute", left: 0, top: 0, width: 1920, height: 1080 };

// ---------------------------------------------------------------------------------------------
// The recordings, piece by piece, under the zooms.
// ---------------------------------------------------------------------------------------------
function Piece({ p }: { p: Placed }) {
  const uhd = useContext(Uhd);
  return (
    <Sequence from={p.start} durationInFrames={p.frames} layout="none" name={"still" in p ? `rec${p.rec} hold ${p.still}` : `rec${p.rec} ${p.from}-${p.to} x${p.rate}`}>
      {"still" in p ? (
        <Img src={still(p.rec, p.still, uhd)} style={FULL} />
      ) : (
        <OffthreadVideo src={staticFile(recSrc(p.rec, uhd))} trimBefore={Math.round(p.from * FPS)} playbackRate={p.rate} muted style={FULL} />
      )}
    </Sequence>
  );
}

const ZOOM_FRAMES = ZOOMS.map((z) => ({ ...z, A: at(z.rec, z.a), B: at(z.rec, z.b) }));
function zoomAt(f: number) {
  for (const z of ZOOM_FRAMES) {
    if (f < z.A || f > z.B) continue;
    const p = Math.min(prog(f, z.A, ZOOM_EASE, inOut), 1 - prog(f, z.B - ZOOM_EASE, ZOOM_EASE, inOut));
    return { s: 1 + (z.s - 1) * p, x: z.x, y: z.y };
  }
  return { s: 1, x: 960, y: 540 };
}

function Recordings() {
  const f = useCurrentFrame();
  const z = zoomAt(f);
  return (
    <AbsoluteFill style={{ transform: `scale(${z.s})`, transformOrigin: `${z.x}px ${z.y}px` }}>
      {PIECES.map((p, i) => (
        <Piece key={i} p={p} />
      ))}
    </AbsoluteFill>
  );
}

/** Before / after on the colour result: a divider comes in from the right and stops in the middle. */
function Compare() {
  const f = useCurrentFrame();
  const uhd = useContext(Uhd);
  const from = SHOT.compare + 8;
  if (f < SHOT.compare || f >= SHOT.mac) return null;
  const p = prog(f, from, 34, inOut);
  const R = RESULT_RECT;
  const x = R.x + R.w * (1 - 0.5 * p);
  const label = (text: string, left: number, o: number) => (
    <div style={{ position: "absolute", left, top: R.y + R.h - 58, padding: "6px 14px", borderRadius: 999, background: "rgba(10,10,10,0.72)", color: PAPER, fontFamily: font, fontSize: 22, fontWeight: 600, opacity: o }}>{text}</div>
  );
  return (
    <AbsoluteFill>
      <Img src={still(2, 3, uhd)} style={{ ...FULL, clipPath: `polygon(${R.x}px ${R.y}px, ${x}px ${R.y}px, ${x}px ${R.y + R.h}px, ${R.x}px ${R.y + R.h}px)` }} />
      <div style={{ position: "absolute", left: x - 1.5, top: R.y, width: 3, height: R.h, background: PAPER, opacity: p > 0 ? 1 : 0, boxShadow: "0 0 12px rgba(0,0,0,0.5)" }} />
      {label("Before", R.x + 16, prog(f, from + 26, 12))}
      {label("After", R.x + R.w - 92, prog(f, from + 26, 12))}
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------------
// Words on screen.
// ---------------------------------------------------------------------------------------------
function Badge() {
  const f = useCurrentFrame();
  const b = BADGES.find((x) => f >= x.start && f < x.end);
  if (!b) return null;
  const o = Math.min(prog(f, b.start, 8), 1 - prog(f, b.end - 8, 8));
  return (
    <div style={{ position: "absolute", right: 196, bottom: 40, display: "flex", alignItems: "center", gap: 8, padding: "10px 18px", borderRadius: 999, background: "rgba(10,10,10,0.8)", border: "1px solid rgba(255,255,255,0.12)", color: PAPER, fontFamily: font, fontSize: 30, fontWeight: 650, opacity: o }}>
      <FastForward size={26} fill={PAPER} strokeWidth={0} />
      {b.rate}×
    </div>
  );
}

const TITLE_FRAMES = 72;
function Titles() {
  const f = useCurrentFrame();
  const t = TITLES.map((x) => ({ ...x, f0: at(x.rec, x.t) })).find((x) => f >= x.f0 && f < x.f0 + TITLE_FRAMES);
  if (!t) return null;
  const o = Math.min(prog(f, t.f0, 12, inOut), 1 - prog(f, t.f0 + TITLE_FRAMES - 12, 12, inOut));
  return (
    <AbsoluteFill style={{ background: `rgba(5,5,5,${0.55 * o})`, alignItems: "center", justifyContent: "center", fontFamily: font, color: PAPER }}>
      <div style={{ display: "flex", alignItems: "center", gap: 26, ...rise(o) }}>
        <span style={{ fontSize: 96, fontWeight: 650, letterSpacing: "-0.04em", textShadow: "0 6px 40px rgba(0,0,0,0.6)" }}>{t.text}</span>
        {t.tag && <span style={{ padding: "8px 20px", borderRadius: 999, background: "rgba(243,201,105,0.16)", color: AMBER, fontSize: 36, fontWeight: 600 }}>{t.tag}</span>}
      </div>
    </AbsoluteFill>
  );
}

function Captions() {
  const f = useCurrentFrame();
  const c = CAPTIONS.map((x) => ({ ...x, A: at(x.rec, x.a), B: at(x.rec, x.b) })).find((x) => f >= x.A && f < x.B);
  if (!c) return null;
  const o = Math.min(prog(f, c.A, 12), 1 - prog(f, c.B - 10, 10, inOut));
  return (
    <div style={{ position: "absolute", left: 196, bottom: 44, maxWidth: 400, padding: "18px 22px", borderRadius: 18, background: "rgba(12,12,12,0.82)", border: "1px solid rgba(255,255,255,0.08)", fontFamily: font, color: PAPER, ...rise(o) }}>
      <div style={{ fontSize: 34, fontWeight: 650, letterSpacing: "-0.025em", lineHeight: 1.12 }}>{c.title}</div>
      {c.sub && <div style={{ marginTop: 8, fontSize: 22, lineHeight: 1.3, color: "rgba(247,246,242,0.72)" }}>{c.sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Opening, the Mac engine, the end card.
// ---------------------------------------------------------------------------------------------
function KokonTitle({ version, size = 1 }: { version: string; size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 30 * size }}>
      <Mark size={104 * size} color={PAPER} />
      <span style={{ fontSize: 116 * size, fontWeight: 620, letterSpacing: "-0.045em", lineHeight: 1 }}>Kokon</span>
      <span style={{ padding: `${8 * size}px ${20 * size}px ${11 * size}px`, borderRadius: 999, border: `${3 * size}px solid ${PAPER}`, fontSize: 56 * size, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>{version}</span>
    </div>
  );
}

/** The poster as the recording starts, close, with the title; then back to the whole window. */
function Opening() {
  const f = useCurrentFrame();
  const uhd = useContext(Uhd);
  if (f >= OPEN) return null;
  const back = prog(f, OPEN - 36, 36, inOut);
  const title = Math.min(prog(f, 4, 22), 1 - prog(f, OPEN - 40, 14, inOut));
  return (
    <AbsoluteFill style={{ background: "#050505" }}>
      <Img src={still(1, 29 / 30, uhd)} style={{ ...FULL, transform: `scale(${2.1 - 1.1 * back})`, transformOrigin: "960px 400px" }} />
      <AbsoluteFill style={{ background: `radial-gradient(ellipse at 50% 55%, rgba(5,5,5,${0.72 * title}) 0%, rgba(5,5,5,${0.4 * title}) 60%, transparent 100%)` }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", fontFamily: font, color: PAPER }}>
        <div style={rise(title)}>
          <KokonTitle version="0.12" />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** Measured on the same Mac (wiki/engineering.md "Bench 10-25" and the 10-26/10-27 reports). */
const MAC_ROWS = [
  { name: "Kokon 0.11", sub: "stable-diffusion.cpp", s: 276, label: "276 s" },
  { name: "Kokon 0.12", sub: "Kokon's Mac engine", s: 65, label: "~65 s", ours: true },
  { name: "Draw Things", sub: "4-bit", s: 150, label: "~150 s" },
  { name: "mflux", sub: "4-bit", s: 158, label: "158 s" },
];
function MacEngine() {
  const f = useCurrentFrame() - SHOT.mac;
  if (f < 0 || f >= SHOT.close - SHOT.mac) return null;
  const head = prog(f, 0, 22);
  const out = prog(f, SHOT.close - SHOT.mac - 12, 12, inOut);
  const MAXW = 860;
  return (
    <AbsoluteFill style={{ background: "#050505", fontFamily: font, color: PAPER, opacity: 1 - out }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 30% 30%, rgba(247,246,242,0.05) 0%, transparent 50%)" }} />
      <div style={{ position: "absolute", left: 180, top: 150, ...rise(head) }}>
        <div style={{ fontSize: 60, fontWeight: 650, letterSpacing: "-0.035em" }}>Kokon's own Mac engine, now the default on Macs</div>
        <div style={{ marginTop: 18, fontSize: 32, color: "rgba(247,246,242,0.75)" }}>M2 Pro 16 GB · 1024² · Qwen-Image 2.1 Turbo, 8 steps</div>
      </div>
      <div style={{ position: "absolute", left: 180, top: 400, display: "flex", flexDirection: "column", gap: 34 }}>
        {MAC_ROWS.map((r, i) => {
          const p = prog(f, 20 + i * 8, 40, inOut);
          const n = prog(f, 44 + i * 8, 14);
          return (
            <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 36, ...rise(prog(f, 10 + i * 8, 18)) }}>
              <div style={{ width: 420 }}>
                <div style={{ fontSize: 38, fontWeight: r.ours ? 700 : 560, letterSpacing: "-0.02em" }}>{r.name}</div>
                <div style={{ fontSize: 24, color: "rgba(247,246,242,0.6)" }}>{r.sub}</div>
              </div>
              <div style={{ width: (MAXW * r.s * p) / 276, height: 46, borderRadius: 12, background: r.ours ? PAPER : "rgba(247,246,242,0.22)" }} />
              <div style={{ fontSize: 38, fontWeight: r.ours ? 700 : 560, opacity: n, fontVariantNumeric: "tabular-nums" }}>{r.label}</div>
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 180, top: 910, fontSize: 26, color: "rgba(247,246,242,0.55)", opacity: prog(f, 80, 20) }}>Time for one image, measured on the same Mac. Lower is better.</div>
    </AbsoluteFill>
  );
}

function Close() {
  const f = useCurrentFrame() - SHOT.close;
  if (f < 0) return null;
  const a = prog(f, 0, 24);
  const b = prog(f, 10, 22);
  const c = prog(f, 22, 22);
  const fade = prog(f, UPDATE012_FRAMES - SHOT.close - 20, 20, inOut);
  return (
    <AbsoluteFill style={{ background: "#050505", fontFamily: font, color: PAPER, opacity: 1 - fade }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 40%, rgba(247,246,242,0.06) 0%, transparent 45%)" }} />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", flexDirection: "column" }}>
        <div style={rise(a)}>
          <KokonTitle version="0.12" />
        </div>
        <div style={{ marginTop: 44, fontSize: 46, fontWeight: 600, letterSpacing: "-0.02em", ...rise(b) }}>kokon.app</div>
        <div style={{ marginTop: 16, fontSize: 30, color: "rgba(247,246,242,0.8)", ...rise(b) }}>Windows · macOS · Linux</div>
        <div style={{ marginTop: 10, fontSize: 26, color: "rgba(247,246,242,0.6)", ...rise(b) }}>12 GB GPU (8 GB in beta), NVIDIA or AMD, or Apple Silicon</div>
        <div style={{ marginTop: 40, padding: "16px 34px", borderRadius: 999, background: PAPER, color: "#0d0d0d", fontSize: 34, fontWeight: 650, letterSpacing: "-0.02em", ...rise(c) }}>Free, local, open source</div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}

/** A short dip through black between the two recordings. */
function Dip({ at: f0, half = 8 }: { at: number; half?: number }) {
  const f = useCurrentFrame();
  const d = Math.abs(f - f0);
  if (d >= half) return null;
  return <AbsoluteFill style={{ background: "#050505", opacity: 1 - d / half }} />;
}

// ---------------------------------------------------------------------------------------------
// Sound: the music in whole phrases (timeline012 MUSIC_PIECES), the voice, two soft hits.
// ---------------------------------------------------------------------------------------------
/** The music's level under the voice: one steady background, as in 0.11 (a little lower: the voice
 * talks over most of this video). */
const MUSIC_GAIN = 0.4;
const LEVEL_MUSIC = 0.62; // sound.tsx LEVEL.music
function Music() {
  const X = MUSIC_XFADE;
  const last = MUSIC_PIECES.length - 1;
  return (
    <>
      {MUSIC_PIECES.map((p, i) => {
        let start = p.at - (i > 0 ? X : 0);
        let from = p.from - (i > 0 ? X / FPS : 0);
        let frames = p.frames + (i > 0 ? X : 0) + (i < last ? X : 0);
        if (start < 0) {
          from -= start / FPS;
          frames += start;
          start = 0;
        }
        frames = Math.min(frames, UPDATE012_FRAMES - start);
        if (frames <= 0) return null;
        const head = i > 0 && p.at - X >= 0;
        return (
          <Sequence key={i} from={start} durationInFrames={frames} layout="none" name={`music ${p.from.toFixed(2)}s`}>
            <Html5Audio
              src={staticFile(MUSIC_SRC)}
              trimBefore={Math.round(from * FPS)}
              volume={(f) => {
                const fin = head ? Math.min(1, f / (2 * X)) : 1;
                const fout = i < last ? Math.min(1, (frames - f) / (2 * X)) : 1;
                const end = Math.min(1, Math.max(0, (UPDATE012_FRAMES - (start + f)) / 45));
                return LEVEL_MUSIC * MUSIC_GAIN * Math.sqrt(Math.max(0, fin)) * Math.sqrt(Math.max(0, fout)) * end;
              }}
            />
          </Sequence>
        );
      })}
    </>
  );
}

const Shot = ({ from, to, children }: { from: number; to: number; children: ReactNode }) => {
  const f = useCurrentFrame();
  return f >= from && f < to ? <>{children}</> : null;
};

/** `uhd`: the 4K render (Update012UHD, `--scale=2`) reads the 2160p recordings. */
export function Update012({ uhd = false }: { uhd?: boolean }) {
  return (
    <Uhd.Provider value={uhd}>
    <AbsoluteFill style={{ background: "#050505" }}>
      <Shot from={SHOT.rec1} to={SHOT.mac}>
        <Recordings />
        <Compare />
        <Captions />
        <Badge />
        <Titles />
        <Dip at={SHOT.rec2} />
      </Shot>
      <Opening />
      <MacEngine />
      <Close />
      <Sfx name="hit" at={6} gain={0.4} />
      <Sfx name="hit" at={SHOT.close} gain={0.35} />
      <Voice cues={CUES_012} />
      <Music />
    </AbsoluteFill>
    </Uhd.Provider>
  );
}
