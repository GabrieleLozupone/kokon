import { Activity, Copy, Cpu, Download, FolderOpen, HardDrive, Layers, RefreshCw, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { getState, openModelSetup, refreshStatus, setState, startTour, toastError, toastInfo, useStore } from "../lib/store";
import { formatBytes } from "../lib/logic";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../lib/theme";
import { LoraSettings } from "./LoraSettings";
import { UpscalerControls } from "./Upscalers";
import { WHATS_NEW_VERSION } from "./WhatsNew";
import type { AppConfig, Check, ModelProfile, ModelsStatus, SetupReport, TextEncoderPlacement } from "../lib/types";
import { IconButton, Seg, Switch } from "./ui";
import { autoCheckEnabled, checkForUpdate } from "../lib/updates";

const REPO_URL = "https://github.com/GabrieleLozupone/kokon";

type Tab = "general" | "models" | "lora" | "performance" | "diagnostics";
const TABS: Tab[] = ["general", "models", "lora", "performance", "diagnostics"];

function PathField(props: { label: string; value: string; onChange: (v: string) => void; folder?: boolean; extensions?: string[]; open?: boolean }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <div className="path-row">
        <input className="input" type="text" value={props.value} onChange={(e) => props.onChange(e.target.value)} spellCheck={false} />
        <button
          className="btn"
          onClick={async () => {
            const p = props.folder ? await native.pickFolder(props.value) : await native.pickFile(props.extensions ?? ["gguf", "safetensors"], props.value);
            if (p) props.onChange(p);
          }}
        >
          Browse
        </button>
        {props.open && (
          <button className="btn" title="Open this folder" onClick={() => native.openFolder(props.value).catch(toastError)}>
            <FolderOpen size={14} /> Open
          </button>
        )}
      </div>
    </label>
  );
}

/** One of the prompt enhancer's instructions: the user's text, or the built-in one ("" saved). */
function EnhancerPrompt(props: { label: string; help: string; value: string; builtin: string | null; max: number; onChange: (v: string) => void }) {
  const custom = props.value.trim() !== "" && props.value.trim() !== props.builtin?.trim();
  return (
    <div className="field">
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ flex: 1 }}>
          {props.label} <span className="muted">· {custom ? "your instructions" : "built-in"}</span>
        </span>
        <button className="btn" disabled={!custom} onClick={() => props.onChange("")} title="Go back to Kokon's built-in instructions">
          <RotateCcw size={13} /> Restore default
        </button>
      </div>
      <textarea
        className="input"
        rows={9}
        spellCheck={false}
        maxLength={props.max}
        value={props.value || props.builtin || ""}
        placeholder={props.builtin === null ? "Loading…" : ""}
        onChange={(e) => props.onChange(e.target.value.trim() === props.builtin?.trim() ? "" : e.target.value)}
      />
      <span className="muted">{props.help}</span>
    </div>
  );
}

function Diagnostics() {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setText(null);
    try {
      setText((await api.diagnostics()).text);
    } catch (e) {
      toastError(e);
      setText("");
    }
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" disabled={!text} onClick={async () => (await writeText(text ?? ""), toastInfo("Diagnostics copied"))}>
          <Copy size={14} /> Copy
        </button>
        <button className="btn" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.restartBackend();
              toastInfo("Inference server restarted");
              load();
            } catch (e) {
              toastError(e);
            } finally {
              setBusy(false);
              refreshStatus();
            }
          }}
        >
          <RotateCcw size={14} /> {busy ? "Restarting…" : "Restart server"}
        </button>
        <button className="btn" onClick={async () => native.openFolder(await native.dataFolder().then((d) => `${d}${d.includes("\\") ? "\\" : "/"}logs`)).catch(toastError)}>
          <FolderOpen size={14} /> Logs
        </button>
      </div>
      <pre className="diag">{text ?? "Collecting…"}</pre>
    </>
  );
}

