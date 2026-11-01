// The stage on a phone (Kokon in a browser on another device): the image is swiped between
// versions and tapped for full screen, and what you can do with it sits in one row under it.
// Stage.tsx uses these in place of its desktop bar.

import { useBlackStatusBar } from "../lib/theme";
import { Brush, Copy, Download, Ellipsis, Expand, Heart, ImagePlus, Info, RefreshCw, SlidersHorizontal, TextCursorInput, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { api, urls } from "../lib/api";
import { haptic } from "../lib/haptics";
import { composerFromRecord, variationRequest } from "../lib/logic";
import { canCopyImage, native } from "../lib/native";
import {
  editShownImage, getState, itemSource, removeSessionItem, reusePrompt, selectItem, setState, submitRequest, toastError, toastInfo, updateComposer, useStore, type SessionItem,
} from "../lib/store";
import type { GenerationRecord, LutEntry } from "../lib/types";
import { promptClosedAt, uploadFiles } from "./Composer";
import { DevelopImg } from "./Develop";
import { LutButton } from "./Lut";
import { ActionButton, InfoPanel, sourceSize, UpscaleButton } from "./Stage";
import { Popover } from "./ui";
import { KokonMark } from "./Welcome";

/** Short prompts that show what a good one looks like (subject, action, place). */
const IDEAS = [
  "A red fox curled up asleep in fresh snow at sunrise",
  "A cosy reading nook by a rainy window, warm lamp light",
  "A monkey dribbling a basketball on an outdoor court",
];

/** A new project: start from a photo, or from words (an idea fills the prompt). */
export function PhoneEmpty() {
  const pick = async () => uploadFiles(await native.pickImageFiles());
  const idea = (p: string) => {
    updateComposer({ prompt: p });
    // Focused in the tap itself: iOS shows the keyboard only then.
    document.getElementById("prompt")?.focus();
  };
  return (
    <div className="phone-empty">
      <KokonMark size={34} />
      <h1>What should we make?</h1>
      <p>Describe a new image below, or start from a photo.</p>
      <button className="phone-photo" onClick={pick}>
        <span className="phone-photo-icon">
          <ImagePlus size={22} />
        </span>
        <span className="phone-photo-text">
          <strong>Edit a photo</strong>
          <span>From your photos or the camera</span>
        </span>
      </button>
      <div className="ideas">
        <span className="ideas-label">Or try</span>
        {IDEAS.map((p) => (
          <button key={p} className="idea" onClick={() => idea(p)}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Swipe sideways to the previous or next version; a tap on the picture opens full screen.
 * Gestures that start on a control (buttons, the comparison slider) are left to it. */
export function Swipe({ children, onTap }: { children: ReactNode; onTap?: () => void }) {
  const session = useStore((s) => s.session);
  const selected = useStore((s) => s.selected);
  const ref = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; t: number; dx: number; axis: "x" | "y" | null; skip: boolean; onImage: boolean } | null>(null);
  // The version just swiped to slides in from that side.
  const [enter, setEnter] = useState<{ key: string; from: "left" | "right" } | null>(null);
  const at = session.findIndex((i) => i.key === selected);
  const prev = at > 0 ? session[at - 1] : undefined;
  const next = at >= 0 ? session[at + 1] : undefined;

  const place = (dx: number, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? "transform 0.38s var(--ease), opacity 0.38s var(--ease)" : "none";
    el.style.transform = dx ? `translateX(${dx}px)` : "";
    el.style.opacity = dx ? String(1 - Math.min(0.5, Math.abs(dx) / 600)) : "";
  };

  return (
    <div
      className="swipe"
      onTouchStart={(e) => {
        const t = e.target as HTMLElement;
        if (e.touches.length !== 1) {
          touch.current = null;
          return;
        }
        const p = e.touches[0];
        touch.current = {
          x: p.clientX,
          y: p.clientY,
          t: performance.now(),
          dx: 0,
          axis: null,
          skip: !!t.closest("button, input, .compare-overlay, .compare-box.slider, .prompt-text"),
          onImage: !!t.closest(".image-box, .compare-box"),
        };
      }}
      onTouchMove={(e) => {
        const s = touch.current;
        if (!s || s.skip) return;
        const p = e.touches[0];
        const dx = p.clientX - s.x;
        const dy = p.clientY - s.y;
        if (!s.axis && Math.hypot(dx, dy) > 8) s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (s.axis !== "x") return;
        s.dx = dx;
        // Past the first or last version the picture follows the finger only a little.
        const end = (dx > 0 && !prev) || (dx < 0 && !next);
        place(end ? dx * 0.22 : dx, false);
      }}
      onTouchEnd={() => {
        const s = touch.current;
        touch.current = null;
        if (!s || s.skip) return;
        const dt = performance.now() - s.t;
        // This touch closed the open prompt box: it does nothing else.
        if (promptClosedAt >= s.t - 50) return place(0, true);
        if (s.axis === "x") {
          const fast = Math.abs(s.dx) / Math.max(1, dt) > 0.45;
          const go = Math.abs(s.dx) > 64 || fast ? (s.dx < 0 ? next : prev) : undefined;
          if (!go) return place(0, true);
          haptic();
          const el = ref.current;
          if (el) {
            el.style.transition = "transform 0.16s ease-in, opacity 0.16s ease-in";
            el.style.transform = `translateX(${s.dx < 0 ? -90 : 90}px)`;
            el.style.opacity = "0";
          }
          window.setTimeout(() => {
            setEnter({ key: go.key, from: s.dx < 0 ? "right" : "left" });
            selectItem(go.key);
            place(0, false);
          }, 140);
        } else if (!s.axis && dt < 320 && s.onImage) onTap?.();
      }}
      onTouchCancel={() => {
        touch.current = null;
        place(0, true);
      }}
    >
      <div ref={ref} className="swipe-track">
        <div key={selected ?? ""} className={`swipe-page ${enter && enter.key === selected ? `enter-${enter.from}` : ""}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** An iPhone or iPad (an iPad's Safari says "Macintosh" but has a touch screen). */
const isIOS = typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (/Mac/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));

/** Saves onto the phone: the share sheet (Save Image puts it in Photos) where the browser can
 * share files, which needs HTTPS. Otherwise an iPhone shows the image to hold (`hold`): a download
 * there opens a file preview, a dead end in a home-screen app, with nothing to go back with; other
 * devices download it. */
async function saveImage(url: string, name: string, hold: () => void) {
  try {
    if (navigator.canShare) {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name, { type: blob.type || "image/png" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    }
  } catch (e) {
    if ((e as DOMException)?.name === "AbortError") return;
  }
  if (isIOS) hold();
  else native.download(url, name);
}

/** The image to save, full screen and at full size: holding it brings the system's menu, whose
 * Save to Photos puts it in Photos. */
function HoldToSave({ src, thumb, onClose }: { src: string; thumb?: string; onClose: () => void }) {
  useBlackStatusBar();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="hold-save" role="dialog" aria-label="Save the image">
      <div className="hold-save-head">
        <span>
          Press and hold the picture, then tap <strong>Save to Photos</strong>.
        </span>
        <button className="glass-btn" title="Done" aria-label="Done" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      <div className="hold-save-img">
        <DevelopImg src={src} placeholder={thumb} alt="Image to save" />
      </div>
    </div>,
    document.body,
  );
}

/** What you can do with the version shown, in one row that scrolls sideways under the image. */
export function PhoneActions({ item, showOriginal, onLut }: { item: SessionItem; showOriginal: boolean; onLut: (lut: LutEntry) => void }) {
  const g = item.gen;
  const source = itemSource(item)!;
  const [fav, setFav] = useState(!!g?.favorite);
  const [hold, setHold] = useState<{ src: string; thumb: string } | null>(null);
  const paint = (overlay: "inpaint" | "expand") => {
    editShownImage();
    setState({ overlay });
  };
  const save = () => {
    const thumb = urls.sourceThumb(source);
    if (g) {
      const name = g.file_path.split(/[\\/]/).pop() ?? "image.png";
      const src = showOriginal ? urls.genOriginal(g.id) : urls.gen(g.id);
      saveImage(src, showOriginal ? name.replace(/(\.\w+)?$/, "-original.png") : name, () => setHold({ src, thumb }));
    } else {
      const src = urls.input(item.input!.id);
      saveImage(src, item.input!.original_name ? decodeURIComponent(item.input!.original_name) : "image.png", () => setHold({ src, thumb }));
    }
  };
  return (
    <div className="actions phone-actions">
      {g?.request && g.mode !== "upscale" && g.mode !== "lut" && g.mode !== "layers" && (
        <ActionButton
          title="Again: same prompt and settings, new seed"
          icon={<RefreshCw size={17} />}
          label="Again"
          onClick={() => {
            const r = variationRequest(g);
            if (r) submitRequest(r);
          }}
        />
      )}
      <ActionButton title="Paint the area to change" icon={<Brush size={17} />} label="Paint" onClick={() => paint("inpaint")} />
      <ActionButton title="Extend the image beyond its borders" icon={<Expand size={17} />} label="Expand" onClick={() => paint("expand")} />
      <UpscaleButton source={source} size={g ? { width: g.width, height: g.height } : { width: item.input!.width, height: item.input!.height }} original={g ? sourceSize(g) : null} parentId={g?.id} />
      <LutButton onPick={onLut} />
      {g && (
        <ActionButton
          title={fav ? "Remove from favorites" : "Favorite"}
          icon={<Heart size={17} fill={fav ? "currentColor" : "none"} />}
          label="Favorite"
          active={fav}
          onClick={async () => {
            try {
              await api.setFavorite(g.id, !fav);
              setFav(!fav);
            } catch (e) {
              toastError(e);
            }
          }}
        />
      )}
      <ActionButton title="Save to this device" icon={<Download size={17} />} label="Save" onClick={save} />
      <PhoneMore item={item} g={g} showOriginal={showOriginal} />
      {hold && <HoldToSave src={hold.src} thumb={hold.thumb} onClose={() => setHold(null)} />}
    </div>
  );
}

/** The rest, in a sheet: reuse the prompt, copy, details, remove. */
function PhoneMore({ item, g, showOriginal }: { item: SessionItem; g?: GenerationRecord; showOriginal: boolean }) {
  const [info, setInfo] = useState(false);
  return (
    <Popover
      className={info ? "info-sheet" : undefined}
      trigger={(open, toggle) => (
        <ActionButton
          title="More"
          icon={<Ellipsis size={17} />}
          label="More"
          active={open}
          onClick={() => {
            setInfo(false);
            toggle();
          }}
        />
      )}
    >
      {(close) =>
        info && g ? (
          <InfoPanel g={g} />
        ) : (
          <>
            {g?.prompt && (
              <button className="opt" onClick={() => (close(), reusePrompt(g))}>
                <span className="check">
                  <TextCursorInput size={17} />
                </span>
                <span>Reuse prompt</span>
              </button>
            )}
            {g && g.mode !== "lut" && g.mode !== "layers" && (
              <button
                className="opt"
                onClick={() => {
                  close();
                  setState({ composer: { ...composerFromRecord(g, getState().composer), mode: "auto" } });
                }}
              >
                <span className="check">
                  <SlidersHorizontal size={17} />
                </span>
                <span>Reuse prompt and settings</span>
              </button>
            )}
            {canCopyImage && (
              <button
                className="opt"
                onClick={async () => {
                  close();
                  try {
                    await native.copyImageUrl(g ? (showOriginal ? urls.genOriginal(g.id) : urls.gen(g.id)) : urls.input(item.input!.id));
                    toastInfo("Image copied");
                  } catch (e) {
                    toastError(e);
                  }
                }}
              >
                <span className="check">
                  <Copy size={17} />
                </span>
                <span>Copy image</span>
              </button>
            )}
            {g && (
              <button className="opt" onClick={() => setInfo(true)}>
                <span className="check">
                  <Info size={17} />
                </span>
                <span>Details</span>
              </button>
            )}
            <button className="opt danger" onClick={() => (close(), removeSessionItem(item.key))}>
              <span className="check">
                <Trash2 size={17} />
              </span>
              <span>Remove from project</span>
            </button>
          </>
        )
      }
    </Popover>
  );
}
