import { Minus, Plus } from "lucide-react";
import React, { useEffect, useImperativeHandle, useState } from "react";
import { useZoomPan } from "../lib/useZoomPan";
import {
  centerOnContentFraction,
  minimapSize,
  visibleContentRect,
  type Size,
  type ZoomTransform,
} from "../lib/zoomMath";
import { isTyping, useMouseActive } from "./Viewer";
import { getState } from "../lib/store";
import { viewerWantsFull } from "../lib/logic";
import { t } from "../lib/i18n";

export interface ZoomPanContext {
  transform: ZoomTransform;
  isZoomed: boolean;
  isPanning: boolean;
  isPinching: boolean;
  /** Children are laid out at the drawn size (`flat`), not at the content's own size. */
  flat: boolean;
  /** The content is drawn with more device pixels than a preview has (stays true once set). */
  wantsFull: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  zoom100: () => void;
  toggleZoom: () => void;
  setTransform: (transform: ZoomTransform | ((prev: ZoomTransform) => ZoomTransform)) => void;
}

export interface ZoomPanProps {
  /** Optional content size; if omitted with an image, measured automatically */
  contentSize?: Size | null;
  /** Image source if using ZoomPan directly as an image viewer */
  src?: string;
  /** Image alt text */
  alt?: string;
  /** Child elements to transform (e.g. compare frame, canvas, or custom layout) */
  children?: React.ReactNode | ((zoom: ZoomPanContext) => React.ReactNode);
  /** Enable click to toggle between fit and 100% (default true) */
  enableToggleZoom?: boolean;
  /** Enable pointer drag pan (default true) */
  enablePan?: boolean;
  /** Image for the mini-map shown while zoomed in (defaults to `src`) */
  minimapSrc?: string;
  /** Reset key to reset transform when changed */
  resetKey?: string | number;
  /** Additional class name for the viewport */
  className?: string;
  /** Ref to access zoom/pan actions imperatively */
  zoomRef?: React.Ref<ZoomPanHandle>;
  /** Lay the content out at its drawn size and move it with a 2D translate, instead of at its
   * own size scaled by a 3D transform. WebKit backs a composited layer at its untransformed
   * size x the device scale (GraphicsLayerCA: the transform-aware scale is disabled), so a
   * 4096 px image shrunk to a phone screen cost ~150 MB of layer per element and edits
   * crashed Safari on an iPhone 15. Flat, the content paints into the screen-sized viewer
   * layer. Children must fill the content box. */
  flat?: boolean;
  /** A screen-sized copy of `src`, shown until the zoom needs more pixels than it has (needs
   * `contentSize`, the full image's size). */
  previewSrc?: string;
}

export interface ZoomPanHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  zoom100: () => void;
  toggleZoom: () => void;
  setTransform: (transform: ZoomTransform | ((prev: ZoomTransform) => ZoomTransform)) => void;
  transform: ZoomTransform;
  isZoomed: boolean;
  isPanning: boolean;
  isPinching: boolean;
}

export interface MiniMapProps {
  contentSize: Size;
  containerSize: Size;
  transform: ZoomTransform;
  src?: string;
  maxSide?: number;
  onNavigate: (nextTransform: ZoomTransform) => void;
}

