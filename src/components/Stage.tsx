import {
  Brush, Check, ClipboardPaste, Combine, Copy, Download, Ellipsis, Expand, FolderOpen, Heart, ImageUpscale, Images, Info, Layers, Loader2, MousePointerClick, Palette, Pencil, RefreshCw, RotateCcw, SlidersHorizontal, Square, TextCursorInput, Trash2, Wand2, WandSparkles, X,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import {
  compareBase, composerFromRecord, formatDuration, jobLabel, type JobClock, lutInfo, lutLabel, MAX_UPSCALE_AREA, MAX_UPSCALE_SIDE, MODE_LABEL, pipelineSummary, remainingSeconds, sizeForWidth, upscaleRequest, arcLayout,
  upscalerLabel, upscaleTargets, variationRequest, moreLikeThisRequest, MORE_LIKE_THIS, imageName, type LinkKind, type TimelineLink,
} from "../lib/logic";
import { canCopyImage, native } from "../lib/native";
import {
  addAsReference, addResult, cancelJob, focusPrompt, getState, itemSource, projectTitle, removeSessionItem, removeSessionItems, reusePrompt, selectedItem, selectItem, sessionLabels, sessionLinks, setState, stageImage, submitRequest, toastError, toastInfo, useStore, type SessionItem,
} from "../lib/store";
import type { GenerationRecord, GenerationRequest, JobView, LutEntry, Mode, Size } from "../lib/types";
import { Cocoon, Hatch } from "./Cocoon";
import { CompareFrame, CompareFullscreen } from "./Compare";
import { PROMPT_FADE_MS, cardMemory, usePromptLeave, useTypewriter, useJobPercent, wordStyle, type CardMemory } from "./jobMotion";
import { DevelopImg } from "./Develop";
import { docById, LabFrame, LabThumb, useLab, useLabJobs, type Lab } from "./LabStage";
import { useMaskTint } from "./LayerDoc";
import { docId, type LayerDoc } from "../lib/layerDoc";
import { LutBar, LutButton, LutOverlay } from "./Lut";
import { IconButton, Popover, useFit } from "./ui";
import { Fullscreen, FullscreenButton, isTyping, ZoomImage, type ViewerNav } from "./Viewer";
import { fileManager, inBrowser, shortcut, useNarrow } from "../lib/platform";
import { PhoneActions, PhoneEmpty, Swipe } from "./PhoneStage";
import { formatDateTime, t } from "../lib/i18n";

export const MODE_ICON: Record<Mode | "lut" | "layers", React.ReactNode> = {
  auto: <Wand2 size={11} />,
  generate: <Wand2 size={11} />,
  edit: <Pencil size={11} />,
  multi_reference: <Combine size={11} />,
  compose: <Wand2 size={11} />,
  inpaint: <Brush size={11} />,
  outpaint: <Expand size={11} />,
  upscale: <ImageUpscale size={11} />,
  lut: <Palette size={11} />,
  layers: <Layers size={11} />,
};

/** What a job is doing, for its card's title; `name` is the image it works on ("Editing image 2"). */
function modeDoing(mode: Mode, name?: string): string {
  switch (mode) {
    case "auto":
      return name ? t("stage.doingAutoFrom", { name }) : t("stage.doingAuto");
    case "generate":
      return name ? t("stage.doingGenerateFrom", { name }) : t("stage.doingGenerate");
    case "edit":
      return name ? t("stage.doingEditFrom", { name }) : t("stage.doingEdit");
    case "multi_reference":
      return t("stage.doingMultiReference");
    case "compose":
      return t("stage.doingCompose");
    case "inpaint":
      return name ? t("stage.doingInpaintFrom", { name }) : t("stage.doingInpaint");
    case "outpaint":
      return name ? t("stage.doingOutpaintFrom", { name }) : t("stage.doingOutpaint");
    case "upscale":
      return name ? t("stage.doingUpscaleFrom", { name }) : t("stage.doingUpscale");
  }
}

function Empty() {
  return (
    <div className="empty">
      <h1>{t("stage.emptyTitle")}</h1>
      <p>{t("stage.emptyIntro")}</p>
      <p className="tip">
        {t("stage.emptyTip")}{" "}
        <button className="link" onClick={() => setState({ overlay: "prompt-tips" })}>
          {t("stage.morePromptTips")}
        </button>
      </p>
      <div className="hint">
        <span>
          <MousePointerClick size={14} /> {t("stage.dropImages")}
        </span>
        <span>
          <ClipboardPaste size={14} /> {t("stage.pasteWith", { shortcut: shortcut("V") })}
        </span>
      </div>
    </div>
  );
}

/** A version in progress. With the prompt enhancer, the prompt it writes first takes the whole
 * frame, appearing word by word; a couple of seconds after the last word it fades and the
 * completion percentage takes over, over the cocoon (components/Cocoon.tsx). Looking at another
 * version unmounts the card; coming back continues from where it is (`cardMemory`). */
function Pending({ job, item, labels }: { job: JobView; item: SessionItem; labels: Record<string, string> }) {
  const o = job.plan?.output;
  const { ref, box } = useFit(o ? o.width / o.height : 1);
  const session = useStore((s) => s.session);
  // A new image (also one from references) has no source to grow from.
  const src = item.request?.mode === "generate" || item.request?.mode === "compose" ? undefined : item.request?.images?.[0];
  const from = src ? session.find((i) => itemSource(i) === src) : undefined;
  const mode = job.plan?.mode;
  // "v3 · Editing v2", "v1 · Creating"
  const title = [imageName(labels[item.key]), mode && modeDoing(mode, from && mode !== "multi_reference" && mode !== "compose" ? imageName(labels[from.key]).toLowerCase() : undefined)].filter(Boolean).join(" · ");
  // The source keeps its own shape inside an expansion; elsewhere it fills the frame.
  const outpaint = item.request?.outpaint;
  const { pct, clock } = useJobPercent(job, item.request, true);
  const [card] = useState(() => cardMemory(job.id));
  const [promptGone, setPromptGone] = useState(card.promptGone);
  const promptPhase = job.enhanced_prompt != null && !promptGone;
  return (
    <div className="stage-frame" ref={ref}>
      <div className={`pending ${promptPhase ? "prompt-phase" : ""}`} style={{ width: box.w, height: box.h }}>
        <Cocoon src={src && !outpaint ? urls.source(src) : undefined} pct={pct} form={pct >= 92} formStart={card.formStart} dim={promptPhase} />
        {promptPhase ? (
          <PromptPhase
            title={title}
            text={job.enhanced_prompt!}
            streaming={job.status === "enhancing_prompt"}
            withImage={!!src || item.request?.mode === "compose"}
            budget={job.plan?.estimated_seconds || null}
            card={card}
            onCancel={() => cancelJob(job.id)}
            onGone={() => {
              card.promptGone = true;
              setPromptGone(true);
            }}
          />
        ) : (
          <ProgressPhase job={job} title={title} pct={pct} clock={clock} card={card} />
        )}
      </div>
    </div>
  );
}

function ProgressPhase({ job, title, pct, clock, card }: { job: JobView; title: string; pct: number; clock: JobClock; card: CardMemory }) {
  const o = job.plan?.output;
  // It fades in the first time only, not when the card comes back.
  const [resumed] = useState(card.progressShown);
  useEffect(() => {
    card.progressShown = true;
  }, [card]);
  const remain = remainingSeconds(job, clock);
  const canCancel = !["done", "failed", "cancelled"].includes(job.status);
  const notes = job.notes.join(" ");
  // A small card (a tall image in a short window) drops what doesn't fit: the title shortens,
  // Stop keeps its icon, the size and the notes hide (styles.css, @container pending). Hover
  // still shows the whole title and the notes.
  return (
    <div className={`progress-phase ${resumed ? "resumed" : ""}`}>
      <span className="pending-title" title={title}>
        {title}
      </span>
      {canCancel && (
        <button className="btn ghost stop-corner" onClick={() => cancelJob(job.id)} title={t("common.cancel")} aria-label={t("common.stop")}>
          <Square size={12} />
          <span className="stop-label">{t("common.stop")}</span>
        </button>
      )}
      {/* The cocoon fills the middle; the percentage sits under it. */}
      <div className="progress-foot" title={notes || undefined}>
        <span className="job-pct" aria-label={t("stage.percentAria", { pct: Math.floor(pct) })}>
          {Math.floor(pct)}
          <small>%</small>
        </span>
        <div className="progress">
          <i style={{ width: `${pct}%` }} />
        </div>
        <span className="progress-detail">
          {jobLabel(job)}
          {o && <span className="detail-size"> · {o.width}×{o.height}</span>}
          {remain !== null && ` · ${t("stage.timeLeft", { time: formatDuration(remain) })}`}
        </span>
        {notes && <span className="notes">{notes}</span>}
      </div>
    </div>
  );
}


/** The prompt enhancer's text over the whole frame, revealed word by word at a calm pace. The
 * model writes it in a second or two and the image starts right away, so the text keeps
 * appearing while the image is made: reading it fills the wait. It never runs ahead of the text
 * that has arrived. */
function PromptPhase(props: { title: string; text: string; streaming: boolean; withImage: boolean; budget: number | null; card: CardMemory; onCancel: () => void; onGone: () => void }) {
  const { text, streaming } = props;
  const shown = useTypewriter(text, streaming, props.budget, props.card);
  // Words already on screen when the card came back don't fade in again.
  const [seen] = useState(shown);
  const ref = useRef<HTMLDivElement>(null);
  const words = useMemo(() => text.split(/(\s+)/), [text]);
  const writing = streaming || shown < text.length;
  const leave = usePromptLeave(writing, text, props.onGone, props.card);
  // Whole words up to the revealed length; each new one fades in once (stable keys).
  const visible: React.ReactNode[] = [];
  let at = 0;
  for (let i = 0; i < words.length && at < shown; i++) {
    const w = words[i];
    visible.push(/^\s+$/.test(w) ? w : <span key={i} className={at < seen ? "w seen" : "w"} style={wordStyle(at, shown)}>{w}</span>);
    at += w.length;
  }
  // Follow the new words only while the reader is at the bottom; scrolling up to reread stays put.
  const follow = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && writing && follow.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, writing]);
  return (
    <div className={`prompt-stage ${leave.leaving ? "leaving" : ""}`} style={{ transitionDuration: `${PROMPT_FADE_MS}ms`, ...leave.style }}>
      <span className={`enhanced-label ${writing ? "shimmer" : ""}`}>
        <WandSparkles size={13} /> {writing ? t("stage.writingPrompt") : t("stage.thePrompt")} · {props.title}
      </span>
      <div
        className="prompt-text"
        ref={ref}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <div className="prompt-flow">
          {text ? visible : <span className="enhanced-wait shimmer">{props.withImage ? t("stage.lookingAtImage") : t("stage.readingIdea")}</span>}
          {writing && text && <i className="caret" />}
        </div>
      </div>
      <button className="btn ghost" onClick={props.onCancel} title={t("common.cancel")}>
        <Square size={12} /> {t("common.stop")}
      </button>
    </div>
  );
}


