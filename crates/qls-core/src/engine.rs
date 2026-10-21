//! The application engine shared by every front end (desktop UI, HTTP API, MCP):
//! a queue of generation jobs executed one at a time against sd-server, with truthful
//! progress, cancellation, automatic VRAM mitigation, and gallery persistence.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use image::GrayImage;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, broadcast};

use crate::config::{AppConfig, LoraEntry};
use crate::diagnostics::{GpuInfo, query_gpus};
use crate::enhancer;
use crate::error::{AppError, AppResult, ErrorCode, translate_generation_failure};
use crate::geometry::Size;
use crate::imaging::{self, LoadedImage};
use crate::lora::{self, AppliedLora};
use crate::paths;
use crate::pipeline;
use crate::planner::{self, GenerationRequest, Mode, OutputFormat, Plan, PlanInputs, ResolutionMode, ResolvedMode};
use crate::process::{BackendProgress, BackendStage, ProgressParser, ServerManager, ServerState};
use crate::sdcpp::{BackendJobStatus, CancelOutcome, Capabilities, SdcppClient, UpscaleRequest};
use crate::store::{GenerationRecord, InputRecord, PipelineRecord, ReferenceRecord, Store, new_id, now_rfc3339};

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    StartingBackend,
    Preparing,
    /// The prompt enhancer is writing the prompt (`JobView::enhanced_prompt` grows).
    EnhancingPrompt,
    Running,
    Saving,
    Done,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

/// A LoRA as the app lists it.
#[derive(Debug, Clone, Serialize)]
pub struct LoraView {
    #[serde(flatten)]
    pub entry: LoraEntry,
    /// Kokon's copy is in the LoRA folder.
    pub available: bool,
}

/// Settings of a LoRA to change; missing fields stay as they are.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoraPatch {
    pub name: Option<String>,
    pub weight: Option<f32>,
    pub trigger_words: Option<String>,
    pub on_by_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobView {
    pub id: String,
    pub status: JobStatus,
    /// Backend-reported stage while running (None if the backend gives no detail).
    pub stage: Option<BackendStage>,
    pub step: Option<(u32, u32)>,
    pub image: Option<(u32, u32)>,
    pub seconds_per_step: Option<f32>,
    pub queue_position: usize,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub prompt: String,
    /// The prompt enhancer's text: partial while `EnhancingPrompt`, then the prompt the image
    /// is made from (`prompt` stays the user's). None when the enhancer did not run or failed.
    pub enhanced_prompt: Option<String>,
    pub client: Option<String>,
    pub plan: Option<Plan>,
    pub seed: Option<i64>,
    pub results: Vec<GenerationRecord>,
    pub error: Option<AppError>,
    pub notes: Vec<String>,
    /// True when progress comes from the server log (we launched it).
    pub detailed_progress: bool,
}

struct Job {
    view: JobView,
    request: GenerationRequest,
    cancel: bool,
    retried_oom: bool,
    workspace: Option<PathBuf>,
    /// The prompt enhancer's finished text, kept for a retry (out of memory).
    enhanced: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Job { job: Box<JobView> },
    Server { state: ServerState, owned: bool, error: Option<AppError> },
    Gallery { id: String, change: &'static str },
}

pub struct Engine {
    cfg: RwLock<AppConfig>,
    pub server: Arc<ServerManager>,
    pub store: Arc<Store>,
    /// Private mode: records in memory, files under `private_dir`; wiped by `clear_private`,
    /// at start and at exit. Never listed in the gallery.
    pub private_store: Arc<Store>,
    /// Measured speed of this machine, for time estimates.
    speed: crate::speed::SpeedBook,
    data_dir: PathBuf,
    private_dir: PathBuf,
    jobs: Mutex<HashMap<String, Job>>,
    order: Mutex<VecDeque<String>>,
    active: Mutex<Option<String>>,
    wake: Notify,
    pub events: broadcast::Sender<Event>,
    gpus: Mutex<(Option<Instant>, Vec<GpuInfo>)>,
    /// `--list-devices` of the engine, keyed by its path and modification time.
    devices: Mutex<Option<DeviceList>>,
    /// First-run downloads (setup wizard).
    pub installer: Arc<crate::installer::Installer>,
    backend_version: Mutex<Option<String>>,
    last_activity: Mutex<Instant>,
}

/// An engine's path, its modification time and its `--list-devices` output.
type DeviceList = (PathBuf, Option<std::time::SystemTime>, Vec<(String, String)>);

fn random_seed() -> i64 {
    let b = uuid::Uuid::new_v4();
    let v = u32::from_le_bytes(b.as_bytes()[..4].try_into().unwrap());
    (v & 0x7fff_ffff) as i64
}

/// Runs CPU-heavy image work off the async runtime.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(AppError::internal)?
}

/// How results are enlarged (from the plan and the settings).
#[derive(Debug, Clone, Copy)]
struct EnlargeOptions {
    /// Upscaler tile size in px (0 = server default).
    tile: u32,
    /// Share of the upscaler's result kept over Lanczos (`AppConfig::upscale_blend`).
    blend: f32,
    /// Shrink the input first (`AppConfig::upscale_prescale`).
    prescale: bool,
}

/// Planner inputs from the configuration and measured facts.
pub fn plan_inputs(cfg: &AppConfig, image_sizes: Vec<Size>, mask: Option<(Size, Option<crate::geometry::Rect>, f64)>, vram_total_mib: Option<u64>) -> PlanInputs {
    PlanInputs {
        image_sizes,
        mask,
        vram_total_mib,
        upscale_tile: crate::planner::upscale_tile(cfg.upscale_tile_size, vram_total_mib, &cfg.upscaler().map(|u| u.0).unwrap_or_default()),
        upscaler: cfg.upscaler().map(|u| u.0),
        metal: cfg.gpu_backend == crate::config::GpuBackend::Metal,
        server_vae_tiling: cfg.vae_tile_size > 0,
        sage_attention: cfg.uses_sage_attention(),
        speed_factor: None,
        hide_uncalibrated: !crate::speed::trust_uncalibrated(cfg),
        unified_memory: false,
    }
}

impl Engine {
    pub fn new(cfg: AppConfig, data_dir: &Path) -> AppResult<Arc<Self>> {
        let store = Arc::new(Store::open(data_dir)?);
        let private_dir = data_dir.join("private");
        // Leftovers of a crash or forced exit while private mode was on.
        let _ = std::fs::remove_dir_all(&private_dir);
        for sub in ["inputs", "thumbs", "out"] {
            std::fs::create_dir_all(private_dir.join(sub)).map_err(|e| AppError::io("create the data folder", &private_dir, e))?;
        }
        let private_store = Arc::new(Store::open_in_memory(&private_dir)?);
        let (events, _) = broadcast::channel(512);
        Ok(Arc::new(Self {
            cfg: RwLock::new(cfg),
            server: ServerManager::new(data_dir.to_path_buf()),
            store,
            private_store,
            speed: if cfg!(test) { crate::speed::SpeedBook::in_memory() } else { crate::speed::SpeedBook::open(data_dir) },
            data_dir: data_dir.to_path_buf(),
            private_dir,
            jobs: Mutex::new(HashMap::new()),
            order: Mutex::new(VecDeque::new()),
            active: Mutex::new(None),
            wake: Notify::new(),
            events,
            gpus: Mutex::new((None, Vec::new())),
            devices: Mutex::new(None),
            installer: crate::installer::Installer::new(),
            backend_version: Mutex::new(None),
            last_activity: Mutex::new(Instant::now()),
        }))
    }

    pub fn config(&self) -> AppConfig {
        let mut cfg = self.cfg.read().unwrap().clone();
        cfg.sage_unsupported = self.lacks_sage_attention(&cfg);
        cfg
    }

    /// The card `cfg` runs the CUDA engine on can't run SageAttention. Uses the cached card
    /// list (queried once if empty) and engine devices, never `config()` or an engine probe.
    fn lacks_sage_attention(&self, cfg: &AppConfig) -> bool {
        if cfg.gpu_backend != crate::config::GpuBackend::Cuda {
            return false;
        }
        let cached = {
            let g = self.gpus.lock().unwrap();
            g.0.is_some().then(|| g.1.clone())
        };
        let cards = cached.unwrap_or_else(|| self.gpus());
        let i = if cards.len() < 2 {
            0
        } else {
            let devices = self.devices.lock().unwrap().as_ref().map(|d| d.2.clone()).unwrap_or_default();
            crate::diagnostics::card_for_device(&devices, &cards, &cfg.effective_device(), cfg.gpu_backend.device_prefix()).unwrap_or(0)
        };
        cards.get(i).is_some_and(GpuInfo::lacks_sage_attention)
    }

    /// Replaces the configuration. Returns true when the backend must restart.
    pub fn set_config(&self, mut new: AppConfig) -> AppResult<bool> {
        // LoRAs change only through `set_loras` (a Settings save may carry an older list).
        new.loras = self.cfg.read().unwrap().loras.clone();
        // The official profile follows the folder and preset; see `AppConfig::normalize`.
        new.normalize();
        new.validate()?;
        new.save()?;
        new.sage_unsupported = self.lacks_sage_attention(&new);
        let mut g = self.cfg.write().unwrap();
        g.sage_unsupported = self.lacks_sage_attention(&g);
        let restart = crate::process::build_server_args(&g, g.profile()) != crate::process::build_server_args(&new, new.profile())
            || g.sdcpp_dir != new.sdcpp_dir
            || g.gpu_backend != new.gpu_backend;
        // The engine's version is probed again only when another build is in use.
        if g.server_exe() != new.server_exe() {
            *self.backend_version.lock().unwrap() = None;
        }
        *g = new;
        drop(g);
        self.place_bundled_upscaler();
        Ok(restart)
    }

    /// Replaces the LoRA list (callers hold `lora::LIBRARY`).
    fn set_loras(&self, loras: Vec<LoraEntry>) -> AppResult<()> {
        let mut new = self.config();
        new.loras = loras;
        new.save()?;
        self.cfg.write().unwrap().loras = new.loras;
        Ok(())
    }

    /// Loads a LoRA file the user picked (blocking: checks it and writes Kokon's copy). Loading
    /// the same file again refreshes the copy and keeps its settings.
    pub fn add_lora(&self, src: &Path) -> AppResult<LoraEntry> {
        let _lock = lora::LIBRARY.lock().unwrap_or_else(|e| e.into_inner());
        let cfg = self.config();
        let existing = cfg.loras.iter().find(|l| l.source == src);
        let entry = lora::import(&cfg, src, existing)?;
        let mut list = cfg.loras.clone();
        match list.iter_mut().find(|l| l.id == entry.id) {
            Some(l) => *l = entry.clone(),
            None => list.push(entry.clone()),
        }
        self.set_loras(list)?;
        Ok(entry)
    }

    /// Changes a LoRA's settings (name, weight, trigger words, on by default).
    pub fn update_lora(&self, id: &str, patch: LoraPatch) -> AppResult<LoraEntry> {
        let _lock = lora::LIBRARY.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = self.config().loras;
        let l = list.iter_mut().find(|l| l.id == id).ok_or_else(|| AppError::new(ErrorCode::NotFound, "This LoRA is no longer loaded."))?;
        if let Some(n) = patch.name {
            let n = n.trim();
            if n.is_empty() {
                return Err(AppError::invalid("Give the LoRA a name."));
            }
            l.name = n.chars().take(80).collect();
        }
        if let Some(w) = patch.weight {
            if !w.is_finite() || !(-2.0..=2.0).contains(&w) {
                return Err(AppError::invalid("A LoRA's strength goes from -2 to 2."));
            }
            l.weight = (w * 100.0).round() / 100.0;
        }
        if let Some(t) = patch.trigger_words {
            l.trigger_words = t.trim().chars().take(500).collect();
        }
        if let Some(on) = patch.on_by_default {
            l.on_by_default = on;
        }
        let out = l.clone();
        self.set_loras(list)?;
        Ok(out)
    }

