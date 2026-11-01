// Layers lab: what a whole-image edit of the flattened layers changed (components/LabScene.ts).
// Qwen's plain edits come back slightly zoomed (10-31 kitchen table: 1.4 % wider, 2.5 % taller,
// up to ~25 px off at the corners), and with the whole picture's tone changed. So the result is
// first put back over the layers (an affine fitted to block shifts of the two images' edges), its
// tone change measured far from the objects and divided out, and only then read: darkening near
// an object = its shadow; something new where the user drew coloured marks = a new object.
//
// Everything here works on plain arrays at an analysis size (one byte or float per pixel).

import { dilate } from "./layers";

/** x' = a x + b y + c, y' = d x + e y + f: a point of the layers -> the same point in the edit. */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 0, e: 1, f: 0 };

export const applyAffine = (t: Affine, x: number, y: number) => ({ x: t.a * x + t.b * y + t.c, y: t.d * x + t.e * y + t.f });

/** The same transform for images `k` times bigger. */
export const scaleAffine = (t: Affine, k: number): Affine => ({ ...t, c: t.c * k, f: t.f * k });

export function invertAffine(t: Affine): Affine {
  const det = t.a * t.e - t.b * t.d || 1;
  const a = t.e / det;
  const b = -t.b / det;
  const d = -t.d / det;
  const e = t.a / det;
  return { a, b, c: -(a * t.c + b * t.f), d, e, f: -(d * t.c + e * t.f) };
}

/** RGBA -> luminance (0-255). */
export function luminance(px: ArrayLike<number>, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  return out;
}

/** Box blur of radius `r`, three times (close to a Gaussian of sigma ~r). */
export function blur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  r = Math.round(r);
  if (r < 1) return src.slice();
  let a = src.slice();
  let b = new Float32Array(src.length);
  const pass = (from: Float32Array, to: Float32Array, len: number, count: number, step: number, stride: number) => {
    for (let c = 0; c < count; c++) {
      const base = c * stride;
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += from[base + Math.min(len - 1, Math.max(0, j)) * step];
      for (let i = 0; i < len; i++) {
        to[base + i * step] = sum / (2 * r + 1);
        sum += from[base + Math.min(len - 1, i + r + 1) * step] - from[base + Math.max(0, i - r) * step];
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(a, b, w, h, 1, w);
    pass(b, a, h, w, w, 1);
  }
  return a;
}

/** Gradient magnitude: edges, which survive the edit's change of tone (the alignment looks at these). */
export function edges(l: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(l.length);
  for (let y = 0; y < h - 1; y++)
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      out[i] = Math.hypot(l[i + 1] - l[i], l[i + w] - l[i]);
    }
  return out;
}

/** In-place radix-2 FFT of one row/column (`n` a power of 2). */
function fft1(re: Float64Array, im: Float64Array, n: number, inverse: boolean) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false) {
  const r = new Float64Array(n);
  const i = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    r.set(re.subarray(y * n, y * n + n));
    i.set(im.subarray(y * n, y * n + n));
    fft1(r, i, n, inverse);
    re.set(r, y * n);
    im.set(i, y * n);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      r[y] = re[y * n + x];
      i[y] = im[y * n + x];
    }
    fft1(r, i, n, inverse);
    for (let y = 0; y < n; y++) {
      re[y * n + x] = r[y];
      im[y * n + x] = i[y];
    }
  }
}

/** Phase correlation of two `n`×`n` blocks: the shift `d` with b(p + d) ≈ a(p) (sub-pixel), and
 * the peak's height (0-1: how sure). */