function Failed({ job, item }: { job: JobView; item: SessionItem }) {
  const [details, setDetails] = useState(false);
  const req = item.request;
  return (
    <div className="stage-frame">
      <div className="failed">
        <strong>{job.status === "cancelled" ? t("stage.cancelled") : job.error?.message ?? t("stage.generationFailed")}</strong>
        {job.error?.suggestion && <span>{job.error.suggestion}</span>}
        <div style={{ display: "flex", gap: 8 }}>
          {req && (
            <button className="btn" onClick={() => (removeSessionItem(item.key), submitRequest(req))}>
              <RotateCcw size={14} /> {t("common.retry")}
            </button>
          )}
          <button className="btn" onClick={() => removeSessionItem(item.key)}>
            <X size={14} /> {t("stage.dismiss")}
          </button>
          {job.error?.detail && (
            <button className="btn" onClick={() => setDetails((d) => !d)}>
              <Info size={14} /> {t("stage.details")}
            </button>
          )}
        </div>
        {details && <pre className="diag" style={{ maxHeight: 220, textAlign: "left", width: "100%" }}>{job.error?.detail}</pre>}
      </div>
    </div>
  );
}

function CopyText({ text, title }: { text: string; title: string }) {
  return (
    <IconButton small title={title} onClick={() => void native.copyText(text).then(() => toastInfo(t("stage.promptCopied")), toastError)}>
      <Copy size={13} />
    </IconButton>
  );
}

