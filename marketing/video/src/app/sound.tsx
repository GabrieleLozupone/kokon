// The soundtrack: the voice-over (public/voice, see timeline.ts), the music bed (public/music.m4a,
// made locally with ACE-Step) and the sound effects (public/sfx, synthesized by
// marketing/audio/make_sfx.py), placed on the frames where things happen. Every level is here,
// so the mix can be tuned in one place.
import { Html5Audio, Sequence, staticFile } from "remotion";
import { CUES, cueFrames, cueSpan, FPS, LAUNCH_VOICE, type Cue } from "./timeline";

const LEVEL = {
  music: 0.62,
  voice: 1,
  click: 0.16,
  typing: 0.16,
  send: 0.16,
  reveal: 0.3,
  slider: 0.14,
  whoosh: 0.26,
  brush: 0.16,
  hit: 0.55,
  riser: 0.22,
} as const;
/** Music level under the voice (about -8 dB), and how fast it dips and comes back. */
const DUCK = { level: 0.4, attack: 8, release: 16 };

type Base = Exclude<keyof typeof LEVEL, "music" | "voice" | "reveal">;
export type SfxName = Base | "reveal";

// Results appear with a soft reveal; three variants take turns (`variant`) so it never repeats
// back to back.
const REVEALS = ["reveal-a", "reveal-b", "reveal-c"] as const;

/** One effect from frame `at` of the current sequence; with `dur` it is cut short with a fade. */
export function Sfx({ name, at, dur, gain = 1, variant }: { name: SfxName; at: number; dur?: number; gain?: number; variant?: number }) {
  if (dur !== undefined && dur <= 0) return null;
  const level = LEVEL[name] * gain;
  const file = name === "reveal" ? REVEALS[(variant ?? 0) % REVEALS.length] : name;
  return (
    <Sequence from={Math.round(at)} durationInFrames={dur} layout="none" name={`sfx:${file}`}>
      <Html5Audio src={staticFile(`sfx/${file}.wav`)} volume={(f) => (dur === undefined ? level : level * Math.min(1, (dur - f) / 6))} />
    </Sequence>
  );
}

/** A click with the soft "send" swell on top: a request leaves. */
export const Send = ({ at }: { at: number }) => (
  <>
    <Sfx name="click" at={at} />
    <Sfx name="send" at={at + 1} />
  </>
);

/** One voice-over cue: its sentences cut from the line's file, with 2-frame fades at the edges. */
function Say({ c }: { c: Cue }) {
  const [a] = cueSpan(c);
  const n = cueFrames(c);
  return (
    <Sequence from={c.at} durationInFrames={n} layout="none" name={`voice ${c.line}.${c.from}`}>
      <Html5Audio
        src={staticFile(`${(c.set ?? LAUNCH_VOICE).dir}/${String(c.line).padStart(2, "0")}.wav`)}
        trimBefore={Math.round(a * FPS)}
        volume={(f) => LEVEL.voice * Math.min(1, f / 2, (n - f) / 2)}
      />
    </Sequence>
  );
}

export const Voice = ({ cues = CUES }: { cues?: Cue[] }) => (
  <>
    {cues.map((c) => (
      <Say key={`${c.line}.${c.from}`} c={c} />
    ))}
  </>
);

/** 1 with no voice, DUCK.level while the voice speaks, with smooth ramps around each cue. */
function duck(f: number, cues: Cue[]): number {
  let d = 0;
  for (const c of cues) {
    const a = c.at;
    const b = c.at + cueFrames(c);
    const v = f < a ? 1 - (a - f) / DUCK.attack : f > b ? 1 - (f - b) / DUCK.release : 1;
    d = Math.max(d, Math.min(1, Math.max(0, v)));
  }
  return 1 - (1 - DUCK.level) * d;
}

/** Music for the whole film, under the voice (`cues`), fading out over the last `fadeOut` frames.
 * `src` and `from` (seconds into the file) pick the track and where it starts. */
export function Music({ frames, fadeOut = 45, cues = CUES, src = "music.m4a", from = 0 }: { frames: number; fadeOut?: number; cues?: Cue[]; src?: string; from?: number }) {
  return <Html5Audio src={staticFile(src)} trimBefore={Math.round(from * FPS)} volume={(f) => LEVEL.music * duck(f, cues) * Math.min(1, Math.max(0, (frames - f) / fadeOut))} />;
}
