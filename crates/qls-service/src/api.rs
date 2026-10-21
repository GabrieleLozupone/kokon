//! Stable local API, versioned under /api/v1. Loopback-only, token-protected, and
//! independent of sd-server's own schema (the engine adapts between the two).

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path as AxPath, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response, Sse, sse::Event as SseEvent},
    routing::{delete, get, post},
};
use futures_util::stream::Stream;
use qls_core::{
    catalog,
    config::{AppConfig, GpuBackend, OFFICIAL_PROFILE_ID, USER_PROFILE_ID},
    diagnostics,
    engine::{APP_VERSION, JobView, LoraPatch},
    error::{AppError, ErrorCode},
    geometry::{ExpansionUnits, Size, aspect_label},
    imaging, installer,
    modelfile::{self, FileInfo, Role, Slot},
    paths,
    planner::{GenerationRequest, InpaintAction, Mode, OutpaintSpec, Quality, UpscaleMethod, UpscaleSpec},
    store::{GenerationRecord, ListQuery},
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::StreamExt;

use crate::{AppState, Lease};

type St = State<Arc<AppState>>;

struct ApiError(AppError);

impl From<AppError> for ApiError {
    fn from(e: AppError) -> Self {
        Self(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.0.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "error": self.0 }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

const ALLOWED_ORIGINS: &[&str] = &["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "http://localhost:1420"];

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/status", get(status))
        .route("/setup", get(setup))
        .route("/setup/hardware", get(setup_hardware))
        .route("/setup/install", get(install_status).post(install_start))
        .route("/setup/install/cancel", post(install_cancel))
        .route("/setup/gpu", post(setup_gpu))
        .route("/setup/legacy-upscalers", get(legacy_upscalers).delete(remove_legacy_upscalers))
        .route("/models", get(models_status))
        .route("/models/scan", post(models_scan))
        .route("/models/inspect", post(models_inspect))
        .route("/models/user", post(models_set_user))
        .route("/models/use", post(models_use))
        .route("/models/vae", post(models_improve_vae))
        .route("/upscalers", get(list_upscalers))
        .route("/upscalers/{name}/download", post(download_upscaler))
        .route("/config", get(get_config).put(put_config))
        .route("/enhancer/defaults", get(enhancer_defaults))
        .route("/backend/start", post(backend_start))
        .route("/backend/stop", post(backend_stop))
        .route("/backend/restart", post(backend_restart))
        .route("/diagnostics", get(diagnostics_json))
        .route("/logs", get(logs))
        .route("/plan", post(plan))
        .route("/jobs", get(list_jobs).post(create_job))
        .route("/jobs/{id}", get(get_job))
        .route("/jobs/{id}/cancel", post(cancel_job))
        .route("/jobs/{id}/wait", get(wait_job))
        .route("/generate", post(op_generate))
        .route("/edit", post(op_edit))
        .route("/inpaint", post(op_inpaint))
        .route("/outpaint", post(op_outpaint))
        .route("/upscale", post(op_upscale))
        .route("/events", get(events))
        .route("/inputs/import", post(import_input))
        .route("/private/clear", post(private_clear))
        .route("/inputs/{id}", get(get_input))
        .route("/inputs/{id}/image", get(input_image))
        .route("/inputs/{id}/thumb", get(input_thumb))
        .route("/gallery", get(gallery_list))
        .route("/gallery/{id}", get(gallery_get).patch(gallery_patch).delete(gallery_delete))
        .route("/gallery/{id}/image", get(gallery_image))
        .route("/gallery/{id}/thumb", get(gallery_thumb))
        .route("/gallery/{id}/original", get(gallery_original))
        .route("/gallery/{id}/export", post(gallery_export))
        .route("/image-info", post(image_info))
        .route("/loras", get(loras_list).post(loras_add))
        .route("/loras/{id}", delete(loras_remove).patch(loras_update))
        .route("/luts", get(luts_list))
        .route("/luts/import", post(luts_import))
        .route("/luts/{name}", delete(luts_remove))
        .route("/luts/{name}/preview", get(luts_preview))
        .route("/luts/{name}/apply", post(luts_apply))
        .route("/examples", post(install_examples))
        .route("/session/heartbeat", post(heartbeat))
        .route("/session/release", post(release))
        .route("/shutdown", post(shutdown))
        .layer(middleware::from_fn_with_state(state.clone(), auth))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024));
    let uploads = Router::new().route("/inputs", post(upload_input)).layer(DefaultBodyLimit::max(210 * 1024 * 1024));
    Router::new()
        .route("/api/v1/ping", get(ping))
        .nest("/api/v1", api.merge(uploads.layer(middleware::from_fn_with_state(state.clone(), auth))))
        .layer(middleware::from_fn(cors))
        .with_state(state)
}

/// CORS for the desktop webview origins only; everything else gets no CORS headers.
async fn cors(req: Request, next: Next) -> Response {
    let origin = req.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok()).map(str::to_owned);
    let allowed = origin.as_deref().filter(|o| ALLOWED_ORIGINS.contains(o)).map(str::to_owned);
    if req.method() == Method::OPTIONS {
        let mut r = StatusCode::NO_CONTENT.into_response();
        if let Some(o) = allowed {
            set_cors(r.headers_mut(), &o);
        }
        return r;
    }
    let mut r = next.run(req).await;
    // Windows PowerShell 5.1 decodes JSON without an explicit charset as Latin-1.
    if r.headers().get(header::CONTENT_TYPE).map(|v| v == "application/json").unwrap_or(false) {
        r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"));
    }
    if let Some(o) = allowed {
        set_cors(r.headers_mut(), &o);
    }
    // Responses differ by Origin (CORS headers), so caches must not reuse one for the other.
    r.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
    r
}

fn set_cors(h: &mut HeaderMap, origin: &str) {
    if let Ok(v) = HeaderValue::from_str(origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
    }
    h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, OPTIONS"));
    h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("authorization, content-type, x-filename"));
    h.insert(header::VARY, HeaderValue::from_static("Origin"));
}

/// Bearer token (or `?token=` for <img>/EventSource), and a foreign-Origin block so web
/// pages open in a browser cannot drive the local API.
async fn auth(State(s): St, req: Request, next: Next) -> Response {
    if let Some(o) = req.headers().get(header::ORIGIN).and_then(|o| o.to_str().ok())
        && !ALLOWED_ORIGINS.contains(&o)
    {
        return ApiError(AppError::new(ErrorCode::Unauthorized, "Requests from web pages are not allowed.")).into_response();
    }
    let header_tok = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    let query_tok = req.uri().query().and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("token=")).map(str::to_owned));
    let ok = header_tok.or(query_tok).map(|t| constant_eq(t.as_bytes(), s.token.as_bytes())).unwrap_or(false);
    if !ok {
        return ApiError(AppError::new(ErrorCode::Unauthorized, "Missing or invalid API token (see service.json).")).into_response();
    }
    // No `touch()` here: heartbeats and status polls are not work, and counting them kept
    // the model loaded for as long as an MCP client stayed connected.
    next.run(req).await
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn ping() -> Json<Value> {
    Json(json!({ "service": "kokon", "version": APP_VERSION }))
}

// ---------------------------------------------------------------------------------------
// Status, setup, config, backend
// ---------------------------------------------------------------------------------------

