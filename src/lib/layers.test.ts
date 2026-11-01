import { describe, expect, it } from "vitest";
import { addTo, dilate, erode, fileSafe, fromLogits, grow, maskOrder, refineEdges, removeFrom, samSelection, union } from "./layers";

describe("layers lab masks", () => {
  it("adding to a layer takes the pixels from the others", () => {
    const masks = [new Uint8Array([255, 255, 0]), new Uint8Array([0, 0, 0])];
    addTo(masks, 1, [0, 255, 255]);
    expect([...masks[0]]).toEqual([255, 0, 0]);
    expect([...masks[1]]).toEqual([0, 255, 255]);
  });

  it("a soft stroke leaves the rest of the other layer's alpha", () => {
    const masks = [new Uint8Array([255]), new Uint8Array([0])];
    addTo(masks, 1, [100]);
    expect([...masks[0]]).toEqual([155]);
    expect([...masks[1]]).toEqual([100]);
  });

  it("a click only takes what no other layer has", () => {
    const masks = [new Uint8Array([255, 0, 100]), new Uint8Array([0, 0, 0])];
    addTo(masks, 1, [255, 255, 255], false);
    expect([...masks[0]]).toEqual([255, 0, 100]);
    expect([...masks[1]]).toEqual([0, 255, 155]);
  });

  it("removing gives the pixels back to the background only", () => {
    const m = new Uint8Array([255, 255]);
    removeFrom(m, [255, 0]);
    expect([...m]).toEqual([0, 255]);
  });

  it("logits above 0 are selected; union takes the largest alpha", () => {
    expect([...fromLogits([-1, 0, 0.5])]).toEqual([0, 0, 255]);
    expect([...union([new Uint8Array([10, 0]), new Uint8Array([5, 200])], 2)]).toEqual([10, 200]);
  });

  it("dilate grows by r in both directions and stays inside the image", () => {
    const w = 5;
    const h = 5;
    const m = new Uint8Array(w * h);
    m[2 * w + 2] = 255;
    const d = dilate(m, w, h, 1);
    const on = [...d].map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
    expect(on).toEqual([6, 7, 8, 11, 12, 13, 16, 17, 18]);
    expect([...dilate(m, w, h, 0)]).toEqual([...m]);
  });

  it("mask order: best IoU first, then smallest to largest", () => {
    expect(maskOrder([0.99, 0.89, 1.01, 0.82], [0.2, 0.17, 0.196, 0.275])).toEqual([2, 1, 3]);
    expect(maskOrder([0.5], [0.1])).toEqual([0]);
  });

  it("file names lose the characters Windows refuses", () => {
    expect(fileSafe('a/b: "c"')).toBe("a b c");
    expect(fileSafe("  ")).toBe("layer");
  });

  it("erode shrinks what dilate grows", () => {
    const w = 7;
    const m = new Uint8Array(w * w);
    m[3 * w + 3] = 255;
    expect([...erode(dilate(m, w, w, 2), w, w, 2)]).toEqual([...m]);
  });

  it("grow reaches further down than up", () => {
    const w = 1;
    const h = 9;
    const m = new Uint8Array(h);
    m[4] = 255;
    const g = grow(m, w, h, { left: 0, right: 0, up: 1, down: 3 });
    expect([...g].map((v) => (v ? 1 : 0))).toEqual([0, 0, 0, 1, 1, 1, 1, 1, 0]);
  });

  it("refineEdges snaps a stepped mask to the photo's edge and keeps the inside solid", () => {
    // The photo: a bright disc (r 10) on dark; the mask: the same disc in 4 px steps (SAM-like).
    const w = 40;
    const h = 40;
    const gray = new Float32Array(w * h);
    const coarse = new Uint8Array(w * h);
    const truth = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const inDisc = Math.hypot(x - 20, y - 20) <= 10;
        gray[y * w + x] = inDisc ? 0.8 : 0.1;
        truth[y * w + x] = inDisc ? 255 : 0;
        coarse[y * w + x] = Math.hypot((x >> 2) * 4 + 2 - 20, (y >> 2) * 4 + 2 - 20) <= 10 ? 255 : 0;
      }
    const err = (m: Uint8Array) => m.reduce((s, v, i) => s + Math.abs(v - truth[i]), 0);
    const refined = refineEdges(coarse, gray, w, h, 4);
    expect(err(refined)).toBeLessThan(err(coarse) * 0.5);
    expect(refined[20 * w + 20]).toBe(255);
    expect(refined[0]).toBe(0);
  });
});

describe("samSelection", () => {
  it("takes SAM's object and a rim past it, two low-res cells wide", () => {
    // 512 px: two cells of 256 = 4 px.
    const w = 512;
    const h = 512;
    const logits = new Float32Array(w * h).fill(-5);
    for (let y = 200; y < 300; y++) for (let x = 200; x < 300; x++) logits[y * w + x] = 3;
    const m = samSelection(logits, w, h);
    expect(m[250 * w + 250]).toBe(255);
    expect(m[250 * w + 196]).toBe(255);
    expect(m[250 * w + 303]).toBe(255);
    expect(m[250 * w + 195]).toBe(0);
    expect(m[195 * w + 250]).toBe(0);
  });
});
