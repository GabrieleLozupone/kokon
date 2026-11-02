//! Pixel-level preprocessing. All functions are pure (input buffers in, new buffers out)
//! and independently testable. Images are handled as 8-bit RGBA so alpha is never lost;
//! colors are never converted (ICC profiles are carried through untouched).

use std::io::Cursor;

use image::{
    DynamicImage, GrayImage, ImageDecoder, ImageFormat, ImageReader, Luma, Rgba, RgbaImage,
    imageops::{self, FilterType},
    metadata::Orientation,
};

use crate::error::{AppError, ErrorCode};
use crate::geometry::{Rect, Size};

/// Upper bound on decoded input size, to fail fast on decompression bombs.
pub const MAX_INPUT_PIXELS: u64 = 64_000_000;

#[derive(Debug, Clone)]
pub struct LoadedImage {
    /// Pixels with EXIF orientation already applied (i.e. as a viewer displays them).
    pub pixels: RgbaImage,
    pub format: &'static str,
    /// EXIF orientation value that was applied (1 = none).
    pub exif_orientation: u8,
    pub icc_profile: Option<Vec<u8>>,
    /// True when at least one pixel is not fully opaque.
    pub has_transparency: bool,
    /// PNG text chunks (keyword, text), if any.
    pub text: Vec<(String, String)>,
}

impl LoadedImage {
    pub fn size(&self) -> Size {
        Size::new(self.pixels.width(), self.pixels.height())
    }
}

fn format_name(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Gif => "gif",
        ImageFormat::Tiff => "tiff",
        _ => "other",
    }
}

fn orientation_code(o: Orientation) -> u8 {
    match o {
        Orientation::NoTransforms => 1,
        Orientation::FlipHorizontal => 2,
        Orientation::Rotate180 => 3,
        Orientation::FlipVertical => 4,
        Orientation::Rotate90FlipH => 5,
        Orientation::Rotate90 => 6,
        Orientation::Rotate270FlipH => 7,
        Orientation::Rotate270 => 8,
    }
}

pub fn decode_image(bytes: &[u8]) -> Result<LoadedImage, AppError> {
    if crate::heif::is_heif(bytes) {
        return decode_heic(bytes);
    }
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AppError::new(ErrorCode::ImageDecode, "This file could not be read as an image.").detail(e.to_string()))?;
    let format = reader.format().ok_or_else(|| {
        AppError::new(ErrorCode::ImageDecode, "Unsupported image format. Use PNG, JPEG, WebP, BMP, GIF, TIFF or HEIC.")
    })?;
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| AppError::new(ErrorCode::ImageDecode, "This image could not be decoded.").detail(e.to_string()))?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || (w as u64 * h as u64) > MAX_INPUT_PIXELS {
        return Err(AppError::new(ErrorCode::ImageDecode, format!("Image is too large ({w}×{h}). The limit is 64 megapixels.")));
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let icc_profile = decoder.icc_profile().ok().flatten();
    let mut dynimg = DynamicImage::from_decoder(decoder)
        .map_err(|e| AppError::new(ErrorCode::ImageDecode, "This image could not be decoded.").detail(e.to_string()))?;
    dynimg.apply_orientation(orientation);
    let text = if format == ImageFormat::Png { read_png_text(bytes) } else { Vec::new() };
    let pixels = dynimg.into_rgba8();
    let has_transparency = pixels.pixels().any(|p| p[3] != 255);
    Ok(LoadedImage {
        pixels,
        format: format_name(format),
        exif_orientation: orientation_code(orientation),
        icc_profile,
        has_transparency,
        text,
    })
}

/// HEIC/HEIF through Windows' HEIF codec, which already applies the file's rotation/mirror.
/// The SDR base image only; an HDR gain map is read separately (see `crate::hdr`).
fn decode_heic(bytes: &[u8]) -> Result<LoadedImage, AppError> {
    let img = crate::wic::decode(bytes).map_err(|e| AppError::new(ErrorCode::ImageDecode, "This HEIC image could not be decoded.").detail(e))?;
    let pixels = img.pixels;
    let has_transparency = pixels.pixels().any(|p| p[3] != 255);
    Ok(LoadedImage {
        pixels,
        format: "heic",
        exif_orientation: 1,
        icc_profile: crate::heif::primary_icc(bytes).or(img.icc_profile),
        has_transparency,
        text: Vec::new(),
    })
}

/// Decodes an image produced by our own engine (an upscaler tile). Not subject to the input
/// limit: a 2048² tile through an x4 model is 8192² (67 MP), and the request plan already bounds
/// it to `max_side` per side.
pub fn decode_engine_image(bytes: &[u8], max_side: u32) -> Result<RgbaImage, AppError> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AppError::new(ErrorCode::ImageDecode, "The engine returned an unreadable image.").detail(e.to_string()))?;
    reader.no_limits();
    let img = reader.decode().map_err(|e| AppError::new(ErrorCode::ImageDecode, "The engine returned an unreadable image.").detail(e.to_string()))?;
    if img.width() == 0 || img.height() == 0 || img.width() > max_side || img.height() > max_side {
        return Err(AppError::new(ErrorCode::ImageDecode, format!("The engine returned an unexpected size ({}×{}).", img.width(), img.height())));
    }
    Ok(img.into_rgba8())
}

pub fn load_image(path: &std::path::Path) -> Result<LoadedImage, AppError> {
    let bytes = std::fs::read(path).map_err(|e| AppError::io("read the image", path, e))?;
    decode_image(&bytes)
}

/// Reads tEXt / zTXt / iTXt chunks from PNG bytes. Never fails; returns what it can.
pub fn read_png_text(bytes: &[u8]) -> Vec<(String, String)> {
    let decoder = png::Decoder::new(Cursor::new(bytes));
    let Ok(reader) = decoder.read_info() else { return Vec::new() };
    let info = reader.info();
    let mut out: Vec<(String, String)> =
        info.uncompressed_latin1_text.iter().map(|c| (c.keyword.clone(), c.text.clone())).collect();
    for c in &info.compressed_latin1_text {
        if let Ok(t) = c.get_text() {
            out.push((c.keyword.clone(), t));
        }
    }
    for c in &info.utf8_text {
        if let Ok(t) = c.get_text() {
            out.push((c.keyword.clone(), t));
        }
    }
    out
}

