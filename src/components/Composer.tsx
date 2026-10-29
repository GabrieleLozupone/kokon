import { ArrowUp, Brush, Check, ChevronDown, Expand, Eye, FolderOpen, Gauge, ImagePlus, Layers, Lightbulb, Maximize, Pencil, Repeat, Settings2, SlidersHorizontal, Sparkles, Square, Undo2, Video, WandSparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, urls } from "../lib/api";
import { activeLoras, activeOverrides, aspectLabel, buildRequest, composing, editing, enhancerApplies, expansionPixels, formatDuration, hasOutpaint, imageName, MAX_LORAS, moveRef, needsPrompt, parseRatio, toggleLora, wantsPromptReview, type Ref } from "../lib/logic";
import { native } from "../lib/native";
import { haptic } from "../lib/haptics";
import { inBrowser, useNarrow } from "../lib/platform";
import {
  addAsReference, addInputs, cancelPromptReview, editShownImage, enhancerAvailable, getState, itemSource, openSettings, selectedItem, sessionLabels, setProjectLoras, setState, startNewImage, submitComposer, toastError, undoEnhancedPrompt, updateComposer, useStore, type SessionItem,
} from "../lib/store";
import type { InpaintAction, Plan, Quality } from "../lib/types";
import { AdvancedPanel } from "./Advanced";
import { reviewPhotos } from "./PhotoReview";
import { AspectGrid, pickAspect, RatioIcon, resolutionLabel, ResolutionMenu } from "./SizeMenus";
import { Option, Popover, Seg } from "./ui";

// All presets run Qwen-Image 2.1 Turbo (8 steps); they differ in size.
const QUALITY: { value: Quality; label: string; sub: string }[] = [
  { value: "fast", label: "Fast", sub: "~1 MP · fastest" },
  { value: "balanced", label: "Balanced", sub: "~1.5K" },
  { value: "quality", label: "Quality", sub: "native 2K · slowest" },
];

const VIDEO_DURATIONS: { frames: number; label: string; sub: string }[] = [
  { frames: 49, label: "2s (49f)", sub: "49 frames · 24 fps · fast" },
  { frames: 73, label: "3s (73f)", sub: "73 frames · 24 fps · balanced" },
  { frames: 97, label: "4s (97f)", sub: "97 frames · 24 fps · quality" },
  { frames: 121, label: "5s (121f)", sub: "121 frames · 24 fps · maximum" },
];

const INPAINT_ACTIONS: { value: InpaintAction; label: string; placeholder: string }[] = [
  { value: "edit", label: "Change", placeholder: "Describe the change in the painted area…" },
  { value: "remove", label: "Remove", placeholder: "What to remove (optional)…" },
  { value: "replace", label: "Replace", placeholder: "What to put there instead…" },
  { value: "add", label: "Add", placeholder: "What to add in the painted area…" },
];

const INPAINT_VERB: Record<InpaintAction, string> = { edit: "Changing", remove: "Clearing", replace: "Replacing", add: "Adding to" };

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
          title={`${refs.length > 1 ? `Image ${i + 1}: ` : ""}${nameOf(r) ?? r.name} · ${r.width}×${r.height}${refs.length > 1 ? " — drag to reorder" : ""}`}
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
            title="Remove"
            aria-label={`Remove image ${i + 1}`}
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

/** Edit image | New image | Video: whether the prompt changes an image, makes a new one, or generates video. */
function ModeSwitch({ editing }: { editing: boolean }) {
  const mode = useStore((s) => s.composer.mode);
  const sel = useStore(selectedItem);
  const session = useStore((s) => s.session);
  const img = sel && (sel.gen || sel.input) ? sel : [...session].reverse().find((i) => i.gen || i.input);
  const refs = useStore((s) => s.composer.refs);
  const name = refs.length ? "image 1 of the prompt" : img ? `${imageName(sessionLabels(session)[img.key]).toLowerCase()}, the image shown` : "";
  const isVideo = mode === "video";
  const isEditing = editing && !isVideo;
  const isNewImage = !editing && !isVideo;

  return (
    <div className="mode-switch" role="radiogroup" aria-label="What the prompt does">
      <button
        className={isNewImage ? "on" : ""}
        role="radio"
        aria-checked={isNewImage}
        onClick={() => {
          updateComposer({ mode: "generate" });
          editing && startNewImage();
        }}
        title="Make a new image. Images you add are references (a person, a product, a style) for it, not edited; your images stay in the timeline"
      >
        <Sparkles size={14} /> <span className="lbl">New image</span>
      </button>
      {img && (
        <button
          className={isEditing ? "on" : ""}
          role="radio"
          aria-checked={isEditing}
          onClick={() => {
            updateComposer({ mode: "auto" });
            !editing && editShownImage();
          }}
          title={editing ? "The prompt edits this image" : `Edit ${name}`}
        >
          <Pencil size={14} /> <span className="lbl">Edit image</span>
        </button>
      )}
      <button
        className={isVideo ? "on" : ""}
        role="radio"
        aria-checked={isVideo}
        onClick={() => updateComposer({ mode: "video" })}
        title="Generate a video (Wan2.2 local diffusion)"
      >
        <Video size={14} /> <span className="lbl">Video</span>
      </button>
    </div>
  );
}

