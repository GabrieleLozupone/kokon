// "Blend into scene" (LayerDoc): what the AI read about where each object stands, shown before the
// edit so the user can correct it (Gabriele 11-02: "un pop up con possibilità di correggerlo"). The
// reading picks the effects the prompt names (lib/blend.ts): a wrong "wet" draws a reflection on dry
// ground, a wrong "dry" leaves a puddle without one.

import { Loader2, Sun, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { blendEffects, FALLS, SURFACES } from "../lib/blend";
import type { SceneReading } from "../lib/types";
import { t } from "../lib/i18n";
import { IconButton } from "./ui";

export interface BlendRow {
  id: string;
  name: string;
  /** Missing while it is being read. */
  reading?: SceneReading;
  /** Why the reading is the safe default. */
  failed?: string;
}

/** At the fast preset (11-02 bench, RTX 5070 Ti): ~2 s to read each object's place, then one edit of
 * the whole scene for all of them, 12-24 s. */
const READ_SECONDS = 2;
const EDIT_SECONDS = 20;

export function BlendChoice({ rows, onChange, onBlend, onCancel }: { rows: BlendRow[]; onChange: (id: string, r: SceneReading) => void; onBlend: () => void; onCancel: () => void }) {
  const reading = rows.some((r) => !r.reading);
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!reading) go.current?.focus();
  }, [reading]);
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
  const s = EDIT_SECONDS + rows.length * READ_SECONDS;
  const time = s < 60 ? t("blendChoice.aboutSeconds", { n: Math.max(5, Math.round(s / 5) * 5) }) : t("blendChoice.aboutMinutes", { n: Math.round(s / 60) });

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="split-choice blend-choice" role="dialog" aria-modal="true" aria-labelledby="blend-choice-title">
        <span className="split-choice-close">
          <IconButton title={t("blendChoice.cancelEsc")} onClick={onCancel}>
            <X size={18} />
          </IconButton>
        </span>
        <h2 id="blend-choice-title">
          {t("blendChoice.title")} <span className="exp-tag">{t("blendChoice.experimental")}</span>
        </h2>
        <p className="split-choice-lead">
          {t("blendChoice.lead", { count: rows.length })}
        </p>
        <div className="blend-rows">
          {rows.map((row) => {
            const r = row.reading;
            return (
              <div key={row.id} className="blend-row">
                <div className="blend-row-head">
                  <span className="blend-row-name">{row.name}</span>
                  <span className={`blend-row-state ${row.failed ? "warn" : ""}`} title={row.failed}>
                    {!r ? (
                      <>
                        <Loader2 size={13} className="spin" /> {t("blendChoice.readingScene")}
                      </>
                    ) : row.failed ? (
                      t("blendChoice.readFailed")
                    ) : r.complete ? (
                      t("blendChoice.readByAi")
                    ) : (
                      t("blendChoice.partlyRead")
                    )}
                  </span>
                </div>
                <div className={`blend-fields ${r ? "" : "waiting"}`}>
                  <label>
                    <span>{t("blendChoice.ground")}</span>
                    <select className="select" value={r?.surface ?? ""} disabled={!r} onChange={(e) => r && onChange(row.id, { ...r, surface: e.target.value as SceneReading["surface"] })}>
                      {!r && <option value="" />}
                      {SURFACES.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("blendChoice.shadows")}</span>
                    <div className="seg">
                      {([false, true] as const).map((hard) => (
                        <button key={String(hard)} className={r && r.hard_shadows === hard ? "on" : ""} disabled={!r} onClick={() => r && onChange(row.id, { ...r, hard_shadows: hard })}>
                          {hard ? t("blendChoice.hardShadows") : t("blendChoice.softShadows")}
                        </button>
                      ))}
                    </div>
                  </label>
                  <label>
                    <span>{t("blendChoice.theyFall")}</span>
                    <select className="select" value={r?.shadows_fall ?? ""} disabled={!r} onChange={(e) => r && onChange(row.id, { ...r, shadows_fall: e.target.value as SceneReading["shadows_fall"] })}>
                      {!r && <option value="" />}
                      {FALLS.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {r && (
                  <details className="blend-prompt">
                    <summary>{t("blendChoice.whatAiIsAsked")}</summary>
                    <p>{blendEffects(row.name, r)}</p>
                  </details>
                )}
              </div>
            );
          })}
        </div>
        <div className="split-choice-foot">
          <span>
            {t("blendChoice.foot", { time })}
          </span>
          <span className="blend-buttons">
            <button className="btn ghost" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            <button ref={go} className="btn primary" onClick={onBlend} disabled={reading}>
              <Sun size={15} /> {t("blendChoice.blend")}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
