import { Map as MapIcon, Minus, Plus, RotateCcw } from "lucide-react";
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

export interface ZoomPanContext {
  transform: ZoomTransform;
  isZoomed: boolean;
  isPanning: boolean;
  isPinching: boolean;
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
  /** Elements placed inside viewport but NOT transformed (e.g. fullscreen button, stage badges) */
  overlay?: React.ReactNode;
  /** Show floating HUD controls (+, -, fit, 1:1, %) */
  showControls?: boolean;
  /** Enable keyboard shortcuts (+, -, 0, 1, m). Default true */
  enableKeyboard?: boolean;
  /** Enable click to toggle between fit and 100% (default true) */
  enableToggleZoom?: boolean;
  /** Enable pointer drag pan (default true) */
  enablePan?: boolean;
  /** Keep panning with momentum when a fast drag is released (default true) */
  enableInertia?: boolean;
  /** Two-finger pinch zoom on touch screens (default true) */
  enablePinch?: boolean;
  /** Called when a multi-touch pinch begins */
  onGestureStart?: () => void;
  /** Show the mini-map navigator when zoomed in (default false) */
  showMinimap?: boolean;
  /** Optional image URL for the mini-map (defaults to `src`) */
  minimapSrc?: string;
  /** Max side length in px for the mini-map (default 140) */
  minimapMaxSide?: number;
  /** Reset key to reset transform when changed */
  resetKey?: string | number;
  /** Additional class name for the viewport */
  className?: string;
  /** Max scale when auto-fitting (default 1.0) */
  maxFitScale?: number;
  /** Callback on transform change */
  onChange?: (transform: ZoomTransform) => void;
  /** Ref to access zoom/pan actions imperatively */
  zoomRef?: React.Ref<ZoomPanHandle>;
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
  overlay,
  showControls = true,
  enableKeyboard = true,
  enableToggleZoom = true,
  enablePan = true,
  enableInertia = true,
  enablePinch = true,
  onGestureStart,
  showMinimap = false,
  minimapSrc,
  minimapMaxSide = 140,
  resetKey,
  className = "",
  maxFitScale = 1,
  onChange,
  zoomRef,
}: ZoomPanProps) {
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const [minimapToggled, setMinimapToggled] = useState(false);
  const activeContentSize = (src && naturalSize) ? naturalSize : (contentSize ?? naturalSize);

  const [mouseActive, wakeMouse] = useMouseActive(2200);

  // Clear natural size when src changes so dimensions of old image do not linger
  useEffect(() => {
    setNaturalSize(null);
  }, [src]);

  // When showControls is enabled, wake the mouse immediately so controls are visible
  useEffect(() => {
    if (showControls) wakeMouse();
  }, [showControls, wakeMouse]);

  const zoom = useZoomPan({
    contentSize: activeContentSize,
    resetKey: resetKey ?? src,
    maxFitScale,
    enableToggleZoom,
    enablePan,
    enableInertia,
    enablePinch,
    onGestureStart,
    onChange,
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

  // Keyboard navigation for zoom (+, -, 0, 1, m)
  useEffect(() => {
    if (!enableKeyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (getState().overlay) return;

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
      } else if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        setMinimapToggled((v) => !v);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, enableKeyboard]);

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

  const zoomPercent = Math.round(zoom.transform.scale * 100);
  const isMinimapVisible =
    (showMinimap || minimapToggled) &&
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
      <div
        className="zoom-pan-content"
        style={{
          width: activeContentSize?.width,
          height: activeContentSize?.height,
          transform: `translate3d(${zoom.transform.x}px, ${zoom.transform.y}px, 0px) scale(${zoom.transform.scale})`,
          transformOrigin: "0 0",
          willChange: zoom.isPanning ? "transform" : "auto",
        }}
      >
        {typeof children === "function" ? children(zoom) : children}
        {src && (
          <img
            src={src}
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
      {overlay}

      {isMinimapVisible && (
        <MiniMap
          contentSize={zoom.contentSize}
          containerSize={zoom.containerSize}
          transform={zoom.transform}
          src={minimapSrc ?? src}
          maxSide={minimapMaxSide}
          onNavigate={zoom.setTransform}
        />
      )}

      {showControls && (
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
          <button
            className="zoom-btn"
            title="Zoom out (-)"
            aria-label="Zoom out"
            onClick={zoom.zoomOut}
          >
            <Minus size={14} />
          </button>
          <button
            className="zoom-pill"
            title="Click to reset to fit (0)"
            aria-label={`Current zoom: ${zoomPercent}%. Reset to fit`}
            onClick={zoom.zoomFit}
          >
            {zoomPercent}%
          </button>
          <button
            className="zoom-btn"
            title="Zoom in (+)"
            aria-label="Zoom in"
            onClick={zoom.zoomIn}
          >
            <Plus size={14} />
          </button>
          <button
            className="zoom-btn"
            title={zoom.isZoomed ? "Fit to screen (0)" : "Zoom 100% (1)"}
            aria-label={zoom.isZoomed ? "Fit to screen" : "Zoom 100%"}
            onClick={() => (zoom.isZoomed ? zoom.zoomFit() : zoom.zoom100())}
          >
            {zoom.isZoomed ? <RotateCcw size={13} /> : <span style={{ fontSize: 11, fontWeight: 700 }}>1:1</span>}
          </button>
          {zoom.isZoomed && (
            <button
              className={`zoom-btn ${isMinimapVisible ? "active" : ""}`}
              title={minimapToggled ? "Hide navigator (M)" : "Show navigator (M)"}
              aria-label="Toggle navigator map"
              onClick={() => setMinimapToggled((v) => !v)}
            >
              <MapIcon size={13} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