/// Encodes PNG with optional UTF-8 text chunks and ICC profile. Writes RGB when the image
/// is fully opaque (smaller files), RGBA otherwise.
pub fn encode_png(img: &RgbaImage, text: &[(&str, &str)], icc: Option<&[u8]>, fast: bool) -> Result<Vec<u8>, AppError> {
    let opaque = img.pixels().all(|p| p[3] == 255);
    let mut info = png::Info::with_size(img.width(), img.height());
    info.color_type = if opaque { png::ColorType::Rgb } else { png::ColorType::Rgba };
    info.bit_depth = png::BitDepth::Eight;
    if let Some(icc) = icc {
        info.icc_profile = Some(std::borrow::Cow::Owned(icc.to_vec()));
    }
    let mut out = Vec::with_capacity(img.as_raw().len() / 2);
    {
        let mut enc = png::Encoder::with_info(&mut out, info).map_err(png_err)?;
        enc.set_compression(if fast { png::Compression::Fastest } else { png::Compression::Balanced });
        for (k, v) in text {
            enc.add_itxt_chunk((*k).to_string(), (*v).to_string()).map_err(png_err)?;
        }
        let mut writer = enc.write_header().map_err(png_err)?;
        if opaque {
            let rgb: Vec<u8> = img.as_raw().chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect();
            writer.write_image_data(&rgb).map_err(png_err)?;
        } else {
            writer.write_image_data(img.as_raw()).map_err(png_err)?;
        }
        writer.finish().map_err(png_err)?;
    }
    Ok(out)
}

fn png_err(e: png::EncodingError) -> AppError {
    AppError::new(ErrorCode::Internal, "Failed to encode PNG.").detail(e.to_string())
}

/// JPEG has no alpha: transparent pixels are flattened onto white, not shown with the colour
/// hidden under alpha 0 (Qwen-Image's RGBA output leaves e.g. purple there: purple thumbnails).
pub fn encode_jpeg(img: &RgbaImage, quality: u8) -> Result<Vec<u8>, AppError> {
    let rgb = image::RgbImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        let a = p[3] as u32;
        image::Rgb(std::array::from_fn(|c| ((p[c] as u32 * a + 255 * (255 - a) + 127) / 255) as u8))
    });
    let mut out = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality.clamp(1, 100));
    rgb.write_with_encoder(enc).map_err(|e| AppError::new(ErrorCode::Internal, "Failed to encode JPEG.").detail(e.to_string()))?;
    Ok(out)
}

pub fn encode_webp_lossless(img: &RgbaImage) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::new();
    let enc = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
    img.write_with_encoder(enc).map_err(|e| AppError::new(ErrorCode::Internal, "Failed to encode WebP.").detail(e.to_string()))?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------
// Geometry operations
// ---------------------------------------------------------------------------------------

