//! kokon-service (crate qls-service) — the headless Kokon service.
//!
//! Owns the generation engine and the sd-server process, and exposes the stable local API
//! (`http://127.0.0.1:<port>/api/v1/...`) used by the desktop app, the MCP server and
//! scripts. Exactly one instance runs (the port bind is the lock). It exits by itself when
//! no client holds a lease and no work is pending, stopping sd-server unless the user
//! chose to keep it running.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod api;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qls_core::config::{AppConfig, data_dir};
use qls_core::engine::{APP_VERSION, Engine};
use qls_core::process::ServerState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
}

pub struct Lease {
    pub kind: String,
    pub last_seen: Instant,
    /// Client process id. A dead process drops its lease at once (app killed or crashed); a
    /// live one keeps it however late its heartbeat is (see [`lease_alive`]).
    pub pid: Option<u32>,
}

pub struct AppState {
    pub engine: Arc<Engine>,
    pub token: String,
    pub leases: Mutex<HashMap<String, Lease>>,
    /// When the last lease went away and how long to wait before exiting.
    pub exit_deadline: Mutex<Option<Instant>>,
    pub persistent: bool,
    /// The last client left on purpose (or died): exit right after the work stops instead
    /// of waiting out the idle grace. Cleared by any heartbeat.
    pub quick_exit: std::sync::atomic::AtomicBool,
    pub shutdown: tokio::sync::Notify,
    pub started: Instant,
}

pub const LEASE_TTL: Duration = Duration::from_secs(45);

/// Whether a client still holds its lease. Clients that sent their pid (the desktop app, the
/// MCP server) hold it while that process runs: after the computer sleeps their heartbeat is
/// minutes late, and dropping them then cancelled the window's jobs and unloaded the model.
/// The heartbeat timeout only applies to clients without a pid.
fn lease_alive(l: &Lease) -> bool {
    match l.pid {
        Some(pid) => qls_core::process::pid_alive(pid),
        None => l.last_seen.elapsed() < LEASE_TTL,
    }
}

fn load_or_create_token(dir: &std::path::Path) -> String {
    let p = dir.join("service-token");
    if let Ok(t) = std::fs::read_to_string(&p) {
        let t = t.trim().to_string();
        if t.len() >= 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return t;
        }
    }
    let t = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    let _ = std::fs::write(&p, &t);
    t
}

/// The port of a kokon-service that answers its ping at the port recorded in service.json.
async fn running_service() -> Option<u16> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let info: ServiceInfo = serde_json::from_str(&std::fs::read_to_string(service_info_path()).ok()?).ok()?;
    let ping = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", info.port)).await.ok()?;
        s.write_all(b"GET /api/v1/ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").await.ok()?;
        let mut buf = vec![0u8; 256];
        let n = s.read(&mut buf).await.ok()?;
        let head = String::from_utf8_lossy(&buf[..n]);
        (head.starts_with("HTTP/1.") && head.split(' ').nth(1) == Some("200")).then_some(info.port)
    };
    tokio::time::timeout(Duration::from_secs(2), ping).await.ok().flatten()
}

pub fn service_info_path() -> PathBuf {
    data_dir().join("service.json")
}

fn init_logging(dir: &std::path::Path) -> tracing_appender::non_blocking::WorkerGuard {
    let logs = dir.join("logs");
    let _ = std::fs::create_dir_all(&logs);
    let file = tracing_appender::rolling::never(&logs, "service.log");
    let (nb, guard) = tracing_appender::non_blocking(file);
    tracing_subscriber::fmt()
        .with_writer(nb)
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_env("QLS_LOG").unwrap_or_else(|_| "info".into()))
        .init();
    guard
}

const HELP: &str = "\
kokon-service — headless engine for Kokon (generation, job queue, gallery)

Usage: kokon-service [--port <n>] [--persistent]

Options:
  --port <n>    Port of the local API (default: the configured service_port, 39151)
  --persistent  Keep sd-server running after the last client disconnects
  -h, --help    Print this help and exit
  --version     Print the version and exit

Environment:
  QLS_DATA_DIR    Data folder: gallery, logs, models (default: the OS local app data folder)
  QLS_CONFIG_DIR  Config folder (default: the OS config folder)
  QLS_LOG         Log filter, e.g. info or debug (default: info)";

/// `--version` and `--help` answer before the data folder, the log or the port are touched,
/// so they work while a service is already running.
fn cli_meta(args: &[String]) -> Option<String> {
    if args.iter().any(|a| a == "--version") {
        Some(format!("kokon-service {APP_VERSION}"))
    } else if args.iter().any(|a| a == "--help" || a == "-h") {
        Some(HELP.to_string())
    } else {
        None
    }
}

