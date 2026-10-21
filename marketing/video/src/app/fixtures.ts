// Records, jobs and state shaped exactly like the service's, for the showcase images in
// public/img. Everything a scene shows goes through the app's own components.
import { emptyComposer, type Composer } from "../../../../src/lib/logic";
import { getState, type SessionItem, type State } from "../mocks/store";
import type { GenerationRecord, GenerationRequest, InpaintAction, JobView, LoraItem, ResolvedMode } from "../../../../src/lib/types";

export const SIZES: Record<string, [number, number]> = {
  street: [2752, 1536],
  "street-removed": [2752, 1536],
  "street-cat": [2752, 1536],
  cabin: [2752, 1536],
  "cabin-winter": [2752, 1536],
  bakery: [2368, 1760],
  "bakery-text": [2368, 1760],
  potter: [1760, 2368],
  "potter-watercolor": [1760, 2368],
  room: [2368, 1760],
  "room-sofa": [2368, 1760],
  lighthouse: [1536, 1536],
  "lighthouse-wide": [2764, 1536],
  sneaker: [1536, 1536],
  "sneaker-ad": [1536, 1536],
  hero: [2752, 1536],
};

export const PROMPTS = {
  street:
    "A sunny cobblestone street in a small Italian coastal town, a pastel yellow café with lemon trees, a red vintage scooter parked in front, warm late-morning light, 35mm",
  /** What the user types with Prompt+ on, and the prompt Prompt+ writes from it (the record keeps both). */
  idea: "sunny italian street, café, red scooter",
  enhanced:
    "A 35mm photograph of a sunny cobblestone street in a small Italian coastal town. On the left, a pastel yellow café with green wooden shutters has small round tables and wicker chairs on the pavement, with lemon trees in terracotta pots beside the door. A red vintage scooter stands parked in front of the café, angled toward the viewer, its chrome catching the light. The narrow street climbs gently into the background between warm stone houses with flower boxes on the windows. Warm late-morning sunlight comes from the upper right, casting soft diagonal shadows across the grey cobblestones and lighting the café's facade, with a strip of clear blue sky above the rooftops.",
  remove: "the red scooter",
  add: "a ginger cat sitting on the cobblestones, looking at the camera",
  winter: "Make it a snowy winter night, warm light glowing from the cabin windows, stars in the sky",
  text: 'Change the sign to "KOKON CAFÉ" in the same gold lettering',
  restyle: "Turn it into a hand-painted watercolor illustration",
  replace: "Replace the armchair with a green velvet sofa and hang an abstract painting above it",
  expand: "Continue the rocky coastline and the turquoise sea",
  product: "Place the sneaker on wet black stone with a soft orange rim light, advertising shot",
};

const req = (mode: GenerationRequest["mode"], prompt: string, images: string[] = [], extra: Partial<GenerationRequest> = {}): GenerationRequest => ({
  prompt,
  mode,
  images,
  quality: "quality",
  resolution: "auto",
  advanced: {},
  ...extra,
});

/** A finished image. `from` = the image it was made from (an edit's reference). */
export function gen(id: string, mode: ResolvedMode, prompt: string, from?: string, extra: Partial<GenerationRecord> = {}): GenerationRecord {
  const [w, h] = SIZES[id];
  const refs = from ? [{ index: 0, input_id: from, width: SIZES[from][0], height: SIZES[from][1] }] : [];
  return {
    id,
    created_at: "2026-10-10T09:12:36Z",
    mode,
    prompt,
    negative_prompt: "",
    seed: 1101,
    width: w,
    height: h,
    working_width: w,
    working_height: h,
    model: "qwen-image-2.1-turbo-Q4_K",
    sampler: "euler",
    scheduler: null,
    steps: 8,
    cfg: 1,
    strength: null,
    quality: "quality",
    resolution: "auto",
    references: refs,
    mask_input_id: null,
    outpaint: null,
    file_path: `C:\Users\you\Pictures\Kokon\${id}.png`,
    extra_paths: [],
    favorite: false,
    parent_id: null,
    duration_ms: 38_000,
    notes: [],
    request: req(mode, prompt, from ? [`gen:${from}`] : []),
    ...extra,
  };
}

export const genItem = (g: GenerationRecord): SessionItem => ({ key: g.id, kind: "gen", gen: g });