async fn status(State(s): St) -> Json<Value> {
    let e = s.engine.clone();
    let gpu = tokio::task::spawn_blocking(move || e.gpu()).await.ok().flatten();
    let srv = s.engine.server.status();
    let jobs = s.engine.jobs();
    let queued = jobs.iter().filter(|j| j.status == qls_core::engine::JobStatus::Queued).count();
    let cfg = s.engine.config();
    let e = s.engine.clone();
    let engine_update = tokio::task::spawn_blocking(move || e.engine_update_needed()).await.unwrap_or(false);
    Json(json!({
        "service": { "version": APP_VERSION, "pid": std::process::id(), "uptime_s": s.started.elapsed().as_secs() },
        "server": {
            "state": srv.state, "owned": srv.owned, "pid": srv.pid, "port": if srv.port > 0 { srv.port } else { cfg.server_port },
            "model": srv.model, "model_loaded": srv.state == qls_core::process::ServerState::Ready,
            "error": srv.error,
            "cancel_generating": srv.capabilities.as_ref().map(|c| c.img_feature("cancel_generating")),
            "samplers": srv.capabilities.as_ref().map(|c| c.samplers.clone()).unwrap_or_default(),
            "schedulers": srv.capabilities.as_ref().map(|c| c.schedulers.clone()).unwrap_or_default(),
            "upscale": srv.capabilities.as_ref().map(|c| c.upscale),
            "text_generation": srv.capabilities.as_ref().map(|c| c.text_generation),
        },
        "upscaler": { "model": cfg.upscaler().map(|u| u.0).unwrap_or_else(|| cfg.upscaler_model.clone()), "available": cfg.upscaler_file().is_some() },
        "engine": { "release": catalog::engine_tag(), "update_needed": engine_update },
        "profile": { "id": cfg.profile().id, "display_name": cfg.profile().display_name, "source": cfg.profile().source },
        "gpu": gpu,
        "active_job": s.engine.active_job(),
        "queue": { "queued": queued, "jobs": jobs.iter().filter(|j| !j.status.is_terminal()).collect::<Vec<_>>() },
        "setup_complete": cfg.setup_complete,
    }))
}

async fn setup(State(s): St) -> ApiResult<Json<Value>> {
    let e = s.engine.clone();
    let _ = tokio::task::spawn_blocking(move || e.place_bundled_upscaler()).await;
    let cfg = s.engine.config();
    let srv_ok = s.engine.server.status().state == qls_core::process::ServerState::Ready;
    let e = s.engine.clone();
    let report = tokio::task::spawn_blocking(move || diagnostics::setup_checks_with(&cfg, Some(srv_ok), e.devices(), e.backend_version())).await.map_err(AppError::internal)?;
    Ok(Json(serde_json::to_value(report).unwrap()))
}

/// What the setup wizard shows: the GPU, the recommended preset and, per preset, which files
/// are installed in the configured folder and how much is left to download.
#[derive(Deserialize)]
struct HardwareQ {
    /// Engine to list the downloads for; default: the configured one.
    backend: Option<GpuBackend>,
    /// Card (index in `gpus`) to size the presets for; default: the one in use.
    gpu: Option<usize>,
}

async fn setup_hardware(State(s): St, Query(q): Query<HardwareQ>) -> ApiResult<Json<Value>> {
    let engine = s.engine.clone();
    let v = tokio::task::spawn_blocking(move || {
        let cfg = engine.config();
        let cards = engine.gpus();
        let in_use = engine.gpu_index();
        let card = q.gpu.filter(|&i| i < cards.len()).unwrap_or(in_use);
        let gpu = cards.get(card).cloned();
        let detected = gpu.as_ref().map(|g| g.planning_mib());
        let vram = cfg.planning_vram_mib(detected);
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let dir = cfg.sdcpp_dir.clone();
        let vendor = gpu.as_ref().map(|g| g.vendor.clone());
        let recommended_backend = vendor.as_deref().map(GpuBackend::for_vendor).unwrap_or_default();
        let backend = q.backend.unwrap_or(if cfg.setup_complete { cfg.gpu_backend } else { recommended_backend });
        let unified = gpu.as_ref().is_some_and(|g| g.unified);
        let presets: Vec<Value> = catalog::PRESETS
            .iter()
            .filter(|p| p.offered(unified))
            .map(|p| {
                let files = catalog::downloads_for(p, backend, &dir);
                let (download, disk) = installer::space_needed(&dir, &files);
                json!({
                    "id": p.id, "label": if unified { p.unified_label } else { p.label }, "summary": if unified { p.unified_summary } else { p.summary }, "verified": p.verified, "min_vram_mib": p.min_vram_mib,
                    "files": installer::preview(&dir, &files), "download_bytes": download, "disk_bytes": disk,
                })
            })
            .collect();
        // The user's own files: what their profile still needs (engine, upscalers, official
        // pieces they chose to download).
        let user_files = cfg.user_profile().map(|u| {
            let files = catalog::downloads_for_profile(u, backend);
            let (download, disk) = installer::space_needed(&dir, &files);
            json!({ "files": installer::preview(&dir, &files), "download_bytes": download, "disk_bytes": disk })
        });
        json!({
            "active_source": cfg.profile().source,
            "user_files": user_files,
            "gpu": gpu,
            "gpus": cards.iter().map(|c| json!({ "name": c.name, "memory_total_mib": c.memory_total_mib })).collect::<Vec<_>>(),
            "gpu_index": card,
            "gpu_in_use": in_use,
            "nvidia": vendor.as_deref() == Some("nvidia"),
            "vendor": vendor,
            "backend": backend,
            "recommended_backend": recommended_backend,
            "vram_mib": vram,
            "vram_simulated": cfg.vram_override_mib > 0,
            "ram_total_mib": sys.total_memory() / (1024 * 1024),
            "recommended": catalog::recommended_preset(vram, unified).id,
            "current": cfg.hardware_preset,
            "current_backend": cfg.gpu_backend,
            "presets": presets,
            "sdcpp_dir": dir,
            "default_sdcpp_dir": qls_core::config::default_sdcpp_dir(),
            "free_bytes": installer::free_space(&dir),
            "issues_url": catalog::ISSUES_URL,
        })
    })
    .await
    .map_err(AppError::internal)?;
    Ok(Json(v))
}

#[derive(Deserialize)]
struct InstallBody {
    preset: String,
    /// Engine to install; default: the configured one.
    backend: Option<GpuBackend>,
    /// Make the preset active when done (false: an engine update keeps the current settings).
    #[serde(default = "yes")]
    apply: bool,
    /// Card (index in `/setup/hardware` `gpus`) to run on once the engine is installed.
    gpu: Option<usize>,
    /// Which files: "official" (the preset's, made active when done) or "user" (the engine
    /// and what the user's own profile still needs). Default: "official" when `apply`, else
    /// the active profile's (an engine update never downloads models a user doesn't use).
    target: Option<String>,
}

fn yes() -> bool {
    true
}

