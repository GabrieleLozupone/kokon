import { CircleAlert, CirclePlay, FolderTree, Layers, Palette, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installProgress, installStep, installTimeLeft, modelChoiceUi, modelOfferDue, whatsNewDue as due } from "../lib/logic";
import { afterStartScreens, refreshStatus, setState, toastError, useStore } from "../lib/store";
import type { GpuBackend, InstallItem, InstallStatus, ModelsStatus } from "../lib/types";
import { native } from "../lib/native";
import { VIDEOS } from "../lib/videos";
import { KokonMark } from "./Welcome";

/** The release these notes describe. Shown once to people updating from an earlier version. */
export const WHATS_NEW_VERSION = "0.12.0";

const NEWS = [
  {
    icon: Layers,
    title: "Layers lab (experimental)",
    text: "Split a photo into layers: click the objects, Kokon cuts them out and fills the background behind them. Move, resize, hide or edit each one, draw new objects with the pencil, then save one image or a PSD for Photoshop.",
    video: VIDEOS.update012.url,
  },
  {
    icon: Sparkles,
    title: "Blend into scene (experimental)",
    text: "After moving objects around, Blend redraws the scene around them so they belong there: shadows on the ground, reflections, contact with what they stand on.",
  },
  {
    icon: Palette,
    title: "Paint with colours",
    text: "In a brushed edit, paint each thing in its own colour and say what goes there: several changes in one go. Select (S) picks an object with one click (its model is downloaded once, 44 MB).",
  },
  {
    icon: WandSparkles,
    title: "Prompt+ for areas and Expand",
    text: "Prompt+ now writes the prompt for a brushed area too (it names what to remove) and for Expand (what the new borders show), for you to check before it runs.",
  },
  {
    icon: ShieldCheck,
    title: "AI marking",
    text: "Every image Kokon makes says in its file, and in an invisible watermark, that it was made with AI, as the EU AI Act asks. Settings → General → Check an image reads both.",
  },
  {
    icon: FolderTree,
    title: "Tidier projects",
    text: "Projects are grouped by day, and several versions can be deleted at once: Ctrl- or Shift-click them in the timeline, then Delete.",
  },
];

/** Remembers that these notes were read and what was postponed (the engine update for its release, the model step),
 * so neither is offered again at the next start. */
async function markSeen(engineSkipped: string | null, model: Record<string, unknown>) {
  try {
    const cfg = await api.config();
    const ui: Record<string, unknown> = { ...((cfg.ui ?? {}) as Record<string, unknown>), whatsNewSeen: WHATS_NEW_VERSION, ...model };
    if (engineSkipped) ui.engineUpdateSkipped = engineSkipped;
    await api.saveConfig({ ...cfg, ui });
  } catch (e) {
    toastError(e);
  }
}

/** Whether to show the notes at start (see `logic.whatsNewDue`). */
export function whatsNewDue(ui: Record<string, unknown>, engine: { release: string; update_needed: boolean } | undefined): boolean {
  return due(ui, engine, WHATS_NEW_VERSION);
}

type Step = "engine" | "vae" | "model";

/** What's new in this release, plus the downloads it offers, each chosen separately: the engine when the release needs
 * a newer stable-diffusion.cpp (only the files that changed), the new VAE (#21) and the Q4_K_M image model, which
 * replace the old files only if the user accepts. Own model files are never switched: the model step is a suggestion. */
