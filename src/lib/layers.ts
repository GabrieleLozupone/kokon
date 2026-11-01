// Layers lab (components/LayersEditor.tsx): the masks behind "Split into layers". Each layer is an
// alpha mask (0-255, one byte per mask pixel); a pixel belongs to one layer at most. The background
// is everything no layer has.

export type Mask = Uint8Array;

/** Adds `a` (0-255 per pixel) to `layer`. `take`: the pixels leave every other layer (the brush);
 * otherwise only what no other layer has is added (a SAM click: a loose mask, such as the whole
 * scene when cycling to a bigger part, never eats a layer already made). */
export function addTo(masks: Mask[], layer: number, a: ArrayLike<number>, take = true) {
  for (let i = 0; i < a.length; i++) {
    let v = a[i];
    if (!v) continue;
    if (!take) {
      masks.forEach((m, k) => {
        if (k !== layer) v = Math.min(v, 255 - m[i]);
      });
      if (v > 0) masks[layer][i] = Math.max(masks[layer][i], v);
      continue;
    }
    masks.forEach((m, k) => {
      if (k === layer) m[i] = Math.max(m[i], v);
      else if (m[i]) m[i] = Math.min(m[i], 255 - v);
    });
  }
}

/** Removes `a` from `layer` only (those pixels go back to the background). */
export function removeFrom(mask: Mask, a: ArrayLike<number>) {
  for (let i = 0; i < a.length; i++) if (a[i]) mask[i] = Math.min(mask[i], 255 - a[i]);
}

/** SAM logits -> a hard 0/255 mask. */
export function fromLogits(logits: ArrayLike<number>): Mask {
  const out = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) out[i] = logits[i] > 0 ? 255 : 0;
  return out;
}

/** How far a click's selection reaches past SAM's own edge, as a share of the long side: two cells
 * of SAM's 256² low-res mask, about its uncertainty at an edge (its threshold at 0 keeps to the
 * inside, which left a rim of the object out). The whole object is then inside: an inpaint repaints
 * a little around it, the layers lab's split snaps the edge back to the photo (`refineEdges`). */
export const SAM_GROW = 2 / 256;

/** A SAM output (logits at `w`×`h`) as the selection a click makes: grown by `SAM_GROW`. */
export function samSelection(logits: ArrayLike<number>, w: number, h: number): Mask {
  return dilate(fromLogits(logits), w, h, Math.max(1, Math.round(Math.max(w, h) * SAM_GROW)));
}

/** Per pixel, the largest alpha of any layer: the background's holes. */
export function union(masks: Mask[], n: number): Mask {
  const out = new Uint8Array(n);
  for (const m of masks) for (let i = 0; i < n; i++) if (m[i] > out[i]) out[i] = m[i];
  return out;
}

/** Grows a mask by `r` px (square max filter, separable). */
export function dilate(m: Mask, w: number, h: number, r: number): Mask {
  r = Math.round(r);
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  const run = (src: Mask, dst: Mask, len: number, count: number, step: number, stride: number) => {
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      for (let i = 0; i < len; i++) {
        let v = 0;
        const lo = Math.max(0, i - r);
        const hi = Math.min(len - 1, i + r);
        for (let j = lo; j <= hi && v < 255; j++) v = Math.max(v, src[base + j * step]);
        dst[base + i * step] = v;
      }
    }
  };
  run(m, tmp, w, h, 1, w); // rows
  run(tmp, out, h, w, w, 1); // columns
  return out;
}

/** SAM's multimask outputs to try for one click, best first: the highest predicted IoU, then the
 * others from the smallest to the largest. Clicking the same spot again moves to the next one
 * (part -> whole); index 0, the single-mask output, is left out (S1: unreliable on one point). */
export function maskOrder(iou: number[], areas: number[]): number[] {
  const idx = [1, 2, 3].filter((i) => i < iou.length);
  if (!idx.length) return [0];
  const best = idx.reduce((a, b) => (iou[b] > iou[a] ? b : a));
  return [best, ...idx.filter((i) => i !== best).sort((a, b) => areas[a] - areas[b])];
}