export function phaseShift(a: Float32Array, b: Float32Array, n: number): { dx: number; dy: number; q: number } {
  const ar = new Float64Array(n * n);
  const ai = new Float64Array(n * n);
  const br = new Float64Array(n * n);
  const bi = new Float64Array(n * n);
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n * n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n * n;
  mb /= n * n;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const wgt = (0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / n)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / n));
      ar[y * n + x] = (a[y * n + x] - ma) * wgt;
      br[y * n + x] = (b[y * n + x] - mb) * wgt;
    }
  fft2(ar, ai, n);
  fft2(br, bi, n);
  // conj(A) * B, normalised.
  for (let i = 0; i < n * n; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ar[i] * bi[i] - ai[i] * br[i];
    const m = Math.hypot(re, im) + 1e-9;
    ar[i] = re / m;
    ai[i] = im / m;
  }
  fft2(ar, ai, n, true);
  let best = 0;
  for (let i = 1; i < n * n; i++) if (ar[i] > ar[best]) best = i;
  const at = (x: number, y: number) => ar[((y + n) % n) * n + ((x + n) % n)];
  const px = best % n;
  const py = (best / n) | 0;
  const sub = (m: number, c: number, p: number) => (m - 2 * c + p !== 0 ? (0.5 * (m - p)) / (m - 2 * c + p) : 0);
  const fx = sub(at(px - 1, py), at(px, py), at(px + 1, py));
  const fy = sub(at(px, py - 1), at(px, py), at(px, py + 1));
  const wrap = (v: number) => (v > n / 2 ? v - n : v);
  return { dx: wrap(px) + fx, dy: wrap(py) + fy, q: ar[best] / (n * n) };
}

export interface BlockShift {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** Shifts of `n`×`n` blocks every `step` px between two edge images; blocks with little texture
 * (under a third of the median block's: a plain wall) or mostly inside `skip` (where the edit is
 * meant to change things: the marks) are left out. */
export function blockShifts(A: Float32Array, B: Float32Array, w: number, h: number, n = 128, step = 96, skip?: Uint8Array): BlockShift[] {
  const blocks: { x0: number; y0: number; sd: number }[] = [];
  for (let y0 = 0; y0 + n <= h; y0 += step)
    for (let x0 = 0; x0 + n <= w; x0 += step) {
      let sum = 0;
      let sq = 0;
      let skipped = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const i = (y0 + y) * w + x0 + x;
          sum += A[i];
          sq += A[i] * A[i];
          if (skip?.[i]) skipped++;
        }
      const mean = sum / (n * n);
      if (skipped <= (n * n) / 4) blocks.push({ x0, y0, sd: Math.sqrt(Math.max(0, sq / (n * n) - mean * mean)) });
    }
  const sds = blocks.map((b) => b.sd).sort((x, y) => x - y);
  const min = Math.max(1e-3, (sds[sds.length >> 1] ?? 0) / 3);
  const out: BlockShift[] = [];
  const a = new Float32Array(n * n);
  const b = new Float32Array(n * n);
  for (const { x0, y0, sd } of blocks) {
    if (sd < min) continue;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        a[y * n + x] = A[(y0 + y) * w + x0 + x];
        b[y * n + x] = B[(y0 + y) * w + x0 + x];
      }
    const s = phaseShift(a, b, n);
    if (s.q > 0.06) out.push({ x: x0 + n / 2, y: y0 + n / 2, dx: s.dx, dy: s.dy });
  }
  return out;
}

function solve3(M: number[][], v: number[]): number[] | null {
  // Normal equations of a 3-parameter least squares (Cramer's rule).
  const det = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M);
  if (Math.abs(D) < 1e-9) return null;
  return [0, 1, 2].map((k) => det(M.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))) / D);
}

/** The affine that best maps block centres to where they moved (least squares, then again
 * without the blocks it misses by much: a block on a changed object is an outlier). Null when
 * too few blocks agree. */
