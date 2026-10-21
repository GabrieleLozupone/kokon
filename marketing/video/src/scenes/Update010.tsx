// "Kokon 0.10": a 40-second update video from the launch film's pieces (Reddit, YouTube, the
// site). Prompt+ first (a few words, the prompt written, the image hatching on the drop), then
// why nothing new is needed (one model, two jobs), the user's own LoRAs (beta), the new look,
// and the end card. Shots hold still or push in slowly and change by cutting on the beat
// (app/timeline010.ts). The on-screen words carry every message, since Reddit plays muted.
import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { siGithub } from "simple-icons";
import { AppWindow } from "../app/AppWindow";
import { appState, genItem, jobItem, LORA, PROJECTS, PROMPTS, settingsState } from "../app/fixtures";
import { FullImage } from "../app/FullImage";
import { Mark, MARK_PATHS } from "../app/Mark";
import { Backdrop, type Cam, Camera, Caption, DepthOfField, Dissolve, inOut, prog, Pointer, typingDone, Vignette } from "../app/motion";
import { Music, Send, Sfx, Voice } from "../app/sound";
import { FPS } from "../app/timeline";
import { beat, CUES_010, LORA_CLICK, MUSIC, PROMPT, said, SHOT, STOP, UPDATE_FRAMES, VOICE_READY, word } from "../app/timeline010";
import { CardMotionContext, type CardMotion } from "../mocks/card";
import { Hatch } from "../mocks/Cocoon";
import type { State } from "../mocks/store";
import { CARD_CAM, CAT, LOGO_CAM, PILL, PROMPT_CAM, promptPlusCard, promptPlusView, REMOVED, SEND, STREET, Words } from "./AppScenes";

export { UPDATE_FRAMES };
const font = '"Inter Variable", Inter, sans-serif';
const PAPER = "#F7F6F2";

/** Shows `children` from frame `from` (inclusive) to `to` (exclusive): one shot. */
const Shot = ({ from, to, children }: { from: number; to: number; children: ReactNode }) => {
  const f = useCurrentFrame();
  return f >= from && f < to ? <>{children}</> : null;
};

/** A slow push from scale `a` to `b` over the shot. */
const push = (f: number, from: number, to: number, a: number, b: number) => a + (b - a) * prog(f, from, to - from, (x) => x);

