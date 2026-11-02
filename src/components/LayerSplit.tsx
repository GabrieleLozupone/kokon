// Layers lab (experimental, branch feature/layers), step 1: the user puts the objects of an image
// into layers by clicking them (MobileSAM in the webview, lib/sam.ts) or painting them, and "Split"
// saves each layer cut from the photo (transparent elsewhere) and the background with transparent
// holes where the layers were, as new versions of the project, and opens them as a layer document
// (LayerDoc.tsx). Filling the holes or completing a cut object is done by hand with the usual
// edits, to see what works before building the real feature.

import { Brush, ChevronDown, ChevronUp, Eraser, Eye, EyeOff, Hand, Layers, MousePointerClick, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { addTo, area, dilate, fileSafe, fromLogits, maskOrder, refineEdges, removeFrom, samSelection, union, type Mask } from "../lib/layers";
import { shortcut } from "../lib/platform";
import { Segmenter, type SamResult } from "../lib/sam";
import type { DocLayer, LayerDoc } from "../lib/layerDoc";
import { addVersions, setState, toastError, toastInfo, useStore } from "../lib/store";
import type { InputRecord } from "../lib/types";
import { SplitChoice, type StickerMode } from "./SplitChoice";
import { IconButton } from "./ui";
import { isTyping } from "./Viewer";
import { ZoomPan } from "./ZoomPan";

const STICKERS_KEY = "kokon.layers.stickers";

/** Mask resolution cap. SAM's own masks are 256² for the whole image; the split refines the edges
 * on the photo at this size (refineEdges), so it is the edge's resolution up to 2K. */
const MAX_MASK_SIDE = 2048;
const COLORS = ["#ff3b6b", "#2f9bff", "#ffb020", "#22c55e", "#a855f7", "#14b8a6", "#f97316", "#e11d48"];
const MAX_UNDO = 30;

interface LayerInfo {
  id: string;
  name: string;
  color: string;
  hidden: boolean;
}

interface Change {
  before: Map<string, Mask>;
  after: Map<string, Mask>;
}

/** The last click with the Select tool: clicking the same spot again cycles SAM's outputs. */
interface LastClick {
  x: number;
  y: number;
  layer: string;
  result: SamResult;
  order: number[];
  pos: number;
  change: Change;
}

type Tool = "select" | "brush" | "eraser" | "pan";
type View = "layers" | "background" | "layer";
type SamState = "loading" | "encoding" | "ready" | "missing" | "error";

let nextId = 1;
const newLayer = (n: number): LayerInfo => ({ id: `l${nextId++}`, name: `Layer ${n}`, color: COLORS[(n - 1) % COLORS.length], hidden: false });

const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("The image could not be loaded."));
    img.src = src;
  });
}

