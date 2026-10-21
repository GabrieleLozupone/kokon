//! The user's own LoRA files. A file is checked against the diffusion model from the headers
//! only, then Kokon writes its own copy into `AppConfig::lora_dir` (the engine's
//! `--lora-model-dir`); the user's file is never changed. The copy differs from the original
//! only where the engine would otherwise lose part of the LoRA:
//! - fused `img_mlp.gate_up` pairs (ComfyUI / ai-toolkit LoRAs) are split into `gate_layer` and
//!   `proj`. The engine maps split LoRAs onto both model layouts, but drops fused ones on the
//!   split GGUF models (32 of 192 modules of every 2.1 LoRA tested on 2026-10-19);
//! - an alpha kept only in PEFT's `lora_adapter_metadata` JSON goes into the top-level `alpha`
//!   metadata the engine reads, so the LoRA runs at the strength it was trained for.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::config::{AppConfig, LoraEntry};
use crate::error::{AppError, AppResult, ErrorCode};

/// LoRAs one image can use at once.
pub const MAX_ACTIVE: usize = 3;

/// Serializes changes to the LoRA list (copying a file takes seconds).
pub static LIBRARY: Mutex<()> = Mutex::new(());

const PREFIXES: &[&str] = &["base_model.model.", "model.diffusion_model.", "diffusion_model.", "transformer.", "unet."];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Down,
    Up,
    Alpha,
    Dora,
    /// LyCORIS factors and full weight differences: applied by the engine, matched by name only.
    Other,
}

const SUFFIXES: &[(&str, Role)] = &[
    (".lora_A.default.weight", Role::Down),
    (".lora_B.default.weight", Role::Up),
    (".lora_A.weight", Role::Down),
    (".lora_B.weight", Role::Up),
    (".lora_down.weight", Role::Down),
    (".lora_up.weight", Role::Up),
    (".alpha", Role::Alpha),
    (".dora_scale", Role::Dora),
    (".lora_magnitude_vector", Role::Dora),
    (".diff", Role::Other),
    (".diff_b", Role::Other),
    (".hada_w1_a", Role::Other),
    (".hada_w1_b", Role::Other),
    (".hada_w2_a", Role::Other),
    (".hada_w2_b", Role::Other),
    (".lokr_w1", Role::Other),
    (".lokr_w2", Role::Other),
    (".lokr_w1_a", Role::Other),
    (".lokr_w1_b", Role::Other),
    (".lokr_w2_a", Role::Other),
    (".lokr_w2_b", Role::Other),
];

/// `(module, role, suffix)` of a LoRA tensor name; None for names that are no LoRA part.
fn split_key(name: &str) -> Option<(&str, Role, &'static str)> {
    SUFFIXES.iter().find(|(s, _)| name.ends_with(s)).map(|(s, r)| (&name[..name.len() - s.len()], *r, *s))
}

fn is_text_encoder(module: &str) -> bool {
    module.starts_with("lora_te") || module.starts_with("text_encoder") || module.starts_with("te.")
}

/// Module name as the model names it; kohya names (`lora_unet_a_b_c`) keep their underscores.
fn module_name(module: &str) -> (&str, bool) {
    if let Some(rest) = module.strip_prefix("lora_unet_") {
        return (rest, true);
    }
    (PREFIXES.iter().find_map(|p| module.strip_prefix(p)).unwrap_or(module), false)
}

const FUSED: &str = ".img_mlp.gate_up";

struct StTensor {
    name: String,
    dtype: String,
    shape: Vec<u64>,
    start: u64,
    end: u64,
}

struct StFile {
    tensors: Vec<StTensor>,
    meta: serde_json::Map<String, serde_json::Value>,
    data_start: u64,
    len: u64,
}

