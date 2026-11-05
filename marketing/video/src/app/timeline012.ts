// The clock of the "Kokon 0.12" video (composition Update012): Gabriele's two screen recordings,
// shown whole and in order (only OBS cut at the ends), the waits sped up, two short freezes to read
// a dialog, slow zooms on details. Recording times are seconds into the 1440p proxies in
// public/rec-0.12 (HDR10 sources tone-mapped there: PQ white at ~270 nits = SDR white). Frames at
// 30 fps from the start of the video.
import voice from "./voice-0.12-v3.json";
import { FPS, type Cue, type Lines, sentenceAt, type VoiceSet } from "./timeline";

export type Rec = 1 | 2;
/** The recordings at 1440p (the 1080p video), or at 2160p from the same crop (the 4K video, Update012UHD). */
export const recSrc = (rec: Rec, uhd: boolean) => `rec-0.12/${rec === 1 ? "layer-lab" : "color-edit"}-${uhd ? 2160 : 1440}.mp4`;

/** A stretch of a recording at `rate` (1 = as recorded), or `hold` seconds on one of its frames
 * (a still in public/rec-0.12/stills, `r<rec>-<t>.png`). */
type Piece = { rec: Rec; from: number; to: number; rate: number } | { rec: Rec; still: number; hold: number };
export type Placed = Piece & { start: number; frames: number };

export const OPEN = 120;
/** Recording 1, Layers lab on the Halloween poster: OBS until 0.97, again from 290.6. */
const REC1: Piece[] = [
  { rec: 1, from: 29 / 30, to: 4, rate: 1 },
  // Picking the objects (round 2, Gabriele: much faster): 2x to the first click, then 5x.
  { rec: 1, from: 4, to: 11, rate: 2 },
  { rec: 1, from: 11, to: 69.5, rate: 5 },
  // "How should the objects be cut out?": held to be read, Quality chosen.
  { rec: 1, from: 69.5, to: 71, rate: 1 },
  { rec: 1, still: 71, hold: 1.5 },
  { rec: 1, from: 71, to: 72.5, rate: 1 },
  // Stickers, then the background filled: 8x.
  { rec: 1, from: 72.5, to: 178, rate: 8 },
  // The layers; bats hidden, the spider moved (the street behind it), girl and ghosts moved:
  // only the spider's move near normal speed.
  { rec: 1, from: 178, to: 183.6, rate: 1 },
  { rec: 1, from: 183.6, to: 187.4, rate: 3 },
  { rec: 1, from: 187.4, to: 191.4, rate: 1.5 },
  { rec: 1, from: 191.4, to: 207, rate: 4 },
  // Expand on the spider's layer, "Complete the spider to the right side" typed.
  { rec: 1, from: 207, to: 231.5, rate: 4 },
  { rec: 1, from: 231.5, to: 251.5, rate: 8 },
  { rec: 1, from: 251.5, to: 257.8, rate: 1 },
  // Blend into scene: what the AI read, held.
  { rec: 1, still: 257.8, hold: 2 },
  { rec: 1, from: 257.8, to: 258.4, rate: 1 },
  { rec: 1, from: 258.4, to: 281.3, rate: 6 },
  { rec: 1, from: 281.3, to: 290.6, rate: 1 },
];
/** Recording 2, Colours on the kitchen: OBS until 1.75, again from 101.2. */
const REC2: Piece[] = [
  { rec: 2, from: 1.8, to: 6, rate: 1 },
  // Painting (round 2, Gabriele: faster): red 3x, its box typed 2x, blue and its box 4x.
  { rec: 2, from: 6, to: 11, rate: 3 },
  { rec: 2, from: 11, to: 19.6, rate: 2 },
  { rec: 2, from: 19.6, to: 36.5, rate: 4 },
  // Done, the Prompt+ menu, Prompt+ writing: 2.5x, then its request held.
  { rec: 2, from: 36.5, to: 43.4, rate: 2.5 },
  { rec: 2, from: 43.4, to: 44.2, rate: 1 },
  { rec: 2, still: 44.2, hold: 1 },
  { rec: 2, from: 44.2, to: 45.5, rate: 1 },
  { rec: 2, from: 45.5, to: 96.5, rate: 10 },
  { rec: 2, from: 96.5, to: 101, rate: 1 },
  // Before / after on the result.
  { rec: 2, still: 101, hold: 4.5 },
];

