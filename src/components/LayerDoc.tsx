// Layers lab, step 2: the layers a split made, over each other like in an image editor, only
// simpler. Right bar: the layers top first (thumbnail, name, eye, drag to reorder) and what to do
// with the selected one: go back to an older version, reset its place, delete it. The selected layer
// is the image the prompt below edits: the result shows on the layer, here (the background: "Fill
// the holes" sets up a brushed Remove on the photo). On the canvas: click a layer to select it, drag
// to move it, drag the corner to scale it; Shift/Ctrl+click selects more (moved and scaled
// together), Group keeps them together. "Blend into scene" (lib/blend.ts, BlendChoice) has the AI
// read where each object stands, then a brushed edit round its base adds its shadow, reflection,
// grass at its feet, read back as layers that follow it. Whole-image edits (LabScene.ts) give Qwen
// the flattened layers: "New objects" adds what the user drew with the coloured pencil as new
// layers, "Edit together" gives the selected objects the edit's look. "Save as image" flattens the layers into a new version; "Export PSD" saves them for Photoshop (lib/psd.ts).

import { Brush, Eraser, Eye, EyeOff, FileDown, GripVertical, Group, Hand, History, ImageDown, Link2, Loader2, Lock, MousePointer2, Paintbrush, Pencil, Redo2, RotateCcw, Scissors, Sparkles, Sun, Trash2, Undo2, Ungroup, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { focusPixels, foreground, keptShare, MIN_KEPT, modelMatte, stickerAlpha } from "../lib/matte";
import { blendPrompt, DEFAULT_READING } from "../lib/blend";
import { dilate, erode, fileSafe } from "../lib/layers";
import { centre, copiedShare, CROP_MAX_RATIO, cropFor, docId, extOf, unionRect, type Rect, waitingMarks, shadowAlpha, strengthPixels, mapBox, reorder, unmapPoint, withGroup, xfOf, type Box, type DocLayer, type Effect, type Feed, type LayerDoc, type SceneEdit, type Sticker, type Xf } from "../lib/layerDoc";
import { buildRequest, refFromInput } from "../lib/logic";
import { native } from "../lib/native";
import { aiMarkingXmp, writePsd } from "../lib/psd";
import { MARK_COLOURS, marksPrompt, type MarkColour } from "../lib/sceneEdit";
import { placesOf } from "./LabScene";
import { shortcut } from "../lib/platform";
import { addResult, addVersions, cancelJob, editSource, focusPrompt, getState, itemOrigin, itemSource, setState, submitRequest, toastError, toastInfo, updateComposer, useStore, type SessionItem } from "../lib/store";
import type { InputRecord, JobView, SceneReading } from "../lib/types";
import { BlendChoice, type BlendRow } from "./BlendChoice";
import { useJobPercent } from "./jobMotion";
import { JobPct, LabJobs, useLab, useLabJobs } from "./LabStage";
import { IconButton } from "./ui";
import { isTyping } from "./Viewer";
import { ZoomPan } from "./ZoomPan";

/** Clean edges' prompt, on the object in its scene (cropOf "clean"). No "sticker" and no "no outline"
 * (11-01): a sticker has a border, and "no outline" took off a lettering's own outline; with the scene
 * in view this kept only the bats / the lettering, clean (bench/20261101-stickers-fill). */
const stickerPrompt = (name: string) =>
  `Keep only the ${name.toLowerCase()}, exactly as it is with its own colours and details, in the same place and size. Remove the background and everything else around it, with no rim of background colour left along its edges, and empty any gap inside it (like the hole of a handle). Make the background fully transparent.`;

/** Fill the holes' prompt, inside Kokon's Add wrapper (pipeline.rs inpaint_prompt). Naming what must not
 * be there took the grey off on the seed that had kept it, and the contact shadows (11-01 bench). */
const FILL_PROMPT =
  "the empty background that continues the surrounding scene, with the same surfaces, textures, lighting and perspective; no objects, people, text or leftover pieces in it, and no shadows or reflections of the things that were there";

/** The progress of an object's sticker: a ring filling up, the percentage inside. */
function StickerRing({ job, item }: { job: JobView; item: SessionItem }) {
  const { pct } = useJobPercent(job, item.request);
  const r = 22;
  const len = 2 * Math.PI * r;
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" className="sticker-progress" aria-label={`${Math.floor(pct)} percent`}>
      <circle cx="28" cy="28" r={r} className="track" />
      <circle cx="28" cy="28" r={r} className="bar" strokeDasharray={len} strokeDashoffset={len * (1 - pct / 100)} transform="rotate(-90 28 28)" />
      <text x="28" y="32" textAnchor="middle">
        {Math.floor(pct)}%
      </text>
    </svg>
  );
}

/** Where the blend's edit is: "Blending into the scene · 38%". */
function ShadowPhase({ job, item }: { job: JobView; item: SessionItem }) {
  const { pct } = useJobPercent(job, item.request);
  if (job.status === "queued") return <>Waiting for the edits before it</>;
  if (job.status === "starting_backend") return <>Starting the engine</>;
  if (job.status === "done") return <>Reading what the AI added</>;
  return <>Blending into the scene · {Math.floor(pct)}%</>;
}

/** What the canvas needs of a layer's version: its alpha (for clicks), where its content is, a thumbnail. */
export interface SourceInfo {
  img: HTMLImageElement;
  alpha: Uint8Array;
  aw: number;
  ah: number;
  /** In frame px. */
  box: Box;
  thumb: string;
  /** Where the image lies in the frame (frame px; past the edge for an expanded object). */
  ext: Rect;
}

/** Versions whose image is not the whole frame (`LayerDoc.ext`), noted from every document shown:
 * ids are unique, so `sourceInfo` finds them without the document. */
const extents = new Map<string, Rect>();
export function noteExtents(doc: { ext?: Record<string, Rect> }) {
  for (const [k, r] of Object.entries(doc.ext ?? {})) extents.set(k, r);
}

/** A layer's version drawn where it lies in the frame (on a context set up in frame px). */
export function drawSource(ctx: CanvasRenderingContext2D, info: SourceInfo) {
  ctx.drawImage(info.img, info.ext.x, info.ext.y, info.ext.w, info.ext.h);
}

const ALPHA_SIDE = 512;
export const toPng = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"));
const cache = new Map<string, Promise<SourceInfo>>();

export function sourceInfo(src: string, W: number, H: number): Promise<SourceInfo> {
  const ext = extents.get(src) ?? { x: 0, y: 0, w: W, h: H };
  const key = `${src}@${W}x${H}@${ext.x},${ext.y},${ext.w},${ext.h}`;
  let p = cache.get(key);
  if (!p) {
    p = new Promise<HTMLImageElement>((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("A layer's image could not be loaded."));
      img.src = urls.source(src);
    }).then((img) => {
      // The alpha map covers the image's own rect (the frame, or more for an expanded object).
      const k = Math.min(1, ALPHA_SIDE / Math.max(ext.w, ext.h));
      const aw = Math.max(1, Math.round(ext.w * k));
      const ah = Math.max(1, Math.round(ext.h * k));
      const c = document.createElement("canvas");
      c.width = aw;
      c.height = ah;
      const ctx = c.getContext("2d")!;
      // Every version is drawn over the whole frame (an edit may come back at another size).
      ctx.drawImage(img, 0, 0, aw, ah);
      const px = ctx.getImageData(0, 0, aw, ah).data;
      const alpha = new Uint8Array(aw * ah);
      let x0 = aw;
      let y0 = ah;
      let x1 = -1;
      let y1 = -1;
      for (let i = 0; i < alpha.length; i++) {
        const a = (alpha[i] = px[i * 4 + 3]);
        if (a <= 16) continue;
        const x = i % aw;
        const y = (i / aw) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const box =
        x1 < 0
          ? { x0: 0, y0: 0, x1: W, y1: H }
          : { x0: ext.x + (x0 / aw) * ext.w, y0: ext.y + (y0 / ah) * ext.h, x1: ext.x + ((x1 + 1) / aw) * ext.w, y1: ext.y + ((y1 + 1) / ah) * ext.h };
      const t = document.createElement("canvas");
      const tk = 64 / Math.max(W, H);
      t.width = Math.max(1, Math.round(W * tk));
      t.height = Math.max(1, Math.round(H * tk));
      t.getContext("2d")!.drawImage(img, ext.x * tk, ext.y * tk, ext.w * tk, ext.h * tk);
      return { img, alpha, aw, ah, box, thumb: t.toDataURL("image/png"), ext };
    });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("An image could not be loaded."));
    img.src = src;
  });
}

/** `img` drawn over a `W`×`H` frame, as RGBA. */
export function pixels(img: CanvasImageSource, W: number, H: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, W, H);
  return ctx.getImageData(0, 0, W, H).data;
}

/** The document's visible layers drawn into one image, at most `maxSide` px (the project's Stage
 * and version strip show it). Layers whose version cannot be loaded are left out. */
export async function renderDoc(doc: LayerDoc, maxSide: number): Promise<HTMLCanvasElement> {
  const W = doc.width;
  const H = doc.height;
  noteExtents(doc);
  const infos = new Map<string, SourceInfo>();
  await Promise.all(doc.layers.map((l) => sourceInfo(l.source, W, H).then((i) => infos.set(l.source, i), () => {})));
  const k = Math.min(1, maxSide / Math.max(W, H));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(W * k));
  c.height = Math.max(1, Math.round(H * k));
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(c.width / W, c.height / H);
  for (const l of [...doc.layers].reverse()) {
    const info = infos.get(l.source);
    if (l.hidden || !info) continue;
    const t = xfOf(doc.layers, l, (src) => infos.get(src)?.box, W, H);
    ctx.save();
    ctx.translate(t.c.x + t.dx, t.c.y + t.dy);
    ctx.scale(t.s, t.s);
    ctx.translate(-t.c.x, -t.c.y);
    drawSource(ctx, info);
    ctx.restore();
  }
  return c;
}

/** A shadow edit's result -> the shadow layer's image: black, as opaque as the edit darkened the
 * flattened layers it was made from, inside the painted ring (lib/layerDoc.ts shadowAlpha). */
export async function shadowImage(p: Effect, result: string, W: number, H: number, name: string): Promise<InputRecord> {
  const [before, after, mask] = await Promise.all([loadImage(urls.source(p.source)), loadImage(urls.source(result)), loadImage(urls.input(p.mask))]);
  const a = pixels(before, W, H);
  const b = pixels(after, W, H);
  const m = pixels(mask, W, H);
  const area = new Uint8Array(W * H);
  for (let i = 0; i < area.length; i++) area[i] = m[i * 4];
  const alpha = shadowAlpha(a, b, area);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const out = ctx.createImageData(W, H);
  for (let i = 0; i < alpha.length; i++) out.data[i * 4 + 3] = alpha[i];
  ctx.putImageData(out, 0, 0);
  return api.upload(await toPng(c), `${name}.png`);
}


/** The painted area (a mask PNG: white = the edit) as a pink tint with a white outline, readable
 * on any picture (the Stage's difference blend is hard to see on dark, warm photos). */
export function useMaskTint(src: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!src) return;
    let gone = false;
    let made: string | null = null;
    loadImage(src)
      .then((img) => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const m = pixels(img, w, h);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        const out = ctx.createImageData(w, h);
        const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[(y * w + x) * 4] >= 128;
        // The outline about 2 px wide at the mask's size (up to 2048), so it shows at fit.
        const r = Math.max(1, Math.round(Math.max(w, h) / 1000));
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const v = m[i];
            const inside = v >= 128;
            const edge = inside && (!on(x - r, y) || !on(x + r, y) || !on(x, y - r) || !on(x, y + r));
            if (edge) out.data.set([255, 255, 255, 255], i);
            else if (v) out.data.set([255, 59, 107, Math.round(v * 0.5)], i);
          }
        ctx.putImageData(out, 0, 0);
        return toPng(c);
      })
      .then((b) => {
        if (gone) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);
  return url;
}

/** A crop edit's result -> the layer's next image: shrunk back into the crop's place in the frame
 * (the rest transparent: the crop holds the whole object), clipped to the grown selection for
 * Clean edges (so the edit cannot bring a neighbour back). An Expand of the crop (`grown`: where its
 * result lies, expandedRect) is put there at the same scale, not squeezed into the crop. The image
 * covers the frame, or more when the object reaches past its edge (`ext`, for LayerDoc.ext). */
