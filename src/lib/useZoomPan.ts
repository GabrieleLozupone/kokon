import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  calculateFit,
  clampOffset,
  clampScale,
  inertiaStep,
  INERTIA_START_SPEED,
  nextZoomStep,
  pinchTransform,
  releaseVelocity,
  zoomAtFocalPoint,
  type MotionSample,
  type PinchStart,
  type Point,
  type Size,
  type ZoomTransform,
} from "./zoomMath";

/** Users who asked the OS for less motion get no momentum. */
const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface UseZoomPanOptions {
  /** Dimensions of the content being displayed (image, canvas, compare box) */
  contentSize?: Size | null;
  /** Optional key/signal to reset zoom/pan when the displayed item or version changes */
  resetKey?: string | number;
  /** Max scale for auto-fit (default 1.0: small images will not be enlarged past 100% on fit) */
  maxFitScale?: number;
  /** Enable mouse wheel zoom (default true) */
  enableWheel?: boolean;
  /** Enable pointer drag pan (default true) */
  enablePan?: boolean;
  /** Enable click to toggle between fit and 100% (default true) */
  enableToggleZoom?: boolean;
  /** Keep panning with momentum after a fast drag is released (default true; off with reduced motion) */
  enableInertia?: boolean;
  /** Two-finger pinch zoom on touch screens (default true) */
  enablePinch?: boolean;
  /** Called when a pinch begins, so children can abandon a stroke or slider drag started by the first finger */
  onGestureStart?: () => void;
  /** Callback on transform change */
  onChange?: (transform: ZoomTransform) => void;
}

export interface UseZoomPanReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  transform: ZoomTransform;
  containerSize: Size;
  /** Content size used for fitting/clamping (never 0) */
  contentSize: Size;
  isZoomed: boolean;
  isPanning: boolean;
  isPinching: boolean;
  canZoom: boolean;
  fitTransform: ZoomTransform;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomFit: () => void;
  zoom100: (focalPoint?: Point) => void;
  toggleZoom: (focalPoint?: Point) => void;
  setTransform: (transform: ZoomTransform | ((prev: ZoomTransform) => ZoomTransform)) => void;
  containerProps: {
    ref: React.RefObject<HTMLDivElement | null>;
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLDivElement>) => void;
    /** Capture-phase handlers: track every finger for pinch even when a child stops propagation */
    onPointerDownCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMoveCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUpCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancelCapture: (e: React.PointerEvent<HTMLDivElement>) => void;
    style: React.CSSProperties;
  };
}