function place(pieces: Piece[], start: number): Placed[] {
  let at = start;
  return pieces.map((p) => {
    const frames = Math.round("still" in p ? p.hold * FPS : ((p.to - p.from) * FPS) / p.rate);
    const placed = { ...p, start: at, frames };
    at += frames;
    return placed;
  });
}
export const PIECES = [...place(REC1, OPEN), ...place(REC2, 0)];
// REC2 follows REC1 directly.
{
  const end1 = PIECES.filter((p) => p.rec === 1).reduce((e, p) => Math.max(e, p.start + p.frames), 0);
  let at = end1;
  for (const p of PIECES.filter((q) => q.rec === 2)) {
    p.start = at;
    at += p.frames;
  }
}
const endOf = (rec: Rec) => Math.max(...PIECES.filter((p) => p.rec === rec).map((p) => p.start + p.frames));
export const SHOT = {
  open: 0,
  rec1: OPEN,
  rec2: endOf(1),
  /** The before/after on the last still. */
  compare: PIECES[PIECES.length - 1].start,
  mac: endOf(2),
  close: endOf(2) + 12 * FPS,
};
/** The end card: 9 s, or longer when the closing line (20) needs it (0.5 s in, 1 s after it). */
const END_LINE = (voice as unknown as Lines)["20"].dur;
export const UPDATE012_FRAMES = SHOT.close + Math.max(9 * FPS, Math.ceil((END_LINE + 1.5) * FPS));

/** Video frame where recording `rec` shows second `t` (the first piece holding it). */
export function at(rec: Rec, t: number): number {
  for (const p of PIECES) {
    if (p.rec !== rec) continue;
    if ("still" in p) {
      if (Math.abs(p.still - t) < 1e-6) return p.start;
    } else if (t >= p.from - 1e-6 && t <= p.to + 1e-6) return p.start + Math.round(((t - p.from) * FPS) / p.rate);
  }
  throw new Error(`recording ${rec} at ${t}s is not in the video`);
}

/** Slow zooms on a detail (video pixels, 1920×1080): in over `ease` frames from recording time
 * `a`, held, out over `ease` frames ending at `b`. Scaled about the detail, so it stays put. */
export interface Zoom { rec: Rec; a: number; b: number; x: number; y: number; s: number }
export const ZOOM_EASE = 24;
export const ZOOMS: Zoom[] = [
  { rec: 1, a: 69.8, b: 72.4, x: 960, y: 560, s: 1.55 }, // Fast / Quality
  { rec: 1, a: 179.2, b: 183.6, x: 1600, y: 250, s: 1.8 }, // the layers panel
  { rec: 1, a: 187.4, b: 191.4, x: 1060, y: 760, s: 1.7 }, // the street behind the spider
  { rec: 1, a: 251.6, b: 254.4, x: 620, y: 745, s: 1.8 }, // the spider completed
  { rec: 1, a: 255.6, b: 258.2, x: 960, y: 560, s: 1.6 }, // read by the AI
  { rec: 1, a: 281.6, b: 286.4, x: 800, y: 780, s: 1.7 }, // the shadows, strength
  { rec: 2, a: 11, b: 19.6, x: 850, y: 420, s: 1.7 }, // what goes here, typed on the image
  { rec: 2, a: 43.4, b: 45.4, x: 956, y: 940, s: 1.6 }, // Prompt+'s request
  { rec: 2, a: 97.4, b: 100.8, x: 1000, y: 400, s: 1.7 }, // bottle and pizza
];

/** Speed badges: every piece faster than 3x. */
export const BADGES = PIECES.filter((p): p is Placed & { rate: number } => "rate" in p && p.rate > 3).map((p) => ({ start: p.start, end: p.start + p.frames, rate: p.rate }));

/** The result's image on screen (video pixels), for the before/after. */
export const RESULT_RECT = { x: 628, y: 66, w: 666, h: 668 };

/** On-screen words: section titles (large, a moment) and captions (bottom left), recording times. */
export const TITLES: { rec: Rec; t: number; text: string; tag?: string }[] = [
  { rec: 1, t: 4.4, text: "Any image → its layers" },
  { rec: 1, t: 178.4, text: "Move anything" },
  { rec: 1, t: 254.6, text: "Blend into scene", tag: "Experimental" },
  { rec: 2, t: 2.2, text: "Paint where things go" },
];
export const CAPTIONS: { rec: Rec; a: number; b: number; title: string; sub?: string }[] = [
  { rec: 1, a: 7, b: 69.4, title: "Click each thing you want on its own layer" },
  { rec: 1, a: 69.6, b: 72.4, title: "Quality: the AI redraws each edge" },
  { rec: 1, a: 72.8, b: 177.6, title: "Each object on its own layer", sub: "The background rebuilt behind them" },
  { rec: 1, a: 180.6, b: 206.8, title: "Move it, hide it", sub: "The scene behind is already there" },
  { rec: 1, a: 207.2, b: 254.2, title: "Edit one layer only", sub: "Extend the spider, ask to complete it" },
  { rec: 1, a: 257, b: 281.2, title: "The AI reads where each object stands", sub: "Then adds shadows, or reflections on wet or shiny ground" },
  { rec: 1, a: 281.6, b: 290.5, title: "Strength to taste. Export to PSD", sub: "Keep going in Photoshop or similar" },
  { rec: 2, a: 5, b: 36.4, title: "One colour per thing", sub: "Say what goes there, on the picture" },
  // Off while the zoom reads Prompt+'s request (it would cover the start of the text).
  { rec: 2, a: 36.8, b: 43.2, title: "Prompt+ writes the full request" },
  { rec: 2, a: 45.6, b: 96.4, title: "Prompt+ writes the full request" },
];

