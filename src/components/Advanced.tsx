import { Dices, RotateCcw } from "lucide-react";
import { updateComposer, useStore } from "../lib/store";
import type { Advanced, OutputFormat, Plan, ReferenceDetail } from "../lib/types";
import { Seg, Switch } from "./ui";
import { UpscalerSettings } from "./Upscalers";

// Verified against sd-server 3f8527a capabilities; replaced by the live list when loaded.
// Steps, CFG and scheduler are fixed by the Turbo model's 8-step schedule (no CFG).
const FALLBACK_SAMPLERS = ["euler", "euler_a", "heun", "dpm2", "dpm++2s_a", "dpm++2m", "dpm++2mv2", "ipndm", "ipndm_v", "lcm", "ddim_trailing", "tcd", "res_multistep", "res_2s", "er_sde"];

function NumField(props: { label: string; value: number | null | undefined; placeholder: string; min: number; max: number; step?: number; onChange: (v: number | null) => void }) {
  return (
    <label className="field-row">
      <span>{props.label}</span>
      <input
        className="input"
        style={{ width: 110 }}
        type="number"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        placeholder={props.placeholder}
        value={props.value ?? ""}
        onChange={(e) => {
          const v = e.target.value === "" ? null : Number(e.target.value);
          props.onChange(v === null || Number.isNaN(v) ? null : Math.min(props.max, Math.max(props.min, v)));
        }}
      />
    </label>
  );
}

export function AdvancedPanel({ plan }: { plan: Plan | null }) {
  const c = useStore((s) => s.composer);
  const samplers = useStore((s) => (s.status?.server as { samplers?: string[] } | undefined)?.samplers);
  const a = c.advanced;
  const setA = (patch: Partial<Advanced>) => updateComposer({ advanced: { ...a, ...patch } });
  const editLike = plan && (plan.mode === "inpaint" || plan.mode === "outpaint" || plan.mode === "edit");

  return (
    <>
      <label className="field-row">
        <span>Seed</span>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            className="input"
            style={{ width: 120 }}
            type="number"
            placeholder="Random"
            value={c.seed ?? ""}
            onChange={(e) => updateComposer({ seed: e.target.value === "" ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
          />
          <button className="icon-btn sm" title="Random seed" onClick={() => updateComposer({ seed: null })}>
            <Dices size={15} />
          </button>
        </div>
      </label>

      <label className="field-row">
        <span>Sampler</span>
        <select className="select" value={a.sampler ?? ""} onChange={(e) => setA({ sampler: e.target.value || null })}>
          <option value="">Default ({plan?.sampler ?? "euler"})</option>
          {(samplers?.length ? samplers : FALLBACK_SAMPLERS).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      {editLike && (
        <label className="field">
          <span>
            Edit strength {a.strength != null ? a.strength.toFixed(2) : plan?.strength != null ? `(auto ${plan.strength})` : "(auto)"}
          </span>
          <input type="range" min={0.05} max={1} step={0.05} value={a.strength ?? plan?.strength ?? 1} onChange={(e) => setA({ strength: Number(e.target.value) })} />
        </label>
      )}

      {plan?.reference_detail && (
        <div className="field">
          <span title="The source images share the GPU budget with the image being drawn. 1 MP leaves more of it for the result, which renders larger and faster; Full gives the model finer source detail but halves the result's size. New chats start at 1 MP.">
            Reference detail
          </span>
          <Seg<ReferenceDetail>
            value={a.reference_detail ?? "standard"}
            options={[
              { value: "standard", label: "1 MP" },
              { value: "full", label: "Full" },
            ]}
            onChange={(v) => setA({ reference_detail: v === "standard" ? null : v })}
          />
        </div>
      )}

      <NumField label="Images per run" value={a.batch_count} placeholder="1" min={1} max={4} onChange={(v) => setA({ batch_count: v })} />

      <div className="field">
        <span>Format</span>
        <Seg<OutputFormat>
          value={a.output_format ?? "png"}
          options={[
            { value: "png", label: "PNG" },
            { value: "jpeg", label: "JPEG" },
            { value: "webp", label: "WebP" },
          ]}
          onChange={(v) => setA({ output_format: v })}
        />
      </div>

      {c.refs[0]?.hdr && (
        <div className="field-row">
          <span title="The HEIC source has an HDR gain map. The result is saved as an Ultra HDR JPEG; the HDR boost fades where the edit changed brightness.">
            Keep HDR (Ultra HDR JPEG)
          </span>
          <Switch on={a.hdr ?? true} onChange={(v) => setA({ hdr: v })} label="Keep HDR" />
        </div>
      )}

      <div className="field-row">
        <span>
          VAE tiling {a.vae_tiling == null ? `(auto: ${plan?.vae_tiling ? "on" : "off"})` : ""}
        </span>
        <Switch on={a.vae_tiling ?? plan?.vae_tiling ?? false} onChange={(v) => setA({ vae_tiling: v })} label="VAE tiling" />
      </div>

      <button className="btn" onClick={() => updateComposer({ advanced: {}, seed: null })}>
        <RotateCcw size={14} /> Reset to automatic
      </button>

      <hr className="menu-sep" />
      <UpscalerSettings />
    </>
  );
}
