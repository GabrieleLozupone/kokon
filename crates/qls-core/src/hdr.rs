//! HDR for HEIC sources: read the source's gain map (via ffmpeg), adapt it to the edited
//! image and write an Ultra HDR JPEG (SDR JPEG + gain map JPEG, with Google/Adobe `hdrgm` XMP
//! and ISO 21496-1 metadata, joined by an MPF index).
//!
//! The model only sees and produces SDR. The source's gain map says how much brighter each
//! point of the *original* scene is in HDR; where the edit changed brightness or content
//! that boost no longer fits, so the gain is faded towards none (plain SDR) there.

use std::path::{Path, PathBuf};
use std::process::Command;

use image::{DynamicImage, GrayImage, ImageEncoder, Luma, RgbaImage, imageops};

use crate::heif::{GainMapMetadata, HeifGainMap};

/// Brightness change (in stops) below which the source gain is kept as is, and above which
/// it is dropped entirely; linear in between.
const KEEP_STOPS: f32 = 0.25;
const DROP_STOPS: f32 = 1.0;

/// A gain map ready to be attached to an SDR image of the same framing.
pub struct GainMap {
    pub image: GrayImage,
    pub metadata: GainMapMetadata,
}

/// `ffmpeg.exe` on PATH (winget, scoop, manual installs), if any.
pub fn find_ffmpeg() -> Option<PathBuf> {
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    std::env::split_paths(&std::env::var_os("PATH")?).map(|d| d.join(exe)).find(|p| p.is_file())
}

/// Reads the gain map of a HEIC file. `source` is the file on disk (ffmpeg needs to seek).
/// The result has the same orientation as the decoded base image (both apply `irot`/`imir`).
pub fn read_heic_gain_map(ffmpeg: &Path, source: &Path, info: &HeifGainMap) -> Result<GainMap, String> {
    let map = if info.is_grid {
        // Grids are stream groups; ffmpeg's filter label takes the group *index*.
        let ffprobe = ffmpeg.with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
        let out = run(Command::new(&ffprobe).args(["-v", "error", "-show_entries", "stream_group=index,id", "-of", "csv=p=0"]).arg(source))?;
        let text = String::from_utf8_lossy(&out);
        let index = text
            .lines()
            .filter_map(|l| {
                // "index,id," (ffprobe adds empty columns for nested sections).
                let mut f = l.trim().split(',');
                Some((f.next()?.trim().to_string(), parse_id(f.next()?)?))
            })
            .find(|(_, id)| *id == info.item_id)
            .map(|(i, _)| i)
            .ok_or_else(|| format!("ffprobe did not list the gain map (item {})", info.item_id))?;
        format!("[0:g:{index}]")
    } else {
        format!("0:#{}", info.item_id)
    };
    let png = run(Command::new(ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(source)
        .args(["-map", &map, "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-pix_fmt", "gray", "-"]))?;
    let image = image::load_from_memory(&png).map_err(|e| format!("gain map decode: {e}"))?.into_luma8();
    Ok(GainMap { image, metadata: info.metadata.clone() })
}

fn parse_id(s: &str) -> Option<u32> {
    let s = s.trim();
    match s.strip_prefix("0x") {
        Some(h) => u32::from_str_radix(h, 16).ok(),
        None => s.parse().ok(),
    }
}

fn run(cmd: &mut Command) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("could not run ffmpeg: {e}"))?;
    if !out.status.success() || out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ffmpeg failed: {}", err.lines().last().unwrap_or("no output")));
    }
    Ok(out.stdout)
}

/// True when `out` shows the same framing as `source` (same aspect ratio within 1%), so the
/// source's gain map can be stretched onto it.
pub fn same_framing(source: (u32, u32), out: (u32, u32)) -> bool {
    let a = source.0 as f64 / source.1 as f64;
    let b = out.0 as f64 / out.1 as f64;
    (a / b - 1.0).abs() < 0.01
}