/// Starts downloading a preset into the configured folder. When every file is installed the
/// preset's runtime settings apply, and for the official files their profile becomes active.
async fn install_start(State(s): St, Json(b): Json<InstallBody>) -> ApiResult<Json<Value>> {
    let preset = catalog::preset(&b.preset).ok_or_else(|| AppError::invalid(format!("Unknown preset {}.", b.preset)))?;
    let cfg = s.engine.config();
    let backend = b.backend.unwrap_or(cfg.gpu_backend);
    let user = match b.target.as_deref() {
        Some("user") => true,
        Some("official") => false,
        None => !b.apply && !cfg.profile().is_official(),
        Some(t) => return Err(AppError::invalid(format!("Unknown install target {t}.")).into()),
    };
    let downloads = if user {
        let u = cfg.user_profile().ok_or_else(|| AppError::invalid("Choose your model files first."))?;
        catalog::downloads_for_profile(u, backend)
    } else {
        catalog::downloads_for(preset, backend, &cfg.sdcpp_dir)
    };
    // A running server keeps its DLLs open; the engine zip may need to replace them.
    let st = s.engine.server.status();
    if st.owned && st.state != qls_core::process::ServerState::Stopped {
        if s.engine.has_pending_work() {
            return Err(AppError::new(ErrorCode::QueueFull, "Wait for the current images to finish, then install.").into());
        }
        s.engine.server.stop().await;
        s.engine.emit_server();
    }
    let engine = s.engine.clone();
    // Below ~8 GiB of planning memory (a 16 GB Mac) only streaming weights from disk fits.
    let small_unified = s.engine.gpu().is_some_and(|g| g.unified && g.planning_mib() < 8 * 1024);
    let apply = b.apply;
    let card = b.gpu;
    let on_finish = Box::new(move |complete: bool| {
        if !complete || !apply {
            return;
        }
        let mut c = engine.config();
        c.apply_preset(preset);
        if !user {
            c.use_official();
        }
        c.gpu_backend = backend;
        if backend == GpuBackend::Metal && small_unified {
            c.text_encoder_placement = qls_core::config::TextEncoderPlacement::Disk;
        }
        if let Err(e) = engine.set_config(c) {
            tracing::error!("could not save the installed preset: {}", e.message);
        }
        // The engine can name its devices only now that it is installed.
        if let Some(i) = card {
            match engine.use_card(i) {
                Ok(Some(_)) => {}
                Ok(None) => tracing::warn!("the engine does not list card {i}; keeping device {}", engine.config().device),
                Err(e) => tracing::error!("could not save the chosen GPU: {}", e.message),
            }
        }
    });
    // The bundled upscaler first, so it is not downloaded again.
    let e = s.engine.clone();
    let _ = tokio::task::spawn_blocking(move || e.place_bundled_upscaler()).await;
    let label = if user { format!("user:{}", preset.id) } else { preset.id.to_string() };
    s.engine.installer.start(cfg.sdcpp_dir.clone(), &label, downloads, on_finish)?;
    Ok(Json(serde_json::to_value(s.engine.installer.status()).unwrap()))
}

/// The upscalers Settings offers, with whether each is installed and what it takes to get it.
async fn list_upscalers(State(s): St) -> Json<Value> {
    let cfg = s.engine.config();
    let active = cfg.upscaler().map(|u| u.0);
    let items: Vec<Value> = qls_core::config::UPSCALER_CHOICES
        .iter()
        .map(|(name, label)| {
            let d = catalog::upscaler_download(name);
            let installed = d.is_none_or(|d| d.is_present(&cfg.sdcpp_dir));
            json!({ "name": name, "label": label, "installed": installed, "size": d.map(|d| d.size), "page": d.map(|d| d.page) })
        })
        .collect();
    Json(json!({ "selected": cfg.upscaler_model, "active": active, "items": items }))
}

/// Downloads one upscaler model (progress in `/setup/install`).
async fn download_upscaler(State(s): St, AxPath(name): AxPath<String>) -> ApiResult<Json<Value>> {
    let d = catalog::upscaler_download(&name).ok_or_else(|| AppError::invalid(format!("Unknown upscaler {name}.")))?;
    let dir = s.engine.config().sdcpp_dir;
    s.engine.installer.start(dir, &format!("upscaler:{name}"), vec![d], Box::new(|_| {}))?;
    Ok(Json(serde_json::to_value(s.engine.installer.status()).unwrap()))
}

/// Upscaler models of earlier versions in the app's own folder (Settings offers to delete
/// them; files elsewhere are never touched).
#[derive(Deserialize)]
struct KeepQ {
    /// Another model to keep besides the saved one (an unsaved choice in Settings).
    keep: Option<String>,
}

async fn legacy_upscalers(State(s): St, Query(q): Query<KeepQ>) -> Json<Value> {
    let cfg = s.engine.config();
    let files = installer::legacy_upscalers(&cfg.sdcpp_dir, &[cfg.upscaler_model.trim(), q.keep.as_deref().unwrap_or("")]);
    let bytes: u64 = files.iter().map(|(_, n)| n).sum();
    Json(json!({ "files": files.iter().map(|(p, _)| p).collect::<Vec<_>>(), "bytes": bytes }))
}

async fn remove_legacy_upscalers(State(s): St, Query(q): Query<KeepQ>) -> ApiResult<Json<Value>> {
    let cfg = s.engine.config();
    let keep = q.keep.unwrap_or_default();
    let freed = tokio::task::spawn_blocking(move || installer::remove_legacy_upscalers(&cfg.sdcpp_dir, &[cfg.upscaler_model.trim(), keep.as_str()])).await.map_err(AppError::internal)??;
    Ok(Json(json!({ "freed_bytes": freed })))
}

#[derive(Deserialize)]
struct GpuBody {
    /// Index in `/setup/hardware` `gpus`.
    gpu: usize,
}

/// Runs the engine on another card (setup's GPU picker).
async fn setup_gpu(State(s): St, Json(b): Json<GpuBody>) -> ApiResult<Json<Value>> {
    let e = s.engine.clone();
    let r = tokio::task::spawn_blocking(move || e.use_card(b.gpu)).await.map_err(AppError::internal)??;
    let Some(restart) = r else {
        return Err(AppError::invalid("The engine does not see this graphics card. Pick it in Settings → Performance → GPU device.").into());
    };
    let st = s.engine.server.status();
    if restart && st.owned && st.state != qls_core::process::ServerState::Stopped && !s.engine.has_pending_work() {
        s.engine.server.stop().await;
        s.engine.emit_server();
    }
    Ok(Json(json!({ "saved": true })))
}

async fn install_status(State(s): St) -> Json<Value> {
    Json(serde_json::to_value(s.engine.installer.status()).unwrap())
}

async fn install_cancel(State(s): St) -> Json<Value> {
    s.engine.installer.cancel();
    Json(serde_json::to_value(s.engine.installer.status()).unwrap())
}

async fn get_config(State(s): St) -> Json<AppConfig> {
    Json(s.engine.config())
}

/// The prompt enhancer's built-in system prompts (Settings shows them for "" and restores them).
async fn enhancer_defaults() -> Json<Value> {
    use qls_core::enhancer;
    Json(json!({ "t2i": enhancer::T2I_SYSTEM_PROMPT, "edit": enhancer::EDIT_SYSTEM_PROMPT, "max_chars": enhancer::MAX_SYSTEM_PROMPT_CHARS }))
}

async fn put_config(State(s): St, Json(cfg): Json<AppConfig>) -> ApiResult<Json<Value>> {
    let restart = s.engine.set_config(cfg)?;
    let st = s.engine.server.status();
    if restart && st.owned && st.state == qls_core::process::ServerState::Ready && !s.engine.has_pending_work() {
        s.engine.server.stop().await;
        s.engine.emit_server();
    }
    Ok(Json(json!({ "saved": true, "backend_restart_needed": restart })))
}

async fn backend_start(State(s): St) -> ApiResult<Json<Value>> {
    let cfg = s.engine.config();
    let engine = s.engine.clone();
    engine.emit_server();
    let r = engine.server.ensure_ready(&cfg).await;
    engine.emit_server();
    let caps = r?;
    Ok(Json(json!({ "ready": true, "model": caps.model.name })))
}

async fn backend_stop(State(s): St) -> Json<Value> {
    let stopped = s.engine.server.stop().await;
    s.engine.emit_server();
    Json(json!({ "stopped": stopped }))
}

