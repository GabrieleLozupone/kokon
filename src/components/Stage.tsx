import {
  Brush, ClipboardPaste, Combine, Copy, Download, Ellipsis, Expand, FolderOpen, Heart, ImageUpscale, Info, Loader2, MousePointerClick, Pencil, RefreshCw, RotateCcw, SlidersHorizontal, Square, TextCursorInput, Trash2, Wand2, X, ZoomIn,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import {
  compareBase, composerFromRecord, formatDuration, jobFraction, jobLabel, MAX_UPSCALE_AREA, MAX_UPSCALE_SIDE, MODE_LABEL, pipelineSummary, remainingSeconds, sizeForWidth, upscaleRequest, arcLayout,
  upscalerLabel, upscaleTargets, variationRequest, imageName, type LinkKind, type TimelineLink,
} from "../lib/logic";
import { native } from "../lib/native";
import {
  addAsReference, cancelJob, focusPrompt, getState, itemSource, removeSessionItem, reusePrompt, selectedItem, selectItem, sessionLabels, sessionLinks, setState, submitRequest, toastError, toastInfo, useStore, type SessionItem,
} from "../lib/store";
import type { GenerationRecord, JobView, Mode, Size } from "../lib/types";
import { CompareFrame, CompareFullscreen } from "./Compare";
import { IconButton, Popover, useFit } from "./ui";
import { Fullscreen, FullscreenButton, isTyping, ZoomImage, type ViewerNav } from "./Viewer";
import { ZoomPan } from "./ZoomPan";
import { fileManager, shortcut } from "../lib/platform";

export const MODE_ICON: Record<Mode, React.ReactNode> = {
  auto: <Wand2 size={11} />,
  generate: <Wand2 size={11} />,
  edit: <Pencil size={11} />,
  multi_reference: <Combine size={11} />,
  inpaint: <Brush size={11} />,
  outpaint: <Expand size={11} />,
  upscale: <ImageUpscale size={11} />,
};

const MODE_DOING: Record<Mode, string> = {
  auto: "Working",
  generate: "Creating",
  edit: "Editing",
  multi_reference: "Combining images",
  inpaint: "Inpainting",
  outpaint: "Expanding",
  upscale: "Upscaling",
};

function Empty() {
  return (
    <div className="empty">
      <h1>What should we make?</h1>
      <p>Describe a new image below, or bring one in to edit it.</p>
      <p className="tip">
        Tip: say what the subject is doing and where, like “a monkey dribbling a basketball on an outdoor court”. Short prompts get literal results.{" "}
        <button className="link" onClick={() => setState({ overlay: "prompt-tips" })}>
          More prompt tips
        </button>
      </p>
      <div className="hint">
        <span>
          <MousePointerClick size={14} /> Drop images here
        </span>
        <span>
          <ClipboardPaste size={14} /> Paste with {shortcut("V")}
        </span>
      </div>
    </div>
  );
}

/** A version in progress: the image it starts from, dimmed, with live progress on top. */
function Pending({ job, item, labels }: { job: JobView; item: SessionItem; labels: Record<string, string> }) {
  const o = job.plan?.output;
  const { ref, box } = useFit(o ? o.width / o.height : 1);
  const session = useStore((s) => s.session);
  const frac = jobFraction(job);
  const remain = remainingSeconds(job);
  const canCancel = !["done", "failed", "cancelled"].includes(job.status);
  const src = item.request?.mode === "generate" ? undefined : item.request?.images?.[0];
  const from = src ? session.find((i) => itemSource(i) === src) : undefined;
  const mode = job.plan?.mode;
  // "v3 · Editing v2", "v1 · Creating"
  const title = [imageName(labels[item.key]), mode && `${MODE_DOING[mode]}${from && mode !== "multi_reference" ? ` ${imageName(labels[from.key]).toLowerCase()}` : ""}`].filter(Boolean).join(" · ");
  // The source keeps its own shape inside an expansion; elsewhere it fills the frame.
  const outpaint = item.request?.outpaint;
  return (
    <div className="stage-frame" ref={ref}>
      <div className="pending" style={{ width: box.w, height: box.h }}>
        {src && !outpaint && <img className="pending-src" src={urls.source(src)} alt="" draggable={false} />}
        <div className="pending-info">
          <span className="pending-title">{title}</span>
          <div className={`progress ${frac === null ? "indeterminate" : ""}`}>
            <i style={frac !== null ? { width: `${Math.round(frac * 100)}%` } : undefined} />
          </div>
          <span>
            {jobLabel(job)}
            {o ? ` · ${o.width}×${o.height}` : ""}
            {remain !== null ? ` · ${formatDuration(remain)} left` : ""}
          </span>
          {job.notes.length > 0 && <span className="notes">{job.notes.join(" ")}</span>}
          {canCancel && (
            <button className="btn" onClick={() => cancelJob(job.id)} title="Cancel">
              <Square size={13} /> Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Failed({ job, item }: { job: JobView; item: SessionItem }) {
  const [details, setDetails] = useState(false);
  const req = item.request;
  return (
    <div className="stage-frame">
      <div className="failed">
        <strong>{job.status === "cancelled" ? "Cancelled" : job.error?.message ?? "Generation failed"}</strong>
        {job.error?.suggestion && <span>{job.error.suggestion}</span>}
        <div style={{ display: "flex", gap: 8 }}>
          {req && (
            <button className="btn" onClick={() => (removeSessionItem(item.key), submitRequest(req))}>
              <RotateCcw size={14} /> Try again
            </button>
          )}
          <button className="btn" onClick={() => removeSessionItem(item.key)}>
            <X size={14} /> Dismiss
          </button>
          {job.error?.detail && (
            <button className="btn" onClick={() => setDetails((d) => !d)}>
              <Info size={14} /> Details
            </button>
          )}
        </div>
        {details && <pre className="diag" style={{ maxHeight: 220, textAlign: "left", width: "100%" }}>{job.error?.detail}</pre>}
      </div>
    </div>
  );
}

function InfoPanel({ g }: { g: GenerationRecord }) {
  const pipeline = pipelineSummary(g);
  const rows: [string, string][] = [
    ["Mode", MODE_LABEL[g.mode]],
    ["Size", `${g.width}×${g.height}${g.working_width !== g.width || g.working_height !== g.height ? ` (worked at ${g.working_width}×${g.working_height})` : ""}`],
    ...(pipeline ? ([["Pipeline", pipeline]] as [string, string][]) : []),
    ["Seed", String(g.seed)],
    ["Steps", String(g.steps)],
    ["CFG", String(g.cfg)],
    ["Sampler", `${g.sampler}${g.scheduler ? ` / ${g.scheduler}` : ""}`],
    ...(g.strength != null ? ([["Strength", String(g.strength)]] as [string, string][]) : []),
    ["References", String(g.references.length)],
    ["Model", g.model],
    ["Time", formatDuration(g.duration_ms / 1000)],
    ["Created", new Date(g.created_at).toLocaleString()],
  ];
  return (
    <div style={{ width: 340, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 13, userSelect: "text", maxHeight: 120, overflow: "auto" }}>{g.prompt}</div>
      {g.negative_prompt && <div className="muted">Negative: {g.negative_prompt}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span className="muted">{k}</span>
            <span style={{ userSelect: "text", wordBreak: "break-all" }}>{v}</span>
          </Fragment>
        ))}
      </div>
      {g.notes.length > 0 && <div className="muted">{g.notes.join(" ")}</div>}
      <div className="muted" style={{ wordBreak: "break-all", userSelect: "text" }}>{g.file_path}</div>
    </div>
  );
}

/** Upscale menu: the upscaler model straight on the image (no diffusion). */
function UpscaleMenu(props: { source: string; size: Size; original?: Size | null; parentId?: string | null; close: () => void }) {
  const { width: w, height: h } = props.size;
  const up = useStore((s) => s.status?.upscaler);
  const oldEngine = useStore((s) => !!s.status?.engine?.update_needed);
  const via = up?.available && !oldEngine ? upscalerLabel(up.model) : "Lanczos";
  const [customW, setCustomW] = useState(Math.min(MAX_UPSCALE_SIDE, w * 2));
  const targets = upscaleTargets(w, h, props.original);
  const custom = sizeForWidth(w, h, customW);
  const customOk = custom.width > w && custom.width <= MAX_UPSCALE_SIDE && custom.height <= MAX_UPSCALE_SIDE && custom.width * custom.height <= MAX_UPSCALE_AREA;
  const go = (t: Size) => {
    submitRequest(upscaleRequest(props.source, t, props.parentId));
    props.close();
  };
  return (
    <div style={{ width: 300, padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="muted">{via}: a few seconds, adds no new content.</span>
      {targets.map((t) => (
        <button key={t.key} className="btn" onClick={() => go(t)}>
          {t.label} · {t.width}×{t.height}
        </button>
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          className="input"
          type="number"
          min={w + 1}
          max={MAX_UPSCALE_SIDE}
          style={{ width: 90 }}
          value={customW}
          onChange={(e) => setCustomW(Math.max(64, Math.min(MAX_UPSCALE_SIDE, Math.round(Number(e.target.value) || 0))))}
          aria-label="Custom width"
        />
        <span className="muted" style={{ flex: 1 }}>
          × {custom.height}
        </span>
        <button className="btn" disabled={!customOk} onClick={() => go(custom)}>
          Upscale
        </button>
      </div>
    </div>
  );
}

/** A main action under the image: icon and word (the word hides when the stage is narrow). */
function ActionButton(props: { title: string; icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button className={`act ${props.active ? "active" : ""}`} title={props.title} aria-label={props.label} onClick={props.onClick}>
      {props.icon}
      <span className="act-label">{props.label}</span>
    </button>
  );
}

function UpscaleButton(props: { source: string; size: Size; original?: Size | null; parentId?: string | null }) {
  return (
    <Popover
      placement="top-end"
      trigger={(open, toggle) => <ActionButton title="Upscale: make a larger copy (2×, 4K or a custom size)" icon={<ImageUpscale size={16} />} label="Upscale" onClick={toggle} active={open} />}
    >
      {(close) => <UpscaleMenu {...props} close={close} />}
    </Popover>
  );
}

function MoreMenu({ item, path }: { item: SessionItem; path: string | null }) {
  const g = item.gen;
  return (
    <Popover
      placement="top-end"
      trigger={(open, toggle) => (
        <IconButton title="More" onClick={toggle} active={open}>
          <Ellipsis size={17} />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          {g && (
            <button
              className="opt"
              onClick={() => {
                close();
                const c = getState().composer;
                setState({ composer: { ...composerFromRecord(g, c), mode: "auto" } });
                focusPrompt();
              }}
            >
              <span className="check">
                <SlidersHorizontal size={15} />
              </span>
              <span>Reuse prompt and settings</span>
            </button>
          )}
          {path && (
            <button className="opt" onClick={() => (close(), native.reveal(path).catch(toastError))}>
              <span className="check">
                <FolderOpen size={15} />
              </span>
              <span>Show in {fileManager}</span>
            </button>
          )}
          <button className="opt" onClick={() => (close(), removeSessionItem(item.key))}>
            <span className="check">
              <Trash2 size={15} />
            </span>
            <span>Remove from project</span>
          </button>
        </>
      )}
    </Popover>
  );
}

function GenActions({ item, g, showOriginal }: { item: SessionItem; g: GenerationRecord; showOriginal: boolean }) {
  // Save, copy and "show in folder" act on the image on screen: the result or its pre-upscale original.
  const shownPath = (showOriginal && g.pipeline?.original_path) || g.file_path;
  const original = g.references[0] && g.mode !== "generate" && g.mode !== "upscale" ? { width: g.references[0].width, height: g.references[0].height } : null;
  const [fav, setFav] = useState(g.favorite);
  return (
    <div className="actions">
      {g.prompt && (
        <ActionButton
          title="Reuse prompt: put this prompt back in the box to change it a little. It works on the same image this one was made from; your current settings stay as they are."
          icon={<TextCursorInput size={16} />}
          label="Reuse prompt"
          onClick={() => reusePrompt(g)}
        />
      )}
      {g.request && g.mode !== "upscale" && (
        <ActionButton
          title="Regenerate: same prompt and settings, new seed"
          icon={<RefreshCw size={16} />}
          label="Regenerate"
          onClick={() => {
            const r = variationRequest(g);
            if (r) submitRequest(r);
          }}
        />
      )}
      <UpscaleButton source={`gen:${g.id}`} size={{ width: g.width, height: g.height }} original={original} parentId={g.id} />
      <span className="sep" />
      <IconButton
        title={fav ? "Remove from favorites" : "Favorite"}
        active={fav}
        onClick={async () => {
          try {
            await api.setFavorite(g.id, !fav);
            setFav(!fav);
          } catch (e) {
            toastError(e);
          }
        }}
      >
        <Heart size={17} fill={fav ? "currentColor" : "none"} />
      </IconButton>
      <IconButton
        title={showOriginal ? "Save the original (before upscaling) as…" : "Save as…"}
        onClick={async () => {
          const name = g.file_path.split(/[\\/]/).pop() ?? "image.png";
          const path = await native.saveAs(showOriginal ? name.replace(/(\.\w+)?$/, "-original.png") : name);
          if (!path) return;
          try {
            const r = await api.exportGeneration(g.id, path, showOriginal);
            toastInfo(`Saved ${r.path.split(/[\\/]/).pop()}`);
          } catch (e) {
            toastError(e);
          }
        }}
      >
        <Download size={17} />
      </IconButton>
      <IconButton
        title={showOriginal ? "Copy the original (before upscaling)" : "Copy image"}
        onClick={async () => {
          try {
            await native.copyImage(shownPath);
            toastInfo("Image copied");
          } catch (e) {
            toastError(e);
          }
        }}
      >
        <Copy size={17} />
      </IconButton>
      <Popover
        placement="top-end"
        trigger={(open, toggle) => (
          <IconButton title="Details" onClick={toggle} active={open}>
            <Info size={17} />
          </IconButton>
        )}
      >
        {() => <InfoPanel g={g} />}
      </Popover>
      <MoreMenu item={item} path={shownPath} />
    </div>
  );
}

function InputActions({ item }: { item: SessionItem }) {
  const input = item.input!;
  return (
    <div className="actions">
      <UpscaleButton source={`input:${input.id}`} size={{ width: input.width, height: input.height }} />
      <span className="sep" />
      <MoreMenu item={item} path={input.original_path ?? input.path} />
    </div>
  );
}

/** A result or input fitted to the stage (with zoom and pan support), with controls
 * (toggle zoom controls, full-screen button) in its top-right corner. */
function PlainFrame({
  src,
  alt,
  w,
  h,
  onFullscreen,
  showControls = true,
  onToggleControls,
}: {
  src: string;
  alt: string;
  w: number;
  h: number;
  onFullscreen: () => void;
  showControls?: boolean;
  onToggleControls?: () => void;
}) {
  const contentSize = w > 0 && h > 0 ? { width: w, height: h } : null;
  return (
    <div className="stage-frame">
      <ZoomPan
        src={src}
        alt={alt}
        contentSize={contentSize}
        showControls={showControls}
        overlay={
          <div
            className="stage-overlay-btns"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {onToggleControls && (
              <button
                className={`stage-overlay-btn ${showControls ? "active" : ""}`}
                title={showControls ? "Hide zoom controls" : "Show zoom controls"}
                aria-label="Toggle zoom controls"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleControls();
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <ZoomIn size={15} />
              </button>
            )}
            <FullscreenButton onOpen={onFullscreen} />
          </div>
        }
      />
    </div>
  );
}

/** Under the image: which image this is and what made it, then what you can do with it. */
function StageBar({ item, label, showOriginal, setShowOriginal }: { item: SessionItem; label: string; showOriginal: boolean; setShowOriginal: (on: boolean) => void }) {
  const g = item.gen;
  const w = g?.width ?? item.input!.width;
  const h = g?.height ?? item.input!.height;
  const from = g?.pipeline?.original_path ? g.pipeline.enlarged_from : null;
  const name = item.input?.original_name ? safeDecode(item.input.original_name) : "Imported image";
  return (
    <div className="stage-bar">
      <div className="stage-meta">
        <span className="ver">{imageName(label)}</span>
        {g && <span className="mode">{MODE_LABEL[g.mode]}</span>}
        <span className="stage-prompt" title={g?.prompt ?? name}>
          {g ? g.prompt || (g.mode === "upscale" ? `${g.references[0]?.width ?? "?"}×${g.references[0]?.height ?? "?"} → ${w}×${h}` : "") : name}
        </span>
        {from ? (
          <span className="seg dims-seg" role="radiogroup" aria-label="Which image to show">
            <button className={showOriginal ? "" : "on"} role="radio" aria-checked={!showOriginal} onClick={() => setShowOriginal(false)} title={`The result, enlarged by ${upscalerLabel(g!.pipeline!.enlarged_with)}`}>
              Upscaled {w}×{h}
            </button>
            <button className={showOriginal ? "on" : ""} role="radio" aria-checked={showOriginal} onClick={() => setShowOriginal(true)} title="What the model made, before the upscaler enlarged it">
              Original {from.width}×{from.height}
            </button>
          </span>
        ) : (
          <span className="dims">
            {w}×{h}
          </span>
        )}
      </div>
      {g ? <GenActions key={`actions-${g.id}`} item={item} g={g} showOriginal={showOriginal} /> : <InputActions item={item} />}
    </div>
  );
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Arcs above the thumbnails join a version to the earlier ones it was made from: one level
 * per arc that spans another, `LANE` px apart, rounded corners of `R` px. */
const LANE = 9;
const R = 5;

/** What joins a version to the one before it: a line when it continues from it (dashed for a
 * new seed of it), a break when it starts something new, a plain gap when it comes from
 * other versions (an arc above shows which). */
function Joint({ kind, hot }: { kind: LinkKind; hot: boolean }) {
  if (kind === "start") return <span className="joint break" aria-hidden />;
  if (kind === "branch" || kind === "combine") return <span className="joint gap" aria-hidden />;
  return <span className={`joint link ${kind === "variant" ? "dashed" : ""} ${hot ? "hot" : ""}`} aria-hidden />;
}

function linkText(link: TimelineLink | undefined, labels: Record<string, string>): string {
  if (!link || link.kind === "start") return "";
  const names = link.parents.map((k) => imageName(labels[k]).toLowerCase()).join(" + ");
  return link.kind === "variant" ? `new seed of ${names}` : `from ${names}`;
}

/** The project's versions in order. A version continues the line of the one it was made from;
 * a new image starts a new line; versions made from earlier ones (or from several) are joined
 * to them by arcs. The image the prompt edits carries a pencil. */
function Timeline({ labels, onSelect }: { labels: Record<string, string>; onSelect?: () => void }) {
  const session = useStore((s) => s.session);
  const selected = useStore((s) => s.selected);
  const jobs = useStore((s) => s.jobs);
  const target = useStore((s) => s.composer.refs[0]?.source);
  const boxRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [centers, setCenters] = useState<Record<string, number>>({});
  const [hovered, setHovered] = useState<string | null>(null);
  const links = useMemo(() => sessionLinks(session), [session]);
  // Dragging a thumbnail onto the prompt box adds it to the prompt.
  const drag = useRef<{ key: string; src: string; x0: number; y0: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [ghost, setGhost] = useState<{ src: string; x: number; y: number; over: boolean } | null>(null);
  const overPrompt = (x: number, y: number) => !!document.elementFromPoint(x, y)?.closest(".composer");
  const hintDrop = (on: boolean) => document.querySelector(".composer")?.classList.toggle("drag", on);
  const endDrag = () => {
    drag.current = null;
    setGhost(null);
    hintDrop(false);
  };

  useEffect(() => {
    boxRef.current?.querySelector(".frame.sel")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, session.length]);

  // A timeline wider than the stage scrolls: a thin bar under it, and the mouse wheel moves
  // it sideways (a touchpad's own sideways swipe keeps working).
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setOverflow(box.scrollWidth > box.clientWidth + 1);
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    if (trackRef.current) ro.observe(trackRef.current);
    const wheel = (e: WheelEvent) => {
      if (box.scrollWidth <= box.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      box.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    };
    box.addEventListener("wheel", wheel, { passive: false });
    measure();
    return () => {
      ro.disconnect();
      box.removeEventListener("wheel", wheel);
    };
  }, [session.length > 0]);

  // Thumbnail centres, for the arcs.
  useLayoutEffect(() => {
    const out: Record<string, number> = {};
    trackRef.current?.querySelectorAll<HTMLElement>(".frame").forEach((f) => {
      if (f.dataset.key) out[f.dataset.key] = f.offsetLeft + f.offsetWidth / 2;
    });
    setCenters(out);
  }, [session, labels]);

  if (!session.length) return null;
  const focus = hovered ?? selected;
  const selParents = new Set(focus ? links[focus]?.parents : []);
  const index = new Map(session.map((it, i) => [it.key, i]));
  const arcs = session
    .flatMap((it) => {
      const l = links[it.key];
      if (!l || (l.kind !== "branch" && l.kind !== "combine")) return [];
      return l.parents.map((p) => ({ from: p, to: it.key, hot: it.key === focus || p === focus }));
    })
    .filter((a) => centers[a.from] !== undefined && centers[a.to] !== undefined);
  const places = arcLayout(arcs.map((a) => ({ a: index.get(a.from)!, b: index.get(a.to)! })));
  const band = arcs.length ? 10 + (Math.max(...places.map((p) => p.lane)) + 1) * LANE : 0;
  const arcPath = (x1: number, x2: number, top: number) => {
    const y = band - 1;
    const d = x2 > x1 ? 1 : -1;
    // Up from the source, across at its level, down into the result, with an arrowhead.
    return `M ${x1} ${y} L ${x1} ${top + R} Q ${x1} ${top} ${x1 + d * R} ${top} L ${x2 - d * R} ${top} Q ${x2} ${top} ${x2} ${top + R} L ${x2} ${y} M ${x2 - 3.5} ${y - 4.5} L ${x2} ${y} L ${x2 + 3.5} ${y - 4.5}`;
  };

  return (
    <div className={`timeline ${overflow ? "overflow" : ""}`} ref={boxRef} aria-label="Versions">
      {/* Room for the selection outline even when there are no arcs (the scroll box clips). */}
      <div className="track" ref={trackRef} style={{ paddingTop: Math.max(band, 6) }} onMouseLeave={() => setHovered(null)}>
        {arcs.length > 0 && (
          <svg className="arcs" height={band} aria-hidden>
            {arcs
              .map((a, i) => ({ a, p: places[i] }))
              .sort((x, y) => Number(x.a.hot) - Number(y.a.hot))
              .map(({ a, p }) => (
                <path key={`${a.from}-${a.to}`} className={a.hot ? "hot" : ""} d={arcPath(centers[a.from] + p.dx1, centers[a.to] + p.dx2, band - 8 - (p.lane + 1) * LANE)} />
              ))}
          </svg>
        )}
        {session.map((it, i) => {
          const job = it.jobId ? jobs[it.jobId] : undefined;
          const src = itemSource(it);
          const pending = it.kind === "job";
          const failed = pending && job && ["failed", "cancelled"].includes(job.status);
          const frac = pending && job ? jobFraction(job) : null;
          const mode: Mode | undefined = it.gen?.mode ?? job?.plan?.mode;
          const link = links[it.key];
          const pendingSrc = pending && it.request?.mode !== "generate" ? it.request?.images?.[0] : undefined;
          const prompt = it.gen?.prompt || it.request?.prompt || "";
          const what = mode ? (mode === "generate" && link?.kind === "start" ? "New image" : MODE_LABEL[mode]) : it.input ? "Imported" : "";
          const tip = [[imageName(labels[it.key]), what, linkText(link, labels)].filter(Boolean).join(" · "), prompt, src ? "Drag onto the prompt box to use it there" : ""].filter(Boolean).join("\n");
          const hot = it.key === focus || link?.parents[0] === focus;
          return (
            <Fragment key={it.key}>
              {i > 0 && <Joint kind={link?.kind ?? "next"} hot={hot} />}
              <button
                data-key={it.key}
                className={`frame ${selected === it.key ? "sel" : ""} ${selParents.has(it.key) ? "src" : ""}`}
                title={tip}
                onMouseEnter={() => setHovered(it.key)}
                onClick={() => {
                  if (dragged.current) dragged.current = false;
                  else {
                    selectItem(it.key);
                    onSelect?.();
                  }
                }}
                onPointerDown={(e) => {
                  if (e.button === 0 && src) drag.current = { key: it.key, src, x0: e.clientX, y0: e.clientY, moved: false };
                }}
                onPointerMove={(e) => {
                  const d = drag.current;
                  if (!d) return;
                  if (!d.moved) {
                    if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
                    d.moved = true;
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }
                  const over = overPrompt(e.clientX, e.clientY);
                  hintDrop(over);
                  setGhost({ src: d.src, x: e.clientX, y: e.clientY, over });
                }}
                onPointerUp={(e) => {
                  const d = drag.current;
                  endDrag();
                  if (!d?.moved) return;
                  dragged.current = true;
                  const dropped = session.find((x) => x.key === d.key);
                  if (dropped && overPrompt(e.clientX, e.clientY)) {
                    addAsReference(dropped);
                    focusPrompt();
                  }
                }}
                onPointerCancel={endDrag}
              >
                <span className="frame-img">
                  {src && <img src={urls.sourceThumb(src)} alt="" draggable={false} />}
                  {pendingSrc && <img className="dim" src={urls.sourceThumb(pendingSrc)} alt="" draggable={false} />}
                  {pending && !failed && (
                    <span className="frame-state">
                      {frac !== null ? <Ring frac={frac} /> : <Loader2 className="spin" size={16} />}
                    </span>
                  )}
                  {failed && (
                    <span className="frame-state">
                      <X size={16} />
                    </span>
                  )}
                  {src && src === target && (
                    <span className="frame-badge" title="The prompt edits this image">
                      <Pencil size={10} />
                    </span>
                  )}
                </span>
                <span className="frame-label">
                  {mode && MODE_ICON[mode]}
                  {labels[it.key]}
                </span>
              </button>
            </Fragment>
          );
        })}
      </div>
      {ghost && <img className={`drag-ghost ${ghost.over ? "over" : ""}`} src={urls.sourceThumb(ghost.src)} style={{ left: ghost.x, top: ghost.y }} alt="" draggable={false} />}
    </div>
  );
}

function Ring({ frac }: { frac: number }) {
  const r = 8;
  const c = 2 * Math.PI * r;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden>
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} strokeLinecap="round" transform="rotate(-90 10 10)" />
    </svg>
  );
}

/** A version that has a picture to show (not a job still running or one that failed). */
const viewable = (i: SessionItem) => !!(i.gen || i.input);

/** Full screen for the selected version: follows the selection, and ←/→ (or the arrows on
 * the sides) step through the versions of the timeline without leaving it. */
function StageFullscreen({ item, session, showOriginal, onClose }: { item: SessionItem; session: SessionItem[]; showOriginal: boolean; onClose: () => void }) {
  const nav = useMemo<ViewerNav>(() => {
    const at = session.findIndex((i) => i.key === item.key);
    const step = (d: number) => {
      for (let j = at + d; j >= 0 && j < session.length; j += d) {
        const key = session[j].key;
        if (viewable(session[j])) return () => selectItem(key);
      }
      return undefined;
    };
    const shown = session.filter(viewable);
    return { prev: step(-1), next: step(1), pos: `${shown.findIndex((i) => i.key === item.key) + 1} / ${shown.length}` };
  }, [item.key, session]);

  const g = item.gen;
  const base = g ? compareBase(g) : null;
  const from = g?.pipeline?.original_path ? g.pipeline.enlarged_from : null;
  let content: React.ReactNode;
  let hint = "Scroll or click to zoom · Drag to pan";
  if (g && from && showOriginal) content = <ZoomImage key={`original-${g.id}`} src={urls.genOriginal(g.id)} alt={`${g.prompt} (before upscaling)`} />;
  else if (g && base) {
    content = <CompareFullscreen key={g.id} g={g} base={base} />;
    hint = "Hold B for the original";
  } else {
    const src = g ? urls.gen(g.id) : urls.input(item.input!.id);
    content = <ZoomImage key={src} src={src} alt={g?.prompt ?? item.input?.original_name ?? ""} />;
  }
  return (
    <Fullscreen hint={hint} onClose={onClose} nav={nav}>
      {content}
    </Fullscreen>
  );
}

export function Stage() {
  const item = useStore(selectedItem);
  const session = useStore((s) => s.session);
  const job = useStore((s) => (item?.jobId ? s.jobs[item.jobId] : undefined));
  const labels = useMemo(() => sessionLabels(session), [session]);
  // The result whose pre-upscale original is on screen instead of it.
  const [originalOf, setOriginalOf] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [showZoomControls, setShowZoomControls] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const canFull = !!item && viewable(item);

  // F opens full screen on the selected version (Esc or F again closes it).
  useEffect(() => {
    if (full || !canFull) return;
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "f" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || getState().overlay) return;
      setFull(true);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [full, canFull]);

  // Nothing to show any more (the version was removed, or a new one is being made): leave full screen.
  useEffect(() => {
    if (full && !canFull) setFull(false);
  }, [full, canFull]);

  const fullscreen = full && canFull && item && (
    <StageFullscreen item={item} session={session} showOriginal={!!(item.gen && originalOf === item.gen.id)} onClose={() => setFull(false)} />
  );
  const openFull = () => setFull(true);

  if (!item) {
    return (
      <div className="stage">
        <Empty />
        <Timeline labels={labels} />
      </div>
    );
  }

  let view: React.ReactNode;
  if (item.kind === "job") {
    view = !job ? (
      <div className="stage-frame">
        <Loader2 className="spin" size={22} />
      </div>
    ) : job.status === "failed" || job.status === "cancelled" ? (
      <Failed job={job} item={item} />
    ) : (
      <Pending job={job} item={item} labels={labels} />
    );
  } else {
    const src = item.gen ? urls.gen(item.gen.id) : urls.input(item.input!.id);
    const w = item.gen?.width ?? item.input!.width;
    const h = item.gen?.height ?? item.input!.height;
    const base = item.gen ? compareBase(item.gen) : null;
    const g = item.gen;
    const from = g?.pipeline?.original_path ? g.pipeline.enlarged_from : null;
    const showOriginal = !!(g && from && originalOf === g.id);
    view = (
      <>
        {g && from && showOriginal ? (
          <PlainFrame
            key={`original-${g.id}-${resetSignal}`}
            src={urls.genOriginal(g.id)}
            alt={`${g.prompt} (before upscaling)`}
            w={from.width}
            h={from.height}
            onFullscreen={openFull}
            showControls={showZoomControls}
            onToggleControls={() => setShowZoomControls((v) => !v)}
          />
        ) : item.gen && base ? (
          <CompareFrame
            key={`compare-${item.gen.id}-${resetSignal}`}
            g={item.gen}
            base={base}
            onFullscreen={openFull}
            showControls={showZoomControls}
            onToggleControls={() => setShowZoomControls((v) => !v)}
          />
        ) : (
          <PlainFrame
            key={`${item.key}-${resetSignal}`}
            src={src}
            alt={item.gen?.prompt ?? item.input?.original_name ?? ""}
            w={w}
            h={h}
            onFullscreen={openFull}
            showControls={showZoomControls}
            onToggleControls={() => setShowZoomControls((v) => !v)}
          />
        )}
        <StageBar item={item} label={labels[item.key]} showOriginal={showOriginal} setShowOriginal={(on) => setOriginalOf(on && g ? g.id : null)} />
      </>
    );
  }

  return (
    <div className="stage">
      {view}
      <Timeline labels={labels} onSelect={() => setResetSignal((s) => s + 1)} />
      {fullscreen}
    </div>
  );
}