/** A mask as a white canvas with that alpha, to scale onto the full image. */
function maskCanvas(m: Mask, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  const d = ctx.createImageData(w, h);
  for (let i = 0; i < m.length; i++) {
    d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = 255;
    d.data[i * 4 + 3] = m[i];
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"));

/** `onSplit`: the new layer document; `onBack`: back to the open document (none: close). */
export function LayerSplit({ onSplit, onBack }: { onSplit: (doc: LayerDoc) => void; onBack?: () => void }) {
  const ref0 = useStore((s) => s.composer.refs[0]);
  const srcW = ref0?.width ?? 1;
  const srcH = ref0?.height ?? 1;
  const scale = Math.min(1, MAX_MASK_SIDE / Math.max(srcW, srcH));
  const mw = Math.max(1, Math.round(srcW * scale));
  const mh = Math.max(1, Math.round(srcH * scale));
  const src = ref0 ? urls.source(ref0.source) : "";

  const [layers, setLayers] = useState<LayerInfo[]>(() => [newLayer(1)]);
  const [active, setActive] = useState(() => layers[0].id);
  const [tool, setTool] = useState<Tool>("select");
  const [view, setView] = useState<View>("layers");
  const [brush, setBrush] = useState(40);
  const [margin, setMargin] = useState(3);
  const [grey, setGrey] = useState(false);
  // How the stickers are cleaned after the split, asked when Split is pressed (SplitChoice; the last
  // answer is remembered and offered first): Quality = a Qwen edit per object (the way it was, "on"
  // before 11-02), Fast = a matte from the service, Off = the rough cut-outs.
  const [asking, setAsking] = useState(false);
  const askingRef = useRef(false);
  askingRef.current = asking;
  const [stickers, setStickersState] = useState<StickerMode>(() => {
    try {
      const v = localStorage.getItem(STICKERS_KEY);
      return v === "off" || v === "fast" ? v : "quality";
    } catch {
      return "quality";
    }
  });
  const setStickers = (m: StickerMode) => {
    setStickersState(m);
    try {
      localStorage.setItem(STICKERS_KEY, m);
    } catch {
      /* storage unavailable */
    }
  };
  const [spacePressed, setSpacePressed] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [sam, setSam] = useState<SamState>("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [areas, setAreas] = useState<Record<string, number>>({});
  /** Layers with something in them (the Split button counts them). */
  const usedCount = layers.filter((l) => (areas[l.id] ?? 0) > 0).length;

  const masks = useRef(new Map<string, Mask>());
  const undoStack = useRef<Change[]>([]);
  const redoStack = useRef<Change[]>([]);
  const last = useRef<LastClick | null>(null);
  const segmenter = useRef<Segmenter | null>(null);
  const full = useRef<Promise<HTMLImageElement> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<{ erase: boolean; size: number; points: [number, number][] } | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const activeRef = useRef(active);
  activeRef.current = active;

  const maskOf = useCallback(
    (id: string) => {
      let m = masks.current.get(id);
      if (!m) masks.current.set(id, (m = new Uint8Array(mw * mh)));
      return m;
    },
    [mw, mh],
  );

  const panning = spacePressed || tool === "pan";
  const bump = () => setTick((t) => t + 1);

  // The full image (for SAM and for the split), and SAM's encoding of it.
  useEffect(() => {
    if (!src) return;
    let gone = false;
    full.current = loadImage(src);
    (async () => {
      try {
        const s = await Segmenter.load();
        if (gone) return;
        if (!s) return setSam("missing");
        setSam("encoding");
        await s.encode(await full.current!, mw, mh);
        if (gone) return;
        segmenter.current = s;
        setSam("ready");
      } catch (e) {
        console.error(e);
        if (!gone) setSam("error");
      }
    })();
    return () => {
      gone = true;
    };
  }, [src, mw, mh]);

  /** Runs `mutate` on the masks (top layer first) and records what changed for Undo. */
  const commit = useCallback(
    (mutate: (all: Mask[], ids: string[]) => void): Change | null => {
      const ids = layersRef.current.map((l) => l.id);
      const all = ids.map(maskOf);
      const before = all.map((m) => m.slice());
      mutate(all, ids);
      const change: Change = { before: new Map(), after: new Map() };
      all.forEach((m, k) => {
        const b = before[k];
        for (let i = 0; i < m.length; i++)
          if (m[i] !== b[i]) {
            change.before.set(ids[k], b);
            change.after.set(ids[k], m.slice());
            break;
          }
      });
      if (!change.before.size) return null;
      undoStack.current = [...undoStack.current, change].slice(-MAX_UNDO);
      redoStack.current = [];
      bump();
      return change;
    },
    [maskOf],
  );

  const restore = (m: Map<string, Mask>) => {
    for (const [id, v] of m) if (masks.current.has(id)) masks.current.set(id, v.slice());
  };

  const undo = useCallback(() => {
    const c = undoStack.current.pop();
    if (!c) return;
    restore(c.before);
    redoStack.current.push(c);
    last.current = null;
    bump();
  }, []);

  const redo = useCallback(() => {
    const c = redoStack.current.pop();
    if (!c) return;
    restore(c.after);
    undoStack.current.push(c);
    bump();
  }, []);

  // The overlay: layer colours, or the background / the active layer alone on a checkerboard.
  useEffect(() => {
    const c = canvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const n = mw * mh;
    const img = ctx.createImageData(mw, mh);
    const d = img.data;
    const checker = (i: number) => ((((i % mw) >> 4) + (((i / mw) | 0) >> 4)) & 1 ? 255 : 200);
    const nextAreas: Record<string, number> = {};
    for (const l of layers) nextAreas[l.id] = area(maskOf(l.id)) / n;
    if (view === "layers") {
      const shown = layers.filter((l) => !l.hidden).map((l) => ({ m: maskOf(l.id), c: rgb(l.color), k: l.id === active ? 0.6 : 0.4 }));
      for (let i = 0; i < n; i++) {
        for (const s of shown) {
          const a = s.m[i];
          if (!a) continue;
          d[i * 4] = s.c[0];
          d[i * 4 + 1] = s.c[1];
          d[i * 4 + 2] = s.c[2];
          d[i * 4 + 3] = a * s.k;
          break;
        }
      }
    } else {
      const hole =
        view === "background" ? dilate(union(layers.map((l) => maskOf(l.id)), n), mw, mh, margin) : maskOf(active).map((a) => 255 - a);
      for (let i = 0; i < n; i++) {
        const a = hole[i];
        if (!a) continue;
        d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = checker(i);
        d[i * 4 + 3] = a;
      }
    }
    ctx.putImageData(img, 0, 0);
    setAreas(nextAreas);
  }, [tick, layers, active, view, margin, mw, mh, maskOf]);

  const toMask = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return [0, 0];
    return [Math.min(mw - 1, Math.max(0, ((e.clientX - r.left) / r.width) * mw)), Math.min(mh - 1, Math.max(0, ((e.clientY - r.top) / r.height) * mh))];
  };

  const select = async (x: number, y: number, remove: boolean) => {
    const s = segmenter.current;
    if (!s) {
      toastInfo(sam === "missing" ? "The selection model is not there: paint with the brush." : "The selection model is still getting ready.");
      return;
    }
    const layer = activeRef.current;
    const prev = last.current;
    const near = prev && Math.hypot(prev.x - x, prev.y - y) < Math.max(mw, mh) * 0.015;
    // The same spot again: undo that click and take SAM's next output (part -> whole).
    if (!remove && prev && near && prev.layer === layer && undoStack.current[undoStack.current.length - 1] === prev.change) {
      undo();
      redoStack.current = [];
      const pos = (prev.pos + 1) % prev.order.length;
      const m = samSelection(prev.result.masks[prev.order[pos]], mw, mh);
      const change = commit((all, ids) => addTo(all, ids.indexOf(layer), m, false));
      last.current = change ? { ...prev, pos, change } : null;
      return;
    }
    setBusy("Selecting…");
    try {
      const result = await s.predict([{ x, y, label: 1 }], mw, mh);
      const order = maskOrder(
        result.iou,
        result.masks.map((m) => area(fromLogits(m))),
      );
      const m = samSelection(result.masks[order[0]], mw, mh);
      const change = commit((all, ids) => (remove ? removeFrom(all[ids.indexOf(layer)], m) : addTo(all, ids.indexOf(layer), m, false)));
      last.current = change && !remove ? { x, y, layer, result, order, pos: 0, change } : null;
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  const strokeSize = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    return r && r.width > 0 ? (brush / r.width) * mw : brush;
  };

  /** Draws the stroke's last segment on the overlay, in the layer's colour (or clears it). */
  const drawSegment = (pts: [number, number][], erase: boolean, size: number) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const color = layers.find((l) => l.id === active)?.color ?? "#fff";
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = ctx.fillStyle = color + "99";
    ctx.lineWidth = size;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    if (pts.length === 1) {
      ctx.arc(pts[0][0], pts[0][1], size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(pts[0][0], pts[0][1]);
      ctx.lineTo(pts[1][0], pts[1][1]);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button === 1 || panning || busy) return;
    if (e.button !== 0 && e.button !== 2) return;
    e.stopPropagation();
    const [x, y] = toMask(e);
    if (tool === "select") {
      void select(x, y, e.button === 2 || e.altKey);
      return;
    }
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    const erase = (tool === "eraser") !== (e.button === 2);
    stroke.current = { erase, size: strokeSize(), points: [[x, y]] };
    drawSegment([[x, y]], erase, stroke.current.size);
  };

  const onMove = (e: React.PointerEvent, k: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (r && !panning) setCursor({ x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k });
    const s = stroke.current;
    if (!s) return;
    e.stopPropagation();
    const p = toMask(e);
    drawSegment([s.points[s.points.length - 1], p], s.erase, s.size);
    s.points.push(p);
  };

  const onUp = () => {
    const s = stroke.current;
    if (!s) return;
    stroke.current = null;
    // Rasterize the whole stroke once, then apply it to the masks.
    const c = document.createElement("canvas");
    c.width = mw;
    c.height = mh;
    const ctx = c.getContext("2d")!;
    ctx.strokeStyle = ctx.fillStyle = "#fff";
    ctx.lineWidth = s.size;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    if (s.points.length === 1) {
      ctx.arc(s.points[0][0], s.points[0][1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.moveTo(s.points[0][0], s.points[0][1]);
      for (const p of s.points.slice(1)) ctx.lineTo(p[0], p[1]);
      ctx.stroke();
    }
    const px = ctx.getImageData(0, 0, mw, mh).data;
    const a = new Uint8Array(mw * mh);
    for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3];
    const layer = activeRef.current;
    last.current = null;
    if (!commit((all, ids) => (s.erase ? removeFrom(all[ids.indexOf(layer)], a) : addTo(all, ids.indexOf(layer), a)))) bump();
  };

  const addLayer = () => {
    const l = newLayer(layers.length + 1);
    setLayers((ls) => [l, ...ls]);
    setActive(l.id);
    setView("layers");
  };

  const removeLayer = (id: string) => {
    const rest = layers.filter((l) => l.id !== id);
    if (!rest.length) return;
    masks.current.delete(id);
    // Undo steps that touched it can no longer be replayed in full.
    undoStack.current = undoStack.current.filter((c) => !c.before.has(id));
    redoStack.current = [];
    last.current = null;
    setLayers(rest);
    if (active === id) setActive(rest[0].id);
  };

  const move = (id: string, by: number) =>
    setLayers((ls) => {
      const i = ls.findIndex((l) => l.id === id);
      const j = i + by;
      if (i < 0 || j < 0 || j >= ls.length) return ls;
      const out = ls.slice();
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    });

  const patch = (id: string, p: Partial<LayerInfo>) => setLayers((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));

  /** Split pressed: how to cut the objects out is asked first (SplitChoice). */
  const askSplit = () => {
    if (!layers.some((l) => area(maskOf(l.id)) > 0)) {
      toastInfo("Put something in a layer first: click an object, or paint it.");
      return;
    }
    setAsking(true);
  };

  /** Saves the background and every non-empty layer at the image's full size as new versions; the
   * objects are then cleaned as `mode` says (LayerDoc's sticker queue). */
  const split = async (mode: StickerMode) => {
    setAsking(false);
    setStickers(mode);
    const used = layers.filter((l) => area(maskOf(l.id)) > 0);
    if (!used.length) return;
    setBusy("Splitting…");
    try {
      const img = await full.current!;
      const W = img.naturalWidth;
      const H = img.naturalHeight;
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const ctx = out.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      const made: InputRecord[] = [];
      const save = async (c: HTMLCanvasElement, name: string) => made.push(await api.upload(await toBlob(c), name));
      const cut = (m: Mask, op: GlobalCompositeOperation) => {
        ctx.globalCompositeOperation = "source-over";
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(img, 0, 0);
        ctx.globalCompositeOperation = op;
        ctx.drawImage(maskCanvas(m, mw, mh), 0, 0, W, H);
        ctx.globalCompositeOperation = "source-over";
      };

      // Edges snapped to the photo's and anti-aliased (SAM's own are stepped and carry a sliver of
      // what is behind): a band of ~0.4 % of the side (8 px at 2K) around each edge.
      const g = document.createElement("canvas");
      g.width = mw;
      g.height = mh;
      const gctx = g.getContext("2d")!;
      gctx.drawImage(img, 0, 0, mw, mh);
      const gpx = gctx.getImageData(0, 0, mw, mh).data;
      const gray = new Float32Array(mw * mh);
      for (let i = 0; i < gray.length; i++) gray[i] = (0.2126 * gpx[i * 4] + 0.7152 * gpx[i * 4 + 1] + 0.0722 * gpx[i * 4 + 2]) / 255;
      const band = Math.max(2, Math.round(Math.max(mw, mh) * 0.004));
      const refined = new Map(layers.map((l) => [l.id, area(maskOf(l.id)) ? refineEdges(maskOf(l.id), gray, mw, mh, band) : maskOf(l.id)]));
      const holes = dilate(union([...refined.values()], mw * mh), mw, mh, margin);
      cut(holes, "destination-out");
      await save(out, "Background (holes).png");
      const base = made[0];
      const docLayers: DocLayer[] = [];

      for (const l of used) {
        cut(refined.get(l.id)!, "destination-in");
        const name = fileSafe(l.name);
        await save(out, `${name}.png`);
        const src = `input:${made[made.length - 1].id}`;
        docLayers.push({ id: l.id, name: l.name, source: src, history: [src], hidden: false, base: false, dx: 0, dy: 0, s: 1 });
        if (grey) {
          // On flat grey: the input that let a plain edit complete a cut object (s14, 10-31).
          const g = document.createElement("canvas");
          g.width = W;
          g.height = H;
          const gc = g.getContext("2d")!;
          gc.fillStyle = "#808080";
          gc.fillRect(0, 0, W, H);
          gc.drawImage(out, 0, 0);
          await save(g, `${name} (grey).png`);
        }
      }
      const bg = `input:${base.id}`;
      docLayers.push({ id: "background", name: "Background", source: bg, history: [bg], hidden: false, base: true, dx: 0, dy: 0, s: 1 });
      addVersions(made, 0);
      onSplit({ width: W, height: H, photo: ref0?.source, layers: docLayers, known: made.map((r) => `input:${r.id}`), ...(mode !== "off" && docLayers.some((l) => !l.base) ? { autoClean: mode } : {}) });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || askingRef.current) return;
      const k = e.key.toLowerCase();
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
      } else if ((e.ctrlKey || e.metaKey) && k === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
      } else if ((e.ctrlKey || e.metaKey) && k === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Escape") (onBack ?? (() => setState({ overlay: null })))();
      else if (e.key === "[") setBrush((b) => Math.max(4, b - 8));
      else if (e.key === "]") setBrush((b) => Math.min(400, b + 8));
      else if (k === "s") setTool("select");
      else if (k === "b") setTool("brush");
      else if (k === "e") setTool("eraser");
      else if (k === "h") setTool((t) => (t === "pan" ? "select" : "pan"));
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
  }, [undo, redo, onBack]);

  useEffect(() => {
    if (!ref0) setState({ overlay: null });
  }, [ref0]);

  const contentSize = useMemo(() => ({ width: srcW, height: srcH }), [srcW, srcH]);
  if (!ref0) return null;

  const activeName = layers.find((l) => l.id === active)?.name ?? "";
  const status =
    busy ??
    {
      loading: "Loading the selection model…",
      encoding: "Reading the image…",
      ready: tool === "select" ? `Click an object to add it to “${activeName}” · again on the same spot: bigger part · right-click: take it out` : `Painting “${activeName}”`,
      missing: "Selection model not found (lab-models/mobilesam): paint the layers with the brush",
      error: "The selection model failed to start (see the console): paint the layers with the brush",
    }[sam];
  const brushCursor = tool === "brush" || tool === "eraser";

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Split into layers (lab)</h2>
        <span className="layers-status">{status}</span>
        <span className="spacer" />
        {onBack && (
          <button className="btn" onClick={onBack}>
            Back to the layers
          </button>
        )}
        <IconButton title="Close (Esc)" onClick={() => setState({ overlay: null })}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="layers-body">
        <div className="editor-stage">
          <ZoomPan contentSize={contentSize} resetKey={src} enableToggleZoom={false} enablePan={panning} className="inpaint-zoom-viewport" minimapSrc={src}>
            {({ transform, isPanning }) => {
              const k = transform.scale;
              const cur = panning ? (isPanning ? "grabbing" : "grab") : busy ? "progress" : brushCursor ? "none" : "crosshair";
              return (
                <div className="mask-wrap" style={{ width: srcW, height: srcH, cursor: cur }} onContextMenu={(e) => e.preventDefault()}>
                  <img src={src} alt="" draggable={false} style={{ width: "100%", height: "100%", display: "block" }} />
                  <canvas
                    ref={canvasRef}
                    width={mw}
                    height={mh}
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", cursor: cur }}
                    onPointerDown={onDown}
                    onPointerMove={(e) => onMove(e, k)}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                    onPointerLeave={() => setCursor(null)}
                  />
                  {cursor && brushCursor && !panning && <div className="brush-cursor" style={{ left: cursor.x, top: cursor.y, width: brush / k, height: brush / k }} />}
                </div>
              );
            }}
          </ZoomPan>
        </div>

        <aside className="layers-panel">
          <div className="layers-title">
            <Layers size={15} /> Layers
            <span className="spacer" />
            <button className="btn" onClick={addLayer} title="A new layer on top">
              <Plus size={14} /> New layer
            </button>
          </div>
          {layers.map((l, i) => (
            <div key={l.id} className={`layer-row ${l.id === active ? "on" : ""}`} onClick={() => setActive(l.id)}>
              <span className="swatch" style={{ background: l.color }} />
              <input value={l.name} onChange={(e) => patch(l.id, { name: e.target.value })} spellCheck={false} />
              <span className="layer-pct">{areas[l.id] ? `${Math.max(0.1, areas[l.id] * 100).toFixed(1)}%` : "empty"}</span>
              <IconButton title={l.hidden ? "Show" : "Hide"} onClick={() => patch(l.id, { hidden: !l.hidden })}>
                {l.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconButton>
              <IconButton title="Up" disabled={i === 0} onClick={() => move(l.id, -1)}>
                <ChevronUp size={14} />
              </IconButton>
              <IconButton title="Down" disabled={i === layers.length - 1} onClick={() => move(l.id, 1)}>
                <ChevronDown size={14} />
              </IconButton>
              <IconButton title="Delete layer" disabled={layers.length < 2} onClick={() => removeLayer(l.id)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
          <div className="layer-row bg">
            <span className="swatch" />
            <span>Background: everything else, transparent where the layers are</span>
          </div>

          <div className="layers-view">
            <span>Show</span>
            {(["layers", "background", "layer"] as const).map((v) => (
              <button key={v} className={`btn ${view === v ? "primary" : ""}`} onClick={() => setView(v)}>
                {{ layers: "Layers", background: "Background", layer: "Active" }[v]}
              </button>
            ))}
          </div>
          <label className="layers-opt" title="Grow the background's holes so no edge of the objects stays on it">
            Hole margin
            <input type="range" min={0} max={20} value={margin} onChange={(e) => setMargin(Number(e.target.value))} />
            <span>{margin}</span>
          </label>
          <label className="layers-opt">
            <input type="checkbox" checked={grey} onChange={(e) => setGrey(e.target.checked)} />
            Also save each layer on grey, as extra versions (for "complete the object" edits)
          </label>
          <p className="layers-help">
            A click adds the object to the active layer (never pixels another layer has: right-click it out of that layer first); the brush
            (B) and eraser (E) fix edges and can move pixels between layers. Split saves the background and each layer as new versions and
            opens them as layers: move them, hide them, edit them one by one.
          </p>
        </aside>
      </div>

      <div className="editor-tools">
        <div className="group">
          <IconButton title="Select objects (S) · right-click takes out" active={tool === "select" && !spacePressed} onClick={() => setTool("select")}>
            <MousePointerClick size={17} />
          </IconButton>
          <IconButton title="Brush (B) · right-click erases" active={tool === "brush" && !spacePressed} onClick={() => setTool("brush")}>
            <Brush size={17} />
          </IconButton>
          <IconButton title="Eraser (E) · right-click paints" active={tool === "eraser" && !spacePressed} onClick={() => setTool("eraser")}>
            <Eraser size={17} />
          </IconButton>
          <IconButton title="Move (H) · or hold Space" active={tool === "pan" || spacePressed} onClick={() => setTool((t) => (t === "pan" ? "select" : "pan"))}>
            <Hand size={17} />
          </IconButton>
        </div>
        <div className="group">
          <label className="slider" title="Brush size ( [ and ] )">
            Size
            <input type="range" min={4} max={400} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
          </label>
        </div>
        <div className="group">
          <IconButton title={`Undo (${shortcut("Z")})`} onClick={undo} disabled={!undoStack.current.length}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton title={`Redo (${shortcut("Y")})`} onClick={redo} disabled={!redoStack.current.length}>
            <Redo2 size={17} />
          </IconButton>
        </div>
        <button className="btn primary layers-split-go" onClick={askSplit} disabled={!!busy || !usedCount} title={usedCount ? "Make each layer its own image, then clean the objects' edges" : "Click an object first: it goes into the active layer"}>
          <Layers size={15} /> Split into layers{usedCount ? ` · ${usedCount}` : ""}
        </button>
      </div>
      {asking && <SplitChoice count={usedCount} last={stickers} onPick={(m) => void split(m)} onCancel={() => setAsking(false)} />}
    </div>
  );
}