fn read_header(path: &Path) -> AppResult<StFile> {
    let unreadable = |why: &str| AppError::invalid(format!("This file isn't a LoRA Kokon can read ({why}). Choose a .safetensors LoRA file."));
    let mut f = File::open(path).map_err(|e| AppError::io("open", path, e))?;
    let len = f.metadata().map_err(|e| AppError::io("read", path, e))?.len();
    let mut b = [0u8; 8];
    f.read_exact(&mut b).map_err(|_| unreadable("too short"))?;
    let n = u64::from_le_bytes(b);
    if n == 0 || n > 128 << 20 || 8 + n > len {
        return Err(unreadable("bad header size"));
    }
    let mut buf = vec![0u8; n as usize];
    f.read_exact(&mut buf).map_err(|_| unreadable("header cut short"))?;
    let v: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&buf).map_err(|_| unreadable("header is not valid JSON"))?;
    let data_start = 8 + n;
    let mut meta = serde_json::Map::new();
    let mut tensors = Vec::new();
    for (name, val) in v {
        if name == "__metadata__" {
            if let Some(m) = val.as_object() {
                meta = m.clone();
            }
            continue;
        }
        let dtype = val.get("dtype").and_then(|d| d.as_str()).unwrap_or("").to_string();
        let shape: Vec<u64> = val.get("shape").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
        let off: Vec<u64> = val.get("data_offsets").and_then(|s| s.as_array()).map(|a| a.iter().filter_map(|x| x.as_u64()).collect()).unwrap_or_default();
        if off.len() != 2 || off[0] > off[1] || data_start + off[1] > len {
            return Err(unreadable("tensor outside the file; it may be incomplete"));
        }
        tensors.push(StTensor { name, dtype, shape, start: off[0], end: off[1] });
    }
    tensors.sort_by_key(|t| t.start);
    Ok(StFile { tensors, meta, data_start, len })
}

/// PEFT's alpha, when the file has no other alpha the engine reads (`.alpha` tensors or a
/// top-level `alpha`).
fn peft_only_alpha(st: &StFile) -> Option<f32> {
    if st.meta.contains_key("alpha") || st.tensors.iter().any(|t| t.name.ends_with(".alpha")) {
        return None;
    }
    let peft: serde_json::Value = serde_json::from_str(st.meta.get("lora_adapter_metadata")?.as_str()?).ok()?;
    let a = peft.get("lora_alpha")?.as_f64()? as f32;
    (a.is_finite() && a > 0.0).then_some(a)
}

/// What a LoRA file holds for the image model it was checked against.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct LoraCheck {
    /// Modules for the image model (low-rank pairs and LyCORIS / diff parts).
    pub modules: usize,
    /// Modules the model has, with matching shapes where they can be compared.
    pub matched: usize,
    /// Fused gate+up MLP pairs Kokon's copy splits.
    pub fused: usize,
    pub rank: Option<u64>,
    /// Alpha taken from PEFT's metadata into the copy.
    pub peft_alpha: Option<f32>,
    /// Shown with the LoRA when it works only in part.
    pub warning: Option<String>,
}

/// Checks a LoRA against the diffusion model's tensor shapes (`modelfile::diffusion_tensor_shapes`).
/// Errors explain why Kokon can't use the file.
pub fn check(lora: &Path, model: &HashMap<String, Vec<u64>>) -> AppResult<LoraCheck> {
    let ext = lora.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    if ext != "safetensors" {
        return Err(AppError::invalid("Kokon only loads LoRAs in .safetensors files (.ckpt, .pt and .bin files can run code when loaded)."));
    }
    let st = read_header(lora)?;
    check_header(&st, model)
}

/// Down shape, up shape, and whether the module has other (LyCORIS / diff) parts.
type ModuleParts<'a> = (Option<&'a [u64]>, Option<&'a [u64]>, bool);

