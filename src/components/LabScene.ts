// Layers lab: reading a whole-image edit back into layers (lib/sceneEdit.ts has the maths). The
// edit of the flattened layers is put back over them (Qwen zooms plain edits a little), its change
// of tone divided out, then: darkening near an object -> that object's shadow layer (it follows the
// object); something new where the user drew coloured marks -> a new layer cut from the edit (SAM's
// outline when the model is there); an object asked to take the edit's look -> its next version.

import { api, urls } from "../lib/api";
import { centre, type LayerDoc, type Place, type SceneEdit } from "../lib/layerDoc";
import { dilate, fileSafe, fromLogits, refineEdges } from "../lib/layers";
import { Segmenter } from "../lib/sam";
import { alignEdit, attached, blur, changed, darkness, IDENTITY, invertAffine, luminance, MARK_COLOURS, objectAt, scaleAffine, splitShadows, toneCurve, type Affine, type MarkColour } from "../lib/sceneEdit";
import type { InputRecord } from "../lib/types";
import { loadImage, pixels, drawSource, sourceInfo, toPng } from "./LayerDoc";

/** Long side of the analysis (shadows are soft: no need for every pixel). */
const SIDE = 1536;
/** Automatic shadows: darkening above this (0-1, past darkness()'s floor) carries a shadow on from
 * near the objects; where it stops the layer is ~10/255, no visible edge. */
const SHADOW_LOW = 0.04;

/** What a result made: images to add to the document. Keys: object ids (shadows, looks) and
 * mark colours (new objects, and their shadows). */
export interface SceneResult {
  objects: { colour: MarkColour; src: string; name: string }[];
  shadows: { of: string; src: string }[];
  looks: { id: string; src: string }[];
  notes: string[];
}

let sam: Promise<Segmenter | null> | null = null;
const segmenter = () => (sam ??= Segmenter.load().catch(() => null));

const canvas = (w: number, h: number) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

/** `img` (any size) drawn over a `w`×`h` frame through `t` (a frame point p shows the image's
 * point t(p), both in frame px `W`×`H`): the edit put back over the layers. */
function warp(img: CanvasImageSource, t: Affine, w: number, h: number, W: number, H: number): HTMLCanvasElement {
  const c = canvas(w, h);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  const k = w / W;
  // Frame point p -> image point t(p): the image is drawn through t's inverse, scaled to w×h.
  const inv = invertAffine(t);
  ctx.setTransform(k * inv.a, k * inv.d, k * inv.b, k * inv.e, k * inv.c, k * inv.f);
  ctx.drawImage(img, 0, 0, W, H);
  return c;
}

/** An object's pixels (alpha > 128) at `w`×`h`, drawn where `place` puts it. */
async function footprint(source: string, place: Place, w: number, h: number, W: number, H: number): Promise<Uint8Array> {
  const info = await sourceInfo(source, W, H);
  const c = canvas(w, h);
  const ctx = c.getContext("2d")!;
  const cc = centre(info.box);
  ctx.scale(w / W, h / H);
  ctx.translate(cc.x + place.dx, cc.y + place.dy);
  ctx.scale(place.s, place.s);
  ctx.translate(-cc.x, -cc.y);
  drawSource(ctx, info);
  const px = ctx.getImageData(0, 0, w, h).data;
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = px[i * 4 + 3] > 128 ? 255 : 0;
  return m;
}

/** One byte per pixel (`w`×`h`) -> a `W`×`H` image: black with that alpha (a shadow layer) or, with
 * `from`, that image cut by it (a new object). */
async function upload(alpha: Uint8Array, w: number, h: number, W: number, H: number, name: string, from?: HTMLCanvasElement): Promise<InputRecord> {
  const small = canvas(w, h);
  const sctx = small.getContext("2d")!;
  const d = sctx.createImageData(w, h);
  for (let i = 0; i < alpha.length; i++) d.data[i * 4 + 3] = alpha[i];
  sctx.putImageData(d, 0, 0);
  const c = canvas(W, H);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (from) {
    ctx.drawImage(from, 0, 0, W, H);
    ctx.globalCompositeOperation = "destination-in";
  }
  ctx.drawImage(small, 0, 0, W, H);
  return api.upload(await toPng(c), `${fileSafe(name)}.png`);
}

