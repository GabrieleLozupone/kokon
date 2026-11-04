import { Brush, Check, Contrast, Eraser, Hand, Loader2, MousePointerClick, Palette, Redo2, Trash2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { area, dilate, fromLogits, maskOrder, samSelection } from "../lib/layers";
import { withActionVerb } from "../lib/logic";
import { inBrowser, shortcut } from "../lib/platform";
import { Segmenter, type SamResult } from "../lib/sam";
import { MARK_COLOURS, marksPrompt, type MarkColour } from "../lib/sceneEdit";
import { closeEditor, focusPrompt, getState, toastError, toastInfo, updateComposer, useStore } from "../lib/store";
import { IconButton } from "./ui";
import { isTyping } from "./Viewer";
import { ZoomPan } from "./ZoomPan";

// Two ways to say where the change goes. Colours (the default): each thing gets a colour, painted
// over the whole area it should fill, and a few words; the model gets the image with the marks
// drawn on (one reference, no guide copy) and the result is pasted on the unmarked image.
// Area: the classic mask (shown pink), with the prompt and an action (Edit, Remove, Replace, Add).
// In both, Select (SAM) fills a clicked object instead of brushing it.

type Kind = "colours" | "area";

type Op =
  | { kind: "stroke"; erase: boolean; size: number; points: [number, number][]; colour?: MarkColour }
  /** A SAM selection (`w`×`h`, stretched over the mask). */
  | { kind: "blob"; erase: boolean; mask: Uint8Array; w: number; h: number; colour?: MarkColour }
  | { kind: "invert" }
  | { kind: "clear" };

/** Mask canvas resolution cap (the backend resizes the mask to the source anyway). */
const MAX_MASK_SIDE = 2048;
/** Soft edge of the exported mask, in mask px. Brush strokes are never exactly binary, so the
 * service keeps this softness for the blend instead of adding its own. */
const FEATHER = 8;
/** Colours: the area pasted back reaches this far (share of the long side) past the marks, so a
 * thing drawn a little larger than its marks is not cut at the edge. */
const MARKS_MARGIN = 0.015;
/** SAM runs at most at this size (its own masks are 256²; larger only costs memory). */
const SAM_SIDE = 1024;

const KIND_KEY = "kokon.inpaint.kind";
/** One area is shown pink, as in the layers lab (the export is white on black either way). */
const AREA_RGB = [255, 59, 107] as const;
const AREA_CSS = "#ff3b6b";
const cssOf = (c: MarkColour | undefined) => (c ? MARK_COLOURS.find((m) => m.name === c)!.css : AREA_CSS);
/** What each colour asks for, per image (kept while the editor closes). */
const lastWants = new Map<string, Partial<Record<MarkColour, string>>>();

function storedKind(): Kind {
  try {
    return localStorage.getItem(KIND_KEY) === "area" ? "area" : "colours";
  } catch {
    return "colours";
  }
}

export function InpaintEditor() {
  const ref0 = useStore((s) => s.composer.refs[0]);
  const existingMask = useStore((s) => s.composer.mask);
  const fromLab = useStore((s) => s.overlayBack === "layers");
  const [ops, setOps] = useState<Op[]>([]);
  const [redo, setRedo] = useState<Op[]>([]);
  // A mask being edited again keeps its kind; the layers lab has its own pencil, so it opens on Area.
  const [kind, setKindState] = useState<Kind>(() => (existingMask && existingMask.refKey === ref0?.key ? (existingMask.marks ? "colours" : "area") : fromLab ? "area" : storedKind()));
  const [colour, setColour] = useState<MarkColour>("red");
  const [wants, setWantsState] = useState<Partial<Record<MarkColour, string>>>(() => lastWants.get(ref0?.source ?? "") ?? {});
  const [used, setUsed] = useState<MarkColour[]>([]);
  /** Where each colour is on the image (0-1): its box goes there, above it. */
  const [where, setWhere] = useState<Partial<Record<MarkColour, Box>>>({});
  const [tool, setTool] = useState<"brush" | "eraser" | "pan" | "select">("brush");
  const [spacePressed, setSpacePressed] = useState(false);
  // Right button held: the other tool is in use, and the toolbar shows it.
  const [swapped, setSwapped] = useState(false);
  const [brush, setBrush] = useState(48); // in screen px
  const [busy, setBusy] = useState(false);
  const [sam, setSam] = useState<"idle" | "loading" | "ready" | "missing" | "error">("idle");
  // The selection model being downloaded (the first time), in %.
  const [samPct, setSamPct] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const current = useRef<Op | null>(null);
  const segmenter = useRef<Segmenter | null>(null);
  // The last click of Select: the same spot again takes SAM's next output (part -> whole).
  const lastClick = useRef<{ x: number; y: number; result: SamResult; order: number[]; pos: number; op: Op } | null>(null);

  const srcW = ref0?.width ?? 1;
  const srcH = ref0?.height ?? 1;
  const scale = Math.min(1, MAX_MASK_SIDE / Math.max(srcW, srcH));
  const mw = Math.max(1, Math.round(srcW * scale));
  const mh = Math.max(1, Math.round(srcH * scale));
  const samK = Math.min(1, SAM_SIDE / Math.max(mw, mh));
  const sw = Math.max(1, Math.round(mw * samK));
  const sh = Math.max(1, Math.round(mh * samK));
  const src = ref0 ? urls.source(ref0.source) : "";
  // In a browser the picture is drawn flat (ZoomPan `flat`: no image-sized layer, which cost an
  // iPhone ~300 MB on a 4K image) and is the preview until the zoom needs the full image; the
  // mask keeps its own resolution either way, and strokes map through the canvas's on-screen box.
  const preview = ref0 && inBrowser ? urls.sourcePreview(ref0.source) : undefined;

  const isPanningActive = spacePressed || tool === "pan";
  const erase = tool === "eraser";
  const colours = kind === "colours";
  const paint = colours ? colour : undefined;

  const setWants = (w: Partial<Record<MarkColour, string>>) => {
    setWantsState(w);
    if (ref0) lastWants.set(ref0.source, w);
  };

  // Load an existing mask (or marks) for re-editing (as a base raster op).
  const baseMask = useRef<HTMLImageElement | null>(null);
  const baseMarks = useRef(false);
  useEffect(() => {
    if (!existingMask || !ref0 || existingMask.refKey !== ref0.key) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      baseMask.current = img;
      baseMarks.current = !!existingMask.marks;
      redraw(ops);
    };
    img.src = urls.input(existingMask.marks ?? existingMask.inputId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Base mask (if re-editing) + every operation after the last "clear". */
  const redraw = useCallback(
    (list: Op[]) => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, mw, mh);
      const lastClear = list.map((o) => o.kind).lastIndexOf("clear");
      if (baseMask.current && lastClear < 0) {
        if (baseMarks.current) ctx.drawImage(baseMask.current, 0, 0, mw, mh);
        else {
          // Stored masks are grayscale (white = edit): convert luminance to alpha.
          const tmp = document.createElement("canvas");
          tmp.width = mw;
          tmp.height = mh;
          const t = tmp.getContext("2d");
          if (t) {
            t.drawImage(baseMask.current, 0, 0, mw, mh);
            const d = t.getImageData(0, 0, mw, mh);
            for (let i = 0; i < d.data.length; i += 4) {
              const v = d.data[i];
              [d.data[i], d.data[i + 1], d.data[i + 2]] = AREA_RGB;
              d.data[i + 3] = v;
            }
            t.putImageData(d, 0, 0);
            ctx.drawImage(tmp, 0, 0);
          }
        }
      }
      for (const op of list.slice(lastClear + 1)) render2(ctx, op, mw, mh);
    },
    [mw, mh],
  );

  useEffect(() => {
    redraw(ops);
    if (colours) {
      const on = coloursOn(canvasRef.current, mw, mh);
      setUsed(on.used);
      setWhere(on.where);
    }
  }, [ops, redraw, colours, mw, mh]);

  /** Colours <-> Area: the drawing starts again (one kind per request). */
  const setKind = (k: Kind) => {
    if (k === kind) return;
    setKindState(k);
    try {
      localStorage.setItem(KIND_KEY, k);
    } catch {
      /* storage unavailable */
    }
    baseMask.current = null;
    lastClick.current = null;
    setOps([]);
    setRedo([]);
  };

  // SAM loads the first time Select is picked (the image is encoded once), and keeps loading if
  // another tool is picked meanwhile: only closing the editor drops it.
  const samStarted = useRef(false);
  const open = useRef(true);
  useEffect(() => {
    // Set again on mount: StrictMode mounts twice in development.
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  useEffect(() => {
    if (tool !== "select" || samStarted.current || !src) return;
    samStarted.current = true;
    setSam("loading");
    (async () => {
      try {
        const s = await Segmenter.load(true, (pct) => open.current && setSamPct(pct));
        if (!open.current) return;
        setSamPct(null);
        if (!s) return setSam("missing");
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.src = src;
        await img.decode();
        await s.encode(img, sw, sh);
        if (!open.current) return;
        segmenter.current = s;
        setSam("ready");
      } catch (e) {
        console.error(e);
        if (open.current) setSam("error");
      }
    })();
  }, [tool, src, sw, sh]);

  const toMask = (e: React.PointerEvent): [number, number] => {
    const c = canvasRef.current;
    if (!c) return [0, 0];
    const r = c.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return [0, 0];
    const x = Math.min(mw, Math.max(0, ((e.clientX - r.left) / r.width) * mw));
    const y = Math.min(mh, Math.max(0, ((e.clientY - r.top) / r.height) * mh));
    return [x, y];
  };

  const maskBrush = () => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return (brush * mw) / Math.max(1, srcW);
    return (brush / r.width) * mw;
  };

  /** Select: the object under the click fills (or, `remove`, leaves) the drawing. */
  const select = async (x: number, y: number, remove: boolean) => {
    const s = segmenter.current;
    if (!s) {
      toastInfo(sam === "missing" ? "The selection model could not be downloaded: paint with the brush." : samPct != null ? `Downloading the selection model… ${samPct}%` : sam === "error" ? "The selection model could not start: paint with the brush." : "The selection model is still getting ready.");
      return;
    }
    const prev = lastClick.current;
    const near = prev && Math.hypot(prev.x - x, prev.y - y) < Math.max(mw, mh) * 0.015;
    if (!remove && prev && near && ops[ops.length - 1] === prev.op) {
      const pos = (prev.pos + 1) % prev.order.length;
      const op: Op = { kind: "blob", erase: false, mask: samSelection(prev.result.masks[prev.order[pos]], sw, sh), w: sw, h: sh, colour: paint };
      lastClick.current = { ...prev, pos, op };
      setOps((o) => [...o.slice(0, -1), op]);
      setRedo([]);
      return;
    }
    setSelecting(true);
    try {
      const result = await s.predict([{ x: x * samK, y: y * samK, label: 1 }], sw, sh);
      const order = maskOrder(
        result.iou,
        result.masks.map((m) => area(fromLogits(m))),
      );
      const op: Op = { kind: "blob", erase: remove, mask: samSelection(result.masks[order[0]], sw, sh), w: sw, h: sh, colour: paint };
      lastClick.current = remove ? null : { x, y, result, order, pos: 0, op };
      setOps((o) => [...o, op]);
      setRedo([]);
    } catch (e) {
      toastError(e);
    } finally {
      setSelecting(false);
    }
  };

  const onDown = (e: React.PointerEvent) => {
    // If middle click or pan mode active, let event bubble to ZoomPan for panning
    if (e.button === 1 || isPanningActive) return;
    if (e.button !== 0 && e.button !== 2) return;

    e.stopPropagation();
    if (tool === "select") {
      // Right click (or Alt): takes the object out.
      const [x, y] = toMask(e);
      if (!selecting) select(x, y, e.button === 2 || e.altKey);
      return;
    }
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    // Right button: the other tool (erases with the brush, paints with the eraser), as in mask editors.
    const isErasing = e.button === 2 ? !erase : erase;
    setSwapped(e.button === 2);
    current.current = { kind: "stroke", erase: isErasing, size: maskBrush(), points: [toMask(e)], colour: paint };
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) render2(ctx, current.current, mw, mh);
  };

  const onMove = (e: React.PointerEvent, transformScale: number) => {
    if (isPanningActive || tool === "select") {
      setCursor(null);
      return;
    }

    const c = canvasRef.current;
    if (c) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCursor({
          x: (e.clientX - r.left) / transformScale,
          y: (e.clientY - r.top) / transformScale,
        });
      }
    }

    const op = current.current;
    if (!op || op.kind !== "stroke") return;
    e.stopPropagation();
    op.points.push(toMask(e));
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) render2(ctx, { ...op, points: op.points.slice(-2) }, mw, mh);
  };

  const onUp = (e: React.PointerEvent) => {
    if (current.current) {
      e.stopPropagation();
      try {
        if ((e.target as HTMLElement).hasPointerCapture(e.pointerId)) {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        }
      } catch {}
      const op = current.current;
      current.current = null;
      setSwapped(false);
      setOps((o) => [...o, op]);
      setRedo([]);
    }
  };

  const undo = () => {
    setOps((o) => {
      if (!o.length) return o;
      setRedo((r) => [...r, o[o.length - 1]]);
      return o.slice(0, -1);
    });
  };

  const redoOp = () => {
    setRedo((r) => {
      if (!r.length) return r;
      setOps((o) => [...o, r[r.length - 1]]);
      return r.slice(0, -1);
    });
  };

  const push = (op: Op) => {
    setOps((o) => [...o, op]);
    setRedo([]);
  };

  // Keyboard navigation, shortcuts, and spacebar-hold pan detection
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;

      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        setSpacePressed(true);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redoOp() : undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoOp();
      } else if (e.key === "Escape") {
        closeEditor();
      } else if (e.key === "[") {
        setBrush((b) => Math.max(4, b - 8));
      } else if (e.key === "]") {
        setBrush((b) => Math.min(400, b + 8));
      } else if (e.key.toLowerCase() === "b") {
        setTool("brush");
      } else if (e.key.toLowerCase() === "e") {
        setTool((t) => (t === "eraser" ? "brush" : "eraser"));
      } else if (e.key.toLowerCase() === "h") {
        setTool((t) => (t === "pan" ? "brush" : "pan"));
      } else if (e.key.toLowerCase() === "s") {
        setTool((t) => (t === "select" ? "brush" : "select"));
      } else if (e.key >= "1" && e.key <= String(MARK_COLOURS.length)) {
        setColour(MARK_COLOURS[Number(e.key) - 1].name);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        setSpacePressed(false);
      }
    };

    const onBlur = () => {
      setSpacePressed(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const toBlob = (c: HTMLCanvasElement): Promise<Blob> => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"));

  const done = async () => {
    const c = canvasRef.current;
    if (!c || !ref0) return;

    const data = c.getContext("2d")!.getImageData(0, 0, mw, mh).data;
    // Detect empty mask.
    let any = false;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 16) {
        any = true;
        break;
      }
    }

    if (!any) {
      updateComposer({ mask: null });
      closeEditor();
      return;
    }

    // Export: white = edit on black (from the drawing's alpha), feathered. Colours: the marks' area,
    // a little larger.
    const out = document.createElement("canvas");
    out.width = mw;
    out.height = mh;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, mw, mh);
    ctx.filter = `blur(${FEATHER / 2}px)`;
    {
      const a = new Uint8Array(mw * mh);
      for (let i = 0; i < a.length; i++) a[i] = colours ? (data[i * 4 + 3] > 16 ? 255 : 0) : data[i * 4 + 3];
      const grown = colours ? dilate(a, mw, mh, Math.max(4, Math.round(Math.max(mw, mh) * MARKS_MARGIN))) : a;
      const white = document.createElement("canvas");
      white.width = mw;
      white.height = mh;
      const w = white.getContext("2d")!;
      const img = w.createImageData(mw, mh);
      for (let i = 0; i < grown.length; i++) {
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
        img.data[i * 4 + 3] = grown[i];
      }
      w.putImageData(img, 0, 0);
      ctx.drawImage(white, 0, 0);
    }
    ctx.filter = "none";

    setBusy(true);
    try {
      const rec = await api.upload(await toBlob(out), "mask.png");
      const marks = colours ? (await api.upload(await toBlob(c), "marks.png")).id : undefined;
      const refKey = getState().composer.refs[0]?.key;
      if (refKey) {
        // Colours: the prompt names each colour's thing (Prompt+, when on, rewrites it seeing the marks).
        const named = used.some((u) => wants[u]?.trim());
        const prompt = marks && (named || !getState().composer.prompt.trim()) ? marksPrompt(used.map((u) => ({ colour: u, what: wants[u] ?? "" }))) : undefined;
        // Area: the action's words start the prompt (Remove by default), unless something is typed.
        const c0 = getState().composer;
        const verb = !marks && !c0.prompt.trim() ? withActionVerb("", c0.inpaintAction) : undefined;
        updateComposer({ mask: { inputId: rec.id, refKey, ...(marks ? { marks } : {}) }, outpaint: null, mode: "auto", ...(prompt ? { prompt, enhancedFrom: null } : verb ? { prompt: verb, enhancedFrom: null } : {}) });
      }
      closeEditor();
      focusPrompt();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!ref0) closeEditor();
  }, [ref0]);

  const contentSize = useMemo(() => ({ width: srcW, height: srcH }), [srcW, srcH]);

  if (!ref0) return null;

  const selectTitle =
    sam === "missing"
      ? "Select (S): the selection model could not be downloaded (open the editor again to retry)"
      : sam === "loading"
        ? samPct != null
          ? `Select (S): downloading the selection model (44 MB, once)… ${samPct}%`
          : "Select (S): getting the selection model ready…"
        : `Select (S): click an object to ${colours ? "fill it with the colour" : "paint it"} · click again for a bigger part · right-click takes it out`;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>{colours ? "Paint where things go" : "Paint the area to change"}</h2>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => closeEditor()}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="editor-stage">
        <ZoomPan
          contentSize={contentSize}
          resetKey={src}
          enableToggleZoom={false}
          enablePan={isPanningActive}
          className="inpaint-zoom-viewport"
          minimapSrc={ref0 && inBrowser ? urls.sourceThumb(ref0.source) : src}
          flat={inBrowser}
        >
          {({ transform, isPanning, flat, wantsFull }) => {
            // Content px per screen px: the box is laid out at its drawn size when flat.
            const k = flat ? 1 : transform.scale;
            const pointer = isPanningActive ? (isPanning ? "grabbing" : "grab") : tool === "select" ? (selecting ? "progress" : "crosshair") : "none";
            return (
            <div
              className="mask-wrap"
              style={{
                width: flat ? "100%" : srcW,
                height: flat ? "100%" : srcH,
                cursor: pointer,
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <img
                ref={imgRef}
                src={preview && !wantsFull ? preview : src}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
              <canvas
                ref={canvasRef}
                width={mw}
                height={mh}
                className={colours ? "marks" : "area"}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  cursor: pointer,
                }}
                onPointerDown={onDown}
                onPointerMove={(e) => onMove(e, k)}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => setCursor(null)}
              />
              {/* What goes at each colour, on the image above its area (below when that is at the top). */}
              {colours &&
                used.map((c) => {
                  const b = where[c];
                  if (!b) return null;
                  const below = b.y0 < 0.1;
                  return (
                    <label
                      key={c}
                      className="marks-want on-stage"
                      style={{
                        left: `${((b.x0 + b.x1) / 2) * 100}%`,
                        top: `${(below ? b.y1 : b.y0) * 100}%`,
                        transform: `translate(-50%, ${below ? "8px" : "calc(-100% - 8px)"}) scale(${1 / k})`,
                        transformOrigin: below ? "top center" : "bottom center",
                      }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <span className="doc-swatch" style={{ background: cssOf(c) }} />
                      <input
                        value={wants[c] ?? ""}
                        placeholder={`What goes here, e.g. “a green velvet armchair”`}
                        onChange={(e) => setWants({ ...wants, [c]: e.target.value })}
                        spellCheck={false}
                      />
                    </label>
                  );
                })}
              {cursor && !isPanningActive && tool !== "select" && (
                <div
                  className="brush-cursor"
                  style={{
                    left: cursor.x,
                    top: cursor.y,
                    width: brush / k,
                    height: brush / k,
                  }}
                />
              )}
            </div>
            );
          }}
        </ZoomPan>
      </div>

      {colours && (
        <div className="marks-panel">
          <p className="marks-help">
            {used.length
              ? "Say what goes at each colour in its box on the image. Works best when the colour fills the whole area the thing should take."
              : "Fill the whole area where something should go, one colour per thing (Select fills an object in one click). The rest of the photo stays as it is."}
          </p>
        </div>
      )}

      <div className="editor-tools">
        {/* How to paint, next to the brush: colours (one per thing) or one area. */}
        <div className="group">
          <span className="seg inpaint-kind" role="radiogroup" aria-label="How to paint">
            <button className={colours ? "on" : ""} role="radio" aria-checked={colours} onClick={() => setKind("colours")} title="One colour per thing to add or change: fill its area, then say what goes there">
              <Palette size={14} /> Colours
            </button>
            <button className={colours ? "" : "on"} role="radio" aria-checked={!colours} onClick={() => setKind("area")} title="One area and a prompt (edit, remove, replace or add)">
              <Brush size={14} /> One area
            </button>
          </span>
        </div>
        {colours && (
          <div className="group marks-colours" role="radiogroup" aria-label="Colour">
            {MARK_COLOURS.map((m, i) => (
              <button
                key={m.name}
                className={`doc-colour ${colour === m.name ? "on" : ""}`}
                style={{ background: m.css }}
                role="radio"
                aria-checked={colour === m.name}
                aria-label={m.name}
                title={`${m.name[0].toUpperCase()}${m.name.slice(1)} (${i + 1})`}
                onClick={() => setColour(m.name)}
              />
            ))}
          </div>
        )}
        <div className="group">
          <IconButton
            title={colours ? "Brush (B): fill the area · right-click erases" : "Brush (B) · right-click erases"}
            active={tool !== "select" && (swapped ? tool === "eraser" : tool === "brush") && !spacePressed}
            onClick={() => setTool("brush")}
          >
            <Brush size={17} />
          </IconButton>
          <IconButton title={selectTitle} active={tool === "select" && !spacePressed} onClick={() => setTool((t) => (t === "select" ? "brush" : "select"))} disabled={sam === "missing"}>
            {sam === "loading" || selecting ? <Loader2 size={17} className="spin" /> : <MousePointerClick size={17} />}
          </IconButton>
          <IconButton
            title="Eraser (E) · right-click paints"
            active={tool !== "select" && (swapped ? tool === "brush" : tool === "eraser") && !spacePressed}
            onClick={() => setTool("eraser")}
          >
            <Eraser size={17} />
          </IconButton>
          <IconButton
            title="Move (H) · or drag with the middle button, or hold Space"
            active={tool === "pan" || spacePressed}
            onClick={() => setTool((t) => (t === "pan" ? "brush" : "pan"))}
          >
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
          <IconButton title={`Undo (${shortcut("Z")})`} onClick={undo} disabled={!ops.length}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton title={`Redo (${shortcut("Y")})`} onClick={redoOp} disabled={!redo.length}>
            <Redo2 size={17} />
          </IconButton>
          {!colours && (
            <IconButton title="Invert mask" onClick={() => push({ kind: "invert" })}>
              <Contrast size={17} />
            </IconButton>
          )}
          <IconButton title={colours ? "Clear the colours" : "Clear mask"} onClick={() => push({ kind: "clear" })}>
            <Trash2 size={17} />
          </IconButton>
        </div>

        <button className="btn primary" onClick={done} disabled={busy}>
          <Check size={15} /> Done
        </button>
      </div>
    </div>
  );
}

