//! Fast stickers for the layers lab: BiRefNet lite (MIT; onnx-community's ONNX export, pinned) run
//! on the CPU with ONNX Runtime. It returns the model's matte of an image; the app turns it into a
//! sticker with the user's selection (`src/lib/matte.ts`: the selection decides what, the matte the
//! edge). Spike s17 (2026-11-02): cleaner edges than SAM, deterministic, ~4 s per object on a
//! 16-thread CPU, no VRAM taken from the image engine. The webview could not run it (WebGPU kernels
//! rejected, WASM out of memory), hence here. Also the MobileSAM files the lab's Select uses.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use image::{GrayImage, RgbaImage, imageops::FilterType};
use ort::session::{RunOptions, Session};
use ort::value::Tensor;

use crate::catalog::{Download, FileKind, join_rel};
use crate::error::{AppError, AppResult, ErrorCode};

/// The model file, downloaded on first use (Settings never lists it: the lab asks for it).
pub const BIREFNET_LITE: Download = Download {
    id: "birefnet_lite",
    label: "BiRefNet lite (fast stickers)",
    kind: FileKind::Model,
    url: "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx",
    fallback_urls: &[],
    page: "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX",
    size: 224_005_088,
    sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
    dest: "models/matting/birefnet_lite.onnx",
    provides: &[],
    engine_tag: None,
};

/// Click-to-select in the layers lab: MobileSAM (Apache-2.0) in Acly's ONNX export (MIT), pinned.
/// It runs in the webview (src/lib/sam.ts, onnxruntime-web); kokon-service downloads the two files
/// the first time the lab is opened and serves them to it (`/segment/models/<file>`), since 0.12
/// (before: the dev server only, so a release had no Select).
pub const MOBILE_SAM: [Download; 2] = [
    Download {
        id: "mobile_sam_encoder",
        label: "MobileSAM image encoder (click to select)",
        kind: FileKind::Model,
        url: "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/mobile_sam_image_encoder.onnx",
        fallback_urls: &[],
        page: "https://huggingface.co/Acly/MobileSAM",
        size: 28_157_093,
        sha256: "580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749",
        dest: "models/segment/mobile_sam_image_encoder.onnx",
        provides: &[],
        engine_tag: None,
    },
    Download {
        id: "mobile_sam_decoder",
        label: "MobileSAM mask decoder (click to select)",
        kind: FileKind::Model,
        url: "https://huggingface.co/Acly/MobileSAM/resolve/0d3b403339b4674a82493d5e97964dd78089ddc8/sam_mask_decoder_multi.onnx",
        fallback_urls: &[],
        page: "https://huggingface.co/Acly/MobileSAM",
        size: 16_496_559,
        sha256: "8976b90a87ba50a6a72217a5ff994f7d25ce16f2229fcc1ed259e1294c622ffe",
        dest: "models/segment/sam_mask_decoder_multi.onnx",
        provides: &[],
        engine_tag: None,
    },
];

/// A MobileSAM file by its name (the last part of its `dest`), for the webview; None for any other name.
pub fn sam_file(sdcpp_dir: &Path, name: &str) -> Option<PathBuf> {
    MOBILE_SAM.iter().find(|d| d.dest.rsplit('/').next() == Some(name)).map(|d| join_rel(sdcpp_dir, d.dest))
}

/// Both MobileSAM files are there.
pub fn sam_installed(sdcpp_dir: &Path) -> bool {
    MOBILE_SAM.iter().all(|d| join_rel(sdcpp_dir, d.dest).is_file())
}

/// The model's input side (the export is fixed at 1024²).
const SIDE: u32 = 1024;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

pub fn model_path(sdcpp_dir: &Path) -> PathBuf {
    join_rel(sdcpp_dir, BIREFNET_LITE.dest)
}

/// Loaded once and kept (~0.5 GB of RAM while the lab is used): loading takes ~4 s. The
/// environment is kept with it (sessions need it alive).
static SESSION: Mutex<Option<(PathBuf, ort::environment::Environment, Session)>> = Mutex::new(None);

fn ort_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Internal, format!("The sticker model failed: {e}"))
}

