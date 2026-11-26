import { ArrowUp, Brush, Check, ChevronDown, Expand, Eye, FolderOpen, Gauge, ImagePlus, Layers, Lightbulb, Maximize, Pencil, Settings, Settings2, SlidersHorizontal, Sparkles, Square, Undo2, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { activeLoras, activeOverrides, aspectLabel, buildRequest, composing, editing, expansionPixels, formatDuration, hasOutpaint, imageName, MAX_LORAS, moveRef, needsPrompt, parseRatio, toggleLora, typedWords, wantsPromptReview, withActionVerb, type Ref } from "../lib/logic";
import { native } from "../lib/native";
import { haptic } from "../lib/haptics";
import { inBrowser, useNarrow } from "../lib/platform";
import {
  addAsReference, addInputs, openEditor, cancelPromptReview, editShownImage, enhancerAvailable, focusPrompt, getState, itemSource, openSettings, selectedItem, sessionLabels, setProjectLoras, setState, startNewImage, submitComposer, toastError, undoEnhancedPrompt, updateComposer, useStore, type SessionItem,
} from "../lib/store";
import type { InpaintAction, Plan, Quality } from "../lib/types";
import { AdvancedPanel } from "./Advanced";
import { reviewPhotos } from "./PhotoReview";
import { AspectGrid, pickAspect, RatioIcon, resolutionLabel, ResolutionMenu } from "./SizeMenus";
import { Option, Popover, Seg } from "./ui";
import { t } from "../lib/i18n";

// All presets run Qwen-Image 2.1 Turbo (8 steps); they differ in size.
const quality = (): { value: Quality; label: string; sub: string }[] => [
  { value: "fast", label: t("composer.qualityFast"), sub: t("composer.qualityFastSub") },
  { value: "balanced", label: t("composer.qualityBalanced"), sub: "~1.5K" },
  { value: "quality", label: t("composer.qualityQuality"), sub: t("composer.qualityQualitySub") },
];

const inpaintActions = (): { value: InpaintAction; label: string; placeholder: string }[] => [
  { value: "remove", label: t("composer.actionRemove"), placeholder: t("composer.actionRemovePlaceholder") },
  { value: "edit", label: t("composer.actionChange"), placeholder: t("composer.actionChangePlaceholder") },
  { value: "replace", label: t("composer.actionReplace"), placeholder: t("composer.actionReplacePlaceholder") },
  { value: "add", label: t("composer.actionAdd"), placeholder: t("composer.actionAddPlaceholder") },
];

/** "Changing the painted area of image 1.2", one whole sentence per action. */
function paintedAreaText(action: InpaintAction, name: string): string {
  switch (action) {
    case "edit":
      return t("composer.paintedChanging", { name });
    case "remove":
      return t("composer.paintedClearing", { name });
    case "replace":
      return t("composer.paintedReplacing", { name });
    case "add":
      return t("composer.paintedAdding", { name });
  }
}

/** When a phone's open prompt box was last closed by a tap outside it: that tap only closes it
 * (PhoneStage.tsx Swipe ignores it). */
export let promptClosedAt = 0;

/** Images from this device (browser picker, drop, paste): uploaded to the service. */
export async function uploadFiles(files: File[]) {
  const recs = [];
  for (const f of await reviewPhotos(files)) {
    try {
      recs.push(await api.upload(f, f.name || "pasted.png"));
    } catch (e) {
      toastError(e);
    }
  }
  addInputs(recs);
}

export async function importPaths(paths: string[]) {
  const recs = [];
  for (const p of paths) {
    try {
      recs.push(await api.importPath(p));
    } catch (e) {
      toastError(e);
    }
  }
  addInputs(recs);
}

/** Name of a reference when it is part of the project ("Image 1.2"). */
function useRefNames() {
  const session = useStore((s) => s.session);
  return useMemo(() => {
    const labels = sessionLabels(session);
    const bySource = new Map<string, string>();
    for (const i of session) {
      const s = itemSource(i);
      if (s) bySource.set(s, imageName(labels[i.key]));
    }
    return (r: Ref) => bySource.get(r.source) ?? null;
  }, [session]);
}

/** Thumbnails of the images the prompt works on; drag to reorder when there are several. */
function RefStrip() {
  const refs = useStore((s) => s.composer.refs);
  const nameOf = useRefNames();
  const [drag, setDrag] = useState<{ from: number; to: number; active: boolean } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; idx: number } | null>(null);

  const indexAt = (clientX: number) => {
    const els = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(".ref") ?? []);
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return i;
    }
    return els.length;
  };

  return (
    <div
      className="refs"
      ref={boxRef}
      onPointerMove={(e) => {
        if (!start.current) return;
        if (!drag?.active && Math.abs(e.clientX - start.current.x) < 5) return;
        setDrag({ from: start.current.idx, to: indexAt(e.clientX), active: true });
      }}
      onPointerUp={() => {
        if (drag?.active) {
          const to = drag.to > drag.from ? drag.to - 1 : drag.to;
          updateComposer({ refs: moveRef(getState().composer.refs, drag.from, to), mask: null, outpaint: null });
        }
        start.current = null;
        setDrag(null);
      }}
      onPointerLeave={() => {
        start.current = null;
        setDrag(null);
      }}
    >
      {refs.map((r, i) => (
        <div
          key={r.key}
          className={`ref ${drag?.active && drag.from === i ? "dragging" : ""} ${drag?.active && drag.to === i && drag.from !== i ? "drop-before" : ""}`}
          title={
            refs.length > 1
              ? t("composer.refTitleMulti", { n: i + 1, name: nameOf(r) ?? r.name, width: r.width, height: r.height })
              : t("composer.refTitle", { name: nameOf(r) ?? r.name, width: r.width, height: r.height })
          }
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest(".rm")) return;
            (e.currentTarget.parentElement as HTMLElement).setPointerCapture?.(e.pointerId);
            start.current = { x: e.clientX, idx: i };
          }}
        >
          <img src={urls.sourceThumb(r.source)} alt="" draggable={false} />
          {refs.length > 1 && <span className="num">{i + 1}</span>}
          <button
            className="rm"
            title={t("common.remove")}
            aria-label={t("composer.removeImage", { n: i + 1 })}
            onClick={() => {
              const c = getState().composer;
              updateComposer({ refs: c.refs.filter((x) => x.key !== r.key), mask: i === 0 ? null : c.mask, outpaint: i === 0 ? null : c.outpaint });
            }}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Edit image | New image: whether the prompt changes an image or makes a new one (with the
 * images in the prompt as references). */
function ModeSwitch({ editing }: { editing: boolean }) {
  const sel = useStore(selectedItem);
  const session = useStore((s) => s.session);
  const img = sel && (sel.gen || sel.input) ? sel : [...session].reverse().find((i) => i.gen || i.input);
  const refs = useStore((s) => s.composer.refs);
  const editTitle = refs.length
    ? t("composer.editTitleRef")
    : img
      ? t("composer.editTitleShown", { name: imageName(sessionLabels(session)[img.key]).toLowerCase() })
      : t("composer.editTitleNone");
  return (
    <div className="mode-switch" role="radiogroup" aria-label={t("composer.modeLabel")}>
      <button
        className={editing ? "" : "on"}
        role="radio"
        aria-checked={!editing}
        onClick={() => startNewImage()}
        title={t("composer.newImageTitle")}
      >
        <Sparkles size={14} /> <span className="lbl">{t("composer.newImage")}</span>
      </button>
      <button className={editing ? "on" : ""} role="radio" aria-checked={editing} onClick={() => !editing && editShownImage()} title={editing ? t("composer.editsThisImage") : editTitle}>
        <Pencil size={14} /> <span className="lbl">{t("composer.editImage")}</span>
      </button>
    </div>
  );
}

/** Says, in words, what the prompt is going to do, and offers the tools for that image. */
function TargetBar() {
  const c = useStore((s) => s.composer);
  const session = useStore((s) => s.session);
  const nameOf = useRefNames();
  const narrow = useNarrow();

  if (!c.refs.length) {
    if (!session.some((i) => i.gen || i.input)) return null;
    return (
      <div className="target create">
        <ModeSwitch editing={false} />
        <span className="target-text">
          <span className="what">{t("composer.newImage")}</span>
          <span className="sub">{t("composer.newImageSub")}</span>
        </span>
      </div>
    );
  }

  if (composing(c)) {
    const n = c.refs.length;
    return (
      <div className="target create">
        <ModeSwitch editing={false} />
        <RefStrip />
        <span className="target-text">
          <span className="what">{t("composer.newImageWithRefs", { count: n })}</span>
          <span className="sub">{n > 1 ? t("composer.referToThem") : t("composer.whatToTake")}</span>
        </span>
      </div>
    );
  }

  const first = c.refs[0];
  const name = nameOf(first)?.toLowerCase() ?? (first.source.startsWith("gen:") ? t("composer.thisResult") : first.name);
  const outPx = hasOutpaint(c.outpaint) ? expansionPixels(c.outpaint!, first.width, first.height) : null;
  const what =
    c.refs.length > 1
      ? t("composer.combining", { count: c.refs.length })
      : c.mask?.marks
        ? t("composer.addingAtMarks", { name })
        : c.mask
          ? paintedAreaText(c.inpaintAction, name)
          : outPx
            ? t("composer.expanding", { name })
            : t("composer.editingName", { name });
  const sub =
    c.refs.length > 1
      ? t("composer.referToThem")
      : outPx
        ? `${first.width}×${first.height} → ${first.width + outPx.left + outPx.right}×${first.height + outPx.top + outPx.bottom}`
        : `${first.width}×${first.height}`;

  return (
    <div className="target">
      <ModeSwitch editing />
      <RefStrip />
      <span className="target-text">
        <span className="what">{what}</span>
        <span className="sub">{sub}</span>
      </span>
      <span className="spacer" />
      <span className="tool-group">
        <button className={`tool ${c.mask ? "on" : ""}`} data-tour="paint" onClick={() => openEditor("inpaint")} title={t("composer.paintTitle")}>
          <Brush size={14} /> <span className="lbl">{c.mask?.marks ? t("composer.coloursPainted") : c.mask ? t("composer.areaPainted") : t("composer.paintArea")}</span>
        </button>
        {c.mask && (
          <button className="tool-x" title={t("composer.removePainted")} onClick={() => updateComposer({ mask: null })}>
            <X size={13} />
          </button>
        )}
      </span>
      <span className="tool-group">
        <button className={`tool ${outPx ? "on" : ""}`} onClick={() => openEditor("expand")} title={t("composer.expandTitle")}>
          <Expand size={14} /> <span className="lbl">{outPx ? t("composer.expanded") : t("composer.expand")}</span>
        </button>
        {outPx && (
          <button className="tool-x" title={t("composer.removeExpansion")} onClick={() => updateComposer({ outpaint: null })}>
            <X size={13} />
          </button>
        )}
      </span>
      {/* The lab needs a mouse and room: not in the phone layout. */}
      {c.refs.length === 1 && !narrow && (
        <span className="tool-group">
          <button className="tool lab" onClick={() => setState({ overlay: "layers" })} title={t("composer.layersTitle")}>
            <Layers size={14} /> <span className="lbl">{t("composer.layersLab")}</span>
          </button>
        </span>
      )}
    </div>
  );
}

/** Adds a reference: a version from this project, or files. */
function AddImage() {
  const session = useStore((s) => s.session);
  const refs = useStore((s) => s.composer.refs);
  const create = useStore((s) => s.composer.create);
  const labels = useMemo(() => sessionLabels(session), [session]);
  const used = new Set(refs.map((r) => r.source));
  const candidates = session.filter((i) => {
    const s = itemSource(i);
    return s && !used.has(s);
  });
  const browse = async () => (inBrowser ? uploadFiles(await native.pickImageFiles()) : importPaths(await native.pickImages()));
  // In a project, images added while not editing are references for a new image.
  const asReference = refs.length > 0 || create || session.length > 0;
  const title = asReference ? t("composer.addReference") : t("composer.addToEdit");
  const titleDrop = asReference ? t("composer.addReferenceDrop") : t("composer.addToEditDrop");

  if (!candidates.length) {
    return (
      <button className="icon-btn" title={titleDrop} aria-label={title} onClick={browse}>
        <ImagePlus size={19} />
      </button>
    );
  }
  return (
    <Popover
      placement="top-start"
      trigger={(open, toggle) => (
        <button className={`icon-btn ${open ? "active" : ""}`} title={title} aria-label={title} onClick={toggle}>
          <ImagePlus size={19} />
        </button>
      )}
    >
      {(close) => (
        <div className="add-menu">
          <div className="label">{asReference ? (refs.length && !create ? t("composer.addAsReference") : t("composer.addReferenceForNew")) : t("composer.editAnImage")}</div>
          <div className="add-grid">
            {candidates.map((it: SessionItem) => (
              <button key={it.key} title={it.gen?.prompt ?? imageName(labels[it.key])} onClick={() => (addAsReference(it), close())}>
                <img src={urls.sourceThumb(itemSource(it)!)} alt="" draggable={false} />
                <span>{labels[it.key]}</span>
              </button>
            ))}
          </div>
          <button className="opt" onClick={() => (close(), browse())}>
            <span className="check">
              <FolderOpen size={15} />
            </span>
            <span>{t("composer.browseFiles")}</span>
          </button>
          <div className="muted" style={{ padding: "2px 10px 6px" }}>
            {t("composer.dropOrPaste")}
          </div>
        </div>
      )}
    </Popover>
  );
}

function usePlanPreview(): { plan: Plan | null; error: string | null } {
  const c = useStore((s) => s.composer);
  const connected = useStore((s) => s.connected);
  const [res, setRes] = useState<{ plan: Plan | null; error: string | null }>({ plan: null, error: null });
  useEffect(() => {
    if (!connected) return;
    const prompt = c.prompt.trim() || "image";
    const req = { ...buildRequest(c), prompt };
    let cancelled = false;
    const t = window.setTimeout(() => {
      api.plan(req).then(
        (p) => !cancelled && setRes({ plan: p, error: null }),
        (e) => !cancelled && setRes({ plan: null, error: e?.message ?? null }),
      );
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [connected, c.prompt, c.refs, c.mode, c.quality, c.resolution, c.aspect, c.outpaint, c.mask, c.inpaintAction, c.customWidth, c.customHeight, c.advanced]);
  return res;
}

const weightLabel = (w: number) => t("composer.percent", { percent: Math.round(w * 100) });

/** The project's LoRAs: shown once any LoRA is loaded in Settings. With one LoRA a click turns
 * it on or off; with more, a list with one switch each. */
function LoraBadge() {
  const all = useStore((s) => s.loras);
  const choice = useStore((s) => s.composer.loras);
  if (all.length === 0) return null;
  const on = activeLoras({ loras: choice }, all);
  const names = all.filter((l) => on.includes(l.id)).map((l) => `${l.name} (${weightLabel(l.weight)})`);
  const title = on.length ? t("composer.loraOn", { names: names.join(", ") }) : t("composer.loraNone");
  const toggle = (id: string) => setProjectLoras(toggleLora({ loras: choice }, all, id));
  if (all.length === 1) {
    const l = all[0];
    return (
      <button
        className={`pill toggle ${on.length ? "on" : ""}`}
        role="switch"
        aria-checked={on.length > 0}
        disabled={!l.available}
        onClick={() => toggle(l.id)}
        title={l.available ? (on.length ? t("composer.loraClickOff", { title }) : t("composer.loraClickOn", { title })) : t("composer.loraMissing")}
      >
        <Layers size={15} />
        <span className="lbl">LoRA</span>
      </button>
    );
  }
  return (
    <Popover
      trigger={(open, toggleOpen) => (
        <button className={`pill toggle ${on.length || open ? "on" : ""}`} onClick={toggleOpen} title={title}>
          <Layers size={15} />
          <span className="lbl">LoRA</span>
          {on.length > 0 && <span className="lora-count">{on.length}</span>}
          <ChevronDown size={13} className="chev" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="label">{t("composer.loraHeader", { max: MAX_LORAS })}</div>
          {all.map((l) => {
            const active = on.includes(l.id);
            const full = !active && on.length >= MAX_LORAS;
            return (
              <button
                key={l.id}
                className="opt"
                role="menuitemcheckbox"
                aria-checked={active}
                disabled={!l.available || full}
                onClick={() => toggle(l.id)}
                title={!l.available ? t("composer.loraMissing") : full ? t("composer.loraMax", { max: MAX_LORAS }) : l.triggerWords ? t("composer.loraAdds", { words: l.triggerWords }) : undefined}
              >
                <span className="check">{active && <Check size={15} />}</span>
                <span className="lora-name">{l.name}</span>
                <span className="sub">{l.available ? weightLabel(l.weight) : t("composer.loraMissingShort")}</span>
              </button>
            );
          })}
          <button className="opt" onClick={() => (close(), openSettings("lora"))}>
            <span className="check">
              <Settings2 size={15} />
            </span>
            <span>{t("composer.manageLoras")}</span>
          </button>
        </>
      )}
    </Popover>
  );
}

/** Prompt+: off; on (writes the prompt, then the image is made); or on with the prompt written
 * into the box first, to read and change before pressing Enter again. */
function PromptPlus() {
  const c = useStore((s) => s.composer);
  const mode = !c.enhance ? "off" : c.enhanceReview ? "review" : "write";
  const title =
    mode === "off"
      ? t("composer.plusOffTitle")
      : mode === "write"
        ? t("composer.plusWriteTitle")
        : t("composer.plusReviewTitle");
  const pick = (m: "off" | "write" | "review") => updateComposer({ enhance: m !== "off", enhanceReview: m === "off" ? c.enhanceReview : m === "review" });
  return (
    <Popover
      className="prompt-plus"
      trigger={(open, toggle) => (
        <button className={`pill toggle ${c.enhance || open ? "on" : ""}`} onClick={toggle} title={title} aria-label={mode === "off" ? t("composer.plusOffLabel") : mode === "write" ? t("composer.plusOnLabel") : t("composer.plusReviewLabel")}>
          <WandSparkles size={15} />
          <span className="lbl">Prompt+</span>
          {mode === "review" && <Eye size={13} aria-hidden />}
          <ChevronDown size={13} className="chev" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-title">Prompt+</div>
          <Option selected={mode === "off"} label={t("common.off")} onClick={() => (pick("off"), close())} />
          <Option selected={mode === "write"} label={t("common.on")} sub={t("composer.plusWriteSub")} onClick={() => (pick("write"), close())} />
          <Option selected={mode === "review"} label={t("composer.plusReview")} sub={t("composer.plusReviewSub")} onClick={() => (pick("review"), close())} />
          {/* How much context Prompt+ gives the image model: only about what is there or what changes. */}
          <div className="menu-sep" />
          <div className="label">{t("composer.detail")}</div>
          <Option selected={!c.enhanceDetail} label={t("composer.detailStandard")} sub={t("composer.detailStandardSub")} onClick={() => (updateComposer({ enhanceDetail: false }), close())} />
          <Option selected={c.enhanceDetail} label={t("composer.detailDetailed")} sub={t("composer.detailDetailedSub")} onClick={() => (updateComposer({ enhance: true, enhanceDetail: true }), close())} />
          <div className="menu-sep" />
          <button className="opt" onClick={() => (close(), openSettings("general", "prompt-plus"))}>
            <span className="check">
              <Settings size={15} />
            </span>
            <span>{t("composer.plusInstructions")}</span>
          </button>
        </>
      )}
    </Popover>
  );
}

/** A phone with the box closed: what the prompt works on, as a small picture (the image it edits,
 * or a new image's first reference) or a spark for a new image from words alone, and in words. */
function PromptContext() {
  const c = useStore((s) => s.composer);
  const nameOf = useRefNames();
  const first = c.refs[0];
  if (!first) {
    return (
      <span className="prompt-ctx-wrap">
        <span className="prompt-ctx new">
          <Sparkles size={16} />
        </span>
        <span className="prompt-ctx-label">{t("composer.newImage")}</span>
      </span>
    );
  }
  const create = composing(c);
  const n = c.refs.length;
  return (
    <span className="prompt-ctx-wrap">
      <span className="prompt-ctx">
        <img src={urls.sourceThumb(first.source)} alt="" draggable={false} />
        {create ? n > 1 && <span className="num">{n}</span> : <span className="frame-badge"><Pencil size={9} /></span>}
      </span>
      <span className="prompt-ctx-label">
        {create
          ? t("composer.newImageRefs", { count: n })
          : n > 1
            ? t("composer.combining", { count: n })
            : t("composer.editingName", { name: (nameOf(first) ?? t("composer.thisImage")).toLowerCase() })}
      </span>
    </span>
  );
}

/** Under the prompt: the prompt in the box was written by Prompt+ from the user's words. */
function EnhancedFrom({ words }: { words: string }) {
  return (
    <div className="enhanced-from">
      <WandSparkles size={12} aria-hidden />
      <span className="text" title={words}>
        {t("composer.enhancedFrom", { words })}
      </span>
      <button className="link" onClick={undoEnhancedPrompt} title={t("composer.undoEnhancedTitle")}>
        <Undo2 size={12} /> {t("composer.undo")}
      </button>
    </div>
  );
}

export function Composer() {
  const c = useStore((s) => s.composer);
  const hasProject = useStore((s) => s.session.length > 0);
  const { plan, error } = usePlanPreview();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hasImages = c.refs.length > 0;
  const overrides = activeOverrides(c.advanced);
  const canEnhance = useStore(enhancerAvailable);
  const newImage = !editing(c);
  // Prompt+ review: the prompt it is writing streams into the box, which is read-only meanwhile.
  const review = useStore((s) => s.review);
  const reviewJob = useStore((s) => (s.review ? s.jobs[s.review.jobId] : undefined));
  const reviewing = !!review;
  // A phone: one line over the image until tapped, then the whole box (over a scrim).
  const phone = useNarrow();
  const [opened, setOpened] = useState(false);
  const expanded = !phone || opened || reviewing;
  const collapse = () => {
    taRef.current?.blur();
    setOpened(false);
  };
  // A phone: a tap outside the box (and outside its menus) closes it; the screen above makes room
  // for it while it is open, nothing covers the screen.
  useEffect(() => {
    if (!phone || !opened || reviewing) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest(".composer-wrap, .popover, .sheet-scrim, .modal-scrim, .viewer")) return;
      promptClosedAt = performance.now();
      collapse();
    };
    // Capture phase: the image stops its own pointerdown (press to compare).
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  });
  const submit = () => {
    if (phone) haptic();
    submitComposer();
    if (phone && !wantsPromptReview(getState().composer)) collapse();
  };

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const fit = () => {
      ta.style.height = "auto";
      ta.style.height = Math.min(200, ta.scrollHeight) + "px";
    };
    fit();
    // Also when its width changes: WebKitGTK (Linux) lays the box out while the window is still
    // hidden at startup, so the first measure wraps the placeholder into a column.
    let width = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== width) {
        width = ta.clientWidth;
        fit();
      }
    });
    ro.observe(ta);
    return () => ro.disconnect();
  }, [c.prompt, reviewJob?.enhanced_prompt]);

  const outPx = hasOutpaint(c.outpaint) && c.refs[0] ? expansionPixels(c.outpaint!, c.refs[0].width, c.refs[0].height) : null;

  const placeholder = reviewing
    ? reviewJob?.status === "starting_backend" || reviewJob?.status === "queued"
      ? t("composer.phPlusReady")
      : hasImages
        ? t("composer.phPlusLooking")
        : t("composer.phPlusReading")
    : !hasImages
    ? hasProject
      ? t("composer.phNewInProject")
      : t("composer.phFirst")
    : composing(c)
      ? c.refs.length > 1
        ? t("composer.phComposeMulti")
        : t("composer.phComposeOne")
    : c.refs.length > 1
      ? t("composer.phCombine")
      : c.mask?.marks
        ? t("composer.phMarks")
      : c.mask
        ? inpaintActions().find((a) => a.value === c.inpaintAction)!.placeholder
        : outPx
          ? t("composer.phExpand")
          : t("composer.phChange");

  // The closed box on a phone has one short line.
  const shortPlaceholder = !hasImages ? t("composer.phShortNew") : composing(c) ? t("composer.phShortCompose") : c.mask ? t("composer.phShortPainted") : t("composer.phChange");

  const hint = (() => {
    if (error) return error;
    if (!plan) return "";
    // 0 = this machine's speed is not measured yet (the first image measures it).
    const time = plan.estimated_seconds > 0 ? `~${formatDuration(plan.estimated_seconds)}` : t("composer.timeUnknown");
    return `${plan.output.width}×${plan.output.height} · ${time}`;
  })();
  const hintTitle = plan
    ? [
        plan.working.width !== plan.output.width || plan.working.height !== plan.output.height ? t("composer.worksAt", { width: plan.working.width, height: plan.working.height }) : "",
        plan.optimized_for_vram ? t("composer.optimizedVram") : "",
        ...plan.notes,
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const shaped = !c.mask && !outPx;
  const custom = c.resolution === "custom";
  const aspectText = custom ? aspectLabel(c.customWidth, c.customHeight) : c.aspect === "auto" ? (plan ? plan.aspect_label : t("common.auto")) : c.aspect;
  const aspectRatioNow = custom
    ? c.customWidth / c.customHeight
    : (parseRatio(c.aspect) ?? (plan ? plan.output.width / plan.output.height : 1));

  const promptBox = (
    <textarea
      id="prompt"
      ref={taRef}
      className={`prompt ${reviewing ? "writing" : ""}`}
      rows={1}
      value={reviewing ? (reviewJob?.enhanced_prompt ?? "") : c.prompt}
      readOnly={reviewing}
      placeholder={expanded ? placeholder : shortPlaceholder}
      // Emptying a prompt Prompt+ wrote starts over with the user's own words.
      onChange={(e) => updateComposer({ prompt: e.target.value, ...(e.target.value.trim() ? {} : { enhancedFrom: null }) })}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          submit();
        } else if (e.key === "ArrowUp" && !c.prompt) {
          const last = getState().lastPrompt;
          if (last) {
            e.preventDefault();
            updateComposer({ prompt: last });
          }
        }
      }}
      onFocus={() => phone && setOpened(true)}
      enterKeyHint={phone ? "send" : undefined}
      spellCheck
    />
  );

  const sendButton = reviewing ? (
    <button className="send" title={t("composer.stopPlusTitle")} aria-label={t("composer.stopPlus")} onClick={() => cancelPromptReview()}>
      <Square size={14} strokeWidth={2.4} />
    </button>
  ) : (
    <button
      className="send"
      title={wantsPromptReview(c) ? t("composer.sendWriteTitle") : newImage ? t("composer.sendCreateTitle") : t("composer.sendApplyTitle")}
      aria-label={wantsPromptReview(c) ? t("composer.sendWrite") : t("composer.sendGenerate")}
      disabled={!typedWords(c) && needsPrompt(c)}
      onClick={submit}
    >
      {wantsPromptReview(c) ? <WandSparkles size={17} strokeWidth={2.2} /> : <ArrowUp size={18} strokeWidth={2.4} />}
    </button>
  );

  return (
    <div className={`composer-wrap ${phone ? "phone" : ""} ${phone && expanded ? "open" : ""}`}>
      <div className="composer" onClick={phone && !expanded ? () => taRef.current?.focus() : undefined}>
        {/* A phone writes on a screen of its own: close it here (sending closes it too). */}
        {phone && expanded && (
          <div className="compose-head">
            <button className="glass-btn" title={t("common.close")} aria-label={t("common.close")} onClick={collapse}>
              <ChevronDown size={22} />
            </button>
            <span className="compose-hint" title={hintTitle}>
              {hint}
            </span>
          </div>
        )}
        {expanded && <TargetBar />}
        {phone ? (
          <div className="prompt-row">
            {promptBox}
            {!expanded && (
              <div className="closed-row">
                <PromptContext />
                {sendButton}
              </div>
            )}
          </div>
        ) : (
          promptBox
        )}
        {expanded && c.enhancedFrom && !reviewing && <EnhancedFrom words={c.enhancedFrom} />}
        {expanded && (
          <div className="controls-row">
          <div className="controls">
            <AddImage />

            {c.mask && !c.mask.marks && (
              <Seg value={c.inpaintAction} options={inpaintActions()} onChange={(v) => (updateComposer({ inpaintAction: v, prompt: withActionVerb(c.prompt, v), enhancedFrom: null }), focusPrompt(true))} />
            )}

            {shaped && (
              <Popover
                className="wide"
                trigger={(open, toggle) => (
                  <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title={t("composer.aspectRatio")}>
                    <RatioIcon ratio={aspectRatioNow} size={15} />
                    {aspectText}
                    <ChevronDown size={13} className="chev" />
                  </button>
                )}
              >
                {(close) => <AspectGrid value={custom ? aspectLabel(c.customWidth, c.customHeight) : c.aspect} onPick={(r) => (pickAspect(r), close())} auto={{ sub: newImage ? t("composer.aspectAutoNew") : t("composer.aspectAutoEdit") }} />}
              </Popover>
            )}

            <Popover
              className="wide"
              trigger={(open, toggle) => (
                <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title={t("composer.resolution")}>
                  <Maximize size={14} />
                  {resolutionLabel(c.resolution, c.customWidth, c.customHeight)}
                  <ChevronDown size={13} className="chev" />
                </button>
              )}
            >
              {(close) => <ResolutionMenu plan={plan} close={close} />}
            </Popover>

            <Popover
              trigger={(open, toggle) => (
                <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title={t("composer.quality")}>
                  <Gauge size={15} />
                  <span className="lbl">{quality().find((q) => q.value === c.quality)?.label}</span>
                  <ChevronDown size={13} className="chev" />
                </button>
              )}
            >
              {(close) =>
                quality().map((q) => <Option key={q.value} selected={c.quality === q.value} label={q.label} sub={q.sub} onClick={() => (updateComposer({ quality: q.value }), close())} />)
              }
            </Popover>

            {canEnhance && <PromptPlus />}

            <LoraBadge />

            <Popover
              placement="top-start"
              className="panel"
              trigger={(open, toggle) => (
                <button
                  className={`icon-btn has-badge ${open ? "active" : ""}`}
                  onClick={toggle}
                  title={overrides.length ? t("composer.advancedOverriding", { list: overrides.join(", ") }) : t("composer.advanced")}
                  aria-label={overrides.length ? t("composer.advancedOverridesLabel", { count: overrides.length }) : t("composer.advancedSettings")}
                >
                  <SlidersHorizontal size={17} />
                  {overrides.length > 0 && <span className="override-dot" />}
                </button>
              )}
            >
              {() => <AdvancedPanel plan={plan} />}
            </Popover>


            <button className="icon-btn" onClick={() => setState({ overlay: "prompt-tips" })} title={t("composer.promptTips")} aria-label={t("composer.promptTips")}>
              <Lightbulb size={17} />
            </button>

            <span className="spacer" />
            <span className="plan-hint" title={hintTitle}>
              {hint}
            </span>
            {!phone && sendButton}
          </div>
          {/* A phone: the buttons scroll; send stays outside them, so nothing slides under it. */}
          {phone && sendButton}
          </div>
        )}
      </div>
    </div>
  );
}