/** Count of pixels with any alpha. */
export function area(m: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) n++;
  return n;
}

/** A file name part from a layer name. */
export function fileSafe(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim() || "layer";
}

/** Shrinks a mask by `r` px (the opposite of `dilate`). */
export function erode(m: Mask, w: number, h: number, r: number): Mask {
  const inv = new Uint8Array(m.length);
  for (let i = 0; i < m.length; i++) inv[i] = 255 - m[i];
  const g = dilate(inv, w, h, r);
  for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
  return g;
}

/** Grows a mask by a different amount each way (px): `down` = towards the bottom of the image. */
export function grow(m: Mask, w: number, h: number, by: { left: number; right: number; up: number; down: number }): Mask {
  const tmp = new Uint8Array(m.length);
  const out = new Uint8Array(m.length);
  // Output pixel x is on if an input pixel in [x - right, x + left] is (the mask moved right by up
  // to `right`, left by up to `left`); the same with rows.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let v = 0;
      const lo = Math.max(0, x - Math.round(by.right));
      const hi = Math.min(w - 1, x + Math.round(by.left));
      for (let j = lo; j <= hi && v < 255; j++) v = Math.max(v, m[y * w + j]);
      tmp[y * w + x] = v;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let v = 0;
      const lo = Math.max(0, y - Math.round(by.down));
      const hi = Math.min(h - 1, y + Math.round(by.up));
      for (let j = lo; j <= hi && v < 255; j++) v = Math.max(v, tmp[j * w + x]);
      out[y * w + x] = v;
    }
  return out;
}

/** Mean of `a` over a (2r+1)² box, clamped at the borders (integral image). */
function boxMean(a: Float32Array, w: number, h: number, r: number): Float32Array {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += a[y * w + x];
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** A cut-out's edge snapped to the photo's edges, soft (anti-aliased) instead of SAM's stepped
 * yes/no: a guided filter (He et al.) of the mask with the photo's grey levels as the guide, kept to
 * a band of `r` px around the edge (inside: solid, outside: empty, so textures inside an object
 * never punch holes in it). `gray`: 0-1 per pixel. Works on the mask's bounding box only. */
export function refineEdges(m: Mask, gray: ArrayLike<number>, w: number, h: number, r: number, eps = 1e-3): Mask {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let i = 0; i < m.length; i++)
    if (m[i]) {
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (x1 < 0 || r < 1) return m.slice();
  const pad = 3 * r;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);
  const cw = x1 - x0 + 1;
  const ch = y1 - y0 + 1;
  const I = new Float32Array(cw * ch);
  const p = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const k = (y + y0) * w + x + x0;
      I[y * cw + x] = gray[k];
      p[y * cw + x] = m[k];
    }
  const P = Float32Array.from(p, (v) => v / 255);
  const mI = boxMean(I, cw, ch, r);
  const mP = boxMean(P, cw, ch, r);
  const II = boxMean(I.map((v) => v * v), cw, ch, r);
  const IP = boxMean(I.map((v, i) => v * P[i]), cw, ch, r);
  const A = new Float32Array(cw * ch);
  const B = new Float32Array(cw * ch);
  for (let i = 0; i < A.length; i++) {
    const varI = II[i] - mI[i] * mI[i];
    A[i] = (IP[i] - mI[i] * mP[i]) / (varI + eps);
    B[i] = mP[i] - A[i] * mI[i];
  }
  const mA = boxMean(A, cw, ch, r);
  const mB = boxMean(B, cw, ch, r);
  const inner = erode(p, cw, ch, r);
  const outer = dilate(p, cw, ch, r);
  const out = m.slice();
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const k = (y + y0) * w + x + x0;
      if (inner[i]) out[k] = 255;
      else if (!outer[i]) out[k] = 0;
      else {
        // The filter's ramp is as wide as the box: a contrast curve around 0.5 keeps the edge where
        // it snapped and about 2 px soft (anti-aliased, not blurred).
        const q = mA[i] * I[i] + mB[i];
        out[k] = Math.round(Math.min(1, Math.max(0, (q - 0.5) * 2.5 + 0.5)) * 255);
      }
    }
  return out;
}
