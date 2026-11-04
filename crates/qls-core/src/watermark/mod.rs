//! The invisible watermark in every image Kokon makes or changes with the model (AI Act Art. 50(2):
//! the second marking layer next to the XMP of provenance.rs; the Code of Practice on marking
//! AI-generated content, Sub-measure 1.1.2). It is Adobe's TrustMark, variant P (the "perceptual"
//! one, ~50 dB PSNR: not visible), MIT code and weights, listed in C2PA's soft-binding algorithm
//! list (`com.adobe.trustmark.P`), so anyone can read it with Adobe's open decoder:
//! `TrustMark(model_type='P').decode(img)` returns the text "Kokon-AI" (docs/ai-marking.md).
//!
//! This is a port of the Python reference (`python/trustmark/trustmark.py` and `datalayer.py`,
//! adobe/trustmark, MIT) on our own ONNX Runtime (the `trustmark` crate pins an older `ort`):
//! the centre square of the image, resized to 256², goes through the encoder with the payload;
//! the change it makes (its mean per channel removed) is scaled back to the square and added,
//! the edges feathered. The decoder reads the centre square at 224². The BCH error correction is
//! vendored from the Rust crate (bch.rs, MIT).

mod bch;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use image::{RgbaImage, imageops::FilterType};
use ort::session::Session;
use ort::value::Tensor;

use crate::catalog::{Download, join_rel};
use crate::error::{AppError, AppResult, ErrorCode};

/// The text Kokon writes in the watermark (TrustMark text mode: 7-bit ASCII, BCH_5). Adobe's
/// decoder shows it as is. A future format would change the last character.
pub const PAYLOAD: &str = "Kokon-AI";

/// TrustMark P (catalog.rs: shipped inside the app, Adobe's host as the fallback): encoder, decoder.
pub const TRUSTMARK_P: [Download; 2] = [
    crate::catalog::TRUSTMARK_P_ENCODER,
    crate::catalog::TRUSTMARK_P_DECODER,
];

/// Both model files are there.
pub fn installed(sdcpp_dir: &Path) -> bool {
    TRUSTMARK_P.iter().all(|d| d.is_present(sdcpp_dir))
}

/// The variant's sizes and strength (P: the encoder at 256², the decoder at 224², strength x1.25).
const ENC_SIDE: u32 = 256;
const DEC_SIDE: u32 = 224;
const P_STRENGTH: f32 = 1.25;
/// Kokon's strength (the reference's default is 1.0). Measured on Kokon outputs (see
/// docs/ai-marking.md): invisible, and read back after JPEG 75, half size, a 10 % crop.
pub const STRENGTH: f32 = 1.0;
/// Below this side the reference is not reliable: smaller images are left unmarked (Kokon never
/// makes them; XMP still marks them).
pub const MIN_SIDE: u32 = 150;
/// The mark fades in over this share of the square's side from each edge (smoothstep). The
/// reference feathers 1 % (at most 50 px), which leaves a faint seam on flat colour (seen on a
/// purple background, 2026-11-04); the decoder reads the whole square, so a wider fade costs little.
const FEATHER: f32 = 0.06;

/// What the watermark check found.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Found {
    /// The text read (only when the error correction accepted it).
    pub text: String,
    /// TrustMark's error-correction schema (BCH_SUPER, BCH_5, BCH_4, BCH_3).
    pub schema: &'static str,
    /// It is Kokon's mark.
    pub kokon: bool,
}

struct Sessions {
    _env: ort::environment::Environment,
    dir: PathBuf,
    encoder: Option<Session>,
    decoder: Option<Session>,
}

/// Loaded on first use and kept (~150 MB of RAM); each model only when needed.
static SESSIONS: Mutex<Option<Sessions>> = Mutex::new(None);

fn ort_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::Internal, format!("The AI watermark failed: {e}"))
}

fn with_session<T>(
    sdcpp_dir: &Path,
    decoder: bool,
    f: impl FnOnce(&mut Session) -> AppResult<T>,
) -> AppResult<T> {
    let d = &TRUSTMARK_P[decoder as usize];
    let path = join_rel(sdcpp_dir, d.dest);
    if !path.is_file() {
        return Err(AppError::new(
            ErrorCode::MissingModel,
            "The AI watermark model is not installed.",
        ));
    }
    let mut guard = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    if guard.as_ref().is_none_or(|s| s.dir != sdcpp_dir) {
        let env = crate::onnx::environment().map_err(ort_err)?;
        *guard = Some(Sessions {
            _env: env,
            dir: sdcpp_dir.to_path_buf(),
            encoder: None,
            decoder: None,
        });
    }
    let s = guard.as_mut().unwrap();
    let slot = if decoder {
        &mut s.decoder
    } else {
        &mut s.encoder
    };
    if slot.is_none() {
        let threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(8);
        let session = crate::onnx::cpu_session(&s._env, &path, threads).map_err(ort_err)?;
        *slot = Some(session);
    }
    f(slot.as_mut().unwrap())
}

