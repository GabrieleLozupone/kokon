import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, MAX_LORAS } from "../lib/logic";
import { native } from "../lib/native";
import { t } from "../lib/i18n";
import { inBrowser } from "../lib/platform";
import { refreshLoras, toastError, toastInfo, useStore } from "../lib/store";
import type { LoraItem } from "../lib/types";
import { Switch } from "./ui";

type Patch = Parameters<typeof api.updateLora>[1];

async function update(id: string, patch: Patch) {
  try {
    await api.updateLora(id, patch);
  } catch (e) {
    toastError(e);
  }
  refreshLoras();
}

/** A text field saved when it loses focus (or on Enter). */
function BlurField(props: { value: string; placeholder?: string; label: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <input
      className="input"
      type="text"
      spellCheck={false}
      aria-label={props.label}
      placeholder={props.placeholder}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== props.value && props.onSave(v)}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

function LoraRow({ l }: { l: LoraItem }) {
  const [weight, setWeight] = useState(l.weight);
  useEffect(() => setWeight(l.weight), [l.weight]);
  const timer = useRef<number | undefined>(undefined);
  const setStrength = (w: number) => {
    setWeight(w);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => update(l.id, { weight: w }), 400);
  };
  const remove = async () => {
    if (!(await native.confirm(t("lora.removeConfirm", { name: l.name }), t("lora.removeTitle")))) return;
    try {
      await api.removeLora(l.id);
    } catch (e) {
      toastError(e);
    }
    refreshLoras();
  };
  return (
    <div className="lora-card">
      <div className="lora-head">
        <BlurField label={t("lora.name")} value={l.name} onSave={(name) => update(l.id, { name })} />
        <button className="icon-btn" onClick={remove} title={t("common.remove")} aria-label={t("lora.removeNamed", { name: l.name })}>
          <Trash2 size={16} />
        </button>
      </div>
      {!l.available && (
        <span className="lora-warn">
          <CircleAlert size={13} /> {t("lora.missingCopy")}
        </span>
      )}
      {l.warning && (
        <span className="lora-warn">
          <CircleAlert size={13} /> {l.warning}
        </span>
      )}
      <label className="field-row">
        <span>{t("lora.strength")}</span>
        <span className="lora-strength">
          <input type="range" min={0} max={2} step={0.05} value={weight} onChange={(e) => setStrength(Number(e.target.value))} aria-label={t("lora.strength")} />
          <span className="muted">{t("lora.strengthPercent", { percent: Math.round(weight * 100) })}</span>
        </span>
      </label>
      <label className="field">
        <span>{t("lora.triggerWordsHint")}</span>
        <BlurField label={t("lora.triggerWords")} placeholder={t("lora.triggerWordsNone")} value={l.triggerWords} onSave={(triggerWords) => update(l.id, { triggerWords })} />
      </label>
      <div className="field-row">
        <span>{t("lora.onByDefaultNewProjects")}</span>
        <Switch on={l.onByDefault} label={t("lora.onByDefault")} onChange={(onByDefault) => update(l.id, { onByDefault })} />
      </div>
      <span className="muted lora-meta">
        {[...l.notes, t("lora.sizeFrom", { size: formatBytes(l.size), source: l.source })].join(" ")}
      </span>
    </div>
  );
}

/** Settings → LoRA: the user's own LoRA files. */
export function LoraSettings() {
  const loras = useStore((s) => s.loras);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    refreshLoras();
  }, []);
  const add = async () => {
    const path = await native.pickFile(["safetensors"], undefined, "LoRA");
    if (!path) return;
    setBusy(true);
    try {
      const l = await api.addLora(path);
      toastInfo(l.warning ? t("lora.loadedWithWarning", { name: l.name }) : t("lora.loaded", { name: l.name }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      refreshLoras();
    }
  };
  return (
    <>
      <div className="setting-card">
        <div className="setting-card-text">
          <strong>{t("lora.title")}</strong>
          <span className="muted">{t("lora.intro", { max: MAX_LORAS })}</span>
        </div>
        {!inBrowser && (
          <button className="btn primary" disabled={busy} onClick={add}>
            <Plus size={15} /> {busy ? t("lora.checking") : t("lora.load")}
          </button>
        )}
      </div>
      <span className="muted">{t("lora.betaNote")}</span>
      <span className="muted">{t("lora.turboNote")}</span>
      {loras.map((l) => (
        <LoraRow key={l.id} l={l} />
      ))}
    </>
  );
}