/// High-quality resize (Lanczos3). Transparent images are resized in premultiplied
/// alpha so fully transparent pixels do not bleed color into edges.
pub fn resize(img: &RgbaImage, width: u32, height: u32) -> RgbaImage {
    if img.width() == width && img.height() == height {
        return img.clone();
    }
    let transparent = img.pixels().any(|p| p[3] != 255);
    if !transparent {
        return imageops::resize(img, width, height, FilterType::Lanczos3);
    }
    let mut pre = img.clone();
    for p in pre.pixels_mut() {
        let a = p[3] as u32;
        for c in 0..3 {
            p[c] = ((p[c] as u32 * a + 127) / 255) as u8;
        }
    }
    let mut out = imageops::resize(&pre, width, height, FilterType::Lanczos3);
    for p in out.pixels_mut() {
        let a = p[3] as u32;
        if a == 0 {
            p[0] = 0;
            p[1] = 0;
            p[2] = 0;
        } else if a < 255 {
            for c in 0..3 {
                p[c] = ((p[c] as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    out
}

pub fn resize_mask(mask: &GrayImage, width: u32, height: u32) -> GrayImage {
    if mask.width() == width && mask.height() == height {
        return mask.clone();
    }
    imageops::resize(mask, width, height, FilterType::Triangle)
}

pub fn crop(img: &RgbaImage, r: Rect) -> RgbaImage {
    imageops::crop_imm(img, r.x, r.y, r.width, r.height).to_image()
}

pub fn crop_mask(mask: &GrayImage, r: Rect) -> GrayImage {
    imageops::crop_imm(mask, r.x, r.y, r.width, r.height).to_image()
}

/// Places `img` at `offset` on a `canvas`-sized image and fills everything outside it by
/// replicating the nearest edge pixel. Used for 32-alignment padding and as the neutral
/// fill for outpaint regions (which are fully regenerated anyway).
pub fn pad_edge(img: &RgbaImage, canvas: Size, offset: (u32, u32)) -> RgbaImage {
    assert!(offset.0 + img.width() <= canvas.width && offset.1 + img.height() <= canvas.height);
    if canvas.width == img.width() && canvas.height == img.height() {
        return img.clone();
    }
    let (ox, oy) = (offset.0 as i64, offset.1 as i64);
    let (iw, ih) = (img.width() as i64, img.height() as i64);
    RgbaImage::from_fn(canvas.width, canvas.height, |x, y| {
        let sx = (x as i64 - ox).clamp(0, iw - 1) as u32;
        let sy = (y as i64 - oy).clamp(0, ih - 1) as u32;
        *img.get_pixel(sx, sy)
    })
}

/// Places `img` at `offset` on a canvas filled with `fill`.
pub fn pad_solid(img: &RgbaImage, canvas: Size, offset: (u32, u32), fill: Rgba<u8>) -> RgbaImage {
    let mut out = RgbaImage::from_pixel(canvas.width, canvas.height, fill);
    imageops::replace(&mut out, img, offset.0 as i64, offset.1 as i64);
    out
}

// ---------------------------------------------------------------------------------------
// Masks — convention: 255 = regenerate, 0 = keep.
// ---------------------------------------------------------------------------------------

/// Converts a user-supplied mask image to a single-channel mask. Masks painted on a
/// transparent layer use alpha; opaque masks use luminance (white = edit). A layer of strokes
/// is empty somewhere; a white-on-black mask blurred on a canvas only comes out partly
/// transparent at the frame's edge (alpha 77 there), and read by alpha it made the whole frame
/// the area (the lab's fill, 11-01): luminance unless some pixel is (nearly) fully transparent.
pub fn mask_from_image(img: &LoadedImage) -> GrayImage {
    let p = &img.pixels;
    if img.has_transparency && p.pixels().any(|q| q[3] < 8) {
        GrayImage::from_fn(p.width(), p.height(), |x, y| Luma([p.get_pixel(x, y)[3]]))
    } else {
        GrayImage::from_fn(p.width(), p.height(), |x, y| {
            let q = p.get_pixel(x, y);
            Luma([((q[0] as u32 * 299 + q[1] as u32 * 587 + q[2] as u32 * 114) / 1000) as u8])
        })
    }
}

pub fn mask_rect(size: Size, inside: Rect, inside_value: u8, outside_value: u8) -> GrayImage {
    GrayImage::from_fn(size.width, size.height, |x, y| {
        if x >= inside.x && x < inside.right() && y >= inside.y && y < inside.bottom() {
            Luma([inside_value])
        } else {
            Luma([outside_value])
        }
    })
}

pub fn invert_mask(mask: &GrayImage) -> GrayImage {
    GrayImage::from_fn(mask.width(), mask.height(), |x, y| Luma([255 - mask.get_pixel(x, y)[0]]))
}

pub fn binarize(mask: &GrayImage, threshold: u8) -> GrayImage {
    GrayImage::from_fn(mask.width(), mask.height(), |x, y| Luma([if mask.get_pixel(x, y)[0] > threshold { 255 } else { 0 }]))
}

/// Bounding box of pixels above `threshold`, or None for an empty mask.
pub fn mask_bbox(mask: &GrayImage, threshold: u8) -> Option<Rect> {
    let (mut x0, mut y0, mut x1, mut y1) = (u32::MAX, u32::MAX, 0u32, 0u32);
    for (x, y, p) in mask.enumerate_pixels() {
        if p[0] > threshold {
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
    }
    (x0 != u32::MAX).then(|| Rect::new(x0, y0, x1 - x0 + 1, y1 - y0 + 1))
}

pub fn mask_coverage(mask: &GrayImage, threshold: u8) -> f64 {
    let n = mask.pixels().filter(|p| p[0] > threshold).count();
    n as f64 / (mask.width() as f64 * mask.height() as f64).max(1.0)
}

/// Separable sliding-window max/min/mean over rows then columns.
fn separable(mask: &GrayImage, radius: u32, op: fn(&[u8]) -> u8) -> GrayImage {
    if radius == 0 {
        return mask.clone();
    }
    let (w, h) = (mask.width() as usize, mask.height() as usize);
    let r = radius as usize;
    let src = mask.as_raw();
    let mut tmp = vec![0u8; w * h];
    let mut buf = Vec::with_capacity(2 * r + 1);
    for y in 0..h {
        let row = &src[y * w..(y + 1) * w];
        for x in 0..w {
            buf.clear();
            buf.extend_from_slice(&row[x.saturating_sub(r)..(x + r + 1).min(w)]);
            tmp[y * w + x] = op(&buf);
        }
    }
    let mut out = vec![0u8; w * h];
    for x in 0..w {
        for y in 0..h {
            buf.clear();
            for yy in y.saturating_sub(r)..(y + r + 1).min(h) {
                buf.push(tmp[yy * w + x]);
            }
            out[y * w + x] = op(&buf);
        }
    }
    GrayImage::from_raw(w as u32, h as u32, out).expect("size")
}

pub fn dilate(mask: &GrayImage, radius: u32) -> GrayImage {
    separable(mask, radius, |s| *s.iter().max().unwrap())
}

pub fn erode(mask: &GrayImage, radius: u32) -> GrayImage {
    separable(mask, radius, |s| *s.iter().min().unwrap())
}

/// Soft edge: three box-blur passes approximate a Gaussian with sigma ≈ radius/√3·√3.
pub fn feather(mask: &GrayImage, radius: u32) -> GrayImage {
    if radius == 0 {
        return mask.clone();
    }
    let r = (radius / 3).max(1);
    let mean = |s: &[u8]| -> u8 { (s.iter().map(|&v| v as u32).sum::<u32>() as f32 / s.len() as f32).round() as u8 };
    let mut m = separable(mask, r, mean);
    m = separable(&m, r, mean);
    separable(&m, r, mean)
}

/// The mask sent to the backend must be binary and must fully cover the feathered
/// region, so the soft blend in [`composite`] never reveals unedited pixels.
pub fn backend_mask(user_mask: &GrayImage, grow: u32) -> GrayImage {
    binarize(&dilate(user_mask, grow), 8)
}

/// Blends `top` over `base` at `at` using `mask` (same size as `top`): out = base·(1−m) + top·m.
/// Alpha is blended the same way, so transparency of untouched regions is preserved exactly.
pub fn composite(base: &mut RgbaImage, top: &RgbaImage, mask: &GrayImage, at: (u32, u32)) {
    assert_eq!((top.width(), top.height()), (mask.width(), mask.height()));
    for (x, y, tp) in top.enumerate_pixels() {
        let bx = at.0 + x;
        let by = at.1 + y;
        if bx >= base.width() || by >= base.height() {
            continue;
        }
        let m = mask.get_pixel(x, y)[0] as u32;
        if m == 0 {
            continue;
        }
        let bp = base.get_pixel_mut(bx, by);
        if m == 255 {
            *bp = *tp;
            continue;
        }
        for c in 0..4 {
            bp[c] = ((bp[c] as u32 * (255 - m) + tp[c] as u32 * m + 127) / 255) as u8;
        }
    }
}

/// Mask (in `size`) that is 255 everywhere except `keep`, which is 0, with the keep
/// area shrunk by `overlap` on selected sides so seams are regenerated.
pub fn outpaint_mask(size: Size, keep: Rect, overlap: crate::geometry::Expansion) -> GrayImage {
    let inner = Rect::new(
        keep.x + overlap.left,
        keep.y + overlap.top,
        keep.width.saturating_sub(overlap.left + overlap.right).max(1),
        keep.height.saturating_sub(overlap.top + overlap.bottom).max(1),
    );
    mask_rect(size, inner, 0, 255)
}

/// Mask used to paste the original back into an outpainted result: 255 inside the
/// original, ramping (smoothstep) to 0 across `feather_px` on edges that were expanded.
pub fn paste_back_mask(size: Size, expanded: crate::geometry::Expansion, feather_px: u32) -> GrayImage {
    let f = feather_px.max(1) as f32;
    GrayImage::from_fn(size.width, size.height, |x, y| {
        let mut v = 1.0f32;
        // Smoothstep: a linear ramp shows its two ends as faint lines on flat areas.
        let ramp = |d: u32| {
            let t = ((d as f32 + 0.5) / f).min(1.0);
            t * t * (3.0 - 2.0 * t)
        };
        if expanded.left > 0 {
            v = v.min(ramp(x));
        }
        if expanded.right > 0 {
            v = v.min(ramp(size.width - 1 - x));
        }
        if expanded.top > 0 {
            v = v.min(ramp(y));
        }
        if expanded.bottom > 0 {
            v = v.min(ramp(size.height - 1 - y));
        }
        Luma([(v * 255.0).round() as u8])
    })
}

/// The original's pixels where `paste` < 255 (its blend band at expanded edges), mirrored across
/// the nearest expanded edge onto a `canvas`-sized image (the original sits at `rect`), and where
/// they landed. The truth to compare the new area against just outside the seam.
pub fn mirror_band(source: &RgbaImage, paste: &GrayImage, rect: Rect, expanded: crate::geometry::Expansion, canvas: Size) -> (RgbaImage, GrayImage) {
    let mut truth = RgbaImage::new(canvas.width, canvas.height);
    let mut known = GrayImage::new(canvas.width, canvas.height);
    let (w, h) = (source.width(), source.height());
    for (x, y, p) in paste.enumerate_pixels() {
        if p[0] == 255 {
            continue;
        }
        // Nearest expanded edge, and the point as far outside it as (x, y) is inside.
        let sides = [
            (expanded.left > 0, x, (rect.x as i64 - 1 - x as i64, (rect.y + y) as i64)),
            (expanded.right > 0, w - 1 - x, ((rect.right() + (w - 1 - x)) as i64, (rect.y + y) as i64)),
            (expanded.top > 0, y, ((rect.x + x) as i64, rect.y as i64 - 1 - y as i64)),
            (expanded.bottom > 0, h - 1 - y, ((rect.x + x) as i64, (rect.bottom() + (h - 1 - y)) as i64)),
        ];
        let Some(&(_, _, (mx, my))) = sides.iter().filter(|s| s.0).min_by_key(|s| s.1) else { continue };
        if mx < 0 || my < 0 || mx >= canvas.width as i64 || my >= canvas.height as i64 {
            continue;
        }
        truth.put_pixel(mx as u32, my as u32, *source.get_pixel(x, y));
        known.put_pixel(mx as u32, my as u32, Luma([255]));
    }
    (truth, known)
}

/// Replaces the pixels where `mask` > 127 by a smooth continuation of the pixels around
/// them (push-pull: weighted averages down a pyramid, then blended back up). Known pixels
/// stay exact. Erases content before a removal so the model cannot copy it back.
pub fn fill_masked(img: &RgbaImage, mask: &GrayImage) -> RgbaImage {
    assert_eq!(img.dimensions(), mask.dimensions());
    let (w, h) = (img.width() as usize, img.height() as usize);
    let color = img.pixels().map(|p| [p[0] as f32, p[1] as f32, p[2] as f32, p[3] as f32]).collect();
    let weight = mask.pixels().map(|m| if m[0] > 127 { 0.0 } else { 1.0 }).collect();
    let base = push_pull(w, h, color, weight, [128.0, 128.0, 128.0, 255.0]);
    let mut out = img.clone();
    for (i, (p, m)) in out.pixels_mut().zip(mask.pixels()).enumerate() {
        if m[0] > 127 {
            *p = Rgba(base[i].map(|v| v.round().clamp(0.0, 255.0) as u8));
        }
    }
    out
}

/// Push-pull fill of a `w`×`h` grid: where `weight` < 1, values blend toward the bilinearly
/// upsampled weighted means of a coarser pyramid level (fully known cells stay exact).
fn push_pull<const N: usize>(w: usize, h: usize, color: Vec<[f32; N]>, weight: Vec<f32>, empty: [f32; N]) -> Vec<[f32; N]> {
    struct Level<const N: usize> {
        w: usize,
        h: usize,
        color: Vec<[f32; N]>,
        weight: Vec<f32>,
    }
    let mut levels = vec![Level { w, h, color, weight }];
    // Push: each coarser pixel is the weighted mean of its (up to) 4 children.
    while levels.last().map(|l| l.w > 1 || l.h > 1).unwrap() {
        let cur = levels.last().unwrap();
        let (nw, nh) = (cur.w.div_ceil(2), cur.h.div_ceil(2));
        let mut csum = vec![[0f32; N]; nw * nh];
        let mut wsum = vec![0f32; nw * nh];
        for y in 0..cur.h {
            for x in 0..cur.w {
                let (i, j) = (y * cur.w + x, (y / 2) * nw + x / 2);
                let wt = cur.weight[i];
                for (s, v) in csum[j].iter_mut().zip(cur.color[i]) {
                    *s += v * wt;
                }
                wsum[j] += wt;
            }
        }
        let color = csum.iter().zip(&wsum).map(|(c, &s)| if s > 0.0 { c.map(|v| v / s) } else { empty }).collect();
        levels.push(Level { w: nw, h: nh, color, weight: wsum.iter().map(|s| s.min(1.0)).collect() });
    }
    // Pull: unknown (or partly known) pixels take the bilinearly upsampled coarser level.
    for l in (0..levels.len() - 1).rev() {
        let (fine, coarse) = levels.split_at_mut(l + 1);
        let (f, c) = (&mut fine[l], &coarse[0]);
        let sample = |x: usize, y: usize| -> [f32; N] {
            let fx = ((x as f32 + 0.5) / 2.0 - 0.5).clamp(0.0, (c.w - 1) as f32);
            let fy = ((y as f32 + 0.5) / 2.0 - 0.5).clamp(0.0, (c.h - 1) as f32);
            let (x0, y0) = (fx as usize, fy as usize);
            let (x1, y1) = ((x0 + 1).min(c.w - 1), (y0 + 1).min(c.h - 1));
            let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
            let p = |x: usize, y: usize| c.color[y * c.w + x];
            let (a, b, d, e) = (p(x0, y0), p(x1, y0), p(x0, y1), p(x1, y1));
            std::array::from_fn(|k| (a[k] * (1.0 - tx) + b[k] * tx) * (1.0 - ty) + (d[k] * (1.0 - tx) + e[k] * tx) * ty)
        };
        for y in 0..f.h {
            for x in 0..f.w {
                let i = y * f.w + x;
                let wt = f.weight[i];
                if wt < 1.0 {
                    let up = sample(x, y);
                    f.color[i] = std::array::from_fn(|k| f.color[i][k] * wt + up[k] * (1.0 - wt));
                }
            }
        }
    }
    levels.swap_remove(0).color
}

/// Low-frequency colour difference `truth` − `generated` on a coarse grid over `generated`:
/// measured where `known` > 0 (weighted by it) and spread smoothly everywhere else. Lets a
/// generated area take on the colour of the original pixels it meets at a paste border (the
/// model's colour cast), without touching detail.
pub struct ColorShift {
    w: usize,
    h: usize,
    cell: f32,
    d: Vec<[f32; 3]>,
}

/// Grid cells along the longer side of a [`ColorShift`]: coarse on purpose, only the cast is wanted.
const SHIFT_CELLS: u32 = 96;

/// `truth` and `known` share a size and sit at `at` in `generated`; each channel's shift is
/// capped at ±`max`. None when nothing is known.
pub fn color_shift(generated: &RgbaImage, truth: &RgbaImage, known: &GrayImage, at: (u32, u32), max: f32) -> Option<ColorShift> {
    assert_eq!(truth.dimensions(), known.dimensions());
    let cell = generated.width().max(generated.height()).div_ceil(SHIFT_CELLS).max(1);
    let (w, h) = (generated.width().div_ceil(cell) as usize, generated.height().div_ceil(cell) as usize);
    let mut sum = vec![[0f32; 3]; w * h];
    let mut wsum = vec![0f32; w * h];
    for (x, y, k) in known.enumerate_pixels() {
        let (gx, gy) = (x + at.0, y + at.1);
        if k[0] == 0 || gx >= generated.width() || gy >= generated.height() {
            continue;
        }
        let (t, g, wt) = (truth.get_pixel(x, y), generated.get_pixel(gx, gy), k[0] as f32 / 255.0);
        let j = (gy / cell) as usize * w + (gx / cell) as usize;
        for c in 0..3 {
            sum[j][c] += (t[c] as f32 - g[c] as f32) * wt;
        }
        wsum[j] += wt;
    }
    if wsum.iter().all(|&s| s == 0.0) {
        return None;
    }
    // A cell is fully trusted once a tenth of it is known.
    let full = (cell * cell) as f32 * 0.1;
    let d = sum.iter().zip(&wsum).map(|(s, &n)| if n > 0.0 { s.map(|v| (v / n).clamp(-max, max)) } else { [0.0; 3] }).collect();
    let weight = wsum.iter().map(|&n| (n / full).min(1.0)).collect();
    let mut d = push_pull(w, h, d, weight, [0.0; 3]);
    // Smooth: detail differences inside the band must not print as blotches.
    for _ in 0..2 {
        d = box_cells(&d, w, h, 2);
    }
    Some(ColorShift { w, h, cell: cell as f32, d })
}

/// Box blur of a `w`×`h` grid, radius `r` cells, edges clamped.
fn box_cells(d: &[[f32; 3]], w: usize, h: usize, r: usize) -> Vec<[f32; 3]> {
    let pass = |src: &[[f32; 3]], horizontal: bool| -> Vec<[f32; 3]> {
        (0..w * h)
            .map(|i| {
                let (x, y) = (i % w, i / w);
                let (lo, hi) = if horizontal { (x.saturating_sub(r), (x + r).min(w - 1)) } else { (y.saturating_sub(r), (y + r).min(h - 1)) };
                let mut s = [0f32; 3];
                for k in lo..=hi {
                    let v = if horizontal { src[y * w + k] } else { src[k * w + x] };
                    for c in 0..3 {
                        s[c] += v[c];
                    }
                }
                s.map(|v| v / (hi - lo + 1) as f32)
            })
            .collect()
    };
    pass(&pass(d, true), false)
}

impl ColorShift {
    /// The shift at pixel (`x`, `y`) of the generated image (bilinear between cell centres).
    pub fn at(&self, x: u32, y: u32) -> [f32; 3] {
        let fx = ((x as f32 + 0.5) / self.cell - 0.5).clamp(0.0, (self.w - 1) as f32);
        let fy = ((y as f32 + 0.5) / self.cell - 0.5).clamp(0.0, (self.h - 1) as f32);
        let (x0, y0) = (fx as usize, fy as usize);
        let (x1, y1) = ((x0 + 1).min(self.w - 1), (y0 + 1).min(self.h - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let p = |x: usize, y: usize| self.d[y * self.w + x];
        let (a, b, c, e) = (p(x0, y0), p(x1, y0), p(x0, y1), p(x1, y1));
        std::array::from_fn(|k| (a[k] * (1.0 - tx) + b[k] * tx) * (1.0 - ty) + (c[k] * (1.0 - tx) + e[k] * tx) * ty)
    }

    /// Adds the shift to `img` (the generated image), scaled per pixel by `weight` (0..1).
    pub fn apply(&self, img: &mut RgbaImage, weight: impl Fn(u32, u32) -> f32) {
        for (x, y, p) in img.enumerate_pixels_mut() {
            let wt = weight(x, y);
            if wt <= 0.0 {
                continue;
            }
            let d = self.at(x, y);
            for c in 0..3 {
                p[c] = (p[c] as f32 + d[c] * wt).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// Colors for marking an area on a guide image, as named in the prompt.
const HIGHLIGHTS: [(&str, [u8; 3]); 4] = [("red", [255, 0, 0]), ("green", [0, 230, 0]), ("blue", [0, 80, 255]), ("magenta", [255, 0, 255])];

/// Highlight color for marking the area where `mask` > 127 on `img`: red (the usual choice)
/// unless the area itself is largely reddish, else the color least present there.
pub fn pick_highlight(img: &RgbaImage, mask: &GrayImage) -> (&'static str, [u8; 3]) {
    assert_eq!(img.dimensions(), mask.dimensions());
    let step = ((img.width() as usize * img.height() as usize) / 200_000).max(1);
    let mut near = [0usize; HIGHLIGHTS.len()];
    let mut n = 0usize;
    for (p, m) in img.pixels().zip(mask.pixels()).step_by(step) {
        if m[0] <= 127 {
            continue;
        }
        n += 1;
        for (k, (_, c)) in HIGHLIGHTS.iter().enumerate() {
            let d: i32 = (0..3).map(|i| (p[i] as i32 - c[i] as i32).pow(2)).sum();
            if d < 140 * 140 {
                near[k] += 1;
            }
        }
    }
    if n == 0 || near[0] * 100 < n * 15 {
        return HIGHLIGHTS[0];
    }
    let k = (0..HIGHLIGHTS.len()).min_by_key(|&k| near[k]).unwrap();
    HIGHLIGHTS[k]
}

/// Guide image: `img` with the area where `mask` > 127 tinted with `color` and outlined,
/// so a prompt can refer to "the area marked in red". Fully opaque.
pub fn highlight(img: &RgbaImage, mask: &GrayImage, color: [u8; 3]) -> RgbaImage {
    assert_eq!(img.dimensions(), mask.dimensions());
    let inside = binarize(mask, 127);
    let ring = dilate(&inside, (img.width().max(img.height()) / 200).max(2));
    RgbaImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        if inside.get_pixel(x, y)[0] > 0 {
            let tint = |i: usize| ((p[i] as u32 + color[i] as u32) / 2) as u8;
            Rgba([tint(0), tint(1), tint(2), 255])
        } else if ring.get_pixel(x, y)[0] > 0 {
            Rgba([color[0], color[1], color[2], 255])
        } else {
            Rgba([p[0], p[1], p[2], 255])
        }
    })
}

#[cfg(test)]
mod fill_tests {
    use super::*;

    #[test]
    fn color_shift_takes_the_cast_measured_in_the_band_and_nothing_else() {
        // A generated image warmer than the truth; only a band at the truth's left is known.
        let truth = RgbaImage::from_pixel(300, 200, Rgba([120, 120, 120, 255]));
        let generated = RgbaImage::from_pixel(400, 200, Rgba([130, 125, 120, 255]));
        let known = GrayImage::from_fn(300, 200, |x, _| Luma([if x < 30 { 255 } else { 0 }]));
        let s = color_shift(&generated, &truth, &known, (100, 0), 32.0).unwrap();
        for (x, y) in [(0, 0), (50, 100), (110, 150), (399, 199)] {
            let d = s.at(x, y);
            assert!((d[0] + 10.0).abs() < 0.5 && (d[1] + 5.0).abs() < 0.5 && d[2].abs() < 0.5, "{x},{y}: {d:?}");
        }
        let mut g = generated.clone();
        s.apply(&mut g, |x, _| if x < 100 { 1.0 } else { 0.0 });
        assert_eq!(g.get_pixel(10, 10).0, [120, 120, 120, 255]);
        assert_eq!(g.get_pixel(200, 10).0, [130, 125, 120, 255]);
        // No cast, no change; nothing known, no shift.
        assert!(color_shift(&truth, &truth, &known, (0, 0), 32.0).unwrap().at(5, 5).iter().all(|v| v.abs() < 1e-3));
        assert!(color_shift(&truth, &truth, &GrayImage::new(300, 200), (0, 0), 32.0).is_none());
    }

    #[test]
    fn color_shift_is_capped() {
        let truth = RgbaImage::from_pixel(64, 64, Rgba([0, 0, 0, 255]));
        let generated = RgbaImage::from_pixel(64, 64, Rgba([200, 200, 200, 255]));
        let s = color_shift(&generated, &truth, &GrayImage::from_pixel(64, 64, Luma([255])), (0, 0), 24.0).unwrap();
        assert!((s.at(30, 30)[0] + 24.0).abs() < 1e-3);
    }

    #[test]
    fn fill_masked_keeps_known_pixels_and_continues_colors() {
        // Left half blue, right half green, a red square across the boundary.
        let mut img = RgbaImage::from_fn(64, 32, |x, _| if x < 32 { Rgba([0, 0, 200, 255]) } else { Rgba([0, 200, 0, 255]) });
        let mut m = GrayImage::new(64, 32);
        for y in 8..24 {
            for x in 20..44 {
                img.put_pixel(x, y, Rgba([255, 0, 0, 255]));
                m.put_pixel(x, y, Luma([255]));
            }
        }
        let out = fill_masked(&img, &m);
        for (x, y, p) in out.enumerate_pixels() {
            if m.get_pixel(x, y)[0] == 0 {
                assert_eq!(p, img.get_pixel(x, y));
            } else {
                assert!(p[0] < 40, "no red left at {x},{y}: {p:?}");
            }
        }
        assert!(out.get_pixel(21, 16)[2] > out.get_pixel(21, 16)[1], "left side continues blue");
        assert!(out.get_pixel(42, 16)[1] > out.get_pixel(42, 16)[2], "right side continues green");
    }

    #[test]
    fn highlight_avoids_the_area_color() {
        let red = RgbaImage::from_pixel(32, 32, Rgba([230, 20, 20, 255]));
        let gray = RgbaImage::from_pixel(32, 32, Rgba([120, 120, 120, 255]));
        let m = GrayImage::from_pixel(32, 32, Luma([255]));
        assert_eq!(pick_highlight(&gray, &m).0, "red");
        assert_ne!(pick_highlight(&red, &m).0, "red");
    }
}

pub fn thumbnail(img: &RgbaImage, max_side: u32) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    if w.max(h) <= max_side {
        return img.clone();
    }
    let s = max_side as f64 / w.max(h) as f64;
    let (tw, th) = (((w as f64 * s).round() as u32).max(1), ((h as f64 * s).round() as u32).max(1));
    imageops::thumbnail(img, tw, th)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::Expansion;

    fn gradient(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([(x * 255 / w.max(1)) as u8, (y * 255 / h.max(1)) as u8, 77, 255]))
    }

    #[test]
    fn engine_tiles_may_exceed_the_input_limit() {
        // An x4 tile of a 2048² image is 8192² (67 MP): over the import limit, but ours.
        let (w, h) = (8192, 8192);
        assert!(w as u64 * h as u64 > MAX_INPUT_PIXELS);
        let png = encode_png(&RgbaImage::from_pixel(w, h, Rgba([10, 20, 30, 255])), &[], None, true).unwrap();
        assert!(decode_image(&png).is_err(), "imports keep the limit");
        assert_eq!(decode_engine_image(&png, 8192).unwrap().dimensions(), (w, h));
        assert!(decode_engine_image(&png, 4096).is_err(), "larger than the plan allows");
    }

    #[test]
    fn jpeg_flattens_transparency_onto_white() {
        // Left half: purple under alpha 0 (Qwen-Image's RGBA background); right half opaque red.
        let img = RgbaImage::from_fn(64, 32, |x, _| if x < 32 { Rgba([155, 75, 196, 0]) } else { Rgba([200, 0, 0, 255]) });
        let back = decode_image(&encode_jpeg(&img, 95).unwrap()).unwrap().pixels;
        let (bg, fg) = (back.get_pixel(8, 16), back.get_pixel(56, 16));
        assert!(bg.0[..3].iter().all(|&c| c > 245), "{bg:?}");
        assert!(fg[0] > 180 && fg[1] < 30, "{fg:?}");
    }

    /// Builds a JPEG with an EXIF APP1 segment carrying the given orientation.
    fn jpeg_with_orientation(img: &RgbaImage, orientation: u16) -> Vec<u8> {
        let jpeg = encode_jpeg(img, 95).unwrap();
        // Minimal little-endian TIFF with a single IFD0 entry: Orientation (0x0112), SHORT.
        let mut tiff = vec![b'I', b'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00];
        tiff.extend_from_slice(&0x0112u16.to_le_bytes());
        tiff.extend_from_slice(&3u16.to_le_bytes());
        tiff.extend_from_slice(&1u32.to_le_bytes());
        tiff.extend_from_slice(&orientation.to_le_bytes());
        tiff.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        let mut payload = b"Exif\0\0".to_vec();
        payload.extend_from_slice(&tiff);
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        out.extend_from_slice(&payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    #[test]
    fn exif_rotation_is_applied() {
        let img = gradient(120, 80);
        let rotated = decode_image(&jpeg_with_orientation(&img, 6)).unwrap();
        assert_eq!(rotated.exif_orientation, 6);
        assert_eq!(rotated.size(), Size::new(80, 120));
        let plain = decode_image(&jpeg_with_orientation(&img, 1)).unwrap();
        assert_eq!(plain.size(), Size::new(120, 80));
        let r8 = decode_image(&jpeg_with_orientation(&img, 8)).unwrap();
        assert_eq!(r8.size(), Size::new(80, 120));
        // Rotate 90 CW: the original top-left (dark red channel) lands at top-right.
        let tl = rotated.pixels.get_pixel(79, 0);
        assert!(tl[0] < 40 && tl[1] < 40, "{tl:?}");
    }

    #[test]
    fn png_roundtrip_preserves_pixels_alpha_text_and_icc() {
        let mut img = gradient(64, 48);
        img.put_pixel(3, 3, Rgba([10, 20, 30, 0]));
        img.put_pixel(4, 3, Rgba([10, 20, 30, 128]));
        let icc = vec![1u8, 2, 3, 4, 5];
        let bytes = encode_png(&img, &[("parameters", "a cat, Steps: 30"), ("qls", "{\"seed\":1}")], Some(&icc), false).unwrap();
        let back = decode_image(&bytes).unwrap();
        assert_eq!(back.pixels, img);
        assert!(back.has_transparency);
        assert_eq!(back.icc_profile.as_deref(), Some(&icc[..]));
        assert!(back.text.iter().any(|(k, v)| k == "parameters" && v == "a cat, Steps: 30"));
        assert!(back.text.iter().any(|(k, _)| k == "qls"));
    }

    #[test]
    fn opaque_png_written_as_rgb_but_identical() {
        let img = gradient(33, 17);
        let bytes = encode_png(&img, &[], None, true).unwrap();
        let back = decode_image(&bytes).unwrap();
        assert!(!back.has_transparency);
        assert_eq!(back.pixels, img);
    }

    #[test]
    fn unicode_text_roundtrip() {
        let img = gradient(8, 8);
        let bytes = encode_png(&img, &[("parameters", "caffè, 東京 ✓")], None, true).unwrap();
        assert_eq!(read_png_text(&bytes)[0].1, "caffè, 東京 ✓");
    }

    #[test]
    fn pad_edge_preserves_content_and_replicates() {
        let img = gradient(1920 / 8, 1080 / 8);
        let canvas = Size::new(240, 136);
        let out = pad_edge(&img, canvas, (0, 1));
        assert_eq!(out.dimensions(), (240, 136));
        assert_eq!(crop(&out, Rect::new(0, 1, 240, 135)), img);
        assert_eq!(out.get_pixel(5, 0), img.get_pixel(5, 0));
        assert_eq!(out.get_pixel(5, 135), img.get_pixel(5, 134));
    }

    #[test]
    fn pad_then_crop_back_is_lossless() {
        let img = gradient(1537 / 4, 1025 / 4);
        let w = crate::geometry::plan_working_canvas(Size::new(img.width(), img.height()), &crate::geometry::CanvasLimits { min_side: 32, ..Default::default() });
        let padded = pad_edge(&img, w.canvas, w.content_offset);
        assert!(w.canvas.is_aligned(32));
        assert_eq!(crop(&padded, w.content_rect()), img);
    }

    #[test]
    fn resize_preserves_transparent_edges() {
        // Opaque white square on fully transparent *red* background: premultiplied resize
        // must not produce reddish fringe pixels.
        let img = RgbaImage::from_fn(64, 64, |x, y| {
            if (16..48).contains(&x) && (16..48).contains(&y) { Rgba([255, 255, 255, 255]) } else { Rgba([255, 0, 0, 0]) }
        });
        let out = resize(&img, 37, 37);
        for p in out.pixels() {
            if p[3] > 16 {
                assert!(p[1] > 200 && p[2] > 200, "fringe {p:?}");
            }
        }
        assert!(out.pixels().any(|p| p[3] == 0));
    }

    #[test]
    fn resize_identity_returns_same() {
        let img = gradient(50, 40);
        assert_eq!(resize(&img, 50, 40), img);
    }

    #[test]
    fn mask_ops() {
        let size = Size::new(100, 80);
        let m = mask_rect(size, Rect::new(40, 30, 10, 10), 255, 0);
        assert_eq!(mask_bbox(&m, 127), Some(Rect::new(40, 30, 10, 10)));
        let d = dilate(&m, 5);
        assert_eq!(mask_bbox(&d, 127), Some(Rect::new(35, 25, 20, 20)));
        let e = erode(&d, 5);
        assert_eq!(mask_bbox(&e, 127), Some(Rect::new(40, 30, 10, 10)));
        let inv = invert_mask(&m);
        assert_eq!(inv.get_pixel(0, 0)[0], 255);
        assert_eq!(inv.get_pixel(45, 35)[0], 0);
        let big = mask_rect(size, Rect::new(30, 20, 40, 40), 255, 0);
        let f = feather(&big, 6);
        assert_eq!(f.get_pixel(50, 40)[0], 255);
        assert_eq!(f.get_pixel(0, 0)[0], 0);
        let edge = f.get_pixel(30, 40)[0];
        assert!(edge > 0 && edge < 255, "edge {edge}");
        assert!(mask_bbox(&GrayImage::new(10, 10), 0).is_none());
        assert!((mask_coverage(&m, 127) - 100.0 / 8000.0).abs() < 1e-9);
    }

    #[test]
    fn backend_mask_covers_feather() {
        let size = Size::new(64, 64);
        let m = feather(&mask_rect(size, Rect::new(20, 20, 24, 24), 255, 0), 6);
        let b = backend_mask(&m, 4);
        for (x, y, p) in m.enumerate_pixels() {
            if p[0] > 0 {
                assert_eq!(b.get_pixel(x, y)[0], 255, "uncovered at {x},{y}");
            }
        }
        assert!(b.pixels().all(|p| p[0] == 0 || p[0] == 255));
    }

    #[test]
    fn mask_from_alpha_layer_and_from_luma() {
        let mut layer = RgbaImage::from_pixel(10, 10, Rgba([0, 0, 0, 0]));
        layer.put_pixel(2, 2, Rgba([0, 0, 0, 255]));
        let li = LoadedImage { pixels: layer, format: "png", exif_orientation: 1, icc_profile: None, has_transparency: true, text: vec![] };
        let m = mask_from_image(&li);
        assert_eq!(m.get_pixel(2, 2)[0], 255);
        assert_eq!(m.get_pixel(3, 3)[0], 0);
        let bw = RgbaImage::from_fn(10, 10, |x, _| if x < 5 { Rgba([255, 255, 255, 255]) } else { Rgba([0, 0, 0, 255]) });
        let li = LoadedImage { pixels: bw, format: "png", exif_orientation: 1, icc_profile: None, has_transparency: false, text: vec![] };
        let m = mask_from_image(&li);
        assert_eq!((m.get_pixel(1, 1)[0], m.get_pixel(8, 1)[0]), (255, 0));
        // White on black whose edge came out partly transparent (a canvas blur): still luminance.
        let soft = RgbaImage::from_fn(10, 10, |x, y| {
            let a = if x == 0 || y == 0 || x == 9 || y == 9 { 77 } else { 255 };
            if x < 5 { Rgba([255, 255, 255, a]) } else { Rgba([0, 0, 0, a]) }
        });
        let li = LoadedImage { pixels: soft, format: "png", exif_orientation: 1, icc_profile: None, has_transparency: true, text: vec![] };
        let m = mask_from_image(&li);
        assert_eq!((m.get_pixel(1, 1)[0], m.get_pixel(8, 1)[0], m.get_pixel(8, 0)[0]), (255, 0, 0));
    }

    #[test]
    fn composite_keeps_unmasked_pixels_exactly_including_alpha() {
        let mut base = RgbaImage::from_fn(50, 50, |x, y| Rgba([x as u8, y as u8, 9, (x * 5) as u8]));
        let orig = base.clone();
        let top = RgbaImage::from_pixel(20, 20, Rgba([200, 200, 200, 255]));
        let mask = feather(&mask_rect(Size::new(20, 20), Rect::new(5, 5, 10, 10), 255, 0), 3);
        composite(&mut base, &top, &mask, (10, 10));
        for (x, y, p) in base.enumerate_pixels() {
            let inside_top = (10..30).contains(&x) && (10..30).contains(&y);
            if !inside_top || mask.get_pixel(x - 10, y - 10)[0] == 0 {
                assert_eq!(p, orig.get_pixel(x, y));
            }
        }
        assert_eq!(base.get_pixel(20, 20), &Rgba([200, 200, 200, 255]));
    }

    #[test]
    fn outpaint_masks() {
        let size = Size::new(128, 64);
        let keep = Rect::new(0, 0, 96, 64);
        let m = outpaint_mask(size, keep, Expansion { right: 8, ..Default::default() });
        assert_eq!(m.get_pixel(10, 10)[0], 0);
        assert_eq!(m.get_pixel(90, 10)[0], 255); // overlap band regenerated
        assert_eq!(m.get_pixel(120, 10)[0], 255);
        let p = paste_back_mask(Size::new(96, 64), Expansion { right: 32, ..Default::default() }, 8);
        assert_eq!(p.get_pixel(0, 10)[0], 255); // left edge not expanded: no ramp
        assert_eq!(p.get_pixel(50, 10)[0], 255);
        assert!(p.get_pixel(95, 10)[0] < 40);
    }

    #[test]
    fn decode_failure_is_friendly() {
        let e = decode_image(b"not an image at all").unwrap_err();
        assert_eq!(e.code, ErrorCode::ImageDecode);
    }
}
