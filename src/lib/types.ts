// Mirrors the kokon-service JSON contract (crates/qls-core).

export type Mode = "auto" | "generate" | "edit" | "inpaint" | "outpaint" | "multi_reference" | "upscale";
export type ResolvedMode = Exclude<Mode, "auto">;
/** What made a saved result: a generation mode, or a colour LUT applied to an image. */
export type RecordMode = ResolvedMode | "lut";
/** What an inpaint does in the painted area. */
export type InpaintAction = "edit" | "remove" | "replace" | "add";
/** Presets of the Turbo model (8 steps, no CFG): ~1 MP, ~1.5K, native 2K. */
export type Quality = "fast" | "balanced" | "quality";
export type ResolutionMode = "auto" | "source" | "1k" | "1.5k" | "2k" | "custom";
export type OutputFormat = "png" | "jpeg" | "webp";
export type Units = "pixels" | "percent";
/** Refine effort of older versions' two-pass records (gallery details only). */
export type RefineMode = "off" | "fast" | "best";
/** The upscaler model only (older versions also had "detailed"). */
export type UpscaleMethod = "quick";

export interface UpscaleSpec { method: UpscaleMethod; scale?: number | null; width?: number | null; height?: number | null }

export interface Size { width: number; height: number }
export interface Rect { x: number; y: number; width: number; height: number }

export interface OutpaintSpec { left: number; right: number; top: number; bottom: number; units: Units }

export interface Advanced {
  sampler?: string | null;
  strength?: number | null;
  batch_count?: number | null;
  output_format?: OutputFormat | null;
  vae_tiling?: boolean | null;
  /** Keep a HEIC source's HDR gain map (Ultra HDR JPEG); null = on. */
  hdr?: boolean | null;
  /** Size of edit/combine sources given to the model; null = standard (1 MP). */
  reference_detail?: ReferenceDetail | null;
}

/** "standard": sources at most 1 MP, so the output renders larger; "full": up to the output's size. */
export type ReferenceDetail = "standard" | "full";

export interface GenerationRequest {
  prompt: string;
  negative_prompt?: string | null;
  mode: Mode;
  images: string[];
  mask?: string | null;
  inpaint_action?: InpaintAction;
  outpaint?: OutpaintSpec | null;
  quality: Quality;
  resolution: ResolutionMode;
  aspect_ratio?: string | null;
  width?: number | null;
  height?: number | null;
  seed?: number | null;
  preserve_dimensions?: boolean;
  advanced: Advanced;
  client?: string;
  parent_id?: string | null;
  upscale?: UpscaleSpec | null;
  /** Private mode: kept out of the gallery and the output folder, deleted when it ends. */
  private?: boolean;
  /** Prompt enhancer: the model's language model rewrites the prompt first (new images, edits, combines). */
  enhance?: boolean;
  /** LoRA ids to use (the app always sends its list; omitted = none, as for MCP). */
  loras?: string[] | null;
}

export interface WorkingCanvas { source: Size; content: Size; canvas: Size; content_offset: [number, number]; scale: number }
export interface RefPlan { index: number; source: Size; canvas: WorkingCanvas }

export interface Plan {
  mode: ResolvedMode;
  /** Inpaint action actually run (a "remove ..." prompt makes an edit a removal). */
  inpaint_action?: InpaintAction | null;
  auto_mode: boolean;
  mode_reason: string;
  output: Size;
  working: Size;
  content: Rect;
  steps: number;
  cfg: number;
  sampler: string;
  strength: number | null;
  batch_count: number;
  vae_tiling: boolean;
  references: RefPlan[];
  aspect_label: string;
  notes: string[];
  optimized_for_vram: boolean;
  /** Calibrated to this machine after its first image; 0 = not measured yet. */
  estimated_seconds: number;
  /** Part of that time the upscaler takes (0..1; known even when the estimate is 0; absent in
   * plans of older versions). */
  upscale_share?: number;
  upscaler: string | null;
  /** Upscaler tile size in px (0 in plans of older versions). */
  upscale_tile?: number;
  upscale: { method: UpscaleMethod; source: Size } | null;
  /** Edits and combines only (absent in older records). */
  reference_detail?: ReferenceDetail | null;
}

