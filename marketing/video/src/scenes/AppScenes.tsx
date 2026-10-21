// The app in use, through its own components: create an image from a sentence, paint an area
// and remove what is in it, add something, and the version timeline. The voice leads: each
// action lands on the sentence that names it (cue frames in app/timeline.ts). Shots hold still
// and change by cutting, finished images are shown full frame.
import type { ReactNode } from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppWindow } from "../app/AppWindow";
import { appState, gen, genItem, jobItem, PROJECTS, PROMPTS, ref } from "../app/fixtures";
import { FullImage } from "../app/FullImage";
import { imageBox, InpaintOverlay, strokePoints } from "../app/InpaintOverlay";
import { Backdrop, type Cam, Camera, camAt, camSpeed, Caption, DepthOfField, Dissolve, inOut, kf, Pointer, prog, typed, typingDone, Vignette } from "../app/motion";
import { Send, Sfx } from "../app/sound";
import { CREATE, FPS, GPU_WORDS, LENGTH, REGION, sceneCues, sentenceAt } from "../app/timeline";
import { CardMotionContext, type CardMotion } from "../mocks/card";
import { Hatch } from "../mocks/Cocoon";
import type { State } from "../mocks/store";

const inpaintReq = (prompt: string, from: string, action: "remove" | "add") => ({
  prompt,
  mode: "inpaint" as const,
  images: [`gen:${from}`],
  quality: "quality" as const,
  resolution: "auto" as const,
  advanced: {},
  inpaint_action: action,
});
// Made with Prompt+ from a few words: the record keeps the written prompt and the user's own.
export const STREET = gen("street", "generate", PROMPTS.enhanced, undefined, { original_prompt: PROMPTS.idea, request: { prompt: PROMPTS.idea, mode: "generate", images: [], quality: "quality", resolution: "auto", advanced: {}, enhance: true } });
export const REMOVED = gen("street-removed", "inpaint", PROMPTS.remove, "street", { request: inpaintReq(PROMPTS.remove, "street", "remove") });
export const CAT = gen("street-cat", "inpaint", PROMPTS.add, "street-removed", { request: inpaintReq(PROMPTS.add, "street-removed", "add") });
const STREET_PROJECT = { id: "current", title: "Italian street café", updatedAt: Date.now() - 20_000, cover: "gen:street", count: 1 };
const withProject = (count: number, cover: string): State["projects"] => [{ ...STREET_PROJECT, count, cover }, ...PROJECTS];
const proj = (n: number, cover: string) => ({ projects: withProject(n, cover), projectId: "current" });

export const SEND: [number, number] = [1232, 857];
/** The composer, close: a macro shot past the window's bottom edge, sharp on the composer only. */
const COMPOSER_CAM: Cam = { x: 850, y: 630, s: 1.8 };
const COMPOSER_FOCUS: [number, number] = [690, 1010];
/** The empty project's composer is shorter and lower: centre it. */
export const PROMPT_CAM: Cam = { x: 850, y: 615, s: 1.7 };
const PROMPT_FOCUS: [number, number] = [800, 1050];
/** Where the stage image sits once a result is selected (window px), to fly into it. */
const STAGE_IMG = { x: 850, y: 319, w: 820 };

/** Steps of a job advancing from `start`, one every `every` frames. */
const stepAt = (f: number, start: number, every: number) => Math.max(0, Math.min(8, Math.floor((f - start) / every) + 1));

/** Big centred words that rise in with the voice and leave with the next ones. */
export function Words({ items, end }: { items: { text: string; at: number }[]; end: number }) {
  const f = useCurrentFrame();
  return (
    <>
      {items.map((w, i) => {
        const to = items[i + 1]?.at ?? end;
        if (f < w.at - 2 || f > to + 2) return null;
        const a = prog(f, w.at - 2, 14);
        const b = i < items.length - 1 ? prog(f, to - 6, 8, inOut) : prog(f, end - 10, 10, inOut);
        return (
          <div key={w.text} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none" }}>
            <div style={{ fontFamily: '"Inter Variable", Inter, sans-serif', fontSize: 104, fontWeight: 660, color: "#f4f4f2", letterSpacing: "-0.045em", textShadow: "0 6px 40px rgba(0,0,0,0.7)", opacity: a * (1 - b), transform: `translateY(${(1 - a) * 26 - b * 18}px)`, filter: `blur(${(1 - a) * 10 + b * 8}px)` }}>
              {w.text}
            </div>
          </div>
        );
      })}
    </>
  );
}

