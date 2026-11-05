//! The AI watermark (qls_core::watermark) by hand, for docs/ai-marking.md's measurements:
//!
//!   cargo run --release -p qls-core --example watermark_check -- <sdcpp_dir> mark <in> <out.png>
//!   cargo run --release -p qls-core --example watermark_check -- <sdcpp_dir> check <image>...
//!   cargo run --release -p qls-core --example watermark_check -- <sdcpp_dir> bench <folder> [max]
//!   cargo run --release -p qls-core --example watermark_check -- <sdcpp_dir> negatives <folder> [max]
//!
//! `bench` marks every PNG/JPEG/WebP in the folder (CPU), prints the PSNR and the largest pixel
//! change, then checks the mark after common changes (JPEG, resizing, crops, brightness, noise,
//! blur, mirror) and that the unmarked images are not read as marked. `negatives` only reads
//! unmarked images (photos, screenshots): how many are taken for Kokon's mark (should be none) or
//! for any TrustMark. Nothing is written.

use std::path::{Path, PathBuf};

use image::{RgbaImage, imageops::FilterType};
use qls_core::watermark;

fn load(p: &Path) -> RgbaImage {
    image::open(p)
        .unwrap_or_else(|e| panic!("{}: {e}", p.display()))
        .to_rgba8()
}

fn psnr(a: &RgbaImage, b: &RgbaImage) -> (f64, u8) {
    let (mut se, mut n, mut max) = (0f64, 0f64, 0u8);
    for (p, q) in a.pixels().zip(b.pixels()) {
        for c in 0..3 {
            let d = p[c].abs_diff(q[c]);
            max = max.max(d);
            se += (d as f64).powi(2);
            n += 1.0;
        }
    }
    (
        if se == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255f64.powi(2) / (se / n)).log10()
        },
        max,
    )
}

fn jpeg(img: &RgbaImage, q: u8) -> RgbaImage {
    image::load_from_memory(&qls_core::imaging::encode_jpeg(img, q).unwrap())
        .unwrap()
        .to_rgba8()
}

fn scale(img: &RgbaImage, f: f32) -> RgbaImage {
    image::imageops::resize(
        img,
        ((img.width() as f32 * f) as u32).max(1),
        ((img.height() as f32 * f) as u32).max(1),
        FilterType::Triangle,
    )
}

/// Keeps `keep` of the area, cut from the right and bottom (the centre moves).
fn crop(img: &RgbaImage, keep: f32) -> RgbaImage {
    let s = keep.sqrt();
    image::imageops::crop_imm(
        img,
        0,
        0,
        (img.width() as f32 * s) as u32,
        (img.height() as f32 * s) as u32,
    )
    .to_image()
}

fn map(img: &RgbaImage, f: impl Fn(u32, u32, u8) -> f32) -> RgbaImage {
    let mut o = img.clone();
    for (x, y, p) in o.enumerate_pixels_mut() {
        for c in 0..3 {
            p.0[c] = f(x, y, p.0[c]).round().clamp(0.0, 255.0) as u8;
        }
    }
    o
}

fn noise(x: u32, y: u32) -> f32 {
    // Deterministic ±6 noise.
    let h = (x.wrapping_mul(73856093) ^ y.wrapping_mul(19349663)).wrapping_mul(2654435761);
    (h >> 24) as f32 / 255.0 * 12.0 - 6.0
}

