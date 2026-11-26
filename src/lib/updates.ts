// In-app updates (Tauri updater): checks GitHub for latest.json at most once a day (unless the
// user turned it off), then downloads, verifies the signature, stops the local service and
// installs with one click. The request carries nothing about the user or their images.

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { type Update, check } from "@tauri-apps/plugin-updater";
import { api } from "./api";
import { t } from "./i18n";
import { inBrowser } from "./platform";
import { getState, setState, toastError, toastInfo } from "./store";

const DAY_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "kokon.lastUpdateCheck";
let pending: Update | null = null;

/** The automatic check is on unless the user turned it off (config `ui.updateCheck`). */
export function autoCheckEnabled(ui: Record<string, unknown> | null | undefined): boolean {
  return ui?.updateCheck !== false;
}

/** Due when the last check is older than a day (or unknown). */
export function checkDue(lastCheck: number | null, now: number): boolean {
  return lastCheck == null || !Number.isFinite(lastCheck) || now - lastCheck >= DAY_MS;
}

function readLastCheck(): number | null {
  try {
    const v = localStorage.getItem(LAST_CHECK_KEY);
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

function writeLastCheck(when: number) {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(when));
  } catch {
    /* only means checking again next start */
  }
}

/** Looks for an update. `manual`: from Settings, so report the outcome (and errors). */
export async function checkForUpdate(manual = false): Promise<void> {
  // A browser shows the server's Kokon, which updates on that computer (or with a new image).
  if (inBrowser) return;
  try {
    const u = await check();
    writeLastCheck(Date.now());
    if (u) {
      pending = u;
      setState({ update: { version: u.version, notes: u.body ?? "", phase: "available", progress: null } });
    } else if (manual) {
      toastInfo(t("updates.upToDate"));
    }
  } catch (e) {
    // Offline, or no release published yet: silent for the automatic check.
    if (manual) toastError(t("updates.checkFailed", { error: String(e) }));
    else console.info("update check failed", e);
  }
}

/** On startup: check if enabled and a day has passed. Never in development builds. */
export async function autoCheckForUpdate(): Promise<void> {
  if (import.meta.env.DEV) return;
  try {
    const cfg = await api.config();
    if (!autoCheckEnabled(cfg.ui as Record<string, unknown>) || !checkDue(readLastCheck(), Date.now())) return;
  } catch {
    return;
  }
  await checkForUpdate(false);
}

/** Download, stop the service (so its files can be replaced), install and restart. */
export async function installUpdate(): Promise<void> {
  const u = pending;
  const info = getState().update;
  if (!u || !info) return;
  try {
    let total = 0;
    let got = 0;
    setState({ update: { ...info, phase: "downloading", progress: null } });
    await u.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? 0;
      else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        setState((s) => (s.update ? { update: { ...s.update, progress: total ? got / total : null } } : {}));
      }
    });
    setState({ update: { ...info, phase: "installing", progress: null } });
    await invoke("prepare_update");
    await u.install();
    await relaunch();
  } catch (e) {
    setState({ update: { ...info, phase: "available", progress: null } });
    toastError(t("updates.installFailed", { error: String(e) }));
  }
}
