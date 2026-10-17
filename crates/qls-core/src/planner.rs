//! Turns a user-level request ("change the car to black", one image, Balanced) into a
//! concrete generation plan: mode, working resolution, steps/CFG, memory mitigations.
//! Pure functions only — image sizes are passed in — so behavior is fully testable.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::config::RecommendedSettings;
use crate::error::{AppError, ErrorCode};
use crate::geometry::{
    self, CanvasLimits, Expansion, ExpansionUnits, OutpaintPlan, Rect, Size, WorkingCanvas, aspect_label, dims_for_area,
    expansion_for_aspect, expansion_to_pixels, plan_outpaint, plan_working_canvas,
};

// ---------------------------------------------------------------------------------------
// Request (stable, user-level)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Auto,
    Generate,
    Edit,
    Inpaint,
    Outpaint,
    MultiReference,
    Upscale,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolvedMode {
    Generate,
    Edit,
    Inpaint,
    Outpaint,
    MultiReference,
    Upscale,
}

impl ResolvedMode {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Generate => "Text to Image",
            Self::Edit => "Edit Image",
            Self::Inpaint => "Inpainting",
            Self::Outpaint => "Outpainting",
            Self::MultiReference => "Multi-reference",
            Self::Upscale => "Upscale",
        }
    }
}

/// What an inpaint does in the painted area. Each action wraps the prompt in an instruction
/// that points the model at the area (marked on a second reference image, see pipeline).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum InpaintAction {
    /// The prompt describes the change.
    #[default]
    Edit,
    /// Erase the painted content and fill with background; the prompt (what to remove) is optional.
    Remove,
    /// Put what the prompt describes in place of the painted content.
    Replace,
    /// Add what the prompt describes inside the painted area.
    Add,
}

static REMOVE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^\s*(?:please\s+)?(?:remove|erase|delete|get rid of|take out|clear away|clean up)\b\s*").unwrap());

impl InpaintAction {
    /// The action actually run: an Edit whose prompt asks to remove something is a Remove.
    pub fn resolve(self, prompt: &str) -> Self {
        if self == Self::Edit && REMOVE_RE.is_match(prompt) { Self::Remove } else { self }
    }

    /// The prompt without the action's own verb ("Remove the girl" → "the girl").
    pub fn subject(self, prompt: &str) -> String {
        static ADD_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^\s*(?:please\s+)?(?:add|put|place|insert)\b\s*").unwrap());
        static REPLACE_RE: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"(?i)^\s*(?:please\s+)?(?:replace(?:\s+(?:it|this|that|them))?\s+with|change(?:\s+(?:it|this|that))?\s+(?:in)?to|with)\b\s*").unwrap());
        let p = prompt.trim();
        let s = match self {
            Self::Edit => p.into(),
            Self::Remove => REMOVE_RE.replace(p, "").into_owned(),
            Self::Add => ADD_RE.replace(p, "").into_owned(),
            Self::Replace => REPLACE_RE.replace(p, "").into_owned(),
        };
        s.trim().trim_end_matches(['.', '!']).trim().to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum UpscaleMethod {
    /// The upscaler model (ESRGAN) only, straight from the image. "detailed" (a low-denoise
    /// diffusion refine, removed 2026-10-09: Turbo cannot refine at low strength) maps here.
    #[default]
    #[serde(alias = "detailed")]
    Quick,
}

/// Target of an upscale job. Exact `width`+`height` win, then one side (aspect kept),
/// then `scale`; the default is 2x.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct UpscaleSpec {
    #[serde(default)]
    pub method: UpscaleMethod,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

/// Largest upscale result: 8192 px per side (the ESRGAN endpoint's limit) and ~40 MP.
pub const MAX_UPSCALE_SIDE: u32 = 8192;
pub const MAX_UPSCALE_AREA: u64 = 40_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Quality {
    /// ~1 MP. Older versions' "turbo" maps here.
    #[default]
    #[serde(alias = "turbo")]
    Fast,
    /// ~1.5K.
    Balanced,
    /// Native 2K, Qwen's recommended size. Older versions' "ultra" (2K, 40 steps) maps here.
    #[serde(alias = "ultra")]
    Quality,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum ResolutionMode {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "1k")]
    K1,
    #[serde(rename = "1.5k")]
    K15,
    #[serde(rename = "2k")]
    K2,
    #[serde(rename = "custom")]
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    #[default]
    Png,
    Jpeg,
    Webp,
}

