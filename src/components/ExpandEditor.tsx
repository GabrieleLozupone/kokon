import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, Lock, LockOpen, Maximize, RotateCcw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { urls } from "../lib/api";
import { LONG_SIDE_PRESETS, aspectLabel, expandToRatio, expandToSize, expansionPixels, expansionPreset, parseRatio, placeInCanvas, sizeForLongSide } from "../lib/logic";
import { closeEditor, focusPrompt, updateComposer, useStore } from "../lib/store";
import type { OutpaintSpec, Units } from "../lib/types";
import { AspectGrid, RatioIcon } from "./SizeMenus";
import { IconButton, Popover, Seg } from "./ui";

type Side = "left" | "right" | "top" | "bottom";
const MAX_FINAL = 16384;

const LOCK_KEY = "kokon.expandRatioLock";
const loadLock = () => {
  try {
    return localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
  }
};

/** Exact final size: each side can only grow (an expansion never crops). With the lock on,
 * typing one side sets the other to the ratio the fields had when it was locked (#42). */
function SizeForm(props: { w: number; h: number; minW: number; minH: number; onApply: (w: number, h: number) => void }) {
  const [w, setW] = useState(props.w);
  const [h, setH] = useState(props.h);
  const [lock, setLock] = useState(loadLock);
  const [ratio, setRatio] = useState(props.w / props.h);
  const ok = w >= props.minW && h >= props.minH && w <= MAX_FINAL && h <= MAX_FINAL && (w > props.minW || h > props.minH);
  const toggleLock = () => {
    const on = !lock;
    setLock(on);
    if (on && w > 0 && h > 0) setRatio(w / h);
    try {
      localStorage.setItem(LOCK_KEY, on ? "1" : "0");
    } catch {
      // the lock just isn't remembered
    }
  };
  const typeW = (v: number) => {
    setW(v);
    if (lock && v > 0) setH(Math.round(v / ratio));
  };
  const typeH = (v: number) => {
    setH(v);
    if (lock && v > 0) setW(Math.round(v * ratio));
  };
  // Screen presets keep the fields' ratio; one smaller than the image can't be reached.
  const presets = LONG_SIDE_PRESETS.map((p) => ({ ...p, size: sizeForLongSide(w > 0 && h > 0 ? w / h : ratio, p.long) }));
  return (
    <div className="expand-size">
      <span className="pair">
        <input className="input" type="number" min={props.minW} max={MAX_FINAL} value={w} onChange={(e) => typeW(Math.round(Number(e.target.value) || 0))} onKeyDown={(e) => e.key === "Enter" && ok && props.onApply(w, h)} aria-label="Final width" />
        <span className="muted">×</span>
        <input className="input" type="number" min={props.minH} max={MAX_FINAL} value={h} onChange={(e) => typeH(Math.round(Number(e.target.value) || 0))} onKeyDown={(e) => e.key === "Enter" && ok && props.onApply(w, h)} aria-label="Final height" />
        <button className={`icon-btn sm ${lock ? "active" : ""}`} onClick={toggleLock} aria-pressed={lock} title={lock ? "Ratio locked: changing one side changes the other" : "Lock the ratio"}>
          {lock ? <Lock size={14} /> : <LockOpen size={14} />}
        </button>
      </span>
      <span className="size-presets">
        {presets.map((p) => (
          <button
            key={p.label}
            className={p.size.width === w && p.size.height === h ? "on" : ""}
            disabled={p.size.width < props.minW || p.size.height < props.minH}
            onClick={() => (setW(p.size.width), setH(p.size.height))}
            title={`${p.size.width}×${p.size.height}`}
          >
            {p.label}
          </button>
        ))}
      </span>
      {w > 0 && h > 0 && (
        <span className="ratio-tag">
          <RatioIcon ratio={w / h} size={14} />
          {aspectLabel(w, h)}
        </span>
      )}
      <span className="muted">
        At least {props.minW}×{props.minH} (the image itself); the image starts centred: drag it, or use the grid, to place it.
      </span>
      <button className="btn" disabled={!ok} onClick={() => props.onApply(w, h)}>
        Use this size
      </button>
    </div>
  );
}

/** How far the canvas (`size` px of a view `room` px) moves from the centre while `pin`'s side is
 * dragged: its opposite edge stays at `pin.at`, as far as the view allows. */
