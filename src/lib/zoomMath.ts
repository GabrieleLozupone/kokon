/**
 * Pure math helpers for 2D zoom and pan transformations.
 */

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ZoomTransform {
  x: number;
  y: number;
  scale: number;
}

export const MIN_ZOOM_SCALE = 0.05;
export const MAX_ZOOM_SCALE = 32;

/**
 * Standard discrete zoom levels used for step-wise zooming (+/- buttons or shortcuts).
 */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

/**
 * Clamps scale within safe bounds.
 */
export function clampScale(scale: number, min = MIN_ZOOM_SCALE, max = MAX_ZOOM_SCALE): number {
  return Math.min(max, Math.max(min, scale));
}

/**
 * Calculates transform to fit content centered inside container.
 * If maxScale is set (e.g. 1.0), prevents enlarging content smaller than container.
 */
export function calculateFit(container: Size, content: Size, maxScale = 1): ZoomTransform {
  if (container.width <= 0 || container.height <= 0 || content.width <= 0 || content.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  const fitScale = Math.min(container.width / content.width, container.height / content.height);
  const scale = clampScale(maxScale > 0 ? Math.min(fitScale, maxScale) : fitScale);
  const x = (container.width - content.width * scale) / 2;
  const y = (container.height - content.height * scale) / 2;
  return { x, y, scale };
}

/**
 * Clamps translation offsets so zoomed content does not get lost outside container viewport.
 * If content fits along an axis, it is centered.
 */
export function clampOffset(offset: Point, scale: number, container: Size, content: Size): Point {
  const renderedW = content.width * scale;
  const renderedH = content.height * scale;

  let x: number;
  if (renderedW <= container.width) {
    x = (container.width - renderedW) / 2;
  } else {
    // When larger than container, cannot pan past left edge (0) or right edge (container.width - renderedW)
    x = Math.max(container.width - renderedW, Math.min(0, offset.x));
  }

  let y: number;
  if (renderedH <= container.height) {
    y = (container.height - renderedH) / 2;
  } else {
    // Cannot pan past top edge (0) or bottom edge (container.height - renderedH)
    y = Math.max(container.height - renderedH, Math.min(0, offset.y));
  }

  return { x, y };
}

/**
 * Zooms into or out of a specific focal point in container coordinates.
 * The content point directly beneath focalPoint remains pinned at focalPoint after scaling.
 */
export function zoomAtFocalPoint(
  current: ZoomTransform,
  focalPoint: Point,
  targetScale: number,
  container: Size,
  content: Size,
): ZoomTransform {
  const scale = clampScale(targetScale);
  if (current.scale <= 0) return { x: 0, y: 0, scale };

  // Determine the content-space coordinate currently under focalPoint
  const contentX = (focalPoint.x - current.x) / current.scale;
  const contentY = (focalPoint.y - current.y) / current.scale;

  // New translation that preserves the content coordinate under focalPoint
  const rawX = focalPoint.x - contentX * scale;
  const rawY = focalPoint.y - contentY * scale;

  const clamped = clampOffset({ x: rawX, y: rawY }, scale, container, content);
  return {
    scale,
    x: clamped.x,
    y: clamped.y,
  };
}

/**
 * Maps a container screen point to coordinates within content space.
 */
export function screenToContentPoint(screenPoint: Point, transform: ZoomTransform): Point {
  return {
    x: (screenPoint.x - transform.x) / transform.scale,
    y: (screenPoint.y - transform.y) / transform.scale,
  };
}

/**
 * Maps a content coordinate to container screen point.
 */
export function contentToScreenPoint(contentPoint: Point, transform: ZoomTransform): Point {
  return {
    x: contentPoint.x * transform.scale + transform.x,
    y: contentPoint.y * transform.scale + transform.y,
  };
}

/**
 * Finds the next discrete zoom step for stepping in or out.
 */
export function nextZoomStep(currentScale: number, direction: "in" | "out"): number {
  const tolerance = 0.02;
  if (direction === "in") {
    const next = ZOOM_STEPS.find((s) => s > currentScale * (1 + tolerance));
    return next ?? clampScale(currentScale * 1.25);
  } else {
    const prev = [...ZOOM_STEPS].reverse().find((s) => s < currentScale * (1 - tolerance));
    return prev ?? clampScale(currentScale / 1.25);
  }
}

/**
 * Calculates the split fraction (0..1) from a pointer X position, given
 * the rendered bounding rect of the content box.
 */
export function calculateSplitFraction(
  clientX: number,
  boxRect: { left: number; width: number },
): number {
  if (boxRect.width <= 0) return 0.5;
  const fraction = (clientX - boxRect.left) / boxRect.width;
  return Math.min(1, Math.max(0, fraction));
}

/**
 * Calculates the split fraction (0..1) from screen X, viewport position,
 * zoom transform, and content width.
 */
export function screenToSplitFraction(
  screenX: number,
  viewportLeft: number,
  transform: ZoomTransform,
  contentWidth: number,
): number {
  const renderedWidth = contentWidth * transform.scale;
  if (renderedWidth <= 0) return 0.5;
  const renderedLeft = viewportLeft + transform.x;
  const fraction = (screenX - renderedLeft) / renderedWidth;
  return Math.min(1, Math.max(0, fraction));
}

// ---------------------------------------------------------------------------
// Phase 5: gestures (pinch, inertia) and the mini-map navigator.
// ---------------------------------------------------------------------------

/** State captured when a two-finger pinch begins. Points are in container coordinates. */
export interface PinchStart {
  transform: ZoomTransform;
  p1: Point;
  p2: Point;
}

/**
 * Two-finger pinch: scales by the change in finger distance and keeps the content point that was
 * under the starting midpoint under the current midpoint, so the image follows both fingers
 * (zoom and pan in one gesture).
 */
export function pinchTransform(start: PinchStart, p1: Point, p2: Point, container: Size, content: Size): ZoomTransform {
  const d0 = Math.hypot(start.p2.x - start.p1.x, start.p2.y - start.p1.y);
  const d1 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const ratio = d0 > 0 && d1 > 0 ? d1 / d0 : 1;
  const scale = clampScale(start.transform.scale * ratio);

  const m0 = { x: (start.p1.x + start.p2.x) / 2, y: (start.p1.y + start.p2.y) / 2 };
  const m1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const anchor = screenToContentPoint(m0, start.transform);

  const clamped = clampOffset({ x: m1.x - anchor.x * scale, y: m1.y - anchor.y * scale }, scale, container, content);
  return { scale, x: clamped.x, y: clamped.y };
}

/** A pointer position sample used to estimate release velocity (t in ms). */
export interface MotionSample {
  t: number;
  x: number;
  y: number;
}

/**
 * Release velocity in px/ms from the samples of the last `windowMs`. A pointer that stopped before
 * being released (no recent samples) has zero velocity, so it does not fling.
 */
export function releaseVelocity(samples: MotionSample[], now: number, windowMs = 100): Point {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 2) return { x: 0, y: 0 };
  const a = recent[0];
  const b = recent[recent.length - 1];
  const dt = b.t - a.t;
  if (dt <= 0) return { x: 0, y: 0 };
  return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
}

