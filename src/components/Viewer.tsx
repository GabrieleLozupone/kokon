// Full-screen viewing: a shell that takes the window full screen and shows any content
// (the live before/after comparison, or a zoomable image).

import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { native } from "../lib/native";

export const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Steps through a list while viewing: `prev` / `next` are absent at the ends; `pos` reads
 * like "3 / 12". */
export interface ViewerNav {
  prev?: () => void;
  next?: () => void;
  pos?: string;
}

/** Button for the top-right corner of an image; F also opens it. `content` is what to show
 * full screen; `hint` is shown next to the close button. With `onOpen` the parent owns the
 * full-screen view (and the F key) and the button only asks for it. */
export function FullscreenButton({ content, hint, onOpen }: { content?: ReactNode; hint?: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const show = onOpen ?? (() => setOpen(true));
  useEffect(() => {
    if (open || onOpen) return;
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "f" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) setOpen(true);
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [open, onOpen]);
  return (
    <>
      <button
        className="fullscreen-btn"
        title="Full screen (F)"
        aria-label="View full screen"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          show();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Maximize2 size={15} />
      </button>
      {open &&
        createPortal(
          <FullscreenShell hint={hint} onClose={() => setOpen(false)}>
            {content}
          </FullscreenShell>,
          document.body,
        )}
    </>
  );
}

/** The full-screen view as a portal, for parents that own it (see `FullscreenButton`). */
export function Fullscreen(props: { children: ReactNode; hint?: string; onClose: () => void; nav?: ViewerNav }) {
  return createPortal(<FullscreenShell {...props} />, document.body);
}

/** True while the mouse has moved in the last moment; `wake` goes on pointer move. */
export function useMouseActive(ms = 1800): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const wake = useCallback(() => {
    setActive(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(false), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [active, wake];
}

/** Previous / next buttons on the left and right edges of a picture. */
export function NavArrows({ nav, visible }: { nav: ViewerNav; visible: boolean }) {
  const btn = (side: "left" | "right", go: (() => void) | undefined) =>
    go && (
      <button
        className={`nav-arrow ${side} ${visible ? "" : "hidden"}`}
        title={side === "left" ? "Previous (←)" : "Next (→)"}
        aria-label={side === "left" ? "Previous image" : "Next image"}
        onClick={(e) => {
          e.stopPropagation();
          go();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {side === "left" ? <ChevronLeft size={26} /> : <ChevronRight size={26} />}
      </button>
    );
  return (
    <>
      {btn("left", nav.prev)}
      {btn("right", nav.next)}
    </>
  );
}

/** ←/↑ and →/↓ call `nav`; returns true when the key was used. */
export function navKey(e: KeyboardEvent, nav: ViewerNav | undefined): boolean {
  if (!nav || e.ctrlKey || e.metaKey || e.altKey) return false;
  const go = e.key === "ArrowLeft" || e.key === "ArrowUp" ? nav.prev : e.key === "ArrowRight" || e.key === "ArrowDown" ? nav.next : undefined;
  if (!go) return false;
  go();
  return true;
}

function FullscreenShell({ children, hint, onClose, nav }: { children: ReactNode; hint?: string; onClose: () => void; nav?: ViewerNav }) {
  const [active, wake] = useMouseActive();
  // Real full screen for the window while open; restored on close unless it already was.
  useEffect(() => {
    let wasFull = false;
    let alive = true;
    native
      .isFullscreen()
      .then((f) => {
        wasFull = f;
        if (alive && !f) return native.setFullscreen(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (!wasFull) native.setFullscreen(false).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.key === "Escape" || (e.key.toLowerCase() === "f" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (navKey(e, nav)) {
        // Captured here so the app's own arrow keys (which also browse versions) don't move twice.
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", down, true);
    return () => window.removeEventListener("keydown", down, true);
  }, [onClose, nav]);

  // React events from a portal still bubble to its React parents: without this, a press
  // anywhere here reaches the stage image underneath (which captures the pointer for the
  // slider / press-to-compare) and the buttons in full screen never get their click.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div
      className="viewer"
      role="dialog"
      aria-label="Full screen"
      onPointerDown={stop}
      onPointerMove={(e) => {
        stop(e);
        wake();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {children}
      {nav && <NavArrows nav={nav} visible={active} />}
      <div className="viewer-bar">
        {nav?.pos && <span className="viewer-tag">{nav.pos}</span>}
        <span className="viewer-hint">{hint ? `${hint} · ` : ""}{nav ? "← → to browse · " : ""}Esc to exit</span>
        <button className="viewer-close" title="Exit full screen (Esc)" aria-label="Exit full screen" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
    </div>
  );
}
import { ZoomPan } from "./ZoomPan";
export { ZoomPan } from "./ZoomPan";

/** Fit to screen; wheel to zoom, drag to pan, click to toggle 100%, + / - / 0 / 1 shortcuts. */
export function ZoomImage({ src, alt }: { src: string; alt: string }) {
  return <ZoomPan src={src} alt={alt} showControls />;
}
