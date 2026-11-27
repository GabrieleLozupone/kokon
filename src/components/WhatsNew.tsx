import { CircleAlert, CirclePlay, Cpu, Languages, Layers } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, installProgress, installStep, installTimeLeft, modelChoiceUi, modelOfferDue, whatsNewDue as due } from "../lib/logic";
import { afterStartScreens, refreshStatus, setState, toastError, useStore } from "../lib/store";
import type { GpuBackend, InstallItem, InstallStatus, ModelsStatus } from "../lib/types";
import { native } from "../lib/native";
import { KokonMark } from "./Welcome";
import { t } from "../lib/i18n";

/** The release these notes describe. Shown once to people updating from an earlier version. */
export const WHATS_NEW_VERSION = "0.13.0";

/** The notes, built at render time so they follow the UI language. */
function news(): { icon: typeof Layers; title: string; text: string; video?: string }[] {
  return [
    { icon: Languages, title: t("whatsNew.v0_13_0_languagesTitle"), text: t("whatsNew.v0_13_0_languagesText") },
    { icon: Cpu, title: t("whatsNew.v0_13_0_gpuTitle"), text: t("whatsNew.v0_13_0_gpuText") },
  ];
}

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

/** A label with its download size after it, when there is one. */
const withSize = (label: string, bytes: number) => (bytes ? t("whatsNew.withSize", { label, size: formatBytes(bytes) }) : label);

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
    const timer = window.setInterval(
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
    return () => window.clearInterval(timer);
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
      <div className="welcome" role="dialog" aria-label={t("whatsNew.heading", { version: WHATS_NEW_VERSION })}>
        <KokonMark size={44} />
        <h1>{t("whatsNew.heading", { version: WHATS_NEW_VERSION })}</h1>
        <div className="welcome-grid">
          {news().map(({ icon: Icon, title, text, video }) => (
            <div className="welcome-item" key={title}>
              <Icon size={20} />
              <strong>{title}</strong>
              <span>
                {text}
                {video && (
                  <>
                    {" "}
                    <button className="link-btn" onClick={() => native.openLink(video).catch(toastError)} title={t("whatsNew.onYouTube")}>
                      <CirclePlay size={13} /> {t("whatsNew.watchVideo", { version: "0.12" })}
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
                {several && <input type="checkbox" checked={wantModel} onChange={(e) => setWantModel(e.target.checked)} aria-label={t("whatsNew.includeModel")} />}
                <div>
                  <strong>{withSize(ownModel ? t("whatsNew.modelTitleOwn") : t("whatsNew.modelTitle"), modelBytes)}</strong>
                  <span>
                    {ownModel ? t("whatsNew.modelBodyOwn") : t("whatsNew.modelBody")}
                  </span>
                  <details className="model-files">
                    <summary>{t("whatsNew.modelWhy")}</summary>
                    <span className="update-detail">
                      {t("whatsNew.modelWhyText")}
                    </span>
                  </details>
                </div>
              </div>
            )}
            {offerVae && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantVae} onChange={(e) => setWantVae(e.target.checked)} aria-label={t("whatsNew.includeVae")} />}
                <div>
                  <strong>{withSize(t("whatsNew.vaeTitle"), vaeBytes)}</strong>
                  <span>
                    {ms?.active.source === "user" ? t("whatsNew.vaeBodyOwn") : t("whatsNew.vaeBody")}
                  </span>
                  <details className="model-files">
                    <summary>{t("whatsNew.vaeWhat")}</summary>
                    <span className="update-detail">
                      {t("whatsNew.vaeWhatText")}
                    </span>
                  </details>
                </div>
              </div>
            )}
            {needsEngine && (
              <div className="setup-note update-offer">
                {several && <input type="checkbox" checked={wantEngine} onChange={(e) => setWantEngine(e.target.checked)} aria-label={t("whatsNew.includeEngine")} />}
                <div>
                  <strong>{withSize(t("whatsNew.engineTitle"), engineBytes)}</strong>
                  <span>
                    {getsSuperscale ? t("whatsNew.engineBodySuperscale") : t("whatsNew.engineBody")}
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
                {installTimeLeft(prog.total - prog.received, inst?.bytes_per_sec ?? 0)
                  ? t("whatsNew.progressLeft", { received: formatBytes(prog.received), total: formatBytes(prog.total), left: installTimeLeft(prog.total - prog.received, inst?.bytes_per_sec ?? 0) ?? "" })
                  : t("whatsNew.progress", { received: formatBytes(prog.received), total: formatBytes(prog.total) })}
              </span>
            </div>
            <div className="progress thick">
              <i style={{ width: `${prog.frac * 100}%` }} />
            </div>
            <span className="muted">{installStep(items) ?? t("whatsNew.starting")}</span>
          </div>
        )}
        {failed.length > 0 && !running && (
          <div className="setup-note" style={{ width: "100%", textAlign: "left" }}>
            <CircleAlert size={14} /> {failed.map((f) => `${f.label}: ${f.error}`).join(" · ")}
            <div className="muted">{t("whatsNew.failedHint")}</div>
          </div>
        )}

        {!offering ? (
          <button className="btn primary big" onClick={() => close(false)}>
            {finished ? t("whatsNew.startCreating") : t("whatsNew.gotIt")}
          </button>
        ) : (
          <div className="welcome-actions">
            <div className="welcome-buttons">
              <button className="btn primary big" disabled={running || !steps.length || (steps.includes("engine") && (!target || missing === null))} onClick={update}>
                {failed.length
                  ? t("common.retry")
                  : running
                    ? t("whatsNew.updating")
                    : withSize(modelOnly ? (ownModel ? t("whatsNew.downloadQ4KM") : t("whatsNew.updateRemoveOld")) : t("whatsNew.updateNow"), size)}
              </button>
              <button className="btn big" onClick={() => close(true, modelOnly && ownModel)}>
                {modelOnly && ownModel ? t("whatsNew.keepMyFile") : offerVae && !needsEngine && !offerModel ? t("whatsNew.keepCurrent") : t("whatsNew.later")}
              </button>
            </div>
            <span className="muted welcome-foot">{t("whatsNew.updateLaterHint")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
