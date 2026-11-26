import { ArrowLeftRight, Check } from "lucide-react";
import { useState } from "react";
import { ASPECTS, LONG_SIDE_PRESETS, aspectLabel, parseRatio, planPipeline, sizeForLongSide, sizeForRatio } from "../lib/logic";
import { getState, updateComposer, useStore } from "../lib/store";
import type { Plan, ResolutionMode } from "../lib/types";
import { Option } from "./ui";
import { t } from "../lib/i18n";

/** A small rectangle with the ratio's shape. */
export function RatioIcon({ ratio, size = 16 }: { ratio: number; size?: number }) {
  const w = ratio >= 1 ? size : Math.max(4, size * ratio);
  const h = ratio >= 1 ? Math.max(4, size / ratio) : size;
  return (
    <span className="ratio-icon" style={{ width: size, height: size }} aria-hidden>
      <i style={{ width: w, height: h }} />
    </span>
  );
}

/** Two numbers typed by hand (a ratio such as 7:5, or a size such as 1920×1080). */
function PairFields(props: { a: number | ""; b: number | ""; sep: string; max: number; onA: (v: number | "") => void; onB: (v: number | "") => void; label: string; onEnter?: () => void; onFocus?: () => void }) {
  const num = (v: string): number | "" => (v === "" ? "" : Math.max(0, Math.min(props.max, Number(v) || 0)));
  const key = (e: React.KeyboardEvent) => e.key === "Enter" && props.onEnter?.();
  return (
    <span className="pair" aria-label={props.label}>
      <input className="input" type="number" min={1} max={props.max} value={props.a} onChange={(e) => props.onA(num(e.target.value))} onKeyDown={key} onFocus={props.onFocus} />
      <span className="muted">{props.sep}</span>
      <input className="input" type="number" min={1} max={props.max} value={props.b} onChange={(e) => props.onB(num(e.target.value))} onKeyDown={key} onFocus={props.onFocus} />
    </span>
  );
}

/** Grid of common ratios plus a ratio of your own. `value` is the current ratio ("16:9",
 * "7:5"), "auto" or null. */
export function AspectGrid(props: { value: string | null; onPick: (ratio: string) => void; auto?: { sub: string } }) {
  const custom = props.value && props.value !== "auto" && !(ASPECTS as readonly string[]).includes(props.value) ? props.value.split(/[:x×/]/) : null;
  const [a, setA] = useState<number | "">(custom ? Number(custom[0]) : "");
  const [b, setB] = useState<number | "">(custom ? Number(custom[1]) : "");
  const typed = a && b ? `${a}:${b}` : "";
  const ok = !!typed && parseRatio(typed) !== null;
  return (
    <div className="aspect-menu">
      {props.auto && (
        <button className={`aspect-auto ${props.value === "auto" ? "on" : ""}`} onClick={() => props.onPick("auto")}>
          <span>{t("common.auto")}</span>
          <span className="sub">{props.auto.sub}</span>
          {props.value === "auto" && <Check size={14} />}
        </button>
      )}
      <div className="aspect-grid">
        {ASPECTS.map((r) => (
          <button key={r} className={props.value === r ? "on" : ""} onClick={() => props.onPick(r)} title={r}>
            <RatioIcon ratio={parseRatio(r)!} />
            {r}
          </button>
        ))}
      </div>
      <div className="aspect-custom">
        <span className="muted">{t("sizeMenus.otherRatio")}</span>
        <PairFields a={a} b={b} sep=":" max={100} onA={setA} onB={setB} label={t("sizeMenus.customRatio")} onEnter={() => ok && props.onPick(typed)} />
        <button className="btn" disabled={!ok} onClick={() => props.onPick(typed)} title={typed && !ok ? t("sizeMenus.ratioRange") : undefined}>
          {t("sizeMenus.use")}
        </button>
      </div>
    </div>
  );
}

const resOptions = (): { value: ResolutionMode; label: string; sub: string }[] => [
  { value: "auto", label: t("common.auto"), sub: t("sizeMenus.autoSub") },
  { value: "1k", label: "1K", sub: "~1 MP" },
  { value: "1.5k", label: "1.5K", sub: "~2.4 MP" },
  { value: "2k", label: "2K", sub: t("sizeMenus.twoKSub") },
  { value: "source", label: t("sizeMenus.source"), sub: t("sizeMenus.sourceSub") },
];

