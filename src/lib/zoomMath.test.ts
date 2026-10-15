import { describe, expect, it } from "vitest";
import {
  calculateFit,
  calculateSplitFraction,
  centerOnContentFraction,
  clampOffset,
  clampScale,
  contentToScreenPoint,
  inertiaStep,
  minimapSize,
  nextZoomStep,
  pinchTransform,
  releaseVelocity,
  screenToContentPoint,
  screenToSplitFraction,
  visibleContentRect,
  zoomAtFocalPoint,
} from "./zoomMath";

describe("zoomMath", () => {
  const container = { width: 800, height: 600 };
  const content = { width: 1600, height: 1200 };

  describe("calculateFit", () => {
    it("fits larger content centered inside container", () => {
      const fit = calculateFit(container, content);
      expect(fit.scale).toBe(0.5);
      expect(fit.x).toBe(0); // 1600 * 0.5 = 800, fits exactly
      expect(fit.y).toBe(0); // 1200 * 0.5 = 600, fits exactly
    });

    it("centers content with different aspect ratio", () => {
      // 800x600 container, 1000x1000 square content
      const square = { width: 1000, height: 1000 };
      const fit = calculateFit(container, square);
      // scale should be 600 / 1000 = 0.6
      expect(fit.scale).toBe(0.6);
      expect(fit.y).toBe(0); // 1000 * 0.6 = 600
      expect(fit.x).toBe((800 - 600) / 2); // 100px letterbox on left and right
    });

    it("respects maxScale for smaller content", () => {
      const small = { width: 200, height: 150 };
      const fit = calculateFit(container, small, 1);
      expect(fit.scale).toBe(1); // Not enlarged past 1.0
      expect(fit.x).toBe((800 - 200) / 2); // 300
      expect(fit.y).toBe((600 - 150) / 2); // 225
    });
  });

  describe("clampOffset", () => {
    it("centers content when it fits within container", () => {
      const offset = clampOffset({ x: 50, y: -20 }, 0.5, container, content);
      // Content is 1600x1200 at scale 0.5 -> 800x600, exactly container size
      expect(offset.x).toBe(0);
      expect(offset.y).toBe(0);
    });

    it("clamps panning when zoomed in", () => {
      // Scale 1.0 -> content is 1600x1200. Container is 800x600.
      // x valid range is [800 - 1600, 0] = [-800, 0]
      // y valid range is [600 - 1200, 0] = [-600, 0]
      expect(clampOffset({ x: 100, y: 50 }, 1, container, content)).toEqual({ x: 0, y: 0 });
      expect(clampOffset({ x: -1000, y: -800 }, 1, container, content)).toEqual({ x: -800, y: -600 });
      expect(clampOffset({ x: -300, y: -200 }, 1, container, content)).toEqual({ x: -300, y: -200 });
    });
  });

  describe("zoomAtFocalPoint", () => {
    it("preserves point under focal position when scaling up", () => {
      const current = { x: 0, y: 0, scale: 0.5 };
      const focal = { x: 400, y: 300 }; // Center of 800x600 container
      // Content point under focal: (400 - 0) / 0.5 = 800, (300 - 0) / 0.5 = 600 (center of 1600x1200)
      const next = zoomAtFocalPoint(current, focal, 1.0, container, content);
      expect(next.scale).toBe(1.0);
      // After scale 1.0, center of 1600x1200 should still be at 400, 300:
      // rawX = 400 - 800 * 1 = -400
      // rawY = 300 - 600 * 1 = -300
      expect(next.x).toBe(-400);
      expect(next.y).toBe(-300);
    });

    it("clamps boundaries properly when zooming near edges", () => {
      const current = { x: 0, y: 0, scale: 0.5 };
      const focal = { x: 0, y: 0 }; // Top-left corner
      const next = zoomAtFocalPoint(current, focal, 2.0, container, content);
      expect(next.scale).toBe(2.0);
      expect(next.x).toBe(0);
      expect(next.y).toBe(0);
    });
  });

  describe("screenToContentPoint and contentToScreenPoint", () => {
    it("converts back and forth accurately", () => {
      const transform = { x: -200, y: -150, scale: 1.5 };
      const screenPoint = { x: 400, y: 300 };
      const contentPoint = screenToContentPoint(screenPoint, transform);
      const backToScreen = contentToScreenPoint(contentPoint, transform);

      expect(backToScreen.x).toBeCloseTo(screenPoint.x);
      expect(backToScreen.y).toBeCloseTo(screenPoint.y);
    });
  });

  describe("nextZoomStep", () => {
    it("steps up and down logically", () => {
      expect(nextZoomStep(1.0, "in")).toBe(1.25);
      expect(nextZoomStep(1.25, "in")).toBe(1.5);
      expect(nextZoomStep(1.0, "out")).toBe(0.75);
      expect(nextZoomStep(0.75, "out")).toBe(0.67);
    });
  });

  describe("clampScale", () => {
    it("constrains within bounds", () => {
      expect(clampScale(0.01)).toBe(0.05);
      expect(clampScale(50)).toBe(32);
      expect(clampScale(1.5)).toBe(1.5);
    });
  });

  describe("calculateSplitFraction", () => {
    it("calculates middle split correctly", () => {
      expect(calculateSplitFraction(400, { left: 0, width: 800 })).toBe(0.5);
      expect(calculateSplitFraction(500, { left: 100, width: 800 })).toBe(0.5);
    });

    it("clamps pointer beyond left and right bounds", () => {
      expect(calculateSplitFraction(-50, { left: 0, width: 800 })).toBe(0);
      expect(calculateSplitFraction(900, { left: 0, width: 800 })).toBe(1);
    });

    it("handles zero or negative width gracefully", () => {
      expect(calculateSplitFraction(100, { left: 0, width: 0 })).toBe(0.5);
      expect(calculateSplitFraction(100, { left: 0, width: -10 })).toBe(0.5);
    });
  });

  describe("screenToSplitFraction", () => {
    it("calculates split fraction taking zoom scale and pan into account", () => {
      // 1000px content at scale 2.0 -> renderedWidth 2000px
      // Pan offset x = -400px, viewportLeft = 100px -> renderedLeft = -300px
      const transform = { x: -400, y: 0, scale: 2.0 };
      const viewportLeft = 100;
      const contentWidth = 1000;

      // Screen X = 500px: distance from renderedLeft is 500 - (-300) = 800px
      // Fraction across 2000px is 800 / 2000 = 0.4
      expect(screenToSplitFraction(500, viewportLeft, transform, contentWidth)).toBe(0.4);

      // Center of content (content X = 500):
      // Screen X = 100 + (-400) + 500 * 2 = 700px
      expect(screenToSplitFraction(700, viewportLeft, transform, contentWidth)).toBe(0.5);

      // Clamping
      expect(screenToSplitFraction(-500, viewportLeft, transform, contentWidth)).toBe(0);
      expect(screenToSplitFraction(3000, viewportLeft, transform, contentWidth)).toBe(1);
    });

    it("matches calculateSplitFraction under zoom", () => {
      const transform = { x: -200, y: -50, scale: 1.5 };
      const viewportLeft = 50;
      const contentWidth = 1200;
      const boxRect = {
        left: viewportLeft + transform.x, // -150
        width: contentWidth * transform.scale, // 1800
      };

      for (const screenX of [0, 200, 500, 750, 1000, 1500, 2000]) {
        const fromTransform = screenToSplitFraction(screenX, viewportLeft, transform, contentWidth);
        const fromRect = calculateSplitFraction(screenX, boxRect);
        expect(fromTransform).toBeCloseTo(fromRect);
      }
    });
  });

  describe("pinchTransform", () => {
    it("scales according to change in finger distance", () => {
      const start = {
        transform: { x: 0, y: 0, scale: 1 },
        p1: { x: 300, y: 300 },
        p2: { x: 500, y: 300 }, // distance = 200
      };
      // Distance increases to 400 (ratio = 2.0)
      const p1 = { x: 200, y: 300 };
      const p2 = { x: 600, y: 300 };
      const next = pinchTransform(start, p1, p2, container, content);
      expect(next.scale).toBe(2);
    });

    it("keeps midpoint anchor steady during pinch", () => {
      const start = {
        transform: { x: -100, y: -100, scale: 1 },
        p1: { x: 300, y: 300 },
        p2: { x: 500, y: 300 }, // midpoint = (400, 300)
      };
      // Move both fingers right by 50px while maintaining distance
      const p1 = { x: 350, y: 300 };
      const p2 = { x: 550, y: 300 };
      const next = pinchTransform(start, p1, p2, container, content);
      expect(next.scale).toBe(1);
      // Midpoint shifted right by 50px, content should pan right by 50px
      expect(next.x).toBe(-50);
      expect(next.y).toBe(-100);
    });
  });

  describe("releaseVelocity", () => {
    it("computes release velocity in px/ms from recent samples", () => {
      const samples = [
        { t: 0, x: 100, y: 100 },
        { t: 50, x: 200, y: 150 },
        { t: 100, x: 300, y: 200 },
      ];
      const v = releaseVelocity(samples, 100, 100);
      // dt = 100 - 0 = 100ms, dx = 200, dy = 100
      expect(v.x).toBe(2);
      expect(v.y).toBe(1);
    });

    it("returns zero velocity if pointer stopped moving before release", () => {
      const samples = [
        { t: 0, x: 100, y: 100 },
        { t: 50, x: 300, y: 300 },
      ];
      // Released at t = 200ms (> 100ms after last sample)
      const v = releaseVelocity(samples, 200, 100);
      expect(v).toEqual({ x: 0, y: 0 });
    });

    it("returns zero velocity for fewer than 2 samples", () => {
      expect(releaseVelocity([], 100)).toEqual({ x: 0, y: 0 });
      expect(releaseVelocity([{ t: 100, x: 10, y: 10 }], 100)).toEqual({ x: 0, y: 0 });
    });
  });

  describe("inertiaStep", () => {
    it("advances position by velocity * dt and decays velocity", () => {
      const transform = { x: -400, y: -300, scale: 1 };
      const velocity = { x: 0.5, y: 0.2 };
      const step = inertiaStep(transform, velocity, 16, container, content, 0.9);

      // x should advance: -400 + 0.5 * 16 = -392
      expect(step.transform.x).toBeCloseTo(-392);
      expect(step.transform.y).toBeCloseTo(-296.8);
      // velocity decays by friction 0.9
      expect(step.velocity.x).toBeCloseTo(0.45);
      expect(step.velocity.y).toBeCloseTo(0.18);
      expect(step.done).toBe(false);
    });

    it("zeros velocity on axis when hitting pan bounds", () => {
      // Content 1600x1200, container 800x600, scale 1.0. Max x is 0.
      const transform = { x: -5, y: -300, scale: 1 };
      const velocity = { x: 1.0, y: 0 }; // Moving right, would exceed 0
      const step = inertiaStep(transform, velocity, 16, container, content);

      expect(step.transform.x).toBe(0);
      expect(step.velocity.x).toBe(0);
      expect(step.done).toBe(true);
    });
  });

  describe("visibleContentRect", () => {
    it("returns full fraction (0, 0, 1, 1) when at fit scale", () => {
      // Content 1600x1200 at scale 0.5 fits 800x600 container exactly
      const transform = { x: 0, y: 0, scale: 0.5 };
      const rect = visibleContentRect(transform, container, content);
      expect(rect.x).toBe(0);
      expect(rect.y).toBe(0);
      expect(rect.w).toBe(1);
      expect(rect.h).toBe(1);
    });

    it("returns fraction of visible area when zoomed in", () => {
      // Scale 1.0, container 800x600, content 1600x1200
      // Pan centered: x = -400, y = -300
      const transform = { x: -400, y: -300, scale: 1 };
      const rect = visibleContentRect(transform, container, content);

      // x0 = 400 / 1 / 1600 = 0.25
      // y0 = 300 / 1 / 1200 = 0.25
      // x1 = (800 + 400) / 1600 = 0.75 -> w = 0.5
      // y1 = (600 + 300) / 1200 = 0.75 -> h = 0.5
      expect(rect.x).toBeCloseTo(0.25);
      expect(rect.y).toBeCloseTo(0.25);
      expect(rect.w).toBeCloseTo(0.5);
      expect(rect.h).toBeCloseTo(0.5);
    });
  });

  describe("centerOnContentFraction", () => {
    it("centers on content point at fraction fx, fy", () => {
      // Center of content (0.5, 0.5) at scale 1.0 in 800x600 container
      const transform = { x: 0, y: 0, scale: 1 };
      const next = centerOnContentFraction(0.5, 0.5, transform, container, content);

      // Content center = (800, 600)
      // container center = (400, 300)
      // x = 400 - 800 * 1 = -400
      // y = 300 - 600 * 1 = -300
      expect(next.x).toBe(-400);
      expect(next.y).toBe(-300);
      expect(next.scale).toBe(1);
    });

    it("clamps offsets at edges when centering near boundary", () => {
      const transform = { x: 0, y: 0, scale: 1 };
      const next = centerOnContentFraction(0, 0, transform, container, content);
      // Top left fraction (0, 0), clamped to max x = 0, y = 0
      expect(next.x).toBe(0);
      expect(next.y).toBe(0);
    });
  });

  describe("minimapSize", () => {
    it("computes aspect-ratio box within maxSide", () => {
      // 1600x1200 -> aspect ratio 4:3. maxSide 160 -> width 160, height 120
      const size = minimapSize(content, 160);
      expect(size.width).toBe(160);
      expect(size.height).toBe(120);

      // Portrait: 1200x1600 -> width 120, height 160
      const portrait = minimapSize({ width: 1200, height: 1600 }, 160);
      expect(portrait.width).toBe(120);
      expect(portrait.height).toBe(160);
    });
  });
});