fn images(dir: &Path, max: usize) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = walk(dir)
        .into_iter()
        .filter(|p| {
            p.extension().and_then(|e| e.to_str()).is_some_and(|e| {
                matches!(
                    e.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "webp"
                )
            })
        })
        .collect();
    v.sort();
    v.truncate(max);
    v
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p))
        } else {
            out.push(p)
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(&args[0]);
    match args[1].as_str() {
        "mark" => {
            let img = load(Path::new(&args[2]));
            let out = watermark::embed(&dir, &img).unwrap().unwrap_or(img.clone());
            let (p, m) = psnr(&img, &out);
            out.save(&args[3]).unwrap();
            println!(
                "marked {} -> {} (PSNR {p:.1} dB, max change {m})",
                args[2], args[3]
            );
        }
        "check" => {
            for f in &args[2..] {
                println!(
                    "{f}: {:?}",
                    watermark::detect(&dir, &load(Path::new(f))).unwrap()
                );
            }
        }
        "bench" => {
            let max = args
                .get(3)
                .and_then(|s| s.parse().ok())
                .unwrap_or(usize::MAX);
            let files = images(Path::new(&args[2]), max);
            type T = (&'static str, Box<dyn Fn(&RgbaImage) -> RgbaImage>);
            let tests: Vec<T> = vec![
                ("none (PNG)", Box::new(|i| i.clone())),
                ("JPEG 90", Box::new(|i| jpeg(i, 90))),
                ("JPEG 75", Box::new(|i| jpeg(i, 75))),
                ("JPEG 50", Box::new(|i| jpeg(i, 50))),
                ("half size", Box::new(|i| scale(i, 0.5))),
                ("quarter size", Box::new(|i| scale(i, 0.25))),
                ("1.5x size", Box::new(|i| scale(i, 1.5))),
                (
                    "screenshot-like (75% + JPEG 85)",
                    Box::new(|i| jpeg(&scale(i, 0.75), 85)),
                ),
                ("crop 10% (right/bottom)", Box::new(|i| crop(i, 0.9))),
                ("crop 20% (right/bottom)", Box::new(|i| crop(i, 0.8))),
                (
                    "brightness +10%",
                    Box::new(|i| map(i, |_, _, v| v as f32 * 1.1)),
                ),
                (
                    "noise ±6",
                    Box::new(|i| map(i, |x, y, v| v as f32 + noise(x, y))),
                ),
                (
                    "blur (half then back)",
                    Box::new(|i| {
                        image::imageops::resize(
                            &scale(i, 0.5),
                            i.width(),
                            i.height(),
                            FilterType::Triangle,
                        )
                    }),
                ),
                ("mirror", Box::new(|i| image::imageops::flip_horizontal(i))),
            ];
            let mut hits = vec![0usize; tests.len()];
            let (mut fp, mut psnrs, mut maxes, mut ms) = (0, vec![], vec![], vec![]);
            for f in &files {
                let img = load(f);
                if watermark::detect(&dir, &img)
                    .unwrap()
                    .is_some_and(|x| x.kokon)
                {
                    fp += 1;
                    println!("already marked (or a false positive): {}", f.display());
                }
                let t = std::time::Instant::now();
                let Some(marked) = watermark::embed(&dir, &img).unwrap() else {
                    continue;
                };
                ms.push(t.elapsed().as_millis());
                let (p, m) = psnr(&img, &marked);
                psnrs.push(p);
                maxes.push(m);
                let row: Vec<bool> = tests
                    .iter()
                    .map(|(_, t)| {
                        watermark::detect(&dir, &t(&marked))
                            .unwrap()
                            .is_some_and(|x| x.kokon)
                    })
                    .collect();
                for (h, ok) in hits.iter_mut().zip(&row) {
                    *h += *ok as usize;
                }
                println!(
                    "{} {}x{}: PSNR {p:.1} dB, max {m}, {} ms, read after: {}",
                    f.file_name().unwrap().to_string_lossy(),
                    img.width(),
                    img.height(),
                    ms.last().unwrap(),
                    row.iter()
                        .map(|b| if *b { '+' } else { '-' })
                        .collect::<String>()
                );
            }
            let n = psnrs.len();
            if n == 0 {
                println!("no images");
                return;
            }
            psnrs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!(
                "\n{n} images marked; PSNR min {:.1} / median {:.1} dB; largest change {} levels; median {} ms",
                psnrs[0],
                psnrs[n / 2],
                maxes.iter().max().unwrap(),
                {
                    ms.sort();
                    ms[n / 2]
                }
            );
            println!("unmarked images read as Kokon's: {fp} of {}", files.len());
            for ((name, _), h) in tests.iter().zip(hits) {
                println!("  {name:34} {h}/{n} ({:.0}%)", 100.0 * h as f64 / n as f64);
            }
        }
        "negatives" => {
            let max = args
                .get(3)
                .and_then(|s| s.parse().ok())
                .unwrap_or(usize::MAX);
            let (mut n, mut kokon, mut other) = (0, 0, 0);
            for f in images(Path::new(&args[2]), max) {
                let Ok(img) = image::open(&f) else { continue };
                n += 1;
                match watermark::detect(&dir, &img.to_rgba8()).unwrap() {
                    Some(x) if x.kokon => {
                        kokon += 1;
                        println!("KOKON (false positive?): {}", f.display());
                    }
                    Some(x) => {
                        other += 1;
                        println!(
                            "other TrustMark {:?} {:?}: {}",
                            x.schema,
                            x.text,
                            f.display()
                        );
                    }
                    None => {}
                }
            }
            println!("{n} images: {kokon} read as Kokon's, {other} as another TrustMark");
        }
        _ => eprintln!("mark | check | bench | negatives"),
    }
}
