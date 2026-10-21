//! Model files the user already has (#14): what a `.gguf` or `.safetensors` file is, read from
//! its header only (a few KB to a few MB, never the weights), and a folder scan that finds the
//! Qwen-Image 2.1 pieces in it (e.g. a ComfyUI `models` folder).
//!
//! The checks mirror how stable-diffusion.cpp recognizes the files (commit af46afa):
//! - diffusion model: Qwen-Image 2.1 has `txt_in.text_norm.weight` (`model_loader.cpp`), older
//!   Qwen-Image models don't;
//! - VAE: the 2.1 VAE has a 64-channel latent (`wan_vae.hpp`, `z_dim = 64`), seen in the shape
//!   of its post-quantization conv (`conv2`, or `post_quant_conv` in diffusers files);
//! - text encoder: Qwen3-VL 8B (QK-norm, hidden size 4096); vision weights (`visual.*`) in the
//!   same file make the separate vision projector unnecessary (`llm.hpp`);
//! - vision projector: Qwen3-VL vision weights projecting to 4096.

use std::collections::HashMap;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::catalog::{Download, Preset, TEXT_ENCODER_Q4_K_M, TEXT_ENCODER_Q8_0, TURBO_Q4_K, VAE, VAE_ORIGINAL, VISION_PROJECTOR};
use crate::config::ModelProfile;
use crate::error::AppError;

/// Hidden size of Qwen3-VL 8B, the text encoder of Qwen-Image 2.1.
const TEXT_HIDDEN: u64 = 4096;
/// Latent channels of the Qwen-Image 2.1 VAE.
const VAE_LATENT: u64 = 64;
/// Smaller files are not image-model weights (configs, LoRAs, embeddings).
pub const SCAN_MIN_BYTES: u64 = 32 << 20;
const SCAN_MAX_DEPTH: usize = 8;
const SCAN_MAX_ENTRIES: usize = 50_000;
const SCAN_MAX_FILES: usize = 2_000;
/// Folders a scan never enters (ComfyUI's own code, environments, outputs).
const SCAN_SKIP: &[&str] = &["custom_nodes", "node_modules", "venv", ".venv", "__pycache__", "output", "input", "temp", ".git", ".cache"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Diffusion,
    Vae,
    TextEncoder,
    VisionProjector,
}

impl Role {
    pub const ALL: [Role; 4] = [Role::Diffusion, Role::Vae, Role::TextEncoder, Role::VisionProjector];

    pub fn label(self) -> &'static str {
        match self {
            Role::Diffusion => "Diffusion model",
            Role::Vae => "VAE",
            Role::TextEncoder => "Text encoder (Qwen3-VL)",
            Role::VisionProjector => "Vision projector (mmproj)",
        }
    }
}

/// What a model file is and whether Kokon can use it for Qwen-Image 2.1.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileInfo {
    pub path: PathBuf,
    pub size: u64,
    /// None: not a model file Kokon recognizes.
    pub role: Option<Role>,
    /// Usable as `role` with Qwen-Image 2.1.
    pub compatible: bool,
    /// A text encoder that carries the vision weights (no separate projector needed).
    pub has_vision: bool,
    /// Main weight type, e.g. "Q4_K", "BF16", "FP8", "INT8".
    pub weights: String,
    /// The file Kokon's setup downloads (same name and size).
    pub official: bool,
    /// Why it can't be used, when it can't.
    pub problem: Option<String>,
}

struct Tensor {
    name: String,
    /// PyTorch order (outermost first); GGUF dimensions are reversed to match.
    shape: Vec<u64>,
    dtype: String,
}

/// The catalog download a file with this name and size is (any folder).
pub fn official_download(path: &Path, size: u64) -> Option<Download> {
    let name = path.file_name()?.to_string_lossy().to_ascii_lowercase();
    [TURBO_Q4_K, VAE, VAE_ORIGINAL, TEXT_ENCODER_Q4_K_M, TEXT_ENCODER_Q8_0, VISION_PROJECTOR]
        .into_iter()
        .find(|d| d.size == size && d.dest.rsplit('/').next().is_some_and(|f| f.eq_ignore_ascii_case(&name)))
}

/// Reads the header of `path` and says what it is. Errors only for files that cannot be read.
pub fn inspect(path: &Path) -> std::io::Result<FileInfo> {
    let meta = std::fs::metadata(path)?;
    if !meta.is_file() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a file"));
    }
    let size = meta.len();
    let mut info = FileInfo { path: path.to_path_buf(), size, role: None, compatible: false, has_vision: false, weights: String::new(), official: false, problem: None };
    let name = path.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let parsed = match ext {
        "gguf" => read_gguf(path),
        "safetensors" => {
            if is_shard(&name) {
                info.problem = Some("This is one part of a model split into several files. Use a single-file version (.safetensors or .gguf).".into());
                return Ok(info);
            }
            read_safetensors(path)
        }
        "ckpt" | "pt" | "pth" | "bin" => {
            info.problem = Some("Kokon only reads .gguf and .safetensors model files (.ckpt, .pt and .bin files can run code when loaded).".into());
            return Ok(info);
        }
        _ => {
            info.problem = Some("Not a model file (.gguf or .safetensors).".into());
            return Ok(info);
        }
    };
    let (tensors, meta) = match parsed {
        Ok(t) => t,
        Err(e) => {
            info.problem = Some(format!("Could not read the file's header ({e}). It may be incomplete or damaged."));
            return Ok(info);
        }
    };
    info.weights = main_weight_type(&tensors);
    classify(&tensors, &meta, &name, &mut info);
    info.official = info.compatible && official_download(path, size).is_some();
    Ok(info)
}