export async function pasteCrop(f: Feed, result: string, W: number, H: number, name: string, grown?: Rect): Promise<{ rec: InputRecord; ext?: Rect }> {
  const r = grown ?? f.rect!;
  let img: CanvasImageSource = await loadImage(urls.source(result));
  const frame = { x: 0, y: 0, w: W, h: H };
  const u = unionRect(frame, r);
  const out = { x: Math.floor(u.x), y: Math.floor(u.y), w: Math.ceil(u.x + u.w) - Math.floor(u.x), h: Math.ceil(u.y + u.h) - Math.floor(u.y) };
  const past = out.x < 0 || out.y < 0 || out.w > W || out.h > H;
  const c = document.createElement("canvas");
  c.width = out.w;
  c.height = out.h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(-out.x, -out.y);
  // The clip is the crop's own selection: an expanded result reaches past it on purpose.
  if (f.clip && !grown) {
    const m = await loadImage(urls.input(f.clip));
    const mw = m.naturalWidth;
    const mh = m.naturalHeight;
    const mc = document.createElement("canvas");
    mc.width = mw;
    mc.height = mh;
    const mctx = mc.getContext("2d")!;
    mctx.drawImage(m, 0, 0);
    const d = mctx.getImageData(0, 0, mw, mh);
    for (let i = 0; i < d.data.length; i += 4) d.data[i + 3] = d.data[i];
    mctx.putImageData(d, 0, 0);
    // In the ring the selection was grown by, faint pixels are the halo of what was around the
    // object (Qwen leaves it half transparent): dropped. Inside the selection everything stays
    // (a glass is see-through on purpose).
    if (f.grow) {
      const rc = document.createElement("canvas");
      rc.width = mw;
      rc.height = mh;
      const rctx = rc.getContext("2d")!;
      rctx.drawImage(img, 0, 0, mw, mh);
      const px = rctx.getImageData(0, 0, mw, mh);
      const sel = new Uint8Array(mw * mh);
      for (let i = 0; i < sel.length; i++) sel[i] = d.data[i * 4] > 128 ? 255 : 0;
      const inner = erode(sel, mw, mh, f.grow);
      for (let i = 0; i < sel.length; i++) if (sel[i] && !inner[i] && px.data[i * 4 + 3] < 160) px.data[i * 4 + 3] = 0;
      rctx.putImageData(px, 0, 0);
      img = rc;
    }
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mc, r.x, r.y, r.w, r.h);
  } else ctx.drawImage(img, r.x, r.y, r.w, r.h);
  const rec = await api.upload(await toPng(c), `${name} (${grown ? "expanded" : "edited"}).png`);
  return past ? { rec, ext: out } : { rec };
}

/** One dab of the layer brushes, in the layer's own pixels: the eraser clears (solid core, soft
 * rim); the shadow brush adds a little darkness each dab, so strokes build up softly. */
