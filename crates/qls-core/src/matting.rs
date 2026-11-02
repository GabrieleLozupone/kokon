//! Fast stickers for the layers lab: BiRefNet lite (MIT; onnx-community's ONNX export, pinned) run
//! on the CPU with ONNX Runtime. It returns the model's matte of an image; the app turns it into a
//! sticker with the user's selection (`src/lib/matte.ts`: the selection decides what, the matte the
//! edge). Spike s17 (2026-11-02): cleaner edges than SAM, deterministic, ~4 s per object on a
//! 16-thread CPU, no VRAM taken from the image engine. The webview could not run it (WebGPU kernels
//! rejected, WASM out of memory), hence here.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use image::{GrayImage, RgbaImage, imageops::FilterType};
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
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

/// The matte of `img` at its own size (white = the main thing in it).
pub fn matte(sdcpp_dir: &Path, img: &RgbaImage) -> AppResult<GrayImage> {
    let path = model_path(sdcpp_dir);
    if !path.is_file() {
        return Err(AppError::new(ErrorCode::MissingModel, "The fast sticker model is not downloaded yet."));
    }
    let x = input_tensor(img);
    let mut guard = SESSION.lock().unwrap_or_else(|p| p.into_inner());
    if guard.as_ref().is_none_or(|(p, _, _)| p != &path) {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let env = ort::init().with_name("kokon-stickers").build().map_err(ort_err)?;
        let s = Session::builder(&env)
            .map_err(ort_err)?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(ort_err)?
            .with_intra_threads(threads)
            .map_err(ort_err)?
            .commit_from_file(&path)
            .map_err(ort_err)?;
        *guard = Some((path.clone(), env, s));
    }
    let (_, _, session) = guard.as_mut().unwrap();
    let input = Tensor::from_array(([1usize, 3, SIDE as usize, SIDE as usize], x.into_boxed_slice())).map_err(ort_err)?;
    let outputs = session.run(ort::inputs![input]).map_err(ort_err)?;
    let (_, logits) = outputs[outputs.len() - 1].try_extract_tensor::<f32>().map_err(ort_err)?;
    if logits.len() != (SIDE * SIDE) as usize {
        return Err(AppError::new(ErrorCode::Internal, "The sticker model returned an unexpected size."));
    }
    Ok(matte_image(logits, img.width(), img.height()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let e = matte(dir.path(), &RgbaImage::new(4, 4)).unwrap_err();
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
            let m = matte(&dir, &img).unwrap();
            eprintln!("matte {:?} in {:.2} s", m.dimensions(), t.elapsed().as_secs_f32());
            m.save(std::env::temp_dir().join("kokon-matte.png")).unwrap();
        }
    }
}
