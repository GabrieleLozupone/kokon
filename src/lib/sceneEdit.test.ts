import { describe, expect, it } from "vitest";
import { alignEdit, applyAffine, attached, changed, darkness, fillHoles, IDENTITY, invertAffine, marksPrompt, objectAt, phaseShift, splitShadows, toneCurve } from "./sceneEdit";

/** A textured test picture: smooth blobs of different sizes (edges everywhere, no repeats). */
function picture(w: number, h: number, at: (x: number, y: number) => { x: number; y: number } = (x, y) => ({ x, y })): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      let v = 120;
      for (let k = 0; k < 40; k++) {
        const cx = (k * 97.3) % w;
        const cy = (k * 61.7 + k * k * 3.1) % h;
        const r = 6 + ((k * 13) % 23);
        const d = Math.hypot(p.x - cx, p.y - cy);
        v += (k % 2 ? 60 : -50) * Math.max(0, 1 - d / r);
      }
      out[y * w + x] = Math.max(0, Math.min(255, v));
    }
  return out;
}

describe("scene edits", () => {
  it("phase correlation finds a block's shift", () => {
    const n = 64;
    const a = picture(n, n);
    const b = picture(n, n, (x, y) => ({ x: x - 5, y: y + 3 }));
    const s = phaseShift(a, b, n);
    // b(p + d) = a(p): b's content is 5 right and 3 up of a's.
    expect(s.dx).toBeCloseTo(5, 0);
    expect(s.dy).toBeCloseTo(-3, 0);
  });

  it("an edit that zoomed the picture is put back over the layers (the 10-31 kitchen case)", () => {
    const w = 640;
    const h = 384;
    const before = picture(w, h);
    // The edit's pixel p shows the layers' point at the centre + (p - centre) / zoom: 1.5 % wider,
    // 2.5 % taller, as Qwen did.
    const zx = 1.015;
    const zy = 1.025;
    const after = picture(w, h, (x, y) => ({ x: w / 2 + (x - w / 2) / zx, y: h / 2 + (y - h / 2) / zy }));
    const t = alignEdit(before, after, w, h);
    // The layers' corner (0, 0) is drawn at centre - centre * zoom in the edit.
    const p = applyAffine(t, 0, 0);
    expect(p.x).toBeCloseTo(w / 2 - (w / 2) * zx, 0);
    expect(p.y).toBeCloseTo(h / 2 - (h / 2) * zy, 0);
    const back = applyAffine(invertAffine(t), p.x, p.y);
    expect(back.x).toBeCloseTo(0, 5);
  });

  it("an edit that moved nothing is the identity", () => {
    const w = 400;
    const h = 300;
    const before = picture(w, h);
    expect(alignEdit(before, before.slice(), w, h)).toEqual(IDENTITY);
  });

  it("the edit's change of tone is not a shadow; real darkening near an object is", () => {
    const n = 100 * 100;
    const before = new Float32Array(n).fill(150);
    // The whole frame 10 % darker (the edit's grade), plus a shadow patch half as bright.
    const after = before.map((v) => v * 0.9);
    for (let y = 60; y < 70; y++) for (let x = 40; x < 60; x++) after[y * 100 + x] = 150 * 0.9 * 0.5;
    const far = new Uint8Array(n).fill(1);
    const lut = toneCurve(before, after, far);
    expect(Math.abs(lut[150] - 135)).toBeLessThan(3);
    const d = darkness(before, after, lut);
    expect(d[10 * 100 + 10]).toBe(0);
    expect(d[65 * 100 + 50]).toBeGreaterThan(0.4);
  });

  it("each object gets the darkening nearest to it, within its reach, and the same under its base", () => {
    const w = 100;
    const h = 40;
    const left = new Uint8Array(w * h);
    const right = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++)
      for (let x = 10; x < 20; x++) {
        left[y * w + x] = 255;
        right[y * w + x + 60] = 255;
      }
    const dark = new Float32Array(w * h);
    // A shadow right under the left object, touching it; another far from both.
    for (let y = 20; y < 24; y++) for (let x = 10; x < 20; x++) dark[y * w + x] = 0.8;
    dark[38 * w + 50] = 0.8;
    const [a, b] = splitShadows(dark, [left, right], w, h, 12, 3);
    expect(a[21 * w + 15]).toBeGreaterThan(150);
    expect(b[21 * w + 15]).toBe(0);
    // Under the object's bottom edge: carried in, so no seam.
    expect(a[18 * w + 15]).toBeGreaterThan(150);
    expect(a[11 * w + 15]).toBe(0);
    // Too far from any object.
    expect(a[38 * w + 50] + b[38 * w + 50]).toBe(0);
  });

  it("where two objects' shadows meet, their layers stack back to the whole darkness (no seam)", () => {
    const w = 80;
    const h = 30;
    const a = new Uint8Array(w * h);
    const b = new Uint8Array(w * h);
    for (let y = 5; y < 10; y++)
      for (let x = 0; x < 10; x++) {
        a[y * w + x + 20] = 255;
        b[y * w + x + 50] = 255;
      }
    const dark = new Float32Array(w * h);
    for (let y = 12; y < 20; y++) for (let x = 15; x < 65; x++) dark[y * w + x] = 0.5;
    const [sa, sb] = splitShadows(dark, [a, b], w, h, 40, 4);
    for (const x of [38, 40, 42, 44]) {
      const i = 15 * w + x;
      const stacked = 1 - (1 - sa[i] / 255) * (1 - sb[i] / 255);
      expect(Math.abs(stacked - 0.5)).toBeLessThan(0.02);
    }
    // Each is soft across the middle, not cut.
    expect(sa[15 * w + 40]).toBeGreaterThan(20);
    expect(sb[15 * w + 40]).toBeGreaterThan(20);
  });

  it("no light seam where the edit redrew an object's edge (no darkening in a thin ring around it)", () => {
    const w = 60;
    const h = 40;
    const obj = new Uint8Array(w * h);
    for (let y = 10; y < 20; y++) for (let x = 20; x < 30; x++) obj[y * w + x] = 255;
    const dark = new Float32Array(w * h);
    // Shadow below, but the 2 px right under the object's edge read nothing.
    for (let y = 22; y < 30; y++) for (let x = 15; x < 35; x++) dark[y * w + x] = 0.6;
    const [plain] = splitShadows(dark, [obj], w, h, 20, 4);
    const [edged] = splitShadows(dark, [obj], w, h, 20, 4, undefined, 3);
    expect(plain[20 * w + 25]).toBe(0);
    expect(edged[20 * w + 25]).toBeGreaterThan(90);
  });

  it("a new object is what changed around its marks, without its shadow, holes filled", () => {
    const w = 60;
    const h = 40;
    const before = new Uint8ClampedArray(w * h * 4);
    const after = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      before.set([180, 140, 100, 255], i * 4);
      after.set([180, 140, 100, 255], i * 4);
    }
    // A green ring (the object, with a hole) and a darker strip of the same brown (its shadow).
    for (let y = 10; y < 20; y++) for (let x = 20; x < 30; x++) if (y < 12 || y > 17 || x < 22 || x > 27) after.set([40, 160, 60, 255], (y * w + x) * 4);
    for (let y = 20; y < 24; y++) for (let x = 20; x < 30; x++) after.set([90, 70, 50, 255], (y * w + x) * 4);
    const lut = new Float32Array(256).map((_, i) => i);
    const m = changed(before, after, lut, w * h);
    expect(m[22 * w + 25]).toBe(0);
    const seed = new Uint8Array(w * h);
    seed[10 * w + 20] = 1;
    const obj = objectAt(m, seed, w, h);
    expect(obj[15 * w + 25]).toBe(255);
    expect(obj[5 * w + 5]).toBe(0);
  });

  it("fills only enclosed holes", () => {
    const w = 5;
    const m = new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 255, 0, 255, 0, 0, 255, 255, 255, 0, 0, 0, 0, 0, 0]);
    const f = fillHoles(m, w, 5);
    expect(f[12]).toBe(255);
    expect(f[0]).toBe(0);
  });

  it("names each colour's object in the prompt", () => {
    expect(marksPrompt([{ colour: "red", what: "a green glass bottle" }])).toMatch(/^Add a green glass bottle where the red marks are\. .*Remove all the coloured marks/);
    expect(marksPrompt([
      { colour: "red", what: "a bottle" },
      { colour: "blue", what: "" },
    ])).toMatch(/^Add a bottle where the red marks are and something that fits the scene where the blue marks are\./);
  });
});

describe("attached", () => {
  it("keeps a long shadow whole from the object, through it, and leaves loose darkening out", () => {
    const w = 40;
    const h = 10;
    const dark = new Float32Array(w * h);
    const seed = new Uint8Array(w * h);
    const obj = new Uint8Array(w * h);
    // A shadow along row 8 from x 2 to 30, the object (no darkening read on it) at x 10-11.
    for (let x = 2; x <= 30; x++) dark[8 * w + x] = x === 10 || x === 11 ? 0 : 0.3;
    for (const x of [10, 11]) obj[8 * w + x] = 1;
    seed[8 * w + 12] = 1;
    // Noise far away, not touching it.
    dark[1 * w + 35] = 0.5;
    const m = attached(dark, seed, w, h, 0.02, obj);
    expect(m[8 * w + 30]).toBe(255);
    expect(m[8 * w + 2]).toBe(255);
    expect(m[1 * w + 35]).toBe(0);
  });
});