/// Name -> shape (PyTorch order) of every tensor in a diffusion model file (.gguf or
/// .safetensors), without the `model.diffusion_model.` / `diffusion_model.` prefix.
pub fn diffusion_tensor_shapes(path: &Path) -> std::io::Result<HashMap<String, Vec<u64>>> {
    let ext = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let (tensors, _) = if ext == "gguf" { read_gguf(path)? } else { read_safetensors(path)? };
    Ok(tensors
        .into_iter()
        .map(|t| {
            let name = t.name.strip_prefix("model.diffusion_model.").or_else(|| t.name.strip_prefix("diffusion_model.")).unwrap_or(&t.name).to_string();
            (name, t.shape)
        })
        .collect())
}

/// `name-00001-of-00004.safetensors`
fn is_shard(name: &str) -> bool {
    let stem = name.trim_end_matches(".safetensors");
    let parts: Vec<&str> = stem.rsplitn(4, '-').collect();
    parts.len() == 4 && parts[1] == "of" && [parts[0], parts[2]].iter().all(|p| p.len() >= 3 && p.chars().all(|c| c.is_ascii_digit()))
}

fn classify(t: &[Tensor], meta: &HashMap<String, String>, file_name: &str, info: &mut FileInfo) {
    let ends = |s: &str| t.iter().any(|x| x.name.ends_with(s));
    let contains = |s: &str| t.iter().any(|x| x.name.contains(s));
    let find = |s: &str| t.iter().find(|x| x.name.ends_with(s));

    // Diffusion model.
    if ends("txt_in.text_norm.weight") {
        info.role = Some(Role::Diffusion);
        info.compatible = true;
        return;
    }
    if contains("transformer_blocks.") && ends("img_in.weight") {
        info.role = Some(Role::Diffusion);
        info.problem = Some("This is an older Qwen-Image model, not Qwen-Image 2.1. Kokon needs Qwen-Image 2.1 (Turbo).".into());
        return;
    }
    if ["double_blocks.", "single_blocks.", "joint_blocks.", "input_blocks.", "transformer_blocks.", "single_transformer_blocks."].iter().any(|s| contains(s)) {
        info.role = Some(Role::Diffusion);
        info.problem = Some("This image model is not Qwen-Image 2.1.".into());
        return;
    }

    // VAE: its post-quantization conv maps the latent to itself.
    if contains("decoder.") && contains("encoder.") {
        info.role = Some(Role::Vae);
        let post = t.iter().find(|x| {
            let n = x.name.trim_start_matches("first_stage_model.").trim_start_matches("vae.");
            n == "conv2.weight" || n == "post_quant_conv.weight"
        });
        match post.and_then(|x| x.shape.first().copied()) {
            Some(VAE_LATENT) => info.compatible = true,
            Some(z) => info.problem = Some(format!("This VAE belongs to another model (latent size {z}). Kokon needs the Qwen-Image 2.1 VAE.")),
            None => info.problem = Some("Not recognized as the Qwen-Image 2.1 VAE.".into()),
        }
        return;
    }

    let vision = contains("visual.") || t.iter().any(|x| x.name.starts_with("v.blk.") || x.name.starts_with("v.patch_embd"));
    // Text encoder: a language model with layers.
    let layers = t.iter().any(|x| (x.name.contains("layers.") && x.name.contains("self_attn.")) || (x.name.starts_with("blk.") && x.name.contains(".attn_")));
    if layers {
        info.role = Some(Role::TextEncoder);
        info.has_vision = vision;
        let qk_norm = ends("self_attn.q_norm.weight") || ends("attn_q_norm.weight");
        let hidden = find("embed_tokens.weight").or_else(|| find("token_embd.weight")).and_then(|x| x.shape.get(1).copied());
        let hidden = hidden.or_else(|| meta.iter().find(|(k, _)| k.ends_with(".embedding_length")).and_then(|(_, v)| v.parse().ok()));
        // Qwen3 8B (text only: Flux.2 Klein's text encoder, prompt enhancers) has exactly the
        // shapes of Qwen3-VL 8B's language model, so only what the file says about itself tells
        // them apart: the GGUF architecture, the vision weights, HF's `language_model.` names,
        // or "VL" in the file name.
        let arch = meta.get("general.architecture").map(|a| a.to_ascii_lowercase());
        let says_vl = vision || arch.as_deref().is_some_and(|a| a.starts_with("qwen3vl")) || contains("language_model.") || file_name.contains("vl");
        if qk_norm && hidden == Some(TEXT_HIDDEN) {
            match arch.as_deref() {
                Some(a) if !a.starts_with("qwen3vl") => {
                    let what = if a == "qwen3" { "Qwen3 8B, a text-only language model (used by Flux.2 Klein and by prompt enhancers)".to_string() } else { format!("a {a} language model") };
                    info.problem = Some(format!("This is {what}, not the Qwen3-VL 8B text encoder that Qwen-Image 2.1 needs."));
                }
                _ if !says_vl => {
                    info.problem = Some("Kokon can't tell this file from Qwen3 8B, the text-only model used by Flux.2 Klein and by prompt enhancers, which looks the same inside. Qwen-Image 2.1 needs Qwen3-VL 8B: choose a file with \"VL\" in its name, or download the official one.".into());
                }
                _ => info.compatible = true,
            }
        } else if hidden == Some(3584) {
            info.problem = Some("This is the Qwen2.5-VL text encoder of older Qwen-Image models. Qwen-Image 2.1 needs Qwen3-VL 8B.".into());
        } else {
            info.problem = Some("Not the Qwen3-VL 8B text encoder that Qwen-Image 2.1 needs.".into());
        }
        return;
    }

    // Vision projector (mmproj): vision weights only.
    if vision || meta.get("general.architecture").is_some_and(|a| a == "clip") {
        info.role = Some(Role::VisionProjector);
        let out = meta
            .get("clip.vision.projection_dim")
            .and_then(|v| v.parse::<u64>().ok())
            .or_else(|| find("visual.merger.linear_fc2.weight").or_else(|| find("visual.merger.mlp.2.weight")).and_then(|x| x.shape.first().copied()));
        match out {
            Some(TEXT_HIDDEN) | None => info.compatible = true,
            Some(d) => info.problem = Some(format!("These vision weights belong to a different Qwen-VL model (output size {d}). Qwen-Image 2.1 needs the Qwen3-VL 8B ones.")),
        }
        return;
    }
    info.problem = Some("Not a Qwen-Image 2.1 model file.".into());
}

