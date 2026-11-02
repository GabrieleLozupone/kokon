// Layers lab: the layer document a split makes (components/LayerDoc.tsx). Each layer is a version
// of the project ("gen:<id>" / "input:<id>") drawn over the whole frame, moved and scaled; editing a
// layer with Kokon makes a new version that the layer then follows. Kept with the project in
// kokon-service (store.ts, `keepLabsIn`), so every device and an update see it; labs made before
// that were in this browser's storage and move there when first read.

import type { MarkColour } from "./sceneEdit";

/** An edit of another image that also belongs to a layer: "Fill the holes" runs a brushed Remove
 * on the original photo with the background's holes as the painted area (an edit of the transparent
 * background keeps its holes transparent), and that result is the background's next version. */
export interface Feed {
  source: string;
  /** Input id of the painted area as set up (the user may paint it again in Paint area). */
  mask: string;
  /** An object-size crop of the layer (`rect` in the layer's own frame px, enlarged `scale` times
   * for the model): its edits are shrunk back into `rect` (pasteCrop), not adopted as they are. */
  rect?: Rect;
  scale?: number;
  /** The layer version the crop was cut from. */
  from?: string;
  /** Clean edges: input id of the grown selection (crop size) the result is clipped to, and how
   * much it was grown (crop px): faint pixels in that ring are dropped (the halo of what was around). */
  clip?: string;
  grow?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a version's image lies in the frame (frame px): the whole frame unless `doc.ext` says. */
export const extOf = (doc: { width: number; height: number; ext?: Record<string, Rect> }, source: string): Rect =>
  doc.ext?.[source] ?? { x: 0, y: 0, w: doc.width, h: doc.height };

export const unionRect = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** An Expand of an object's crop (`rect` in the frame, sent as a `refW`×`refH` image): where its
 * result lies in the frame. The result is the crop plus the expansion, given in the sent image's px
 * (GenerationRecord.outpaint), so it is wider or taller than the crop, never squeezed into it. */
export function expandedRect(rect: Rect, refW: number, refH: number, o: { left: number; right: number; top: number; bottom: number }): Rect {
  const kx = rect.w / refW;
  const ky = rect.h / refH;
  return { x: rect.x - o.left * kx, y: rect.y - o.top * ky, w: (refW + o.left + o.right) * kx, h: (refH + o.top + o.bottom) * ky };
}

/** Below about 1 MP Qwen-Image does worse (planner.rs INPAINT_MIN_AREA): a crop smaller than that is
 * enlarged for the model, at most 4 times, and its result shrunk back. */
export const CROP_AREA = 1024 * 1024;

/** A crop is never narrower than 1:2 (Qwen does worse on very narrow images: a bottle came back
 * 544x1720, 10-31). */
export const CROP_MAX_RATIO = 2;

/** The crop for an object: its content box grown by `margin` of its size each side (room for a part
 * the edit completes), inside the frame, in whole px; widened (or made taller) evenly to at most
 * CROP_MAX_RATIO, past the frame's edge if needed: the layer is transparent there, so the model gets
 * transparent room, not more scene. And how much to enlarge it for the model. */
export function cropFor(box: Box, W: number, H: number, margin: number): { rect: Rect; scale: number } {
  const mx = (box.x1 - box.x0) * margin;
  const my = (box.y1 - box.y0) * margin;
  let x = Math.max(0, Math.floor(box.x0 - mx));
  let y = Math.max(0, Math.floor(box.y0 - my));
  let w = Math.min(W, Math.ceil(box.x1 + mx)) - x;
  let h = Math.min(H, Math.ceil(box.y1 + my)) - y;
  if (h > w * CROP_MAX_RATIO) {
    const nw = Math.ceil(h / CROP_MAX_RATIO);
    x -= Math.floor((nw - w) / 2);
    w = nw;
  } else if (w > h * CROP_MAX_RATIO) {
    const nh = Math.ceil(w / CROP_MAX_RATIO);
    y -= Math.floor((nh - h) / 2);
    h = nh;
  }
  const scale = Math.min(4, Math.max(1, Math.sqrt(CROP_AREA / Math.max(1, w * h))));
  return { rect: { x, y, w, h }, scale };
}

/** An edit of `from` (painted area `mask`) belongs to the layer with feed `f`: any painted edit of an
 * image the lab made for it ("Background to fill"); on the photo itself (an older document's
 * Remove) only the area the lab painted, since the photo has edits of its own. */
const fed = (doc: LayerDoc, f: Feed, from: string | null | undefined, mask: string | null | undefined) =>
  f.source === from && (from !== doc.photo || f.mask === mask);

export interface DocLayer {
  id: string;
  name: string;
  /** The version shown. */
  source: string;
  /** Every version this layer has shown, oldest first (the Versions menu). */
  history: string[];
  hidden: boolean;
  /** The background: not moved, always at the bottom. */
  base: boolean;
  feeds?: Feed[];
  /** Shadows and light made by an edit (only the pixels it changed): not clicked on the canvas. */
  effect?: boolean;
  /** The one layer of Automatic shadows: the next one replaces it (its next version). */
  auto?: boolean;
  /** Automatic shadows as the model made them (`strength` is applied to this), and the strength. */
  made?: string;
  strength?: number;
  /** An object's shadow moves and scales with the object (`follows`), from where the object was
   * when the shadow was made (`at`). */
  follows?: string;
  at?: Place;
  /** Layers with the same group are selected, moved and scaled together. */
  group?: string;
  /** Offset in frame px, and scale around the centre of what the layer shows. */
  dx: number;
  dy: number;
  s: number;
}

export interface Place {
  dx: number;
  dy: number;
  s: number;
}

/** An older shadow edit (until 10-31; its result is still adopted when it comes): a brushed edit of
 * the flattened layers (`source`, made for it alone) with a ring around one object (`of`) or all of
 * them (null) as the painted area (`mask`, input id). Its results become an effect layer (`layer`
 * once made; new results are its next versions). Now SceneEdit. */
export interface Effect {
  source: string;
  mask: string;
  of: string | null;
  at?: Place;
  layer?: string;
}

/** A whole-image edit set up in the lab ("Shadows", "New objects", "Edit together"): the
 * flattened layers (`source`; with the coloured marks drawn on when there are marks, and `before`
 * without them) sent as a plain edit, so Qwen sees the whole scene. Its results are put back over
 * the layers and read (components/LabScene.ts): the shadows of the `shadows` objects, the new look
 * of the `look` objects, one new layer per mark colour (`wants`). */
export interface SceneEdit {
  source: string;
  before: string;
  /** Input id of the marks alone (colours on transparency, frame size). */
  marks?: string;
  wants?: { colour: MarkColour; what: string }[];
  shadows: string[];
  look: string[];
  /** Each visible object when the edit was made (it may move or change while the edit runs). */
  places: Record<string, Place & { source: string }>;
  /** How far shadows are looked for around an object, in % of the image's long side. */
  reach: number;
  /** One shadow layer for all the objects (Automatic shadows), not one per object. */
  one?: boolean;
  /** Layers its results made, so the next result becomes their next version: object id -> its
   * shadow layer, colour -> the new layer, "<colour>:shadow" -> the new layer's shadow. */
  made?: Record<string, string>;
}

export interface LayerDoc {
  /** The frame: the size of the photo that was split. */
  width: number;
  height: number;
  /** The photo that was split (older documents: unknown). */
  photo?: string;
  /** Top first; the background last. */
  layers: DocLayer[];
  pending?: Effect[];
  scenes?: SceneEdit[];
  /** Versions already looked at for "follow the edit" (adopted, or left by going back). */
  known: string[];
  /** Split with the stickers cleaned: LayerDoc cleans every object once, with a Qwen edit each
   * ("quality"; `true` from before 11-02) or the service's matte ("fast"). */
  autoClean?: boolean | "quality" | "fast";
  /** Those automatic Clean edges, one per object layer (shown while any is left). */
  stickers?: Sticker[];
  /** Versions whose image is not the whole frame (`extOf`): an Expand of an object took it past the
   * frame's edge, so its image covers this rect (frame px) and the part outside shows once moved in. */
  ext?: Record<string, Rect>;
}

/** An object's automatic Clean edges: its job once sent (null: not yet, or it could not be sent). */
export interface Sticker {
  layer: string;
  job: string | null;
  /** The layer's version the crop was made from: the sticker is in once the layer moved on. */
  from?: string;
  /** "fill": the background's holes filled (its painted area: `mask`), after the objects. */
  kind?: "fill";
  mask?: string;
  /** Sent again once already (the fill left grey patches). */
  retried?: boolean;
  /** The fill's result was looked at (no grey patches). */
  checked?: boolean;
  skipped?: boolean;
  failed?: boolean;
  /** A fast sticker, made here (no job): being made, or in. */
  local?: "making" | "done";
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const KEY = "kokon.layersLab.";

/** A project's lab: one layer document per image that was split (`photo`), and every version any
 * lab of the project has made (`made`: kept when a document is split again, so its old versions stay
 * out of the version strip). `swept`: older leftovers were looked for once (`leftovers`). */
export interface LabStore {
  v: 2;
  docs: LayerDoc[];
  made: string[];
  swept?: boolean;
}

/** A document's id: the image it was split from (older documents: the background's first version). */
export const docId = (d: LayerDoc) => d.photo ?? d.layers.find((l) => l.base)?.history[0] ?? d.layers[0]?.history[0] ?? "";

/** Every version a document has made or shown (not the photo it was split from). */
export function docSources(d: LayerDoc): Set<string> {
  const s = new Set([...d.known, ...d.layers.flatMap((l) => [...l.history, ...(l.feeds ?? []).map((f) => f.source)]), ...(d.pending ?? []).map((p) => p.source), ...(d.scenes ?? []).flatMap((e) => [e.source, e.before])]);
  if (d.photo) s.delete(d.photo);
  return s;
}

/** The document an image belongs to: the one split from it, or the one that made it. */
export function docFor(lab: LabStore, source: string | null | undefined): LayerDoc | null {
  if (!source) return null;
  return lab.docs.find((d) => d.photo === source) ?? lab.docs.find((d) => docSources(d).has(source)) ?? null;
}

/** A document added, or one split again (the same photo) replaced; `made` keeps the old versions. */
export function putDoc(lab: LabStore, d: LayerDoc): LabStore {
  const id = docId(d);
  const at = lab.docs.findIndex((x) => docId(x) === id);
  const docs = at < 0 ? [...lab.docs, d] : lab.docs.map((x, i) => (i === at ? d : x));
  return { ...lab, docs };
}

// Saves are announced, so the Stage follows the documents (useSyncExternalStore).
let version = 0;
const listeners = new Set<() => void>();
export function subscribeDocs(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}
export const docsVersion = () => version;

/** Where labs are kept (the project, see store.ts): `get` is undefined while the project has none. */
export interface LabKeeper {
  get(projectId: string): unknown;
  set(projectId: string, lab: LabStore): void;
}
let keeper: LabKeeper | null = null;
export function keepLabsIn(k: LabKeeper | null) {
  keeper = k;
}

/** The project's lab changed elsewhere (another device, or the service's copy arrived). */
export function labsChanged() {
  version++;
  for (const f of listeners) f();
}

function parseLab(data: unknown): LabStore | null {
  if (!data || typeof data !== "object") return null;
  // Before 10-31: one document per project, stored as it is.
  if ((data as LabStore).v !== 2) return { v: 2, docs: [data as LayerDoc], made: [] };
  return data as LabStore;
}

export function loadLab(projectId: string): LabStore {
  const kept = parseLab(keeper?.get(projectId));
  if (kept) return kept;
  // Kept in this browser's storage before (the copy stays there as a backup).
  try {
    const raw = localStorage.getItem(KEY + projectId);
    const old = raw ? parseLab(JSON.parse(raw)) : null;
    if (old) return old;
  } catch {
    /* unreadable: no lab */
  }
  return { v: 2, docs: [], made: [] };
}

/** Saves the lab; everything its documents have made joins `made` for good. */
export function saveLab(projectId: string, lab: LabStore) {
  const made = new Set(lab.made);
  for (const d of lab.docs) for (const s of docSources(d)) made.add(s);
  const next = { ...lab, made: [...made] };
  if (keeper) keeper.set(projectId, next);
  else {
    try {
      localStorage.setItem(KEY + projectId, JSON.stringify(next));
    } catch {
      /* storage full or blocked: the documents live until the page closes */
    }
  }
  labsChanged();
}

/** The project's images the lab made or uses (gallery steps to hide, requests to mark hidden). */
export function labSources(lab: LabStore): Set<string> {
  const out = new Set(lab.made);
  for (const d of lab.docs) for (const s of docSources(d)) out.add(s);
  return out;
}

export interface LabItem {
  key: string;
  source: string | null;
  from: string | null;
  mask?: string | null;
}

/** The project's versions that belong to a lab, so the project shows each layered image instead of
 * them: per document, the split's images, every version a layer has shown, the images its crops,
 * fills and shadows were made on, and everything made from those (edits not adopted yet too); and
 * anything an earlier lab of the project made (`made`). The photos that were split and their other
 * edits stay. Answer: version key -> the id of its document (null: an earlier lab's leftover). */
export function labItems(lab: LabStore, items: LabItem[]): Map<string, string | null> {
  const owner = new Map<string, string | null>();
  for (const d of lab.docs) for (const s of docSources(d)) owner.set(s, docId(d));
  for (const s of lab.made) if (!owner.has(s)) owner.set(s, null);
  const photos = new Set(lab.docs.map((d) => d.photo).filter(Boolean) as string[]);
  for (const p of photos) owner.delete(p);
  const keys = new Map<string, string | null>();
  for (const it of items) {
    let doc: string | null | undefined = it.source ? owner.get(it.source) : undefined;
    if (doc === undefined && it.from) {
      if (owner.has(it.from)) doc = owner.get(it.from)!;
      // From a photo itself: only a fill of an older document (a Remove on the photo).
      else if (photos.has(it.from)) {
        const d = lab.docs.find((x) => x.photo === it.from && x.layers.some((l) => l.feeds?.some((f) => !f.rect && fed(x, f, it.from, it.mask))));
        if (d) doc = docId(d);
      }
    }
    if (doc === undefined) continue;
    keys.set(it.key, doc);
    if (it.source) owner.set(it.source, doc);
  }
  return keys;
}

/** Leftovers of labs whose document is gone (a project split before documents were kept per image):
 * images the lab saved, by their names, and the cut-outs saved right after a "Background (holes)". */
export function leftovers(items: { source: string | null; name: string | null; input: boolean }[]): string[] {
  const named = /^(Background \(holes\)|Background to fill|Background on grey|Layers for shadows|Layers for the scene|Layers with marks|Shadows)\.png$|\((grey|object size|to clean|brushed|edited)\)\.png$| shadow\.png$/;
  const out: string[] = [];
  let afterSplit = false;
  for (const it of items) {
    if (!it.input || !it.source || !it.name) {
      afterSplit = false;
      continue;
    }
    if (it.name === "Background (holes).png") {
      out.push(it.source);
      afterSplit = true;
    } else if (named.test(it.name) || afterSplit) out.push(it.source);
    else afterSplit = false;
  }
  return out;
}

/** Layers follow their edits: a version made from a layer's version (and not seen before) becomes
 * the layer's version, then the same again from there (the newest edit wins at each step); so does
 * an edit that matches one of the layer's feeds. `items`: the project's versions in order, with the
 * version each was made from and the input id of its painted area. */
export function reconcile(doc: LayerDoc, items: { source: string; from: string | null; mask?: string | null }[]): LayerDoc {
  const known = new Set(doc.known);
  let changed = false;
  const layers = doc.layers.map((l) => {
    let cur = l.source;
    const history = l.history.slice();
    // Crop feeds are not adopted as they are: their results are pasted back first (LayersEditor).
    const mine = (i: (typeof items)[number]) => i.from === cur || !!l.feeds?.some((f) => !f.rect && fed(doc, f, i.from, i.mask));
    for (;;) {
      const next = [...items].reverse().find((i) => mine(i) && !known.has(i.source));
      if (!next) break;
      for (const i of items) if (mine(i)) known.add(i.source);
      cur = next.source;
      history.push(cur);
    }
    if (cur === l.source) return l;
    changed = true;
    return { ...l, source: cur, history };
  });
  return changed ? { ...doc, layers, known: [...known] } : doc;
}

/** Moves layer `from` to index `to`; the background stays last. */
export function reorder(doc: LayerDoc, from: number, to: number): LayerDoc {
  const ls = doc.layers.slice();
  const last = ls.length - 1;
  if (ls[from]?.base) return doc;
  to = Math.max(0, Math.min(to, ls[last]?.base ? last - 1 : last));
  if (from === to) return doc;
  const [l] = ls.splice(from, 1);
  ls.splice(to, 0, l);
  return { ...doc, layers: ls };
}

/** A layer and every other layer of its group. */
export const withGroup = (layers: DocLayer[], id: string): string[] => {
  const l = layers.find((x) => x.id === id);
  return l?.group ? layers.filter((x) => x.group === l.group).map((x) => x.id) : l ? [id] : [];
};

export const centre = (b: Box) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

/** How a layer is drawn: scaled by `s` around `c`, then moved by `dx`, `dy` (frame px). */
export interface Xf {
  c: { x: number; y: number };
  s: number;
  dx: number;
  dy: number;
}

/** A layer's own move and scale, around the centre of its content; a shadow that follows an
 * object takes the object's move and scale since the shadow was made, plus its own move (the user
 * nudging a shadow the model put a little off). `boxOf`: a version's content box (undefined while
 * it loads). */
export function xfOf(layers: DocLayer[], l: DocLayer, boxOf: (source: string) => Box | undefined, W: number, H: number): Xf {
  const mid = (b: Box | undefined) => (b ? centre(b) : { x: W / 2, y: H / 2 });
  const obj = l.follows ? layers.find((x) => x.id === l.follows) : undefined;
  if (obj && l.at) {
    const c = mid(boxOf(obj.source));
    return { c: { x: c.x + l.at.dx, y: c.y + l.at.dy }, s: obj.s / l.at.s, dx: obj.dx - l.at.dx + l.dx, dy: obj.dy - l.at.dy + l.dy };
  }
  return { c: mid(boxOf(l.source)), s: l.s, dx: l.dx, dy: l.dy };
}

export const mapPoint = (t: Xf, x: number, y: number) => ({ x: (x - t.c.x) * t.s + t.c.x + t.dx, y: (y - t.c.y) * t.s + t.c.y + t.dy });
export const unmapPoint = (t: Xf, x: number, y: number) => ({ x: (x - t.dx - t.c.x) / t.s + t.c.x, y: (y - t.dy - t.c.y) / t.s + t.c.y });

export function mapBox(b: Box, t: Xf): Box {
  const a = mapPoint(t, b.x0, b.y0);
  const z = mapPoint(t, b.x1, b.y1);
  return { x0: a.x, y0: a.y, x1: z.x, y1: z.y };
}

const ownXf = (l: DocLayer, b: Box): Xf => ({ c: centre(b), s: l.s, dx: l.dx, dy: l.dy });

/** A point of the frame -> the point of the layer's own image under it (`b`: its content box). */
export const toLayer = (l: DocLayer, b: Box, x: number, y: number) => unmapPoint(ownXf(l, b), x, y);

/** The layer's content box where it is drawn in the frame. */
export const placed = (l: DocLayer, b: Box): Box => mapBox(b, ownXf(l, b));

/** A shadow edit's result as a shadow (black, this alpha): per pixel how much darker the edit made
 * it (`after` luminance / `before` luminance), inside `area` (0-255 per pixel, the painted area).
 * Darkness, not the edit's own pixels, so the shadow darkens whatever is under it when its object
 * moves; brighter pixels are left out. `floor`: darkening ignored (decode noise, the colour match
 * at the seam). */
export function shadowAlpha(before: ArrayLike<number>, after: ArrayLike<number>, area: ArrayLike<number>, floor = 0.04): Uint8Array {
  const out = new Uint8Array(area.length);
  const lum = (d: ArrayLike<number>, j: number) => 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
  for (let i = 0; i < out.length; i++) {
    if (!area[i]) continue;
    const r = (lum(after, i * 4) + 1) / (lum(before, i * 4) + 1);
    const v = Math.min(1, Math.max(0, (1 - r - floor) / (1 - floor)));
    out[i] = Math.round(v * area[i]);
  }
  return out;
}

/** The pencil's marks sent with New objects / Edit together whose result has not come back yet
 * (input ids): shown over the layers, here and on the Stage, until the objects are there. */
export const waitingMarks = (doc: LayerDoc): string[] => (doc.scenes ?? []).filter((e) => e.marks && !e.made).map((e) => e.marks!);

/** The layer an edit is for, from its image and painted area (`mask`: input id): the layer's own
 * version, one of its fills, a whole-image edit ("scene"), an older ring shadow being made (the
 * object's id; "all objects": "shadows"). Null: not a lab edit. */
export function jobLayer(doc: LayerDoc, image: string | undefined, mask: string | null | undefined): string | null {
  if (!image) return null;
  const own = doc.layers.find((l) => l.source === image || l.feeds?.some((f) => fed(doc, f, image, mask)));
  if (own) return own.id;
  if (doc.scenes?.some((e) => e.source === image)) return "scene";
  const p = doc.pending?.find((x) => x.source === image);
  if (!p) return null;
  return p.layer ?? p.of ?? "shadows";
}

/** What a failed fill copies into the holes instead of a background: the flat grey they were sent
 * as, or the guide's marking (the highlight colour half over that grey, or the colour itself;
 * pipeline.rs highlight, imaging.rs HIGHLIGHTS). Seen 11-01: one try kept the grey, the next the red. */
const COPIED = [
  [128, 128, 128],
  ...[
    [255, 0, 0],
    [0, 230, 0],
    [0, 80, 255],
    [255, 0, 255],
  ].flatMap((c) => [c, c.map((v) => (v + 128) >> 1)]),
];

/** The share of the painted area (`mask` > 127, RGBA both, `n` pixels) whose colour is one a failed
 * fill copies (each channel within 28 levels of it). */
export function copiedShare(rgba: ArrayLike<number>, mask: ArrayLike<number>, n: number): number {
  let inside = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i * 4] < 128) continue;
    inside++;
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    if (COPIED.some((c) => Math.abs(r - c[0]) <= 28 && Math.abs(g - c[1]) <= 28 && Math.abs(b - c[2]) <= 28)) bad++;
  }
  return inside ? bad / inside : 0;
}