fn check_header(st: &StFile, model: &HashMap<String, Vec<u64>>) -> AppResult<LoraCheck> {
    let mut modules: HashMap<&str, ModuleParts> = HashMap::new();
    let mut text_encoder = 0usize;
    for t in &st.tensors {
        let Some((module, role, _)) = split_key(&t.name) else { continue };
        if is_text_encoder(module) {
            text_encoder += 1;
            continue;
        }
        let m = modules.entry(module).or_default();
        match role {
            Role::Down => m.0 = Some(&t.shape),
            Role::Up => m.1 = Some(&t.shape),
            Role::Other => m.2 = true,
            Role::Alpha | Role::Dora => {}
        }
    }
    if modules.is_empty() {
        return Err(if text_encoder > 0 {
            AppError::invalid("This LoRA only changes the text encoder, which Kokon doesn't support. Use a LoRA for the image model.")
        } else {
            AppError::invalid("No LoRA weights found in this file. Is it a LoRA? Full models and other files go in Settings → Models.")
        });
    }
    let underscored: HashMap<String, &str> = model.keys().filter_map(|k| k.strip_suffix(".weight")).map(|k| (k.replace('.', "_"), k)).collect();
    let mut check = LoraCheck::default();
    let mut ranks: HashMap<u64, usize> = HashMap::new();
    let mut wrong_shape = 0usize;
    for (module, (down, up, other)) in &modules {
        if down.is_none() && up.is_none() && !other {
            continue;
        }
        check.modules += 1;
        let (name, kohya) = module_name(module);
        let target = if kohya { underscored.get(name).map(|s| s.to_string()) } else { model.contains_key(&format!("{name}.weight")).then(|| name.to_string()) };
        let (Some(down), Some(up)) = (down, up) else {
            // LyCORIS / diff: the engine applies them by name.
            check.matched += target.is_some() as usize;
            continue;
        };
        if let Some(r) = down.first() {
            *ranks.entry(*r).or_default() += 1;
        }
        let fits = |t: &[u64], rows: u64| t.len() >= 2 && up.first() == Some(&rows) && down.get(1) == Some(&t[1]);
        match target {
            Some(t) => {
                let shape = &model[&format!("{t}.weight")];
                if fits(shape, shape[0]) {
                    check.matched += 1;
                    check.fused += (!kohya && name.ends_with(FUSED)) as usize;
                } else {
                    wrong_shape += 1;
                }
            }
            None if !kohya && name.ends_with(FUSED) => {
                // Fused gate+up on a model with separate gate_layer / proj layers.
                let gate = format!("{}.img_mlp.gate_layer.weight", name.trim_end_matches(FUSED));
                match model.get(&gate) {
                    Some(g) if fits(g, g.first().copied().unwrap_or(0) * 2) => {
                        check.matched += 1;
                        check.fused += 1;
                    }
                    Some(_) => wrong_shape += 1,
                    None => {}
                }
            }
            None => {}
        }
    }
    check.rank = ranks.into_iter().max_by_key(|(r, n)| (*n, *r)).map(|(r, _)| r);
    check.peft_alpha = peft_only_alpha(st);
    if check.matched == 0 {
        let why = if wrong_shape > 0 {
            "This LoRA was made for another model (its layers have other sizes, e.g. Qwen-Image 1.x, 2512 or Edit). On Qwen-Image 2.1 it would do nothing."
        } else {
            "None of this LoRA's layers exist in the model Kokon runs (Qwen-Image 2.1), so it would do nothing. It was made for another model."
        };
        return Err(AppError::invalid(why));
    }
    if check.matched * 10 < check.modules * 9 {
        check.warning = Some(format!("Only {} of its {} layers fit the model; its effect may be weaker than intended.", check.matched, check.modules));
    }
    if text_encoder > 0 {
        let note = "Its text-encoder part is not used.";
        check.warning = Some(check.warning.map_or(note.to_string(), |w| format!("{w} {note}")));
    }
    Ok(check)
}

struct Piece {
    name: String,
    dtype: String,
    shape: Vec<u64>,
    src: u64,
    len: u64,
}

/// Writes Kokon's copy of `src` to `dest` (see the module docs): byte for byte when nothing
/// needs changing, else rewritten with fused pairs split and/or the PEFT alpha as metadata.
pub fn prepare(src: &Path, dest: &Path) -> AppResult<()> {
    let st = read_header(src)?;
    let alpha = peft_only_alpha(&st);
    let fused = |n: &str| split_key(n).is_some_and(|(m, _, _)| !is_text_encoder(m) && !module_name(m).1 && m.ends_with(FUSED));
    let tmp = dest.with_extension("safetensors.part");
    let result = if alpha.is_none() && !st.tensors.iter().any(|t| fused(&t.name)) {
        std::fs::copy(src, &tmp).map(|_| ()).map_err(|e| AppError::io("copy the LoRA to", &tmp, e))
    } else {
        rewrite(src, &st, &tmp, alpha, &fused)
    };
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest).map_err(|e| AppError::io("save the LoRA as", dest, e))
}