/// The model's input: RGB at 1024², normalised as in training, CHW.
pub fn input_tensor(img: &RgbaImage) -> Vec<f32> {
    let small = image::imageops::resize(img, SIDE, SIDE, FilterType::Triangle);
    let n = (SIDE * SIDE) as usize;
    let mut x = vec![0f32; 3 * n];
    for (i, p) in small.pixels().enumerate() {
        for k in 0..3 {
            x[k * n + i] = (p.0[k] as f32 / 255.0 - MEAN[k]) / STD[k];
        }
    }
    x
}

/// The matte (logits) -> 0-255 at `w`×`h`.
pub fn matte_image(logits: &[f32], w: u32, h: u32) -> GrayImage {
    let m = GrayImage::from_fn(SIDE, SIDE, |x, y| {
        let v = logits[(y * SIDE + x) as usize];
        image::Luma([(255.0 / (1.0 + (-v).exp())).round() as u8])
    });
    image::imageops::resize(&m, w, h, FilterType::Triangle)
}

/// Something running that can be told to stop.
pub trait Stop {
    fn stop(&self);
}

/// One quick cut-out's model run: ONNX Runtime ends it at its next operator once `stop` is called
/// (also before it starts: a run whose flag is set exits at once).
pub struct Run {
    opts: RunOptions,
    stopped: AtomicBool,
}

impl Run {
    fn new() -> AppResult<Self> {
        Ok(Self { opts: RunOptions::new().map_err(ort_err)?, stopped: AtomicBool::new(false) })
    }
    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }
}

impl Stop for Run {
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.opts.terminate();
    }
}

enum Slot<T> {
    Running(Arc<T>),
    /// Stop came before the run (the app stopped it while uploading): the run, if it comes, ends at once.
    Stopped(Instant),
}

/// The quick cut-outs being made, by the id the app gave each one, so Stop can end it in the
/// service (`POST /matte/cancel`) and not only stop waiting in the window.
pub struct Runs<T> {
    slots: Mutex<HashMap<String, Slot<T>>>,
}

/// How long a Stop that came first is remembered.
const STOPPED_KEPT: Duration = Duration::from_secs(120);

impl<T: Stop> Runs<T> {
    pub fn new() -> Self {
        Self { slots: Mutex::new(HashMap::new()) }
    }

    /// Registers `run` under `id`; false if `id` was stopped already (the caller gives up).
    pub fn start(&self, id: &str, run: Arc<T>) -> bool {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        slots.retain(|_, s| !matches!(s, Slot::Stopped(at) if at.elapsed() > STOPPED_KEPT));
        if matches!(slots.get(id), Some(Slot::Stopped(_))) {
            slots.remove(id);
            return false;
        }
        slots.insert(id.to_string(), Slot::Running(run));
        true
    }

    /// The run of `id` is over (done, failed or stopped).
    pub fn finish(&self, id: &str) {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        if matches!(slots.get(id), Some(Slot::Running(_))) {
            slots.remove(id);
        }
    }

    /// Stops `id`: true if it was running; otherwise it is remembered and ends as soon as it starts.
    pub fn cancel(&self, id: &str) -> bool {
        let mut slots = self.slots.lock().unwrap_or_else(|p| p.into_inner());
        match slots.get(id) {
            Some(Slot::Running(r)) => {
                r.stop();
                true
            }
            _ => {
                slots.insert(id.to_string(), Slot::Stopped(Instant::now()));
                false
            }
        }
    }

    pub fn running(&self) -> usize {
        self.slots.lock().unwrap_or_else(|p| p.into_inner()).values().filter(|s| matches!(s, Slot::Running(_))).count()
    }
}

impl<T: Stop> Default for Runs<T> {
    fn default() -> Self {
        Self::new()
    }
}

static RUNS: LazyLock<Runs<Run>> = LazyLock::new(Runs::new);

/// Stops the quick cut-out `id` (running, or about to start). True if it was running.
pub fn cancel(id: &str) -> bool {
    RUNS.cancel(id)
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled, "The quick cut-out was stopped.")
}

