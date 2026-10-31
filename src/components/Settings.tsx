import { Activity, Copy, Cpu, Download, FolderOpen, HardDrive, Heart, Layers, MonitorSmartphone, Play, RefreshCw, RotateCcw, Settings2, SquarePen, Trash2, Video, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { native } from "../lib/native";
import { inBrowser } from "../lib/platform";
import { getState, openModelSetup, refreshStatus, setState, startTour, toastError, toastInfo, useStore } from "../lib/store";
import { formatBytes, macBenchProgress } from "../lib/logic";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../lib/theme";
import { LoraSettings } from "./LoraSettings";
import { RemoteAccess } from "./RemoteAccess";
import { UpscalerControls } from "./Upscalers";
import { WHATS_NEW_VERSION } from "./WhatsNew";
import type { AppConfig, Check, InstallStatus, MacBenchState, ModelProfile, ModelsStatus, SetupReport, TextEncoderPlacement } from "../lib/types";
import { IconButton, Seg, Switch } from "./ui";
import { autoCheckEnabled, checkForUpdate } from "../lib/updates";

const REPO_URL = "https://github.com/GabrieleLozupone/kokon";
const SUPPORT_URL = "https://kokon.app/support/";
/** Where testers paste their Mac engine bench report. */
const BENCH_DISCUSSION_URL = "https://github.com/GabrieleLozupone/kokon/discussions/43";

/** Top of Settings → General: where Kokon lives. */
export function RepoCard() {
  return (
    <div className="repo-card">
      <GitHubMark />
      <div className="body">
        <strong>Kokon is open source</strong>
        <span className="muted">Code, issues and discussions are on GitHub. A star helps other people find it.</span>
      </div>
      <button className="btn primary" onClick={() => native.openLink(REPO_URL).catch(toastError)}>
        Open GitHub
      </button>
    </div>
  );
}

/** Under the repository card: one quiet way to tip, no prompts anywhere else. */
export function SupportCard() {
  return (
    <div className="repo-card support-card">
      <Heart size={22} className="support-mark" aria-hidden />
      <div className="body">
        <strong>Support Kokon</strong>
        <span className="muted">Kokon is free and made by one person. If it's useful to you, a tip helps keep it that way.</span>
      </div>
      <button className="btn" onClick={() => native.openLink(SUPPORT_URL).catch(toastError)}>
        Support
      </button>
    </div>
  );
}

/** GitHub's mark (Octicons mark-github, MIT); lucide no longer ships brand icons. */
function GitHubMark() {
  return (
    <svg className="github-mark" viewBox="0 0 16 16" width="26" height="26" aria-hidden>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

type Tab = "general" | "models" | "lora" | "performance" | "devices" | "diagnostics";
const TABS: Tab[] = ["general", "models", "lora", "performance", "devices", "diagnostics"];

/** Browser: what the computer running Kokon has set (only its desktop app changes folders and files). */
function PathField(props: { label: string; value: string; onChange: (v: string) => void; folder?: boolean; extensions?: string[]; open?: boolean }) {
  if (inBrowser) {
    return (
      <div className="field">
        <span>{props.label}</span>
        <span className="muted">{props.value || "—"} (on the computer running Kokon)</span>
      </div>
    );
  }
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

/** Settings → Performance on a Mac: runs `kokon-engine-mac bench` on this Mac and gives the report to paste on
 * GitHub. `blocked`: why it cannot run with the saved settings. */
function MacBench({ blocked }: { blocked: string | null }) {
  const bench = useStore((s) => s.macBench);
  const [now, setNow] = useState(Date.now());
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    api.macBench().then((b) => setState({ macBench: b }), () => {});
  }, []);
  const running = bench?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(t);
  }, [running]);
  const progress = bench && macBenchProgress(bench, now);
  const act = async (f: () => Promise<MacBenchState>) => {
    try {
      setState({ macBench: await f() });
    } catch (e) {
      toastError(e);
    }
  };
  const run = async () => {
    setStarting(true);
    await act(() => api.startMacBench());
    setStarting(false);
  };
  const report = bench?.state === "done" ? bench.report : "";
  return (
    <div className="field">
      <div className="setting-card">
        <div className="setting-card-text">
          <strong>Benchmark this Mac</strong>
          <span className="muted">
            Measures Kokon's Mac engine on this Mac: speed, memory and accuracy, with each chip-specific path on and off. It takes about 10 minutes and
            uses the whole Mac: close other apps and keep it plugged in. Images can't be made while it runs.
          </span>
        </div>
        {running ? (
          <button className="btn" onClick={() => act(api.cancelMacBench)}>
            <X size={15} /> Cancel
          </button>
        ) : (
          <button className="btn primary" disabled={!!blocked || starting} title={blocked ?? undefined} onClick={run}>
            <Activity size={15} /> {bench?.state === "done" ? "Run again" : "Run"}
          </button>
        )}
      </div>
      {progress && (
        <>
          <div className="progress thick">
            <i style={{ width: `${progress.frac * 100}%` }} />
          </div>
          <span className="muted">{progress.text}</span>
        </>
      )}
      {bench?.state === "failed" && (
        <>
          <span className="muted">{bench.error}</span>
          {bench.log && <pre className="diag" style={{ maxHeight: 180 }}>{bench.log}</pre>}
        </>
      )}
      {report && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" onClick={async () => (await writeText(report), toastInfo("Report copied"))}>
              <Copy size={14} /> Copy report
            </button>
            <button className="btn" onClick={() => native.openLink(BENCH_DISCUSSION_URL).catch(toastError)}>
              Share on GitHub
            </button>
          </div>
          <span className="muted">Paste the report in the GitHub discussion: it shows which paths suit this chip. Nothing is sent by Kokon.</span>
          <pre className="diag" style={{ maxHeight: 260 }}>{report}</pre>
        </>
      )}
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
        {(!inBrowser || window.isSecureContext) && (
          <button className="btn" disabled={!text} onClick={async () => (await (inBrowser ? navigator.clipboard.writeText(text ?? "") : writeText(text ?? "")), toastInfo("Diagnostics copied"))}>
            <Copy size={14} /> Copy
          </button>
        )}
        <button className="btn" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.startBackend({ mode: "image" });
              toastInfo("Image server (Qwen-Image 2.1) started");
              load();
            } catch (e) {
              toastError(e);
            } finally {
              setBusy(false);
              refreshStatus();
            }
          }}
        >
          <SquarePen size={14} /> Start Image Server
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.startBackend({ mode: "video" });
              toastInfo("Video server (Wan 2.2) started");
              load();
            } catch (e) {
              toastError(e);
            } finally {
              setBusy(false);
              refreshStatus();
            }
          }}
        >
          <Video size={14} /> Start Video Server
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
        {!inBrowser && (
          <button className="btn" onClick={async () => native.openFolder(await native.dataFolder().then((d) => `${d}${d.includes("\\") ? "\\" : "/"}logs`)).catch(toastError)}>
            <FolderOpen size={14} /> Logs
          </button>
        )}
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
  const [enhancerDefaults, setEnhancerDefaults] = useState<{ t2i: string; edit: string; compose?: string; max_chars: number } | null>(null);
  const textGeneration = useStore((s) => s.status?.server.text_generation);
  const server = useStore((s) => s.server);
  const serverModel = useStore((s) => s.status?.server.model);

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

  // Switching to the new VAE (#21) or the Q4_K_M image model: download, then the service swaps it and deletes the old
  // file from Kokon's folder (never the user's own).
  const [vaeProgress, setVaeProgress] = useState<number | null>(null);
  const [ditProgress, setDitProgress] = useState<number | null>(null);
  const switchFile = async (start: () => Promise<InstallStatus>, setProgress: (p: number | null) => void, done: string) => {
    try {
      let st = await start();
      setProgress(0);
      while (st.running) {
        await new Promise((r) => window.setTimeout(r, 700));
        st = await api.installStatus();
        const total = st.items.reduce((a, i) => a + i.size, 0);
        setProgress(total ? st.items.reduce((a, i) => a + i.received, 0) / total : 0);
      }
      const failed = st.items.find((i) => i.state === "failed");
      if (failed) toastError(new Error(`${failed.label}: ${failed.error}`));
      else if (st.complete) toastInfo(done);
      api.models().then(setMs, () => {});
      api.config().then(setCfg, () => {});
    } catch (e) {
      toastError(e);
    } finally {
      setProgress(null);
    }
  };
  const improveVae = () => switchFile(api.improveVae, setVaeProgress, "The new decoder is in use");
  const newImageModel = () => switchFile(api.newImageModel, setDitProgress, "The Q4_K_M image model is in use");

  // Leaving with unsaved changes asks first (people forgot Save): `then` runs after Save or
  // Discard, Cancel stays here.
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const leave = (then: () => void) => (dirty ? setLeaving(() => then) : then());
  const close = () => leave(() => setState({ overlay: null }));
  const onEscape = useRef(close);
  onEscape.current = () => (leaving ? setLeaving(null) : close());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEscape.current();
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

  const save = async (): Promise<boolean> => {
    try {
      const r = await api.saveConfig(cfg);
      setDirty(false);
      api.setup().then((s: SetupReport) => setUpscaler(s.checks.find((c) => c.id === "upscaler") ?? null), () => {});
      toastInfo(r.backend_restart_needed ? "Saved. The model reloads with the new settings on the next generation." : "Saved");
      refreshStatus();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  const nav: [Tab, string, React.ReactNode][] = [
    ["general", "General", <Settings2 size={16} key="g" />],
    ["models", "Models", <HardDrive size={16} key="m" />],
    ["lora", "LoRA (beta)", <Layers size={16} key="l" />],
    ["performance", "Performance", <Cpu size={16} key="p" />],
    // Only the computer running Kokon decides who else can use it.
    ...(inBrowser ? [] : ([["devices", "Other devices", <MonitorSmartphone size={16} key="o" />]] as [Tab, string, React.ReactNode][])),
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
          {tab !== "diagnostics" && tab !== "lora" && tab !== "devices" && (
            <button className="btn primary nav-save" style={{ justifyContent: "center" }} disabled={!dirty} onClick={save}>
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
              <RepoCard />
              <SupportCard />
              <PathField label="Save images and videos to" value={cfg.outputDir} folder open onChange={(v) => set({ outputDir: v })} />
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
              {inBrowser ? (
                <div className="field-row">
                  <span>Kokon {appVersion} on the computer running it. It updates there.</span>
                  <button className="btn" onClick={() => api.logout().then(() => location.reload(), toastError)}>
                    Sign out
                  </button>
                </div>
              ) : (
                <>
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
                </>
              )}
              <div className="field-row">
                <span>What's new in Kokon {WHATS_NEW_VERSION}</span>
                <button className="btn" onClick={() => leave(() => setState({ overlay: "whats-new" }))}>
                  Show
                </button>
              </div>
              <div className="field-row">
                <span>Welcome screen: what Kokon is and how it keeps your work private</span>
                <button className="btn" onClick={() => leave(() => setState({ overlay: "welcome" }))}>
                  Show
                </button>
              </div>
              <div className="field-row">
                <span>Tour: a short walk through an example project (adds the examples again if you removed them)</span>
                <button className="btn" onClick={() => leave(startTour)}>
                  Start
                </button>
              </div>

              <h4 style={{ margin: "14px 0 0", fontSize: 14, fontWeight: 600 }}>Prompt+</h4>
              <span className="muted" style={{ marginTop: -8 }}>
                With Prompt+ on (next to the prompt), the model's own language model rewrites your prompt before making the image, following these instructions. It
                always writes in English. Its menu also lets you read and change the prompt before the image is made.
                {textGeneration === false && " The inference engine in use cannot write prompts: Prompt+ appears with an engine that can."}
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
              <EnhancerPrompt
                label="New images from references"
                help="Used for a new image that uses your images as references (New image with images added). Each image is first labelled on its own; these instructions then write the scene from the labels."
                value={cfg.enhancerComposePrompt ?? ""}
                builtin={enhancerDefaults?.compose ?? null}
                max={enhancerDefaults?.max_chars ?? 20000}
                onChange={(v) => set({ enhancerComposePrompt: v })}
              />
            </>
          )}

          {tab === "devices" && <RemoteAccess />}

          {tab === "models" && (
            <>
              <div className="setting-card">
                <div className="setting-card-text">
                  <strong>Model setup</strong>
                  <span className="muted">Downloads the official Qwen-Image 2.1 and Wan2.2 Video weights for your graphics card, uses model files you already have, or switches between VRAM presets.</span>
                </div>
                <button
                  className="btn primary"
                  onClick={() => leave(() => setState({ overlay: null, needsSetup: true }))}
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
                    <strong>{profile.model === "wan-2.2" ? "Official video model" : "Official image model"}</strong>
                    <span className="muted">
                      {profile.model === "wan-2.2"
                        ? ms === null
                          ? "Wan 2.2 Video, tested with Kokon."
                          : ms.video_official_installed
                            ? "Wan 2.2 Video, tested with Kokon. Downloaded."
                            : "Wan 2.2 Video, tested with Kokon. Not downloaded into this folder yet: Set up models… gets it."
                        : ms === null
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
                    {profile.model === "wan-2.2"
                      ? ms && !ms.video_official_installed && (
                          <button
                            className="btn primary"
                            onClick={() => {
                              if (dirty && !window.confirm("Discard the unsaved changes and open the model setup?")) return;
                              setState({ overlay: null, needsSetup: true });
                            }}
                          >
                            <Download size={15} /> Download…
                          </button>
                        )
                      : ms && !ms.official_installed && (
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
                    {((profile.model === "wan-2.2" && ms?.video_official_installed) || (profile.model !== "wan-2.2" && ms?.official_installed)) && (
                      <button
                        className="btn primary"
                        disabled={server.state === "starting"}
                        onClick={async () => {
                          try {
                            if (dirty) await save();
                            await api.startBackend({ profile: profile.id });
                            toastInfo(`Inference server loaded ${profile.displayName}`);
                          } catch (e) {
                            toastError(e);
                          } finally {
                            refreshStatus();
                          }
                        }}
                      >
                        <Play size={14} /> {server.state === "ready" && serverModel && profile.diffusionModel.endsWith(serverModel) ? "Restart server" : "Start server"}
                      </button>
                    )}
                    {!inBrowser && (
                      <button
                        className="btn"
                        onClick={() => {
                          if (dirty && !window.confirm("Discard the unsaved changes and choose your own model files?")) return;
                          openModelSetup("own");
                        }}
                      >
                        <FolderOpen size={15} /> Use my own files…
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <span className="muted">Your own files: not tested by Kokon. Set up models… checks them and finds them again if they move.</span>
                  <PathField label="Diffusion model" value={profile.diffusionModel} onChange={(v) => setProfile({ diffusionModel: v })} />
                  <PathField label="VAE" value={profile.vae} onChange={(v) => setProfile({ vae: v })} />
                  <PathField label={profile.model === "wan-2.2" ? "Text encoder (UMT5-XXL)" : "Text encoder (Qwen3-VL)"} value={profile.textEncoder} onChange={(v) => setProfile({ textEncoder: v })} />
                  {profile.model !== "wan-2.2" && (
                    <PathField label="Vision projector (mmproj)" value={profile.visionProjector ?? ""} onChange={(v) => setProfile({ visionProjector: v || null })} />
                  )}
                </>
              )}
              {profile.model !== "wan-2.2" && ms?.dit?.update && (
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>Image model file</strong>
                    <span className="muted">
                      {ms.dit.update === "official"
                        ? "Kokon now uses unsloth's Q4_K_M of the image model: better supported, slightly better, the same 4-bit size. Switching downloads it and deletes the old file from Kokon's folder."
                        : "Your image model is the Q4_K file Kokon used before. Kokon now uses unsloth's Q4_K_M: better supported, slightly better, the same 4-bit size. Switching downloads it into Kokon's folder; your own file stays where it is."}
                    </span>
                    {ditProgress !== null && (
                      <div className="progress" style={{ marginTop: 6 }}>
                        <i style={{ width: `${ditProgress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  <button className="btn primary" disabled={ditProgress !== null || vaeProgress !== null || dirty} title={dirty ? "Save or discard your changes first" : undefined} onClick={newImageModel}>
                    <Download size={15} /> {ditProgress !== null ? `${Math.floor(ditProgress * 100)}%` : `Switch${ms.dit.download_bytes ? ` · ${formatBytes(ms.dit.download_bytes)}` : ""}`}
                  </button>
                </div>
              )}
              {ms && profile.model !== "wan-2.2" && (
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
                    <button className="btn primary" disabled={vaeProgress !== null || ditProgress !== null || dirty} title={dirty ? "Save or discard your changes first" : undefined} onClick={improveVae}>
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
                <span>{cfg.macEngine ? "Kokon's Mac engine (experimental)" : "Metal (Apple Silicon GPU, beta)"}</span>
              </div>
              <div className="field-row">
                <span>Kokon's Mac engine (experimental)</span>
                <Switch on={!!cfg.macEngine} onChange={(v) => set({ macEngine: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>
                Kokon's own engine for Apple Silicon: the GPU, the CPU's matrix unit and the Neural Engine work together, about 4 times faster. New images, edits, brushed edits, extending and Prompt+ work on it; LoRAs and the upscaler model still need it off.
              </span>
              {!inBrowser && <MacBench blocked={dirty ? "Save or discard your changes first" : !cfg.macEngine ? "Turn on Kokon's Mac engine and save first" : null} />}
              {!cfg.macEngine && (
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
              )}
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
              {cfg.gpuBackend === "vulkan" && <span className="muted" style={{ marginTop: -10 }}>With Vulkan, images are decoded in tiles of 512 px at most: larger tiles exceed the driver's buffer limit on AMD cards and get much slower.</span>}
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
              {!inBrowser && (
              <>
              <label className="field-row">
                <span>Inference server port</span>
                <input className="input" type="number" min={1024} max={65535} style={{ width: 100 }} value={cfg.serverPort} onChange={(e) => set({ serverPort: Number(e.target.value) || cfg.serverPort })} />
              </label>
              <label className="field">
                <span>Extra server arguments</span>
                <input className="input" type="text" spellCheck={false} placeholder="e.g. --vae-conv-direct" value={cfg.extraServerArgs.join(" ")} onChange={(e) => set({ extraServerArgs: e.target.value.split(/\s+/).filter(Boolean) })} />
              </label>
              </>
              )}
              {!inBrowser && <span className="muted">The server always listens on 127.0.0.1 only.</span>}
            </>
          )}

          {tab === "lora" && <LoraSettings />}
          {tab === "diagnostics" && <Diagnostics />}
          {/* On a phone Save sits at the foot of the page (the tabs scroll sideways). */}
          {tab !== "diagnostics" && tab !== "lora" && tab !== "devices" && (
            <div className="modal-save">
              <button className="btn primary" disabled={!dirty} onClick={save}>
                Save
              </button>
            </div>
          )}
        </div>
        {leaving && (
          <div className="modal-ask" role="alertdialog" aria-label="Unsaved changes">
            <div className="modal-ask-box">
              <strong>Save your changes?</strong>
              <span className="muted">Some settings were changed and not saved.</span>
              <div className="modal-ask-actions">
                <button className="btn ghost" onClick={() => setLeaving(null)}>
                  Cancel
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    const then = leaving;
                    setLeaving(null);
                    setDirty(false);
                    then();
                  }}
                >
                  Discard
                </button>
                <button
                  className="btn primary"
                  autoFocus
                  onClick={async () => {
                    const then = leaving;
                    setLeaving(null);
                    if (await save()) then();
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