export function InfoPanel({ g }: { g: GenerationRecord }) {
  const pipeline = pipelineSummary(g);
  const lut = lutInfo(g);
  const size = `${g.width}×${g.height}`;
  const created = formatDateTime(new Date(g.created_at));
  const rows: [string, string][] = lut ? [
    [t("stage.infoMode"), MODE_LABEL[g.mode]],
    [t("stage.infoSize"), size],
    [t("stage.infoLut"), !lut.name.startsWith("kokon:") && lut.title && lut.title !== lut.name ? `${lut.name} (${lut.title})` : lutLabel(lut)],
    [t("stage.infoIntensity"), t("stage.percentValue", { value: Math.round(lut.intensity * 100) })],
    [t("stage.infoCreated"), created],
  ] : [
    [t("stage.infoMode"), MODE_LABEL[g.mode]],
    [t("stage.infoSize"), g.working_width !== g.width || g.working_height !== g.height ? t("stage.infoSizeWorkedAt", { size, workSize: `${g.working_width}×${g.working_height}` }) : size],
    ...(pipeline ? ([[t("stage.infoPipeline"), pipeline]] as [string, string][]) : []),
    [t("stage.infoSeed"), String(g.seed)],
    [t("stage.infoSteps"), String(g.steps)],
    [t("stage.infoCfg"), String(g.cfg)],
    [t("stage.infoSampler"), `${g.sampler}${g.scheduler ? ` / ${g.scheduler}` : ""}`],
    ...(g.strength != null ? ([[t("stage.infoStrength"), String(g.strength)]] as [string, string][]) : []),
    [t("stage.infoReferences"), String(g.references.length)],
    ...(g.loras?.length ? ([["LoRA", g.loras.map((l) => `${l.name} (${t("stage.percentValue", { value: Math.round(l.weight * 100) })})`).join(", ")]] as [string, string][]) : []),
    [t("stage.infoModel"), g.model],
    [t("stage.infoTime"), formatDuration(g.duration_ms / 1000)],
    [t("stage.infoCreated"), created],
  ];
  return (
    <div className="info-panel" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="info-prompt">
        <div style={{ fontSize: 13, maxHeight: 160, overflow: "auto" }}>{g.prompt}</div>
        <CopyText text={g.prompt} title={g.original_prompt ? t("stage.copyEnhancedPrompt") : t("stage.copyPrompt")} />
      </div>
      {g.original_prompt && (
        <div className="info-prompt">
          <div className="muted" style={{ maxHeight: 80, overflow: "auto" }}>
            <WandSparkles size={11} style={{ verticalAlign: -1 }} /> {t("stage.writtenByEnhancerFrom", { prompt: g.original_prompt })}
          </div>
          <CopyText text={g.original_prompt} title={t("stage.copyYourPrompt")} />
        </div>
      )}
      {g.negative_prompt && <div className="muted">{t("stage.negativePrompt", { prompt: g.negative_prompt })}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 12 }}>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <span className="muted">{k}</span>
            <span style={{ wordBreak: "break-all" }}>{v}</span>
          </Fragment>
        ))}
      </div>
      {g.notes.length > 0 && <div className="muted">{g.notes.join(" ")}</div>}
      <div className="muted" style={{ wordBreak: "break-all" }}>{g.file_path}</div>
    </div>
  );
}

/** Upscale menu: the upscaler model straight on the image (no diffusion). */
function UpscaleMenu(props: { source: string; size: Size; original?: Size | null; parentId?: string | null; close: () => void }) {
  const { width: w, height: h } = props.size;
  const up = useStore((s) => s.status?.upscaler);
  // The engine running now can't upscale (an old one, before the update): Lanczos.
  const noEsrgan = useStore((s) => s.status?.server?.upscale === false);
  const via = up?.available && !noEsrgan ? upscalerLabel(up.model) : "Lanczos";
  const [customW, setCustomW] = useState(Math.min(MAX_UPSCALE_SIDE, w * 2));
  const targets = upscaleTargets(w, h, props.original);
  const custom = sizeForWidth(w, h, customW);
  const customOk = custom.width > w && custom.width <= MAX_UPSCALE_SIDE && custom.height <= MAX_UPSCALE_SIDE && custom.width * custom.height <= MAX_UPSCALE_AREA;
  const go = (t: Size) => {
    submitRequest(upscaleRequest(props.source, t, props.parentId));
    props.close();
  };
  return (
    <div className="upscale-menu" style={{ padding: 8, display: "flex", flexDirection: "column", gap: 10 }}>
      <span className="muted">{t("stage.upscaleVia", { upscaler: via })}</span>
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
          aria-label={t("stage.customWidth")}
        />
        <span className="muted" style={{ flex: 1 }}>
          × {custom.height}
        </span>
        <button className="btn" disabled={!customOk} onClick={() => go(custom)}>
          {t("stage.upscale")}
        </button>
      </div>
    </div>
  );
}

/** A main action under the image: icon and word (the word hides when the stage is narrow). */
export function ActionButton(props: { title: string; icon: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button className={`act ${props.active ? "active" : ""}`} title={props.title} aria-label={props.label} onClick={props.onClick}>
      {props.icon}
      <span className="act-label">{props.label}</span>
    </button>
  );
}

export function UpscaleButton(props: { source: string; size: Size; original?: Size | null; parentId?: string | null }) {
  return (
    <Popover
      placement="top-end"
      trigger={(open, toggle) => <ActionButton title={t("stage.upscaleTooltip")} icon={<ImageUpscale size={16} />} label={t("stage.upscale")} onClick={toggle} active={open} />}
    >
      {(close) => <UpscaleMenu {...props} close={close} />}
    </Popover>
  );
}

