// Pure UI logic (unit-tested in logic.test.ts).

import type { Advanced, GenerationRecord, GenerationRequest, InpaintAction, InputRecord, InstallItem, JobView, LoraItem, LutInfo, Mode, OutpaintSpec, Plan, Quality, ResolutionMode, Size } from "./types";

export interface Ref {
  key: string;
  /** "input:<id>" or "gen:<id>" */
  source: string;
  width: number;
  height: number;
  name: string;
  /** HEIC source with an HDR gain map. */
  hdr?: boolean;
}

export interface Composer {
  prompt: string;
  refs: Ref[];
  /** Mask painted on refs[0] (input id of the mask PNG). */
  mask: { inputId: string; refKey: string } | null;
  /** What to do in the painted area. */
  inpaintAction: InpaintAction;
  outpaint: OutpaintSpec | null;
  mode: Mode;
  aspect: string;
  quality: Quality;
  resolution: ResolutionMode;
  customWidth: number;
  customHeight: number;
  seed: number | null;
  advanced: Advanced;
  /** Prompt enhancer on (remembered; used only where `enhancerApplies`). */
  enhance: boolean;
  /** LoRAs switched on in this project; null = the ones on by default (`activeLoras`). */
  loras: string[] | null;
}

/** A preset name from any version: older ones also had "turbo" (now Fast) and "ultra" (now Quality). */
export function normalizeQuality(q: unknown, fallback: Quality = "fast"): Quality {
  if (q === "fast" || q === "balanced" || q === "quality") return q;
  if (q === "turbo") return "fast";
  if (q === "ultra") return "quality";
  return fallback;
}

export const emptyComposer = (prefs?: Partial<Composer>): Composer => ({
  prompt: "",
  refs: [],
  mask: null,
  inpaintAction: "edit",
  outpaint: null,
  mode: "auto",
  aspect: prefs?.aspect ?? "auto",
  quality: normalizeQuality(prefs?.quality),
  resolution: prefs?.resolution ?? "auto",
  customWidth: prefs?.customWidth ?? 1024,
  customHeight: prefs?.customHeight ?? 1024,
  seed: null,
  advanced: newChatAdvanced(prefs?.advanced),
  enhance: prefs?.enhance === true,
  loras: null,
});

/** LoRAs one image can use at once (`lora::MAX_ACTIVE`). */
export const MAX_LORAS = 3;

/** The LoRAs a request from this composer uses: the project's choice, else the ones on by
 * default; only loaded ones whose copy is there, at most `MAX_LORAS`. */
export function activeLoras(c: Pick<Composer, "loras">, all: LoraItem[]): string[] {
  const usable = new Set(all.filter((l) => l.available).map((l) => l.id));
  const chosen = c.loras ?? all.filter((l) => l.onByDefault).map((l) => l.id);
  return chosen.filter((id) => usable.has(id)).slice(0, MAX_LORAS);
}

/** The project's LoRA choice after switching `id` on or off. */
export function toggleLora(c: Pick<Composer, "loras">, all: LoraItem[], id: string): string[] {
  const now = activeLoras(c, all);
  if (now.includes(id)) return now.filter((x) => x !== id);
  return now.length < MAX_LORAS ? [...now, id] : now;
}

/** Advanced settings a new chat starts with: everything kept except Reference detail, which
 * every chat starts at the standard 1 MP. */
function newChatAdvanced(a: Advanced | undefined): Advanced {
  const { reference_detail: _, ...rest } = a ?? {};
  return rest;
}

let counter = 0;
export const newKey = () => `k${Date.now().toString(36)}${(counter++).toString(36)}`;

export const refFromInput = (r: InputRecord): Ref => ({ key: newKey(), source: `input:${r.id}`, width: r.width, height: r.height, name: r.original_name ? decodeSafe(r.original_name) : "Image", hdr: r.hdr || undefined });
export const refFromGen = (g: GenerationRecord): Ref => ({ key: newKey(), source: `gen:${g.id}`, width: g.width, height: g.height, name: "Result" });

function decodeSafe(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Moves a reference, keeping all others in order. */
export function moveRef(refs: Ref[], from: number, to: number): Ref[] {
  if (from === to || from < 0 || from >= refs.length) return refs;
  const out = refs.slice();
  const [r] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, r);
  return out;
}

export function hasOutpaint(o: OutpaintSpec | null): boolean {
  return !!o && (o.left > 0 || o.right > 0 || o.top > 0 || o.bottom > 0);
}