export function fitAffine(pts: BlockShift[]): { t: Affine; inliers: number; err: number } | null {
  let keep = pts.map(() => true);
  let t: Affine | null = null;
  let errs: number[] = [];
  for (let it = 0; it < 4; it++) {
    const P = pts.filter((_, i) => keep[i]);
    if (P.length < 6) return null;
    const M = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const vx = [0, 0, 0];
    const vy = [0, 0, 0];
    for (const p of P) {
      const r = [p.x, p.y, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += r[i] * r[j];
        vx[i] += r[i] * (p.x + p.dx);
        vy[i] += r[i] * (p.y + p.dy);
      }
    }
    const sx = solve3(M, vx);
    const sy = solve3(M, vy);
    if (!sx || !sy) return null;
    t = { a: sx[0], b: sx[1], c: sx[2], d: sy[0], e: sy[1], f: sy[2] };
    errs = pts.map((p) => {
      const q = applyAffine(t!, p.x, p.y);
      return Math.hypot(q.x - p.x - p.dx, q.y - p.y - p.dy);
    });
    const sorted = errs.filter((_, i) => keep[i]).sort((x, y) => x - y);
    const lim = Math.max(1.5, sorted[sorted.length >> 1] * 2.5);
    keep = errs.map((e) => e < lim);
  }
  const inl = errs.filter((_, i) => keep[i]);
  if (inl.length < 6 || inl.length < pts.length * 0.4) return null;
  return { t: t!, inliers: inl.length, err: inl.sort((x, y) => x - y)[inl.length >> 1] };
}

/** Where the edit put the layers' content: identity when nothing moved or nothing could be told. */
export function alignEdit(before: Float32Array, after: Float32Array, w: number, h: number, skip?: Uint8Array): Affine {
  const A = edges(blur(before, w, h, 1), w, h);
  const B = edges(blur(after, w, h, 1), w, h);
  const fit = fitAffine(blockShifts(A, B, w, h, 128, 96, skip));
  if (!fit) return IDENTITY;
  // Less than half a pixel anywhere: nothing moved (a brushed edit is pasted back as it was).
  const far = [applyAffine(fit.t, 0, 0), applyAffine(fit.t, w, 0), applyAffine(fit.t, 0, h), applyAffine(fit.t, w, h)];
  const corners = [
    [0, 0],
    [w, 0],
    [0, h],
    [w, h],
  ];
  return far.every((p, i) => Math.hypot(p.x - corners[i][0], p.y - corners[i][1]) < 0.5) ? IDENTITY : fit.t;
}

/** The edit's change of tone, as a lookup: luminance before (0-255) -> the luminance the edit gives
 * it where nothing else happened (`far`: pixels away from the objects and the marks). Median per
 * bin, made non-decreasing; ranges with too few pixels follow their neighbours. */
export function toneCurve(before: Float32Array, after: Float32Array, far: Uint8Array): Float32Array {
  const BINS = 32;
  const hist = Array.from({ length: BINS }, () => new Uint32Array(256));
  const count = new Uint32Array(BINS);
  for (let i = 0; i < before.length; i++) {
    if (!far[i]) continue;
    const k = Math.min(BINS - 1, Math.floor(before[i] / (256 / BINS)));
    hist[k][Math.min(255, Math.max(0, Math.round(after[i])))]++;
    count[k]++;
  }
  const mids: number[] = [];
  const vals: number[] = [];
  for (let k = 0; k < BINS; k++) {
    if (count[k] < 50) continue;
    let acc = 0;
    let v = 0;
    for (; v < 255; v++) if ((acc += hist[k][v]) * 2 >= count[k]) break;
    mids.push((k + 0.5) * (256 / BINS));
    vals.push(v);
  }
  const lut = new Float32Array(256);
  if (!mids.length) {
    for (let i = 0; i < 256; i++) lut[i] = i;
    return lut;
  }
  for (let i = 0; i < 256; i++) {
    let v: number;
    if (i <= mids[0]) v = (vals[0] * (i + 2)) / (mids[0] + 2);
    else if (i >= mids[mids.length - 1]) v = (vals[vals.length - 1] * (i + 2)) / (mids[mids.length - 1] + 2);
    else {
      let k = 0;
      while (mids[k + 1] < i) k++;
      const t = (i - mids[k]) / (mids[k + 1] - mids[k]);
      v = vals[k] + t * (vals[k + 1] - vals[k]);
    }
    lut[i] = i ? Math.max(v, lut[i - 1]) : v;
  }
  return lut;
}