function pinShift(pin: { side: Side; at: number } | null, axis: "x" | "y", size: number, room: number): number {
  if (!pin || (axis === "x") !== (pin.side === "left" || pin.side === "right")) return 0;
  const start = pin.side === "right" || pin.side === "bottom" ? pin.at : pin.at - size;
  const clamped = Math.min(Math.max(start, Math.min(0, room - size)), Math.max(0, room - size));
  return clamped - (room - size) / 2;
}

export function ExpandEditor() {
  const ref0 = useStore((s) => s.composer.refs[0]);
  const initial = useStore((s) => s.composer.outpaint);
  const [spec, setSpec] = useState<OutpaintSpec>(initial ?? { left: 0, right: 0, top: 0, bottom: 0, units: "pixels" });
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ w: 800, h: 600 });
  const [frozenScale, setFrozenScale] = useState<number | null>(null);
  // The side being dragged, and where the canvas's opposite edge was then (px from the view's
  // left/top): it holds still there, slides only once the canvas reaches the window's other edge.
  const [pin, setPin] = useState<{ side: Side; at: number } | null>(null);
  // A side being dragged: `s0` the view's scale when it was grabbed, `pos` the pointer now, `extra`
  // what holding it at the window's edge has added (source px).
  const drag = useRef<{ side: Side; start: number; startVal: number; s0: number; pos: number; extra: number; moved: boolean } | null>(null);
  const raf = useRef(0);
  const liveScale = useRef(1);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  // Moving the image inside the new canvas: the same final size, the extra space shifted between sides.
  const move = useRef<{ x: number; y: number; px: { left: number; right: number; top: number; bottom: number } } | null>(null);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth - 64, h: el.clientHeight - 48 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!ref0) closeEditor();
  }, [ref0]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeEditor();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!ref0) return null;

  const W = ref0.width;
  const H = ref0.height;
  const px = expansionPixels(spec, W, H);
  const finalW = W + px.left + px.right;
  const finalH = H + px.top + px.bottom;
  const fitScale = Math.min(stage.w / finalW, stage.h / finalH, 1.5);
  // Dragging a side: the view keeps its scale while the canvas fits, and shrinks smoothly once it
  // reaches the window's edge (zooming out at the grab was a jarring jump, 11-04).
  const scale = frozenScale ?? (drag.current ? Math.min(fitScale, drag.current.s0) : fitScale);
  liveScale.current = scale;
  const src = ref0.source.startsWith("gen:") ? urls.gen(ref0.source.slice(4)) : urls.input(ref0.source.slice(6));

  const toUnits = (pixels: number, side: Side) => {
    if (spec.units === "pixels") return Math.max(0, Math.round(pixels));
    const base = side === "left" || side === "right" ? W : H;
    return Math.max(0, Math.round((pixels / base) * 1000) / 10);
  };
  const setSide = (side: Side, v: number) => setSpec((s) => ({ ...s, [side]: Math.max(0, Number.isFinite(v) ? v : 0) }));

  /** The dragged side's size: the pointer's way out (at the scale it was grabbed at) plus what
   * holding it at the edge added, snapped to 8 px. */
  const applyDrag = (d: NonNullable<typeof drag.current>) => {
    const delta = (d.pos - d.start) / d.s0;
    const outward = (d.side === "left" || d.side === "top" ? -delta : delta) + d.extra;
    setSide(d.side, toUnits(Math.max(0, Math.round((d.startVal + outward) / 8) * 8), d.side));
  };
  const onHandleDown = (side: Side) => (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const cw0 = finalW * scale;
    const ch0 = finalH * scale;
    setPin({ side, at: side === "right" ? (stage.w - cw0) / 2 : side === "left" ? (stage.w + cw0) / 2 : side === "bottom" ? (stage.h - ch0) / 2 : (stage.h + ch0) / 2 });
    const pos = side === "left" || side === "right" ? e.clientX : e.clientY;
    const d = { side, start: pos, startVal: px[side], s0: scale, pos, extra: 0, moved: false };
    drag.current = d;
    // Held at the window's edge (or past it), the side keeps growing, faster the further out the
    // pointer is: no letting go and grabbing again to go on.
    let last = performance.now();
    const loop = (now: number) => {
      if (drag.current !== d) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const r = stageRef.current?.getBoundingClientRect();
      if (r && d.moved) {
        const edge = 28;
        const over = side === "right" ? d.pos - (r.right - edge) : side === "left" ? r.left + edge - d.pos : side === "bottom" ? d.pos - (r.bottom - edge) : r.top + edge - d.pos;
        if (over > 0) {
          d.extra += ((160 + 8 * over) * dt) / liveScale.current;
          applyDrag(d);
        }
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
  };
  const onImageDown = (e: React.PointerEvent) => {
    if (px.left + px.right + px.top + px.bottom === 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setFrozenScale(scale);
    move.current = { x: e.clientX, y: e.clientY, px };
  };
  const onHandleMove = (e: React.PointerEvent) => {
    const m = move.current;
    if (m) {
      applyPixels(placed(m.px, m.px.left + (e.clientX - m.x) / (frozenScale ?? scale), m.px.top + (e.clientY - m.y) / (frozenScale ?? scale)));
      return;
    }
    const d = drag.current;
    if (!d) return;
    d.pos = d.side === "left" || d.side === "right" ? e.clientX : e.clientY;
    if (Math.abs(d.pos - d.start) > 4) d.moved = true;
    applyDrag(d);
  };
  const onHandleUp = () => {
    cancelAnimationFrame(raf.current);
    drag.current = null;
    move.current = null;
    setFrozenScale(null);
    setPin(null);
  };
  const placed = (p: typeof px, left: number, top: number): OutpaintSpec => placeInCanvas(p, left, top);
  // Where the image sits: 0 = left/top, 0.5 = centre, 1 = right/bottom (the 3x3 grid).
  const exX = px.left + px.right;
  const exY = px.top + px.bottom;
  const anchorAt = (ax: number, ay: number) => applyPixels({ left: Math.round(exX * ax), right: exX - Math.round(exX * ax), top: Math.round(exY * ay), bottom: exY - Math.round(exY * ay), units: "pixels" });
  const anchored = (ax: number, ay: number) => Math.abs(px.left - Math.round(exX * ax)) <= 4 && Math.abs(px.top - Math.round(exY * ay)) <= 4;

  const preset = (k: Parameters<typeof expansionPreset>[0]) => applyPixels(expansionPreset(k, W, H, { ...px, units: "pixels" as Units }));
  const applyPixels = (next: OutpaintSpec) => {
    if (spec.units === "percent") {
      setSpec({ left: toPct(next.left, W), right: toPct(next.right, W), top: toPct(next.top, H), bottom: toPct(next.bottom, H), units: "percent" });
    } else setSpec(next);
  };
  const toPct = (p: number, b: number) => Math.round((p / b) * 1000) / 10;

  const switchUnits = (u: Units) => {
    if (u === spec.units) return;
    if (u === "percent") setSpec({ left: toPct(px.left, W), right: toPct(px.right, W), top: toPct(px.top, H), bottom: toPct(px.bottom, H), units: "percent" });
    else setSpec({ ...px, units: "pixels" });
  };

  const tooBig = finalW > MAX_FINAL || finalH > MAX_FINAL;
  const any = px.left + px.right + px.top + px.bottom > 0;
  const cw = finalW * scale;
  const ch = finalH * scale;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <h2>Expand the image</h2>
        <span className="muted">
          {W}×{H} ({aspectLabel(W, H)}) → <strong className="expand-final">{finalW}×{finalH} ({aspectLabel(finalW, finalH)})</strong>
        </span>
        <span className="spacer" />
        <IconButton title="Cancel (Esc)" onClick={() => closeEditor()}>
          <X size={18} />
        </IconButton>
      </div>
      <div className="editor-stage" ref={stageRef} onPointerMove={onHandleMove} onPointerUp={onHandleUp}>
        <div
          className="expand-area"
          style={{
            width: cw,
            height: ch,
            // While a side is dragged its opposite edge holds still, so the handle follows the
            // pointer (centred, it moved at half its speed).
            transform: `translate(${pinShift(pin, "x", cw, stage.w)}px, ${pinShift(pin, "y", ch, stage.h)}px)`,
          }}
        >
          <div className="expand-canvas" style={{ left: 0, top: 0, width: cw, height: ch }} />
          <div
            className={`expand-src ${any ? "movable" : ""}`}
            style={{ left: px.left * scale, top: px.top * scale, width: W * scale, height: H * scale }}
            onPointerDown={onImageDown}
            title={any ? "Drag to place the image in the new canvas" : undefined}
          >
            <img src={src} alt="" draggable={false} />
          </div>
          <div className="handle h" style={{ left: 0, top: ch / 2 }} onPointerDown={onHandleDown("left")} title="Drag to extend left" />
          <div className="handle h" style={{ left: cw, top: ch / 2 }} onPointerDown={onHandleDown("right")} title="Drag to extend right" />
          <div className="handle v" style={{ left: cw / 2, top: 0 }} onPointerDown={onHandleDown("top")} title="Drag to extend up" />
          <div className="handle v" style={{ left: cw / 2, top: ch }} onPointerDown={onHandleDown("bottom")} title="Drag to extend down" />
        </div>
      </div>
      <div className="editor-tools" style={{ flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
          <div className="group">
            <IconButton title="Extend left" onClick={() => preset("left")}>
              <ArrowLeft size={17} />
            </IconButton>
            <IconButton title="Extend right" onClick={() => preset("right")}>
              <ArrowRight size={17} />
            </IconButton>
            <IconButton title="Extend up" onClick={() => preset("top")}>
              <ArrowUp size={17} />
            </IconButton>
            <IconButton title="Extend down" onClick={() => preset("bottom")}>
              <ArrowDown size={17} />
            </IconButton>
          </div>
          <div className="group">
            <Popover
              className="wide"
              trigger={(open, toggle) => (
                <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Expand to an aspect ratio">
                  <RatioIcon ratio={finalW / finalH} size={15} />
                  {aspectLabel(finalW, finalH)}
                  <ChevronDown size={13} />
                </button>
              )}
            >
              {(close) => (
                <AspectGrid
                  value={aspectLabel(finalW, finalH)}
                  onPick={(r) => {
                    const ratio = parseRatio(r);
                    if (ratio) applyPixels(expandToRatio(W, H, ratio));
                    close();
                  }}
                />
              )}
            </Popover>
            <Popover
              trigger={(open, toggle) => (
                <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Expand to an exact size">
                  <Maximize size={14} />
                  {finalW}×{finalH}
                  <ChevronDown size={13} />
                </button>
              )}
            >
              {(close) => (
                <SizeForm
                  w={finalW}
                  h={finalH}
                  minW={W}
                  minH={H}
                  onApply={(w, h) => {
                    applyPixels(expandToSize(W, H, w, h));
                    close();
                  }}
                />
              )}
            </Popover>
            {/* Where the image goes in the new canvas: the extra space goes to the other sides. */}
            <div className="anchor-grid" role="group" aria-label="Place the image">
              {[0, 0.5, 1].map((ay) =>
                [0, 0.5, 1].map((ax) => (
                  <button
                    key={`${ax}-${ay}`}
                    className={any && anchored(ax, ay) ? "on" : ""}
                    disabled={!any || (exX === 0 && ax !== 0.5) || (exY === 0 && ay !== 0.5)}
                    onClick={() => anchorAt(ax, ay)}
                    title={`Image ${ay === 0 ? "top" : ay === 1 ? "bottom" : ""}${ay !== 0.5 && ax !== 0.5 ? " " : ""}${ax === 0 ? "left" : ax === 1 ? "right" : ""}${ax === 0.5 && ay === 0.5 ? "centred" : ""}: the new space on the ${[ax === 0 ? "right" : ax === 1 ? "left" : exX ? "left and right" : "", ay === 0 ? "bottom" : ay === 1 ? "top" : exY ? "top and bottom" : ""].filter(Boolean).join(", ")}`}
                  >
                    <span />
                  </button>
                )),
              )}
            </div>
            <IconButton title="Reset" onClick={() => setSpec({ left: 0, right: 0, top: 0, bottom: 0, units: spec.units })}>
              <RotateCcw size={17} />
            </IconButton>
          </div>
        </div>
        <div className="expand-fields">
          {(["left", "right", "top", "bottom"] as Side[]).map((s) => (
            <label key={s}>
              {s[0].toUpperCase() + s.slice(1)}
              <input className="num-input" type="number" min={0} step={spec.units === "pixels" ? 8 : 1} value={spec[s]} onChange={(e) => setSide(s, Number(e.target.value))} />
            </label>
          ))}
          <div style={{ width: 120 }}>
            <Seg<Units>
              value={spec.units}
              options={[
                { value: "pixels", label: "px" },
                { value: "percent", label: "%" },
              ]}
              onChange={switchUnits}
            />
          </div>
          <button
            className="btn primary"
            disabled={!any || tooBig}
            title={tooBig ? `Max ${MAX_FINAL}px per side` : undefined}
            onClick={() => {
              updateComposer({ outpaint: spec, mask: null, mode: "auto" });
              closeEditor();
              focusPrompt();
            }}
          >
            <Check size={15} /> Done
          </button>
        </div>
      </div>
    </div>
  );
}
