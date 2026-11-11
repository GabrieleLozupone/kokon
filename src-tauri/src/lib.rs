//! Desktop shell. The UI talks to kokon-service over loopback HTTP; this shell only
//! ensures the service is running, keeps a "ui" lease alive while the window is open,
//! and provides native integrations (clipboard images, Explorer).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Manager, RunEvent};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ServiceInfo {
    port: u16,
    token: String,
    pid: u32,
    version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    base_url: String,
    token: String,
    version: String,
}

#[derive(Default)]
struct Shared {
    info: Mutex<Option<ServiceInfo>>,
    heartbeat_started: Mutex<bool>,
    connect_lock: Mutex<()>,
}

fn client_id() -> String {
    format!("ui-{}", std::process::id())
}

/// The service's data folder. Until the service has moved the folder of the app's old name
/// (QwenLocalStudio, renamed Kokon on 2026-10-08) to KokonData, the old one is read.
fn data_dir() -> PathBuf {
    if let Ok(p) = std::env::var("QLS_DATA_DIR") {
        return PathBuf::from(p);
    }
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    let (new, old) = (base.join("KokonData"), base.join("QwenLocalStudio"));
    if !new.exists() && old.is_dir() { old } else { new }
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().expect("http")
}

fn read_info() -> Option<ServiceInfo> {
    serde_json::from_str(&std::fs::read_to_string(data_dir().join("service.json")).ok()?).ok()
}