async fn backend_restart(State(s): St) -> ApiResult<Json<Value>> {
    s.engine.server.stop().await;
    backend_start(State(s)).await
}

async fn diagnostics_json(State(s): St) -> ApiResult<Json<Value>> {
    let engine = s.engine.clone();
    let v = tokio::task::spawn_blocking(move || {
        let cfg = engine.config();
        let gpus = diagnostics::query_gpus();
        let srv = engine.server.status();
        let version = engine.backend_version();
        let devices = diagnostics::list_devices(&cfg.server_exe());
        let log = engine.server.log.tail(300);
        let args = qls_core::process::build_server_args(&cfg, cfg.profile());
        let mut text = String::new();
        use std::fmt::Write;
        let _ = writeln!(text, "Kokon {APP_VERSION} — diagnostics ({})", qls_core::store::now_rfc3339());
        let _ = writeln!(text, "\n[GPU]");
        match &gpus {
            Some(g) => {
                for x in g {
                    let _ = writeln!(text, "{} — {} MiB total, {} MiB used, {} MiB free, driver {}{}", x.name, x.memory_total_mib, x.memory_used_mib, x.memory_free_mib, x.driver_version, if x.compute_capability.is_empty() { String::new() } else { format!(", compute capability {}", x.compute_capability) });
                }
            }
            None => {
                let _ = writeln!(text, "nvidia-smi not available");
            }
        }
        let _ = writeln!(text, "Backend devices: {}", devices.iter().map(|(n, d)| format!("{n} ({d})")).collect::<Vec<_>>().join(", "));
        let cuda = devices.iter().any(|(n, _)| n.to_ascii_lowercase().starts_with("cuda"));
        let _ = writeln!(text, "CUDA backend: {}", if cuda { "available" } else { "NOT available" });
        let _ = writeln!(text, "\n[Inference server]");
        let _ = writeln!(text, "stable-diffusion.cpp: {}", version.clone().unwrap_or_else(|| "unknown".into()));
        let tags: Vec<String> = catalog::engine_downloads(cfg.gpu_backend)
            .iter()
            .filter(|d| d.engine_tag.is_some())
            .map(|d| d.installed_tag(&cfg.sdcpp_dir).unwrap_or_else(|| "none".into()))
            .collect();
        let _ = writeln!(text, "Engine release: {} (expected {})", tags.join(", "), catalog::engine_tag());
        let _ = writeln!(text, "State: {:?}, owned: {}, pid: {:?}, port: {}", srv.state, srv.owned, srv.pid, srv.port);
        if let Some(e) = &srv.error {
            let _ = writeln!(text, "Last error: {} {}", e.message, e.detail.clone().unwrap_or_default());
        }
        let _ = writeln!(text, "Launch: sd-server.exe {}", args.join(" "));
        if let Some(c) = &srv.capabilities {
            let _ = writeln!(text, "Model: {} ({})", c.model.name, c.model.path);
            let _ = writeln!(text, "Modes: {:?}; limits {}..{} px; features {}", c.supported_modes, c.limits.min_width, c.limits.max_width, c.features_by_mode);
            let models: Vec<&str> = c.upscalers.iter().filter(|u| u.model).map(|u| u.name.as_str()).collect();
            let _ = writeln!(text, "Upscalers: {} (image upscale: {})", if models.is_empty() { "none".into() } else { models.join(", ") }, c.upscale);
        }
        let _ = writeln!(text, "\n[Configuration]");
        let _ = writeln!(text, "sdcpp dir: {}", cfg.sdcpp_dir.display());
        let official = cfg.profile().is_official();
        let _ = writeln!(text, "Preset: {}, profile: {} ({})", cfg.hardware_preset, cfg.profile().display_name, if official { "official files" } else { "the user's own files, not tested by Kokon" });
        if cfg.vram_override_mib > 0 {
            let _ = writeln!(text, "Simulated VRAM for planning: {} MiB", cfg.vram_override_mib);
        }
        for (label, p, _) in cfg.profile().files() {
            let state = match (p.is_file(), official) {
                (false, _) => "MISSING".to_string(),
                (true, true) => "ok".to_string(),
                // Own files: what they are, so a report shows the quantization in use.
                (true, false) => modelfile::inspect(p).map(|i| format!("ok, {:.2} GB, {}{}", i.size as f64 / 1e9, i.weights, i.problem.map(|e| format!(", {e}")).unwrap_or_default())).unwrap_or_else(|e| e.to_string()),
            };
            let _ = writeln!(text, "{label}: {} ({state})", p.display());
        }
        let _ = writeln!(text, "Device: {}, text encoder: {:?}, VRAM reserve: {} GiB, flash attention: {}, sage attention: {} (in use: {})", cfg.device, cfg.text_encoder_placement, cfg.vram_reserve_gib, cfg.flash_attention, cfg.sage_attention, cfg.uses_sage_attention());
        let _ = writeln!(text, "VAE tile size: {}, upscale tile size: {}", cfg.vae_tile_size, cfg.upscale_tile_size);
        let up = diagnostics::upscaler_check(&cfg);
        let model = cfg.upscaler().map(|u| u.0).unwrap_or_default();
        let tile = qls_core::planner::upscale_tile(cfg.upscale_tile_size, cfg.planning_vram_mib(gpus.as_ref().and_then(|g| g.first()).map(|g| g.planning_mib())), &model);
        let _ = writeln!(text, "Upscaler: {} (tile {tile} px, blend {:.0} %, pre-shrink {})", up.detail, cfg.upscale_blend * 100.0, cfg.upscale_prescale);
        let _ = writeln!(text, "Ports: server {}, service {}", cfg.server_port, cfg.service_port);
        let _ = writeln!(text, "Output: {}", cfg.output_dir.display());
        let _ = writeln!(text, "Data: {}", qls_core::config::data_dir().display());
        let _ = writeln!(text, "\n[Server log — last {} lines]", log.len());
        for l in &log {
            let _ = writeln!(text, "{l}");
        }
        json!({
            "gpus": gpus, "devices": devices, "cuda_available": cuda, "backend_version": version,
            "server": srv, "launch_args": args, "config": cfg, "log": log, "text": text,
        })
    })
    .await
    .map_err(AppError::internal)?;
    Ok(Json(v))
}

#[derive(Deserialize)]
struct LinesQ {
    lines: Option<usize>,
}

async fn logs(State(s): St, Query(q): Query<LinesQ>) -> Json<Value> {
    Json(json!({ "lines": s.engine.server.log.tail(q.lines.unwrap_or(200).min(4000)) }))
}

// ---------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct JobBody {
    #[serde(flatten)]
    request: GenerationRequest,
    /// Caller's project folder (MCP): relative paths resolve here; allowed output root.
    #[serde(default)]
    workspace: Option<String>,
}

fn workspace_path(w: Option<&str>) -> Result<Option<PathBuf>, AppError> {
    match w {
        Some(w) if !w.trim().is_empty() => {
            let p = paths::normalize(w, None)?;
            if !p.is_dir() {
                return Err(AppError::new(ErrorCode::InvalidPath, format!("Workspace folder not found: {}", p.display())));
            }
            Ok(Some(p))
        }
        _ => Ok(None),
    }
}

async fn create_job(State(s): St, Json(b): Json<JobBody>) -> ApiResult<(StatusCode, Json<JobView>)> {
    let ws = workspace_path(b.workspace.as_deref())?;
    let j = s.engine.submit(b.request, ws)?;
    Ok((StatusCode::ACCEPTED, Json(j)))
}

async fn list_jobs(State(s): St) -> Json<Vec<JobView>> {
    Json(s.engine.jobs())
}