    /// Removes a LoRA and Kokon's copy of it (the user's own file stays).
    pub fn remove_lora(&self, id: &str) -> AppResult<()> {
        let _lock = lora::LIBRARY.lock().unwrap_or_else(|e| e.into_inner());
        let cfg = self.config();
        let Some(l) = cfg.loras.iter().find(|l| l.id == id) else { return Ok(()) };
        let path = lora::entry_path(&cfg, l);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::io("delete", &path, e)),
        }
        self.set_loras(cfg.loras.iter().filter(|l| l.id != id).cloned().collect())
    }

    /// The loaded LoRAs, with whether Kokon's copy is still there.
    pub fn loras(&self) -> Vec<LoraView> {
        let cfg = self.config();
        cfg.loras.iter().map(|l| LoraView { available: lora::entry_path(&cfg, l).is_file(), entry: l.clone() }).collect()
    }

    /// Copies the upscaler shipped with the app into the configured folder when it is missing
    /// there (new install, another folder chosen). Failures leave it to the setup download.
    pub fn place_bundled_upscaler(&self) {
        let Some(bundle) = crate::installer::bundle_dir() else { return };
        let dir = self.config().sdcpp_dir;
        match crate::installer::install_bundled(&crate::catalog::UPSCALER, &dir, &bundle) {
            Ok(true) => tracing::info!("bundled upscaler copied into {}", dir.display()),
            Ok(false) => {}
            Err(e) => tracing::warn!("could not copy the bundled upscaler into {}: {e}", dir.display()),
        }
    }

    /// Deletes the original VAE from the app's folder once the texture fix replaced it and no
    /// profile uses it (after the update, and at start in case a busy server held it open).
    pub fn remove_unused_original_vae(&self) {
        let Some(old) = crate::catalog::unused_original_vae(&self.config()) else { return };
        match std::fs::remove_file(&old) {
            Ok(()) => tracing::info!("deleted the original VAE {} (replaced by the texture fix)", old.display()),
            Err(e) => tracing::warn!("could not delete the original VAE {} yet: {e}", old.display()),
        }
    }

    /// The installed engine is from another release than the catalog's (or the engine
    /// manifest's): Setup offers the update. An engine without a release marker (built by hand,
    /// an external server) only needs it when it cannot run the upscaler.
    pub fn engine_update_needed(&self) -> bool {
        let cfg = self.config();
        let engines = crate::catalog::engine_downloads(cfg.gpu_backend);
        if engines.iter().all(|d| d.is_present(&cfg.sdcpp_dir)) {
            return false;
        }
        let managed = engines.iter().any(|d| d.engine_tag.is_some() && d.installed_tag(&cfg.sdcpp_dir).is_some());
        managed || !self.server.capabilities().is_some_and(|c| c.has_upscaler(crate::catalog::UPSCALER_NAME, true))
    }

    /// The store holding generation `id`: the gallery, or the private-mode store.
    pub fn gen_store(&self, id: &str) -> &Arc<Store> {
        if self.store.get_generation(id).is_err() && self.private_store.get_generation(id).is_ok() { &self.private_store } else { &self.store }
    }

    /// The store holding input `id` (see [`Self::gen_store`]).
    pub fn input_store(&self, id: &str) -> &Arc<Store> {
        if self.store.get_input(id).is_err() && self.private_store.get_input(id).is_ok() { &self.private_store } else { &self.store }
    }

    /// Where a generation's image file may be deleted from: the output folder, or the
    /// private folder for private results.
    pub fn output_root(&self, id: &str) -> PathBuf {
        if Arc::ptr_eq(self.gen_store(id), &self.private_store) { self.private_dir.join("out") } else { self.config().output_dir }
    }

    /// Ends private mode: forgets every private record and deletes its files.
    pub fn clear_private(&self) -> AppResult<usize> {
        let (items, _) = self.private_store.list_generations(&crate::store::ListQuery { limit: Some(500), ..Default::default() })?;
        self.private_store.clear()?;
        let mut removed = 0;
        for sub in ["inputs", "thumbs", "out"] {
            let dir = self.private_dir.join(sub);
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    if std::fs::remove_file(e.path()).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        if !items.is_empty() {
            tracing::info!("private mode cleared ({} results, {removed} files)", items.len());
        }
        Ok(items.len())
    }

    pub fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        self.last_activity.lock().unwrap().elapsed()
    }

    pub fn has_pending_work(&self) -> bool {
        self.active.lock().unwrap().is_some() || self.jobs.lock().unwrap().values().any(|j| !j.view.status.is_terminal()) || self.installer.is_running()
    }

    /// Every graphics card found (refreshed every few seconds for the live memory use).
    pub fn gpus(&self) -> Vec<GpuInfo> {
        let mut g = self.gpus.lock().unwrap();
        if !g.0.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            *g = (Some(Instant::now()), query_gpus().unwrap_or_default());
        }
        g.1.clone()
    }

    /// The engine's devices (`--list-devices`); empty until the engine is installed.
    pub fn devices(&self) -> Vec<(String, String)> {
        let exe = self.config().server_exe();
        let mtime = std::fs::metadata(&exe).and_then(|m| m.modified()).ok();
        if mtime.is_none() {
            return Vec::new();
        }
        let mut d = self.devices.lock().unwrap();
        if let Some((p, t, list)) = d.as_ref()
            && *p == exe
            && *t == mtime
        {
            return list.clone();
        }
        let list = crate::diagnostics::list_devices(&exe);
        *d = Some((exe, mtime, list.clone()));
        list
    }

    /// Index in `gpus()` of the card the engine runs on (the configured device); the first
    /// card when there is one or the engine can't tell.
    pub fn gpu_index(&self) -> usize {
        let cards = self.gpus();
        if cards.len() < 2 {
            return 0;
        }
        let cfg = self.config();
        crate::diagnostics::card_for_device(&self.devices(), &cards, &cfg.effective_device(), cfg.gpu_backend.device_prefix()).unwrap_or(0)
    }

    /// The card the engine runs on; plans and presets are sized for it.
    pub fn gpu(&self) -> Option<GpuInfo> {
        let i = self.gpu_index();
        self.gpus().into_iter().nth(i)
    }

    /// Runs the engine on card `card` of `gpus()`: Some(whether the server must restart), or
    /// None if the engine can't list its devices yet (not installed) or doesn't see that card.
    pub fn use_card(&self, card: usize) -> AppResult<Option<bool>> {
        let mut cfg = self.config();
        let Some(dev) = crate::diagnostics::device_for_card(&self.devices(), &self.gpus(), card, cfg.gpu_backend.device_prefix()) else {
            return Ok(None);
        };
        if cfg.effective_device() == dev {
            return Ok(Some(false));
        }
        cfg.device = dev;
        self.set_config(cfg).map(Some)
    }

    pub fn backend_version(&self) -> Option<String> {
        if let Some(v) = self.backend_version.lock().unwrap().clone() {
            return Some(v);
        }
        let v = crate::diagnostics::backend_version(&self.config().server_exe());
        *self.backend_version.lock().unwrap() = v.clone();
        v
    }

    fn emit_job(&self, id: &str) {
        if let Some(v) = self.job(id) {
            let _ = self.events.send(Event::Job { job: Box::new(v) });
        }
    }

    pub fn emit_server(&self) {
        let s = self.server.status();
        let _ = self.events.send(Event::Server { state: s.state, owned: s.owned, error: s.error });
    }

    fn update(&self, id: &str, f: impl FnOnce(&mut Job)) {
        {
            let mut jobs = self.jobs.lock().unwrap();
            if let Some(j) = jobs.get_mut(id) {
                f(j);
            }
        }
        self.emit_job(id);
    }

    fn queue_positions(&self) {
        let order = self.order.lock().unwrap();
        let mut jobs = self.jobs.lock().unwrap();
        let mut pos = 0;
        for id in order.iter() {
            if let Some(j) = jobs.get_mut(id)
                && j.view.status == JobStatus::Queued
            {
                pos += 1;
                j.view.queue_position = pos;
            }
        }
    }

    pub fn job(&self, id: &str) -> Option<JobView> {
        self.jobs.lock().unwrap().get(id).map(|j| j.view.clone())
    }

    pub fn jobs(&self) -> Vec<JobView> {
        let order = self.order.lock().unwrap();
        let jobs = self.jobs.lock().unwrap();
        order.iter().filter_map(|id| jobs.get(id).map(|j| j.view.clone())).collect()
    }

    pub fn active_job(&self) -> Option<JobView> {
        let id = self.active.lock().unwrap().clone()?;
        self.job(&id)
    }

    /// Validates cheaply and enqueues. `workspace` is the caller's project folder (MCP),
    /// used to resolve relative paths and as an allowed output root.
    pub fn submit(&self, mut request: GenerationRequest, workspace: Option<PathBuf>) -> AppResult<JobView> {
        self.touch();
        let upscale = request.mode == Mode::Upscale;
        // Removing a painted area needs no description (the planner writes the prompt).
        let removal = request.mask.is_some() && request.inpaint_action == planner::InpaintAction::Remove;
        if request.prompt.trim().is_empty() && !upscale && !removal {
            return Err(AppError::invalid("Describe what to generate or change."));
        }
        if upscale && request.images.is_empty() {
            return Err(AppError::invalid("Choose an image to upscale."));
        }
        if request.images.len() > 16 {
            return Err(AppError::invalid("Too many images."));
        }
        // A model file on a drive that is not connected, moved or deleted: say so now, so the
        // app can guide the user (Setup), instead of failing once the job starts. Also with the
        // model loaded: sd-server opens the files again for every image.
        if let Some(e) = self.config().missing_files_error() {
            return Err(e);
        }
        if let Some(seed) = request.seed
            && seed < 0
        {
            request.seed = None;
        }
        let id = format!("job_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let view = JobView {
            id: id.clone(),
            status: JobStatus::Queued,
            stage: None,
            step: None,
            image: None,
            seconds_per_step: None,
            queue_position: 0,
            created_at: now_rfc3339(),
            started_at: None,
            finished_at: None,
            prompt: if upscale && request.prompt.trim().is_empty() { "Upscale".into() } else { request.prompt.clone() },
            enhanced_prompt: None,
            client: request.client.clone(),
            plan: None,
            seed: request.seed,
            results: vec![],
            error: None,
            notes: vec![],
            detailed_progress: false,
        };
        {
            let mut jobs = self.jobs.lock().unwrap();
            jobs.insert(id.clone(), Job { view, request, cancel: false, retried_oom: false, workspace, enhanced: None });
            let mut order = self.order.lock().unwrap();
            order.push_back(id.clone());
            // Keep memory bounded: drop the oldest finished jobs.
            while order.len() > 300 {
                let Some(pos) = order.iter().position(|i| jobs.get(i).map(|j| j.view.status.is_terminal()).unwrap_or(true)) else { break };
                if let Some(old) = order.remove(pos) {
                    jobs.remove(&old);
                }
            }
        }
        self.queue_positions();
        self.emit_job(&id);
        self.wake.notify_one();
        Ok(self.job(&id).unwrap())
    }

    /// Requests cancellation. Queued jobs stop immediately; a running job is stopped as
    /// soon as the backend allows (see `run_job`).
    pub fn cancel(&self, id: &str) -> AppResult<JobView> {
        let status = self.job(id).ok_or_else(|| AppError::new(ErrorCode::NotFound, "Unknown job."))?.status;
        if status.is_terminal() {
            return Ok(self.job(id).unwrap());
        }
        self.update(id, |j| {
            j.cancel = true;
            if j.view.status == JobStatus::Queued {
                j.view.status = JobStatus::Cancelled;
                j.view.finished_at = Some(now_rfc3339());
            }
        });
        self.queue_positions();
        Ok(self.job(id).unwrap())
    }

    /// Cancels every unfinished job submitted by `client` (e.g. "ui" when the desktop app
    /// closes). A running job stops the owned server, which frees the GPU right away.
    pub fn cancel_client_jobs(&self, client: &str) -> usize {
        let ids: Vec<String> = {
            let jobs = self.jobs.lock().unwrap();
            jobs.values().filter(|j| !j.view.status.is_terminal() && j.view.client.as_deref() == Some(client)).map(|j| j.view.id.clone()).collect()
        };
        for id in &ids {
            let _ = self.cancel(id);
        }
        ids.len()
    }

    fn next_queued(&self) -> Option<String> {
        let order = self.order.lock().unwrap();
        let jobs = self.jobs.lock().unwrap();
        order.iter().find(|id| jobs.get(*id).map(|j| j.view.status == JobStatus::Queued).unwrap_or(false)).cloned()
    }

    /// Worker loop: one job at a time (the GPU is the bottleneck); the queue keeps order.
    pub async fn run_worker(self: Arc<Self>) {
        loop {
            let Some(id) = self.next_queued() else {
                self.wake.notified().await;
                continue;
            };
            *self.active.lock().unwrap() = Some(id.clone());
            self.queue_positions();
            let r = self.clone().run_job(&id).await;
            if let Err(e) = r {
                let cancelled = self.jobs.lock().unwrap().get(&id).map(|j| j.cancel).unwrap_or(false);
                self.update(&id, |j| {
                    if cancelled || e.code == ErrorCode::Cancelled {
                        j.view.status = JobStatus::Cancelled;
                    } else {
                        j.view.status = JobStatus::Failed;
                        j.view.error = Some(e.clone());
                    }
                    j.view.finished_at = Some(now_rfc3339());
                    j.view.stage = None;
                });
                if !cancelled {
                    tracing::warn!("job {id} failed: {} {:?}", e.message, e.detail);
                }
            }
            *self.active.lock().unwrap() = None;
            self.touch();
        }
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.jobs.lock().unwrap().get(id).map(|j| j.cancel).unwrap_or(true)
    }

    fn check_cancel(&self, id: &str) -> AppResult<()> {
        if self.is_cancelled(id) { Err(AppError::new(ErrorCode::Cancelled, "Cancelled.")) } else { Ok(()) }
    }

    /// Loads one image source: "input:<id>", "gen:<id>" or an absolute path. A private job
    /// keeps its copy of the input in the private store.
    pub fn resolve_source(&self, src: &str, workspace: Option<&Path>, private: bool) -> AppResult<(LoadedImage, InputRecord)> {
        let (bytes, original_path, name) = self.read_source(src, workspace)?;
        let store = if private { &self.private_store } else { &self.store };
        let rec = store.put_input(&bytes, name.as_deref(), original_path.as_deref())?;
        let img = imaging::decode_image(&bytes)?;
        Ok((img, rec))
    }

    /// The bytes of an image source, with its original path and file name.
    fn read_source(&self, src: &str, workspace: Option<&Path>) -> AppResult<(Vec<u8>, Option<String>, Option<String>)> {
        Ok(if let Some(id) = src.strip_prefix("input:") {
            let rec = self.input_store(id).get_input(id)?;
            let b = std::fs::read(&rec.path).map_err(|e| AppError::io("read the stored image", Path::new(&rec.path), e))?;
            (b, rec.original_path.clone(), rec.original_name.clone())
        } else if let Some(id) = src.strip_prefix("gen:") {
            let rec = self.gen_store(id).get_generation(id)?;
            let p = PathBuf::from(&rec.file_path);
            let b = std::fs::read(&p).map_err(|e| AppError::io("read the generated image", &p, e))?;
            (b, Some(rec.file_path.clone()), p.file_name().map(|n| n.to_string_lossy().into_owned()))
        } else {
            let p = paths::validate_input_image(src, workspace, &[])?;
            let b = std::fs::read(&p).map_err(|e| AppError::io("read the image", &p, e))?;
            (b, Some(p.to_string_lossy().into_owned()), p.file_name().map(|n| n.to_string_lossy().into_owned()))
        })
    }

    /// The colour LUTs the user has opened (`<data>/luts`).
    pub fn luts(&self) -> crate::lut::LutLibrary {
        crate::lut::LutLibrary::new(self.data_dir.join("luts"))
    }

    /// A library LUT on a "gen:"/"input:" source at full strength, reduced to `max_side`, for
    /// the live preview (the UI shows the intensity as its opacity over the image). JPEG, or
    /// PNG when the image has transparency or a colour profile to keep. Returns the content type.
    pub fn lut_preview(&self, src: &str, name: &str, max_side: u32) -> AppResult<(Vec<u8>, &'static str)> {
        if !src.starts_with("gen:") && !src.starts_with("input:") {
            return Err(AppError::new(ErrorCode::InvalidInput, "LUTs apply to results and imported images."));
        }
        let lut = self.luts().load(name)?;
        let img = imaging::decode_image(&self.read_source(src, None)?.0)?;
        let small = lut.apply(&imaging::thumbnail(&img.pixels, max_side.clamp(256, 4096)), 1.0);
        if img.has_transparency || img.icc_profile.is_some() {
            Ok((imaging::encode_png(&small, &[], img.icc_profile.as_deref(), true)?, "image/png"))
        } else {
            Ok((imaging::encode_jpeg(&small, 92)?, "image/jpeg"))
        }
    }

    /// Applies a library LUT to a "gen:"/"input:" source at `intensity` (0-1) and saves the
    /// result as a new version made from it (mode "lut"; the source stays as it is). Private
    /// when asked or when the source itself is private. Same file format as a source result.
    pub fn apply_lut(&self, src: &str, name: &str, intensity: f32, private: bool) -> AppResult<GenerationRecord> {
        let started = Instant::now();
        let library = self.luts();
        let lut = library.load(name)?;
        let parent = match src.strip_prefix("gen:") {
            Some(id) => Some(self.gen_store(id).get_generation(id)?),
            None if src.starts_with("input:") => None,
            None => return Err(AppError::new(ErrorCode::InvalidInput, "LUTs apply to results and imported images.")),
        };
        let source_private = match (&parent, src.strip_prefix("input:")) {
            (Some(p), _) => Arc::ptr_eq(self.gen_store(&p.id), &self.private_store),
            (None, Some(id)) => Arc::ptr_eq(self.input_store(id), &self.private_store),
            _ => false,
        };
        let private = private || source_private;
        let (img, input) = self.resolve_source(src, None, private)?;
        let intensity = if intensity.is_finite() { intensity.clamp(0.0, 1.0) } else { 1.0 };
        let out = lut.apply(&img.pixels, intensity);
        library.touch(name);

        let cfg = self.config();
        let id = new_id();
        let now = chrono::Local::now();
        let store = if private { &self.private_store } else { &self.store };
        let dir = if private { self.private_dir.join("out") } else { cfg.output_dir.join(now.format("%Y-%m-%d").to_string()) };
        std::fs::create_dir_all(&dir).map_err(|e| AppError::io("create the output folder", &dir, e))?;
        let format = match parent.as_ref().and_then(|p| Path::new(&p.file_path).extension()).map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
            Some("jpg" | "jpeg") => OutputFormat::Jpeg,
            Some("webp") => OutputFormat::Webp,
            _ => OutputFormat::Png,
        };
        let file = paths::unique_path(dir.join(format!("{}-lut-{}.{}", now.format("%H%M%S"), paths::sanitize_file_stem(name), format.ext())), &[]);
        let pct = (intensity * 100.0).round();
        let mut rec = GenerationRecord {
            id: id.clone(),
            created_at: now_rfc3339(),
            mode: "lut".into(),
            prompt: String::new(),
            original_prompt: None,
            loras: vec![],
            negative_prompt: String::new(),
            seed: parent.as_ref().map(|p| p.seed).unwrap_or(0),
            width: out.width(),
            height: out.height(),
            working_width: out.width(),
            working_height: out.height(),
            model: String::new(),
            sampler: String::new(),
            scheduler: None,
            steps: 0,
            cfg: 0.0,
            strength: None,
            quality: String::new(),
            resolution: String::new(),
            references: vec![ReferenceRecord { index: 0, input_id: input.id.clone(), original_path: input.original_path.clone(), width: input.width, height: input.height }],
            mask_input_id: None,
            outpaint: None,
            file_path: file.to_string_lossy().into_owned(),
            extra_paths: vec![],
            favorite: false,
            parent_id: parent.as_ref().map(|p| p.id.clone()),
            duration_ms: 0,
            notes: vec![format!("Colour LUT \"{name}\" at {pct} %.")],
            app_version: APP_VERSION.into(),
            backend_version: None,
            client: None,
            request: serde_json::json!({
                "mode": "lut",
                "images": [src],
                "parent_id": parent.as_ref().map(|p| p.id.clone()),
                "lut": { "name": name, "title": lut.title, "intensity": intensity },
                "private": private,
            }),
            pipeline: None,
        };
        rec.duration_ms = started.elapsed().as_millis() as u64;
        write_atomic(&file, &encode_output(&out, format, &rec, img.icc_profile.as_deref())?)?;
        if let Ok(j) = imaging::encode_jpeg(&imaging::thumbnail(&out, 512), 85) {
            let _ = std::fs::write(store.thumb_path(&id), j);
        }
        store.insert_generation(&rec)?;
        if !private {
            let _ = self.events.send(Event::Gallery { id: id.clone(), change: "added" });
        }
        Ok(rec)
    }

    /// How this machine's measured speed compares with the time model (None: not measured).
    fn speed_factor(&self, cfg: &AppConfig) -> Option<f32> {
        self.speed.get(&crate::speed::machine_key(cfg, self.gpu().as_ref())).map(|c| c.factor)
    }

    /// VRAM to plan with: the card's (or the simulated size), less what the user's own model
    /// files take beyond the official ones the budgets were measured with.
    fn planning_vram(&self, cfg: &AppConfig) -> Option<u64> {
        let gpu = self.gpu();
        let unified = gpu.as_ref().is_some_and(|g| g.unified);
        cfg.planning_vram_mib(gpu.map(|g| g.planning_mib())).map(|v| v.saturating_sub(cfg.model_vram_extra_mib(unified)))
    }

    /// Dry run: the plan a request would get (used by the UI to show working sizes).
    pub fn preview_plan(&self, req: &GenerationRequest, sizes: Vec<Size>, mask: Option<(Size, Option<crate::geometry::Rect>, f64)>) -> AppResult<Plan> {
        let cfg = self.config();
        let vram = self.planning_vram(&cfg);
        let mut inputs = plan_inputs(&cfg, sizes, mask, vram);
        inputs.speed_factor = self.speed_factor(&cfg);
        inputs.unified_memory = self.gpu().is_some_and(|g| g.unified);
        planner::plan(req, &inputs, &cfg.profile().recommended_settings)
    }

    async fn run_job(self: Arc<Self>, id: &str) -> AppResult<()> {
        let started = Instant::now();
        let (request, workspace) = {
            let jobs = self.jobs.lock().unwrap();
            let j = jobs.get(id).ok_or_else(|| AppError::internal("job vanished"))?;
            (j.request.clone(), j.workspace.clone())
        };
        self.update(id, |j| {
            j.view.status = JobStatus::Preparing;
            j.view.started_at = Some(now_rfc3339());
            j.view.queue_position = 0;
        });
        // A file that went missing while the job was queued (see `submit`).
        if let Some(e) = self.config().missing_files_error() {
            return Err(e);
        }

        // 1. Load inputs (off the async runtime: decoding large photos is CPU work).
        let this = self.clone();
        let req2 = request.clone();
        let ws = workspace.clone();
        let (images, inputs_meta, mask) = tokio::task::spawn_blocking(move || -> AppResult<_> {
            let mut images = Vec::new();
            let mut metas = Vec::new();
            for s in &req2.images {
                let (img, rec) = this.resolve_source(s, ws.as_deref(), req2.private)?;
                images.push(img);
                metas.push(rec);
            }
            let mask = match &req2.mask {
                Some(m) => {
                    let (img, rec) = this.resolve_source(m, ws.as_deref(), req2.private)?;
                    Some((imaging::mask_from_image(&img), rec))
                }
                None => None,
            };
            Ok((images, metas, mask))
        })
        .await
        .map_err(AppError::internal)??;
        self.check_cancel(id)?;

        // 2. Plan.
        let cfg = self.config();
        let profile = cfg.profile().clone();
        let vram = self.planning_vram(&cfg);
        let mask_info = mask.as_ref().map(|(m, _)| (Size::new(m.width(), m.height()), imaging::mask_bbox(m, 16), imaging::mask_coverage(m, 16)));
        let mut plan_inputs = plan_inputs(&cfg, images.iter().map(|i| i.size()).collect(), mask_info, vram);
        plan_inputs.speed_factor = self.speed_factor(&cfg);
        plan_inputs.unified_memory = self.gpu().is_some_and(|g| g.unified);
        let plan = planner::plan(&request, &plan_inputs, &profile.recommended_settings)?;
        let seed = request.seed.unwrap_or_else(random_seed);
        let mut request = request;
        if plan.mode == ResolvedMode::Upscale && request.prompt.trim().is_empty() {
            request.prompt = self.upscale_prompt(&request);
        }
        self.update(id, |j| {
            j.view.plan = Some(plan.clone());
            j.view.seed = Some(seed);
            j.view.notes = plan.notes.clone();
        });

        // 3. Backend.
        // A job that also starts the server is not a fair speed sample (startup, first load).
        let model_loaded = self.server.capabilities().is_some_and(|c| c.model_matches(&profile.diffusion_model));
        let mut cold_start = false;
        if self.server.status().state != ServerState::Ready || self.server.owned_alive() == Some(false) || !model_loaded {
            cold_start = true;
            self.update(id, |j| j.view.status = JobStatus::StartingBackend);
            self.emit_server();
            let r = self.server.ensure_ready(&cfg).await;
            self.emit_server();
            r?;
        }
        self.check_cancel(id)?;
        self.update(id, |j| j.view.status = JobStatus::Preparing);

        // Whether the running server can use the upscaler (an engine older than MoSR lists the
        // file but cannot run it; an external server may lack --hires-upscalers-dir):
        // enlargements fall back to Lanczos. Fresh, because the server rescans the folder.
        let client = SdcppClient::new(self.server.port());
        let caps = client.capabilities(Duration::from_secs(5)).await.ok().or_else(|| self.server.capabilities()).unwrap_or_default();
        let esrgan = plan.upscaler.clone().filter(|n| caps.has_upscaler(n, true));
        let needs_esrgan = plan.upscale.is_some() || plan.output.area() as f64 > plan.content.area() as f64 * 1.21;
        if needs_esrgan && plan.upscaler.is_some() && esrgan.is_none() {
            self.update(id, |j| j.view.notes.push("The inference engine cannot run the upscaler (update it in Setup); enlarged with Lanczos.".into()));
        } else if plan.upscaler.is_none() && needs_esrgan && cfg.upscaler_model.trim() != crate::config::LANCZOS {
            self.update(id, |j| j.view.notes.push("The upscaler model is missing (install it in Setup); enlarged with Lanczos.".into()));
        }
        let quick_upscale = plan.upscale.is_some();
        let icc = images.first().and_then(|i| i.icc_profile.clone());
        let mut enhanced: Option<String> = None;
        let mut loras: Vec<AppliedLora> = Vec::new();

        let (contents, post) = if quick_upscale {
            // No diffusion: the source itself is enlarged.
            let src = images.into_iter().next().ok_or_else(|| AppError::invalid("Choose an image to upscale."))?;
            let size = src.size();
            let post = pipeline::PostProcess {
                kind: pipeline::PostKind::Plain,
                keep_alpha: true,
                working: size,
                content: crate::geometry::Rect::new(0, 0, size.width, size.height),
                output: plan.output,
                mode: plan.mode,
                outpaint: None,
            };
            (vec![src.pixels], post)
        } else {
            // 4. Build the request (CPU work).
            let plan2 = plan.clone();
            let prompt = request.prompt.clone();
            let mask_img: Option<GrayImage> = mask.as_ref().map(|(m, _)| m.clone());
            let opts = pipeline::BackendOptions { server_vae_tile_size: cfg.vae_tile_size };
            let prepared = tokio::task::spawn_blocking(move || pipeline::prepare(&plan2, &prompt, seed, &images, mask_img.as_ref(), &opts))
                .await
                .map_err(AppError::internal)??;
            let pipeline::PreparedJob { request: mut sd_req, post } = prepared;

            // 4b. Prompt enhancer: rewrites the user's prompt, looking at the references
            // exactly as the image model gets them.
            if request.enhance && enhancer::applies(plan.mode) {
                enhanced = self.enhance_prompt(id, &client, &caps, &cfg, plan.mode, &request.prompt, &sd_req.ref_images, seed).await?;
                if let Some(text) = &enhanced {
                    sd_req.prompt = pipeline::enhanced_prompt(&request.prompt, text);
                }
            }

            // 4c. The user's LoRAs, trigger words in front of the final prompt.
            loras = self.job_loras(id, &cfg, &request, &caps);
            if !loras.is_empty() {
                sd_req.prompt = lora::with_triggers(&sd_req.prompt, &loras);
                sd_req.lora = lora::request_entries(&loras);
            }

            // 5. Submit and follow.
            let mut lines = self.server.subscribe_lines();
            let detailed = self.server.status().owned;
            let submitted = Instant::now();
            let accepted = client.submit(&sd_req).await?;
            drop(sd_req); // release the base64 payloads
            self.update(id, |j| {
                j.view.status = JobStatus::Running;
                j.view.detailed_progress = detailed;
            });
            let mut parser = ProgressParser::default();
            let mut job_log: Vec<String> = Vec::new();
            let mut last_poll = Instant::now() - Duration::from_secs(10);
            let backend_job = loop {
                // Drain log lines -> truthful stage/step.
                loop {
                    match lines.try_recv() {
                        Ok(l) => {
                            if job_log.len() < 4000 {
                                job_log.push(l.clone());
                            }
                            if let Some(p) = parser.feed(&l) {
                                self.apply_progress(id, p);
                            }
                        }
                        Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
                if self.is_cancelled(id) {
                    return self.cancel_running(id, &client, &accepted.id, &self.config()).await;
                }
                if last_poll.elapsed() >= Duration::from_millis(500) {
                    last_poll = Instant::now();
                    match client.job(&accepted.id).await {
                        Ok(bj) => match bj.status {
                            BackendJobStatus::Completed | BackendJobStatus::Failed | BackendJobStatus::Cancelled => break bj,
                            BackendJobStatus::Queued if !detailed => self.update(id, |j| j.view.stage = None),
                            BackendJobStatus::Generating if !detailed => self.update(id, |j| j.view.stage = Some(BackendStage::Generating)),
                            _ => {}
                        },
                        Err(e) => {
                            if self.server.owned_alive() == Some(false) {
                                let tail = self.server.log.tail(30).join("\n");
                                self.server.mark_lost(AppError::new(ErrorCode::ServerCrashed, "The inference server stopped unexpectedly."));
                                self.emit_server();
                                let mut err = translate_generation_failure("server process exited", &tail, (plan.working.width, plan.working.height), None);
                                if err.code == ErrorCode::GenerationFailed {
                                    err = AppError::new(ErrorCode::ServerCrashed, "The inference server stopped unexpectedly.")
                                        .suggest("It will restart automatically on the next job.")
                                        .detail(tail);
                                }
                                return self.maybe_retry_oom(id, err).await;
                            }
                            if e.code == ErrorCode::NotFound {
                                return Err(AppError::new(ErrorCode::GenerationFailed, "The inference server lost track of the job (it may have restarted)."));
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(120)).await;
            };

            match backend_job.status {
                BackendJobStatus::Completed => {}
                BackendJobStatus::Cancelled => return Err(AppError::new(ErrorCode::Cancelled, "Cancelled.")),
                _ => {
                    let msg = backend_job.error.map(|e| format!("{}: {}", e.code, e.message)).unwrap_or_default();
                    let smaller = Size::new(((plan.working.width as f64) * 0.75) as u32 / 32 * 32, ((plan.working.height as f64) * 0.75) as u32 / 32 * 32);
                    let err = translate_generation_failure(&msg, &job_log.join("\n"), (plan.working.width, plan.working.height), Some((smaller.width, smaller.height)));
                    return self.maybe_retry_oom(id, err).await;
                }
            }
            // LoRAs slow each step (~19 % for one at 0.7 on Q4_K): not a speed sample.
            if !cold_start && loras.is_empty() {
                let key = crate::speed::machine_key(&cfg, self.gpu().as_ref());
                let predicted = planner::backend_seconds(&plan, cfg.uses_sage_attention());
                if let Some(f) = self.speed.record(&key, submitted.elapsed().as_secs_f32(), predicted) {
                    tracing::info!("speed calibration {key}: x{f:.2}");
                }
            }
            let result = backend_job.result.unwrap_or_default();
            if result.images.is_empty() {
                return Err(AppError::new(ErrorCode::GenerationFailed, "The inference server returned no image."));
            }
            let post = Arc::new(post);
            let mut contents = Vec::with_capacity(result.images.len());
            for im in result.images {
                let p = post.clone();
                contents.push(
                    blocking(move || {
                        let raw = imaging::decode_image(&crate::sdcpp::b64_decode(&im.b64_json)?)?.pixels;
                        Ok(pipeline::crop_content(raw, &p))
                    })
                    .await?,
                );
            }
            (contents, Arc::try_unwrap(post).map_err(|_| AppError::internal("post-process still shared"))?)
        };

        // 6. Enlarge (ESRGAN), post-process and save.
        let post = Arc::new(post);
        let duration_start = started;
        let mask_rec = mask.map(|(_, r)| r);
        let mut records = Vec::with_capacity(contents.len());
        let count = contents.len() as u32;
        for (i, content) in contents.into_iter().enumerate() {
            let before = Size::new(content.width(), content.height());
            let target = pipeline::enlarge_target(&post);
            // Kept when the upscaler enlarges it, so the user can still see and save it.
            let original = target.map(|_| content.clone());
            let how = EnlargeOptions { tile: plan.upscale_tile, blend: cfg.upscale_blend, prescale: cfg.upscale_prescale };
            let (content, enlarged_with) = self.enlarge(id, &client, content, target, esrgan.as_deref(), how, (i as u32 + 1, count)).await?;
            let original = original.filter(|_| enlarged_with.is_some());
            self.update(id, |j| {
                j.view.status = JobStatus::Saving;
                j.view.stage = None;
            });
            let pipeline_rec = PipelineRecord {
                base: None,
                refine: None,
                refine_steps: None,
                refine_denoise: None,
                hires_upscaler: None,
                cache_threshold: None,
                enlarged_from: enlarged_with.is_some().then_some(before),
                enlarged_with,
                original_path: None, // set when the original is saved
            };
            let this = self.clone();
            let mut plan3 = plan.clone();
            // Notes added while running (fallbacks, retries) belong in the record too.
            if let Some(j) = self.job(id) {
                plan3.notes = j.notes;
            }
            let (p, req3, inputs3, mask3, icc3, ws, enh3, loras3) = (post.clone(), request.clone(), inputs_meta.clone(), mask_rec.clone(), icc.clone(), workspace.clone(), enhanced.clone(), loras.clone());
            let rec = blocking(move || {
                let final_img = pipeline::finish(content, &p)?;
                let duration_ms = duration_start.elapsed().as_millis() as u64;
                let pipeline = (pipeline_rec != PipelineRecord::default()).then_some(pipeline_rec);
                this.save_result(&final_img, &req3, &plan3, seed + i as i64, &inputs3, mask3.as_ref(), icc3.as_deref(), duration_ms, ws.as_deref(), i, pipeline, original.as_ref(), enh3, loras3)
            })
            .await?;
            if !request.private {
                let _ = self.events.send(Event::Gallery { id: rec.id.clone(), change: "added" });
            }
            records.push(rec);
        }
        self.update(id, |j| {
            j.view.status = JobStatus::Done;
            j.view.results = records;
            j.view.finished_at = Some(now_rfc3339());
            j.view.stage = None;
        });
        Ok(())
    }

    /// The LoRAs job `id` uses (see `lora::resolve`); skipped ones are noted on the job.
    fn job_loras(&self, id: &str, cfg: &AppConfig, request: &GenerationRequest, caps: &Capabilities) -> Vec<AppliedLora> {
        let (loras, notes) = lora::resolve(cfg, request.loras.as_deref());
        let (loras, notes) = if !loras.is_empty() && !caps.img_feature("lora") {
            (Vec::new(), vec!["This inference engine can't use LoRAs (update it in Setup); made without them.".to_string()])
        } else {
            (loras, notes)
        };
        if !notes.is_empty() {
            self.update(id, |j| j.view.notes.extend(notes));
        }
        loras
    }

    /// Runs the prompt enhancer for job `id` and streams its text into the job. Returns the
    /// new prompt, or None when the job keeps the user's prompt: the engine cannot write text,
    /// or the enhancer failed (both noted on the job). Errors only for a cancel or a crash.
    #[allow(clippy::too_many_arguments)]
    async fn enhance_prompt(&self, id: &str, client: &SdcppClient, caps: &Capabilities, cfg: &AppConfig, mode: ResolvedMode, prompt: &str, images: &[String], seed: i64) -> AppResult<Option<String>> {
        // A retry after running out of memory keeps the first prompt.
        if let Some(done) = self.jobs.lock().unwrap().get(id).and_then(|j| j.enhanced.clone()) {
            return Ok(Some(done));
        }
        if !caps.text_generation {
            self.update(id, |j| j.view.notes.push("This inference engine has no prompt enhancer (update it in Setup); your prompt was used as written.".into()));
            return Ok(None);
        }
        self.update(id, |j| {
            j.view.status = JobStatus::EnhancingPrompt;
            j.view.stage = None;
            j.view.enhanced_prompt = Some(String::new());
        });
        let req = enhancer::request(cfg, mode, prompt, images.to_vec(), seed);
        let started = Instant::now();
        let mut text = String::new();
        let mut last_emit = Instant::now();
        let on_delta = |d: &str| {
            text.push_str(d);
            // The UI follows the text at ~10 updates a second.
            if last_emit.elapsed() >= Duration::from_millis(100) {
                last_emit = Instant::now();
                let partial = text.clone();
                self.update(id, |j| j.view.enhanced_prompt = Some(partial));
            }
        };
        let r = client.text_gen(&req, Duration::from_secs(300), on_delta, || self.is_cancelled(id)).await;
        let failure = match r {
            Ok(done) => match enhancer::clean(&done.text) {
                Some(t) => {
                    tracing::info!("prompt enhancer: {} tokens in {:.1} s ({}, seed {})", done.usage.completion_tokens, started.elapsed().as_secs_f32(), done.finish_reason, done.seed);
                    let cut = done.finish_reason == "length";
                    self.update(id, |j| {
                        j.view.enhanced_prompt = Some(t.clone());
                        j.enhanced = Some(t.clone());
                        if cut {
                            j.view.notes.push("The prompt enhancer reached its length limit; its prompt may end abruptly.".into());
                        }
                    });
                    return Ok(Some(t));
                }
                None => "it wrote nothing".to_string(),
            },
            Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
            Err(e) => {
                if self.server.owned_alive() == Some(false) {
                    let tail = self.server.log.tail(30).join("\n");
                    self.server.mark_lost(AppError::new(ErrorCode::ServerCrashed, "The inference server stopped unexpectedly."));
                    self.emit_server();
                    return Err(AppError::new(ErrorCode::ServerCrashed, "The inference server stopped while writing the prompt.")
                        .suggest("It will restart automatically on the next job. Turn the prompt enhancer off if it happens again.")
                        .detail(tail));
                }
                tracing::warn!("prompt enhancer failed: {} {:?}", e.message, e.detail);
                e.detail.clone().map(|d| format!("{} {d}", e.message)).unwrap_or(e.message)
            }
        };
        self.update(id, |j| {
            j.view.enhanced_prompt = None;
            j.view.notes.push(format!("The prompt enhancer failed ({}); your prompt was used as written.", failure.trim_end_matches('.')));
        });
        Ok(None)
    }

    /// Label of an upscale request that has no prompt: the source's own prompt, if any.
    fn upscale_prompt(&self, req: &GenerationRequest) -> String {
        let source = req.images.first().and_then(|s| s.strip_prefix("gen:")).and_then(|g| self.gen_store(g).get_generation(g).ok());
        match source {
            Some(g) if !g.prompt.trim().is_empty() => g.prompt,
            _ => "Upscaled image".into(),
        }
    }

    /// Enlarges `content` with the upscaler model when [`pipeline::finish`] would resize it
    /// up to `target` by more than ~1.1x. Returns the (possibly larger) content and how the
    /// enlargement is done; upscaler failures fall back to Lanczos with a note. `image` is
    /// (this image, images in the batch), for the progress.
    #[allow(clippy::too_many_arguments)]
    async fn enlarge(&self, id: &str, client: &SdcppClient, content: image::RgbaImage, target: Option<Size>, esrgan: Option<&str>, how: EnlargeOptions, image: (u32, u32)) -> AppResult<(image::RgbaImage, Option<String>)> {
        let Some(target) = target else { return Ok((content, None)) };
        let size = Size::new(content.width(), content.height());
        let factor = (target.width as f64 / size.width as f64).max(target.height as f64 / size.height as f64);
        if factor <= pipeline::ESRGAN_MIN_FACTOR {
            return Ok((content, None));
        }
        let Some(name) = esrgan else { return Ok((content, Some("Lanczos".into()))) };
        self.update(id, |j| {
            j.view.status = JobStatus::Running;
            j.view.stage = Some(BackendStage::Upscaling);
            j.view.step = None;
            j.view.image = Some(image);
            j.view.seconds_per_step = None;
        });
        let content = Arc::new(content);
        let r = self.esrgan_enlarge(id, client, content.clone(), target, name, how).await;
        let r = match r {
            Ok(Some(img)) if how.blend < 1.0 => {
                let src = content.clone();
                blocking(move || Ok(pipeline::blend_with_lanczos(img, &src, how.blend))).await.map(Some)
            }
            r => r,
        };
        let content = Arc::try_unwrap(content).unwrap_or_else(|a| (*a).clone());
        match r {
            Ok(Some(img)) => Ok((img, Some(name.to_string()))),
            Ok(None) => Ok((content, None)),
            Err(e) if e.code == ErrorCode::Cancelled => Err(e),
            Err(e) => {
                tracing::warn!("upscaler failed, using Lanczos: {} {:?}", e.message, e.detail);
                self.update(id, |j| j.view.notes.push(format!("Upscaler model failed ({}); enlarged with Lanczos.", e.message)));
                Ok((content, Some("Lanczos".into())))
            }
        }
    }

    async fn esrgan_enlarge(&self, id: &str, client: &SdcppClient, content: Arc<image::RgbaImage>, target: Size, upscaler: &str, how: EnlargeOptions) -> AppResult<Option<image::RgbaImage>> {
        // Requests are sized for the x4 model; the server tiles each one at `how.tile` px.
        let size = Size::new(content.width(), content.height());
        let input = if how.prescale { pipeline::prescale_size(size, target, 4) } else { size };
        let Some(ep) = pipeline::esrgan_plan(input, target, 4) else { return Ok(None) };
        let tile_px = how.tile;
        let c = content.clone();
        let input = Arc::new(blocking(move || Ok(imaging::resize(&c, ep.input.width, ep.input.height))).await?);
        let mut stitcher = pipeline::Stitcher::new(ep.input);
        // Tiles are the upscaler's steps: (done, total) and the measured time per tile.
        let total = ep.tiles.len() as u32;
        self.update(id, |j| j.view.step = Some((0, total)));
        let started = Instant::now();
        for (k, tile) in ep.tiles.iter().enumerate() {
            self.check_cancel(id)?;
            let (inp, t) = (input.clone(), *tile);
            let png = blocking(move || pipeline::tile_png_b64(&inp, &t)).await?;
            let resp = client.upscale(&UpscaleRequest { image: png, upscaler: Some(upscaler.to_string()), tile_size: (tile_px > 0).then_some(tile_px), output_format: "png".into() }).await?;
            let up = blocking(move || imaging::decode_engine_image(&crate::sdcpp::b64_decode(&resp.images[0].b64_json)?, pipeline::ESRGAN_MAX_OUTPUT_SIDE)).await?;
            stitcher.add(tile, &up)?;
            let done = k as u32 + 1;
            let per_tile = started.elapsed().as_secs_f32() / done as f32;
            self.update(id, |j| {
                j.view.step = Some((done, total));
                j.view.seconds_per_step = Some(per_tile);
            });
        }
        Ok(Some(blocking(move || stitcher.finish(&content)).await?))
    }

    fn apply_progress(&self, id: &str, p: BackendProgress) {
        self.update(id, |j| {
            j.view.stage = Some(p.stage);
            j.view.step = p.step;
            j.view.image = p.image;
            j.view.seconds_per_step = p.seconds_per_step;
        });
    }

    async fn cancel_running(&self, id: &str, client: &SdcppClient, backend_id: &str, cfg: &AppConfig) -> AppResult<()> {
        match client.cancel(backend_id).await {
            Ok(CancelOutcome::Cancelled) | Ok(CancelOutcome::AlreadyFinished) | Ok(CancelOutcome::NotFound) => {}
            Ok(CancelOutcome::NotInterruptible) | Err(_) => {
                // This sd-server build cannot interrupt a running job. If we own the
                // process, restart it to free the GPU now; otherwise the result is discarded.
                if self.server.status().owned {
                    self.update(id, |j| j.view.notes.push("Stopping the inference server to cancel immediately.".into()));
                    self.server.stop().await;
                    self.emit_server();
                    let this_cfg = cfg.clone();
                    let srv = self.server.clone();
                    let has_more = self.next_queued().is_some();
                    if has_more {
                        tokio::spawn(async move {
                            let _ = srv.ensure_ready(&this_cfg).await;
                        });
                    }
                } else {
                    self.update(id, |j| j.view.notes.push("The external server will finish this image; the result is discarded.".into()));
                }
            }
        }
        Err(AppError::new(ErrorCode::Cancelled, "Cancelled."))
    }

    /// One automatic retry for out-of-memory: enable VAE tiling, then lower resolution.
    async fn maybe_retry_oom(&self, id: &str, err: AppError) -> AppResult<()> {
        let can_retry = err.code == ErrorCode::OutOfMemory && !self.jobs.lock().unwrap().get(id).map(|j| j.retried_oom).unwrap_or(true);
        if !can_retry {
            return Err(err);
        }
        self.update(id, |j| {
            j.retried_oom = true;
            let tiled = j.view.plan.as_ref().map(|p| p.vae_tiling).unwrap_or(false);
            j.request.advanced.vae_tiling = Some(true);
            if tiled {
                j.request.resolution = match j.request.resolution {
                    ResolutionMode::K2 | ResolutionMode::Source | ResolutionMode::Custom => ResolutionMode::K15,
                    _ => ResolutionMode::K1,
                };
                j.request.width = None;
                j.request.height = None;
                j.view.notes.push("Ran out of GPU memory; retrying at a lower resolution.".into());
            } else {
                j.view.notes.push("Ran out of GPU memory; retrying with memory optimization.".into());
            }
            j.view.status = JobStatus::Queued;
            j.view.stage = None;
            j.view.step = None;
        });
        // Re-queue at the front.
        {
            let mut order = self.order.lock().unwrap();
            if let Some(pos) = order.iter().position(|x| x == id) {
                order.remove(pos);
            }
            order.push_front(id.to_string());
        }
        self.wake.notify_one();
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn save_result(
        &self,
        img: &image::RgbaImage,
        req: &GenerationRequest,
        plan: &Plan,
        seed: i64,
        inputs: &[InputRecord],
        mask: Option<&InputRecord>,
        icc: Option<&[u8]>,
        duration_ms: u64,
        workspace: Option<&Path>,
        index: usize,
        mut pipeline: Option<PipelineRecord>,
        original: Option<&image::RgbaImage>,
        enhanced_prompt: Option<String>,
        loras: Vec<AppliedLora>,
    ) -> AppResult<GenerationRecord> {
        let cfg = self.config();
        let id = new_id();
        let now = chrono::Local::now();
        let store = if req.private { &self.private_store } else { &self.store };
        let dir = if req.private { self.private_dir.join("out") } else { cfg.output_dir.join(now.format("%Y-%m-%d").to_string()) };
        std::fs::create_dir_all(&dir).map_err(|e| AppError::io("create the output folder", &dir, e))?;
        let words: Vec<&str> = req.prompt.split_whitespace().take(6).collect();
        let stem = format!("{}-{}-{seed}", now.format("%H%M%S"), paths::sanitize_file_stem(&words.join(" ")));
        // HDR from a HEIC source forces an Ultra HDR JPEG; otherwise the requested format.
        let (hdr, hdr_note) = hdr_for(img, req, plan, inputs);
        let format = if hdr.is_some() { OutputFormat::Jpeg } else { plan.output_format };
        let file = paths::unique_path(dir.join(format!("{stem}.{}", format.ext())), &[]);

        if let Some(o) = original {
            let path = store.original_path(&id);
            let saved = (|| {
                if let Some(d) = path.parent() {
                    std::fs::create_dir_all(d).map_err(|e| AppError::io("create the originals folder", d, e))?;
                }
                write_atomic(&path, &imaging::encode_png(o, &[], icc, true)?)
            })();
            match (saved, pipeline.as_mut()) {
                (Ok(()), Some(p)) => p.original_path = Some(path.to_string_lossy().into_owned()),
                (Err(e), _) => tracing::warn!("could not keep the pre-upscale image of {id}: {} {:?}", e.message, e.detail),
                _ => {}
            }
        }

        let mode = match plan.mode {
            ResolvedMode::Generate => "generate",
            ResolvedMode::Edit => "edit",
            ResolvedMode::Inpaint => "inpaint",
            ResolvedMode::Outpaint => "outpaint",
            ResolvedMode::MultiReference => "multi_reference",
            ResolvedMode::Upscale => "upscale",
        };
        let mut rec = GenerationRecord {
            id: id.clone(),
            created_at: now_rfc3339(),
            mode: mode.into(),
            // An enhanced job records the prompt the image was made from, and the user's.
            original_prompt: enhanced_prompt.is_some().then(|| req.prompt.clone()),
            prompt: enhanced_prompt.unwrap_or_else(|| req.prompt.clone()),
            loras,
            negative_prompt: plan.negative_prompt.clone(),
            seed,
            width: img.width(),
            height: img.height(),
            working_width: plan.working.width,
            working_height: plan.working.height,
            model: cfg.profile().model_name(),
            sampler: plan.sampler.clone(),
            scheduler: None,
            steps: plan.steps,
            cfg: plan.cfg,
            strength: plan.strength,
            quality: serde_json::to_value(plan.quality).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
            resolution: serde_json::to_value(plan.resolution).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
            references: inputs
                .iter()
                .enumerate()
                .map(|(i, r)| ReferenceRecord { index: i, input_id: r.id.clone(), original_path: r.original_path.clone(), width: r.width, height: r.height })
                .collect(),
            mask_input_id: mask.map(|m| m.id.clone()),
            outpaint: plan.outpaint.map(|o| o.expansion),
            file_path: file.to_string_lossy().into_owned(),
            extra_paths: vec![],
            favorite: false,
            parent_id: req.parent_id.clone(),
            duration_ms,
            notes: plan.notes.clone(),
            app_version: APP_VERSION.into(),
            backend_version: self.backend_version.lock().unwrap().clone(),
            client: req.client.clone(),
            request: serde_json::to_value(req).unwrap_or_default(),
            pipeline,
        };
        rec.notes.extend(hdr_note);
        let bytes = match &hdr {
            Some(gm) => crate::hdr::encode_ultra_hdr(img, icc, gm, 95).map_err(|e| AppError::new(ErrorCode::Internal, "Failed to encode the HDR JPEG.").detail(e))?,
            None => encode_output(img, format, &rec, icc)?,
        };
        write_atomic(&file, &bytes)?;

        // Optional copy to a caller-chosen path (MCP / API), validated and never overwriting.
        if let Some(out) = &req.output_path {
            let mut roots = vec![cfg.output_dir.clone()];
            if let Some(w) = workspace {
                roots.push(w.to_path_buf());
            }
            let input_paths: Vec<PathBuf> = inputs.iter().filter_map(|r| r.original_path.as_ref().map(PathBuf::from)).collect();
            let raw = if index == 0 { out.clone() } else { numbered(out, index) };
            let target = paths::resolve_output_path(&raw, workspace, &roots, &input_paths)?;
            if let Some(d) = target.parent() {
                std::fs::create_dir_all(d).map_err(|e| AppError::io("create the output folder", d, e))?;
            }
            let ext = target.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            let fmt = match ext.as_str() {
                "jpg" | "jpeg" => OutputFormat::Jpeg,
                "webp" => OutputFormat::Webp,
                _ => OutputFormat::Png,
            };
            let data = if fmt == format { bytes.clone() } else { encode_output(img, fmt, &rec, icc)? };
            write_atomic(&target, &data)?;
            rec.extra_paths.push(target.to_string_lossy().into_owned());
        }
        drop(bytes);
        let thumb = imaging::thumbnail(img, 512);
        if let Ok(j) = imaging::encode_jpeg(&thumb, 85) {
            let _ = std::fs::write(store.thumb_path(&id), j);
        }
        store.insert_generation(&rec)?;
        Ok(rec)
    }
}

/// The gain map to attach when the source is an HDR HEIC and the user kept HDR on
/// (`advanced.hdr`, default on), plus a note saying what happened. Only for results that
/// keep the source's framing (edit, inpaint, upscale); every failure falls back to SDR.
fn hdr_for(img: &image::RgbaImage, req: &GenerationRequest, plan: &Plan, inputs: &[InputRecord]) -> (Option<crate::hdr::GainMap>, Option<String>) {
    let Some(src) = inputs.first().filter(|r| r.format == "heic" && r.hdr) else { return (None, None) };
    if req.advanced.hdr == Some(false) {
        return (None, None);
    }
    if !matches!(plan.mode, ResolvedMode::Edit | ResolvedMode::Inpaint | ResolvedMode::Upscale) {
        return (None, Some("HDR not kept: only edits, inpainting and upscales keep the source's framing.".into()));
    }
    if !crate::hdr::same_framing((src.width, src.height), img.dimensions()) {
        return (None, Some("HDR not kept: the result's framing differs from the HEIC source.".into()));
    }
    let Some(ffmpeg) = crate::hdr::find_ffmpeg() else {
        return (None, Some("HDR not kept: ffmpeg was not found on PATH (needed to read the HEIC gain map).".into()));
    };
    let attempt = || -> Result<(crate::hdr::GainMap, f32), String> {
        let path = Path::new(&src.path);
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        let info = crate::heif::gain_map(&bytes).ok_or("no ISO 21496-1 gain map")?;
        let gm = crate::hdr::read_heic_gain_map(&ffmpeg, path, &info)?;
        let base = imaging::decode_image(&bytes).map_err(|e| e.message)?.pixels;
        if !crate::hdr::same_framing(base.dimensions(), gm.image.dimensions()) {
            return Err("gain map and image disagree on orientation".into());
        }
        Ok(crate::hdr::adapt_gain_map(&gm, &base, img))
    };
    match attempt() {
        Ok((gm, kept)) => {
            let note = format!("HDR kept from the HEIC source (Ultra HDR JPEG); the HDR boost was kept on {:.0}% of the image and faded where the edit changed brightness.", kept * 100.0);
            (Some(gm), Some(note))
        }
        Err(e) => {
            tracing::warn!("HDR gain map failed: {e}");
            (None, Some(format!("HDR not kept: {e}.")))
        }
    }
}

fn numbered(path: &str, i: usize) -> String {
    let p = Path::new(path);
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let ext = p.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    p.with_file_name(format!("{stem}-{}{ext}", i + 1)).to_string_lossy().into_owned()
}

pub fn encode_output(img: &image::RgbaImage, format: OutputFormat, rec: &GenerationRecord, icc: Option<&[u8]>) -> AppResult<Vec<u8>> {
    match format {
        OutputFormat::Png => {
            let text = rec.png_text();
            let pairs: Vec<(&str, &str)> = text.iter().map(|(k, v)| (*k, v.as_str())).collect();
            imaging::encode_png(img, &pairs, icc, false)
        }
        OutputFormat::Jpeg => imaging::encode_jpeg(img, 95),
        OutputFormat::Webp => imaging::encode_webp_lossless(img),
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("{}.part", path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default()));
    std::fs::write(&tmp, bytes).map_err(|e| AppError::io("write the image", &tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        AppError::io("save the image", path, e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End to end on a real iPhone HEIC (QLS_TEST_HEIC, ffmpeg on PATH): import, simulated
    /// edit (left half 2 stops darker), HDR decision and Ultra HDR file. QLS_TEST_OUT keeps it.
    #[test]
    fn heic_edit_keeps_hdr() {
        let Ok(p) = std::env::var("QLS_TEST_HEIC") else { return };
        if crate::hdr::find_ffmpeg().is_none() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        let bytes = std::fs::read(&p).unwrap();
        let input = store.put_input(&bytes, Some("IMG.HEIC"), Some(&p)).unwrap();
        assert_eq!(input.format, "heic");
        assert!(input.hdr);
        assert!(store.input_display_path(&input.id).is_file());

        let mut edited = imaging::decode_image(&bytes).unwrap().pixels;
        let w = edited.width();
        for (x, _, px) in edited.enumerate_pixels_mut() {
            if x < w / 2 {
                for c in 0..3 {
                    px.0[c] /= 3;
                }
            }
        }
        let mut req = GenerationRequest { prompt: "darker".into(), images: vec![format!("input:{}", input.id)], preserve_dimensions: true, ..Default::default() };
        let pi = crate::planner::PlanInputs { image_sizes: vec![Size::new(input.width, input.height)], vram_total_mib: Some(16303), ..Default::default() };
        let plan = crate::planner::plan(&req, &pi, &crate::config::RecommendedSettings::default()).unwrap();
        assert_eq!(plan.mode, ResolvedMode::Edit);

        let (gm, note) = hdr_for(&edited, &req, &plan, std::slice::from_ref(&input));
        let gm = gm.expect("HDR kept");
        let note = note.unwrap();
        assert!(note.contains("HDR kept"), "{note}");
        // Roughly the right half keeps its boost.
        let share: f64 = note.split("kept on ").nth(1).unwrap().split('%').next().unwrap().parse().unwrap();
        assert!((35.0..65.0).contains(&share), "{note}");
        let icc = crate::heif::primary_icc(&bytes);
        let out = crate::hdr::encode_ultra_hdr(&edited, icc.as_deref(), &gm, 95).unwrap();
        if let Ok(d) = std::env::var("QLS_TEST_OUT") {
            std::fs::write(Path::new(&d).join("edit_ultrahdr.jpg"), &out).unwrap();
        }

        req.advanced.hdr = Some(false);
        assert!(hdr_for(&edited, &req, &plan, std::slice::from_ref(&input)).0.is_none(), "toggle off");
        let cropped = image::imageops::crop_imm(&edited, 0, 0, w, w).to_image();
        let (none, why) = hdr_for(&cropped, &GenerationRequest { advanced: Default::default(), ..req.clone() }, &plan, std::slice::from_ref(&input));
        assert!(none.is_none() && why.unwrap().contains("framing"));
    }

    #[test]
    fn numbered_paths() {
        assert_eq!(numbered(r"C:\a\hero.png", 1), r"C:\a\hero-2.png");
        assert_eq!(numbered("x", 2), "x-3");
    }

    #[test]
    fn lora_library_survives_settings_saves() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: test-only env override, single-threaded setup.
        unsafe { std::env::set_var("QLS_CONFIG_DIR", dir.path().join("cfg")) };
        let mut cfg = AppConfig { sdcpp_dir: dir.path().join("sdcpp"), ..AppConfig::default() };
        cfg.normalize();
        let model = cfg.profile().diffusion_model.clone();
        std::fs::create_dir_all(model.parent().unwrap()).unwrap();
        crate::modelfile::tests::write_gguf(&model, &[], &[], &[("transformer_blocks.0.attn.to_q.weight", 1, &[8, 8])]);
        // A LoRA for that layer (header only: the copy is byte for byte).
        let src = dir.path().join("My Style.safetensors");
        crate::modelfile::tests::write_st(&src, &[("transformer_blocks.0.attn.to_q.lora_A.weight", "BF16", &[4, 8]), ("transformer_blocks.0.attn.to_q.lora_B.weight", "BF16", &[8, 4])]);
        let e = Engine::new(cfg, dir.path()).unwrap();

        let added = e.add_lora(&src).unwrap();
        assert_eq!((added.id.as_str(), added.name.as_str(), added.weight), ("my-style", "My Style", 1.0));
        let copy = e.config().lora_dir().join("my-style.safetensors");
        assert_eq!(std::fs::read(&copy).unwrap(), std::fs::read(&src).unwrap());
        e.update_lora("my-style", LoraPatch { weight: Some(0.75), trigger_words: Some(" grainscape ".into()), on_by_default: Some(true), ..Default::default() }).unwrap();
        assert!(e.update_lora("my-style", LoraPatch { weight: Some(3.0), ..Default::default() }).is_err());
        // Loading the same file again keeps its settings.
        assert_eq!(e.add_lora(&src).unwrap().weight, 0.75);

        // Settings saved from an older copy of the config keep the list.
        let mut stale = e.config();
        stale.loras.clear();
        e.set_config(stale).unwrap();
        let l = &e.loras()[0];
        assert!(l.available);
        assert_eq!((l.entry.trigger_words.as_str(), l.entry.on_by_default), ("grainscape", true));
        assert_eq!(AppConfig::load().loras.len(), 1);

        e.remove_lora("my-style").unwrap();
        assert!(e.loras().is_empty() && !copy.exists() && src.exists());
    }

    #[tokio::test]
    async fn submit_validate_and_cancel_queued() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: test-only env override, single-threaded setup.
        unsafe { std::env::set_var("QLS_CONFIG_DIR", dir.path().join("cfg")) };
        // Engine and model files (empty) in the test's own folder, never the real one.
        let mut cfg = AppConfig::default();
        cfg.sdcpp_dir = dir.path().join("sdcpp");
        cfg.normalize();
        std::fs::create_dir_all(cfg.engine_dir()).unwrap();
        std::fs::write(cfg.server_exe(), b"").unwrap();
        for (_, p, _) in cfg.profile().files() {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let te = cfg.profile().text_encoder.clone();
        let e = Engine::new(cfg, dir.path()).unwrap();
        // A model file that is gone (drive disconnected, moved): refused before queueing.
        std::fs::rename(&te, te.with_extension("moved")).unwrap();
        let err = e.submit(GenerationRequest { prompt: "a fox".into(), ..Default::default() }, None).unwrap_err();
        assert_eq!(err.code, ErrorCode::MissingModel);
        assert!(err.message.contains("Text encoder") && err.suggestion.as_deref().unwrap().contains("drive"), "{err:?}");
        std::fs::rename(te.with_extension("moved"), &te).unwrap();
        assert!(e.submit(GenerationRequest { prompt: " ".into(), ..Default::default() }, None).is_err());
        // Remove needs no prompt; other inpaint actions do.
        let remove = GenerationRequest { images: vec!["gen:x".into()], mask: Some("input:m".into()), inpaint_action: planner::InpaintAction::Remove, ..Default::default() };
        assert!(e.submit(GenerationRequest { inpaint_action: planner::InpaintAction::Replace, ..remove.clone() }, None).is_err());
        let r = e.submit(remove, None).unwrap();
        e.cancel(&r.id).unwrap();
        let j = e.submit(GenerationRequest { prompt: "a fox".into(), seed: Some(-1), ..Default::default() }, None).unwrap();
        assert_eq!(j.status, JobStatus::Queued);
        assert_eq!(j.seed, None, "negative seed means random");
        let j2 = e.submit(GenerationRequest { prompt: "a cat".into(), ..Default::default() }, None).unwrap();
        assert_eq!(e.job(&j2.id).unwrap().queue_position, 2);
        let c = e.cancel(&j.id).unwrap();
        assert_eq!(c.status, JobStatus::Cancelled);
        assert_eq!(e.job(&j2.id).unwrap().queue_position, 1);
        assert_eq!(e.next_queued().as_deref(), Some(j2.id.as_str()));
        assert!(e.cancel("nope").is_err());
        // Upscales need an image but no prompt; the job gets a readable label.
        let up = GenerationRequest { mode: Mode::Upscale, ..Default::default() };
        assert!(e.submit(up.clone(), None).is_err());
        let j3 = e.submit(GenerationRequest { images: vec!["gen:x".into()], ..up }, None).unwrap();
        assert_eq!(j3.prompt, "Upscale");
        // Closing the desktop app cancels only its own jobs.
        let ui = e.submit(GenerationRequest { prompt: "ui job".into(), client: Some("ui".into()), ..Default::default() }, None).unwrap();
        let mcp = e.submit(GenerationRequest { prompt: "mcp job".into(), client: Some("mcp".into()), ..Default::default() }, None).unwrap();
        assert_eq!(e.cancel_client_jobs("ui"), 1);
        assert_eq!(e.job(&ui.id).unwrap().status, JobStatus::Cancelled);
        assert_eq!(e.job(&mcp.id).unwrap().status, JobStatus::Queued);
    }

    /// An upscale endpoint that answers every request with its tile enlarged x2 (nearest).
    async fn fake_upscaler() -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut req = Vec::new();
                let mut buf = [0u8; 65536];
                let body = loop {
                    let n = sock.read(&mut buf).await.unwrap();
                    req.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&req).to_string();
                    if let Some(end) = text.find("\r\n\r\n") {
                        let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                        if req.len() >= end + 4 + len {
                            break req[end + 4..end + 4 + len].to_vec();
                        }
                    }
                };
                let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
                let tile = image::load_from_memory(&crate::sdcpp::b64_decode(v["image"].as_str().unwrap()).unwrap()).unwrap();
                let up = tile.resize_exact(tile.width() * 2, tile.height() * 2, image::imageops::FilterType::Nearest);
                let mut png = std::io::Cursor::new(Vec::new());
                up.write_to(&mut png, image::ImageFormat::Png).unwrap();
                let out = serde_json::json!({ "images": [{ "index": 0, "b64_json": crate::sdcpp::b64(png.get_ref()) }] }).to_string();
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", out.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(out.as_bytes()).await;
            }
        });
        port
    }

    #[tokio::test]
    async fn upscaling_reports_its_tiles_as_steps() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: test-only env override, single-threaded setup.
        unsafe { std::env::set_var("QLS_CONFIG_DIR", dir.path().join("cfg")) };
        let mut cfg = AppConfig::default();
        cfg.sdcpp_dir = dir.path().join("sdcpp");
        cfg.normalize();
        std::fs::create_dir_all(cfg.engine_dir()).unwrap();
        std::fs::write(cfg.server_exe(), b"").unwrap();
        for (_, p, _) in cfg.profile().files() {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let e = Engine::new(cfg, dir.path()).unwrap();
        let id = e.submit(GenerationRequest { prompt: "a long strip".into(), ..Default::default() }, None).unwrap().id;
        let mut events = e.events.subscribe();
        // 4200 px wide: three tiles of at most 2048 px for an x4 model.
        let content = image::RgbaImage::from_pixel(4200, 40, image::Rgba([90, 120, 200, 255]));
        let how = EnlargeOptions { tile: 0, blend: 1.0, prescale: false };
        let client = SdcppClient::new(fake_upscaler().await);
        let (img, with) = e.enlarge(&id, &client, content, Some(Size::new(16800, 160)), Some("4x"), how, (2, 3)).await.unwrap();
        assert_eq!((img.width(), with.as_deref()), (8400, Some("4x")), "stitched from the x2 answers");
        let mut steps = Vec::new();
        while let Ok(ev) = events.try_recv() {
            if let Event::Job { job } = ev {
                if job.stage == Some(BackendStage::Upscaling) {
                    assert_eq!((job.status, job.image), (JobStatus::Running, Some((2, 3))));
                    if steps.last() != Some(&(job.step, job.seconds_per_step.is_some())) {
                        steps.push((job.step, job.seconds_per_step.is_some()));
                    }
                }
            }
        }
        assert_eq!(steps.first(), Some(&(None, false)));
        let tiles: Vec<_> = steps.iter().filter_map(|(s, timed)| s.map(|s| (s, *timed))).collect();
        assert_eq!(tiles, vec![((0, 3), false), ((1, 3), true), ((2, 3), true), ((3, 3), true)], "{steps:?}");
    }

    #[tokio::test]
    async fn prompt_enhancer_streams_falls_back_and_is_kept_for_retries() {
        use crate::sdcpp::{fake_server, sse_answer};
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: test-only env override, single-threaded setup.
        unsafe { std::env::set_var("QLS_CONFIG_DIR", dir.path().join("cfg")) };
        let mut cfg = AppConfig::default();
        cfg.sdcpp_dir = dir.path().join("sdcpp");
        cfg.normalize();
        std::fs::create_dir_all(cfg.engine_dir()).unwrap();
        std::fs::write(cfg.server_exe(), b"").unwrap();
        for (_, p, _) in cfg.profile().files() {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let e = Engine::new(cfg.clone(), dir.path()).unwrap();
        let caps = Capabilities { text_generation: true, ..Default::default() };
        let submit = || e.submit(GenerationRequest { prompt: "rendi il gatto nero".into(), enhance: true, ..Default::default() }, None).unwrap().id;
        let images = vec!["PNG1".to_string()];

        // Streams into the job (~10 updates a second) and keeps the finished text.
        let id = submit();
        let mut events = e.events.subscribe();
        let (port, body) = fake_server(200, "text/event-stream", sse_answer(&["Change the cat's", " fur to black."], "stop"), Duration::from_millis(150)).await;
        let out = e.enhance_prompt(&id, &SdcppClient::new(port), &caps, &cfg, ResolvedMode::Edit, "rendi il gatto nero", &images, 42).await.unwrap();
        assert_eq!(out.as_deref(), Some("Change the cat's fur to black."));
        let mut partial = false;
        while let Ok(ev) = events.try_recv() {
            if let Event::Job { job } = ev {
                partial |= job.status == JobStatus::EnhancingPrompt && job.enhanced_prompt.as_deref() == Some("Change the cat's");
            }
        }
        assert!(partial, "the job shows the text while it is written");
        let v = e.job(&id).unwrap();
        assert_eq!((v.enhanced_prompt.as_deref(), v.prompt.as_str()), (Some("Change the cat's fur to black."), "rendi il gatto nero"));
        let sent: serde_json::Value = serde_json::from_str(&body.await.unwrap()).unwrap();
        assert_eq!((sent["images"][0].as_str(), sent["sampling"]["seed"].as_i64()), (Some("PNG1"), Some(42)), "the references and the job's seed");
        assert_eq!(sent["system_prompt"], enhancer::EDIT_SYSTEM_PROMPT);
        // A retry (out of memory) keeps that prompt without asking the server again.
        let again = e.enhance_prompt(&id, &SdcppClient::new(1), &caps, &cfg, ResolvedMode::Edit, "rendi il gatto nero", &images, 43).await.unwrap();
        assert_eq!(again, out);

        // A failure keeps the user's prompt, with a note.
        let id = submit();
        let chunks = vec!["event: delta\ndata: {\"text\":\"Chan\"}\n\n".into(), "event: error\ndata: {\"error\":\"out of memory\"}\n\n".into()];
        let (port, _) = fake_server(200, "text/event-stream", chunks, Duration::from_millis(1)).await;
        assert_eq!(e.enhance_prompt(&id, &SdcppClient::new(port), &caps, &cfg, ResolvedMode::Generate, "un gatto", &[], 1).await.unwrap(), None);
        let v = e.job(&id).unwrap();
        assert_eq!(v.enhanced_prompt, None);
        assert!(v.notes.last().is_some_and(|n| n.contains("prompt enhancer failed") && n.contains("out of memory") && n.ends_with("used as written.")), "{:?}", v.notes);
        // An empty answer too.
        let id = submit();
        let (port, _) = fake_server(200, "text/event-stream", sse_answer(&["  "], "stop"), Duration::ZERO).await;
        assert_eq!(e.enhance_prompt(&id, &SdcppClient::new(port), &caps, &cfg, ResolvedMode::Generate, "un gatto", &[], 1).await.unwrap(), None);
        assert!(e.job(&id).unwrap().notes.last().unwrap().contains("wrote nothing"));
        // A cut-off answer is used, with a note.
        let id = submit();
        let (port, _) = fake_server(200, "text/event-stream", sse_answer(&["A cat on a"], "length"), Duration::ZERO).await;
        assert_eq!(e.enhance_prompt(&id, &SdcppClient::new(port), &caps, &cfg, ResolvedMode::Generate, "un gatto", &[], 1).await.unwrap().as_deref(), Some("A cat on a"));
        assert!(e.job(&id).unwrap().notes.last().unwrap().contains("length limit"));

        // An engine without text generation (official builds): note, no request.
        let id = submit();
        assert_eq!(e.enhance_prompt(&id, &SdcppClient::new(1), &Capabilities::default(), &cfg, ResolvedMode::Generate, "un gatto", &[], 1).await.unwrap(), None);
        assert!(e.job(&id).unwrap().notes.last().unwrap().contains("no prompt enhancer"));
        assert_eq!(e.job(&id).unwrap().status, JobStatus::Queued, "status untouched");

        // Cancel while the enhancer is writing: the job stops.
        let id = submit();
        let (port, _) = fake_server(200, "text/event-stream", sse_answer(&["slow"], "stop"), Duration::from_secs(30)).await;
        let (e2, id2) = (e.clone(), id.clone());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            e2.cancel(&id2).unwrap();
        });
        let err = e.enhance_prompt(&id, &SdcppClient::new(port), &caps, &cfg, ResolvedMode::Generate, "un gatto", &[], 1).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Cancelled);
    }

    #[test]
    fn private_results_stay_out_of_the_gallery() {
        let dir = tempfile::tempdir().unwrap();
        let e = Engine::new(AppConfig::default(), dir.path()).unwrap();
        // A tiny PNG imported in private mode lives in the private store only.
        let png = imaging::encode_png(&image::RgbaImage::from_pixel(8, 8, image::Rgba([200, 10, 10, 255])), &[], None, false).unwrap();
        let input = e.private_store.put_input(&png, Some("secret.png"), None).unwrap();
        assert!(e.store.get_input(&input.id).is_err());
        assert!(Arc::ptr_eq(e.input_store(&input.id), &e.private_store));
        assert!(Path::new(&input.path).starts_with(dir.path().join("private")));
        let (_, rec) = e.resolve_source(&format!("input:{}", input.id), None, true).unwrap();
        assert_eq!(rec.id, input.id);
        assert!(e.store.get_input(&input.id).is_err(), "a private job does not copy its input into the gallery");
        // Ending private mode deletes records and files.
        assert_eq!(e.clear_private().unwrap(), 0);
        assert!(e.private_store.get_input(&input.id).is_err());
        assert!(!Path::new(&input.path).exists());
        // A new engine wipes leftovers of a previous run.
        std::fs::write(dir.path().join("private").join("out").join("left.png"), b"x").unwrap();
        drop(e);
        let _e = Engine::new(AppConfig::default(), dir.path()).unwrap();
        assert!(!dir.path().join("private").join("out").join("left.png").exists());
        let req: GenerationRequest = serde_json::from_str(r#"{"prompt":"x"}"#).unwrap();
        assert!(!req.private, "off unless asked");
    }

    #[test]
    fn lut_results_are_new_versions_of_their_source() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = AppConfig { output_dir: dir.path().join("out"), ..Default::default() };
        let e = Engine::new(cfg, dir.path()).unwrap();
        let cube = dir.path().join("Invert.cube");
        let mut text = String::from("LUT_3D_SIZE 2
");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    text.push_str(&format!("{} {} {}
", 1 - r, 1 - g, 1 - b));
                }
            }
        }
        std::fs::write(&cube, text).unwrap();
        let lut = e.luts().import(&cube).unwrap();
        let png = imaging::encode_png(&image::RgbaImage::from_pixel(16, 8, image::Rgba([200, 10, 40, 255])), &[], None, false).unwrap();
        let input = e.store.put_input(&png, Some("photo.png"), None).unwrap();
        let src = format!("input:{}", input.id);
        let preview = e.lut_preview(&src, &lut.name, 1024).unwrap();
        assert_eq!(preview.1, "image/jpeg");

        let rec = e.apply_lut(&src, &lut.name, 0.5, false).unwrap();
        assert_eq!((rec.mode.as_str(), rec.width, rec.height), ("lut", 16, 8));
        assert_eq!(rec.request["images"][0], src.as_str(), "made from the source (timeline link)");
        assert_eq!(rec.request["lut"]["intensity"], 0.5);
        assert!(Path::new(&rec.file_path).starts_with(dir.path().join("out")) && rec.file_path.ends_with(".png"));
        let px = *imaging::load_image(Path::new(&rec.file_path)).unwrap().pixels.get_pixel(0, 0);
        assert!(px[0].abs_diff(128) <= 1 && px[1].abs_diff(128) <= 1, "half way to the inverse: {px:?}");
        assert!(imaging::read_png_text(&std::fs::read(&rec.file_path).unwrap()).iter().any(|(k, v)| k == "parameters" && v.starts_with("Colour LUT: Invert")));
        assert!(e.store.get_generation(&rec.id).is_ok());

        // A result of a result keeps its format and parent; private sources stay private.
        let again = e.apply_lut(&format!("gen:{}", rec.id), &lut.name, 1.0, false).unwrap();
        assert_eq!(again.parent_id.as_deref(), Some(rec.id.as_str()));
        let other = imaging::encode_png(&image::RgbaImage::from_pixel(4, 4, image::Rgba([1, 2, 3, 255])), &[], None, false).unwrap();
        let secret = e.private_store.put_input(&other, Some("secret.png"), None).unwrap();
        let p = e.apply_lut(&format!("input:{}", secret.id), &lut.name, 1.0, false).unwrap();
        assert!(e.store.get_generation(&p.id).is_err() && e.private_store.get_generation(&p.id).is_ok());
        assert!(Path::new(&p.file_path).starts_with(dir.path().join("private")));
        assert!(e.apply_lut("C:/x.png", &lut.name, 1.0, false).is_err());
        assert!(e.apply_lut(&src, "missing", 1.0, false).is_err());
    }

    #[test]
    fn plan_inputs_follow_config() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig::default();
        cfg.gpu_backend = crate::config::GpuBackend::Cuda; // SageAttention is CUDA only
        cfg.sdcpp_dir = dir.path().to_path_buf();
        cfg.upscaler_model = crate::config::UPSCALER_CHOICES[0].0.into(); // the PC default (Macs: Lanczos)
        let i = plan_inputs(&cfg, vec![], None, Some(16303));
        assert_eq!(i.upscaler, None, "no model file -> Lanczos");
        assert!(i.server_vae_tiling && i.sage_attention && !i.metal);
        assert_eq!(i.upscale_tile, 128, "the ESRGAN default's tile");
        std::fs::create_dir_all(cfg.upscalers_dir()).unwrap();
        std::fs::File::create(crate::catalog::UPSCALER.path(dir.path())).unwrap().set_len(crate::catalog::UPSCALER.size).unwrap();
        cfg.vae_tile_size = 0;
        cfg.gpu_backend = crate::config::GpuBackend::Metal;
        let i = plan_inputs(&cfg, vec![], None, Some(12_000));
        assert_eq!(i.upscaler.as_deref(), Some("4xNomos2_hq_mosr"));
        assert_eq!(i.upscale_tile, 256, "smaller tiles under 14 GB");
        assert!(!i.server_vae_tiling && i.metal);
    }

    #[test]
    fn output_encoding_formats() {
        let img = image::RgbaImage::from_pixel(8, 8, image::Rgba([1, 2, 3, 255]));
        let rec: GenerationRecord = serde_json::from_value(serde_json::json!({
            "id":"x","created_at":"t","mode":"generate","prompt":"p","negative_prompt":"","seed":1,"width":8,"height":8,
            "working_width":32,"working_height":32,"model":"m","sampler":"euler","scheduler":null,"steps":1,"cfg":6.0,"strength":null,
            "quality":"fast","resolution":"auto","references":[],"mask_input_id":null,"outpaint":null,"file_path":"f","favorite":false,
            "parent_id":null,"duration_ms":1,"notes":[],"app_version":"1","backend_version":null,"client":null
        }))
        .unwrap();
        let png = encode_output(&img, OutputFormat::Png, &rec, None).unwrap();
        assert!(imaging::read_png_text(&png).iter().any(|(k, _)| k == "qls:generation"));
        let jpg = encode_output(&img, OutputFormat::Jpeg, &rec, None).unwrap();
        assert_eq!(&jpg[..2], &[0xFF, 0xD8]);
        let webp = encode_output(&img, OutputFormat::Webp, &rec, None).unwrap();
        assert_eq!(&webp[..4], b"RIFF");
    }
}