const total = (m: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < m.length; i++) s += m[i];
  return s;
};

/** "a green glass bottle" -> "Green glass bottle". */
export function layerName(what: string, colour: MarkColour): string {
  const t = what.trim().replace(/^(a|an|the|some|another)\s+/i, "");
  return t ? t[0].toUpperCase() + t.slice(1, 40) : `New object (${colour})`;
}

interface Pair {
  w: number;
  h: number;
  /** Before / the edit put back over it, RGBA at w×h. */
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
  /** Blurred luminances. */
  lb: Float32Array;
  la: Float32Array;
  /** Pixels the edit covers once put back (its border may not reach the frame's edge). */
  valid: Uint8Array;
  t: Affine;
  img: HTMLImageElement;
}

/** The two images at the analysis size, the edit put back over the layers (`align`; `skip`:
 * where it is meant to change, left out of the alignment). */
async function pair(beforeSrc: string, afterSrc: string, W: number, H: number, align: boolean, skip?: (w: number, h: number) => Promise<Uint8Array>): Promise<Pair> {
  const k = Math.min(1, SIDE / Math.max(W, H));
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const [bi, ai] = await Promise.all([loadImage(urls.source(beforeSrc)), loadImage(urls.source(afterSrc))]);
  const before = pixels(bi, w, h);
  const n = w * h;
  let t = IDENTITY;
  if (align) {
    const tk = alignEdit(luminance(before, n), luminance(pixels(ai, w, h), n), w, h, skip ? await skip(w, h) : undefined);
    t = scaleAffine(tk, W / w);
  }
  const after = warp(ai, t, w, h, W, H).getContext("2d")!.getImageData(0, 0, w, h).data;
  const valid = new Uint8Array(n);
  // Both opaque there (a background with holes left has none to compare).
  for (let i = 0; i < n; i++) valid[i] = after[i * 4 + 3] > 250 && before[i * 4 + 3] > 250 ? 1 : 0;
  const r = Math.max(1, Math.round(Math.max(w, h) * 0.0015));
  return { w, h, before, after, lb: blur(luminance(before, n), w, h, r), la: blur(luminance(after, n), w, h, r), valid, t, img: ai };
}

/** Where the edit put back leaves no pixels (it came back zoomed in: a strip at the frame's edges,
 * ~8 px of 1328 on 11-01), the value along the column, then the row, so a shadow reaches the edge
 * instead of stopping short of it. Taken `m` px inside: the edit's own outermost rows are off (dark
 * streaks along the whole edge, 11-01 Halloween), so they are filled too. Elsewhere (no comparison
 * possible) 0. */
function fillBorder(d: Float32Array, valid: Uint8Array, w: number, h: number) {
  const m = Math.max(3, Math.round(Math.max(w, h) * 0.006));
  const done = Uint8Array.from(valid);
  for (let x = 0; x < w; x++) {
    let top = -1;
    let bottom = -1;
    for (let y = 0; y < h; y++) {
      if (!valid[y * w + x]) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0 || bottom - top < 4 * m) continue;
    top += m;
    bottom -= m;
    for (let y = 0; y < h; y++) {
      if (y >= top && y <= bottom) continue;
      d[y * w + x] = d[(y < top ? top : bottom) * w + x];
      done[y * w + x] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    let left = -1;
    let right = -1;
    for (let x = 0; x < w; x++) {
      if (!done[y * w + x]) continue;
      if (left < 0) left = x;
      right = x;
    }
    if (left >= 0 && right - left >= 4 * m) {
      left += m;
      right -= m;
    }
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (done[i] && x >= left && x <= right) continue;
      d[i] = left < 0 ? 0 : x < left ? d[y * w + left] : x > right ? d[y * w + right] : 0;
    }
  }
}

