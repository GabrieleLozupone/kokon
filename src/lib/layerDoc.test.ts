import { describe, expect, it } from "vitest";
import { copiedShare, cropFor, expandedRect, extOf, unionRect, docFor, keepLabsIn, labSources, loadLab, saveLab, waitingMarks, jobLayer, labItems, leftovers, putDoc, type LabStore, shadowAlpha, mapPoint, placed, reconcile, reorder, toLayer, xfOf, type DocLayer, type LayerDoc } from "./layerDoc";

const layer = (id: string, source: string, base = false): DocLayer => ({ id, name: id, source, history: [source], hidden: false, base, dx: 0, dy: 0, s: 1 });
const doc = (layers: DocLayer[]): LayerDoc => ({ width: 100, height: 100, layers, known: [] });

describe("layer document", () => {
  it("a layer follows the newest edit made from it, then the edits of that", () => {
    const d = doc([layer("a", "input:a"), layer("bg", "input:bg", true)]);
    const items = [
      { source: "gen:1", from: "input:a" },
      { source: "gen:2", from: "input:a" },
      { source: "gen:3", from: "gen:2" },
      { source: "gen:4", from: "input:x" },
    ];
    const r = reconcile(d, items);
    expect(r.layers[0].source).toBe("gen:3");
    expect(r.layers[0].history).toEqual(["input:a", "gen:2", "gen:3"]);
    expect(r.layers[1]).toBe(d.layers[1]);
    expect(r.known).toEqual(expect.arrayContaining(["gen:1", "gen:2", "gen:3"]));
  });

  it("an edit already seen is not adopted again (the user went back from it)", () => {
    const d = { ...doc([layer("a", "input:a")]), known: ["gen:1"] };
    expect(reconcile(d, [{ source: "gen:1", from: "input:a" }])).toBe(d);
  });

  it("an edit of the photo with the background's holes as the painted area fills the background", () => {
    const bg = { ...layer("bg", "input:bg", true), feeds: [{ source: "input:photo", mask: "m1" }] };
    const d0 = { ...doc([bg]), photo: "input:photo" };
    const items = [
      { source: "gen:other", from: "input:photo", mask: null },
      { source: "gen:fill", from: "input:photo", mask: "m1" },
      { source: "gen:more", from: "gen:fill", mask: null },
    ];
    const r = reconcile(d0, items);
    expect(r.layers[0].history).toEqual(["input:bg", "gen:fill", "gen:more"]);
    expect(r.known).not.toContain("gen:other");
  });

  it("a fill painted again in Paint area (another mask) still fills the background", () => {
    const bg = { ...layer("bg", "input:bg", true), feeds: [{ source: "input:tofill", mask: "m1" }] };
    const r = reconcile({ ...doc([bg]), photo: "input:photo" }, [{ source: "gen:wider", from: "input:tofill", mask: "m9" }]);
    expect(r.layers[0].source).toBe("gen:wider");
  });

  it("reorder keeps the background last", () => {
    const d = doc([layer("a", "x"), layer("b", "y"), layer("bg", "z", true)]);
    expect(reorder(d, 0, 5).layers.map((l) => l.id)).toEqual(["b", "a", "bg"]);
    expect(reorder(d, 2, 0)).toBe(d);
    expect(reorder(d, 1, 0).layers.map((l) => l.id)).toEqual(["b", "a", "bg"]);
  });

  it("toLayer undoes the move and the scale around the content's centre", () => {
    const l = { ...layer("a", "x"), dx: 10, dy: -5, s: 2 };
    const b = { x0: 40, y0: 40, x1: 60, y1: 60 };
    const p = placed(l, b);
    expect(p).toEqual({ x0: 40, y0: 25, x1: 80, y1: 65 });
    expect(toLayer(l, b, p.x0, p.y0)).toEqual({ x: 40, y: 40 });
    expect(toLayer(l, b, p.x1, p.y1)).toEqual({ x: 60, y: 60 });
  });

  it("a shadow follows its object from where the object was when it was made", () => {
    const box = { x0: 40, y0: 40, x1: 60, y1: 60 };
    const obj = { ...layer("cup", "c"), dx: 30, dy: 0, s: 2 };
    const shadow = { ...layer("sh", "s"), effect: true, follows: "cup", at: { dx: 10, dy: 0, s: 1 } };
    const t = xfOf([obj, shadow], shadow, () => box, 100, 100);
    // A shadow pixel at the object's old centre (50+10, 50) lands at its new centre (50+30, 50).
    expect(mapPoint(t, 60, 50)).toEqual({ x: 80, y: 50 });
    // 5 px right of the old centre: 10 px right of the new one (scale 1 -> 2).
    expect(mapPoint(t, 65, 50)).toEqual({ x: 90, y: 50 });
    // Nudged by hand (the model put it a little off): its own move adds to the object's.
    const nudged = { ...shadow, dx: 3, dy: -2 };
    expect(mapPoint(xfOf([obj, nudged], nudged, () => box, 100, 100), 60, 50)).toEqual({ x: 83, y: 48 });
    // Without `at` (or the object gone) a layer uses its own place.
    expect(xfOf([shadow], shadow, () => box, 100, 100)).toEqual({ c: { x: 50, y: 50 }, s: 1, dx: 0, dy: 0 });
  });

  it("shadowAlpha: how much darker, inside the painted area only; brighter pixels are left out", () => {
    const px = (v: number) => [v, v, v, 255];
    const before = [...px(200), ...px(200), ...px(200), ...px(200), ...px(100)];
    const after = [...px(199), ...px(100), ...px(240), ...px(0), ...px(50)];
    const a = [...shadowAlpha(before, after, [255, 255, 255, 255, 0])];
    expect(a[0]).toBe(0); // noise
    expect(a[1]).toBeGreaterThan(120); // half as bright: about half black
    expect(a[1]).toBeLessThan(135);
    expect(a[2]).toBe(0); // brighter
    expect(a[3]).toBeGreaterThan(250); // black
    expect(a[4]).toBe(0); // outside the area
  });

  it("labItems: the lab's versions and what was made from them; the photo and its own edits stay", () => {
    const d: LayerDoc = {
      ...doc([{ ...layer("bg", "input:bg", true), feeds: [{ source: "input:photo", mask: "m1" }] }, layer("cup", "gen:cup2")]),
      photo: "input:photo",
      known: ["input:bg", "input:cup"],
      pending: [{ source: "input:flat", mask: "m2", of: null }],
    };
    const lab: LabStore = { v: 2, docs: [d], made: ["input:old"] };
    const items = [
      { key: "photo", source: "input:photo", from: null },
      { key: "edit", source: "gen:e", from: "input:photo", mask: null },
      { key: "bg", source: "input:bg", from: null },
      { key: "cup", source: "input:cup", from: null },
      { key: "cup2", source: "gen:cup2", from: "input:cup" },
      { key: "cup3", source: "gen:cup3", from: "gen:cup2" },
      { key: "fill", source: "gen:f", from: "input:photo", mask: "m1" },
      { key: "flat", source: "input:flat", from: null },
      { key: "shadow", source: "gen:s", from: "input:flat", mask: "m2" },
      { key: "job", source: null, from: "gen:cup3" },
      { key: "export", source: "input:flattened", from: null },
      { key: "old", source: "input:old", from: null },
      { key: "oldEdit", source: "gen:o", from: "input:old" },
    ];
    const got = labItems(lab, items);
    expect([...got.keys()].sort()).toEqual(["bg", "cup", "cup2", "cup3", "fill", "flat", "job", "old", "oldEdit", "shadow"]);
    expect(got.get("cup3")).toBe("input:photo");
    expect(got.get("oldEdit")).toBeNull();
  });

  it("one document per image: found by its photo or by what it made; splitting again replaces it", () => {
    const a = { ...doc([layer("bg", "input:bgA", true)]), photo: "gen:A" };
    const b = { ...doc([layer("bg", "input:bgB", true)]), photo: "gen:B" };
    let lab: LabStore = putDoc(putDoc({ v: 2, docs: [], made: [] }, a), b);
    expect(lab.docs.length).toBe(2);
    expect(docFor(lab, "gen:B")).toBe(b);
    expect(docFor(lab, "input:bgA")).toBe(a);
    expect(docFor(lab, "gen:other")).toBeNull();
    const a2 = { ...doc([layer("bg", "input:bgA2", true)]), photo: "gen:A" };
    lab = putDoc(lab, a2);
    expect(lab.docs).toEqual([a2, b]);
  });

  it("leftovers: the lab's own images by name, and the cut-outs saved right after a split's background", () => {
    const it = (source: string, name: string | null, input = true) => ({ source, name, input });
    expect(
      leftovers([
        it("input:photo", "kitchen.png"),
        it("gen:e", null, false),
        it("input:bg", "Background (holes).png"),
        it("input:cup", "Cup.png"),
        it("input:glass", "Glass.png"),
        it("gen:x", null, false),
        it("input:crop", "Cup (object size).png"),
        it("input:fill", "Background to fill.png"),
        it("input:sh", "Cup shadow.png"),
        it("input:export", "Layers flattened.png"),
        it("input:mine", "holiday.png"),
      ]),
    ).toEqual(["input:bg", "input:cup", "input:glass", "input:crop", "input:fill", "input:sh"]);
  });

  it("jobLayer: an edit of a layer, of one of its fills, or a shadow being made", () => {
    const d: LayerDoc = {
      ...doc([layer("cup", "gen:cup2"), { ...layer("bg", "input:bg", true), feeds: [{ source: "input:fill", mask: "m1" }] }]),
      pending: [
        { source: "input:flat", mask: "m2", of: "cup" },
        { source: "input:flat2", mask: "m3", of: null },
        { source: "input:flat3", mask: "m4", of: null, layer: "fx-1" },
      ],
    };
    expect(jobLayer(d, "gen:cup2", null)).toBe("cup");
    expect(jobLayer(d, "input:fill", "m1")).toBe("bg");
    expect(jobLayer(d, "input:fill", "other")).toBe("bg"); // painted again in Paint area
    expect(jobLayer(d, "input:flat", "m2")).toBe("cup");
    expect(jobLayer(d, "input:flat2", "m3")).toBe("shadows");
    expect(jobLayer(d, "input:flat3", "m4")).toBe("fx-1");
    expect(jobLayer(d, "input:photo", null)).toBeNull();
  });

  it("cropFor: the object's box with a margin, inside the frame, enlarged to about 1 MP", () => {
    const { rect, scale } = cropFor({ x0: 100, y0: 200, x1: 300, y1: 400 }, 2048, 2048, 0.2);
    expect(rect).toEqual({ x: 60, y: 160, w: 280, h: 280 });
    expect(scale).toBeCloseTo(1024 / 280, 3);
    // At the frame's edge, and never enlarged more than 4 times or shrunk.
    expect(cropFor({ x0: 0, y0: 0, x1: 50, y1: 50 }, 100, 100, 0.2)).toEqual({ rect: { x: 0, y: 0, w: 60, h: 60 }, scale: 4 });
    expect(cropFor({ x0: 0, y0: 0, x1: 2000, y1: 2000 }, 2048, 2048, 0).scale).toBe(1);
  });

  it("cropFor: a narrow object gets transparent room at its sides, up to 1:2 (past the frame if needed)", () => {
    // A bottle 100 x 400 (with the margin 140 x 560): widened to 280, centred on it.
    const { rect, scale } = cropFor({ x0: 1000, y0: 500, x1: 1100, y1: 900 }, 2752, 1536, 0.2);
    expect(rect).toEqual({ x: 910, y: 420, w: 280, h: 560 });
    expect(scale).toBeCloseTo(Math.sqrt((1024 * 1024) / (280 * 560)), 3);
    // At the frame's left edge: the room goes past it.
    expect(cropFor({ x0: 0, y0: 0, x1: 50, y1: 300 }, 1000, 1000, 0).rect).toEqual({ x: -50, y: 0, w: 150, h: 300 });
    // A wide one gets height instead.
    expect(cropFor({ x0: 0, y0: 400, x1: 600, y1: 500 }, 1000, 1000, 0).rect).toEqual({ x: 0, y: 300, w: 600, h: 300 });
  });

  it("marks sent with a scene edit show until its result made layers", () => {
    const scene = { source: "input:s", before: "input:b", shadows: [], look: [], places: {}, reach: 12 };
    const d = { ...doc([layer("bg", "input:bg", true)]), scenes: [{ ...scene, marks: "m1" }, { ...scene, marks: "m2", made: {} }, scene] };
    expect(waitingMarks(d)).toEqual(["m1"]);
  });

  it("crop edits are not adopted as they are (they are pasted back first)", () => {
    const cup = { ...layer("cup", "input:cup"), feeds: [{ source: "input:crop", mask: "", rect: { x: 0, y: 0, w: 10, h: 10 }, scale: 2, from: "input:cup" }] };
    const d = doc([cup]);
    expect(reconcile(d, [{ source: "gen:c", from: "input:crop", mask: null }])).toBe(d);
  });
});

