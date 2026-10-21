//! sd-server process management: launch arguments, reuse/spawn/stop, log capture and
//! truthful progress parsing from the server's own log output.

use std::collections::VecDeque;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::config::{AppConfig, ModelProfile, TextEncoderPlacement};
use crate::error::{AppError, ErrorCode, translate_startup_failure};
use crate::sdcpp::{Capabilities, SdcppClient};

// ---------------------------------------------------------------------------------------
// Launch arguments
// ---------------------------------------------------------------------------------------

pub fn build_server_args(cfg: &AppConfig, profile: &ModelProfile) -> Vec<String> {
    let p = |p: &Path| p.to_string_lossy().into_owned();
    let mut a: Vec<String> = vec![
        "--listen-ip".into(),
        "127.0.0.1".into(),
        "--listen-port".into(),
        cfg.server_port.to_string(),
        "--diffusion-model".into(),
        p(&profile.diffusion_model),
        "--vae".into(),
        p(&profile.vae),
        "--llm".into(),
        p(&profile.text_encoder),
    ];
    if let Some(v) = &profile.vision_projector {
        a.push("--llm_vision".into());
        a.push(p(v));
    }
    let dev = cfg.effective_device();
    let metal = cfg.gpu_backend == crate::config::GpuBackend::Metal;
    let mut placement = cfg.text_encoder_placement;
    if metal && placement == TextEncoderPlacement::Ram {
        // Unified memory: "system RAM" is the GPU's memory too, so a CPU copy only costs.
        placement = TextEncoderPlacement::Gpu;
    }
    if metal && placement == TextEncoderPlacement::Gpu {
        // Weights stay on the Metal device as zero-copy mappings of the model files (needs
        // the params on their compute device). Without `--auto-fit off` auto-fit may put the
        // text encoder in "RAM": on a Mac a second, staged copy in the same memory.
        a.extend(["--backend".into(), dev.clone(), "--auto-fit".into(), "off".into()]);
    }
    match placement {
        TextEncoderPlacement::Ram => {
            // Weights in RAM, compute on the GPU. Explicit --params-backend disables
            // auto-fit, so DiT/VAE weights live on their compute device.
            a.extend(["--backend".into(), dev.clone(), "--params-backend".into(), "te=cpu".into()]);
        }
        TextEncoderPlacement::Gpu if metal => {}
        TextEncoderPlacement::Gpu => a.extend(["--backend".into(), dev.clone()]),
        TextEncoderPlacement::Cpu => a.extend(["--backend".into(), format!("diffusion={dev},vae={dev},te=cpu")]),
        TextEncoderPlacement::Auto => a.extend(["--backend".into(), format!("diffusion={dev},vae={dev}"), "--auto-fit".into(), "on".into()]),
        TextEncoderPlacement::Disk => a.extend(["--backend".into(), dev.clone(), "--params-backend".into(), "disk".into()]),
    }
    if metal {
        // Weights mapped from the files instead of copied (Metal support upstream in #2037,
        // part of the pinned build). ggml keeps Metal buffers wired while in use (residency
        // sets, 3 min keep-alive), so macOS cannot page them out: what does not fit under
        // Metal's working-set limit must be released instead (Disk placement, 16 GB Macs).
        a.push("--mmap".into());
    }
    if cfg.flash_attention {
        a.push("--fa".into());
    }
    if cfg.uses_sage_attention() {
        // Falls back to flash/default attention for layers it can't handle.
        a.push("--sage-attn".into());
    }
    if cfg.vae_tile_size > 0 {
        a.extend([
            "--vae-tiling".into(),
            "--vae-tile-size".into(),
            cfg.vae_tile_size.to_string(),
            "--vae-tile-overlap".into(),
            "0.125".into(),
        ]);
    }
    match cfg.prefix_cache_type.as_str() {
        "auto" => {}
        "off" => a.extend(["--model-args".into(), "qwen_image_2_1_prefix_cache=false".into()]),
        t => a.extend(["--model-args".into(), format!("qwen_image_2_1_prefix_cache_type={t}")]),
    }
    if cfg.eager_load && placement != TextEncoderPlacement::Disk {
        a.push("--eager-load".into());
    }
    // The upscaler for `/sdcpp/v1/upscale` (tile size sent per request); the server scans the
    // folder lazily, so a model added later is picked up without a restart.
    let up_dir = cfg.upscalers_dir();
    if up_dir.is_dir() {
        a.push("--hires-upscalers-dir".into());
        a.push(p(&up_dir));
    }
    // The user's LoRAs (Kokon's copies); scanned on every request, so a LoRA loaded later
    // needs no restart.
    a.push("--lora-model-dir".into());
    a.push(p(&cfg.lora_dir()));
    if cfg.gpu_backend != crate::config::GpuBackend::Metal {
        // Direct convolutions in the upscaler (it only affects UNet/ControlNet models besides,
        // never Qwen). MoSR at 1472², 768 px tiles on an RTX 5070 Ti: CUDA 3.8 s / +2.4 GB →
        // 3.1 s / +1.55 GB; Vulkan +4.2 GB → +1.25 GB. On Metal it is ~4x slower (M2 Pro).
        a.push("--diffusion-conv-direct".into());
    }
    if cfg.vram_reserve_gib > 0.0 {
        // A negative --max-vram reserves that much free VRAM (sd-server --help).
        a.push("--max-vram".into());
        a.push(format!("-{}", trim_float(cfg.vram_reserve_gib)));
    }
    a.extend(profile.backend_args.iter().cloned());
    a.extend(cfg.extra_server_args.iter().cloned());
    a
}

fn trim_float(v: f32) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