/** The darkening the edit added (tone change divided out), 0-1 per pixel; tone measured on the
 * pixels farther than `reach` from every object and outside `busy` (the marks). */
function addedDarkness(p: Pair, objects: Uint8Array[], reach: number, busy?: Uint8Array): Float32Array {
  const near = new Uint8Array(p.w * p.h);
  for (const m of objects) for (let i = 0; i < m.length; i++) if (m[i]) near[i] = 255;
  // Grown at a quarter of the size (dilate is per pixel of radius).
  const q = 4;
  const qw = Math.ceil(p.w / q);
  const qh = Math.ceil(p.h / q);
  const small = new Uint8Array(qw * qh);
  for (let i = 0; i < near.length; i++) if (near[i] || busy?.[i]) small[((((i / p.w) | 0) / q) | 0) * qw + (((i % p.w) / q) | 0)] = 255;
  const grown = dilate(small, qw, qh, reach / q);
  const far = new Uint8Array(p.w * p.h);
  for (let i = 0; i < far.length; i++) far[i] = p.valid[i] && !grown[((((i / p.w) | 0) / q) | 0) * qw + (((i % p.w) / q) | 0)] ? 1 : 0;
  const lut = toneCurve(p.lb, p.la, far);
  const d = darkness(p.lb, p.la, lut);
  fillBorder(d, p.valid, p.w, p.h);
  // A touch of smoothing: decode speckle left above the floor.
  return blur(d, p.w, p.h, 1);
}

/** Visible objects of the document (not the background, not shadows). */
const objectsOf = (doc: LayerDoc) => doc.layers.filter((l) => !l.base && !l.effect && !l.hidden);

