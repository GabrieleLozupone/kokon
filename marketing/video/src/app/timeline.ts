// The film's clock: where each scene starts, where each voice-over sentence plays, and the
// music's beat grid. Scenes read their cue frames from here, so pictures, voice and music move
// together when one of them is retimed. All values are frames at 30 fps, on the main timeline.
import voice from "./voice.json";

export const FPS = 30;
/** Cross-fade between scenes that fade in (the others cut). */
export const FADE = 18;

/** Scene lengths; the start of each follows from the one before. */
export const LENGTH = {
  intro: 120,
  hook: 150,
  create: 475,
  region: 475,
  versions: 155,
  montage: 506,
  agent: 300,
  hardware: 240,
  outro: 240,
} as const;
export type SceneName = keyof typeof LENGTH;
export const FADES_IN: Record<SceneName, boolean> = {
  intro: false,
  hook: true,
  create: true,
  region: false,
  versions: false,
  montage: true,
  agent: true,
  hardware: true,
  outro: true,
};

export const START = {} as Record<SceneName, number>;
let at = 0;
for (const name of Object.keys(LENGTH) as SceneName[]) {
  if (FADES_IN[name] && at > 0) at -= FADE;
  START[name] = at;
  at += LENGTH[name];
}
export const TOTAL = at;

// Music (public/music.m4a, 118 BPM): one beat grid through the whole track, measured with
// librosa's onset envelope. The drop the Agent scene lands on is beat 102 (60.3 s), the outro
// accent beat 135 (77.1 s).
const BEAT0 = 8.45;
const BEAT = 60 / 118;
export const beatFrame = (k: number) => Math.round((BEAT0 + k * BEAT) * FPS);

// ---------------------------------------------------------------------------------------------
// Voice-over: public/voice/NN.wav from marketing/audio/gen_voice.py; voice.json holds where each
// sentence starts and ends in its file (seconds).
// ---------------------------------------------------------------------------------------------
export type Lines = Record<string, { dur: number; sentences: [number, number][] }>;
/** A voice-over: the folder of its files in public/ (NN.wav per line) and where each sentence is. */
export interface VoiceSet {
  dir: string;
  lines: Lines;
}
export const LAUNCH_VOICE: VoiceSet = { dir: "voice", lines: voice as unknown as Lines };

/** A piece of one line: sentences `from`..`to` (inclusive), starting at main-timeline frame `at`.
 * `set`: the voice-over it comes from (the launch film's by default). */
export interface Cue {
  line: number;
  from: number;
  to: number;
  at: number;
  set?: VoiceSet;
}

const linesOf = (c: Cue) => (c.set ?? LAUNCH_VOICE).lines[String(c.line)].sentences;
/** Seconds into the line's file where the cue's sentences start and end. */
export function cueSpan(c: Cue): [number, number] {
  const s = linesOf(c);
  return [s[c.from][0], s[c.to][1]];
}
export const cueFrames = (c: Cue) => Math.ceil((cueSpan(c)[1] - cueSpan(c)[0]) * FPS);
/** Frame (main timeline) where sentence `i` of the cue's line starts, when played from this cue. */
export const sentenceAt = (c: Cue, i: number) => c.at + Math.round((linesOf(c)[i][0] - cueSpan(c)[0]) * FPS);

const cue = (scene: SceneName, line: number, local: number, from = 0, to = from): Cue => ({ line, from, to, at: START[scene] + local });
const all = (scene: SceneName, line: number, local: number): Cue => cue(scene, line, local, 0, LAUNCH_VOICE.lines[String(line)].sentences.length - 1);

// Scene-local frames where things happen that the voice names. Scenes import these too.
// Create with Prompt+: a few words typed, Prompt+ on, Send on beat 10 and a cut to the card; it
// writes the prompt and fades to the percentage (a closer shot on beat 17); the logo forms, and
// from it the image hatches full frame.
/** Seconds into line 3's sentence 2 where "and your graphics card" starts (Whisper word times). */
export const GPU_WORDS = 1.68;
export const CREATE = { ask: 100, pill: 150, send: 172, job: 173, write: 180, written: 244, leave: 256, form: 278, closer: 279, done: 294, hatch: 300, full: 355, promises: 360 };
// Shot changes (removeCut, removeShot, addCut, addShot) and the scene's end sit on beats.
export const REGION = { paint: 46, paint1: 130, removeCut: 138, remove: 150, removeSend: 177, removeShot: 185, addCut: 246, add: 256, addSend: 298, addShot: 307, same: 344 };
export const MONTAGE_EDIT = 91.5; // 1.5 bars
// Five edits ("Shoot a product ad." made room for Prompt+ in Create, so the drop stays put).
export const MONTAGE = { edits: 5, mosaic: 458 };
export const AGENT = { works: 83, ask: 150 };
export const OUTRO = { try: 102, knows: 144 };

export const CUES: Cue[] = [
  all("intro", 1, 38),
  all("hook", 2, 15),
  cue("create", 3, 12, 0),
  // The two Prompt+ sentences in one cue: the take's own 0.4 s pause between them.
  cue("create", 3, CREATE.ask, 1, 2),
  cue("create", 3, CREATE.promises, 3, 5),
  cue("region", 4, 6, 0),
  cue("region", 4, 58, 1),
  cue("region", 4, REGION.remove, 2),
  cue("region", 4, REGION.add, 3),
  cue("region", 4, REGION.same, 4),
  all("versions", 5, 10),
  ...Array.from({ length: MONTAGE.edits }, (_, i) => cue("montage", 6, Math.round(i * MONTAGE_EDIT) + 4, i)),
  // Sentence 5 ("Shoot a product ad.") is no longer played.
  cue("montage", 6, MONTAGE.mosaic + 3, 6),
  cue("agent", 7, 14, 0),
  cue("agent", 7, AGENT.works, 1),
  cue("agent", 7, AGENT.ask, 2),
  all("hardware", 8, 6),
  cue("outro", 9, 4, 0, 1),
  cue("outro", 9, OUTRO.try, 2),
  cue("outro", 9, OUTRO.knows, 3),
];

/** The cues of a scene with their start in scene-local frames. */
export const sceneCues = (scene: SceneName) => CUES.filter((c) => c.at >= START[scene] && c.at < START[scene] + LENGTH[scene]).map((c) => ({ ...c, at: c.at - START[scene] }));
