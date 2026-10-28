// Full-screen viewing: a shell that takes the window full screen and shows any content
// (the live before/after comparison, or a zoomable image).

import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { urls } from "../lib/api";
import { haptic } from "../lib/haptics";
import { native } from "../lib/native";
import { inBrowser } from "../lib/platform";
import { useBlackStatusBar } from "../lib/theme";
import { ZoomPan } from "./ZoomPan";

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

/** Chrome on Android redraws only part of the page after leaving full screen: the rest keeps the
 * full-screen layout until a reload. Once the window has its size back (the address bar slides in
 * over several resizes), the page is put on a layer of its own for two frames, which makes the
 * browser draw all of it again. */
function repaintAfterFullscreen() {
  const root = document.getElementById("root");
  if (!root) return;
  let timer = 0;
  const repaint = () => {
    window.removeEventListener("resize", settle);
    root.style.opacity = "0.999";
    requestAnimationFrame(() => requestAnimationFrame(() => (root.style.opacity = "")));
  };
  const settle = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(repaint, 250);
  };
  window.addEventListener("resize", settle);
  timer = window.setTimeout(repaint, 400);
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

/** A horizontal swipe steps through `nav` on a touch screen: the picture follows the finger
 * (only a little past the ends) and the next one slides in from that side, as the phone's
 * versions do. Not while zoomed in, nor on a control or the comparison slider; a second
 * finger (pinch) cancels it. `pageKey` names what is shown. */
export function SwipeNav({ nav, pageKey, className = "", children }: { nav: ViewerNav; pageKey: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number; t: number; dx: number; axis: "x" | "y" | null } | null>(null);
  // The side the page just swiped to slides in from.
  const [enter, setEnter] = useState<"left" | "right" | null>(null);
  const place = (dx: number, animate: boolean) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? "transform 0.38s var(--ease), opacity 0.38s var(--ease)" : "none";
    el.style.transform = dx ? `translateX(${dx}px)` : "";
    el.style.opacity = dx ? String(1 - Math.min(0.5, Math.abs(dx) / 600)) : "";
  };
  const cancel = () => {
    if (touch.current?.axis === "x") place(0, true);
    touch.current = null;
  };
  return (
    <div
      className={`swipe-nav ${className}`}
      onTouchStart={(e) => {
        const t = e.target as HTMLElement;
        if (e.touches.length !== 1 || t.closest("button, .zoomed, .compare-box.slider, .zoom-controls, .zoom-minimap, .viewer-compare-bar")) return cancel();
        touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), dx: 0, axis: null };
      }}
      onTouchMove={(e) => {
        const s = touch.current;
        if (!s) return;
        if (e.touches.length !== 1) return cancel();
        const dx = e.touches[0].clientX - s.x;
        const dy = e.touches[0].clientY - s.y;
        if (!s.axis && Math.hypot(dx, dy) > 8) s.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (s.axis !== "x") return;
        s.dx = dx;
        const end = (dx > 0 && !nav.prev) || (dx < 0 && !nav.next);
        place(end ? dx * 0.22 : dx, false);
      }}
      onTouchEnd={() => {
        const s = touch.current;
        touch.current = null;
        if (!s || s.axis !== "x") return;
        const fast = Math.abs(s.dx) / Math.max(1, performance.now() - s.t) > 0.45;
        const go = Math.abs(s.dx) > 64 || fast ? (s.dx < 0 ? nav.next : nav.prev) : undefined;
        if (!go) return place(0, true);
        haptic();
        const el = ref.current;
        if (el) {
          el.style.transition = "transform 0.16s ease-in, opacity 0.16s ease-in";
          el.style.transform = `translateX(${s.dx < 0 ? -90 : 90}px)`;
          el.style.opacity = "0";
        }
        const from = s.dx < 0 ? "right" : "left";
        window.setTimeout(() => {
          go();
          setEnter(from);
          place(0, false);
        }, 140);
      }}
      onTouchCancel={cancel}
    >
      <div ref={ref} key={pageKey} className={`swipe-nav-page ${enter ? `enter-${enter}` : ""}`} onAnimationEnd={(e) => e.target === e.currentTarget && setEnter(null)}>
        {children}
      </div>
    </div>
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
  useBlackStatusBar();
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
      if (!wasFull) native.setFullscreen(false).then(inBrowser ? repaintAfterFullscreen : undefined).catch(() => {});
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
      {nav ? (
        <SwipeNav nav={nav} pageKey={nav.pos ?? ""}>
          {children}
        </SwipeNav>
      ) : (
        children
      )}
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

/** Fit to screen; wheel to zoom, drag to pan, click to toggle 100%, + / - / 0 / 1 shortcuts.
 * With the image's `source` ("gen:…" / "input:…") and `size`, a browser shows the preview until
 * the zoom needs the full image, and the thumbnail in the mini-map; a browser always draws it
 * flat (see ZoomPan). The desktop app loads the full image at once. */
export function ZoomImage({ src, alt, source, size }: { src: string; alt: string; source?: string; size?: { width: number; height: number } }) {
  const known = inBrowser && source && size && size.width > 0 && size.height > 0;
  return (
    <ZoomPan
      src={src}
      alt={alt}
      flat={inBrowser}
      contentSize={known ? size : undefined}
      previewSrc={known ? urls.sourcePreview(source) : undefined}
      minimapSrc={known ? urls.sourceThumb(source) : undefined}
    />
  );
}
