import { ArrowLeft, ArrowLeftRight, Bug, Check, ChevronDown, CircleAlert, Download, ExternalLink, FileSearch, FolderOpen, Loader2, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installItemShort, installProgress, installStep, installTimeLeft } from "../lib/logic";
import { native } from "../lib/native";
import { refreshStatus, setState, toastError, toastInfo, useStore } from "../lib/store";
import type { GpuBackend, HardwareReport, InstallItem, InstallStatus, ModelScan, ModelSlot, ModelsStatus, SetupReport } from "../lib/types";
import { OwnModels } from "./OwnModels";
import { Seg } from "./ui";
import { ReadyTips, Showcase } from "./Welcome";

const gb = (mib: number) => `${Math.round(mib / 1024)} GB`;

function engineOptions(vendor: string | null): { value: GpuBackend; label: string }[] {
  if (vendor === "apple") return [{ value: "metal", label: "Metal (beta)" }];
  const vulkan = { value: "vulkan" as GpuBackend, label: vendor === "nvidia" ? "Vulkan" : "Vulkan (beta)" };
  return vendor === "nvidia" ? [{ value: "cuda", label: "CUDA" }, vulkan] : [vulkan];
}

function engineNote(b: GpuBackend, nvidia: boolean): string {
  if (b === "cuda") return "NVIDIA's CUDA build: the fastest and tested path. Recommended.";
  if (b === "metal") return "Beta. Runs on the Mac's GPU through Metal. Needs macOS 15 or newer.";
  return nvidia
    ? "The same model through Vulkan: works on NVIDIA, but slower than CUDA (no SageAttention) and the first image takes longer. Useful to try the AMD / Intel path; both engines can stay installed."
    : "Beta. AMD and Intel cards run the model through Vulkan, with the graphics driver you already have. Not yet tested on a real AMD or Intel card: please report how it goes.";
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
          <ExternalLink size={14} /> Download page
        </button>
        <button className="btn" onClick={() => native.openFolder(folder).catch(toastError)}>
          <FolderOpen size={14} /> Open folder
        </button>
        <button className="btn" onClick={() => native.openLink(issuesUrl).catch(toastError)}>
          <Bug size={14} /> Report the problem
        </button>
      </div>
    </div>
  );
}

