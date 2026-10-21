// The clock of the "Kokon 0.10" update video (composition Update010): the music's beat grid,
// the shots (cut on beats), the voice-over cues (voiceover-0.10.md) and the frames of the
// actions the voice names. Frames at 30 fps from the start of the video.
import voice from "./voice-0.10.json";
import { FPS, type Cue, type Lines, sentenceAt, type VoiceSet } from "./timeline";

// Music: `src` from `from` seconds; its beats fall every BEAT seconds from BEAT0 (seconds into
// the video). Both cuts come from audio/make_update_music.py (ACE-Step takes): the drop on beat
// 26 (the hatch), the music silent by `stop` (seconds), before the last words.
const MUSICS = {
  /** Take 1: a quiet build, the drop, a dead stop. */
  take1: { src: "music-0.10.m4a", from: 0, stop: 37.607 },
  /** Take 1 with one more groove bar, for the longer Prompt+ model part (the cut in use). */
  take1long: { src: "music-0.10-long.m4a", from: 0, stop: 39.641 },
  /** Take 3: groove, a near-silent break under the logo, the drop, a second hit on the LoRA
   * part, an ending bar. */
  take3: { src: "music-0.10-take3.m4a", from: 0, stop: 37.7 },
};
export const MUSIC = MUSICS.take1long;
const BEAT = 60 / 118;
const BEAT0 = 0;
/** Frame of beat `k` of the video. */
export const beat = (k: number) => Math.round((BEAT0 + k * BEAT) * FPS);
/** Where the music stops dead, before the last words. */
export const STOP = Math.round(MUSIC.stop * FPS);

/** Shot starts (frames), each on a beat. */
export const SHOT = {
  title: 0,
  composer: beat(6),
  card: beat(10),
  /** On the beat before "Then Kokon makes the image." (set below, from the voice). */
  making: 0,
  logo: beat(24),
  hatch: beat(26), // the drop
  // "One model. Two jobs." over the image, then the diagram, read slowly.
  model: beat(32),
  settings: beat(46),
  /** On the beat before "Turn it on with one click." (set below, from the voice). */
  pill: 0,
  look: beat(60),
  bar: beat(63),
  silk: beat(66),
  end: beat(70),
};
export const UPDATE_FRAMES = beat(84);

// Voice-over: public/voice-0.10/NN.wav and voice-0.10.json from `gen_voice.py build`. Until the
// takes exist the json holds estimated spans ("_provisional"): the cues still time the
// captions and the music's ducking, but no voice plays.
const json = voice as unknown as Lines & { _provisional?: boolean };
export const VOICE_READY = !json._provisional;
export const UPDATE_VOICE: VoiceSet = { dir: "voice-0.10", lines: json };

const cue = (line: number, at: number, from = 0, to = from): Cue => ({ line, from, to, at, set: UPDATE_VOICE });
/** Seconds into a sentence where a word starts (Whisper word times of the picked takes). */
export const WORD = { two: 1.6, reads: 0.72, writes: 1.58, load: 0.21, click: 1.07, spun: 1.67 };
const all = (line: number, at: number): Cue => cue(line, at, 0, UPDATE_VOICE.lines[String(line)].sentences.length - 1);
const span = (line: number, i: number) => UPDATE_VOICE.lines[String(line)].sentences[i];

/** Prompt+ in the composer: typing on "Type a few words.", the prompt written while the voice
 * says "Prompt Plus writes the full prompt." (its sentence starts at `write`). */
const WRITE = SHOT.card + 7;
export const CUES_010: Cue[] = [
  all(1, 10),
  all(2, WRITE - Math.round(span(2, 1)[0] * FPS)),
  all(3, SHOT.hatch + 10),
  all(4, SHOT.settings + 6),
  // "...spun from silk." as the silk shot comes in.
  all(5, SHOT.silk - Math.round(WORD.spun * FPS)),
  cue(6, SHOT.end + 12, 0),
  // "Get it at kokon dot app." right after the music stops.
  cue(6, STOP + 8, 1),
];
const cueOf = (n: number, i: number) => CUES_010.find((c) => c.line === n && c.from <= i && i <= c.to)!;
/** Frame where sentence `i` of line `n` starts, and where a word of it starts. */
export const said = (n: number, i: number) => sentenceAt(cueOf(n, i), i);
export const word = (n: number, i: number, w: keyof typeof WORD) => said(n, i) + Math.round(WORD[w] * FPS);
/** Frame where sentence `i` of line `n` ends. */
export const saidEnd = (n: number, i: number) => said(n, i) + Math.round((span(n, i)[1] - span(n, i)[0]) * FPS);
/** The last beat at or before frame `f`. */
const beatBefore = (f: number) => beat(Math.floor((f / FPS - BEAT0) / BEAT));
SHOT.pill = Math.min(beatBefore(said(4, 2) + 2), SHOT.look - 45);
SHOT.making = beatBefore(said(2, 2) + 4);

/** LoRA: "Load a LoRA…" clicked as the voice says "Load one in Settings.", the pill on "one
 * click" (but before the cut to the new look). */
export const LORA_CLICK = { load: word(4, 1, "load") + 4, pill: Math.min(word(4, 2, "click"), SHOT.look - 14) };

/** The Prompt+ shots (frames of the video), in the shape Create uses (scenes/AppScenes.tsx). */
export const PROMPT = {
  ask: SHOT.composer + 14,
  typeCps: 48,
  pill: SHOT.card - 14,
  send: SHOT.card - 1,
  job: SHOT.card,
  write: WRITE,
  written: SHOT.making - 24,
  leave: SHOT.making - 21,
  form: SHOT.logo - 1,
  done: SHOT.hatch - 6,
  hatch: SHOT.hatch,
};