/** A small keyword in the lower left, for a shot whose action the voice names. */
const Tag = ({ text, start, end }: { text: string; start: number; end: number }) => <Caption title={text} start={start} end={end} y={930} size={48} />;

// ---------------------------------------------------------------------------------------
// Create: the window arrives and a few words are typed; Prompt+ on, Send. Cut to the card:
// Prompt+ writes the full prompt, the percentage takes over the cocoon, the image hatches out
// of the logo, then fills the frame. "No cloud. No account. No subscription." over it.
// ---------------------------------------------------------------------------------------
export const CREATE_FRAMES = LENGTH.create;

/** The card in two still shots: the whole card while Prompt+ writes (a slow push), then, from
 * the percentage on, closer, with the logo where the full-frame logo the image hatches from
 * sits (same centre and size, measured), so the cut between them reads as one logo. */
export const CARD_CAM: Cam = { x: 852, y: 360, s: 1.55 };
const CARD_CAM_END = 1.6;
export const LOGO_CAM: Cam = { x: 848, y: 364, s: 1.756 };
export const PILL: [number, number] = [840, 853];

/** When things happen in a Prompt+ shot (scene frames): typing, the Prompt+ pill, Send, the
 * prompt being written and leaving, the logo forming, the hatch. Create uses CREATE; the 0.10
 * update video its own. */
export type PromptPlusTimes = Pick<typeof CREATE, "ask" | "pill" | "send" | "job" | "write" | "written" | "leave" | "form" | "done" | "hatch"> & { typeCps?: number };

/** The job's percentage at scene frame `f`: the image starts while Prompt+ is still on screen. */
const pctFor = (C: PromptPlusTimes) => (f: number) => kf(f, [[C.write, 0], [C.form, 92], [C.done, 100]]);

/** The job card's clock at scene frame `f`. */
export function promptPlusCard(f: number, C: PromptPlusTimes): CardMotion {
  const pct = pctFor(C);
  // Prompt+ writes the whole prompt between `write` and `written` (sped up, like the image).
  const cps = (PROMPTS.enhanced.length * FPS) / (C.written - C.write);
  return {
    t: Math.max(0, f - C.job) / FPS,
    pctAt: (t) => pct(C.job + t * FPS),
    chars: Math.max(0, f - C.write) * (cps / FPS),
    cps,
    leave: prog(f, C.leave, 21, (x) => x),
    hatchMs: f >= C.hatch ? ((f - C.hatch) * 1000) / FPS : null,
  };
}

/** The window at scene frame `t`: the words typed, the job with Prompt+ writing, then the image. */
export function promptPlusView(t: number, C: PromptPlusTimes, card: CardMotion, size: { width: number; height: number } = { width: 1440, height: 900 }) {
  const base = appState();
  const cpsType = C.typeCps ?? 32;
  const request = { prompt: PROMPTS.idea, mode: "generate" as const, images: [], quality: "quality" as const, resolution: "auto" as const, advanced: {}, enhance: true };
  let state: State;
  const composer = { ...base.composer, enhance: t >= C.pill };
  if (t < C.job) {
    state = appState({ composer: { ...composer, prompt: typed(PROMPTS.idea, t, C.ask + 2, cpsType) } });
  } else if (t < C.hatch) {
    const pct = pctFor(C)(t);
    const j = jobItem("j-street", "generate", PROMPTS.idea, "street", undefined, Math.min(8, Math.floor((pct / 100) * 8)));
    const writing = t < C.write + 40;
    // The prompt is written while the image is being made; it stays on screen until it leaves.
    const job = { ...j.job, status: writing ? ("enhancing_prompt" as const) : j.job.status, step: writing ? null : j.job.step, enhanced_prompt: t < C.leave + 21 ? PROMPTS.enhanced : null };
    state = appState({ session: [{ ...j.item, request }], selected: "j-street", jobs: { "j-street": job }, composer, ...proj(1, "gen:street") });
  } else {
    state = appState({ session: [genItem(STREET)], selected: "street", composer, ...proj(1, "gen:street") });
  }
  return <AppWindow state={state} {...size} card={card} />;
}