/// The weight type holding most of the parameters (matrices only).
fn main_weight_type(t: &[Tensor]) -> String {
    let mut by: HashMap<&str, u64> = HashMap::new();
    for x in t.iter().filter(|x| x.shape.len() >= 2) {
        *by.entry(x.dtype.as_str()).or_default() += x.shape.iter().product::<u64>();
    }
    by.into_iter().max_by_key(|(_, n)| *n).map(|(d, _)| d.to_string()).unwrap_or_default()
}

fn safetensors_dtype(d: &str) -> String {
    match d {
        "F8_E4M3" | "F8_E5M2" | "F8_E4M3FN" => "FP8".into(),
        "I8" => "INT8".into(),
        "U8" => "UINT8".into(),
        other => other.to_string(),
    }
}

fn read_safetensors(path: &Path) -> std::io::Result<(Vec<Tensor>, HashMap<String, String>)> {
    let mut f = std::fs::File::open(path)?;
    let mut len = [0u8; 8];
    f.read_exact(&mut len)?;
    let n = u64::from_le_bytes(len);
    if n == 0 || n > 128 << 20 {
        return Err(bad("unexpected header size"));
    }
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf)?;
    let v: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&buf).map_err(|_| bad("header is not valid JSON"))?;
    let mut meta = HashMap::new();
    let mut tensors = Vec::new();
    for (name, val) in v {
        if name == "__metadata__" {
            if let Some(m) = val.as_object() {
                meta.extend(m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))));
            }
            continue;
        }
        let dtype = val.get("dtype").and_then(|d| d.as_str()).unwrap_or("").to_string();
        let shape = val.get("shape").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
        tensors.push(Tensor { name, shape, dtype: safetensors_dtype(&dtype) });
    }
    Ok((tensors, meta))
}

fn bad(msg: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, msg.to_string())
}

fn ggml_type(t: u32) -> String {
    const NAMES: &[(u32, &str)] = &[
        (0, "F32"),
        (1, "F16"),
        (2, "Q4_0"),
        (3, "Q4_1"),
        (6, "Q5_0"),
        (7, "Q5_1"),
        (8, "Q8_0"),
        (9, "Q8_1"),
        (10, "Q2_K"),
        (11, "Q3_K"),
        (12, "Q4_K"),
        (13, "Q5_K"),
        (14, "Q6_K"),
        (15, "Q8_K"),
        (16, "IQ2_XXS"),
        (17, "IQ2_XS"),
        (18, "IQ3_XXS"),
        (19, "IQ1_S"),
        (20, "IQ4_NL"),
        (21, "IQ3_S"),
        (22, "IQ2_S"),
        (23, "IQ4_XS"),
        (24, "I8"),
        (29, "IQ1_M"),
        (30, "BF16"),
    ];
    NAMES.iter().find(|(n, _)| *n == t).map(|(_, s)| s.to_string()).unwrap_or_else(|| format!("type {t}"))
}

struct Gguf<R> {
    r: R,
}

impl<R: Read + Seek> Gguf<R> {
    fn u32(&mut self) -> std::io::Result<u32> {
        let mut b = [0u8; 4];
        self.r.read_exact(&mut b)?;
        Ok(u32::from_le_bytes(b))
    }

    fn u64(&mut self) -> std::io::Result<u64> {
        let mut b = [0u8; 8];
        self.r.read_exact(&mut b)?;
        Ok(u64::from_le_bytes(b))
    }

    fn string(&mut self) -> std::io::Result<String> {
        let n = self.u64()?;
        if n > 16 << 20 {
            return Err(bad("string too long"));
        }
        let mut b = vec![0u8; n as usize];
        self.r.read_exact(&mut b)?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }

    fn skip(&mut self, n: u64) -> std::io::Result<()> {
        self.r.seek(SeekFrom::Current(i64::try_from(n).map_err(|_| bad("bad length"))?))?;
        Ok(())
    }

    /// A metadata value: kept as text when it is a string or a number, skipped otherwise.
    fn value(&mut self, ty: u32) -> std::io::Result<Option<String>> {
        let fixed = |t: u32| -> Option<u64> {
            match t {
                0 | 1 | 7 => Some(1),
                2 | 3 => Some(2),
                4..=6 => Some(4),
                10..=12 => Some(8),
                _ => None,
            }
        };
        Ok(match ty {
            8 => Some(self.string()?),
            9 => {
                let et = self.u32()?;
                let n = self.u64()?;
                if n > 100_000_000 {
                    return Err(bad("array too long"));
                }
                match (et, fixed(et)) {
                    (8, _) => {
                        for _ in 0..n {
                            let len = self.u64()?;
                            self.skip(len)?;
                        }
                    }
                    (_, Some(s)) => self.skip(s * n)?,
                    _ => return Err(bad("nested arrays are not supported")),
                }
                None
            }
            4 => Some(self.u32()?.to_string()),
            5 => Some((self.u32()? as i32).to_string()),
            10 => Some(self.u64()?.to_string()),
            t => {
                self.skip(fixed(t).ok_or_else(|| bad("unknown value type"))?)?;
                None
            }
        })
    }
}

fn read_gguf(path: &Path) -> std::io::Result<(Vec<Tensor>, HashMap<String, String>)> {
    let mut g = Gguf { r: BufReader::with_capacity(1 << 20, std::fs::File::open(path)?) };
    let mut magic = [0u8; 4];
    g.r.read_exact(&mut magic)?;
    if &magic != b"GGUF" {
        return Err(bad("not a GGUF file"));
    }
    if g.u32()? < 2 {
        return Err(bad("GGUF version 1 is not supported"));
    }
    let (n_tensors, n_kv) = (g.u64()?, g.u64()?);
    if n_tensors > 100_000 || n_kv > 100_000 {
        return Err(bad("too many entries"));
    }
    let mut meta = HashMap::new();
    for _ in 0..n_kv {
        let key = g.string()?;
        let ty = g.u32()?;
        if let Some(v) = g.value(ty)? {
            meta.insert(key, v);
        }
    }
    let mut tensors = Vec::with_capacity(n_tensors as usize);
    for _ in 0..n_tensors {
        let name = g.string()?;
        let nd = g.u32()?;
        if nd > 8 {
            return Err(bad("bad tensor dimensions"));
        }
        let mut shape = (0..nd).map(|_| g.u64()).collect::<std::io::Result<Vec<u64>>>()?;
        shape.reverse();
        let ty = g.u32()?;
        g.u64()?; // offset
        tensors.push(Tensor { name, shape, dtype: ggml_type(ty) });
    }
    Ok((tensors, meta))
}

/// Every model file under `dir` (sub-folders included) that Kokon recognizes, usable or not.
pub fn scan(dir: &Path) -> Vec<FileInfo> {
    scan_with(dir, SCAN_MIN_BYTES)
}

fn scan_with(dir: &Path, min_bytes: u64) -> Vec<FileInfo> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    let mut entries = 0usize;
    let mut candidates = 0usize;
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            entries += 1;
            if entries > SCAN_MAX_ENTRIES || candidates > SCAN_MAX_FILES {
                return out;
            }
            let Ok(ft) = e.file_type() else { continue };
            let name = e.file_name().to_string_lossy().to_ascii_lowercase();
            if ft.is_dir() {
                // Symlinked folders are not followed (no loops, no surprises).
                if depth < SCAN_MAX_DEPTH && !name.starts_with('.') && !SCAN_SKIP.contains(&name.as_str()) {
                    stack.push((e.path(), depth + 1));
                }
                continue;
            }
            if !(name.ends_with(".gguf") || name.ends_with(".safetensors")) {
                continue;
            }
            let p = e.path();
            if std::fs::metadata(&p).map(|m| m.len() < min_bytes).unwrap_or(true) {
                continue;
            }
            candidates += 1;
            if let Ok(info) = inspect(&p)
                && info.role.is_some()
            {
                out.push(info);
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// The files a scan suggests for each role (None: not found). The official files win; then a
/// text encoder that carries its vision weights (no projector needed); then a diffusion model
/// that leaves room on a card with `vram_mib`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Picks {
    pub diffusion: Option<PathBuf>,
    pub vae: Option<PathBuf>,
    pub text_encoder: Option<PathBuf>,
    /// None also when the text encoder has the vision weights.
    pub vision_projector: Option<PathBuf>,
}

