import { ArrowLeft, ArrowLeftRight, Bug, Check, ChevronDown, CircleAlert, Download, ExternalLink, FileSearch, FolderOpen, Loader2, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installItemShort, installProgress, installStep, installTimeLeft } from "../lib/logic";
import { native } from "../lib/native";
import { inBrowser } from "../lib/platform";
import { afterStartScreens, refreshStatus, setState, toastError, toastInfo, useStore } from "../lib/store";
import type { GpuBackend, HardwareReport, InstallItem, InstallStatus, ModelScan, ModelSlot, ModelsStatus, SetupReport } from "../lib/types";
import { OwnModels } from "./OwnModels";
import { Seg } from "./ui";
import { ReadyTips, Showcase } from "./Welcome";
import { t } from "../lib/i18n";

const gb = (mib: number) => t("setup.gb", { n: Math.round(mib / 1024) });

function engineOptions(vendor: string | null): { value: GpuBackend; label: string }[] {
  if (vendor === "apple") return [{ value: "metal", label: t("setup.engineMetalBeta") }];
  const vulkan = { value: "vulkan" as GpuBackend, label: vendor === "nvidia" ? "Vulkan" : t("setup.engineVulkanBeta") };
  return vendor === "nvidia" ? [{ value: "cuda", label: "CUDA" }, vulkan] : [vulkan];
}

function engineNote(b: GpuBackend, nvidia: boolean): string {
  if (b === "cuda") return t("setup.engineNoteCuda");
  if (b === "metal") return t("setup.engineNoteMetal");
  return nvidia
    ? t("setup.engineNoteVulkanNvidia")
    : t("setup.engineNoteVulkan");
}

/** The GPU card's second line: memory, RAM and driver. */
function memoryLine(hw: HardwareReport, vram: number | null): string {
  let line: string;
  if (hw.gpu?.unified)
    line = hw.vram_simulated
      ? t("setup.unifiedMemoryPlanning", { memory: gb(hw.gpu.memory_total_mib), vram: gb(vram ?? 0) })
      : t("setup.unifiedMemory", { memory: gb(hw.gpu.memory_total_mib) });
  else if (vram)
    line = hw.vram_simulated ? t("setup.vramRamSimulated", { vram: gb(vram), ram: gb(hw.ram_total_mib) }) : t("setup.vramRam", { vram: gb(vram), ram: gb(hw.ram_total_mib) });
  else line = t("setup.ramOnly", { ram: gb(hw.ram_total_mib) });
  return hw.gpu?.driver_version ? t("setup.withDriver", { line, version: hw.gpu.driver_version }) : line;
}

function ItemIcon({ it }: { it: InstallItem }) {
  switch (it.state) {
    case "present":
    case "done":
      return <Check size={16} />;
    case "failed":
      return <CircleAlert size={16} />;
    case "downloading":
    case "verifying":
    case "extracting":
      return <Loader2 className="spin" size={16} />;
    default:
      return <Download size={16} style={{ opacity: 0.4 }} />;
  }
}

/** A file that could not be downloaded: what happened and how to get it by hand. */
function Failure({ it, issuesUrl }: { it: InstallItem; issuesUrl: string }) {
  const folder = it.kind === "engine" ? it.path : it.path.replace(/[\\/][^\\/]+$/, "");
  return (
    <div className="setup-failure">
      <strong>{it.label}</strong>
      <span>{it.error}</span>
      <span>{it.hint}</span>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="btn" onClick={() => native.openLink(it.page).catch(toastError)}>
          <ExternalLink size={14} /> {t("setup.downloadPage")}
        </button>
        {!inBrowser && (
          <button className="btn" onClick={() => native.openFolder(folder).catch(toastError)}>
            <FolderOpen size={14} /> {t("setup.openFolder")}
          </button>
        )}
        <button className="btn" onClick={() => native.openLink(issuesUrl).catch(toastError)}>
          <Bug size={14} /> {t("setup.reportProblem")}
        </button>
      </div>
    </div>
  );
}

function FileList({ items }: { items: InstallItem[] }) {
  return (
    <div className="setup-files">
      {items.map((it) => (
        // Prefixed: bare state names are other components' classes (.pending is the job card, .failed its error).
        <div className={`setup-file is-${it.state}`} key={it.id}>
          <ItemIcon it={it} />
          <span className="name">{it.label}</span>
          <span className="state">{installItemShort(it)}</span>
        </div>
      ))}
    </div>
  );
}