export function Create() {
  const f = useCurrentFrame();
  const cues = sceneCues("create");
  const C = CREATE;
  const T0 = C.ask + 2;
  const T1 = typingDone(PROMPTS.idea, T0, 32);
  const card = promptPlusCard(f, C);
  const view = (t: number) => promptPlusView(t, C, card);

  const enter = prog(f, 0, 34);
  const typingCam = camAt(f, [
    [0, { x: 720, y: 450, s: 1.02 }],
    [40, { x: 720, y: 450, s: 1.1 }],
    [92, PROMPT_CAM],
    [C.send, { ...PROMPT_CAM, s: 1.86 }],
  ]);
  const onCard = f >= C.job;
  const cam = !onCard ? typingCam : f >= C.closer ? LOGO_CAM : { ...CARD_CAM, s: CARD_CAM.s + (CARD_CAM_END - CARD_CAM.s) * prog(f, C.job, C.closer - C.job, (x) => x) };
  // Sharp on the composer while typing; the whole window on the card.
  const dof = onCard ? 0 : prog(f, 70, 20);
  const app = (
    <Camera cam={cam} tilt={(1 - enter) * 16} lift={(1 - enter) * 260} opacity={enter} free={f > 60 && !onCard}>
      {view(f)}
      {!onCard && (
        <Pointer
          path={[
            [56, 980, 700],
            [88, 640, 812],
            [112, 900, 880],
            [C.pill - 2, PILL[0], PILL[1]],
            [C.send - 12, 1120, 880],
            [C.send - 1, SEND[0], SEND[1]],
          ]}
          clicks={[90, C.pill, C.send]}
          hideBefore={56}
        />
      )}
    </Camera>
  );
  // Once the card has formed the logo: a hard cut to the same logo filling the frame, and the
  // image hatches out of it full frame (the app's hatching, on the frame instead of the stage).
  const full = f >= C.hatch ? 1 : 0;
  const words = cues.find((c) => c.from === 3)!;
  // The captions follow the voice: "Prompt Plus writes the full prompt," then "and your graphics
  // card makes it."
  const prompting = cues.find((c) => c.from === 1)!;
  const writesAt = sentenceAt(prompting, 2);
  const gpuAt = writesAt + Math.round(GPU_WORDS * FPS);
  return (
    <AbsoluteFill>
      <Backdrop />
      {!full && (dof > 0.01 ? <DepthOfField focus={PROMPT_FOCUS} blur={7 * dof}>{app}</DepthOfField> : app)}
      {full > 0 && (
        // Its own stacking context: the hatch layers (z-index 1-2) stay under the words.
        <div style={{ position: "absolute", inset: 0, isolation: "isolate" }}>
          <CardMotionContext.Provider value={card}>
            <Hatch aspect={1920 / 1080} fill>
              <FullImage before="street" push={1 + prog(f, C.full, LENGTH.create - C.full, (x) => x) * 0.05} dim={0.25 * prog(f, C.promises - 8, 12)} />
            </Hatch>
          </CardMotionContext.Provider>
        </div>
      )}
      <Vignette strength={onCard && f < C.closer ? 0.7 : 0} />
      <Tag text="Prompt+ writes the prompt." start={writesAt} end={gpuAt - 2} />
      <Caption title="Made on your own GPU." sub="Qwen-Image 2.1 Turbo · Prompt+ ~2 s, then 2752×1536 in 38 s on an RTX 5070 Ti (sped up here)" start={gpuAt} end={C.hatch} y={930} size={48} />
      <Words
        items={[
          { text: "No cloud.", at: sentenceAt(words, 3) },
          { text: "No account.", at: sentenceAt(words, 4) },
          { text: "No subscription.", at: sentenceAt(words, 5) },
        ]}
        end={LENGTH.create - 4}
      />
      <Sfx name="click" at={90} />
      <Sfx name="typing" at={T0} dur={T1 - T0} />
      <Sfx name="click" at={C.pill} />
      <Send at={C.send} />
      <Sfx name="reveal" at={C.hatch + 6} variant={0} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------
// Region: paint the scooter; cut to the composer, Remove; the result full frame. Cut back,
// Add a cat; full frame again, then a before/after handle against the very first image.
// ---------------------------------------------------------------------------------------
export const REGION_FRAMES = LENGTH.region;
const STROKE: [number, number][] = [
  [0.47, 0.52], [0.62, 0.49], [0.665, 0.58], [0.475, 0.6], [0.455, 0.7], [0.67, 0.68], [0.68, 0.78], [0.46, 0.8], [0.465, 0.9], [0.665, 0.88], [0.62, 0.965], [0.5, 0.965],
];
const AR = 2752 / 1536;
const REMOVE_SEG: [number, number] = [581, 857];
const ADD_SEG: [number, number] = [689, 857];
const CAT_PROMPT = "a ginger cat sitting on the cobblestones";

export function Region() {
  const f = useCurrentFrame();
  const base = appState();
  const R = REGION;
  const box = imageBox(AR);
  // The paint editor's image filling the frame, as the full-frame picture Create ended on.
  const fillCam: Cam = { x: box.x + box.w / 2, y: box.y + box.h / 2, s: 1920 / box.w };
  const paintAt = (t: number) => prog(t, R.paint, R.paint1 - R.paint, (x) => x);

  // Shot 1: the paint editor over the image.
  const paintShot = () => {
    const state = appState({ session: [genItem(STREET)], selected: "street", composer: { ...base.composer, refs: [ref("street")] }, ...proj(1, "gen:street") });
    const cam = camAt(f, [
      [0, fillCam],
      [40, { ...fillCam, s: 1.58 }],
      [R.removeCut, { ...fillCam, y: fillCam.y + 6, s: 1.63 }],
    ]);
    return (
      <Camera cam={cam} free>
        <AppWindow state={state} width={1440} height={900} hideComposer overlay={<InpaintOverlay id="street" aspect={AR} points={STROKE} p={paintAt(f)} brush={74} />} />
      </Camera>
    );
  };

  // Shots 2 and 4: the composer, close. The action is picked as the voice says it.
  const composerShot = (from: number, action: "remove" | "add") => {
    const t = f - from;
    const pick = action === "remove" ? R.remove : R.add;
    const send = action === "remove" ? R.removeSend : R.addSend;
    const seg = action === "remove" ? REMOVE_SEG : ADD_SEG;
    const prompt = action === "remove" ? PROMPTS.remove : CAT_PROMPT;
    const img = action === "remove" ? STREET : REMOVED;
    const state = appState({
      session: action === "remove" ? [genItem(STREET)] : [genItem(STREET), genItem(REMOVED)],
      selected: img.id,
      composer: {
        ...base.composer,
        refs: [ref(img.id)],
        mask: { inputId: action === "remove" ? "mask" : "mask2", refKey: `ref-${img.id}` },
        inpaintAction: f >= pick ? action : "edit",
        prompt: typed(prompt, f, pick + 6, 70),
      },
      ...proj(action === "remove" ? 1 : 2, `gen:${img.id}`),
    });
    const cam = { ...COMPOSER_CAM, s: COMPOSER_CAM.s + t * 0.0006 };
    return (
      <DepthOfField focus={COMPOSER_FOCUS}>
        <Camera cam={cam} free>
          <AppWindow state={state} width={1440} height={900} />
          <Pointer
            path={[
              [from, seg[0] + 120, seg[1] + 50],
              [pick - 2, seg[0], seg[1]],
              [send - 10, seg[0] + 60, seg[1] - 20],
              [send - 1, SEND[0], SEND[1]],
              [send + 10, SEND[0] + 30, SEND[1] - 30],
            ]}
            clicks={[pick, send]}
          />
        </Camera>
      </DepthOfField>
    );
  };

  let shot: ReactNode;
  if (f < R.removeCut) shot = paintShot();
  else if (f < R.removeShot) shot = composerShot(R.removeCut, "remove");
  else if (f < R.addCut) {
    shot = <FullImage before="street" after="street-removed" reveal={prog(f, R.removeShot + 6, 22, inOut)} push={1 + (f - R.removeShot) * 0.0007} />;
  } else if (f < R.addShot) shot = composerShot(R.addCut, "add");
  else {
    // The cat wipes in; then the handle compares against the very first image.
    const cmp = f >= R.same + 14;
    shot = cmp ? (
      <FullImage before="street" after="street-cat" split={kf(f, [[R.same + 14, 0], [R.same + 70, 0.72], [LENGTH.region, 0.46]])} push={1.03} />
    ) : (
      <FullImage before="street-removed" after="street-cat" reveal={prog(f, R.addShot + 6, 22, inOut)} push={1 + (f - R.addShot) * 0.0007} />
    );
  }
  // Create ended on the full-frame street; it hands over to the paint editor's identical image.
  const handover = 1 - prog(f, 0, 10, inOut);
  return (
    <AbsoluteFill>
      <Backdrop />
      {shot}
      {f < 10 && (
        <div style={{ position: "absolute", inset: 0, opacity: handover }}>
          <FullImage before="street" push={1.06} dim={0.25} />
        </div>
      )}
      {(f >= R.removeCut && f < R.removeShot) || (f >= R.addCut && f < R.addShot) ? (
        <>
          <Vignette strength={0.55} side="top" reach={0.6} />
          <Vignette strength={0.6} reach={0.15} />
        </>
      ) : null}
      <Tag text="Paint." start={R.paint} end={R.removeCut} />
      <Tag text="Remove." start={R.removeShot + 8} end={R.addCut} />
      <Tag text="Add." start={R.addShot + 8} end={R.same + 10} />
      {f >= R.same + 14 &&
        (["Before", "After"] as const).map((t) => (
          <div key={t} style={{ position: "absolute", top: 56, [t === "Before" ? "left" : "right"]: 64, padding: "8px 18px", borderRadius: 999, background: "rgba(0,0,0,0.5)", color: "#f2f2f2", fontFamily: '"Inter Variable", Inter, sans-serif', fontSize: 26, fontWeight: 550, opacity: prog(f, R.same + 18, 12) }}>
            {t}
          </div>
        ))}
      <Sfx name="brush" at={R.paint} dur={R.paint1 - R.paint} />
      <Sfx name="click" at={R.remove} />
      <Send at={R.removeSend} />
      <Sfx name="reveal" at={R.removeShot + 6} variant={1} />
      <Sfx name="click" at={R.add} />
      <Send at={R.addSend} />
      <Sfx name="reveal" at={R.addShot + 6} variant={2} />
      <Sfx name="slider" at={R.same + 16} />
    </AbsoluteFill>
  );
}

// ---------------------------------------------------------------------------------------
// Versions: the timeline of the project, every step kept; two clicks walk back through it.
// ---------------------------------------------------------------------------------------
export const VERSIONS_FRAMES = LENGTH.versions;

export function Versions() {
  const f = useCurrentFrame();
  const base = appState();
  const cues = sceneCues("versions");
  const back1 = cues[0].at + 8;
  const back2 = sentenceAt(cues[0], 1) + 14;
  const view = (t: number) => {
    const sel = t < back1 ? "street-cat" : t < back2 ? "street-removed" : "street";
    const state = appState({ session: [genItem(STREET), genItem(REMOVED), genItem(CAT)], selected: sel, composer: { ...base.composer, refs: [ref(sel)] }, ...proj(3, "gen:street-cat") });
    return <AppWindow state={state} width={1440} height={900} />;
  };
  const cam = { x: 850, y: 520, s: 1.66 + f * 0.0005 };
  return (
    <AbsoluteFill>
      <Backdrop />
      <Camera cam={cam}>
        <Dissolve frame={f} cuts={[back1, back2]} view={view} dur={8} />
        <Pointer path={[[0, 1000, 720], [back1 - 6, 812, 664], [back2 - 6, 776, 664], [VERSIONS_FRAMES, 760, 690]]} clicks={[back1, back2]} />
      </Camera>
      <Vignette strength={0.9} side="top" />
      <Caption title="Every version kept." start={12} end={VERSIONS_FRAMES} y={90} size={56} />
      <Sfx name="click" at={back1} />
      <Sfx name="click" at={back2} />
    </AbsoluteFill>
  );
}