/** Velocity (px/ms) below which a fling stops. */
export const INERTIA_MIN_SPEED = 0.02;
/** Release speed (px/ms) needed to start a fling (~150 px/s). */
export const INERTIA_START_SPEED = 0.15;
/** Velocity kept per 16 ms frame. */
export const INERTIA_FRICTION = 0.92;

/**
 * One inertia frame: moves by velocity × dt, decays the velocity (frame-rate independent), and
 * stops an axis that hits the pan bounds so the image does not "stick" against an edge.
 */
export function inertiaStep(
  transform: ZoomTransform,
  velocity: Point,
  dtMs: number,
  container: Size,
  content: Size,
  friction = INERTIA_FRICTION,
): { transform: ZoomTransform; velocity: Point; done: boolean } {
  const raw = { x: transform.x + velocity.x * dtMs, y: transform.y + velocity.y * dtMs };
  const clamped = clampOffset(raw, transform.scale, container, content);
  const decay = Math.pow(friction, dtMs / 16);
  const vx = Math.abs(clamped.x - raw.x) > 0.01 ? 0 : velocity.x * decay;
  const vy = Math.abs(clamped.y - raw.y) > 0.01 ? 0 : velocity.y * decay;
  const done = Math.hypot(vx, vy) < INERTIA_MIN_SPEED;
  return { transform: { scale: transform.scale, x: clamped.x, y: clamped.y }, velocity: { x: vx, y: vy }, done };
}

/** Rectangle as fractions (0..1) of the content. */
export interface FractionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The part of the content visible in the viewport, as fractions of the content (for the mini-map). */
export function visibleContentRect(transform: ZoomTransform, container: Size, content: Size): FractionRect {
  if (transform.scale <= 0 || content.width <= 0 || content.height <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  const x0 = Math.max(0, -transform.x / transform.scale / content.width);
  const y0 = Math.max(0, -transform.y / transform.scale / content.height);
  const x1 = Math.min(1, (container.width - transform.x) / transform.scale / content.width);
  const y1 = Math.min(1, (container.height - transform.y) / transform.scale / content.height);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Pans (same scale) so the content point at fractions (fx, fy) sits in the viewport centre. */
export function centerOnContentFraction(
  fx: number,
  fy: number,
  transform: ZoomTransform,
  container: Size,
  content: Size,
): ZoomTransform {
  const cx = Math.min(1, Math.max(0, fx)) * content.width;
  const cy = Math.min(1, Math.max(0, fy)) * content.height;
  const raw = { x: container.width / 2 - cx * transform.scale, y: container.height / 2 - cy * transform.scale };
  const clamped = clampOffset(raw, transform.scale, container, content);
  return { scale: transform.scale, x: clamped.x, y: clamped.y };
}

/** Mini-map box size: the content's aspect ratio within a `maxSide` square. */
export function minimapSize(content: Size, maxSide = 160): Size {
  if (content.width <= 0 || content.height <= 0) return { width: maxSide, height: maxSide };
  const k = maxSide / Math.max(content.width, content.height);
  return { width: Math.round(content.width * k), height: Math.round(content.height * k) };
}
