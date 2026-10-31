// Minimal global store (useSyncExternalStore) — no extra dependencies.
//
// Work is organised in projects: each project is one line of work (an original or a first
// result and every version made from it). The open project lives in `session`/`selected`;
// every project is kept as ids in `projects` (persisted) and re-loaded from the service when
// opened again.

import { inBrowser, isNarrow } from "./platform";
import { native } from "./native";
import { useSyncExternalStore } from "react";
import { markFresh } from "../components/Cocoon";
import { api, ApiError, setPrivateInputs, subscribe, urls } from "./api";
import { activeLoras, buildRequest, composing, emptyComposer, goneVersions, macEngineOfferDue, needsPrompt, newKey, pageOutdated, persistentAdvanced, refFromGen, refFromInput, reviewRequest, stageFitsPreview, starPromptDue, timelineLinks, undoTarget, versionLabels, wantsPromptReview, type CompareMode, type Composer, type Ref } from "./logic";
import type { AppErrorBody, GenerationRecord, GenerationRequest, InputRecord, JobView, LoraItem, MacBenchState, ServerState, StatusResponse } from "./types";

export type Overlay = null | "gallery" | "settings" | "inpaint" | "expand" | "welcome" | "whats-new" | "mac-engine" | "prompt-tips" | "shortcuts";

export interface SessionItem {
  key: string;
  kind: "gen" | "input" | "job";
  gen?: GenerationRecord;
  input?: InputRecord;
  jobId?: string;
  /** Request that produced a pending job (for "Try again"). */
  request?: GenerationRequest;
}

export interface ProjectMeta {
  id: string;
  title: string;
  /** The title was typed by the user (otherwise it follows the first prompt). */
  named?: boolean;
  updatedAt: number;
  /** "gen:<id>" / "input:<id>" of the latest image. */
  cover: string | null;
  count: number;
}

export interface Toast {
  id: string;
  message: string;
  suggestion?: string;
  detail?: string;
  kind: "error" | "info";
}

/** A newer Kokon release found by the update check (`lib/updates.ts`). */
export interface UpdateInfo {
  version: string;
  notes: string;
  phase: "available" | "downloading" | "installing";
  /** 0..1 while downloading, when the size is known. */
  progress: number | null;
}

export interface State {
  update: UpdateInfo | null;
  connected: boolean;
  connectError: string | null;
  server: { state: ServerState; owned: boolean; error: AppErrorBody | null };
  status: StatusResponse | null;
  /** Versions of the open project, in order. */
  session: SessionItem[];
  selected: string | null;
  projectId: string;
  /** Saved projects, most recent first (empty ones are left out). */
  projects: ProjectMeta[];
  sidebar: boolean;
  jobs: Record<string, JobView>;
  composer: Composer;
  /** Last submitted prompt (Up arrow in an empty prompt brings it back). */
  lastPrompt: string;
  overlay: Overlay;
  /** The upscaler comparison, shown over any overlay (Settings, the Advanced menu). */
  compareUpscalers: boolean;
  toasts: Toast[];
  galleryVersion: number;
  /** Benchmark this Mac: null until Settings asks the service. */
  macBench: MacBenchState | null;
  needsSetup: boolean;
  /** Setup opens on "Use models I already have" or on the official download (Settings → Models). */
  setupMode: "own" | "official" | null;
  setupTarget?: "image" | "video" | null;
  /** Before/after view for results made from another image; kept while switching results. */
  compare: CompareMode;
  /** Flicker period in ms. */
  flickerMs: number;
  /** Private mode: nothing is saved to the gallery, the output folder or the project list. */
  privateMode: boolean;
  /** Versions left with Undo, most recent last (Redo walks back through them). */
  redo: string[];
  /** Step of the first-run tour on screen (components/Tour.tsx), or null. */
  tour: number | null;
  /** The one-time "star on GitHub" card is on screen (App.tsx). */
  starPrompt: boolean;
  /** The user's LoRAs (Settings → LoRA). */
  loras: LoraItem[];
  /** Tab Settings opens on (then cleared). */
  settingsTab: string | null;
  /** Prompt+ is writing a prompt into the box for review: its job, and the user's words. */
  review: { jobId: string; prompt: string } | null;
}

const PREFS_KEY = "qls.prefs.v1";
const PROJECTS_KEY = "qls.projects.v1";
const SIDEBAR_KEY = "qls.sidebar.v1";

function loadPrefs(): Partial<Composer> {
  try {
    const p: Partial<Composer> = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    // Older versions also saved CFG/steps/strength, which then overrode every preset.
    return { ...p, advanced: persistentAdvanced(p.advanced) };
  } catch {
    return {};
  }
}

function savePrefs(c: Composer) {
  try {
    const { quality, resolution, aspect, customWidth, customHeight, enhance, enhanceReview } = c;
    const advanced = persistentAdvanced(c.advanced);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ quality, resolution, aspect, customWidth, customHeight, advanced, enhance, enhanceReview }));
  } catch {
    /* storage unavailable */
  }
}

// ---------------------------------------------------------------------------------------
// Projects (persisted as ids; records are fetched from the service when a project opens)
// ---------------------------------------------------------------------------------------

interface StoredItem {
  key: string;
  kind: SessionItem["kind"];
  genId?: string;
  inputId?: string;
  jobId?: string;
  request?: GenerationRequest;
}

export interface ProjectData {
  meta: ProjectMeta;
  items: StoredItem[];
  selected: string | null;
  /** LoRAs switched on in the project (absent = the ones on by default). */
  loras?: string[];
  /** The service's revision of it (see crates/qls-core/src/projects.rs). */
  rev?: number;
}

// The project list lives in kokon-service, shared by every device (0.11). Before, each app
// kept it in its own browser storage: `loadProjects` sends that copy once, then keeps it
// as a backup under BACKUP_KEY.
const projects: Record<string, ProjectData> = {};
const BACKUP_KEY = "qls.projects.v1.backup";

const genCache = new Map<string, GenerationRecord>();
const inputCache = new Map<string, InputRecord>();

/** Per project, the version keys of the last copy heard from the service: a save sends them,
 * so versions added elsewhere since are kept and the ones removed here are removed there. */
const serverKeys = new Map<string, string[]>();
/** Projects changed here and not saved yet; `edits` counts changes, so a save's answer is not
 * applied over a newer change made while it was on its way. */
const dirty = new Set<string>();
const edits = new Map<string, number>();
let saveTimer: number | undefined;

/** What other devices need to hear about (the selection alone is this device's own). */
const content = (p: ProjectData | undefined) => (p ? JSON.stringify([p.items.map((i) => i.key), p.meta.title, p.meta.named, p.loras]) : "");

