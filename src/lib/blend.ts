// Layers lab "Blend into scene": moved objects made to belong where they stand. Bench 2026-11-02
// (`bench/20261102-200503-scene-integration`): a prompt that names reflections or water makes Qwen
// add water on dry ground, so the Prompt+ model first reads where each object stands (qls-core
// scene.rs; the user can correct it) and the prompt names only what that place does. Then Qwen
// redraws the whole scene (one plain edit of the flattened layers: it decides where and how), and the
// area that changed round the objects is pasted from it as it is, the objects' part in it included
// (Gabriele 11-02: Qwen moves the object a little, so its reflection only meets its own object). One
// "Blend" layer on top; the rest of the image stays the original.
//
// Everything here works on plain arrays (one byte per pixel, or RGBA).

import type { SceneReading } from "./types";
import { dilate, erode } from "./layers";
import { blur, fillHoles, luminance } from "./sceneEdit";

type Surface = SceneReading["surface"];
type Fall = SceneReading["shadows_fall"];

/** The choices the dialog offers, as the user reads them. */
export const SURFACES: { id: Surface; label: string }[] = [
  { id: "dry", label: "Dry ground" },
  { id: "wet", label: "Wet ground" },
  { id: "water", label: "Puddle or water" },
  { id: "glossy", label: "Glossy or polished" },
  { id: "grass", label: "Grass" },
  { id: "soil", label: "Sand or soil" },
  { id: "snow", label: "Snow" },
  { id: "fabric", label: "Carpet or fabric" },
  { id: "other", label: "Something else" },
];
export const FALLS: { id: Fall; label: string }[] = [
  { id: "under", label: "Under it" },
  { id: "left", label: "To the left" },
  { id: "right", label: "To the right" },
  { id: "front", label: "Towards the camera" },
  { id: "back", label: "Away from the camera" },
];

/** What is safe when the scene could not be read: dry ground, a soft shadow under it. */
export const DEFAULT_READING: SceneReading = {
  surface: "dry",
  light: "overcast",
  hard_shadows: false,
  light_from: "above",
  shadows_fall: "under",
  colour: "neutral",
  object_in: "both",
  complete: false,
};

const GROUND: Record<Surface, string> = {
  dry: "ground",
  wet: "wet ground",
  water: "water",
  glossy: "polished surface",
  grass: "grass",
  soil: "ground",
  snow: "snow",
  fabric: "surface",
  other: "surface",
};
const TOWARDS: Record<Fall, string> = { left: "to the left", right: "to the right", front: "towards the viewer", back: "away from the viewer", under: "" };

/** What Qwen is asked for one object (`name`, its layer name): only the effects this surface has.
 * Water words only on wet, water or glossy surfaces (bench rounds 1-2: named, they get drawn). */
export function blendEffects(name: string, r: SceneReading): string {
  const n = name.trim().toLowerCase() || "object";
  const g = GROUND[r.surface] ?? "surface";
  const fall = r.shadows_fall;
  let p: string;
  // A hard shadow as long and at the angle of the scene's own (a short stub looked pasted, 11-02); under
  // soft or overcast light only a faint darkening at the contact (a dark blob under the boots looked fake).
  if (r.hard_shadows && fall !== "under")
    p = `Add the ${n}'s hard-edged shadow on the ${g}, starting at the bottom of the ${n} and cast ${TOWARDS[fall]} with the same direction, angle and length as the other shadows in the scene, and a dark contact shadow where the ${n} touches the ${g}.`;
  else if (fall === "under" || r.light === "overcast") p = `Add a faint soft darkening on the ${g} right where the ${n} touches it.`;
  else p = `Add a soft shadow on the ${g} under the ${n}, falling slightly ${TOWARDS[fall]}, and a faint darkening right where it touches the ${g}.`;
  // A clear mirror image from the base (a "blurred" one came out as a smear), of the lower part (the whole
  // woman put her face upside down between her boots, round 4).
  if (r.surface === "wet" || r.surface === "water")
    p += ` Add the reflection of the lower part of the ${n} in the ${g}: mirrored upside down, starting exactly at the bottom of the ${n}, slightly darker, as clear as the other reflections in it${r.surface === "water" ? ", with small ripples around where it stands in the water." : "."}`;
  else if (r.surface === "glossy") p += ` Add the ${n}'s reflection on the ${g}: mirrored upside down, starting exactly at the bottom of the ${n}, slightly darker and fading out.`;
  else if (r.surface === "grass") p += ` Let a few grass blades cover the bottom of the ${n} where it touches the grass, so it sits in the grass, not on top of it. The grass is dry.`;
  else if (r.surface === "soil" || r.surface === "snow") p += ` Let the ${n}'s base sink slightly into the ${r.surface === "snow" ? "snow" : "ground"}. No reflection.`;
  else p += ` The ${g} is dry: no reflection.`;
  return p;
}

