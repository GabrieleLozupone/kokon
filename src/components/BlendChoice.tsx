// "Blend into scene" (LayerDoc): what the AI read about where each object stands, shown before the
// edit so the user can correct it (Gabriele 11-02: "un pop up con possibilità di correggerlo"). The
// reading picks the effects the prompt names (lib/blend.ts): a wrong "wet" draws a reflection on dry
// ground, a wrong "dry" leaves a puddle without one.

import { Loader2, Sun, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { blendEffects, FALLS, SURFACES } from "../lib/blend";
import type { SceneReading } from "../lib/types";
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
  const time = s < 60 ? `about ${Math.max(5, Math.round(s / 5) * 5)} s` : `about ${Math.round(s / 60)} min`;

  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="split-choice blend-choice" role="dialog" aria-modal="true" aria-labelledby="blend-choice-title">
        <span className="split-choice-close">
          <IconButton title="Cancel (Esc)" onClick={onCancel}>
            <X size={18} />
          </IconButton>
        </span>
        <h2 id="blend-choice-title">
          Blend into the scene <span className="exp-tag">Experimental</span>
        </h2>
        <p className="split-choice-lead">
          The AI looked at where {rows.length === 1 ? "the object stands" : "each object stands"}. It redraws the scene with what that place does: the contact shadow, the
          shadow, a reflection on wet or shiny ground. Check what it read and change anything that is wrong. It is
          experimental and often does not work yet: blending all the objects at once works best.
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
                        <Loader2 size={13} className="spin" /> Reading the scene…
                      </>
                    ) : row.failed ? (
                      "Could not read it: check these"
                    ) : r.complete ? (
                      "Read by the AI"
                    ) : (
                      "Partly read: check these"
                    )}
                  </span>
                </div>
                <div className={`blend-fields ${r ? "" : "waiting"}`}>
                  <label>
                    <span>Ground</span>
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
                    <span>Shadows</span>
                    <div className="seg">
                      {([false, true] as const).map((hard) => (
                        <button key={String(hard)} className={r && r.hard_shadows === hard ? "on" : ""} disabled={!r} onClick={() => r && onChange(row.id, { ...r, hard_shadows: hard })}>
                          {hard ? "Hard (sun)" : "Soft"}
                        </button>
                      ))}
                    </div>
                  </label>
                  <label>
                    <span>They fall</span>
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
                    <summary>What the AI is asked</summary>
                    <p>{blendEffects(row.name, r)}</p>
                  </details>
                )}
              </div>
            );
          })}
        </div>
        <div className="split-choice-foot">
          <span>
            {time} · the rest of the picture stays as it is · moved it later? Blend again
          </span>
          <span className="blend-buttons">
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
            <button ref={go} className="btn primary" onClick={onBlend} disabled={reading}>
              <Sun size={15} /> Blend
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