fn rewrite(src: &Path, st: &StFile, tmp: &Path, alpha: Option<f32>, fused: &dyn Fn(&str) -> bool) -> AppResult<()> {
    // Output rows of each fused module (its up matrix), to split a DoRA magnitude the same way.
    let up_rows: HashMap<&str, u64> = st
        .tensors
        .iter()
        .filter_map(|t| split_key(&t.name).filter(|(_, r, _)| *r == Role::Up).map(|(m, _, _)| (m, t.shape.first().copied().unwrap_or(0))))
        .collect();
    let mut pieces = Vec::with_capacity(st.tensors.len() + 64);
    for t in &st.tensors {
        let len = t.end - t.start;
        let src_at = st.data_start + t.start;
        if !fused(&t.name) {
            pieces.push(Piece { name: t.name.clone(), dtype: t.dtype.clone(), shape: t.shape.clone(), src: src_at, len });
            continue;
        }
        let (module, role, suffix) = split_key(&t.name).unwrap();
        let base = module.trim_end_matches(FUSED);
        let (gate, proj) = (format!("{base}.img_mlp.gate_layer{suffix}"), format!("{base}.img_mlp.proj{suffix}"));
        let rows = t.shape.first().copied().unwrap_or(0);
        let split_rows = matches!(role, Role::Up | Role::Dora) && rows >= 2 && rows % 2 == 0 && up_rows.get(module) == Some(&rows) && len % rows == 0;
        if split_rows {
            // [gate; proj]: the order the engine's fused layer uses.
            let half = rows / 2;
            let row_bytes = len / rows;
            let mut shape = t.shape.clone();
            shape[0] = half;
            pieces.push(Piece { name: gate, dtype: t.dtype.clone(), shape: shape.clone(), src: src_at, len: half * row_bytes });
            pieces.push(Piece { name: proj, dtype: t.dtype.clone(), shape, src: src_at + half * row_bytes, len: len - half * row_bytes });
        } else {
            // Down matrix and alpha: shared by both halves.
            pieces.push(Piece { name: gate, dtype: t.dtype.clone(), shape: t.shape.clone(), src: src_at, len });
            pieces.push(Piece { name: proj, dtype: t.dtype.clone(), shape: t.shape.clone(), src: src_at, len });
        }
    }
    let mut head = serde_json::Map::new();
    let mut meta = st.meta.clone();
    if let Some(a) = alpha {
        meta.insert("alpha".into(), serde_json::Value::String(format!("{a}")));
    }
    if !meta.is_empty() {
        head.insert("__metadata__".into(), serde_json::Value::Object(meta));
    }
    let mut off = 0u64;
    for p in &pieces {
        head.insert(p.name.clone(), serde_json::json!({ "dtype": p.dtype, "shape": p.shape, "data_offsets": [off, off + p.len] }));
        off += p.len;
    }
    let mut hj = serde_json::to_vec(&head).map_err(AppError::internal)?;
    hj.resize(hj.len().div_ceil(8) * 8, b' ');
    let io = |e| AppError::io("write the LoRA copy", tmp, e);
    let mut input = File::open(src).map_err(|e| AppError::io("open", src, e))?;
    let mut out = BufWriter::with_capacity(4 << 20, File::create(tmp).map_err(io)?);
    out.write_all(&(hj.len() as u64).to_le_bytes()).map_err(io)?;
    out.write_all(&hj).map_err(io)?;
    for p in &pieces {
        if p.src + p.len > st.len {
            return Err(AppError::invalid("This LoRA file is incomplete."));
        }
        input.seek(SeekFrom::Start(p.src)).map_err(|e| AppError::io("read", src, e))?;
        let copied = std::io::copy(&mut (&mut input).take(p.len), &mut out).map_err(io)?;
        if copied != p.len {
            return Err(AppError::invalid("This LoRA file is incomplete."));
        }
    }
    out.into_inner().map_err(|e| io(e.into_error()))?.sync_all().map_err(io)
}

