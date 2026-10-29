//! Persistent configuration and model profiles. Stored as JSON in
//! `%APPDATA%\Kokon\config.json`; every field has a default so older or
//! partial files keep loading.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};
use crate::planner::Mode;

pub const APP_NAME: &str = "Kokon";
/// Folder names before the app was renamed Kokon (2026-10-08); moved on first start.
const LEGACY_CONFIG_DIR: &str = "Qwen Local Studio";
const LEGACY_DATA_DIR: &str = "QwenLocalStudio";
/// Distinct from the installer's program folder `%LOCALAPPDATA%\Kokon`, so uninstalling
/// never touches the gallery or the models.
pub const DATA_DIR_NAME: &str = "KokonData";
pub const DEFAULT_SERVER_PORT: u16 = 39150;
pub const DEFAULT_SERVICE_PORT: u16 = 39151;
/// Port for access from other devices (`remote_access`); the token API stays on loopback.
pub const DEFAULT_REMOTE_PORT: u16 = 39152;
/// Schema 8 (2026-10-12): the upscalers folder setting is gone (always `<sdcpp>/models/upscalers`)
/// and ESRGAN tile sizes reset to automatic.
/// Schema 9 (2026-10-16, #14): profiles record their model and source; model paths edited by
/// hand on the official profile move to a profile of the user's own files.
/// Schema 10 (2026-10-19): the 8 GB preset's VRAM reserve 1 -> 1.5 GiB (unless set by hand).
const SCHEMA_VERSION: u32 = 10;
/// `upscaler_model` value for a plain Lanczos resize (no model).
pub const LANCZOS: &str = "lanczos";
/// Upscalers offered in Settings: (file stem, label). Superscale-SP is a setup download, MoSR is
/// bundled with the app, UltraSharp is an optional download (`catalog::UPSCALER_DOWNLOADS`).
pub const UPSCALER_CHOICES: &[(&str, &str)] = &[
    ("4x_NMKD-Superscale-SP_178000_G", "Superscale-SP"),
    (crate::catalog::UPSCALER_NAME, "MoSR (experimental)"),
    ("4x-UltraSharp", "UltraSharp"),
    (LANCZOS, "Lanczos (plain resize)"),
];
/// Default model (user choice, 2026-10-12, after MoSR drew a grid on clean renders): Superscale-SP
/// on PCs, Lanczos on Macs, where ESRGAN takes minutes (1024² to 2048² on an M2 Pro: Superscale-SP
/// 5 min 45 s, Lanczos 1 s).
pub const DEFAULT_UPSCALER: &str = if cfg!(target_os = "macos") { LANCZOS } else { UPSCALER_CHOICES[0].0 };
/// Extensions sd-server accepts for model-backed upscalers (common.cpp, commit 3f8527a).
pub const UPSCALER_EXTENSIONS: &[&str] = &["pth", "safetensors", "gguf", "pt"];
/// Profile id of the official Qwen-Image 2.1 weights (the default since schema 5).
pub const OFFICIAL_PROFILE_ID: &str = "qwen-image-2.1";
/// Profile id of Qwen-Image 2.1 files the user already had (#14): one per model.
pub const USER_PROFILE_ID: &str = "qwen-image-2.1-user";
/// The model a profile's files are (`ModelProfile::model`). Today the only one; future model
/// definitions (strategy, presets, prompts) will be looked up by this id.
pub const QWEN_IMAGE_21: &str = "qwen-image-2.1";

/// Video model profile constants (Wan 2.2 SOTA).
pub const WAN_2_2: &str = "wan-2.2";
pub const WAN_OFFICIAL_PROFILE_ID: &str = "wan-2.2";
pub const WAN_USER_PROFILE_ID: &str = "wan-2.2-user";

/// Where the text encoder's weights live. Compute always runs on the selected GPU except
/// for `Cpu`, which also computes on the CPU (slow for image editing, measured ~35×).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TextEncoderPlacement {
    /// Weights in system RAM, compute on GPU (`--params-backend te=cpu`). Recommended.
    #[default]
    Ram,
    /// Weights and compute on GPU (fastest prompt encoding, slower sampling on 16 GB).
    Gpu,
    /// Weights and compute on CPU (`--backend te=cpu`). Lowest VRAM, slow editing.
    Cpu,
    /// Let stable-diffusion.cpp's auto-fit decide.
    Auto,
    /// Every model's weights reloaded from disk when needed (`--params-backend disk`).
    /// Least memory, slower; for Macs with 16 GB of unified memory.
    Disk,
}

/// Which stable-diffusion.cpp build runs the model. Each build lives in its own folder, so
/// Folder of Kokon's Mac engine, in the stable-diffusion.cpp folder (beside `engine-metal`), and its executable
/// (the engine's kernels and resources are the `KokonEngineMac_KokonEngine.bundle` next to it).
pub const MAC_ENGINE_DIR: &str = "engine-mac";
pub const MAC_ENGINE_EXE: &str = "kokon-engine-mac";

/// switching back and forth needs no re-download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GpuBackend {
    /// NVIDIA (CUDA 12 build). The verified path.
    Cuda,
    /// AMD, Intel and NVIDIA through Vulkan. Works on NVIDIA; AMD/Intel unverified.
    Vulkan,
    /// Apple Silicon (Metal build, macOS 15+). Beta.
    Metal,
}

impl Default for GpuBackend {
    /// The engine of this platform when nothing is configured.
    fn default() -> Self {
        if cfg!(target_os = "macos") { GpuBackend::Metal } else { GpuBackend::Cuda }
    }
}

impl GpuBackend {
    /// ggml device-name prefix (`cuda0`, `vulkan0`).
    pub fn device_prefix(self) -> &'static str {
        match self {
            GpuBackend::Cuda => "cuda",
            GpuBackend::Vulkan => "vulkan",
            // ggml registers the Mac GPU as "MTL0" (`--list-devices`, seen on an M2 Pro).
            GpuBackend::Metal => "mtl",
        }
    }

    /// Folder of this build, relative to the stable-diffusion.cpp folder ("" = the folder
    /// itself, where the CUDA build has always been).
    pub fn engine_subdir(self) -> &'static str {
        match self {
            GpuBackend::Cuda => "",
            GpuBackend::Vulkan => "engine-vulkan",
            GpuBackend::Metal => "engine-metal",
        }
    }

    /// Engine for a GPU vendor as reported by `diagnostics::query_gpus`.
    pub fn for_vendor(vendor: &str) -> Self {
        match vendor {
            "nvidia" => GpuBackend::Cuda,
            "apple" => GpuBackend::Metal,
            _ => GpuBackend::Vulkan,
        }
    }
}

/// Effort of the refine pass of older versions (two-pass generation, removed 2026-10-06;
/// Detailed upscale, removed 2026-10-09). Kept to read their gallery records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RefineMode {
    /// Kept for old configs; behaves like Fast.
    Off,
    /// Fewer refine steps + EasyCache.
    #[default]
    Fast,
    /// More refine steps, no cache.
    Best,
}

/// Per-model planning settings. Sampling itself is fixed by the Turbo model: its 8-step
/// schedule (`planner::TURBO_SIGMAS`) at CFG 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RecommendedSettings {
    pub sampler: String,
    /// Pixel area used by Auto resolution at each quality level.
    pub area_fast: u64,
    pub area_balanced: u64,
    pub area_quality: u64,
    pub align: u32,
    pub max_side: u32,
    pub max_references: u32,
}

impl Default for RecommendedSettings {
    fn default() -> Self {
        // Official Qwen-Image 2.1 Turbo settings (Qwen/Qwen-Image-2.1-Turbo model card): its
        // saved 8-step schedule with flow-matching Euler, no CFG, native 2K buckets. The
        // presets differ only in size: ~1 MP, 1.5K and native 2K.
        Self { sampler: "euler".into(), area_fast: 1024 * 1024, area_balanced: 1536 * 1536, area_quality: 2048 * 2048, align: 32, max_side: 4096, max_references: 10 }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProfileCapabilities {
    pub text_to_image: bool,
    pub edit: bool,
    pub multi_reference: bool,
    pub inpaint: bool,
    pub outpaint: bool,
    pub alpha: bool,
}

impl Default for ProfileCapabilities {
    fn default() -> Self {
        Self { text_to_image: true, edit: true, multi_reference: true, inpaint: true, outpaint: true, alpha: true }
    }
}

/// Where a profile's files come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileSource {
    /// Downloaded by Setup from the catalog, tested with Kokon. Paths follow the folder and preset.
    Official,
    /// Files the user already had (any folder, any quantization), not tested by Kokon.
    User,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub display_name: String,
    /// The model these files are ([`QWEN_IMAGE_21`]).
    pub model: String,
    pub source: ProfileSource,
    /// Folder the user's files were found in (Setup searches it again when one has moved).
    pub scan_dir: Option<PathBuf>,
    pub diffusion_model: PathBuf,
    pub vae: PathBuf,
    pub text_encoder: PathBuf,
    pub vision_projector: Option<PathBuf>,
    /// Extra sd-server arguments specific to this model.
    pub backend_args: Vec<String>,
    pub recommended_settings: RecommendedSettings,
    pub capabilities: ProfileCapabilities,
}

impl Default for ModelProfile {
    fn default() -> Self {
        Self::official(&default_sdcpp_dir(), crate::catalog::preset(crate::catalog::DEFAULT_PRESET).unwrap())
    }
}

impl ModelProfile {
    /// The official weights a hardware preset downloads (GGUF of Qwen/Qwen-Image-2.1-Turbo,
    /// Qwen's own Qwen3-VL GGUF, the 2.1 VAE).
    pub fn official(sdcpp_dir: &Path, preset: &crate::catalog::Preset) -> Self {
        use crate::catalog::{official_dit, official_vae, VISION_PROJECTOR};
        let diffusion = official_dit(preset, sdcpp_dir);
        let quant = diffusion.dest.rsplit('-').next().unwrap_or("").trim_end_matches(".gguf");
        Self {
            id: OFFICIAL_PROFILE_ID.into(),
            display_name: format!("Qwen-Image 2.1 Turbo {quant} (official)"),
            model: QWEN_IMAGE_21.into(),
            source: ProfileSource::Official,
            scan_dir: None,
            diffusion_model: diffusion.path(sdcpp_dir),
            vae: official_vae(sdcpp_dir).path(sdcpp_dir),
            text_encoder: preset.text_encoder.path(sdcpp_dir),
            vision_projector: Some(VISION_PROJECTOR.path(sdcpp_dir)),
            backend_args: vec![],
            recommended_settings: RecommendedSettings::default(),
            capabilities: ProfileCapabilities::default(),
        }
    }

