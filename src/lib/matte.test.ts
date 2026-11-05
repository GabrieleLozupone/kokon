import { describe, expect, it } from "vitest";
import { foreground, keptShare, MIN_KEPT, stickerAlpha } from "./matte";

const W = 64;
const H = 64;
/** A disc selection (255 inside), radius r around the centre. */
const disc = (r: number, cx = 32, cy = 32) => Uint8Array.from({ length: W * H }, (_, i) => (Math.hypot((i % W) - cx, Math.floor(i / W) - cy) < r ? 255 : 0));

describe("fast sticker alpha", () => {
  it("lets the matte empty a hole inside the selection, adds nothing far outside", () => {
    const sel = disc(20);
    // The matte: the disc with a hole in the middle (a handle's gap), plus a blob far away.
    const matte = Float32Array.from(sel, (v, i) => {
      const x = i % W;
      const y = Math.floor(i / W);
      if (Math.hypot(x - 32, y - 32) < 5) return 0;
      if (x < 4 && y < 4) return 1;
      return v ? 1 : 0;
    });
    const { alpha, fellBack } = stickerAlpha(matte, sel, W, H);
    expect(fellBack).toBe(false);
    expect(alpha[32 * W + 32]).toBe(0);
    expect(alpha[32 * W + 45]).toBeGreaterThan(0.9);
    expect(alpha[1 * W + 1]).toBe(0);
  });

  it("falls back to the selection's edge band when the matte drops a whole piece", () => {
    // Two discs selected; the matte keeps only one (the bats it lost on the poster).
    const a = disc(10, 18, 32);
    const b = disc(10, 46, 32);
    const sel = Uint8Array.from(a, (v, i) => Math.max(v, b[i]));
    const matte = Float32Array.from(a, (v) => (v ? 1 : 0));
    const { alpha, fellBack } = stickerAlpha(matte, sel, W, H);
    expect(fellBack).toBe(true);
    expect(alpha[32 * W + 46]).toBe(1);
  });
});

describe("quick cut-out check", () => {
  it("counts how much of the selection the sticker keeps", () => {
    const sel = Uint8Array.from([255, 255, 255, 255, 0, 0]);
    expect(keptShare(Float32Array.from([1, 1, 0.9, 0.6, 1, 1]), sel)).toBe(1);
    expect(keptShare(Float32Array.from([1, 0, 0, 0, 1, 1]), sel)).toBe(0.25);
    // An empty matte (the model failed or saw nothing): fails the check, the layer stays.
    expect(keptShare(new Float32Array(6), sel)).toBeLessThan(MIN_KEPT);
    expect(keptShare(new Float32Array(6), new Uint8Array(6))).toBe(0);
  });
});

describe("foreground colours", () => {
  it("takes the background's tint out of a soft edge", () => {
    // White object on red: the edge pixels are half white, half red; the estimate gets nearer white.
    const alpha = Float32Array.from({ length: W * H }, (_, i) => Math.min(1, Math.max(0, (32 - (i % W)) / 4 + 0.5)));
    const rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const a = alpha[i];
      rgba.set([255, Math.round(255 * a), Math.round(255 * a), 255], i * 4);
    }
    const out = foreground(rgba, alpha, W, H);
    const i = 10 * W + 32; // alpha 0.5: the photo is (255, 128, 128)
    expect(rgba[i * 4 + 1]).toBeLessThan(140);
    expect(out[i * 4 + 1]).toBeGreaterThan(200);
    expect(out[i * 4 + 3]).toBe(Math.round(255 * alpha[i]));
  });
});