// ---------------------------------------------------------------------------------------------
// Title: the mark assembles, "Kokon", and the release.
// ---------------------------------------------------------------------------------------------
function Title() {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sp = (delay: number, damping = 14) => spring({ frame: f - delay, fps, config: { damping, mass: 0.8, stiffness: 110 } });
  const stem = sp(2, 18);
  const upper = sp(10);
  const lower = sp(16);
  const shift = prog(f, 26, 22, inOut);
  const word = prog(f, 30, 22);
  const badge = spring({ frame: f - beat(3), fps, config: { damping: 12, mass: 0.6, stiffness: 160 } });
  const tag = prog(f, beat(4), 18);
  const size = 150;
  return (
    <AbsoluteFill style={{ background: "#050505", alignItems: "center", justifyContent: "center", fontFamily: font }}>
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(circle at 50% 46%, rgba(247,246,242,${0.07 * stem}) 0%, transparent 45%)` }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 38, transform: `scale(${1 + prog(f, 0, SHOT.composer, (x) => x) * 0.04})` }}>
        <div style={{ display: "flex", alignItems: "center", gap: interpolate(shift, [0, 1], [0, 40]) }}>
          <svg width={size} height={size} viewBox="0 0 1024 1024" style={{ overflow: "visible" }}>
            <path d={MARK_PATHS.stem} fill={PAPER} style={{ transformOrigin: "175px 1000px", transform: `translateY(${(1 - stem) * 160}px) scaleY(${0.5 + stem * 0.5})`, opacity: stem }} />
            <path d={MARK_PATHS.upper} fill={PAPER} style={{ transformOrigin: "390px 549px", transform: `rotate(${(1 - upper) * -70}deg) scale(${upper})`, opacity: Math.min(1, upper * 2) }} />
            <path d={MARK_PATHS.lower} fill={PAPER} style={{ transformOrigin: "390px 587px", transform: `rotate(${(1 - lower) * 60}deg) scale(${lower})`, opacity: Math.min(1, lower * 2) }} />
          </svg>
          <div style={{ overflow: "hidden", width: interpolate(shift, [0, 1], [0, 720]), height: size + 20, display: "flex", alignItems: "center", gap: 30 }}>
            <span style={{ fontSize: 156, fontWeight: 620, color: PAPER, letterSpacing: "-0.045em", lineHeight: 1, transform: `translateX(${(1 - word) * -60}px)`, opacity: word, whiteSpace: "nowrap" }}>Kokon</span>
            <span
              style={{
                padding: "10px 26px 14px",
                borderRadius: 999,
                border: `3px solid ${PAPER}`,
                color: PAPER,
                fontSize: 74,
                fontWeight: 600,
                letterSpacing: "-0.03em",
                lineHeight: 1,
                opacity: Math.min(1, badge * 1.5),
                transform: `scale(${0.6 + 0.4 * badge})`,
                whiteSpace: "nowrap",
              }}
            >
              0.10
            </span>
          </div>
        </div>
        <div style={{ fontSize: 40, fontWeight: 450, color: "rgba(247,246,242,0.78)", letterSpacing: "-0.02em", opacity: tag, transform: `translateY(${(1 - tag) * 18}px)`, filter: `blur(${(1 - tag) * 6}px)` }}>
          Prompt+ · your own LoRAs · a new look
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------------
// Prompt+: a few words typed, Prompt+ on, Send. The card: the prompt is written, the percentage,
// the logo forms; on the drop the image hatches full frame. Then "One model. Two jobs."
// ---------------------------------------------------------------------------------------------
/** The card while the image is made: the whole card, pulled back from the writing shot. */
const MAKING_CAM: Cam = { x: 852, y: 430, s: 1.4 };
const PROMPT_FOCUS: [number, number] = [800, 1050];

function PromptPlus() {
  const f = useCurrentFrame();
  const P = PROMPT;
  const card = promptPlusCard(f, P);
  const onCard = f >= SHOT.card;
  const cam: Cam = !onCard
    ? { ...PROMPT_CAM, s: push(f, SHOT.composer, SHOT.card, 1.7, 1.84) }
    : f < SHOT.making
      ? { ...CARD_CAM, s: push(f, SHOT.card, SHOT.making, 1.5, 1.6) }
      : f < SHOT.logo
        ? { ...MAKING_CAM, s: push(f, SHOT.making, SHOT.logo, 1.4, 1.46) }
        : LOGO_CAM;
  const app = (
    <Camera cam={cam} free={!onCard}>
      {promptPlusView(f, P, card)}
      {!onCard && (
        <Pointer
          path={[
            [SHOT.composer + 30, 980, 960],
            [P.pill - 2, PILL[0], PILL[1]],
            [P.send - 10, 1120, 880],
            [P.send - 1, SEND[0], SEND[1]],
          ]}
          clicks={[P.pill, P.send]}
          hideBefore={SHOT.composer + 30}
        />
      )}
    </Camera>
  );
  return (
    <AbsoluteFill>
      <Backdrop />
      {!onCard ? <DepthOfField focus={PROMPT_FOCUS} blur={7}>{app}</DepthOfField> : app}
      <Vignette strength={onCard ? 0.75 : 0} />
      <Caption title="Type a few words." start={SHOT.composer + 6} end={SHOT.card - 2} y={150} size={52} />
      <Caption title="Prompt+ writes the full prompt." sub="Off by default · one click in the composer · any language" start={P.write} end={SHOT.making - 2} y={890} size={52} />
      <Caption title="Then Kokon makes the image." sub="Qwen-Image 2.1 Turbo on your own GPU (sped up here)" start={SHOT.making + 4} end={SHOT.logo} y={890} size={52} />
    </AbsoluteFill>
  );
}

/** The image hatching full frame from the card's logo, held under "One model. Two jobs." */
function Hatched() {
  const f = useCurrentFrame();
  const card = promptPlusCard(f, PROMPT);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", inset: 0, isolation: "isolate" }}>
        <CardMotionContext.Provider value={card}>
          <Hatch aspect={1920 / 1080} fill>
            <FullImage before="street" push={push(f, SHOT.hatch, SHOT.model, 1, 1.04)} dim={0.42 * prog(f, said(3, 0) - 8, 12)} />
          </Hatch>
        </CardMotionContext.Provider>
      </div>
      <Words
        items={[
          { text: "One model.", at: said(3, 0) },
          { text: "Two jobs.", at: word(3, 0, "two") },
        ]}
        end={SHOT.model + 6}
      />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------------
// One model, two jobs: Qwen3-VL 8B is already loaded as Qwen-Image 2.1's text encoder; Prompt+
// asks it to write. Silk threads run from your words into it and out to its two jobs.
// ---------------------------------------------------------------------------------------------
/** A thread of silk from (x0, y0) to (x1, y1): a few strands, drawn in over `p` (0–1). */
function Thread({ x0, y0, x1, y1, p, glow = 0 }: { x0: number; y0: number; x1: number; y1: number; p: number; glow?: number }) {
  const strands = [0, 1, 2, 3];
  const mx = (x0 + x1) / 2;
  return (
    <g style={{ filter: glow > 0 ? `drop-shadow(0 0 ${10 * glow}px rgba(247,246,242,${0.8 * glow}))` : undefined }}>
      {strands.map((i) => {
        const w = (i - 1.5) * 7;
        const d = `M ${x0} ${y0} C ${mx} ${y0 + w}, ${mx} ${y1 - w}, ${x1} ${y1}`;
        return <path key={i} d={d} pathLength={1} fill="none" stroke={PAPER} strokeOpacity={i === 1 ? 0.95 : 0.35} strokeWidth={i === 1 ? 2.4 : 1.2} strokeDasharray="1 1" strokeDashoffset={1 - p} strokeLinecap="round" />;
      })}
    </g>
  );
}

const glass: CSSProperties = {
  position: "absolute",
  borderRadius: 26,
  background: "linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.025))",
  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1), 0 40px 100px rgba(0,0,0,0.5)",
  color: PAPER,
  fontFamily: font,
};

function OneModel() {
  const f = useCurrentFrame();
  const t0 = SHOT.model;
  const show = (at: number, dur = 26) => prog(f, at, dur);
  const rise = (p: number): CSSProperties => ({ opacity: p, transform: `translateY(${(1 - p) * 24}px)`, filter: `blur(${(1 - p) * 8}px)` });
  const reads = word(3, 1, "reads");
  const writes = word(3, 1, "writes");
  const none = said(3, 2);
  const a = show(t0 + 2);
  const b = show(t0 + 12);
  const thIn = prog(f, t0 + 8, 30, inOut);
  const thRead = prog(f, reads, 28, inOut);
  const thWrite = prog(f, writes, 28, inOut);
  const newGlow = Math.min(prog(f, writes + 12, 10), 1 - 0.6 * prog(f, writes + 30, 30));
  const s = push(f, t0, SHOT.settings, 1, 1.035);
  return (
    <AbsoluteFill style={{ fontFamily: font }}>
      <Backdrop glow={0.9} />
      <div style={{ position: "absolute", inset: 0, transform: `scale(${s})` }}>
        <div style={{ position: "absolute", top: 96, left: 0, right: 0, textAlign: "center", fontSize: 76, fontWeight: 660, letterSpacing: "-0.045em", color: "#f4f4f2", ...rise(show(t0, 18)) }}>One model. Two jobs.</div>
        <svg width={1920} height={1080} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
          <Thread x0={460} y0={540} x1={640} y1={540} p={thIn} />
          <Thread x0={1120} y0={500} x1={1250} y1={400} p={thRead} />
          <Thread x0={1120} y0={580} x1={1250} y1={690} p={thWrite} glow={newGlow} />
        </svg>
        {/* your words */}
        <div style={{ ...glass, left: 90, top: 480, width: 370, padding: "22px 26px", ...rise(a) }}>
          <div style={{ fontSize: 18, color: "rgba(247,246,242,0.55)", marginBottom: 8 }}>Your words</div>
          <div style={{ fontSize: 26, fontWeight: 560, letterSpacing: "-0.02em" }}>sunny italian street, café, red scooter</div>
        </div>
        {/* the model */}
        <div style={{ ...glass, left: 640, top: 400, width: 480, height: 280, padding: "34px 36px", display: "flex", flexDirection: "column", justifyContent: "center", ...rise(b) }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
            <Mark size={44} color={PAPER} />
            <span style={{ fontSize: 46, fontWeight: 660, letterSpacing: "-0.035em" }}>Qwen3-VL 8B</span>
          </div>
          <div style={{ marginTop: 16, fontSize: 23, lineHeight: 1.35, color: "rgba(247,246,242,0.7)" }}>The text encoder Qwen-Image 2.1 already loads. Same engine, same memory.</div>
        </div>
        {/* its two jobs */}
        <div style={{ ...glass, left: 1250, top: 340, width: 580, padding: "20px 26px", ...rise(show(reads + 6)) }}>
          <div style={{ fontSize: 30, fontWeight: 620, letterSpacing: "-0.02em" }}>Reads your prompt</div>
          <div style={{ fontSize: 20, color: "rgba(247,246,242,0.6)", marginTop: 6 }}>so the image follows it, as always</div>
        </div>
        <div style={{ ...glass, left: 1250, top: 630, width: 580, padding: "20px 26px", boxShadow: `inset 0 0 0 ${1 + newGlow}px rgba(247,246,242,${0.12 + 0.6 * newGlow}), 0 40px 100px rgba(0,0,0,0.5), 0 0 ${60 * newGlow}px rgba(247,246,242,${0.25 * newGlow})`, ...rise(show(writes + 6)) }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 30, fontWeight: 620, letterSpacing: "-0.02em" }}>Writes your prompt</span>
            <span style={{ fontSize: 17, fontWeight: 650, padding: "4px 11px", borderRadius: 999, background: PAPER, color: "#0d0d0d" }}>NEW · Prompt+</span>
          </div>
          <div style={{ fontSize: 20, color: "rgba(247,246,242,0.6)", marginTop: 6 }}>a full prompt from your few words</div>
        </div>
        <div style={{ position: "absolute", top: 880, left: 0, right: 0, textAlign: "center", fontSize: 50, fontWeight: 640, letterSpacing: "-0.03em", color: "#f4f4f2", ...rise(show(none - 2, 24)) }}>
          No second model to download.
        </div>
      </div>
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------------
// LoRA (beta): load one in Settings, then one click on the LoRA pill turns it on.
// ---------------------------------------------------------------------------------------------
/** "Load a LoRA…" in Settings, and the LoRA pill in a project's composer (window px, measured
 * with the Layout composition at 1:1). */
const LOAD_BTN: [number, number] = [988, 271];
const LORA_PILL: [number, number] = [932, 853];
const SETTINGS_CAM = { x: 640, y: 450 };
const PILL_CAM: Cam = { x: 880, y: 770, s: 1.9 };
const PILL_FOCUS: [number, number] = [560, 860];
const clickLoad = LORA_CLICK.load;
const loaded = clickLoad + 8;
const clickPill = LORA_CLICK.pill;

function Lora() {
  const f = useCurrentFrame();
  const project = { session: [genItem(STREET)], selected: "street", projects: [{ id: "current", title: "Italian street café", updatedAt: Date.now() - 20_000, cover: "gen:street", count: 1 }, ...PROJECTS], projectId: "current" };
  const settings = (t: number) => {
    const state = settingsState({ ...project, loras: t >= loaded ? [LORA] : [] });
    return <AppWindow state={state} width={1440} height={900} />;
  };
  const inSettings = f < SHOT.pill;
  const base = appState();
  const pillState: State = appState({ ...project, loras: [LORA], composer: { ...base.composer, prompt: PROMPTS.idea, loras: f >= clickPill ? [LORA.id] : null } });
  return (
    <AbsoluteFill>
      <Backdrop />
      {inSettings ? (
        <Camera cam={{ ...SETTINGS_CAM, s: push(f, SHOT.settings, SHOT.pill, 1.48, 1.54) }}>
          <Dissolve frame={f} cuts={[loaded]} view={settings} dur={8} />
          <Pointer path={[[SHOT.settings + 4, 1180, 560], [clickLoad - 2, LOAD_BTN[0], LOAD_BTN[1]], [clickLoad + 20, LOAD_BTN[0] + 40, LOAD_BTN[1] + 140]]} clicks={[clickLoad]} hideBefore={SHOT.settings + 4} hideAfter={clickLoad + 22} />
        </Camera>
      ) : (
        <DepthOfField focus={PILL_FOCUS} blur={6}>
          <Camera cam={{ ...PILL_CAM, s: push(f, SHOT.pill, SHOT.look, 1.9, 2.02) }} free>
            <AppWindow state={pillState} width={1440} height={900} />
            <Pointer path={[[SHOT.pill + 4, 1080, 960], [clickPill - 2, LORA_PILL[0], LORA_PILL[1]], [SHOT.look, LORA_PILL[0] + 14, LORA_PILL[1] + 30]]} clicks={[clickPill]} hideBefore={SHOT.pill + 4} />
          </Camera>
        </DepthOfField>
      )}
      <Vignette side="left" strength={inSettings ? 0.75 : 0} reach={0.7} />
      {!inSettings && <Vignette side="top" strength={0.6} reach={0.6} />}
      <Caption title="Your own LoRAs." sub="Beta · load a Qwen-Image 2.1 LoRA once, in Settings" start={SHOT.settings + 4} end={SHOT.pill} x={60} y={430} size={50} maxWidth={420} />
      <Caption title="One click turns it on." sub="Per project · tested on Windows · no catalog yet" start={SHOT.pill + 4} end={SHOT.look} x={96} y={130} size={52} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------------
// The new look: the window whole, its own title bar, the silk where things move.
// ---------------------------------------------------------------------------------------------
const LOOK_PROJECT = { projects: [{ id: "current", title: "Italian street café", updatedAt: Date.now() - 20_000, cover: "gen:street-cat", count: 3 }, ...PROJECTS], projectId: "current" };

function NewLook() {
  const f = useCurrentFrame();
  const base = appState();
  const idle = appState({ session: [genItem(STREET), genItem(REMOVED), genItem(CAT)], selected: "street-cat", ...LOOK_PROJECT });
  // A fourth version being made: the status capsule spins its silk, a thread runs round it.
  const j = jobItem("j-look", "edit", "Make it golden hour", "street-cat", "street-cat", 3);
  const making = appState({ session: [genItem(STREET), genItem(REMOVED), genItem(CAT), j.item], selected: "street-cat", jobs: { "j-look": j.job }, ...LOOK_PROJECT, composer: { ...base.composer } });
  const card: CardMotion = { t: (f - SHOT.bar) / FPS + 4, pctAt: (t) => Math.min(96, 20 + t * 7) };
  const words = prog(f, SHOT.look + 2, 16);
  let shot: ReactNode;
  if (f < SHOT.bar) {
    shot = (
      <Camera cam={{ x: 720, y: 400, s: push(f, SHOT.look, SHOT.bar, 0.9, 0.93) }}>
        <AppWindow state={idle} width={1440} height={900} className="silk" />
      </Camera>
    );
  } else if (f < SHOT.silk) {
    shot = (
      <Camera cam={{ x: 1010, y: 150, s: push(f, SHOT.bar, SHOT.silk, 2.0, 2.08) }} free>
        <AppWindow state={making} width={1440} height={900} card={card} />
      </Camera>
    );
  } else {
    shot = (
      <Camera cam={{ x: 848, y: 600, s: push(f, SHOT.silk, SHOT.end, 2.3, 2.4) }} free>
        <AppWindow state={making} width={1440} height={900} card={card} />
      </Camera>
    );
  }
  return (
    <AbsoluteFill>
      <Backdrop />
      {shot}
      {f < SHOT.bar && (
        <div style={{ position: "absolute", top: 40, left: 0, right: 0, textAlign: "center", fontFamily: font, fontSize: 76, fontWeight: 660, letterSpacing: "-0.045em", color: "#f4f4f2", opacity: words, transform: `translateY(${(1 - words) * 24}px)`, filter: `blur(${(1 - words) * 8}px)` }}>
          A new look.
        </div>
      )}
      {f >= SHOT.bar && <Vignette strength={0.8} />}
      <Caption title="Its own title bar." sub="Calmer, deeper, in light and dark" start={SHOT.bar + 2} end={SHOT.silk} y={900} size={52} />
      <Caption title="Spun from silk." sub="Threads show what's being made" start={SHOT.silk + 2} end={SHOT.end} y={900} size={52} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------------
// End card.
// ---------------------------------------------------------------------------------------------
function End() {
  const f = useCurrentFrame();
  const t = SHOT.end;
  const a = prog(f, t, 28);
  const b = prog(f, t + 16, 22);
  const c = prog(f, said(6, 1) - 4, 20);
  const fade = prog(f, UPDATE_FRAMES - 20, 20, inOut);
  return (
    <AbsoluteFill style={{ fontFamily: font, background: "#050505", alignItems: "center", justifyContent: "center", opacity: 1 - fade }}>
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(circle at 50% 42%, rgba(247,246,242,0.06) 0%, transparent 45%)" }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30, marginTop: -40 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 34, opacity: a, transform: `scale(${0.94 + a * 0.06})`, filter: `blur(${(1 - a) * 8}px)` }}>
          <Mark size={120} color={PAPER} />
          <span style={{ fontSize: 128, fontWeight: 620, color: PAPER, letterSpacing: "-0.045em", lineHeight: 1 }}>Kokon</span>
          <span style={{ padding: "8px 22px 12px", borderRadius: 999, border: `3px solid ${PAPER}`, color: PAPER, fontSize: 60, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1 }}>0.10</span>
        </div>
        <div style={{ fontSize: 40, color: "rgba(247,246,242,0.82)", letterSpacing: "-0.02em", opacity: b, transform: `translateY(${(1 - b) * 14}px)` }}>Free and open source · Windows · macOS · Linux</div>
        <div style={{ marginTop: 18, padding: "18px 40px", borderRadius: 999, background: PAPER, color: "#0d0d0d", fontSize: 34, fontWeight: 650, letterSpacing: "-0.02em", opacity: c, transform: `translateY(${(1 - c) * 14}px)` }}>kokon.app</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 24, color: "rgba(247,246,242,0.62)", opacity: c, transform: `translateY(${(1 - c) * 14}px)` }}>
          <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
            <path d={siGithub.path} fill="rgba(247,246,242,0.62)" />
          </svg>
          github.com/GabrieleLozupone/kokon
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** Every effect, on the main timeline (the shots unmount when they end, a sound must not). */
function Sounds() {
  const T0 = PROMPT.ask + 2;
  const T1 = typingDone(PROMPTS.idea, T0, PROMPT.typeCps);
  return (
    <>
      <Sfx name="hit" at={beat(3)} gain={0.55} />
      <Sfx name="typing" at={T0} dur={T1 - T0} />
      <Sfx name="click" at={PROMPT.pill} />
      <Send at={PROMPT.send} />
      <Sfx name="riser" at={SHOT.hatch - 40} gain={0.8} />
      <Sfx name="reveal" at={SHOT.hatch + 6} variant={0} />
      <Sfx name="whoosh" at={SHOT.model} gain={0.7} />
      <Sfx name="click" at={clickLoad} />
      <Sfx name="reveal" at={loaded + 2} variant={1} gain={0.6} />
      <Sfx name="click" at={clickPill} />
      <Sfx name="whoosh" at={SHOT.look} gain={0.5} />
      <Sfx name="hit" at={SHOT.end} gain={0.5} />
      <Sfx name="hit" at={STOP} gain={0.7} />
    </>
  );
}

export function Update010() {
  return (
    <AbsoluteFill style={{ background: "#050505" }}>
      <Shot from={SHOT.title} to={SHOT.composer}>
        <Title />
      </Shot>
      <Shot from={SHOT.composer} to={SHOT.hatch}>
        <PromptPlus />
      </Shot>
      <Shot from={SHOT.hatch} to={SHOT.model}>
        <Hatched />
      </Shot>
      <Shot from={SHOT.model} to={SHOT.settings}>
        <OneModel />
      </Shot>
      <Shot from={SHOT.settings} to={SHOT.look}>
        <Lora />
      </Shot>
      <Shot from={SHOT.look} to={SHOT.end}>
        <NewLook />
      </Shot>
      <Shot from={SHOT.end} to={UPDATE_FRAMES}>
        <End />
      </Shot>
      <Sounds />
      {VOICE_READY && <Voice cues={CUES_010} />}
      <Music frames={UPDATE_FRAMES} cues={VOICE_READY ? CUES_010 : []} src={MUSIC.src} from={MUSIC.from} fadeOut={30} />
    </AbsoluteFill>
  );
}
