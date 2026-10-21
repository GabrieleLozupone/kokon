// Five edits, full frame, cut on the music: each starts as the voice names it ("Change the
// season."), its one-sentence prompt appears under the picture, and the result wipes in on the
// next beat but one. All images were made by Kokon. It ends on the results together with the
// street from the demo, "One sentence each.", right before the drop the Agent scene lands on.
import { AbsoluteFill, Img, Sequence, staticFile, useCurrentFrame } from "remotion";
import { FullImage } from "../app/FullImage";
import { PROMPTS } from "../app/fixtures";
import { inOut, prog, typed } from "../app/motion";
import { Sfx } from "../app/sound";
import { LENGTH, MONTAGE, MONTAGE_EDIT } from "../app/timeline";

interface Edit {
  label: string;
  before: string;
  after: string;
  prompt: string;
  expand?: number;
}

const EDITS: Edit[] = [
  { label: "Change the season.", before: "cabin", after: "cabin-winter", prompt: PROMPTS.winter },
  { label: "Fix the sign.", before: "bakery", after: "bakery-text", prompt: PROMPTS.text },
  { label: "Restyle a portrait.", before: "potter", after: "potter-watercolor", prompt: PROMPTS.restyle },
  { label: "Swap the furniture.", before: "room", after: "room-sofa", prompt: PROMPTS.replace },
  { label: "Expand the frame.", before: "lighthouse", after: "lighthouse-wide", prompt: PROMPTS.expand, expand: 1536 / 2764 },
];
/** The mosaic: the street with the cat from the demo, then the five edits. */
const TILES = ["street-cat", ...EDITS.map((e) => e.after)];

export const MONTAGE_FRAMES = LENGTH.montage;
const START = EDITS.map((_, i) => Math.round(i * MONTAGE_EDIT));
/** The result wipes in two beats after the cut. */
const WIPE = 30;
const font = '"Inter Variable", Inter, sans-serif';

function OneEdit({ e, index, frames }: { e: Edit; index: number; frames: number }) {
  const f = useCurrentFrame();
  const reveal = prog(f, WIPE, 20, inOut);
  const label = prog(f, 3, 12);
  const sentence = typed(e.prompt, f, 6, 90);
  return (
    <AbsoluteFill>
      <FullImage before={e.before} after={e.after} reveal={reveal} expandFrom={e.expand} push={1 + (f / frames) * 0.05} />
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.35) 22%, rgba(0,0,0,0) 40%)" }} />
      <div style={{ position: "absolute", left: 96, top: 72, fontFamily: font, fontSize: 22, fontWeight: 600, letterSpacing: "0.14em", color: "rgba(240,240,240,0.6)", textShadow: "0 2px 12px rgba(0,0,0,0.6)" }}>
        {String(index + 1).padStart(2, "0")} / {String(EDITS.length).padStart(2, "0")}
      </div>
      <div style={{ position: "absolute", left: 96, bottom: 150, fontFamily: font, fontSize: 64, fontWeight: 650, letterSpacing: "-0.035em", color: "#f4f4f2", textShadow: "0 4px 30px rgba(0,0,0,0.6)", opacity: label, transform: `translateY(${(1 - label) * 20}px)`, filter: `blur(${(1 - label) * 6}px)` }}>
        {e.label}
      </div>
      <div style={{ position: "absolute", left: 96, bottom: 84, maxWidth: 1500, fontFamily: font, fontSize: 26, color: "rgba(240,240,240,0.78)", textShadow: "0 2px 14px rgba(0,0,0,0.7)", opacity: prog(f, 6, 8) }}>
        “{sentence}
        {sentence.length < e.prompt.length ? <span style={{ opacity: 0.7 }}>▍</span> : "”"}
      </div>
      <Sfx name="reveal" at={WIPE} variant={index} gain={0.85} />
    </AbsoluteFill>
  );
}

function Mosaic() {
  const f = useCurrentFrame();
  const W = 560;
  const H = 315;
  const G = 28;
  const text = prog(f, 4, 14);
  return (
    <AbsoluteFill style={{ background: "#050505" }}>
      <div style={{ position: "absolute", left: (1920 - (3 * W + 2 * G)) / 2, top: (1080 - (2 * H + G)) / 2, display: "grid", gridTemplateColumns: `repeat(3, ${W}px)`, gap: G, transform: `scale(${1.02 + f * 0.0012})` }}>
        {TILES.map((id, i) => {
          const p = prog(f, i * 1.5 - 3, 10); // the first tiles are already there on the cut
          return (
            <div key={id} style={{ width: W, height: H, borderRadius: 16, overflow: "hidden", opacity: p, transform: `scale(${0.9 + p * 0.1})`, boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}>
              <Img src={staticFile(`img/${id}.jpg`)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            </div>
          );
        })}
      </div>
      <div style={{ position: "absolute", inset: 0, background: `rgba(0,0,0,${0.45 * text})` }} />
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <div style={{ fontFamily: font, fontSize: 104, fontWeight: 660, color: "#f4f4f2", letterSpacing: "-0.045em", textShadow: "0 6px 40px rgba(0,0,0,0.7)", opacity: text, transform: `translateY(${(1 - text) * 26}px)`, filter: `blur(${(1 - text) * 10}px)` }}>
          One sentence each.
        </div>
      </div>
    </AbsoluteFill>
  );
}

export function Montage() {
  return (
    <AbsoluteFill style={{ background: "#050505" }}>
      {EDITS.map((e, i) => {
        const frames = (START[i + 1] ?? MONTAGE.mosaic) - START[i];
        return (
          <Sequence key={e.after} from={START[i]} durationInFrames={frames}>
            <OneEdit e={e} index={i} frames={frames} />
          </Sequence>
        );
      })}
      <Sequence from={MONTAGE.mosaic}>
        <Mosaic />
      </Sequence>
      <Sfx name="riser" at={MONTAGE.mosaic - 18} />
    </AbsoluteFill>
  );
}