/// Fits the source gain map to the edited image: same relative resolution as in the source,
/// and the gain faded out where the edit changed brightness (see [`KEEP_STOPS`]).
/// Returns the adapted map and the share of the image that kept (most of) its HDR boost.
pub fn adapt_gain_map(gm: &GainMap, source_sdr: &RgbaImage, edited: &RgbaImage) -> (GainMap, f32) {
    let (ew, eh) = edited.dimensions();
    let scale = gm.image.width() as f64 / source_sdr.width() as f64;
    let w = ((ew as f64 * scale).round() as u32).clamp(1, ew);
    let h = ((eh as f64 * scale).round() as u32).clamp(1, eh);
    let gain = imageops::resize(&gm.image, w, h, imageops::FilterType::Triangle);
    let ys = luma_linear(&imageops::resize(source_sdr, w, h, imageops::FilterType::Triangle));
    let ye = luma_linear(&imageops::resize(edited, w, h, imageops::FilterType::Triangle));

    // Per-pixel keep weight from the brightness change, smoothed so the fade has no edges.
    let mut keep = GrayImage::new(w, h);
    for (i, p) in keep.pixels_mut().enumerate() {
        let stops = ((ye[i] + 1e-3) / (ys[i] + 1e-3)).log2().abs();
        let k = 1.0 - ((stops - KEEP_STOPS) / (DROP_STOPS - KEEP_STOPS)).clamp(0.0, 1.0);
        p.0 = [(k * 255.0).round() as u8];
    }
    let keep = imageops::blur(&keep, (w.max(h) as f32 / 400.0).max(1.0));

    let m = &gm.metadata;
    let (lo, hi, gamma) = (m.gain_map_min[0], m.gain_map_max[0], m.gamma[0]);
    let mut out = GrayImage::new(w, h);
    let mut kept = 0usize;
    for (o, (g, k)) in out.pixels_mut().zip(gain.pixels().zip(keep.pixels())) {
        let k = k.0[0] as f64 / 255.0;
        if k > 0.5 {
            kept += 1;
        }
        // ISO 21496-1: log2 gain = lerp(min, max, encoded^(1/gamma)); fade it towards 0 (no boost).
        let e = g.0[0] as f64 / 255.0;
        let log_gain = lo + (hi - lo) * e.powf(1.0 / gamma);
        let faded = log_gain * k;
        let enc = if hi > lo { ((faded - lo) / (hi - lo)).clamp(0.0, 1.0).powf(gamma) } else { 0.0 };
        *o = Luma([(enc * 255.0).round() as u8]);
    }
    let share = kept as f32 / (w * h) as f32;
    (GainMap { image: out, metadata: m.clone() }, share)
}

/// Relative linear luminance per pixel (sRGB transfer, Rec.709 weights).
fn luma_linear(img: &RgbaImage) -> Vec<f32> {
    let lin: Vec<f32> = (0..256)
        .map(|v| {
            let c = v as f32 / 255.0;
            if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
        })
        .collect();
    img.pixels().map(|p| 0.2126 * lin[p.0[0] as usize] + 0.7152 * lin[p.0[1] as usize] + 0.0722 * lin[p.0[2] as usize]).collect()
}

const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const ISO_NS: &[u8] = b"urn:iso:std:iso:ts:21496:-1\0";

/// Encodes an Ultra HDR JPEG: `sdr` as the primary image (with `icc`), `gm` as the gain map.
/// `provenance`: more attributes for the primary's XMP description (Kokon's AI marking, provenance.rs).
pub fn encode_ultra_hdr(sdr: &RgbaImage, icc: Option<&[u8]>, gm: &GainMap, quality: u8, provenance: &str) -> Result<Vec<u8>, String> {
    let primary = jpeg(&DynamicImage::ImageRgba8(sdr.clone()).into_rgb8(), icc, quality)?;
    let gain = jpeg(&gm.image, None, quality.min(90))?;

    let mut gain_segments = app(1, &[XMP_NS, gain_map_xmp(&gm.metadata).as_bytes()].concat());
    gain_segments.extend(app(2, &[ISO_NS, &gm.metadata.to_iso()].concat()));
    let gain_file = insert_after_soi(&gain, &gain_segments);

    // Primary: XMP directory + ISO version marker + MPF index, then the encoder's own segments.
    let mut head = app(1, &[XMP_NS, primary_xmp(gain_file.len(), provenance).as_bytes()].concat());
    head.extend(app(2, &[ISO_NS, &[0, 0, 0, 0]].concat()));
    let mpf_at = 2 + head.len() + 4 + 4; // SOI + segments + APP2 marker/length + "MPF\0"
    let mpf_len = app(2, &mpf(0, 0, 0)).len();
    let primary_len = primary.len() + head.len() + mpf_len;
    head.extend(app(2, &mpf(primary_len as u32, gain_file.len() as u32, (primary_len - mpf_at) as u32)));
    let mut out = insert_after_soi(&primary, &head);
    debug_assert_eq!(out.len(), primary_len);
    out.extend_from_slice(&gain_file);
    Ok(out)
}

fn jpeg<P: image::PixelWithColorType + image::Pixel<Subpixel = u8>>(img: &image::ImageBuffer<P, Vec<u8>>, icc: Option<&[u8]>, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    if let Some(icc) = icc {
        let _ = enc.set_icc_profile(icc.to_vec());
    }
    enc.write_image(img.as_raw(), img.width(), img.height(), P::COLOR_TYPE).map_err(|e| format!("JPEG encode: {e}"))?;
    Ok(out)
}