/// The centre square the variant works on: (left, top, side).
fn centre_square(w: u32, h: u32) -> (u32, u32, u32) {
    let m = w.min(h);
    ((w - m) / 2, (h - m) / 2, m)
}

/// RGB of `img` (alpha ignored) resized to `side`² (bilinear with antialiasing, as PIL's), in
/// [-1, 1], CHW.
fn model_input(img: &RgbaImage, side: u32) -> Vec<f32> {
    let small = image::imageops::resize(img, side, side, FilterType::Triangle);
    let n = (side * side) as usize;
    let mut x = vec![0f32; 3 * n];
    for (i, p) in small.pixels().enumerate() {
        for k in 0..3 {
            x[k * n + i] = p.0[k] as f32 / 127.5 - 1.0;
        }
    }
    x
}

/// Bilinear resize of one CHW plane set (align_corners = false, as torch's `interpolate`).
fn upsample(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    let mut out = vec![0f32; 3 * dw * dh];
    let axis = |d: usize, dn: usize, sn: usize| {
        let s = ((d as f32 + 0.5) * sn as f32 / dn as f32 - 0.5).max(0.0);
        let i0 = (s.floor() as usize).min(sn - 1);
        let i1 = (i0 + 1).min(sn - 1);
        (i0, i1, s - i0 as f32)
    };
    let xs: Vec<_> = (0..dw).map(|x| axis(x, dw, sw)).collect();
    for c in 0..3 {
        let plane = &src[c * sw * sh..(c + 1) * sw * sh];
        for y in 0..dh {
            let (y0, y1, fy) = axis(y, dh, sh);
            let (r0, r1) = (
                &plane[y0 * sw..(y0 + 1) * sw],
                &plane[y1 * sw..(y1 + 1) * sw],
            );
            let o = &mut out[c * dw * dh + y * dw..c * dw * dh + (y + 1) * dw];
            for (x, &(x0, x1, fx)) in xs.iter().enumerate() {
                let top = r0[x0] + (r0[x1] - r0[x0]) * fx;
                let bot = r1[x0] + (r1[x1] - r1[x0]) * fx;
                o[x] = top + (bot - top) * fy;
            }
        }
    }
    out
}

/// The 100 bits TrustMark carries for `text` in text mode with BCH_5 (datalayer.py): 61 data
/// bits (7-bit ASCII, zero padded), 35 error-correction bits, then the schema "0001".
fn payload_bits(text: &str) -> Vec<f32> {
    const DATA: usize = 61;
    const ECC: usize = 35;
    let mut data: String = text
        .chars()
        .map(|c| format!("{:07b}", (c as u32) & 127))
        .collect();
    data.truncate(DATA);
    data.push_str(&"0".repeat(DATA - data.len()));
    let padded = format!("{data}{}", "0".repeat((8 - DATA % 8) % 8));
    let bytes: Vec<u8> = padded
        .as_bytes()
        .chunks(8)
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 2).unwrap())
        .collect();
    let mut state = bch::bch_init(5, bch::POLYNOMIAL);
    let ecc = bch::bch_encode(&mut state, &bytes);
    let mut ecc: String = ecc.iter().map(|b| format!("{b:08b}")).collect();
    ecc.truncate(ECC);
    format!("{data}{ecc}0001")
        .chars()
        .map(|c| if c == '1' { 1.0 } else { 0.0 })
        .collect()
}

/// The schemas: (name, data bits, bit flips corrected).
const SCHEMAS: [(&str, usize, u32); 4] = [
    ("BCH_SUPER", 40, 8),
    ("BCH_5", 61, 5),
    ("BCH_4", 68, 4),
    ("BCH_3", 75, 3),
];

