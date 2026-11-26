import { Eye, FolderOpen, Loader2, Palette, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { lutLabel } from "../lib/logic";
import { native } from "../lib/native";
import { inBrowser } from "../lib/platform";
import { toastError } from "../lib/store";
import type { LutEntry } from "../lib/types";
import { Popover } from "./ui";
import { t } from "../lib/i18n";

/** Asks for a .cube file and adds it to Kokon's LUT list. */
async function openCubeFile(): Promise<LutEntry | null> {
  const path = await native.pickFile(["cube", "CUBE"], undefined, "LUT");
  if (!path) return null;
  try {
    return await api.importLut(path);
  } catch (e) {
    toastError(e);
    return null;
  }
}

function LutList({ current, onPick, close }: { current?: string; onPick: (lut: LutEntry) => void; close: () => void }) {
  const [items, setItems] = useState<LutEntry[] | null>(null);
  useEffect(() => {
    api.luts().then((r) => setItems(r.items), toastError);
  }, []);
  const pick = (e: LutEntry) => {
    close();
    onPick(e);
  };
  const own = items?.filter((e) => !e.builtin) ?? [];
  const presets = items?.filter((e) => e.builtin) ?? [];
  const row = (e: LutEntry) => (
    <button className="opt" onClick={() => pick(e)} title={!e.builtin && e.title && e.title !== e.name ? e.title : undefined}>
      <span className="check">{e.name === current ? <Palette size={15} /> : null}</span>
      <span className="lut-name">{lutLabel(e)}</span>
      {!e.builtin && <span className="sub">{e.kind === "3d" ? `${e.size}³` : "1D"}</span>}
    </button>
  );
  return (
    <div className="lut-list">
      {items === null && <Loader2 className="spin" size={16} style={{ margin: 10 }} />}
      {own.length > 0 && <span className="muted lut-list-title">{t("lut.yourLuts")}</span>}
      {own.map((e) => (
        <div key={e.name} className="lut-row">
          {row(e)}
          <button
            className="icon-btn sm"
            title={t("lut.removeFromList")}
            aria-label={t("lut.removeNamedFromList", { name: e.name })}
            onClick={() => api.removeLut(e.name).then(() => setItems((l) => l?.filter((x) => x.name !== e.name) ?? null), toastError)}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {presets.length > 0 && <span className="muted lut-list-title">{t("lut.kokonPresets")}</span>}
      {presets.map((e) => (
        <div key={e.name} className="lut-row">
          {row(e)}
        </div>
      ))}
      {!inBrowser && (
        <button
          className="opt"
          onClick={async () => {
            close();
            const e = await openCubeFile();
            if (e) onPick(e);
          }}
        >
          <span className="check">
            <FolderOpen size={15} />
          </span>
          <span>{t("lut.openCubeFile")}</span>
        </button>
      )}
    </div>
  );
}

/** "LUT" under the image: Kokon's presets, the LUTs opened before, or a .cube file.
 * `current` (the LUT being previewed) is shown as its label. */
export function LutButton({ current, onPick }: { current?: LutEntry; onPick: (lut: LutEntry) => void }) {
  return (
    <Popover
      placement="top-end"
      trigger={(open, toggle) => (
        <button
          className={`act ${open ? "active" : ""}`}
          title={current ? t("lut.chooseAnother") : t("lut.buttonTooltip")}
          aria-label="LUT"
          onClick={toggle}
        >
          <Palette size={16} />
          <span className={current ? "lut-current" : "act-label"}>{current ? lutLabel(current) : "LUT"}</span>
        </button>
      )}
    >
      {(close) => <LutList current={current?.name} onPick={onPick} close={close} />}
    </Popover>
  );
}

/** The LUT preview over the image: the LUT at full strength, its opacity = the intensity. */
export function LutOverlay({ src, opacity }: { src: string; opacity: number }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <>
      <img
        key={src}
        className="stage-img fill lut-overlay"
        src={src}
        alt=""
        draggable={false}
        style={{ opacity: loaded === src ? opacity : 0 }}
        onLoad={() => setLoaded(src)}
        onError={() => toastError(new Error(t("lut.previewFailed")))}
      />
      {loaded !== src && (
        <span className="lut-loading">
          <Loader2 className="spin" size={18} />
        </span>
      )}
    </>
  );
}

/** Replaces the actions while a LUT is previewed: which LUT, how strong, before/after, save. */
export function LutBar(props: {
  lut: LutEntry;
  intensity: number;
  saving: boolean;
  onPick: (lut: LutEntry) => void;
  onIntensity: (v: number) => void;
  onBefore: (on: boolean) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const pct = Math.round(props.intensity * 100);
  return (
    <div className="actions lut-bar">
      <LutButton current={props.lut} onPick={props.onPick} />
      <label className="lut-intensity" title={t("lut.intensity")}>
        <input type="range" min={0} max={100} value={pct} aria-label={t("lut.intensity")} onChange={(e) => props.onIntensity(Number(e.target.value) / 100)} />
        <span>{pct} %</span>
      </label>
      <button
        className="act"
        title={t("lut.beforeTooltip")}
        onPointerDown={() => props.onBefore(true)}
        onPointerUp={() => props.onBefore(false)}
        onPointerLeave={() => props.onBefore(false)}
      >
        <Eye size={16} />
        <span className="act-label">{t("lut.before")}</span>
      </button>
      <span className="sep" />
      <button className="act" title={t("lut.cancelEsc")} onClick={props.onCancel}>
        <X size={16} />
        <span className="act-label">{t("common.cancel")}</span>
      </button>
      <button className="btn primary" onClick={props.onSave} disabled={props.saving || pct === 0} title={t("lut.saveTooltip")}>
        {props.saving ? <Loader2 className="spin" size={14} /> : null}
        {t("common.save")}
      </button>
    </div>
  );
}