export function WhatsNew() {
  const engine = useStore((s) => s.status?.engine);
  const needsEngine = !!engine?.update_needed;
  const [missing, setMissing] = useState<InstallItem[] | null>(null);
  const [target, setTarget] = useState<{ preset: string; backend: GpuBackend } | null>(null);
  const [ms, setMs] = useState<ModelsStatus | null>(null);
  const [ui, setUi] = useState<Record<string, unknown> | null>(null);
  // With several offered, each can be left out.
  const [wantEngine, setWantEngine] = useState(true);
  const [wantVae, setWantVae] = useState(true);
  const [wantModel, setWantModel] = useState(true);
  const [queue, setQueue] = useState<Step[]>([]);
  const [inst, setInst] = useState<InstallStatus | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    api.models().then(setMs, () => {});
    api.config().then((c) => setUi((c.ui ?? {}) as Record<string, unknown>), () => setUi({}));
    api.installStatus().then((i) => i.running && setInst(i), () => {});
    if (!needsEngine) return;
    api.hardware().then((h) => {
      const preset = h.presets.find((p) => p.id === h.current) ?? h.presets.find((p) => p.id === h.recommended);
      setTarget(preset ? { preset: preset.id, backend: h.backend } : null);
      // With the user's own model files, the update downloads the engine, not official models.
      const files = h.active_source === "user" ? h.user_files?.files ?? [] : preset?.files ?? [];
      setMissing(files.filter((f) => f.state !== "present"));
    }, toastError);
  }, [needsEngine]);

  const offerVae = !!ms && !ms.vae.improved;
  const offerModel = !!ui && modelOfferDue(ms?.dit, ui, WHATS_NEW_VERSION);
  const ownModel = ms?.dit.update === "own";
  const engineBytes = (missing ?? []).reduce((a, i) => a + Math.max(0, i.size - i.received), 0);
  const vaeBytes = ms?.vae.download_bytes ?? 0;
  const modelBytes = ms?.dit.download_bytes ?? 0;

  const begin = async (step: Step) => {
    try {
      if (step === "engine") {
        if (!target) return false;
        setInst(await api.install(target.preset, target.backend, false));
      } else if (step === "vae") {
        setInst(await api.improveVae());
      } else {
        setInst(await api.newImageModel());
      }
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };

  // One download at a time: the next step starts when the previous one completed.
  const running = inst?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(
      () =>
        api.installStatus().then((i) => {
          setInst(i);
          if (i.running || !i.complete) return;
          const [next, ...rest] = queue;
          setQueue(rest);
          if (next) begin(next);
          else {
            setFinished(true);
            api.models().then(setMs, () => {});
          }
        }, () => {}),
      500,
    );
    return () => window.clearInterval(t);
  }, [running, queue]);

  const items = inst?.items ?? [];
  const failed = items.filter((i) => i.state === "failed");
  const prog = installProgress(items);
  // Smallest first; the image model last.
  const steps: Step[] = [
    ...(needsEngine && wantEngine ? ["engine" as const] : []),
    ...(offerVae && wantVae ? ["vae" as const] : []),
    ...(offerModel && wantModel ? ["model" as const] : []),
  ];
  const size = (steps.includes("engine") ? engineBytes : 0) + (steps.includes("vae") ? vaeBytes : 0) + (steps.includes("model") ? modelBytes : 0);
  const offering = (needsEngine || offerVae || offerModel) && !finished;
  // Macs default to Lanczos: their update has no Superscale-SP download.
  const getsSuperscale = (missing ?? []).some((i) => i.id === "upscaler_superscale");
  const several = [needsEngine, offerVae, offerModel].filter(Boolean).length > 1;
  const modelOnly = offerModel && !several;

  const update = async () => {
    const [first, ...rest] = steps;
    if (!first) return;
    setQueue(rest);
    await begin(first);
  };
  /** `keep`: an own-files user chose to keep their image model (never asked again). */
  const close = (postponed: boolean, keep = false) => {
    if (running) api.cancelInstall().catch(() => {});
    setState({ overlay: null });
    // A model step that did not happen (postponed or left out) waits for the next release.
    const modelUi = offerModel && (postponed || !wantModel) ? modelChoiceUi(keep ? "keep" : "later", WHATS_NEW_VERSION) : {};
    markSeen(postponed && engine && needsEngine ? engine.release : null, modelUi);
    refreshStatus();
    afterStartScreens();
  };

  return (
    <div className="modal-scrim">
      <div className="welcome" role="dialog" aria-label={`What's new in Kokon ${WHATS_NEW_VERSION}`}>
        <KokonMark size={44} />
        <h1>What's new in Kokon {WHATS_NEW_VERSION}</h1>
        <div className="welcome-grid">
          {NEWS.map(({ icon: Icon, title, text, video }: { icon: typeof Layers; title: string; text: string; video?: string }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>
                {text}
                {video && (
                  <>
                    {" "}
                    <button className="link-btn" onClick={() => native.openLink(video).catch(toastError)} title="On YouTube (opens in your browser)">
                      <CirclePlay size={13} /> Watch the 0.12 video
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>

        {offering && !running && (
          <div className="update-offers">
            {offerModel && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantModel} onChange={(e) => setWantModel(e.target.checked)} aria-label="Include the new image model file" />}
                <div>
                  <strong>
                    {ownModel ? "A newer image model file" : "New image model file"}
                    {modelBytes ? ` · ${formatBytes(modelBytes)}` : ""}
                  </strong>
                  <span>
                    {ownModel
                      ? "Your image model is the Q4_K file Kokon used before. Kokon now uses unsloth's Q4_K_M: better supported, slightly better, the same 4-bit size. Kokon can download it into its own folder and use it; your file stays where it is, untouched."
                      : "Kokon now uses unsloth's Q4_K_M of Qwen-Image 2.1 Turbo: better supported, slightly better, the same 4-bit size. The old file is deleted once the new one is downloaded and checked."}{" "}
                    You can also switch later in Settings → Models.
                  </span>
                  <details className="model-files">
                    <summary>Why change it?</summary>
                    <span className="update-detail">
                      Both are 4-bit copies of Qwen's Turbo model and look much the same. The Q4_K_M comes from unsloth, one of the most used sources of
                      GGUF models, and it is the file Kokon's tests and its Mac engine are checked against. Same license as the model.
                    </span>
                  </details>
                </div>
              </div>
            )}
            {offerVae && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantVae} onChange={(e) => setWantVae(e.target.checked)} aria-label="Include the new decoder" />}
                <div>
                  <strong>New image decoder{vaeBytes ? ` · ${formatBytes(vaeBytes)}` : ""}</strong>
                  <span>
                    For the cleaner images above, Kokon needs to replace the decoder it installed. The old file is deleted once the new one is in place.
                    {ms?.active.source === "user" && " Your own VAE file stays where it is: Kokon uses its own copy."} If you keep the current one, you can switch any time in
                    Settings → Models.
                  </span>
                  <details className="model-files">
                    <summary>What is it?</summary>
                    <span className="update-detail">
                      The decoder (VAE, variational autoencoder) turns the model's result into pixels. Qwen's original decoder leaves a faint 2-pixel checkerboard on fine
                      texture. This version, retrained by madebyollin (the author of TAESD), removes it: the image, its colours and the time stay the same. Same license as
                      the model.
                    </span>
                  </details>
                </div>
              </div>
            )}
            {needsEngine && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantEngine} onChange={(e) => setWantEngine(e.target.checked)} aria-label="Include the engine update" />}
                <div>
                  <strong>Engine update{engineBytes ? ` · ${formatBytes(engineBytes)}` : ""}</strong>
                  <span>
                    A newer stable-diffusion.cpp is ready, the engine that runs the models on your graphics chip{getsSuperscale ? ", plus the Superscale-SP model" : ""}.
                    Your images, models and settings stay as they are.
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {(running || (inst && !finished && !failed.length && !inst.complete)) && (
          <div className="setup-card setup-progress" style={{ width: "100%", textAlign: "left" }}>
            <div className="setup-progress-head">
              <span className="pct">{Math.floor(prog.frac * 100)}%</span>
              <span className="muted">
                {formatBytes(prog.received)} of {formatBytes(prog.total)}
                {installTimeLeft(prog.total - prog.received, inst?.bytes_per_sec ?? 0) ? ` · ${installTimeLeft(prog.total - prog.received, inst?.bytes_per_sec ?? 0)}` : ""}
              </span>
            </div>
            <div className="progress thick">
              <i style={{ width: `${prog.frac * 100}%` }} />
            </div>
            <span className="muted">{installStep(items) ?? "Starting…"}</span>
          </div>
        )}
        {failed.length > 0 && !running && (
          <div className="setup-note" style={{ width: "100%", textAlign: "left" }}>
            <CircleAlert size={14} /> {failed.map((f) => `${f.label}: ${f.error}`).join(" · ")}
            <div className="muted">Try again, or open Settings → Models to do it later.</div>
          </div>
        )}

        {!offering ? (
          <button className="btn primary big" onClick={() => close(false)}>
            {finished ? "Start creating" : "Got it"}
          </button>
        ) : (
          <div className="welcome-actions">
            <div className="welcome-buttons">
              <button className="btn primary big" disabled={running || !steps.length || (steps.includes("engine") && (!target || missing === null))} onClick={update}>
                {failed.length
                  ? "Try again"
                  : running
                    ? "Updating…"
                    : `${modelOnly ? (ownModel ? "Download Q4_K_M and use it" : "Update now and remove the old file") : "Update now"}${size ? ` · ${formatBytes(size)}` : ""}`}
              </button>
              <button className="btn big" onClick={() => close(true, modelOnly && ownModel)}>
                {modelOnly && ownModel ? "Keep using my file" : offerVae && !needsEngine && !offerModel ? "Keep the current one" : "Later"}
              </button>
            </div>
            <span className="muted welcome-foot">You can update later from Settings → Models.</span>
          </div>
        )}
      </div>
    </div>
  );
}