/// Reads 100 decoder bits as datalayer.py does: the schema from the last 2 bits; the error
/// correction must accept the data (and its padding stay zero), else nothing was found. Kokon's
/// mark is only accepted as BCH_5 with exactly its text, so a photo whose noise happens to pass a
/// weaker check is never called Kokon's.
fn read_bits(bits: &[bool]) -> Option<Found> {
    if bits.len() != 100 {
        return None;
    }
    let version = (bits[98] as usize) << 1 | bits[99] as usize;
    let (schema, data_bits, t) = SCHEMAS[version];
    let ecc_bits = 100 - 4 - data_bits;
    let pack = |b: &[bool]| -> Vec<u8> {
        b.chunks(8)
            .map(|c| {
                c.iter()
                    .enumerate()
                    .fold(0u8, |acc, (i, &v)| acc | ((v as u8) << (7 - i)))
            })
            .collect()
    };
    let mut data = pack(&bits[..data_bits]);
    let ecc = pack(&bits[data_bits..data_bits + ecc_bits]);
    let mut state = bch::bch_init(t, bch::POLYNOMIAL);
    let flips = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        bch::bch_decode(&mut state, &mut data, &ecc)
    }))
    .ok()?;
    let pad = (8 - data_bits % 8) % 8;
    if flips as u32 > t || (pad != 0 && data.last().copied().unwrap_or(0) & ((1u8 << pad) - 1) != 0)
    {
        return None;
    }
    let all: String = data.iter().map(|b| format!("{b:08b}")).collect();
    let text: String = all
        .as_bytes()
        .chunks(7)
        .filter(|c| c.len() == 7)
        .map(|c| u8::from_str_radix(std::str::from_utf8(c).unwrap(), 2).unwrap() as char)
        .collect();
    let text = text.trim_end_matches('\0').trim().to_string();
    let kokon = schema == "BCH_5" && text == PAYLOAD;
    Some(Found {
        text,
        schema,
        kokon,
    })
}

/// Reads the watermark of `img` (None: no TrustMark P watermark the error correction accepts).
pub fn detect(sdcpp_dir: &Path, img: &RgbaImage) -> AppResult<Option<Found>> {
    let (w, h) = img.dimensions();
    if w.min(h) < 16 {
        return Ok(None);
    }
    let (left, top, m) = centre_square(w, h);
    let square = image::imageops::crop_imm(img, left, top, m, m).to_image();
    let x = model_input(&square, DEC_SIDE);
    let logits = with_session(sdcpp_dir, true, |s| {
        let input = Tensor::from_array((
            [1usize, 3, DEC_SIDE as usize, DEC_SIDE as usize],
            x.into_boxed_slice(),
        ))
        .map_err(ort_err)?;
        let out = s.run(ort::inputs!["image" => input]).map_err(ort_err)?;
        let (_, v) = out["output"].try_extract_tensor::<f32>().map_err(ort_err)?;
        Ok(v.to_vec())
    })?;
    let bits: Vec<bool> = logits.iter().map(|&v| v > 0.0).collect();
    Ok(read_bits(&bits))
}