/** Per pixel, how much darker the edit made it than its tone change alone would (0-1), above
 * `floor` (decode noise, texture redrawn). Both luminances blurred already. */
export function darkness(before: Float32Array, after: Float32Array, lut: Float32Array, floor = 0.06): Float32Array {
  const out = new Float32Array(before.length);
  for (let i = 0; i < out.length; i++) {
    const want = lut[Math.min(255, Math.max(0, Math.round(before[i])))];
    const d = 1 - (after[i] + 2) / (want + 2);
    out[i] = d > floor ? Math.min(1, (d - floor) / (1 - floor)) : 0;
  }
  return out;
}

/** Nearest object and the distance to it (px, chamfer 3-4) for every pixel: `labels` = the
 * object's index on its pixels, -1 elsewhere. */
export function nearest(labels: Int16Array, w: number, h: number): { label: Int16Array; dist: Float32Array } {
  const label = labels.slice();
  const dist = new Float32Array(w * h);
  for (let i = 0; i < dist.length; i++) dist[i] = label[i] >= 0 ? 0 : Infinity;
  const look = (i: number, j: number, c: number) => {
    if (dist[j] + c < dist[i]) {
      dist[i] = dist[j] + c;
      label[i] = label[j];
    }
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) look(i, i - 1, 1);
      if (y > 0) {
        look(i, i - w, 1);
        if (x > 0) look(i, i - w - 1, 1.4142);
        if (x < w - 1) look(i, i - w + 1, 1.4142);
      }
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) look(i, i + 1, 1);
      if (y < h - 1) {
        look(i, i + w, 1);
        if (x < w - 1) look(i, i + w + 1, 1.4142);
        if (x > 0) look(i, i + w - 1, 1.4142);
      }
    }
  return { label, dist };
}

/** Each object's shadow (0-255 per pixel), from the darkening the edit added:
 * - one darkness map first: the objects' own pixels and a few px around their outlines (`edge`:
 *   the edit redraws an object's edge, so nothing is read there) are filled from the readings
 *   around them (a soft average over ~`under` px), so there is no light seam between an object
 *   and its shadow, and the shadow drawn under an object stays whole when it moves;
 * - kept within `reach` px of an object (fading out over the last quarter), not on `others`
 *   (objects that get no shadow here);
 * - shared between the objects softly by how near each one is, as alphas that stack back to the
 *   map exactly (1 - (1 - a)^share each): no hard cut where two shadows meet, which any resampling
 *   would turn into a light line.
 * `objects[k]`: object k's pixels (alpha > 128). */
export function splitShadows(dark: Float32Array, objects: Uint8Array[], w: number, h: number, reach: number, under: number, others?: Uint8Array, edge = 0): Uint8Array[] {
  const n = w * h;
  const covered = new Uint8Array(n);
  for (const m of edge >= 1 ? objects.map((o) => dilate(o, w, h, edge)) : objects) for (let i = 0; i < n; i++) if (m[i]) covered[i] = 1;
  const known = Float32Array.from(covered, (c) => (c ? 0 : 1));
  const r = Math.max(1, Math.round(under / 2));
  const bv = blur(Float32Array.from(dark, (v, i) => v * known[i]), w, h, r);
  const bk = blur(known, w, h, r);
  const total = Float32Array.from(dark, (v, i) => (known[i] ? v : bk[i] > 0.02 ? bv[i] / bk[i] : 0));
  const dists = objects.map((m) => nearest(Int16Array.from(m, (v) => (v ? 0 : -1)), w, h).dist);
  const tau = Math.max(1.5, under / 2);
  const out = objects.map(() => new Uint8Array(n));
  const wk = new Float64Array(objects.length);
  for (let i = 0; i < n; i++) {
    if (!total[i] || others?.[i]) continue;
    let dmin = Infinity;
    for (const d of dists) dmin = Math.min(dmin, d[i]);
    if (dmin > reach) continue;
    const a = Math.min(0.999, total[i] * Math.min(1, (reach - dmin) / (reach * 0.25)));
    let sum = 0;
    for (let k = 0; k < dists.length; k++) sum += wk[k] = Math.exp(-(dists[k][i] - dmin) / tau);
    for (let k = 0; k < dists.length; k++) out[k][i] = Math.round((1 - Math.pow(1 - a, wk[k] / sum)) * 255);
  }
  return out;
}

