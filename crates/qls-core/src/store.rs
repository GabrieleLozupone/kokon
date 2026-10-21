//! Local persistence: SQLite gallery of generations, content-addressed input images,
//! and the metadata written into PNG files. Nothing leaves the machine.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::RefineMode;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::geometry::{Expansion, Size};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReferenceRecord {
    pub index: usize,
    /// Content-addressed copy of the reference (always available for reopening).
    pub input_id: String,
    #[serde(default)]
    pub original_path: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// How the pixels were produced beyond a single diffusion pass (Details panel).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct PipelineRecord {
    /// First pass of a two-pass job (the refine ran at `working_*`).
    pub base: Option<Size>,
    pub refine: Option<RefineMode>,
    pub refine_steps: Option<u32>,
    pub refine_denoise: Option<f32>,
    /// Upscaler between the passes ("RealESRGAN_x4plus" or "Lanczos").
    pub hires_upscaler: Option<String>,
    /// EasyCache threshold used for sampling.
    pub cache_threshold: Option<f32>,
    /// How the result was enlarged to its final size, when it was ("RealESRGAN_x4plus" or "Lanczos").
    pub enlarged_with: Option<String>,
    /// Size the content had before the final enlargement.
    pub enlarged_from: Option<Size>,
    /// The diffusion output before that enlargement (PNG in the store's `originals`), kept
    /// so the result can be compared with it or saved without the upscaler.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GenerationRecord {
    pub id: String,
    pub created_at: String,
    pub mode: String,
    /// The prompt the image was made from (the prompt enhancer's when it ran).
    pub prompt: String,
    /// The user's own prompt, when the prompt enhancer rewrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_prompt: Option<String>,
    /// LoRAs the image was made with.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loras: Vec<crate::lora::AppliedLora>,
    pub negative_prompt: String,
    pub seed: i64,
    pub width: u32,
    pub height: u32,
    pub working_width: u32,
    pub working_height: u32,
    pub model: String,
    pub sampler: String,
    pub scheduler: Option<String>,
    pub steps: u32,
    pub cfg: f32,
    pub strength: Option<f32>,
    pub quality: String,
    pub resolution: String,
    pub references: Vec<ReferenceRecord>,
    pub mask_input_id: Option<String>,
    pub outpaint: Option<Expansion>,
    pub file_path: String,
    #[serde(default)]
    pub extra_paths: Vec<String>,
    pub favorite: bool,
    pub parent_id: Option<String>,
    pub duration_ms: u64,
    pub notes: Vec<String>,
    pub app_version: String,
    pub backend_version: Option<String>,
    pub client: Option<String>,
    /// Full original request, for exact "reopen".
    #[serde(default)]
    pub request: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline: Option<PipelineRecord>,
}

impl GenerationRecord {
    /// AUTOMATIC1111-style "parameters" text understood by many image tools.
    pub fn parameters_text(&self) -> String {
        if self.mode == "lut" {
            let lut = &self.request["lut"];
            let pct = (lut["intensity"].as_f64().unwrap_or(1.0) * 100.0).round();
            return format!("Colour LUT: {}, Intensity: {pct}%, Size: {}x{}, Version: Kokon {}", lut["name"].as_str().unwrap_or("?"), self.width, self.height, self.app_version);
        }
        let mut s = self.prompt.clone();
        if !self.negative_prompt.is_empty() {
            s.push_str(&format!("\nNegative prompt: {}", self.negative_prompt));
        }
        s.push_str(&format!(
            "\nSteps: {}, Sampler: {}, Schedule type: {}, CFG scale: {}, Seed: {}, Size: {}x{}, Model: {}",
            self.steps,
            self.sampler,
            self.scheduler.as_deref().unwrap_or("default"),
            self.cfg,
            self.seed,
            self.width,
            self.height,
            self.model
        ));
        if let Some(st) = self.strength {
            s.push_str(&format!(", Denoising strength: {st}"));
        }
        if !self.loras.is_empty() {
            let list: Vec<String> = self.loras.iter().map(|l| format!("{} ({})", l.name.replace([',', ':'], " "), l.weight)).collect();
            s.push_str(&format!(", LoRA: {}", list.join(" + ")));
        }
        if let Some(p) = &self.pipeline
            && let Some(base) = p.base
        {
            let factor = self.working_width as f64 / base.width.max(1) as f64;
            s.push_str(&format!(
                ", Hires upscale: {factor:.2}, Hires steps: {}, Hires upscaler: {}",
                p.refine_steps.unwrap_or(0),
                p.hires_upscaler.as_deref().unwrap_or("Lanczos")
            ));
            if let Some(d) = p.refine_denoise {
                s.push_str(&format!(", Hires denoising strength: {d}"));
            }
        }
        s.push_str(&format!(", Mode: {}, Version: Kokon {}", self.mode, self.app_version));
        s
    }

