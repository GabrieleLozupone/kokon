import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, MAX_LORAS } from "../lib/logic";
import { native } from "../lib/native";
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
    if (!(await native.confirm(`Remove "${l.name}" from Kokon? Your own file stays where it is.`, "Remove LoRA"))) return;
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
        <BlurField label="Name" value={l.name} onSave={(name) => update(l.id, { name })} />
        <button className="icon-btn" onClick={remove} title="Remove" aria-label={`Remove ${l.name}`}>
          <Trash2 size={16} />
        </button>
      </div>
      {!l.available && (
        <span className="lora-warn">
          <CircleAlert size={13} /> Kokon's copy of this LoRA is missing. Remove it and load the file again.
        </span>
      )}
      {l.warning && (
        <span className="lora-warn">
          <CircleAlert size={13} /> {l.warning}
        </span>
      )}
      <label className="field-row">
        <span>Strength</span>
        <span className="lora-strength">
          <input type="range" min={0} max={2} step={0.05} value={weight} onChange={(e) => setStrength(Number(e.target.value))} aria-label="Strength" />
          <span className="muted">{Math.round(weight * 100)} %</span>
        </span>
      </label>
      <label className="field">
        <span>Trigger words (added in front of the prompt when the LoRA is on)</span>
        <BlurField label="Trigger words" placeholder="none" value={l.triggerWords} onSave={(triggerWords) => update(l.id, { triggerWords })} />
      </label>
      <div className="field-row">
        <span>On by default in new projects</span>
        <Switch on={l.onByDefault} label="On by default" onChange={(onByDefault) => update(l.id, { onByDefault })} />
      </div>
      <span className="muted lora-meta">
        {[...l.notes, `${formatBytes(l.size)} · from ${l.source}`].join(" ")}
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
      toastInfo(l.warning ? `Loaded "${l.name}", with a warning` : `Loaded "${l.name}"`);
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
          <strong>Your LoRA files (beta)</strong>
          <span className="muted">
            Load LoRAs made for Qwen-Image 2.1 (.safetensors). Kokon checks each file and keeps its own prepared copy; your file is not changed. Turn them on or off for each project with the
            LoRA button next to the prompt, up to {MAX_LORAS} at a time.
          </span>
        </div>
        <button className="btn primary" disabled={busy} onClick={add}>
          <Plus size={15} /> {busy ? "Checking…" : "Load a LoRA…"}
        </button>
      </div>
      <span className="muted">
        Beta: tested on Windows with an NVIDIA card. It should work the same on Mac and Linux, but it hasn't been tested there yet: please tell us how it goes on GitHub.
      </span>
      <span className="muted">
        Most LoRAs are trained on the full Qwen-Image 2.1 model, while Kokon runs the faster Turbo model. The popular ones we tested didn't improve on what Turbo does with a good prompt, so compare
        with the LoRA on and off. A LoRA makes each image about 20 % slower.
      </span>
      {loras.map((l) => (
        <LoraRow key={l.id} l={l} />
      ))}
    </>
  );
}