/// A release build on Windows is a GUI-subsystem binary with no console of its own, so the
/// output of `--version` would go nowhere: attach to the console that launched it (cmd,
/// PowerShell) first. A debug build, macOS and Linux print directly.
fn print_meta(text: &str) {
    #[cfg(all(windows, not(debug_assertions)))]
    unsafe {
        unsafe extern "system" {
            fn AttachConsole(process_id: u32) -> i32;
        }
        const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
    println!("{text}");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(text) = cli_meta(&args) {
        print_meta(&text);
        return;
    }
    run(args)
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn run(args: Vec<String>) {
    let persistent = args.iter().any(|a| a == "--persistent");
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    // Rotate the service log at startup (keep one previous).
    let log_file = dir.join("logs").join("service.log");
    if std::fs::metadata(&log_file).map(|m| m.len() > 5_000_000).unwrap_or(false) {
        let _ = std::fs::rename(&log_file, dir.join("logs").join("service.prev.log"));
    }
    let _guard = init_logging(&dir);

    let cfg = AppConfig::load();
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .and_then(|p| p.parse().ok())
        .unwrap_or(cfg.service_port);

    // Single instance: a kokon-service answering at the port in service.json. Loopback only.
    let listener = match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
        Ok(l) => l,
        Err(e) => {
            if let Some(other) = running_service().await {
                tracing::info!("port {port} busy ({e}); kokon-service is already running on port {other} — exiting");
                return;
            }
            // Reserved by Windows (Hyper-V/WSL/Docker excluded ranges, "access denied") or taken
            // by another program: any free port. Clients find it in service.json.
            match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
                Ok(l) => {
                    tracing::warn!("port {port} cannot be opened ({e}); using {}", l.local_addr().map(|a| a.port()).unwrap_or(0));
                    l
                }
                Err(e2) => {
                    tracing::error!("port {port} cannot be opened ({e}) and no free port either ({e2}) — exiting");
                    return;
                }
            }
        }
    };
    let addr = listener.local_addr().unwrap_or_else(|_| SocketAddr::from(([127, 0, 0, 1], port)));
    let port = addr.port();

    let engine = match Engine::new(cfg, &dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("cannot start engine: {e} {:?}", e.detail);
            return;
        }
    };
    // The upscaler ships with the app: put it where sd-server looks (no download needed).
    let e = engine.clone();
    let _ = tokio::task::spawn_blocking(move || e.place_bundled_upscaler()).await;
    // The original VAE left behind when a busy server held it open during the update.
    engine.remove_unused_original_vae();
    let token = load_or_create_token(&dir);
    let info = ServiceInfo { port, token: token.clone(), pid: std::process::id(), version: APP_VERSION.into() };
    let _ = std::fs::write(service_info_path(), serde_json::to_string_pretty(&info).unwrap());
    tracing::info!("kokon-service {APP_VERSION} listening on http://{addr} (pid {})", info.pid);

    let state = Arc::new(AppState {
        engine: engine.clone(),
        token,
        leases: Mutex::new(HashMap::new()),
        exit_deadline: Mutex::new(Some(Instant::now() + Duration::from_secs(90))),
        persistent,
        quick_exit: std::sync::atomic::AtomicBool::new(false),
        shutdown: tokio::sync::Notify::new(),
        started: Instant::now(),
    });

    tokio::spawn(engine.clone().run_worker());
    tokio::spawn(lifecycle(state.clone()));
    tokio::spawn(server_watch(state.clone()));
    tokio::spawn(qls_core::engine_manifest::run(APP_VERSION));

    let app = api::router(state.clone());
    let st = state.clone();
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move { st.shutdown.notified().await });
    if let Err(e) = serve.await {
        tracing::error!("http server error: {e}");
    }

    let _ = engine.clear_private();
    // Shutdown: stop sd-server unless the user wants it kept loaded.
    let cfg = engine.config();
    if !cfg.keep_server_running {
        if engine.server.stop().await {
            tracing::info!("stopped sd-server on exit");
        }
        engine.remove_unused_original_vae();
    } else {
        tracing::info!("leaving sd-server running (keep_server_running)");
    }
    if let Ok(s) = std::fs::read_to_string(service_info_path())
        && let Ok(i) = serde_json::from_str::<ServiceInfo>(&s)
        && i.pid == std::process::id()
    {
        let _ = std::fs::remove_file(service_info_path());
    }
    tracing::info!("kokon-service exited");
}