export function useZoomPan(options: UseZoomPanOptions = {}): UseZoomPanReturn {
  const {
    contentSize = null,
    resetKey,
    maxFitScale = 1,
    enableWheel = true,
    enablePan = true,
    enableToggleZoom = true,
    enableInertia = true,
    enablePinch = true,
    onGestureStart,
    onChange,
  } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const [containerSize, setContainerSize] = useState<Size>({ width: 0, height: 0 });
  const [transform, setTransformState] = useState<ZoomTransform>({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [isPinching, setIsPinching] = useState(false);

  // Track if user is currently at "fit" scale so resize preserves fit
  const wasAtFitRef = useRef(true);
  const prevResetKeyRef = useRef(resetKey);
  const prevContentRef = useRef<Size | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onGestureStartRef = useRef(onGestureStart);
  onGestureStartRef.current = onGestureStart;

  const contentWidth = contentSize && contentSize.width > 0 ? contentSize.width : 1;
  const contentHeight = contentSize && contentSize.height > 0 ? contentSize.height : 1;
  const content: Size = useMemo(
    () => ({ width: contentWidth, height: contentHeight }),
    [contentWidth, contentHeight],
  );

  const fitTransform = useMemo(() => {
    return calculateFit(containerSize, content, maxFitScale);
  }, [containerSize, content, maxFitScale]);

  // Latest values for gesture/animation callbacks that outlive a render (rAF, capture handlers).
  const geomRef = useRef({ container: containerSize, content, fitScale: fitTransform.scale });
  geomRef.current = { container: containerSize, content, fitScale: fitTransform.scale };

  // Inertia (momentum) animation.
  const inertiaRaf = useRef<number | null>(null);
  const stopInertia = useCallback(() => {
    if (inertiaRaf.current !== null) {
      cancelAnimationFrame(inertiaRaf.current);
      inertiaRaf.current = null;
    }
  }, []);
  useEffect(() => stopInertia, [stopInertia]);

  const canZoom = useMemo(() => {
    if (!contentSize || containerSize.width <= 0 || containerSize.height <= 0) return true;
    return contentSize.width > containerSize.width || contentSize.height > containerSize.height || fitTransform.scale < 0.99;
  }, [contentSize?.width, contentSize?.height, containerSize.width, containerSize.height, fitTransform.scale]);

  const isZoomed = useMemo(() => {
    return transform.scale > fitTransform.scale * 1.02;
  }, [transform.scale, fitTransform.scale]);

  const updateTransform = useCallback(
    (next: ZoomTransform | ((prev: ZoomTransform) => ZoomTransform)) => {
      stopInertia();
      setTransformState((prev) => {
        const resolved = typeof next === "function" ? next(prev) : next;
        const clamped = clampOffset({ x: resolved.x, y: resolved.y }, resolved.scale, containerSize, content);
        const finalTransform = { scale: resolved.scale, x: clamped.x, y: clamped.y };
        wasAtFitRef.current = Math.abs(finalTransform.scale - fitTransform.scale) < 0.005;
        return finalTransform;
      });
    },
    [containerSize, content, fitTransform.scale, stopInertia],
  );

  useEffect(() => {
    onChangeRef.current?.(transform);
  }, [transform.scale, transform.x, transform.y]);

  // Measure container dimensions
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setContainerSize({ width: Math.round(width), height: Math.round(height) });
        }
      }
    });

    ro.observe(el);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setContainerSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    }

    return () => ro.disconnect();
  }, []);

  // Update transform on container resize or content change
  useLayoutEffect(() => {
    if (containerSize.width <= 0 || containerSize.height <= 0) return;
    if (content.width <= 0 || content.height <= 0) return;

    const isFirstRun = prevContentRef.current === null;
    const contentChanged =
      prevContentRef.current !== null &&
      (content.width !== prevContentRef.current.width || content.height !== prevContentRef.current.height);
    const resetKeyChanged = resetKey !== undefined && resetKey !== prevResetKeyRef.current;

    prevContentRef.current = content;
    prevResetKeyRef.current = resetKey;

    if (isFirstRun || resetKeyChanged || contentChanged || wasAtFitRef.current) {
      if (resetKeyChanged || contentChanged) stopInertia();
      wasAtFitRef.current = true;
      setTransformState(fitTransform);
    } else {
      // Re-clamp current transform to new container dimensions
      setTransformState((prev) => {
        const clamped = clampOffset({ x: prev.x, y: prev.y }, prev.scale, containerSize, content);
        if (clamped.x === prev.x && clamped.y === prev.y) return prev;
        return { ...prev, x: clamped.x, y: clamped.y };
      });
    }
  }, [containerSize.width, containerSize.height, content.width, content.height, resetKey, fitTransform]);

  // Zoom actions
  const zoomFit = useCallback(() => {
    wasAtFitRef.current = true;
    updateTransform(fitTransform);
  }, [fitTransform, updateTransform]);

  const zoom100 = useCallback(
    (focal?: Point) => {
      const focalPoint = focal ?? {
        x: containerSize.width / 2,
        y: containerSize.height / 2,
      };
      updateTransform((prev) => zoomAtFocalPoint(prev, focalPoint, 1.0, containerSize, content));
    },
    [containerSize, content, updateTransform],
  );

  const zoomIn = useCallback(() => {
    const focalPoint = { x: containerSize.width / 2, y: containerSize.height / 2 };
    const nextScale = nextZoomStep(transform.scale, "in");
    updateTransform((prev) => zoomAtFocalPoint(prev, focalPoint, nextScale, containerSize, content));
  }, [containerSize, content, transform.scale, updateTransform]);

  const zoomOut = useCallback(() => {
    const focalPoint = { x: containerSize.width / 2, y: containerSize.height / 2 };
    const nextScale = nextZoomStep(transform.scale, "out");
    updateTransform((prev) => zoomAtFocalPoint(prev, focalPoint, nextScale, containerSize, content));
  }, [containerSize, content, transform.scale, updateTransform]);

  const toggleZoom = useCallback(
    (focal?: Point) => {
      if (isZoomed) {
        zoomFit();
      } else {
        zoom100(focal);
      }
    },
    [isZoomed, zoomFit, zoom100],
  );

  // Wheel listener with non-passive event registration to prevent page scroll
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enableWheel) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      stopInertia();

      const rect = el.getBoundingClientRect();
      const focalPoint: Point = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      };

      // Handle trackpad pinch (ctrlKey) vs standard mouse wheel
      const delta = -e.deltaY;
      const sensitivity = e.ctrlKey ? 0.012 : 0.002;
      const zoomFactor = Math.min(1.4, Math.max(0.7, Math.exp(delta * sensitivity)));

      setTransformState((prev) => {
        const nextScale = clampScale(prev.scale * zoomFactor);
        const next = zoomAtFocalPoint(prev, focalPoint, nextScale, containerSize, content);
        wasAtFitRef.current = Math.abs(next.scale - fitTransform.scale) < 0.005;
        return next;
      });
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [containerSize, content, enableWheel, fitTransform.scale, stopInertia]);

  // Pointer drag panning
  const dragRef = useRef<{
    startX: number;
    startY: number;
    initialX: number;
    initialY: number;
    moved: boolean;
  } | null>(null);
  /** Recent pointer positions during a drag, for the release velocity. */
  const samplesRef = useRef<MotionSample[]>([]);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const startInertia = useCallback(
    (velocity: Point) => {
      stopInertia();
      if (!enableInertia || prefersReducedMotion() || typeof requestAnimationFrame !== "function") return;
      if (Math.hypot(velocity.x, velocity.y) < INERTIA_START_SPEED) return;
      let v = velocity;
      let pos = transformRef.current;
      let last = performance.now();
      const frame = (t: number) => {
        // Cap dt so a stalled tab does not jump the image across the screen.
        const dt = Math.min(48, Math.max(1, t - last));
        last = t;
        const g = geomRef.current;
        const step = inertiaStep(pos, v, dt, g.container, g.content);
        pos = step.transform;
        v = step.velocity;
        setTransformState(pos);
        inertiaRaf.current = step.done ? null : requestAnimationFrame(frame);
      };
      inertiaRaf.current = requestAnimationFrame(frame);
    },
    [enableInertia, stopInertia],
  );

  // ---- Two-finger pinch -------------------------------------------------------------------
  // Tracked in the capture phase so it works over children that stop propagation (the inpaint
  // canvas, the compare slider): those see the first finger, then `onGestureStart` tells them
  // to drop what it started.
  const touches = useRef(new Map<number, Point>());
  const pinchRef = useRef<PinchStart | null>(null);
  /** After a pinch, the remaining finger does nothing until every finger is lifted. */
  const suppressRef = useRef(false);

  const localPoint = (e: React.PointerEvent): Point => {
    const r = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };

  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Any new touch or click catches a fling in progress.
      stopInertia();
      if (!enablePinch || e.pointerType !== "touch") return;
      touches.current.set(e.pointerId, localPoint(e));
      if (touches.current.size === 2 && !pinchRef.current) {
        const [p1, p2] = [...touches.current.values()];
        dragRef.current = null;
        setIsPanning(false);
        pinchRef.current = { transform: transformRef.current, p1, p2 };
        suppressRef.current = true;
        setIsPinching(true);
        onGestureStartRef.current?.();
        e.stopPropagation();
      }
    },
    [enablePinch, stopInertia],
  );

  const onPointerMoveCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!touches.current.has(e.pointerId)) return;
    touches.current.set(e.pointerId, localPoint(e));
    const start = pinchRef.current;
    if (start && touches.current.size >= 2) {
      const [p1, p2] = [...touches.current.values()];
      const g = geomRef.current;
      const next = pinchTransform(start, p1, p2, g.container, g.content);
      wasAtFitRef.current = Math.abs(next.scale - g.fitScale) < 0.005;
      setTransformState(next);
    }
    if (suppressRef.current) e.stopPropagation();
  }, []);

  const onTouchEndCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!touches.current.delete(e.pointerId)) return;
    if (pinchRef.current && touches.current.size < 2) {
      pinchRef.current = null;
      setIsPinching(false);
    }
    if (touches.current.size === 0) suppressRef.current = false;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (pinchRef.current || suppressRef.current) return;
      // Middle button always pans (also where left-drag belongs to a tool, e.g. the inpaint brush).
      const middle = e.button === 1;
      if (!enablePan && !middle) return;
      if (e.button !== 0 && !middle) return;
      // No browser autoscroll on middle-drag.
      if (middle) e.preventDefault();

      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        initialX: transform.x,
        initialY: transform.y,
        moved: false,
      };
      samplesRef.current = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
      if (typeof e.currentTarget.setPointerCapture === "function") {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* ignore pointer capture failure */
        }
      }
    },
    [enablePan, transform.x, transform.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;

      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;

      if (!d.moved && Math.hypot(dx, dy) > 4) {
        d.moved = true;
        setIsPanning(true);
      }

      if (d.moved) {
        const now = performance.now();
        const samples = samplesRef.current;
        samples.push({ t: now, x: e.clientX, y: e.clientY });
        while (samples.length > 2 && now - samples[0].t > 150) samples.shift();

        const rawOffset = { x: d.initialX + dx, y: d.initialY + dy };
        const clamped = clampOffset(rawOffset, transform.scale, containerSize, content);
        setTransformState((prev) => {
          const next = { ...prev, x: clamped.x, y: clamped.y };
          return next;
        });
      }
    },
    [containerSize, content, transform.scale],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      dragRef.current = null;
      setIsPanning(false);

      if (typeof e.currentTarget.releasePointerCapture === "function") {
        try {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
        } catch {
          /* ignore pointer capture release failure */
        }
      }

      if (d?.moved) {
        startInertia(releaseVelocity(samplesRef.current, performance.now()));
      } else if (d && enableToggleZoom && e.button === 0) {
        const rect = e.currentTarget.getBoundingClientRect();
        const focal: Point = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        toggleZoom(focal);
      }
      samplesRef.current = [];
    },
    [enableToggleZoom, startInertia, toggleZoom],
  );

  const onPointerCancel = useCallback(() => {
    dragRef.current = null;
    samplesRef.current = [];
    setIsPanning(false);
  }, []);

  const cursorStyle = useMemo(() => {
    if (isPanning) return "grabbing";
    if (isZoomed) return "grab";
    if (enableToggleZoom) return canZoom ? "zoom-in" : "default";
    return "default";
  }, [canZoom, enableToggleZoom, isPanning, isZoomed]);

  return {
    containerRef,
    contentRef,
    transform,
    containerSize,
    contentSize: content,
    isZoomed,
    isPanning,
    isPinching,
    canZoom,
    fitTransform,
    zoomIn,
    zoomOut,
    zoomFit,
    zoom100,
    toggleZoom,
    setTransform: updateTransform,
    containerProps: {
      ref: containerRef,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onPointerDownCapture,
      onPointerMoveCapture,
      onPointerUpCapture: onTouchEndCapture,
      onPointerCancelCapture: onTouchEndCapture,
      style: {
        cursor: cursorStyle,
        touchAction: "none",
        userSelect: "none",
      },
    },
  };
}