    /// The official video model profile (Wan 2.2).
    pub fn official_video(sdcpp_dir: &Path, preset: &crate::catalog::VideoPreset) -> Self {
        Self {
            id: WAN_OFFICIAL_PROFILE_ID.into(),
            display_name: format!("Wan 2.2 {} (official)", preset.label),
            model: WAN_2_2.into(),
            source: ProfileSource::Official,
            scan_dir: None,
            diffusion_model: preset.diffusion.path(sdcpp_dir),
            vae: preset.vae.path(sdcpp_dir),
            text_encoder: preset.text_encoder.path(sdcpp_dir),
            vision_projector: None,
            backend_args: vec![],
            recommended_settings: RecommendedSettings {
                sampler: "euler".into(),
                area_fast: 832 * 480,
                area_balanced: 832 * 480,
                area_quality: 1280 * 720,
                align: 16,
                max_side: 1280,
                max_references: 1,
            },
            capabilities: ProfileCapabilities {
                text_to_image: true,
                edit: true,
                multi_reference: false,
                inpaint: false,
                outpaint: false,
                alpha: false,
            },
        }
    }

    /// (label, path, required) for every model file.
    pub fn files(&self) -> Vec<(&'static str, &Path, bool)> {
        let mut v = vec![
            ("Diffusion model", self.diffusion_model.as_path(), true),
            ("VAE", self.vae.as_path(), true),
            (if self.model == WAN_2_2 { "Text encoder (UMT5-XXL)" } else { "Text encoder (Qwen3-VL)" }, self.text_encoder.as_path(), true),
        ];
        if let Some(p) = &self.vision_projector {
            v.push(("Vision projector (mmproj)", p.as_path(), true));
        }
        v
    }

    /// Files the user already had.
    pub fn user(diffusion_model: PathBuf, vae: PathBuf, text_encoder: PathBuf, vision_projector: Option<PathBuf>) -> Self {
        Self {
            id: USER_PROFILE_ID.into(),
            display_name: "Qwen-Image 2.1 (your files)".into(),
            source: ProfileSource::User,
            scan_dir: None,
            diffusion_model,
            vae,
            text_encoder,
            vision_projector,
            ..Self::default()
        }
    }

    /// Video model files the user already had.
    pub fn user_video(diffusion_model: PathBuf, vae: PathBuf, text_encoder: PathBuf) -> Self {
        Self {
            id: "user-video".into(),
            display_name: "Wan 2.2 Video (your files)".into(),
            model: WAN_2_2.into(),
            source: ProfileSource::User,
            scan_dir: None,
            diffusion_model,
            vae,
            text_encoder,
            vision_projector: None,
            backend_args: vec![],
            recommended_settings: RecommendedSettings {
                sampler: "euler".into(),
                area_fast: 832 * 480,
                area_balanced: 832 * 480,
                area_quality: 1280 * 720,
                align: 16,
                max_side: 1280,
                max_references: 1,
            },
            capabilities: ProfileCapabilities {
                text_to_image: true,
                edit: true,
                multi_reference: false,
                inpaint: false,
                outpaint: false,
                alpha: false,
            },
        }
    }

    pub fn is_official(&self) -> bool {
        self.source == ProfileSource::Official
    }

    fn same_files(&self, o: &ModelProfile) -> bool {
        (&self.diffusion_model, &self.vae, &self.text_encoder, &self.vision_projector) == (&o.diffusion_model, &o.vae, &o.text_encoder, &o.vision_projector)
    }

    pub fn model_name(&self) -> String {
        self.diffusion_model.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| self.display_name.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppConfig {
    pub schema_version: u32,
    pub sdcpp_dir: PathBuf,
    /// stable-diffusion.cpp build that runs the model.
    pub gpu_backend: GpuBackend,
    pub server_port: u16,
    pub service_port: u16,
    /// Open the browser UI to other devices on the network (`remote_port`, all interfaces).
    /// Needs a password first (`remote::PasswordFile`). Changed only through `/remote`: a
    /// whole-config save keeps the current values (`Engine::set_config`).
    pub remote_access: bool,
    pub remote_port: u16,
    pub active_profile: String,
    pub profiles: Vec<ModelProfile>,
    /// ggml device name for diffusion + VAE, e.g. "cuda0" (see `sd-server --list-devices`).
    /// A name of another engine (e.g. "cuda0" with Vulkan) means device 0 of the active one.
    pub device: String,
    pub text_encoder_placement: TextEncoderPlacement,
    /// VRAM kept free, in GiB (passed as a negative `--max-vram`).
    pub vram_reserve_gib: f32,
    pub flash_attention: bool,
    /// Native CUDA SageAttention in the diffusion model (`--sage-attn`); ~1.5x faster
    /// steps at 2K on an RTX 5070 Ti with near-identical output. CUDA only (SM80+);
    /// ignored by other engines.
    pub sage_attention: bool,
    /// The card the engine runs on is too old for SageAttention (`GpuInfo::lacks_sage_attention`).
    /// Set by `Engine::config` from the detected GPU and shown in Settings; never read from
    /// the settings file.
    #[serde(skip_deserializing)]
    pub sage_unsupported: bool,
    /// VAE tile size in pixels (`--vae-tiling --vae-tile-size N`); 0 disables tiling.
    /// Untiled 2K decodes need ~18 GB, OOM and retry with 256px tiles (~22 s); 768px
    /// tiles decode 2K in ~4 s on a 16 GB card.
    pub vae_tile_size: u32,
    /// Storage type of the Qwen 2.1 prefix cache (text + reference K/V reused across steps,
    /// `--model-args qwen_image_2_1_prefix_cache_type=...`). "auto" picks FP32 whenever
    /// SageAttention is on: ~8 GiB for a 2 MP reference, which never fits on 16 GB, so every
    /// edit fell back to the full sequence. "q8_0" (~2.2 GiB at 2 MP) fits; "f16" halves FP32;
    /// "off" disables the cache.
    pub prefix_cache_type: String,
    /// Load all weights when the server starts (`--eager-load`) instead of on the first
    /// step of the first job (~7 s of per-segment loading).
    pub eager_load: bool,
    /// Upscaler model (file stem in the upscalers folder); the bundled MoSR runs when its file
    /// is missing.
    pub upscaler_model: String,
    /// Upscaler tile size in pixels; 0 = automatic (`planner::upscale_tile`).
    pub upscale_tile_size: u32,
    /// Share of the upscaler's result kept over a plain Lanczos enlargement (0..1; 1 = only
    /// the upscaler). Lower values tone down texture the model invents.
    pub upscale_blend: f32,
    /// Shrink the input before the upscaler so its x4 output is ~1.41x the target
    /// (`pipeline::prescale_size`): the model then sees the kind of image it was trained on,
    /// which avoided grid patterns on clean renders in an A/B on 8 images (2026-10-12).
    pub upscale_prescale: bool,
    pub extra_server_args: Vec<String>,
    /// Kokon's own engine for Apple Silicon (`engine-mac/`, `kokon-engine-mac serve`) instead of sd.cpp's Metal build:
    /// the GPU, the CPU's matrix unit and the Neural Engine together, ~4x faster text to image on an M2 Pro. Experimental
    /// and off by default (Settings → Performance). Text to image, edits with references, brushed edits, extending an
    /// image and Prompt+; no LoRAs or second passes yet (`Capabilities::mac_engine_unsupported`). sd.cpp stays the default,
    /// the fallback, and the engine on Windows and Linux.
    pub mac_engine: bool,
    pub output_dir: PathBuf,
    pub keep_server_running: bool,
    /// When no desktop window is attached (e.g. MCP only), unload the model after this
    /// many idle minutes. 0 disables.
    pub idle_unload_minutes: u32,
    pub setup_complete: bool,
    /// Hardware preset chosen in the setup wizard (`catalog::PRESETS`).
    pub hardware_preset: String,
    /// Video hardware preset chosen in setup or settings (`catalog::VIDEO_PRESETS`).
    #[serde(default = "default_video_hardware_preset")]
    pub video_hardware_preset: String,
    /// Plan as if the GPU had this much VRAM (MiB); 0 = use the detected size. For testing
    /// smaller cards on a larger one, together with a VRAM ballast (scripts/dev).
    pub vram_override_mib: u64,
    /// System prompts of the prompt enhancer for text-to-image, edits and new images from
    /// references; "" = the built-in ones (`enhancer::T2I_SYSTEM_PROMPT`, `EDIT_SYSTEM_PROMPT`,
    /// `COMPOSE_SYSTEM_PROMPT`).
    pub enhancer_t2i_prompt: String,
    pub enhancer_edit_prompt: String,
    pub enhancer_compose_prompt: String,
    pub enhancer_video_prompt: String,
    /// The user's LoRAs (Settings → LoRA), each a copy in `lora_dir`. Changed only through the
    /// LoRA endpoints: a whole-config save keeps the current list (`Engine::set_config`).
    pub loras: Vec<LoraEntry>,
    /// Opaque UI preferences (last quality, resolution mode, aspect...).
    pub ui: serde_json::Value,
}

fn default_video_hardware_preset() -> String {
    "video_12gb".into()
}

impl Default for AppConfig {
    fn default() -> Self {
        let sdcpp = default_sdcpp_dir();
        Self {
            schema_version: SCHEMA_VERSION,
            profiles: vec![ModelProfile::official(&sdcpp, crate::catalog::preset(crate::catalog::DEFAULT_PRESET).unwrap())],
            active_profile: OFFICIAL_PROFILE_ID.into(),
            sdcpp_dir: sdcpp,
            gpu_backend: GpuBackend::default(),
            server_port: DEFAULT_SERVER_PORT,
            service_port: DEFAULT_SERVICE_PORT,
            remote_access: false,
            remote_port: DEFAULT_REMOTE_PORT,
            device: "cuda0".into(),
            text_encoder_placement: TextEncoderPlacement::Ram,
            vram_reserve_gib: 1.0,
            flash_attention: true,
            sage_attention: true,
            sage_unsupported: false,
            vae_tile_size: 768,
            prefix_cache_type: "q8_0".into(),
            eager_load: true,
            upscaler_model: DEFAULT_UPSCALER.into(),
            upscale_tile_size: 0,
            upscale_blend: 1.0,
            upscale_prescale: false,
            extra_server_args: vec![],
            mac_engine: false,
            output_dir: default_output_dir(),
            keep_server_running: false,
            idle_unload_minutes: 15,
            setup_complete: false,
            hardware_preset: crate::catalog::DEFAULT_PRESET.into(),
            video_hardware_preset: "video_12gb".into(),
            vram_override_mib: 0,
            enhancer_t2i_prompt: String::new(),
            enhancer_edit_prompt: String::new(),
            enhancer_compose_prompt: String::new(),
            enhancer_video_prompt: String::new(),
            loras: vec![],
            ui: serde_json::json!({}),
        }
    }
}

/// A LoRA the user loaded. Kokon's copy is `<lora_dir>/<id>.safetensors` (see `lora.rs`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoraEntry {
    /// File stem of the copy; also how requests name it.
    pub id: String,
    /// Shown in the app (the original file's name until the user renames it).
    pub name: String,
    /// The file the user picked (never changed by Kokon).
    pub source: PathBuf,
    pub weight: f32,
    /// Added in front of the prompt when the LoRA is used.
    pub trigger_words: String,
    /// On in every new project of the app (MCP never uses LoRAs).
    pub on_by_default: bool,
    /// Size of the copy in bytes.
    pub size: u64,
    /// From the check: the LoRA works only in part.
    pub warning: Option<String>,
    /// What the copy changed (split layers, alpha).
    pub notes: Vec<String>,
    pub added_at: String,
}

impl Default for LoraEntry {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), source: PathBuf::new(), weight: 1.0, trigger_words: String::new(), on_by_default: false, size: 0, warning: None, notes: vec![], added_at: String::new() }
    }
}