/** More like this (#55): a new image from this one, a little or more different. */
function MoreLikeThisButton({ g }: { g: GenerationRecord }) {
  const run = (strength: number) => {
    const r = moreLikeThisRequest(g, strength);
    if (r) submitRequest(r);
  };
  const options = [
    { strength: MORE_LIKE_THIS.subtle, label: t("stage.moreLikeThisSubtle"), hint: t("stage.moreLikeThisSubtleHint") },
    { strength: MORE_LIKE_THIS.strong, label: t("stage.moreLikeThisStrong"), hint: t("stage.moreLikeThisStrongHint") },
  ];
  return (
    <Popover
      placement="top-end"
      trigger={(open, toggle) => <ActionButton title={t("stage.moreLikeThisTooltip")} icon={<Images size={16} />} label={t("stage.moreLikeThis")} onClick={toggle} active={open} />}
    >
      {(close) => (
        <>
          {options.map((o) => (
            <button key={o.label} className="opt" onClick={() => (close(), run(o.strength))}>
              <span>
                {o.label}
                <span className="muted" style={{ display: "block" }}>
                  {o.hint}
                </span>
              </span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

function MoreMenu({ item, path }: { item: SessionItem; path: string | null }) {
  const g = item.gen;
  return (
    <Popover
      placement="top-end"
      trigger={(open, toggle) => (
        <IconButton title={t("stage.more")} onClick={toggle} active={open}>
          <Ellipsis size={17} />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          {g && g.mode !== "lut" && g.mode !== "layers" && (
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
              <span>{t("stage.reusePromptAndSettings")}</span>
            </button>
          )}
          {path && !inBrowser && (
            <button className="opt" onClick={() => (close(), native.reveal(path).catch(toastError))}>
              <span className="check">
                <FolderOpen size={15} />
              </span>
              <span>{fileManager === "Finder" ? t("stage.showInFinder") : fileManager === "Explorer" ? t("stage.showInExplorer") : t("stage.showInFileManager")}</span>
            </button>
          )}
          <button className="opt" onClick={() => (close(), removeSessionItem(item.key))}>
            <span className="check">
              <Trash2 size={15} />
            </span>
            <span>{t("stage.removeFromProject")}</span>
          </button>
        </>
      )}
    </Popover>
  );
}

/** The size of the image an edit was made from (the upscale menu offers it back), or null. */
export function sourceSize(g: GenerationRecord): Size | null {
  return g.references[0] && g.mode !== "generate" && g.mode !== "compose" && g.mode !== "upscale" && g.mode !== "lut" && g.mode !== "layers" ? { width: g.references[0].width, height: g.references[0].height } : null;
}

function GenActions({ item, g, showOriginal, onLut }: { item: SessionItem; g: GenerationRecord; showOriginal: boolean; onLut: (lut: LutEntry) => void }) {
  // Save, copy and "show in folder" act on the image on screen: the result or its pre-upscale original.
  const shownPath = (showOriginal && g.pipeline?.original_path) || g.file_path;
  const original = sourceSize(g);
  const [fav, setFav] = useState(g.favorite);
  return (
    <div className="actions">
      {g.prompt && (
        <ActionButton
          title={t("stage.reusePromptTooltip")}
          icon={<TextCursorInput size={16} />}
          label={t("stage.reusePrompt")}
          onClick={() => reusePrompt(g)}
        />
      )}
      {g.request && g.mode !== "upscale" && g.mode !== "lut" && g.mode !== "layers" && (
        <ActionButton
          title={t("stage.regenerateTooltip")}
          icon={<RefreshCw size={16} />}
          label={t("stage.regenerate")}
          onClick={() => {
            const r = variationRequest(g);
            if (r) submitRequest(r);
          }}
        />
      )}
      {moreLikeThisRequest(g) && <MoreLikeThisButton g={g} />}
      <UpscaleButton source={`gen:${g.id}`} size={{ width: g.width, height: g.height }} original={original} parentId={g.id} />
      <LutButton onPick={onLut} />
      <span className="sep" />
      <IconButton
        title={fav ? t("stage.removeFromFavorites") : t("stage.favorite")}
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
        title={inBrowser ? (showOriginal ? t("stage.downloadOriginal") : t("common.download")) : showOriginal ? t("stage.saveOriginalAs") : t("stage.saveAs")}
        onClick={async () => {
          const name = g.file_path.split(/[\\/]/).pop() ?? "image.png";
          if (inBrowser) {
            // Onto this device, as the file Kokon saved.
            native.download(showOriginal ? urls.genOriginal(g.id) : urls.gen(g.id), showOriginal ? name.replace(/(\.\w+)?$/, "-original.png") : name);
            return;
          }
          const path = await native.saveAs(showOriginal ? name.replace(/(\.\w+)?$/, "-original.png") : name);
          if (!path) return;
          try {
            const r = await api.exportGeneration(g.id, path, showOriginal);
            toastInfo(t("stage.savedFile", { name: r.path.split(/[\\/]/).pop() ?? "" }));
          } catch (e) {
            toastError(e);
          }
        }}
      >
        <Download size={17} />
      </IconButton>
      {canCopyImage && (
        <IconButton
          title={showOriginal ? t("stage.copyOriginal") : t("stage.copyImage")}
          onClick={async () => {
            try {
              if (inBrowser) await native.copyImageUrl(showOriginal ? urls.genOriginal(g.id) : urls.gen(g.id));
              else await native.copyImage(shownPath);
              toastInfo(t("stage.imageCopied"));
            } catch (e) {
              toastError(e);
            }
          }}
        >
          <Copy size={17} />
        </IconButton>
      )}
      <Popover
        placement="top-end"
        trigger={(open, toggle) => (
          <IconButton title={t("stage.details")} onClick={toggle} active={open}>
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

function InputActions({ item, onLut }: { item: SessionItem; onLut: (lut: LutEntry) => void }) {
  const input = item.input!;
  return (
    <div className="actions">
      <UpscaleButton source={`input:${input.id}`} size={{ width: input.width, height: input.height }} />
      <LutButton onPick={onLut} />
      <span className="sep" />
      <MoreMenu item={item} path={input.original_path ?? input.path} />
    </div>
  );
}

/** A result or input fitted to the stage (never enlarged past its own size), with the
 * full-screen button in its top-right corner. */
/** `fill`: enlarged to fill the frame like the card it replaces (a result); otherwise never shown
 * wider than it is. */
/** One image on the stage. With `source` ("gen:"/"input:"), a browser may load its preview
 * (`stageImage`); `src` is loaded as it is. */
function PlainFrame({ src, source, alt, w, h, maskSrc, overlay, fill, onFullscreen }: { src?: string; source?: string; alt: string; w: number; h: number; maskSrc?: string; overlay?: React.ReactNode; fill?: boolean; onFullscreen: () => void }) {
  const { ref, box } = useFit(w / h);
  const bw = fill ? box.w : Math.min(box.w, w);
  const img = source ? stageImage(source, bw, bw * (h / w)) : src;
  return (
    <div className="stage-frame" ref={ref}>
      <div className="image-box" style={{ width: bw, height: bw * (h / w) }}>
        <DevelopImg className="stage-img fill" src={img} placeholder={source ? urls.sourceThumb(source) : undefined} alt={alt} />
        {maskSrc && <img className="stage-mask" src={maskSrc} alt="" draggable={false} />}
        {overlay}
        <FullscreenButton onOpen={onFullscreen} />
      </div>
    </div>
  );
}

/** Under the image: which image this is and what made it, then what you can do with it. */
/** `phone`: the prompt stays in Details, the actions are the phone's row. */
function StageBar(props: { item: SessionItem; label: string; showOriginal: boolean; setShowOriginal: (on: boolean) => void; lutBar: React.ReactNode; onLut: (lut: LutEntry) => void; phone?: boolean }) {
  const { item, label, showOriginal, setShowOriginal } = props;
  const g = item.gen;
  const lut = g && lutInfo(g);
  const w = g?.width ?? item.input!.width;
  const h = g?.height ?? item.input!.height;
  const from = g?.pipeline?.original_path ? g.pipeline.enlarged_from : null;
  const name = item.input?.original_name ? safeDecode(item.input.original_name) : t("stage.importedImage");
  return (
    <div className="stage-bar">
      <div className="stage-meta">
        <span className="ver">{imageName(label)}</span>
        {g && <span className="mode">{MODE_LABEL[g.mode]}</span>}
        {g?.original_prompt && (
          <span className="enhanced-mark" title={t("stage.enhancedMarkTooltip")}>
            <WandSparkles size={13} />
          </span>
        )}
        {!props.phone && (
        <span className="stage-prompt" title={g?.original_prompt ? t("stage.promptWithYours", { prompt: g.prompt, original: g.original_prompt }) : g?.prompt ?? name}>
          {g ? g.original_prompt || g.prompt || (g.mode === "upscale" ? `${g.references[0]?.width ?? "?"}×${g.references[0]?.height ?? "?"} → ${w}×${h}` : lut ? `${lutLabel(lut)} · ${t("stage.percentValue", { value: Math.round(lut.intensity * 100) })}` : "") : name}
        </span>
        )}
        {from && !props.lutBar ? (
          <span className="seg dims-seg" role="radiogroup" aria-label={t("stage.whichImage")}>
            <button className={showOriginal ? "" : "on"} role="radio" aria-checked={!showOriginal} onClick={() => setShowOriginal(false)} title={t("stage.upscaledTooltip", { upscaler: upscalerLabel(g!.pipeline!.enlarged_with) })}>
              {t("stage.upscaled")}<span className="seg-dims"> {w}×{h}</span>
            </button>
            <button className={showOriginal ? "on" : ""} role="radio" aria-checked={showOriginal} onClick={() => setShowOriginal(true)} title={t("stage.originalTooltip")}>
              {t("stage.original")}<span className="seg-dims"> {from.width}×{from.height}</span>
            </button>
          </span>
        ) : (
          <span className="dims">
            {w}×{h}
          </span>
        )}
      </div>
      {props.lutBar ??
        (props.phone ? (
          <PhoneActions key={`actions-${item.key}`} item={item} showOriginal={showOriginal} onLut={props.onLut} />
        ) : g ? (
          <GenActions key={`actions-${g.id}`} item={item} g={g} showOriginal={showOriginal} onLut={props.onLut} />
        ) : (
          <InputActions item={item} onLut={props.onLut} />
        ))}
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
 * per arc that spans another, `LANE` px apart, rounded corners of `R` px; they stop `GAP` px
 * above the thumbnails, clear of the ring or outline round them. */
const LANE = 9;
const R = 5;
const GAP = 9;

/** What joins a version to the one before it: a line when it continues from it (dashed for a
 * new seed of it), a break when it starts something new, a plain gap when it comes from
 * other versions (an arc above shows which). */
function Joint({ kind, hot }: { kind: LinkKind; hot: boolean }) {
  if (kind === "start") return <span className="joint break" aria-hidden />;
  if (kind === "branch" || kind === "combine") return <span className="joint gap" aria-hidden />;
  // A straight line between the thumbnails, ending where a ring or outline round them sits.
  return <span className={`joint link ${kind === "variant" ? "dashed" : ""} ${hot ? "hot" : ""}`} aria-hidden />;
}

function linkText(link: TimelineLink | undefined, labels: Record<string, string>): string {
  if (!link || link.kind === "start") return "";
  const names = link.parents.map((k) => imageName(labels[k]).toLowerCase()).join(" + ");
  return link.kind === "variant" ? t("stage.linkNewSeedOf", { names }) : t("stage.linkFrom", { names });
}

/** The project's versions in order. A version continues the line of the one it was made from;
 * a new image starts a new line; versions made from earlier ones (or from several) are joined
 * to them by arcs. The image the prompt edits carries a pencil. */
function Timeline({ labels, lab }: { labels: Record<string, string>; lab: Lab }) {
  const all = useStore((s) => s.session);
  // The layers lab's versions are not shown: each split image is one frame, where the first of its
  // versions was (LabStage.tsx); an earlier lab's leftovers are not shown at all.
  const session = useMemo(() => (lab.hidden.size ? all.filter((i) => !lab.hidden.has(i.key)) : all), [all, lab]);
  const labJobs = useLabJobs(lab);
  const labSlots = useMemo(() => {
    const out: { at: number; doc: LayerDoc; key: string }[] = [];
    const seen = new Set<string>();
    let shown = 0;
    for (const i of all) {
      if (!lab.hidden.has(i.key)) {
        shown++;
        continue;
      }
      const d = docById(lab, lab.hidden.get(i.key));
      if (!d || seen.has(docId(d))) continue;
      seen.add(docId(d));
      out.push({ at: shown, doc: d, key: i.key });
    }
    return out;
  }, [all, lab]);
  const selected = useStore((s) => s.selected);
  const jobs = useStore((s) => s.jobs);
  const target = useStore((s) => s.composer.refs[0]?.source);
  // Ctrl/⌘-click picks several versions (Shift-click a run of them), Delete removes them from the
  // project (or the shown one, with nothing picked), after asking. A version being made can't be.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const removable = (it: SessionItem) => it.kind !== "job" || ["failed", "cancelled"].includes(jobs[it.jobId ?? ""]?.status ?? "failed");
  const pick = (key: string, range: boolean) => {
    const from = anchor.current ?? selected;
    const next = new Set(picked.size ? picked : selected && session.some((i) => i.key === selected) ? [selected] : []);
    if (range && from) {
      const a = session.findIndex((i) => i.key === from);
      const b = session.findIndex((i) => i.key === key);
      if (a >= 0 && b >= 0) for (const it of session.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(it.key);
    } else if (next.has(key)) next.delete(key);
    else next.add(key);
    if (!range) anchor.current = key;
    setPicked(new Set([...next].filter((k) => session.some((i) => i.key === k && removable(i)))));
  };
  // Versions gone (removed here or elsewhere) are no longer picked.
  useEffect(() => {
    if ([...picked].some((k) => !session.some((i) => i.key === k))) setPicked(new Set([...picked].filter((k) => session.some((i) => i.key === k))));
  }, [session, picked]);
  useEffect(() => {
    const down = async (e: KeyboardEvent) => {
      if (isTyping(e.target) || getState().overlay) return;
      if (e.key === "Escape" && picked.size) {
        setPicked(new Set());
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const keys = picked.size ? [...picked] : session.filter((i) => i.key === selected && removable(i)).map((i) => i.key);
      if (!keys.length) return;
      e.preventDefault();
      const n = keys.length;
      const ok = await native.confirm(t("stage.removeVersionsConfirm", { count: n }), t("stage.removeFromProject"));
      if (!ok) return;
      removeSessionItems(keys);
      setPicked(new Set());
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, session, selected, jobs]);
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

  if (!session.length && !labSlots.length) return null;
  const focus = hovered ?? selected;
  const labFrame = (doc: LayerDoc, key: string, first: boolean) => {
    const id = docId(doc);
    const isSel = !!selected && lab.hidden.get(selected) === id;
    const making = labJobs.find((j) => docId(j.doc) === id && j.job.status !== "failed");
    return (
      <Fragment key={`lab-${id}`}>
        {!first && <Joint kind="next" hot={false} />}
        <button data-key={`lab-${id}`} className={`frame ${isSel ? "sel" : ""}`} title={t("stage.layersFrameTooltip")} onClick={() => selectItem(key)}>
          <span className="frame-box">
            <span className="frame-img">
              <LabThumb doc={doc} job={making} />
            </span>
            {(isSel || making) && (
              <svg className={`frame-silk ${making ? "making" : ""}`} viewBox="0 0 60 60" aria-hidden>
                <rect className="ring" x="1" y="1" width="58" height="58" rx="17" />
                {making && <rect className="run" x="1" y="1" width="58" height="58" rx="17" pathLength={200} />}
              </svg>
            )}
          </span>
          <span className="frame-label">
            <Layers size={10} />
            {t("stage.layers")}
          </span>
        </button>
      </Fragment>
    );
  };
  const labFirst = labSlots.filter((x) => x.at === 0);
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
  const band = arcs.length ? 10 + GAP + (Math.max(...places.map((p) => p.lane)) + 1) * LANE : 0;
  const arcPath = (x1: number, x2: number, top: number) => {
    const y = band - GAP;
    const d = x2 > x1 ? 1 : -1;
    // Up from the source, across at its level, down into the result, with an arrowhead.
    return `M ${x1} ${y} L ${x1} ${top + R} Q ${x1} ${top} ${x1 + d * R} ${top} L ${x2 - d * R} ${top} Q ${x2} ${top} ${x2} ${top + R} L ${x2} ${y} M ${x2 - 3.5} ${y - 4.5} L ${x2} ${y} L ${x2 + 3.5} ${y - 4.5}`;
  };

  return (
    <div className={`timeline ${overflow ? "overflow" : ""}`} ref={boxRef} aria-label={t("stage.versions")}>
      {/* Room for the selection outline even when there are no arcs (the scroll box clips). */}
      <div className="track" ref={trackRef} style={{ paddingTop: Math.max(band, 6) }} onMouseLeave={() => setHovered(null)}>
        {arcs.length > 0 && (
          <svg className="arcs" height={band} aria-hidden>
            {arcs
              .map((a, i) => ({ a, p: places[i] }))
              .sort((x, y) => Number(x.a.hot) - Number(y.a.hot))
              .map(({ a, p }) => (
                <path key={`${a.from}-${a.to}`} className={a.hot ? "hot" : ""} d={arcPath(centers[a.from] + p.dx1, centers[a.to] + p.dx2, band - 8 - GAP - (p.lane + 1) * LANE)} />
              ))}
          </svg>
        )}
        {labFirst.map((x, k) => labFrame(x.doc, x.key, k === 0))}
        {session.map((it, i) => {
          const job = it.jobId ? jobs[it.jobId] : undefined;
          const src = itemSource(it);
          const pending = it.kind === "job";
          const failed = pending && job && ["failed", "cancelled"].includes(job.status);
          // Being made: a thread runs round its thumbnail (the shown version has a still ring).
          const making = pending && !failed;
          const mode: Mode | "lut" | "layers" | undefined = it.gen?.mode ?? job?.plan?.mode;
          const link = links[it.key];
          const pendingSrc = pending && it.request?.mode !== "generate" && it.request?.mode !== "compose" ? it.request?.images?.[0] : undefined;
          const prompt = it.gen?.prompt || it.request?.prompt || "";
          const what = mode ? (mode === "generate" && link?.kind === "start" ? t("stage.newImage") : MODE_LABEL[mode]) : it.input ? t("stage.imported") : "";
          const tip = [[imageName(labels[it.key]), what, linkText(link, labels)].filter(Boolean).join(" · "), prompt, src ? t("stage.dragToPrompt") : ""].filter(Boolean).join("\n");
          const hot = it.key === focus || link?.parents[0] === focus;
          return (
            <Fragment key={it.key}>
              {(i > 0 || labFirst.length > 0) && <Joint kind={link?.kind ?? "next"} hot={hot} />}
              <button
                data-key={it.key}
                className={`frame ${selected === it.key ? "sel" : ""} ${selParents.has(it.key) ? "src" : ""} ${picked.has(it.key) ? "picked" : ""}`}
                title={tip}
                aria-pressed={picked.size ? picked.has(it.key) : undefined}
                onMouseEnter={() => setHovered(it.key)}
                onClick={(e) => {
                  if (dragged.current) dragged.current = false;
                  else if (e.ctrlKey || e.metaKey || e.shiftKey) pick(it.key, e.shiftKey);
                  else {
                    if (picked.size) setPicked(new Set());
                    anchor.current = it.key;
                    selectItem(it.key);
                  }
                }}
                onPointerDown={(e) => {
                  // A finger scrolls the timeline; dragging onto the prompt is for a mouse.
                  if (e.button === 0 && src && e.pointerType !== "touch") drag.current = { key: it.key, src, x0: e.clientX, y0: e.clientY, moved: false };
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
                <span className="frame-box">
                <span className="frame-img">
                  {src && <DevelopImg src={urls.sourceThumb(src)} />}
                  {pendingSrc && <img className="dim" src={urls.sourceThumb(pendingSrc)} alt="" draggable={false} />}
                  {pending && !failed && job && job.status !== "queued" && <JobPercent job={job} request={it.request} />}
                  {failed && (
                    <span className="frame-state">
                      <X size={16} />
                    </span>
                  )}
                  {src && src === target && (
                    <span className="frame-badge" title={t("stage.promptEditsThis")}>
                      <Pencil size={10} />
                    </span>
                  )}
                </span>
                {(making || selected === it.key) && (
                  <svg className={`frame-silk ${making ? "making" : ""}`} viewBox="0 0 60 60" aria-hidden>
                    <rect className="ring" x="1" y="1" width="58" height="58" rx="17" />
                    {making && <rect className="run" x="1" y="1" width="58" height="58" rx="17" pathLength={200} />}
                  </svg>
                )}
                </span>
                {picked.has(it.key) && (
                  <span className="frame-pick" aria-hidden>
                    <Check size={11} strokeWidth={3} />
                  </span>
                )}
                <span className="frame-label">
                  {mode && MODE_ICON[mode]}
                  {labels[it.key]}
                </span>
              </button>
              {labSlots.filter((x) => x.at === i + 1).map((x) => labFrame(x.doc, x.key, false))}
            </Fragment>
          );
        })}
      </div>
      {ghost && <img className={`drag-ghost ${ghost.over ? "over" : ""}`} src={urls.sourceThumb(ghost.src)} style={{ left: ghost.x, top: ghost.y }} alt="" draggable={false} />}
    </div>
  );
}

/** The whole job's progress in the timeline: the same percentage as its card. */
function JobPercent({ job, request }: { job: JobView; request?: GenerationRequest | null }) {
  const { pct } = useJobPercent(job, request);
  return (
    <span className="frame-pct">
      {Math.floor(pct)}
      <small>%</small>
    </span>
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
  let hint = t("stage.zoomHint");
  if (g && from && showOriginal) content = <ZoomImage key={`original-${g.id}`} src={urls.genOriginal(g.id)} alt={t("stage.beforeUpscalingAlt", { prompt: g.prompt })} />;
  else if (g && base) {
    content = <CompareFullscreen key={g.id} g={g} base={base} />;
    hint = t("stage.holdBForOriginal");
  } else {
    const src = g ? urls.gen(g.id) : urls.input(item.input!.id);
    const size = g ? { width: g.width, height: g.height } : { width: item.input!.width, height: item.input!.height };
    content = <ZoomImage key={src} src={src} source={g ? `gen:${g.id}` : `input:${item.input!.id}`} size={size} alt={g?.prompt ?? item.input?.original_name ?? ""} />;
  }
  return (
    <Fullscreen hint={hint} onClose={onClose} nav={nav}>
      {content}
    </Fullscreen>
  );
}

/** The LUT intensity last saved, the starting point of the next preview. */
let lastIntensity = 1;

export function Stage() {
  const item = useStore(selectedItem);
  const session = useStore((s) => s.session);
  // A phone: swipe between versions, a row of actions and a filmstrip (PhoneStage.tsx).
  const phone = useNarrow();
  const job = useStore((s) => (item?.jobId ? s.jobs[item.jobId] : undefined));
  const labels = useMemo(() => sessionLabels(session), [session]);
  const lab = useLab();
  // A version of a layer document is selected: the Stage shows that layered image instead.
  const labDoc = item ? docById(lab, lab.hidden.get(item.key)) : null;
  const inLab = !!labDoc;
  // The result whose pre-upscale original is on screen instead of it.
  const [originalOf, setOriginalOf] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const canFull = !!item && viewable(item) && !inLab;
  // A LUT being previewed on the selected version (intensity 0-1), before saving it as a new one.
  const [lut, setLut] = useState<{ itemKey: string; source: string; lut: LutEntry; intensity: number } | null>(null);
  const [before, setBefore] = useState(false);
  const [saving, setSaving] = useState(false);
  const lutActive = lut && item && lut.itemKey === item.key ? lut : null;
  // The area painted for the next edit, shown on the image it belongs to (the prompt's first image).
  const mask = useStore((s) => s.composer.mask);
  const ref0 = useStore((s) => s.composer.refs[0]);
  const itemSource = item?.gen ? `gen:${item.gen.id}` : item?.input ? `input:${item.input.id}` : null;
  const masked = !!mask && !!ref0 && mask.refKey === ref0.key && ref0.source === itemSource;
  // Pink with a light edge, as in the layers lab; coloured marks are shown as drawn.
  const tint = useMaskTint(masked && !mask!.marks ? urls.input(mask!.inputId) : null);
  const maskSrc = masked ? (mask!.marks ? urls.input(mask!.marks) : tint ?? undefined) : undefined;

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

  // Another version selected: the preview ends.
  useEffect(() => {
    if (lut && lut.itemKey !== item?.key) setLut(null);
  }, [item?.key, lut]);

  // While previewing a LUT: Esc cancels, holding B shows the image without it.
  useEffect(() => {
    if (!lutActive || full) return;
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || getState().overlay) return;
      if (e.key === "Escape") setLut(null);
      else if (e.key.toLowerCase() === "b" && !e.ctrlKey && !e.metaKey) setBefore(true);
    };
    const up = (e: KeyboardEvent) => e.key.toLowerCase() === "b" && setBefore(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [!!lutActive, full]);

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
      <div className={`stage ${phone ? "phone-stage" : ""}`}>
        {phone ? <PhoneEmpty /> : <Empty />}
        <Timeline labels={labels} lab={lab} />
      </div>
    );
  }

  // The picture (or the job's card), and under it the bar with what to do with it.
  let view: React.ReactNode;
  let bar: React.ReactNode = null;
  if (inLab) {
    view = <LabFrame doc={labDoc!} lab={lab} />;
  } else if (item.kind === "job") {
    view = !job ? (
      <div className="stage-frame">
        <Loader2 className="spin" size={22} />
      </div>
    ) : job.status === "failed" || job.status === "cancelled" ? (
      <Failed job={job} item={item} />
    ) : (
      <Pending key={job.id} job={job} item={item} labels={labels} />
    );
  } else {
    const src = item.gen ? urls.gen(item.gen.id) : urls.input(item.input!.id);
    const w = item.gen?.width ?? item.input!.width;
    const h = item.gen?.height ?? item.input!.height;
    const base = item.gen ? compareBase(item.gen) : null;
    const g = item.gen;
    const from = g?.pipeline?.original_path ? g.pipeline.enlarged_from : null;
    const showOriginal = !!(g && from && originalOf === g.id) && !lutActive;
    const source = g ? `gen:${g.id}` : `input:${item.input!.id}`;
    const startLut = (e: LutEntry) => setLut((l) => ({ itemKey: item.key, source, lut: e, intensity: l?.intensity ?? lastIntensity }));
    const saveLut = async () => {
      if (!lutActive) return;
      setSaving(true);
      try {
        lastIntensity = lutActive.intensity;
        const rec = await api.applyLut(lutActive.lut.name, lutActive.source, lutActive.intensity, getState().privateMode, projectTitle());
        setLut(null);
        addResult(rec);
      } catch (e) {
        toastError(e);
      } finally {
        setSaving(false);
      }
    };
    // The preview is made for the screen: the image's own size at most.
    const previewMax = Math.min(Math.max(w, h), Math.round(1600 * Math.min(2, window.devicePixelRatio || 1)), 4096);
    const lutBar = lutActive && (
      <LutBar
        lut={lutActive.lut}
        intensity={lutActive.intensity}
        saving={saving}
        onPick={startLut}
        onIntensity={(v) => setLut({ ...lutActive, intensity: v })}
        onBefore={setBefore}
        onCancel={() => setLut(null)}
        onSave={saveLut}
      />
    );
    view = (
        <Hatch key={item.key} id={g?.id} aspect={w / h}>
        {lutActive ? (
          <PlainFrame
            key={src}
            source={source}
            alt={g?.prompt ?? item.input?.original_name ?? ""}
            w={w}
            h={h}
            overlay={<LutOverlay src={urls.lutPreview(lutActive.lut.name, lutActive.source, previewMax)} opacity={before ? 0 : lutActive.intensity} />}
            onFullscreen={openFull}
          />
        ) : g && from && showOriginal ? (
          <PlainFrame key={`original-${g.id}`} src={urls.genOriginal(g.id)} alt={t("stage.beforeUpscalingAlt", { prompt: g.prompt })} w={from.width} h={from.height} onFullscreen={openFull} />
        ) : item.gen && base ? (
          <CompareFrame key={`compare-${item.gen.id}`} g={item.gen} base={base} maskSrc={maskSrc} onFullscreen={openFull} />
        ) : (
          <PlainFrame key={src} source={source} alt={item.gen?.prompt ?? item.input?.original_name ?? ""} w={w} h={h} maskSrc={maskSrc} fill={!!item.gen} onFullscreen={openFull} />
        )}
        </Hatch>
    );
    bar = <StageBar item={item} label={labels[item.key]} showOriginal={showOriginal} setShowOriginal={(on) => setOriginalOf(on && g ? g.id : null)} lutBar={lutBar} onLut={startLut} phone={phone} />;
  }

  return (
    <div className={`stage ${phone ? "phone-stage" : ""}`}>
      {phone ? <Swipe onTap={canFull && !lutActive ? openFull : undefined}>{view}</Swipe> : view}
      {/* A phone keeps the bar's room even without one (a job), so the timeline never moves. */}
      {phone ? <div className="phone-bar">{bar}</div> : bar}
      <Timeline labels={labels} lab={lab} />
      {fullscreen}
    </div>
  );
}