fn ping(port: u16) -> bool {
    http()
        .get(format!("http://127.0.0.1:{port}/api/v1/ping"))
        .timeout(Duration::from_millis(1500))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn service_exe() -> Option<PathBuf> {
    let me = std::env::current_exe().ok()?;
    let dir = me.parent()?;
    // Bundled sidecar (Tauri strips the target suffix) or a dev build next to the shell.
    for name in ["kokon-service.exe", "kokon-service-x86_64-pc-windows-msvc.exe", "kokon-service", "kokon-service-aarch64-apple-darwin", "kokon-service-x86_64-unknown-linux-gnu"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// The service's own output while it runs: a crash before it opens its log (an unsupported
/// processor, a missing library) leaves its reason here (#53). In the temp folder, not the data
/// folder, which the service creates (and moves from the old name) itself.
fn start_log() -> PathBuf {
    std::env::temp_dir().join("kokon-service-start.log")
}

const NO_AVX: &str = "This processor does not support AVX instructions, which Kokon needs (most processors made since 2011 have them), so Kokon cannot run on this computer.";

/// Kokon's engine and libraries are built for x86 processors with AVX: one without it (a 2010
/// Xeon, #53) stopped with "Illegal instruction" before writing anything.
fn cpu_unsupported() -> Option<&'static str> {
    #[cfg(target_arch = "x86_64")]
    if !std::arch::is_x86_feature_detected!("avx") {
        return Some(NO_AVX);
    }
    None
}

fn spawn_service() -> Result<std::process::Child, String> {
    if let Some(why) = cpu_unsupported() {
        return Err(why.into());
    }
    let exe = service_exe().ok_or("kokon-service was not found next to the application.")?;
    let mut cmd = std::process::Command::new(exe);
    let err = std::fs::File::create(start_log()).map(std::process::Stdio::from).unwrap_or_else(|_| std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP: survives independently of this window.
        cmd.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    cmd.spawn().map_err(|e| format!("Could not start the Kokon service: {e}"))
}

/// Why the service stopped while starting: an illegal instruction means the processor lacks
/// something it was built for; otherwise the exit status and the last lines it wrote.
fn start_failure(status: std::process::ExitStatus) -> String {
    #[cfg(unix)]
    let illegal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal() == Some(4) // SIGILL
    };
    #[cfg(windows)]
    let illegal = status.code() == Some(0xC000_001Du32 as i32); // STATUS_ILLEGAL_INSTRUCTION
    #[cfg(not(any(unix, windows)))]
    let illegal = false;
    if illegal {
        return "The Kokon service stopped with an illegal instruction: this processor lacks instructions Kokon is built for (AVX or newer).".into();
    }
    let text = std::fs::read_to_string(start_log()).unwrap_or_default();
    let tail: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(5)..].join("
");
    if tail.is_empty() {
        format!("The Kokon service stopped while starting ({status}).")
    } else {
        format!("The Kokon service stopped while starting ({status}):
{tail}")
    }
}

/// Asks the service to exit (it also stops sd-server unless kept loaded) and waits until it
/// no longer answers, so an update can replace its executable.
fn stop_service(info: &ServiceInfo) -> bool {
    let _ = http().post(format!("http://127.0.0.1:{}/api/v1/shutdown", info.port)).bearer_auth(&info.token).send();
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(15) {
        if !ping(info.port) {
            // The port closes before the process ends; give it a moment to release its files.
            std::thread::sleep(Duration::from_millis(800));
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn ensure_service(shared: &Shared) -> Result<ServiceInfo, String> {
    let _g = shared.connect_lock.lock().unwrap();
    if let Some(i) = read_info()
        && ping(i.port)
    {
        if i.version == env!("CARGO_PKG_VERSION") {
            return Ok(i);
        }
        // Left running by the previous version (e.g. just updated): replace it.
        stop_service(&i);
    }
    let mut child = spawn_service()?;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(250));
        if let Some(i) = read_info()
            && ping(i.port)
        {
            return Ok(i);
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(start_failure(status));
        }
    }
    Err(format!(
        "The Kokon service did not start. See {} and {}.",
        data_dir().join("logs").join("service.log").display(),
        start_log().display()
    ))
}

fn heartbeat(info: &ServiceInfo) -> bool {
    http()
        .post(format!("http://127.0.0.1:{}/api/v1/session/heartbeat", info.port))
        .bearer_auth(&info.token)
        .json(&serde_json::json!({ "client_id": client_id(), "kind": "ui", "pid": std::process::id() }))
        .send()
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn start_heartbeat(shared: Arc<Shared>) {
    {
        let mut started = shared.heartbeat_started.lock().unwrap();
        if *started {
            return;
        }
        *started = true;
    }
    std::thread::spawn(move || {
        loop {
            let info = shared.info.lock().unwrap().clone();
            if let Some(i) = info
                && !heartbeat(&i)
            {
                // Service gone (crash or manual stop): bring it back.
                if let Ok(n) = ensure_service(&shared) {
                    heartbeat(&n);
                    *shared.info.lock().unwrap() = Some(n);
                }
            }
            std::thread::sleep(Duration::from_secs(15));
        }
    });
}

#[tauri::command]
async fn connect(state: tauri::State<'_, Arc<Shared>>) -> Result<Connection, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let info = ensure_service(&shared)?;
        heartbeat(&info);
        *shared.info.lock().unwrap() = Some(info.clone());
        start_heartbeat(shared.clone());
        Ok(Connection { base_url: format!("http://127.0.0.1:{}/api/v1", info.port), token: info.token, version: info.version })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn copy_image(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let img = tauri::async_runtime::spawn_blocking(move || image::open(&path).map(|i| i.into_rgba8()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Could not read the image: {e}"))?;
    let (w, h) = img.dimensions();
    app.clipboard().write_image(&tauri::image::Image::new_owned(img.into_raw(), w, h)).map_err(|e| e.to_string())
}

/// Returns the clipboard image as PNG bytes (empty if the clipboard holds no image).
#[tauri::command]
async fn read_clipboard_image(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    let Ok(img) = app.clipboard().read_image() else { return Ok(tauri::ipc::Response::new(Vec::<u8>::new())) };
    let (w, h, rgba) = (img.width(), img.height(), img.rgba().to_vec());
    let png = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let buf = image::RgbaImage::from_raw(w, h, rgba).ok_or("bad clipboard image")?;
        let mut out = Vec::new();
        image::DynamicImage::ImageRgba8(buf).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(png))
}

/// The Layers lab's .psd (the request's raw body): asks where to save it, writes it there. Returns
/// the path, or null when the dialog is cancelled.
#[tauri::command]
async fn save_psd(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else { return Err("No file to save.".into()) };
    let data = data.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app.dialog().file().set_file_name("Layers.psd").add_filter("Photoshop", &["psd"]).blocking_save_file() else { return Ok(None) };
        let path = path.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, data).map_err(|e| format!("Could not save the file: {e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Before installing an update: stop the service so the installer can replace it.
#[tauri::command]
async fn prepare_update(state: tauri::State<'_, Arc<Shared>>) -> Result<(), String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let info = shared.info.lock().unwrap().clone().or_else(read_info);
        match info {
            Some(i) if ping(i.port) && !stop_service(&i) => Err("The Kokon service did not stop. Close Kokon and try again.".to_string()),
            _ => Ok(()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("Folder not found.".into());
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Opens a download page, the issue tracker or the prompt guide in the browser. Only https
/// links to our own hosts and the ones the setup wizard uses are allowed.
#[tauri::command]
fn open_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // youtu.be: the video guides (src/lib/videos.ts), opened in the browser, never embedded.
    let allowed = ["https://github.com/", "https://huggingface.co/", "https://kokon.app/", "https://youtu.be/"];
    if !allowed.iter().any(|p| url.starts_with(p)) || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("This link cannot be opened from the app.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn data_folder() -> String {
    data_dir().to_string_lossy().into_owned()
}

fn release(shared: &Shared) {
    if let Some(i) = shared.info.lock().unwrap().clone() {
        let _ = http()
            .post(format!("http://127.0.0.1:{}/api/v1/session/release", i.port))
            .bearer_auth(&i.token)
            .timeout(Duration::from_secs(2))
            .json(&serde_json::json!({ "client_id": client_id(), "kind": "ui" }))
            .send();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer paints a blank window with the NVIDIA driver (#15). Turn it
    // off there unless the user set the variable; done first, while no other thread exists.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
    }
    // Feature unification gives every reqwest client here rustls without a provider (from
    // tauri-plugin-updater); building one before a provider is installed panics.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let shared = Arc::new(Shared::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(shared.clone())
        .setup(|app| {
            // The window starts hidden and the page shows it once its splash is painted
            // (public/boot.js). If the page never loads (dev server down, broken web view),
            // show it anyway so there is something to close or read.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                if let Some(w) = handle.get_webview_window("main")
                    && !w.is_visible().unwrap_or(true)
                {
                    let _ = w.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![connect, copy_image, read_clipboard_image, save_psd, reveal, open_folder, open_link, data_folder, prepare_update])
        .build(tauri::generate_context!())
        .expect("error while building Kokon");
    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            release(&shared);
        }
    });
}