// ---------------------------------------------------------------------------------------
// Progress parsing (only what the backend actually prints)
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendStage {
    Preparing,
    EncodingImages,
    EncodingPrompt,
    Generating,
    /// Hires fix: decoding the first pass, ESRGAN, re-encoding at the target size.
    Upscaling,
    /// Hires fix: second sampling pass at the target size.
    Refining,
    Decoding,
    Finishing,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BackendProgress {
    pub stage: BackendStage,
    /// (current, total) sampling step, when the sampler's progress bar reports it.
    pub step: Option<(u32, u32)>,
    /// (current, total) image in a batch.
    pub image: Option<(u32, u32)>,
    pub seconds_per_step: Option<f32>,
}

#[derive(Debug, Default)]
pub struct ProgressParser {
    current: Option<BackendProgress>,
}

impl ProgressParser {
    pub fn reset(&mut self) {
        self.current = None;
    }

    /// Feeds one log line (already split on \n / \r). sd-server erases progress bars with
    /// ESC[K and may print the next log line right after it, so ESC[K also separates
    /// lines. Returns the latest update when the state changes.
    pub fn feed(&mut self, raw: &str) -> Option<BackendProgress> {
        let mut last = None;
        for seg in raw.split("\u{1b}[K") {
            if let Some(p) = self.feed_segment(seg) {
                last = Some(p);
            }
        }
        last
    }

    fn feed_segment(&mut self, raw: &str) -> Option<BackendProgress> {
        let line = raw.trim();
        if line.is_empty() {
            return None;
        }
        let set = |s: &mut Self, stage: BackendStage| -> Option<BackendProgress> {
            let image = s.current.and_then(|c| c.image);
            let p = BackendProgress { stage, step: None, image, seconds_per_step: None };
            s.current = Some(p);
            Some(p)
        };
        if line.contains("generate_image ") && !line.contains("completed") {
            self.current = None;
            return set(self, BackendStage::Preparing);
        }
        self.current?;
        let stage = self.current.map(|c| c.stage).unwrap();
        if line.contains("generate_image completed") {
            return set(self, BackendStage::Finishing);
        }
        if line.contains("EDIT mode") || line.contains("IMG2IMG") {
            return set(self, BackendStage::EncodingImages);
        }
        if line.contains("sampling using") && stage == BackendStage::Preparing {
            return set(self, BackendStage::EncodingPrompt);
        }
        if line.contains("encode_first_stage completed") {
            return set(self, BackendStage::EncodingPrompt);
        }
        if let Some(rest) = line.split("generating image:").nth(1) {
            // "generating image: 1/1 - seed 7"
            let frac = rest.trim().split_whitespace().next().unwrap_or("");
            let image = parse_fraction(frac);
            let p = BackendProgress { stage: BackendStage::Generating, step: None, image, seconds_per_step: None };
            self.current = Some(p);
            return Some(p);
        }
        if line.contains("hires fix: upscaling to") {
            return set(self, BackendStage::Upscaling);
        }
        // The upscaling stage prints VAE and ESRGAN tile bars that look like step bars
        // (the VAE encode can even report "6/6"); sampling starts when the diffusion
        // model builds its graph or EasyCache announces itself.
        if stage == BackendStage::Upscaling
            && (line.contains("EasyCache enabled")
                || (line.contains("build cached graph cut plan") && !line.contains("vae") && !line.contains("esrgan")))
        {
            return set(self, BackendStage::Refining);
        }
        if line.contains("decoding") && line.contains("latent") && !line.contains("completed") {
            return set(self, BackendStage::Decoding);
        }
        if matches!(stage, BackendStage::Generating | BackendStage::Refining)
            && let Some((cur, total, spi)) = parse_step_bar(line)
        {
            let mut p = self.current.unwrap();
            if p.step != Some((cur, total)) {
                p.step = Some((cur, total));
                p.seconds_per_step = spi;
                self.current = Some(p);
                return Some(p);
            }
        }
        None
    }
}

fn parse_fraction(s: &str) -> Option<(u32, u32)> {
    let (a, b) = s.split_once('/')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// Parses a sampler bar such as `|=====>     | 2/20 - 1.99s/it`. Tensor-loading bars
/// (`98/397 - 3.76GB/s`) are rejected because they report bytes, not iterations.
pub fn parse_step_bar(line: &str) -> Option<(u32, u32, Option<f32>)> {
    let after = line.rsplit('|').next()?.trim();
    let (frac, rate) = after.split_once(" - ")?;
    let rate = rate.trim();
    let spi = if let Some(v) = rate.strip_suffix("s/it") {
        v.trim().parse::<f32>().ok()
    } else if let Some(v) = rate.strip_suffix("it/s") {
        v.trim().parse::<f32>().ok().filter(|x| *x > 0.0).map(|x| 1.0 / x)
    } else {
        return None;
    };
    let (cur, total) = parse_fraction(frac)?;
    (total > 0 && cur <= total).then_some((cur, total, spi))
}

// ---------------------------------------------------------------------------------------
// Server manager
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerState {
    Stopped,
    Starting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerStatus {
    pub state: ServerState,
    /// True when this app launched the process (and may stop it).
    pub owned: bool,
    pub pid: Option<u32>,
    pub port: u16,
    pub model: Option<String>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub error: Option<AppError>,
    pub capabilities: Option<Capabilities>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OwnedRecord {
    pid: u32,
    port: u16,
    model: String,
    log: PathBuf,
}

pub struct LogBuffer {
    lines: Mutex<VecDeque<String>>,
    cap: usize,
}

impl LogBuffer {
    fn new(cap: usize) -> Self {
        Self { lines: Mutex::new(VecDeque::with_capacity(cap)), cap }
    }
    fn push(&self, l: String) {
        let mut g = self.lines.lock().unwrap();
        if g.len() == self.cap {
            g.pop_front();
        }
        g.push_back(l);
    }
    pub fn tail(&self, n: usize) -> Vec<String> {
        let g = self.lines.lock().unwrap();
        g.iter().skip(g.len().saturating_sub(n)).cloned().collect()
    }
}

struct Inner {
    state: ServerState,
    owned: bool,
    pid: Option<u32>,
    /// The server this app launched in this session. Kept so an exit is seen (and reaped)
    /// with `try_wait`: on Linux/macOS a dropped child that dies stays a zombie under its pid.
    child: Option<std::process::Child>,
    port: u16,
    model: Option<String>,
    started_at: Option<chrono::DateTime<chrono::Utc>>,
    error: Option<AppError>,
    caps: Option<Capabilities>,
    tail_stop: Option<Arc<std::sync::atomic::AtomicBool>>,
}

pub struct ServerManager {
    inner: Mutex<Inner>,
    start_lock: tokio::sync::Mutex<()>,
    data_dir: PathBuf,
    pub log: Arc<LogBuffer>,
    lines_tx: broadcast::Sender<String>,
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

impl ServerManager {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        let (lines_tx, _) = broadcast::channel(4096);
        Arc::new(Self {
            inner: Mutex::new(Inner {
                state: ServerState::Stopped,
                owned: false,
                pid: None,
                child: None,
                port: 0,
                model: None,
                started_at: None,
                error: None,
                caps: None,
                tail_stop: None,
            }),
            start_lock: tokio::sync::Mutex::new(()),
            data_dir,
            log: Arc::new(LogBuffer::new(4000)),
            lines_tx,
        })
    }

    /// Live stream of server log lines (only available for servers this app launched).
    pub fn subscribe_lines(&self) -> broadcast::Receiver<String> {
        self.lines_tx.subscribe()
    }

    pub fn status(&self) -> ServerStatus {
        let g = self.inner.lock().unwrap();
        ServerStatus {
            state: g.state,
            owned: g.owned,
            pid: g.pid,
            port: g.port,
            model: g.model.clone(),
            started_at: g.started_at,
            error: g.error.clone(),
            capabilities: g.caps.clone(),
        }
    }

    pub fn capabilities(&self) -> Option<Capabilities> {
        self.inner.lock().unwrap().caps.clone()
    }

    fn record_path(&self) -> PathBuf {
        self.data_dir.join("sd-server.owned.json")
    }

    fn log_path(&self) -> PathBuf {
        self.data_dir.join("logs").join("sd-server.log")
    }

    fn read_record(&self) -> Option<OwnedRecord> {
        serde_json::from_str(&std::fs::read_to_string(self.record_path()).ok()?).ok()
    }

    fn set_state(&self, f: impl FnOnce(&mut Inner)) {
        let mut g = self.inner.lock().unwrap();
        f(&mut g);
    }

    /// Mark the server as gone (e.g. the process exited unexpectedly).
    pub fn mark_lost(&self, err: AppError) {
        self.set_state(|g| {
            g.state = ServerState::Error;
            g.error = Some(err);
            g.caps = None;
        });
    }

    /// Ensures a compatible sd-server is reachable: reuses a running one, otherwise
    /// launches it. Serialized so concurrent callers never start two instances.
    pub async fn ensure_ready(&self, cfg: &AppConfig) -> Result<Capabilities, AppError> {
        let _guard = self.start_lock.lock().await;
        let profile = cfg.profile().clone();
        // Our server may run on a fallback port (see `launch_port`); otherwise the configured one.
        let rec = self.read_record().filter(|r| process_alive(r.pid));
        let port = rec.as_ref().map(|r| r.port).unwrap_or(cfg.server_port);
        let client = SdcppClient::new(port);

        if let Ok(caps) = client.capabilities(Duration::from_secs(3)).await {
            let rec = rec.filter(|r| r.port == port);
            if caps.model_matches(&profile.diffusion_model) && caps.supports_img_gen() {
                let owned = rec.is_some();
                if let Some(r) = &rec
                    && self.inner.lock().unwrap().tail_stop.is_none()
                {
                    self.start_tail(&r.log, true);
                }
                self.set_state(|g| {
                    g.state = ServerState::Ready;
                    g.owned = owned;
                    g.pid = rec.as_ref().map(|r| r.pid);
                    if g.child.as_ref().map(|c| c.id()) != g.pid {
                        g.child = None;
                    }
                    g.port = port;
                    g.model = Some(caps.model.name.clone());
                    g.error = None;
                    g.caps = Some(caps.clone());
                    if g.started_at.is_none() {
                        g.started_at = Some(chrono::Utc::now());
                    }
                });
                return Ok(caps);
            }
            if let Some(r) = rec {
                tracing::info!("restarting owned sd-server (pid {}) for a different model", r.pid);
                kill_pid(r.pid);
                let _ = std::fs::remove_file(self.record_path());
                wait_port_free(&client, Duration::from_secs(15)).await;
            } else {
                // Someone else's server with another model: ours starts on a free port.
                tracing::info!("port {port} is used by another stable-diffusion.cpp server ({}); starting ours on another port", caps.model.name);
            }
        }

        self.spawn_and_wait(cfg, &profile).await
    }

    async fn spawn_and_wait(&self, cfg: &AppConfig, profile: &ModelProfile) -> Result<Capabilities, AppError> {
        let fail = |e: AppError| {
            self.set_state(|g| {
                g.state = ServerState::Error;
                g.error = Some(e.clone());
                g.caps = None;
            });
            e
        };
        let exe = cfg.server_exe();
        if let Some(e) = cfg.missing_files_error() {
            return Err(fail(e));
        }
        let log_path = self.log_path();
        if let Some(d) = log_path.parent() {
            std::fs::create_dir_all(d).map_err(|e| fail(AppError::io("create the log folder", d, e)))?;
        }
        let mut port = launch_port(cfg.server_port).ok_or_else(|| fail(port_unavailable_error(cfg.server_port)))?;
        // sd-server exits with code 0 and no log line when it cannot listen (a port reserved
        // between our check and its bind): one more try on another free port.
        for attempt in 0..2 {
            match self.launch(cfg, profile, &exe, &log_path, port).await {
                Ok(caps) => return Ok(caps),
                Err(Launch::Failed(e)) => return Err(fail(e)),
                Err(Launch::NotListening) if attempt == 0 => {
                    tracing::warn!("sd-server exited without listening on port {port}; retrying on another port");
                    port = free_port().ok_or_else(|| fail(port_unavailable_error(port)))?;
                }
                Err(Launch::NotListening) => break,
            }
        }
        Err(fail(port_unavailable_error(port)))
    }

    async fn launch(&self, cfg: &AppConfig, profile: &ModelProfile, exe: &Path, log_path: &Path, port: u16) -> Result<Capabilities, Launch> {
        let fail = Launch::Failed;
        if log_path.exists() {
            let _ = std::fs::rename(log_path, log_path.with_extension("prev.log"));
        }
        let file = std::fs::File::create(log_path).map_err(|e| fail(AppError::io("create the server log", log_path, e)))?;
        let run_cfg = AppConfig { server_port: port, ..cfg.clone() };
        let args = build_server_args(&run_cfg, profile);
        tracing::info!("starting {} {}", exe.display(), args.join(" "));

        let mut cmd = std::process::Command::new(exe);
        cmd.args(&args)
            .current_dir(&cfg.sdcpp_dir)
            .stdin(std::process::Stdio::null())
            .stdout(file.try_clone().map_err(|e| fail(e.into()))?)
            .stderr(file);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        }
        let mut child = cmd.spawn().map_err(|e| {
            fail(AppError::new(ErrorCode::ServerStartFailed, "Could not launch sd-server.exe.").detail(e.to_string()))
        })?;
        let pid = child.id();
        let rec = OwnedRecord { pid, port, model: profile.model_name(), log: log_path.to_path_buf() };
        let _ = std::fs::write(self.record_path(), serde_json::to_string(&rec).unwrap_or_default());
        self.set_state(|g| {
            g.state = ServerState::Starting;
            g.owned = true;
            g.pid = Some(pid);
            if let Some(mut old) = g.child.take() {
                let _ = old.try_wait(); // reap a crashed predecessor
            }
            g.port = port;
            g.error = None;
            g.caps = None;
            g.started_at = Some(chrono::Utc::now());
        });
        self.start_tail(log_path, false);

        let client = SdcppClient::new(port);
        let started = Instant::now();
        loop {
            if let Ok(Some(status)) = child.try_wait() {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let tail = self.log.tail(40).join("\n");
                let _ = std::fs::remove_file(self.record_path());
                // Code 0 before answering = `svr.listen` failed (it logs "listening on" first).
                if status.success() {
                    return Err(Launch::NotListening);
                }
                return Err(fail(translate_startup_failure(&format!("{tail}\n(exit status {status})"))));
            }
            if let Ok(caps) = client.capabilities(Duration::from_secs(2)).await {
                self.set_state(|g| {
                    g.state = ServerState::Ready;
                    g.model = Some(caps.model.name.clone());
                    g.caps = Some(caps.clone());
                    g.child = Some(child);
                });
                return Ok(caps);
            }
            if started.elapsed() > Duration::from_secs(900) {
                kill_pid(pid);
                return Err(fail(
                    AppError::new(ErrorCode::ServerStartFailed, "The inference server took too long to start.").detail(self.log.tail(40).join("\n")),
                ));
            }
            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    }

    /// The port of the server in use; it can differ from the configured one (`launch_port`).
    pub fn port(&self) -> u16 {
        self.inner.lock().unwrap().port
    }

    /// Stops the server if this app owns it. Never touches servers it did not start.
    pub async fn stop(&self) -> bool {
        let _guard = self.start_lock.lock().await;
        let (owned, pid) = {
            let g = self.inner.lock().unwrap();
            (g.owned, g.pid.or_else(|| self.read_record().map(|r| r.pid)))
        };
        let pid = if owned { pid } else { self.read_record().map(|r| r.pid) };
        let stopped = match pid {
            Some(pid) if process_alive(pid) => {
                kill_pid(pid);
                true
            }
            _ => false,
        };
        let _ = std::fs::remove_file(self.record_path());
        self.set_state(|g| {
            if let Some(s) = g.tail_stop.take() {
                s.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            g.state = ServerState::Stopped;
            g.owned = false;
            g.pid = None;
            g.child = None;
            g.caps = None;
            g.started_at = None;
        });
        stopped
    }

    /// Whether the owned process is still alive (false for external servers).
    pub fn owned_alive(&self) -> Option<bool> {
        let mut g = self.inner.lock().unwrap();
        if !g.owned {
            return None;
        }
        // A server launched in this session: `try_wait` sees (and reaps) an exit. One reused
        // from an earlier session is not our child, so it is checked by pid.
        if let Some(child) = g.child.as_mut()
            && let Ok(status) = child.try_wait()
        {
            return Some(status.is_none());
        }
        g.pid.map(process_alive)
    }

    fn start_tail(&self, path: &Path, from_end: bool) {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if let Some(old) = self.inner.lock().unwrap().tail_stop.replace(stop.clone()) {
            old.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        let path = path.to_path_buf();
        let log = self.log.clone();
        let tx = self.lines_tx.clone();
        std::thread::Builder::new()
            .name("sd-server-log".into())
            .spawn(move || tail_file(&path, from_end, &stop, |line| {
                log.push(line.clone());
                let _ = tx.send(line);
            }))
            .ok();
    }
}

/// Follows a growing file, splitting on \n and \r (progress bars use carriage returns).
fn tail_file(path: &Path, from_end: bool, stop: &std::sync::atomic::AtomicBool, mut on_line: impl FnMut(String)) {
    let mut pos: u64 = 0;
    let mut opened = false;
    let mut partial = Vec::<u8>::new();
    let mut buf = vec![0u8; 64 * 1024];
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        if let Ok(mut f) = std::fs::OpenOptions::new().read(true).open(path) {
            let len = f.metadata().map(|m| m.len()).unwrap_or(0);
            if !opened {
                pos = if from_end { len } else { 0 };
                opened = true;
            }
            if len < pos {
                pos = 0; // truncated / replaced
            }
            if len > pos && f.seek(SeekFrom::Start(pos)).is_ok() {
                while let Ok(n) = f.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    pos += n as u64;
                    for &b in &buf[..n] {
                        if b == b'\n' || b == b'\r' {
                            if !partial.is_empty() {
                                on_line(String::from_utf8_lossy(&partial).into_owned());
                                partial.clear();
                            }
                        } else {
                            partial.push(b);
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

async fn wait_port_free(client: &SdcppClient, timeout: Duration) {
    let t = Instant::now();
    while t.elapsed() < timeout && client.capabilities(Duration::from_millis(500)).await.is_ok() {
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

enum Launch {
    Failed(AppError),
    /// Exited with code 0 before answering: the port could not be opened.
    NotListening,
}

/// The configured port when it can be opened, otherwise a free one. Windows reserves port
/// ranges for Hyper-V, WSL and Docker (`netsh interface ipv4 show excludedportrange
/// protocol=tcp`), different at every boot; binding a reserved port fails with "access denied".
fn launch_port(configured: u16) -> Option<u16> {
    match std::net::TcpListener::bind(("127.0.0.1", configured)) {
        Ok(_) => Some(configured),
        Err(e) => {
            let p = free_port();
            tracing::warn!("port {configured} cannot be opened ({e}); using {p:?}");
            p
        }
    }
}

/// A port the system reports free right now.
pub fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0)).and_then(|l| l.local_addr()).map(|a| a.port()).ok()
}

fn port_unavailable_error(port: u16) -> AppError {
    AppError::new(ErrorCode::ServerStartFailed, format!("The inference server could not open a network port on this computer (last tried: {port})."))
        .suggest("Windows can reserve ports for Hyper-V, WSL or Docker. Restart the computer, or set another port in Settings → Performance.")
}

pub fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    let pid = Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    sys.process(pid)
        .map(|p| p.name().to_string_lossy().to_ascii_lowercase().starts_with("sd-server"))
        .unwrap_or(false)
}

/// Whether any process with this pid exists (used for client liveness, not sd-server).
pub fn pid_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    let pid = Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, ProcessRefreshKind::nothing());
    sys.process(pid).is_some()
}

fn kill_pid(pid: u32) {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    let p = Pid::from_u32(pid);
    sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[p]), true, ProcessRefreshKind::nothing());
    if let Some(proc_) = sys.process(p)
        && proc_.name().to_string_lossy().to_ascii_lowercase().starts_with("sd-server")
    {
        proc_.kill();
        let _ = proc_.wait();
    }
}

/// Runs a short-lived sd-server command (e.g. `--help`, `--list-devices`) and returns output.
pub fn run_server_probe(exe: &Path, args: &[&str], timeout: Duration) -> Option<String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    if let Some(d) = exe.parent() {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd.spawn().ok()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    let out = rx.recv_timeout(timeout).ok()?.ok()?;
    let mut s = String::from_utf8_lossy(&out.stdout).into_owned();
    s.push('\n');
    s.push_str(&String::from_utf8_lossy(&out.stderr));
    Some(s)
}

/// Parses `--list-devices` output: `NAME<TAB>description` lines.
pub fn parse_device_list(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let (n, d) = l.split_once('\t')?;
            let n = n.trim();
            (!n.is_empty() && !n.contains(' ') && n.chars().all(|c| c.is_ascii_alphanumeric())).then(|| (n.to_string(), d.trim().to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_launch_args() {
        let mut cfg = AppConfig::default();
        cfg.gpu_backend = crate::config::GpuBackend::Cuda; // the default is Metal on a Mac
        // A folder without an upscalers subfolder.
        cfg.sdcpp_dir = std::env::temp_dir().join("qls-no-sdcpp-here");
        cfg.apply_preset(crate::catalog::preset("16gb").unwrap());
        let a = build_server_args(&cfg, cfg.profile());
        let s = a.join(" ");
        let m = |f: &str| crate::catalog::join_rel(&cfg.sdcpp_dir, &format!("models/qwen21/{f}")).display().to_string();
        assert!(s.starts_with("--listen-ip 127.0.0.1 --listen-port 39150"));
        assert!(s.contains(&format!("--diffusion-model {}", m("qwen-image-2.1-turbo-Q4_K.gguf"))));
        assert!(s.contains(&format!("--vae {}", m("texture_fix_vae_for_qwen_image_2.1_bf16.safetensors"))));
        assert!(s.contains(&format!("--llm {}", m("Qwen3VL-8B-Instruct-Q4_K_M.gguf"))));
        assert!(s.contains(&format!("--llm_vision {}", m("mmproj-Qwen3VL-8B-Instruct-F16.gguf"))));
        assert!(s.contains("--backend cuda0 --params-backend te=cpu"));
        assert!(s.contains("--fa --sage-attn --vae-tiling --vae-tile-size 768 --vae-tile-overlap 0.125"));
        assert!(s.contains("--model-args qwen_image_2_1_prefix_cache_type=q8_0 --eager-load"));
        assert!(s.ends_with("--diffusion-conv-direct --max-vram -1"));
        assert!(!s.contains("0.0.0.0"));
        assert!(!s.contains("--hires-upscalers-dir"), "missing folder is not passed");
        assert!(!s.contains("upscale-tile-size"), "the tile size is sent with each request");
        assert!(!s.contains("--vae-conv-direct"), "slower for Qwen's VAE");
    }

    #[test]
    fn upscaler_args() {
        let dir = tempfile::tempdir().unwrap();
        let mut cfg = AppConfig::default();
        cfg.sdcpp_dir = dir.path().to_path_buf();
        std::fs::create_dir_all(cfg.upscalers_dir()).unwrap();
        cfg.upscale_tile_size = 256;
        for (backend, direct) in [(crate::config::GpuBackend::Cuda, true), (crate::config::GpuBackend::Vulkan, true), (crate::config::GpuBackend::Metal, false)] {
            cfg.gpu_backend = backend;
            let a = build_server_args(&cfg, cfg.profile());
            let i = a.iter().position(|x| x == "--hires-upscalers-dir").unwrap();
            assert_eq!(a[i + 1], cfg.upscalers_dir().to_string_lossy());
            assert_eq!(a.iter().any(|x| x == "--diffusion-conv-direct"), direct, "{backend:?}: direct convolutions are ~4x slower on Metal");
            assert!(!a.join(" ").contains("upscale-tile-size"));
        }
    }

    /// Captured from sd-cli 3f8527a (bench hires_fast: 1376x768 -> ESRGAN -> 2048x1152,
    /// 6 refine steps, EasyCache, 1024px VAE tiles). sd-server prints the same lines.
    const HIRES_LOG: &str = "[INFO   ] image.cpp:814  - generate_image 1376x768
[INFO   ] request.cpp:420  - sampling using Euler method
[INFO   ] image.cpp:529  - get_learned_condition completed, taking 1.14s
[INFO   ] image.cpp:866  - generating image: 1/1 - seed 42
[INFO   ] sample-cache.cpp:66   - EasyCache enabled - threshold: 0.200, start: 0.15, end: 0.95
  |==>                                               | 1/20 - 2.66s/it\u{1b}[K[INFO   ] ggml_graph_cut.cpp:1034 - qwen_image_2_1 build cached graph cut plan done (taking 2 ms)
  |==================================================| 20/20 - 1.63s/it\u{1b}[K
[INFO   ] image.cpp:899  - sampling completed, taking 17.40s
[INFO   ] image.cpp:924  - hires fix: upscaling to 2048x1152
[INFO   ] image.cpp:932  - hires fix: loading model upscaler from 'C:\\AI\\sdcpp\\models\\upscalers\\RealESRGAN_x4plus.pth'
[INFO   ] image.cpp:960  - hires fix: scheduler_steps=17, denoising_strength=0.35, sigma_sched_size=7
[INFO   ] ggml_graph_cut.cpp:1034 - wan_vae build cached graph cut plan done (taking 0 ms)
  |##################################################| 128/128 - 2.23GB/s\u{1b}[K
  |=========================>                        | 1/2 - 1.12s/it\u{1b}[K
  |==================================================| 2/2 - 1.27it/s\u{1b}[K
[INFO   ] ggml_graph_cut.cpp:1034 - esrgan build cached graph cut plan done (taking 2 ms)
  |>                                                 | 1/112 - 2.88it/s\u{1b}[K
  |==================================================| 112/112 - 10.87it/s\u{1b}[K
[INFO   ] ggml_graph_cut.cpp:1034 - wan_vae build cached graph cut plan done (taking 0 ms)
  |========>                                         | 1/6 - 1.86it/s\u{1b}[K
  |==================================================| 6/6 - 3.42it/s\u{1b}[K
[INFO   ] sample-cache.cpp:66   - EasyCache enabled - threshold: 0.200, start: 0.15, end: 0.95
[INFO   ] ggml_graph_cut.cpp:1034 - qwen_image_2_1 build cached graph cut plan done (taking 3 ms)
  |========>                                         | 1/6 - 4.02s/it\u{1b}[K[INFO   ] ggml_graph_cut.cpp:1034 - qwen_image_2_1 build cached graph cut plan done (taking 3 ms)
  |================>                                 | 2/6 - 3.81s/it\u{1b}[K
  |==================================================| 6/6 - 3.80s/it\u{1b}[K
[INFO   ] image.cpp:1024 - hires sampling 1/1 completed, taking 15.46s
[INFO   ] image.cpp:1036 - hires fix completed, taking 30.73s
[INFO   ] image.cpp:554  - decoding 1 latents
  |========>                                         | 1/6 - 1.07s/it\u{1b}[K
[INFO   ] image.cpp:620  - latent 1 decoded, taking 6.18s
[INFO   ] image.cpp:1050 - generate_image completed in 55.52s";

    #[test]
    fn progress_through_hires_refine() {
        let mut p = ProgressParser::default();
        let updates: Vec<BackendProgress> = HIRES_LOG.split(['\n', '\r']).filter_map(|l| p.feed(l)).collect();
        let stages: Vec<BackendStage> = updates.iter().map(|u| u.stage).collect();
        let pos = |s: BackendStage| stages.iter().position(|x| *x == s).unwrap_or_else(|| panic!("missing {s:?} in {stages:?}"));
        assert!(pos(BackendStage::Generating) < pos(BackendStage::Upscaling));
        assert!(pos(BackendStage::Upscaling) < pos(BackendStage::Refining));
        assert!(pos(BackendStage::Refining) < pos(BackendStage::Decoding));
        let base: Vec<(u32, u32)> = updates.iter().filter(|u| u.stage == BackendStage::Generating).filter_map(|u| u.step).collect();
        assert_eq!(base, vec![(1, 20), (20, 20)]);
        // VAE/ESRGAN tile bars (2, 112 and the 6-tile encode) never count as refine steps.
        let refine: Vec<(u32, u32, Option<f32>)> =
            updates.iter().filter(|u| u.stage == BackendStage::Refining).filter_map(|u| u.step.map(|s| (s.0, s.1, u.seconds_per_step))).collect();
        assert_eq!(refine.iter().map(|r| (r.0, r.1)).collect::<Vec<_>>(), vec![(1, 6), (2, 6), (6, 6)]);
        assert_eq!(refine[0].2, Some(4.02), "the 1.86it/s VAE tile bar was not taken");
        assert!(updates.iter().filter(|u| u.stage == BackendStage::Upscaling).all(|u| u.step.is_none()));
        assert_eq!(stages.last(), Some(&BackendStage::Finishing));
    }

    #[test]
    fn placement_variants_and_reserve() {
        let mut cfg = AppConfig::default();
        cfg.gpu_backend = crate::config::GpuBackend::Cuda;
        cfg.text_encoder_placement = TextEncoderPlacement::Cpu;
        cfg.vram_reserve_gib = 1.5;
        cfg.flash_attention = false;
        cfg.sage_attention = false;
        cfg.vae_tile_size = 0;
        cfg.extra_server_args = vec!["--vae-conv-direct".into()];
        cfg.prefix_cache_type = "off".into();
        cfg.eager_load = false;
        let s = build_server_args(&cfg, cfg.profile()).join(" ");
        assert!(s.contains("--model-args qwen_image_2_1_prefix_cache=false"));
        assert!(!s.contains("--eager-load"));
        assert!(s.contains("--backend diffusion=cuda0,vae=cuda0,te=cpu"));
        assert!(s.contains("--max-vram -1.5"));
        assert!(!s.contains("--fa"));
        assert!(!s.contains("--sage-attn"));
        assert!(!s.contains("--vae-tiling"));
        assert!(s.ends_with("--vae-conv-direct"));
        cfg.text_encoder_placement = TextEncoderPlacement::Auto;
        cfg.vram_reserve_gib = 0.0;
        cfg.prefix_cache_type = "auto".into();
        let s = build_server_args(&cfg, cfg.profile()).join(" ");
        assert!(!s.contains("--model-args"));
        assert!(s.contains("--auto-fit on"));
        assert!(!s.contains("--max-vram"));
    }

    #[test]
    fn vulkan_launch() {
        let mut cfg = AppConfig::default();
        cfg.gpu_backend = crate::config::GpuBackend::Vulkan;
        let s = build_server_args(&cfg, cfg.profile()).join(" ");
        assert!(s.contains("--backend vulkan0 --params-backend te=cpu"), "{s}");
        assert!(s.contains("--fa"));
        assert!(!s.contains("--sage-attn"), "SageAttention is CUDA only");
        assert!(s.contains("qwen_image_2_1_prefix_cache_type=q8_0"));
    }

    #[test]
    fn metal_launch() {
        let mut cfg = AppConfig::default();
        cfg.gpu_backend = crate::config::GpuBackend::Metal;
        let s = build_server_args(&cfg, cfg.profile()).join(" ");
        assert!(s.contains("--backend mtl0 --auto-fit off --mmap --fa"), "RAM placement runs everything on the GPU: {s}");
        assert!(!s.contains("--params-backend") && !s.contains("--sage-attn"));
        assert!(s.contains("--mmap") && s.contains("--eager-load"));
        cfg.text_encoder_placement = TextEncoderPlacement::Disk;
        let s = build_server_args(&cfg, cfg.profile()).join(" ");
        assert!(s.contains("--backend mtl0 --params-backend disk"), "{s}");
        assert!(!s.contains("--eager-load"), "nothing to preload when weights stream from disk");
    }

    #[test]
    fn step_bar_parsing() {
        assert_eq!(parse_step_bar("  |=====>                                            | 2/20 - 1.99s/it"), Some((2, 20, Some(1.99))));
        assert_eq!(parse_step_bar("|====| 4/8 - 2.00it/s"), Some((4, 8, Some(0.5))));
        assert_eq!(parse_step_bar("  |#############    | 98/397 - 3.76GB/s"), None);
        assert_eq!(parse_step_bar("random text"), None);
    }

    /// Real log excerpt captured from sd-server 3f8527a during an edit job.
    const EDIT_LOG: &str = "[INFO   ] image.cpp:814  - generate_image 1024x1024
[INFO   ] diffusion_engine.cpp:3012 - Using 'qwen' preset for reference images
[INFO   ] request.cpp:420  - sampling using Euler method
[INFO   ] image.cpp:274  - EDIT mode
  |##################################################| 98/98 - 728.50MB/s\u{1b}[K
[INFO   ] image.cpp:398  - encode_first_stage completed, taking 0.99s
[INFO   ] image.cpp:529  - get_learned_condition completed, taking 4.30s
[INFO   ] image.cpp:866  - generating image: 1/1 - seed 3
  |==>                                               | 1/20 - 12.44s/it\u{1b}[K\r  |=====>      | 2/20 - 2.57s/it\u{1b}[K\r  |=======>     | 3/20 - 2.47s/it
[INFO   ] image.cpp:899  - sampling completed, taking 53.57s
[INFO   ] image.cpp:554  - decoding 1 latents
  |########################                          | 59/128 - 931.44MB/s
[INFO   ] image.cpp:620  - latent 1 decoded, taking 1.15s
[INFO   ] image.cpp:1050 - generate_image completed in 61.38s";

    #[test]
    fn progress_from_real_log() {
        let mut p = ProgressParser::default();
        let updates: Vec<BackendProgress> = EDIT_LOG.split(['\n', '\r']).filter_map(|l| p.feed(l)).collect();
        let stages: Vec<BackendStage> = updates.iter().map(|u| u.stage).collect();
        assert_eq!(stages.first(), Some(&BackendStage::Preparing));
        assert!(stages.contains(&BackendStage::EncodingImages));
        assert!(stages.contains(&BackendStage::EncodingPrompt));
        assert!(stages.contains(&BackendStage::Decoding));
        assert_eq!(stages.last(), Some(&BackendStage::Finishing));
        let steps: Vec<(u32, u32)> = updates.iter().filter_map(|u| u.step).collect();
        assert_eq!(steps, vec![(1, 20), (2, 20), (3, 20)]);
        let gen_ = updates.iter().find(|u| u.stage == BackendStage::Generating).unwrap();
        assert_eq!(gen_.image, Some((1, 1)));
        // The tensor-loading bar during decode must not be mistaken for steps.
        assert!(updates.iter().all(|u| u.step.map(|s| s.1) != Some(128)));
    }

    #[test]
    fn step_bar_followed_by_log_line_on_same_line() {
        // Captured from sd-server 3f8527a: the step bar is immediately followed by a log line.
        let mut p = ProgressParser::default();
        p.feed("[INFO   ] image.cpp:814  - generate_image 1376x768");
        p.feed("[INFO   ] image.cpp:866  - generating image: 1/1 - seed 7");
        let u = p.feed("  |==>        | 1/20 - 4.05s/it\u{1b}[K[INFO   ] ggml_graph_cut.cpp:1034 - qwen_image_2_1 build cached graph cut plan done").unwrap();
        assert_eq!(u.step, Some((1, 20)));
        let u = p.feed("  |=====>     | 20/20 - 2.01s/it\u{1b}[K[INFO   ] image.cpp:899  - sampling completed, taking 41.67s").unwrap();
        assert_eq!(u.step, Some((20, 20)));
    }

    #[test]
    fn launch_port_falls_back_when_the_port_cannot_be_opened() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = taken.local_addr().unwrap().port();
        let p = launch_port(busy).unwrap();
        assert_ne!(p, busy);
        assert!(std::net::TcpListener::bind(("127.0.0.1", p)).is_ok(), "the fallback is free");
        let free = free_port().unwrap();
        assert_eq!(launch_port(free), Some(free), "a free configured port is kept");
    }

    #[test]
    fn parser_ignores_lines_before_a_job() {
        let mut p = ProgressParser::default();
        assert!(p.feed("  |==>   | 1/20 - 2.0s/it").is_none());
        assert!(p.feed("[INFO] listening on: http://127.0.0.1:39150").is_none());
    }

    #[test]
    fn device_list() {
        let out = "ggml_cuda_init: found 1 CUDA devices:\n  Device 0: NVIDIA GeForce RTX 5070 Ti, compute capability 12.0\nCUDA0\tNVIDIA GeForce RTX 5070 Ti\nCPU\tAMD Ryzen 7 7700 8-Core Processor              \n";
        assert_eq!(
            parse_device_list(out),
            vec![("CUDA0".into(), "NVIDIA GeForce RTX 5070 Ti".into()), ("CPU".into(), "AMD Ryzen 7 7700 8-Core Processor".into())]
        );
        // ggml's Vulkan backend (device names as ggml registers them; not yet captured from a real run).
        // Device names reported by the Metal build on an M2 Pro (2026-10-09); descriptions illustrative.
        let out = "MTL0	Apple M2 Pro
BLAS	Accelerate
CPU	Apple M2 Pro
";
        assert_eq!(parse_device_list(out)[0].0, "MTL0");
        let mut cfg = AppConfig::default();
        cfg.gpu_backend = crate::config::GpuBackend::Metal;
        assert!(parse_device_list(out).iter().any(|(n, _)| n.to_ascii_lowercase() == cfg.effective_device()));
        let out = "ggml_vulkan: Found 1 Vulkan devices:\nggml_vulkan: 0 = AMD Radeon RX 7800 XT (AMD proprietary driver) | uma: 0 | fp16: 1\nVulkan0\tAMD Radeon RX 7800 XT\nCPU\tAMD Ryzen 7 7700\n";
        assert_eq!(parse_device_list(out)[0], ("Vulkan0".into(), "AMD Radeon RX 7800 XT".into()));
    }

    /// Regression: on Linux a crashed sd-server stayed a zombie under its pid, so the job
    /// poll loop never saw it exit and waited forever.
    #[cfg(unix)]
    #[test]
    fn owned_alive_sees_a_launched_server_exit() {
        // `sleep` under the name sd-server, so `process_alive` recognizes it.
        let dir = std::env::temp_dir().join(format!("qls-owned-alive-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("sd-server");
        std::fs::copy("/bin/sleep", &exe).unwrap();
        let mut child = std::process::Command::new(&exe).arg("30").spawn().unwrap();
        let pid = child.id();
        child.kill().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // The bug itself: on Linux the zombie keeps its name under its pid. macOS reports no name
        // for a zombie, so there it never looked alive; the checks below hold on both.
        if cfg!(target_os = "linux") {
            assert!(process_alive(pid), "the dead, unreaped server still looks alive by pid (zombie)");
        }
        let m = ServerManager::new(dir.clone());
        m.set_state(|g| {
            g.owned = true;
            g.pid = Some(pid);
            g.child = Some(child);
        });
        assert_eq!(m.owned_alive(), Some(false), "try_wait sees the exit");
        assert!(!process_alive(pid), "and reaps it");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