export interface AppErrorBody { code: string; message: string; suggestion?: string; detail?: string }

export interface ReferenceRecord { index: number; input_id: string; original_path?: string | null; width: number; height: number }

export interface PipelineRecord {
  base: Size | null;
  refine: RefineMode | null;
  refine_steps: number | null;
  refine_denoise: number | null;
  hires_upscaler: string | null;
  cache_threshold: number | null;
  enlarged_with: string | null;
  enlarged_from: Size | null;
  /** The result before that enlargement, kept by the service (absent on older results). */
  original_path?: string | null;
}

export interface GenerationRecord {
  id: string;
  created_at: string;
  mode: RecordMode;
  /** The prompt the image was made from (the prompt enhancer's when it ran). */
  prompt: string;
  /** The user's own prompt, when the prompt enhancer rewrote it. */
  original_prompt?: string | null;
  /** LoRAs the image was made with. */
  loras?: AppliedLora[];
  negative_prompt: string;
  seed: number;
  width: number;
  height: number;
  working_width: number;
  working_height: number;
  model: string;
  sampler: string;
  scheduler: string | null;
  steps: number;
  cfg: number;
  strength: number | null;
  /** May hold an older version's preset name ("turbo", "ultra"): see `normalizeQuality`. */
  quality: Quality | string;
  resolution: ResolutionMode;
  references: ReferenceRecord[];
  mask_input_id: string | null;
  outpaint: { left: number; right: number; top: number; bottom: number } | null;
  file_path: string;
  extra_paths: string[];
  favorite: boolean;
  parent_id: string | null;
  duration_ms: number;
  notes: string[];
  request: GenerationRequest | null;
  pipeline?: PipelineRecord | null;
}

/** A LoRA as an image used it. */
export interface AppliedLora { id: string; name: string; weight: number; trigger_words?: string }

/** One of the user's LoRAs (Settings → LoRA); Kokon's prepared copy is `<dir>/<id>.safetensors`. */
export interface LoraItem {
  id: string;
  name: string;
  /** The file the user picked. */
  source: string;
  weight: number;
  triggerWords: string;
  onByDefault: boolean;
  size: number;
  warning: string | null;
  notes: string[];
  addedAt: string;
  /** Kokon's copy is still in its LoRA folder. */
  available: boolean;
}

/** A .cube LUT in Kokon's list (the user's, most recently used first, then Kokon's presets). */
export interface LutEntry { name: string; title: string | null; kind: "1d" | "3d"; size: number; builtin: boolean }
/** How a "lut" result was made (in its `request`). */
export interface LutInfo { name: string; title?: string | null; intensity: number }

export type JobStatus = "queued" | "starting_backend" | "preparing" | "enhancing_prompt" | "running" | "saving" | "done" | "failed" | "cancelled";
export type BackendStage = "preparing" | "encoding_images" | "encoding_prompt" | "generating" | "upscaling" | "refining" | "decoding" | "finishing";

export interface JobView {
  id: string;
  status: JobStatus;
  stage: BackendStage | null;
  step: [number, number] | null;
  image: [number, number] | null;
  seconds_per_step: number | null;
  queue_position: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  prompt: string;
  /** The prompt enhancer's text: growing while "enhancing_prompt", then the prompt in use. */
  enhanced_prompt?: string | null;
  plan: Plan | null;
  seed: number | null;
  results: GenerationRecord[];
  error: AppErrorBody | null;
  notes: string[];
  detailed_progress: boolean;
}

export interface InputRecord {
  id: string;
  path: string;
  original_name: string | null;
  original_path: string | null;
  width: number;
  height: number;
  format: string;
  has_alpha: boolean;
  /** HEIC with an HDR gain map. */
  hdr?: boolean;
}

