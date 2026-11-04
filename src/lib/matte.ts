// Fast stickers for the layers lab: BiRefNet lite (MIT) gives the matte, run by kokon-service on the
// CPU (crates/qls-core/src/matting.rs: the webview could not run it, WebGPU kernels rejected and WASM out
// of memory, 11-02).
//
// Spike s17 (11-02, wiki/layers.md): a salient-object model cuts out the main thing of a crop, not the
// object the user chose, so SAM decides what and the matte decides the edge: the model sees the object
// with the rest faded to grey (`focusPixels`), its matte may empty holes inside the selection (spokes,
// a handle, a halo SAM took) but adds nothing beyond a thin band around it, and when it drops a whole
// piece of the selection the selection's own edge band is used instead (`stickerAlpha`). The edge
// colours are then freed of the background bleeding into them (`foreground`, Germer et al. 2020).

import { api } from "./api";
import { dilate, erode, type Mask } from "./layers";

/** The model's matte (0-1) of RGBA pixels `w`×`h`, at that size (uploaded, matted by the service). */
export async function modelMatte(rgba: Uint8ClampedArray, w: number, h: number): Promise<Float32Array> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  const png = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"));
  const rec = await api.upload(png, "sticker input.png");
  const m = await createImageBitmap(await api.matte(`input:${rec.id}`));
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(m, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] / 255;
  return out;
}

/** Box blur (radius r, 3 passes ~ Gaussian) of a 0-1 image. */
function blur(a: Float32Array, w: number, h: number, r: number): Float32Array {
  r = Math.max(1, Math.round(r));
  let cur = a.slice();
  const tmp = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += cur[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / (2 * r + 1);
        s += cur[y * w + Math.min(w - 1, x + r + 1)] - cur[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = s / (2 * r + 1);
        s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
  }
  return cur;
}

const toUnit = (m: Mask) => Float32Array.from(m, (v) => (v > 127 ? 1 : 0));

/** The model's input: the selected object, the rest faded to grey 4 % of the side away from it. */
export function focusPixels(rgba: Uint8ClampedArray, sel: Mask, w: number, h: number): Uint8ClampedArray {
  const r = Math.max(6, 0.04 * Math.max(w, h));
  const g = blur(toUnit(dilate(sel, w, h, r)), w, h, r / 3);
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 3; k++) out[i * 4 + k] = rgba[i * 4 + k] * g[i] + 128 * (1 - g[i]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** The band around the selection's edge where the matte decides (px). */
export const bandOf = (w: number, h: number) => Math.max(4, 0.015 * Math.max(w, h));

/** SAM decides what, the matte only the edge: 1 deep inside the selection, 0 beyond the band. */
export function bandAlpha(matte: Float32Array, sel: Mask, w: number, h: number): Float32Array {
  const r = bandOf(w, h);
  const inner = erode(sel, w, h, r);
  const outer = dilate(sel, w, h, r);
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = inner[i] > 127 ? 1 : outer[i] > 127 ? Math.min(1, Math.max(0, matte[i])) : 0;
  return a;
}

/** A piece of the selection whose core (eroded by the band) is bigger than 2 % of the selection and
 * keeps less than 30 % in the matte: the matte dropped it (the bats of the poster, s17). */
export function dropsPiece(a: Float32Array, sel: Mask, w: number, h: number): boolean {
  const core = erode(sel, w, h, bandOf(w, h));
  let total = 0;
  for (const v of sel) if (v > 127) total++;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let s = 0; s < core.length; s++) {
    if (core[s] < 128 || seen[s]) continue;
    let n = 0;
    let kept = 0;
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      n++;
      if (a[i] > 0.5) kept++;
      const x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of nb)
        if (j >= 0 && j < core.length && !seen[j] && core[j] > 127) {
          seen[j] = 1;
          stack.push(j);
        }
    }
    if (n > 0.02 * total && kept / n < 0.3) return true;
  }
  return false;
}

/** The sticker's alpha from the model's matte and the selection (both `w`×`h`): the matte inside the
 * selection grown by the band (it may empty holes, it adds nothing farther out), or the band alone
 * when the matte dropped a whole piece of the selection (`fellBack`). */
export function stickerAlpha(matte: Float32Array, sel: Mask, w: number, h: number): { alpha: Float32Array; fellBack: boolean } {
  const outer = blur(toUnit(dilate(sel, w, h, bandOf(w, h))), w, h, 1);
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = Math.min(1, Math.max(0, matte[i])) * outer[i];
  return dropsPiece(a, sel, w, h) ? { alpha: bandAlpha(matte, sel, w, h), fellBack: true } : { alpha: a, fellBack: false };
}

/** How much of the selection the sticker keeps (0-1): the share of selected pixels with alpha over
 * one half. A quick cut-out that keeps almost nothing failed (an empty or wrong matte), and must
 * say so instead of putting an invisible layer in place of the object. */