async fn get_job(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Json<JobView>> {
    Ok(Json(s.engine.job(&id).ok_or_else(|| AppError::new(ErrorCode::NotFound, "Unknown job."))?))
}

async fn cancel_job(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Json<JobView>> {
    Ok(Json(s.engine.cancel(&id)?))
}

#[derive(Deserialize)]
struct WaitQ {
    timeout: Option<u64>,
}

async fn wait_for(s: &AppState, id: &str, timeout: Duration) -> Result<JobView, AppError> {
    let mut rx = s.engine.events.subscribe();
    let deadline = Instant::now() + timeout;
    loop {
        let j = s.engine.job(id).ok_or_else(|| AppError::new(ErrorCode::NotFound, "Unknown job."))?;
        if j.status.is_terminal() || Instant::now() >= deadline {
            return Ok(j);
        }
        let _ = tokio::time::timeout(Duration::from_millis(1000).min(deadline - Instant::now()), rx.recv()).await;
    }
}

/// Long-poll until the job finishes or `timeout` seconds pass (default 60, max 600).
async fn wait_job(State(s): St, AxPath(id): AxPath<String>, Query(q): Query<WaitQ>) -> ApiResult<Json<JobView>> {
    Ok(Json(wait_for(&s, &id, Duration::from_secs(q.timeout.unwrap_or(60).min(600))).await?))
}

/// Stable convenience endpoints. Body is a simplified request; `?wait=false` returns the
/// queued job immediately, otherwise the call returns when the job finishes.
#[derive(Deserialize, Default)]
#[serde(default)]
struct SimpleOp {
    prompt: String,
    negative_prompt: Option<String>,
    image: Option<String>,
    images: Vec<String>,
    mask: Option<String>,
    /// Inpaint: `edit` (default), `remove`, `replace` or `add`.
    action: Option<InpaintAction>,
    width: Option<u32>,
    height: Option<u32>,
    aspect_ratio: Option<String>,
    quality: Option<Quality>,
    seed: Option<i64>,
    output_path: Option<String>,
    preserve_dimensions: Option<bool>,
    left: f64,
    right: f64,
    top: f64,
    bottom: f64,
    units: Option<ExpansionUnits>,
    workspace: Option<String>,
    client: Option<String>,
    /// Upscale: factor (default 2), or a target `width`/`height`.
    scale: Option<f64>,
    method: Option<UpscaleMethod>,
}

#[derive(Deserialize)]
struct OpQ {
    wait: Option<bool>,
}

async fn run_simple(s: Arc<AppState>, mode: Mode, op: SimpleOp, wait: bool) -> ApiResult<Json<JobView>> {
    let mut images = op.images.clone();
    if let Some(i) = op.image.clone() {
        images.insert(0, i);
    }
    let req = GenerationRequest {
        prompt: op.prompt,
        negative_prompt: op.negative_prompt,
        mode,
        images,
        mask: op.mask,
        inpaint_action: op.action.unwrap_or_default(),
        outpaint: (mode == Mode::Outpaint).then_some(OutpaintSpec { left: op.left, right: op.right, top: op.top, bottom: op.bottom, units: op.units.unwrap_or_default() }),
        quality: op.quality.unwrap_or_default(),
        aspect_ratio: op.aspect_ratio,
        width: op.width,
        height: op.height,
        seed: op.seed,
        preserve_dimensions: op.preserve_dimensions.unwrap_or(true),
        output_path: op.output_path,
        client: op.client.or(Some("api".into())),
        upscale: (mode == Mode::Upscale).then_some(UpscaleSpec { method: op.method.unwrap_or_default(), scale: op.scale, width: op.width, height: op.height }),
        ..Default::default()
    };
    let ws = workspace_path(op.workspace.as_deref())?;
    let j = s.engine.submit(req, ws)?;
    if !wait {
        return Ok(Json(j));
    }
    Ok(Json(wait_for(&s, &j.id, Duration::from_secs(3600)).await?))
}

async fn op_generate(State(s): St, Query(q): Query<OpQ>, Json(op): Json<SimpleOp>) -> ApiResult<Json<JobView>> {
    run_simple(s, Mode::Generate, op, q.wait.unwrap_or(true)).await
}
async fn op_edit(State(s): St, Query(q): Query<OpQ>, Json(op): Json<SimpleOp>) -> ApiResult<Json<JobView>> {
    let mode = if op.images.len() + op.image.is_some() as usize > 1 { Mode::MultiReference } else { Mode::Edit };
    run_simple(s, mode, op, q.wait.unwrap_or(true)).await
}
async fn op_inpaint(State(s): St, Query(q): Query<OpQ>, Json(op): Json<SimpleOp>) -> ApiResult<Json<JobView>> {
    run_simple(s, Mode::Inpaint, op, q.wait.unwrap_or(true)).await
}
async fn op_outpaint(State(s): St, Query(q): Query<OpQ>, Json(op): Json<SimpleOp>) -> ApiResult<Json<JobView>> {
    run_simple(s, Mode::Outpaint, op, q.wait.unwrap_or(true)).await
}
/// `{"image": "...", "scale": 2 | "width"/"height", "prompt"?}`: the upscaler model only.
async fn op_upscale(State(s): St, Query(q): Query<OpQ>, Json(op): Json<SimpleOp>) -> ApiResult<Json<JobView>> {
    run_simple(s, Mode::Upscale, op, q.wait.unwrap_or(true)).await
}

#[derive(Deserialize)]
struct PlanBody {
    #[serde(flatten)]
    request: GenerationRequest,
    #[serde(default)]
    workspace: Option<String>,
}

/// Dry run: resolved mode, working/output size and notes for the current inputs.
async fn plan(State(s): St, Json(b): Json<PlanBody>) -> ApiResult<Json<Value>> {
    let engine = s.engine.clone();
    let ws = workspace_path(b.workspace.as_deref())?;
    let v = tokio::task::spawn_blocking(move || -> Result<Value, AppError> {
        let mut sizes = Vec::new();
        for src in &b.request.images {
            sizes.push(source_size(&engine, src, ws.as_deref())?);
        }
        let mask = match &b.request.mask {
            Some(m) => {
                let (img, _) = engine.resolve_source(m, ws.as_deref(), b.request.private)?;
                let mm = imaging::mask_from_image(&img);
                Some((Size::new(mm.width(), mm.height()), imaging::mask_bbox(&mm, 16), imaging::mask_coverage(&mm, 16)))
            }
            None => None,
        };
        let p = engine.preview_plan(&b.request, sizes, mask)?;
        Ok(serde_json::to_value(p).unwrap())
    })
    .await
    .map_err(AppError::internal)??;
    Ok(Json(v))
}

fn source_size(engine: &qls_core::engine::Engine, src: &str, ws: Option<&Path>) -> Result<Size, AppError> {
    if let Some(id) = src.strip_prefix("input:") {
        let r = engine.input_store(id).get_input(id)?;
        return Ok(Size::new(r.width, r.height));
    }
    if let Some(id) = src.strip_prefix("gen:") {
        let r = engine.gen_store(id).get_generation(id)?;
        return Ok(Size::new(r.width, r.height));
    }
    // Only sizes are needed: a file path is read into the private store, which is temporary.
    let (img, _) = engine.resolve_source(src, ws, true)?;
    Ok(img.size())
}

// ---------------------------------------------------------------------------------------
// Events (SSE)
// ---------------------------------------------------------------------------------------

async fn events(State(s): St) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
    let rx = s.engine.events.subscribe();
    let stream = tokio_stream::wrappers::BroadcastStream::new(rx).filter_map(|r| r.ok()).map(|ev| Ok(SseEvent::default().json_data(ev).unwrap_or_default()));
    Sse::new(stream).keep_alive(axum::response::sse::KeepAlive::new().interval(Duration::from_secs(15)))
}

// ---------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------

#[derive(Deserialize, Default)]
struct PrivateQ {
    #[serde(default)]
    private: bool,
}

async fn upload_input(State(s): St, Query(q): Query<PrivateQ>, headers: HeaderMap, body: Bytes) -> ApiResult<Json<Value>> {
    if body.is_empty() {
        return Err(AppError::invalid("The upload was empty.").into());
    }
    let name = headers.get("x-filename").and_then(|v| v.to_str().ok()).map(|n| percent_decode(n).chars().take(200).collect::<String>());
    let store = if q.private { s.engine.private_store.clone() } else { s.engine.store.clone() };
    let rec = tokio::task::spawn_blocking(move || store.put_input(&body, name.as_deref(), None)).await.map_err(AppError::internal)??;
    Ok(Json(serde_json::to_value(rec).unwrap()))
}

#[derive(Deserialize)]
struct PathBody {
    path: String,
}

async fn import_input(State(s): St, Query(q): Query<PrivateQ>, Json(b): Json<PathBody>) -> ApiResult<Json<Value>> {
    let store = if q.private { s.engine.private_store.clone() } else { s.engine.store.clone() };
    let rec = tokio::task::spawn_blocking(move || -> Result<_, AppError> {
        let p = paths::validate_input_image(&b.path, None, &[])?;
        let bytes = std::fs::read(&p).map_err(|e| AppError::io("read the image", &p, e))?;
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned());
        store.put_input(&bytes, name.as_deref(), Some(&p.to_string_lossy()))
    })
    .await
    .map_err(AppError::internal)??;
    Ok(Json(serde_json::to_value(rec).unwrap()))
}