function persistProjects(ids: string[]) {
  for (const id of ids) {
    dirty.add(id);
    edits.set(id, (edits.get(id) ?? 0) + 1);
  }
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushProjects, 300);
}

async function flushProjects() {
  for (const id of [...dirty]) {
    const p = projects[id];
    dirty.delete(id);
    if (!p || !(p.items.length || p.meta.named)) continue;
    const seq = edits.get(id);
    try {
      const merged = await api.saveProject(id, p, serverKeys.get(id) ?? []);
      if (edits.get(id) === seq) await applyProject(merged);
      else serverKeys.set(id, merged.items.map((i) => i.key));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) dropProject(id);
      // Not reachable: saved again once the connection is back (startEvents).
      else dirty.add(id);
    }
  }
}

/** A copy from the service: into the list, and into the open project when its versions differ. */
async function applyProject(p: ProjectData) {
  const id = p.meta.id;
  serverKeys.set(id, p.items.map((i) => i.key));
  if (dirty.has(id)) return;
  const old = projects[id];
  projects[id] = { ...p, selected: old?.selected && p.items.some((i) => i.key === old.selected) ? old.selected : p.selected };
  if (id !== state.projectId || state.privateMode) {
    setState({ projects: projectList() });
    return;
  }
  const keys = state.session.map((i) => i.key);
  if (keys.length === p.items.length && keys.every((k, i) => k === p.items[i].key)) {
    setState({ projects: projectList() });
    return;
  }
  const seq = edits.get(id);
  const session = await hydrate(p.items, id);
  // Changed here meanwhile, or another project opened: that change is saved and merged instead.
  if (edits.get(id) !== seq || state.projectId !== id) return;
  const selected = session.some((i) => i.key === state.selected) ? state.selected : (session.at(-1)?.key ?? null);
  setState({ session, selected });
}

/** Removed on another device: out of the list; if it is open, a new project starts. */
function dropProject(id: string) {
  delete projects[id];
  serverKeys.delete(id);
  dirty.delete(id);
  if (id === state.projectId) setState((s) => ({ projectId: newKey(), session: [], selected: null, redo: [], composer: emptyComposer(s.composer), projects: projectList() }));
  else setState({ projects: projectList() });
}

/** Loads the list from the service; the first time, with this app's own list from before 0.11. */
export async function loadProjects() {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    const local = raw ? (JSON.parse(raw) as Record<string, ProjectData>) : null;
    if (local && typeof local === "object") {
      await api.importProjects(Object.values(local));
      localStorage.setItem(BACKUP_KEY, raw!);
      localStorage.removeItem(PROJECTS_KEY);
    }
  } catch {
    /* sent again next start (it stays in storage until the service has it) */
  }
  const { projects: list } = await api.projects();
  const ids = new Set(list.map((p) => p.meta.id));
  for (const id of Object.keys(projects)) if (!ids.has(id) && !dirty.has(id)) delete projects[id];
  for (const p of list) await applyProject(p);
  setState({ projects: projectList() });
}

/** News from the service: a project changed (on this or another device) or was removed. */
async function onProjectEvent(id: string, rev: number, deleted: boolean) {
  if (deleted) {
    if (projects[id] || serverKeys.has(id)) dropProject(id);
    return;
  }
  if ((projects[id]?.rev ?? 0) >= rev) return;
  try {
    await applyProject(await api.project(id));
  } catch {
    /* removed meanwhile: its own event follows */
  }
}