export const resolutionLabel = (r: ResolutionMode, w: number, h: number) => (r === "custom" ? `${w}×${h}` : resOptions().find((o) => o.value === r)?.label ?? t("common.auto"));

/** Output size: a preset level or an exact width × height (whose ratio is then shown). */
export function ResolutionMenu({ plan, close }: { plan: Plan | null; close: () => void }) {
  const c = useStore((s) => s.composer);
  const editing = c.refs.length > 0;
  const [w, setW] = useState<number | "">(c.customWidth);
  const [h, setH] = useState<number | "">(c.customHeight);
  const valid = typeof w === "number" && typeof h === "number" && w >= 64 && h >= 64;
  const apply = (nw: number | "", nh: number | "") => {
    setW(nw);
    setH(nh);
    if (typeof nw === "number" && typeof nh === "number" && nw >= 64 && nh >= 64) updateComposer({ resolution: "custom", customWidth: nw, customHeight: nh });
  };
  // The size already in the fields is picked by clicking the row or a field: before, only a
  // changed value picked it, so a size left from an earlier image had to be retyped.
  const pick = () => valid && c.resolution !== "custom" && updateComposer({ resolution: "custom", customWidth: w as number, customHeight: h as number });
  // Screen presets keep the ratio already typed (16:9 when there is none).
  const ratio = valid ? (w as number) / (h as number) : 16 / 9;
  return (
    <div className="res-menu">
      {resOptions().filter((o) => o.value !== "source" || editing).map((o) => (
        <Option key={o.value} selected={c.resolution === o.value} label={o.label} sub={o.sub} onClick={() => (updateComposer({ resolution: o.value }), close())} />
      ))}
      <div className={`res-custom ${c.resolution === "custom" ? "on" : ""}`}>
        <button className="res-custom-head" onClick={pick}>
          <span className="check">{c.resolution === "custom" && <Check size={15} />}</span>
          {t("sizeMenus.exactSize")}
        </button>
        <span className="res-custom-row">
          <PairFields a={w} b={h} sep="×" max={4096} onA={(v) => apply(v, h)} onB={(v) => apply(w, v)} label={t("sizeMenus.widthHeight")} onEnter={close} onFocus={pick} />
          <button className="icon-btn sm" title={t("sizeMenus.swap")} onClick={() => apply(h, w)}>
            <ArrowLeftRight size={14} />
          </button>
          {valid && (
            <span className="ratio-tag">
              <RatioIcon ratio={(w as number) / (h as number)} size={14} />
              {aspectLabel(w as number, h as number)}
            </span>
          )}
        </span>
        <span className="res-custom-row size-presets">
          {LONG_SIDE_PRESETS.map((p) => {
            const s = sizeForLongSide(ratio, p.long);
            const on = c.resolution === "custom" && c.customWidth === s.width && c.customHeight === s.height;
            return (
              <button key={p.label} className={on ? "on" : ""} onClick={() => apply(s.width, s.height)} title={`${s.width}×${s.height}`}>
                {p.label}
              </button>
            );
          })}
        </span>
      </div>
      {plan && (
        <div className="res-foot muted">
          {t("sizeMenus.output", { width: plan.output.width, height: plan.output.height, ratio: aspectLabel(plan.output.width, plan.output.height), pipeline: planPipeline(plan) })}
        </div>
      )}
    </div>
  );
}

/** Picking a ratio while an exact size is set keeps about the same number of pixels; Auto
 * goes back to automatic size too. */
export function pickAspect(ratio: string) {
  const c = getState().composer;
  const r = parseRatio(ratio);
  if (c.resolution !== "custom") updateComposer({ aspect: ratio });
  else if (!r) updateComposer({ aspect: "auto", resolution: "auto" });
  else {
    const s = sizeForRatio(r, c.customWidth * c.customHeight);
    updateComposer({ aspect: ratio, customWidth: s.width, customHeight: s.height });
  }
}
