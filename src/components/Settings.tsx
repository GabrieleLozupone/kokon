import { Activity, Copy, Cpu, Download, FolderOpen, HardDrive, Heart, Layers, MonitorSmartphone, RefreshCw, RotateCcw, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { api } from "../lib/api";
import { AiMarkingCard } from "./AiCheck";
import { native } from "../lib/native";
import { inBrowser } from "../lib/platform";
import { getState, openModelSetup, refreshStatus, setState, startTour, toastError, toastInfo, useStore } from "../lib/store";
import { formatBytes, macBenchProgress } from "../lib/logic";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../lib/theme";
import { LANGUAGES, langChoice, setLangChoice, systemLang, t, type LangChoice } from "../lib/i18n";
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
        <strong>{t("settings.openSourceTitle")}</strong>
        <span className="muted">{t("settings.openSourceText")}</span>
      </div>
      <button className="btn primary" onClick={() => native.openLink(REPO_URL).catch(toastError)}>
        {t("settings.openGitHub")}
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
        <strong>{t("settings.supportTitle")}</strong>
        <span className="muted">{t("settings.supportText")}</span>
      </div>
      <button className="btn" onClick={() => native.openLink(SUPPORT_URL).catch(toastError)}>
        {t("settings.support")}
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
        <span className="muted">{t("settings.pathOnServer", { path: props.value || "—" })}</span>
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
          {t("settings.browse")}
        </button>
        {props.open && (
          <button className="btn" title={t("settings.openFolder")} onClick={() => native.openFolder(props.value).catch(toastError)}>
            <FolderOpen size={14} /> {t("common.open")}
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
          {props.label} <span className="muted">· {custom ? t("settings.enhancerCustom") : t("settings.enhancerBuiltin")}</span>
        </span>
        <button className="btn" disabled={!custom} onClick={() => props.onChange("")} title={t("settings.restoreDefaultTitle")}>
          <RotateCcw size={13} /> {t("settings.restoreDefault")}
        </button>
      </div>
      <textarea
        className="input"
        rows={9}
        spellCheck={false}
        maxLength={props.max}
        value={props.value || props.builtin || ""}
        placeholder={props.builtin === null ? t("common.loading") : ""}
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
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
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
          <strong>{t("settings.benchTitle")}</strong>
          <span className="muted">{t("settings.benchText")}</span>
        </div>
        {running ? (
          <button className="btn" onClick={() => act(api.cancelMacBench)}>
            <X size={15} /> {t("common.cancel")}
          </button>
        ) : (
          <button className="btn primary" disabled={!!blocked || starting} title={blocked ?? undefined} onClick={run}>
            <Activity size={15} /> {bench?.state === "done" ? t("settings.benchRunAgain") : t("settings.benchRun")}
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
            <button className="btn" onClick={async () => (await writeText(report), toastInfo(t("settings.reportCopied")))}>
              <Copy size={14} /> {t("settings.copyReport")}
            </button>
            <button className="btn" onClick={() => native.openLink(BENCH_DISCUSSION_URL).catch(toastError)}>
              {t("settings.shareOnGitHub")}
            </button>
          </div>
          <span className="muted">{t("settings.benchPasteHint")}</span>
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
          <button className="btn" disabled={!text} onClick={async () => (await (inBrowser ? navigator.clipboard.writeText(text ?? "") : writeText(text ?? "")), toastInfo(t("settings.diagnosticsCopied")))}>
            <Copy size={14} /> {t("common.copy")}
          </button>
        )}
        <button className="btn" onClick={load}>
          <RefreshCw size={14} /> {t("settings.refresh")}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.restartBackend();
              toastInfo(t("settings.serverRestarted"));
              load();
            } catch (e) {
              toastError(e);
            } finally {
              setBusy(false);
              refreshStatus();
            }
          }}
        >
          <RotateCcw size={14} /> {busy ? t("settings.restarting") : t("settings.restartServer")}
        </button>
        {!inBrowser && (
          <button className="btn" onClick={async () => native.openFolder(await native.dataFolder().then((d) => `${d}${d.includes("\\") ? "\\" : "/"}logs`)).catch(toastError)}>
            <FolderOpen size={14} /> {t("settings.logs")}
          </button>
        )}
      </div>
      <pre className="diag">{text ?? t("settings.collecting")}</pre>
    </>
  );
}