export function MiniMap({
  contentSize,
  containerSize,
  transform,
  src,
  maxSide = 140,
  onNavigate,
}: MiniMapProps) {
  const mapRef = React.useRef<HTMLDivElement | null>(null);
  const isDraggingRef = React.useRef(false);

  const mapSize = minimapSize(contentSize, maxSide);
  const rect = visibleContentRect(transform, containerSize, contentSize);

  const handlePointer = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = mapRef.current;
      if (!el) return;
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return;
      const fx = (e.clientX - b.left) / b.width;
      const fy = (e.clientY - b.top) / b.height;
      const next = centerOnContentFraction(fx, fy, transform, containerSize, contentSize);
      onNavigate(next);
    },
    [containerSize, contentSize, onNavigate, transform],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    isDraggingRef.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    handlePointer(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    e.stopPropagation();
    e.preventDefault();
    handlePointer(e);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;
    e.stopPropagation();
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      ref={mapRef}
      className="zoom-minimap"
      style={{
        width: mapSize.width,
        height: mapSize.height,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={(e) => e.stopPropagation()}
    >
      {src && (
        <img
          src={src}
          alt=""
          draggable={false}
          className="zoom-minimap-img"
        />
      )}
      <div
        className="zoom-minimap-viewport"
        style={{
          left: `${rect.x * 100}%`,
          top: `${rect.y * 100}%`,
          width: `${rect.w * 100}%`,
          height: `${rect.h * 100}%`,
        }}
      />
    </div>
  );
}

export function ZoomPan({
  contentSize,
  src,
  alt = "",
  children,
  enableToggleZoom = true,
  enablePan = true,
  minimapSrc,
  resetKey,
  className = "",
  zoomRef,
  flat = false,
  previewSrc,
}: ZoomPanProps) {
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  // A preview's own size is not the content's.
  const activeContentSize = (src && naturalSize && !(previewSrc && contentSize)) ? naturalSize : (contentSize ?? naturalSize);

  const [mouseActive, wakeMouse] = useMouseActive(2200);

  // Clear natural size when src changes so dimensions of old image do not linger
  useEffect(() => {
    setNaturalSize(null);
  }, [src]);

  // Show the toolbar on open; it hides while the mouse rests and comes back when it moves.
  useEffect(() => {
    wakeMouse();
  }, [wakeMouse]);

  const zoom = useZoomPan({
    contentSize: activeContentSize,
    resetKey: resetKey ?? src,
    enableToggleZoom,
    enablePan,
  });

  useImperativeHandle(
    zoomRef,
    () => ({
      zoomIn: zoom.zoomIn,
      zoomOut: zoom.zoomOut,
      zoomFit: zoom.zoomFit,
      zoom100: zoom.zoom100,
      toggleZoom: zoom.toggleZoom,
      setTransform: zoom.setTransform,
      transform: zoom.transform,
      isZoomed: zoom.isZoomed,
      isPanning: zoom.isPanning,
      isPinching: zoom.isPinching,
    }),
    [zoom],
  );

  // Keyboard navigation for zoom (+, -, 0, 1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Another panel covers this view (the inpaint editor is a panel with its own ZoomPan).
      if (getState().overlay && !ref.current?.closest(".overlay")) return;

      // When a full-screen viewer is open, only the ZoomPan inside the viewer handles shortcuts
      const viewer = document.querySelector(".viewer");
      if (viewer && !ref.current?.closest(".viewer")) return;

      if (e.key === "+" || e.key === "=" || e.key === "Add") {
        e.preventDefault();
        zoom.zoomIn();
      } else if (e.key === "-" || e.key === "_" || e.key === "Subtract") {
        e.preventDefault();
        zoom.zoomOut();
      } else if (e.key === "0") {
        e.preventDefault();
        zoom.zoomFit();
      } else if (e.key === "1") {
        e.preventDefault();
        zoom.zoom100();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  const {
    ref,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onPointerDownCapture,
    onPointerMoveCapture,
    onPointerUpCapture,
    onPointerCancelCapture,
    style,
  } = zoom.containerProps;

  // Once zoomed past what a preview can show, the full image (kept when zooming out again).
  const full = React.useRef({ key: resetKey ?? src, on: false });
  if (full.current.key !== (resetKey ?? src)) full.current = { key: resetKey ?? src, on: false };
  if (zoom.fitted && activeContentSize && viewerWantsFull(activeContentSize, zoom.transform.scale, window.devicePixelRatio || 1)) full.current.on = true;
  const wantsFull = full.current.on;
  const shownSrc = previewSrc && contentSize && !wantsFull ? previewSrc : src;
  const scale = zoom.transform.scale;
  const contentStyle: React.CSSProperties = flat
    ? {
        width: activeContentSize ? activeContentSize.width * scale : undefined,
        height: activeContentSize ? activeContentSize.height * scale : undefined,
        transform: `translate(${zoom.transform.x}px, ${zoom.transform.y}px)`,
      }
    : {
        width: activeContentSize?.width,
        height: activeContentSize?.height,
        transform: `translate3d(${zoom.transform.x}px, ${zoom.transform.y}px, 0px) scale(${scale})`,
        transformOrigin: "0 0",
        willChange: zoom.isPanning ? "transform" : "auto",
      };

  const zoomPercent = Math.round(zoom.transform.scale * 100);
  const isMinimapVisible =
    zoom.isZoomed &&
    activeContentSize &&
    activeContentSize.width > 0 &&
    activeContentSize.height > 0;

  return (
    <div
      ref={ref}
      className={`zoom-pan-viewport ${zoom.isZoomed ? "zoomed" : ""} ${className}`}
      style={style}
      onPointerDownCapture={(e) => {
        wakeMouse();
        onPointerDownCapture(e);
      }}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={onPointerUpCapture}
      onPointerCancelCapture={onPointerCancelCapture}
      onPointerDown={(e) => {
        wakeMouse();
        onPointerDown(e);
      }}
      onPointerMove={(e) => {
        wakeMouse();
        onPointerMove(e);
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="zoom-pan-content" style={contentStyle}>
        {typeof children === "function" ? children({ ...zoom, flat, wantsFull }) : children}
        {shownSrc && (
          <img
            src={shownSrc}
            alt={alt}
            draggable={false}
            className="zoom-pan-img"
            onLoad={(e) => {
              setNaturalSize({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              });
            }}
          />
        )}
      </div>

      {isMinimapVisible && (
        <MiniMap
          contentSize={zoom.contentSize}
          containerSize={zoom.containerSize}
          transform={zoom.transform}
          src={minimapSrc ?? src}
          onNavigate={zoom.setTransform}
        />
      )}

        <div
          className={`zoom-controls ${mouseActive || zoom.isPanning ? "visible" : "hidden"}`}
          onPointerDown={(e) => {
            wakeMouse();
            e.stopPropagation();
          }}
          onPointerMove={(e) => {
            wakeMouse();
            e.stopPropagation();
          }}
          onPointerEnter={wakeMouse}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button className="zoom-btn" title={t("zoomPan.zoomOutTooltip")} aria-label={t("zoomPan.zoomOut")} onClick={zoom.zoomOut}>
            <Minus size={15} />
          </button>
          <span className="zoom-pct" aria-live="polite">{zoomPercent}%</span>
          <button className="zoom-btn" title={t("zoomPan.zoomInTooltip")} aria-label={t("zoomPan.zoomIn")} onClick={zoom.zoomIn}>
            <Plus size={15} />
          </button>
          <button className="zoom-btn text" title={t("zoomPan.fitTooltip")} disabled={!zoom.isZoomed} onClick={zoom.zoomFit}>
            {t("zoomPan.fit")}
          </button>
        </div>
    </div>
  );
}