/// One APPn segment (marker, big-endian length including itself, payload).
fn app(n: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = vec![0xFF, 0xE0 + n];
    v.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    v.extend_from_slice(payload);
    v
}

fn insert_after_soi(jpeg: &[u8], segments: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(jpeg.len() + segments.len());
    v.extend_from_slice(&jpeg[..2]);
    v.extend_from_slice(segments);
    v.extend_from_slice(&jpeg[2..]);
    v
}

/// MPF APP2 payload: two images, offsets relative to the TIFF header right after "MPF\0".
fn mpf(primary_len: u32, gain_len: u32, gain_offset: u32) -> Vec<u8> {
    let mut v = b"MPF\0MM\0\x2a\0\0\0\x08".to_vec();
    v.extend_from_slice(&3u16.to_be_bytes());
    let entry = |v: &mut Vec<u8>, tag: u16, typ: u16, count: u32, value: [u8; 4]| {
        v.extend_from_slice(&tag.to_be_bytes());
        v.extend_from_slice(&typ.to_be_bytes());
        v.extend_from_slice(&count.to_be_bytes());
        v.extend_from_slice(&value);
    };
    entry(&mut v, 0xB000, 7, 4, *b"0100");
    entry(&mut v, 0xB001, 4, 1, 2u32.to_be_bytes());
    entry(&mut v, 0xB002, 7, 32, 50u32.to_be_bytes()); // 8 (header) + 2 + 3*12 + 4
    v.extend_from_slice(&0u32.to_be_bytes());
    for (attr, size, off) in [(0x0003_0000u32, primary_len, 0u32), (0, gain_len, gain_offset)] {
        v.extend_from_slice(&attr.to_be_bytes());
        v.extend_from_slice(&size.to_be_bytes());
        v.extend_from_slice(&off.to_be_bytes());
        v.extend_from_slice(&[0, 0, 0, 0]);
    }
    v
}

fn primary_xmp(gain_len: usize, extra: &str) -> String {
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Kokon"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" {extra}><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="{gain_len}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>"#
    )
}

fn gain_map_xmp(m: &GainMapMetadata) -> String {
    let f = |a: &[f64; 3]| {
        if m.multichannel {
            format!("<rdf:Seq><rdf:li>{:.6}</rdf:li><rdf:li>{:.6}</rdf:li><rdf:li>{:.6}</rdf:li></rdf:Seq>", a[0], a[1], a[2])
        } else {
            format!("{:.6}", a[0])
        }
    };
    let (attrs, elems): (Vec<String>, Vec<String>) = [
        ("GainMapMin", f(&m.gain_map_min)),
        ("GainMapMax", f(&m.gain_map_max)),
        ("Gamma", f(&m.gamma)),
        ("OffsetSDR", f(&m.base_offset)),
        ("OffsetHDR", f(&m.alternate_offset)),
    ]
    .into_iter()
    .partition_map_like(m.multichannel);
    format!(
        r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Kokon"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" {} hdrgm:HDRCapacityMin="{:.6}" hdrgm:HDRCapacityMax="{:.6}" hdrgm:BaseRenditionIsHDR="False">{}</rdf:Description></rdf:RDF></x:xmpmeta>"#,
        attrs.join(" "),
        m.base_hdr_headroom.max(0.0),
        m.alternate_hdr_headroom,
        elems.join("")
    )
}

/// Single-channel values go in attributes, per-channel sequences in elements.
trait PartitionLike {
    fn partition_map_like(self, multichannel: bool) -> (Vec<String>, Vec<String>);
}