/** A version being made: `step` of 8 done (0 = still preparing). */
export function jobItem(key: string, mode: ResolvedMode, prompt: string, output: string, from: string | undefined, step: number, action?: InpaintAction): { item: SessionItem; job: JobView } {
  const [w, h] = SIZES[output];
  const request = req(mode, prompt, from ? [`gen:${from}`] : [], action ? { inpaint_action: action } : {});
  const running = step > 0;
  const done = step >= 8;
  const job: JobView = {
    id: key,
    status: running ? "running" : "preparing",
    stage: !running ? null : done ? "decoding" : "generating",
    step: running ? [Math.min(step, 8), 8] : null,
    image: null,
    seconds_per_step: 4.6,
    queue_position: 0,
    created_at: "2026-10-10T09:12:00Z",
    started_at: "2026-10-10T09:12:00Z",
    finished_at: null,
    prompt,
    plan: {
      mode,
      inpaint_action: action ?? null,
      auto_mode: false,
      mode_reason: "",
      output: { width: w, height: h },
      working: { width: w, height: h },
      content: { x: 0, y: 0, width: w, height: h },
      steps: 8,
      cfg: 1,
      sampler: "euler",
      strength: null,
      batch_count: 1,
      vae_tiling: false,
      references: [],
      aspect_label: "16:9",
      notes: [],
      optimized_for_vram: false,
      estimated_seconds: 38,
      upscaler: null,
      upscale: null,
    } as unknown as JobView["plan"],
    seed: 1101,
    results: [],
    error: null,
    notes: [],
    detailed_progress: true,
  };
  return { item: { key, kind: "job", jobId: key, request }, job };
}

export const ref = (id: string): Composer["refs"][number] => ({ key: `ref-${id}`, source: `gen:${id}`, width: SIZES[id][0], height: SIZES[id][1], name: id });

const H = 3600_000;
const now = Date.now();
export const PROJECTS: State["projects"] = [
  { id: "p1", title: "Kokon Café", updatedAt: now - 0.3 * H, cover: "gen:bakery-text", count: 2 },
  { id: "p2", title: "Cabin by the lake", updatedAt: now - 1.2 * H, cover: "gen:cabin-winter", count: 2 },
  { id: "p3", title: "Ceramic studio", updatedAt: now - 2.5 * H, cover: "gen:potter-watercolor", count: 2 },
  { id: "p4", title: "Living room staging", updatedAt: now - 5 * H, cover: "gen:room-sofa", count: 2 },
  { id: "p5", title: "Lighthouse panorama", updatedAt: now - 26 * H, cover: "gen:lighthouse-wide", count: 2 },
  { id: "p6", title: "Sneaker campaign", updatedAt: now - 50 * H, cover: "gen:sneaker-ad", count: 2 },
];

/** The app as it looks with nothing open, plus `patch`. */
export function appState(patch: Partial<State> = {}): State {
  return {
    ...getState(),
    connected: true, // the status capsule reads "Ready"; plan previews never resolve (mocks/api.ts)
    server: { state: "ready", owned: true, error: null },
    // The loaded engine can write prompts: the composer shows Prompt+.
    status: { server: { text_generation: true } } as unknown as State["status"],
    loras: [],
    session: [],
    selected: null,
    projectId: "current",
    projects: PROJECTS,
    sidebar: true,
    jobs: {},
    composer: emptyComposer({ quality: "quality" }),
    overlay: null,
    toasts: [],
    needsSetup: false,
    compare: "off",
    privateMode: false,
    redo: [],
    update: null,
    ...patch,
  };
}

/** The app with Settings open on the LoRA (beta) tab (Settings also reads the service's version). */
export const settingsState = (patch: Partial<State> = {}): State =>
  appState({ overlay: "settings", settingsTab: "lora", loras: [LORA], status: { server: { text_generation: true }, service: { version: "0.10.0" } } as unknown as State["status"], ...patch });

/** A LoRA the user has loaded in Settings → LoRA (beta): a stand-in name, no real file. */
export const LORA: LoraItem = {
  id: "film-look",
  name: "Film look",
  source: String.raw`C:\Users\you\Downloads\film-look.safetensors`,
  weight: 0.7,
  triggerWords: "analog film photo",
  onByDefault: false,
  size: 84_200_000,
  warning: null,
  notes: [],
  addedAt: "2026-10-20T09:00:00Z",
  available: true,
};