impl LoraEntry {
    pub fn file_name(&self) -> String {
        format!("{}.safetensors", self.id)
    }
}

/// `QLS_OUTPUT_DIR` sets it for a new install (the Docker image's `/gallery` volume).
pub fn default_output_dir() -> PathBuf {
    if let Ok(p) = std::env::var("QLS_OUTPUT_DIR") {
        return PathBuf::from(p);
    }
    dirs::picture_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Pictures")))
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_NAME)
}

/// Where the setup wizard installs stable-diffusion.cpp and the models on a new install:
/// `%LOCALAPPDATA%\KokonData\sdcpp`.
pub fn default_sdcpp_dir() -> PathBuf {
    data_dir().join("sdcpp")
}

/// `%APPDATA%\Kokon` (roaming) — configuration.
pub fn config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("QLS_CONFIG_DIR") {
        return PathBuf::from(p);
    }
    migrate_dir(&dirs::config_dir().unwrap_or_else(std::env::temp_dir), LEGACY_CONFIG_DIR, APP_NAME)
}

/// `%LOCALAPPDATA%\KokonData` — gallery database, inputs, thumbnails, logs, models
/// installed by the setup screen.
pub fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("QLS_DATA_DIR") {
        return PathBuf::from(p);
    }
    migrate_dir(&dirs::data_local_dir().unwrap_or_else(std::env::temp_dir), LEGACY_DATA_DIR, DATA_DIR_NAME)
}

/// The data folder of the app's previous name (for relocating stored paths).
fn legacy_data_dir() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(std::env::temp_dir).join(LEGACY_DATA_DIR)
}

/// `base\new`, moving `base\old` there first if only the old folder exists (a rename on the
/// same drive). If the move fails, e.g. while a service of the old version still holds its
/// files, the old folder stays in use and the move is retried on the next start.
pub fn migrate_dir(base: &Path, old: &str, new: &str) -> PathBuf {
    let new_path = base.join(new);
    let old_path = base.join(old);
    // Unit tests must never move the real folders of this PC (tests call it with temp dirs).
    if cfg!(test) && !base.starts_with(std::env::temp_dir()) {
        return new_path;
    }
    if new_path.exists() || !old_path.is_dir() {
        return new_path;
    }
    match std::fs::rename(&old_path, &new_path) {
        Ok(()) => {
            tracing::info!("moved {} to {}", old_path.display(), new_path.display());
            new_path
        }
        Err(e) => {
            tracing::warn!("could not move {} to {} ({e}); using the old folder", old_path.display(), new_path.display());
            old_path
        }
    }
}

/// `p` inside the old data folder after that folder was moved: the same path in the new one.
fn relocate(p: &mut PathBuf, old: &Path, new: &Path) {
    if old.exists() || old == new {
        return;
    }
    if let Ok(rest) = p.strip_prefix(old) {
        *p = new.join(rest);
    }
}

impl AppConfig {
    pub fn path() -> PathBuf {
        config_dir().join("config.json")
    }

    pub fn load() -> Self {
        Self::load_from(&Self::path())
    }