/// `img` with Kokon's watermark, or None when it already carries it (an edit of a Kokon image
/// keeps the mark it has: marking twice would only add noise) or is too small to carry one.
pub fn embed(sdcpp_dir: &Path, img: &RgbaImage) -> AppResult<Option<RgbaImage>> {
    let (w, h) = img.dimensions();
    if w.min(h) < MIN_SIDE {
        return Ok(None);
    }
    if detect(sdcpp_dir, img)?.is_some_and(|f| f.kokon) {
        return Ok(None);
    }
    let (left, top, m) = centre_square(w, h);
    let square = image::imageops::crop_imm(img, left, top, m, m).to_image();
    let cover = model_input(&square, ENC_SIDE);
    let bits = payload_bits(PAYLOAD);
    let side = ENC_SIDE as usize;
    let stego = with_session(sdcpp_dir, false, |s| {
        let image = Tensor::from_array(([1usize, 3, side, side], cover.clone().into_boxed_slice()))
            .map_err(ort_err)?;
        let secret =
            Tensor::from_array(([1usize, 100], bits.into_boxed_slice())).map_err(ort_err)?;
        let out = s
            .run(ort::inputs!["onnx::Concat_0" => image, "onnx::Gemm_1" => secret])
            .map_err(ort_err)?;
        let (_, v) = out["image"].try_extract_tensor::<f32>().map_err(ort_err)?;
        Ok(v.to_vec())
    })?;
    // The change, without a colour shift (its mean per channel removed), at the square's size.
    let n = side * side;
    let mut residual: Vec<f32> = stego
        .iter()
        .zip(&cover)
        .map(|(s, c)| s.clamp(-1.0, 1.0) - c)
        .collect();
    for c in 0..3 {
        let plane = &mut residual[c * n..(c + 1) * n];
        let mean = plane.iter().sum::<f32>() / n as f32;
        plane.iter_mut().for_each(|v| *v -= mean);
    }
    let mm = m as usize;
    let up = upsample(&residual, side, side, mm, mm);
    let k = STRENGTH * P_STRENGTH;
    let band = (m as f32 * FEATHER).max(1.0);
    let ramp = |i: usize| {
        let t = ((i as f32 + 0.5) / band).min(1.0);
        t * t * (3.0 - 2.0 * t)
    };
    let mut out = img.clone();
    for y in 0..mm {
        let ay = ramp(y.min(mm - 1 - y));
        for x in 0..mm {
            let a = ay * ramp(x.min(mm - 1 - x));
            let p = out.get_pixel_mut(left + x as u32, top + y as u32);
            for c in 0..3 {
                let orig = p.0[c] as f32;
                let marked = ((up[c * mm * mm + y * mm + x] * k + orig / 127.5 - 1.0)
                    .clamp(-1.0, 1.0)
                    + 1.0)
                    * 127.5;
                p.0[c] = (a * marked + (1.0 - a) * orig).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bools(v: &[f32]) -> Vec<bool> {
        v.iter().map(|&b| b > 0.5).collect()
    }

    #[test]
    fn payload_round_trips_and_survives_five_flips() {
        let bits = payload_bits(PAYLOAD);
        assert_eq!(bits.len(), 100);
        assert_eq!(&bools(&bits)[96..], &[false, false, false, true]);
        let found = read_bits(&bools(&bits)).unwrap();
        assert_eq!(
            found,
            Found {
                text: PAYLOAD.into(),
                schema: "BCH_5",
                kokon: true
            }
        );
        let mut b = bools(&bits);
        for i in [0, 13, 40, 60, 77] {
            b[i] = !b[i];
        }
        assert!(read_bits(&b).unwrap().kokon);
        for i in [5, 20, 33, 50, 70, 90] {
            b[i] = !b[i];
        }
        assert!(read_bits(&b).is_none_or(|f| !f.kokon));
    }

    #[test]
    fn random_bits_are_never_kokon() {
        // A cheap LCG: no rand dependency.
        let mut s: u64 = 0x2545F4914F6CDD1D;
        let mut accepted = 0;
        for _ in 0..20_000 {
            let b: Vec<bool> = (0..100)
                .map(|_| {
                    s = s
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    s >> 63 == 1
                })
                .collect();
            if let Some(f) = read_bits(&b) {
                accepted += 1;
                assert!(!f.kokon);
            }
        }
        // Weaker schemas sometimes accept noise (datalayer.py does too): never as Kokon's mark.
        assert!(accepted < 2_000, "{accepted}");
    }

    #[test]
    fn upsample_matches_torch_bilinear() {
        // torch.nn.functional.interpolate([[0, 1]], size=4, mode="bilinear", align_corners=False)
        // along x: [0, 0.25, 0.75, 1].
        let src = vec![0.0, 1.0, 0.0, 1.0, 0.0, 1.0];
        let out = upsample(&src, 2, 1, 4, 1);
        assert_eq!(&out[..4], &[0.0, 0.25, 0.75, 1.0]);
    }

    /// With the models in KOKON_TEST_MODELS (a folder holding models/watermark/*.onnx): marks,
    /// reads back, does not mark twice, survives JPEG 75 and half size, and leaves alpha alone.
    #[test]
    fn embeds_and_detects_with_the_models() {
        let Ok(dir) = std::env::var("KOKON_TEST_MODELS") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let img = RgbaImage::from_fn(640, 480, |x, y| {
            image::Rgba([
                (x / 3) as u8,
                (y / 2) as u8,
                ((x + y) / 5) as u8,
                if x < 20 { 0 } else { 255 },
            ])
        });
        assert!(detect(&dir, &img).unwrap().is_none_or(|f| !f.kokon));
        let marked = embed(&dir, &img).unwrap().unwrap();
        assert!(detect(&dir, &marked).unwrap().unwrap().kokon);
        assert!(embed(&dir, &marked).unwrap().is_none());
        assert!(marked.pixels().zip(img.pixels()).all(|(a, b)| a[3] == b[3]));
        let jpg = crate::imaging::encode_jpeg(&marked, 75).unwrap();
        assert!(
            detect(&dir, &image::load_from_memory(&jpg).unwrap().to_rgba8())
                .unwrap()
                .unwrap()
                .kokon
        );
        let half = image::imageops::resize(&marked, 320, 240, FilterType::Triangle);
        assert!(detect(&dir, &half).unwrap().unwrap().kokon);
    }
}
