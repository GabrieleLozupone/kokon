// The timing of a job's card in the stage: the live percentage, the prompt enhancer's text
// appearing word by word, and the prompt leaving for the percentage. Kept apart from Stage.tsx
// so the launch video (marketing/video) can drive the same card from its frame clock.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { jobPercent, type JobClock } from "../lib/logic";
import type { GenerationRequest, JobView } from "../lib/types";
import { reducedMotion } from "./Cocoon";

/** This machine's pace for the phases the plan cannot estimate (model load, prompt enhancer),
 * remembered between jobs; a per-viewer convenience, so defaults when storage is unavailable. */
const PROGRESS_KEY = "kokon.progress";
interface ProgressMemory { loadSeconds: number; enhancerSecondsPerWord: number }
function progressMemory(): ProgressMemory {
  const d: ProgressMemory = { loadSeconds: 20, enhancerSecondsPerWord: 0.015 };
  try {
    const v = JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}");
    return { loadSeconds: v.loadSeconds > 0 ? v.loadSeconds : d.loadSeconds, enhancerSecondsPerWord: v.enhancerSecondsPerWord > 0 ? v.enhancerSecondsPerWord : d.enhancerSecondsPerWord };
  } catch {
    return d;
  }
}
function rememberProgress(m: Partial<ProgressMemory>) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify({ ...progressMemory(), ...m }));
  } catch {
    /* storage unavailable: the defaults stay */
  }
}

const ENHANCED_MODES = new Set(["generate", "edit", "multi_reference"]);

/** Live percentage of a whole job (`jobPercent`), computed a few times a second, only ever going
 * up, and eased so it counts up smoothly. Tracks when the job and each phase started; `learn`
 * (the main card only) remembers how long the model load and the prompt enhancer took. */
export function useJobPercent(job: JobView, request: GenerationRequest | null | undefined, learn = false): { pct: number; clock: JobClock } {
  const enhance = !!request?.enhance && ENHANCED_MODES.has(job.plan?.mode ?? request?.mode ?? "");
  const [shown, setShown] = useState<{ pct: number; clock: JobClock }>(() => ({ pct: 0, clock: { elapsed: 0, inPhase: 0, inRunning: 0, sinceStep: 0, enhance, ...progressMemory() } }));
  const live = useRef({ job, enhance });
  live.current = { job, enhance };
  useEffect(() => {
    const mem = progressMemory();
    let startedAt: number | null = null;
    let runningAt: number | null = null;
    let phase = { key: "", at: performance.now() };
    let step = { key: "", at: performance.now() };
    let target = 0;
    let value = 0;
    const id = window.setInterval(() => {
      const { job: j, enhance: e } = live.current;
      const now = performance.now();
      if (startedAt === null && j.status !== "queued") startedAt = now;
      if (runningAt === null && j.status === "running") runningAt = now;
      const key = `${j.status}|${j.stage ?? ""}`;
      if (key !== phase.key) {
        // Learn the phases the plan does not estimate, when they end.
        const took = (now - phase.at) / 1000;
        const was = phase.key.split("|")[0];
        if (learn && was === "starting_backend" && took > 1) rememberProgress({ loadSeconds: took });
        if (learn && was === "enhancing_prompt" && j.enhanced_prompt) {
          const words = j.enhanced_prompt.split(/\s+/).filter(Boolean).length;
          if (words >= 5) rememberProgress({ enhancerSecondsPerWord: took / words });
        }
        phase = { key, at: now };
      }
      const stepKey = j.step ? `${j.stage}|${j.step[0]}/${j.step[1]}` : "";
      if (stepKey !== step.key) step = { key: stepKey, at: now };
      const clock: JobClock = {
        elapsed: startedAt === null ? 0 : (now - startedAt) / 1000,
        inPhase: (now - phase.at) / 1000,
        inRunning: runningAt === null ? 0 : (now - runningAt) / 1000,
        sinceStep: (now - step.at) / 1000,
        enhance: e,
        ...mem,
      };
      target = Math.max(target, jobPercent(j, clock));
      value += (target - value) * (reducedMotion() ? 1 : 0.18);
      if (target - value < 0.05) value = target;
      setShown({ pct: value, clock });
    }, 60);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return shown;
}

/** How long the finished prompt stays on screen before the percentage takes over (ms). */
export const PROMPT_HOLD_MS = 2200;
export const PROMPT_FADE_MS = 700;

/** Once the whole prompt is on screen it holds, then fades (`leaving`, styled by
 * `.prompt-stage.leaving`), then `onGone`. `style` is for a clock other than the browser's. */
export function usePromptLeave(writing: boolean, text: string, onGone: () => void): { leaving: boolean; style?: CSSProperties } {
  const [leaving, setLeaving] = useState(false);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (writing || !text) return;
    const hold = window.setTimeout(() => setLeaving(true), PROMPT_HOLD_MS);
    const end = window.setTimeout(() => gone.current(), PROMPT_HOLD_MS + PROMPT_FADE_MS);
    return () => (window.clearTimeout(hold), window.clearTimeout(end));
  }, [writing, text]);
  return { leaving };
}

/** Inline style of the word starting at character `at` while `shown` characters are revealed;
 * none here, the CSS animation (`.prompt-text .w`) fades each word in when it mounts. */
export function wordStyle(_at: number, _shown: number): CSSProperties | undefined {
  return undefined;
}

/** Calm reading pace of the prompt (characters a second). */
const TYPE_CHARS_PER_S = 32;

/** How many characters of `text` to show now: ~32 a second, faster when needed to finish in
 * 4-12 s (and in half the time a quick image takes), never past `text`. */
export function useTypewriter(text: string, streaming: boolean, budget: number | null): number {
  const [shown, setShown] = useState(() => (reducedMotion() ? text.length : 0));
  const target = useRef({ text, streaming, budget });
  target.current = { text, streaming, budget };
  const start = useRef<number | null>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    let raf = 0;
    let last = performance.now();
    let n = 0;
    const tick = (now: number) => {
      const { text: t, streaming: s, budget: b } = target.current;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (t.length > 0 && start.current === null) start.current = now;
      if (n < t.length) {
        const cap = Math.max(4, Math.min(12, b ? b * 0.5 : 12));
        const total = Math.min(cap, Math.max(4, t.length / TYPE_CHARS_PER_S));
        const left = Math.max(0.4, total - (now - (start.current ?? now)) / 1000);
        const speed = Math.max(s ? 20 : TYPE_CHARS_PER_S, (t.length - n) / left);
        n = Math.min(t.length, n + speed * dt);
        setShown(n);
      }
      // Done once everything has arrived and is on screen.
      if (s || n < t.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return reducedMotion() ? text.length : shown;
}