/** A whole-image edit's result -> what it made (see SceneResult). */
export async function readScene(doc: LayerDoc, e: SceneEdit, result: string): Promise<SceneResult> {
  const W = doc.width;
  const H = doc.height;
  const out: SceneResult = { objects: [], shadows: [], looks: [], notes: [] };
  // The marks, one mask per colour (the pencil's colours, drawn opaque).
  let marks: { colour: MarkColour; m: Uint8Array; what: string }[] = [];
  let marked: Uint8Array | undefined;
  const readMarks = async (w: number, h: number) => {
    if (!e.marks || !e.wants?.length) return new Uint8Array(w * h);
    const px = pixels(await loadImage(urls.input(e.marks)), w, h);
    marks = e.wants.map((x) => ({ ...x, m: new Uint8Array(w * h) }));
    const any = new Uint8Array(w * h);
    for (let i = 0; i < any.length; i++) {
      if (px[i * 4 + 3] < 128) continue;
      let best = -1;
      let bd = Infinity;
      marks.forEach((x, k) => {
        const c = MARK_COLOURS.find((mc) => mc.name === x.colour)!.rgb;
        const d = Math.abs(px[i * 4] - c[0]) + Math.abs(px[i * 4 + 1] - c[1]) + Math.abs(px[i * 4 + 2] - c[2]);
        if (d < bd) {
          bd = d;
          best = k;
        }
      });
      if (best >= 0) marks[best].m[i] = 255;
      any[i] = 255;
    }
    // Room around the marks: the object may be drawn a little bigger than them.
    marked = dilate(any, w, h, Math.round(Math.max(w, h) * 0.03));
    return marked;
  };
  const p = await pair(e.before, result, W, H, true, readMarks);
  const { w, h } = p;
  if (!marked) await readMarks(w, h);
  const reach = (Math.max(w, h) * e.reach) / 100;
  const ids = Object.keys(e.places).filter((id) => doc.layers.some((l) => l.id === id));
  const feet = new Map<string, Uint8Array>();
  for (const id of ids) feet.set(id, await footprint(e.places[id].source, e.places[id], w, h, W, H));

  // New objects: what changed around each colour's marks.
  const news: { colour: MarkColour; m: Uint8Array }[] = [];
  if (marks.length) {
    const lut = toneCurve(p.lb, p.la, Uint8Array.from(p.valid, (v, i) => (v && !marked![i] ? 1 : 0)));
    const diff = changed(p.before, p.after, lut, w * h);
    let full: HTMLCanvasElement | null = null;
    const gray = Float32Array.from(luminance(p.after, w * h), (v) => v / 255);
    for (const mk of marks) {
      const region = dilate(mk.m, w, h, Math.round(Math.max(w, h) * 0.04));
      const cand = Uint8Array.from(diff, (v, i) => (v && region[i] && p.valid[i] ? 255 : 0));
      let obj = objectAt(cand, dilate(mk.m, w, h, Math.round(Math.max(w, h) * 0.01)), w, h);
      const area = total(obj) / 255;
      if (area < w * h * 0.0002) {
        out.notes.push(`Nothing new was found at the ${mk.colour} marks.`);
        continue;
      }
      obj = await samOutline(p, obj, w, h);
      const soft = refineEdges(obj, gray, w, h, Math.max(2, Math.round(Math.max(w, h) * 0.003)));
      full ??= warp(p.img, p.t, W, H, W, H);
      const rec = await upload(soft, w, h, W, H, layerName(mk.what, mk.colour), full);
      out.objects.push({ colour: mk.colour, src: `input:${rec.id}`, name: layerName(mk.what, mk.colour) });
      news.push({ colour: mk.colour, m: obj });
    }
  }

  // Shadows: only of the objects asked for. A new object comes alone (its shadow is made
  // afterwards with Automatic shadows), whatever shadow Qwen drew for it is left out.
  const targets = e.shadows.filter((id) => feet.has(id)).map((id) => ({ of: id, m: feet.get(id)! }));
  // One layer for all of them (Automatic shadows): the darkening within reach of the objects, taken
  // out only where an object is (it covers its own pixels). No band around the outlines to fill
  // back: a fill that fell short left a light ring round the spider's legs (11-01).
  if (targets.length && e.one) {
    const dark = addedDarkness(p, [...feet.values()], reach, marked);
    const near = new Uint8Array(w * h);
    for (const t of targets) for (let i = 0; i < t.m.length; i++) if (t.m[i]) near[i] = 255;
    const q = 4;
    const qw = Math.ceil(w / q);
    const qh = Math.ceil(h / q);
    const small = new Uint8Array(qw * qh);
    for (let i = 0; i < near.length; i++) if (near[i]) small[(((i / w) | 0) / q | 0) * qw + (((i % w) / q) | 0)] = 255;
    const within = dilate(small, qw, qh, reach / q);
    // Within reach is only where a shadow starts: it is kept as far as it goes on from there (the
    // box-shaped reach cut the girl's long shadow with straight edges, 11-01 Halloween).
    const seed = new Uint8Array(w * h);
    for (let i = 0; i < seed.length; i++) seed[i] = within[(((i / w) | 0) / q | 0) * qw + (((i % w) / q) | 0)];
    const keep = attached(dark, seed, w, h, SHADOW_LOW, near);
    const alpha = new Uint8Array(w * h);
    for (let i = 0; i < alpha.length; i++) {
      if (near[i] || !keep[i]) continue;
      alpha[i] = Math.round(Math.min(1, dark[i]) * 255);
    }
    if (total(alpha) < 255 * w * h * 0.0003) out.notes.push("No shadow was found.");
    else out.shadows.push({ of: "all", src: `input:${(await upload(alpha, w, h, W, H, "Shadows")).id}` });
    return out;
  }
  if (targets.length) {
    const others = new Uint8Array(w * h);
    for (const [id, m] of feet) if (!e.shadows.includes(id)) for (let i = 0; i < m.length; i++) if (m[i]) others[i] = 255;
    const dark = addedDarkness(p, [...feet.values(), ...news.map((n) => n.m)], reach, marked);
    const split = splitShadows(dark, targets.map((t) => t.m), w, h, reach, Math.max(w, h) * 0.015, others, Math.round(Math.max(w, h) * 0.004));
    for (let k = 0; k < targets.length; k++) {
      // Less than a hint of shadow: nothing to add.
      if (total(split[k]) < 255 * w * h * 0.0003) {
        out.notes.push(`No shadow was found for ${nameOf(doc, targets[k].of, out)}.`);
        continue;
      }
      const rec = await upload(split[k], w, h, W, H, `${nameOf(doc, targets[k].of, out)} shadow`);
      out.shadows.push({ of: targets[k].of, src: `input:${rec.id}` });
    }
  }

  // The edit's look of an object: its pixels in the edit, back in the object's own place.
  if (e.look.length) {
    const full = warp(p.img, p.t, W, H, W, H);
    for (const id of e.look) {
      const at = e.places[id];
      const l = doc.layers.find((x) => x.id === id);
      const foot = feet.get(id);
      if (!at || !l || !foot) continue;
      if (!differs(p, foot)) continue;
      const info = await sourceInfo(at.source, W, H);
      const cc = centre(info.box);
      const c = canvas(W, H);
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      // Frame -> the object's own pixels: the inverse of its move and scale.
      ctx.setTransform(1 / at.s, 0, 0, 1 / at.s, cc.x - (cc.x + at.dx) / at.s, cc.y - (cc.y + at.dy) / at.s);
      ctx.drawImage(full, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      drawSource(ctx, info);
      const rec = await api.upload(await toPng(c), `${fileSafe(l.name)} (edited).png`);
      out.looks.push({ id, src: `input:${rec.id}` });
    }
  }
  return out;
}

const nameOf = (doc: LayerDoc, of: string, out: SceneResult) => doc.layers.find((l) => l.id === of)?.name ?? out.objects.find((o) => o.colour === of)?.name ?? of;

/** Whether the edit changed an object beyond decode noise (mean change over its pixels). */
function differs(p: Pair, foot: Uint8Array): boolean {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < foot.length; i++) {
    if (!foot[i] || !p.valid[i]) continue;
    n++;
    for (let c = 0; c < 3; c++) sum += Math.abs(p.after[i * 4 + c] - p.before[i * 4 + c]);
  }
  return n > 0 && sum / (n * 3) > 6;
}