    pub fn png_text(&self) -> Vec<(&'static str, String)> {
        let mut slim = self.clone();
        slim.request = serde_json::Value::Null;
        if let Some(p) = slim.pipeline.as_mut() {
            p.original_path = None;
        }
        vec![
            ("parameters", self.parameters_text()),
            ("qls:generation", serde_json::to_string(&slim).unwrap_or_default()),
            ("Software", format!("Kokon {}", self.app_version)),
        ]
    }

    pub fn from_png_text(text: &[(String, String)]) -> Option<Self> {
        text.iter().find(|(k, _)| k == "qls:generation").and_then(|(_, v)| serde_json::from_str(v).ok())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InputRecord {
    pub id: String,
    pub path: String,
    pub original_name: Option<String>,
    pub original_path: Option<String>,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub has_alpha: bool,
    pub created_at: String,
    /// HEIC with an ISO 21496-1 HDR gain map.
    #[serde(default)]
    pub hdr: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ListQuery {
    #[serde(default)]
    pub q: Option<String>,
    #[serde(default)]
    pub favorites: bool,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub offset: Option<u32>,
    /// "recent" (default) or "oldest".
    #[serde(default)]
    pub sort: Option<String>,
}

pub struct Store {
    conn: Mutex<Connection>,
    pub data_dir: PathBuf,
}

fn db_err(e: rusqlite::Error) -> AppError {
    AppError::new(ErrorCode::Internal, "The local gallery database reported an error.").detail(e.to_string())
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn new_id() -> String {
    // Time-ordered prefix keeps file listings chronological.
    format!("{}{}", chrono::Utc::now().format("%Y%m%d%H%M%S"), &uuid::Uuid::new_v4().simple().to_string()[..8])
}

impl Store {
    pub fn open(data_dir: &Path) -> AppResult<Self> {
        std::fs::create_dir_all(data_dir.join("inputs")).map_err(|e| AppError::io("create the data folder", data_dir, e))?;
        std::fs::create_dir_all(data_dir.join("thumbs")).map_err(|e| AppError::io("create the data folder", data_dir, e))?;
        let conn = Connection::open(data_dir.join("gallery.db")).map_err(db_err)?;
        Self::init(conn, data_dir)
    }

    pub fn open_in_memory(data_dir: &Path) -> AppResult<Self> {
        Self::init(Connection::open_in_memory().map_err(db_err)?, data_dir)
    }

    fn init(conn: Connection, data_dir: &Path) -> AppResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS generations (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                prompt TEXT NOT NULL,
                mode TEXT NOT NULL,
                favorite INTEGER NOT NULL DEFAULT 0,
                file_path TEXT NOT NULL,
                record TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS gen_created ON generations(created_at);
             CREATE INDEX IF NOT EXISTS gen_fav ON generations(favorite);
             CREATE TABLE IF NOT EXISTS inputs (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                record TEXT NOT NULL
             );",
        )
        .map_err(db_err)?;
        conn.pragma_update(None, "user_version", 1).map_err(db_err)?;
        Ok(Self { conn: Mutex::new(conn), data_dir: data_dir.to_path_buf() })
    }

    /// Forgets every record (used for the temporary private-mode store).
    pub fn clear(&self) -> AppResult<()> {
        self.conn.lock().unwrap().execute_batch("DELETE FROM generations; DELETE FROM inputs;").map_err(db_err)
    }

    pub fn thumb_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("thumbs").join(format!("{id}.jpg"))
    }

    /// The bundled example projects' images ([`crate::examples`]).
    pub fn examples_dir(&self) -> PathBuf {
        self.data_dir.join("examples")
    }

    /// Where a result's pre-enlargement image is kept ([`PipelineRecord::original_path`]).
    pub fn original_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("originals").join(format!("{id}.png"))
    }

    pub fn insert_generation(&self, r: &GenerationRecord) -> AppResult<()> {
        let json = serde_json::to_string(r).map_err(AppError::internal)?;
        self.conn
            .lock()
            .unwrap()
            .execute(
                "INSERT OR REPLACE INTO generations (id, created_at, prompt, mode, favorite, file_path, record) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                params![r.id, r.created_at, r.prompt, r.mode, r.favorite as i32, r.file_path, json],
            )
            .map_err(db_err)?;
        Ok(())
    }

    pub fn get_generation(&self, id: &str) -> AppResult<GenerationRecord> {
        let json: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT record FROM generations WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        let json = json.ok_or_else(|| AppError::new(ErrorCode::NotFound, "That image is no longer in the gallery."))?;
        let mut rec: GenerationRecord = serde_json::from_str(&json).map_err(AppError::internal)?;
        rec.favorite = self.is_favorite(id)?;
        Ok(rec)
    }

    fn is_favorite(&self, id: &str) -> AppResult<bool> {
        let v: Option<i32> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT favorite FROM generations WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        Ok(v.unwrap_or(0) != 0)
    }

    pub fn list_generations(&self, q: &ListQuery) -> AppResult<(Vec<GenerationRecord>, u64)> {
        let limit = q.limit.unwrap_or(60).clamp(1, 500);
        let offset = q.offset.unwrap_or(0);
        let order = if q.sort.as_deref() == Some("oldest") { "ASC" } else { "DESC" };
        let pattern = q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| {
            let esc = s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            format!("%{esc}%")
        });
        let where_ = "WHERE (?1 IS NULL OR prompt LIKE ?1 ESCAPE '\\' OR mode LIKE ?1 ESCAPE '\\') AND (?2 = 0 OR favorite = 1)";
        let conn = self.conn.lock().unwrap();
        let total: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM generations {where_}"), params![pattern, q.favorites as i32], |r| r.get(0))
            .map_err(db_err)?;
        let mut stmt = conn
            .prepare(&format!("SELECT record, favorite FROM generations {where_} ORDER BY created_at {order}, id {order} LIMIT ?3 OFFSET ?4"))
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![pattern, q.favorites as i32, limit, offset], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?)))
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (json, fav) = row.map_err(db_err)?;
            if let Ok(mut rec) = serde_json::from_str::<GenerationRecord>(&json) {
                rec.favorite = fav != 0;
                out.push(rec);
            }
        }
        Ok((out, total.max(0) as u64))
    }

    pub fn set_favorite(&self, id: &str, fav: bool) -> AppResult<()> {
        let n = self.conn.lock().unwrap().execute("UPDATE generations SET favorite = ?2 WHERE id = ?1", params![id, fav as i32]).map_err(db_err)?;
        if n == 0 {
            return Err(AppError::new(ErrorCode::NotFound, "That image is no longer in the gallery."));
        }
        Ok(())
    }

    /// Removes the record, its image file (only if inside the app output folder, or an
    /// example's), thumbnail and pre-upscale original.
    pub fn delete_generation(&self, id: &str, output_root: &Path) -> AppResult<()> {
        let rec = self.get_generation(id)?;
        self.conn.lock().unwrap().execute("DELETE FROM generations WHERE id = ?1", [id]).map_err(db_err)?;
        let f = PathBuf::from(&rec.file_path);
        if crate::paths::is_within(&f, &[output_root.to_path_buf(), self.examples_dir()]) {
            let _ = std::fs::remove_file(&f);
        }
        let _ = std::fs::remove_file(self.thumb_path(id));
        let _ = std::fs::remove_file(self.original_path(id));
        Ok(())
    }

    // ---- inputs -----------------------------------------------------------------------

    /// Stores input bytes content-addressed (deduplicated). Original bytes are kept so
    /// EXIF/ICC survive for reopening.
    pub fn put_input(&self, bytes: &[u8], original_name: Option<&str>, original_path: Option<&str>) -> AppResult<InputRecord> {
        let img = crate::imaging::decode_image(bytes)?;
        let hash = hex::encode(Sha256::digest(bytes));
        let id = hash[..24].to_string();
        if let Ok(existing) = self.get_input(&id)
            && Path::new(&existing.path).is_file()
        {
            return Ok(existing);
        }
        let ext = match img.format {
            "jpeg" => "jpg",
            f => f,
        };
        let path = self.data_dir.join("inputs").join(format!("{id}.{ext}"));
        std::fs::write(&path, bytes).map_err(|e| AppError::io("store the image", &path, e))?;
        let thumb = crate::imaging::thumbnail(&img.pixels, 384);
        if let Ok(j) = crate::imaging::encode_jpeg(&thumb, 85) {
            let _ = std::fs::write(self.data_dir.join("inputs").join(format!("{id}.thumb.jpg")), j);
        }
        if img.format == "heic" {
            // The UI's WebView cannot show HEIC: keep a full-size JPEG to display instead.
            let j = crate::imaging::encode_jpeg(&img.pixels, 92)?;
            std::fs::write(self.input_display_path(&id), j).map_err(|e| AppError::io("store the image", &path, e))?;
        }
        let rec = InputRecord {
            id: id.clone(),
            path: path.to_string_lossy().into_owned(),
            original_name: original_name.map(str::to_owned),
            original_path: original_path.map(str::to_owned),
            width: img.pixels.width(),
            height: img.pixels.height(),
            format: img.format.to_string(),
            has_alpha: img.has_transparency,
            created_at: now_rfc3339(),
            hdr: img.format == "heic" && crate::heif::gain_map(bytes).is_some(),
        };
        let json = serde_json::to_string(&rec).map_err(AppError::internal)?;
        self.conn
            .lock()
            .unwrap()
            .execute("INSERT OR REPLACE INTO inputs (id, created_at, record) VALUES (?1,?2,?3)", params![id, rec.created_at, json])
            .map_err(db_err)?;
        Ok(rec)
    }

    pub fn get_input(&self, id: &str) -> AppResult<InputRecord> {
        if !id.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::new(ErrorCode::NotFound, "Unknown input image."));
        }
        let json: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT record FROM inputs WHERE id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(db_err)?;
        let json = json.ok_or_else(|| AppError::new(ErrorCode::NotFound, "Unknown input image."))?;
        let mut rec: InputRecord = serde_json::from_str(&json).map_err(AppError::internal)?;
        // Records keep absolute paths; after the data folder moved (app renamed, user moved
        // it) the file is found by name in this store's inputs folder.
        if !Path::new(&rec.path).is_file()
            && let Some(name) = Path::new(&rec.path).file_name()
        {
            let here = self.data_dir.join("inputs").join(name);
            if here.is_file() {
                rec.path = here.to_string_lossy().into_owned();
            }
        }
        Ok(rec)
    }

    pub fn input_thumb_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("inputs").join(format!("{id}.thumb.jpg"))
    }

    /// Full-size JPEG shown in the UI for inputs the WebView cannot display (HEIC).
    pub fn input_display_path(&self, id: &str) -> PathBuf {
        self.data_dir.join("inputs").join(format!("{id}.display.jpg"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &str, prompt: &str, created: &str) -> GenerationRecord {
        GenerationRecord {
            id: id.into(),
            created_at: created.into(),
            mode: "generate".into(),
            original_prompt: None,
            loras: vec![],
            prompt: prompt.into(),
            negative_prompt: "blurry".into(),
            seed: 1234,
            width: 1024,
            height: 1024,
            working_width: 1024,
            working_height: 1024,
            model: "qwen-image-2.1-UC-Q4_K_M".into(),
            sampler: "euler".into(),
            scheduler: None,
            steps: 30,
            cfg: 6.0,
            strength: None,
            quality: "balanced".into(),
            resolution: "auto".into(),
            references: vec![ReferenceRecord { index: 0, input_id: "abc".into(), original_path: Some(r"C:\a.png".into()), width: 10, height: 20 }],
            mask_input_id: None,
            outpaint: Some(Expansion { left: 1, right: 2, top: 3, bottom: 4 }),
            file_path: r"C:\out\x.png".into(),
            extra_paths: vec![],
            favorite: false,
            parent_id: None,
            duration_ms: 5000,
            notes: vec!["n".into()],
            app_version: "1.0.0".into(),
            backend_version: Some("commit 3f8527a".into()),
            client: Some("ui".into()),
            request: serde_json::json!({"prompt": prompt}),
            pipeline: None,
        }
    }

    #[test]
    fn pipeline_metadata_roundtrip_and_parameters() {
        let mut r = rec("g2", "a cabin", "2026-10-06T10:00:00.000Z");
        r.working_width = 2048;
        r.working_height = 1152;
        r.pipeline = Some(PipelineRecord {
            base: Some(Size::new(1376, 768)),
            refine: Some(RefineMode::Fast),
            refine_steps: Some(6),
            refine_denoise: Some(0.35),
            hires_upscaler: Some("RealESRGAN_x4plus".into()),
            cache_threshold: Some(0.2),
            enlarged_with: Some("RealESRGAN_x4plus".into()),
            enlarged_from: Some(Size::new(2048, 1152)),
            original_path: None,
        });
        let text = r.png_text();
        let params_ = &text.iter().find(|(k, _)| *k == "parameters").unwrap().1;
        assert!(params_.contains("Hires upscale: 1.49, Hires steps: 6, Hires upscaler: RealESRGAN_x4plus, Hires denoising strength: 0.35"), "{params_}");
        let owned: Vec<(String, String)> = text.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let back = GenerationRecord::from_png_text(&owned).unwrap();
        assert_eq!(back.pipeline, r.pipeline);
        // Records written before this field existed still load.
        let mut v = serde_json::to_value(rec("g3", "x", "t")).unwrap();
        v.as_object_mut().unwrap().remove("pipeline");
        assert_eq!(serde_json::from_value::<GenerationRecord>(v).unwrap().pipeline, None);
    }

    #[test]
    fn metadata_serialization_roundtrip_via_png() {
        let r = rec("g1", "a red fox in snow", "2026-10-06T10:00:00.000Z");
        let img = image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255]));
        let text = r.png_text();
        let pairs: Vec<(&str, &str)> = text.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let png = crate::imaging::encode_png(&img, &pairs, None, true).unwrap();
        let back = crate::imaging::decode_image(&png).unwrap();
        let parsed = GenerationRecord::from_png_text(&back.text).unwrap();
        let mut expected = r.clone();
        expected.request = serde_json::Value::Null;
        assert_eq!(parsed, expected);
        let params_ = back.text.iter().find(|(k, _)| k == "parameters").unwrap().1.clone();
        assert!(params_.starts_with("a red fox in snow\nNegative prompt: blurry\nSteps: 30, Sampler: euler"));
        assert!(params_.contains("Seed: 1234, Size: 1024x1024"));
    }

    #[test]
    fn gallery_crud_search_favorites_sort() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        s.insert_generation(&rec("a", "a red fox", "2026-10-06T10:00:00.000Z")).unwrap();
        s.insert_generation(&rec("b", "blue whale 100%", "2026-10-06T11:00:00.000Z")).unwrap();
        s.insert_generation(&rec("c", "red car", "2026-10-06T12:00:00.000Z")).unwrap();
        let (all, total) = s.list_generations(&ListQuery::default()).unwrap();
        assert_eq!(total, 3);
        assert_eq!(all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["c", "b", "a"]);
        let (red, _) = s.list_generations(&ListQuery { q: Some("red".into()), ..Default::default() }).unwrap();
        assert_eq!(red.len(), 2);
        let (pct, _) = s.list_generations(&ListQuery { q: Some("100%".into()), ..Default::default() }).unwrap();
        assert_eq!(pct.len(), 1, "LIKE wildcards are escaped");
        s.set_favorite("a", true).unwrap();
        let (fav, n) = s.list_generations(&ListQuery { favorites: true, ..Default::default() }).unwrap();
        assert_eq!((fav.len(), n, fav[0].favorite), (1, 1, true));
        let (old, _) = s.list_generations(&ListQuery { sort: Some("oldest".into()), limit: Some(1), ..Default::default() }).unwrap();
        assert_eq!(old[0].id, "a");
        assert!(s.get_generation("a").unwrap().favorite);
        s.delete_generation("a", dir.path()).unwrap();
        assert_eq!(s.get_generation("a").unwrap_err().code, ErrorCode::NotFound);
        assert!(s.set_favorite("zzz", true).is_err());
        // Reopen persists.
        drop(s);
        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.list_generations(&ListQuery::default()).unwrap().1, 2);
        assert_eq!(s.get_generation("c").unwrap().references[0].input_id, "abc");
    }

    #[test]
    fn inputs_are_deduplicated() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(dir.path()).unwrap();
        let img = image::RgbaImage::from_pixel(30, 20, image::Rgba([5, 6, 7, 255]));
        let png = crate::imaging::encode_png(&img, &[], None, true).unwrap();
        let a = s.put_input(&png, Some("x.png"), None).unwrap();
        let b = s.put_input(&png, Some("y.png"), None).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!((a.width, a.height), (30, 20));
        assert!(Path::new(&a.path).is_file());
        assert!(s.input_thumb_path(&a.id).is_file());
        assert!(s.get_input("../../etc").is_err());
        assert!(s.put_input(b"garbage", None, None).is_err());
    }
}