impl OutputFormat {
    pub fn ext(&self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct OutpaintSpec {
    #[serde(default)]
    pub left: f64,
    #[serde(default)]
    pub right: f64,
    #[serde(default)]
    pub top: f64,
    #[serde(default)]
    pub bottom: f64,
    #[serde(default)]
    pub units: ExpansionUnits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AdvancedOptions {
    pub sampler: Option<String>,
    /// Edit/inpaint denoising strength (0..1).
    pub strength: Option<f32>,
    pub batch_count: Option<u32>,
    pub output_format: Option<OutputFormat>,
    /// None = automatic.
    pub vae_tiling: Option<bool>,
    /// Keep the HDR gain map of a HEIC source (Ultra HDR JPEG output); None = on.
    pub hdr: Option<bool>,
    /// How large edit/combine sources are given to the model; None = standard (1 MP).
    pub reference_detail: Option<ReferenceDetail>,
}

/// Size of the source images the model sees in edits and combines. They share the token
/// budget with the image being drawn, so a smaller reference leaves room for a larger output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceDetail {
    /// At most 1 MP per reference (diffusers' Qwen edit pipelines use ~1 MP too): the rest
    /// of the budget goes to the output, which renders larger and in fewer total tokens.
    #[default]
    Standard,
    /// Up to the output's own area: finer source detail, but a single edit gets half the budget.
    Full,
}

/// Largest reference area with [`ReferenceDetail::Standard`].
pub const STANDARD_REFERENCE_AREA: u64 = 1024 * 1024;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct GenerationRequest {
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    #[serde(default)]
    pub mode: Mode,
    /// Ordered image sources: "input:<id>", "gen:<id>" or an absolute file path.
    #[serde(default)]
    pub images: Vec<String>,
    #[serde(default)]
    pub mask: Option<String>,
    /// What to do in the masked area (inpaint only).
    #[serde(default)]
    pub inpaint_action: InpaintAction,
    #[serde(default)]
    pub outpaint: Option<OutpaintSpec>,
    #[serde(default)]
    pub quality: Quality,
    #[serde(default)]
    pub resolution: ResolutionMode,
    /// "auto", "1:1", "16:9", ... (text-to-image, edit, multi-reference; image 1's shape when unset).
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub seed: Option<i64>,
    #[serde(default = "default_true")]
    pub preserve_dimensions: bool,
    #[serde(default)]
    pub advanced: AdvancedOptions,
    #[serde(default)]
    pub output_path: Option<String>,
    #[serde(default)]
    pub client: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    /// Target for `mode: upscale`.
    #[serde(default)]
    pub upscale: Option<UpscaleSpec>,
    /// Private mode: inputs and results go to a temporary store (not the gallery or the
    /// output folder) that is deleted when private mode ends or the service exits.
    #[serde(default)]
    pub private: bool,
}

// ---------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RefPlan {
    pub index: usize,
    pub source: Size,
    pub canvas: WorkingCanvas,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct UpscalePlan {
    pub method: UpscaleMethod,
    pub source: Size,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Plan {
    pub mode: ResolvedMode,
    pub auto_mode: bool,
    pub mode_reason: String,
    /// Delivered image size.
    pub output: Size,
    /// Model canvas size (multiple of 32).
    pub working: Size,
    /// Content area inside `working` that maps to the output (rest is alignment padding).
    pub content: Rect,
    /// Sampling steps (Turbo's 8; 0 = no diffusion, a Quick upscale).
    pub steps: u32,
    /// Always 1 (Turbo runs without classifier-free guidance).
    pub cfg: f32,
    pub sampler: String,
    pub strength: Option<f32>,
    pub batch_count: u32,
    pub vae_tiling: bool,
    pub output_format: OutputFormat,
    pub negative_prompt: String,
    pub references: Vec<RefPlan>,
    pub outpaint: Option<OutpaintPlan>,
    /// Region of the source sent to the model for inpainting.
    pub inpaint_region: Option<Rect>,
    /// Resolved inpaint action (see [`InpaintAction::resolve`]).
    #[serde(default)]
    pub inpaint_action: Option<InpaintAction>,
    pub quality: Quality,
    pub resolution: ResolutionMode,
    pub aspect_label: String,
    /// User-visible notes such as "Optimized for available GPU memory".
    pub notes: Vec<String>,
    pub optimized_for_vram: bool,
    pub estimated_seconds: f32,
    /// Upscaler model used to enlarge the result; None = Lanczos.
    #[serde(default)]
    pub upscaler: Option<String>,
    /// Tile size the upscaler runs with ([`upscale_tile`]); 0 in records of older versions.
    #[serde(default)]
    pub upscale_tile: u32,
    #[serde(default)]
    pub upscale: Option<UpscalePlan>,
    /// Exact noise schedule (Turbo's); empty when no diffusion runs.
    #[serde(default)]
    pub custom_sigmas: Vec<f32>,
    /// Reference size policy of edits and combines (None for the other modes and in records
    /// of older versions, which always encoded references at the output's area).
    #[serde(default)]
    pub reference_detail: Option<ReferenceDetail>,
    /// Decode tile (width, height in pixels) sent with the job; None = the server's own.
    #[serde(default)]
    pub vae_tile: Option<(u32, u32)>,
}

/// Facts about inputs and the environment, measured before planning.
#[derive(Debug, Clone, Default)]
pub struct PlanInputs {
    pub image_sizes: Vec<Size>,
    /// (mask size, bounding box of painted area, coverage 0..1)
    pub mask: Option<(Size, Option<Rect>, f64)>,
    pub vram_total_mib: Option<u64>,
    /// Upscaler model available to the server (`AppConfig::upscaler_file`).
    pub upscaler: Option<String>,
    /// Upscaler tile size ([`upscale_tile`]); 0 = the large-memory default.
    pub upscale_tile: u32,
    /// The Metal engine (Apple Silicon): much slower upscaler.
    pub metal: bool,
    /// The server was launched with `--vae-tiling` (tiles every decode by default).
    pub server_vae_tiling: bool,
    /// SageAttention is enabled (faster steps; used for estimates only).
    pub sage_attention: bool,
    /// Measured speed of this machine relative to the time model (`crate::speed`).
    pub speed_factor: Option<f32>,
    /// Without a measurement, report `estimated_seconds` = 0 (unknown until the first image)
    /// instead of the uncalibrated model, which only fits the hardware it was measured on.
    pub hide_uncalibrated: bool,
    /// Apple Silicon (unified memory). Fast renders its full size here too: 768² plus the
    /// upscaler took longer than 1 MP directly on an M2 Pro (5 min 25 s vs 4 min 20 s, 2026-10-10).
    pub unified_memory: bool,
}

// ---------------------------------------------------------------------------------------
// Prompt understanding (deliberately small and predictable)
// ---------------------------------------------------------------------------------------

static RATIO_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d{1,2})\s*:\s*(\d{1,2})\b").unwrap());
static DIMS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b(\d{3,4})\s*[x×]\s*(\d{3,4})\b").unwrap());
static OUTPAINT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(extend|expand|outpaint|uncrop|zoom(?:ed)? out|widen|make (?:it|the image) (?:wider|taller))\b").unwrap());
static AMOUNT_PCT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(\d{1,3})\s*(%|percent)").unwrap());
static AMOUNT_PX_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(\d{2,4})\s*(px|pixels?)\b").unwrap());

#[derive(Debug, Clone, PartialEq)]
pub enum AspectHint {
    Ratio(f64, String),
    Dimensions(u32, u32),
}

/// Aspect ratio implied by a text prompt, if any.
pub fn aspect_hint(prompt: &str) -> Option<AspectHint> {
    if let Some(c) = DIMS_RE.captures(prompt) {
        let (w, h): (u32, u32) = (c[1].parse().ok()?, c[2].parse().ok()?);
        if (64..=4096).contains(&w) && (64..=4096).contains(&h) {
            return Some(AspectHint::Dimensions(w, h));
        }
    }
    // Only well-known ratios, so times like "10:30" are not mistaken for aspect ratios.
    const KNOWN: &[(u32, u32)] = &[(1, 1), (4, 3), (3, 4), (3, 2), (2, 3), (16, 9), (9, 16), (21, 9), (9, 21), (5, 4), (4, 5), (2, 1), (1, 2), (16, 10), (10, 16)];
    for c in RATIO_RE.captures_iter(prompt) {
        let (a, b): (u32, u32) = (c[1].parse().ok()?, c[2].parse().ok()?);
        if KNOWN.contains(&(a, b)) {
            return Some(AspectHint::Ratio(a as f64 / b as f64, format!("{a}:{b}")));
        }
    }
    let p = prompt.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| p.contains(w));
    if has(&["panorama", "panoramic", "ultrawide", "ultra-wide", "cinematic banner"]) {
        return Some(AspectHint::Ratio(21.0 / 9.0, "21:9".into()));
    }
    if has(&["hero image", "hero banner", "banner", "landscape", "widescreen", "wide shot", "desktop wallpaper", "youtube thumbnail", "cinematic"]) {
        return Some(AspectHint::Ratio(16.0 / 9.0, "16:9".into()));
    }
    if has(&["phone wallpaper", "mobile wallpaper", "instagram story", "story format", "vertical video", "tiktok", "smartphone wallpaper"]) {
        return Some(AspectHint::Ratio(9.0 / 16.0, "9:16".into()));
    }
    if has(&["portrait", "poster", "full-body", "full body", "book cover", "vertical"]) {
        return Some(AspectHint::Ratio(3.0 / 4.0, "3:4".into()));
    }
    if has(&["square", "profile picture", "avatar", "app icon", "icon", "logo", "instagram post"]) {
        return Some(AspectHint::Ratio(1.0, "1:1".into()));
    }
    None
}

pub fn parse_aspect(s: &str) -> Option<(f64, String)> {
    let s = s.trim();
    if s.eq_ignore_ascii_case("auto") || s.is_empty() {
        return None;
    }
    let (a, b) = s.split_once([':', 'x', '/'])?;
    let (a, b): (f64, f64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    (a > 0.0 && b > 0.0 && (a / b) > 0.124 && (a / b) < 8.1).then(|| (a / b, s.to_string()))
}

/// Outpaint intent expressed in words ("extend to the left", "make it 16:9 landscape").
pub fn outpaint_intent(prompt: &str, source: Size) -> Option<Expansion> {
    if !OUTPAINT_RE.is_match(prompt) {
        return None;
    }
    let p = prompt.to_lowercase();
    let amount_pct = AMOUNT_PCT_RE.captures(&p).and_then(|c| c[1].parse::<f64>().ok()).filter(|v| *v > 0.0 && *v <= 200.0);
    let amount_px = AMOUNT_PX_RE.captures(&p).and_then(|c| c[1].parse::<f64>().ok());
    let side = |pct_base: u32| -> u32 {
        if let Some(px) = amount_px {
            return px as u32;
        }
        (pct_base as f64 * amount_pct.unwrap_or(25.0) / 100.0).round() as u32
    };
    let word = |w: &str| Regex::new(&format!(r"\b{w}\b")).map(|r| r.is_match(&p)).unwrap_or(false);
    let mut e = Expansion::default();
    if word("left") {
        e.left = side(source.width);
    }
    if word("right") {
        e.right = side(source.width);
    }
    if word("top") || word("up") || word("upwards") || word("above") || word("sky") {
        e.top = side(source.height);
    }
    if word("bottom") || word("down") || word("downwards") || word("below") {
        e.bottom = side(source.height);
    }
    if word("sides") || word("horizontally") || word("wider") || word("widen") {
        e.left = side(source.width);
        e.right = side(source.width);
    }
    if word("vertically") || word("taller") {
        e.top = side(source.height);
        e.bottom = side(source.height);
    }
    if e.is_zero() {
        if let Some(AspectHint::Ratio(r, _)) = aspect_hint(prompt) {
            let x = expansion_for_aspect(source, r);
            if !x.is_zero() {
                return Some(x);
            }
        }
        if p.contains("landscape") {
            return Some(expansion_for_aspect(source, 16.0 / 9.0)).filter(|x| !x.is_zero());
        }
        if p.contains("portrait") {
            return Some(expansion_for_aspect(source, 9.0 / 16.0)).filter(|x| !x.is_zero());
        }
        // "zoom out" / "expand the image": every side.
        let h = side(source.width);
        let v = side(source.height);
        e = Expansion { left: h, right: h, top: v, bottom: v };
    }
    Some(e)
}

// ---------------------------------------------------------------------------------------
// Resolution and memory policy
// ---------------------------------------------------------------------------------------

/// Official Qwen-Image 2.1 native 2K buckets (model card).
const OFFICIAL_2K: &[(f64, u32, u32)] = &[
    (1.0, 2048, 2048),
    (4.0 / 3.0, 2400, 1792),
    (3.0 / 4.0, 1792, 2400),
    (3.0 / 2.0, 2528, 1696),
    (2.0 / 3.0, 1696, 2528),
    (16.0 / 9.0, 2752, 1536),
    (9.0 / 16.0, 1536, 2752),
];

/// Output size for an aspect ratio and pixel area: the official 2K bucket when one matches,
/// else the closest aligned size.
fn size_for_aspect(aspect: f64, area: u64, rec: &RecommendedSettings) -> Size {
    match OFFICIAL_2K.iter().find(|(a, w, h)| (a / aspect - 1.0).abs() < 0.01 && (*w as u64 * *h as u64) as f64 <= area as f64 * 1.02 && area >= 2048 * 2048) {
        Some((_, w, h)) => Size::new(*w, *h),
        None => dims_for_area(aspect, area as f64, rec.align, 256, rec.max_side),
    }
}

pub fn resolution_area(mode: ResolutionMode, quality: Quality, rec: &RecommendedSettings) -> Option<u64> {
    match mode {
        ResolutionMode::Auto => Some(match quality {
            Quality::Fast => rec.area_fast,
            Quality::Balanced => rec.area_balanced,
            Quality::Quality => rec.area_quality,
        }),
        ResolutionMode::K1 => Some(1024 * 1024),
        ResolutionMode::K15 => Some(1536 * 1536),
        ResolutionMode::K2 => Some(2048 * 2048),
        ResolutionMode::Source | ResolutionMode::Custom => None,
    }
}

/// Transformer token budget for the whole sequence (target + references), from total
/// VRAM. 16384 tokens = one 2048² image, verified to run on a 16 GB card.
pub fn token_budget(vram_total_mib: Option<u64>) -> u64 {
    let Some(mib) = vram_total_mib else { return 12_288 };
    let gib = mib as f64 / 1024.0;
    // Anchored on measurement: a 16 GB card (≈15.9 GiB reported) runs 2048² text-to-image.
    let tokens = if gib < 15.0 {
        (gib - 2.0) / 13.0 * 16_384.0
    } else if gib <= 20.0 {
        16_384.0
    } else {
        16_384.0 + (gib - 20.0) * 1_024.0
    };
    tokens.clamp(4_096.0, 24_576.0) as u64
}

/// Extra tokens for discrete GPUs of 15 GiB and up: 16 GB cards run native 2K edits
/// (2752×1536 = 16 512 tokens) with a standard 1 MP reference (1344×768 = 4 032), like
/// Unsloth Studio's 2720×1536 + 1 MP on the same RTX 5070 Ti. sd-server's graph cut
/// (`--max-vram -1`) splits the graph instead of failing if the activations do not fit.
pub const DISCRETE_LARGE_GPU_BONUS: u64 = 20_736 - 16_384;

/// Token budget the planner uses: [`token_budget`], plus [`DISCRETE_LARGE_GPU_BONUS`] on
/// discrete GPUs of 15 GiB and up. Macs (unified memory) and smaller cards are not measured
/// at larger sizes yet and keep the base budget.
pub fn planning_token_budget(vram_total_mib: Option<u64>, unified_memory: bool) -> u64 {
    let base = token_budget(vram_total_mib);
    match vram_total_mib {
        Some(mib) if !unified_memory && mib as f64 / 1024.0 >= 15.0 => base + DISCRETE_LARGE_GPU_BONUS,
        _ => base,
    }
}

/// Untiled-decode budget for an unknown GPU: an untiled 1 MP decode leaves margin on a
/// 16 GB card with the DiT resident, larger ones tile.
pub const LARGE_GPU_VAE_TILE_AREA: u64 = 1024 * 1024;
/// Weights and overhead that stay resident while the VAE decodes (DiT ~4.5 GB + VAE
/// ~0.65 GB + CUDA context and fragmentation).
const VAE_DECODE_RESIDENT_MIB: u64 = 7 * 1024;
/// Activation bytes per pixel of an untiled decode, between the two measurements in
/// docs/engineering-notes.md (untiled 2K needs ~18 GB end to end → ~2.6 kB/px; the "~1.5
/// MP fills a 16 GB card" anchor implies more) — chosen so both hold with margin.
const VAE_DECODE_BYTES_PER_PIXEL: f64 = 3500.0;
/// Share of the planning VRAM a decode may use; the rest is headroom.
const VAE_DECODE_VRAM_SHARE: f64 = 0.85;

/// Largest decode area (pixels) that may run untiled on a GPU with `vram_total_mib` of
/// planning VRAM: `resident + area * bytes_per_pixel <= share * vram`. Scales with the
/// card instead of assuming the smallest one: a 16 GB card keeps tiled 1.5K and 2K
/// decodes, a 32 GB card decodes every size the planner can budget untiled. sd.cpp
/// retries a decode that runs out of memory with smaller tiles itself, so an estimate
/// that is slightly too large only costs the retry.
pub fn max_untiled_vae_area(vram_total_mib: Option<u64>) -> u64 {
    match vram_total_mib {
        None => LARGE_GPU_VAE_TILE_AREA,
        Some(mib) => {
            let budget_mib = mib as f64 * VAE_DECODE_VRAM_SHARE - VAE_DECODE_RESIDENT_MIB as f64;
            (budget_mib.max(0.0) * 1024.0 * 1024.0 / VAE_DECODE_BYTES_PER_PIXEL) as u64
        }
    }
}
/// Overlap the server is launched with (`--vae-tile-overlap`), also sent with per-job tiles.
pub const VAE_TILE_OVERLAP: f32 = 0.125;
/// Pixels per latent of Qwen-Image 2.1's VAE.
const VAE_SCALE: u32 = 16;
/// Shortest side of a shaped decode tile, in latents (512 px).
const MIN_VAE_TILE_SIDE: u32 = 32;

/// Tiles sd.cpp makes along one axis of `dim` latents with `tile`-latent tiles
/// (`sd_tiling_plan_axis` in runtime/tiling.cpp, non-circular).
fn vae_axis_tiles(dim: u32, tile: u32, overlap: f32) -> u32 {
    if tile >= dim {
        return 1;
    }
    let extent = (dim - tile) as i64;
    let tile = tile as i64;
    let target = extent as f32 / ((1.0 - overlap) * tile as f32);
    let min_i = 1 + (extent - 1) / (tile - 1).max(1);
    let max_i = (2 * extent / tile).max(1);
    let lower = (target.floor() as i64).clamp(min_i, max_i.max(min_i));
    let upper = (target.ceil() as i64).clamp(min_i, max_i.max(min_i));
    let err = |n: i64| (1.0 / n as f32 - 1.0 / target).abs();
    (if err(upper) < err(lower) { upper } else { lower }) as u32 + 1
}

/// Decode tile (width, height in pixels) for a `size` image whose tiles may cover at most
/// `max_area`: the grid with the least decoded area, overlap included. The server's square
/// 768 px tiles cut 2752×1536 into 4×3 tiles covering 67 % more than the image; shaped
/// tiles (at least 512 px a side) cover it in 5 full-height 608 px columns (+10 %).
pub fn vae_decode_tile(size: Size, max_area: u64) -> (u32, u32) {
    let (lw, lh) = (size.width / VAE_SCALE, size.height / VAE_SCALE);
    // Tile length for `n` tiles along an axis (sd.cpp's relative size > 1).
    let len = |dim: u32, n: u32| if n <= 1 { dim } else { ((dim as f32 / (n as f32 * (1.0 - VAE_TILE_OVERLAP) + VAE_TILE_OVERLAP)).floor() as u32).max(4) };
    let mut best: Option<(u64, u32, (u32, u32))> = None;
    for nx in 1..=12 {
        for ny in 1..=12 {
            let (tw, th) = (len(lw, nx), len(lh, ny));
            // Thin strips decode least but leave little context at the seams.
            if (tw * th * VAE_SCALE * VAE_SCALE) as u64 > max_area || tw.min(th) < MIN_VAE_TILE_SIDE.min(lw).min(lh) {
                continue;
            }
            let count = vae_axis_tiles(lw, tw, VAE_TILE_OVERLAP) * vae_axis_tiles(lh, th, VAE_TILE_OVERLAP);
            let cost = count as u64 * (tw * th) as u64;
            if best.map(|(c, n, _)| (cost, count) < (c, n)).unwrap_or(true) {
                best = Some((cost, count, (tw * VAE_SCALE, th * VAE_SCALE)));
            }
        }
    }
    best.map(|b| b.2).unwrap_or((768, 768))
}

/// Apple Silicon: the VRAM-equivalent to plan with on a Mac with `ram_mib` of unified
/// memory, so presets and working sizes follow the same rules as a discrete GPU.
///
/// Metal lets the GPU wire about 2/3 of unified memory (about 3/4 from 64 GB up; macOS's
/// `recommendedMaxWorkingSetSize`, the rest stays for the system). The GPU budgets above
/// assume the text encoder sits in *separate* system RAM; on a Mac it shares the same pool,
/// so its weights (`text_encoder_mib`, encoder + vision projector) come off the top.
/// Not yet measured on a Mac: 16 GB → ~4.5 GiB (lightest preset, 1 MP only),
/// 24 GB → ~9.8 GiB (12 GB preset), 32 GB → ~15 GiB (16 GB preset, 2K),
/// 64 GB → ~42 GiB (32 GB+ preset).
pub fn unified_memory_planning_mib(ram_mib: u64, text_encoder_mib: u64) -> u64 {
    let gpu_share = if ram_mib >= 64 * 1024 { ram_mib * 3 / 4 } else { ram_mib * 2 / 3 };
    gpu_share.saturating_sub(text_encoder_mib)
}

pub const PIXELS_PER_TOKEN: u64 = 256; // 8x VAE downscale, 2x2 patches

/// The noise schedule of every diffusion job: `sample_sigmas` of Qwen/Qwen-Image-2.1-Turbo's model_index.json
/// (8 steps, fixed at every resolution, no dynamic shift), sent verbatim because sd.cpp's
/// own Qwen schedule shifts by resolution and has a 0.02 terminal shift.
pub const TURBO_SIGMAS: [f32; 9] = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0];
/// Turbo's step count (fixed: Qwen evaluated no other schedule).
pub const TURBO_STEPS: u32 = TURBO_SIGMAS.len() as u32 - 1;

/// Area of the inpaint guide reference (the region with the painted area marked), as a
/// share of the working canvas: enough to locate the area, cheap in tokens.
pub const INPAINT_GUIDE_AREA: f64 = 0.25;

/// An inpaint paints its region at most this many times its real pixel area (at least
/// [`INPAINT_MIN_AREA`]): enlarging a small image to the quality tier costs time, and the extra
/// pixels are thrown away when the patch is shrunk back (1024² painted at 1888²: ~40 s vs ~15 s).
pub const INPAINT_MAX_ENLARGE: f64 = 1.5;
/// Smallest inpaint canvas: the model's own ~1 MP, below which it does worse.
pub const INPAINT_MIN_AREA: u64 = 1024 * 1024;

/// Seconds per sampling step, from RTX 5070 Ti measurements at CFG 6 (two model passes per
/// step): 1 MP ≈ 2.0 s (1.63 s with SageAttention), 2048x1152 ≈ 5.6 s (3.8 s with
/// SageAttention). CFG 1 (always, with Turbo) runs one pass, so half of that.
fn step_seconds(tokens: f32, ref_tokens: f32, sage: bool, cfg: f32) -> f32 {
    let x = tokens / 4096.0;
    let base = if sage { 1.6 * x.powf(1.1) } else { 2.0 * x.powf(1.4) };
    let passes = if uses_guidance(cfg) { 1.0 } else { 0.5 };
    base * passes * (1.0 + 0.12 * ref_tokens / tokens.max(1.0))
}

/// sd-server runs the unconditional pass whenever CFG differs from 1 (diffusion_engine.cpp,
/// commit 3f8527a); only then is the negative prompt used.
pub fn uses_guidance(cfg: f32) -> bool {
    (cfg - 1.0).abs() > 1e-4
}

/// Upscaler tile size with at least this much GPU memory (MiB): the 16 GB presets and up.
pub const LARGE_UPSCALE_TILE_MIB: u64 = 14 * 1024;
pub const LARGE_UPSCALE_TILE: u32 = 768;
pub const SMALL_UPSCALE_TILE: u32 = 256;
/// ESRGAN tiles: with direct convolutions 128 px is as fast as 256–512 px on an RTX 5070 Ti
/// (13.2–13.7 s for 1472², 2026-10-12) at a fraction of the memory (+455 MB vs +3.4 GB).
pub const ESRGAN_UPSCALE_TILE: u32 = 128;

/// Whether `model` is the MoSR upscaler (anything else is an ESRGAN model).
pub fn is_mosr(model: &str) -> bool {
    model == crate::catalog::UPSCALER_NAME
}

/// Tile size of the upscaler: `override_px` when set; ESRGAN 128 px; MoSR 768 px on 16 GB
/// cards and Macs with 32 GB+ (about +1.55 GB on CUDA with direct convolutions), 256 px below
/// (12 GB cards, 16–24 GB Macs: about +0.5 GB). Unknown GPU: the 16 GB default preset's.
pub fn upscale_tile(override_px: u32, vram_mib: Option<u64>, model: &str) -> u32 {
    match (override_px, vram_mib) {
        (t, _) if t > 0 => t,
        _ if !is_mosr(model) => ESRGAN_UPSCALE_TILE,
        (_, Some(v)) if v < LARGE_UPSCALE_TILE_MIB => SMALL_UPSCALE_TILE,
        _ => LARGE_UPSCALE_TILE,
    }
}

/// One x4 pass over `input` pixels, model load included. Measured on a 1472² edit
/// (2026-10-12), RTX 5070 Ti, CUDA with direct convolutions: MoSR 3.1 s at 768 px tiles and
/// ~5 s at 128–256 px (Vulkan within 10%), Superscale-SP (ESRGAN) 13.2 s at 128 px. M2 Pro,
/// Metal: MoSR 54.6 s at 768 px and 78 s at 128 px; Superscale-SP 5 min 45 s for 1024² (M2 Pro,
/// 2026-10-12: ~345 s/MP, which is why Macs default to Lanczos).
pub fn esrgan_seconds(input: u64, tile: u32, metal: bool, mosr: bool) -> f32 {
    let large = tile == 0 || tile >= 512;
    let per_mp = match (mosr, metal, large) {
        (true, false, true) => 1.4,
        (true, false, false) => 2.3,
        (true, true, true) => 25.0,
        (true, true, false) => 32.0,
        (false, false, _) => 6.1,
        (false, true, _) => 345.0,
    };
    0.5 + per_mp * input as f32 / 1_048_576.0
}

/// VAE decode with 768 px tiles: ~1.3 s at 1 MP, ~3.9 s at 2048x1152.
fn decode_seconds(area: u64) -> f32 {
    1.0 + 1.25 * area as f32 / 1_048_576.0
}

/// Rough wall-clock estimate of one diffusion job (single pass), excluding enlargement.
pub fn estimate_seconds(working: Size, refs: &[RefPlan], steps: u32, batch: u32, sage: bool, cfg: f32) -> f32 {
    let tokens = |s: Size| (s.area() / PIXELS_PER_TOKEN) as f32;
    let ref_tokens: f32 = refs.iter().map(|r| tokens(r.canvas.canvas)).sum();
    let encode = 4.0 + ref_tokens / 4096.0 * 3.0;
    let t = encode + step_seconds(tokens(working), ref_tokens, sage, cfg) * steps as f32;
    (t + decode_seconds(working.area())) * batch as f32
}

/// Uncalibrated prediction of the backend part of a planned job (what `crate::speed`
/// compares with the measured time): encode, sampling and decode, no enlargement.
pub fn backend_seconds(p: &Plan, sage: bool) -> f32 {
    estimate_seconds(p.working, &p.references, p.steps, p.batch_count, sage, p.cfg)
}

fn limits(max_area: u64, rec: &RecommendedSettings) -> CanvasLimits {
    CanvasLimits { max_area, align: rec.align, max_side: rec.max_side, ..Default::default() }
}

/// Exact upscale target for a source size.
pub fn upscale_target(src: Size, spec: &UpscaleSpec) -> Result<Size, AppError> {
    let aspect = src.aspect();
    let t = match (spec.width, spec.height) {
        (Some(w), Some(h)) => Size::new(w, h),
        (Some(w), None) => Size::new(w, ((w as f64 / aspect).round() as u32).max(1)),
        (None, Some(h)) => Size::new(((h as f64 * aspect).round() as u32).max(1), h),
        (None, None) => {
            let s = spec.scale.unwrap_or(2.0);
            if !(s.is_finite() && s > 0.0) {
                return Err(AppError::invalid("The upscale factor must be a positive number."));
            }
            Size::new(((src.width as f64 * s).round() as u32).max(1), ((src.height as f64 * s).round() as u32).max(1))
        }
    };
    if t.width < 64 || t.height < 64 || t.width > MAX_UPSCALE_SIDE || t.height > MAX_UPSCALE_SIDE {
        return Err(AppError::invalid(format!("The upscaled size must be between 64 and {MAX_UPSCALE_SIDE} pixels per side.")));
    }
    if t.area() > MAX_UPSCALE_AREA {
        return Err(AppError::invalid(format!("{}×{} is too large; the limit is about 40 megapixels.", t.width, t.height)));
    }
    Ok(t)
}

fn detect_mode(req: &GenerationRequest, inputs: &PlanInputs) -> Result<(ResolvedMode, bool, String), AppError> {
    let n = inputs.image_sizes.len();
    let has_mask = req.mask.is_some() && inputs.mask.as_ref().map(|m| m.2 > 0.0).unwrap_or(false);
    let has_outpaint = req.outpaint.map(|o| o.left > 0.0 || o.right > 0.0 || o.top > 0.0 || o.bottom > 0.0).unwrap_or(false);
    let need = |ok: bool, msg: &str| if ok { Ok(()) } else { Err(AppError::invalid(msg)) };
    let explicit = |m: ResolvedMode, why: &str| Ok((m, false, why.to_string()));
    match req.mode {
        Mode::Generate => explicit(ResolvedMode::Generate, "Selected"),
        Mode::Edit => {
            need(n >= 1, "Add an image to edit.")?;
            if n >= 2 { explicit(ResolvedMode::MultiReference, "Selected (several images)") } else { explicit(ResolvedMode::Edit, "Selected") }
        }
        Mode::MultiReference => {
            need(n >= 1, "Add at least one reference image.")?;
            explicit(ResolvedMode::MultiReference, "Selected")
        }
        Mode::Inpaint => {
            need(n >= 1, "Add an image to inpaint.")?;
            need(has_mask, "Paint the area to change first.")?;
            explicit(ResolvedMode::Inpaint, "Selected")
        }
        Mode::Outpaint => {
            need(n >= 1, "Add an image to expand.")?;
            explicit(ResolvedMode::Outpaint, "Selected")
        }
        Mode::Upscale => {
            need(n >= 1, "Choose an image to upscale.")?;
            explicit(ResolvedMode::Upscale, "Selected")
        }
        Mode::Auto => {
            if n == 0 {
                return Ok((ResolvedMode::Generate, true, "No image provided".into()));
            }
            if has_mask {
                return Ok((ResolvedMode::Inpaint, true, "A mask was painted".into()));
            }
            if has_outpaint {
                return Ok((ResolvedMode::Outpaint, true, "Expansion requested".into()));
            }
            if n >= 2 {
                return Ok((ResolvedMode::MultiReference, true, format!("{n} reference images")));
            }
            if outpaint_intent(&req.prompt, inputs.image_sizes[0]).is_some() {
                return Ok((ResolvedMode::Outpaint, true, "The prompt asks to extend the image".into()));
            }
            Ok((ResolvedMode::Edit, true, "An image was provided".into()))
        }
    }
}

/// Reference canvas whose aligned area never exceeds `max_canvas_area`: the backend
/// resizes any reference larger than the output area (by area, with rounding that can
/// slightly distort aspect), so staying at or below it keeps references untouched.
fn ref_canvas(src: Size, max_canvas_area: u64, rec: &RecommendedSettings) -> WorkingCanvas {
    let mut area = src.area().min(max_canvas_area);
    loop {
        let c = plan_working_canvas(src, &CanvasLimits { min_side: 64, ..limits(area, rec) });
        if c.canvas.area() <= max_canvas_area || area < 64 * 64 {
            return c;
        }
        area = (area as f64 * 0.97) as u64;
    }
}

/// Produces the generation plan. `rec` comes from the active model profile.
pub fn plan(req: &GenerationRequest, inputs: &PlanInputs, rec: &RecommendedSettings) -> Result<Plan, AppError> {
    if req.prompt.len() > 8000 {
        return Err(AppError::invalid("The prompt is too long (8000 characters max)."));
    }
    if inputs.image_sizes.len() > rec.max_references as usize {
        return Err(AppError::invalid(format!("Use at most {} reference images.", rec.max_references)));
    }
    let (mode, auto_mode, mode_reason) = detect_mode(req, inputs)?;
    let inpaint_action = (mode == ResolvedMode::Inpaint).then(|| req.inpaint_action.resolve(&req.prompt));
    // Upscales and removals need no description.
    let prompt_optional = mode == ResolvedMode::Upscale || inpaint_action == Some(InpaintAction::Remove);
    if req.prompt.trim().is_empty() && !prompt_optional {
        return Err(AppError::invalid("Describe what to generate or change."));
    }
    let mut notes = Vec::new();
    let quality = req.quality;
    // Turbo: its fixed 8-step schedule without CFG (model card).
    let cfg = 1.0;
    let budget_tokens = planning_token_budget(inputs.vram_total_mib, inputs.unified_memory);
    let budget_area = budget_tokens * PIXELS_PER_TOKEN;
    let tier_area = resolution_area(req.resolution, quality, rec);
    let adv = &req.advanced;
    let mut steps = TURBO_STEPS;
    let batch_count = if mode == ResolvedMode::Upscale { 1 } else { adv.batch_count.unwrap_or(1).clamp(1, 8) };
    let mut optimized = false;
    // Diffusion always runs in one pass; larger outputs are enlarged with the upscaler
    // model (user A/B test, 2026-10-06: the two-pass refine made results worse).
    let mut upscale = None;

    // Shared: cap an area by the VRAM budget given references totalling `n_refs` times it.
    let mut cap_for_refs = |wanted: u64, n_refs: f64, notes: &mut Vec<String>| -> u64 {
        let allowed = (budget_area as f64 / (1.0 + n_refs)) as u64;
        if wanted > allowed {
            optimized = true;
            notes.push("Resolution reduced to fit available GPU memory.".into());
            allowed
        } else {
            wanted
        }
    };

    // Reference cap of edits and combines (besides the output's own area, see `ref_canvas`).
    let ref_cap = match adv.reference_detail.unwrap_or_default() {
        ReferenceDetail::Standard => STANDARD_REFERENCE_AREA,
        ReferenceDetail::Full => u64::MAX,
    };
    // Edit/combine: largest area `a <= wanted` with `a + Σ min(ref_i, a, ref_cap)` within the budget.
    let cap_for_sources = |wanted: u64, refs: &[Size], notes: &mut Vec<String>| -> u64 {
        let fits = |a: u64| a + refs.iter().map(|r| r.area().min(a).min(ref_cap)).sum::<u64>() <= budget_area;
        if fits(wanted) {
            return wanted;
        }
        let (mut lo, mut hi) = (budget_area / (1 + refs.len() as u64), wanted);
        while hi - lo > 1024 {
            let mid = (lo + hi) / 2;
            if fits(mid) { lo = mid } else { hi = mid }
        }
        notes.push("Resolution reduced to fit available GPU memory.".into());
        lo
    };

    let mut sources_reduced = false;
    let mut references = Vec::new();
    let mut outpaint = None;
    let mut inpaint_region = None;
    let mut strength = None;
    let output: Size;
    let working: WorkingCanvas;

    match mode {
        ResolvedMode::Generate => {
            let explicit_dims = match (req.width, req.height) {
                (Some(w), Some(h)) => Some((w, h)),
                _ => match req.aspect_ratio.as_deref().and_then(parse_aspect) {
                    Some(_) => None,
                    None => match aspect_hint(&req.prompt) {
                        Some(AspectHint::Dimensions(w, h)) if req.aspect_ratio.as_deref().map(|a| a == "auto").unwrap_or(true) => Some((w, h)),
                        _ => None,
                    },
                },
            };
            if let Some((w, h)) = explicit_dims {
                if !(64..=rec.max_side).contains(&w) || !(64..=rec.max_side).contains(&h) {
                    return Err(AppError::invalid(format!("Width and height must be between 64 and {}.", rec.max_side)));
                }
                let src = Size::new(w, h);
                // Above the VRAM budget: render smaller, then enlarge to the exact size.
                let area = cap_for_refs(src.area(), 0.0, &mut notes);
                working = plan_working_canvas(src, &CanvasLimits { min_side: 64, ..limits(area, rec) });
                output = src;
            } else {
                let (aspect, _label) = req
                    .aspect_ratio
                    .as_deref()
                    .and_then(parse_aspect)
                    .or_else(|| match aspect_hint(&req.prompt) {
                        Some(AspectHint::Ratio(r, l)) => Some((r, l)),
                        _ => None,
                    })
                    .unwrap_or((1.0, "1:1".into()));
                let wanted = tier_area.unwrap_or(rec.area_balanced);
                let area = cap_for_refs(wanted, 0.0, &mut notes);
                let size = size_for_aspect(aspect, area, rec);
                working = plan_working_canvas(size, &limits(size.area(), rec));
                output = size;
            }
        }
        ResolvedMode::Edit | ResolvedMode::MultiReference => {
            let first = inputs.image_sizes[0];
            // Output shape: the chosen aspect ratio, else image 1's.
            let chosen_aspect = req.aspect_ratio.as_deref().and_then(parse_aspect).map(|(a, _)| a);
            let aspect = chosen_aspect.unwrap_or(first.width as f64 / first.height as f64);
            let tier = matches!(req.resolution, ResolutionMode::K1 | ResolutionMode::K15 | ResolutionMode::K2);
            let target = match (req.width, req.height) {
                (Some(w), Some(h)) => {
                    if !(64..=rec.max_side).contains(&w) || !(64..=rec.max_side).contains(&h) {
                        return Err(AppError::invalid(format!("Width and height must be between 64 and {}.", rec.max_side)));
                    }
                    Size::new(w, h)
                }
                // An explicit 1K/1.5K/2K sets the output size whatever the sources' sizes, so a
                // small photo can be edited into a larger image.
                _ if tier => size_for_aspect(aspect, tier_area.unwrap(), rec),
                _ => match chosen_aspect {
                    Some(a) => dims_for_area(a, first.area() as f64, 1, 64, 16384),
                    None => first,
                },
            };
            // Auto renders at most the quality tier (enlarging larger outputs afterwards);
            // explicit sizes ask for the whole output.
            let wanted = match req.resolution {
                ResolutionMode::Auto => tier_area.unwrap().min(target.area().max(256 * 256)),
                _ => target.area(),
            };
            // Target and references share the token budget; a reference never takes more
            // than the target's area (see `ref_canvas`), so small references leave room.
            let area = cap_for_sources(wanted, &inputs.image_sizes, &mut notes);
            sources_reduced = area < wanted;
            let full = plan_working_canvas(target, &limits(area, rec));
            working = full;
            // Within 10 % of the cap (1 MP outputs, after alignment) the source keeps the
            // output's own canvas, as with Full.
            let ref_area = if working.canvas.area() <= ref_cap.saturating_add(ref_cap / 10) { working.canvas.area() } else { ref_cap };
            for (i, s) in inputs.image_sizes.iter().enumerate() {
                let c = if i == 0 && *s == target && ref_area == working.canvas.area() { working } else { ref_canvas(*s, ref_area, rec) };
                references.push(RefPlan { index: i, source: *s, canvas: c });
            }
            output = if req.preserve_dimensions || tier || chosen_aspect.is_some() { target } else { full.content };
            strength = adv.strength.map(|s| s.clamp(0.0, 1.0));
        }
        ResolvedMode::Upscale => {
            let src = inputs.image_sizes[0];
            let spec = req.upscale.unwrap_or_default();
            output = upscale_target(src, &spec)?;
            upscale = Some(UpscalePlan { method: spec.method, source: src });
            // No diffusion: the upscaler model works on the source itself.
            working = WorkingCanvas { source: src, content: src, canvas: src, content_offset: (0, 0), scale: 1.0 };
            steps = 0;
        }
        ResolvedMode::Inpaint => {
            let src = inputs.image_sizes[0];
            let (mask_size, bbox, _) = inputs.mask.ok_or_else(|| AppError::invalid("Paint the area to change first."))?;
            if mask_size != src {
                notes.push("The mask was resized to match the image.".into());
            }
            let bbox = bbox.ok_or_else(|| AppError::invalid("The mask is empty. Paint the area to change."))?;
            let sx = src.width as f64 / mask_size.width as f64;
            let sy = src.height as f64 / mask_size.height as f64;
            let bbox = Rect::new(
                (bbox.x as f64 * sx) as u32,
                (bbox.y as f64 * sy) as u32,
                ((bbox.width as f64 * sx).ceil() as u32).max(1),
                ((bbox.height as f64 * sy).ceil() as u32).max(1),
            );
            // References: the region itself (at most the reference cap, as in edits), plus a
            // smaller copy with the area marked. Full: both at the output's area (the server's
            // own resize), as before 0.9.4.
            let wanted = tier_area.unwrap_or(src.area());
            let image1_share = if wanted > ref_cap.saturating_add(ref_cap / 10) { ref_cap as f64 / wanted as f64 } else { 1.0 };
            let area = cap_for_refs(wanted, image1_share + INPAINT_GUIDE_AREA, &mut notes);
            // At least the working size of context around the mask, so the model sees the scene.
            let min_ctx = (area as f64).sqrt() as u32;
            let region = geometry::inpaint_region(src, bbox, min_ctx, 0.55);
            let paint_area = area.min(((region.area() as f64 * INPAINT_MAX_ENLARGE) as u64).max(INPAINT_MIN_AREA));
            let l = CanvasLimits { upscale_to_area: Some(paint_area), max_upscale: 4.0, ..limits(paint_area, rec) };
            working = plan_working_canvas(region.size(), &l);
            if region.size() != src {
                notes.push(format!("Focused on a {}×{} area around the mask.", region.width, region.height));
            }
            inpaint_region = Some(region);
            output = src;
            // The image being painted stays at the working size; only the model's view of it shrinks.
            let image1 = if working.canvas.area() <= ref_cap.saturating_add(ref_cap / 10) { working } else { ref_canvas(region.size(), ref_cap, rec) };
            references.push(RefPlan { index: 0, source: region.size(), canvas: image1 });
            let guide_area = (working.canvas.area() as f64 * INPAINT_GUIDE_AREA) as u64;
            references.push(RefPlan { index: 0, source: region.size(), canvas: ref_canvas(region.size(), guide_area, rec) });
            strength = Some(adv.strength.unwrap_or(1.0).clamp(0.05, 1.0));
        }
        ResolvedMode::Outpaint => {
            let src = inputs.image_sizes[0];
            let exp = match req.outpaint {
                Some(o) if o.left > 0.0 || o.right > 0.0 || o.top > 0.0 || o.bottom > 0.0 => {
                    expansion_to_pixels(src, o.left, o.right, o.top, o.bottom, o.units)
                }
                _ => outpaint_intent(&req.prompt, src).ok_or_else(|| AppError::invalid("Choose how far to expand the image."))?,
            };
            let final_area = Size::new(src.width + exp.left + exp.right, src.height + exp.top + exp.bottom).area();
            let wanted = match req.resolution {
                ResolutionMode::Source | ResolutionMode::Custom => final_area,
                _ => tier_area.unwrap().min(final_area.max(256 * 256)),
            };
            let area = cap_for_refs(wanted, 1.0, &mut notes);
            let p = plan_outpaint(src, exp, &limits(area, rec), 32).map_err(AppError::invalid)?;
            working = p.working;
            output = p.final_size;
            references.push(RefPlan { index: 0, source: src, canvas: ref_canvas(src, p.working.canvas.area(), rec) });
            outpaint = Some(p);
            strength = Some(adv.strength.unwrap_or(1.0).clamp(0.05, 1.0));
        }
    }

    optimized |= sources_reduced;
    let quick_upscale = upscale.is_some();
    if !quick_upscale && !working.canvas.is_aligned(rec.align) {
        return Err(AppError::new(ErrorCode::Internal, "Working size is not aligned.").detail(format!("{:?}", working.canvas)));
    }
    let max_ref_area = references.iter().map(|r| r.canvas.canvas.area()).max().unwrap_or(0);
    let total_area = working.canvas.area();
    // Untiled decodes while `resident + area * bytes/pixel` fits in this GPU's share of
    // memory (`max_untiled_vae_area`): a 16 GB card still tiles 1.5K and 2K (untiled 2K
    // needs ~18 GB), a 32 GB card decodes everything the planner can budget. Encoding the
    // references and decoding the result are sequential phases, so each is judged against
    // the budget on its own rather than added together.
    let untiled_area = max_untiled_vae_area(inputs.vram_total_mib);
    let auto_tiling = total_area > untiled_area || max_ref_area > untiled_area;
    // The server's `--vae-tiling` is no longer a reason to tile: a decode within the
    // budget is sent with tiling turned off (only an explicit choice overrides).
    let vae_tiling = adv.vae_tiling.unwrap_or(auto_tiling);
    if vae_tiling && adv.vae_tiling.is_none() && !inputs.server_vae_tiling && !quick_upscale {
        optimized = true;
        notes.push("Memory optimization enabled for this size.".into());
    }
    // Large discrete GPUs: decode tiles shaped to the image (fewer, larger tiles); others keep
    // the server's square tiles.
    let large_gpu = !inputs.unified_memory && inputs.vram_total_mib.map(|m| m as f64 / 1024.0 >= 15.0).unwrap_or(false);
    let vae_tile = (vae_tiling && large_gpu && !quick_upscale && total_area > untiled_area)
        .then(|| vae_decode_tile(working.canvas, untiled_area));
    if (working.content.area() as f64) < output.area() as f64 * 0.98 && matches!(mode, ResolvedMode::Generate | ResolvedMode::Edit | ResolvedMode::MultiReference) {
        notes.push(format!(
            "Rendered at {}×{}, then enlarged to {}×{} with {}.",
            working.content.width,
            working.content.height,
            output.width,
            output.height,
            inputs.upscaler.as_deref().unwrap_or("Lanczos")
        ));
    }
    // Results are enlarged with ESRGAN when the model exists (Lanczos otherwise).
    let enlarge = output.area() as f64 > working.content.area() as f64 * 1.21;
    let mut estimated_seconds =
        if quick_upscale { 2.0 } else { estimate_seconds(working.canvas, &references, steps, batch_count, inputs.sage_attention, cfg) };
    if inputs.upscaler.is_some() && (enlarge || quick_upscale) {
        let mosr = inputs.upscaler.as_deref().is_some_and(is_mosr);
        estimated_seconds += esrgan_seconds(working.content.area(), inputs.upscale_tile, inputs.metal, mosr) * batch_count as f32;
    }
    estimated_seconds = match inputs.speed_factor {
        Some(f) => estimated_seconds * f,
        None if inputs.hide_uncalibrated => 0.0,
        None => estimated_seconds,
    };
    let negative_prompt = req.negative_prompt.clone().unwrap_or_default();
    if !negative_prompt.trim().is_empty() && !quick_upscale {
        notes.push("The negative prompt is ignored: Turbo runs without CFG.".into());
    }
    Ok(Plan {
        mode,
        auto_mode,
        mode_reason,
        aspect_label: aspect_label(output),
        output,
        working: working.canvas,
        content: working.content_rect(),
        steps,
        cfg,
        sampler: adv.sampler.clone().filter(|s| !s.is_empty()).unwrap_or_else(|| rec.sampler.clone()),
        strength,
        batch_count,
        vae_tiling,
        output_format: adv.output_format.unwrap_or_default(),
        negative_prompt,
        references,
        outpaint,
        inpaint_region,
        inpaint_action,
        quality,
        resolution: req.resolution,
        notes,
        optimized_for_vram: optimized,
        estimated_seconds,
        upscaler: inputs.upscaler.clone(),
        upscale_tile: if inputs.upscale_tile > 0 { inputs.upscale_tile } else { LARGE_UPSCALE_TILE },
        upscale,
        custom_sigmas: if quick_upscale { Vec::new() } else { TURBO_SIGMAS.to_vec() },
        vae_tile,
        reference_detail: matches!(mode, ResolvedMode::Edit | ResolvedMode::MultiReference | ResolvedMode::Inpaint).then(|| adv.reference_detail.unwrap_or_default()),
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn estimates_follow_the_measured_speed() {
        let r = GenerationRequest { prompt: "a lighthouse at dusk".into(), ..Default::default() };
        let base = PlanInputs { vram_total_mib: Some(16303), ..Default::default() };
        let raw = plan(&r, &base, &RecommendedSettings::default()).unwrap().estimated_seconds;
        assert!(raw > 0.0);
        let slow = PlanInputs { speed_factor: Some(13.0), ..base.clone() };
        let s = plan(&r, &slow, &RecommendedSettings::default()).unwrap();
        assert!((s.estimated_seconds / raw - 13.0).abs() < 0.01);
        assert!((backend_seconds(&s, false) - raw).abs() < 0.5, "the calibration compares against the uncalibrated backend time");
        let unknown = PlanInputs { hide_uncalibrated: true, ..base.clone() };
        assert_eq!(plan(&r, &unknown, &RecommendedSettings::default()).unwrap().estimated_seconds, 0.0, "unknown until measured");
        let known = PlanInputs { hide_uncalibrated: true, speed_factor: Some(2.0), ..base };
        assert!(plan(&r, &known, &RecommendedSettings::default()).unwrap().estimated_seconds > 0.0);
    }

    #[test]
    fn unified_memory_maps_to_presets() {
        use crate::catalog::{TEXT_ENCODER_Q4_K_M, VISION_PROJECTOR, recommended_preset};
        let te = (TEXT_ENCODER_Q4_K_M.size + VISION_PROJECTOR.size) / (1024 * 1024);
        let mac = |gb: u64| unified_memory_planning_mib(gb * 1024, te);
        assert!(mac(16) < 6 * 1024, "16 GB: only the smallest working sizes");
        assert_eq!(token_budget(Some(mac(16))), 4_096);
        assert_eq!(recommended_preset(Some(mac(24)), true).id, "12gb");
        assert_eq!(recommended_preset(Some(mac(32)), true).id, "16gb");
        assert_eq!(recommended_preset(Some(mac(48)), true).id, "24gb");
        assert_eq!(recommended_preset(Some(mac(64)), true).id, "32gb");
        assert_eq!(unified_memory_planning_mib(4096, te), 0, "never underflows");
        // The Mac names of the presets match what each memory size gets.
        for (gb, id) in [(16, "12gb"), (24, "12gb"), (32, "16gb"), (36, "16gb"), (48, "24gb"), (64, "32gb"), (128, "32gb")] {
            let p = recommended_preset(Some(mac(gb)), true);
            assert_eq!(p.id, id, "{gb} GB Mac");
            assert!(p.unified_label.contains(&gb.to_string()) || (gb > 64 && p.unified_label.contains('+')), "{gb} GB Mac labelled {}", p.unified_label);
        }
    }

    use super::*;

    fn rec() -> RecommendedSettings {
        RecommendedSettings::default()
    }
    fn req(prompt: &str) -> GenerationRequest {
        GenerationRequest { prompt: prompt.into(), preserve_dimensions: true, quality: Quality::Balanced, ..Default::default() }
    }
    fn inputs(sizes: &[(u32, u32)]) -> PlanInputs {
        PlanInputs { image_sizes: sizes.iter().map(|(w, h)| Size::new(*w, *h)).collect(), mask: None, vram_total_mib: Some(16303), ..Default::default() }
    }

    #[test]
    fn text_to_image_defaults() {
        let p = plan(&req("a lighthouse at dusk"), &inputs(&[]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Generate);
        assert!(p.auto_mode);
        assert_eq!(p.output, Size::new(1536, 1536), "Balanced = 1.5K");
        assert_eq!(p.working, Size::new(1536, 1536));
        assert_eq!((p.steps, p.cfg, p.sampler.as_str()), (8, 1.0, "euler"), "Turbo: 8 steps, no CFG (official)");
        assert!(p.vae_tiling, "1.5K is above a 16 GB card's untiled budget");
        assert!(p.references.is_empty());
    }

    #[test]
    fn every_job_runs_turbos_schedule() {
        assert_eq!(GenerationRequest::default().quality, Quality::Fast, "the default");
        for q in [Quality::Fast, Quality::Balanced, Quality::Quality] {
            for sizes in [&[][..], &[(1200, 800)][..], &[(1200, 800), (900, 900)][..]] {
                let mut r = req("a lighthouse at dusk");
                r.quality = q;
                let p = plan(&r, &inputs(sizes), &rec()).unwrap();
                assert_eq!((p.steps, p.cfg), (8, 1.0), "{q:?}: fixed steps, no CFG");
                assert_eq!(p.custom_sigmas, TURBO_SIGMAS.to_vec());
            }
        }
        let r = req("a lighthouse at dusk");
        assert_eq!(plan(&GenerationRequest { quality: Quality::Fast, ..r }, &inputs(&[]), &rec()).unwrap().working, Size::new(1024, 1024), "Fast = ~1 MP");
        // Older clients' quality names still load.
        let q = |s: &str| serde_json::from_str::<Quality>(s).unwrap();
        assert_eq!((q(r#""turbo""#), q(r#""ultra""#), q(r#""quality""#)), (Quality::Fast, Quality::Quality, Quality::Quality));
    }

    #[test]
    fn mac_fast_renders_the_full_size() {
        let mac = |sizes: &[(u32, u32)]| PlanInputs { unified_memory: true, vram_total_mib: Some(4600), upscaler: Some("4xNomos2_hq_mosr".into()), ..inputs(sizes) };
        let mut r = req("a lighthouse at dusk");
        r.quality = Quality::Fast;
        let p = plan(&r, &mac(&[]), &rec()).unwrap();
        assert_eq!((p.output, p.working), (Size::new(1024, 1024), Size::new(1024, 1024)), "no smaller render + upscale");
        assert!(p.upscale.is_none());
        let p = plan(&r, &mac(&[(1024, 768)]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(1024, 768));
        assert!(p.upscale.is_none());
    }

    #[test]
    fn negative_prompt_is_ignored() {
        let mut r = req("a lighthouse at dusk");
        r.negative_prompt = Some("blurry".into());
        let p = plan(&r, &inputs(&[]), &rec()).unwrap();
        assert_eq!(p.negative_prompt, "blurry", "still sent; the server ignores it at CFG 1");
        assert!(p.notes.iter().any(|n| n.contains("negative prompt is ignored")));
        assert!(!plan(&req("a fox"), &inputs(&[]), &rec()).unwrap().notes.iter().any(|n| n.contains("negative prompt")));
    }

    #[test]
    fn prompt_implies_aspect() {
        let p = plan(&req("Generate a hero image for the landing page, 16:9"), &inputs(&[]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(2048, 1152));
        let p = plan(&req("a phone wallpaper of mountains"), &inputs(&[]), &rec()).unwrap();
        assert!(p.output.height > p.output.width);
        let p = plan(&req("a poster, 1280x720"), &inputs(&[]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(1280, 720));
        assert_eq!(p.working, Size::new(1280, 736));
    }

    #[test]
    fn explicit_aspect_and_quality_tiers() {
        let mut r = req("a cat");
        r.aspect_ratio = Some("16:9".into());
        r.resolution = ResolutionMode::K2;
        let p = plan(&r, &inputs(&[]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(2752, 1536), "official 2K bucket");
        assert!(p.vae_tiling, "large decode gets tiling");
        assert!(p.optimized_for_vram);
        r.resolution = ResolutionMode::Auto;
        r.quality = Quality::Fast;
        let p = plan(&r, &inputs(&[]), &rec()).unwrap();
        assert!(p.output.area() <= 1_100_000);
        r.quality = Quality::Balanced;
        let p = plan(&r, &inputs(&[]), &rec()).unwrap();
        assert!(p.output.area() > 1_100_000 && p.output.area() <= 1536 * 1536 * 102 / 100, "Balanced = about 1.5K");
        r.quality = Quality::Quality;
        let p = plan(&r, &inputs(&[]), &rec()).unwrap();
        assert_eq!(p.working, Size::new(2752, 1536), "Quality = official native 2K bucket");
        assert_eq!(p.output, p.working);
    }

    #[test]
    fn single_image_means_edit_and_preserves_dimensions() {
        let p = plan(&req("change the red car to a black Porsche"), &inputs(&[(1920, 1080)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Edit);
        assert_eq!(p.output, Size::new(1920, 1080));
        assert!(p.working.is_aligned(32));
        let a = p.content.width as f64 / p.content.height as f64;
        assert!((a / (1920.0 / 1080.0) - 1.0).abs() < 0.01);
        assert_eq!(p.references.len(), 1);
        // Standard detail (default): the source is given at ~1 MP, same shape.
        let rc = p.references[0].canvas;
        assert!(rc.canvas.area() <= STANDARD_REFERENCE_AREA, "{:?}", rc.canvas);
        assert!((rc.content.width as f64 / rc.content.height as f64 / (1920.0 / 1080.0) - 1.0).abs() < 0.02);
        assert_eq!(p.reference_detail, Some(ReferenceDetail::Standard));
        assert!(p.strength.is_none());
        assert_eq!(p.cfg, 1.0, "official: edits run without CFG too");
    }

    #[test]
    fn near_budget_source_is_not_rescaled() {
        // Regression: a 1376x768 result (0.7% over the 1 MP Balanced budget) was shrunk by 0.4% and padded.
        let p = plan(&req("make it nighttime"), &inputs(&[(1376, 768)]), &rec()).unwrap();
        assert_eq!(p.working, Size::new(1376, 768));
        assert_eq!(p.content, Rect::new(0, 0, 1376, 768));
        assert!(p.notes.is_empty(), "{:?}", p.notes);
    }

    #[test]
    fn source_mode_works_at_full_resolution() {
        let mut r = req("make it night");
        r.resolution = ResolutionMode::Source;
        let p = plan(&r, &inputs(&[(1536, 1024)]), &rec()).unwrap();
        assert_eq!(p.working, Size::new(1536, 1024));
        assert_eq!(p.output, Size::new(1536, 1024));
        let p = plan(&r, &inputs(&[(1920, 1080)]), &rec()).unwrap();
        assert_eq!(p.working, Size::new(1920, 1088));
        assert_eq!(p.content, Rect::new(0, 4, 1920, 1080));
    }

    #[test]
    fn huge_photo_is_reduced_for_vram_and_restored() {
        let mut r = req("make it autumn");
        r.resolution = ResolutionMode::Source;
        let budget = (planning_token_budget(Some(16303), false) * 256) as f64 * 1.05;
        let p = plan(&r, &inputs(&[(4032, 3024)]), &rec()).unwrap();
        assert!(p.optimized_for_vram);
        // Standard detail: a 1 MP reference leaves ~3 MP for the image being drawn.
        assert!(p.references[0].canvas.canvas.area() <= STANDARD_REFERENCE_AREA);
        assert!(p.working.area() > 2_900_000, "{:?}", p.working);
        assert!((p.working.area() + p.references[0].canvas.canvas.area()) as f64 <= budget, "target + reference share the budget");
        assert_eq!(p.output, Size::new(4032, 3024));
        assert!(p.notes.iter().any(|n| n.contains("enlarged to 4032×3024")));
        // Full detail: the reference takes the output's canvas, half the budget each.
        r.advanced.reference_detail = Some(ReferenceDetail::Full);
        let p = plan(&r, &inputs(&[(4032, 3024)]), &rec()).unwrap();
        assert_eq!(p.references[0].canvas.canvas, p.working);
        assert!((p.working.area() * 2) as f64 <= budget);
        assert_eq!(p.reference_detail, Some(ReferenceDetail::Full));
    }

    fn env(upscaler: bool) -> PlanInputs {
        PlanInputs { upscaler: upscaler.then(|| "4xNomos2_hq_mosr".to_string()), sage_attention: true, ..inputs(&[]) }
    }

    #[test]
    fn generation_is_always_one_pass() {
        // Any size: one diffusion pass within the budget.
        for (res, aspect) in [(ResolutionMode::Auto, "16:9"), (ResolutionMode::K15, "1:1"), (ResolutionMode::K2, "9:16")] {
            for q in [Quality::Fast, Quality::Balanced, Quality::Quality] {
                let mut r = req("a cozy mountain cabin");
                r.aspect_ratio = Some(aspect.into());
                r.resolution = res;
                r.quality = q;
                let p = plan(&r, &env(true), &rec()).unwrap();
                assert!(!p.notes.iter().any(|n| n.contains("Two passes")), "{res:?} {aspect} {q:?}");
                assert!(p.working.is_aligned(32));
                assert!(p.working.area() as f64 <= (planning_token_budget(Some(16303), false) * 256) as f64 * 1.02, "{:?}", p.working);
            }
        }
    }

    #[test]
    fn large_text_to_image_renders_within_budget_then_enlarges() {
        // Official 2K bucket fits the budget: rendered natively.
        let mut r = req("a city at night");
        r.aspect_ratio = Some("16:9".into());
        r.resolution = ResolutionMode::K2;
        let p = plan(&r, &env(true), &rec()).unwrap();
        assert_eq!(p.output, Size::new(2752, 1536));
        assert!(p.vae_tiling, "large decode is tiled");

        // A custom 4K: rendered at the budget, delivered at the exact size with the upscaler.
        let mut r = req("a city at night");
        r.resolution = ResolutionMode::Custom;
        r.width = Some(3840);
        r.height = Some(2160);
        let p = plan(&r, &env(true), &rec()).unwrap();
        assert_eq!(p.output, Size::new(3840, 2160), "exact requested size is delivered");
        assert!(p.working.area() as f64 <= (planning_token_budget(Some(16303), false) * 256) as f64 * 1.02, "alignment padding only");
        assert!((p.content.width as f64 / p.content.height as f64 / (3840.0 / 2160.0) - 1.0).abs() < 0.01);
        assert!(p.notes.iter().any(|n| n.contains("enlarged to 3840×2160 with 4xNomos2_hq_mosr")), "{:?}", p.notes);
    }

    #[test]
    fn edits_are_one_pass_and_enlarged_to_the_source() {
        let i = PlanInputs { image_sizes: vec![Size::new(5120, 2880)], ..env(true) };
        let mut r = req("make it a dark version");
        r.quality = Quality::Fast;
        let p = plan(&r, &i, &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Edit);
        assert_eq!(p.working, Size::new(1376, 768));
        assert_eq!(p.references[0].canvas.canvas, p.working);
        assert_eq!(p.output, Size::new(5120, 2880));
        assert_eq!((p.steps, p.cfg), (8, 1.0));
        let esrgan = p.estimated_seconds;
        let p2 = plan(&r, &PlanInputs { upscaler: None, ..i.clone() }, &rec()).unwrap();
        assert!(esrgan > p2.estimated_seconds, "the enlargement is included in the estimate");
        assert!(p2.notes.iter().any(|n| n.ends_with("with Lanczos.")));
    }

    #[test]
    fn quality_edit_shares_the_2k_budget_with_its_reference() {
        let mut r = req("remove the people");
        r.quality = Quality::Quality;
        let i = PlanInputs { image_sizes: vec![Size::new(5712, 4284)], ..env(true) };
        // Standard detail on 16 GB: 1 MP reference and the full native 2K area (~4.2 MP) drawn.
        let p = plan(&r, &i, &rec()).unwrap();
        assert!((4_100_000..=4_300_000).contains(&p.working.area()), "{:?}", p.working);
        assert!(p.references[0].canvas.canvas.area() <= STANDARD_REFERENCE_AREA);
        assert_eq!(p.output, Size::new(5712, 4284));
        r.advanced.reference_detail = Some(ReferenceDetail::Full);
        let p = plan(&r, &i, &rec()).unwrap();
        assert_eq!((p.steps, p.cfg), (8, 1.0));
        // Full: native 2K plus a 2K reference exceeds 16 GB, so both get half the budget (~2.65 MP each).
        // Each side rounds to 32 px, so allow the same 5 % slack as many_references_share_the_budget.
        assert!((2_450_000..=2_800_000).contains(&p.working.area()), "{:?}", p.working);
        assert_eq!(p.references[0].canvas.canvas, p.working, "the model sees the source at the canvas size");
        assert!(p.notes.iter().any(|n| n.contains("Resolution reduced")));
        assert!((p.working.area() + p.references[0].canvas.canvas.area()) as f64 <= (planning_token_budget(Some(16303), false) * PIXELS_PER_TOKEN) as f64 * 1.05);
        assert_eq!(p.output, Size::new(5712, 4284));
    }

    #[test]
    fn tiers_set_the_output_size_of_edits_and_combines() {
        // Regression: 1K/1.5K/2K were capped by the smallest source, so 800x800 refs always gave 800x800.
        let budget = (planning_token_budget(Some(16303), false) * PIXELS_PER_TOKEN) as f64 * 1.05;
        let mut r = req("put both people in a kitchen");
        r.resolution = ResolutionMode::K15;
        let p = plan(&r, &inputs(&[(800, 800), (800, 800)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::MultiReference);
        assert_eq!(p.output, Size::new(1536, 1536));
        assert!(p.working.area() > 1_500_000, "small references leave room for the target: {:?}", p.working);
        assert!((p.working.area() + p.references.iter().map(|r| r.canvas.canvas.area()).sum::<u64>()) as f64 <= budget);
        r.resolution = ResolutionMode::K2;
        r.aspect_ratio = Some("16:9".into());
        let p = plan(&r, &inputs(&[(800, 800), (600, 900)]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(2752, 1536), "official 2K bucket");
        assert!((p.working.area() + p.references.iter().map(|r| r.canvas.canvas.area()).sum::<u64>()) as f64 <= budget);
        let a = p.content.width as f64 / p.content.height as f64;
        assert!((a / (16.0 / 9.0) - 1.0).abs() < 0.02);
        // A single small photo edited at 1K.
        let mut r = req("make it a watercolor");
        r.resolution = ResolutionMode::K1;
        let p = plan(&r, &inputs(&[(640, 480)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Edit);
        assert!((1_000_000..=1_100_000).contains(&p.output.area()), "{:?}", p.output);
        assert!((p.output.width as f64 / p.output.height as f64 / (4.0 / 3.0) - 1.0).abs() < 0.02);
    }

    #[test]
    fn edit_aspect_and_custom_size() {
        let mut r = req("turn it into a wide cinematic shot");
        r.aspect_ratio = Some("16:9".into());
        let p = plan(&r, &inputs(&[(1024, 1024)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Edit);
        assert!(p.output.width > p.output.height);
        assert!((p.output.area() as f64 / (1024.0 * 1024.0) - 1.0).abs() < 0.05, "Auto keeps the source's pixel count");
        let mut r = req("same scene, poster");
        r.resolution = ResolutionMode::Custom;
        (r.width, r.height) = (Some(1200), Some(1800));
        let p = plan(&r, &inputs(&[(800, 800)]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(1200, 1800));
        r.width = Some(9000);
        assert!(plan(&r, &inputs(&[(800, 800)]), &rec()).is_err());
    }

    #[test]
    fn many_references_share_the_budget() {
        let mut r = req("combine");
        r.resolution = ResolutionMode::Source;
        let i = PlanInputs { image_sizes: vec![Size::new(3000, 2000), Size::new(2000, 2000), Size::new(2000, 2000)], ..env(true) };
        let p = plan(&r, &i, &rec()).unwrap();
        assert!(p.optimized_for_vram);
        let total: u64 = p.working.area() + p.references.iter().map(|r| r.canvas.canvas.area()).sum::<u64>();
        assert!(total as f64 <= (planning_token_budget(Some(16303), false) * 256) as f64 * 1.05, "{total}");
    }

    #[test]
    fn upscale_targets() {
        let src = Size::new(1376, 768);
        let t = |spec: UpscaleSpec| upscale_target(src, &spec);
        assert_eq!(t(UpscaleSpec::default()).unwrap(), Size::new(2752, 1536), "default 2x");
        assert_eq!(t(UpscaleSpec { scale: Some(4.0), ..Default::default() }).unwrap(), Size::new(5504, 3072));
        assert_eq!(t(UpscaleSpec { width: Some(3840), ..Default::default() }).unwrap(), Size::new(3840, 2143));
        assert_eq!(t(UpscaleSpec { height: Some(2880), ..Default::default() }).unwrap(), Size::new(5160, 2880));
        assert_eq!(t(UpscaleSpec { width: Some(5120), height: Some(2880), ..Default::default() }).unwrap(), Size::new(5120, 2880));
        assert!(t(UpscaleSpec { scale: Some(8.0), ..Default::default() }).is_err(), "over 8192 px");
        assert!(t(UpscaleSpec { width: Some(8000), height: Some(8000), ..Default::default() }).is_err(), "over 40 MP");
        assert!(t(UpscaleSpec { scale: Some(-1.0), ..Default::default() }).is_err());
    }

    #[test]
    fn upscaler_tile_follows_memory() {
        let m = "4xNomos2_hq_mosr";
        assert_eq!(upscale_tile(0, Some(16_303), m), 768, "16 GB card");
        assert_eq!(upscale_tile(0, Some(12_282), m), 256, "12 GB card");
        assert_eq!(upscale_tile(0, Some(8_192), m), 256);
        assert_eq!(upscale_tile(0, None, m), 768, "unknown GPU: the default preset's");
        assert_eq!(upscale_tile(0, Some(LARGE_UPSCALE_TILE_MIB), m), 768);
        assert_eq!(upscale_tile(512, Some(8_192), m), 512, "the setting wins");
        assert_eq!(upscale_tile(0, Some(16_303), "4x_NMKD-Superscale-SP_178000_G"), 128, "ESRGAN");
        // Planned with the job, so the engine and the estimate agree.
        let p = plan(&req("a lighthouse"), &PlanInputs { upscale_tile: 256, ..env(true) }, &rec()).unwrap();
        assert_eq!(p.upscale_tile, 256);
    }

    #[test]
    fn upscaler_estimates() {
        let mp = 1472 * 1472;
        // Measured 2026-10-12 (1472² edit): 3.1 s CUDA tile 768, ~5 s tile 256, 54.6 s M2 Pro.
        assert!((esrgan_seconds(mp, 768, false, true) - 3.1).abs() < 0.6);
        assert!((esrgan_seconds(mp, 256, false, true) - 5.0).abs() < 0.6);
        assert!((esrgan_seconds(mp, 768, true, true) - 54.6).abs() < 3.0);
        assert!(esrgan_seconds(mp, 256, true, true) > esrgan_seconds(mp, 768, true, true));
        assert!((esrgan_seconds(mp, 128, false, false) - 13.2).abs() < 1.0, "Superscale-SP");
        let r = GenerationRequest { mode: Mode::Upscale, upscale: Some(UpscaleSpec { scale: Some(2.0), ..Default::default() }), ..Default::default() };
        let i = PlanInputs { image_sizes: vec![Size::new(1472, 1472)], upscale_tile: 768, upscaler: Some("4xNomos2_hq_mosr".into()), ..env(true) };
        let (pc, mac) = (plan(&r, &i, &rec()).unwrap(), plan(&r, &PlanInputs { metal: true, ..i.clone() }, &rec()).unwrap());
        assert!(mac.estimated_seconds > pc.estimated_seconds * 5.0, "{} vs {}", mac.estimated_seconds, pc.estimated_seconds);
    }

    #[test]
    fn upscale_plans() {
        let mut r = GenerationRequest { mode: Mode::Upscale, upscale: Some(UpscaleSpec { scale: Some(2.0), ..Default::default() }), ..Default::default() };
        let i = PlanInputs { image_sizes: vec![Size::new(1376, 768)], ..env(true) };
        let p = plan(&r, &i, &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Upscale);
        assert_eq!(p.output, Size::new(2752, 1536));
        assert_eq!(p.steps, 0, "Quick runs no diffusion");
        assert_eq!(p.working, Size::new(1376, 768));
        assert!(p.custom_sigmas.is_empty() && p.references.is_empty());
        assert!(p.estimated_seconds < 20.0, "{}", p.estimated_seconds);

        r.mode = Mode::Upscale;
        assert!(plan(&r, &env(true), &rec()).is_err(), "needs an image");
    }

    #[test]
    fn server_vae_tiling_is_reflected_in_the_plan() {
        let i = PlanInputs { server_vae_tiling: true, ..inputs(&[]) };
        let p = plan(&req("a fox"), &i, &rec()).unwrap();
        assert!(p.vae_tiling, "Balanced 1.5K is above a 16 GB card's untiled budget");
        assert!(!p.notes.iter().any(|n| n.contains("Memory optimization")), "nothing to announce");
        let mut r = req("a fox");
        r.advanced.vae_tiling = Some(false);
        assert!(!plan(&r, &i, &rec()).unwrap().vae_tiling, "explicit off wins");
        // The server's --vae-tiling is only a fallback: a decode within the budget runs
        // untiled (the request then turns tiling off, see pipeline::vae_tiling_params).
        let mut r = req("a fox");
        r.quality = Quality::Fast;
        assert!(!plan(&r, &i, &rec()).unwrap().vae_tiling, "1 MP fits: untiled even though the server tiles");
    }

    #[test]
    fn vae_tiling_follows_the_gpus_memory() {
        let at = |vram: Option<u64>, quality: Quality| {
            let mut r = req("a lighthouse at dusk");
            r.quality = quality;
            let i = PlanInputs { vram_total_mib: vram, ..inputs(&[]) };
            plan(&r, &i, &rec()).unwrap().vae_tiling
        };
        // 32 GB (RTX 5090): every tier the planner can budget decodes untiled, 2K included.
        assert!(!at(Some(32_607), Quality::Fast), "32 GB: 1 MP");
        assert!(!at(Some(32_607), Quality::Balanced), "32 GB: 1.5K");
        assert!(!at(Some(32_607), Quality::Quality), "32 GB: 2K");
        // 16 GB (RTX 5070 Ti): 1 MP untiled, 1.5K and 2K stay tiled (untiled 2K ~18 GB).
        assert!(!at(Some(16_303), Quality::Fast), "16 GB: 1 MP leaves margin");
        assert!(at(Some(16_303), Quality::Balanced), "16 GB: 1.5K");
        assert!(at(Some(16_303), Quality::Quality), "16 GB: 2K");
        // 12 GB cards keep today's behavior: even 1 MP tiles (their planning budget is
        // too tight for the model's estimate to be trusted).
        assert!(at(Some(12_282), Quality::Fast), "12 GB: 1 MP");
        assert!(at(None, Quality::Balanced), "unknown GPU: the conservative threshold");
    }

    #[test]
    fn untiled_decode_budget_scales_with_vram() {
        assert_eq!(max_untiled_vae_area(None), LARGE_GPU_VAE_TILE_AREA, "unknown GPU");
        // Between the two documented anchors: 16 GB gets past 1 MP (margin on the "~1.5 MP
        // fills the card" point), 32 GB gets more than the largest planned size (2K = 4.2 MP).
        let m16 = max_untiled_vae_area(Some(16_303));
        assert!((1_048_576..2_300_000).contains(&m16), "{m16}");
        assert!(max_untiled_vae_area(Some(32_607)) > 2048 * 2048);
        assert_eq!(max_untiled_vae_area(Some(4_608)), 0, "a 16 GB Mac's planning budget: nothing untiled");
    }

    #[test]
    fn multi_reference_keeps_order_and_budget() {
        let p = plan(
            &req("Use the person from image 1, the clothing from image 2, and the lighting style from image 3."),
            &inputs(&[(1080, 1920), (1024, 1024), (4032, 3024)]),
            &rec(),
        )
        .unwrap();
        assert_eq!(p.mode, ResolvedMode::MultiReference);
        let idx: Vec<usize> = p.references.iter().map(|r| r.index).collect();
        assert_eq!(idx, vec![0, 1, 2]);
        assert_eq!(p.references[0].source, Size::new(1080, 1920));
        assert_eq!(p.references[2].source, Size::new(4032, 3024));
        assert!(p.output.height > p.output.width, "image 1 defines the output shape");
        for r in &p.references {
            assert!(r.canvas.canvas.is_aligned(32));
            assert!(r.canvas.canvas.area() <= p.working.area());
        }
    }

    #[test]
    fn too_many_references() {
        let sizes: Vec<(u32, u32)> = (0..11).map(|_| (512, 512)).collect();
        assert!(plan(&req("x"), &inputs(&sizes), &rec()).is_err());
    }

    #[test]
    fn empty_prompt_rejected() {
        assert_eq!(plan(&req("  "), &inputs(&[]), &rec()).unwrap_err().code, ErrorCode::InvalidInput);
    }

    #[test]
    fn mode_override() {
        let mut r = req("a new scene");
        r.mode = Mode::Generate;
        let p = plan(&r, &inputs(&[(800, 600)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Generate);
        assert!(!p.auto_mode);
        r.mode = Mode::Inpaint;
        assert!(plan(&r, &inputs(&[(800, 600)]), &rec()).is_err(), "inpaint needs a mask");
        r.mode = Mode::Edit;
        assert!(plan(&r, &inputs(&[]), &rec()).is_err());
    }

    #[test]
    fn inpaint_plan_crops_around_mask() {
        let mut r = req("remove the sign");
        r.mask = Some("input:m".into());
        let mut i = inputs(&[(4032, 3024)]);
        i.mask = Some((Size::new(4032, 3024), Some(Rect::new(2000, 1500, 120, 90)), 0.001));
        let p = plan(&r, &i, &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Inpaint);
        let reg = p.inpaint_region.unwrap();
        assert!(reg.x <= 2000 && reg.right() >= 2120);
        assert!(reg.width < 4032);
        assert_eq!(p.output, Size::new(4032, 3024));
        assert_eq!(p.strength, Some(1.0));
        assert!(p.working.is_aligned(32));
    }

    #[test]
    fn small_images_are_not_inpainted_at_the_full_tier() {
        let painted = |w: u32, h: u32| {
            let mut r = req("a red hat");
            r.mask = Some("input:m".into());
            r.quality = Quality::Quality;
            let mut i = inputs(&[(w, h)]);
            i.vram_total_mib = Some(32607);
            i.mask = Some((Size::new(w, h), Some(Rect::new(w / 4, 0, w / 2, h / 3)), 0.1));
            let p = plan(&r, &i, &rec()).unwrap();
            assert_eq!(p.output, Size::new(w, h));
            p.working.area()
        };
        let a = painted(1024, 1024);
        assert!(a <= 1_650_000 && a >= 1_400_000, "1 MP photo painted at ~1.5 MP, not the 2K tier: {a}");
        let a = painted(600, 400);
        assert!((1_000_000..=1_150_000).contains(&a), "small photos get the model's ~1 MP: {a}");
        assert!(painted(4000, 3000) > 3_000_000, "large photos keep the tier");
    }

    #[test]
    fn inpaint_with_empty_mask_falls_back_to_edit_in_auto() {
        let mut r = req("make it sunny");
        r.mask = Some("input:m".into());
        let mut i = inputs(&[(1024, 768)]);
        i.mask = Some((Size::new(1024, 768), None, 0.0));
        assert_eq!(plan(&r, &i, &rec()).unwrap().mode, ResolvedMode::Edit);
    }

    #[test]
    fn outpaint_from_numbers_and_from_words() {
        let mut r = req("continue the beach");
        r.outpaint = Some(OutpaintSpec { left: 256.0, right: 256.0, top: 0.0, bottom: 0.0, units: ExpansionUnits::Pixels });
        let p = plan(&r, &inputs(&[(1024, 1024)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Outpaint);
        assert_eq!(p.output, Size::new(1536, 1024));
        let op = p.outpaint.unwrap();
        assert_eq!(op.source_rect_final, Rect::new(256, 0, 1024, 1024));

        let p = plan(&req("extend the image to the left by 50%"), &inputs(&[(1000, 800)]), &rec()).unwrap();
        assert_eq!(p.mode, ResolvedMode::Outpaint);
        assert_eq!(p.output, Size::new(1500, 800));

        let p = plan(&req("expand it to 16:9 landscape"), &inputs(&[(1024, 1024)]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(1820, 1024));

        let mut r = req("more sky");
        r.outpaint = Some(OutpaintSpec { top: 25.0, units: ExpansionUnits::Percent, ..Default::default() });
        let p = plan(&r, &inputs(&[(1920, 1080)]), &rec()).unwrap();
        assert_eq!(p.output, Size::new(1920, 1350));
    }

    #[test]
    fn outpaint_intent_parsing() {
        let s = Size::new(1000, 1000);
        assert_eq!(outpaint_intent("change the car color", s), None);
        assert_eq!(outpaint_intent("extend right", s), Some(Expansion { right: 250, ..Default::default() }));
        assert_eq!(outpaint_intent("expand upwards by 400 px", s), Some(Expansion { top: 400, ..Default::default() }));
        assert_eq!(outpaint_intent("zoom out", s), Some(Expansion { left: 250, right: 250, top: 250, bottom: 250 }));
        assert_eq!(outpaint_intent("make it wider", s), Some(Expansion { left: 250, right: 250, ..Default::default() }));
    }

    #[test]
    fn aspect_hints() {
        assert_eq!(aspect_hint("a 16:9 banner"), Some(AspectHint::Ratio(16.0 / 9.0, "16:9".into())));
        assert_eq!(aspect_hint("logo for a cafe"), Some(AspectHint::Ratio(1.0, "1:1".into())));
        assert_eq!(aspect_hint("a street at 10:30 in the morning"), None);
        assert_eq!(aspect_hint("a cat"), None);
        assert_eq!(parse_aspect("4:3").unwrap().0, 4.0 / 3.0);
        assert!(parse_aspect("auto").is_none());
        assert!(parse_aspect("100:1").is_none());
    }

    #[test]
    fn budget_scales_with_vram() {
        assert_eq!(token_budget(Some(16303)), 16_384);
        assert!(token_budget(Some(8192)) < token_budget(Some(16303)));
        assert!(token_budget(Some(24576)) > token_budget(Some(16303)));
        assert_eq!(token_budget(None), 12_288);
        // Discrete 16 GB cards: native 2K plus a 1 MP reference; Macs and 12 GB cards unchanged.
        assert_eq!(planning_token_budget(Some(16303), false), 20_736);
        assert!(planning_token_budget(Some(16303), false) * PIXELS_PER_TOKEN >= 2752 * 1536 + 1344 * 768);
        assert_eq!(planning_token_budget(Some(16303), true), 16_384);
        assert_eq!(planning_token_budget(Some(12282), false), token_budget(Some(12282)));
        assert_eq!(planning_token_budget(None, false), 12_288);
    }

    #[test]
    fn vae_tiles_follow_sdcpp_and_fit_the_image() {
        // sd.cpp's own split of 2752×1536 (172×96 latents) with 768 px (48) tiles: 4×3.
        assert_eq!((vae_axis_tiles(172, 48, 0.125), vae_axis_tiles(96, 48, 0.125)), (4, 3));
        assert_eq!(vae_axis_tiles(96, 96, 0.125), 1);
        let (w, h) = vae_decode_tile(Size::new(2752, 1536), LARGE_GPU_VAE_TILE_AREA);
        assert!((w * h) as u64 <= LARGE_GPU_VAE_TILE_AREA, "{w}x{h}");
        let decoded = |w: u32, h: u32| vae_axis_tiles(172, w / 16, 0.125) * vae_axis_tiles(96, h / 16, 0.125) * (w / 16) * (h / 16);
        assert!(decoded(w, h) * 10 < decoded(768, 768) * 8, "at least 20 % less decoding than 768² tiles: {w}x{h}");
        assert_eq!((w % 16, h % 16), (0, 0));
        assert_eq!((w, h), (608, 1536), "5 full-height columns");
        assert!(w.min(h) >= 512, "no thin strips");
        // Every size gets a tile within the area.
        for s in [Size::new(2048, 2048), Size::new(2368, 1792), Size::new(1536, 2752), Size::new(1376, 768)] {
            let (w, h) = vae_decode_tile(s, LARGE_GPU_VAE_TILE_AREA);
            assert!((w * h) as u64 <= LARGE_GPU_VAE_TILE_AREA && w <= s.width && h <= s.height, "{s:?}: {w}x{h}");
        }
    }

    #[test]
    fn shaped_vae_tiles_only_on_large_discrete_gpus() {
        let mut r = req("a lighthouse at dusk");
        r.quality = Quality::Quality;
        r.aspect_ratio = Some("16:9".into());
        let big = PlanInputs { vram_total_mib: Some(16303), server_vae_tiling: true, ..inputs(&[]) };
        let p = plan(&r, &big, &rec()).unwrap();
        assert!(p.vae_tile.is_some(), "16 GB card");
        let p = plan(&r, &PlanInputs { vram_total_mib: Some(32_607), ..big.clone() }, &rec()).unwrap();
        assert!(p.vae_tile.is_none(), "32 GB card: 2K decodes untiled, no tiles needed");
        let p = plan(&r, &PlanInputs { unified_memory: true, ..big.clone() }, &rec()).unwrap();
        assert!(p.vae_tile.is_none(), "Mac: the server's tiles");
        let p = plan(&r, &PlanInputs { vram_total_mib: Some(12282), ..big.clone() }, &rec()).unwrap();
        assert!(p.vae_tile.is_none(), "12 GB card: the server's tiles");
        r.advanced.vae_tiling = Some(false);
        assert!(plan(&r, &big, &rec()).unwrap().vae_tile.is_none(), "tiling off");
    }

    #[test]
    fn estimate_matches_benchmarks_roughly() {
        // Benchmarks ran at CFG 6.
        let s = estimate_seconds(Size::new(1024, 1024), &[], 20, 1, false, 6.0);
        assert!((40.0..55.0).contains(&s), "{s}");
        let s = estimate_seconds(Size::new(2048, 2048), &[], 3, 1, false, 6.0);
        assert!((40.0..60.0).contains(&s), "{s}");
        // 2K bench (sd-cli incl. ~3 s load): sage single pass 104 s.
        let s = estimate_seconds(Size::new(2048, 1152), &[], 20, 1, true, 6.0);
        assert!((80.0..105.0).contains(&s), "native {s}");
        // CFG 1 runs one model pass per step: 40 steps cost about what 20 did at CFG 6.
        let one = estimate_seconds(Size::new(1024, 1024), &[], 40, 1, true, 1.0);
        let two = estimate_seconds(Size::new(1024, 1024), &[], 20, 1, true, 6.0);
        assert!((one - two).abs() < 1.0, "{one} vs {two}");
    }

    #[test]
    fn request_json_contract() {
        let r: GenerationRequest = serde_json::from_str(
            r#"{"prompt":"x","mode":"multi_reference","images":["C:\\a.png","input:abc"],"quality":"fast","resolution":"1.5k",
                "outpaint":{"left":10,"units":"percent"},"advanced":{"steps":12,"output_format":"webp"}}"#,
        )
        .unwrap();
        assert_eq!(r.mode, Mode::MultiReference);
        assert_eq!(r.resolution, ResolutionMode::K15);
        assert_eq!(r.quality, Quality::Fast);
        assert!(r.preserve_dimensions);
        assert_eq!(r.outpaint.unwrap().units, ExpansionUnits::Percent);
        assert_eq!(r.advanced.output_format, Some(OutputFormat::Webp));
        assert!(r.upscale.is_none());

        // Older clients: Detailed upscales and their refine effort map to the upscaler model.
        let r: GenerationRequest = serde_json::from_str(
            r#"{"prompt":"","mode":"upscale","images":["gen:abc"],"upscale":{"method":"detailed","width":3840},"advanced":{"refine":"best","cfg":4,"steps":30}}"#,
        )
        .unwrap();
        assert_eq!(r.mode, Mode::Upscale);
        assert_eq!(r.upscale.unwrap().method, UpscaleMethod::Quick);
        assert_eq!(r.upscale.unwrap().width, Some(3840));
    }
}
