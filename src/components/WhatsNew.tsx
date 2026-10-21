import { CircleAlert, Layers, ListChecks, Paintbrush, WandSparkles, Wrench, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installProgress, installStep, installTimeLeft } from "../lib/logic";
import { refreshStatus, setState, toastError, useStore } from "../lib/store";
import type { GpuBackend, InstallItem, InstallStatus, ModelsStatus } from "../lib/types";
import { KokonMark } from "./Welcome";

/** The release these notes describe. Shown once to people updating from an earlier version. */
export const WHATS_NEW_VERSION = "0.10.0";

const NEWS = [
  {
    icon: WandSparkles,
    title: "Prompt+",
    text: "Turn on Prompt+ next to Quality: from a short idea in any language, the model writes a detailed prompt first (for edits it looks at your photo). You watch it being written. No second model to download.",
  },
  {
    icon: Layers,
    title: "Your own LoRAs (beta)",
    text: "Load Qwen-Image 2.1 LoRAs in Settings → LoRA, then turn them on for each project with the LoRA button, up to 3 at once. Tested on Windows so far: tell us how it goes on Mac and Linux.",
  },
  {
    icon: Paintbrush,
    title: "A new look",
    text: "A calmer, deeper design in light and dark, with Kokon's own window bar. Settings is now at the bottom of the sidebar.",
  },
  {
    icon: ListChecks,
    title: "Clean up in one go",
    text: "Press Select above your projects or in All images to remove several at once (or Ctrl/⌘-click, Shift-click for a range).",
  },
  {
    icon: Zap,
    title: "Faster on big cards",
    text: "With 24 GB of graphics memory or more, Fast images (and Balanced from 32 GB) finish a little sooner. Thanks to giveen.",
  },
  {
    icon: Wrench,
    title: "Fixes",
    text: "On Linux and Mac a crashed engine no longer leaves an image waiting forever (thanks to giveen). Kokon starts even if Windows reserves its ports. One percentage now covers the whole job.",
  },
];

/** Remembers that these notes were read and, if the engine update was postponed, for which
 * release, so neither is offered again at the next start. */
async function markSeen(engineSkipped: string | null) {
  try {
    const cfg = await api.config();
    const ui: Record<string, unknown> = { ...((cfg.ui ?? {}) as Record<string, unknown>), whatsNewSeen: WHATS_NEW_VERSION };
    if (engineSkipped) ui.engineUpdateSkipped = engineSkipped;
    await api.saveConfig({ ...cfg, ui });
  } catch (e) {
    toastError(e);
  }
}

/** Whether to show the notes at start: once per release after an update (not on a new install,
 * which gets the welcome screen), and again while a needed engine update was not postponed. */
export function whatsNewDue(ui: Record<string, unknown>, engine: { release: string; update_needed: boolean } | undefined): boolean {
  if (!ui.welcomeSeen) return false;
  return ui.whatsNewSeen !== WHATS_NEW_VERSION || (!!engine?.update_needed && ui.engineUpdateSkipped !== engine.release);
}

type Step = "engine" | "vae";

/** What's new in this release, plus the downloads it offers: the engine when the release needs
 * a newer stable-diffusion.cpp (only the files that changed), and the new VAE (#21), which
 * replaces the old one only if the user accepts. */
export function WhatsNew() {
  const engine = useStore((s) => s.status?.engine);
  const needsEngine = !!engine?.update_needed;
  const [missing, setMissing] = useState<InstallItem[] | null>(null);
  const [target, setTarget] = useState<{ preset: string; backend: GpuBackend } | null>(null);
  const [ms, setMs] = useState<ModelsStatus | null>(null);
  // With both offered, each can be left out.
  const [wantEngine, setWantEngine] = useState(true);
  const [wantVae, setWantVae] = useState(true);
  const [queue, setQueue] = useState<Step[]>([]);
  const [inst, setInst] = useState<InstallStatus | null>(null);
  const [finished, setFinished] = useState(false);

  useEffect(() => {
    api.models().then(setMs, () => {});
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
  const engineBytes = (missing ?? []).reduce((a, i) => a + Math.max(0, i.size - i.received), 0);
  const vaeBytes = ms?.vae.download_bytes ?? 0;

  const begin = async (step: Step) => {
    try {
      if (step === "engine") {
        if (!target) return false;
        setInst(await api.install(target.preset, target.backend, false));
      } else {
        setInst(await api.improveVae());
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
  const steps: Step[] = [...(needsEngine && wantEngine ? ["engine" as const] : []), ...(offerVae && wantVae ? ["vae" as const] : [])];
  const size = (steps.includes("engine") ? engineBytes : 0) + (steps.includes("vae") ? vaeBytes : 0);
  const offering = (needsEngine || offerVae) && !finished;
  // Macs default to Lanczos: their update has no Superscale-SP download.
  const getsSuperscale = (missing ?? []).some((i) => i.id === "upscaler_superscale");
  const both = needsEngine && offerVae;

  const update = async () => {
    const [first, ...rest] = steps;
    if (!first) return;
    setQueue(rest);
    await begin(first);
  };
  const close = (postponed: boolean) => {
    if (running) api.cancelInstall().catch(() => {});
    setState({ overlay: null });
    markSeen(postponed && engine && needsEngine ? engine.release : null);
    refreshStatus();
    api.startBackend().then(refreshStatus, () => refreshStatus());
  };

  return (
    <div className="modal-scrim">
      <div className="welcome" role="dialog" aria-label={`What's new in Kokon ${WHATS_NEW_VERSION}`}>
        <KokonMark size={44} />
        <h1>What's new in Kokon {WHATS_NEW_VERSION}</h1>
        <div className="welcome-grid">
          {NEWS.map(({ icon: Icon, title, text }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>{text}</span>
            </div>
          ))}
        </div>

        {offering && !running && (
          <div className="update-offers">
            {offerVae && (
              <div className="setup-note update-offer">
                {both && <input type="checkbox" checked={wantVae} onChange={(e) => setWantVae(e.target.checked)} aria-label="Include the new decoder" />}
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
                {both && <input type="checkbox" checked={wantEngine} onChange={(e) => setWantEngine(e.target.checked)} aria-label="Include the engine update" />}
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
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn primary big" disabled={running || !steps.length || (steps.includes("engine") && (!target || missing === null))} onClick={update}>
                {failed.length ? "Try again" : running ? "Updating…" : `Update now${size ? ` · ${formatBytes(size)}` : ""}`}
              </button>
              <button className="btn big" onClick={() => close(true)}>
                {offerVae && !needsEngine ? "Keep the current one" : "Later"}
              </button>
            </div>
            <span className="muted welcome-foot">You can update later from Settings → Models.</span>
          </div>
        )}
      </div>
    </div>
  );
}