/** Pixels the edit changed beyond its tone change, not counting shadows (darker, same colour):
 * where a new object was drawn. RGBA in, both at the analysis size; `lut` from toneCurve. */
export function changed(before: ArrayLike<number>, after: ArrayLike<number>, lut: Float32Array, n: number, threshold = 28): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const lb = 0.2126 * before[j] + 0.7152 * before[j + 1] + 0.0722 * before[j + 2];
    const la = 0.2126 * after[j] + 0.7152 * after[j + 1] + 0.0722 * after[j + 2];
    const g = (lut[Math.min(255, Math.round(lb))] + 2) / (lb + 2);
    const diff = (Math.abs(after[j] - before[j] * g) + Math.abs(after[j + 1] - before[j + 1] * g) + Math.abs(after[j + 2] - before[j + 2] * g)) / 3;
    if (diff < threshold) continue;
    // A shadow: darker with the same hue (chromaticity within a few %).
    const sb = before[j] + before[j + 1] + before[j + 2] + 3;
    const sa = after[j] + after[j + 1] + after[j + 2] + 3;
    const hue = Math.abs((after[j] + 1) / sa - (before[j] + 1) / sb) + Math.abs((after[j + 1] + 1) / sa - (before[j + 1] + 1) / sb);
    if (la < lb * g && hue < 0.04) continue;
    out[i] = 255;
  }
  return out;
}

/** The pieces of `m` that touch `seed`, with their holes filled: one new object from the changed
 * pixels around its marks. */
export function objectAt(m: Uint8Array, seed: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let i = 0; i < m.length; i++)
    if (m[i] && seed[i] && !out[i]) {
      out[i] = 255;
      stack.push(i);
    }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
      if (j >= 0 && j < m.length && m[j] && !out[j]) {
        out[j] = 255;
        stack.push(j);
      }
  }
  return fillHoles(out, w, h);
}

/** Fills what the mask encloses (not reachable from the border without crossing it). */
export function fillHoles(m: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!m[i] && !outside[i]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < m.length - w) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 255;
  return out;
}

/** The colours of the sketch pencil, as Qwen reads them (named in the prompt). */
export const MARK_COLOURS = [
  { name: "red", css: "#ff2020", rgb: [255, 32, 32] },
  { name: "blue", css: "#1f5bff", rgb: [31, 91, 255] },
  { name: "green", css: "#14c814", rgb: [20, 200, 20] },
  { name: "yellow", css: "#ffd400", rgb: [255, 212, 0] },
] as const;

export type MarkColour = (typeof MARK_COLOURS)[number]["name"];

/** The prompt for new objects drawn as coloured marks: one clause per colour (`what` empty: Qwen
 * picks something that fits). Prompt+ may rewrite it; it sees the marks too. */
export function marksPrompt(marks: { colour: MarkColour; what: string }[]): string {
  const clauses = marks.map((m) => `${m.what.trim() || "something that fits the scene"} where the ${m.colour} marks are`);
  const list = clauses.length > 1 ? `${clauses.slice(0, -1).join(", ")} and ${clauses[clauses.length - 1]}` : clauses[0];
  return `Add ${list}. Draw each one at the size and place of its marks, sitting naturally in the scene with matching perspective and light. Remove all the coloured marks completely. Keep everything else in the image unchanged.`;
}