/// A free id (= file stem in the LoRA folder) for a file named `stem`.
pub fn new_id(stem: &str, taken: &HashSet<String>, dir: &Path) -> String {
    let base = crate::paths::sanitize_file_stem(stem);
    let base = if base.is_empty() { "lora".to_string() } else { base };
    let free = |id: &str| !taken.contains(id) && !dir.join(format!("{id}.safetensors")).exists();
    if free(&base) {
        return base;
    }
    (2..).map(|i| format!("{base}-{i}")).find(|id| free(id)).unwrap()
}

/// Checks `src` against the active model, writes the copy and returns the new entry (not yet in
/// the config). `existing` replaces an entry for the same file, keeping its settings.
pub fn import(cfg: &AppConfig, src: &Path, existing: Option<&LoraEntry>) -> AppResult<LoraEntry> {
    let model_path = &cfg.profile().diffusion_model;
    let model = crate::modelfile::diffusion_tensor_shapes(model_path).map_err(|e| {
        AppError::new(ErrorCode::InvalidInput, "Kokon needs its image model to check a LoRA, and couldn't read it.").detail(format!("{}: {e}", model_path.display())).suggest("Finish the setup in Settings → Models first.")
    })?;
    let checked = check(src, &model)?;
    let dir = cfg.lora_dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::io("create the LoRA folder", &dir, e))?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let id = match existing {
        Some(e) => e.id.clone(),
        None => new_id(&stem, &cfg.loras.iter().map(|l| l.id.clone()).collect(), &dir),
    };
    let dest = dir.join(format!("{id}.safetensors"));
    prepare(src, &dest)?;
    let mut notes = Vec::new();
    if checked.fused > 0 {
        notes.push(format!("{} fused MLP layers split so the engine applies all of them.", checked.fused));
    }
    if let (Some(a), Some(r)) = (checked.peft_alpha, checked.rank) {
        notes.push(format!("Strength from the file's settings (alpha {a}, rank {r})."));
    }
    let size = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
    let base = existing.cloned().unwrap_or_else(|| LoraEntry { name: stem.clone(), ..LoraEntry::default() });
    Ok(LoraEntry {
        id,
        source: src.to_path_buf(),
        size,
        warning: checked.warning,
        notes,
        added_at: crate::store::now_rfc3339(),
        ..base
    })
}

/// A LoRA as one image used it (job record and image metadata).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppliedLora {
    pub id: String,
    pub name: String,
    pub weight: f32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub trigger_words: String,
}

/// The LoRAs a job uses: `requested` ids or names (case-insensitive), in that order. A request
/// without the field (MCP, the HTTP API) uses none: LoRAs are an app feature for now (decided
/// 2026-10-20: no catalog of LoRAs with a clear purpose that an agent could pick). "On by
/// default" is applied by the app, which always sends its list. Also returns notes for the ones
/// skipped.
pub fn resolve(cfg: &AppConfig, requested: Option<&[String]>) -> (Vec<AppliedLora>, Vec<String>) {
    let mut notes = Vec::new();
    let chosen: Vec<&LoraEntry> = match requested {
        None => Vec::new(),
        Some(list) => {
            let mut out: Vec<&LoraEntry> = Vec::new();
            for want in list {
                let w = want.trim();
                match cfg.loras.iter().find(|l| l.id == w).or_else(|| cfg.loras.iter().find(|l| l.name.eq_ignore_ascii_case(w) || l.id.eq_ignore_ascii_case(w))) {
                    Some(l) if !out.iter().any(|o| o.id == l.id) => out.push(l),
                    Some(_) => {}
                    None if !w.is_empty() => notes.push(format!("The LoRA \"{w}\" isn't loaded in Settings → LoRA; made without it.")),
                    None => {}
                }
            }
            out
        }
    };
    let dir = cfg.lora_dir();
    let mut applied = Vec::new();
    for l in chosen {
        if !dir.join(l.file_name()).is_file() {
            notes.push(format!("The LoRA \"{}\" is missing from Kokon's LoRA folder; load it again in Settings → LoRA.", l.name));
        } else if applied.len() == MAX_ACTIVE {
            notes.push(format!("At most {MAX_ACTIVE} LoRAs at once; made without \"{}\".", l.name));
        } else if l.weight != 0.0 {
            applied.push(AppliedLora { id: l.id.clone(), name: l.name.clone(), weight: l.weight, trigger_words: l.trigger_words.trim().to_string() });
        }
    }
    (applied, notes)
}