describe("where the lab is kept", () => {
  it("reads the project's copy, else the one this browser kept before", () => {
    const old = { v: 2, docs: [], made: ["gen:old"] };
    localStorage.setItem("kokon.layersLab.p", JSON.stringify(old));
    const kept = new Map<string, unknown>();
    keepLabsIn({ get: (id) => kept.get(id), set: (id, lab) => kept.set(id, lab) });
    try {
      expect(loadLab("p").made).toEqual(["gen:old"]);
      saveLab("p", { ...loadLab("p"), made: [...loadLab("p").made, "gen:new"] });
      expect((kept.get("p") as { made: string[] }).made).toEqual(["gen:old", "gen:new"]);
      expect(loadLab("p").made).toEqual(["gen:old", "gen:new"]);
      expect(labSources(loadLab("p")).has("gen:new")).toBe(true);
      // The browser's copy stays as it was (a backup).
      expect(JSON.parse(localStorage.getItem("kokon.layersLab.p")!).made).toEqual(["gen:old"]);
    } finally {
      keepLabsIn(null);
      localStorage.removeItem("kokon.layersLab.p");
    }
  });
});

describe("copiedShare", () => {
  const img = (px: number[][]) => px.flatMap((p) => [...p, 255]);
  const mask = img([[255, 255, 255], [255, 255, 255], [255, 255, 255], [0, 0, 0]]);
  it("finds the grey and the guide's red copied into the holes, not a real background", () => {
    expect(copiedShare(img([[128, 130, 126], [184, 78, 78], [30, 60, 160], [128, 128, 128]]), mask, 4)).toBeCloseTo(2 / 3);
    expect(copiedShare(img([[30, 60, 160], [40, 70, 170], [90, 50, 120], [128, 128, 128]]), mask, 4)).toBe(0);
  });
});