pub fn best(files: &[FileInfo], vram_mib: Option<u64>) -> Picks {
    let usable = |r: Role| files.iter().filter(move |f| f.role == Some(r) && f.compatible);
    let diffusion = usable(Role::Diffusion)
        .min_by_key(|f| {
            let fits = vram_mib.is_none_or(|v| f.size / (1 << 20) + 6 * 1024 <= v);
            // Official first; then the largest that fits; then the smallest.
            (!f.official, !fits, if fits { u64::MAX - f.size } else { f.size })
        })
        .map(|f| f.path.clone());
    let vae = usable(Role::Vae).min_by_key(|f| (!f.official, f.size)).map(|f| f.path.clone());
    let te = usable(Role::TextEncoder).min_by_key(|f| (!f.official, !f.has_vision, f.size));
    let vision_projector = match te {
        Some(t) if t.has_vision => None,
        _ => usable(Role::VisionProjector).min_by_key(|f| (!f.official, f.size)).map(|f| f.path.clone()),
    };
    Picks { diffusion, vae, text_encoder: te.map(|f| f.path.clone()), vision_projector }
}

/// What the user chose for a role in Setup: a file of theirs, or the official file downloaded
/// into a folder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Slot {
    Path(PathBuf),
    Download(PathBuf),
}

/// The official file Setup downloads for a role (the text encoder of `preset`).
pub fn official_for(role: Role, preset: &Preset) -> Download {
    match role {
        Role::Diffusion => preset.diffusion,
        Role::Vae => VAE,
        Role::TextEncoder => preset.text_encoder,
        Role::VisionProjector => VISION_PROJECTOR,
    }
}

/// The path a slot resolves to, checked: the user's file must be a usable `role` file; an
/// official download goes into the folder under its own name (a file of that name already
/// there must be the official one). Also returns whether a text encoder has vision weights.
fn resolve(slot: &Slot, role: Role, preset: &Preset) -> Result<(PathBuf, bool), AppError> {
    match slot {
        Slot::Path(p) => {
            let info = inspect(p).map_err(|e| AppError::io("read", p, e))?;
            if info.role != Some(role) {
                let what = match (info.role, info.problem) {
                    (Some(r), _) => format!("this is a {} file", r.label().to_lowercase()),
                    (None, Some(problem)) => problem,
                    (None, None) => "not recognized".into(),
                };
                return Err(AppError::invalid(format!("{}: {what} ({}).", role.label(), p.display())));
            }
            if !info.compatible {
                return Err(AppError::invalid(format!("{}: {}", role.label(), info.problem.unwrap_or_else(|| "not usable with Qwen-Image 2.1.".into()))));
            }
            Ok((p.clone(), info.has_vision))
        }
        Slot::Download(dir) => {
            let d = official_for(role, preset);
            let path = dir.join(d.file_name());
            if let Ok(m) = std::fs::metadata(&path)
                && m.len() != d.size
            {
                return Err(AppError::invalid(format!("{}: {} already exists and is not the official file. Choose another folder, or choose that file instead.", role.label(), path.display())));
            }
            Ok((path, false))
        }
    }
}