/// The prompt with the LoRAs' trigger words in front (after the prompt enhancer, so it never
/// rewrites them); words already in the prompt are not added again.
pub fn with_triggers(prompt: &str, loras: &[AppliedLora]) -> String {
    let lower = prompt.to_lowercase();
    let words: Vec<&str> = loras.iter().map(|l| l.trigger_words.trim().trim_end_matches(',').trim()).filter(|w| !w.is_empty() && !lower.contains(&w.to_lowercase())).collect();
    if words.is_empty() {
        return prompt.to_string();
    }
    format!("{}, {prompt}", words.join(", "))
}

/// `sd-server` request entries: paths relative to the LoRA folder.
pub fn request_entries(loras: &[AppliedLora]) -> Vec<crate::sdcpp::LoraParam> {
    loras.iter().map(|l| crate::sdcpp::LoraParam { path: format!("{}.safetensors", l.id), multiplier: l.weight }).collect()
}

/// The file a LoRA entry's copy lives in.
pub fn entry_path(cfg: &AppConfig, l: &LoraEntry) -> PathBuf {
    cfg.lora_dir().join(l.file_name())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A safetensors file with real data: each tensor's bytes are its index repeated.
    fn write_lora(path: &Path, tensors: &[(&str, &[u64])], meta: serde_json::Value) -> Vec<Vec<u8>> {
        let mut head = serde_json::Map::new();
        head.insert("__metadata__".into(), meta);
        let mut data: Vec<u8> = Vec::new();
        let mut blobs = Vec::new();
        for (i, (n, shape)) in tensors.iter().enumerate() {
            let len = shape.iter().product::<u64>() as usize * 2;
            let blob: Vec<u8> = (0..len).map(|j| (i * 7 + j) as u8).collect();
            head.insert(n.to_string(), serde_json::json!({ "dtype": "BF16", "shape": shape, "data_offsets": [data.len(), data.len() + len] }));
            data.extend(&blob);
            blobs.push(blob);
        }
        let h = serde_json::to_vec(&head).unwrap();
        let mut b = (h.len() as u64).to_le_bytes().to_vec();
        b.extend(h);
        b.extend(data);
        std::fs::write(path, b).unwrap();
        blobs
    }

    fn read_tensor(path: &Path, name: &str) -> (Vec<u64>, Vec<u8>) {
        let st = read_header(path).unwrap();
        let t = st.tensors.iter().find(|t| t.name == name).unwrap_or_else(|| panic!("{name} missing"));
        let bytes = std::fs::read(path).unwrap();
        (t.shape.clone(), bytes[(st.data_start + t.start) as usize..(st.data_start + t.end) as usize].to_vec())
    }

    /// The 2.1 Turbo GGUF layout (separate gate_layer / proj), 2 blocks, tiny sizes.
    fn model() -> HashMap<String, Vec<u64>> {
        let mut m = HashMap::new();
        for b in 0..2 {
            m.insert(format!("transformer_blocks.{b}.attn.to_q.weight"), vec![8, 8]);
            m.insert(format!("transformer_blocks.{b}.img_mlp.gate_layer.weight"), vec![16, 8]);
            m.insert(format!("transformer_blocks.{b}.img_mlp.proj.weight"), vec![16, 8]);
        }
        m
    }

    #[test]
    fn splits_fused_gate_up_and_bakes_peft_alpha() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("style.safetensors");
        let peft = serde_json::json!({ "lora_adapter_metadata": "{\"r\": 4, \"lora_alpha\": 8}" });
        let blobs = write_lora(
            &src,
            &[
                ("diffusion_model.transformer_blocks.0.attn.to_q.lora_A.weight", &[4, 8]),
                ("diffusion_model.transformer_blocks.0.attn.to_q.lora_B.weight", &[8, 4]),
                ("diffusion_model.transformer_blocks.0.img_mlp.gate_up.lora_A.weight", &[4, 8]),
                ("diffusion_model.transformer_blocks.0.img_mlp.gate_up.lora_B.weight", &[32, 4]),
            ],
            peft,
        );
        let c = check(&src, &model()).unwrap();
        assert_eq!((c.modules, c.matched, c.fused, c.rank, c.peft_alpha, c.warning.as_deref()), (2, 2, 1, Some(4), Some(8.0), None));

        let dest = dir.path().join("copy.safetensors");
        prepare(&src, &dest).unwrap();
        let p = "diffusion_model.transformer_blocks.0.img_mlp.";
        let (s, gate_up) = read_tensor(&dest, &format!("{p}gate_layer.lora_B.weight"));
        assert_eq!((s, gate_up.as_slice()), (vec![16, 4], &blobs[3][..blobs[3].len() / 2]));
        let (s, proj_up) = read_tensor(&dest, &format!("{p}proj.lora_B.weight"));
        assert_eq!((s, proj_up.as_slice()), (vec![16, 4], &blobs[3][blobs[3].len() / 2..]));
        assert_eq!(read_tensor(&dest, &format!("{p}gate_layer.lora_A.weight")).1, blobs[2]);
        assert_eq!(read_tensor(&dest, &format!("{p}proj.lora_A.weight")).1, blobs[2]);
        assert_eq!(read_tensor(&dest, "diffusion_model.transformer_blocks.0.attn.to_q.lora_B.weight").1, blobs[1]);
        let st = read_header(&dest).unwrap();
        assert!(!st.tensors.iter().any(|t| t.name.contains("gate_up")));
        assert_eq!(st.meta["alpha"], "8");
        assert!(st.meta.contains_key("lora_adapter_metadata"));
        // The engine then reads the alpha from the metadata: nothing left to bake.
        assert_eq!(peft_only_alpha(&st), None);
        assert!(!dir.path().join("copy.safetensors.part").exists());
    }

    #[test]
    fn copies_a_lora_that_needs_nothing_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("a.safetensors");
        write_lora(
            &src,
            &[("lora_unet_transformer_blocks_1_attn_to_q.lora_down.weight", &[2, 8]), ("lora_unet_transformer_blocks_1_attn_to_q.lora_up.weight", &[8, 2]), ("lora_unet_transformer_blocks_1_attn_to_q.alpha", &[])],
            serde_json::json!({}),
        );
        let c = check(&src, &model()).unwrap();
        assert_eq!((c.matched, c.fused, c.peft_alpha), (1, 0, None));
        let dest = dir.path().join("b.safetensors");
        prepare(&src, &dest).unwrap();
        assert_eq!(std::fs::read(&src).unwrap(), std::fs::read(&dest).unwrap());
    }

    #[test]
    fn refuses_loras_for_other_models_and_other_files() {
        let dir = tempfile::tempdir().unwrap();
        // Qwen-Image 1.x: same names, other sizes.
        let old = dir.path().join("old.safetensors");
        write_lora(&old, &[("transformer_blocks.0.attn.to_q.lora_A.weight", &[4, 6]), ("transformer_blocks.0.attn.to_q.lora_B.weight", &[6, 4])], serde_json::json!({}));
        assert!(check(&old, &model()).unwrap_err().message.contains("another model"));
        // Another family: no layer in common.
        let sdxl = dir.path().join("sdxl.safetensors");
        write_lora(&sdxl, &[("lora_unet_down_blocks_0_attn.lora_down.weight", &[4, 8]), ("lora_unet_down_blocks_0_attn.lora_up.weight", &[8, 4])], serde_json::json!({}));
        assert!(check(&sdxl, &model()).unwrap_err().message.contains("None of this LoRA's layers"));
        let te = dir.path().join("te.safetensors");
        write_lora(&te, &[("lora_te_layer.lora_down.weight", &[4, 8]), ("lora_te_layer.lora_up.weight", &[8, 4])], serde_json::json!({}));
        assert!(check(&te, &model()).unwrap_err().message.contains("text encoder"));
        let pt = dir.path().join("x.pt");
        std::fs::write(&pt, b"x").unwrap();
        assert!(check(&pt, &model()).unwrap_err().message.contains(".safetensors"));
        let broken = dir.path().join("broken.safetensors");
        std::fs::write(&broken, [200u8, 0, 0, 0, 0, 0, 0, 0, b'{']).unwrap();
        assert!(check(&broken, &model()).is_err());
    }

    #[test]
    fn warns_when_only_part_fits() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("half.safetensors");
        write_lora(
            &src,
            &[
                ("transformer_blocks.0.attn.to_q.lora_A.weight", &[4, 8]),
                ("transformer_blocks.0.attn.to_q.lora_B.weight", &[8, 4]),
                ("transformer_blocks.0.attn.add_k_proj.lora_A.weight", &[4, 8]),
                ("transformer_blocks.0.attn.add_k_proj.lora_B.weight", &[8, 4]),
            ],
            serde_json::json!({}),
        );
        let c = check(&src, &model()).unwrap();
        assert_eq!((c.modules, c.matched), (2, 1));
        assert!(c.warning.unwrap().contains("Only 1 of its 2 layers"));
    }

    fn entry(id: &str, on: bool, weight: f32, triggers: &str) -> LoraEntry {
        LoraEntry { id: id.into(), name: id.to_uppercase(), on_by_default: on, weight, trigger_words: triggers.into(), ..LoraEntry::default() }
    }

    #[test]
    fn resolves_requested_or_default_loras() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig { sdcpp_dir: dir.path().to_path_buf(), ..AppConfig::default() };
        cfg.loras = vec![entry("film", true, 0.7, "grainscape"), entry("angles", false, 1.0, ""), entry("gone", true, 1.0, ""), entry("off", true, 0.0, "")];
        std::fs::create_dir_all(cfg.lora_dir()).unwrap();
        for id in ["film", "angles", "off"] {
            std::fs::write(cfg.lora_dir().join(format!("{id}.safetensors")), b"x").unwrap();
        }
        // MCP / API requests name no LoRAs: none, whatever is on by default in the app.
        assert_eq!(resolve(&cfg, None), (vec![], vec![]));
        let (on, notes) = resolve(&cfg, Some(&["gone".into(), "film".into()]));
        assert_eq!(on.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(), ["film"]);
        assert!(notes[0].contains("\"GONE\" is missing"));
        let (on, notes) = resolve(&cfg, Some(&["Angles".into(), "film".into(), "film".into(), "nope".into()]));
        assert_eq!(on.iter().map(|l| (l.id.as_str(), l.weight)).collect::<Vec<_>>(), [("angles", 1.0), ("film", 0.7)]);
        assert_eq!(notes, ["The LoRA \"nope\" isn't loaded in Settings → LoRA; made without it."]);
        assert!(resolve(&cfg, Some(&[])).0.is_empty());
        assert_eq!(request_entries(&on)[1], crate::sdcpp::LoraParam { path: "film.safetensors".into(), multiplier: 0.7 });
    }

    #[test]
    fn trigger_words_go_in_front_once() {
        let l = |t: &str| AppliedLora { id: "a".into(), name: "A".into(), weight: 1.0, trigger_words: t.into() };
        assert_eq!(with_triggers("a red fox", &[l("grainscape,"), l(""), l("ohwx style")]), "grainscape, ohwx style, a red fox");
        assert_eq!(with_triggers("GrainScape photo of a fox", &[l("grainscape")]), "GrainScape photo of a fox");
    }

    #[test]
    fn ids_are_unique_file_stems() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("my-style.safetensors"), b"").unwrap();
        let taken: HashSet<String> = ["my-style-2".to_string()].into();
        assert_eq!(new_id("My Style", &taken, dir.path()), "my-style-3");
        assert!(!new_id("???", &HashSet::new(), dir.path()).is_empty());
    }
}