/** Says, in words, what the prompt is going to do, and offers the tools for that image. */
function TargetBar() {
  const c = useStore((s) => s.composer);
  const nameOf = useRefNames();

  if (c.mode === "video") {
    const isI2V = c.refs.length > 0;
    const what = isI2V ? `Image to Video: ${nameOf(c.refs[0]) ?? c.refs[0].name}` : "Text to Video";
    const sub = isI2V ? "Animate this image with Wan2.2" : "Generate video from prompt with Wan2.2";
    return (
      <div className="target">
        <ModeSwitch editing={isI2V} />
        {isI2V && <RefStrip />}
        <span className="target-text">
          <span className="what">{what}</span>
          <span className="sub">{sub}</span>
        </span>
      </div>
    );
  }

  if (!c.refs.length) {
    return (
      <div className="target create">
        <ModeSwitch editing={false} />
        <span className="target-text">
          <span className="what">New image</span>
          <span className="sub">From the prompt; images you add are references</span>
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
          <span className="what">New image with {n === 1 ? "1 reference" : `${n} references`}</span>
          <span className="sub">{n > 1 ? "Refer to them as image 1, image 2… in the prompt" : "Say what to take from it: the person, the product, the style…"}</span>
        </span>
      </div>
    );
  }

  const first = c.refs[0];
  const name = nameOf(first)?.toLowerCase() ?? (first.source.startsWith("gen:") ? "this result" : first.name);
  const outPx = hasOutpaint(c.outpaint) ? expansionPixels(c.outpaint!, first.width, first.height) : null;
  const what =
    c.refs.length > 1 ? `Combining ${c.refs.length} images` : c.mask ? `${INPAINT_VERB[c.inpaintAction]} the painted area of ${name}` : outPx ? `Expanding ${name}` : `Editing ${name}`;
  const sub =
    c.refs.length > 1
      ? "Refer to them as image 1, image 2… in the prompt"
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
        <button className={`tool ${c.mask ? "on" : ""}`} data-tour="paint" onClick={() => setState({ overlay: "inpaint" })} title="Paint the area to change; the rest stays as it is">
          <Brush size={14} /> <span className="lbl">{c.mask ? "Area painted" : "Paint area"}</span>
        </button>
        {c.mask && (
          <button className="tool-x" title="Remove the painted area" onClick={() => updateComposer({ mask: null })}>
            <X size={13} />
          </button>
        )}
      </span>
      <span className="tool-group">
        <button className={`tool ${outPx ? "on" : ""}`} onClick={() => setState({ overlay: "expand" })} title="Extend the image beyond its borders">
          <Expand size={14} /> <span className="lbl">{outPx ? "Expanded" : "Expand"}</span>
        </button>
        {outPx && (
          <button className="tool-x" title="Remove the expansion" onClick={() => updateComposer({ outpaint: null })}>
            <X size={13} />
          </button>
        )}
      </span>
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
  const title = asReference ? "Add a reference image" : "Add an image to edit";

  if (!candidates.length) {
    return (
      <button className="icon-btn" title={`${title} (or drop / paste)`} aria-label={title} onClick={browse}>
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
          <div className="label">{asReference ? (refs.length && !create ? "Add an image as reference" : "Add a reference for the new image") : "Edit an image"}</div>
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
            <span>Browse files…</span>
          </button>
          <div className="muted" style={{ padding: "2px 10px 6px" }}>
            You can also drop or paste images.
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
  }, [connected, c.prompt, c.refs, c.mode, c.quality, c.resolution, c.aspect, c.outpaint, c.mask, c.inpaintAction, c.customWidth, c.customHeight, c.video_frames, c.fps, c.advanced]);
  return res;
}

const weightLabel = (w: number) => `${Math.round(w * 100)} %`;

/** The project's LoRAs: shown once any LoRA is loaded in Settings. With one LoRA a click turns
 * it on or off; with more, a list with one switch each. */
