// Thin client for the local kokon-service API. Images are referenced by URL (with the
// token as a query parameter) so the webview streams them directly — no base64 copies.
// In a browser (another device) there is no token: the session cookie signs requests in, and
// every change carries the CSRF header the service asks for.

import { inBrowser } from "./platform";
import type { ProjectData } from "./store";
import type {
  GpuBackend,
  AppConfig, AppErrorBody, GenerationRecord, GenerationRequest, HardwareReport, InputRecord, InstallStatus, JobView, LoraItem, LutEntry, MacBenchState, ModelFileInfo, ModelScan, ModelSlot, ModelsStatus, Plan,
  ServiceEvent, SetupReport, StatusResponse, UpscalerItem,
} from "./types";

export class ApiError extends Error {
  constructor(public body: AppErrorBody, public status: number) {
    super(body.message);
  }
}

let base = "";
let token = "";
/** Private mode: uploads and imports go to the service's temporary store. */
let privateInputs = false;

export function setPrivateInputs(on: boolean) {
  privateInputs = on;
}

const privateQuery = () => (privateInputs ? "?private=true" : "");

export function configure(baseUrl: string, tok: string) {
  base = baseUrl;
  token = tok;
}

export const isConfigured = () => base !== "";

/** Browser: the session ended (new password, signed out elsewhere); the app asks to sign in again. */
let onSignedOut = () => {};
export function setSignedOutHandler(f: () => void) {
  onSignedOut = f;
}

function authHeaders(method: string | undefined): Record<string, string> {
  if (!inBrowser) return { Authorization: `Bearer ${token}` };
  return method && method !== "GET" ? { "x-kokon-csrf": "1" } : {};
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { ...authHeaders(init.method), ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    });
  } catch (e) {
    throw new ApiError({ code: "server_unavailable", message: inBrowser ? "Kokon is not reachable." : "The local service is not reachable.", detail: String(e) }, 0);
  }
  const text = await res.text();
  let data: any = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    if (inBrowser && data?.error?.code === "login_required" && !path.startsWith("/auth/")) onSignedOut();
    const message = data?.error?.message ?? (text.trim() || `HTTP ${res.status}`);
    const code = data?.error?.code ?? "internal";
    throw new ApiError({ code, message, detail: data?.error?.detail ?? (data ? undefined : text.trim()) }, res.status);
  }
  return data as T;
}

/** `?token=…` for URLs the browser loads by itself (images, events); nothing in a browser, where the cookie signs in. */
const tq = (sep: "?" | "&") => (token ? `${sep}token=${token}` : "");