/** SAM's outline of a new object (box prompt around the changed pixels) when the model is there
 * and agrees with them (IoU >= 0.5); else the changed pixels as they are. */
async function samOutline(p: Pair, obj: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const s = await segmenter();
  if (!s) return obj;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < obj.length; i++)
    if (obj[i]) {
      const x = i % w;
      const y = (i / w) | 0;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  const mx = (x1 - x0) * 0.04 + 2;
  const my = (y1 - y0) * 0.04 + 2;
  try {
    const c = canvas(w, h);
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(p.after), w, h), 0, 0);
    await s.encode(c, w, h);
    const r = await s.predict([], w, h, { x0: Math.max(0, x0 - mx), y0: Math.max(0, y0 - my), x1: Math.min(w - 1, x1 + mx), y1: Math.min(h - 1, y1 + my) });
    let best: Uint8Array | null = null;
    let bestIou = 0.5;
    for (const logits of r.masks) {
      const m = fromLogits(logits);
      let inter = 0;
      let uni = 0;
      for (let i = 0; i < m.length; i++) {
        if (m[i] && obj[i]) inter++;
        if (m[i] || obj[i]) uni++;
      }
      const iou = uni ? inter / uni : 0;
      if (iou >= bestIou) {
        bestIou = iou;
        best = m;
      }
    }
    return best ?? obj;
  } catch {
    return obj;
  }
}

/** The objects the scene edits read, as they are now (their place and version). */
export function placesOf(doc: LayerDoc): SceneEdit["places"] {
  return Object.fromEntries(objectsOf(doc).map((l) => [l.id, { dx: l.dx, dy: l.dy, s: l.s, source: l.source }]));
}