function dab(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, mode: "erase" | "shade") {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  if (mode === "erase") {
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(0.6, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
  } else {
    g.addColorStop(0, "rgba(0,0,0,0.06)");
    g.addColorStop(1, "rgba(0,0,0,0)");
  }
  ctx.globalCompositeOperation = mode === "erase" ? "destination-out" : "source-over";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

/** How far a whole-image shadow edit's result is read around each object (% of the long side). */
const SCENE_REACH = 12;
/** The selected layers per document (the last one is the one the panel shows), kept while the
 * view closes (Paint area, Expand, the Stage). */
const lastSelected = new Map<string, string[]>();

/** The pencil's marks per document, and what each colour asks for (kept while the view closes). */
interface Mark {
  colour: MarkColour;
  /** Line width in frame px. */
  r: number;
  pts: { x: number; y: number }[];
}
const lastMarks = new Map<string, { marks: Mark[]; wants: Partial<Record<MarkColour, string>> }>();

/** A pencil mark: an opaque line in its colour (LabScene tells the colours apart by nearest colour). */
function drawMark(ctx: CanvasRenderingContext2D, m: Mark, from = 0) {
  const css = MARK_COLOURS.find((c) => c.name === m.colour)!.css;
  ctx.strokeStyle = css;
  ctx.fillStyle = css;
  ctx.lineWidth = m.r * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (m.pts.length - from === 1) {
    ctx.beginPath();
    ctx.arc(m.pts[from].x, m.pts[from].y, m.r, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(m.pts[from].x, m.pts[from].y);
  for (let i = from + 1; i < m.pts.length; i++) ctx.lineTo(m.pts[i].x, m.pts[i].y);
  ctx.stroke();
}

type Drag = { mode: "move" | "scale"; ids: string[]; x0: number; y0: number; l0: Record<string, DocLayer>; c: { x: number; y: number } };

export function LayerDoc({ projectId, doc, onChange, onNewSplit }: { projectId: string; doc: LayerDoc; onChange: (d: LayerDoc) => void; onNewSplit: () => void }) {
  const W = doc.width;
  const H = doc.height;
  const key = `${projectId}|${docId(doc)}`;
  const [live, setLive] = useState(doc);
  const [sels, setSelsState] = useState<string[]>(() => (lastSelected.get(key) ?? []).filter((id) => doc.layers.some((l) => l.id === id)));
  const setSels = (ids: string[]) => {
    lastSelected.set(key, ids);
    setSelsState(ids);
  };
  /** The layer the panel shows and the prompt edits (the last one clicked). */
  const selected: string | null = sels[sels.length - 1] ?? null;
  /** Selects a layer with its group (it last, so the panel shows it). */
  const setSelected = (id: string | null) => setSels(id ? [...withGroup(live.layers, id).filter((x) => x !== id), id] : []);
  const multi = sels.length > 1;
  const [infos, setInfos] = useState<Record<string, SourceInfo>>({});
  const [tool, setTool] = useState<"move" | "pan" | "erase" | "shade" | "sketch" | "area">("move");
  const [markColour, setMarkColour] = useState<MarkColour>("red");
  const [sketch, setSketchState] = useState(() => lastMarks.get(key) ?? { marks: [], wants: {} });
  const setSketch = (v: typeof sketch) => {
    lastMarks.set(key, v);
    setSketchState(v);
  };
  const marksRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Mark | null>(null);
  // Layer brushes: size in screen px, the pointer's place in frame px.
  // The pencil has its own size: marks only need to be seen (thick marks hide the scene).
  const [brushSize, setBrushSize] = useState(40);
  const [pencilSize, setPencilSize] = useState(12);
  const brush = tool === "sketch" ? pencilSize : brushSize;
  const setBrush = (f: (b: number) => number) => (tool === "sketch" ? setPencilSize : setBrushSize)(f);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const paintRef = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<{ x: number; y: number } | null>(null);
  const zoomK = useRef(1);
  const [spacePressed, setSpacePressed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rowDrag, setRowDrag] = useState<{ from: number; over: number } | null>(null);
  // The layer being renamed (double-click), so a click on a row leaves the arrows to nudging.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  useEffect(() => setVersionsOpen(false), [selected]);
  const undoStack = useRef<LayerDoc[]>([]);
  const redoStack = useRef<LayerDoc[]>([]);
  const drag = useRef<Drag | null>(null);
  const hitRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<(HTMLDivElement | null)[]>([]);
  const lab = useLab();
  const labJobs = useLabJobs(lab).filter((j) => docId(j.doc) === docId(doc));
  // The area painted for the next edit, shown where it applies: on a layer's own image (moved with
  // it), or on the whole frame (a fill, a shadow edit: images the lab made at the frame's size).
  const mask = useStore((s) => s.composer.mask);
  const target = useStore((s) => s.composer.refs[0]);
  const composing = useStore((s) => s.composer.create);
  const paintedSource = mask && target && mask.refKey === target.key && !composing ? target.source : null;
  const paintedLayer = paintedSource ? doc.layers.find((l) => l.source === paintedSource) : undefined;
  const paintedCrop = paintedSource ? doc.layers.flatMap((l) => (l.feeds ?? []).filter((f) => f.rect && f.source === paintedSource).map((f) => ({ l, f })))[0] : undefined;
  const paintedFrame = !!paintedSource && !paintedLayer && !paintedCrop && (doc.layers.some((l) => l.feeds?.some((f) => f.source === paintedSource)) || !!doc.pending?.some((p) => p.source === paintedSource));
  const maskTint = useMaskTint(mask && (paintedLayer || paintedFrame || paintedCrop) ? urls.input(mask.inputId) : null);
  /** The edit being made for a row: its own, or (the background's row) a new "all objects" shadow. */
  const rowJob = (l: DocLayer) => labJobs.find((j) => j.job.status !== "failed" && (j.layer === l.id || (l.base && j.layer === "shadows")));

  useEffect(() => setLive(doc), [doc]);

  useEffect(() => {
    let gone = false;
    noteExtents(doc);
    for (const l of doc.layers) {
      if (infos[l.source]) continue;
      sourceInfo(l.source, W, H).then(
        (info) => !gone && setInfos((m) => ({ ...m, [l.source]: info })),
        (e) => !gone && toastError(e),
      );
    }
    return () => {
      gone = true;
    };
  }, [doc.layers, W, H, infos]);

  const panning = spacePressed || tool === "pan";
  const sel = live.layers.find((l) => l.id === selected) ?? null;
  // A brush works on the selected layer: the eraser on any object or shadow, the shadow brush on
  // shadow layers. Otherwise the pointer selects and moves.
  const brushOn = (tool === "erase" || tool === "shade") && !panning && !!sel && !sel.base && !sel.hidden && (tool === "erase" || !!sel.effect);
  // The painted area of the next edit (pink), brushed here: left adds, right (or Alt) takes out.
  const areaOn = tool === "area" && !panning && !!maskTint;
  const liveRef = useRef(live);
  liveRef.current = live;
  const xf = (l: DocLayer, d: LayerDoc = live): Xf => xfOf(d.layers, l, (src) => infos[src]?.box, W, H);

  // The painted area at its own size (the image it applies to: the frame, a layer, or a layer's
  // crop), changed by the Area brush and sent back to the prompt as a new mask when a stroke ends.
  const areaCanvas = useRef<HTMLCanvasElement | null>(null);
  const areaPreview = useRef<HTMLCanvasElement>(null);
  const areaStroke = useRef<{ erase: boolean; last: { x: number; y: number } } | null>(null);
  const areaUndo = useRef<string[]>([]);
  const areaRedo = useRef<string[]>([]);
  const maskId = maskTint ? mask?.inputId : undefined;
  useEffect(() => {
    areaCanvas.current = null;
    if (!maskId) return;
    let gone = false;
    loadImage(urls.input(maskId))
      .then((img) => {
        if (gone) return;
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        // On black: a mask with any transparency is read by its alpha (see prepareFill).
        const cx = c.getContext("2d")!;
        cx.fillStyle = "#000";
        cx.fillRect(0, 0, c.width, c.height);
        cx.drawImage(img, 0, 0);
        areaCanvas.current = c;
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [maskId]);
  // The stroke's preview goes once the new pink is drawn.
  useEffect(() => {
    const c = areaPreview.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [maskTint]);
  // A painted area opens on the Area brush (the area is what changes next).
  useEffect(() => {
    setTool((t) => (maskId && t === "move" ? "area" : !maskId && t === "area" ? "move" : t));
  }, [maskId]);

  /** A frame point in the area's px, and its px per frame px. */
  const toArea = (p: { x: number; y: number }) => {
    const c = areaCanvas.current;
    if (!c) return null;
    if (paintedCrop) {
      const t = xf(paintedCrop.l);
      const q = unmapPoint(t, p.x, p.y);
      const r = paintedCrop.f.rect!;
      const k = c.width / r.w;
      return { x: (q.x - r.x) * k, y: (q.y - r.y) * k, k: k / t.s };
    }
    const k = c.width / W;
    if (paintedLayer) {
      const t = xf(paintedLayer);
      const q = unmapPoint(t, p.x, p.y);
      return { x: q.x * k, y: q.y * k, k: k / t.s };
    }
    return { x: p.x * k, y: p.y * k, k };
  };

  const areaTo = (p: { x: number; y: number }) => {
    const st = areaStroke.current;
    const c = areaCanvas.current;
    if (!st || !c) return;
    const r = brush / 2 / zoomK.current;
    const a = toArea(st.last);
    const b = toArea(p);
    const line = (ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, w: number, colour: string) => {
      ctx.strokeStyle = ctx.fillStyle = colour;
      ctx.lineWidth = w;
      ctx.lineCap = ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    };
    if (a && b) line(c.getContext("2d")!, a.x, a.y, b.x, b.y, 2 * r * b.k, st.erase ? "#000" : "#fff");
    const pv = areaPreview.current?.getContext("2d");
    if (pv) line(pv, st.last.x, st.last.y, p.x, p.y, 2 * r, st.erase ? "rgba(20, 20, 20, 0.55)" : "rgba(255, 59, 107, 0.5)");
    st.last = p;
  };

  const setArea = (inputId: string) => {
    const m = getState().composer.mask;
    if (m) updateComposer({ mask: { ...m, inputId } });
  };
  const endArea = async () => {
    const c = areaCanvas.current;
    areaStroke.current = null;
    if (!c || !mask) return;
    try {
      const rec = await api.upload(await toPng(c), "mask.png");
      areaUndo.current.push(mask.inputId);
      areaRedo.current = [];
      setArea(rec.id);
    } catch (e) {
      toastError(e);
    }
  };
  /** Undo / Redo of the Area brush (its own steps, while it is the tool). */
  const areaStep = (back: boolean) => {
    const from = back ? areaUndo.current : areaRedo.current;
    const id = from.pop();
    if (!id || !mask) return false;
    (back ? areaRedo.current : areaUndo.current).push(mask.inputId);
    setArea(id);
    return true;
  };

  /** An object-size crop of a layer for the model (cropFor): "edit" = the layer as it is with room
   * around it (every prompt on an object layer); "clean" = the object with its selection grown ~3 px,
   * filled from the photo there, so Qwen sees the real border and redraws it (Clean edges). Reused
   * while the layer's version is the same. */
  const cropOf = async (l: DocLayer, kind: "edit" | "clean"): Promise<Feed> => {
    // An older crop of this version is reused, unless it is narrower than crops are now.
    const have = l.feeds?.find((f) => f.rect && f.from === l.source && !f.clip && Math.max(f.rect.w / f.rect.h, f.rect.h / f.rect.w) <= CROP_MAX_RATIO + 0.01);
    if (kind === "edit" && have) return have;
    const info = await sourceInfo(l.source, W, H);
    const { rect, scale } = cropFor(info.box, W, H, kind === "edit" ? 0.2 : 0.08);
    const cw = Math.max(1, Math.round(rect.w * scale));
    const ch = Math.max(1, Math.round(rect.h * scale));
    // The image over the whole frame, moved and enlarged so the crop fills the canvas (the crop may
    // reach past the frame: transparent there).
    const draw = (img: HTMLImageElement, ctx: CanvasRenderingContext2D, at: Rect = { x: 0, y: 0, w: W, h: H }) => {
      ctx.save();
      ctx.imageSmoothingQuality = "high";
      ctx.setTransform(cw / rect.w, 0, 0, ch / rect.h, (-rect.x * cw) / rect.w, (-rect.y * ch) / rect.h);
      ctx.drawImage(img, at.x, at.y, at.w, at.h);
      ctx.restore();
    };
    const c = document.createElement("canvas");
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext("2d")!;
    let clip: string | undefined;
    // ~3 px of the frame around the selection (in the enlarged crop: 3 x scale).
    const g = Math.max(2, Math.round(3 * scale));
    if (kind === "clean") {
      const lc = document.createElement("canvas");
      lc.width = cw;
      lc.height = ch;
      const lctx = lc.getContext("2d")!;
      draw(info.img, lctx, info.ext);
      const px = lctx.getImageData(0, 0, cw, ch).data;
      const sel0 = new Uint8Array(cw * ch);
      for (let i = 0; i < sel0.length; i++) sel0[i] = px[i * 4 + 3] > 16 ? 255 : 0;
      const grown = dilate(sel0, cw, ch, g);
      const gc = document.createElement("canvas");
      gc.width = cw;
      gc.height = ch;
      const gctx = gc.getContext("2d")!;
      const ga = gctx.createImageData(cw, ch);
      for (let i = 0; i < grown.length; i++) {
        ga.data[i * 4] = ga.data[i * 4 + 1] = ga.data[i * 4 + 2] = 255;
        ga.data[i * 4 + 3] = grown[i];
      }
      gctx.putImageData(ga, 0, 0);
      // The whole photo around the object (when known), the layer over it. On transparency with a
      // rim of photo, Qwen took the object for a sticker with a coloured border and kept the rim (bats,
      // lettering, 11-01); seeing the scene, it knows what is background (the paste-back is clipped).
      const photo = live.photo ? await loadImage(urls.source(live.photo)).catch(() => null) : null;
      if (photo) draw(photo, ctx);
      ctx.drawImage(lc, 0, 0);
      // The clip for the paste-back: the grown selection, white on black.
      const mk = document.createElement("canvas");
      mk.width = cw;
      mk.height = ch;
      const mkx = mk.getContext("2d")!;
      mkx.fillStyle = "#000";
      mkx.fillRect(0, 0, cw, ch);
      mkx.drawImage(gc, 0, 0);
      clip = (await api.upload(await toPng(mk), "clip.png")).id;
    } else draw(info.img, ctx, info.ext);
    const rec = await api.upload(await toPng(c), `${fileSafe(l.name)} (${kind === "edit" ? "object size" : "to clean"}).png`);
    addVersions([rec], 0);
    const f: Feed = { source: `input:${rec.id}`, mask: "", rect, scale, from: l.source, ...(clip ? { clip, grow: g } : {}) };
    const d = liveRef.current;
    commitRef.current({ ...d, layers: d.layers.map((x) => (x.id === l.id ? { ...x, feeds: [...(x.feeds ?? []), f] } : x)) });
    return f;
  };

  // Selecting a layer (or a new version of it) makes it the image the prompt edits; its result comes
  // back to the layer. An object layer is edited at its own size (an enlarged crop, cropOf), the
  // background and shadows on the whole frame. Not when the view opens: the prompt keeps what it was
  // set up for (a fill whose area was just painted again in Paint area).
  // Several layers selected: the prompt stays as it is (Edit together sets it up for them).
  const shownSel = useRef(`${selected}|${sel?.source}|${multi}`);
  const selNow = useRef<string | null>(selected);
  selNow.current = multi ? null : selected;
  useEffect(() => {
    const k = `${selected}|${sel?.source}|${multi}`;
    if (k === shownSel.current) return;
    shownSel.current = k;
    if (!sel || multi) return;
    if (sel.base || sel.effect) {
      editSource(sel.source, false);
      return;
    }
    const id = sel.id;
    cropOf(sel, "edit").then(
      (f) => selNow.current === id && editSource(f.source, false),
      (e) => toastError(e),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sel?.source, multi]);

  /** Clean edges: the object with a little of what is around it, and a prompt to keep only the
   * object, ready in the prompt box (the result is clipped to the grown selection when it comes back). */
  const cleanEdges = async (l: DocLayer) => {
    setBusy(true);
    try {
      const f = await cropOf(l, "clean");
      if (!editSource(f.source, false)) throw new Error("The object could not be opened.");
      updateComposer({ mask: null, outpaint: null, prompt: stickerPrompt(l.name) });
      focusPrompt(true);
      toastInfo("The object is ready to clean at its own size: check the prompt, then Generate. The result replaces the layer, inside its outline.");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** A fast sticker, as the layer's next version: the object over the photo around it, matted by the
   * service (lib/matte.ts: the selection decides what, the matte only the edge; edge colours freed of
   * the background). Deterministic, a few seconds; Clean edges is the AI redraw. */
  const fastSticker = async (l: DocLayer) => {
    const e = extOf(liveRef.current, l.source);
    if (e.x < 0 || e.y < 0 || e.w > W || e.h > H) throw new Error(`${l.name} reaches past the photo: use Clean edges.`);
    const info = await sourceInfo(l.source, W, H);
    const b = info.box;
    const m = Math.round(Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.1) + 8;
    const x0 = Math.max(0, Math.floor(b.x0 - m));
    const y0 = Math.max(0, Math.floor(b.y0 - m));
    const cw = Math.min(W, Math.ceil(b.x1 + m)) - x0;
    const ch = Math.min(H, Math.ceil(b.y1 + m)) - y0;
    if (cw < 8 || ch < 8) throw new Error(`${l.name} is too small for a sticker.`);
    // Worked on at most 1600 px (the model sees 1024 anyway); solid parts keep full-size pixels.
    const k = Math.min(1, 1600 / Math.max(cw, ch));
    const w = Math.max(1, Math.round(cw * k));
    const h = Math.max(1, Math.round(ch * k));
    const photo = live.photo ? await loadImage(urls.source(live.photo)).catch(() => null) : null;
    const scene = (sw: number, sh: number, withPhoto: boolean) => {
      const c = document.createElement("canvas");
      c.width = sw;
      c.height = sh;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.setTransform(sw / cw, 0, 0, sh / ch, (-x0 * sw) / cw, (-y0 * sh) / ch);
      if (withPhoto && photo) ctx.drawImage(photo, 0, 0, W, H);
      drawSource(ctx, info);
      return c;
    };
    const own = scene(w, h, false).getContext("2d")!.getImageData(0, 0, w, h).data;
    const sel = new Uint8Array(w * h);
    for (let i = 0; i < sel.length; i++) sel[i] = own[i * 4 + 3] > 127 ? 255 : 0;
    // The object in its scene (a new object drawn by the lab is over the photo too).
    const rgba = scene(w, h, true).getContext("2d")!.getImageData(0, 0, w, h).data;
    if (!sel.some((v) => v)) throw new Error(`${l.name} has no pixels to cut out.`);
    const matte = await modelMatte(focusPixels(rgba, sel, w, h), w, h);
    const { alpha } = stickerAlpha(matte, sel, w, h);
    // Checked before anything changes: a cut-out that kept (almost) nothing leaves the layer as it was.
    const kept = keptShare(alpha, sel);
    if (kept < MIN_KEPT) throw new Error(`The quick cut-out found almost nothing of ${l.name} (${Math.round(kept * 100)} % kept): the layer is unchanged. Try Clean edges.`);
    const small = document.createElement("canvas");
    small.width = w;
    small.height = h;
    small.getContext("2d")!.putImageData(new ImageData(foreground(rgba, alpha, w, h) as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
    const out = document.createElement("canvas");
    out.width = W;
    out.height = H;
    const octx = out.getContext("2d")!;
    octx.imageSmoothingQuality = "high";
    octx.drawImage(small, x0, y0, cw, ch);
    if (k < 1) {
      const full = scene(cw, ch, true).getContext("2d")!.getImageData(0, 0, cw, ch).data;
      const d = octx.getImageData(x0, y0, cw, ch);
      for (let i = 0; i < cw * ch; i++) if (d.data[i * 4 + 3] > 250) for (let c = 0; c < 3; c++) d.data[i * 4 + c] = full[i * 4 + c];
      octx.putImageData(d, x0, y0);
    }
    const rec = await api.upload(await toPng(out), `${fileSafe(l.name)} (sticker).png`);
    addVersions([rec], 0);
    const src = `input:${rec.id}`;
    const now = liveRef.current;
    commitRef.current({ ...now, layers: now.layers.map((x) => (x.id === l.id ? { ...x, source: src, history: [...x.history, src] } : x)), known: [...now.known, src] });
  };

  /** The fast sticker model is downloaded once (224 MB), the first time Fast is used; the % shows. */
  const [matteDl, setMatteDl] = useState<number | null>(null);
  const ensureMatteModel = async () => {
    if ((await api.matteStatus()).installed) return;
    setMatteDl(0);
    try {
      await api.downloadMatte();
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 1000));
        const st = await api.installStatus();
        const it = st.items.find((i) => i.id === "birefnet_lite");
        if (it?.state === "failed" || it?.state === "cancelled") throw new Error(it.error ?? "The sticker model could not be downloaded.");
        if (it?.state === "done" || it?.state === "present") return;
        if (!st.running) {
          if ((await api.matteStatus()).installed) return;
          throw new Error("The sticker model could not be downloaded.");
        }
        if (it?.size) setMatteDl(Math.floor((100 * it.received) / it.size));
      }
    } finally {
      setMatteDl(null);
    }
  };
  const quickClean = async (l: DocLayer) => {
    setBusy(true);
    try {
      await ensureMatteModel();
      await fastSticker(l);
      toastInfo(`${l.name}: quick cut-out done.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  // Stickers: after a split with stickers on, every object is cleaned once. Quality: each goes to
  // Clean edges on its own (a crop at object size and the sticker prompt, sent as lab steps; the
  // service runs them one after the other and each result comes back like any Clean edges). Fast:
  // each object is matted here (fastSticker), the background's fill sent before (PC: side by side)
  // or after them (Mac).
  const stickersStarted = useRef(false);
  const setSticker = (layer: string, p: Partial<Sticker>) => {
    const d = liveRef.current;
    const next = { ...d, stickers: (d.stickers ?? []).map((s) => (s.layer === layer ? { ...s, ...p } : s)) };
    liveRef.current = next;
    setLive(next);
    onChange(next);
  };
  const makeStickers = async () => {
    const d = liveRef.current;
    const fast = d.autoClean === "fast";
    const objects = d.layers.filter((l) => !l.base && !l.effect);
    const base = d.layers.find((l) => l.base);
    const start = { ...d, autoClean: undefined, stickers: [...objects.map((l): Sticker => ({ layer: l.id, job: null })), ...(base ? [{ layer: base.id, job: null, kind: "fill" as const }] : [])] };
    liveRef.current = start;
    setLive(start);
    onChange(start);
    // The crops become versions (and the prompt's image) on the way: put back what was there.
    const before = getState();
    const keep = { selected: before.selected, refs: before.composer.refs };
    const putBack = () => setState((s) => ({ selected: s.session.some((i) => i.key === keep.selected) ? keep.selected : s.selected, composer: { ...s.composer, refs: keep.refs } }));
    const sendFill = async () => {
      const bg = liveRef.current.layers.find((x) => x.base);
      if (!bg || liveRef.current.stickers?.find((s) => s.kind)?.skipped) return;
      try {
        const { rec, mask } = await prepareFill(bg);
        const job = await submitRequest(fillRequest(rec, mask));
        setSticker(bg.id, job ? { job, from: bg.source, mask } : { failed: true });
      } catch (e) {
        console.error(e);
        setSticker(bg.id, { failed: true });
      }
    };
    if (fast) {
      // A PC: the fill is sent first and runs on the graphics card while the stickers are made on
      // the CPU, side by side. A Mac (unified memory): the image engine uses the CPU too and they
      // fought (11-04: stickers waited on the fill), so the stickers first, then the fill.
      const sideBySide = !getState().status?.gpu?.unified;
      if (sideBySide) await sendFill();
      let ready = true;
      try {
        await ensureMatteModel();
      } catch (e) {
        toastError(e);
        ready = false;
      }
      for (const l of objects) {
        if (liveRef.current.stickers?.find((s) => s.layer === l.id && !s.kind)?.skipped) continue;
        if (!ready) {
          setSticker(l.id, { failed: true });
          continue;
        }
        setSticker(l.id, { local: "making" });
        try {
          await fastSticker(liveRef.current.layers.find((x) => x.id === l.id) ?? l);
          setSticker(l.id, { local: "done" });
        } catch (e) {
          console.error(e);
          setSticker(l.id, { failed: true, local: undefined });
          toastError(e);
        }
      }
      if (!sideBySide) await sendFill();
      putBack();
      return;
    }
    for (const l of objects) {
      if (liveRef.current.stickers?.find((s) => s.layer === l.id && !s.kind)?.skipped) continue;
      try {
        const f = await cropOf(liveRef.current.layers.find((x) => x.id === l.id) ?? l, "clean");
        const it = getState().session.find((i) => itemSource(i) === f.source);
        if (!it?.input) throw new Error(`The crop of ${l.name} is not in the project.`);
        // Skipped while its crop was made.
        if (liveRef.current.stickers?.find((s) => s.layer === l.id)?.skipped) continue;
        const c = getState().composer;
        const req = buildRequest({ ...c, prompt: stickerPrompt(l.name), refs: [refFromInput(it.input)], mask: null, outpaint: null, create: false, mode: "auto", enhance: false, enhancedFrom: null, seed: null });
        const job = await submitRequest({ ...req, hidden: true });
        setSticker(l.id, job ? { job, from: l.source } : { failed: true });
      } catch (e) {
        console.error(e);
        setSticker(l.id, { failed: true });
      }
    }
    // Then the background: its holes filled, shadows and leftovers of the objects taken off.
    await sendFill();
    putBack();
  };
  useEffect(() => {
    if (!live.autoClean || stickersStarted.current) return;
    stickersStarted.current = true;
    void makeStickers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const jobs = useStore((s) => s.jobs);
  const session = useStore((s) => s.session);
  /** Where an object's sticker is. */
  const stickerState = (s: Sticker): "waiting" | "making" | "done" | "skipped" | "failed" => {
    if (s.skipped) return "skipped";
    if (s.failed) return "failed";
    if (s.local) return s.local;
    const j = s.job ? jobs[s.job] : undefined;
    if (!j) return s.job ? "done" : "waiting";
    // Done once the result is pasted into the layer (a moment after the job).
    if (j.status === "done") {
      // The fill counts once its result was checked for grey patches (or it was the second try).
      if (s.kind && !s.checked && !s.retried) return "making";
      return s.from && live.layers.find((l) => l.id === s.layer)?.source === s.from ? "making" : "done";
    }
    if (j.status === "cancelled") return "skipped";
    if (j.status === "failed") return "failed";
    return j.status === "queued" ? "waiting" : "making";
  };
  // A fill that copied the grey (or the guide's marking) instead of a background is sent once more.
  const checkedFill = useRef(new Set<string>());
  useEffect(() => {
    const s = live.stickers?.find((x) => x.kind && x.job && !x.retried && !x.skipped);
    if (!s?.job || !s.mask || jobs[s.job]?.status !== "done" || checkedFill.current.has(s.job)) return;
    const gen = session.find((i) => i.jobId === s.job)?.gen;
    if (!gen) return;
    checkedFill.current.add(s.job);
    const mask = s.mask;
    (async () => {
      const [img, m] = await Promise.all([loadImage(urls.source(`gen:${gen.id}`)), loadImage(urls.input(mask))]);
      const w = Math.min(512, img.naturalWidth);
      const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
      const a = pixels(img, w, h);
      const b = pixels(m, w, h);
      const rec = gen.request?.images?.[0] && session.find((i) => itemSource(i) === gen.request!.images[0])?.input;
      // 20 %: the two failed Halloween fills scored 72 %, a clean one 4.6 % (grey pavement).
      if (copiedShare(a, b, w * h) < 0.2 || !rec) return setSticker(s.layer, { checked: true });
      toastInfo("The background fill copied the grey or the marking instead of a background: trying once more.");
      const job = await submitRequest(fillRequest(rec, mask));
      setSticker(s.layer, job ? { job, retried: true } : { checked: true });
    })().catch((e) => {
      console.error(e);
      setSticker(s.layer, { checked: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, session, live.stickers]);

  // Blend into scene (or an older Automatic shadows edit) being made (sent, generated, or read back):
  // the layers stay where they are meanwhile (the result is made for this layout), and the stage says
  // how far it is. A failed edit does not hold them.
  const [blendSending, setBlendSending] = useState(false);
  const autoScenes = (live.scenes ?? []).filter((e) => e.one);
  const shadowJob = labJobs.find((j) => j.job.status !== "failed" && autoScenes.some((e) => e.source === j.item.request?.images?.[0]));
  const shadowReading = autoScenes.some((e) => session.some((i) => i.gen && itemOrigin(i).from[0] === e.source && !live.known.includes(`gen:${i.gen.id}`)));
  const shadowing = blendSending || !!shadowJob || shadowReading;
  // Something moved (or was scaled, shown, hidden) since the last blend: its layer no longer fits.
  const lastBlend = [...(live.scenes ?? [])].reverse().find((e) => e.blend);
  const blendStale =
    !!lastBlend &&
    live.layers.some((l) => l.blend === "paste" && !l.hidden) &&
    live.layers.some((o) => {
      if (o.base || o.effect) return false;
      const at = lastBlend.places[o.id];
      if (!at) return !o.hidden;
      if (o.hidden) return true;
      return o.source !== at.source || Math.hypot(o.dx - at.dx, o.dy - at.dy) > 0.02 * Math.max(W, H) || Math.abs(o.s / at.s - 1) > 0.05;
    });

  const skipSticker = (s: Sticker) => {
    if (s.job) void cancelJob(s.job);
    setSticker(s.layer, { skipped: true });
  };
  const stickerRows = (live.stickers ?? []).filter((s) => live.layers.some((l) => l.id === s.layer));
  const stickerStates = stickerRows.map(stickerState);
  const stickersLeft = stickerStates.filter((x) => x === "waiting" || x === "making").length;
  /** Stickers are being made: the Stage shows the objects on transparency, the one being made ringed. */
  const stickering = stickersLeft > 0;
  const stickerOf = (id: string) => {
    const i = stickerRows.findIndex((s) => s.layer === id);
    return i < 0 ? null : stickerStates[i];
  };
  const stickerNow = stickerRows[stickerStates.indexOf("making")] ?? stickerRows[stickerStates.indexOf("waiting")];
  // All in: the list goes and the background fades back under them; the ones not cleaned are named.
  useEffect(() => {
    if (!stickerRows.length || stickersLeft) return;
    const failed = stickerRows.filter((_, i) => stickerStates[i] === "failed").map((s) => live.layers.find((l) => l.id === s.layer)?.name ?? "");
    toastInfo(failed.length ? `Stickers done; not cleaned: ${failed.join(", ")}. Select one and use Clean edges.` : "Stickers done. Not clean enough? Select the object and use Clean edges, or the Eraser.");
    const d = { ...liveRef.current, stickers: undefined };
    liveRef.current = d;
    setLive(d);
    onChange(d);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickersLeft, stickerRows.length]);

  // Strength: the Blend (or older Shadows) layer redrawn from the model's version, as its next version:
  // the change it makes over the layers under it, times k (0: none, 1: as made, 2: twice as dark).
  // The Blend layer is a paste, opaque where it changed, so scaling its alpha alone (stacking it,
  // before 11-04) left it as it was: past alpha 1 its colours move on from what is under it.
  // The Blend (or older Shadows) layer shown, not the in-front piece.
  const autoShadows = live.layers.find((l) => l.auto && l.effect && l.blend !== "front" && !l.hidden) ?? live.layers.find((l) => l.auto && l.effect && l.blend !== "front");
  const [strengthShown, setStrengthShown] = useState(100);
  useEffect(() => setStrengthShown(Math.round((autoShadows?.strength ?? 1) * 100)), [autoShadows?.id, autoShadows?.strength]);
  useEffect(() => {
    const l = autoShadows;
    const k = strengthShown / 100;
    if (!l || Math.abs(k - (l.strength ?? 1)) < 0.001) return;
    const id = window.setTimeout(async () => {
      try {
        const made = l.made ?? l.source;
        const img = await loadImage(urls.source(made));
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, W, H);
        const d = ctx.getImageData(0, 0, W, H);
        // What is under the layer, in the layer's own place (it may have been moved or scaled).
        const at = live.layers.indexOf(l);
        const under = await render(W, H, undefined, live.layers.slice(at + 1));
        const info = await sourceInfo(l.source, W, H);
        const t = xfOf(live.layers, l, (src) => (src === l.source ? info.box : infos[src]?.box), W, H);
        const u = document.createElement("canvas");
        u.width = W;
        u.height = H;
        const uctx = u.getContext("2d")!;
        uctx.translate(t.c.x, t.c.y);
        uctx.scale(1 / t.s, 1 / t.s);
        uctx.translate(-t.c.x - t.dx, -t.c.y - t.dy);
        uctx.drawImage(under, 0, 0);
        d.data.set(strengthPixels(d.data, uctx.getImageData(0, 0, W, H).data, k));
        ctx.putImageData(d, 0, 0);
        const rec = await api.upload(await toPng(c), "Shadows.png");
        const src = `input:${rec.id}`;
        const now = liveRef.current;
        commitRef.current({ ...now, layers: now.layers.map((x) => (x.id === l.id ? { ...x, source: src, history: [...x.history, src], made, strength: k } : x)) });
      } catch (e) {
        toastError(e);
      }
    }, 400);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strengthShown]);

  const commit = (next: LayerDoc) => {
    undoStack.current = [...undoStack.current, doc].slice(-50);
    redoStack.current = [];
    setLive(next);
    onChange(next);
  };
  // For work that ends after an upload: the latest render's commit (the document may have changed).
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const patchLayer = (id: string, p: Partial<DocLayer>) => commit({ ...live, layers: live.layers.map((l) => (l.id === id ? { ...l, ...p } : l)) });

  const undo = () => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(live);
    setLive(prev);
    onChange(prev);
  };
  const redo = () => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(live);
    setLive(next);
    onChange(next);
  };

  /** Removes these layers (not the background), and the shadows that follow them. */
  const removeLayers = (ids: string[]) => {
    const gone = new Set(live.layers.filter((l) => ids.includes(l.id) && !l.base).map((l) => l.id));
    if (!gone.size) return;
    commit({ ...live, layers: live.layers.filter((x) => !gone.has(x.id) && !(x.follows && gone.has(x.follows))) });
    setSels([]);
  };

  /** Selected layers that move (objects: the background and shadows stay where they are). */
  const movable = (ids: string[]) =>
    live.layers.filter(
      (l) =>
        ids.includes(l.id) &&
        !l.base &&
        infos[l.source] &&
        // A shadow that follows an object moved with it already moves with it.
        !(l.follows && ids.includes(l.follows)),
    );

  /** Moves the layers by (dx, dy) and scales them by `k` around `c` (frame px), from `l0`. */
  const placeAll = (ids: string[], l0: Record<string, DocLayer>, dx: number, dy: number, k = 1, c = { x: 0, y: 0 }) => {
    setLive((cur) => ({
      ...cur,
      layers: cur.layers.map((l) => {
        const o = l0[l.id];
        const info = o && ids.includes(l.id) ? infos[o.source] : undefined;
        if (!o || !info) return l;
        // Its content's centre where it is drawn, moved/scaled with the others around c.
        const own = centre(info.box);
        const at = { x: own.x + o.dx, y: own.y + o.dy };
        return { ...l, s: Math.min(20, Math.max(0.05, o.s * k)), dx: c.x + k * (at.x - c.x) - own.x + dx, dy: c.y + k * (at.y - c.y) - own.y + dy };
      }),
    }));
  };

  const toFrame = (e: React.PointerEvent) => {
    const r = hitRef.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };

  /** The top visible layer with something under the point (shadow layers are picked in the list). */
  const hit = (x: number, y: number): DocLayer | null => {
    for (const l of live.layers) {
      const info = infos[l.source];
      if (l.hidden || l.effect || !info) continue;
      const q = unmapPoint(xf(l), x, y);
      const ix = Math.floor(((q.x - info.ext.x) / info.ext.w) * info.aw);
      const iy = Math.floor(((q.y - info.ext.y) / info.ext.h) * info.ah);
      if (ix < 0 || iy < 0 || ix >= info.aw || iy >= info.ah) continue;
      if (info.alpha[iy * info.aw + ix] > 32) return l;
    }
    return null;
  };

  // While a brush is on, the selected layer is drawn on a canvas the brush paints into.
  const paintInfo = brushOn && sel ? infos[sel.source] : undefined;
  useEffect(() => {
    const c = paintRef.current;
    if (!c || !paintInfo || stroke.current) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(paintInfo.img, 0, 0, c.width, c.height);
  }, [paintInfo, W, H]);

  /** Brush dabs from the last point to frame point `p`, in the layer's own pixels. */
  const paintTo = (p: { x: number; y: number }) => {
    const c = paintRef.current;
    if (!c || !sel) return;
    const t = xf(sel);
    const q = unmapPoint(t, p.x, p.y);
    const r = Math.max(1, brush / 2 / zoomK.current / t.s);
    const from = stroke.current ?? q;
    const n = Math.max(1, Math.ceil(Math.hypot(q.x - from.x, q.y - from.y) / Math.max(1, r / 4)));
    const ctx = c.getContext("2d")!;
    // The canvas covers the layer's own rect (past the frame for an expanded object).
    const e = extOf(live, sel.source);
    for (let i = stroke.current ? 1 : 0; i <= n; i++) dab(ctx, from.x + ((q.x - from.x) * i) / n - e.x, from.y + ((q.y - from.y) * i) / n - e.y, r, tool === "erase" ? "erase" : "shade");
    stroke.current = q;
  };

  /** A stroke ends: the layer as painted becomes its next version (Undo and Versions go back). */
  const endStroke = async () => {
    const c = paintRef.current;
    const l = sel;
    stroke.current = null;
    if (!c || !l) return;
    setBusy(true);
    try {
      const rec = await api.upload(await toPng(c), `${fileSafe(l.name)} (brushed).png`);
      addVersions([rec], 0);
      const src = `input:${rec.id}`;
      const d = liveRef.current;
      const e = d.ext?.[l.source];
      commitRef.current({
        ...d,
        ...(e ? { ext: { ...d.ext, [src]: e } } : {}),
        // Strength starts from what was brushed (else its next change would bring back what was erased).
        layers: d.layers.map((x) => (x.id === l.id ? { ...x, source: src, history: [...x.history, src], ...(x.made ? { made: src, strength: 1 } : {}) } : x)),
        known: [...d.known, src],
      });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** The drawn box around layers (union of their content where they are). */
  const boxOfAll = (ls: DocLayer[]): Box | null => {
    let b: Box | null = null;
    for (const l of ls) {
      const info = infos[l.source];
      if (!info || l.hidden) continue;
      const m = mapBox(info.box, xf(l));
      b = b ? { x0: Math.min(b.x0, m.x0), y0: Math.min(b.y0, m.y0), x1: Math.max(b.x1, m.x1), y1: Math.max(b.y1, m.y1) } : m;
    }
    return b;
  };

  const startDrag = (e: React.PointerEvent, mode: Drag["mode"], ids: string[]) => {
    const ls = movable(ids);
    const box = boxOfAll(ls);
    if (!ls.length || !box) return;
    e.stopPropagation();
    try {
      hitRef.current?.setPointerCapture(e.pointerId);
    } catch {}
    const p = toFrame(e);
    drag.current = { mode, ids: ls.map((l) => l.id), x0: p.x, y0: p.y, l0: Object.fromEntries(ls.map((l) => [l.id, l])), c: centre(box) };
  };

  // The pencil: marks in frame px, kept per document until they are sent with New objects.
  useEffect(() => {
    const c = marksRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    for (const m of [...sketch.marks, ...(drawing.current ? [drawing.current] : [])]) drawMark(ctx, m);
  });

  const onDown = (e: React.PointerEvent) => {
    if (shadowing) return;
    if (areaOn && (e.button === 0 || e.button === 2)) {
      e.stopPropagation();
      try {
        hitRef.current?.setPointerCapture(e.pointerId);
      } catch {}
      const p = toFrame(e);
      areaStroke.current = { erase: e.button === 2 || e.altKey, last: p };
      areaTo(p);
      return;
    }
    if (e.button !== 0 || panning) return;
    const p = toFrame(e);
    if (brushOn) {
      e.stopPropagation();
      try {
        hitRef.current?.setPointerCapture(e.pointerId);
      } catch {}
      stroke.current = null;
      paintTo(p);
      return;
    }
    if (tool === "sketch") {
      e.stopPropagation();
      try {
        hitRef.current?.setPointerCapture(e.pointerId);
      } catch {}
      drawing.current = { colour: markColour, r: Math.max(2, brush / 2 / zoomK.current), pts: [p] };
      const ctx = marksRef.current?.getContext("2d");
      if (ctx) drawMark(ctx, drawing.current);
      setCursor(p);
      return;
    }
    const inSel = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && selLayers.some((x) => x.effect) ? boxOfAll(selLayers.filter((x) => !x.hidden)) : null;
    if (inSel && p.x >= inSel.x0 && p.x <= inSel.x1 && p.y >= inSel.y0 && p.y <= inSel.y1) {
      startDrag(e, "move", sels);
      return;
    }
    const l = hit(p.x, p.y);
    // Shift / Ctrl / Cmd: add or take out (with its group); Alt: this layer alone, even in a group.
    if (l && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      const ids = withGroup(live.layers, l.id);
      const on = sels.includes(l.id);
      setSels(on ? sels.filter((x) => !ids.includes(x)) : [...sels.filter((x) => !ids.includes(x)), ...ids.filter((x) => x !== l.id), l.id]);
      return;
    }
    if (!l) {
      setSels([]);
      return;
    }
    // A click on a layer already selected keeps the selection, so the drag moves all of them.
    const ids = e.altKey ? [l.id] : sels.includes(l.id) ? [...sels.filter((x) => x !== l.id), l.id] : [...withGroup(live.layers, l.id).filter((x) => x !== l.id), l.id];
    setSels(ids);
    startDrag(e, "move", ids);
  };

  const onMove = (e: React.PointerEvent) => {
    if (areaOn) {
      const p = toFrame(e);
      setCursor(p);
      if (areaStroke.current) {
        e.stopPropagation();
        areaTo(p);
      }
      return;
    }
    if (brushOn || tool === "sketch") {
      const p = toFrame(e);
      setCursor(p);
      if (brushOn && stroke.current) {
        e.stopPropagation();
        paintTo(p);
      }
      if (drawing.current) {
        e.stopPropagation();
        drawing.current.pts.push(p);
        const ctx = marksRef.current?.getContext("2d");
        if (ctx) drawMark(ctx, drawing.current, drawing.current.pts.length - 2);
      }
      return;
    }
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const p = toFrame(e);
    if (d.mode === "move") placeAll(d.ids, d.l0, p.x - d.x0, p.y - d.y0);
    else {
      const r0 = Math.hypot(d.x0 - d.c.x, d.y0 - d.c.y) || 1;
      placeAll(d.ids, d.l0, 0, 0, Math.hypot(p.x - d.c.x, p.y - d.c.y) / r0, d.c);
    }
  };

  const onUp = () => {
    if (areaStroke.current) {
      void endArea();
      return;
    }
    if (stroke.current) {
      void endStroke();
      return;
    }
    if (drawing.current) {
      const m = drawing.current;
      drawing.current = null;
      setSketch({ ...sketch, marks: [...sketch.marks, m] });
      return;
    }
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const moved = live.layers.some((l) => d.l0[l.id] && (l.dx !== d.l0[l.id].dx || l.dy !== d.l0[l.id].dy || l.s !== d.l0[l.id].s));
    if (moved) commit(live);
  };

  // Reorder by dragging a row's grip (pointer events: the window's file drop takes HTML drag and drop).
  const onGripDown = (e: React.PointerEvent, i: number) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setRowDrag({ from: i, over: i });
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (!rowDrag) return;
    // The new index once the row is taken out: how many other rows are above the pointer.
    let over = 0;
    rowsRef.current.slice(0, live.layers.length).forEach((el, i) => {
      if (!el || i === rowDrag.from) return;
      const r = el.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) over++;
    });
    if (over !== rowDrag.over) setRowDrag({ ...rowDrag, over });
  };
  const onGripUp = () => {
    if (!rowDrag) return;
    const next = reorder(live, rowDrag.from, rowDrag.over);
    setRowDrag(null);
    if (next !== live) commit(next);
  };

  /** The background's holes as a brushed Add ready in the prompt, with a prompt to fine-tune: the
   * background with its holes flat grey (opaque: an edit of the transparent background keeps the
   * holes; no objects in them, as on the photo) and the holes as the painted area. Add keeps the
   * image as it is under the area (Remove blurs it first and, empty, clears "everything that was
   * there"). The result comes back as the background's next version. */
  /** The background's holes ready to fill: the image (holes grey) as a version, and the area. */
  const prepareFill = async (l: DocLayer) => {
      const info = await sourceInfo(l.source, W, H);
      const k = Math.min(1, 2048 / Math.max(W, H));
      const mw = Math.max(1, Math.round(W * k));
      const mh = Math.max(1, Math.round(H * k));
      const c = document.createElement("canvas");
      c.width = mw;
      c.height = mh;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(info.img, 0, 0, mw, mh);
      const px = ctx.getImageData(0, 0, mw, mh).data;
      let hole: Uint8Array = new Uint8Array(mw * mh);
      for (let i = 0; i < hole.length; i++) hole[i] = px[i * 4 + 3] < 200 ? 255 : 0;
      // Wider than the holes: the objects' fringe and the contact shadows at their feet (1.5 %: 0.6 %
      // left the shadows, 11-01 bench; the Area brush widens it for longer ones).
      hole = dilate(hole, mw, mh, Math.max(2, Math.round(Math.max(mw, mh) * 0.015)));
      const m = ctx.createImageData(mw, mh);
      for (let i = 0; i < hole.length; i++) {
        m.data[i * 4] = m.data[i * 4 + 1] = m.data[i * 4 + 2] = hole[i];
        m.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(m, 0, 0);
      const out = document.createElement("canvas");
      out.width = mw;
      out.height = mh;
      const o = out.getContext("2d")!;
      // Opaque, black under it: blurred on transparency, the frame's edge pixels came out partly
      // transparent, and the service reads a mask with any transparency by its alpha (white strokes
      // on a layer) -> the whole frame was the area, the guide all red, and Qwen copied the grey or
      // the red (11-01, Halloween). The same seed fills cleanly with the mask opaque.
      o.fillStyle = "#000";
      o.fillRect(0, 0, mw, mh);
      o.filter = "blur(4px)"; // the soft edge of a painted area (InpaintEditor FEATHER)
      o.drawImage(c, 0, 0);
      const mask = await api.upload(await toPng(out), "mask.png");

      const g = document.createElement("canvas");
      g.width = W;
      g.height = H;
      const gc = g.getContext("2d")!;
      gc.fillStyle = "#808080";
      gc.fillRect(0, 0, W, H);
      gc.drawImage(info.img, 0, 0, W, H);
      const rec = await api.upload(await toPng(g), "Background to fill.png");
      addVersions([rec], 0);
      const target = `input:${rec.id}`;
      const d = liveRef.current;
      commitRef.current({ ...d, layers: d.layers.map((x) => (x.id === l.id ? { ...x, feeds: [...(x.feeds ?? []), { source: target, mask: mask.id }] } : x)) });
      return { rec, target, mask: mask.id };
  };
  /** The fill as a request (the automatic one after a split): an Add in the holes, a lab step. */
  const fillRequest = (rec: InputRecord, mask: string) => {
    const ref = refFromInput(rec);
    const c = getState().composer;
    return { ...buildRequest({ ...c, prompt: FILL_PROMPT, refs: [ref], mask: { inputId: mask, refKey: ref.key }, inpaintAction: "add", outpaint: null, create: false, mode: "auto", enhance: false, enhancedFrom: null, seed: null }), hidden: true };
  };

  const fillHoles = async (l: DocLayer) => {
    setBusy(true);
    try {
      const { target, mask } = await prepareFill(l);
      if (!editSource(target, false)) throw new Error("The background to fill could not be opened.");
      const refKey = getState().composer.refs[0]?.key;
      // Kokon wraps it: "In <image1>, add {this} inside the area marked …" (pipeline.rs inpaint_prompt).
      if (refKey) updateComposer({ mask: { inputId: mask, refKey }, outpaint: null, mode: "auto", inpaintAction: "add", prompt: FILL_PROMPT });
      focusPrompt(true);
      toastInfo("The holes are painted as an Add with a prompt to fine-tune (e.g. name the surfaces: “the wooden table top and the tiled floor”), then Generate. The result becomes the background here.");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** The visible layers drawn into one `w`×`h` image (`skip`: layers left out; `only`: just these). */
  const render = async (w: number, h: number, skip?: Set<string>, only?: DocLayer[]) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.scale(w / W, h / H);
    for (const l of [...(only ?? live.layers)].reverse()) {
      if (l.hidden || skip?.has(l.id)) continue;
      const info = await sourceInfo(l.source, W, H);
      const t = xfOf(live.layers, l, (src) => (src === l.source ? info.box : infos[src]?.box), W, H);
      ctx.save();
      ctx.translate(t.c.x + t.dx, t.c.y + t.dy);
      ctx.scale(t.s, t.s);
      ctx.translate(-t.c.x, -t.c.y);
      drawSource(ctx, info);
      ctx.restore();
    }
    return c;
  };

  /** The background still has holes (grey in what is sent): Fill the holes first. */
  const hasHoles = async () => {
    const base = live.layers.find((l) => l.base);
    const info = base && !base.hidden ? await sourceInfo(base.source, W, H) : undefined;
    return !!info && info.alpha.some((a) => a < 200);
  };

  /** The colours the pencil has used, in the palette's order. */
  const usedColours = MARK_COLOURS.map((c) => c.name).filter((c) => sketch.marks.some((m) => m.colour === c));
  const wantsNow = () => usedColours.map((colour) => ({ colour, what: sketch.wants[colour] ?? "" }));

  /** Sets up a whole-image edit in the prompt (LabScene reads its result): the flattened layers on
   * grey (holes left would keep the image transparent), with the pencil's marks drawn on when there
   * are any; `shadows`: objects whose shadows are read back (their shadow layers are left out of
   * what is sent, so Qwen makes them again); `look`: objects that take the edit's look. */
  /** `send`: made right away (a lab step, no Prompt+) instead of set up in the prompt; `one`: one
   * shadow layer for all the objects. */
  const sendScene = async (o: { shadows: string[]; look: string[]; prompt: string; marks: boolean; hint: string; send?: boolean; one?: boolean; blend?: boolean }) => {
    setBusy(true);
    // Sent right away: the flattened layers become a version on the way; the prompt's image is put back.
    const keep = { selected: getState().selected, refs: getState().composer.refs };
    try {
      const skip = new Set(live.layers.filter((l) => l.effect && (o.shadows.includes(l.follows ?? "") || (!l.follows && o.shadows.length > 0))).map((l) => l.id));
      // Blend: the background and the objects being blended, nothing else (Gabriele 11-03).
      if (o.blend) for (const l of live.layers) if (!l.base && !l.effect && !o.shadows.includes(l.id)) skip.add(l.id);
      const flat = document.createElement("canvas");
      flat.width = W;
      flat.height = H;
      const fctx = flat.getContext("2d")!;
      fctx.fillStyle = "#808080";
      fctx.fillRect(0, 0, W, H);
      fctx.drawImage(await render(W, H, skip), 0, 0);
      const before = await api.upload(await toPng(flat), "Layers for the scene.png");
      let source = before;
      let marksId: string | undefined;
      if (o.marks && sketch.marks.length) {
        const mc = document.createElement("canvas");
        mc.width = W;
        mc.height = H;
        const mctx = mc.getContext("2d")!;
        for (const m of sketch.marks) drawMark(mctx, m);
        marksId = (await api.upload(await toPng(mc), "marks.png")).id;
        fctx.drawImage(mc, 0, 0);
        source = await api.upload(await toPng(flat), "Layers with marks.png");
      }
      addVersions([source], 0);
      const target = `input:${source.id}`;
      if (!o.send) {
        if (!editSource(target, false)) throw new Error("The flattened layers could not be opened.");
        updateComposer({ mask: null, outpaint: null, mode: "auto", prompt: o.prompt });
      }
      const scene: SceneEdit = {
        source: target,
        before: `input:${before.id}`,
        ...(marksId ? { marks: marksId, wants: wantsNow() } : {}),
        shadows: o.shadows,
        look: o.look,
        places: placesOf(live),
        reach: SCENE_REACH,
        ...(o.one ? { one: true } : {}),
        ...(o.blend ? { blend: true } : {}),
      };
      // The same layers again upload as the same image (the service keeps one copy): an older edit of it
      // would read this one's result first (11-01: per-object shadows instead of the one layer asked for).
      // Blend: the old Automatic shadows layer would double the shadows: hidden (its eye brings it back).
      const layers = o.blend ? live.layers.map((l) => (l.auto && l.effect && !l.blend ? { ...l, hidden: true } : l)) : live.layers;
      commit({ ...live, layers, scenes: [...(live.scenes ?? []).filter((x) => x.source !== target), scene] });
      if (marksId) setSketch({ marks: [], wants: sketch.wants });
      setSels([]);
      if (o.send) {
        const c = getState().composer;
        const req = buildRequest({ ...c, prompt: o.prompt, refs: [refFromInput(source)], mask: null, outpaint: null, create: false, mode: "auto", enhance: false, enhancedFrom: null, seed: null });
        await submitRequest({ ...req, hidden: true });
        setState((st) => ({ selected: st.session.some((i) => i.key === keep.selected) ? keep.selected : st.selected, composer: { ...st.composer, refs: keep.refs } }));
        toastInfo((await hasHoles()) ? "Making the shadows, but the background still has holes (grey in the image): fill them first for real shadows." : o.hint);
        return;
      }
      focusPrompt(true);
      toastInfo((await hasHoles()) ? "Ready in the prompt, but the background still has holes (grey in the image): Fill the holes first." : o.hint);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };


  // Blend into scene (11-02, replaces Automatic shadows): the AI reads where each object stands
  // (BlendChoice shows it, the user corrects it), then Qwen redraws the whole scene with what each
  // place does (lib/blend.ts blendPrompt) and only what changed round the objects is kept (LabScene
  // readScene, blendKeep): one Blend layer over the background and one in-front piece on top.
  const [blendRows, setBlendRows] = useState<BlendRow[] | null>(null);
  /** Bumped by Cancel and Blend: readings still running for an older dialog stop. */
  const blendRun = useRef(0);

  /** The scene read for one object by the Prompt+ model (a job that makes no image). */
  const readPlace = async (o: DocLayer, rec: InputRecord, run: number) => {
    let reading: SceneReading | undefined;
    let failed: string | undefined;
    try {
      const ref = refFromInput(rec);
      const req = buildRequest({ ...getState().composer, prompt: "", refs: [ref], mask: null, outpaint: null, create: false, mode: "auto", enhance: false, enhancedFrom: null, seed: null });
      let job = await api.submit({ ...req, read_scene: o.name, hidden: true, ...(getState().privateMode ? { private: true } : {}) });
      while (job.status !== "done" && job.status !== "failed" && job.status !== "cancelled") {
        await new Promise((r) => window.setTimeout(r, 400));
        if (blendRun.current !== run) {
          void api.cancel(job.id).catch(() => {});
          return;
        }
        job = await api.job(job.id);
      }
      if (job.scene) reading = job.scene;
      else failed = job.error?.message ?? job.notes[job.notes.length - 1] ?? "no answer";
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    if (blendRun.current !== run) return;
    setBlendRows((rows) => rows && rows.map((r) => (r.id === o.id ? { ...r, reading: reading ?? { ...DEFAULT_READING }, failed } : r)));
  };

  /** Opens the dialog: the selected objects, else every visible one; their scene is read meanwhile. */
  const startBlend = async () => {
    const all = live.layers.filter((l) => !l.base && !l.effect && !l.hidden);
    const chosen = sels.some((id) => all.some((l) => l.id === id)) ? all.filter((l) => sels.includes(l.id)) : all;
    if (!chosen.length) return toastInfo("No visible objects to blend in.");
    setBusy(true);
    try {
      // What the AI reads: the background and the chosen objects (as sendScene sends them), without the
      // earlier Blend or Shadows layers, on grey (holes would make the image transparent).
      const skip = new Set(live.layers.filter((l) => (l.effect && l.auto) || (!l.base && !l.effect && !chosen.includes(l))).map((l) => l.id));
      const flat = document.createElement("canvas");
      flat.width = W;
      flat.height = H;
      const fctx = flat.getContext("2d")!;
      fctx.fillStyle = "#808080";
      fctx.fillRect(0, 0, W, H);
      fctx.drawImage(await render(W, H, skip), 0, 0);
      const rec = await api.upload(await toPng(flat), "Layers to blend in.png");
      const run = ++blendRun.current;
      setBlendRows(chosen.map((o) => ({ id: o.id, name: o.name })));
      for (const o of chosen) void readPlace(o, rec, run);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const cancelBlend = () => {
    blendRun.current++;
    setBlendRows(null);
  };

  /** One edit of the whole scene for every object in the dialog, sent right away as a lab step. */
  const sendBlend = async () => {
    const rows = blendRows;
    blendRun.current++;
    setBlendRows(null);
    const items = (rows ?? []).flatMap((r) => (r.reading && live.layers.some((l) => l.id === r.id) ? [{ id: r.id, name: r.name, reading: r.reading }] : []));
    if (!items.length) return;
    setBlendSending(true);
    try {
      const hideAuto = live.layers.some((l) => l.auto && l.effect && !l.blend && !l.hidden);
      await sendScene({
        shadows: items.map((i) => i.id),
        look: [],
        prompt: blendPrompt(items),
        marks: false,
        send: true,
        one: true,
        blend: true,
        hint: `Blending ${items.length === 1 ? "it" : `the ${items.length} objects`} into the scene${hideAuto ? "; the old Shadows layer is hidden" : ""}. Moved something later? Blend again.`,
      });
    } finally {
      setBlendSending(false);
    }
  };

  const newObjects = () =>
    sendScene({
      shadows: [],
      look: [],
      marks: true,
      prompt: marksPrompt(wantsNow()),
      hint: "The whole scene with your marks is in the prompt (Prompt+ sees the marks too), then Generate. Each new object comes back as its own layer at the marks' place and size (no shadow: Automatic shadows makes them).",
    });

  /** Several objects edited as one scene: the prompt is the user's; they take the edit's look. */
  const editTogether = (objects: DocLayer[]) =>
    sendScene({
      shadows: [],
      look: objects.map((l) => l.id),
      marks: sketch.marks.length > 0,
      prompt: sketch.marks.length ? marksPrompt(wantsNow()) : "",
      hint: `Write what to change in the whole scene, then Generate: the ${objects.length} selected objects take the result's look, the other layers stay.`,
    });

  const setGroup = (ids: string[], group: string | undefined) => commit({ ...live, layers: live.layers.map((l) => (ids.includes(l.id) && !l.base ? { ...l, group } : l)) });

  const flatten = async () => {
    setBusy(true);
    try {
      // The one image of the lab that goes to the gallery (its steps are kept out of it).
      const rec = await api.upload(await toPng(await render(W, H)), "Layers flattened.png");
      addResult(await api.saveLayers(`input:${rec.id}`, live.photo ?? null, getState().privateMode));
      setState({ overlay: null });
      toastInfo("Saved the layers as one image: a new version, and in All images (the layers stay: open Layers lab again).");
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  /** The layers as a Photoshop file: each one where and as big as it is here (hidden ones hidden). */
  const exportPsd = async () => {
    setBusy(true);
    try {
      const layers = [];
      for (const l of live.layers) {
        const c = await render(W, H, undefined, [{ ...l, hidden: false }]);
        layers.push({ name: l.name, hidden: l.hidden, rgba: c.getContext("2d")!.getImageData(0, 0, W, H).data });
      }
      const flat = document.createElement("canvas");
      flat.width = W;
      flat.height = H;
      const fx = flat.getContext("2d")!;
      fx.fillStyle = "#fff";
      fx.fillRect(0, 0, W, H);
      fx.drawImage(await render(W, H), 0, 0);
      const xmp = aiMarkingXmp(getState().status?.service.version ?? "");
      const path = await native.savePsd(writePsd(W, H, layers, fx.getImageData(0, 0, W, H).data, xmp));
      if (path) toastInfo(`Saved ${path.split(/[\\/]/).pop()}: each layer is its own layer in Photoshop.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      // Shadows being made for this layout: nothing moves or changes until they are in.
      if (shadowing && e.key !== "Escape") return;
      const k = e.key.toLowerCase();
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
      } else if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        if (!(tool === "area" && areaStep(!e.shiftKey))) e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        if (!(tool === "area" && areaStep(false))) redo();
      } else if ((e.ctrlKey || e.metaKey) && k === "a") {
        // Every visible object (not the background, not shadows).
        e.preventDefault();
        setSels(live.layers.filter((l) => !l.base && !l.effect && !l.hidden).map((l) => l.id));
      } else if ((e.ctrlKey || e.metaKey) && k === "g") {
        e.preventDefault();
        if (e.shiftKey) setGroup(sels, undefined);
        else if (movable(sels).length > 1) setGroup(sels, `g-${Date.now()}`);
      } else if (e.key === "Escape") setState({ overlay: null });
      else if ((e.key === "Delete" || e.key === "Backspace") && sels.length) removeLayers(sels);
      else if (e.key.startsWith("Arrow") && movable(sels).length) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        const ids = movable(sels).map((l) => l.id);
        commit({ ...live, layers: live.layers.map((l) => (ids.includes(l.id) ? { ...l, dx: l.dx + dx, dy: l.dy + dy } : l)) });
      } else if (k === "v") setTool("move");
      else if (k === "h") setTool((t) => (t === "pan" ? "move" : "pan"));
      else if (k === "e") setTool("erase");
      else if (k === "b") setTool("shade");
      else if (k === "p") setTool("sketch");
      else if (k === "a" && maskTint) setTool("area");
      else if (e.key === "[") setBrush((b) => Math.max(4, b - 8));
      else if (e.key === "]") setBrush((b) => Math.min(400, b + 8));
    };
    const onKeyUp = (e: KeyboardEvent) => e.code === "Space" && setSpacePressed(false);
    const onBlur = () => setSpacePressed(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  });

  const contentSize = useMemo(() => ({ width: W, height: H }), [W, H]);
  const base = live.layers.find((l) => l.base);
  const selLayers = live.layers.filter((l) => sels.includes(l.id));
  const selObjects = selLayers.filter((l) => !l.base && !l.effect);
  const grouped = selLayers.some((l) => l.group);
  const groupable = selLayers.filter((l) => !l.base).length > 1;

  const status = areaOn
    ? "Area brush: paint to add to the pink area · right-click takes out · [ ] size · then Generate"
    : brushOn
    ? `${tool === "erase" ? "Eraser" : "Shadow brush"} on “${sel!.name}”: paint · [ ] size · V to select and move`
    : tool === "erase"
      ? "Eraser: select an object or shadow layer in the list"
      : tool === "shade"
        ? "Shadow brush: select a shadow layer in the list"
        : tool === "sketch"
          ? "Pencil: draw where a new object goes, one colour per object · [ ] size · then say what it is on the right"
          : "Click a layer to select it · Shift+click adds · drag to move · a corner scales · Ctrl+A all · Ctrl+G group";

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Layers (lab)</h2>
        {labJobs.length && !stickering ? <LabJobs lab={lab} doc={doc} /> : <span className="layers-status">{stickering ? "Making stickers: each object is redrawn on its own; the background comes back when they are in" : status}</span>}
        <span className="spacer" />
        <button className="btn" onClick={onNewSplit} title="Split this image again (replaces these layers; other images keep theirs)">
          <Scissors size={14} /> New split
        </button>
        <IconButton title="Close (Esc)" onClick={() => setState({ overlay: null })}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="layers-body">
        <div className="editor-stage">
          {stickering && (
            <div className="sticker-strip">
              <Loader2 size={14} className="spin" />
              <span>
                {matteDl !== null ? (
                  <>Getting the sticker model (once, 224 MB) · {matteDl}%</>
                ) : (
                  <>
                    Making stickers · {stickerRows.length - stickersLeft} of {stickerRows.length}
                    {stickerNow ? ` · ${stickerNow.kind ? "filling the background" : (live.layers.find((l) => l.id === stickerNow.layer)?.name ?? "")}` : ""}
                  </>
                )}
              </span>
              {stickerNow && (
                <button className="btn" onClick={() => skipSticker(stickerNow)} title="Keep this object's rough cut-out">
                  Skip
                </button>
              )}
              <button className="btn" onClick={() => stickerRows.forEach((s, i) => (stickerStates[i] === "waiting" || stickerStates[i] === "making") && skipSticker(s))} title="Keep the rough cut-outs of the objects not done yet">
                Skip all
              </button>
            </div>
          )}
          {shadowing && (
            <div className="doc-lock" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
              <div className="doc-lock-card">
                <Loader2 size={18} className="spin" />
                <span>
                  {shadowJob ? <ShadowPhase job={shadowJob.job} item={shadowJob.item} /> : blendSending ? "Sending the scene" : "Reading what the AI added"}
                  <small>The layers stay where they are until it is in</small>
                </span>
              </div>
            </div>
          )}
          {maskTint && !stickering && <span className="doc-mask-chip">Painted area: Generate redoes what is pink · brush it here to change it (A)</span>}
          {!maskTint && waitingMarks(live).length > 0 && <span className="doc-mask-chip">Your marks: Generate adds the new objects there</span>}
          <ZoomPan contentSize={contentSize} resetKey="layer-doc" enableToggleZoom={false} enablePan={panning} className="inpaint-zoom-viewport" minimapSrc={base ? urls.source(base.source) : undefined}>
            {({ transform, isPanning }) => {
              const k = transform.scale;
              zoomK.current = k;
              const cur = panning ? (isPanning ? "grabbing" : "grab") : brushOn || areaOn || tool === "sketch" ? "none" : drag.current ? "move" : "default";
              const shown = selLayers.filter((l) => !l.hidden);
              const box = boxOfAll(shown);
              const canScale = movable(sels).length > 0;
              return (
                <div className={`mask-wrap doc-frame ${stickering ? "stickering" : ""}`} style={{ width: W, height: H }} onContextMenu={(e) => e.preventDefault()}>
                  {[...live.layers].reverse().map((l) => {
                    if (l.hidden) return null;
                    const t = xf(l);
                    // Stickers: background and shadows out of sight (they fade back), objects by their state.
                    const st = stickering ? (l.base || l.effect ? "hide" : (stickerOf(l.id) ?? "done")) : null;
                    // An expanded object's image reaches past the frame: placed on its own rect.
                    const e = extOf(live, l.source);
                    const at = { left: e.x, top: e.y, width: e.w, height: e.h, transformOrigin: `${t.c.x - e.x}px ${t.c.y - e.y}px`, transform: `translate(${t.dx}px, ${t.dy}px) scale(${t.s})` };
                    if (brushOn && l.id === sel!.id)
                      return <canvas key={`${l.id}:paint`} ref={paintRef} width={Math.round(e.w)} height={Math.round(e.h)} className="doc-layer" style={at} />;
                    return (
                      <img
                        key={`${l.id}:${l.source}`}
                        src={urls.source(l.source)}
                        alt=""
                        draggable={false}
                        className={`doc-layer ${st ? `st-${st}` : ""}`}
                        style={at}
                      />
                    );
                  })}
                  {/* Stickers: a ring with the percentage on the object being made, a spinner on the ones waiting. */}
                  {stickering &&
                    stickerRows.map((s, i) => {
                      const st = stickerStates[i];
                      const l = live.layers.find((x) => x.id === s.layer)!;
                      const info = infos[l.source];
                      // The background's fill: a ring only while it is made (in the middle).
                      if ((st !== "waiting" && st !== "making") || !info || l.hidden || (s.kind && st !== "making")) return null;
                      const c = centre(mapBox(info.box, xf(l)));
                      const job = s.job ? jobs[s.job] : undefined;
                      const item = s.job ? session.find((x) => x.jobId === s.job) : undefined;
                      return (
                        <div key={`ring-${s.layer}`} className={`sticker-ring ${st}`} style={{ left: c.x, top: c.y, transform: `translate(-50%, -50%) scale(${1 / k})` }}>
                          {st === "making" && job && item && job.status !== "done" ? <StickerRing job={job} item={item} /> : <Loader2 size={st === "making" ? 26 : 16} className="spin" />}
                        </div>
                      );
                    })}
                  {/* Marks already sent: shown until the new objects come back. */}
                  {waitingMarks(live).map((m) => (
                    <img key={m} className="doc-layer doc-marks" src={urls.input(m)} alt="" draggable={false} />
                  ))}
                  <canvas ref={marksRef} width={W} height={H} className="doc-layer doc-marks" />
                  {maskTint && paintedCrop && (() => {
                    const t = xf(paintedCrop.l);
                    const r = paintedCrop.f.rect!;
                    return (
                      <div className="doc-layer" style={{ transformOrigin: `${t.c.x}px ${t.c.y}px`, transform: `translate(${t.dx}px, ${t.dy}px) scale(${t.s})` }}>
                        <img className="doc-crop-mask" src={maskTint} alt="" draggable={false} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
                      </div>
                    );
                  })()}
                  {maskTint &&
                    !paintedCrop &&
                    (() => {
                      const t = paintedLayer ? xf(paintedLayer) : null;
                      return (
                        <img
                          className="doc-mask"
                          src={maskTint}
                          alt=""
                          draggable={false}
                          style={t ? { transformOrigin: `${t.c.x}px ${t.c.y}px`, transform: `translate(${t.dx}px, ${t.dy}px) scale(${t.s})` } : undefined}
                        />
                      );
                    })()}
                  <canvas ref={areaPreview} width={W} height={H} className="doc-layer doc-marks" />
                  <div ref={hitRef} className="doc-hit" style={{ cursor: cur }} onContextMenu={(e) => e.preventDefault()} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onPointerLeave={() => setCursor(null)} />
                  {(brushOn || areaOn || tool === "sketch") && cursor && !panning && (
                    <div
                      className={`brush-cursor ${tool === "sketch" ? "pencil" : ""}`}
                      style={{ left: cursor.x, top: cursor.y, width: brush / k, height: brush / k, borderWidth: 1.5 / k, ...(tool === "sketch" ? { borderColor: MARK_COLOURS.find((c) => c.name === markColour)!.css } : {}) }}
                    />
                  )}
                  {/* Several selected: a thin box on each, one box with the handle around all. */}
                  {shown.length > 1 &&
                    tool !== "sketch" &&
                    shown.map((l) => {
                      const b = boxOfAll([l]);
                      return b && <div key={l.id} className="doc-sel doc-sel-part" style={{ left: b.x0, top: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, borderWidth: 1 / k }} />;
                    })}
                  {box && tool !== "sketch" && (
                    <div className="doc-sel" style={{ left: box.x0, top: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, borderWidth: 1.5 / k }}>
                      {/* A handle on every corner: scaling is about the centre, so any of them works the same. */}
                      {canScale &&
                        (["tl", "tr", "bl", "br"] as const).map((at) => (
                          <div
                            key={at}
                            className={`doc-handle ${at}`}
                            title="Drag to scale"
                            style={{ width: 12 / k, height: 12 / k, [at[0] === "t" ? "top" : "bottom"]: -6 / k, [at[1] === "l" ? "left" : "right"]: -6 / k, borderWidth: 1.5 / k }}
                            onPointerDown={(e) => startDrag(e, "scale", sels)}
                            onPointerMove={onMove}
                            onPointerUp={onUp}
                          />
                        ))}
                    </div>
                  )}
                </div>
              );
            }}
          </ZoomPan>
        </div>

        <aside className={`layers-panel ${shadowing ? "locked" : ""}`}>
          <div className="layers-title">Layers</div>
          {live.layers.map((l, i) => {
            const info = infos[l.source];
            const mark = rowDrag && rowDrag.from !== i && rowDrag.over === i ? (rowDrag.over > rowDrag.from ? "drop-below" : "drop-above") : "";
            return (
              <div
                key={l.id}
                ref={(el) => {
                  rowsRef.current[i] = el;
                }}
                className={`layer-row doc-row ${sels.includes(l.id) ? "on" : ""} ${mark} ${rowDrag?.from === i ? "dragging" : ""}`}
                onClick={(e) => {
                  if (e.shiftKey || e.ctrlKey || e.metaKey) {
                    const ids = withGroup(live.layers, l.id);
                    setSels(sels.includes(l.id) ? sels.filter((x) => !ids.includes(x)) : [...sels.filter((x) => !ids.includes(x)), ...ids.filter((x) => x !== l.id), l.id]);
                  } else if (e.altKey) setSels([l.id]);
                  else setSelected(l.id);
                }}
              >
                {l.base ? (
                  <span className="grip" title="The background stays at the bottom">
                    <Lock size={13} />
                  </span>
                ) : (
                  <span className="grip" title="Drag to reorder" onPointerDown={(e) => onGripDown(e, i)} onPointerMove={onGripMove} onPointerUp={onGripUp}>
                    <GripVertical size={14} />
                  </span>
                )}
                <span className="doc-thumb">{info && <img src={info.thumb} alt="" />}</span>
                {renaming === l.id ? (
                  <input
                    autoFocus
                    value={l.name}
                    onChange={(e) => onChange({ ...live, layers: live.layers.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)) })}
                    onBlur={() => setRenaming(null)}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === "Escape") && (e.target as HTMLInputElement).blur()}
                    spellCheck={false}
                  />
                ) : (
                  <span className="doc-name" title="Double-click to rename" onDoubleClick={() => setRenaming(l.id)}>
                    {l.name}
                  </span>
                )}
                {l.group && (
                  <span className="doc-group" title="In a group: a click selects the whole group (Alt+click: this layer alone)">
                    <Link2 size={12} />
                  </span>
                )}
                {rowJob(l) ? (
                  <span className="layer-pct doc-running" title="An edit of this layer is being made">
                    <Loader2 className="spin" size={12} /> <JobPct job={rowJob(l)!.job} item={rowJob(l)!.item} />
                  </span>
                ) : (
                  l.history.length > 1 && <span className="layer-pct" title="Versions">v{l.history.indexOf(l.source) + 1}</span>
                )}
                <IconButton title={l.hidden ? "Show" : "Hide"} onClick={() => patchLayer(l.id, { hidden: !l.hidden })}>
                  {l.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                </IconButton>
              </div>
            );
          })}

          {(tool === "sketch" || sketch.marks.length > 0) && (
            <div className="doc-actions doc-new">
              <div className="doc-actions-title">
                <Pencil size={13} /> New objects
              </div>
              <p className="layers-help">
                {sketch.marks.length
                  ? "Say what goes at each colour. The whole scene goes to Qwen with your marks; each object comes back as its own layer at that place and size, without a shadow (Automatic shadows makes them). Prompt+ sees the marks too."
                  : "Draw where a new object goes (an outline or a scribble), one colour per object."}
              </p>
              {usedColours.map((c) => (
                <label key={c} className="doc-want">
                  <span className="doc-swatch" style={{ background: MARK_COLOURS.find((m) => m.name === c)!.css }} />
                  <input
                    value={sketch.wants[c] ?? ""}
                    placeholder={`What goes at the ${c} marks, e.g. “a green glass bottle”`}
                    onChange={(e) => setSketch({ ...sketch, wants: { ...sketch.wants, [c]: e.target.value } })}
                    spellCheck={false}
                  />
                </label>
              ))}
              {sketch.marks.length > 0 && (
                <div className="doc-grid">
                  <button className="btn" onClick={() => setSketch({ ...sketch, marks: sketch.marks.slice(0, -1) })} title="Take back the last mark">
                    <Undo2 size={14} /> Undo mark
                  </button>
                  <button className="btn" onClick={() => setSketch({ marks: [], wants: sketch.wants })} title="Remove every mark">
                    <Trash2 size={14} /> Clear marks
                  </button>
                  <button className="btn primary doc-wide" onClick={newObjects} disabled={busy} title="The flattened layers with your marks as the image to edit, and a prompt naming each colour's object">
                    <WandSparkles size={14} /> Set up the prompt
                  </button>
                </div>
              )}
            </div>
          )}

          {multi ? (
            <div className="doc-actions">
              <div className="doc-actions-title">{sels.length} layers</div>
              <p className="layers-help">Moved and scaled together. Edit together gives Qwen the whole scene; the selected objects take the result's look.</p>
              <div className="doc-grid">
                {groupable &&
                  (grouped ? (
                    <button className="btn" onClick={() => setGroup(sels, undefined)} title={`Ungroup (${shortcut("Shift+G")})`}>
                      <Ungroup size={14} /> Ungroup
                    </button>
                  ) : (
                    <button className="btn" onClick={() => setGroup(sels, `g-${Date.now()}`)} title={`Keep them together: a click on one selects all (${shortcut("G")})`}>
                      <Group size={14} /> Group
                    </button>
                  ))}
                {selObjects.length > 0 && (
                  <button className="btn" onClick={() => editTogether(selObjects)} disabled={busy} title="The whole scene as the image to edit; the selected objects take the result's look, the other layers stay">
                    <Sparkles size={14} /> Edit together
                  </button>
                )}
                {selObjects.length > 0 && (
                  <button className="btn" onClick={() => commit({ ...live, layers: live.layers.map((l) => (selObjects.some((o) => o.id === l.id) ? { ...l, dx: 0, dy: 0, s: 1 } : l)) })} title="Back to where they were in the photo">
                    <RotateCcw size={14} /> Reset place
                  </button>
                )}
                <button className="btn" onClick={() => removeLayers(sels)} title="Remove them from the layers (with their shadows; the versions stay in the project)">
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          ) : sel ? (
            <div className="doc-actions">
              <div className="doc-actions-title">{sel.name}</div>
              <p className="layers-help">
                {sel.base
                  ? "The prompt edits the background. Fill the holes sets up the fill; widen the area with Paint area (shadows too) before Generate."
                  : sel.effect
                    ? sel.follows
                      ? "Moves and scales with its object. Make it again after a big move."
                      : sel.blend
                        ? "The AI's redrawn scene round the objects (their shadows, reflections, where they touch the ground), on top of them. Something wrong? The Eraser (E) takes it out of this layer. Moved an object? Blend again."
                        : "Made where the objects are: make them again after moving objects."
                    : `The prompt edits this layer at its own size, e.g. “Complete the ${sel.name.toLowerCase()}, keep the transparent background”.`}
              </p>
              <div className="doc-grid">
                {sel.base && (
                  <button className="btn" onClick={() => fillHoles(sel)} disabled={busy} title="Paints the holes as an Add with a prompt to fine-tune, ready to generate">
                    <Eraser size={14} /> Fill the holes
                  </button>
                )}
                {!sel.base && !sel.effect && (
                  <button className="btn" onClick={() => cleanEdges(sel)} disabled={busy} title="Quality: the AI redraws the object's border at its own size, as a cut-out on transparency; the result stays inside its outline (grown ~3 px)">
                    <Sparkles size={14} /> Clean edges
                  </button>
                )}
                {!sel.base && !sel.effect && (
                  <button className="btn" onClick={() => quickClean(sel)} disabled={busy} title="Fast: a quick cut-out from the photo, a few seconds (the first time, the sticker model is downloaded: 224 MB)">
                    <Scissors size={14} /> {matteDl !== null ? `Getting the model · ${matteDl}%` : "Quick cut-out"}
                  </button>
                )}
                {sel.history.length > 1 && (
                  <button className={`btn ${versionsOpen ? "on" : ""}`} onClick={() => setVersionsOpen((o) => !o)} aria-expanded={versionsOpen} title="Show an earlier version of this layer">
                    <History size={14} /> Versions · {sel.history.length}
                  </button>
                )}
                {!sel.base && !sel.effect && (
                  <button className="btn" onClick={() => patchLayer(sel.id, { dx: 0, dy: 0, s: 1 })} disabled={!sel.dx && !sel.dy && sel.s === 1} title="Back to where it was in the photo">
                    <RotateCcw size={14} /> Reset place
                  </button>
                )}
                {!sel.base && (
                  <button className="btn" onClick={() => removeLayers([sel.id])} title="Remove it from the layers (the version stays in the project)">
                    <Trash2 size={14} /> Delete
                  </button>
                )}
              </div>
              {/* Inline under the buttons, the panel's full width (a popover from the right column ran off the panel). */}
              {versionsOpen && sel.history.length > 1 && (
                <div className="doc-versions">
                  {[...sel.history].reverse().map((v) => (
                    <button key={v} className={`doc-version ${v === sel.source ? "on" : ""}`} onClick={() => patchLayer(sel.id, { source: v })} title={v === sel.source ? "Shown now" : "Show this version"}>
                      <img src={urls.source(v)} alt="" />
                      <span>v{sel.history.indexOf(v) + 1}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <p className="layers-help doc-none">Select a layer (here or on the image) to edit it with the prompt below. Shift+click selects more; the pencil (P) draws new objects.</p>
          )}

        </aside>
      </div>

      {blendRows && <BlendChoice rows={blendRows} onChange={(id, r) => setBlendRows((rows) => rows && rows.map((x) => (x.id === id ? { ...x, reading: r } : x)))} onBlend={() => void sendBlend()} onCancel={cancelBlend} />}
      <div className={`editor-tools ${shadowing ? "locked" : ""}`}>
        <div className="group">
          <IconButton title="Select and move (V)" active={tool === "move" && !spacePressed} onClick={() => setTool("move")}>
            <MousePointer2 size={17} />
          </IconButton>
          <IconButton title="Pan (H) · or hold Space" active={tool === "pan" || spacePressed} onClick={() => setTool((t) => (t === "pan" ? "move" : "pan"))}>
            <Hand size={17} />
          </IconButton>
          <IconButton title="Eraser (E): erase part of the selected layer (an object or a shadow)" active={tool === "erase" && !spacePressed} onClick={() => setTool("erase")}>
            <Eraser size={17} />
          </IconButton>
          <IconButton title="Shadow brush (B): paint soft shadow on the selected shadow layer" active={tool === "shade" && !spacePressed} onClick={() => setTool("shade")}>
            <Brush size={17} />
          </IconButton>
          <IconButton title="Pencil (P): draw where a new object goes, one colour per object" active={tool === "sketch" && !spacePressed} onClick={() => setTool("sketch")}>
            <Pencil size={17} />
          </IconButton>
          {maskTint && (
            <IconButton title="Area brush (A): change the pink area of the next edit · right-click takes out" active={tool === "area" && !spacePressed} onClick={() => setTool("area")}>
              <Paintbrush size={17} />
            </IconButton>
          )}
        </div>
        {tool === "sketch" && (
          <div className="group">
            {MARK_COLOURS.map((c) => (
              <button key={c.name} className={`doc-colour ${markColour === c.name ? "on" : ""}`} style={{ background: c.css }} title={`${c.name[0].toUpperCase()}${c.name.slice(1)}: one object`} aria-label={c.name} onClick={() => setMarkColour(c.name)} />
            ))}
          </div>
        )}
        {(tool === "erase" || tool === "shade" || tool === "sketch" || areaOn) && (
          <div className="group">
            <label className="slider" title="Brush size ( [ and ] )">
              Size
              <input type="range" min={4} max={400} value={brush} onChange={(e) => setBrush(() => Number(e.target.value))} />
            </label>
          </div>
        )}
        <div className="group">
          <IconButton title={`Undo (${shortcut("Z")})`} onClick={() => (tool === "area" && areaStep(true)) || undo()} disabled={!undoStack.current.length && !(tool === "area" && areaUndo.current.length)}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton title={`Redo (${shortcut("Y")})`} onClick={() => (tool === "area" && areaStep(false)) || redo()} disabled={!redoStack.current.length && !(tool === "area" && areaRedo.current.length)}>
            <Redo2 size={17} />
          </IconButton>
        </div>
        {/* The whole document's commands (the panel on the right is for the selected layer). */}
        <div className="group">
          <button
            className={`pill doc-cmd ${blendStale ? "stale" : ""}`}
            onClick={startBlend}
            disabled={busy || shadowing}
            title={
              blendStale
                ? "Something moved since the blend: its shadows and reflections no longer fit. Blend again (the selected objects, else all)"
                : "Experimental: often does not work yet. The AI reads where each object stands (you can correct it), then redraws the scene with their shadows, reflections on wet or shiny ground, grass round their feet; only that is kept, as the Blend layer (the selected objects, else all)"
            }
          >
            <Sun size={15} /> {blendStale ? "Blend again" : "Blend into scene"}
            <span className="exp-tag">Experimental</span>
          </button>
          {autoShadows && (
            <label className="slider" title="How strong the blend's shadows and reflections are, without making them again (0 %: none, 100 %: as the model made them, 200 %: twice as strong)">
              Strength
              <input type="range" min={0} max={200} step={10} value={strengthShown} onChange={(e) => setStrengthShown(Number(e.target.value))} />
              <span className="doc-cmd-val">{strengthShown}%</span>
            </label>
          )}
          <button className="pill doc-cmd" onClick={exportPsd} disabled={busy || shadowing} title="Save the layers as a Photoshop file (.psd), each one a layer, to open in Photoshop, Photopea, GIMP or Krita">
            <FileDown size={15} /> Export PSD
          </button>
          <button className="pill doc-cmd primary" onClick={flatten} disabled={busy || shadowing}>
            <ImageDown size={15} /> Save as image
          </button>
        </div>
      </div>
    </div>
  );
}