    pub fn load_from(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            // Windows PowerShell 5.1 writes UTF-8 with a BOM; accept it.
            Ok(s) => match serde_json::from_str::<AppConfig>(s.trim_start_matches('\u{feff}')) {
                Ok(mut c) => {
                    if c.profiles.is_empty() {
                        c.profiles.push(ModelProfile::official(&c.sdcpp_dir, c.preset()));
                        c.active_profile = OFFICIAL_PROFILE_ID.into();
                    }
                    if c.schema_version < 8 {
                        // ESRGAN tile sizes don't carry over to MoSR, which picks its own by
                        // GPU memory. The custom upscalers folder key is ignored.
                        c.upscale_tile_size = 0;
                        // 0.9.0's default moves to the new one; a model picked by hand stays.
                        if c.upscaler_model.trim() == "4x-UltraSharp" {
                            c.upscaler_model = DEFAULT_UPSCALER.into();
                        }
                    }
                    if c.schema_version < 7 {
                        // Turbo only (2026-10-09): the official profile moves from the base
                        // Qwen-Image 2.1 weights to the preset's Turbo model, and every profile
                        // gets the new presets (the old step/CFG settings no longer exist).
                        let preset = c.preset();
                        for p in &mut c.profiles {
                            if p.id == OFFICIAL_PROFILE_ID {
                                let official = ModelProfile::official(&c.sdcpp_dir, preset);
                                p.display_name = official.display_name;
                                p.diffusion_model = official.diffusion_model;
                            }
                            p.recommended_settings = RecommendedSettings::default();
                        }
                    }
                    // Paths into the data folder of the app's old name (models installed by the
                    // setup screen) follow the folder to its new name.
                    if std::env::var("QLS_DATA_DIR").is_err() {
                        c.relocate_paths(&legacy_data_dir(), &data_dir());
                    }
                    if c.schema_version < 9 {
                        // Older files have no source: every profile but the official one is
                        // the user's.
                        for p in &mut c.profiles {
                            if p.id != OFFICIAL_PROFILE_ID {
                                p.source = ProfileSource::User;
                            }
                        }
                        c.keep_hand_edited_paths();
                    }
                    if c.schema_version < 10 && c.hardware_preset == "8gb" && c.vram_reserve_gib == 1.0 {
                        c.vram_reserve_gib = c.preset().vram_reserve_gib;
                    }
                    // The official weights are always available as a profile, built for the
                    // configured folder and preset; the active one stays as it is.
                    c.normalize();
                    c.schema_version = c.schema_version.max(SCHEMA_VERSION);
                    c
                }
                Err(e) => {
                    tracing::warn!("config at {} is invalid ({e}); using defaults", path.display());
                    let _ = std::fs::copy(path, path.with_extension("json.invalid"));
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> Result<(), AppError> {
        self.save_to(&Self::path())
    }

    /// Atomic write: temp file + rename.
    pub fn save_to(&self, path: &Path) -> Result<(), AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| AppError::io("create the settings folder", dir, e))?;
        }
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self).map_err(AppError::internal)?;
        std::fs::write(&tmp, json).map_err(|e| AppError::io("write settings", &tmp, e))?;
        std::fs::rename(&tmp, path).map_err(|e| AppError::io("save settings", path, e))?;
        Ok(())
    }

    pub fn profile(&self) -> &ModelProfile {
        self.profiles.iter().find(|p| p.id == self.active_profile).unwrap_or(&self.profiles[0])
    }

    pub fn user_profile(&self) -> Option<&ModelProfile> {
        self.profiles.iter().find(|p| p.id == USER_PROFILE_ID)
    }

    /// Keeps the invariants every saved config has: the official profile exists and points to
    /// the official files of the configured folder and preset (its tuning is kept), every
    /// other profile is the user's, and the active profile exists.
    pub fn normalize(&mut self) {
        // A prompt equal to the built-in one is saved as "" so it follows future defaults.
        for (custom, default) in [
            (&mut self.enhancer_t2i_prompt, crate::enhancer::T2I_SYSTEM_PROMPT),
            (&mut self.enhancer_edit_prompt, crate::enhancer::EDIT_SYSTEM_PROMPT),
            (&mut self.enhancer_compose_prompt, crate::enhancer::COMPOSE_SYSTEM_PROMPT),
            (&mut self.enhancer_video_prompt, crate::enhancer::VIDEO_SYSTEM_PROMPT),
        ] {
            if custom.trim().is_empty() || custom.trim() == default {
                custom.clear();
            }
        }
        for p in &mut self.profiles {
            p.source = if p.id == OFFICIAL_PROFILE_ID || p.id == WAN_OFFICIAL_PROFILE_ID { ProfileSource::Official } else { ProfileSource::User };
            if p.model.trim().is_empty() {
                p.model = QWEN_IMAGE_21.into();
            }
        }
        let mut official = ModelProfile::official(&self.sdcpp_dir, self.preset());
        match self.profiles.iter_mut().find(|p| p.id == OFFICIAL_PROFILE_ID) {
            Some(p) => {
                official.recommended_settings = p.recommended_settings.clone();
                official.backend_args = p.backend_args.clone();
                official.capabilities = p.capabilities.clone();
                *p = official;
            }
            None => self.profiles.insert(0, official),
        }
        let video_preset = self.video_preset();
        if let Some(p) = self.profiles.iter_mut().find(|p| p.id == WAN_OFFICIAL_PROFILE_ID) {
            let mut official_video = ModelProfile::official_video(&self.sdcpp_dir, video_preset);
            official_video.recommended_settings = p.recommended_settings.clone();
            official_video.capabilities = p.capabilities.clone();
            *p = official_video;
        }
        if !self.profiles.iter().any(|p| p.id == self.active_profile) {
            self.active_profile = OFFICIAL_PROFILE_ID.into();
        }
    }

    /// Before schema 9, own files were set by editing the official profile's paths
    /// (Settings → Models, or config.json by hand). When those files are all there, they move
    /// to the user profile (active if the official one was), so presets can't overwrite them.
    fn keep_hand_edited_paths(&mut self) {
        let canonical = ModelProfile::official(&self.sdcpp_dir, self.preset());
        let Some(p) = self.profiles.iter().find(|p| p.id == OFFICIAL_PROFILE_ID) else { return };
        if p.same_files(&canonical) || !p.files().iter().all(|(_, f, _)| f.is_file()) || self.user_profile().is_some() {
            return;
        }
        let mut user = ModelProfile::user(p.diffusion_model.clone(), p.vae.clone(), p.text_encoder.clone(), p.vision_projector.clone());
        user.recommended_settings = p.recommended_settings.clone();
        user.backend_args = p.backend_args.clone();
        tracing::info!("model paths edited on the official profile moved to the profile of your own files");
        self.profiles.push(user);
        if self.active_profile == OFFICIAL_PROFILE_ID {
            self.active_profile = USER_PROFILE_ID.into();
        }
    }

    /// Saves the user's own files as the user profile and makes it active. Tuning of an
    /// earlier user profile is kept.
    pub fn set_user_files(&mut self, mut profile: ModelProfile) {
        profile.id = USER_PROFILE_ID.into();
        profile.source = ProfileSource::User;
        if let Some(old) = self.user_profile() {
            profile.recommended_settings = old.recommended_settings.clone();
            profile.backend_args = old.backend_args.clone();
        }
        self.profiles.retain(|p| p.id != USER_PROFILE_ID);
        self.profiles.push(profile);
        self.active_profile = USER_PROFILE_ID.into();
    }

    /// The active model uses the texture-fix VAE (#21).
    pub fn uses_improved_vae(&self) -> bool {
        self.profile().vae.file_name().is_some_and(|n| n.eq_ignore_ascii_case(crate::catalog::VAE.file_name()))
    }

    /// Makes the active model use the texture-fix VAE in the app's folder, once downloaded. The
    /// official files switch by themselves (`catalog::official_vae`); the user's own profile
    /// points to it instead of their VAE, which stays where it is.
    pub fn use_improved_vae(&mut self) {
        let vae = crate::catalog::VAE.path(&self.sdcpp_dir);
        let active = self.active_profile.clone();
        if let Some(p) = self.profiles.iter_mut().find(|p| p.id == active && !p.is_official()) {
            p.vae = vae;
        }
        self.normalize();
    }

    /// Makes the active model use the Q4_K_M image model in the app's folder, once downloaded.
    /// The official files switch by themselves (`catalog::official_dit`); the user's own profile
    /// points to it instead of their file, which stays where it is.
    pub fn use_new_dit(&mut self) {
        let dit = crate::catalog::TURBO_Q4_K_M.path(&self.sdcpp_dir);
        let active = self.active_profile.clone();
        if let Some(p) = self.profiles.iter_mut().find(|p| p.id == active && !p.is_official()) {
            p.diffusion_model = dit;
        }
        self.normalize();
    }

    /// Makes the official files the active model (they may still need downloading).
    pub fn use_official(&mut self) {
        self.normalize();
        self.active_profile = OFFICIAL_PROFILE_ID.into();
    }

    /// Returns the active or target profile for `mode`.
    pub fn profile_for_mode(&self, mode: Mode) -> Cow<'_, ModelProfile> {
        if mode == Mode::Video {
            if let Some(p) = self.profiles.iter().find(|p| p.model == WAN_2_2) {
                Cow::Borrowed(p)
            } else {
                Cow::Owned(ModelProfile::official_video(&self.sdcpp_dir, self.video_preset()))
            }
        } else if self.profile().model == WAN_2_2 {
            if let Some(p) = self.profiles.iter().find(|p| p.model == QWEN_IMAGE_21) {
                Cow::Borrowed(p)
            } else {
                Cow::Owned(ModelProfile::official(&self.sdcpp_dir, self.preset()))
            }
        } else {
            Cow::Borrowed(self.profile())
        }
    }

    /// Model files of the active profile for `mode` that are not there (label, path).
    pub fn missing_files_for_mode(&self, mode: Mode) -> Vec<(&'static str, PathBuf)> {
        let p = self.profile_for_mode(mode);
        p.files().into_iter().filter(|(_, path, required)| *required && !path.is_file()).map(|(l, path, _)| (l, path.to_path_buf())).collect()
    }

    /// Model files of the active profile that are not there (label, path).
    pub fn missing_files(&self) -> Vec<(&'static str, PathBuf)> {
        self.missing_files_for_mode(Mode::Auto)
    }

    /// Why the inference server cannot start: the engine or a model file is missing for `mode`.
    pub fn missing_files_error_for_mode(&self, mode: Mode) -> Option<AppError> {
        let exe = self.server_exe();
        if !exe.is_file() && self.uses_mac_engine() {
            return Some(
                AppError::new(ErrorCode::MissingModel, format!("Kokon's Mac engine was not found in {}.", exe.parent().unwrap_or(&exe).display()))
                    .suggest("Turn off Kokon's Mac engine in Settings → Performance to use the standard engine."),
            );
        }
        if !exe.is_file() {
            return Some(
                AppError::new(ErrorCode::MissingModel, format!("sd-server was not found in {}.", self.engine_dir().display()))
                    .suggest("Install it from Settings → Models → Set up models…, or set the stable-diffusion.cpp folder in Settings."),
            );
        }
        let missing = self.missing_files_for_mode(mode);
        let (label, path) = missing.first()?;
        let more = match missing.len() {
            1 => String::new(),
            n => format!(" (and {} more)", n - 1),
        };
        Some(
            AppError::new(ErrorCode::MissingModel, format!("{label} not found: {}{more}", path.display()))
                .suggest("If it is on a drive that is not connected, connect it and try again. Otherwise open Setup to find the file again, choose other files, or download the missing ones."),
        )
    }

    /// Why the inference server cannot start: the engine or a model file is missing.
    pub fn missing_files_error(&self) -> Option<AppError> {
        self.missing_files_error_for_mode(Mode::Auto)
    }

    /// VRAM (MiB) the user's own files take beyond the official ones, which the planner's
    /// budgets were measured with: a larger diffusion model (and, with unified memory, a larger
    /// text encoder) leaves less room for the images. 0 for the official files.
    pub fn model_vram_extra_mib(&self, unified: bool) -> u64 {
        let p = self.profile();
        if p.is_official() {
            return 0;
        }
        let size = |f: &Path| std::fs::metadata(f).map(|m| m.len()).unwrap_or(0);
        let te = size(&p.text_encoder) + p.vision_projector.as_deref().map(size).unwrap_or(0);
        extra_weights_mib(size(&p.diffusion_model), te, unified)
    }

    pub fn relocate_paths(&mut self, old: &Path, new: &Path) {
        relocate(&mut self.sdcpp_dir, old, new);
        for p in &mut self.profiles {
            for f in [&mut p.diffusion_model, &mut p.vae, &mut p.text_encoder] {
                relocate(f, old, new);
            }
            if let Some(v) = p.vision_projector.as_mut() {
                relocate(v, old, new);
            }
        }
    }

    pub fn preset(&self) -> &'static crate::catalog::Preset {
        crate::catalog::preset(&self.hardware_preset).unwrap_or_else(|| crate::catalog::preset(crate::catalog::DEFAULT_PRESET).unwrap())
    }

    /// Uses `preset`'s runtime settings, and its files for the official profile (tuning kept).
    /// The active profile stays: a preset never replaces the user's own files. Setup also calls
    /// [`Self::use_official`] when it installs the official files.
    pub fn apply_preset(&mut self, preset: &crate::catalog::Preset) {
        self.hardware_preset = preset.id.into();
        self.text_encoder_placement = preset.text_encoder_placement;
        self.vram_reserve_gib = preset.vram_reserve_gib;
        self.normalize();
    }

    pub fn video_preset(&self) -> &'static crate::catalog::VideoPreset {
        crate::catalog::video_preset(&self.video_hardware_preset).unwrap_or_else(|| &crate::catalog::VIDEO_PRESETS[1])
    }

    /// Uses `preset`'s runtime settings and registers its official video profile.
    pub fn apply_video_preset(&mut self, preset: &crate::catalog::VideoPreset) {
        self.video_hardware_preset = preset.id.into();
        self.text_encoder_placement = preset.text_encoder_placement;
        let mut p = ModelProfile::official_video(&self.sdcpp_dir, preset);
        if let Some(pos) = self.profiles.iter().position(|x| x.id == p.id) {
            p.recommended_settings = self.profiles[pos].recommended_settings.clone();
            p.capabilities = self.profiles[pos].capabilities.clone();
            self.profiles[pos] = p;
        } else {
            self.profiles.push(p);
        }
        self.active_profile = WAN_OFFICIAL_PROFILE_ID.into();
        self.normalize();
    }

    /// VRAM the planner should assume: the override when set, otherwise the detected size.
    pub fn planning_vram_mib(&self, detected: Option<u64>) -> Option<u64> {
        if self.vram_override_mib > 0 { Some(self.vram_override_mib) } else { detected }
    }

    /// Folder of the active stable-diffusion.cpp build.
    pub fn engine_dir(&self) -> PathBuf {
        match self.gpu_backend.engine_subdir() {
            "" => self.sdcpp_dir.clone(),
            sub => self.sdcpp_dir.join(sub),
        }
    }

    pub fn server_exe(&self) -> PathBuf {
        if self.uses_mac_engine() {
            return self.mac_engine_exe();
        }
        self.engine_dir().join(if cfg!(windows) { "sd-server.exe" } else { "sd-server" })
    }

    /// Kokon's Mac engine, on or off: the copy inside the app (next to kokon-service; `tauri dev` puts one there too),
    /// else the one `engine-mac/tools/install-dev.sh` puts in the stable-diffusion.cpp folder.
    pub fn mac_engine_exe(&self) -> PathBuf {
        let here = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
        mac_engine_in(here.as_deref(), &self.sdcpp_dir)
    }

    /// Kokon's Mac engine runs instead of sd-server: chosen in Settings, on the Metal backend only.
    pub fn uses_mac_engine(&self) -> bool {
        self.mac_engine && self.gpu_backend == GpuBackend::Metal
    }

    /// The configured device when it belongs to the active engine, else its first GPU.
    pub fn effective_device(&self) -> String {
        let dev = self.device.trim().to_ascii_lowercase();
        let prefix = self.gpu_backend.device_prefix();
        match dev.strip_prefix(prefix) {
            Some(i) if !i.is_empty() && i.chars().all(|c| c.is_ascii_digit()) => dev,
            // Engines number their devices independently: fall back to the first one.
            _ => format!("{prefix}0"),
        }
    }

    /// `--vae-tile-size` the engine runs with: the setting, at most
    /// [`crate::planner::VULKAN_VAE_TILE`] on Vulkan; 0 = no server-side tiling.
    pub fn server_vae_tile_size(&self) -> u32 {
        match self.gpu_backend {
            GpuBackend::Vulkan => self.vae_tile_size.min(crate::planner::VULKAN_VAE_TILE),
            _ => self.vae_tile_size,
        }
    }

    /// SageAttention is requested and the engine and card support it.
    pub fn uses_sage_attention(&self) -> bool {
        self.sage_attention && !self.sage_unsupported && self.gpu_backend == GpuBackend::Cuda
    }

    /// Folder of the upscaler (`--hires-upscalers-dir`).
    /// Kokon's copies of the user's LoRAs (`--lora-model-dir`). Not `models/loras`, where users
    /// and tools keep their own files: the engine would list those too.
    pub fn lora_dir(&self) -> PathBuf {
        self.sdcpp_dir.join("models").join("kokon-loras")
    }

    pub fn upscalers_dir(&self) -> PathBuf {
        crate::catalog::join_rel(&self.sdcpp_dir, crate::catalog::UPSCALERS_SUBDIR)
    }

    /// The upscaler that runs (name, file): the chosen model when its file is in the upscalers
    /// folder (sd-server resolves `<dir>/<name>.<ext>` the same way), else the bundled MoSR.
    pub fn upscaler(&self) -> Option<(String, PathBuf)> {
        let name = self.upscaler_model.trim();
        if name == LANCZOS {
            return None;
        }
        let dir = self.upscalers_dir();
        if !name.is_empty() && name != crate::catalog::UPSCALER_NAME {
            if let Some(p) = UPSCALER_EXTENSIONS.iter().map(|e| dir.join(format!("{name}.{e}"))).find(|p| p.is_file()) {
                return Some((name.to_string(), p));
            }
        }
        let d = crate::catalog::UPSCALER;
        d.is_present(&self.sdcpp_dir).then(|| (crate::catalog::UPSCALER_NAME.to_string(), d.path(&self.sdcpp_dir)))
    }

    /// The file of [`Self::upscaler`].
    pub fn upscaler_file(&self) -> Option<PathBuf> {
        self.upscaler().map(|(_, p)| p)
    }

    /// A save from a browser (another device) changes the app's settings, not the computer's:
    /// folders, model files, ports, engine arguments and network access keep their values in
    /// `current`. Those take a path on the server or decide what runs there, and only the
    /// desktop app (or the config file) sets them.
    pub fn keep_computer_settings(&mut self, current: &AppConfig) {
        self.sdcpp_dir = current.sdcpp_dir.clone();
        self.output_dir = current.output_dir.clone();
        self.profiles = current.profiles.clone();
        self.active_profile = current.active_profile.clone();
        self.extra_server_args = current.extra_server_args.clone();
        self.server_port = current.server_port;
        self.service_port = current.service_port;
        self.remote_access = current.remote_access;
        self.remote_port = current.remote_port;
    }

    pub fn validate(&self) -> Result<(), AppError> {
        if self.server_port == self.service_port {
            return Err(AppError::new(ErrorCode::InvalidConfig, "The inference server and the app service cannot use the same port."));
        }
        if self.remote_port == self.server_port || self.remote_port == self.service_port {
            return Err(AppError::new(ErrorCode::InvalidConfig, "The port for other devices must differ from the app's own ports."));
        }
        if self.server_port < 1024 || self.service_port < 1024 || self.remote_port < 1024 {
            return Err(AppError::new(ErrorCode::InvalidConfig, "Ports must be 1024 or higher."));
        }
        if !(0.0..=64.0).contains(&self.vram_reserve_gib) {
            return Err(AppError::new(ErrorCode::InvalidConfig, "VRAM reserve must be between 0 and 64 GiB."));
        }
        if self.device.trim().is_empty() || !self.device.chars().all(|c| c.is_ascii_alphanumeric()) {
            return Err(AppError::new(ErrorCode::InvalidConfig, "Device must be a backend name such as cuda0."));
        }
        if self.prefix_cache_type.is_empty() || !self.prefix_cache_type.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(AppError::new(ErrorCode::InvalidConfig, "Prefix cache type must be auto, off, or a weight type such as q8_0 or f16."));
        }
        if self.profiles.is_empty() {
            return Err(AppError::new(ErrorCode::InvalidConfig, "No model profile configured."));
        }
        if !(0.0..=1.0).contains(&self.upscale_blend) {
            return Err(AppError::new(ErrorCode::InvalidConfig, "Upscaler blend must be between 0 and 100 %."));
        }
        if self.vram_override_mib != 0 && !(4096..=196_608).contains(&self.vram_override_mib) {
            return Err(AppError::new(ErrorCode::InvalidConfig, "Simulated VRAM must be between 4096 and 196608 MiB (or 0 to detect it)."));
        }
        let max = crate::enhancer::MAX_SYSTEM_PROMPT_CHARS;
        if [&self.enhancer_t2i_prompt, &self.enhancer_edit_prompt, &self.enhancer_compose_prompt, &self.enhancer_video_prompt].iter().any(|p| p.chars().count() > max) {
            return Err(AppError::new(ErrorCode::InvalidConfig, format!("Prompt enhancer instructions can be at most {max} characters.")));
        }
        Ok(())
    }
}

