// The question asked when the user splits an image into layers (LayerSplit): how the objects are cut
// out. Fast = the sticker model in kokon-service (crates/qls-core/src/matting.rs, a few seconds each);
// Quality = Qwen redraws each object's edge (about half a minute each). Either way the background's
// holes are then filled by the image model.

import { Check, Scissors, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { IconButton } from "./ui";

export type StickerMode = "quality" | "fast" | "off";

/** Seconds per object, as measured (11-02, RTX 5070 Ti + 16-thread CPU): for the time shown. */
const SECONDS = { fast: 4, quality: 30 };

const total = (n: number, mode: "fast" | "quality") => {
  const s = n * SECONDS[mode];
  return s < 60 ? t("splitChoice.aboutSeconds", { n: Math.max(5, Math.round(s / 5) * 5) }) : t("splitChoice.aboutMinutes", { n: Math.round(s / 60) });
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

  const card = (mode: "fast" | "quality") => {
    const fast = mode === "fast";
    return (
      <button key={mode} ref={mode === preferred ? first : undefined} className={`split-card ${mode === preferred ? "last" : ""}`} onClick={() => onPick(mode)}>
        <span className="split-card-icon">{fast ? <Scissors size={20} /> : <Sparkles size={20} />}</span>
        <span className="split-card-title">
          {fast ? t("splitChoice.fast") : t("splitChoice.quality")}
          {mode === last && <span className="split-card-tag">{t("splitChoice.lastUsed")}</span>}
        </span>
        <span className="split-card-text">{fast ? t("splitChoice.fastText") : t("splitChoice.qualityText")}</span>
        <ul className="split-card-points">
          {(fast
            ? [t("splitChoice.fastPointSolid"), t("splitChoice.fastPointStandOut")]
            : [t("splitChoice.qualityPointHair"), t("splitChoice.qualityPointBusy")]
          ).map((p) => (
            <li key={p}>
              <Check size={13} /> {p}
            </li>
          ))}
        </ul>
        <span className="split-card-time">
          {t("splitChoice.timeFor", { time: total(count, mode), count })}
          {fast && missing ? ` · ${t("splitChoice.firstTimeDownload")}` : ""}
        </span>
      </button>
    );
  };

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="split-choice" role="dialog" aria-modal="true" aria-labelledby="split-choice-title">
        <span className="split-choice-close">
          <IconButton title={t("splitChoice.backEsc")} onClick={onCancel}>
            <X size={18} />
          </IconButton>
        </span>
        <h2 id="split-choice-title">{t("splitChoice.title")}</h2>
        <p className="split-choice-lead">
          {t("splitChoice.lead")}
        </p>
        <div className="split-cards">{(["fast", "quality"] as const).map(card)}</div>
        <div className="split-choice-foot">
          <span>{t("splitChoice.backgroundFilled")}</span>
          <button className="btn ghost" onClick={() => onPick("off")}>
            {t("splitChoice.skip")}
          </button>
        </div>
      </div>
    </div>
  );
}