/** Composer state -> stable service request. */
export function buildRequest(c: Composer, parentId?: string | null): GenerationRequest {
  const maskValid = c.mask && c.refs[0] && c.mask.refKey === c.refs[0].key;
  const custom = c.resolution === "custom";
  // Inpaint and expand keep the source's shape; create, edit and combine take the chosen ratio.
  const shaped = !maskValid && !hasOutpaint(c.outpaint);
  return {
    prompt: c.prompt.trim(),
    mode: c.mode,
    images: c.mode === "generate" ? [] : c.refs.map((r) => r.source),
    mask: maskValid ? `input:${c.mask!.inputId}` : null,
    ...(maskValid ? { inpaint_action: c.inpaintAction } : {}),
    outpaint: hasOutpaint(c.outpaint) ? c.outpaint : null,
    quality: c.quality,
    resolution: c.resolution,
    aspect_ratio: shaped && c.aspect !== "auto" && !custom ? c.aspect : null,
    width: custom ? c.customWidth : null,
    height: custom ? c.customHeight : null,
    seed: c.seed,
    preserve_dimensions: true,
    advanced: cleanAdvanced(c.advanced),
    client: "ui",
    parent_id: parentId ?? null,
    ...(c.enhance && enhancerApplies(c) ? { enhance: true } : {}),
  };
}

/** The prompt enhancer works on new images, edits and combines; a painted area or an expansion
 * wraps the prompt in its own instruction. */
export function enhancerApplies(c: Composer): boolean {
  const maskValid = c.mask && c.refs[0] && c.mask.refKey === c.refs[0].key;
  return !maskValid && !hasOutpaint(c.outpaint);
}

/** False only for a removal in a painted area, which needs no description. */
export function needsPrompt(c: Composer): boolean {
  const maskValid = c.mask && c.refs[0] && c.mask.refKey === c.refs[0].key;
  return !(maskValid && c.inpaintAction === "remove");
}

/** Advanced fields that change how the model samples. They last for the session only: a value
 * typed once must not silently override the presets after a restart. */
const SAMPLING_OVERRIDES = ["sampler", "strength", "reference_detail"];
/** Fields of older versions that Turbo's fixed schedule no longer uses (may sit in saved
 * preferences, projects and gallery records): dropped everywhere. */
const REMOVED_ADVANCED = ["steps", "cfg", "scheduler", "flow_shift", "refine"];

/** Labels of the sampling overrides currently set, e.g. ["Sampler heun", "Strength 0.8"]. */
export function activeOverrides(a: Advanced): string[] {
  const label: Record<string, string> = { sampler: "Sampler", strength: "Strength", reference_detail: "Reference" };
  return Object.entries(cleanAdvanced(a))
    .filter(([k]) => SAMPLING_OVERRIDES.includes(k))
    .map(([k, v]) => `${label[k]} ${v}`);
}

/** `a` without the session-only sampling overrides (what is kept in saved preferences). */
export function persistentAdvanced(a: Advanced | undefined): Advanced {
  const out = cleanAdvanced(a ?? {});
  for (const k of SAMPLING_OVERRIDES) delete (out as Record<string, unknown>)[k];
  return out;
}

