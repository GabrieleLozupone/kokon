import { describe, expect, it } from "vitest";
import { blendEffects, blendKeep, blendPrompt, DEFAULT_READING } from "./blend";
import type { SceneReading } from "./types";

const read = (o: Partial<SceneReading>): SceneReading => ({ ...DEFAULT_READING, complete: true, ...o });
const WATER = /water|puddle|ripple|reflection|wet|mirror/i;

describe("blend prompts", () => {
  it("names water and reflections only where the surface has them", () => {
    // The bench's four scenes as the reader saw them (2026-11-02).
    expect(blendEffects("Man", read({ surface: "dry", light: "sun", hard_shadows: true, shadows_fall: "right" }))).toBe(
      "Add the man's hard-edged shadow on the ground, starting at the bottom of the man and cast to the right with the same direction, angle and length as the other shadows in the scene, and a dark contact shadow where the man touches the ground. The ground is dry: no reflection.",
    );
    const puddle = blendEffects("Woman", read({ surface: "wet", light: "overcast", shadows_fall: "under" }));
    expect(puddle).toBe(
      "Add a faint soft darkening on the wet ground right where the woman touches it. Add the reflection of the lower part of the woman in the wet ground: mirrored upside down, starting exactly at the bottom of the woman, slightly darker, as clear as the other reflections in it.",
    );
    expect(blendEffects("Teapot", read({ surface: "glossy", light: "window", shadows_fall: "right" }))).toContain("a soft shadow on the polished surface under the teapot, falling slightly to the right");
    const grass = blendEffects("Dog", read({ surface: "grass", light: "sun", shadows_fall: "right" }));
    expect(grass).toContain("grass blades cover the bottom of the dog");
    expect(grass).not.toMatch(WATER);
    expect(blendEffects("Duck", read({ surface: "water" }))).toContain("small ripples around where it stands in the water");
    for (const surface of ["dry", "soil", "snow", "fabric", "other"] as const) expect(blendEffects("Box", read({ surface })).replace(/no reflection/i, "")).not.toMatch(WATER);
  });
  it("asks for every object in one edit, then what stays", () => {
    const one = blendPrompt([{ name: "Dog", reading: read({ surface: "grass" }) }]);
    expect(one.endsWith(" Do not change the dog. Keep everything else in the image unchanged.")).toBe(true);
    const three = blendPrompt(["Woman", "Dog", "Bench"].map((name) => ({ name, reading: read({}) })));
    expect(three).toContain("where the woman touches it. The ground is dry: no reflection. Add a faint soft darkening on the ground right where the dog");
    expect(three.endsWith("Do not change the woman, the dog and the bench. Keep everything else in the image unchanged.")).toBe(true);
  });
});

/** A w×h mask with the box [x0, x1] × [y0, y1] set. */
function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = 255;
  return m;
}

describe("blendKeep", () => {
  const w = 200;
  const h = 300;
  const obj = rect(w, h, 90, 60, 110, 120); // 61 px tall
  const valid = new Uint8Array(w * h).fill(1);
  /** A ground with a fine random texture (60-180; its blur is flat grey). */
  const texture = (seed: number) => {
    const px = new Uint8ClampedArray(w * h * 4);
    let s = seed;
    for (let i = 0; i < w * h; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const v = 60 + (s % 121);
      px.set([v, v, v, 255], i * 4);
    }
    return px;
  };
  const before = texture(1);
  const at = (m: Uint8Array, x: number, y: number) => m[y * w + x];

  it("pastes the changed area round the object with the object's part in it, nothing else", () => {
    const after = texture(2); // the whole ground redrawn: the same kind of texture, other grains
    const paint = (x0: number, y0: number, x1: number, y1: number, f: (v: number) => number) => {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (let c = 0; c < 3; c++) after[(y * w + x) * 4 + c] = f(after[(y * w + x) * 4 + c]);
    };
    paint(80, 105, 150, 140, (v) => v * 0.35); // its shadow, and its feet redrawn darker (Qwen moved them)
    paint(92, 65, 108, 85, () => 230); // its top recoloured: a change of the object itself
    paint(5, 5, 25, 25, (v) => v * 0.3); // a dark patch far away
    paint(0, 285, w - 1, 299, (v) => v * 0.35); // a dark band past twice its height...
    paint(140, 140, 144, 299, (v) => v * 0.35); // ...attached to the shadow by a thin strip
    const r = blendKeep(before, after, valid, obj, w, h);
    expect(at(r.alpha, 130, 130)).toBeGreaterThan(200); // the shadow
    expect(at(r.alpha, 100, 115)).toBeGreaterThan(200); // the object's feet, from the edit
    expect(at(r.alpha, 100, 75)).toBe(0); // its recoloured top stays the original
    expect(at(r.alpha, 60, 60)).toBe(0); // the redrawn texture
    expect(at(r.alpha, 15, 15)).toBe(0); // far away, not touching it
    expect(at(r.alpha, 5, 292)).toBe(0); // beyond twice its height
    expect(r.n).toBeGreaterThan(1500);
  });
  it("pastes nothing when only the tone changed, and the tone comes back", () => {
    const after = before.slice();
    for (let i = 0; i < after.length; i += 4) for (let c = 0; c < 3; c++) after[i + c] = Math.min(255, after[i + c] * 0.8);
    const r = blendKeep(before, after, valid, obj, w, h);
    expect(r.n).toBe(0);
    expect(Math.abs(r.lut[96] - 120)).toBeLessThan(4); // 0.8 darker -> brought back
  });
});