function LoraBadge() {
  const all = useStore((s) => s.loras);
  const choice = useStore((s) => s.composer.loras);
  if (all.length === 0) return null;
  const on = activeLoras({ loras: choice }, all);
  const names = all.filter((l) => on.includes(l.id)).map((l) => `${l.name} (${weightLabel(l.weight)})`);
  const title = on.length ? `LoRA on in this project: ${names.join(", ")}` : "LoRA: none on in this project";
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
        title={l.available ? `${title}. Click to turn ${on.length ? "off" : "on"}.` : "This LoRA's file is missing: load it again in Settings → LoRA."}
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
          <div className="label">LoRA in this project · up to {MAX_LORAS}</div>
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
                title={!l.available ? "This LoRA's file is missing: load it again in Settings → LoRA." : full ? `At most ${MAX_LORAS} LoRAs at once.` : l.triggerWords ? `Adds: ${l.triggerWords}` : undefined}
              >
                <span className="check">{active && <Check size={15} />}</span>
                <span className="lora-name">{l.name}</span>
                <span className="sub">{l.available ? weightLabel(l.weight) : "missing"}</span>
              </button>
            );
          })}
          <button className="opt" onClick={() => (close(), openSettings("lora"))}>
            <span className="check">
              <Settings2 size={15} />
            </span>
            <span>Manage LoRAs…</span>
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
      ? "Prompt+: let the model rewrite a short prompt, in any language, as a detailed English description before making the image. Adds a few seconds."
      : mode === "write"
        ? "Prompt+ on: before making the image, the model rewrites your prompt as a detailed English description (looking at your images). You see it being written; the result keeps both."
        : "Prompt+ on, review first: the model writes the detailed prompt into the box; change it if you like, then press Enter to make the image.";
  const pick = (m: "off" | "write" | "review") => updateComposer({ enhance: m !== "off", enhanceReview: m === "off" ? c.enhanceReview : m === "review" });
  return (
    <Popover
      className="prompt-plus"
      trigger={(open, toggle) => (
        <button className={`pill toggle ${c.enhance || open ? "on" : ""}`} onClick={toggle} title={title} aria-label={`Prompt+: ${mode === "off" ? "off" : mode === "write" ? "on" : "on, review first"}`}>
          <WandSparkles size={15} />
          <span className="lbl">Prompt+</span>
          {mode === "review" && <Eye size={13} aria-hidden />}
          <ChevronDown size={13} className="chev" />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="label">Prompt+</div>
          <Option selected={mode === "off"} label="Off" onClick={() => (pick("off"), close())} />
          <Option selected={mode === "write"} label="On" sub="writes, then makes" onClick={() => (pick("write"), close())} />
          <Option selected={mode === "review"} label="Review first" sub="you edit it first" onClick={() => (pick("review"), close())} />
          <button className="opt" onClick={() => (close(), openSettings("general"))}>
            <span className="check">
              <Settings2 size={15} />
            </span>
            <span>Prompt+ instructions…</span>
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
        <span className="prompt-ctx-label">New image</span>
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
        {create ? `New image · ${n === 1 ? "1 reference" : `${n} references`}` : n > 1 ? `Combining ${n} images` : `Editing ${(nameOf(first) ?? "this image").toLowerCase()}`}
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
        Written by Prompt+ from “{words}”. Change it if you like; Enter makes the image.
      </span>
      <button className="link" onClick={undoEnhancedPrompt} title="Back to your own words">
        <Undo2 size={12} /> Undo
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
  const canEnhance = useStore(enhancerAvailable) && enhancerApplies(c);
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
      ? "Prompt+ is getting ready…"
      : hasImages
        ? "Prompt+ is looking at your images…"
        : "Prompt+ is reading your idea…"
    : c.mode === "video"
      ? hasImages
        ? "Describe motion or animation for this image…"
        : "Describe a video scene, camera motion, action…"
    : !hasImages
    ? hasProject
      ? "Describe a new image: subject, what it's doing, setting…"
      : "Describe an image (subject, action, setting) or drop one in to edit…"
    : composing(c)
      ? c.refs.length > 1
        ? "Describe the new image: who or what from image 1, image 2… and the scene…"
        : "Describe the new image with the reference: the scene, what it's doing…"
    : c.refs.length > 1
      ? "Describe how to combine image 1, image 2…"
      : c.mask
        ? INPAINT_ACTIONS.find((a) => a.value === c.inpaintAction)!.placeholder
        : outPx
          ? "Describe the extended scene (optional details)…"
          : "Describe the change…";

  // The closed box on a phone has one short line.
  const shortPlaceholder = !hasImages ? "Describe a new image…" : composing(c) ? "Describe the new image…" : c.mask ? "Describe the painted area…" : "Describe the change…";

  const hint = (() => {
    if (error) return error;
    if (!plan) return "";
    // 0 = this machine's speed is not measured yet (the first image measures it).
    const time = plan.estimated_seconds > 0 ? `~${formatDuration(plan.estimated_seconds)}` : "time known after the first image";
    return `${plan.output.width}×${plan.output.height} · ${time}`;
  })();
  const hintTitle = plan
    ? [
        plan.working.width !== plan.output.width || plan.working.height !== plan.output.height ? `Works at ${plan.working.width}×${plan.working.height}` : "",
        plan.optimized_for_vram ? "Optimized for GPU memory" : "",
        ...plan.notes,
      ]
        .filter(Boolean)
        .join("\n")
    : "";
  const shaped = !c.mask && !outPx;
  const custom = c.resolution === "custom";
  const aspectText = custom ? aspectLabel(c.customWidth, c.customHeight) : c.aspect === "auto" ? (plan ? plan.aspect_label : "Auto") : c.aspect;
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
    <button className="send" title="Stop Prompt+ (your prompt stays)" aria-label="Stop Prompt+" onClick={() => cancelPromptReview()}>
      <Square size={14} strokeWidth={2.4} />
    </button>
  ) : (
    <button
      className="send"
      title={wantsPromptReview(c) ? "Write the prompt with Prompt+ (Enter)" : newImage ? "Create (Enter)" : "Apply (Enter)"}
      aria-label={wantsPromptReview(c) ? "Write the prompt" : "Generate"}
      disabled={!c.prompt.trim() && needsPrompt(c)}
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
            <button className="glass-btn" title="Close" aria-label="Close" onClick={collapse}>
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

            {c.mask && (
              <Seg value={c.inpaintAction} options={INPAINT_ACTIONS} onChange={(v) => updateComposer({ inpaintAction: v })} />
            )}

            {shaped && (
              <Popover
                className="wide"
                trigger={(open, toggle) => (
                  <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Aspect ratio">
                    <RatioIcon ratio={aspectRatioNow} size={15} />
                    {aspectText}
                    <ChevronDown size={13} className="chev" />
                  </button>
                )}
              >
                {(close) => <AspectGrid value={custom ? aspectLabel(c.customWidth, c.customHeight) : c.aspect} onPick={(r) => (pickAspect(r), close())} auto={{ sub: newImage ? "From the prompt, else square" : "Same as image 1" }} />}
              </Popover>
            )}

            <Popover
              className="wide"
              trigger={(open, toggle) => (
                <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Resolution">
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
                <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Quality">
                  <Gauge size={15} />
                  <span className="lbl">{QUALITY.find((q) => q.value === c.quality)?.label}</span>
                  <ChevronDown size={13} className="chev" />
                </button>
              )}
            >
              {(close) =>
                QUALITY.map((q) => <Option key={q.value} selected={c.quality === q.value} label={q.label} sub={q.sub} onClick={() => (updateComposer({ quality: q.value }), close())} />)
              }
            </Popover>

            {c.mode === "video" && (
              <Popover
                trigger={(open, toggle) => (
                  <button className={`pill ${open ? "on" : ""}`} onClick={toggle} title="Video Duration">
                    <Video size={14} />
                    <span className="lbl">{VIDEO_DURATIONS.find((d) => d.frames === (c.video_frames ?? plan?.video_frames ?? 49))?.label ?? `${c.video_frames ?? 49} frames`}</span>
                    <ChevronDown size={13} className="chev" />
                  </button>
                )}
              >
                {(close) =>
                  VIDEO_DURATIONS.map((d) => (
                    <Option
                      key={d.frames}
                      selected={(c.video_frames ?? plan?.video_frames ?? 49) === d.frames}
                      label={d.label}
                      sub={d.sub}
                      onClick={() => {
                        updateComposer({ video_frames: d.frames });
                        close();
                      }}
                    />
                  ))
                }
              </Popover>
            )}

            {c.mode === "video" && (
              <button
                className={`pill ${c.video_loop ? "on" : ""}`}
                onClick={() => updateComposer({ video_loop: !c.video_loop })}
                title="Seamless Loop: ends smoothly connect to the beginning"
              >
                <Repeat size={14} />
                <span className="lbl">Loop</span>
              </button>
            )}

            {canEnhance && <PromptPlus />}

            <LoraBadge />

            <Popover
              placement="top-start"
              className="panel"
              trigger={(open, toggle) => (
                <button
                  className={`icon-btn has-badge ${open ? "active" : ""}`}
                  onClick={toggle}
                  title={overrides.length ? `Advanced: overriding the preset (${overrides.join(", ")})` : "Advanced"}
                  aria-label={overrides.length ? `Advanced settings, ${overrides.length} overrides active` : "Advanced settings"}
                >
                  <SlidersHorizontal size={17} />
                  {overrides.length > 0 && <span className="override-dot" />}
                </button>
              )}
            >
              {() => <AdvancedPanel plan={plan} />}
            </Popover>


            <button className="icon-btn" onClick={() => setState({ overlay: "prompt-tips" })} title="Prompt tips" aria-label="Prompt tips">
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
