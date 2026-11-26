import { Download, Images, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { formatBytes, installProgress } from "../lib/logic";
import { isMac } from "../lib/platform";
import { refreshStatus, setState, toastError, useStore } from "../lib/store";
import type { InstallStatus, UpscalerItem } from "../lib/types";
import { Seg } from "./ui";

const img = import.meta.glob("../assets/upscalers/*.png", { eager: true, import: "default" }) as Record<string, string>;
const crop = (scenario: string, method: string) => img[`../assets/upscalers/${scenario}-${method}.png`];

/** What each upscaler is good and bad at, from an A/B on 8 images at x1.4, x2 and x4, and the
 * time on an M2 Pro (2026-10-12): Macs default to Lanczos, ESRGAN models take minutes there. */
export function upscalerNotes(): Record<string, { key: string; label: string; text: string }> {
  return {
    "4x_NMKD-Superscale-SP_178000_G": {
      key: "superscale",
      label: "Superscale-SP",
      text: isMac ? t("upscalers.superscaleNoteMac") : t("upscalers.superscaleNote"),
    },
    "4xNomos2_hq_mosr": {
      key: "mosr",
      label: t("upscalers.mosrLabel"),
      text: isMac ? t("upscalers.mosrNoteMac") : t("upscalers.mosrNote"),
    },
    "4x-UltraSharp": {
      key: "ultrasharp",
      label: "UltraSharp",
      text: isMac ? t("upscalers.ultrasharpNoteMac") : t("upscalers.ultrasharpNote"),
    },
    lanczos: {
      key: "lanczos",
      label: "Lanczos",
      text: isMac ? t("upscalers.lanczosNoteMac") : t("upscalers.lanczosNote"),
    },
  };
}

const scenarios = () => [
  { key: "face", label: t("upscalers.scenarioFace"), hint: t("upscalers.scenarioFaceHint") },
  { key: "jpeg", label: t("upscalers.scenarioJpeg"), hint: t("upscalers.scenarioJpegHint") },
  { key: "night", label: t("upscalers.scenarioNight"), hint: t("upscalers.scenarioNightHint") },
  { key: "text", label: t("upscalers.scenarioText"), hint: t("upscalers.scenarioTextHint") },
  { key: "landscape", label: t("upscalers.scenarioLandscape"), hint: t("upscalers.scenarioLandscapeHint") },
  { key: "x4", label: t("upscalers.scenarioX4"), hint: t("upscalers.scenarioX4Hint") },
];
const METHODS = ["4x_NMKD-Superscale-SP_178000_G", "4xNomos2_hq_mosr", "4x-UltraSharp", "lanczos"];

/** Side-by-side crops of each upscaler in a few typical cases, with what each one is good at. */
export function UpscalerCompare() {
  const SCENARIOS = scenarios();
  const UPSCALER_NOTES = upscalerNotes();
  const [scenario, setScenario] = useState(SCENARIOS[0].key);
  const close = () => setState({ compareUpscalers: false });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const s = SCENARIOS.find((x) => x.key === scenario)!;
  return (
    <div className="modal-scrim" style={{ zIndex: 60 }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="upscaler-compare" role="dialog" aria-label={t("upscalers.compareTitle")}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h3 style={{ flex: 1, margin: 0 }}>{t("upscalers.compareTitle")}</h3>
          <button className="icon-btn" title={t("common.close")} onClick={close}>
            <X size={18} />
          </button>
        </div>
        <span className="muted">{t("upscalers.compareIntro")}</span>
        <Seg<string> value={scenario} options={SCENARIOS.map((x) => ({ value: x.key, label: x.label }))} onChange={setScenario} />
        <span className="muted">{s.hint}</span>
        <div className="upscaler-grid">
          {METHODS.map((m) => (
            <figure key={m}>
              <img src={crop(scenario, UPSCALER_NOTES[m].key)} alt={t("upscalers.cropAlt", { method: UPSCALER_NOTES[m].label, scenario: s.label })} />
              <figcaption>
                <strong>{UPSCALER_NOTES[m].label}</strong>
                <span>{UPSCALER_NOTES[m].text}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Upscaler model, its download, and the strength slider. Controlled: Settings binds it to its
 * draft, the Advanced menu to the saved settings. */
export function UpscalerControls(props: { model: string; blend: number; onModel: (m: string) => void; onBlend: (b: number) => void; onBlendDone?: () => void }) {
  const [items, setItems] = useState<UpscalerItem[] | null>(null);
  const [inst, setInst] = useState<InstallStatus | null>(null);
  const load = () => api.upscalers().then((r) => setItems(r.items), () => {});
  useEffect(() => {
    load();
    api.installStatus().then((i) => i.running && i.preset?.startsWith("upscaler:") && setInst(i), () => {});
  }, []);
  const running = !!inst?.running;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(
      () =>
        api.installStatus().then((i) => {
          setInst(i);
          if (!i.running) {
            load();
            refreshStatus();
            const failed = i.items.find((x) => x.state === "failed");
            if (failed) toastError(new Error(t("upscalers.downloadFailedNamed", { name: failed.label, error: failed.error ?? t("upscalers.downloadFailed") })));
          }
        }, () => {}),
      500,
    );
    return () => window.clearInterval(timer);
  }, [running]);

  const sel = items?.find((i) => i.name === props.model);
  const downloading = running && inst?.preset === `upscaler:${props.model}`;
  const download = async () => {
    try {
      setInst(await api.downloadUpscaler(props.model));
    } catch (e) {
      toastError(e);
    }
  };
  const note = upscalerNotes()[props.model];
  return (
    <>
      <label className="field-row">
        <span>{t("upscalers.upscaler")}</span>
        <select className="select" value={props.model} onChange={(e) => props.onModel(e.target.value)}>
          {(items ?? []).map((i) => (
            <option key={i.name} value={i.name}>
              {i.installed ? i.label : t("upscalers.optionDownload", { name: i.label, size: formatBytes(i.size ?? 0) })}
            </option>
          ))}
          {items && !items.some((i) => i.name === props.model) && <option value={props.model}>{props.model}</option>}
        </select>
      </label>
      {note && <span className="muted" style={{ marginTop: -8 }}>{note.text}</span>}
      {sel && !sel.installed && (
        <div className="field-row">
          <span className="muted">{downloading ? t("upscalers.downloading", { percent: Math.floor(installProgress(inst!.items).frac * 100) }) : t("upscalers.notInstalled")}</span>
          <button className="btn" disabled={running} onClick={download}>
            {downloading ? <Loader2 className="spin" size={14} /> : <Download size={14} />} {formatBytes(sel.size ?? 0)}
          </button>
        </div>
      )}
      {props.model !== "lanczos" && (
        <label className="field">
          <span>{t("upscalers.strength", { percent: Math.round(props.blend * 100) })}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={props.blend}
            onChange={(e) => props.onBlend(Number(e.target.value))}
            onPointerUp={props.onBlendDone}
            onKeyUp={props.onBlendDone}
          />
        </label>
      )}
      {props.model !== "lanczos" && (
        <span className="muted" style={{ marginTop: -8 }}>
          {t("upscalers.strengthHint")}
        </span>
      )}
      <div className="setting-card">
        <div className="setting-card-text">
          <strong>{t("upscalers.notSure")}</strong>
          <span className="muted">{t("upscalers.notSureHint")}</span>
        </div>
        <button className="btn" onClick={() => setState({ compareUpscalers: true })}>
          <Images size={15} /> {t("upscalers.compare")}
        </button>
      </div>
    </>
  );
}

/** [`UpscalerControls`] bound to the saved settings (the Advanced menu: no Save button). */
export function UpscalerSettings() {
  const [model, setModel] = useState<string | null>(null);
  const [blend, setBlend] = useState(1);
  useEffect(() => {
    api.config().then((c) => {
      setModel(c.upscalerModel);
      setBlend(c.upscaleBlend);
    }, toastError);
  }, []);
  const save = async (patch: { upscalerModel?: string; upscaleBlend?: number }) => {
    try {
      const c = await api.config();
      await api.saveConfig({ ...c, ...patch });
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };
  const upscaling = useStore((s) => s.status?.upscaler?.model);
  if (model === null) return null;
  return (
    <div className="field" style={{ gap: 10 }}>
      <span className="muted" style={{ fontSize: 12 }}>
        {upscaling && upscaling !== model
          ? t("upscalers.enlargingAllNowUsing", { name: upscalerNotes()[upscaling]?.label ?? upscaling })
          : t("upscalers.enlargingAll")}
      </span>
      <UpscalerControls
        model={model}
        blend={blend}
        onModel={(m) => {
          setModel(m);
          save({ upscalerModel: m });
        }}
        onBlend={setBlend}
        onBlendDone={() => save({ upscaleBlend: blend })}
      />
    </div>
  );
}
