// The app's job-card timing (src/components/jobMotion.ts) read from the frame clock instead of
// timers: same names, same results, as pure functions of the card's time.
import type { CSSProperties } from "react";
import type { JobClock } from "../../../../src/lib/logic";
import type { GenerationRequest, JobView } from "../../../../src/lib/types";
import { useCard } from "./card";

export const PROMPT_HOLD_MS = 2200;
export const PROMPT_FADE_MS = 700;

export function useJobPercent(_job: JobView, request: GenerationRequest | null | undefined, _learn = false): { pct: number; clock: JobClock } {
  const c = useCard();
  const clock: JobClock = { elapsed: c.t, inPhase: c.t, inRunning: c.t, sinceStep: 0, enhance: !!request?.enhance, loadSeconds: 20, enhancerSecondsPerWord: 0.015 };
  return { pct: c.pctAt(c.t), clock };
}

export function useTypewriter(text: string, _streaming: boolean, _budget: number | null): number {
  const c = useCard();
  return Math.min(text.length, c.chars ?? text.length);
}

/** The fade of `.prompt-stage.leaving`, at the frame's point in it. */
export function usePromptLeave(_writing: boolean, _text: string, _onGone: () => void): { leaving: boolean; style?: CSSProperties } {
  const l = Math.min(1, Math.max(0, useCard().leave ?? 0));
  if (l <= 0) return { leaving: false };
  const e = l * l; // ease-in, as the CSS transition
  return { leaving: false, style: { opacity: 1 - e, transform: `scale(${1 - 0.03 * e})`, filter: `blur(${8 * e}px)` } };
}

/** The word-in keyframes (styles.css) at the word's age: it appeared `(shown - at) / cps` ago. */
export function wordStyle(at: number, shown: number): CSSProperties {
  // Hooks can't run here (called in a loop), so the speed comes from the module's last card.
  const age = Math.max(0, (shown - at) / lastCps);
  const k = Math.min(1, age / 0.9);
  const e = 1 - Math.pow(1 - k, 3);
  return { animation: "none", opacity: Math.min(1, e * 1.4), filter: e < 1 ? `blur(${(6 * (1 - e)).toFixed(2)}px)` : undefined };
}

let lastCps = 60;
/** Set by <AppWindow> for each frame, before its components render. */
export function setWordPace(cps: number) {
  lastCps = cps;
}