export function Settings() {
  // Opened on a tab by `openSettings` (e.g. the LoRA badge), else General.
  const [tab, setTab] = useState<Tab>(() => {
    const initial = getState().settingsTab as Tab | null;
    return initial && TABS.includes(initial) ? initial : "general";
  });
  useEffect(() => setState({ settingsTab: null }), []);
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  // Opened on a section (e.g. Prompt+ instructions, from the Prompt+ menu): scrolled to once it is drawn.
  const focus = useRef(getState().settingsFocus);
  useEffect(() => {
    if (!focus.current || !cfg) return;
    const el = document.getElementById(`settings-${focus.current}`);
    if (!el) return;
    focus.current = null;
    setState({ settingsFocus: null });
    window.requestAnimationFrame(() => el.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [cfg, tab]);
  const [devices, setDevices] = useState<[string, string][]>([]);
  const [upscaler, setUpscaler] = useState<Check | null>(null);
  // The saved model setup: what is missing, whether the official files are downloaded.
  const [ms, setMs] = useState<ModelsStatus | null>(null);
  const [legacy, setLegacy] = useState<{ files: string[]; bytes: number } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [theme, setTheme] = useState(themeChoice);
  const [language, setLanguage] = useState(langChoice);
  const [enhancerDefaults, setEnhancerDefaults] = useState<{ t2i: string; edit: string; compose?: string; max_chars: number } | null>(null);
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
    if (!cfg || !legacy || !window.confirm(t("settings.deleteLegacyConfirm", { size: formatBytes(legacy.bytes), files: legacy.files.join("\n") }))) return;
    try {
      const r = await api.removeLegacyUpscalers(cfg.upscalerModel);
      toastInfo(t("settings.deletedFreed", { size: formatBytes(r.freed_bytes) }));
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
      if (failed) toastError(new Error(t("settings.downloadFailedNamed", { name: failed.label, error: failed.error ?? "" })));
      else if (st.complete) toastInfo(done);
      api.models().then(setMs, () => {});
      api.config().then(setCfg, () => {});
    } catch (e) {
      toastError(e);
    } finally {
      setProgress(null);
    }
  };
  const improveVae = () => switchFile(api.improveVae, setVaeProgress, t("settings.newDecoderInUse"));
  const newImageModel = () => switchFile(api.newImageModel, setDitProgress, t("settings.newImageModelInUse"));

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
      toastInfo(r.backend_restart_needed ? t("settings.savedReload") : t("settings.saved"));
      refreshStatus();
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  const nav: [Tab, string, React.ReactNode][] = [
    ["general", t("settings.tabGeneral"), <Settings2 size={16} key="g" />],
    ["models", t("settings.tabModels"), <HardDrive size={16} key="m" />],
    ["lora", t("settings.tabLora"), <Layers size={16} key="l" />],
    ["performance", t("settings.tabPerformance"), <Cpu size={16} key="p" />],
    // Only the computer running Kokon decides who else can use it.
    ...(inBrowser ? [] : ([["devices", t("settings.tabDevices"), <MonitorSmartphone size={16} key="o" />]] as [Tab, string, React.ReactNode][])),
    ["diagnostics", t("settings.tabDiagnostics"), <Activity size={16} key="d" />],
  ];

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-label={t("settings.title")}>
        <div className="modal-nav">
          {nav.map(([id, label, icon]) => (
            <button key={id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
              {icon} {label}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {tab !== "diagnostics" && tab !== "lora" && tab !== "devices" && (
            <button className="btn primary nav-save" style={{ justifyContent: "center" }} disabled={!dirty} onClick={save}>
              {t("common.save")}
            </button>
          )}
        </div>
        <div className="modal-body">
          <div style={{ display: "flex", alignItems: "center" }}>
            <h3 style={{ flex: 1 }}>{nav.find((n) => n[0] === tab)?.[1]}</h3>
            <IconButton title={t("common.close")} onClick={close}>
              <X size={18} />
            </IconButton>
          </div>

          {tab === "general" && (
            <>
              <RepoCard />
              <SupportCard />
              <AiMarkingCard />
              <PathField label={t("settings.saveImagesTo")} value={cfg.outputDir} folder open onChange={(v) => set({ outputDir: v })} />
              <div className="field-row">
                <span>{t("settings.projectFolders")}</span>
                <Switch on={!!cfg.projectFolders} onChange={(v) => set({ projectFolders: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>{t("settings.projectFoldersHint")}</span>
              <label className="field">
                <span>{t("settings.language")}</span>
                <select className="input" value={language} onChange={(e) => {
                  const v = e.target.value as LangChoice;
                  setLanguage(v);
                  setLangChoice(v);
                }}>
                  <option value="system">{t("settings.languageSystem", { name: LANGUAGES.find((l) => l.code === systemLang())!.name })}</option>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <span className="muted">{t("settings.languageHint")}</span>
              </label>
              <div className="field">
                <span>{t("settings.appearance")}</span>
                <Seg<ThemeChoice>
                  value={theme}
                  options={[
                    { value: "system", label: t("settings.themeSystem") },
                    { value: "light", label: t("settings.themeLight") },
                    { value: "dark", label: t("settings.themeDark") },
                  ]}
                  onChange={(v) => (setThemeChoice(v), setTheme(v))}
                />
                <span className="muted">{t("settings.appearanceHint")}</span>
              </div>
              <div className="field-row">
                <span>{t("settings.keepServerRunning")}</span>
                <Switch on={cfg.keepServerRunning} onChange={(v) => set({ keepServerRunning: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>{t("settings.keepServerRunningHint")}</span>
              <label className="field-row">
                <span>{t("settings.idleUnload")}</span>
                <input className="input" type="number" min={0} max={1440} style={{ width: 90 }} value={cfg.idleUnloadMinutes} onChange={(e) => set({ idleUnloadMinutes: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
              <span className="muted" style={{ marginTop: -10 }}>{t("settings.idleUnloadHint")}</span>
              {inBrowser ? (
                <div className="field-row">
                  <span>{t("settings.browserVersion", { version: appVersion })}</span>
                  <button className="btn" onClick={() => api.logout().then(() => location.reload(), toastError)}>
                    {t("settings.signOut")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="field-row">
                    <span>{t("settings.updateCheck")}</span>
                    <Switch on={autoCheckEnabled(cfg.ui)} onChange={(v) => set({ ui: { ...cfg.ui, updateCheck: v } })} />
                  </div>
                  <span className="muted" style={{ marginTop: -10 }}>{t("settings.updateCheckHint")}</span>
                  <div className="field-row">
                    <span>{t("settings.youHave", { version: appVersion })}</span>
                    <button className="btn" onClick={() => checkForUpdate(true)}>
                      {t("settings.checkNow")}
                    </button>
                  </div>
                </>
              )}
              <div className="field-row">
                <span>{t("settings.whatsNew", { version: WHATS_NEW_VERSION })}</span>
                <button className="btn" onClick={() => leave(() => setState({ overlay: "whats-new" }))}>
                  {t("settings.show")}
                </button>
              </div>
              <div className="field-row">
                <span>{t("settings.welcomeScreen")}</span>
                <button className="btn" onClick={() => leave(() => setState({ overlay: "welcome" }))}>
                  {t("settings.show")}
                </button>
              </div>
              <div className="field-row">
                <span>{t("settings.tour")}</span>
                <button className="btn" onClick={() => leave(startTour)}>
                  {t("settings.start")}
                </button>
              </div>

              <h4 id="settings-prompt-plus" style={{ margin: "14px 0 0", fontSize: 14, fontWeight: 600, scrollMarginTop: 12 }}>Prompt+</h4>
              <span className="muted" style={{ marginTop: -8 }}>
                {t("settings.promptPlusIntro")}
                {textGeneration === false && ` ${t("settings.promptPlusNoEngine")}`}
              </span>
              <div className="setting-card" style={{ alignItems: "flex-start" }}>
                <span className="muted">{t("settings.promptPlusWarning")}</span>
              </div>
              <EnhancerPrompt
                label={t("settings.enhancerT2i")}
                help={t("settings.enhancerT2iHelp")}
                value={cfg.enhancerT2iPrompt ?? ""}
                builtin={enhancerDefaults?.t2i ?? null}
                max={enhancerDefaults?.max_chars ?? 20000}
                onChange={(v) => set({ enhancerT2iPrompt: v })}
              />
              <EnhancerPrompt
                label={t("settings.enhancerEdit")}
                help={t("settings.enhancerEditHelp")}
                value={cfg.enhancerEditPrompt ?? ""}
                builtin={enhancerDefaults?.edit ?? null}
                max={enhancerDefaults?.max_chars ?? 20000}
                onChange={(v) => set({ enhancerEditPrompt: v })}
              />
              <EnhancerPrompt
                label={t("settings.enhancerCompose")}
                help={t("settings.enhancerComposeHelp")}
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
                  <strong>{t("settings.modelSetup")}</strong>
                  <span className="muted">{t("settings.modelSetupText")}</span>
                </div>
                <button
                  className="btn primary"
                  onClick={() => leave(() => setState({ overlay: null, needsSetup: true }))}
                >
                  <Download size={15} /> {t("settings.setUpModels")}
                </button>
              </div>
              <PathField label={t("settings.sdcppFolder")} value={cfg.sdcppDir} folder onChange={(v) => set({ sdcppDir: v })} />
              {cfg.profiles.length > 1 ? (
                <label className="field-row">
                  <span>{t("settings.model")}</span>
                  <select className="select" value={profile.id} onChange={(e) => set({ activeProfile: e.target.value })}>
                    {cfg.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="muted">{t("settings.modelNamed", { name: profile.displayName })}</span>
              )}
              {profile.source === "official" ? (
                // The official files follow the install folder and preset; own files get their own profile.
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>{t("settings.officialModel")}</strong>
                    <span className="muted">
                      {ms === null
                        ? t("settings.officialModelText")
                        : ms.official_installed
                          ? t("settings.officialModelDownloaded")
                          : t("settings.officialModelNotDownloaded")}
                    </span>
                    <details className="model-files">
                      <summary>{t("settings.files")}</summary>
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
                          if (dirty && !window.confirm(t("settings.discardOpenSetup"))) return;
                          openModelSetup("official");
                        }}
                      >
                        <Download size={15} /> {t("settings.downloadEllipsis")}
                      </button>
                    )}
                    {!inBrowser && (
                      <button
                        className="btn"
                        onClick={() => {
                          if (dirty && !window.confirm(t("settings.discardOwnFiles"))) return;
                          openModelSetup("own");
                        }}
                      >
                        <FolderOpen size={15} /> {t("settings.useOwnFiles")}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  <span className="muted">{t("settings.ownFilesText")}</span>
                  <PathField label={t("settings.diffusionModel")} value={profile.diffusionModel} onChange={(v) => setProfile({ diffusionModel: v })} />
                  <PathField label={t("settings.vae")} value={profile.vae} onChange={(v) => setProfile({ vae: v })} />
                  <PathField label={t("settings.textEncoderFile")} value={profile.textEncoder} onChange={(v) => setProfile({ textEncoder: v })} />
                  <PathField label={t("settings.visionProjector")} value={profile.visionProjector ?? ""} onChange={(v) => setProfile({ visionProjector: v || null })} />
                </>
              )}
              {ms?.dit.update && (
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>{t("settings.imageModelFile")}</strong>
                    <span className="muted">
                      {ms.dit.update === "official"
                        ? t("settings.imageModelUpdateOfficial")
                        : t("settings.imageModelUpdateOwn")}
                    </span>
                    {ditProgress !== null && (
                      <div className="progress" style={{ marginTop: 6 }}>
                        <i style={{ width: `${ditProgress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  <button className="btn primary" disabled={ditProgress !== null || vaeProgress !== null || dirty} title={dirty ? t("settings.saveOrDiscardFirst") : undefined} onClick={newImageModel}>
                    <Download size={15} /> {ditProgress !== null ? t("settings.percent", { percent: Math.floor(ditProgress * 100) }) : ms.dit.download_bytes ? t("settings.switchSize", { size: formatBytes(ms.dit.download_bytes) }) : t("settings.switch")}
                  </button>
                </div>
              )}
              {ms && (
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>{t("settings.imageDecoder")}</strong>
                    <span className="muted">
                      {ms.vae.improved
                        ? t("settings.decoderImproved")
                        : profile.source === "official"
                          ? t("settings.decoderUpdateOfficial")
                          : t("settings.decoderUpdateOwn")}
                    </span>
                    {vaeProgress !== null && (
                      <div className="progress" style={{ marginTop: 6 }}>
                        <i style={{ width: `${vaeProgress * 100}%` }} />
                      </div>
                    )}
                  </div>
                  {!ms.vae.improved && (
                    <button className="btn primary" disabled={vaeProgress !== null || ditProgress !== null || dirty} title={dirty ? t("settings.saveOrDiscardFirst") : undefined} onClick={improveVae}>
                      <Download size={15} /> {vaeProgress !== null ? t("settings.percent", { percent: Math.floor(vaeProgress * 100) }) : ms.vae.download_bytes ? t("settings.switchSize", { size: formatBytes(ms.vae.download_bytes) }) : t("settings.switch")}
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
                <span>{t("settings.upscalePrescale")}</span>
                <Switch on={cfg.upscalePrescale} onChange={(v) => applyNow({ upscalePrescale: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>{t("settings.upscalePrescaleHint")}</span>
              {legacy && legacy.files.length > 0 && (
                <div className="setting-card">
                  <div className="setting-card-text">
                    <strong>{t("settings.legacyTitle")}</strong>
                    <span className="muted">{t("settings.legacyText", { files: legacy.files.map((f) => f.split(/[\\/]/).pop()).join(", ") })}</span>
                  </div>
                  <button className="btn" onClick={removeLegacy}>
                    <Trash2 size={15} /> {t("settings.deleteSize", { size: formatBytes(legacy.bytes) })}
                  </button>
                </div>
              )}
            </>
          )}

          {tab === "performance" && mac && (
            <>
              <div className="field">
                <span>{t("settings.engine")}</span>
                <span>{cfg.macEngine ? t("settings.macEngine") : t("settings.metalEngine")}</span>
              </div>
              <div className="field-row">
                <span>{t("settings.macEngine")}</span>
                <Switch on={!!cfg.macEngine} onChange={(v) => set({ macEngine: v })} />
              </div>
              <span className="muted" style={{ marginTop: -10 }}>{t("settings.macEngineHint")}</span>
              {!inBrowser && <MacBench blocked={dirty ? t("settings.saveOrDiscardFirst") : !cfg.macEngine ? t("settings.benchNeedsMacEngine") : null} />}
              {!cfg.macEngine && (
              <div className="field">
                <span>{t("settings.modelMemory")}</span>
                <Seg<TextEncoderPlacement>
                  value={cfg.textEncoderPlacement === "disk" ? "disk" : "gpu"}
                  options={[
                    { value: "gpu", label: t("settings.keepLoaded") },
                    { value: "disk", label: t("settings.loadWhenNeeded") },
                  ]}
                  onChange={(v) => set({ textEncoderPlacement: v })}
                />
                <span className="muted">{t("settings.modelMemoryHint")}</span>
              </div>
              )}
              <label className="field-row">
                <span>{t("settings.macReserve")}</span>
                <input className="input" type="number" min={0} max={16} step={0.5} style={{ width: 90 }} value={cfg.vramReserveGib} onChange={(e) => set({ vramReserveGib: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            </>
          )}

          {tab === "performance" && !mac && (
            <>
              <div className="field">
                <span>{t("settings.engine")}</span>
                <span>{cfg.gpuBackend === "vulkan" ? "Vulkan" : "CUDA (NVIDIA)"}</span>
                <span className="muted">{t("settings.switchEngineHint")}</span>
              </div>
              <label className="field-row">
                <span>{t("settings.gpuDevice")}</span>
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
                <span>{t("settings.textEncoderWeights")}</span>
                <Seg<TextEncoderPlacement>
                  value={cfg.textEncoderPlacement}
                  options={[
                    { value: "ram", label: "RAM" },
                    { value: "gpu", label: "GPU" },
                    { value: "cpu", label: "CPU" },
                    { value: "auto", label: t("common.auto") },
                  ]}
                  onChange={(v) => set({ textEncoderPlacement: v })}
                />
                <span className="muted">{t("settings.textEncoderWeightsHint")}</span>
              </div>
              <label className="field-row">
                <span>{t("settings.vramReserve")}</span>
                <input className="input" type="number" min={0} max={16} step={0.5} style={{ width: 90 }} value={cfg.vramReserveGib} onChange={(e) => set({ vramReserveGib: Math.max(0, Number(e.target.value) || 0) })} />
              </label>
            </>
          )}

          {tab === "performance" && (
            <>
              <div className="field-row">
                <span>{t("settings.flashAttention")}</span>
                <Switch on={cfg.flashAttention} onChange={(v) => set({ flashAttention: v })} />
              </div>
              {cfg.gpuBackend === "cuda" && (
                <>
                  <div className="field-row">
                    <span>{t("settings.sageAttention")}</span>
                    <Switch on={cfg.sageAttention && !cfg.sageUnsupported} disabled={cfg.sageUnsupported} onChange={(v) => set({ sageAttention: v })} />
                  </div>
                  {cfg.sageUnsupported && <span className="muted" style={{ marginTop: -10 }}>{t("settings.sageUnsupported")}</span>}
                </>
              )}
              <label className="field-row">
                <span>{t("settings.vaeTileSize")}</span>
                <input className="input" type="number" min={0} max={2048} step={128} style={{ width: 90 }} value={cfg.vaeTileSize} onChange={(e) => set({ vaeTileSize: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              {cfg.gpuBackend === "vulkan" && <span className="muted" style={{ marginTop: -10 }}>{t("settings.vulkanTileHint")}</span>}
              <div className="field">
                <span>{t("settings.prefixCache")}</span>
                <Seg<string>
                  value={cfg.prefixCacheType}
                  options={[
                    { value: "q8_0", label: t("settings.prefixCache8bit") },
                    { value: "f16", label: "FP16" },
                    { value: "auto", label: t("common.auto") },
                    { value: "off", label: t("common.off") },
                  ]}
                  onChange={(v) => set({ prefixCacheType: v })}
                />
                <span className="muted">{cfg.gpuBackend === "cuda" ? t("settings.prefixCacheHintCuda") : t("settings.prefixCacheHint")}</span>
              </div>
              {cfg.textEncoderPlacement !== "disk" && (
                <div className="field-row">
                  <span>{t("settings.eagerLoad")}</span>
                  <Switch on={cfg.eagerLoad} onChange={(v) => set({ eagerLoad: v })} />
                </div>
              )}
              <label className="field-row">
                <span>{t("settings.upscaleTileSize")}</span>
                <input className="input" type="number" min={0} max={1024} step={64} style={{ width: 90 }} value={cfg.upscaleTileSize} onChange={(e) => set({ upscaleTileSize: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
              </label>
              <span className="muted" style={{ marginTop: -10 }}>{t("settings.upscaleTileSizeHint")}</span>
              {!mac && (
                <>
                  <label className="field-row">
                    <span>{t("settings.vramOverride")}</span>
                    <input className="input" type="number" min={0} max={196608} step={1024} style={{ width: 100 }} value={cfg.vramOverrideMib} onChange={(e) => set({ vramOverrideMib: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
                  </label>
                  <span className="muted" style={{ marginTop: -10 }}>{t("settings.vramOverrideHint")}</span>
                </>
              )}
              {!inBrowser && (
              <>
              <label className="field-row">
                <span>{t("settings.serverPort")}</span>
                <input className="input" type="number" min={1024} max={65535} style={{ width: 100 }} value={cfg.serverPort} onChange={(e) => set({ serverPort: Number(e.target.value) || cfg.serverPort })} />
              </label>
              <label className="field">
                <span>{t("settings.extraServerArgs")}</span>
                <input className="input" type="text" spellCheck={false} placeholder={t("settings.extraServerArgsPlaceholder")} value={cfg.extraServerArgs.join(" ")} onChange={(e) => set({ extraServerArgs: e.target.value.split(/\s+/).filter(Boolean) })} />
              </label>
              </>
              )}
              {!inBrowser && <span className="muted">{t("settings.serverLocalOnly")}</span>}
            </>
          )}

          {tab === "lora" && <LoraSettings />}
          {tab === "diagnostics" && <Diagnostics />}
          {/* On a phone Save sits at the foot of the page (the tabs scroll sideways). */}
          {tab !== "diagnostics" && tab !== "lora" && tab !== "devices" && (
            <div className="modal-save">
              <button className="btn primary" disabled={!dirty} onClick={save}>
                {t("common.save")}
              </button>
            </div>
          )}
        </div>
        {leaving && (
          <div className="modal-ask" role="alertdialog" aria-label={t("settings.unsavedChanges")}>
            <div className="modal-ask-box">
              <strong>{t("settings.saveChangesQuestion")}</strong>
              <span className="muted">{t("settings.saveChangesText")}</span>
              <div className="modal-ask-actions">
                <button className="btn ghost" onClick={() => setLeaving(null)}>
                  {t("common.cancel")}
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
                  {t("settings.discard")}
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
                  {t("common.save")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