function FileList({ items }: { items: InstallItem[] }) {
  return (
    <div className="setup-files">
      {items.map((it) => (
        <div className={`setup-file ${it.state}`} key={it.id}>
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
      <strong>{n === 1 ? "Kokon can't find a model file" : `Kokon can't find ${n} model files`}</strong>
      {models.missing.map((m) => (
        <div className="missing" key={m.path}>
          {m.label}: {m.path}
        </div>
      ))}
      <span>
        If they are on a drive that is not connected, connect it first.
        {models.scan_dir ? ` Kokon checks again and also looks for them in ${models.scan_dir}, in case they were moved.` : ""}
      </span>
      <div className="actions">
        <button className="btn primary" onClick={props.onLookAgain} disabled={!!props.busy}>
          {props.busy ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />} {props.busy ?? "Look for them again"}
        </button>
        {props.note && !props.busy && <span className="repair-result">{props.note}</span>}
      </div>
      {props.options.length > 0 && (
        <div className="repair-options">
          <span className="muted">Or:</span>
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
    const t = window.setInterval(() => api.installStatus().then(setInst, () => {}), 500);
    return () => window.clearInterval(t);
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
      toastInfo(found.length === 1 ? `Found the missing file in ${dir}. It is used from there now.` : `Found the ${found.length} missing files in ${dir}. They are used from there now.`);
      await refresh();
    }
    return { all, found: found.length, missing: missing.length, scan: sc };
  };

  // Check the same paths again (a drive connected again), then the folder the files were
  // found in (files moved inside it).
  const lookAgain = async () => {
    setRepairNote(null);
    setRepairBusy("Checking the files…");
    try {
      const m = await api.models();
      setModels(m);
      if (m.missing.length === 0) {
        toastInfo("All model files are there again.");
        await refresh();
        return;
      }
      if (m.scan_dir) {
        setRepairBusy(`Looking in ${m.scan_dir}…`);
        const r = await relocate(m, m.scan_dir);
        if (r.all) return;
        setRepairNote(r.found ? `Found ${r.found} of ${r.missing} in ${m.scan_dir}. Choose one of the options below for the others.` : "Still not found. If they are on a drive, connect it and try again, or choose one of the options below.");
        return;
      }
      setRepairNote("Still not found. If they are on a drive, connect it and try again, or choose one of the options below.");
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
    setRepairBusy(`Looking in ${d}…`);
    try {
      const r = await relocate(models, d);
      if (!r.all) {
        setRepairNote(r.found ? `Found ${r.found} of ${r.missing} in that folder: choose the others in "Your files" below.` : `They are not in ${d}. Choose the files in "Your files" below.`);
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
    setRepairBusy(profile === "user" ? "Switching to your files…" : "Switching to the official model…");
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
      // Load the model in the background; the status indicator shows progress.
      api.startBackend().then(refreshStatus, toastError);
      refreshStatus();
    } catch (e) {
      toastError(e);
    }
  };

  const chosen = hw?.presets.find((p) => p.id === preset) ?? null;
  const running = inst?.running ?? false;
  const own = mode === "own";
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
    repairOptions.push({ icon: <FolderOpen size={16} />, title: "Find them in another folder", detail: "If you moved your models: Kokon looks for the same files there.", run: searchElsewhere });
    repairOptions.push({ icon: <FileSearch size={16} />, title: "Choose other files", detail: "Pick the files yourself, below.", run: showOwn });
    if (userActive && models.downloadable.length > 0) {
      repairOptions.push({ icon: <Download size={16} />, title: "Download the missing files", detail: `The official ${models.downloadable.join(", ")}, saved where the missing file was.`, run: () => download("user") });
    }
    if (userActive) {
      repairOptions.push(
        models.official_installed
          ? { icon: <ArrowLeftRight size={16} />, title: "Use the official model", detail: "Already downloaded: switch to it. Your files stay set up.", run: () => switchTo("official") }
          : { icon: <Download size={16} />, title: "Download the official model", detail: `${formatBytes(modelBytes)}, tested with Kokon, into ${hw?.sdcpp_dir ?? "the install folder"}.`, run: () => download("official") },
      );
    } else {
      repairOptions.push({ icon: <Download size={16} />, title: "Download the official model", detail: `${formatBytes(modelBytes)}, into ${hw?.sdcpp_dir ?? "the install folder"}.`, run: () => download("official") });
      if (models.user_installed) {
        repairOptions.push({ icon: <ArrowLeftRight size={16} />, title: "Use your own files again", detail: models.user_scan_dir ? `The ones in ${models.user_scan_dir}.` : "The files you chose before.", run: () => switchTo("user") });
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
          <h1>{setupDone ? "Models" : "Welcome to Kokon"}</h1>
          <p className="setup-lead">
            {own
              ? "Everything runs on this PC. Use the Qwen-Image 2.1 files you already have, for example from ComfyUI: Setup only downloads the engine and what you don't have."
              : `Everything runs on this PC. Setup downloads the image model once (${chosen ? formatBytes(chosen.files.reduce((a, f) => a + f.size, 0)) : "about 12 GB"}); after that, nothing leaves your computer.`}
          </p>
        </div>

        {repair && (
          <Repair models={models!} busy={repairBusy} note={repairNote} onLookAgain={lookAgain} options={repairOptions} />
        )}

        {setupDone && engineUpdate?.update_needed && engineMissing.length > 0 && !running && (
          <div className="setup-note">
            This version of Kokon brings Prompt+, which needs Kokon&apos;s updated engine: press Install to download it (
            {formatBytes(engineMissing.reduce((a, i) => a + Math.max(0, i.size - i.received), 0))}). Until then, everything else works as before and Prompt+ stays hidden.
          </div>
        )}

        {!hw ? (
          <div className="setup-card">
            <Loader2 className="spin" size={18} /> Checking this PC…
          </div>
        ) : (
          <>
            <div className="setup-card setup-gpu">
              <strong>{hw.gpu ? hw.gpu.name : "No graphics card found"}</strong>
              <span className="muted">
                {hw.gpu?.unified
                  ? `${gb(hw.gpu.memory_total_mib)} unified memory${hw.vram_simulated ? ` (planning as ${gb(vram ?? 0)})` : ""}`
                  : `${vram ? `${gb(vram)} VRAM${hw.vram_simulated ? " (simulated)" : ""} · ` : ""}${gb(hw.ram_total_mib)} RAM`}{hw.gpu?.driver_version ? ` · driver ${hw.gpu.driver_version}` : ""}
              </span>
            </div>
            {!hw.gpu && (
              <div className="setup-note">
                Kokon needs a graphics card with at least 12 GB of VRAM: NVIDIA (RTX 20 series or newer), or AMD / Intel through Vulkan (beta), or a Mac with Apple Silicon. Make sure its driver is installed.
              </div>
            )}
            {hw.gpu?.unified ? (
              hw.gpu.memory_total_mib < 23 * 1024 ? (
                <div className="setup-note">
                  With {gb(hw.gpu.memory_total_mib)} of unified memory Kokon works, but slowly: model weights are read from disk as needed and images are made at about 1 megapixel, which takes about 4 to 5 minutes on an M2 Pro. 32 GB or more and a Pro, Max or Ultra chip are recommended. Close other apps while generating.
                </div>
              ) : (
                hw.gpu.memory_total_mib < 31 * 1024 && (
                  <div className="setup-note">
                    With {gb(hw.gpu.memory_total_mib)} of unified memory expect several minutes per image. 32 GB or more and a Pro, Max or Ultra chip are recommended.
                  </div>
                )
              )
            ) : (
              <>
                {vram !== null && vram < 7 * 1024 && <div className="setup-note">Your GPU has {gb(vram)} of VRAM. 8 GB is the smallest size Kokon runs on (in beta); it may fail or run slowly.</div>}
                {vram !== null && vram >= 7 * 1024 && vram < 10 * 1024 && (
                  <div className="setup-note">
                    8 GB graphics cards are in beta: images are made at about 1 megapixel, and an edit takes 1–2 minutes on an RTX 5050 Laptop. Tell us how it runs on yours.
                  </div>
                )}
                {hw.ram_total_mib < 15 * 1024 && <div className="setup-note">The text encoder runs from system RAM; with {gb(hw.ram_total_mib)} of RAM, 16 GB or more is recommended.</div>}
              </>
            )}

            {running || paused ? (
              <div className="muted">
                {chosen?.label} preset · {hw.sdcpp_dir}
              </div>
            ) : (
              <>
                {/* Where the model comes from: the first choice, so it is seen first. */}
                <div className="field">
                  <span>Image model</span>
                  <div className="choice-cards" role="radiogroup">
                    <button className={`choice-card ${!own ? "on" : ""}`} role="radio" aria-checked={!own} onClick={() => setMode("official")}>
                      <Download size={20} />
                      <div>
                        <strong>Download the model</strong>
                        <span>Qwen-Image 2.1 Turbo, tested with Kokon{modelBytes ? ` · ${formatBytes(modelBytes)}` : ""}</span>
                      </div>
                    </button>
                    <button className={`choice-card ${own ? "on" : ""}`} role="radio" aria-checked={own} onClick={() => setMode("own")}>
                      <FolderOpen size={20} />
                      <div>
                        <strong>Use models I already have</strong>
                        <span>From ComfyUI or another folder; only the engine is downloaded</span>
                      </div>
                    </button>
                  </div>
                </div>
                {own && models && (
                  <div id="own-models">
                    <OwnModels
                      // A new set of files (saved, found again): start from it, not from the old choices.
                      key={models.active.id + models.slots.map((x) => `${x.path}:${x.exists}`).join("|")}
                      models={models}
                      officialFiles={(chosen?.files ?? []).filter((f) => f.kind === "model")}
                      vramMib={vram}
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
                    <span>Graphics card</span>
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
                          {g.name} · {gb(g.memory_total_mib)}
                          {i === hw.gpu_in_use && setupDone ? " (in use)" : ""}
                        </option>
                      ))}
                    </select>
                    <span className="muted">Kokon runs on one card. The preset is sized for the card you pick; you can change it later in Settings → Performance.</span>
                  </label>
                )}
                {hw.gpu && (
                  <div className="field">
                    <span>Engine</span>
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
                  <span>{hw.gpu?.unified ? "Preset for your Mac's memory" : "Preset for your graphics card"}</span>
                  <Seg<string> value={preset ?? hw.recommended} options={hw.presets.map((p) => ({ value: p.id, label: p.label }))} onChange={setPreset} />
                  {chosen && own && <span className="muted">How Kokon runs the model on your card: memory use and image sizes. Your files are kept.</span>}
                  {chosen && !own && (
                    <span className="muted">
                      {chosen.summary}.{chosen.id === hw.recommended ? " Recommended for your GPU." : ""}
                      {hw.gpu?.unified ? " Not yet tested on a Mac." : chosen.verified ? "" : chosen.id === "8gb" ? " Beta: tested by users, not yet by us." : " Not yet tested on a real card of this size."}
                    </span>
                  )}
                  {hw.gpu?.unified && (
                    <span className="muted">
                      Presets are named by total unified memory. macOS lets the graphics part use about two thirds of it, and the text encoder shares the same memory, so the image model gets less than the number on your Mac: a 16 GB Mac has room for the lightest preset only. Pick a larger one only on a Mac with that much memory.
                    </span>
                  )}
                </div>
                <div className="field">
                  <span>Install folder</span>
                  <div className="path-row">
                    <input className="input" type="text" value={hw.sdcpp_dir} readOnly spellCheck={false} />
                    <button className="btn" onClick={chooseFolder}>
                      Change
                    </button>
                  </div>
                  <span className="muted">
                    {hw.free_bytes != null ? `${formatBytes(hw.free_bytes)} free` : ""}
                    {chosen && chosen.disk_bytes > 0 ? ` · needs about ${formatBytes(chosen.disk_bytes)}` : ""}
                    {lowSpace ? " — not enough space on this drive; choose another folder." : ""}
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
                    {formatBytes(prog.received)} of {formatBytes(prog.total)}
                    {running && rate > 0 ? ` · ${formatBytes(rate)}/s` : ""}
                    {running ? (installTimeLeft(prog.total - prog.received, rate) ? ` · ${installTimeLeft(prog.total - prog.received, rate)}` : "") : " · paused"}
                  </span>
                </div>
                <div className="progress thick">
                  <i style={{ width: `${prog.frac * 100}%` }} />
                </div>
                <span className="muted">{running ? installStep(items) ?? "Starting…" : "Downloads continue where they stopped, also after closing the app."}</span>
                <div>
                  {running ? (
                    <button className="btn" onClick={() => api.cancelInstall().then(setInst, toastError)}>
                      <Pause size={14} /> Pause
                    </button>
                  ) : (
                    <button className="btn primary" onClick={install} disabled={lowSpace}>
                      <Play size={14} /> Resume
                    </button>
                  )}
                </div>
              </div>
            )}

            {failed.length > 0 && !running && (
              <div className="setup-note">
                <div style={{ marginBottom: 8 }}>
                  {failed.length === 1 ? "One file" : `${failed.length} files`} could not be downloaded. Try again, or get {failed.length === 1 ? "it" : "them"} by hand and press Check again.
                  Please report a broken link so it can be fixed for everyone.
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
                <span>Checking the model files and the engine…</span>
              </div>
            ) : (
              presetInstalled &&
              !running && (
                <div className="setup-card setup-ready">
                  <Check size={18} />
                  <span>{hw.current === chosen?.id || !chosen ? "Everything is installed." : `The ${chosen.label} files are already here.`}</span>
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
                  {items.length} files · {missing.length ? `${formatBytes(toDownload)} to download` : "all installed"}
                </button>
                {(showFiles || running) && <FileList items={items} />}
              </div>
            )}
          </>
        )}

        <div className="setup-actions">
          {hw && !running && !paused && !presetInstalled && (!own || ownActive) && (
            <button className="btn primary big" disabled={!chosen || lowSpace} onClick={install}>
              <Download size={16} /> {failed.length ? "Try again" : `Install · ${formatBytes(toDownload)}`}
            </button>
          )}
          {hw && presetInstalled && !running && chosen && (hw.current !== chosen.id || hw.current_backend !== hw.backend || (!own && hw.active_source === "user")) && (
            // Files of another preset or engine are already here: switch without downloading.
            <button className="btn" onClick={install}>
              {!own && hw.active_source === "user"
                ? "Use the official files"
                : hw.current_backend !== hw.backend
                  ? `Use ${{ cuda: "CUDA", vulkan: "Vulkan", metal: "Metal" }[hw.backend]} with the ${chosen.label} preset`
                  : `Use the ${chosen.label} preset`}
            </button>
          )}
          {(ready || presetInstalled) && !running && (
            <button className={`btn big ${presetInstalled ? "primary" : ""}`} disabled={!ready || checking} onClick={start}>
              {setupDone ? "Done" : "Start"}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {setupDone && (
            <button className="btn ghost" onClick={back} disabled={running}>
              <ArrowLeft size={14} /> Back
            </button>
          )}
          <button className="btn ghost" onClick={() => setState({ overlay: "settings" })} disabled={running}>
            <Settings2 size={14} /> Settings
          </button>
          <button className="btn ghost" onClick={() => refresh()} disabled={checking || running}>
            <RefreshCw size={14} /> Check again
          </button>
        </div>

        {/* Files installed but something else stops the start (e.g. the GPU is not found). Not
            while own files are still being chosen, and not twice with the missing-files card. */}
        {report && !report.ready && !running && !paused && presetInstalled && !repair && !checking && (
          <div className="setup-note">
            <div style={{ marginBottom: 6 }}>Kokon can't start yet:</div>
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
          Qwen-Image 2.1 Turbo is released by Alibaba's Qwen team under the Qwen Research License: research and evaluation only, no commercial use. By downloading it you accept that license. The upscalers are Superscale-SP by Nmkd
          (WTFPL) and the experimental 4xNomos2_hq_mosr by Philip Hofmann (CC BY 4.0). Downloads come only from GitHub (stable-diffusion.cpp, upscaler) and Hugging Face, and every file is verified with its SHA-256 checksum.
        </p>
      </div>
    </div>
  );
}