export interface RemoteStatus {
  enabled: boolean;
  forced: boolean;
  port: number;
  password_set: boolean;
  listening: boolean;
  url: string | null;
  error: string | null;
  min_password_chars: number;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  status: () => call<StatusResponse>("/status"),
  setup: () => call<SetupReport>("/setup"),
  /** `gpu`: index in `gpus` to size the presets for (default: the card in use). */
  hardware: (backend?: GpuBackend, gpu?: number) => {
    const q = new URLSearchParams();
    if (backend) q.set("backend", backend);
    if (gpu !== undefined) q.set("gpu", String(gpu));
    const qs = q.toString();
    return call<HardwareReport>(`/setup/hardware${qs ? `?${qs}` : ""}`);
  },
  /** `apply = false`: only download (an engine update), keeping the configured preset and settings.
   * `gpu`: card to run on once installed (index in `hardware().gpus`). */
  install: (preset: string, backend: GpuBackend, apply = true, gpu?: number, target?: "official" | "user") =>
    call<InstallStatus>("/setup/install", { method: "POST", body: json({ preset, backend, apply, gpu, target }) }),
  /** The active model's files and what is missing. */
  models: () => call<ModelsStatus>("/models"),
  /** Model files in a folder (sub-folders included), with a suggested file per role. */
  scanModels: (dir: string) => call<ModelScan>("/models/scan", { method: "POST", body: json({ dir }) }),
  inspectModel: (path: string) => call<ModelFileInfo>("/models/inspect", { method: "POST", body: json({ path }) }),
  /** Saves the user's own files (checked) as the active model; `vision_projector` null = not needed. */
  setUserModels: (b: { diffusion_model: ModelSlot; vae: ModelSlot; text_encoder: ModelSlot; vision_projector: ModelSlot | null; scan_dir: string | null }) =>
    call<ModelsStatus>("/models/user", { method: "POST", body: json(b) }),
  useModels: (profile: "official" | "user") => call<ModelsStatus>("/models/use", { method: "POST", body: json({ profile }) }),
  /** Downloads the texture-fix VAE and switches the active model to it (progress in installStatus). */
  improveVae: () => call<InstallStatus>("/models/vae", { method: "POST" }),
  newImageModel: () => call<InstallStatus>("/models/dit", { method: "POST" }),
  /** Runs the engine on another card (index in `hardware().gpus`); needs the engine installed. */
  setGpu: (gpu: number) => call<{ saved: boolean }>("/setup/gpu", { method: "POST", body: json({ gpu }) }),
  upscalers: () => call<{ selected: string; active: string | null; items: UpscalerItem[] }>("/upscalers"),
  /** Progress in `installStatus` (preset "upscaler:<name>"). */
  downloadUpscaler: (name: string) => call<InstallStatus>(`/upscalers/${encodeURIComponent(name)}/download`, { method: "POST" }),
  /** ESRGAN models of earlier versions in the app's own folder. */
  legacyUpscalers: (keep: string) => call<{ files: string[]; bytes: number }>(`/setup/legacy-upscalers?keep=${encodeURIComponent(keep)}`),
  /** `keep`: the model chosen in Settings, even if not saved yet. */
  removeLegacyUpscalers: (keep: string) => call<{ freed_bytes: number }>(`/setup/legacy-upscalers?keep=${encodeURIComponent(keep)}`, { method: "DELETE" }),
  /** Benchmark this Mac (Kokon's Mac engine); progress also arrives as `mac_bench` events. */
  macBench: () => call<MacBenchState>("/mac-engine/bench"),
  /** `quick`: one image per run instead of two. */
  startMacBench: (quick = false) => call<MacBenchState>("/mac-engine/bench", { method: "POST", body: json({ quick }) }),
  cancelMacBench: () => call<MacBenchState>("/mac-engine/bench/cancel", { method: "POST" }),
  clearMacBench: () => call<MacBenchState>("/mac-engine/bench", { method: "DELETE" }),
  installStatus: () => call<InstallStatus>("/setup/install"),
  cancelInstall: () => call<InstallStatus>("/setup/install/cancel", { method: "POST" }),
  config: () => call<AppConfig>("/config"),
  /** The prompt enhancer's built-in instructions. */
  enhancerDefaults: () => call<{ t2i: string; edit: string; compose: string; max_chars: number }>("/enhancer/defaults"),
  saveConfig: (c: AppConfig) => call<{ saved: boolean; backend_restart_needed: boolean }>("/config", { method: "PUT", body: json(c) }),
  startBackend: (opts?: { profile?: string; mode?: "image" | "video" }) => call<{ ready: boolean; model?: string }>("/backend/start", { method: "POST", body: json(opts ?? {}) }),
  stopBackend: () => call<{ stopped: boolean }>("/backend/stop", { method: "POST" }),
  restartBackend: (opts?: { profile?: string; mode?: "image" | "video" }) => call<{ ready: boolean; model?: string }>("/backend/restart", { method: "POST", body: json(opts ?? {}) }),
  diagnostics: () => call<{ text: string }>("/diagnostics"),
  plan: (r: GenerationRequest) => call<Plan>("/plan", { method: "POST", body: json(r) }),
  submit: (r: GenerationRequest) => call<JobView>("/jobs", { method: "POST", body: json(r) }),
  job: (id: string) => call<JobView>(`/jobs/${id}`),
  jobs: () => call<JobView[]>("/jobs"),
  cancel: (id: string) => call<JobView>(`/jobs/${id}/cancel`, { method: "POST" }),
  upload: (bytes: Blob | ArrayBuffer | Uint8Array, name?: string) =>
    call<InputRecord>(`/inputs${privateQuery()}`, { method: "POST", body: bytes as BodyInit, headers: { "Content-Type": "application/octet-stream", ...(name ? { "x-filename": encodeURIComponent(name) } : {}) } }),
  importPath: (path: string) => call<InputRecord>(`/inputs/import${privateQuery()}`, { method: "POST", body: json({ path }) }),
  clearPrivate: () => call<{ cleared: number }>("/private/clear", { method: "POST" }),
  input: (id: string) => call<InputRecord>(`/inputs/${id}`),
  gallery: (q: { q?: string; favorites?: boolean; limit?: number; offset?: number; sort?: string }) => {
    const p = new URLSearchParams();
    if (q.q) p.set("q", q.q);
    if (q.favorites) p.set("favorites", "true");
    if (q.limit) p.set("limit", String(q.limit));
    if (q.offset) p.set("offset", String(q.offset));
    if (q.sort) p.set("sort", q.sort);
    return call<{ items: GenerationRecord[]; total: number }>(`/gallery?${p}`);
  },
  generation: (id: string) => call<GenerationRecord>(`/gallery/${id}`),
  setFavorite: (id: string, favorite: boolean) => call<GenerationRecord>(`/gallery/${id}`, { method: "PATCH", body: json({ favorite }) }),
  deleteGeneration: (id: string) => call<{ deleted: string }>(`/gallery/${id}`, { method: "DELETE" }),
  /** Adds the bundled example projects to the gallery (idempotent) and lists them. */
  installExamples: () => call<{ projects: { title: string; generations: string[] }[] }>("/examples", { method: "POST" }),
  loras: () => call<{ items: LoraItem[]; dir: string; max_active: number }>("/loras"),
  /** Checks a LoRA file against the image model and loads Kokon's copy of it. */
  addLora: (path: string) => call<LoraItem>("/loras", { method: "POST", body: json({ path }) }),
  updateLora: (id: string, patch: Partial<Pick<LoraItem, "name" | "weight" | "triggerWords" | "onByDefault">>) =>
    call<LoraItem>(`/loras/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) }),
  /** Removes the LoRA and Kokon's copy (the user's file stays). */
  removeLora: (id: string) => call<{ removed: string }>(`/loras/${encodeURIComponent(id)}`, { method: "DELETE" }),
  luts: () => call<{ items: LutEntry[] }>("/luts"),
  /** Adds a .cube file to the list (copied into Kokon's data folder). */
  importLut: (path: string) => call<LutEntry>("/luts/import", { method: "POST", body: json({ path }) }),
  removeLut: (name: string) => call<{ removed: string }>(`/luts/${encodeURIComponent(name)}`, { method: "DELETE" }),
  /** Saves `source` with the LUT applied as a new version; `intensity` 0-1. */
  applyLut: (name: string, source: string, intensity: number, isPrivate: boolean) =>
    call<GenerationRecord>(`/luts/${encodeURIComponent(name)}/apply`, { method: "POST", body: json({ source, intensity, private: isPrivate }) }),
  exportGeneration: (id: string, path: string, original = false) => call<{ path: string }>(`/gallery/${id}/export`, { method: "POST", body: json({ path, overwrite: true, original }) }),
  /** The project list every device shares (crates/qls-core/src/projects.rs). */
  projects: () => call<{ projects: ProjectData[] }>("/projects"),
  project: (id: string) => call<ProjectData>(`/projects/${encodeURIComponent(id)}`),
  /** The records of every version of a project, in one answer; deleted versions are left out. */
  projectRecords: (id: string) =>
    call<{ generations: Record<string, GenerationRecord>; inputs: Record<string, InputRecord> }>(`/projects/${encodeURIComponent(id)}/records`),
  /** `known`: the version keys of the copy last heard from the service; answers with the merged project. */
  saveProject: (id: string, project: ProjectData, known: string[]) => call<ProjectData>(`/projects/${encodeURIComponent(id)}`, { method: "PUT", body: json({ project, known }) }),
  deleteProject: (id: string) => call<{ deleted: string }>(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** This app's list from before 0.11 (browser storage), merged in once. */
  importProjects: (projects: ProjectData[]) => call<{ changed: number }>("/projects/import", { method: "POST", body: json({ projects }) }),
  /** Browser sign-in (see crates/qls-service/src/remote.rs). */
  session: () => call<{ signed_in: boolean; password_set: boolean }>("/auth/session"),
  login: (password: string) => call<{ signed_in: boolean }>("/auth/login", { method: "POST", body: json({ password }) }),
  logout: () => call<{ signed_in: boolean }>("/auth/logout", { method: "POST" }),
  /** Access from other devices (desktop app only). */
  remote: () => call<RemoteStatus>("/remote"),
  setRemote: (enabled: boolean, port?: number) => call<RemoteStatus>("/remote", { method: "POST", body: json({ enabled, port }) }),
  setRemotePassword: (password: string) => call<RemoteStatus>("/remote/password", { method: "POST", body: json({ password }) }),
  removeRemotePassword: () => call<RemoteStatus>("/remote/password", { method: "DELETE" }),
  /** Browser: keeps the service from exiting while this tab is open (the desktop app does it from Rust). */
  heartbeat: (clientId: string) => call<{ ok: boolean }>("/session/heartbeat", { method: "POST", body: json({ client_id: clientId, kind: "web" }) }),
};

export const urls = {
  input: (id: string) => `${base}/inputs/${id}/image${tq("?")}`,
  inputThumb: (id: string) => `${base}/inputs/${id}/thumb${tq("?")}`,
  gen: (id: string) => `${base}/gallery/${id}/image${tq("?")}`,
  genThumb: (id: string) => `${base}/gallery/${id}/thumb${tq("?")}`,
  /** Screen-sized copies for a browser's stage (at most `PREVIEW_SIDE` px, logic.ts). */
  genPreview: (id: string) => `${base}/gallery/${id}/preview${tq("?")}`,
  inputPreview: (id: string) => `${base}/inputs/${id}/preview${tq("?")}`,
  /** The result before the upscaler enlarged it (`pipeline.original_path`). */
  genOriginal: (id: string) => `${base}/gallery/${id}/original${tq("?")}`,
  /** Full image for a "gen:<id>" / "input:<id>" source. */
  source: (s: string) => (s.startsWith("gen:") ? urls.gen(s.slice(4)) : urls.input(s.slice(6))),
  /** A LUT on a "gen:"/"input:" source at full strength, at most `max` px on its long side. */
  lutPreview: (name: string, source: string, max: number) => `${base}/luts/${encodeURIComponent(name)}/preview?source=${encodeURIComponent(source)}&max=${max}${tq("&")}`,
  sourcePreview: (s: string) => (s.startsWith("gen:") ? urls.genPreview(s.slice(4)) : urls.inputPreview(s.slice(6))),
  sourceThumb: (s: string) => (s.startsWith("gen:") ? urls.genThumb(s.slice(4)) : urls.inputThumb(s.slice(6))),
};

/** Server-sent events with automatic reconnect. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: ServiceEvent) => void, onState?: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: number | undefined;
  const open = () => {
    es = new EventSource(`${base}/events${tq("?")}`);
    es.onopen = () => onState?.(true);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data));
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      onState?.(false);
      es?.close();
      if (closed) return;
      retry = window.setTimeout(open, 1500);
      // An EventSource never says why it failed: a browser whose session ended (new password, a
      // restart that didn't keep it) goes to the sign-in now, not at the next heartbeat.
      if (inBrowser)
        api.session().then(
          (s) => {
            if (s.signed_in || closed) return;
            closed = true;
            window.clearTimeout(retry);
            onSignedOut();
          },
          () => {},
        );
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    es?.close();
  };
}