describe("expanded objects", () => {
  it("puts an Expand result around the crop, not squeezed into it", () => {
    // A 200x400 crop sent enlarged 2x (400x800), expanded 200 px right and 100 px at the bottom.
    const r = expandedRect({ x: 1000, y: 300, w: 200, h: 400 }, 400, 800, { left: 0, right: 200, top: 0, bottom: 100 });
    expect(r).toEqual({ x: 1000, y: 300, w: 300, h: 450 });
    const l = expandedRect({ x: 10, y: 20, w: 100, h: 100 }, 100, 100, { left: 50, right: 0, top: 25, bottom: 0 });
    expect(l).toEqual({ x: -40, y: -5, w: 150, h: 125 });
  });
  it("knows where a version lies", () => {
    const doc = { width: 800, height: 600, ext: { "input:b": { x: -40, y: 0, w: 900, h: 600 } } };
    expect(extOf(doc, "input:a")).toEqual({ x: 0, y: 0, w: 800, h: 600 });
    expect(extOf(doc, "input:b")).toEqual({ x: -40, y: 0, w: 900, h: 600 });
    expect(unionRect({ x: 0, y: 0, w: 800, h: 600 }, { x: 700, y: -50, w: 300, h: 100 })).toEqual({ x: 0, y: -50, w: 1000, h: 650 });
  });
});