/// The user profile for the files chosen in Setup, every one checked. The vision projector is
/// left out when the text encoder carries the vision weights, and required otherwise
/// (editing needs it).
pub fn user_profile(diffusion: &Slot, vae: &Slot, text_encoder: &Slot, vision: Option<&Slot>, scan_dir: Option<PathBuf>, preset: &Preset) -> Result<ModelProfile, AppError> {
    let (diffusion, _) = resolve(diffusion, Role::Diffusion, preset)?;
    let (vae, _) = resolve(vae, Role::Vae, preset)?;
    let (te, te_vision) = resolve(text_encoder, Role::TextEncoder, preset)?;
    let vision = match (vision, te_vision) {
        (_, true) => None,
        (Some(v), false) => Some(resolve(v, Role::VisionProjector, preset)?.0),
        (None, false) => return Err(AppError::invalid("This text encoder has no vision weights, which editing needs: choose the vision projector (mmproj), or download it.")),
    };
    let mut p = ModelProfile::user(diffusion, vae, te, vision);
    p.scan_dir = scan_dir;
    Ok(p)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A safetensors file with these tensors (header only; no weights).
    pub(crate) fn write_st(path: &Path, tensors: &[(&str, &str, &[u64])]) {
        let mut m = serde_json::Map::new();
        m.insert("__metadata__".into(), serde_json::json!({ "format": "pt" }));
        for (n, d, s) in tensors {
            m.insert(n.to_string(), serde_json::json!({ "dtype": d, "shape": s, "data_offsets": [0, 0] }));
        }
        let h = serde_json::to_vec(&m).unwrap();
        let mut b = (h.len() as u64).to_le_bytes().to_vec();
        b.extend(h);
        std::fs::write(path, b).unwrap();
    }

    /// A GGUF file with string/u32 metadata and these tensors (dims in GGUF order).
    pub(crate) fn write_gguf(path: &Path, kv: &[(&str, &str)], kv_u32: &[(&str, u32)], tensors: &[(&str, u32, &[u64])]) {
        let s = |b: &mut Vec<u8>, x: &str| {
            b.extend((x.len() as u64).to_le_bytes());
            b.extend(x.as_bytes());
        };
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend((tensors.len() as u64).to_le_bytes());
        b.extend(((kv.len() + kv_u32.len() + 1) as u64).to_le_bytes());
        for (k, v) in kv {
            s(&mut b, k);
            b.extend(8u32.to_le_bytes());
            s(&mut b, v);
        }
        for (k, v) in kv_u32 {
            s(&mut b, k);
            b.extend(4u32.to_le_bytes());
            b.extend(v.to_le_bytes());
        }
        // A tokenizer-like string array, skipped by the reader.
        s(&mut b, "tokenizer.ggml.tokens");
        b.extend(9u32.to_le_bytes());
        b.extend(8u32.to_le_bytes());
        b.extend(3u64.to_le_bytes());
        for t in ["a", "bb", "ccc"] {
            s(&mut b, t);
        }
        for (n, ty, dims) in tensors {
            s(&mut b, n);
            b.extend((dims.len() as u32).to_le_bytes());
            for d in *dims {
                b.extend(d.to_le_bytes());
            }
            b.extend(ty.to_le_bytes());
            b.extend(0u64.to_le_bytes());
        }
        std::fs::write(path, b).unwrap();
    }

    /// A set of synthetic files like a ComfyUI models folder: the 2.1 Turbo as INT8
    /// safetensors, the 2.1 VAE, a Qwen3-VL text encoder with the vision tower, plus files of
    /// other models.
    pub(crate) fn comfy_folder(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let m = dir.join("models");
        for sub in ["diffusion_models", "vae", "text_encoders", "custom_nodes"] {
            std::fs::create_dir_all(m.join(sub)).unwrap();
        }
        let dit = m.join("diffusion_models").join("qwen_image_2.1_turbo_int8_convrot.safetensors");
        write_st(&dit, &[("model.diffusion_model.txt_in.text_norm.weight", "BF16", &[4096]), ("model.diffusion_model.transformer_blocks.0.img_mod.1.weight", "I8", &[24576, 4096]), ("model.diffusion_model.img_in.weight", "BF16", &[4096, 64])]);
        let vae = m.join("vae").join("qwen_image_2.1_vae_bf16.safetensors");
        write_st(&vae, &[("conv2.weight", "BF16", &[64, 64, 1, 1, 1]), ("decoder.conv1.weight", "BF16", &[1152, 64, 1, 3, 3]), ("encoder.conv1.weight", "BF16", &[96, 3, 3, 3, 3])]);
        let te = m.join("text_encoders").join("qwen3vl_8b_int8_convrot.safetensors");
        write_st(
            &te,
            &[
                ("model.embed_tokens.weight", "BF16", &[151936, 4096]),
                ("model.layers.0.self_attn.q_proj.weight", "I8", &[4096, 4096]),
                ("model.layers.0.self_attn.q_norm.weight", "BF16", &[128]),
                ("visual.blocks.0.attn.qkv.weight", "BF16", &[3456, 1152]),
                ("visual.merger.linear_fc2.weight", "BF16", &[4096, 4608]),
            ],
        );
        // Another model's files, and one inside a folder a scan skips.
        write_st(&m.join("diffusion_models").join("qwen_image_2512.safetensors"), &[("transformer_blocks.0.img_mod.1.weight", "BF16", &[18432, 3072]), ("img_in.weight", "BF16", &[3072, 64])]);
        write_st(&m.join("vae").join("qwen_image_vae.safetensors"), &[("conv2.weight", "BF16", &[16, 16, 1, 1, 1]), ("decoder.conv1.weight", "BF16", &[384, 16, 1, 3, 3]), ("encoder.conv1.weight", "BF16", &[96, 3, 3, 3, 3])]);
        write_st(&m.join("custom_nodes").join("hidden.safetensors"), &[("txt_in.text_norm.weight", "BF16", &[4096])]);
        (dit, vae, te)
    }

    #[test]
    fn recognizes_comfyui_files() {
        let dir = tempfile::tempdir().unwrap();
        let (dit, vae, te) = comfy_folder(dir.path());
        let d = inspect(&dit).unwrap();
        assert_eq!((d.role, d.compatible, d.weights.as_str(), d.official), (Some(Role::Diffusion), true, "INT8", false));
        let v = inspect(&vae).unwrap();
        assert_eq!((v.role, v.compatible), (Some(Role::Vae), true));
        assert!(!v.official, "the official name, but not its size");
        let t = inspect(&te).unwrap();
        assert_eq!((t.role, t.compatible, t.has_vision), (Some(Role::TextEncoder), true, true));
        let old = inspect(&dir.path().join("models/diffusion_models/qwen_image_2512.safetensors")).unwrap();
        assert_eq!((old.role, old.compatible), (Some(Role::Diffusion), false));
        assert!(old.problem.unwrap().contains("not Qwen-Image 2.1"));
        let old_vae = inspect(&dir.path().join("models/vae/qwen_image_vae.safetensors")).unwrap();
        assert!(!old_vae.compatible && old_vae.problem.unwrap().contains("latent size 16"));
    }

    #[test]
    fn recognizes_gguf_files() {
        let dir = tempfile::tempdir().unwrap();
        let dit = dir.path().join("turbo.gguf");
        write_gguf(&dit, &[], &[], &[("model.diffusion_model.txt_in.text_norm.weight", 30, &[4096]), ("model.diffusion_model.img_in.weight", 12, &[64, 4096]), ("model.diffusion_model.proj_out.weight", 12, &[4096, 64])]);
        let d = inspect(&dit).unwrap();
        assert_eq!((d.role, d.compatible, d.weights.as_str()), (Some(Role::Diffusion), true, "Q4_K"));
        let te = dir.path().join("te.gguf");
        write_gguf(&te, &[("general.architecture", "qwen3vl")], &[("qwen3vl.embedding_length", 4096)], &[("token_embd.weight", 12, &[4096, 151936]), ("blk.0.attn_q.weight", 12, &[4096, 4096]), ("blk.0.attn_q_norm.weight", 0, &[128])]);
        let t = inspect(&te).unwrap();
        assert_eq!((t.role, t.compatible, t.has_vision), (Some(Role::TextEncoder), true, false));
        let old_te = dir.path().join("qwen25.gguf");
        write_gguf(&old_te, &[("general.architecture", "qwen2vl")], &[], &[("token_embd.weight", 12, &[3584, 152064]), ("blk.0.attn_q.weight", 12, &[3584, 3584])]);
        assert!(inspect(&old_te).unwrap().problem.unwrap().contains("Qwen2.5-VL"));
        let mm = dir.path().join("mmproj.gguf");
        write_gguf(&mm, &[("general.architecture", "clip")], &[("clip.vision.projection_dim", 4096)], &[("v.blk.0.attn_qkv.weight", 1, &[1152, 3456]), ("mm.2.weight", 1, &[4608, 4096])]);
        let p = inspect(&mm).unwrap();
        assert_eq!((p.role, p.compatible), (Some(Role::VisionProjector), true));
        let mm4b = dir.path().join("mmproj-4b.gguf");
        write_gguf(&mm4b, &[("general.architecture", "clip")], &[("clip.vision.projection_dim", 2560)], &[("v.blk.0.attn_qkv.weight", 1, &[1024, 3072])]);
        assert!(!inspect(&mm4b).unwrap().compatible);
    }

    #[test]
    fn text_only_qwen3_is_not_the_text_encoder() {
        // chillahc (Reddit, 10-21): setup picked a prompt enhancer's Qwen3 8B as the text encoder.
        let dir = tempfile::tempdir().unwrap();
        let te_tensors: &[(&str, &str, &[u64])] = &[("model.embed_tokens.weight", "BF16", &[151936, 4096]), ("model.layers.0.self_attn.q_proj.weight", "F8_E4M3", &[4096, 4096]), ("model.layers.0.self_attn.q_norm.weight", "BF16", &[128])];
        let gguf = dir.path().join("Qwen3-8B-Q4_K_M.gguf");
        write_gguf(&gguf, &[("general.architecture", "qwen3")], &[("qwen3.embedding_length", 4096)], &[("token_embd.weight", 12, &[4096, 151936]), ("blk.0.attn_q.weight", 12, &[4096, 4096]), ("blk.0.attn_q_norm.weight", 0, &[128])]);
        let g = inspect(&gguf).unwrap();
        assert_eq!((g.role, g.compatible), (Some(Role::TextEncoder), false));
        assert!(g.problem.unwrap().contains("Qwen3 8B, a text-only"));
        // Same shapes in a safetensors file with nothing that says VL: not picked either.
        let klein = dir.path().join("qwen_3_8b_fp8mixed.safetensors");
        write_st(&klein, te_tensors);
        let k = inspect(&klein).unwrap();
        assert!(!k.compatible && k.problem.unwrap().contains("can't tell"));
        // ...but the same file named as Qwen3-VL is accepted (it needs the projector).
        let vl = dir.path().join("qwen3_vl_8b_text_fp8.safetensors");
        write_st(&vl, te_tensors);
        let v = inspect(&vl).unwrap();
        assert_eq!((v.compatible, v.has_vision), (true, false));
        // A scan with only the text-only files suggests no text encoder (the official one is downloaded).
        std::fs::remove_file(&vl).unwrap();
        assert_eq!(best(&scan_with(dir.path(), 0), None).text_encoder, None);
    }

    #[test]
    fn rejects_unsafe_split_and_broken_files() {
        let dir = tempfile::tempdir().unwrap();
        for (name, needle) in [("model.ckpt", "can run code"), ("model.bin", "can run code"), ("model-00001-of-00004.safetensors", "split into several"), ("notes.txt", "Not a model file")] {
            let p = dir.path().join(name);
            std::fs::write(&p, b"0123456789").unwrap();
            let i = inspect(&p).unwrap();
            assert!(i.role.is_none() && !i.compatible && i.problem.as_deref().unwrap().contains(needle), "{name}: {:?}", i.problem);
        }
        let p = dir.path().join("broken.safetensors");
        std::fs::write(&p, b"\xff\xff\xff\xff\xff\xff\xff\xffgarbage").unwrap();
        assert!(inspect(&p).unwrap().problem.unwrap().contains("header"));
        let p = dir.path().join("broken.gguf");
        std::fs::write(&p, b"GGUF\x03\x00\x00\x00").unwrap();
        assert!(inspect(&p).unwrap().problem.unwrap().contains("header"));
        assert!(inspect(&dir.path().join("missing.gguf")).is_err());
    }

    #[test]
    fn official_files_by_name_and_size() {
        let p = Path::new("D:/anywhere/Qwen3VL-8B-Instruct-Q4_K_M.gguf");
        assert_eq!(official_download(p, TEXT_ENCODER_Q4_K_M.size).unwrap().id, "text_encoder_q4_k_m");
        assert!(official_download(p, 123).is_none(), "same name, other size");
        assert!(official_download(Path::new("D:/x/renamed.gguf"), TEXT_ENCODER_Q4_K_M.size).is_none());
    }

    #[test]
    fn scan_finds_the_pieces_and_picks_the_best() {
        let dir = tempfile::tempdir().unwrap();
        let (dit, vae, te) = comfy_folder(dir.path());
        let files = scan_with(dir.path(), 0);
        assert_eq!(files.len(), 5, "skipped folders are not entered: {files:#?}");
        let picks = best(&files, Some(16_303));
        assert_eq!(picks, Picks { diffusion: Some(dit.clone()), vae: Some(vae), text_encoder: Some(te), vision_projector: None }, "the text encoder carries the vision weights");
        // A text encoder without vision needs the projector, when there is one.
        let mm = dir.path().join("models").join("mmproj.gguf");
        write_gguf(&mm, &[("general.architecture", "clip")], &[("clip.vision.projection_dim", 4096)], &[("v.blk.0.attn_qkv.weight", 1, &[1152, 3456])]);
        let mut files = scan_with(dir.path(), 0);
        for f in files.iter_mut().filter(|f| f.role == Some(Role::TextEncoder)) {
            f.has_vision = false;
        }
        assert_eq!(best(&files, None).vision_projector, Some(mm));
        // The minimum size skips small files.
        assert!(scan_with(dir.path(), 1 << 20).is_empty());
        assert!(scan(&dir.path().join("missing")).is_empty());
    }

    #[test]
    fn user_profile_checks_every_choice() {
        let dir = tempfile::tempdir().unwrap();
        let (dit, vae, te) = comfy_folder(dir.path());
        let preset = crate::catalog::preset("16gb").unwrap();
        let path = |p: &Path| Slot::Path(p.to_path_buf());
        // badraymen's set (#14): the fused text encoder needs no projector.
        let p = user_profile(&path(&dit), &path(&vae), &path(&te), None, Some(dir.path().to_path_buf()), preset).unwrap();
        assert_eq!((p.id.as_str(), p.vision_projector.clone(), p.scan_dir.clone()), (crate::config::USER_PROFILE_ID, None, Some(dir.path().to_path_buf())));
        // ...and a projector chosen anyway is not passed.
        let mm = dir.path().join("mm.gguf");
        write_gguf(&mm, &[("general.architecture", "clip")], &[("clip.vision.projection_dim", 4096)], &[("v.blk.0.attn_qkv.weight", 1, &[1152, 3456])]);
        assert_eq!(user_profile(&path(&dit), &path(&vae), &path(&te), Some(&path(&mm)), None, preset).unwrap().vision_projector, None);
        // Wrong file for the role, or a file of another model.
        let e = user_profile(&path(&vae), &path(&vae), &path(&te), None, None, preset).unwrap_err();
        assert!(e.message.starts_with("Diffusion model: this is a vae file"), "{}", e.message);
        let old = dir.path().join("models/diffusion_models/qwen_image_2512.safetensors");
        assert!(user_profile(&path(&old), &path(&vae), &path(&te), None, None, preset).unwrap_err().message.contains("not Qwen-Image 2.1"));
        // Official pieces to download: the official text encoder has no vision, so the
        // projector is required, and downloaded too.
        let dl = dir.path().join("dl");
        let e = user_profile(&path(&dit), &path(&vae), &Slot::Download(dl.clone()), None, None, preset).unwrap_err();
        assert!(e.message.contains("vision projector"), "{}", e.message);
        let p = user_profile(&path(&dit), &Slot::Download(dl.clone()), &Slot::Download(dl.clone()), Some(&Slot::Download(dl.clone())), None, preset).unwrap();
        assert_eq!(p.vae, dl.join(VAE.file_name()));
        assert_eq!(p.text_encoder, dl.join(preset.text_encoder.file_name()));
        assert_eq!(p.vision_projector, Some(dl.join(VISION_PROJECTOR.file_name())));
        assert_eq!(crate::catalog::profile_model_downloads(&p).len(), 3, "and they are what the install downloads");
        // A different file under the official name is never overwritten.
        std::fs::create_dir_all(&dl).unwrap();
        std::fs::write(dl.join(VAE.file_name()), b"mine").unwrap();
        assert!(user_profile(&path(&dit), &Slot::Download(dl), &path(&te), None, None, preset).unwrap_err().message.contains("not the official file"));
    }

    #[test]
    fn diffusion_pick_follows_vram() {
        let f = |name: &str, gib: u64| FileInfo { path: PathBuf::from(name), size: gib << 30, role: Some(Role::Diffusion), compatible: true, has_vision: false, weights: String::new(), official: false, problem: None };
        let files = [f("bf16", 20), f("int8", 10), f("q4", 5)];
        assert_eq!(best(&files, Some(16 * 1024)).diffusion, Some(PathBuf::from("int8")), "the largest that leaves room");
        assert_eq!(best(&files, Some(8 * 1024)).diffusion, Some(PathBuf::from("q4")), "nothing fits: the smallest");
        let mut off = f("official", 4);
        off.official = true;
        assert_eq!(best(&[files[0].clone(), off], Some(32 * 1024)).diffusion, Some(PathBuf::from("official")));
    }
}
