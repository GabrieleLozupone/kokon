// Thin client for the local kokon-service API. Images are referenced by URL (with the
// token as a query parameter) so the webview streams them directly — no base64 copies.

import type {
  GpuBackend,
  AppConfig, AppErrorBody, GenerationRecord, GenerationRequest, HardwareReport, InputRecord, InstallStatus, JobView, Plan, ServiceEvent, SetupReport, StatusResponse,
  UpscalerItem,
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

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    });
  } catch (e) {
    throw new ApiError({ code: "server_unavailable", message: "The local service is not reachable.", detail: String(e) }, 0);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(data?.error ?? { code: "internal", message: `HTTP ${res.status}` }, res.status);
  }
  return data as T;
}

const json = (body: unknown) => JSON.stringify(body);

export const api = {
  status: () => call<StatusResponse>("/status"),
  setup: () => call<SetupReport>("/setup"),
  hardware: (backend?: GpuBackend) => call<HardwareReport>(backend ? `/setup/hardware?backend=${backend}` : "/setup/hardware"),
  /** `apply = false`: only download (an engine update), keeping the configured preset and settings. */
  install: (preset: string, backend: GpuBackend, apply = true) => call<InstallStatus>("/setup/install", { method: "POST", body: json({ preset, backend, apply }) }),
  upscalers: () => call<{ selected: string; active: string | null; items: UpscalerItem[] }>("/upscalers"),
  /** Progress in `installStatus` (preset "upscaler:<name>"). */
  downloadUpscaler: (name: string) => call<InstallStatus>(`/upscalers/${encodeURIComponent(name)}/download`, { method: "POST" }),
  /** ESRGAN models of earlier versions in the app's own folder. */
  legacyUpscalers: (keep: string) => call<{ files: string[]; bytes: number }>(`/setup/legacy-upscalers?keep=${encodeURIComponent(keep)}`),
  /** `keep`: the model chosen in Settings, even if not saved yet. */
  removeLegacyUpscalers: (keep: string) => call<{ freed_bytes: number }>(`/setup/legacy-upscalers?keep=${encodeURIComponent(keep)}`, { method: "DELETE" }),
  installStatus: () => call<InstallStatus>("/setup/install"),
  cancelInstall: () => call<InstallStatus>("/setup/install/cancel", { method: "POST" }),
  config: () => call<AppConfig>("/config"),
  saveConfig: (c: AppConfig) => call<{ saved: boolean; backend_restart_needed: boolean }>("/config", { method: "PUT", body: json(c) }),
  startBackend: () => call<{ ready: boolean }>("/backend/start", { method: "POST" }),
  stopBackend: () => call<{ stopped: boolean }>("/backend/stop", { method: "POST" }),
  restartBackend: () => call<{ ready: boolean }>("/backend/restart", { method: "POST" }),
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
  exportGeneration: (id: string, path: string, original = false) => call<{ path: string }>(`/gallery/${id}/export`, { method: "POST", body: json({ path, overwrite: true, original }) }),
};

export const urls = {
  input: (id: string) => (id.startsWith("/") ? id : `${base}/inputs/${id}/image?token=${token}`),
  inputThumb: (id: string) => (id.startsWith("/") ? id : `${base}/inputs/${id}/thumb?token=${token}`),
  gen: (id: string) => (id.startsWith("/") ? id : `${base}/gallery/${id}/image?token=${token}`),
  genThumb: (id: string) => (id.startsWith("/") ? id : `${base}/gallery/${id}/thumb?token=${token}`),
  /** The result before the upscaler enlarged it (`pipeline.original_path`). */
  genOriginal: (id: string) => (id.startsWith("/") ? id : `${base}/gallery/${id}/original?token=${token}`),
  /** Full image for a "gen:<id>" / "input:<id>" source. */
  source: (s: string) => (s.startsWith("/") ? s : s.startsWith("gen:") ? urls.gen(s.slice(4)) : urls.input(s.slice(6))),
  sourceThumb: (s: string) => (s.startsWith("/") ? s : s.startsWith("gen:") ? urls.genThumb(s.slice(4)) : urls.inputThumb(s.slice(6))),
};

/** Server-sent events with automatic reconnect. Returns an unsubscribe function. */
export function subscribe(onEvent: (e: ServiceEvent) => void, onState?: (connected: boolean) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: number | undefined;
  const open = () => {
    es = new EventSource(`${base}/events?token=${token}`);
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
      if (!closed) retry = window.setTimeout(open, 1500);
    };
  };
  open();
  return () => {
    closed = true;
    window.clearTimeout(retry);
    es?.close();
  };
}