async fn get_input(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Json<Value>> {
    Ok(Json(serde_json::to_value(s.engine.input_store(&id).get_input(&id)?).unwrap()))
}

/// Ends private mode: deletes every private input and result.
async fn private_clear(State(s): St) -> ApiResult<Json<Value>> {
    let n = s.engine.clear_private()?;
    Ok(Json(json!({ "cleared": n })))
}

async fn serve_file(path: &Path, content_type: Option<&str>) -> ApiResult<Response> {
    let bytes = tokio::fs::read(path).await.map_err(|e| AppError::io("read the image", path, e))?;
    let ct = content_type.map(str::to_owned).unwrap_or_else(|| {
        match path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).as_deref() {
            Some("png") => "image/png",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("webp") => "image/webp",
            Some("gif") => "image/gif",
            Some("bmp") => "image/bmp",
            Some("tif") | Some("tiff") => "image/tiff",
            _ => "application/octet-stream",
        }
        .to_string()
    });
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, ct)
        .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable")
        .body(Body::from(bytes))
        .unwrap())
}

async fn loras_list(State(s): St) -> Json<Value> {
    let cfg = s.engine.config();
    Json(json!({ "items": s.engine.loras(), "dir": cfg.lora_dir(), "max_active": qls_core::lora::MAX_ACTIVE }))
}

/// Loads a LoRA file the user picked: checked against the image model, then copied into
/// Kokon's LoRA folder (the user's file stays as it is).
async fn loras_add(State(s): St, Json(b): Json<PathBody>) -> ApiResult<Json<Value>> {
    let p = PathBuf::from(&b.path);
    if !p.is_absolute() || !p.is_file() {
        return Err(AppError::new(ErrorCode::InvalidInput, "Choose a LoRA file (.safetensors).").into());
    }
    let engine = s.engine.clone();
    let entry = tokio::task::spawn_blocking(move || engine.add_lora(&p)).await.map_err(AppError::internal)??;
    Ok(Json(serde_json::to_value(entry).unwrap()))
}

async fn loras_update(State(s): St, AxPath(id): AxPath<String>, Json(b): Json<LoraPatch>) -> ApiResult<Json<Value>> {
    let entry = s.engine.update_lora(&id, b)?;
    Ok(Json(serde_json::to_value(entry).unwrap()))
}

async fn loras_remove(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Json<Value>> {
    s.engine.remove_lora(&id)?;
    Ok(Json(json!({ "removed": id })))
}

async fn luts_list(State(s): St) -> Json<Value> {
    let lib = s.engine.luts();
    Json(json!({ "items": tokio::task::spawn_blocking(move || lib.list()).await.unwrap_or_default() }))
}

/// Adds a .cube file the user picked to the LUT list (copied into the data folder).
async fn luts_import(State(s): St, Json(b): Json<PathBody>) -> ApiResult<Json<Value>> {
    let p = PathBuf::from(&b.path);
    if !p.is_absolute() || !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cube")) {
        return Err(AppError::new(ErrorCode::InvalidInput, "Choose a .cube LUT file.").into());
    }
    let lib = s.engine.luts();
    let entry = tokio::task::spawn_blocking(move || lib.import(&p)).await.map_err(AppError::internal)??;
    Ok(Json(serde_json::to_value(entry).unwrap()))
}

async fn luts_remove(State(s): St, AxPath(name): AxPath<String>) -> ApiResult<Json<Value>> {
    s.engine.luts().remove(&name)?;
    Ok(Json(json!({ "removed": name })))
}

#[derive(Deserialize)]
struct LutPreviewQ {
    source: String,
    #[serde(default = "default_preview_side")]
    max: u32,
}

fn default_preview_side() -> u32 {
    2048
}

/// The LUT on an image, reduced, for the live preview.
async fn luts_preview(State(s): St, AxPath(name): AxPath<String>, Query(q): Query<LutPreviewQ>) -> ApiResult<Response> {
    let engine = s.engine.clone();
    let (bytes, ct) = tokio::task::spawn_blocking(move || engine.lut_preview(&q.source, &name, q.max)).await.map_err(AppError::internal)??;
    Ok(Response::builder().header(header::CONTENT_TYPE, ct).header(header::CACHE_CONTROL, "no-store").body(Body::from(bytes)).unwrap())
}

#[derive(Deserialize)]
struct LutApplyBody {
    source: String,
    #[serde(default = "default_intensity")]
    intensity: f32,
    #[serde(default)]
    private: bool,
}

fn default_intensity() -> f32 {
    1.0
}

/// Saves the image with the LUT applied as a new version (the source is kept).
async fn luts_apply(State(s): St, AxPath(name): AxPath<String>, Json(b): Json<LutApplyBody>) -> ApiResult<Json<Value>> {
    let engine = s.engine.clone();
    let rec = tokio::task::spawn_blocking(move || engine.apply_lut(&b.source, &name, b.intensity, b.private)).await.map_err(AppError::internal)??;
    Ok(Json(serde_json::to_value(rec).unwrap()))
}

async fn input_image(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let store = s.engine.input_store(&id);
    let r = store.get_input(&id)?;
    if r.format == "heic" {
        return serve_file(&store.input_display_path(&id), Some("image/jpeg")).await;
    }
    serve_file(Path::new(&r.path), None).await
}

async fn input_thumb(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let store = s.engine.input_store(&id);
    store.get_input(&id)?;
    serve_file(&store.input_thumb_path(&id), Some("image/jpeg")).await
}

// ---------------------------------------------------------------------------------------
// Gallery
// ---------------------------------------------------------------------------------------

async fn gallery_list(State(s): St, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let (items, total) = s.engine.store.list_generations(&q)?;
    Ok(Json(json!({ "items": items, "total": total })))
}