/// Exits when no client holds a lease, no job is pending, and the grace period passed.
/// Also unloads the model after long idle periods when no desktop window is attached.
async fn lifecycle(state: Arc<AppState>) {
    let mut last_tick = Instant::now();
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        // A long gap between two 2 s ticks: the computer slept. Give every client a fresh
        // timeout to check in again before deciding it is gone.
        let gap = last_tick.elapsed();
        last_tick = Instant::now();
        let resumed = gap > Duration::from_secs(20);
        if resumed {
            tracing::info!("resumed after {} s (computer asleep?): waiting for clients to check in", gap.as_secs());
        }
        let (n_leases, has_ui, lost) = {
            let mut leases = state.leases.lock().unwrap();
            if resumed {
                leases.values_mut().for_each(|l| l.last_seen = Instant::now());
            }
            let mut lost = Vec::new();
            leases.retain(|id, l| {
                let alive = lease_alive(l);
                if !alive {
                    lost.push((id.clone(), l.kind.clone()));
                }
                alive
            });
            (leases.len(), leases.values().any(|l| l.kind == "ui"), lost)
        };
        for (id, kind) in &lost {
            tracing::info!("client {id} ({kind}) is gone");
            client_left(&state, kind, has_ui, n_leases);
        }
        let busy = state.engine.has_pending_work();
        if n_leases > 0 || busy {
            *state.exit_deadline.lock().unwrap() = None;
        } else if !state.persistent {
            // Nobody is left to use the model: free the GPU now, exit after the grace.
            let st = state.engine.server.status();
            if st.owned && st.state != ServerState::Stopped && !state.engine.config().keep_server_running {
                tracing::info!("no clients — unloading model");
                state.engine.server.stop().await;
                state.engine.emit_server();
            }
            let grace = if state.quick_exit.load(std::sync::atomic::Ordering::Relaxed) { 3 } else { 60 };
            let mut d = state.exit_deadline.lock().unwrap();
            match *d {
                None => *d = Some(Instant::now() + Duration::from_secs(grace)),
                Some(t) if Instant::now() >= t => {
                    tracing::info!("no clients and no work — shutting down");
                    state.shutdown.notify_waiters();
                    return;
                }
                _ => {}
            }
        }
        // Idle unload (MCP-only or scripted use): free VRAM after N idle minutes.
        let cfg = state.engine.config();
        let st = state.engine.server.status();
        if !has_ui
            && !busy
            && cfg.idle_unload_minutes > 0
            && st.state == ServerState::Ready
            && st.owned
            && state.engine.idle_for() > Duration::from_secs(cfg.idle_unload_minutes as u64 * 60)
        {
            tracing::info!("idle for {} min without the desktop app — unloading model", cfg.idle_unload_minutes);
            state.engine.server.stop().await;
            state.engine.emit_server();
        }
    }
}

/// A client released its lease or died. When the last desktop window goes, its unfinished
/// jobs are cancelled (MCP jobs keep running); when the last client goes, the service exits
/// as soon as the work stops.
pub fn client_left(state: &AppState, kind: &str, ui_remaining: bool, remaining: usize) {
    if kind == "ui" && !ui_remaining {
        let n = state.engine.cancel_client_jobs("ui");
        if n > 0 {
            tracing::info!("desktop app closed — cancelled {n} job(s)");
        }
        // Private mode lasts as long as the window.
        let _ = state.engine.clear_private();
    }
    if remaining == 0 {
        state.quick_exit.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Detects an owned sd-server that died between jobs, so the UI shows the right state.
async fn server_watch(state: Arc<AppState>) {
    loop {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let st = state.engine.server.status();
        if st.state == ServerState::Ready && st.owned && state.engine.server.owned_alive() == Some(false) {
            state.engine.server.mark_lost(qls_core::error::AppError::new(
                qls_core::error::ErrorCode::ServerCrashed,
                "The inference server stopped unexpectedly.",
            ));
            state.engine.emit_server();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{cli_meta, APP_VERSION};

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn version_and_help_answer_without_starting() {
        assert_eq!(cli_meta(&args("--version")).unwrap(), format!("kokon-service {APP_VERSION}"));
        for flag in ["--help", "-h"] {
            let help = cli_meta(&args(flag)).unwrap();
            for needle in ["--port", "--persistent", "QLS_DATA_DIR", "QLS_CONFIG_DIR", "QLS_LOG"] {
                assert!(help.contains(needle), "{flag} does not mention {needle}");
            }
        }
        assert!(cli_meta(&args("--persistent --port 1234")).is_none());
    }
}
