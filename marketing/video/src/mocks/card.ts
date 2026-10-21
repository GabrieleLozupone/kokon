// The clock of the job card in the stage (mocks/jobMotion.ts, mocks/Cocoon.tsx), from the
// frame: the app runs it on timers, which a video renders out of order. <AppWindow card={…}>
// provides it; without one a card shows its first moment.
import { createContext, useContext } from "react";

export interface CardMotion {
  /** Seconds since the card appeared. */
  t: number;
  /** The job's percentage at `t` seconds (only ever rising). */
  pctAt: (t: number) => number;
  /** Characters of the enhanced prompt revealed, and how fast they arrive (characters a second). */
  chars?: number;
  cps?: number;
  /** The finished prompt fading out for the percentage, 0..1. */
  leave?: number;
  /** Milliseconds into the result's hatching (null: not hatching). */
  hatchMs?: number | null;
}

export const CardMotionContext = createContext<CardMotion | null>(null);
const STILL: CardMotion = { t: 0, pctAt: () => 0 };
export const useCard = () => useContext(CardMotionContext) ?? STILL;

/** Seconds into the card when the percentage first reached `pct` (null: not yet at `t`). */
export function reachedAt(c: CardMotion, pct: number): number | null {
  if (c.pctAt(c.t) < pct) return null;
  if (c.pctAt(0) >= pct) return 0;
  let lo = 0;
  let hi = c.t;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (c.pctAt(mid) >= pct) hi = mid;
    else lo = mid;
  }
  return hi;
}