function cleanAdvanced(a: Advanced): Advanced {
  const out: Advanced = {};
  for (const [k, v] of Object.entries(a)) {
    if (v !== null && v !== undefined && v !== "" && !REMOVED_ADVANCED.includes(k)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Restores composer fields from a stored generation (gallery "reopen"). */
export function composerFromRecord(g: GenerationRecord, base: Composer): Composer {
  const req = g.request;
  const refs: Ref[] = g.references.map((r) => ({ key: newKey(), source: `input:${r.input_id}`, width: r.width, height: r.height, name: `Image ${r.index + 1}` }));
  const c: Composer = {
    ...base,
    // An enhanced result is the user's prompt with the enhancer on (Reuse prompt takes its text).
    prompt: g.original_prompt ?? g.prompt,
    enhance: !!g.original_prompt,
    refs,
    mask: g.mask_input_id && refs[0] ? { inputId: g.mask_input_id, refKey: refs[0].key } : null,
    inpaintAction: req?.inpaint_action ?? "edit",
    outpaint: g.outpaint ? { ...g.outpaint, units: "pixels" } : null,
    // Upscales are started from the image toolbar, not the composer.
    mode: req?.mode && req.mode !== "upscale" && g.mode !== "lut" ? req.mode : "auto",
    quality: normalizeQuality(g.quality, base.quality),
    resolution: req?.resolution ?? base.resolution,
    aspect: req?.aspect_ratio ?? "auto",
    seed: null,
    advanced: cleanAdvanced(req?.advanced ?? {}),
    // The LoRAs it was made with (none for images made before LoRAs or without them).
    loras: (g.loras ?? []).map((l) => l.id),
  };
  if (req?.width && req?.height) {
    c.customWidth = req.width;
    c.customHeight = req.height;
  }
  return c;
}

/** A variation: same recipe, new random seed. */
export function variationRequest(g: GenerationRecord): GenerationRequest | null {
  if (!g.request) return null;
  return { ...g.request, seed: null, client: "ui", parent_id: g.id };
}

export const MODE_LABEL: Record<Mode | "lut", string> = {
  auto: "Auto",
  generate: "Create",
  edit: "Edit",
  inpaint: "Inpaint",
  outpaint: "Expand",
  multi_reference: "Combine",
  upscale: "Upscale",
  lut: "LUT",
};

/** How a LUT is shown: a preset ("kokon:<key>") by its title, a user's LUT by its file name. */
export function lutLabel(l: { name: string; title?: string | null }): string {
  return l.name.startsWith("kokon:") ? l.title || l.name.slice(6) : l.name;
}

/** The LUT a "lut" result was made with. */
export function lutInfo(g: GenerationRecord): LutInfo | null {
  return g.mode === "lut" ? ((g.request as unknown as { lut?: LutInfo } | null)?.lut ?? null) : null;
}

/** Short names within a project. Every image that starts something new (a new image, a new
 * seed of one, an import) gets the next number: "1", "2"… Everything made from it (edits,
 * edits of edits, combinations led by it, upscales) is numbered within it: "1.1", "1.2"…
 * `from`/`variant` as in timelineLinks. */
export function versionLabels(items: { key: string; source: string | null; from: string[]; variant?: boolean }[]): Record<string, string> {
  const links = timelineLinks(items);
  const out: Record<string, string> = {};
  const family: Record<string, string> = {};
  const count: Record<string, number> = {};
  let images = 0;
  for (const it of items) {
    const parent = links[it.key].parents[0];
    if (!parent || it.variant) {
      const n = String(++images);
      family[it.key] = n;
      out[it.key] = n;
    } else {
      const f = family[parent];
      family[it.key] = f;
      count[f] = (count[f] ?? 0) + 1;
      out[it.key] = `${f}.${count[f]}`;
    }
  }
  return out;
}

export interface ArcPlace {
  /** 0 = lowest level; an arc sits above every shorter arc it spans or overlaps. */
  lane: number;
  /** Horizontal shift of each end from its thumbnail's centre, so arcs meeting at one
   * thumbnail do not share a point. */
  dx1: number;
  dx2: number;
}

/** Places arcs between items at positions `a` -> `b` (indexes along the timeline). */
export function arcLayout(arcs: { a: number; b: number }[], spread = 8, maxShift = 16): ArcPlace[] {
  const lanes: { lo: number; hi: number }[][] = [];
  const order = arcs.map((_, i) => i).sort((i, j) => Math.abs(arcs[i].b - arcs[i].a) - Math.abs(arcs[j].b - arcs[j].a) || Math.min(arcs[i].a, arcs[i].b) - Math.min(arcs[j].a, arcs[j].b));
  const out: ArcPlace[] = arcs.map(() => ({ lane: 0, dx1: 0, dx2: 0 }));
  for (const i of order) {
    const lo = Math.min(arcs[i].a, arcs[i].b);
    const hi = Math.max(arcs[i].a, arcs[i].b);
    let lane = 0;
    while (lanes[lane]?.some((s) => lo <= s.hi && s.lo <= hi)) lane++;
    (lanes[lane] ??= []).push({ lo, hi });
    out[i].lane = lane;
  }
  // Ends at the same item, ordered by where the other end lies (left to right), spread out.
  const ends = new Map<number, { arc: number; end: "dx1" | "dx2"; other: number }[]>();
  arcs.forEach((r, i) => {
    for (const [at, end, other] of [[r.a, "dx1", r.b], [r.b, "dx2", r.a]] as const) {
      if (!ends.has(at)) ends.set(at, []);
      ends.get(at)!.push({ arc: i, end, other });
    }
  });
  for (const list of ends.values()) {
    list.sort((p, q) => p.other - q.other);
    const step = list.length > 1 ? Math.min(spread, (2 * maxShift) / (list.length - 1)) : 0;
    list.forEach((e, k) => (out[e.arc][e.end] = (k - (list.length - 1) / 2) * step));
  }
  return out;
}

/** "Image 1.2" for a short name, for sentences and headings. */
export const imageName = (label: string | undefined) => (label ? `Image ${label}` : "Image");

/** How a version joins the timeline: "start" begins a new line (a new image or an import),
 * "next" continues from the version just before it, "variant" is the version before made
 * again with a new seed, "branch" comes from an earlier version, "combine" from several. */
export type LinkKind = "start" | "next" | "variant" | "branch" | "combine";

export interface TimelineLink {
  kind: LinkKind;
  /** Keys of the versions this one was made from (in reference order). */
  parents: string[];
}

/** Links between versions. `from` are the "gen:<id>"/"input:<id>" sources an item was made
 * from; `variant` marks a new seed of `from[0]` rather than an edit of it. Sources that are
 * not in the project are ignored. */
export function timelineLinks(items: { key: string; source: string | null; from: string[]; variant?: boolean }[]): Record<string, TimelineLink> {
  const bySource = new Map<string, string>();
  const out: Record<string, TimelineLink> = {};
  items.forEach((it, i) => {
    const parents = [...new Set(it.from.map((f) => bySource.get(f)).filter((k): k is string => !!k && k !== it.key))];
    const prev = items[i - 1]?.key;
    const kind: LinkKind = !parents.length ? "start" : parents.length > 1 ? "combine" : parents[0] !== prev ? "branch" : it.variant ? "variant" : "next";
    out[it.key] = { kind, parents };
    if (it.source) bySource.set(it.source, it.key);
  });
  return out;
}

/** "1m ago"-style age for the project list. */
export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Short truthful status text for a job. */
export function jobLabel(j: JobView): string {
  switch (j.status) {
    case "queued":
      return j.queue_position > 1 ? `Queued · ${j.queue_position}` : "Queued";
    case "starting_backend":
      return "Loading model";
    case "preparing":
      return "Preparing";
    case "enhancing_prompt":
      return "Writing the prompt";
    case "saving":
      return "Saving";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "running": {
      const batch = j.image && j.image[1] > 1 ? ` · ${j.image[0]}/${j.image[1]}` : "";
      switch (j.stage) {
        case "preparing":
          return "Preparing";
        case "encoding_images":
          return "Encoding references";
        case "encoding_prompt":
          return "Reading prompt";
        case "generating":
          return j.step ? `Generating · ${j.step[0]}/${j.step[1]}${batch}` : `Generating${batch}`;
        case "upscaling":
          return j.step ? `Upscaling · ${j.step[0]}/${j.step[1]}${batch}` : `Upscaling${batch}`;
        case "refining":
          return j.step ? `Refining · ${j.step[0]}/${j.step[1]}${batch}` : `Refining${batch}`;
        case "decoding":
          return "Decoding";
        case "finishing":
          return "Finishing";
        default:
          return "Working";
      }
    }
  }
}

/** What the progress knows besides the job (seconds): time since the job left the queue,
 * time in the current phase (status and stage), since the job started running and since the
 * last step or tile; whether the prompt enhancer runs for it; and this machine's remembered
 * speeds (`progressMemory`). */
export interface JobClock {
  elapsed: number;
  inPhase: number;
  inRunning: number;
  sinceStep: number;
  enhance: boolean;
  /** Seconds the model took to load the last time. */
  loadSeconds: number;
  /** Seconds the prompt enhancer took per word the last time. */
  enhancerSecondsPerWord: number;
}

/** About how many words the built-in enhancer prompts ask for. */
const ENHANCER_WORDS = { generate: 110, edit: 35 };
const SAVE_SECONDS = 1;

/** Time left of a phase estimated at `est` seconds, `t` seconds in. Past ~80 % of the
 * estimate it keeps shrinking without reaching 0, so an overrun slows the bar instead of
 * stopping it. */
function phaseLeft(est: number, t: number): number {
  if (est <= 0) return 0;
  return t < 0.8 * est ? est - t : (0.16 * est * est) / t;
}

/** Estimated seconds until the job is done: what is left of the current phase, measured where
 * the engine reports progress (steps, tiles, the enhancer's words), plus every phase still to
 * come (model load, enhancer, generation, decoding, upscaler, saving). */
export function jobSecondsLeft(j: JobView, c: JobClock): number {
  const p = j.plan;
  const quick = p?.mode === "upscale";
  // The plan's split of the time; without a measured speed, a typical job (corrected live by the
  // steps and tiles as they come).
  const total = p && p.estimated_seconds > 0 ? p.estimated_seconds : quick ? 8 : 30;
  const share = quick ? 1 : Math.min(0.95, Math.max(0, p?.upscale_share ?? 0));
  const upS = total * share;
  const genS = total - upS;
  const decodeS = genS * 0.1;
  const batch = Math.max(1, p?.batch_count ?? 1);
  const imagesAfter = j.image && j.image[1] > 1 ? j.image[1] - j.image[0] : 0;
  const words = ENHANCER_WORDS[p?.mode === "generate" ? "generate" : "edit"];
  const enhanceS = c.enhance ? 0.5 + words * c.enhancerSecondsPerWord : 0;
  const fromGeneration = genS + upS + SAVE_SECONDS;
  switch (j.status) {
    case "queued":
    case "starting_backend":
      return phaseLeft(c.loadSeconds, j.status === "queued" ? 0 : c.inPhase) + enhanceS + fromGeneration;
    case "preparing":
      return phaseLeft(0.5, c.inPhase) + enhanceS + fromGeneration;
    case "enhancing_prompt": {
      const written = (j.enhanced_prompt ?? "").split(/\s+/).filter(Boolean).length;
      // Once it writes, its own pace says how long the rest takes.
      const left = written >= 8 ? (Math.max(words - written, words * 0.05) * c.inPhase) / written : phaseLeft(enhanceS, c.inPhase);
      return left + fromGeneration;
    }
    case "saving":
      return phaseLeft(SAVE_SECONDS, c.inPhase);
    case "done":
    case "failed":
    case "cancelled":
      return 0;
  }
  switch (j.stage) {
    case "upscaling": {
      const perImage = upS / batch;
      const after = (imagesAfter * upS) / batch + SAVE_SECONDS;
      if (j.step && j.step[1] > 0) {
        const perTile = j.seconds_per_step ?? perImage / j.step[1];
        const within = Math.min(0.95, c.sinceStep / perTile);
        return Math.max(0, j.step[1] - j.step[0] - within) * perTile + after;
      }
      return phaseLeft(perImage, c.inPhase) + after;
    }
    case "finishing":
      return phaseLeft(0.5, c.inPhase) + upS + SAVE_SECONDS;
    case "decoding":
      return phaseLeft(decodeS / batch, c.inPhase) + (imagesAfter * genS) / batch + upS + SAVE_SECONDS;
    case "generating":
    case "refining":
      if (j.step && j.step[1] > 0) {
        const perStep = j.seconds_per_step ?? (0.85 * genS) / batch / j.step[1];
        const within = Math.min(0.95, c.sinceStep / perStep);
        return Math.max(0, j.step[1] - j.step[0] - within) * perStep + decodeS / batch + (imagesAfter * genS) / batch + upS + SAVE_SECONDS;
      }
  }
  // Encoding, or a server that reports no steps: time against the generation estimate.
  return phaseLeft(genS, c.inRunning) + upS + SAVE_SECONDS;
}

/** Completion (0..100) of the whole job, model load to saved file: the time it has taken over
 * that time plus the time left (`jobSecondsLeft`). Short of 100 until the job is done. */
export function jobPercent(j: JobView, c: JobClock): number {
  if (j.status === "done") return 100;
  if (j.status === "queued" || j.status === "failed" || j.status === "cancelled" || c.elapsed <= 0) return 0;
  return Math.min(99, (100 * c.elapsed) / (c.elapsed + jobSecondsLeft(j, c)));
}

/** Time left to show, only once the engine's own pace is known (steps or tiles running). */
export function remainingSeconds(j: JobView, c: JobClock): number | null {
  if (j.status !== "running" || !j.step || !j.seconds_per_step) return null;
  if (j.stage !== "generating" && j.stage !== "upscaling") return null;
  return jobSecondsLeft(j, c);
}

// ---------------------------------------------------------------------------------------
// Upscaling
// ---------------------------------------------------------------------------------------

/** Server limits for upscale results (8192 px per side, ~40 MP). */
export const MAX_UPSCALE_SIDE = 8192;
export const MAX_UPSCALE_AREA = 40_000_000;

export interface UpscaleTarget { key: string; label: string; width: number; height: number }

const fits = (s: Size) => s.width >= 64 && s.height >= 64 && s.width <= MAX_UPSCALE_SIDE && s.height <= MAX_UPSCALE_SIDE && s.width * s.height <= MAX_UPSCALE_AREA;

/** Size with the given width and the source's aspect ratio. */
export function sizeForWidth(w: number, h: number, width: number): Size {
  return { width: Math.round(width), height: Math.max(1, Math.round((width * h) / w)) };
}

/** Upscale presets for a w×h image: 2x, 4K (3840 long side) and the original source
 * size of an edit, when each is a real enlargement within the limits. */
export function upscaleTargets(w: number, h: number, source?: Size | null): UpscaleTarget[] {
  const out: UpscaleTarget[] = [];
  const add = (key: string, label: string, s: Size) => {
    if (fits(s) && s.width * s.height > w * h * 1.05 && !out.some((o) => o.width === s.width && o.height === s.height)) out.push({ key, label, ...s });
  };
  add("2x", "2×", { width: w * 2, height: h * 2 });
  const k4 = w >= h ? sizeForWidth(w, h, 3840) : { width: Math.round((3840 * w) / h), height: 3840 };
  add("4k", "4K", k4);
  if (source) add("source", "Source size", source);
  return out;
}

export function upscaleRequest(source: string, target: Size, parentId?: string | null): GenerationRequest {
  return {
    prompt: "",
    mode: "upscale",
    images: [source],
    quality: "fast",
    resolution: "auto",
    preserve_dimensions: true,
    advanced: {},
    client: "ui",
    parent_id: parentId ?? null,
    upscale: { method: "quick", width: target.width, height: target.height },
  };
}

const dims = (s: Size) => `${s.width}×${s.height}`;
/** Upscaler models offered in Settings: [file stem, label]. Mirrors UPSCALER_CHOICES in config.rs. */
export const UPSCALERS: [string, string][] = [
  ["4x_NMKD-Superscale-SP_178000_G", "Superscale-SP"],
  ["4xNomos2_hq_mosr", "MoSR"],
  ["4x-UltraSharp", "UltraSharp"],
  ["lanczos", "Lanczos"],
];
const UPSCALER_LABELS: Record<string, string> = Object.fromEntries(UPSCALERS);

/** Short name of the upscaler that ran or will run: "Superscale-SP", "MoSR", "Lanczos"... */
export const upscalerLabel = (name: string | null | undefined) => (!name || name === "Lanczos" ? "Lanczos" : UPSCALER_LABELS[name] ?? name);

/** "1376×768 → 5120×2880 (MoSR)" for the Details panel; two-pass records from
 * older versions read "1376×768 → refined 2048×1152 (Fast, 6 steps, UltraSharp) → ...". */
export function pipelineSummary(g: GenerationRecord): string | null {
  const p = g.pipeline;
  if (!p) return null;
  const parts: string[] = [];
  if (p.base) {
    const mode = p.refine === "best" ? "Best" : "Fast";
    parts.push(dims(p.base), `refined ${g.working_width}×${g.working_height} (${mode}, ${p.refine_steps ?? "?"} steps, ${upscalerLabel(p.hires_upscaler)})`);
  }
  if (p.enlarged_with && p.enlarged_from) {
    if (!parts.length) parts.push(dims(p.enlarged_from));
    parts.push(`${g.width}×${g.height} (${upscalerLabel(p.enlarged_with)})`);
  }
  return parts.length ? parts.join(" → ") : null;
}

/** Short description of what a plan will do, for the Advanced panel. */
export function planPipeline(plan: Plan): string {
  const out = dims(plan.output);
  const enlarge = plan.output.width * plan.output.height > plan.content.width * plan.content.height * 1.21;
  const via = upscalerLabel(plan.upscaler);
  if (plan.upscale?.method === "quick") return `${dims(plan.upscale.source)} → ${out} (${via})`;
  const work = dims(plan.working);
  return enlarge ? `${work} render → ${out} output (${via})` : `${work} render → ${out} output`;
}

export function formatDuration(s: number): string {
  const t = Math.round(s);
  if (t < 60) return `${Math.max(1, t)}s`;
  const m = Math.floor(t / 60);
  return t % 60 ? `${m}m ${t % 60}s` : `${m}m`;
}

/** Undo target for version `key`: the version it was made from (`from` is that image's
 * "gen:<id>"/"input:<id>"), or the version before it when that one is not in the project. */
export function undoTarget(items: { key: string; source: string | null; from: string | null }[], key: string): string | null {
  const i = items.findIndex((x) => x.key === key);
  if (i < 0) return null;
  const from = items[i].from;
  const parent = from ? items.find((x) => x.source === from && x.key !== key) : undefined;
  if (parent) return parent.key;
  return i > 0 ? items[i - 1].key : null;
}

/** 1.2 GB, 340 MB, 12 KB (decimal units, like download sizes on Hugging Face and GitHub). */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  return `${Math.max(0, Math.round(n / 1e3))} KB`;
}

/** Overall download progress over the files that were not installed already. */
export function installProgress(items: InstallItem[]): { received: number; total: number; frac: number } {
  const todo = items.filter((i) => i.state !== "present");
  const total = todo.reduce((a, i) => a + i.size, 0);
  const received = todo.reduce((a, i) => a + Math.min(i.received, i.size), 0);
  return { received, total, frac: total ? received / total : 1 };
}

/** One line under a file in the setup wizard. */
export function installItemText(i: InstallItem, bytesPerSec: number): string {
  switch (i.state) {
    case "present":
    case "done":
      return `Installed · ${formatBytes(i.size)}`;
    case "pending":
      return `To download · ${formatBytes(i.size - i.received)}`;
    case "downloading": {
      const rate = bytesPerSec > 0 ? ` · ${formatBytes(bytesPerSec)}/s` : "";
      const left = bytesPerSec > 0 ? ` · ${formatDuration((i.size - i.received) / bytesPerSec)} left` : "";
      return `${formatBytes(i.received)} of ${formatBytes(i.size)}${rate}${left}`;
    }
    case "verifying":
      return "Checking the file…";
    case "extracting":
      return "Extracting…";
    case "cancelled":
      return i.received ? `Paused at ${formatBytes(i.received)}; continues where it stopped` : "Cancelled";
    case "failed":
      return i.error ?? "Failed";
  }
}

/** Right-hand status of a file in the setup list. */
export function installItemShort(i: InstallItem): string {
  switch (i.state) {
    case "present":
    case "done":
      return "Installed";
    case "downloading":
      return `${Math.floor((i.received / i.size) * 100)}%`;
    case "verifying":
      return "Checking";
    case "extracting":
      return "Extracting";
    case "failed":
      return "Failed";
    case "cancelled":
      return i.received ? `Paused · ${formatBytes(i.size - i.received)} left` : formatBytes(i.size);
    case "pending":
      return formatBytes(i.size - i.received);
  }
}

/** What the installer is doing right now, for the progress panel. */
export function installStep(items: InstallItem[]): string | null {
  const it = items.find((i) => i.state === "downloading" || i.state === "verifying" || i.state === "extracting");
  if (!it) return null;
  if (it.state === "verifying") return `Checking ${it.label}`;
  if (it.state === "extracting") return `Unpacking ${it.label}`;
  return `Downloading ${it.label}`;
}

/** "about 2 min left" once the speed is known. */
export function installTimeLeft(remaining: number, bytesPerSec: number): string | null {
  if (bytesPerSec < 100e3 || remaining <= 0) return null;
  const s = remaining / bytesPerSec;
  return s < 60 ? "less than a minute left" : `about ${Math.ceil(s / 60)} min left`;
}

/** Aspect ratios offered in the menus (landscape, then its portrait twin). */
export const ASPECTS = ["1:1", "5:4", "4:5", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21"] as const;

/** "16:9" -> 1.777…; null when it is not a usable ratio (the service accepts 1:8 to 8:1). */
export function parseRatio(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x×/]\s*(\d+(?:\.\d+)?)\s*$/i.exec(s);
  if (!m) return null;
  const r = Number(m[1]) / Number(m[2]);
  return Number.isFinite(r) && r >= 0.125 && r <= 8 ? r : null;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Readable ratio of a size: "16:9" when it is (within 1 %) a common ratio, the reduced
 * fraction when that is short ("7:5"), else "1.85:1". */
export function aspectLabel(w: number, h: number): string {
  if (w <= 0 || h <= 0) return "";
  const r = w / h;
  const known = ASPECTS.find((a) => Math.abs(parseRatio(a)! / r - 1) < 0.01);
  if (known) return known;
  const g = gcd(Math.round(w), Math.round(h));
  const a = Math.round(w) / g;
  const b = Math.round(h) / g;
  if (a <= 32 && b <= 32) return `${a}:${b}`;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

/** Width × height with ratio `r` and about the given pixel area, rounded to multiples of 16. */
export function sizeForRatio(r: number, area: number, max = 4096): Size {
  const r16 = (v: number) => Math.max(64, Math.min(max, Math.round(v / 16) * 16));
  return { width: r16(Math.sqrt(area * r)), height: r16(Math.sqrt(area / r)) };
}

/** Expansion (source pixels, centred) that turns a w×h image into ratio `r` without cropping. */
export function expandToRatio(w: number, h: number, r: number): OutpaintSpec {
  if (w / h < r) {
    const extra = Math.max(0, Math.round(h * r) - w);
    return { left: Math.floor(extra / 2), right: extra - Math.floor(extra / 2), top: 0, bottom: 0, units: "pixels" };
  }
  const extra = Math.max(0, Math.round(w / r) - h);
  return { left: 0, right: 0, top: Math.floor(extra / 2), bottom: extra - Math.floor(extra / 2), units: "pixels" };
}

/** Expansion (centred) to an exact final size; a side smaller than the source stays as it is. */
export function expandToSize(w: number, h: number, W: number, H: number): OutpaintSpec {
  const ex = Math.max(0, Math.round(W) - w);
  const ey = Math.max(0, Math.round(H) - h);
  return { left: Math.floor(ex / 2), right: ex - Math.floor(ex / 2), top: Math.floor(ey / 2), bottom: ey - Math.floor(ey / 2), units: "pixels" };
}

/** Expansion presets in source pixels. */
export function expansionPreset(kind: "left" | "right" | "top" | "bottom" | "landscape" | "portrait" | "square", w: number, h: number, cur: OutpaintSpec): OutpaintSpec {
  const base: OutpaintSpec = { left: cur.left, right: cur.right, top: cur.top, bottom: cur.bottom, units: "pixels" };
  const qx = Math.round(w * 0.25);
  const qy = Math.round(h * 0.25);
  const toAspect = (a: number): OutpaintSpec => {
    if (w / h < a) {
      const extra = Math.max(0, Math.round(h * a) - w);
      return { left: Math.floor(extra / 2), right: extra - Math.floor(extra / 2), top: 0, bottom: 0, units: "pixels" };
    }
    const extra = Math.max(0, Math.round(w / a) - h);
    return { left: 0, right: 0, top: Math.floor(extra / 2), bottom: extra - Math.floor(extra / 2), units: "pixels" };
  };
  switch (kind) {
    case "left":
      return { ...base, left: base.left + qx };
    case "right":
      return { ...base, right: base.right + qx };
    case "top":
      return { ...base, top: base.top + qy };
    case "bottom":
      return { ...base, bottom: base.bottom + qy };
    case "landscape":
      return toAspect(16 / 9);
    case "portrait":
      return toAspect(9 / 16);
    case "square":
      return toAspect(1);
  }
}

/** Expansion in pixels regardless of units. */
export function expansionPixels(o: OutpaintSpec, w: number, h: number) {
  const f = (v: number, b: number) => (o.units === "percent" ? Math.round((b * v) / 100) : Math.round(v));
  return { left: f(o.left, w), right: f(o.right, w), top: f(o.top, h), bottom: f(o.bottom, h) };
}

// ---------------------------------------------------------------------------------------
// Before / after comparison
// ---------------------------------------------------------------------------------------

export type CompareMode = "off" | "slider" | "flicker" | "diff";

/** The image a result was made from and where it sits inside the result, as fractions of the
 * result's width/height (an expanded image sits inside a larger canvas). */
export interface CompareBase {
  inputId: string;
  rect: { x: number; y: number; w: number; h: number };
}

export function compareBase(g: GenerationRecord): CompareBase | null {
  const r = g.references[0];
  // A new image or a combination of several has no single "before".
  if (!r || !["edit", "inpaint", "outpaint", "upscale", "lut"].includes(g.mode)) return null;
  const o = g.outpaint;
  if (g.mode === "outpaint" && o) {
    // Expansion is in source pixels; the result is the source plus the expansion.
    const W = r.width + o.left + o.right;
    const H = r.height + o.top + o.bottom;
    return { inputId: r.input_id, rect: { x: o.left / W, y: o.top / H, w: r.width / W, h: r.height / H } };
  }
  return { inputId: r.input_id, rect: { x: 0, y: 0, w: 1, h: 1 } };
}

/** Per-pixel change between two equally sized RGBA buffers: the dimmed result in grey with
 * changed pixels in red (stronger = bigger change). Pixels the "before" does not cover
 * (alpha 0, e.g. expanded areas) count as changed. Returns the changed share of the image. */
export function diffPixels(after: Uint8ClampedArray, before: Uint8ClampedArray, out: Uint8ClampedArray, threshold = 24): number {
  let changed = 0;
  const n = after.length / 4;
  for (let i = 0; i < after.length; i += 4) {
    const grey = 0.3 * (0.299 * after[i] + 0.587 * after[i + 1] + 0.114 * after[i + 2]);
    const d = before[i + 3] < 128 ? 255 : Math.max(Math.abs(after[i] - before[i]), Math.abs(after[i + 1] - before[i + 1]), Math.abs(after[i + 2] - before[i + 2]));
    const a = d <= threshold ? 0 : Math.min(1, 0.35 + (d - threshold) / 96);
    if (a > 0) changed++;
    out[i] = grey + (255 - grey) * a;
    out[i + 1] = grey + (64 - grey) * a;
    out[i + 2] = grey + (64 - grey) * a;
    out[i + 3] = 255;
  }
  return n ? changed / n : 0;
}

/** Where the gallery preview stands in `ids`: on the image it shows (`id`) wherever the list
 * moved it, else at its last position `at` (clamped); null when the list is empty. */
export function previewIndex(ids: string[], id: string, at: number): number | null {
  if (!ids.length) return null;
  const i = ids.indexOf(id);
  return i >= 0 ? i : Math.min(Math.max(at, 0), ids.length - 1);
}

/** The image to show once `id` leaves the list: the next one, the previous at the end, or
 * null when it was the only one (or not in the list). */
export function neighbourAfterRemoval(ids: string[], id: string): string | null {
  const i = ids.indexOf(id);
  if (i < 0) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** Images made with the app before the one-time "star on GitHub" card. */
export const STAR_PROMPT_AFTER = 5;

/** Whether to show the star card now: enough images made, and nothing else on screen (a dialog,
 * the tour or setup), else it waits for the next finished image. */
export function starPromptDue(made: number, busy: boolean): boolean {
  return made >= STAR_PROMPT_AFTER && !busy;
}