function projectList(): ProjectMeta[] {
  return Object.values(projects)
    .filter((p) => p.items.length || p.meta.named)
    .map((p) => p.meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export const itemSource = (i: { gen?: GenerationRecord; input?: InputRecord }) => (i.gen ? `gen:${i.gen.id}` : i.input ? `input:${i.input.id}` : null);
const storedSource = (i: StoredItem) => (i.genId ? `gen:${i.genId}` : i.inputId ? `input:${i.inputId}` : null);

const toStored = (i: SessionItem): StoredItem => ({
  key: i.key,
  kind: i.kind,
  genId: i.gen?.id,
  inputId: i.input?.id,
  jobId: i.jobId,
  request: i.kind === "job" ? i.request : undefined,
});

function titleOf(items: SessionItem[]): string | null {
  for (const i of items) {
    const p = i.gen?.original_prompt || i.gen?.prompt || i.request?.prompt;
    if (p) return p;
    if (i.input) return i.input.original_name ? safeDecode(i.input.original_name) : "Imported image";
  }
  return null;
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const lastCover = (items: StoredItem[]) => {
  for (let k = items.length - 1; k >= 0; k--) {
    const s = storedSource(items[k]);
    if (s) return s;
  }
  return null;
};
const countOf = (items: StoredItem[]) => items.filter((i) => i.kind !== "job").length;

/** Writes the open project back into `projects` after its versions or selection changed. */
function syncProject(prev: State) {
  // Private work is never written to the project list (titles come from prompts).
  if (state.privateMode) return;
  const id = state.projectId;
  const old = projects[id];
  const items = state.session.map(toStored);
  for (const i of state.session) {
    if (i.gen) genCache.set(i.gen.id, i.gen);
    if (i.input) inputCache.set(i.input.id, i.input);
  }
  // Opening a project must not move it to the top; adding a version does.
  const edited = id === prev.projectId && state.session !== prev.session;
  projects[id] = {
    meta: {
      id,
      title: old?.meta.named ? old.meta.title : titleOf(state.session) ?? old?.meta.title ?? "Untitled",
      named: old?.meta.named,
      updatedAt: edited || !old ? Date.now() : old.meta.updatedAt,
      cover: lastCover(items),
      count: countOf(items),
    },
    items,
    selected: state.selected,
    loras: state.composer.loras ?? undefined,
    rev: old?.rev,
  };
  // Saved (and heard by the other devices) only when something they show changed.
  if (content(projects[id]) !== content(old)) persistProjects([id]);
  else if (old) projects[id].meta.updatedAt = old.meta.updatedAt;
  state = { ...state, projects: projectList() };
}

/** Loads the records of a stored project. Versions deleted from the gallery are skipped.
 * All of them come in one request (one per version is slow on a phone); against a service
 * without it, or for versions it did not know yet, one request per version. */
async function hydrate(items: StoredItem[], projectId?: string): Promise<SessionItem[]> {
  let gone = new Set<string>();
  const missing = items.some((it) => (it.kind === "gen" && it.genId && !genCache.has(it.genId)) || (it.kind === "input" && it.inputId && !inputCache.has(it.inputId)));
  if (projectId && missing) {
    try {
      const r = await api.projectRecords(projectId);
      for (const g of Object.values(r.generations)) genCache.set(g.id, g);
      for (const i of Object.values(r.inputs)) inputCache.set(i.id, i);
      gone = goneVersions(items, r, serverKeys.get(projectId) ?? []);
    } catch {
      /* an older kokon-service: one request per version below */
    }
  }
  const out = await Promise.all(
    items.map(async (it): Promise<SessionItem | null> => {
      if (gone.has(it.key)) return null;
      try {
        if (it.kind === "gen" && it.genId) {
          const g = genCache.get(it.genId) ?? (await api.generation(it.genId));
          genCache.set(g.id, g);
          return { key: it.key, kind: "gen", gen: g, jobId: it.jobId };
        }
        if (it.kind === "input" && it.inputId) {
          const r = inputCache.get(it.inputId) ?? (await api.input(it.inputId));
          inputCache.set(r.id, r);
          return { key: it.key, kind: "input", input: r };
        }
        // A job is only shown while the service still knows it (e.g. not after a restart).
        if (it.kind === "job" && it.jobId && state.jobs[it.jobId]) return { key: it.key, kind: "job", jobId: it.jobId, request: it.request };
      } catch {
        /* deleted */
      }
      return null;
    }),
  );
  return out.filter((x): x is SessionItem => !!x);
}

const loadSidebar = () => {
  // On a phone the sidebar's place is the library (PhoneApp.tsx): it opens there, on the projects.
  if (isNarrow()) return true;
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "0";
  } catch {
    return true;
  }
};

let state: State = {
  update: null,
  connected: false,
  connectError: null,
  server: { state: "stopped", owned: false, error: null },
  status: null,
  session: [],
  selected: null,
  projectId: newKey(),
  projects: projectList(),
  sidebar: loadSidebar(),
  jobs: {},
  composer: emptyComposer(loadPrefs()),
  lastPrompt: "",
  overlay: null,
  compareUpscalers: false,
  toasts: [],
  galleryVersion: 0,
  macBench: null,
  needsSetup: false,
  setupMode: null,
  setupTarget: null,
  compare: "off",
  flickerMs: 500,
  privateMode: false,
  redo: [],
  tour: null,
  starPrompt: false,
  loras: [],
  settingsTab: null,
  review: null,
};

const listeners = new Set<() => void>();

export function getState() {
  return state;
}

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const prev = state;
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if (p.composer) savePrefs(state.composer);
  if (state.session !== prev.session || state.selected !== prev.selected || state.projectId !== prev.projectId) syncProject(prev);
  // On a phone "sidebar" is the library being open: not the desktop sidebar's saved choice.
  if (p.sidebar !== undefined && !isNarrow()) {
    try {
      localStorage.setItem(SIDEBAR_KEY, p.sidebar ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }
  listeners.forEach((l) => l());
}

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
  );
}

let switchingServerMode: Promise<void> | null = null;

export async function isVideoModelDownloaded(): Promise<boolean> {
  const s = getState();
  if (s.status?.video_model_installed !== undefined) {
    return s.status.video_model_installed;
  }
  try {
    const m = await api.models();
    return !!m.video_official_installed;
  } catch {
    return false;
  }
}

export async function promptVideoModelDownload(): Promise<boolean> {
  const confirmed = await native.confirm(
    "To animate photos or generate videos, Kokon needs the Wan 2.2 video model.\n\nWould you like to open Setup to download it now?",
    "Download Video Model"
  );
  if (confirmed) {
    openModelSetup("official", "video");
  }
  return confirmed;
}

/** Switches the workflow and composer to Animate (video) mode, verifying model download first. */
export async function switchToAnimate(refs?: Ref[]): Promise<boolean> {
  const installed = await isVideoModelDownloaded();
  if (!installed) {
    await promptVideoModelDownload();
    return false;
  }

  setState((st) => {
    const existingRef = refs ?? (st.composer.refs.length > 0 ? st.composer.refs : null);
    const selected = selectedItem(st);
    const fallbackRef = selected?.gen ? refFromGen(selected.gen) : selected?.input ? refFromInput(selected.input) : null;
    const targetRefs = existingRef ?? (fallbackRef ? [fallbackRef] : []);

    return {
      composer: {
        ...emptyComposer(st.composer),
        mode: "video",
        refs: targetRefs,
        prompt: st.composer.prompt || "cinematic subtle motion, vivid details",
      },
    };
  });

  await ensureServerMode("video");
  focusPrompt();
  return true;
}

export function updateComposer(patch: Partial<Composer>) {
  setState((s) => ({ composer: { ...s.composer, ...patch } }));
  if (patch.mode === "video") {
    ensureServerMode("video");
  } else if (patch.mode) {
    ensureServerMode("image");
  }
}

/** Ensures the inference server is running the model suited for the active mode (image or video). */
export async function ensureServerMode(mode: "image" | "video") {
  if (switchingServerMode) {
    await switchingServerMode;
  }
  const s = getState();
  if (!s.connected) return;
  const busy = Object.values(s.jobs).some((j) => !["done", "failed", "cancelled"].includes(j.status));
  if (busy) return;

  const currentModel = (s.status?.server.model ?? "").toLowerCase();
  const isVideoServer = currentModel.includes("wan");
  const desiredVideo = mode === "video";

  if (s.server.state === "ready" && isVideoServer === desiredVideo) {
    return;
  }

  if (desiredVideo) {
    const installed = await isVideoModelDownloaded();
    if (!installed) {
      await promptVideoModelDownload();
      return;
    }
  }

  switchingServerMode = (async () => {
    try {
      await api.startBackend({ mode });
      await refreshStatus();
    } catch (e) {
      if (isMissingModel(e) && mode === "video") {
        await promptVideoModelDownload();
      } else {
        toastError(e);
      }
      await refreshStatus();
    } finally {
      switchingServerMode = null;
    }
  })();
  await switchingServerMode;
}

// ---------------------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------------------

export function toastError(e: unknown) {
  const body: AppErrorBody = e instanceof ApiError ? e.body : { code: "internal", message: e instanceof Error ? e.message : String(e) };
  pushToast({ id: newKey(), message: body.message, suggestion: body.suggestion, detail: body.detail, kind: "error" });
}

/** Opens Setup (also over a finished setup): to fix missing model files, or to choose own files. */
export function openModelSetup(mode: "own" | "official" | null = null, target?: "image" | "video") {
  setState({ overlay: null, needsSetup: true, setupMode: mode, setupTarget: target ?? null });
}

/** The engine or a model file is missing (drive not connected, moved, deleted). */
export const isMissingModel = (e: unknown) => (e instanceof ApiError ? e.body.code : (e as AppErrorBody | null)?.code) === "missing_model";

export function toastInfo(message: string) {
  pushToast({ id: newKey(), message, kind: "info" });
}

function pushToast(t: Toast) {
  setState((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  if (t.kind === "info") window.setTimeout(() => dismissToast(t.id), 3500);
}

export function dismissToast(id: string) {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

// ---------------------------------------------------------------------------------------
// Connection and events
// ---------------------------------------------------------------------------------------

let unsub: (() => void) | null = null;

/** After Setup or What's new: the Mac engine offer when it is due (the answer decides which engine loads), else the
 * model loads in the background so the first image starts at once. */
export async function afterStartScreens() {
  try {
    const [cfg, st] = await Promise.all([api.config(), api.status()]);
    if (!inBrowser && macEngineOfferDue(st, (cfg.ui ?? {}) as Record<string, unknown>, cfg.setupComplete)) {
      setState({ overlay: "mac-engine" });
      return;
    }
  } catch {
    // The offer can wait for the next start; the model still loads.
  }
  api.startBackend().then(refreshStatus, () => refreshStatus());
}

export async function refreshStatus() {
  try {
    const st = await api.status();
    const tg = st.server.text_generation;
    if (typeof tg === "boolean" && tg !== knownTextGeneration) {
      knownTextGeneration = tg;
      try {
        localStorage.setItem(TEXT_GEN_KEY, tg ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
    }
    setState({ status: st, server: { state: st.server.state, owned: st.server.owned, error: st.server.error } });
    if (inBrowser) reloadIfOutdated(st.service.version);
    return st;
  } catch {
    return null;
  }
}

const RELOADED_FOR_KEY = "kokon.reloadedFor";

/** Browser: the app on the server computer updated while this page was open (or cached), so it
 * runs the old UI against the new service: load the new one, once per version (logic.ts
 * `pageOutdated`). The desktop app updates its UI and service together. */
function reloadIfOutdated(serviceVersion: string) {
  let reloadedFor: string | null = null;
  try {
    reloadedFor = sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    /* storage unavailable: the write below fails too, and then no reload */
  }
  if (!pageOutdated(__KOKON_VERSION__, serviceVersion, reloadedFor)) return;
  try {
    sessionStorage.setItem(RELOADED_FOR_KEY, serviceVersion);
  } catch {
    // Without storage a reload could loop: stay on this page.
    return;
  }
  location.reload();
}

const TEXT_GEN_KEY = "kokon.textGeneration";
let knownTextGeneration = (() => {
  try {
    return localStorage.getItem(TEXT_GEN_KEY) === "1";
  } catch {
    return false;
  }
})();

/** The engine can write prompts (prompt enhancer): as the loaded model reports, else as it did
 * last time, so the switch is there before the model loads. */
export function enhancerAvailable(s: State): boolean {
  return s.status?.server.text_generation ?? knownTextGeneration;
}

export function startEvents() {
  unsub?.();
  unsub = subscribe(
    (ev) => {
      if (ev.type === "job") onJob(ev.job);
      else if (ev.type === "server") {
        const loaded = ev.state === "ready" && getState().server.state !== "ready";
        setState({ server: { state: ev.state, owned: ev.owned, error: ev.error } });
        // What the newly loaded engine can do (the prompt enhancer).
        if (loaded) refreshStatus();
      }
      else if (ev.type === "gallery") setState((s) => ({ galleryVersion: s.galleryVersion + 1 }));
      else if (ev.type === "projects") onProjectEvent(ev.id, ev.rev, ev.deleted);
      else if (ev.type === "mac_bench") setState({ macBench: ev.bench });
    },
    (ok) => {
      setState({ connected: ok });
      if (ok) {
        // Catch up on anything missed while disconnected.
        api.jobs().then((js) => js.forEach(onJob)).catch(() => {});
        refreshStatus();
        // Changes made elsewhere meanwhile, then this app's own that could not be saved.
        loadProjects().then(flushProjects, () => {});
      }
    },
  );
}

function onJob(job: JobView) {
  // A model file went missing between submitting and starting: Setup shows what and how to fix
  // it (only for a job that just failed, not old ones listed again after reconnecting).
  const prev = getState().jobs[job.id];
  if (job.status === "failed" && prev?.status !== "failed" && isMissingModel(job.error) && job.finished_at && Date.now() - Date.parse(job.finished_at) < 60_000) {
    openModelSetup();
  }
  // Results replacing a version in progress of the open project hatch out of the cocoon when
  // first shown (marked before the state change renders them).
  if (job.status === "done" && prev?.status !== "done" && getState().session.some((i) => i.jobId === job.id && i.kind === "job")) {
    markFresh(job.results.map((g) => g.id));
  }
  // Prompt+ review: the prompt it wrote goes into the box (no image, no version).
  if (getState().review?.jobId === job.id) {
    onReviewJob(job);
    return;
  }
  // Made with this app (it had a pending version), not by another client such as MCP.
  let made = false;
  setState((s) => {
    const jobs = { ...s.jobs, [job.id]: job };
    if (job.status !== "done") return { jobs };
    // Keys from the image ids, the same the service gives them (projects.rs `job_done`), so a
    // result added by both, or by two devices, is one version.
    const results = job.results.map((g): SessionItem => ({ key: `r-${g.id}`, kind: "gen", gen: g, jobId: job.id }));
    // Replace the pending version with one version per result.
    const idx = s.session.findIndex((i) => i.jobId === job.id && i.kind === "job");
    if (idx >= 0) {
      made = true;
      const pending = s.session[idx];
      const session = [...s.session.slice(0, idx), ...results, ...s.session.slice(idx + 1)];
      const wasSelected = s.selected === pending.key;
      // Editing carries on from the new version; creating new images (also from references)
      // stays in create mode with the same references.
      let composer = s.composer;
      const src = pending.request?.images?.[0];
      if (wasSelected && results[0]?.gen && src && composer.refs[0]?.source === src && !composer.create) {
        composer = { ...composer, refs: [refFromGen(results[0].gen), ...composer.refs.slice(1)], mask: null, outpaint: null };
      }
      return { jobs, session, composer, selected: wasSelected && results[0] ? results[0].key : s.selected };
    }
    // A job of another (closed) project.
    for (const p of Object.values(projects)) {
      const k = p.items.findIndex((i) => i.jobId === job.id && i.kind === "job");
      if (k < 0) continue;
      made = true;
      const stored = results.map(toStored);
      for (const g of job.results) genCache.set(g.id, g);
      const wasSelected = p.selected === p.items[k].key;
      p.items = [...p.items.slice(0, k), ...stored, ...p.items.slice(k + 1)];
      if (wasSelected && stored[0]) p.selected = stored[0].key;
      // Shown at once; the service made the same change and saves it (no save from here).
      p.meta = { ...p.meta, cover: lastCover(p.items), count: countOf(p.items), updatedAt: Date.now() };
      return { jobs, projects: projectList() };
    }
    // A job from another client (e.g. MCP): track it but do not add it to a project.
    return { jobs };
  });
  if (made && job.results.length) countImageMade();
  if (job.status === "failed" && job.error) toastError(new ApiError(job.error, 500));
}

/** A Prompt+ review job changed: the text streams into the box; when done the box keeps it
 * (with the user's words, for Undo); a failure or a cancel leaves the user's prompt. */
function onReviewJob(job: JobView) {
  setState((s) => {
    const jobs = { ...s.jobs, [job.id]: job };
    if (!["done", "failed", "cancelled"].includes(job.status)) return { jobs };
    const words = s.review?.prompt ?? s.composer.prompt;
    const text = job.status === "done" ? job.enhanced_prompt?.trim() : "";
    const composer = text ? { ...s.composer, prompt: text, enhancedFrom: words } : { ...s.composer, prompt: words };
    return { jobs, review: null, composer };
  });
  if (job.status === "failed" && job.error) toastError(new ApiError(job.error, 500));
  if (job.status === "done") focusPrompt(true);
}

// ---------------------------------------------------------------------------------------
// Star prompt: once, after a few images made with the app, never again whatever the answer.
// ---------------------------------------------------------------------------------------

const MADE_KEY = "kokon.imagesMade";
/** Config `ui.starPromptSeen`; true until read at start, so nothing shows before that. */
let starSeen = true;

export function initStarPrompt(ui: Record<string, unknown>) {
  starSeen = !!ui.starPromptSeen;
}

function countImageMade() {
  if (starSeen) return;
  let made: number;
  try {
    made = (Number(localStorage.getItem(MADE_KEY)) || 0) + 1;
    localStorage.setItem(MADE_KEY, String(made));
  } catch {
    return;
  }
  const s = getState();
  if (!starPromptDue(made, s.overlay !== null || s.tour !== null || s.needsSetup)) return;
  starSeen = true;
  setState({ starPrompt: true });
  api
    .config()
    .then((cfg) => api.saveConfig({ ...cfg, ui: { ...((cfg.ui ?? {}) as Record<string, unknown>), starPromptSeen: true } }))
    .catch(() => {
      /* only means it may show once more after a restart */
    });
}

export function closeStarPrompt() {
  setState({ starPrompt: false });
}

// ---------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------

/** A fresh composer (keeping quality/size preferences) that edits `selected`, if it is an image. */
function composerFor(c: Composer, session: SessionItem[], selected: string | null): Composer {
  const it = session.find((i) => i.key === selected);
  const ref = it?.gen ? refFromGen(it.gen) : it?.input ? refFromInput(it.input) : null;
  return { ...emptyComposer(c), refs: ref ? [ref] : [] };
}

/** Starts a new project; the current one stays in the list. */
export function newProject() {
  setState((s) =>
    s.session.length
      ? { projectId: newKey(), session: [], selected: null, overlay: null, redo: [], composer: { ...emptyComposer(s.composer), mode: "auto" } }
      : { overlay: null, composer: { ...emptyComposer(s.composer), mode: "auto", prompt: s.composer.prompt } },
  );
  ensureServerMode("image");
  // A phone shows the new project's start first; the writing screen opens when the box is tapped.
  if (!isNarrow()) focusPrompt();
}

/** Starts a new video project; the current one stays in the list. */
export function newVideoProject() {
  setState((s) => {
    const comp = { ...emptyComposer(s.composer), mode: "video" as const };
    return s.session.length
      ? { projectId: newKey(), session: [], selected: null, overlay: null, redo: [], composer: comp }
      : { overlay: null, composer: { ...comp, prompt: s.composer.prompt } };
  });
  ensureServerMode("video");
  focusPrompt();
}

/** Private mode on: a fresh project whose images stay out of the gallery, the output folder
 * and the project list. Off: those images are deleted (after confirming). */
export async function setPrivateMode(on: boolean, confirmDiscard: () => Promise<boolean>) {
  const s = getState();
  if (on === s.privateMode) return;
  if (!on && s.session.length > 0 && !(await confirmDiscard())) return;
  if (!on) {
    try {
      await api.clearPrivate();
    } catch (e) {
      toastError(e);
      return;
    }
  }
  setPrivateInputs(on);
  // The project being left was saved already (normal mode) or is discarded (private mode).
  setState((st) => ({ privateMode: on, projectId: newKey(), session: [], selected: null, overlay: null, redo: [], composer: emptyComposer(st.composer) }));
  if (on) toastInfo("Private mode: images are not saved, and are deleted when you turn it off or close the app.");
  if (!isNarrow()) focusPrompt();
}

let switching = 0;

export async function switchProject(id: string, selectKey?: string) {
  if (id === state.projectId) {
    setState({ overlay: null });
    if (selectKey) selectItem(selectKey);
    return;
  }
  const data = projects[id];
  if (!data) return;
  const token = ++switching;
  preloadStage(data, selectKey);
  const session = await hydrate(data.items, id);
  if (token !== switching) return;
  const keep = (k: string | null | undefined) => (k && session.some((i) => i.key === k) ? k : null);
  const selected = keep(selectKey) ?? keep(data.selected) ?? session[session.length - 1]?.key ?? null;
  setState((s) => ({ projectId: id, session, selected, overlay: null, redo: [], composer: { ...composerFor(s.composer, session, selected), loras: data.loras ?? null } }));
  const isVideo = session.some((i) => i.gen?.mode === "video" || i.request?.mode === "video");
  if (isVideo) {
    ensureServerMode("video");
  } else if (session.some((i) => i.gen || i.input)) {
    ensureServerMode("image");
  }
}

// In a browser the stage shows a screen-sized preview when it is as sharp there (logic.ts
// stageFitsPreview). Until a stage has measured itself, a phone is assumed to fit.
let stageFits = isNarrow();
let preloading: HTMLImageElement | null = null;

/** The image the stage loads, drawn at `w`×`h` CSS px: in a browser the preview when it fits,
 * else (and always in the desktop app) the full image. */
export function stageImage(source: string, w: number, h: number): string {
  if (!inBrowser) return urls.source(source);
  if (w > 0 && h > 0) stageFits = stageFitsPreview(w, h, window.devicePixelRatio || 1);
  return stageFits ? urls.sourcePreview(source) : urls.source(source);
}

/** A project is being opened: its selected version's preview starts loading now, alongside
 * its records, instead of after them (a browser only). */
function preloadStage(data: ProjectData, selectKey?: string) {
  if (!inBrowser || !stageFits) return;
  const it = data.items.find((i) => i.key === selectKey) ?? data.items.find((i) => i.key === data.selected) ?? data.items.findLast((i) => i.kind !== "job");
  const src = it && storedSource(it);
  if (!src) return;
  preloading = new Image();
  preloading.src = urls.sourcePreview(src);
}

/** Switches the project's LoRAs (the composer's LoRA badge); new projects start with the ones
 * on by default. */
export function setProjectLoras(ids: string[]) {
  setState((s) => ({ composer: { ...s.composer, loras: ids } }));
  const p = projects[state.projectId];
  if (p && !state.privateMode) {
    p.loras = ids;
    persistProjects([p.meta.id]);
  }
}

/** Reloads the LoRA list from the service. */
export async function refreshLoras() {
  try {
    setState({ loras: (await api.loras()).items });
  } catch {
    /* service not reachable: keep the last list */
  }
}

/** Opens Settings on one of its tabs. */
export function openSettings(tab: string) {
  setState({ overlay: "settings", settingsTab: tab });
}

/** Adds the example projects that ship with Kokon (made by Kokon itself), except the ones
 * already in the list, below the user's own work. Returns the first one (the tour's). */
export async function addExampleProjects(): Promise<string | null> {
  const { projects: examples } = await api.installExamples();
  const now = Date.now();
  let first: string | null = null;
  const added: string[] = [];
  examples.forEach((ex, i) => {
    const have = Object.values(projects).find((p) => p.items.some((it) => it.genId === ex.generations[0]));
    if (have) {
      first ??= have.meta.id;
      return;
    }
    // Ids from the images: two devices adding them at once make the same projects.
    const id = `ex-${ex.generations[0]}`;
    const items: StoredItem[] = ex.generations.map((g) => ({ key: `ex-${g}`, kind: "gen", genId: g }));
    const updatedAt = now - 60_000 - i * 1000;
    projects[id] = { meta: { id, title: ex.title, named: true, updatedAt, cover: lastCover(items), count: items.length }, items, selected: items[items.length - 1].key };
    first ??= id;
    added.push(id);
  });
  persistProjects(added);
  setState({ projects: projectList() });
  return first;
}

/** Opens the first example project on its last version and starts the tour. */
export async function startTour() {
  try {
    const id = await addExampleProjects();
    if (!id) return;
    await switchProject(id, projects[id]?.items.at(-1)?.key);
    setState({ tour: 0, overlay: null, sidebar: true });
  } catch (e) {
    toastError(e);
  }
}

/** Closes the tour and remembers that it was seen. */
export async function endTour() {
  setState({ tour: null });
  try {
    const cfg = await api.config();
    const ui = (cfg.ui ?? {}) as Record<string, unknown>;
    if (!ui.tourSeen) await api.saveConfig({ ...cfg, ui: { ...ui, tourSeen: true } });
  } catch {
    /* shown again next time */
  }
}

/** Gives a project a name; an empty name goes back to naming it after its first prompt. */
export function renameProject(id: string, name: string) {
  const title = name.trim().replace(/\s+/g, " ").slice(0, 120);
  const p = projects[id] ?? { meta: { id, title: "", updatedAt: Date.now(), cover: null, count: 0 }, items: [], selected: null };
  const auto = id === state.projectId ? titleOf(state.session) : null;
  p.meta = title ? { ...p.meta, title, named: true } : { ...p.meta, title: auto ?? p.meta.title ?? "Untitled", named: false };
  projects[id] = p;
  persistProjects([id]);
  setState({ projects: projectList() });
}

/** Removes a project from the list; its images stay in the gallery. */
export function deleteProject(id: string) {
  deleteProjects([id]);
}

/** Removes projects from the list (their images stay in All images); the open one closes. */
export function deleteProjects(ids: string[]) {
  for (const id of ids) {
    delete projects[id];
    dirty.delete(id);
    if (serverKeys.delete(id)) api.deleteProject(id).catch(toastError);
  }
  if (ids.includes(state.projectId)) setState((s) => ({ projectId: newKey(), session: [], selected: null, composer: emptyComposer(s.composer), projects: projectList() }));
  else setState({ projects: projectList() });
}

/** Opens a gallery image: in the project that holds it, or in a new project with its ancestors. */
export async function openGeneration(g: GenerationRecord) {
  genCache.set(g.id, g);
  const here = state.session.find((i) => i.gen?.id === g.id);
  if (here) {
    setState({ overlay: null });
    selectItem(here.key);
    return;
  }
  for (const [id, p] of Object.entries(projects)) {
    const it = p.items.find((i) => i.genId === g.id);
    if (it) return switchProject(id, it.key);
  }
  const chain = [g];
  for (let pid = g.parent_id; pid && chain.length < 24; ) {
    try {
      const r = genCache.get(pid) ?? (await api.generation(pid));
      genCache.set(r.id, r);
      chain.unshift(r);
      pid = r.parent_id;
    } catch {
      break;
    }
  }
  const items: SessionItem[] = [];
  const root = chain[0];
  const ref = root.references[0];
  if (ref && root.references.length === 1 && root.mode !== "generate" && root.mode !== "compose") {
    try {
      const r = inputCache.get(ref.input_id) ?? (await api.input(ref.input_id));
      items.push({ key: newKey(), kind: "input", input: r });
    } catch {
      /* original no longer stored */
    }
  }
  items.push(...chain.map((r): SessionItem => ({ key: newKey(), kind: "gen", gen: r })));
  const selected = items[items.length - 1].key;
  setState((s) => ({ projectId: newKey(), session: items, selected, overlay: null, composer: composerFor(s.composer, items, selected) }));
}

/** A generation was deleted: drop it from every project. */
export function forgetGeneration(id: string) {
  genCache.delete(id);
  const changed: string[] = [];
  for (const p of Object.values(projects)) {
    if (!p.items.some((i) => i.genId === id)) continue;
    p.items = p.items.filter((i) => i.genId !== id);
    p.meta = { ...p.meta, cover: lastCover(p.items), count: countOf(p.items) };
    changed.push(p.meta.id);
  }
  persistProjects(changed);
  setState((s) => {
    const session = s.session.filter((i) => i.gen?.id !== id);
    const refs = s.composer.refs.filter((r) => r.source !== `gen:${id}`);
    return {
      session,
      projects: projectList(),
      selected: session.some((i) => i.key === s.selected) ? s.selected : session[session.length - 1]?.key ?? null,
      composer: refs.length === s.composer.refs.length ? s.composer : { ...s.composer, refs, mask: null, outpaint: null },
    };
  });
}

// ---------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------

/** Makes `ref` the image being edited (image 1); other references stay. */
function retarget(c: Composer, ref: Ref): Composer {
  if (c.refs[0]?.source === ref.source) return c;
  const rest = c.refs.slice(1).filter((r) => r.source !== ref.source);
  return { ...c, refs: [ref, ...rest], mask: null, outpaint: null, aspect: "auto" };
}

const refOf = (it: SessionItem | undefined) => (it?.gen ? refFromGen(it.gen) : it?.input ? refFromInput(it.input) : null);

/** Shows a version. While editing, the shown image also becomes the one the prompt edits;
 * in "New image" mode browsing only shows it (Edit image switches back). Choosing a version
 * by hand ends the current Undo/Redo walk. */
export function selectItem(key: string, keepRedo = false) {
  setState((s) => {
    const it = s.session.find((i) => i.key === key);
    if (!it) return {};
    const ref = s.composer.refs.length && !s.composer.create ? refOf(it) : null;
    return { selected: key, composer: ref ? retarget(s.composer, ref) : s.composer, ...(keepRedo ? {} : { redo: [] }) };
  });
}

/** "New image": the prompt creates a new image; images in the prompt stay, as references
 * (people, products, a style) instead of the image to edit. The versions stay to look at. */
export function startNewImage() {
  setState((s) => ({ composer: { ...s.composer, create: true, mask: null, outpaint: null } }));
  focusPrompt();
}

/** "Edit image": the prompt edits the version shown (or the latest image). When it is one of a
 * new image's references it becomes image 1 and the others stay; a version that is not (such as
 * the new image just made) is edited on its own. */
export function editShownImage() {
  setState((s) => {
    const shown = s.session.find((i) => i.key === s.selected);
    const ref = refOf(shown) ?? refOf([...s.session].reverse().find((i) => i.gen || i.input));
    if (!ref) return composing(s.composer) ? { composer: { ...s.composer, create: false, aspect: "auto" } } : {};
    const c = s.composer;
    if (composing(c)) {
      const here = c.refs.find((r) => r.source === ref.source);
      const refs = here ? [here, ...c.refs.filter((r) => r !== here)] : [ref];
      return { composer: { ...c, refs, create: false, mask: null, outpaint: null, aspect: "auto" } };
    }
    return { composer: { ...retarget(c, ref), create: false } };
  });
  focusPrompt();
}

/** "Animate": turns an image (generated or uploaded input) into a video using Wan2.2 TI2V */
export function animateItem(item: SessionItem) {
  const ref = item.gen ? refFromGen(item.gen) : item.input ? refFromInput(item.input) : null;
  if (!ref) return;
  switchToAnimate([ref]);
}

/** The sources ("gen:<id>"/"input:<id>") a version was made from; `variant` when it is the
 * same recipe again with a new seed (a variation of a new image) rather than an edit. */
export function itemOrigin(i: SessionItem): { from: string[]; variant: boolean } {
  const req = i.gen?.request ?? i.request;
  const mode = i.gen?.mode ?? req?.mode;
  // A new image (also one made from references) starts a line of its own.
  const images = mode === "generate" || mode === "compose" ? [] : req?.images ?? [];
  if (images.length) return { from: images, variant: false };
  const parent = i.gen?.parent_id ?? req?.parent_id;
  return parent ? { from: [`gen:${parent}`], variant: true } : { from: [], variant: false };
}

const lineage = (session: SessionItem[]) => session.map((i) => ({ key: i.key, source: itemSource(i), ...itemOrigin(i) }));

/** Short names of a project's images: "1", "1.1", "2"… */
export const sessionLabels = (session: SessionItem[]) => versionLabels(lineage(session));

/** How each version joins the timeline. */
export const sessionLinks = (session: SessionItem[]) => timelineLinks(lineage(session));

/** Puts a result's prompt back in the prompt box to try it again with small changes: it
 * works on the same images the result was made from (none for a new image), and keeps the
 * quality, size and advanced settings as they are now. */
export function reusePrompt(g: GenerationRecord) {
  setState((s) => {
    const c = s.composer;
    const compose = g.mode === "compose";
    const sources = compose ? { from: g.request?.images ?? [], variant: false } : itemOrigin({ key: "", kind: "gen", gen: g });
    const refs: Ref[] = [];
    if (!sources.variant) {
      sources.from.forEach((src, i) => {
        const here = refOf(s.session.find((x) => itemSource(x) === src));
        const rec = g.references[i];
        const ref = here ?? (rec ? { key: newKey(), source: `input:${rec.input_id}`, width: rec.width, height: rec.height, name: `Image ${i + 1}` } : null);
        if (ref) refs.push(ref);
      });
    }
    const mask = g.mask_input_id && refs[0] ? { inputId: g.mask_input_id, refKey: refs[0].key } : null;
    return {
      composer: {
        ...c,
        prompt: g.prompt,
        // The enhancer's text is a full prompt already: sent as it is (rewriting it again would
        // drift); Undo in the box brings back the user's words.
        enhancedFrom: g.original_prompt ?? null,
        create: compose && refs.length > 0,
        refs,
        mask,
        inpaintAction: mask ? g.request?.inpaint_action ?? "edit" : c.inpaintAction,
        outpaint: g.outpaint && refs.length ? { ...g.outpaint, units: "pixels" } : null,
        aspect: refs.length && !c.refs.length && !compose ? "auto" : c.aspect,
        seed: null,
      },
    };
  });
  focusPrompt(true);
}

/** Back to the user's own words from a prompt Prompt+ wrote (the box's Undo). */
export function undoEnhancedPrompt() {
  setState((s) => (s.composer.enhancedFrom == null ? {} : { composer: { ...s.composer, prompt: s.composer.enhancedFrom, enhancedFrom: null } }));
  focusPrompt(true);
}

const undoItems = (session: SessionItem[]) => session.map((i) => ({ key: i.key, source: itemSource(i), from: itemOrigin(i).from[0] ?? null }));

/** The version Undo goes back to (what the selected one was made from), if any. */
export function undoKey(s: State): string | null {
  return s.selected ? undoTarget(undoItems(s.session), s.selected) : null;
}

/** Back to the version the selected one was made from; the next edit starts from there. */
export function undoVersion() {
  const s = getState();
  const target = undoKey(s);
  if (!target || !s.selected) return;
  const redo = [...s.redo, s.selected];
  selectItem(target, true);
  setState({ redo });
}

/** Forward again to the version left with Undo. */
export function redoVersion() {
  const s = getState();
  const key = s.redo[s.redo.length - 1];
  if (!key) return;
  const redo = s.redo.slice(0, -1);
  if (s.session.some((i) => i.key === key)) selectItem(key, true);
  setState({ redo });
}

/** New images: into an empty project they become versions to work on (the photo to edit);
 * in a project they are added to the prompt: as extra references while editing, else as
 * references for a new image ("New image" stays; Edit image edits image 1). */
export function addInputs(records: InputRecord[]) {
  if (!records.length) return;
  setState((s) => {
    const added = records.map(refFromInput);
    if (s.session.length) {
      const create = s.composer.refs.length ? s.composer.create : true;
      return { composer: { ...s.composer, refs: [...s.composer.refs, ...added].slice(0, 10), create, outpaint: null } };
    }
    const items: SessionItem[] = records.map((r) => ({ key: newKey(), kind: "input", input: r }));
    return {
      composer: { ...s.composer, refs: [...s.composer.refs, ...added].slice(0, 10), mask: null, outpaint: null, aspect: "auto" },
      session: [...s.session, ...items],
      selected: items[0].key,
    };
  });
  if (getState().composer.refs.length >= 10) toastInfo("Up to 10 reference images are supported.");
}

export async function submitRequest(req: GenerationRequest) {
  try {
    if (getState().privateMode) req = { ...req, private: true };
    const job = await api.submit(req);
    const item: SessionItem = { key: newKey(), kind: "job", jobId: job.id, request: req };
    setState((s) => ({ jobs: { ...s.jobs, [job.id]: job }, session: [...s.session, item], selected: item.key, redo: [] }));
    return true;
  } catch (e) {
    // The prompt and images stay in the composer: once the files are back, Generate again.
    if (isMissingModel(e)) openModelSetup();
    toastError(e);
    return false;
  }
}

/** A version the service made right away (a LUT applied): added after the others and
 * selected; editing carries on from it when the prompt was editing its source. */
export function addResult(g: GenerationRecord) {
  setState((s) => {
    const item: SessionItem = { key: newKey(), kind: "gen", gen: g };
    const src = g.request?.images?.[0];
    const composer = src && s.composer.refs[0]?.source === src ? { ...s.composer, refs: [refFromGen(g), ...s.composer.refs.slice(1)], mask: null, outpaint: null } : s.composer;
    return { session: [...s.session, item], selected: item.key, composer, redo: [] };
  });
}

export async function submitComposer() {
  const s = getState();
  if (s.review) return;
  if (wantsPromptReview(s.composer)) return startPromptReview();
  const target = composing(s.composer) ? undefined : s.composer.refs[0]?.source;
  const parent = target?.startsWith("gen:") ? target.slice(4) : null;
  const req: GenerationRequest = { ...buildRequest(s.composer, parent), loras: activeLoras(s.composer, s.loras) };
  if (!req.prompt && needsPrompt(s.composer)) {
    toastInfo("Describe what to create or change.");
    return;
  }
  if (await submitRequest(req)) {
    setState((st) => {
      const sent = st.composer.prompt.trim() === req.prompt;
      return {
        lastPrompt: st.composer.enhancedFrom ?? req.prompt,
        composer: { ...st.composer, prompt: sent ? "" : st.composer.prompt, enhancedFrom: sent ? null : st.composer.enhancedFrom, seed: null },
      };
    });
  }
}

/** Prompt+ review: the prompt is written into the box first (a job that makes no image). */
async function startPromptReview() {
  const s = getState();
  let req = reviewRequest(s.composer);
  if (s.privateMode) req = { ...req, private: true };
  try {
    const job = await api.submit(req);
    setState((st) => ({ jobs: { ...st.jobs, [job.id]: job }, review: { jobId: job.id, prompt: st.composer.prompt } }));
  } catch (e) {
    if (isMissingModel(e)) openModelSetup();
    toastError(e);
  }
}

/** Stops Prompt+ writing a prompt for review; the user's words stay in the box. */
export async function cancelPromptReview() {
  const r = getState().review;
  if (!r) return;
  try {
    onReviewJob(await api.cancel(r.jobId));
  } catch (e) {
    setState((s) => ({ review: null, composer: { ...s.composer, prompt: r.prompt } }));
    toastError(e);
  }
}

export async function cancelJob(jobId: string) {
  try {
    const j = await api.cancel(jobId);
    onJob(j);
  } catch (e) {
    toastError(e);
  }
}

/** Adds a version to the prompt: an extra reference while editing, else a reference for a new
 * image ("New image" stays; Edit image edits image 1). */
export function addAsReference(item: SessionItem) {
  const ref = item.gen ? refFromGen(item.gen) : item.input ? refFromInput(item.input) : null;
  if (!ref) return;
  if (getState().composer.refs.some((r) => r.source === ref.source)) {
    toastInfo("That image is already in the prompt.");
    return;
  }
  if (getState().composer.refs.length >= 10) {
    toastInfo("Up to 10 reference images are supported.");
    return;
  }
  setState((s) => ({ composer: { ...s.composer, refs: [...s.composer.refs, ref].slice(0, 10), create: s.composer.refs.length ? s.composer.create : true, outpaint: null } }));
}

export function focusPrompt(cursorToEnd = false) {
  window.setTimeout(() => {
    const el = document.getElementById("prompt") as HTMLTextAreaElement | null;
    el?.focus();
    if (el && cursorToEnd) el.setSelectionRange(el.value.length, el.value.length);
  }, 30);
}

export function removeSessionItem(key: string) {
  const s = getState();
  const removed = s.session.find((i) => i.key === key);
  const session = s.session.filter((i) => i.key !== key);
  const src = removed ? itemSource(removed) : null;
  const refs = src ? s.composer.refs.filter((r) => r.source !== src) : s.composer.refs;
  setState({ session, composer: refs.length === s.composer.refs.length ? s.composer : { ...s.composer, refs, mask: null, outpaint: null } });
  if (s.selected === key) {
    const next = session[session.length - 1];
    if (next) selectItem(next.key);
    else setState({ selected: null });
  }
}

export function selectedItem(s: State): SessionItem | null {
  return s.session.find((i) => i.key === s.selected) ?? null;
}