/// [`AppConfig::model_vram_extra_mib`] for files of these sizes (bytes; text encoder plus
/// vision projector together). Smaller files give nothing back: the budgets stay as measured
/// (with the Q4_K; the default Q4_K_M counts its extra ~140 MiB).
fn extra_weights_mib(diffusion: u64, text_encoder: u64, unified: bool) -> u64 {
    use crate::catalog::{TEXT_ENCODER_Q4_K_M, TURBO_Q4_K, VISION_PROJECTOR};
    let mut extra = diffusion.saturating_sub(TURBO_Q4_K.size);
    if unified {
        extra += text_encoder.saturating_sub(TEXT_ENCODER_Q4_K_M.size + VISION_PROJECTOR.size);
    }
    extra >> 20
}

/// See [`AppConfig::mac_engine_exe`]: `app_dir` is kokon-service's folder.
fn mac_engine_in(app_dir: Option<&Path>, sdcpp_dir: &Path) -> PathBuf {
    app_dir.map(|d| d.join(MAC_ENGINE_EXE)).filter(|p| p.is_file()).unwrap_or_else(|| sdcpp_dir.join(MAC_ENGINE_DIR).join(MAC_ENGINE_EXE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_engine_inside_the_app_first() {
        let app = tempfile::tempdir().unwrap();
        let sdcpp = tempfile::tempdir().unwrap();
        let dev = sdcpp.path().join(MAC_ENGINE_DIR).join(MAC_ENGINE_EXE);
        assert_eq!(mac_engine_in(Some(app.path()), sdcpp.path()), dev);
        assert_eq!(mac_engine_in(None, sdcpp.path()), dev);
        std::fs::write(app.path().join(MAC_ENGINE_EXE), b"").unwrap();
        assert_eq!(mac_engine_in(Some(app.path()), sdcpp.path()), app.path().join(MAC_ENGINE_EXE));
    }

    /// Empty files at every path of `p`.
    fn touch_files(p: &ModelProfile) {
        for (_, f, _) in p.files() {
            std::fs::create_dir_all(f.parent().unwrap()).unwrap();
            std::fs::write(f, b"").unwrap();
        }
    }

    fn own_files(dir: &Path) -> ModelProfile {
        let m = dir.join("ComfyUI").join("models");
        ModelProfile::user(m.join("diffusion_models").join("turbo_int8.safetensors"), m.join("vae").join("vae.safetensors"), m.join("text_encoders").join("qwen3vl_fused.safetensors"), None)
    }

    #[test]
    fn enhancer_prompts_default_blank_and_are_capped() {
        let mut c = AppConfig::default();
        assert!(c.enhancer_t2i_prompt.is_empty() && c.enhancer_edit_prompt.is_empty(), "built-in by default");
        // Older settings files have no such keys.
        let old: AppConfig = serde_json::from_str(r#"{"schemaVersion":9}"#).unwrap();
        assert!(old.enhancer_edit_prompt.is_empty() && old.enhancer_compose_prompt.is_empty());
        // A restored default is saved blank, so it follows future defaults; a custom one stays.
        c.enhancer_t2i_prompt = format!("{}\n", crate::enhancer::T2I_SYSTEM_PROMPT);
        c.enhancer_edit_prompt = "Retouch jewelry only.".into();
        c.normalize();
        assert_eq!((c.enhancer_t2i_prompt.as_str(), c.enhancer_edit_prompt.as_str()), ("", "Retouch jewelry only."));
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["enhancerEditPrompt"], "Retouch jewelry only.");
        assert!(c.validate().is_ok());
        c.enhancer_compose_prompt = format!(" {} ", crate::enhancer::COMPOSE_SYSTEM_PROMPT);
        c.normalize();
        assert!(c.enhancer_compose_prompt.is_empty());
        c.enhancer_edit_prompt = "x".repeat(crate::enhancer::MAX_SYSTEM_PROMPT_CHARS + 1);
        assert!(c.validate().is_err());
        c.enhancer_edit_prompt.clear();
        c.enhancer_compose_prompt = "x".repeat(crate::enhancer::MAX_SYSTEM_PROMPT_CHARS + 1);
        assert!(c.validate().is_err());
    }

    #[test]
    fn hand_edited_official_paths_move_to_the_user_profile() {
        let dir = tempfile::tempdir().unwrap();
        let sd = dir.path().join("sd");
        let mine = own_files(dir.path());
        touch_files(&mine);
        // badraymen's config (#14): the official profile pointed at ComfyUI files by hand.
        let mut old = AppConfig { sdcpp_dir: sd.clone(), schema_version: 8, ..AppConfig::default() };
        old.normalize();
        let p = &mut old.profiles[0];
        (p.diffusion_model, p.vae, p.text_encoder, p.vision_projector) = (mine.diffusion_model.clone(), mine.vae.clone(), mine.text_encoder.clone(), None);
        p.backend_args = vec!["--x".into()];
        let path = dir.path().join("config.json");
        old.save_to(&path).unwrap();
        let c = AppConfig::load_from(&path);
        assert_eq!(c.active_profile, USER_PROFILE_ID, "the edited files stay in use");
        let user = c.profile();
        assert_eq!((user.source, user.diffusion_model.clone(), user.vision_projector.clone()), (ProfileSource::User, mine.diffusion_model.clone(), None));
        assert_eq!(user.backend_args, vec!["--x".to_string()]);
        assert_eq!(user.model, QWEN_IMAGE_21);
        let off = c.profiles.iter().find(|p| p.id == OFFICIAL_PROFILE_ID).unwrap();
        assert!(off.same_files(&ModelProfile::official(&sd, c.preset())) && off.is_official(), "the official profile is official again");
        c.save_to(&path).unwrap();
        assert_eq!(AppConfig::load_from(&path), c, "nothing changes on the next load");

        // Edited paths whose files are gone are not kept: back to the official files.
        std::fs::remove_file(&mine.vae).unwrap();
        old.save_to(&path).unwrap();
        let c = AppConfig::load_from(&path);
        assert_eq!((c.active_profile.as_str(), c.profiles.len()), (OFFICIAL_PROFILE_ID, 1));
        assert!(c.profile().same_files(&ModelProfile::official(&sd, c.preset())));
    }

    #[test]
    fn presets_never_replace_the_users_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = AppConfig { sdcpp_dir: dir.path().join("sd"), ..AppConfig::default() };
        c.normalize();
        let mut mine = own_files(dir.path());
        mine.scan_dir = Some(dir.path().join("ComfyUI"));
        c.set_user_files(mine.clone());
        c.profiles.iter_mut().find(|p| p.id == USER_PROFILE_ID).unwrap().recommended_settings.area_fast = 768 * 768;
        c.apply_preset(crate::catalog::preset("32gb").unwrap());
        assert_eq!(c.active_profile, USER_PROFILE_ID);
        assert_eq!((c.profile().text_encoder.clone(), c.hardware_preset.as_str()), (mine.text_encoder.clone(), "32gb"));
        let off = c.profiles.iter().find(|p| p.id == OFFICIAL_PROFILE_ID).unwrap();
        assert!(off.text_encoder.ends_with("Qwen3VL-8B-Instruct-Q8_0.gguf"), "the official profile follows the preset");
        // Choosing files again keeps the tuning; switching to the official files keeps them.
        c.set_user_files(own_files(dir.path()));
        assert_eq!(c.profile().recommended_settings.area_fast, 768 * 768);
        assert_eq!(c.profiles.len(), 2);
        c.use_official();
        assert_eq!(c.active_profile, OFFICIAL_PROFILE_ID);
        assert!(c.user_profile().is_some(), "the user's profile is never deleted");
        // The official files follow the folder.
        c.sdcpp_dir = dir.path().join("elsewhere");
        c.normalize();
        assert!(c.profile().diffusion_model.starts_with(dir.path().join("elsewhere")));
        // An active profile that is gone falls back to the official one.
        c.active_profile = "nope".into();
        c.normalize();
        assert_eq!(c.active_profile, OFFICIAL_PROFILE_ID);
    }

    #[test]
    fn missing_files_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = AppConfig { sdcpp_dir: dir.path().join("sd"), ..AppConfig::default() };
        c.normalize();
        assert!(c.missing_files_error().unwrap().message.contains("sd-server"), "the engine first");
        std::fs::create_dir_all(c.engine_dir()).unwrap();
        std::fs::write(c.server_exe(), b"").unwrap();
        let mine = own_files(dir.path());
        c.set_user_files(mine.clone());
        assert_eq!(c.missing_files().len(), 3);
        let e = c.missing_files_error().unwrap();
        assert_eq!(e.code, ErrorCode::MissingModel);
        assert!(e.message.starts_with("Diffusion model not found") && e.message.ends_with("(and 2 more)"), "{}", e.message);
        touch_files(&mine);
        assert!(c.missing_files().is_empty() && c.missing_files_error().is_none());
    }

    #[test]
    fn larger_own_files_take_planning_memory() {
        use crate::catalog::{TEXT_ENCODER_Q8_0, TURBO_Q4_K};
        assert_eq!(extra_weights_mib(TURBO_Q4_K.size, 0, false), 0);
        assert_eq!(extra_weights_mib(TURBO_Q4_K.size / 2, 0, false), 0, "smaller files give nothing back");
        assert_eq!(extra_weights_mib(TURBO_Q4_K.size + (6 << 30), 0, false), 6 * 1024);
        assert_eq!(extra_weights_mib(0, TEXT_ENCODER_Q8_0.size, false), 0, "the text encoder sits in system RAM");
        assert!(extra_weights_mib(0, TEXT_ENCODER_Q8_0.size, true) > 2000, "unified memory: it shares the GPU's memory");
        // The official profile is what the budgets were measured with.
        assert_eq!(AppConfig::default().model_vram_extra_mib(true), 0);
    }

    #[test]
    fn defaults_match_spec() {
        let c = AppConfig::default();
        let p = c.profile();
        assert_eq!(p.id, OFFICIAL_PROFILE_ID);
        assert!(p.diffusion_model.starts_with(default_sdcpp_dir()));
        // A new install (no earlier model file in the folder) gets the Q4_K_M.
        let dir = tempfile::tempdir().unwrap();
        let mut fresh = AppConfig { sdcpp_dir: dir.path().to_path_buf(), ..AppConfig::default() };
        fresh.normalize();
        assert_eq!(fresh.profile().display_name, "Qwen-Image 2.1 Turbo Q4_K_M (official)");
        assert!(fresh.profile().diffusion_model.ends_with("qwen-image-2.1-turbo-Q4_K_M.gguf"));
        assert_eq!(c.hardware_preset, "16gb");
        assert_eq!(c.planning_vram_mib(Some(16303)), Some(16303));
        assert_eq!(c.device, "cuda0");
        assert_eq!(c.vram_reserve_gib, 1.0);
        assert!(c.flash_attention);
        assert!(!c.keep_server_running);
        assert!(c.validate().is_ok());
        assert_eq!(p.files().len(), 4);
        assert_eq!(c.upscale_tile_size, 0, "automatic");
        let default_model = if cfg!(target_os = "macos") { "lanczos" } else { "4x_NMKD-Superscale-SP_178000_G" };
        assert_eq!((c.upscaler_model.as_str(), c.upscale_blend, c.upscale_prescale), (default_model, 1.0, false));
        assert_eq!(c.upscalers_dir(), default_sdcpp_dir().join("models").join("upscalers"));
    }

    #[test]
    fn engine_choice_sets_folder_device_and_flags() {
        let mut c = AppConfig::default();
        c.gpu_backend = GpuBackend::Cuda;
        assert_eq!(c.engine_dir(), c.sdcpp_dir);
        assert_eq!(c.effective_device(), "cuda0");
        assert!(c.uses_sage_attention());
        c.sage_unsupported = true;
        assert!(!c.uses_sage_attention(), "pre-Ampere card");
        let saved: AppConfig = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert!(!saved.sage_unsupported, "detected per run, not read back");
        c.sage_unsupported = false;
        c.gpu_backend = GpuBackend::Vulkan;
        assert_eq!(c.engine_dir(), c.sdcpp_dir.join("engine-vulkan"));
        assert!(c.server_exe().starts_with(c.sdcpp_dir.join("engine-vulkan")));
        assert_eq!(c.effective_device(), "vulkan0", "a CUDA device name maps to the first Vulkan GPU");
        c.device = "Vulkan1".into();
        assert_eq!(c.effective_device(), "vulkan1");
        c.device = "vulkan".into();
        assert_eq!(c.effective_device(), "vulkan0");
        assert!(!c.uses_sage_attention(), "SageAttention is CUDA only");
        assert_eq!(GpuBackend::for_vendor("nvidia"), GpuBackend::Cuda);
        assert_eq!(GpuBackend::for_vendor("amd"), GpuBackend::Vulkan);
        assert_eq!(GpuBackend::for_vendor("apple"), GpuBackend::Metal);
        c.gpu_backend = GpuBackend::Metal;
        c.device = "cuda0".into();
        assert_eq!(c.effective_device(), "mtl0", "matches MTL0 in --list-devices");
        assert_eq!(c.engine_dir(), c.sdcpp_dir.join("engine-metal"));
        assert!(!c.uses_sage_attention());
        // Configs written before the field existed keep this platform's engine.
        let old: AppConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(old.gpu_backend, if cfg!(target_os = "macos") { GpuBackend::Metal } else { GpuBackend::Cuda });
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains(r#""gpuBackend":"metal""#));
    }

    #[test]
    fn official_profile_is_added_but_not_forced() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let old = r#"{"schemaVersion":4,"sdcppDir":"D:\\sd","activeProfile":"uc","profiles":[{"id":"uc","displayName":"UC","diffusionModel":"D:\\sd\\uc.gguf"}]}"#;
        std::fs::write(&p, old).unwrap();
        let c = AppConfig::load_from(&p);
        assert_eq!(c.active_profile, "uc", "the user's choice stays active");
        let off = c.profiles.iter().find(|p| p.id == OFFICIAL_PROFILE_ID).unwrap();
        // Catalog paths are joined per component, so the separator is the platform's own.
        let sd = |f: &str| crate::catalog::join_rel(Path::new(r"D:\sd"), &format!("models/qwen21/{f}"));
        assert_eq!(off.diffusion_model, sd("qwen-image-2.1-turbo-Q4_K_M.gguf"));
        // Saved again, nothing is added twice.
        c.save_to(&p).unwrap();
        assert_eq!(AppConfig::load_from(&p).profiles.len(), 2);
        // A file without profiles uses its own folder and preset.
        std::fs::write(&p, r#"{"sdcppDir":"D:\\sd","hardwarePreset":"24gb"}"#).unwrap();
        let c = AppConfig::load_from(&p);
        assert_eq!(c.profile().diffusion_model, sd("qwen-image-2.1-turbo-Q4_K_M.gguf"));
    }

    #[test]
    fn old_folders_move_to_the_new_name() {
        let base = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(base.path().join("QwenLocalStudio").join("inputs")).unwrap();
        std::fs::write(base.path().join("QwenLocalStudio").join("gallery.db"), b"db").unwrap();
        let d = migrate_dir(base.path(), "QwenLocalStudio", "KokonData");
        assert_eq!(d, base.path().join("KokonData"));
        assert!(d.join("gallery.db").is_file() && !base.path().join("QwenLocalStudio").exists());
        // Once moved, nothing happens again; a fresh install just gets the new name.
        assert_eq!(migrate_dir(base.path(), "QwenLocalStudio", "KokonData"), d);
        assert_eq!(migrate_dir(base.path(), "Missing", "New"), base.path().join("New"));
        // Model paths inside the moved folder follow it; others stay.
        let (old, new) = (base.path().join("QwenLocalStudio"), d.clone());
        let mut c = AppConfig::default();
        c.sdcpp_dir = old.join("sdcpp");
        c.apply_preset(crate::catalog::preset("16gb").unwrap());
        c.profiles.push(ModelProfile { id: "mine".into(), diffusion_model: PathBuf::from(r"C:\AI\sdcpp\x.gguf"), ..ModelProfile::default() });
        c.relocate_paths(&old, &new);
        assert_eq!(c.sdcpp_dir, new.join("sdcpp"));
        assert!(c.profile().diffusion_model.starts_with(new.join("sdcpp")));
        assert_eq!(c.profiles[1].diffusion_model, PathBuf::from(r"C:\AI\sdcpp\x.gguf"));
    }

    #[test]
    fn presets_switch_weights_and_keep_tuning() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = AppConfig { sdcpp_dir: dir.path().to_path_buf(), ..AppConfig::default() };
        c.profiles[0].recommended_settings.area_fast = 768 * 768;
        c.apply_preset(crate::catalog::preset("32gb").unwrap());
        let p = c.profile();
        assert!(p.diffusion_model.ends_with("qwen-image-2.1-turbo-Q4_K_M.gguf"), "4-bit Turbo on every preset");
        assert!(p.text_encoder.ends_with("Qwen3VL-8B-Instruct-Q8_0.gguf"));
        assert_eq!(p.display_name, "Qwen-Image 2.1 Turbo Q4_K_M (official)");
        assert_eq!(p.recommended_settings.area_fast, 768 * 768);
        assert_eq!((c.hardware_preset.as_str(), c.profiles.len()), ("32gb", 1));
        c.vram_override_mib = 12_288;
        assert_eq!(c.planning_vram_mib(Some(16303)), Some(12_288));
        assert!(c.validate().is_ok());
        c.vram_override_mib = 100;
        assert!(c.validate().is_err());
    }

    #[test]
    fn schema_8_migration() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let old = r#"{"schemaVersion":7,"sdcppDir":"D:\\sd","upscalersDir":"E:\\esrgan","upscalerModel":"4x_NMKD-Superscale-SP_178000_G","upscaleTileSize":256}"#;
        std::fs::write(&p, old).unwrap();
        let c = AppConfig::load_from(&p);
        assert_eq!(c.schema_version, SCHEMA_VERSION);
        assert_eq!(c.upscale_tile_size, 0, "ESRGAN tile sizes reset to automatic");
        assert_eq!(c.upscalers_dir(), crate::catalog::join_rel(Path::new(r"D:\sd"), "models/upscalers"), "the custom folder is no longer used");
        assert_eq!(c.upscaler_model, "4x_NMKD-Superscale-SP_178000_G", "the model choice is kept");
        assert!(!serde_json::to_string(&c).unwrap().contains("upscalersDir"), "the folder key is dropped on save");
        std::fs::write(&p, r#"{"schemaVersion":7,"upscalerModel":"4x-UltraSharp"}"#).unwrap();
        assert_eq!(AppConfig::load_from(&p).upscaler_model, DEFAULT_UPSCALER, "0.9.0's default moves to the new one");
        // A tile size chosen after the change is kept.
        std::fs::write(&p, r#"{"schemaVersion":8,"upscaleTileSize":512}"#).unwrap();
        assert_eq!(AppConfig::load_from(&p).upscale_tile_size, 512);
    }

    #[test]
    fn base_model_installs_move_to_turbo() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("config.json");
        let old = r#"{"schemaVersion":6,"sdcppDir":"D:\\sd","hardwarePreset":"24gb","activeProfile":"qwen-image-2.1","profiles":[
            {"id":"qwen-image-2.1","displayName":"Qwen-Image 2.1 Q8_0 (official)","diffusionModel":"D:\\sd\\models\\qwen21\\qwen-image-2.1-Q8_0.gguf","backendArgs":["--x"],
             "recommendedSettings":{"steps_fast":20,"steps_ultra":40,"cfg":1.0,"area_ultra":4194304,"area_fast":1048576}},
            {"id":"mine","diffusionModel":"D:\\sd\\mine.gguf","recommendedSettings":{"area_quality":1000000}}]}"#;
        std::fs::write(&p, old).unwrap();
        let c = AppConfig::load_from(&p);
        let off = c.profile();
        assert_eq!(off.diffusion_model, crate::catalog::join_rel(Path::new(r"D:\sd"), "models/qwen21/qwen-image-2.1-turbo-Q4_K_M.gguf"));
        assert_eq!(off.display_name, "Qwen-Image 2.1 Turbo Q4_K_M (official)");
        assert_eq!(off.backend_args, vec!["--x".to_string()], "launch flags stay");
        assert_eq!(off.recommended_settings, RecommendedSettings::default());
        let mine = c.profiles.iter().find(|p| p.id == "mine").unwrap();
        assert_eq!(mine.diffusion_model, PathBuf::from(r"D:\sd\mine.gguf"), "other profiles keep their model");
        assert_eq!(mine.recommended_settings, RecommendedSettings::default());
        assert_eq!(c.schema_version, SCHEMA_VERSION);
    }

    #[test]
    fn upscaler_file_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = AppConfig::default();
        c.sdcpp_dir = dir.path().to_path_buf();
        c.upscaler_model = UPSCALER_CHOICES[0].0.into(); // the PC default (Macs: Lanczos)
        assert!(c.upscaler_file().is_none());
        std::fs::create_dir_all(c.upscalers_dir()).unwrap();
        let f = c.upscalers_dir().join("4xNomos2_hq_mosr.pth");
        std::fs::write(&f, b"partial").unwrap();
        assert!(c.upscaler_file().is_none(), "a partial file is not installed");
        std::fs::File::create(&f).unwrap().set_len(crate::catalog::UPSCALER.size).unwrap();
        assert_eq!(c.upscaler().unwrap(), ("4xNomos2_hq_mosr".to_string(), f.clone()), "the chosen model is missing: the bundled MoSR runs");
        let ss = c.upscalers_dir().join("4x_NMKD-Superscale-SP_178000_G.pth");
        std::fs::write(&ss, b"x").unwrap();
        assert_eq!(c.upscaler().unwrap(), ("4x_NMKD-Superscale-SP_178000_G".to_string(), ss));
        c.upscaler_model = "4xNomos2_hq_mosr".into();
        assert_eq!(c.upscaler_file().unwrap(), f);
        c.upscaler_model = LANCZOS.into();
        assert_eq!(c.upscaler(), None, "a plain resize, even with models installed");
        c.upscale_blend = 1.5;
        assert!(c.validate().is_err());
        // Older config files without the new fields keep loading with defaults.
        let old: AppConfig = serde_json::from_str(r#"{"serverPort": 41000, "vaeTileSize": 512}"#).unwrap();
        assert_eq!(old.profile().recommended_settings.area_quality, 2048 * 2048);
    }

    #[test]
    fn eight_gb_preset_reserves_more_vram() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let load = |json: &str| {
            std::fs::write(&path, json).unwrap();
            AppConfig::load_from(&path).vram_reserve_gib
        };
        assert_eq!(load(r#"{"schemaVersion": 9, "hardwarePreset": "8gb", "vramReserveGib": 1.0}"#), 1.5);
        assert_eq!(load(r#"{"schemaVersion": 9, "hardwarePreset": "8gb", "vramReserveGib": 2.0}"#), 2.0, "set by hand");
        assert_eq!(load(r#"{"schemaVersion": 9, "hardwarePreset": "16gb", "vramReserveGib": 1.0}"#), 1.0);
        assert_eq!(load(r#"{"schemaVersion": 10, "hardwarePreset": "8gb", "vramReserveGib": 1.0}"#), 1.0, "chosen after the migration");
        let mut c = AppConfig::default();
        c.apply_preset(crate::catalog::preset("8gb").unwrap());
        assert_eq!(c.vram_reserve_gib, 1.5);
        c.apply_preset(crate::catalog::preset("12gb").unwrap());
        assert_eq!(c.vram_reserve_gib, 1.0);
    }

    #[test]
    fn roundtrip_and_partial_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut c = AppConfig::default();
        c.server_port = 40000;
        c.ui = serde_json::json!({"quality": "fast"});
        c.save_to(&path).unwrap();
        assert_eq!(AppConfig::load_from(&path), c);
        std::fs::write(&path, r#"{"serverPort": 41000}"#).unwrap();
        let p = AppConfig::load_from(&path);
        assert_eq!(p.server_port, 41000);
        assert_eq!(p.profiles.len(), 1);
        std::fs::write(&path, "\u{feff}{\"serverPort\": 42000}").unwrap();
        assert_eq!(AppConfig::load_from(&path).server_port, 42000, "UTF-8 BOM accepted");
        std::fs::write(&path, "{ broken").unwrap();
        assert_eq!(AppConfig::load_from(&path), AppConfig::default());
        assert!(path.with_extension("json.invalid").exists());
    }

    #[test]
    fn validation() {
        let mut c = AppConfig::default();
        c.service_port = c.server_port;
        assert!(c.validate().is_err());
        let mut c = AppConfig::default();
        c.remote_port = c.service_port;
        assert!(c.validate().is_err());
        let mut c = AppConfig::default();
        c.device = "cuda0; rm".into();
        assert!(c.validate().is_err());
    }

    /// A 0.10.2 config file (no network fields) loads with access from other devices off.
    #[test]
    fn config_from_0_10_2_keeps_network_access_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let old = r#"{"schemaVersion": 10, "serverPort": 39150, "servicePort": 39151, "setupComplete": true,
            "hardwarePreset": "16gb", "outputDir": "/home/me/Pictures/Kokon", "ui": {"quality": "balanced"}}"#;
        std::fs::write(&path, old).unwrap();
        let c = AppConfig::load_from(&path);
        assert!(!c.remote_access);
        assert_eq!(c.remote_port, DEFAULT_REMOTE_PORT);
        assert!(c.setup_complete);
        assert_eq!(c.output_dir, PathBuf::from("/home/me/Pictures/Kokon"));
        assert_eq!(c.ui["quality"], "balanced");
        assert!(c.validate().is_ok());
    }

    #[test]
    fn browser_saves_keep_the_computers_settings() {
        let current = AppConfig { remote_access: true, extra_server_args: vec!["--x".into()], ..AppConfig::default() };
        let mut sent = current.clone();
        sent.sdcpp_dir = PathBuf::from("/tmp/evil");
        sent.output_dir = PathBuf::from("/etc");
        sent.extra_server_args = vec!["--rpc".into()];
        sent.profiles[0].diffusion_model = PathBuf::from("/etc/passwd");
        sent.service_port = 40000;
        sent.remote_access = false;
        sent.remote_port = 40001;
        sent.flash_attention = !current.flash_attention;
        sent.keep_computer_settings(&current);
        let mut expected = current.clone();
        expected.flash_attention = sent.flash_attention;
        assert_eq!(sent, expected, "only the app setting changed");
    }
}