export type ServerState = "stopped" | "starting" | "ready" | "error";

export interface StatusResponse {
  service: { version: string; pid: number; uptime_s: number };
  server: {
    state: ServerState; owned: boolean; pid: number | null; port: number; model: string | null; model_loaded: boolean; error: AppErrorBody | null;
    /** The loaded engine can write prompts (prompt enhancer); null while no model is loaded. */
    text_generation?: boolean | null;
    /** The engine can run an upscaler model (null: not running). */
    upscale?: boolean | null;
  };
  profile: { id: string; display_name: string; source: ProfileSource };
  gpu: { name: string; vendor: string; unified: boolean; memory_total_mib: number; memory_used_mib: number; memory_free_mib: number; driver_version: string } | null;
  active_job: JobView | null;
  queue: { queued: number; jobs: JobView[] };
  upscaler?: { model: string; available: boolean };
  /** The installed engine predates `release` (needed for the upscaler): Setup updates it. */
  engine?: { release: string; update_needed: boolean };
  setup_complete: boolean;
}

export interface Check { id: string; label: string; ok: boolean; detail: string }
export interface SetupReport { ready: boolean; checks: Check[]; devices: [string, string][]; backend_version: string | null }

export type TextEncoderPlacement = "ram" | "gpu" | "cpu" | "auto" | "disk";

/** Official: files Setup downloaded and Kokon tested. User: files the user already had. */
export type ProfileSource = "official" | "user";

export interface ModelProfile {
  id: string;
  displayName: string;
  /** The model the files are ("qwen-image-2.1"). */
  model: string;
  source: ProfileSource;
  /** Folder the user's files were found in. */
  scanDir: string | null;
  diffusionModel: string;
  vae: string;
  textEncoder: string;
  visionProjector: string | null;
  backendArgs: string[];
  recommendedSettings: Record<string, unknown>;
  capabilities: Record<string, boolean>;
}

/** stable-diffusion.cpp build: CUDA (NVIDIA) or Vulkan (AMD, Intel, also NVIDIA). */
export type GpuBackend = "cuda" | "vulkan" | "metal";

export interface AppConfig {
  schemaVersion: number;
  sdcppDir: string;
  gpuBackend: GpuBackend;
  serverPort: number;
  servicePort: number;
  activeProfile: string;
  profiles: ModelProfile[];
  device: string;
  textEncoderPlacement: TextEncoderPlacement;
  vramReserveGib: number;
  flashAttention: boolean;
  sageAttention: boolean;
  /** The card is too old for SageAttention (before RTX 30 / compute capability 8.0); detected, read-only. */
  sageUnsupported?: boolean;
  vaeTileSize: number;
  prefixCacheType: string;
  eagerLoad: boolean;
  /** Upscaler model (file stem); the bundled MoSR runs when its file is missing. */
  upscalerModel: string;
  /** Upscaler tile size in px; 0 = automatic (ESRGAN 128; MoSR 768, or 256 under 14 GB). */
  upscaleTileSize: number;
  /** Share of the upscaler's result kept over a Lanczos enlargement (0..1). */
  upscaleBlend: number;
  /** Shrink the input before upscaling (enlargements under ~2.8x). */
  upscalePrescale: boolean;
  extraServerArgs: string[];
  outputDir: string;
  keepServerRunning: boolean;
  idleUnloadMinutes: number;
  setupComplete: boolean;
  /** Hardware preset chosen in the setup wizard. */
  hardwarePreset: string;
  /** Plan as if the GPU had this much VRAM (MiB); 0 = detected. */
  vramOverrideMib: number;
  /** Prompt enhancer instructions for new images and for edits; "" = the built-in ones. */
  enhancerT2iPrompt?: string;
  enhancerEditPrompt?: string;
  ui: Record<string, unknown>;
}

export type InstallItemState = "present" | "pending" | "downloading" | "verifying" | "extracting" | "done" | "failed" | "cancelled";