type Box = { x0: number; y0: number; x1: number; y1: number };

/** The mark colours on the canvas and the box of each (0-1 of the image; sampled, an opaque pixel goes
 * to the nearest colour). */
function coloursOn(c: HTMLCanvasElement | null, w: number, h: number): { used: MarkColour[]; where: Partial<Record<MarkColour, Box>> } {
  const ctx = c?.getContext("2d");
  const where: Partial<Record<MarkColour, Box>> = {};
  if (!ctx) return { used: [], where };
  const d = ctx.getImageData(0, 0, w, h).data;
  const seen = new Set<MarkColour>();
  for (let i = 0; i < d.length; i += 4 * 7) {
    if (d[i + 3] < 200) continue;
    let best: (typeof MARK_COLOURS)[number] = MARK_COLOURS[0];
    let bd = Infinity;
    for (const m of MARK_COLOURS) {
      const dd = (d[i] - m.rgb[0]) ** 2 + (d[i + 1] - m.rgb[1]) ** 2 + (d[i + 2] - m.rgb[2]) ** 2;
      if (dd < bd) [best, bd] = [m, dd];
    }
    seen.add(best.name);
    const x = ((i / 4) % w) / w;
    const y = ((i / 4 / w) | 0) / h;
    const b = (where[best.name] ??= { x0: x, y0: y, x1: x, y1: y });
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.y0 = Math.min(b.y0, y);
    b.y1 = Math.max(b.y1, y);
  }
  return { used: MARK_COLOURS.map((m) => m.name).filter((n) => seen.has(n)), where };
}