/** The one edit's prompt for every object blended: each one's effects, then what stays. */
export function blendPrompt(items: { name: string; reading: SceneReading }[]): string {
  const names = items.map((i) => `the ${i.name.trim().toLowerCase() || "object"}`);
  const list = names.length < 2 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${items.map((i) => blendEffects(i.name, i.reading)).join(" ")} Do not change ${list}. Keep everything else in the image unchanged.`;
}

/** The pixels set in `m`, as a box (null when none). */
function boxOf(m: Uint8Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Distance in px to the nearest set pixel of `m` (two-pass chamfer, 1 / 1.4). */
function distance(m: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = m[i] ? 0 : 1e9;
  const D = Math.SQRT2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 1);
        if (x > 0) v = Math.min(v, d[i - w - 1] + D);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + D);
      }
      d[i] = v;
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 1);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + D);
        if (x > 0) v = Math.min(v, d[i + w - 1] + D);
      }
      d[i] = v;
    }
  return d;
}

/** Qwen's change of tone, undone: original luminance = gain x Qwen's + offset, fitted on `far` pixels
 * (blurred: a redrawn texture matches the original only on average), refitted 3 times without the
 * pixels that do not follow it (a shadow or a reflection far from the objects). A line, not a free
 * curve: a curve learnt that the only dark pixels far away (a long shadow) were a tone change and
 * took the shadows out with it. As a lookup 0-255. */
export function toneLine(after: Float32Array, before: Float32Array, far: Uint8Array): Float32Array {
  let gain = 1;
  let offset = 0;
  let limit = Infinity;
  for (let round = 0; round < 4; round++) {
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    const res: number[] = [];
    for (let i = 0; i < after.length; i++) {
      if (!far[i]) continue;
      const e = Math.abs(gain * after[i] + offset - before[i]);
      if (e > limit) continue;
      n++;
      sx += after[i];
      sy += before[i];
      sxx += after[i] * after[i];
      sxy += after[i] * before[i];
      if (i % 7 === 0) res.push(e);
    }
    if (n < 100) break;
    const den = n * sxx - sx * sx;
    if (Math.abs(den) < 1e-6) break;
    gain = Math.min(2, Math.max(0.5, (n * sxy - sx * sy) / den));
    offset = (sy - gain * sx) / n;
    res.sort((x, y) => x - y);
    limit = Math.max(4, 2.5 * (res[res.length >> 1] ?? 4));
  }
  return Float32Array.from({ length: 256 }, (_, v) => Math.min(255, Math.max(0, gain * v + offset)));
}

/** What to paste of Qwen's redrawn scene (`after`, already put back over `before`; RGBA w×h; `valid`
 * where it covers), as the Blend layer's alpha (0-255), and `lut`: Qwen's luminance -> the original's,
 * to apply to its pixels (ratio per pixel: its colours kept, its overall darkening or brightening
 * taken out; per-channel curves gave a lilac cast on the bright puddle, 11-02). `objects` = the blended
 * objects' pixels (0/255).
 * Gabriele 11-02: "take the area that changed the most and put it in exactly as it is". Qwen moves and
 * reshapes an object a little (the boots ~12 px), so its shadow or reflection never meets the original
 * object: the area is pasted object and all (its boots with its reflection), on top.
 * - Change is measured on blurred images: a redrawn texture (grass, cobbles) keeps its local mean, a
 *   shadow, a reflection or a wet patch changes it.
 * - Pieces of change that touch the objects, within twice their height (a relit lawn stays out); a
 *   piece mostly inside an object is a change of its colour, not of the scene round it: left out
 *   (an orange patch on the coat, 11-02). Gaps closed, holes filled, edge soft. */
export function blendKeep(before: ArrayLike<number>, after: ArrayLike<number>, valid: Uint8Array, objects: Uint8Array, w: number, h: number) {
  const n = w * h;
  const L = Math.max(w, h);
  const alpha = new Uint8Array(n);
  const box = boxOf(objects, w, h);
  const lb = luminance(before, n);
  const la = luminance(after, n);
  const dist = distance(objects, w, h);
  const far = new Uint8Array(n);
  for (let i = 0; i < n; i++) far[i] = valid[i] && dist[i] > 0.12 * L ? 1 : 0;
  const r = Math.max(1, Math.round(0.006 * L));
  const lut = toneLine(blur(la, w, h, r), blur(lb, w, h, r), far);
  if (!box) return { alpha, n: 0, lut };
  const k = new Float32Array(n);
  for (let i = 0; i < n; i++) k[i] = (lut[Math.min(255, Math.max(0, Math.round(la[i])))] + 1) / (la[i] + 1);
  const d = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const bc = new Float32Array(n);
    const tc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      bc[i] = before[i * 4 + c];
      tc[i] = Math.min(255, after[i * 4 + c] * k[i]);
    }
    const bb = blur(bc, w, h, r);
    const bt = blur(tc, w, h, r);
    for (let i = 0; i < n; i++) if (valid[i]) d[i] = Math.max(d[i], Math.abs(bt[i] - bb[i]));
  }
  const oh = box.y1 - box.y0 + 1;
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) cand[i] = d[i] > 12 && dist[i] < 2 * oh ? 1 : 0;
  const near = dilate(objects, w, h, Math.max(2, 0.03 * L));
  // Pieces of change (4-connected), each kept or not as a whole.
  const label = new Int32Array(n).fill(-1);
  const keep = new Uint8Array(n);
  const stack: number[] = [];
  const piece: number[] = [];
  for (let s0 = 0; s0 < n; s0++) {
    if (!cand[s0] || label[s0] >= 0) continue;
    piece.length = 0;
    let inside = 0;
    let touches = false;
    label[s0] = s0;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!;
      piece.push(i);
      if (objects[i]) inside++;
      if (near[i]) touches = true;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
        if (j >= 0 && j < n && cand[j] && label[j] < 0) {
          label[j] = s0;
          stack.push(j);
        }
    }
    if (touches && inside <= piece.length / 2) for (const i of piece) keep[i] = 255;
  }
  const c = Math.max(2, Math.round(0.005 * L));
  const closed = fillHoles(erode(dilate(keep, w, h, c), w, h, c), w, h);
  const soft = blur(Float32Array.from(closed, (v) => v / 255), w, h, Math.max(1, Math.round(0.002 * L)));
  let kept = 0;
  for (let i = 0; i < n; i++) {
    alpha[i] = Math.round(Math.min(1, soft[i]) * 255);
    if (alpha[i] > 25) kept++;
  }
  return { alpha, n: kept, lut };
}