export interface InstallItem {
  id: string;
  label: string;
  kind: "engine" | "model";
  size: number;
  received: number;
  state: InstallItemState;
  error: string | null;
  hint: string | null;
  url: string;
  page: string;
  path: string;
}

/** An upscaler offered in Settings (`GET /upscalers`). */
export interface UpscalerItem { name: string; label: string; installed: boolean; size: number | null; page: string | null }

export interface InstallStatus {
  running: boolean;
  complete: boolean;
  preset: string | null;
  sdcpp_dir: string | null;
  items: InstallItem[];
  bytes_per_sec: number;
}

export interface HardwarePreset {
  id: string;
  label: string;
  summary: string;
  verified: boolean;
  min_vram_mib: number;
  files: InstallItem[];
  download_bytes: number;
  disk_bytes: number;
}

export type ModelRole = "diffusion" | "vae" | "text_encoder" | "vision_projector";

/** What a model file is (read from its header). */
export interface ModelFileInfo {
  path: string;
  size: number;
  role: ModelRole | null;
  /** Usable with Qwen-Image 2.1 in this role. */
  compatible: boolean;
  /** A text encoder with the vision weights (no projector needed). */
  has_vision: boolean;
  /** Main weight type, e.g. "Q4_K", "BF16", "INT8". */
  weights: string;
  official: boolean;
  problem: string | null;
}

export interface ModelScan {
  dir: string;
  files: ModelFileInfo[];
  picks: Record<"diffusion" | "vae" | "text_encoder" | "vision_projector", string | null>;
  /** Missing files of the active profile found under the same name (moved). */
  moved: Partial<Record<ModelRole, string>>;
}

/** A file the user chose, or an official file to download into a folder. */
export type ModelSlot = { path: string } | { download: string };

/** The active model's files and what is missing (`GET /models`). */
export interface ModelsStatus {
  active: { id: string; display_name: string; source: ProfileSource; model: string };
  slots: { role: ModelRole | null; label: string; path: string; exists: boolean; info: ModelFileInfo | null }[];
  missing: { label: string; path: string }[];
  /** Missing files Setup can download (official ones). */
  downloadable: string[];
  engine_installed: boolean;
  /** Folder the active files were found in (none for the official files). */
  scan_dir: string | null;
  /** Folder of the user's own files. */
  user_scan_dir: string | null;
  has_user_profile: boolean;
  /** Every file of the user's own profile is there. */
  user_installed: boolean;
  official_installed: boolean;
  default_download_dir: string;
  /** The texture-fix VAE (#21): in use, or what switching to it downloads. */
  vae: { improved: boolean; download_bytes: number; page: string };
}

export interface HardwareReport {
  /** Source of the active profile. */
  active_source: ProfileSource;
  /** What the user's own-files profile still needs (engine, upscalers, official pieces). */
  user_files: { files: InstallItem[]; download_bytes: number; disk_bytes: number } | null;
  /** The card the presets are sized for (`gpu_index` in `gpus`). */
  gpu: StatusResponse["gpu"];
  gpus: { name: string; memory_total_mib: number }[];
  gpu_index: number;
  /** Card the engine runs on now. */
  gpu_in_use: number;
  nvidia: boolean;
  vendor: string | null;
  /** Engine the presets' file lists are for. */
  backend: GpuBackend;
  recommended_backend: GpuBackend;
  /** Engine in use now. */
  current_backend: GpuBackend;
  vram_mib: number | null;
  vram_simulated: boolean;
  ram_total_mib: number;
  recommended: string;
  current: string;
  presets: HardwarePreset[];
  sdcpp_dir: string;
  default_sdcpp_dir: string;
  free_bytes: number | null;
  issues_url: string;
}

export type ServiceEvent =
  | { type: "job"; job: JobView }
  | { type: "server"; state: ServerState; owned: boolean; error: AppErrorBody | null }
  | { type: "gallery"; id: string; change: "added" | "updated" | "deleted" };