// Voice: voiceover-0.12.md, one cue per sentence (or per line), placed on the action it names.
const json = voice as unknown as Lines;
export const VOICE_012: VoiceSet = { dir: "voice-0.12-v3", lines: json };
const n = (line: number) => VOICE_012.lines[String(line)].sentences.length;
const cue = (line: number, f: number, from = 0, to = from): Cue => ({ line, from, to, at: f, set: VOICE_012 });
const all = (line: number, f: number): Cue => cue(line, f, 0, n(line) - 1);
export const CUES_012: Cue[] = [
  all(1, 18),
  all(2, at(1, 1.2)),
  all(3, at(1, 4.2)),
  cue(4, at(1, 11), 0),
  cue(4, at(1, 27), 1),
  cue(4, at(1, 34), 2),
  cue(4, at(1, 42.5), 3),
  cue(4, at(1, 55), 4),
  all(5, at(1, 69.8)),
  all(6, at(1, 76)),
  all(7, at(1, 178.6)),
  // Round 2: only "Move the spider: …" (no "Hide the bats.", no "Make the girl bigger.").
  cue(8, at(1, 187.5), 1),
  all(9, at(1, 207.6)),
  all(10, at(1, 251.8)),
  all(11, at(1, 254.8)),
  all(12, at(1, 266)),
  // "Too strong? Turn it down." as the strength goes to 50 %, then the PSD sentence.
  cue(13, at(1, 283), 0, 1),
  cue(13, at(1, 285.6), 2),
  all(14, at(2, 2.4)),
  cue(15, at(2, 5.4), 0),
  cue(15, at(2, 11.2), 1),
  // Round 2: no line 16 ("Blue: a pizza on a plate.") and no line 18's first sentence.
  all(17, at(2, 37)),
  cue(18, SHOT.compare + 30, 1),
  all(19, SHOT.mac + 24),
  all(20, SHOT.close + 15),
];
const cueOf = (line: number, i: number) => CUES_012.find((c) => c.line === line && c.from <= i && i <= c.to)!;
/** Frame where sentence `i` of line `line` starts. */
export const said = (line: number, i = 0) => sentenceAt(cueOf(line, i), i);

// Music: the 0.11 video's house-4 (92 s, 118 BPM, first bar line at 0.288 s): intro bars 0-3,
// groove 4-23, softer 24-30, groove 32-39, outro 40-42. The video is longer, so whole 8-bar
// phrases follow each other on the beat grid (a short crossfade on the bar line), and the outro
// starts on the end card (bar 39 -> 40, as the track itself plays it).
export const MUSIC_SRC = "music-0.11-house4.m4a";
const BAR = (4 * 60) / 118;
const BAR0 = 0.288;
/** [first bar, bar after the last] of the track, in the order played. */
const PHRASES: [number, number][] = [
  [0, 40],
  [8, 24],
  [32, 40],
];
const OUTRO: [number, number] = [40, 44];
export interface MusicPiece { at: number; from: number; frames: number }
export const MUSIC_PIECES: MusicPiece[] = (() => {
  const bars = [...PHRASES, OUTRO];
  const lens = bars.map(([a, b]) => (b - a) * BAR);
  // The outro on the end card: everything before it ends at SHOT.close.
  const before = lens.slice(0, -1).reduce((s, l) => s + l, 0);
  let t = SHOT.close / FPS - before;
  return bars.map(([a], i) => {
    const p = { at: Math.round(t * FPS), from: BAR0 + a * BAR, frames: Math.round(lens[i] * FPS) };
    t += lens[i];
    return p;
  });
})();
/** Crossfade between pieces, frames on each side of the bar line. */
export const MUSIC_XFADE = 4;
