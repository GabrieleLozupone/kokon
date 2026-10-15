import { Brush, Check, Contrast, Eraser, Hand, Redo2, Trash2, Undo2, X, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { shortcut } from "../lib/platform";
import { focusPrompt, getState, setState, toastError, updateComposer, useStore } from "../lib/store";
import { IconButton } from "./ui";
import { ZoomPan } from "./ZoomPan";

type Op =
  | { kind: "stroke"; erase: boolean; size: number; points: [number, number][] }
  | { kind: "invert" }
  | { kind: "clear" };

/** Mask canvas resolution cap (the backend resizes the mask to the source anyway). */
const MAX_MASK_SIDE = 2048;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

export interface InpaintEditorProps {
  imageSrc?: string;
  imageWidth?: number;
  imageHeight?: number;
  initialMaskInputId?: string;
  onSaveMask?: (blob: Blob) => Promise<void> | void;
  onClose?: () => void;
}

export function InpaintEditor({
  imageSrc,
  imageWidth,
  imageHeight,
  initialMaskInputId,
  onSaveMask,
  onClose,
}: InpaintEditorProps = {}) {
  const ref0 = useStore((s) => s.composer.refs[0]);
  const existingMask = useStore((s) => s.composer.mask);
  const [ops, setOps] = useState<Op[]>([]);
  const [redo, setRedo] = useState<Op[]>([]);
  const [tool, setTool] = useState<"brush" | "eraser" | "pan">("brush");
  const [spacePressed, setSpacePressed] = useState(false);
  const [brush, setBrush] = useState(48); // in screen px
  const [feather, setFeather] = useState(8); // in mask px
  const [busy, setBusy] = useState(false);
  const [showZoomControls, setShowZoomControls] = useState(true);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const current = useRef<Op | null>(null);

  const srcW = imageWidth ?? ref0?.width ?? 1;
  const srcH = imageHeight ?? ref0?.height ?? 1;
  const scale = Math.min(1, MAX_MASK_SIDE / Math.max(srcW, srcH));
  const mw = Math.max(1, Math.round(srcW * scale));
  const mh = Math.max(1, Math.round(srcH * scale));
  const src =
    imageSrc ??
    (ref0 ? (ref0.source.startsWith("gen:") ? urls.gen(ref0.source.slice(4)) : urls.input(ref0.source.slice(6))) : "");

  const isPanningActive = spacePressed || tool === "pan";
  const erase = tool === "eraser";

  // Load an existing mask for re-editing (as a base raster op).
  const baseMask = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const maskId = initialMaskInputId ?? (existingMask && ref0 && existingMask.refKey === ref0.key ? existingMask.inputId : null);
    if (!maskId) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      baseMask.current = img;
      redraw(ops);
    };
    img.src = urls.input(maskId);
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
            d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
            d.data[i + 3] = v;
          }
          t.putImageData(d, 0, 0);
          ctx.drawImage(tmp, 0, 0);
        }
      }
      for (const op of list.slice(lastClear + 1)) render2(ctx, op, mw, mh);
    },
    [mw, mh],
  );

  useEffect(() => redraw(ops), [ops, redraw]);

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

  const onDown = (e: React.PointerEvent) => {
    // If middle click or pan mode active, let event bubble to ZoomPan for panning
    if (e.button === 1 || isPanningActive) return;
    if (e.button !== 0 && e.button !== 2) return;

    e.stopPropagation();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    const isErasing = erase || e.button === 2;
    current.current = { kind: "stroke", erase: isErasing, size: maskBrush(), points: [toMask(e)] };
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) render2(ctx, current.current, mw, mh);
  };

  const onMove = (e: React.PointerEvent, transformScale: number) => {
    if (isPanningActive) {
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
        onClose ? onClose() : setState({ overlay: null });
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
  }, [onClose]);

  const done = async () => {
    const c = canvasRef.current;
    if (!c || (!ref0 && !imageSrc)) return;

    // Export: white = edit on black, feathered.
    const out = document.createElement("canvas");
    out.width = mw;
    out.height = mh;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, mw, mh);
    if (feather > 0) ctx.filter = `blur(${feather / 2}px)`;
    ctx.drawImage(c, 0, 0);
    ctx.filter = "none";

    // Detect empty mask.
    const data = c.getContext("2d")!.getImageData(0, 0, mw, mh).data;
    let any = false;
    for (let i = 3; i < data.length; i += 16) {
      if (data[i] > 16) {
        any = true;
        break;
      }
    }

    if (!any) {
      if (onSaveMask) {
        await onSaveMask(new Blob([]));
      } else {
        updateComposer({ mask: null });
      }
      onClose ? onClose() : setState({ overlay: null });
      return;
    }

    setBusy(true);
    try {
      const blob: Blob = await new Promise((res, rej) =>
        out.toBlob((b) => (b ? res(b) : rej(new Error("export failed"))), "image/png"),
      );
      if (onSaveMask) {
        await onSaveMask(blob);
      } else {
        const rec = await api.upload(blob, "mask.png");
        const refKey = getState().composer.refs[0]?.key;
        if (refKey) updateComposer({ mask: { inputId: rec.id, refKey }, outpaint: null, mode: "auto" });
      }
      onClose ? onClose() : setState({ overlay: null });
      focusPrompt();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!ref0 && !imageSrc) {
      onClose ? onClose() : setState({ overlay: null });
    }
  }, [ref0, imageSrc, onClose]);

  const contentSize = useMemo(() => ({ width: srcW, height: srcH }), [srcW, srcH]);

  if (!ref0 && !imageSrc) return null;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Paint the area to change</h2>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => (onClose ? onClose() : setState({ overlay: null }))}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="editor-stage">
        <ZoomPan
          contentSize={contentSize}
          resetKey={src}
          showControls={showZoomControls}
          enableToggleZoom={false}
          enablePan={isPanningActive}
          className="inpaint-zoom-viewport"
        >
          {({ transform, isPanning }) => (
            <div
              className="mask-wrap"
              style={{
                width: srcW,
                height: srcH,
                cursor: isPanningActive ? (isPanning ? "grabbing" : "grab") : "none",
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              <img
                ref={imgRef}
                src={src}
                alt=""
                draggable={false}
                style={{ width: "100%", height: "100%", display: "block" }}
              />
              <canvas
                ref={canvasRef}
                width={mw}
                height={mh}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  cursor: isPanningActive ? (isPanning ? "grabbing" : "grab") : "none",
                }}
                onPointerDown={onDown}
                onPointerMove={(e) => onMove(e, transform.scale)}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={() => setCursor(null)}
              />
              {cursor && !isPanningActive && (
                <div
                  className="brush-cursor"
                  style={{
                    left: cursor.x,
                    top: cursor.y,
                    width: brush / transform.scale,
                    height: brush / transform.scale,
                  }}
                />
              )}
            </div>
          )}
        </ZoomPan>
      </div>

      <div className="editor-tools">
        <div className="group">
          <IconButton
            title="Brush (B)"
            active={tool === "brush" && !spacePressed}
            onClick={() => setTool("brush")}
          >
            <Brush size={17} />
          </IconButton>
          <IconButton
            title="Eraser (E)"
            active={tool === "eraser" && !spacePressed}
            onClick={() => setTool("eraser")}
          >
            <Eraser size={17} />
          </IconButton>
          <IconButton
            title="Pan / Hand (H or hold Space)"
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
          <label className="slider" title="Soft edge">
            Feather
            <input type="range" min={0} max={64} value={feather} onChange={(e) => setFeather(Number(e.target.value))} />
          </label>
        </div>

        <div className="group">
          <IconButton title={`Undo (${shortcut("Z")})`} onClick={undo} disabled={!ops.length}>
            <Undo2 size={17} />
          </IconButton>
          <IconButton title={`Redo (${shortcut("Y")})`} onClick={redoOp} disabled={!redo.length}>
            <Redo2 size={17} />
          </IconButton>
          <IconButton title="Invert mask" onClick={() => push({ kind: "invert" })}>
            <Contrast size={17} />
          </IconButton>
          <IconButton title="Clear mask" onClick={() => push({ kind: "clear" })}>
            <Trash2 size={17} />
          </IconButton>
        </div>

        <div className="group">
          <IconButton
            title={showZoomControls ? "Hide zoom controls" : "Show zoom controls"}
            active={showZoomControls}
            onClick={() => setShowZoomControls((v) => !v)}
          >
            <ZoomIn size={17} />
          </IconButton>
        </div>

        <button className="btn primary" onClick={done} disabled={busy}>
          <Check size={15} /> Done
        </button>
      </div>
    </div>
  );
}

/** Draws a single operation incrementally (no clearing). */
function render2(ctx: CanvasRenderingContext2D, op: Op, w: number, h: number) {
  if (op.kind === "clear") {
    ctx.clearRect(0, 0, w, h);
    return;
  }
  if (op.kind === "invert") {
    ctx.globalCompositeOperation = "xor";
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
    return;
  }
  ctx.globalCompositeOperation = op.erase ? "destination-out" : "source-over";
  ctx.strokeStyle = "#fff";
  ctx.fillStyle = "#fff";
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