export function Settings() {
  // Opened on a tab by `openSettings` (e.g. the LoRA badge), else General.
  const [tab, setTab] = useState<Tab>(() => {
    const t = getState().settingsTab as Tab | null;
    return t && TABS.includes(t) ? t : "general";
  });
  useEffect(() => setState({ settingsTab: null }), []);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  const [devices, setDevices] = useState<[string, string][]>([]);
  const [upscaler, setUpscaler] = useState<Check | null>(null);
  // The saved model setup: what is missing, whether the official files are downloaded.
  const [ms, setMs] = useState<ModelsStatus | null>(null);
  const [legacy, setLegacy] = useState<{ files: string[]; bytes: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [theme, setTheme] = useState(themeChoice);
  const [enhancerDefaults, setEnhancerDefaults] = useState<{ t2i: string; edit: string; max_chars: number } | null>(null);
  const textGeneration = useStore((s) => s.status?.server.text_generation);

  useEffect(() => {
    api.config().then(setCfg, toastError);
    api.enhancerDefaults().then(setEnhancerDefaults, () => {});
    api.setup().then(
      (r: SetupReport) => {
        setDevices(r.devices);
        setUpscaler(r.checks.find((c) => c.id === "upscaler") ?? null);
      },
      () => {},
    );
    api.models().then(setMs, () => {});
  }, []);
  // Upscaler files not in use, keeping the model chosen here even before Save.
  const draftModel = cfg?.upscalerModel;
  useEffect(() => {
    if (draftModel !== undefined) api.legacyUpscalers(draftModel).then(setLegacy, () => {});
  }, [draftModel]);

  const removeLegacy = async () => {
    if (!cfg || !legacy || !window.confirm(`Delete the upscaler files not in use (${formatBytes(legacy.bytes)})?\n\n${legacy.files.join("\n")}`)) return;
    try {
      const r = await api.removeLegacyUpscalers(cfg.upscalerModel);
      toastInfo(`Deleted (${formatBytes(r.freed_bytes)} freed)`);
      api.legacyUpscalers(cfg.upscalerModel).then(setLegacy, () => {});
    } catch (e) {
      toastError(e);
    }
  };

  // Switching to the new VAE (#21): download, then the service swaps it and deletes the old one.
  const [vaeProgress, setVaeProgress] = useState<number | null>(null);
  const improveVae = async () => {
    try {
      let st = await api.improveVae();
      setVaeProgress(0);
      while (st.running) {
        await new Promise((r) => window.setTimeout(r, 700));
        st = await api.installStatus();
        const total = st.items.reduce((a, i) => a + i.size, 0);
        setVaeProgress(total ? st.items.reduce((a, i) => a + i.received, 0) / total : 0);
      }
      const failed = st.items.find((i) => i.state === "failed");
      if (failed) toastError(new Error(`${failed.label}: ${failed.error}`));
      else if (st.complete) toastInfo("The new decoder is in use");
      api.models().then(setMs, () => {});
      api.config().then(setCfg, () => {});
    } catch (e) {
      toastError(e);
    } finally {
      setVaeProgress(null);
    }
  };

  const close = () => setState({ overlay: null });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!cfg) return null;
  const profile = cfg.profiles.find((p) => p.id === cfg.activeProfile) ?? cfg.profiles[0];
  // Apple Silicon (Metal) has unified memory: no VRAM, device picker or CUDA-only options.
  const mac = cfg.gpuBackend === "metal";
  const appVersion = getState().status?.service.version ?? "";
  const set = (patch: Partial<AppConfig>) => {
    setCfg({ ...cfg, ...patch });
    setDirty(true);
  };
  const setProfile = (patch: Partial<ModelProfile>) => set({ profiles: cfg.profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)) });
  // Upscaler options apply at once, like in the Advanced menu: saved on top of the stored
  // settings (other unsaved fields stay a draft) and mirrored in the draft, so Save keeps them.
  const applyNow = async (patch: Partial<AppConfig>) => {
    setCfg((c) => (c ? { ...c, ...patch } : c));
    try {
      const saved = await api.config();
      await api.saveConfig({ ...saved, ...patch });
      api.setup().then((s: SetupReport) => setUpscaler(s.checks.find((c) => c.id === "upscaler") ?? null), () => {});
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };

  const save = async () => {
    try {
      const r = await api.saveConfig(cfg);
      setDirty(false);
      api.setup().then((s: SetupReport) => setUpscaler(s.checks.find((c) => c.id === "upscaler") ?? null), () => {});
      toastInfo(r.backend_restart_needed ? "Saved. The model reloads with the new settings on the next generation." : "Saved");
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };

  const nav: [Tab, string, React.ReactNode][] = [
    ["general", "General", <Settings2 size={16} key="g" />],
    ["models", "Models", <HardDrive size={16} key="m" />],
    ["lora", "LoRA (beta)", <Layers size={16} key="l" />],
    ["performance", "Performance", <Cpu size={16} key="p" />],
    ["diagnostics", "Diagnostics", <Activity size={16} key="d" />],
  ];

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label="Settings">
        <div className="modal-nav">
          {nav.map(([t, label, icon]) => (
            <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {icon} {label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {tab !== "diagnostics" && tab !== "lora" && (
            <button className="btn primary" style={{ justifyContent: "center" }} disabled={!dirty} onClick={save}>
              Save
            </button>
          )}
        </div>
        <div className="modal-body">
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3 style={{ flex: 1 }}>{nav.find((n) => n[0] === tab)?.[1]}</h3>
            <IconButton title="Close" onClick={close}>
              <X size={18} />
            </IconButton>
          </div>

          {tab === "general" && (
            <>
              <PathField label="Save images to" value={cfg.outputDir} folder open onChange={(v) => set({ outputDir: v })} />
              <div className="field">
                <span>Appearance</span>
                <Seg<ThemeChoice>
                  value={theme}
                  options={[
                    { value: "system", label: "System" },
                    { value: "light", label: "Light" },
                    { value: "dark", label: "Dark" },
                  ]}
                  onChange={(v) => (setThemeChoice(v), setTheme(v))}
                />
                <span className="muted">System follows your computer's light or dark mode. Applies at once.</span>
              </div>
              <div className="field-row">
                <span>Keep inference server running after closing the app</span>
                <Switch on={cfg.keepServerRunning} onChange={(v) => set({ keepServerRunning: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>Keeps the model loaded so the next start is instant.</span>
              <label className="field-row">
                <span>Unload the model after idle minutes (app closed)</span>
                <input className="input" type="number" min={0} max={1440} style={{ width: 90 }} value={cfg.idleUnloadMinutes} onChange={(e) => set({ idleUnloadMinutes: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
              <span className="muted" style={{ marginTop: -10 }}>Applies to MCP and API use without the desktop window. 0 keeps it loaded.</span>
              <div className="field-row">
                <span>Check for updates once a day</span>
                <Switch on={autoCheckEnabled(cfg.ui)} onChange={(v) => set({ ui: { ...cfg.ui, updateCheck: v } })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>
                Only asks GitHub for the latest version number; nothing about you or your images is sent. Updates install when you click them.
              </span>
              <div className="field-row">
                <span>You have Kokon {appVersion}</span>
                <button className="btn" onClick={() => checkForUpdate(true)}>
                  Check now
                </button>
              </div>
              <div className="field-row">
                <span>What's new in Kokon {WHATS_NEW_VERSION}</span>
                <button className="btn" onClick={() => setState({ overlay: "whats-new" })}>
                  Show
                </button>
              </div>
              <div className="field-row">
                <span>Welcome screen: what Kokon is and how it keeps your work private</span>
                <button className="btn" onClick={() => setState({ overlay: "welcome" })}>
                  Show
                </button>
              </div>
              <div className="field-row">
                <span>Tour: a short walk through an example project (adds the examples again if you removed them)</span>
                <button className="btn" onClick={startTour}>
                  Start
                </button>
              </div>
              <div className="field-row">
                <span>Kokon is open source: code, issues and discussions are on GitHub</span>
                <button className="btn" onClick={() => native.openLink(REPO_URL).catch(toastError)}>
                  Open GitHub
                </button>
              </div>

              <h4 style={{ margin: "14px 0 0", fontSize: 14, fontWeight: 600 }}>Prompt enhancer</h4>
              <span className="muted" style={{ marginTop: -8 }}>
                With Enhance on (next to the prompt), the model's own language model rewrites your prompt before making the image, following these instructions. It
                always writes in English.
                {textGeneration === false && " The inference engine in use cannot write prompts: Enhance appears with an engine that can."}
              </span>
              <div className="setting-card" style={{ alignItems: "flex-start" }}>
                <span className="muted">
                  Kokon was tested only with its built-in instructions. Your own can make results worse, or make the model answer with something that is not a prompt; Restore
                  default brings the built-in ones back.
                </span>
              </div>
              <EnhancerPrompt
                label="New images"
                help="Used when creating an image from the prompt alone."
                value={cfg.enhancerT2iPrompt ?? ""}
                builtin={enhancerDefaults?.t2i ?? null}
                max={enhancerDefaults?.max_chars ?? 20000}
                onChange={(v) => set({ enhancerT2iPrompt: v })}
              />
              <EnhancerPrompt
                label="Edits"
                help="Used when editing or combining images; the model sees the images."
                value={cfg.enhancerEditPrompt ?? ""}
                builtin={enhancerDefaults?.edit ?? null}
                max={enhancerDefaults?.max_chars ?? 20000}
                onChange={(v) => set({ enhancerEditPrompt: v })}
              />
            </>
          )}

          {tab === "models" && (
            <>
              <div className="setting-card">
                <div className="setting-card-text">
                  <strong>Model setup</strong>
                  <span className="muted">Downloads the official Qwen-Image 2.1 weights for your graphics card, uses model files you already have, or switches between the 12, 16, 24 and 32 GB presets.</span>
                </div>
                <button
                  className="btn primary"
                  onClick={() => {
                    if (dirty && !window.confirm("Discard the unsaved changes and open the model setup?")) return;
                    setState({ overlay: null, needsSetup: true });
                  }}
                >
                  <Download size={15} /> Set up models…
                </button>
              </div>
              <PathField label="stable-diffusion.cpp folder" value={cfg.sdcppDir} folder onChange={(v) => set({ sdcppDir: v })} />
              {cfg.profiles.length > 1 ? (
                <label className="field-row">
                  <span>Model</span>
                  <select className="select" value={profile.id} onChange={(e) => set({ activeProfile: e.target.value })}>
                    {cfg.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="muted">Model: {profile.displayName}</span>
              )}
              {profile.source === "official" ? (
                // The official files follow the install folder and preset; own files get their own profile.
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>Official model</strong>
                    <span className="muted">
                      {ms === null
                        ? "Qwen-Image 2.1 Turbo, tested with Kokon."
                        : ms.official_installed
                          ? "Qwen-Image 2.1 Turbo, tested with Kokon. Downloaded."
                          : "Qwen-Image 2.1 Turbo, tested with Kokon. Not downloaded into this folder yet: Download… gets it, or use model files you already have."}
                    </span>
                    <details className="model-files">
                      <summary>Files</summary>
                      {[profile.diffusionModel, profile.vae, profile.textEncoder, profile.visionProjector].filter(Boolean).map((p) => (
                        <span key={p}>{p}</span>
                      ))}
                    </details>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {ms && !ms.official_installed && (
                      <button
                        className="btn primary"
                        onClick={() => {
                          if (dirty && !window.confirm("Discard the unsaved changes and open the model setup?")) return;
                          openModelSetup("official");
                        }}
                      >
                        <Download size={15} /> Download…
                      </button>
                    )}
                    <button
                      className="btn"
                      onClick={() => {
                        if (dirty && !window.confirm("Discard the unsaved changes and choose your own model files?")) return;
                        openModelSetup("own");
                      }}
                    >
                      <FolderOpen size={15} /> Use my own files…
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="muted">Your own files: not tested by Kokon. Set up models… checks them and finds them again if they move.</span>
                  <PathField label="Diffusion model" value={profile.diffusionModel} onChange={(v) => setProfile({ diffusionModel: v })} />
                  <PathField label="VAE" value={profile.vae} onChange={(v) => setProfile({ vae: v })} />
                  <PathField label="Text encoder (Qwen3-VL)" value={profile.textEncoder} onChange={(v) => setProfile({ textEncoder: v })} />
                  <PathField label="Vision projector (mmproj)" value={profile.visionProjector ?? ""} onChange={(v) => setProfile({ visionProjector: v || null })} />
                </>
              )}
              {ms && (
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>Image decoder (VAE)</strong>
                    <span className="muted">
                      {ms.vae.improved
                        ? "The new decoder: no fine grid pattern on skin, hair and smooth areas."
                        : "A new decoder removes the fine grid pattern on skin, hair and smooth areas, with the same speed and colours. Switching downloads it and deletes the old one from Kokon's folder" +
                          (profile.source === "official" ? "." : "; your own VAE file stays where it is.")}
                    </span>
                    {vaeProgress !== null && (
                      <div className="progress" style={{ marginTop: 6 }}>
                        <i style={{ width: `${vaeProgress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  {!ms.vae.improved && (
                    <button className="btn primary" disabled={vaeProgress !== null || dirty} title={dirty ? "Save or discard your changes first" : undefined} onClick={improveVae}>
                      <Download size={15} /> {vaeProgress !== null ? `${Math.floor(vaeProgress * 100)}%` : `Switch${ms.vae.download_bytes ? ` · ${formatBytes(ms.vae.download_bytes)}` : ""}`}
                    </button>
                  )}
                </div>
              )}
              <UpscalerControls
                model={cfg.upscalerModel}
                blend={cfg.upscaleBlend}
                onModel={(m) => applyNow({ upscalerModel: m })}
                onBlend={(b) => setCfg({ ...cfg, upscaleBlend: b })}
                onBlendDone={() => applyNow({ upscaleBlend: cfg.upscaleBlend })}
              />
              {upscaler && !upscaler.ok && <span className="muted">{upscaler.detail}</span>}
              <div className="field-row">
                <span>Shrink the image before upscaling</span>
                <Switch on={cfg.upscalePrescale} onChange={(v) => applyNow({ upscalePrescale: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>
                Gives the upscaler a smaller image, like the ones it was trained on: fewer invented patterns on clean renders and faster, slightly less fine detail. Only for enlargements under 2.8×.
              </span>
              {legacy && legacy.files.length > 0 && (
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>Upscaler files not in use</strong>
                    <span className="muted">{legacy.files.map((f) => f.split(/[\\/]/).pop()).join(", ")}: not the selected model. Only Kokon's own folder is checked.</span>
                  </div>
                  <button className="btn" onClick={removeLegacy}>
                    <Trash2 size={15} /> Delete ({formatBytes(legacy.bytes)})
                  </button>
                </div>
              )}
            </>
          )}

          {tab === "performance" && mac && (
            <>
              <div className="field">
                <span>Engine</span>
                <span>Metal (Apple Silicon GPU, beta)</span>
              </div>
              <div className="field">
                <span>Model memory</span>
                <Seg<TextEncoderPlacement>
                  value={cfg.textEncoderPlacement === "disk" ? "disk" : "gpu"}
                  options={[
                    { value: "gpu", label: "Keep loaded" },
                    { value: "disk", label: "Load when needed" },
                  ]}
                  onChange={(v) => set({ textEncoderPlacement: v })}
                />
                <span className="muted">
                  Keep loaded: every model stays in memory, fastest between steps; needs 24 GB or more. Load when needed: each model (text encoder, image model, decoder) is loaded from the SSD when it runs and released after, so the image model has room to work on 16 GB Macs. It adds a few seconds per image. macOS cannot swap memory the GPU is using, so this is what makes 16 GB work.
                </span>
              </div>
              <label className="field-row">
                <span>Memory kept free for macOS (GiB)</span>
                <input className="input" type="number" min={0} max={16} step={0.5} style={{ width: 90 }} value={cfg.vramReserveGib} onChange={(e) => set({ vramReserveGib: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            </>
          )}

          {tab === "performance" && !mac && (
            <>
              <div className="field">
                <span>Engine</span>
                <span>{cfg.gpuBackend === "vulkan" ? "Vulkan" : "CUDA (NVIDIA)"}</span>
                <span className="muted">To switch engine, use Models → Set up models…: it downloads the other engine if needed. Both can stay installed.</span>
              </div>
              <label className="field-row">
                <span>GPU device</span>
                <select className="select" value={cfg.device} onChange={(e) => set({ device: e.target.value })}>
                  {(devices.length ? devices : [[cfg.device, ""] as [string, string]]).map(([n, d]) => (
                    <option key={n} value={n.toLowerCase()}>
                      {n}
                      {d ? ` — ${d}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span>Text encoder weights</span>
                <Seg<TextEncoderPlacement>
                  value={cfg.textEncoderPlacement}
                  options={[
                    { value: "ram", label: "RAM" },
                    { value: "gpu", label: "GPU" },
                    { value: "cpu", label: "CPU" },
                    { value: "auto", label: "Auto" },
                  ]}
                  onChange={(v) => set({ textEncoderPlacement: v })}
                />
                <span className="muted">
                  RAM (recommended): weights in system memory, computed on the GPU. CPU uses the least VRAM but makes image editing several times slower.
                </span>
              </div>
              <label className="field-row">
                <span>VRAM reserve (GiB)</span>
                <input className="input" type="number" min={0} max={16} step={0.5} style={{ width: 90 }} value={cfg.vramReserveGib} onChange={(e) => set({ vramReserveGib: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            </>
          )}

          {tab === "performance" && (
            <>
              <div className="field-row">
                <span>Flash attention</span>
                <Switch on={cfg.flashAttention} onChange={(v) => set({ flashAttention: v })} />
              </div>
              {cfg.gpuBackend === "cuda" && (
                <>
                  <div className="field-row">
                    <span>SageAttention (faster sampling)</span>
                    <Switch on={cfg.sageAttention && !cfg.sageUnsupported} disabled={cfg.sageUnsupported} onChange={(v) => set({ sageAttention: v })} />
                  </div>
                  {cfg.sageUnsupported && <span className="muted" style={{ marginTop: -10 }}>Needs an RTX 30 series or newer card; off on this one.</span>}
                </>
              )}
              <label className="field-row">
                <span>VAE tile size (px, 0 = off)</span>
                <input className="input" type="number" min={0} max={2048} step={128} style={{ width: 90 }} value={cfg.vaeTileSize} onChange={(e) => set({ vaeTileSize: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              <div className="field">
                <span>Edit prefix cache</span>
                <Seg<string>
                  value={cfg.prefixCacheType}
                  options={[
                    { value: "q8_0", label: "8-bit" },
                    { value: "f16", label: "FP16" },
                    { value: "auto", label: "Auto" },
                    { value: "off", label: "Off" },
                  ]}
                  onChange={(v) => set({ prefixCacheType: v })}
                />
                <span className="muted">
                  Reuses the reference image and prompt across steps so each step only computes the new image. 8-bit (recommended) uses the least memory; FP16 is more exact but needs twice the memory{cfg.gpuBackend === "cuda" ? "; Auto uses FP32 when SageAttention is on and usually does not fit" : ""}.
                </span>
              </div>
              {cfg.textEncoderPlacement !== "disk" && (
                <div className="field-row">
                  <span>Load all weights at startup</span>
                  <Switch on={cfg.eagerLoad} onChange={(v) => set({ eagerLoad: v })} />
                </div>
              )}
              <label className="field-row">
                <span>Upscaler tile size (px, 0 = automatic)</span>
                <input className="input" type="number" min={0} max={1024} step={64} style={{ width: 90 }} value={cfg.upscaleTileSize} onChange={(e) => set({ upscaleTileSize: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              <span className="muted" style={{ marginTop: -10 }}>Automatic: 768 px with 16 GB of GPU memory or more (fastest), 256 px below (about 1 GB less).</span>
              {!mac && (
                <>
                  <label className="field-row">
                    <span>Simulated VRAM for testing (MiB, 0 = detect)</span>
                    <input className="input" type="number" min={0} max={196608} step={1024} style={{ width: 100 }} value={cfg.vramOverrideMib} onChange={(e) => set({ vramOverrideMib: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </label>
                  <span className="muted" style={{ marginTop: -10 }}>
                    Plans image sizes as if the card had this much memory (e.g. 12288 to test a 12 GB card). Combine with the VRAM ballast script in scripts/dev so the memory is really unavailable.
                  </span>
                </>
              )}
              <label className="field-row">
                <span>Inference server port</span>
                <input className="input" type="number" min={1024} max={65535} style={{ width: 100 }} value={cfg.serverPort} onChange={(e) => set({ serverPort: Number(e.target.value) || cfg.serverPort })} />
              </label>
              <label className="field">
                <span>Extra server arguments</span>
                <input className="input" type="text" spellCheck={false} placeholder="e.g. --vae-conv-direct" value={cfg.extraServerArgs.join(" ")} onChange={(e) => set({ extraServerArgs: e.target.value.split(/\s+/).filter(Boolean) })} />
              </label>
              <span className="muted">The server always listens on 127.0.0.1 only.</span>
            </>
          )}

          {tab === "lora" && <LoraSettings />}
          {tab === "diagnostics" && <Diagnostics />}
        </div>
      </div>
    </div>
  );
}