async fn gallery_get(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Json<GenerationRecord>> {
    Ok(Json(s.engine.gen_store(&id).get_generation(&id)?))
}

#[derive(Deserialize)]
struct PatchBody {
    favorite: Option<bool>,
}

async fn gallery_patch(State(s): St, AxPath(id): AxPath<String>, Json(b): Json<PatchBody>) -> ApiResult<Json<GenerationRecord>> {
    let store = s.engine.gen_store(&id);
    if let Some(f) = b.favorite {
        store.set_favorite(&id, f)?;
        let _ = s.engine.events.send(qls_core::engine::Event::Gallery { id: id.clone(), change: "updated" });
    }
    Ok(Json(store.get_generation(&id)?))
}

async fn gallery_delete(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Json<Value>> {
    let out = s.engine.output_root(&id);
    s.engine.gen_store(&id).delete_generation(&id, &out)?;
    let _ = s.engine.events.send(qls_core::engine::Event::Gallery { id: id.clone(), change: "deleted" });
    Ok(Json(json!({ "deleted": id })))
}

async fn gallery_image(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let r = s.engine.gen_store(&id).get_generation(&id)?;
    serve_file(Path::new(&r.file_path), None).await
}

/// The result before the upscaler enlarged it, when it was kept.
async fn gallery_original(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let r = s.engine.gen_store(&id).get_generation(&id)?;
    let p = r.pipeline.and_then(|p| p.original_path).ok_or_else(|| AppError::new(ErrorCode::NotFound, "This image has no pre-upscale original."))?;
    serve_file(Path::new(&p), Some("image/png")).await
}

async fn gallery_thumb(State(s): St, AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let store = s.engine.gen_store(&id);
    let p = store.thumb_path(&id);
    if !p.is_file() {
        let r = store.get_generation(&id)?;
        return serve_file(Path::new(&r.file_path), None).await;
    }
    serve_file(&p, Some("image/jpeg")).await
}

#[derive(Deserialize)]
struct ExportBody {
    path: String,
    #[serde(default)]
    overwrite: bool,
    /// Save the pre-upscale original instead of the result.
    #[serde(default)]
    original: bool,
}

/// "Save as" from the desktop app (path chosen in the native dialog, which already
/// confirmed any overwrite). Format follows the extension.
async fn gallery_export(State(s): St, AxPath(id): AxPath<String>, Json(b): Json<ExportBody>) -> ApiResult<Json<Value>> {
    let rec = s.engine.gen_store(&id).get_generation(&id)?;
    let saved = tokio::task::spawn_blocking(move || -> Result<PathBuf, AppError> {
        let mut target = paths::normalize(&b.path, None)?;
        let ext = target.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
        let fmt = match ext.as_deref() {
            Some("jpg") | Some("jpeg") => qls_core::planner::OutputFormat::Jpeg,
            Some("webp") => qls_core::planner::OutputFormat::Webp,
            Some("png") => qls_core::planner::OutputFormat::Png,
            _ => {
                target.set_extension("png");
                qls_core::planner::OutputFormat::Png
            }
        };
        let source = if b.original {
            rec.pipeline.as_ref().and_then(|p| p.original_path.clone()).ok_or_else(|| AppError::new(ErrorCode::NotFound, "This image has no pre-upscale original."))?
        } else {
            rec.file_path.clone()
        };
        if Path::new(&source) == target {
            return Ok(target);
        }
        if !b.overwrite {
            target = paths::unique_path(target, &[]);
        }
        let img = imaging::load_image(Path::new(&source))?;
        let bytes = qls_core::engine::encode_output(&img.pixels, fmt, &rec, img.icc_profile.as_deref())?;
        qls_core::engine::write_atomic(&target, &bytes)?;
        Ok(target)
    })
    .await
    .map_err(AppError::internal)??;
    Ok(Json(json!({ "path": saved })))
}

/// Adds the bundled example projects (first launch, or Settings) and lists them.
async fn install_examples(State(s): St) -> ApiResult<Json<Value>> {
    let engine = s.engine.clone();
    let projects = tokio::task::spawn_blocking(move || engine.install_examples()).await.map_err(AppError::internal)??;
    Ok(Json(json!({ "projects": projects })))
}

async fn image_info(Json(b): Json<PathBody>) -> ApiResult<Json<Value>> {
    let v = tokio::task::spawn_blocking(move || -> Result<Value, AppError> {
        let p = paths::validate_input_image(&b.path, None, &[])?;
        let bytes = std::fs::read(&p).map_err(|e| AppError::io("read the image", &p, e))?;
        let img = imaging::decode_image(&bytes)?;
        let size = img.size();
        let meta = GenerationRecord::from_png_text(&img.text);
        let parameters = img.text.iter().find(|(k, _)| k == "parameters").map(|(_, v)| v.clone());
        Ok(json!({
            "path": p, "width": size.width, "height": size.height, "aspect_ratio": aspect_label(size),
            "aspect_value": (size.width as f64 / size.height as f64 * 10000.0).round() / 10000.0,
            "file_type": img.format, "file_size": bytes.len(), "exif_orientation": img.exif_orientation,
            "has_transparency": img.has_transparency, "has_icc_profile": img.icc_profile.is_some(),
            "generation": meta, "parameters": parameters,
        }))
    })
    .await
    .map_err(AppError::internal)??;
    Ok(Json(v))
}

// ---------------------------------------------------------------------------------------
// Sessions / lifecycle
// ---------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct HeartbeatBody {
    client_id: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    pid: Option<u32>,
}

async fn heartbeat(State(s): St, Json(b): Json<HeartbeatBody>) -> Json<Value> {
    let kind = b.kind.unwrap_or_else(|| "client".into());
    s.leases.lock().unwrap().insert(b.client_id.chars().take(80).collect(), Lease { kind, last_seen: Instant::now(), pid: b.pid });
    *s.exit_deadline.lock().unwrap() = None;
    s.quick_exit.store(false, std::sync::atomic::Ordering::Relaxed);
    Json(json!({ "ok": true, "ttl_s": crate::LEASE_TTL.as_secs() }))
}

async fn release(State(s): St, Json(b): Json<HeartbeatBody>) -> Json<Value> {
    let (removed, remaining, ui_remaining) = {
        let mut l = s.leases.lock().unwrap();
        let removed = l.remove(&b.client_id);
        (removed, l.len(), l.values().any(|l| l.kind == "ui"))
    };
    if let Some(lease) = removed {
        tracing::info!("client {} ({}) released", b.client_id, lease.kind);
        // The desktop app closed: cancel its jobs and exit promptly instead of finishing
        // them and waiting out the idle grace with the model still in VRAM.
        crate::client_left(&s, &lease.kind, ui_remaining, remaining);
    }
    Json(json!({ "ok": true, "remaining_clients": remaining }))
}

async fn shutdown(State(s): St) -> Json<Value> {
    s.shutdown.notify_waiters();
    Json(json!({ "ok": true }))
}

/// Decodes %XX escapes (file names are sent URI-encoded in a header).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------------------------------------------------------------------------------------
// The user's own model files (#14)
// ---------------------------------------------------------------------------------------

/// Saves `cfg`; restarts an idle server of ours when the model changed.
async fn save_and_restart(s: &AppState, cfg: AppConfig) -> ApiResult<()> {
    let restart = s.engine.set_config(cfg)?;
    let st = s.engine.server.status();
    if restart && st.owned && st.state != qls_core::process::ServerState::Stopped && !s.engine.has_pending_work() {
        s.engine.server.stop().await;
        s.engine.emit_server();
    }
    Ok(())
}

/// Downloads the texture-fix VAE (#21) into the app's folder and makes the active model use
/// it (progress in `/setup/install`). The server holds the old file open, so it restarts once
/// idle; then the original VAE in the app's folder is deleted if no profile uses it. The user's
/// own VAE is never deleted.
async fn models_improve_vae(State(s): St) -> ApiResult<Json<Value>> {
    let dir = s.engine.config().sdcpp_dir;
    let engine = s.engine.clone();
    let on_finish = Box::new(move |complete: bool| {
        if !complete {
            return;
        }
        let mut c = engine.config();
        c.use_improved_vae();
        let restart = match engine.set_config(c) {
            Ok(r) => r,
            Err(e) => return tracing::error!("could not switch to the new VAE: {}", e.message),
        };
        tracing::info!("switched to the texture-fix VAE");
        tokio::spawn(async move {
            if restart {
                while engine.has_pending_work() {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                let st = engine.server.status();
                if st.owned && st.state != qls_core::process::ServerState::Stopped {
                    engine.server.stop().await;
                    engine.emit_server();
                }
            }
            let e = engine.clone();
            let _ = tokio::task::spawn_blocking(move || e.remove_unused_original_vae()).await;
        });
    });
    s.engine.installer.start(dir, "vae", vec![catalog::VAE], on_finish)?;
    Ok(Json(serde_json::to_value(s.engine.installer.status()).unwrap()))
}

fn role_of(label: &str) -> Option<Role> {
    Role::ALL.into_iter().find(|r| r.label() == label)
}

/// The active model: its files (what each is, whether it is there), what is missing and what
/// can be done about it. Setup shows this when a file is missing.
async fn models_status(State(s): St) -> ApiResult<Json<Value>> {
    let cfg = s.engine.config();
    let v = tokio::task::spawn_blocking(move || {
        let p = cfg.profile();
        let slots: Vec<Value> = p
            .files()
            .into_iter()
            .map(|(label, path, _)| {
                let exists = path.is_file();
                // Own files only: the official ones are known (and their headers are big).
                let info = (exists && !p.is_official()).then(|| modelfile::inspect(path).ok()).flatten();
                json!({ "role": role_of(label), "label": label, "path": path, "exists": exists, "info": info })
            })
            .collect();
        let downloadable: Vec<&str> = catalog::profile_model_downloads(p).iter().map(|d| d.label).collect();
        let official_installed = cfg.profiles.iter().find(|q| q.id == OFFICIAL_PROFILE_ID).is_some_and(|q| q.files().iter().all(|(_, f, _)| f.is_file()));
        json!({
            "active": { "id": p.id, "display_name": p.display_name, "source": p.source, "model": p.model },
            "slots": slots,
            "missing": cfg.missing_files().iter().map(|(l, f)| json!({ "label": l, "path": f })).collect::<Vec<_>>(),
            "downloadable": downloadable,
            "engine_installed": cfg.server_exe().is_file(),
            // The folder the active files were found in (none for the official ones), and the
            // one of the user's own files (offered to switch back to them).
            "scan_dir": p.scan_dir,
            "user_scan_dir": cfg.user_profile().and_then(|u| u.scan_dir.clone()),
            "has_user_profile": cfg.user_profile().is_some(),
            "user_installed": cfg.user_profile().is_some_and(|u| u.files().iter().all(|(_, f, _)| f.is_file())),
            "official_installed": official_installed,
            "default_download_dir": catalog::join_rel(&cfg.sdcpp_dir, catalog::MODEL_SUBDIR),
            // The texture-fix VAE (#21): in use, or what switching to it downloads.
            "vae": {
                "improved": cfg.uses_improved_vae(),
                "download_bytes": if catalog::VAE.is_present(&cfg.sdcpp_dir) { 0 } else { catalog::VAE.size },
                "page": catalog::VAE.page,
            },
        })
    })
    .await
    .map_err(AppError::internal)?;
    Ok(Json(v))
}

#[derive(Deserialize)]
struct ScanBody {
    dir: PathBuf,
}

/// Every model file in a folder (sub-folders included), the suggested file for each role, and
/// files with the same name as missing ones of the active profile (moved within the folder).
async fn models_scan(State(s): St, Json(b): Json<ScanBody>) -> ApiResult<Json<Value>> {
    if !b.dir.is_dir() {
        return Err(AppError::invalid(format!("{} is not a folder.", b.dir.display())).into());
    }
    let engine = s.engine.clone();
    let v = tokio::task::spawn_blocking(move || {
        let cfg = engine.config();
        let files = modelfile::scan(&b.dir);
        let vram = cfg.planning_vram_mib(engine.gpu().map(|g| g.planning_mib()));
        let picks = modelfile::best(&files, vram);
        let mut moved = serde_json::Map::new();
        for (label, path) in cfg.missing_files() {
            let name = path.file_name().map(|n| n.to_ascii_lowercase());
            let role = role_of(label);
            if let Some(f) = files.iter().find(|f| f.compatible && f.role == role && f.path.file_name().map(|n| n.to_ascii_lowercase()) == name) {
                moved.insert(serde_json::to_value(role).unwrap().as_str().unwrap_or_default().to_string(), json!(f.path));
            }
        }
        json!({ "dir": b.dir, "files": files, "picks": picks, "moved": moved })
    })
    .await
    .map_err(AppError::internal)?;
    Ok(Json(v))
}

#[derive(Deserialize)]
struct InspectBody {
    path: PathBuf,
}

async fn models_inspect(Json(b): Json<InspectBody>) -> ApiResult<Json<FileInfo>> {
    let p = b.path.clone();
    let info = tokio::task::spawn_blocking(move || modelfile::inspect(&p)).await.map_err(AppError::internal)?.map_err(|e| AppError::io("read", &b.path, e))?;
    Ok(Json(info))
}

#[derive(Deserialize)]
struct UserFilesBody {
    diffusion_model: Slot,
    vae: Slot,
    text_encoder: Slot,
    /// None: not needed (the text encoder carries the vision weights).
    vision_projector: Option<Slot>,
    scan_dir: Option<PathBuf>,
}

/// Saves the user's own files (checked) as the active profile. Official pieces to download are
/// then fetched by `/setup/install` with target "user", together with the engine.
async fn models_set_user(State(s): St, Json(b): Json<UserFilesBody>) -> ApiResult<Json<Value>> {
    let engine = s.engine.clone();
    let cfg = tokio::task::spawn_blocking(move || -> Result<AppConfig, AppError> {
        let mut cfg = engine.config();
        let p = modelfile::user_profile(&b.diffusion_model, &b.vae, &b.text_encoder, b.vision_projector.as_ref(), b.scan_dir, cfg.preset())?;
        cfg.set_user_files(p);
        Ok(cfg)
    })
    .await
    .map_err(AppError::internal)??;
    save_and_restart(&s, cfg).await?;
    models_status(State(s)).await
}

#[derive(Deserialize)]
struct UseBody {
    /// "official" or "user".
    profile: String,
}

/// Switches between the official files and the user's own (both stay saved).
async fn models_use(State(s): St, Json(b): Json<UseBody>) -> ApiResult<Json<Value>> {
    let mut cfg = s.engine.config();
    match b.profile.as_str() {
        "official" => cfg.use_official(),
        "user" if cfg.user_profile().is_some() => cfg.active_profile = USER_PROFILE_ID.into(),
        "user" => return Err(AppError::invalid("Choose your model files first.").into()),
        other => return Err(AppError::invalid(format!("Unknown profile {other}.")).into()),
    }
    save_and_restart(&s, cfg).await?;
    models_status(State(s)).await
}