export function keptShare(alpha: Float32Array, sel: Mask): number {
  let inside = 0;
  let kept = 0;
  for (let i = 0; i < sel.length; i++) {
    if (sel[i] <= 127) continue;
    inside++;
    if (alpha[i] > 0.5) kept++;
  }
  return inside ? kept / inside : 0;
}

/** Below this share of its selection kept, a quick cut-out counts as failed. */
export const MIN_KEPT = 0.2;

/** Foreground colours of `rgba` under `alpha` (0-1): what the edge pixels would be without the
 * background mixed in (multilevel estimation of Germer, Uelwer, Conrad, Harmeling 2020, as in
 * pymatting's estimate_foreground_ml: coarse to fine, F and B solved per pixel from the neighbours). */
export function foreground(rgba: Uint8ClampedArray, alpha: Float32Array, w: number, h: number): Uint8ClampedArray {
  const n0 = w * h;
  const img = new Float32Array(n0 * 3);
  for (let i = 0; i < n0; i++) for (let k = 0; k < 3; k++) img[i * 3 + k] = rgba[i * 4 + k] / 255;
  const levels = Math.ceil(Math.log2(Math.max(w, h)));
  let F = new Float32Array(3);
  let B = new Float32Array(3);
  let pw = 1;
  let ph = 1;
  for (let k = 0; k < 3; k++) F[k] = B[k] = img[k];
  for (let lv = 0; lv <= levels; lv++) {
    const lw = Math.max(1, Math.round(w ** (lv / levels)));
    const lh = Math.max(1, Math.round(h ** (lv / levels)));
    const n = lw * lh;
    const I = new Float32Array(n * 3);
    const A = new Float32Array(n);
    const Fn = new Float32Array(n * 3);
    const Bn = new Float32Array(n * 3);
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        const sx = Math.min(w - 1, Math.floor((x * w) / lw));
        const sy = Math.min(h - 1, Math.floor((y * h) / lh));
        const px = Math.min(pw - 1, Math.floor((x * pw) / lw));
        const py = Math.min(ph - 1, Math.floor((y * ph) / lh));
        const i = y * lw + x;
        A[i] = alpha[sy * w + sx];
        for (let k = 0; k < 3; k++) {
          I[i * 3 + k] = img[(sy * w + sx) * 3 + k];
          Fn[i * 3 + k] = F[(py * pw + px) * 3 + k];
          Bn[i * 3 + k] = B[(py * pw + px) * 3 + k];
        }
      }
    const iters = n <= 32 * 32 ? 10 : 2;
    for (let it = 0; it < iters; it++)
      for (let y = 0; y < lh; y++)
        for (let x = 0; x < lw; x++) {
          const i = y * lw + x;
          const a = A[i];
          // A tiny regularisation: with no neighbours (the 1×1 level) the system is singular.
          let a00 = a * a + 1e-5;
          let a11 = (1 - a) * (1 - a) + 1e-5;
          const a01 = a * (1 - a);
          let f0 = 0, f1 = 0, f2 = 0, b0 = 0, b1 = 0, b2 = 0;
          for (let q = 0; q < 4; q++) {
            const nx = q === 0 ? x - 1 : q === 1 ? x + 1 : x;
            const ny = q === 2 ? y - 1 : q === 3 ? y + 1 : y;
            if (nx < 0 || ny < 0 || nx >= lw || ny >= lh) continue;
            const j = ny * lw + nx;
            const wgt = 5e-3 + 0.1 * Math.abs(a - A[j]);
            a00 += wgt;
            a11 += wgt;
            f0 += wgt * Fn[j * 3];
            f1 += wgt * Fn[j * 3 + 1];
            f2 += wgt * Fn[j * 3 + 2];
            b0 += wgt * Bn[j * 3];
            b1 += wgt * Bn[j * 3 + 1];
            b2 += wgt * Bn[j * 3 + 2];
          }
          const det = a00 * a11 - a01 * a01;
          for (let k = 0; k < 3; k++) {
            const r0 = (k === 0 ? f0 : k === 1 ? f1 : f2) + a * I[i * 3 + k];
            const r1 = (k === 0 ? b0 : k === 1 ? b1 : b2) + (1 - a) * I[i * 3 + k];
            Fn[i * 3 + k] = Math.min(1, Math.max(0, (a11 * r0 - a01 * r1) / det));
            Bn[i * 3 + k] = Math.min(1, Math.max(0, (a00 * r1 - a01 * r0) / det));
          }
        }
    F = Fn;
    B = Bn;
    pw = lw;
    ph = lh;
  }
  const out = new Uint8ClampedArray(n0 * 4);
  for (let i = 0; i < n0; i++) {
    // Solid object: the photo's own pixels (full detail); estimated colours only where alpha is soft.
    const solid = alpha[i] > 0.98;
    for (let k = 0; k < 3; k++) out[i * 4 + k] = Math.round(255 * (solid ? img[i * 3 + k] : F[i * 3 + k]));
    out[i * 4 + 3] = Math.round(255 * alpha[i]);
  }
  return out;
}
