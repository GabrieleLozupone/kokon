// The question asked when the user splits an image into layers (LayerSplit): how the objects are cut
// out. Fast = the sticker model in kokon-service (crates/qls-core/src/matting.rs, a few seconds each);
// Quality = Qwen redraws each object's edge (about half a minute each). Either way the background's
// holes are then filled by the image model.

import { Check, Scissors, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { IconButton } from "./ui";

export type StickerMode = "quality" | "fast" | "off";

/** Seconds per object, as measured (11-02, RTX 5070 Ti + 16-thread CPU): for the time shown. */
const SECONDS = { fast: 4, quality: 30 };

const total = (n: number, mode: "fast" | "quality") => {
  const s = n * SECONDS[mode];
  return s < 60 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s` : `about ${Math.round(s / 60)} min`;
};

export function SplitChoice({ count, last, onPick, onCancel }: { count: number; last: StickerMode; onPick: (m: StickerMode) => void; onCancel: () => void }) {
  // The fast model is downloaded the first time it is used: said on its card.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api.matteStatus().then((s) => setMissing(!s.installed), () => {});
  }, []);
  const preferred = last === "off" ? "fast" : last;
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);
  const objects = `${count} object${count === 1 ? "" : "s"}`;

  const card = (mode: "fast" | "quality") => {
    const fast = mode === "fast";
    return (
      <button key={mode} ref={mode === preferred ? first : undefined} className={`split-card ${mode === preferred ? "last" : ""}`} onClick={() => onPick(mode)}>
        <span className="split-card-icon">{fast ? <Scissors size={20} /> : <Sparkles size={20} />}</span>
        <span className="split-card-title">
          {fast ? "Fast" : "Quality"}
          {mode === last && <span className="split-card-tag">Last used</span>}
        </span>
        <span className="split-card-text">{fast ? "A quick, precise cut-out of each object, the same every time." : "The AI redraws each object's edge as a clean cut-out."}</span>
        <ul className="split-card-points">
          {(fast
            ? ["Solid objects with clear edges", "Objects that stand out from what is behind them"]
            : ["Hair, fur, fine or see-through parts", "Objects that blend into a busy background"]
          ).map((p) => (
            <li key={p}>
              <Check size={13} /> {p}
            </li>
          ))}
        </ul>
        <span className="split-card-time">
          {total(count, mode)} for {objects}
          {fast && missing ? " · first time: downloads 224 MB" : ""}
        </span>
      </button>
    );
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="split-choice" role="dialog" aria-modal="true" aria-labelledby="split-choice-title">
        <span className="split-choice-close">
          <IconButton title="Back to selecting (Esc)" onClick={onCancel}>
            <X size={18} />
          </IconButton>
        </span>
        <h2 id="split-choice-title">How should the objects be cut out?</h2>
        <p className="split-choice-lead">
          Each object becomes its own layer. Pick by how hard its edges are to cut out; you can redo any object later with Clean edges (Quality) or Quick
          cut-out (Fast).
        </p>
        <div className="split-cards">{(["fast", "quality"] as const).map(card)}</div>
        <div className="split-choice-foot">
          <span>Then the background behind them is filled in by the AI.</span>
          <button className="btn ghost" onClick={() => onPick("off")}>
            Skip: keep the rough cut-outs
          </button>
        </div>
      </div>
    </div>
  );
}