/** Another way out of missing files: what it does, in one line. */
interface RepairOption {
  icon: React.ReactNode;
  title: string;
  detail: string;
  run: () => void;
}

/** A model file is missing (drive not connected, moved, deleted): which, the one action that
 * fixes most cases (look again, also in the folder the files were found in), and the other
 * ways out, each saying what it does. */
function Repair(props: { models: ModelsStatus; busy: string | null; note: string | null; onLookAgain: () => void; options: RepairOption[] }) {
  const { models } = props;
  const n = models.missing.length;
  return (
    <div className="setup-note setup-repair">
      <strong>{t("setup.missingTitle", { count: n })}</strong>
      {models.missing.map((m) => (
        <div className="missing" key={m.path}>
          {m.label}: {m.path}
        </div>
      ))}
      <span>
        {models.scan_dir ? t("setup.missingHintScan", { dir: models.scan_dir }) : t("setup.missingHint")}
      </span>
      <div className="actions">
        <button className="btn primary" onClick={props.onLookAgain} disabled={!!props.busy}>
          {props.busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} {props.busy ?? t("setup.lookAgain")}
        </button>
        {props.note && !props.busy && <span className="repair-result">{props.note}</span>}
      </div>
      {props.options.length > 0 && (
        <div className="repair-options">
          <span className="muted">{t("setup.or")}</span>
          {props.options.map((o) => (
            <button key={o.title} className="repair-option" onClick={o.run} disabled={!!props.busy}>
              {o.icon}
              <span>
                <strong>{o.title}</strong>
                <span className="muted">{o.detail}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** First launch (and Settings → Models → Set up models): detect the GPU, pick a preset,
 * download stable-diffusion.cpp and the official Qwen-Image 2.1 weights, then start. Or use
 * the Qwen-Image 2.1 files the user already has (#14), downloading only the engine. */
export function Setup() {
  const [hw, setHw] = useState<HardwareReport | null>(null);
  const [report, setReport] = useState<SetupReport | null>(null);
  const [inst, setInst] = useState<InstallStatus | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  const [backend, setBackend] = useState<GpuBackend | null>(null);
  // Card picked on a multi-GPU machine (index in hw.gpus); null: the one in use.
  const [card, setCard] = useState<number | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [checking, setChecking] = useState(false);
  const [models, setModels] = useState<ModelsStatus | null>(null);
  // Official files, or files the user already has.
  const requestedMode = useStore((s) => s.setupMode);
  const [mode, setMode] = useState<"official" | "own" | null>(requestedMode);
  const [scan, setScan] = useState<ModelScan | null>(null);
  const wasRunning = useRef(false);
  const setupDone = useStore((s) => s.status?.setup_complete ?? false);
  const engineUpdate = useStore((s) => s.status?.engine);

  const refresh = async (engine: GpuBackend | null = backend, gpu: number | null = card) => {
    setChecking(true);
    try {
      const [h, r, i, m] = await Promise.all([api.hardware(engine ?? undefined, gpu ?? undefined), api.setup(), api.installStatus(), api.models()]);
      setHw(h);
      setModels(m);
      setMode((x) => x ?? (h.active_source === "user" ? "own" : "official"));
      setBackend(h.backend);
      setReport(r);
      setInst(i);
      // A running install of the user's own files is labelled "user:<preset>".
      setPreset((p) => p ?? (i.running && i.preset ? i.preset.replace(/^user:/, "") : h.recommended));
    } catch (e) {
      toastError(e);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  // Follow a running installation; re-check everything once it ends.
  useEffect(() => {
    if (!inst?.running) {
      if (wasRunning.current) {
        wasRunning.current = false;
        refresh();
      }
      return;
    }
    wasRunning.current = true;
    const timer = window.setInterval(() => api.installStatus().then(setInst, () => {}), 500);
    return () => window.clearInterval(timer);
  }, [inst?.running]);

  const chooseFolder = async () => {
    const dir = await native.pickFolder(hw?.sdcpp_dir);
    if (!dir) return;
    try {
      const cfg = await api.config();
      await api.saveConfig({ ...cfg, sdcppDir: dir });
      refresh();
    } catch (e) {
      toastError(e);
    }
  };

  const install = async () => {
    if (!preset) return;
    try {
      setInst(await api.install(preset, backend ?? hw?.backend ?? "cuda", true, card ?? undefined, mode === "own" ? "user" : "official"));
    } catch (e) {
      toastError(e);
    }
  };

  // The missing-files card: what it is doing now, and what its last search found.
  const [repairBusy, setRepairBusy] = useState<string | null>(null);
  const [repairNote, setRepairNote] = useState<string | null>(null);

  /** Missing files of `m` found under the same name in `dir` (moved there): when all are
   * found they are used right away. */
  const relocate = async (m: ModelsStatus, dir: string) => {
    const sc = await api.scanModels(dir);
    const missing = m.slots.filter((x) => !x.exists && x.role);
    const found = missing.filter((x) => sc.moved[x.role!]);
    const all = missing.length > 0 && found.length === missing.length;
    if (all) {
      const slot = (role: string): ModelSlot | null => {
        const x = m.slots.find((y) => y.role === role);
        return x ? { path: sc.moved[x.role!] ?? x.path } : null;
      };
      setModels(await api.setUserModels({ diffusion_model: slot("diffusion")!, vae: slot("vae")!, text_encoder: slot("text_encoder")!, vision_projector: slot("vision_projector"), scan_dir: dir }));
      setScan(null);
      toastInfo(t("setup.foundMissing", { count: found.length, dir }));
      await refresh();
    }
    return { all, found: found.length, missing: missing.length, scan: sc };
  };

  // Check the same paths again (a drive connected again), then the folder the files were
  // found in (files moved inside it).
  const lookAgain = async () => {
    setRepairNote(null);
    setRepairBusy(t("setup.checkingFiles"));
    try {
      const m = await api.models();
      setModels(m);
      if (m.missing.length === 0) {
        toastInfo(t("setup.allFilesBack"));
        await refresh();
        return;
      }
      if (m.scan_dir) {
        setRepairBusy(t("setup.lookingIn", { dir: m.scan_dir }));
        const r = await relocate(m, m.scan_dir);
        if (r.all) return;
        setRepairNote(r.found ? t("setup.foundSomeIn", { found: r.found, missing: r.missing, dir: m.scan_dir }) : t("setup.stillNotFound"));
        return;
      }
      setRepairNote(t("setup.stillNotFound"));
    } catch (e) {
      toastError(e);
    } finally {
      setRepairBusy(null);
    }
  };

  // Files moved to another folder: look for them there; otherwise choose them by hand.
  const searchElsewhere = async () => {
    const d = await native.pickFolder(models?.scan_dir ?? models?.user_scan_dir ?? undefined);
    if (!d || !models) return;
    setRepairNote(null);
    setRepairBusy(t("setup.lookingIn", { dir: d }));
    try {
      const r = await relocate(models, d);
      if (!r.all) {
        setRepairNote(r.found ? t("setup.foundSomeThere", { found: r.found, missing: r.missing }) : t("setup.notInFolder", { dir: d }));
        setScan(r.scan);
        showOwn();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setRepairBusy(null);
    }
  };

  // "Use models I already have", scrolled into view (it sits below the missing-files card).
  const showOwn = () => {
    setMode("own");
    window.setTimeout(() => document.getElementById("own-models")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const download = (target: "official" | "user") => {
    if (!preset) return;
    setMode(target === "official" ? "official" : "own");
    api.install(preset, backend ?? hw?.backend ?? "cuda", true, undefined, target).then(setInst, toastError);
  };

  const switchTo = async (profile: "official" | "user") => {
    setRepairBusy(profile === "user" ? t("setup.switchingToOwn") : t("setup.switchingToOfficial"));
    try {
      setModels(await api.useModels(profile));
      setMode(profile === "user" ? "own" : "official");
      await refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setRepairBusy(null);
    }
  };

  const back = () => setState({ needsSetup: false, setupMode: null });

  const start = async () => {
    try {
      if (hw && card !== null && card !== hw.gpu_in_use) await api.setGpu(card);
      const [cfg, st] = await Promise.all([api.config(), refreshStatus()]);
      // An engine update the user chose not to install now: don't open Setup for it again.
      const ui = { ...((cfg.ui ?? {}) as Record<string, unknown>) };
      if (st?.engine?.update_needed) ui.engineUpdateSkipped = st.engine.release;
      await api.saveConfig({ ...cfg, setupComplete: true, ui });
      setState({ needsSetup: false, setupMode: null });
      // On a Mac, the Mac engine offer first; then the model loads in the background (the status indicator shows it).
      afterStartScreens();
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };

  const chosen = hw?.presets.find((p) => p.id === preset) ?? null;
  const running = inst?.running ?? false;
  // A browser cannot pick files on the server: the official download only.
  const own = mode === "own" && !inBrowser;
  // Own files: what their profile needs, once saved and active (until then nothing to install).
  const ownActive = own && hw?.active_source === "user" && !!hw.user_files;
  // While (or after) installing this preset, show the live list; otherwise what is on disk.
  const installKey = own ? `user:${preset}` : preset;
  const live = !!inst && inst.preset === installKey && inst.items.length > 0 && (running || inst.items.some((i) => i.state !== "pending" && i.state !== "present"));
  const items = live ? inst!.items : own ? (ownActive ? hw!.user_files!.files : []) : chosen?.files ?? [];
  const missing = items.filter((i) => i.state !== "present" && i.state !== "done");
  const failed = items.filter((i) => i.state === "failed");
  const paused = !running && items.some((i) => i.state === "cancelled" || (i.state === "pending" && i.received > 0));
  const toDownload = missing.reduce((a, i) => a + Math.max(0, i.size - i.received), 0);
  const prog = installProgress(items);
  // Size of the official model files (for the choice between downloading and own files).
  const modelBytes = (chosen?.files ?? []).filter((f) => f.kind === "model").reduce((a, f) => a + f.size, 0);
  const diskNeeded = own ? hw?.user_files?.disk_bytes ?? 0 : chosen?.disk_bytes ?? 0;
  const lowSpace = hw?.free_bytes != null && chosen != null && hw.free_bytes < diskNeeded;
  // Own files not chosen yet: nothing to install, nothing ready.
  const presetInstalled = missing.length === 0 && (!own || ownActive);
  const repair = setupDone && !!models && models.missing.length > 0 && !running;
  // The other ways out of missing files, each saying what it does.
  const repairOptions: RepairOption[] = [];
  if (models) {
    const userActive = models.active.source === "user";
    if (!inBrowser) {
      repairOptions.push({ icon: <FolderOpen size={16} />, title: t("setup.optFindElsewhere"), detail: t("setup.optFindElsewhereDetail"), run: searchElsewhere });
      repairOptions.push({ icon: <FileSearch size={16} />, title: t("setup.optChooseOther"), detail: t("setup.optChooseOtherDetail"), run: showOwn });
    }
    if (userActive && models.downloadable.length > 0) {
      repairOptions.push({ icon: <Download size={16} />, title: t("setup.optDownloadMissing"), detail: t("setup.optDownloadMissingDetail", { files: models.downloadable.join(", ") }), run: () => download("user") });
    }
    if (userActive) {
      repairOptions.push(
        models.official_installed
          ? { icon: <ArrowLeftRight size={16} />, title: t("setup.optUseOfficial"), detail: t("setup.optUseOfficialDetail"), run: () => switchTo("official") }
          : { icon: <Download size={16} />, title: t("setup.optDownloadOfficial"), detail: hw?.sdcpp_dir ? t("setup.optDownloadOfficialTestedDetail", { size: formatBytes(modelBytes), dir: hw.sdcpp_dir }) : t("setup.optDownloadOfficialTestedDetailNoDir", { size: formatBytes(modelBytes) }), run: () => download("official") },
      );
    } else {
      repairOptions.push({ icon: <Download size={16} />, title: t("setup.optDownloadOfficial"), detail: hw?.sdcpp_dir ? t("setup.optDownloadOfficialDetail", { size: formatBytes(modelBytes), dir: hw.sdcpp_dir }) : t("setup.optDownloadOfficialDetailNoDir", { size: formatBytes(modelBytes) }), run: () => download("official") });
      if (models.user_installed) {
        repairOptions.push({ icon: <ArrowLeftRight size={16} />, title: t("setup.optUseOwnAgain"), detail: models.user_scan_dir ? t("setup.optUseOwnAgainDetail", { dir: models.user_scan_dir }) : t("setup.optUseOwnAgainDetailNoDir"), run: () => switchTo("user") });
      }
    }
  }
  const ready = !!report?.ready && !running;
  const rate = inst?.bytes_per_sec ?? 0;
  const vram = hw?.vram_mib ?? null;
  const engineMissing = missing.filter((i) => i.kind === "engine");

  return (
    <div className="setup">
      <div className="setup-inner">
        <div>
          <h1>{setupDone ? t("setup.titleModels") : t("setup.titleWelcome")}</h1>
          <p className="setup-lead">
            {own
              ? t("setup.leadOwn")
              : chosen
                ? t("setup.leadOfficial", { size: formatBytes(chosen.files.reduce((a, f) => a + f.size, 0)) })
                : t("setup.leadOfficialAbout")}
          </p>
        </div>

        {repair && (
          <Repair models={models!} busy={repairBusy} note={repairNote} onLookAgain={lookAgain} options={repairOptions} />
        )}

        {setupDone && engineUpdate?.update_needed && engineMissing.length > 0 && !running && (
          <div className="setup-note">
            {t("setup.promptPlusEngine", { size: formatBytes(engineMissing.reduce((a, i) => a + Math.max(0, i.size - i.received), 0)) })}
          </div>
        )}

        {!hw ? (
          <div className="setup-card">
            <Loader2 className="spin" size={18} /> {t("setup.checkingPc")}
          </div>
        ) : (
          <>
            <div className="setup-card setup-gpu">
              <strong>{hw.gpu ? hw.gpu.name : t("setup.noGpu")}</strong>
              <span className="muted">
                {memoryLine(hw, vram)}
              </span>
            </div>
            {!hw.gpu && (
              <div className="setup-note">
                {t("setup.noGpuNote")}
              </div>
            )}
            {hw.gpu?.unified ? (
              hw.gpu.memory_total_mib < 23 * 1024 ? (
                <div className="setup-note">
                  {t("setup.unifiedSlowNote", { memory: gb(hw.gpu.memory_total_mib) })}
                </div>
              ) : (
                hw.gpu.memory_total_mib < 31 * 1024 && (
                  <div className="setup-note">
                    {t("setup.unifiedMinutesNote", { memory: gb(hw.gpu.memory_total_mib) })}
                  </div>
                )
              )
            ) : (
              <>
                {vram !== null && vram < 7 * 1024 && <div className="setup-note">{t("setup.lowVramNote", { vram: gb(vram) })}</div>}
                {vram !== null && vram >= 7 * 1024 && vram < 10 * 1024 && (
                  <div className="setup-note">
                    {t("setup.vram8gbNote")}
                  </div>
                )}
                {hw.ram_total_mib < 15 * 1024 && <div className="setup-note">{t("setup.lowRamNote", { ram: gb(hw.ram_total_mib) })}</div>}
              </>
            )}

            {running || paused ? (
              <div className="muted">
                {t("setup.presetAndFolder", { preset: chosen?.label ?? "", dir: hw.sdcpp_dir })}
              </div>
            ) : (
              <>
                {/* Where the model comes from: the first choice, so it is seen first. A browser has only the download. */}
                {!inBrowser && <div className="field">
                  <span>{t("setup.imageModel")}</span>
                  <div className="choice-cards" role="radiogroup">
                    <button className={`choice-card ${!own ? "on" : ""}`} role="radio" aria-checked={!own} onClick={() => setMode("official")}>
                      <Download size={20} />
                      <div>
                        <strong>{t("setup.downloadModel")}</strong>
                        <span>{modelBytes ? t("setup.downloadModelDetailSize", { size: formatBytes(modelBytes) }) : t("setup.downloadModelDetail")}</span>
                      </div>
                    </button>
                    {!inBrowser && (
                      <button className={`choice-card ${own ? "on" : ""}`} role="radio" aria-checked={own} onClick={() => setMode("own")}>
                        <FolderOpen size={20} />
                        <div>
                          <strong>{t("setup.useOwnModels")}</strong>
                          <span>{t("setup.useOwnModelsDetail")}</span>
                        </div>
                      </button>
                    )}
                  </div>
                </div>}
                {own && models && (
                  <div id="own-models">
                    <OwnModels
                      // A new set of files (saved, found again): start from it, not from the old choices.
                      key={models.active.id + models.slots.map((x) => `${x.path}:${x.exists}`).join("|")}
                      models={models}
                      officialFiles={(chosen?.files ?? []).filter((f) => f.kind === "model")}
                      vramMib={vram}
                      backend={backend ?? hw?.backend}
                      initialScan={scan}
                      onSaved={async (m) => {
                        setModels(m);
                        setScan(null);
                        await refresh();
                      }}
                    />
                  </div>
                )}
                {hw.gpus.length > 1 && (
                  <label className="field">
                    <span>{t("setup.graphicsCard")}</span>
                    <select
                      className="select"
                      value={hw.gpu_index}
                      onChange={(e) => {
                        const i = Number(e.target.value);
                        setCard(i);
                        setPreset(null); // the recommendation follows the card
                        refresh(backend, i);
                      }}
                    >
                      {hw.gpus.map((g, i) => (
                        <option key={i} value={i}>
                          {i === hw.gpu_in_use && setupDone
                            ? t("setup.gpuOptionInUse", { name: g.name, memory: gb(g.memory_total_mib) })
                            : t("setup.gpuOption", { name: g.name, memory: gb(g.memory_total_mib) })}
                        </option>
                      ))}
                    </select>
                    <span className="muted">{t("setup.oneCardNote")}</span>
                  </label>
                )}
                {hw.gpu && (
                  <div className="field">
                    <span>{t("setup.engine")}</span>
                    <Seg<GpuBackend>
                      value={backend ?? hw.backend}
                      options={engineOptions(hw.vendor)}
                      onChange={(b) => {
                        setBackend(b);
                        refresh(b, card);
                      }}
                    />
                    <span className="muted">{engineNote(backend ?? hw.backend, hw.nvidia)}</span>
                  </div>
                )}
                <div className="field">
                  <span>{hw.gpu?.unified ? t("setup.presetMac") : t("setup.presetGpu")}</span>
                  <Seg<string> value={preset ?? hw.recommended} options={hw.presets.map((p) => ({ value: p.id, label: p.label }))} onChange={setPreset} />
                  {chosen && own && <span className="muted">{t("setup.presetOwnNote")}</span>}
                  {chosen && !own && (
                    <span className="muted">
                      {chosen.summary}.{chosen.id === hw.recommended ? ` ${t("setup.recommendedForGpu")}` : ""}
                      {hw.gpu?.unified ? ` ${t("setup.notTestedMac")}` : chosen.verified ? "" : chosen.id === "8gb" ? ` ${t("setup.betaUserTested")}` : ` ${t("setup.notTestedCardSize")}`}
                    </span>
                  )}
                  {hw.gpu?.unified && (
                    <span className="muted">
                      {t("setup.macPresetNote")}
                    </span>
                  )}
                </div>
                <div className="field">
                  <span>{t("setup.installFolder")}</span>
                  <div className="path-row">
                    <input className="input" type="text" value={hw.sdcpp_dir} readOnly spellCheck={false} />
                    {!inBrowser && (
                      <button className="btn" onClick={chooseFolder}>
                        {t("setup.change")}
                      </button>
                    )}
                  </div>
                  <span className="muted">
                    {hw.free_bytes != null ? t("setup.freeSpace", { size: formatBytes(hw.free_bytes) }) : ""}
                    {chosen && chosen.disk_bytes > 0 ? ` · ${t("setup.needsAbout", { size: formatBytes(chosen.disk_bytes) })}` : ""}
                    {lowSpace ? ` — ${t("setup.notEnoughSpace")}` : ""}
                  </span>
                </div>
              </>
            )}

            {/* Progress panel while installing or paused. */}
            {(running || paused) && (
              <div className="setup-card setup-progress">
                <div className="setup-progress-head">
                  <span className="pct">{Math.floor(prog.frac * 100)}%</span>
                  <span className="muted">
                    {t("setup.progress", { received: formatBytes(prog.received), total: formatBytes(prog.total) })}
                    {running && rate > 0 ? ` · ${t("setup.rate", { rate: formatBytes(rate) })}` : ""}
                    {running ? (installTimeLeft(prog.total - prog.received, rate) ? ` · ${installTimeLeft(prog.total - prog.received, rate)}` : "") : ` · ${t("setup.paused")}`}
                  </span>
                </div>
                <div className="progress thick">
                  <i style={{ width: `${prog.frac * 100}%` }} />
                </div>
                <span className="muted">{running ? installStep(items) ?? t("setup.starting") : t("setup.resumeNote")}</span>
                <div>
                  {running ? (
                    <button className="btn" onClick={() => api.cancelInstall().then(setInst, toastError)}>
                      <Pause size={14} /> {t("setup.pause")}
                    </button>
                  ) : (
                    <button className="btn primary" onClick={install} disabled={lowSpace}>
                      <Play size={14} /> {t("setup.resume")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {failed.length > 0 && !running && (
              <div className="setup-note">
                <div style={{ marginBottom: 8 }}>
                  {t("setup.failedNote", { count: failed.length })}
                </div>
                {failed.map((it) => (
                  <Failure key={it.id} it={it} issuesUrl={hw.issues_url} />
                ))}
              </div>
            )}

            {checking && !running ? (
              // Checking the files and the engine takes a few seconds: say so.
              <div className="setup-card setup-ready">
                <Loader2 className="spin" size={18} />
                <span>{t("setup.checkingFilesEngine")}</span>
              </div>
            ) : (
              presetInstalled &&
              !running && (
                <div className="setup-card setup-ready">
                  <Check size={18} />
                  <span>{hw.current === chosen?.id || !chosen ? t("setup.allInstalled") : t("setup.presetFilesHere", { preset: chosen.label })}</span>
                </div>
              )
            )}
            {presetInstalled && !running && !setupDone && <ReadyTips />}
            {(running || paused) && <Showcase />}

            {/* What gets installed (nothing to list while own files are being chosen). */}
            {items.length > 0 && (
              <div className="field">
                <button className="setup-toggle" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles || running}>
                  <ChevronDown size={14} style={{ transform: showFiles || running ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }} />
                  {missing.length ? t("setup.filesToDownload", { count: items.length, size: formatBytes(toDownload) }) : t("setup.filesAllInstalled", { count: items.length })}
                </button>
                {(showFiles || running) && <FileList items={items} />}
              </div>
            )}
          </>
        )}

        <div className="setup-actions">
          {hw && !running && !paused && !presetInstalled && (!own || ownActive) && (
            <button className="btn primary big" disabled={!chosen || lowSpace} onClick={install}>
              <Download size={16} /> {failed.length ? t("common.retry") : t("setup.install", { size: formatBytes(toDownload) })}
            </button>
          )}
          {hw && presetInstalled && !running && chosen && (hw.current !== chosen.id || hw.current_backend !== hw.backend || (!own && hw.active_source === "user")) && (
            // Files of another preset or engine are already here: switch without downloading.
            <button className="btn" onClick={install}>
              {!own && hw.active_source === "user"
                ? t("setup.useOfficialFiles")
                : hw.current_backend !== hw.backend
                  ? t("setup.useEngineWithPreset", { engine: { cuda: "CUDA", vulkan: "Vulkan", metal: "Metal" }[hw.backend], preset: chosen.label })
                  : t("setup.usePreset", { preset: chosen.label })}
            </button>
          )}
          {(ready || presetInstalled) && !running && (
            <button className={`btn big ${presetInstalled ? "primary" : ""}`} disabled={!ready || checking} onClick={start}>
              {setupDone ? t("common.done") : t("setup.start")}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {setupDone && (
            <button className="btn ghost" onClick={back} disabled={running}>
              <ArrowLeft size={14} /> {t("common.back")}
            </button>
          )}
          <button className="btn ghost" onClick={() => setState({ overlay: "settings" })} disabled={running}>
            <Settings2 size={14} /> {t("setup.settings")}
          </button>
          <button className="btn ghost" onClick={() => refresh()} disabled={checking || running}>
            <RefreshCw size={14} /> {t("setup.checkAgain")}
          </button>
        </div>

        {/* Files installed but something else stops the start (e.g. the GPU is not found). Not
            while own files are still being chosen, and not twice with the missing-files card. */}
        {report && !report.ready && !running && !paused && presetInstalled && !repair && !checking && (
          <div className="setup-note">
            <div style={{ marginBottom: 6 }}>{t("setup.cantStartYet")}</div>
            {report.checks
              .filter((c) => !c.ok)
              .map((c, i) => (
                <div key={i}>
                  <strong>{c.label}</strong>: {c.detail}
                </div>
              ))}
          </div>
        )}
        <p className="muted setup-foot">
          {t("setup.licenseFoot")}
        </p>
      </div>
    </div>
  );
}