/// The matte of `img` at its own size (white = the main thing in it). `run`: the id Stop uses
/// (`cancel`); a stopped run returns ErrorCode::Cancelled.
pub fn matte(sdcpp_dir: &Path, img: &RgbaImage, run: Option<&str>) -> AppResult<GrayImage> {
    let path = model_path(sdcpp_dir);
    if !path.is_file() {
        return Err(AppError::new(ErrorCode::MissingModel, "The fast sticker model is not downloaded yet."));
    }
    let this = Arc::new(Run::new()?);
    struct Finish<'a>(Option<&'a str>);
    impl Drop for Finish<'_> {
        fn drop(&mut self) {
            if let Some(id) = self.0 {
                RUNS.finish(id);
            }
        }
    }
    if let Some(id) = run
        && !RUNS.start(id, this.clone())
    {
        return Err(cancelled());
    }
    let _finish = Finish(run);
    let x = input_tensor(img);
    // Another cut-out may hold the model: a Stop while waiting for it is seen here.
    let mut guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    if this.is_stopped() {
        return Err(cancelled());
    }
    if guard.as_ref().is_none_or(|(p, _, _)| p != &path) {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let env = crate::onnx::environment().map_err(ort_err)?;
        let s = crate::onnx::cpu_session(&env, &path, threads).map_err(ort_err)?;
        *guard = Some((path.clone(), env, s));
    }
    let (_, _, session) = guard.as_mut().unwrap();
    let input = Tensor::from_array(([1usize, 3, SIDE as usize, SIDE as usize], x.into_boxed_slice())).map_err(ort_err)?;
    let outputs = match session.run_with_options(ort::inputs![input], &this.opts) {
        Ok(o) => o,
        Err(_) if this.is_stopped() => return Err(cancelled()),
        Err(e) => return Err(ort_err(e)),
    };
    let (_, logits) = outputs[outputs.len() - 1].try_extract_tensor::<f32>().map_err(ort_err)?;
    if logits.len() != (SIDE * SIDE) as usize {
        return Err(AppError::new(ErrorCode::Internal, "The sticker model returned an unexpected size."));
    }
    Ok(matte_image(logits, img.width(), img.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fake(AtomicBool);
    impl Stop for Fake {
        fn stop(&self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn runs_stop_the_running_one_only() {
        let runs = Runs::new();
        let a = Arc::new(Fake::default());
        let b = Arc::new(Fake::default());
        assert!(runs.start("a", a.clone()));
        assert!(runs.start("b", b.clone()));
        assert!(runs.cancel("a"));
        assert!(a.0.load(Ordering::SeqCst));
        assert!(!b.0.load(Ordering::SeqCst));
        runs.finish("a");
        runs.finish("b");
        assert_eq!(runs.running(), 0);
    }

    #[test]
    fn a_stop_before_the_run_ends_it_when_it_comes() {
        let runs = Runs::new();
        assert!(!runs.cancel("x"));
        assert!(!runs.start("x", Arc::new(Fake::default())));
        // Remembered once: the next run with that id goes ahead.
        assert!(runs.start("x", Arc::new(Fake::default())));
        runs.finish("x");
        // A stop after the run finished does not stop a later run forever either.
        assert!(!runs.cancel("y"));
        assert_eq!(runs.running(), 0);
    }

    #[test]
    fn only_the_sam_files_are_served() {
        let d = Path::new("/kokon");
        assert_eq!(sam_file(d, "sam_mask_decoder_multi.onnx"), Some(join_rel(d, "models/segment/sam_mask_decoder_multi.onnx")));
        assert!(sam_file(d, "mobile_sam_image_encoder.onnx").is_some());
        for bad in ["birefnet_lite.onnx", "../models/segment/sam_mask_decoder_multi.onnx", "", "segment"] {
            assert_eq!(sam_file(d, bad), None, "{bad}");
        }
        assert!(!sam_installed(d));
    }

    #[test]
    fn input_is_normalised_chw() {
        let img = RgbaImage::from_pixel(8, 8, image::Rgba([255, 0, 128, 255]));
        let x = input_tensor(&img);
        let n = (SIDE * SIDE) as usize;
        assert_eq!(x.len(), 3 * n);
        assert!((x[0] - (1.0 - MEAN[0]) / STD[0]).abs() < 1e-4);
        assert!((x[n] - (0.0 - MEAN[1]) / STD[1]).abs() < 1e-4);
        assert!((x[2 * n] - (128.0 / 255.0 - MEAN[2]) / STD[2]).abs() < 1e-3);
    }

    #[test]
    fn logits_become_a_matte_at_the_image_size() {
        let mut logits = vec![-20f32; (SIDE * SIDE) as usize];
        // The left half is the object.
        for y in 0..SIDE {
            for x in 0..SIDE / 2 {
                logits[(y * SIDE + x) as usize] = 20.0;
            }
        }
        let m = matte_image(&logits, 300, 200);
        assert_eq!(m.dimensions(), (300, 200));
        assert_eq!(m.get_pixel(10, 100).0[0], 255);
        assert_eq!(m.get_pixel(290, 100).0[0], 0);
    }

    #[test]
    fn missing_model_is_said() {
        let dir = tempfile::tempdir().unwrap();
        let e = matte(dir.path(), &RgbaImage::new(4, 4), None).unwrap_err();
        assert!(e.to_string().contains("not downloaded"));
    }
}

#[cfg(test)]
mod real_model {
    use super::*;

    /// `KOKON_MATTE_DIR` = a folder with `models/matting/birefnet_lite.onnx`, `KOKON_MATTE_IMAGE` = a photo.
    #[test]
    #[ignore = "needs the model file"]
    fn mattes_a_photo() {
        let dir = PathBuf::from(std::env::var("KOKON_MATTE_DIR").unwrap());
        let img = image::open(std::env::var("KOKON_MATTE_IMAGE").unwrap()).unwrap().to_rgba8();
        for _ in 0..2 {
            let t = std::time::Instant::now();
            let m = matte(&dir, &img, None).unwrap();
            eprintln!("matte {:?} in {:.2} s", m.dimensions(), t.elapsed().as_secs_f32());
            m.save(std::env::temp_dir().join("kokon-matte.png")).unwrap();
        }
    }
}

#[cfg(test)]
mod shared_runtime_tests {
    /// With the real models (KOKON_TEST_SDCPP: a folder holding models/matting/birefnet_lite.onnx and
    /// models/watermark/*.onnx): a result is watermarked, then a fast sticker is matted, in one
    /// process. Before crate::onnx, the second to start failed ("only one environment is allowed
    /// per process"): every quick cut-out after a result (Windows), no watermark after a sticker (Mac).
    #[test]
    fn watermark_then_sticker_in_one_process() {
        let Ok(dir) = std::env::var("KOKON_TEST_SDCPP") else { return };
        let dir = std::path::PathBuf::from(dir);
        let img = image::RgbaImage::from_fn(400, 300, |x, y| image::Rgba([(x / 2) as u8, (y / 2) as u8, if (150..250).contains(&x) { 230 } else { 40 }, 255]));
        let marked = crate::watermark::embed(&dir, &img).unwrap().unwrap();
        // On the CPU the first matte (session included) takes ~8 s on an M2 Pro; on the Neural
        // Engine (ort's default device policy, crate::onnx::cpu_session) it never came back.
        let started = std::time::Instant::now();
        let m = super::matte(&dir, &marked, None).unwrap();
        assert!(started.elapsed().as_secs() < 90, "first matte took {:?}", started.elapsed());
        assert_eq!(m.dimensions(), (400, 300));
        assert!(crate::watermark::detect(&dir, &marked).unwrap().unwrap().kokon);
    }

    /// Stop ends the model's run in the service: before it starts (stopped while uploading) at
    /// once, and during it well before a run would finish (~1 s vs 4-6 s per matte).
    #[test]
    fn stop_ends_the_run() {
        let Ok(dir) = std::env::var("KOKON_TEST_SDCPP") else { return };
        let dir = std::path::PathBuf::from(dir);
        let img = image::RgbaImage::from_pixel(640, 480, image::Rgba([90, 140, 200, 255]));
        // The session is loaded first, so the timings below are the run's alone.
        super::matte(&dir, &img, None).unwrap();
        assert!(!super::cancel("test-early"));
        let e = super::matte(&dir, &img, Some("test-early")).unwrap_err();
        assert_eq!(e.code, crate::error::ErrorCode::Cancelled);
        // The same id can be used again afterwards.
        let t = std::time::Instant::now();
        super::matte(&dir, &img, Some("test-early")).unwrap();
        let whole = t.elapsed();
        let stopper = std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert!(super::cancel("test-during"));
        });
        let t = std::time::Instant::now();
        let e = super::matte(&dir, &img, Some("test-during")).unwrap_err();
        stopper.join().unwrap();
        assert_eq!(e.code, crate::error::ErrorCode::Cancelled);
        assert!(t.elapsed() < whole, "stopped after {:?}, a whole run {:?}", t.elapsed(), whole);
        assert_eq!(super::RUNS.running(), 0);
    }
}