impl<I: Iterator<Item = (&'static str, String)>> PartitionLike for I {
    fn partition_map_like(self, multichannel: bool) -> (Vec<String>, Vec<String>) {
        let mut attrs = vec![];
        let mut elems = vec![];
        for (k, v) in self {
            if multichannel {
                elems.push(format!("<hdrgm:{k}>{v}</hdrgm:{k}>"));
            } else {
                attrs.push(format!("hdrgm:{k}=\"{v}\""));
            }
        }
        (attrs, elems)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> GainMapMetadata {
        GainMapMetadata {
            gain_map_min: [-0.05; 3],
            gain_map_max: [1.85; 3],
            gamma: [0.66; 3],
            base_offset: [1e-5; 3],
            alternate_offset: [1e-5; 3],
            base_hdr_headroom: 0.0,
            alternate_hdr_headroom: 1.85,
            multichannel: false,
            use_base_colour_space: true,
        }
    }

    fn decode_log_gain(m: &GainMapMetadata, v: u8) -> f64 {
        let (lo, hi) = (m.gain_map_min[0], m.gain_map_max[0]);
        lo + (hi - lo) * (v as f64 / 255.0).powf(1.0 / m.gamma[0])
    }

    #[test]
    fn unchanged_edit_keeps_the_gain_and_a_changed_one_drops_it() {
        let src = RgbaImage::from_pixel(64, 48, image::Rgba([120, 110, 100, 255]));
        let gm = GainMap { image: GrayImage::from_pixel(32, 24, Luma([200])), metadata: meta() };
        let (same, share) = adapt_gain_map(&gm, &src, &src);
        assert_eq!(same.image.dimensions(), (32, 24));
        assert!(share > 0.99);
        assert!((decode_log_gain(&gm.metadata, same.image.get_pixel(10, 10).0[0]) - decode_log_gain(&gm.metadata, 200)).abs() < 0.02);

        // The edit is 3 stops darker everywhere: no boost left (log gain ~0).
        let dark = RgbaImage::from_pixel(128, 96, image::Rgba([40, 36, 33, 255]));
        let (faded, share) = adapt_gain_map(&gm, &src, &dark);
        assert_eq!(faded.image.dimensions(), (64, 48), "same relative resolution on a 2x larger result");
        assert!(share < 0.01);
        assert!(decode_log_gain(&gm.metadata, faded.image.get_pixel(30, 20).0[0]).abs() < 0.02);
    }

    #[test]
    fn ultra_hdr_layout() {
        let sdr = RgbaImage::from_pixel(64, 32, image::Rgba([200, 30, 30, 255]));
        let gm = GainMap { image: GrayImage::from_pixel(32, 16, Luma([128])), metadata: meta() };
        let icc = vec![7u8; 600];
        let out = encode_ultra_hdr(&sdr, Some(&icc), &gm, 90, "").unwrap();

        // Find the MPF segment and check that its second entry points at a JPEG with gain map XMP.
        let pos = out.windows(4).position(|w| w == b"MPF\0").unwrap();
        let tiff = pos + 4;
        let e2 = tiff + 50 + 16;
        let size = u32::from_be_bytes(out[e2 + 4..e2 + 8].try_into().unwrap()) as usize;
        let off = u32::from_be_bytes(out[e2 + 8..e2 + 12].try_into().unwrap()) as usize;
        let primary_size = u32::from_be_bytes(out[tiff + 50 + 4..tiff + 50 + 8].try_into().unwrap()) as usize;
        assert_eq!(tiff + off, primary_size, "gain map starts right after the primary image");
        assert_eq!(primary_size + size, out.len());
        let gain = &out[tiff + off..];
        assert_eq!(&gain[..2], &[0xFF, 0xD8]);
        let g = String::from_utf8_lossy(gain);
        assert!(g.contains("hdrgm:GainMapMax=\"1.850000\"") && g.contains("urn:iso:std:iso:ts:21496:-1"));
        let p = String::from_utf8_lossy(&out[..primary_size]);
        assert!(p.contains(&format!("Item:Length=\"{size}\"")));
        assert_eq!(&out[primary_size - 2..primary_size], &[0xFF, 0xD9], "primary ends with EOI");

        // Both images decode; the primary keeps its ICC profile.
        assert_eq!(image::load_from_memory(&out).unwrap().width(), 64);
        assert_eq!(image::load_from_memory(gain).unwrap().width(), 32);
        let mut dec = image::codecs::jpeg::JpegDecoder::new(std::io::Cursor::new(&out[..primary_size])).unwrap();
        use image::ImageDecoder;
        assert_eq!(dec.icc_profile().unwrap().unwrap(), icc);
    }

    /// Run with QLS_TEST_HEIC=<iPhone .HEIC with HDR> and ffmpeg on PATH.
    #[test]
    fn real_heic_gain_map_matches_base() {
        let Ok(p) = std::env::var("QLS_TEST_HEIC") else { return };
        let Some(ff) = find_ffmpeg() else { return };
        let bytes = std::fs::read(&p).unwrap();
        let info = crate::heif::gain_map(&bytes).unwrap();
        let gm = read_heic_gain_map(&ff, Path::new(&p), &info).unwrap();
        let base = crate::wic::decode(&bytes).unwrap().pixels;
        println!("base {:?} gain map {:?}", base.dimensions(), gm.image.dimensions());
        assert!(same_framing(base.dimensions(), gm.image.dimensions()), "gain map oriented like the base");
        let out = encode_ultra_hdr(&base, crate::heif::primary_icc(&bytes).as_deref(), &adapt_gain_map(&gm, &base, &base).0, 92, "").unwrap();
        if let Ok(dir) = std::env::var("QLS_TEST_OUT") {
            std::fs::write(Path::new(&dir).join("ultrahdr_test.jpg"), &out).unwrap();
        }
    }
}