/** A selection as a canvas in its colour (made once per selection). */
const blobCanvas = new WeakMap<Uint8Array, HTMLCanvasElement>();
function blobOf(op: Extract<Op, { kind: "blob" }>): HTMLCanvasElement {
  let c = blobCanvas.get(op.mask);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = op.w;
  c.height = op.h;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(op.w, op.h);
  const rgb = op.colour ? MARK_COLOURS.find((m) => m.name === op.colour)!.rgb : AREA_RGB;
  for (let i = 0; i < op.mask.length; i++) {
    if (!op.mask[i]) continue;
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  blobCanvas.set(op.mask, c);
  return c;
}

/** Draws a single operation incrementally (no clearing). */
function render2(ctx: CanvasRenderingContext2D, op: Op, w: number, h: number) {
  if (op.kind === "clear") {
    ctx.clearRect(0, 0, w, h);
    return;
  }
  if (op.kind === "invert") {
    ctx.globalCompositeOperation = "xor";
    ctx.fillStyle = AREA_CSS;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    return;
  }
  ctx.globalCompositeOperation = op.erase ? "destination-out" : "source-over";
  if (op.kind === "blob") {
    // Stretched smooth (a stepped edge otherwise); the colour stays solid, only the edge's alpha softens.
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(blobOf(op), 0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    return;
  }
  ctx.strokeStyle = cssOf(op.colour);
  ctx.fillStyle = cssOf(op.colour);
  ctx.lineWidth = op.size;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const p = op.points;
  ctx.beginPath();
  if (p.length === 1) {
    ctx.arc(p[0][0], p[0][1], op.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = "source-over";
}
