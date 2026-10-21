//! Executes a [`Plan`] at the pixel level: builds the backend request (exact working
//! geometry, binary masks) and post-processes results (crop alignment padding, restore
//! dimensions, composite inpaint/outpaint so untouched pixels stay bit-identical).
//! Enlargements go through ESRGAN when the engine has it: [`crop_content`], then
//! [`enlarge_target`] / [`esrgan_plan`] + [`Stitcher`], then [`finish`].

use image::{GrayImage, Luma, Rgba, RgbaImage};

use crate::error::{AppError, AppResult, ErrorCode};
use crate::geometry::{Rect, Size, WorkingCanvas};
use crate::imaging::{self, LoadedImage};
use crate::planner::{InpaintAction, Plan, ReferenceDetail, ResolvedMode};
use crate::sdcpp::{Guidance, ImgGenRequest, SampleParams, VaeTilingParams, b64};

/// Server-side facts that shape the request but are not part of the plan.
#[derive(Debug, Clone)]
pub struct BackendOptions {
    /// `--vae-tile-size` the server was launched with (0 = no server-side tiling).
    pub server_vae_tile_size: u32,
}

impl Default for BackendOptions {
    fn default() -> Self {
        Self { server_vae_tile_size: 0 }
    }
}

/// Tile size used when the server has no tiling configured (2K decode: ~4 s vs ~22 s at 256 px).
pub const DEFAULT_VAE_TILE: u32 = 768;

/// Per-request VAE tiling. The request is merged over the server's launch defaults, so
/// when the server already tiles (`--vae-tiling --vae-tile-size N`) nothing is sent —
/// sending `tile_size 0` would silently select 256 px tiles. Only an explicit "off"
/// overrides it.
/// A per-job tile (`Plan::vae_tile`, large discrete GPUs) replaces the server's size.
pub fn vae_tiling_params(tiling: bool, server_tile: u32, job_tile: Option<(u32, u32)>) -> Option<VaeTilingParams> {
    if let (true, Some((w, h))) = (tiling, job_tile) {
        return Some(VaeTilingParams { enabled: true, tile_size_w: Some(w), tile_size_h: Some(h), target_overlap: Some(crate::planner::VAE_TILE_OVERLAP) });
    }
    match (tiling, server_tile > 0) {
        (true, true) | (false, false) => None,
        (false, true) => Some(VaeTilingParams { enabled: false, ..Default::default() }),
        (true, false) => Some(VaeTilingParams { enabled: true, tile_size_w: Some(DEFAULT_VAE_TILE), tile_size_h: Some(DEFAULT_VAE_TILE), target_overlap: Some(0.125) }),
    }
}

pub struct PreparedJob {
    pub request: ImgGenRequest,
    pub post: PostProcess,
}

pub enum PostKind {
    Plain,
    Inpaint { source: RgbaImage, region: Rect, blend: GrayImage },
    Outpaint { source: RgbaImage, feather: u32 },
}

pub struct PostProcess {
    pub kind: PostKind,
    /// Qwen-Image 2.1 always decodes an alpha channel; on opaque content ~1% of pixels
    /// come back at alpha 247–254. When transparency is not intended, force opaque.
    pub keep_alpha: bool,
    pub working: Size,
    pub content: Rect,
    pub output: Size,
    pub mode: ResolvedMode,
    pub outpaint: Option<crate::geometry::OutpaintPlan>,
}

fn png_b64(img: &RgbaImage) -> AppResult<String> {
    Ok(b64(&imaging::encode_png(img, &[], None, true)?))
}

fn gray_png_b64(m: &GrayImage) -> AppResult<String> {
    let mut out = Vec::new();
    image::DynamicImage::ImageLuma8(m.clone())
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| AppError::internal(e))?;
    Ok(b64(&out))
}

/// Places `img` (resized to the canvas content) on the plan's padded canvas.
fn to_canvas(img: &RgbaImage, c: &crate::geometry::WorkingCanvas) -> RgbaImage {
    let resized = imaging::resize(img, c.content.width, c.content.height);
    imaging::pad_edge(&resized, c.canvas, c.content_offset)
}

fn mean_color(img: &RgbaImage) -> Rgba<u8> {
    let (mut r, mut g, mut b, mut n) = (0u64, 0u64, 0u64, 0u64);
    let step = ((img.width() as u64 * img.height() as u64) / 65_536).max(1) as usize;
    for p in img.pixels().step_by(step) {
        r += p[0] as u64;
        g += p[1] as u64;
        b += p[2] as u64;
        n += 1;
    }
    let n = n.max(1);
    Rgba([(r / n) as u8, (g / n) as u8, (b / n) as u8, 255])
}

fn is_binary(m: &GrayImage) -> bool {
    m.pixels().all(|p| p[0] == 0 || p[0] == 255)
}

const RGBA_PREFIX: &str = "This is an RGBA image with transparency.";
const RGBA_SUFFIX: &str = "The image has alpha channel and the background is transparent.";

/// True when the prompt asks for transparency (e.g. "transparent background", "remove the background").
pub fn wants_transparency(prompt: &str) -> bool {
    let p = prompt.to_lowercase();
    ["transparent", "transparency", "alpha channel", "rgba", "no background", "without background", "remove the background", "remove background", "cut out", "cutout"]
        .iter()
        .any(|k| p.contains(k))
}

/// Inpaint instruction: `<image1>` is the region (blurred out where content is removed),
/// `<image2>` the same region with the area marked in `color`. The wording follows the
/// official Qwen-Image 2.1 edit prompt guide (refer to images as `<imageN>`; for removals,
/// describe what fills the exposed area).
pub fn inpaint_prompt(action: InpaintAction, prompt: &str, color: &str) -> String {
    let area = format!("the area marked in {color} in <image2>");
    let keep = "Keep everything outside the marked area exactly as it is.";
    let what = action.subject(prompt);
    match action {
        InpaintAction::Edit => format!("In <image1>, change only {area}: {what}. Blend the change seamlessly into the surrounding scene. {keep}"),
        InpaintAction::Remove => {
            let (target, it) = if what.is_empty() { ("everything that was there".to_string(), "it") } else { (what.clone(), "the removed content") };
            format!(
                "In <image1>, {area} has been blurred out to remove {target}. Replace the blurred area with the background that would naturally be behind it, \
                 continuing the surrounding scene, textures, lighting and perspective, so that no trace, outline or shadow of {it} remains. {keep}"
            )
        }
        InpaintAction::Replace => format!(
            "In <image1>, replace what is inside {area} with {what}. Match the scene's lighting, perspective, scale and style so it looks naturally part of the image. {keep}"
        ),
        InpaintAction::Add => format!(
            "In <image1>, add {what} inside {area}, fitting it naturally into the scene with matching lighting, perspective, scale and shadows. {keep}"
        ),
    }
}

/// Prompt sent to the model. Transparency requests use the prompt format recommended for
/// Qwen-Image 2.1 RGBA output; outpainting gets an instruction prefix so short prompts
/// like "extend left" still describe the task.
pub fn effective_prompt(plan: &Plan, prompt: &str) -> String {
    let p = prompt.trim();
    if wants_transparency(p) && !p.starts_with(RGBA_PREFIX) {
        let body = p.trim_end_matches('.');
        return format!("{RGBA_PREFIX} {body}. {RGBA_SUFFIX}");
    }
    match plan.mode {
        ResolvedMode::Outpaint => format!(
            "Extend the image naturally into the empty border areas, continuing the scene with matching perspective, lighting and style. {}",
            prompt.trim()
        ),
        _ => prompt.trim().to_string(),
    }
}

/// The prompt sent for an enhanced job (text-to-image, edit, combine): the enhancer's text,
/// wrapped for transparency when the user's own words asked for it (not the rewrite's, which
/// may mention "transparent glass").
pub fn enhanced_prompt(original: &str, enhanced: &str) -> String {
    let p = enhanced.trim();
    if wants_transparency(original) && !p.starts_with(RGBA_PREFIX) {
        return format!("{RGBA_PREFIX} {}. {RGBA_SUFFIX}", p.trim_end_matches('.'));
    }
    p.to_string()
}

pub fn prepare(plan: &Plan, prompt: &str, seed: i64, images: &[LoadedImage], mask: Option<&GrayImage>, opts: &BackendOptions) -> AppResult<PreparedJob> {
    let first = plan.working;
    let mut req = ImgGenRequest {
        prompt: effective_prompt(plan, prompt),
        negative_prompt: plan.negative_prompt.clone(),
        width: first.width,
        height: first.height,
        seed,
        batch_count: plan.batch_count,
        strength: None,
        init_image: None,
        mask_image: None,
        ref_images: Vec::new(),
        image_preprocess: Vec::new(),
        ref_image_args: None,
        sample_params: SampleParams {
            sample_method: Some(plan.sampler.clone()),
            scheduler: None,
            sample_steps: plan.steps,
            flow_shift: None,
            custom_sigmas: plan.custom_sigmas.clone(),
            guidance: Guidance { txt_cfg: plan.cfg, img_cfg: None },
        },
        vae_tiling_params: vae_tiling_params(plan.vae_tiling, opts.server_vae_tile_size, plan.vae_tile),
        hires: None,
        cache_mode: None,
        cache_option: None,
        lora: Vec::new(),
        output_format: "png".into(),
        embed_image_metadata: false,
    };
    let mut kind = PostKind::Plain;
    let keep_alpha = wants_transparency(prompt) || images.iter().any(|i| i.has_transparency);
    let need_images = |n: usize| -> AppResult<()> {
        if images.len() < n {
            Err(AppError::new(ErrorCode::InvalidInput, "An input image is missing."))
        } else {
            Ok(())
        }
    };

    match plan.mode {
        ResolvedMode::Generate => {}
        ResolvedMode::Edit | ResolvedMode::MultiReference => {
            need_images(plan.references.len())?;
            for r in &plan.references {
                let img = &images[r.index].pixels;
                req.ref_images.push(png_b64(&to_canvas(img, &r.canvas))?);
            }
            req.image_preprocess.push("target=ref,mode=none".into());
            // Standard detail: encode the references at their planned (≤ 1 MP) size; Full keeps
            // the server's resize to the output's area, as before.
            if plan.reference_detail == Some(ReferenceDetail::Standard) {
                req.ref_image_args = Some("resize_before_vae=false".into());
            }
            if let Some(s) = plan.strength {
                req.strength = Some(s);
            }
        }
        ResolvedMode::Inpaint => {
            need_images(1)?;
            let src = &images[0].pixels;
            let src_size = Size::new(src.width(), src.height());
            let user_mask = mask.ok_or_else(|| AppError::invalid("A mask is required for inpainting."))?;
            let user_mask = imaging::resize_mask(user_mask, src_size.width, src_size.height);
            let region = plan.inpaint_region.unwrap_or(Rect::new(0, 0, src_size.width, src_size.height));
            let action = plan.inpaint_action.unwrap_or_default();
            // The working canvas (image being painted), from the plan; image 1 for the model
            // may be smaller (references[0], capped at 1 MP with Standard detail).
            let wc = WorkingCanvas {
                source: region.size(),
                content: Size::new(plan.content.width, plan.content.height),
                canvas: plan.working,
                content_offset: (plan.content.x, plan.content.y),
                scale: plan.content.width as f64 / region.width.max(1) as f64,
            };
            let rc = plan.references[0].canvas;
            let crop = imaging::crop(src, region);
            let content = imaging::resize(&crop, wc.content.width, wc.content.height);
            drop(crop);

            // Blend mask (source resolution): soft edges so the patch merges invisibly.
            let mut blend = imaging::crop_mask(&user_mask, region);
            if action == InpaintAction::Remove {
                // Removals also take the halo and contact shadow just outside the stroke.
                blend = imaging::dilate(&blend, ((region.width.max(region.height) as f64) * 0.01).round().max(4.0) as u32);
            }
            if is_binary(&blend) {
                let r = ((region.width.max(region.height) as f64) * 0.006).round().max(3.0) as u32;
                blend = imaging::feather(&imaging::dilate(&blend, r / 2), r);
            }
            // Backend mask (working resolution): binary, grown to cover the soft edge.
            let m_content = imaging::resize_mask(&blend, wc.content.width, wc.content.height);
            let grow = ((wc.scale * 4.0).round() as u32).clamp(4, 24);
            let m_work = imaging::backend_mask(&m_content, grow);
            let mut m_canvas = GrayImage::from_pixel(wc.canvas.width, wc.canvas.height, Luma([0]));
            image::imageops::replace(&mut m_canvas, &m_work, wc.content_offset.0 as i64, wc.content_offset.1 as i64);

            // Image 1: the region; for a removal with the content already blurred away, so
            // the model rebuilds background instead of copying the object back.
            let pad = |img: &RgbaImage| imaging::pad_edge(img, wc.canvas, wc.content_offset);
            let image1 = if action == InpaintAction::Remove { imaging::fill_masked(&content, &m_work) } else { content.clone() };
            // Image 2 (guide): the area marked in a color named in the prompt. The model gets
            // no mask otherwise; the latent mask only discards changes outside it.
            let gc = plan.references.get(1).map(|r| r.canvas).ok_or_else(|| AppError::internal("missing inpaint guide plan"))?;
            let (color_name, color) = imaging::pick_highlight(&content, &m_content);
            let guide_mask = imaging::resize_mask(&m_work, gc.content.width, gc.content.height);
            let guide = imaging::highlight(&imaging::resize(&image1, gc.content.width, gc.content.height), &guide_mask, color);
            drop(content);

            let image1_b64 = png_b64(&pad(&image1))?;
            req.init_image = Some(image1_b64.clone());
            let same = rc.canvas == wc.canvas && rc.content == wc.content && rc.content_offset == wc.content_offset;
            req.ref_images.push(if same { image1_b64 } else { png_b64(&imaging::pad_edge(&imaging::resize(&image1, rc.content.width, rc.content.height), rc.canvas, rc.content_offset))? });
            req.ref_images.push(png_b64(&imaging::pad_edge(&guide, gc.canvas, gc.content_offset))?);
            // Standard detail: the references are encoded at their planned sizes (image 1 ≤ 1 MP,
            // the guide a quarter of the canvas); Full lets the server resize both to the output's area.
            if plan.reference_detail == Some(ReferenceDetail::Standard) {
                req.ref_image_args = Some("resize_before_vae=false".into());
            }
            req.prompt = inpaint_prompt(action, prompt, color_name);
            req.mask_image = Some(gray_png_b64(&m_canvas)?);
            req.strength = plan.strength;
            req.image_preprocess = vec!["target=init,mode=none".into(), "target=mask,mode=none,filter=nearest-exact".into(), "target=ref,mode=none".into()];
            kind = PostKind::Inpaint { source: src.clone(), region, blend };
        }
        ResolvedMode::Outpaint => {
            need_images(1)?;
            let src = &images[0].pixels;
            let op = plan.outpaint.ok_or_else(|| AppError::internal("missing outpaint plan"))?;
            let r = op.source_rect_working;
            let scaled = imaging::resize(src, r.width, r.height);
            // Unknown areas get the image's mean color: neutral, no edge streaks.
            let canvas = imaging::pad_solid(&scaled, op.working.canvas, (r.x, r.y), mean_color(src));
            let mask = imaging::outpaint_mask(op.working.canvas, r, op.overlap_working);
            req.init_image = Some(png_b64(&canvas)?);
            req.mask_image = Some(gray_png_b64(&mask)?);
            req.ref_images.push(png_b64(&to_canvas(src, &plan.references[0].canvas))?);
            req.strength = plan.strength;
            req.image_preprocess = vec!["target=init,mode=none".into(), "target=mask,mode=none,filter=nearest-exact".into(), "target=ref,mode=none".into()];
            let feather_final = ((op.overlap_working.left.max(op.overlap_working.right).max(op.overlap_working.top).max(op.overlap_working.bottom)) as f64
                / op.working.scale)
                .round() as u32;
            kind = PostKind::Outpaint { source: src.clone(), feather: feather_final.max(2) };
        }
        ResolvedMode::Upscale => return Err(AppError::internal("an upscale has no diffusion request")),
    }

    Ok(PreparedJob {
        request: req,
        post: PostProcess { kind, keep_alpha, working: plan.working, content: plan.content, output: plan.output, mode: plan.mode, outpaint: plan.outpaint },
    })
}

/// Turns one backend output image into the delivered image (Lanczos for any resize).
pub fn postprocess(raw: RgbaImage, post: &PostProcess) -> AppResult<RgbaImage> {
    finish(crop_content(raw, post), post)
}

/// Step 1: the meaningful part of a backend image (alignment padding removed).
pub fn crop_content(raw: RgbaImage, post: &PostProcess) -> RgbaImage {
    let raw = if raw.width() != post.working.width || raw.height() != post.working.height {
        tracing::warn!("backend returned {}x{}, expected {:?}", raw.width(), raw.height(), post.working);
        imaging::resize(&raw, post.working.width, post.working.height)
    } else {
        raw
    };
    let mut content = imaging::crop(&raw, post.content);
    drop(raw);
    if !post.keep_alpha {
        for p in content.pixels_mut() {
            p[3] = 255;
        }
    }
    content
}

/// Size the content is resized to in [`finish`], when ESRGAN may help. Inpaint patches
/// are generated near native size and keep the plain path.
pub fn enlarge_target(post: &PostProcess) -> Option<Size> {
    match &post.kind {
        PostKind::Plain => Some(post.output),
        PostKind::Outpaint { .. } => post.outpaint.map(|o| o.final_size),
        PostKind::Inpaint { .. } => None,
    }
}

/// Step 3: resize (now usually *down* from an ESRGAN result) and composite. `content`
/// is the output of [`crop_content`], optionally enlarged in between.
pub fn finish(content: RgbaImage, post: &PostProcess) -> AppResult<RgbaImage> {
    Ok(match &post.kind {
        PostKind::Plain => imaging::resize(&content, post.output.width, post.output.height),
        PostKind::Inpaint { source, region, blend } => {
            let patch = imaging::resize(&content, region.width, region.height);
            let mut out = source.clone();
            imaging::composite(&mut out, &patch, blend, (region.x, region.y));
            out
        }
        PostKind::Outpaint { source, feather } => {
            let op = post.outpaint.as_ref().ok_or_else(|| AppError::internal("missing outpaint plan"))?;
            let mut out = imaging::resize(&content, op.final_size.width, op.final_size.height);
            let paste = imaging::paste_back_mask(Size::new(source.width(), source.height()), op.expansion, *feather);
            imaging::composite(&mut out, source, &paste, (op.source_rect_final.x, op.source_rect_final.y));
            out
        }
    })
}

// ---------------------------------------------------------------------------------------
// ESRGAN enlargement (POST /sdcpp/v1/upscale)
// ---------------------------------------------------------------------------------------

/// Results per side of one `/sdcpp/v1/upscale` call (server limit, routes_sdcpp.cpp).
pub const ESRGAN_MAX_OUTPUT_SIDE: u32 = 8192;
/// Context shared by neighbouring tiles; ESRGAN's receptive field is far smaller.
pub const ESRGAN_TILE_OVERLAP: u32 = 32;
/// Cap on the intermediate x4 image (~400 MB RGBA); larger inputs are shrunk first.
pub const ESRGAN_MAX_OUTPUT_AREA: u64 = 100_000_000;
/// Below this linear factor Lanczos is as good and much cheaper.
pub const ESRGAN_MIN_FACTOR: f64 = 1.1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tile {
    /// Region sent to the upscaler (input coordinates).
    pub rect: Rect,
    /// Part of the tile kept in the stitched result; cores cover the image without gaps.
    pub core: Rect,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EsrganPlan {
    /// Size the content is resized to before upscaling (usually unchanged).
    pub input: Size,
    pub tiles: Vec<Tile>,
}

fn axis_tiles(len: u32, max: u32, overlap: u32) -> Vec<(u32, u32, u32, u32)> {
    if len <= max {
        return vec![(0, len, 0, len)];
    }
    let n = (len - overlap).div_ceil(max - overlap);
    let tile = (len + (n - 1) * overlap).div_ceil(n).min(max);
    let mut out = Vec::with_capacity(n as usize);
    for i in 0..n {
        let start = (i * (tile - overlap)).min(len - tile);
        let end = start + tile;
        let core_start = if i == 0 { 0 } else { start + overlap / 2 };
        let core_end = if i == n - 1 { len } else { end - overlap / 2 };
        out.push((start, end, core_start, core_end));
    }
    out
}

/// Overlapping tiles no larger than `max` per side.
pub fn tile_grid(size: Size, max: u32, overlap: u32) -> Vec<Tile> {
    let xs = axis_tiles(size.width, max, overlap);
    let ys = axis_tiles(size.height, max, overlap);
    let mut tiles = Vec::with_capacity(xs.len() * ys.len());
    for &(y0, y1, cy0, cy1) in &ys {
        for &(x0, x1, cx0, cx1) in &xs {
            tiles.push(Tile { rect: Rect::new(x0, y0, x1 - x0, y1 - y0), core: Rect::new(cx0, cy0, cx1 - cx0, cy1 - cy0) });
        }
    }
    tiles
}

/// How to enlarge `content` to `target` with an x`scale` ESRGAN model; None when the
/// factor is small enough for Lanczos.
pub fn esrgan_plan(content: Size, target: Size, scale: u32) -> Option<EsrganPlan> {
    let factor = (target.width as f64 / content.width as f64).max(target.height as f64 / content.height as f64);
    if factor <= ESRGAN_MIN_FACTOR || scale < 2 {
        return None;
    }
    let s2 = (scale * scale) as u64;
    let input = if content.area() * s2 > ESRGAN_MAX_OUTPUT_AREA {
        let k = (ESRGAN_MAX_OUTPUT_AREA as f64 / (content.area() * s2) as f64).sqrt();
        Size::new(((content.width as f64 * k).floor() as u32).max(1), ((content.height as f64 * k).floor() as u32).max(1))
    } else {
        content
    };
    Some(EsrganPlan { input, tiles: tile_grid(input, ESRGAN_MAX_OUTPUT_SIDE / scale, ESRGAN_TILE_OVERLAP) })
}

/// Assembles upscaled tiles. The model's real factor comes from the first result.
pub struct Stitcher {
    input: Size,
    out: Option<RgbaImage>,
    scale: u32,
}

impl Stitcher {
    pub fn new(input: Size) -> Self {
        Self { input, out: None, scale: 0 }
    }

    pub fn add(&mut self, tile: &Tile, up: &RgbaImage) -> AppResult<()> {
        let scale = up.width() / tile.rect.width.max(1);
        if scale < 1 || up.width() != tile.rect.width * scale || up.height() != tile.rect.height * scale {
            return Err(AppError::new(ErrorCode::GenerationFailed, "The upscaler returned an unexpected size.")
                .detail(format!("tile {:?} -> {}x{}", tile.rect, up.width(), up.height())));
        }
        if self.out.is_none() {
            self.scale = scale;
            self.out = Some(RgbaImage::new(self.input.width * scale, self.input.height * scale));
        } else if scale != self.scale {
            return Err(AppError::new(ErrorCode::GenerationFailed, "The upscaler changed its scale between tiles."));
        }
        let c = tile.core;
        let piece = image::imageops::crop_imm(up, (c.x - tile.rect.x) * scale, (c.y - tile.rect.y) * scale, c.width * scale, c.height * scale).to_image();
        image::imageops::replace(self.out.as_mut().unwrap(), &piece, (c.x * scale) as i64, (c.y * scale) as i64);
        Ok(())
    }

    /// The stitched image. ESRGAN models are RGB-only, so `alpha_from`'s alpha channel
    /// (if it has any transparency) is resized onto the result.
    pub fn finish(self, alpha_from: &RgbaImage) -> AppResult<RgbaImage> {
        let mut out = self.out.ok_or_else(|| AppError::internal("no upscaled tiles"))?;
        if alpha_from.pixels().any(|p| p[3] != 255) {
            let a = image::imageops::resize(alpha_from, out.width(), out.height(), image::imageops::FilterType::Lanczos3);
            for (o, s) in out.pixels_mut().zip(a.pixels()) {
                o[3] = s[3];
            }
        } else {
            for p in out.pixels_mut() {
                p[3] = 255;
            }
        }
        Ok(out)
    }
}

/// Factor of the model's x4 output over the target that [`prescale_size`] aims for: the output
/// is then shrunk ~1.41x, like the downscaled photos these models are trained on.
pub const PRESCALE_OVERSHOOT: f64 = std::f64::consts::SQRT_2;

/// Input size for an `scale`x upscaler so its output is about [`PRESCALE_OVERSHOOT`] times
/// `target`: smaller than `content` for factors below ~2.8 (x4 model), else unchanged.
pub fn prescale_size(content: Size, target: Size, scale: u32) -> Size {
    let factor = (target.width as f64 / content.width as f64).max(target.height as f64 / content.height as f64);
    let s = (factor * PRESCALE_OVERSHOOT / scale as f64).min(1.0);
    if s >= 1.0 {
        return content;
    }
    Size::new(((content.width as f64 * s).round() as u32).max(16), ((content.height as f64 * s).round() as u32).max(16))
}

/// Keeps `amount` (0..1) of the upscaler's result `up` and the rest of a Lanczos enlargement of
/// `src` to the same size; alpha comes from `up`.
pub fn blend_with_lanczos(mut up: RgbaImage, src: &RgbaImage, amount: f32) -> RgbaImage {
    if amount >= 1.0 {
        return up;
    }
    let base = imaging::resize(src, up.width(), up.height());
    let a = amount.clamp(0.0, 1.0);
    for (o, b) in up.pixels_mut().zip(base.pixels()) {
        for c in 0..3 {
            o[c] = (o[c] as f32 * a + b[c] as f32 * (1.0 - a)).round() as u8;
        }
    }
    up
}

/// PNG (base64) of one tile for the upscale endpoint (alpha is dropped by the server).
pub fn tile_png_b64(input: &RgbaImage, tile: &Tile) -> AppResult<String> {
    png_b64(&imaging::crop(input, tile.rect))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enhanced_prompt_follows_the_users_words_for_transparency() {
        assert_eq!(enhanced_prompt("un gatto", "  A tabby cat on a sill.\n"), "A tabby cat on a sill.");
        assert_eq!(enhanced_prompt("a vase", "A transparent glass vase on oak."), "A transparent glass vase on oak.", "the rewrite's words do not ask for alpha");
        let p = enhanced_prompt("a logo with transparent background", "A flat fox logo.");
        assert_eq!(p, format!("{RGBA_PREFIX} A flat fox logo. {RGBA_SUFFIX}"));
        assert_eq!(enhanced_prompt("transparent", &p), p, "not wrapped twice");
    }

    #[test]
    fn prescale_and_blend() {
        let c = Size::new(1448, 1448);
        // x1.41 (1.5K render to 2K): half the input, so x4 lands at 1.41x the target.
        let p = prescale_size(c, Size::new(2048, 2048), 4);
        assert_eq!(p, Size::new(724, 724));
        assert_eq!(prescale_size(c, Size::new(2896, 2896), 4).width, 1024, "x2: ~0.71x");
        assert_eq!(prescale_size(c, Size::new(5792, 5792), 4), c, "x4: the full input");
        // Blend: 0 = Lanczos, 1 = the upscaler, alpha from the upscaler.
        let src = RgbaImage::from_pixel(2, 2, image::Rgba([100, 100, 100, 255]));
        let up = RgbaImage::from_pixel(8, 8, image::Rgba([200, 0, 50, 255]));
        assert_eq!(blend_with_lanczos(up.clone(), &src, 1.0), up);
        assert_eq!(blend_with_lanczos(up.clone(), &src, 0.0).get_pixel(3, 3).0, [100, 100, 100, 255]);
        assert_eq!(blend_with_lanczos(up, &src, 0.5).get_pixel(3, 3).0, [150, 50, 75, 255]);
    }
    use crate::config::RecommendedSettings;
    use crate::geometry::ExpansionUnits;
    use crate::planner::{GenerationRequest, Mode, OutpaintSpec, PlanInputs, Quality, ResolutionMode, STANDARD_REFERENCE_AREA, UpscaleSpec, plan};
    use crate::sdcpp::b64_decode;

    fn env(sizes: Vec<Size>) -> PlanInputs {
        PlanInputs { image_sizes: sizes, vram_total_mib: Some(16303), upscaler: Some("4xNomos2_hq_mosr".into()), ..Default::default() }
    }
    fn esrgan_opts() -> BackendOptions {
        BackendOptions { server_vae_tile_size: 768 }
    }

    #[test]
    fn vae_tiling_never_overrides_the_server_tile_size() {
        assert_eq!(vae_tiling_params(true, 768, None), None, "server already tiles with its own size");
        assert_eq!(vae_tiling_params(false, 0, None), None);
        assert_eq!(vae_tiling_params(false, 768, None), Some(VaeTilingParams { enabled: false, ..Default::default() }));
        let t = vae_tiling_params(true, 768, Some((1024, 1536))).unwrap();
        assert_eq!((t.enabled, t.tile_size_w, t.tile_size_h), (true, Some(1024), Some(1536)), "a per-job tile wins");
        assert_eq!(vae_tiling_params(false, 768, Some((1024, 1536))), Some(VaeTilingParams { enabled: false, ..Default::default() }), "off stays off");
        let p = vae_tiling_params(true, 0, None).unwrap();
        assert_eq!((p.enabled, p.tile_size_w, p.tile_size_h, p.target_overlap), (true, Some(768), Some(768), Some(0.125)));
        // Regression: a planned-tiled 2K job sent tile_size 0, i.e. 256 px tiles.
        let mut r = req("a cabin");
        r.aspect_ratio = Some("16:9".into());
        r.resolution = ResolutionMode::K2;
        let i = PlanInputs { server_vae_tiling: true, ..env(vec![]) };
        let p = plan(&r, &i, &RecommendedSettings::default()).unwrap();
        assert!(p.vae_tiling);
        let j = prepare(&p, &r.prompt, 1, &[], None, &esrgan_opts()).unwrap();
        // 16 GB: a tile shaped to the image, never size 0.
        let v = serde_json::to_value(&j.request).unwrap();
        assert!(v["vae_tiling_params"]["tile_size_w"].as_u64().unwrap() >= 256 && v["vae_tiling_params"]["tile_size_h"].as_u64().unwrap() >= 256, "{v}");
        // 12 GB: the server's own tiles, nothing sent.
        let p = plan(&r, &PlanInputs { vram_total_mib: Some(12282), ..i }, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, &[], None, &esrgan_opts()).unwrap();
        assert!(serde_json::to_value(&j.request).unwrap().get("vae_tiling_params").is_none());
    }

    #[test]
    fn quality_generate_request_is_one_pass() {
        let mut r = req("a cozy mountain cabin");
        r.aspect_ratio = Some("16:9".into());
        r.quality = Quality::Quality;
        let p = plan(&r, &env(vec![]), &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 42, &[], None, &esrgan_opts()).unwrap();
        let v = serde_json::to_value(&j.request).unwrap();
        assert_eq!((v["width"].as_u64(), v["height"].as_u64()), (Some(p.working.width as u64), Some(p.working.height as u64)));
        assert!(v.get("hires").map(|h| h.is_null()).unwrap_or(true), "no second pass");
        assert!(v.get("cache_mode").map(|c| c.is_null()).unwrap_or(true));
        assert_eq!(v["sample_params"]["sample_steps"], 8);
        assert_eq!(v["sample_params"]["custom_sigmas"].as_array().unwrap().len(), 9, "Turbo's schedule");
        assert_eq!(v["sample_params"]["guidance"]["txt_cfg"], 1.0, "official: no CFG");
        assert!(p.working.area() > 2_500_000, "Quality renders toward native 2K: {:?}", p.working);
    }

    #[test]
    fn large_edit_is_one_pass_then_enlarged() {
        let img = photo(3840, 2160);
        let mut r = req("make it a dark version");
        r.resolution = ResolutionMode::Source;
        let p = plan(&r, &env(vec![img.size()]), &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 3, std::slice::from_ref(&img), None, &esrgan_opts()).unwrap();
        assert!(j.request.hires.is_none());
        assert_eq!((j.request.width, j.request.height), (p.working.width, p.working.height));
        let rc = p.references[0].canvas.canvas;
        assert_eq!(decode(&j.request.ref_images[0]).dimensions(), (rc.width, rc.height), "reference as planned");
        assert!(rc.area() <= STANDARD_REFERENCE_AREA && p.working.area() > rc.area() * 2, "1 MP reference, larger canvas");
        assert_eq!(j.request.ref_image_args.as_deref(), Some("resize_before_vae=false"), "encoded at its planned size");
        // The single-pass result is enlarged to the 3840x2160 source size with ESRGAN.
        let content = crop_content(fake_backend(p.working.width, p.working.height), &j.post);
        let target = enlarge_target(&j.post).unwrap();
        assert_eq!(target, Size::new(3840, 2160));
        let ep = esrgan_plan(Size::new(content.width(), content.height()), target, 4).unwrap();
        assert!(!ep.tiles.is_empty(), "the larger canvas may take more than one upscale call");
        let out = finish(content, &j.post).unwrap();
        assert_eq!(out.dimensions(), (3840, 2160));
    }

    #[test]
    fn upscales_never_reach_img_gen() {
        let img = photo(1376, 768);
        let r = GenerationRequest { mode: Mode::Upscale, upscale: Some(UpscaleSpec { width: Some(5120), ..Default::default() }), ..Default::default() };
        let p = plan(&r, &env(vec![img.size()]), &RecommendedSettings::default()).unwrap();
        assert!(prepare(&p, "", 9, std::slice::from_ref(&img), None, &esrgan_opts()).is_err(), "the upscaler model only");
    }

    #[test]
    fn enlarge_targets_by_kind() {
        let img = photo(800, 600);
        let mut r = req("more beach");
        r.outpaint = Some(OutpaintSpec { left: 0.0, right: 50.0, top: 0.0, bottom: 0.0, units: ExpansionUnits::Percent });
        let p = plan(&r, &env(vec![img.size()]), &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), None, &esrgan_opts()).unwrap();
        assert_eq!(enlarge_target(&j.post), Some(Size::new(1200, 600)));
        let mut m = GrayImage::new(800, 600);
        m.put_pixel(400, 300, Luma([255]));
        let mut r = req("remove it");
        r.mask = Some("m".into());
        let i = PlanInputs { mask: Some((Size::new(800, 600), imaging::mask_bbox(&m, 127), 0.01)), ..env(vec![img.size()]) };
        let p = plan(&r, &i, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &esrgan_opts()).unwrap();
        assert_eq!(enlarge_target(&j.post), None, "inpaint keeps its own path");
    }

    #[test]
    fn esrgan_vs_lanczos_choice() {
        let c = Size::new(1376, 768);
        assert!(esrgan_plan(c, Size::new(1500, 837), 4).is_none(), "1.09x: Lanczos");
        assert!(esrgan_plan(c, Size::new(1376, 768), 4).is_none());
        assert!(esrgan_plan(c, Size::new(1000, 558), 4).is_none(), "shrinking: Lanczos");
        let ep = esrgan_plan(c, Size::new(5120, 2880), 4).unwrap();
        assert_eq!(ep.input, c);
        assert_eq!(ep.tiles, vec![Tile { rect: Rect::new(0, 0, 1376, 768), core: Rect::new(0, 0, 1376, 768) }]);
        assert!(esrgan_plan(c, Size::new(5120, 2880), 1).is_none(), "not an enlarging model");
    }

    #[test]
    fn large_inputs_are_tiled_and_capped() {
        let ep = esrgan_plan(Size::new(3000, 1700), Size::new(6000, 3400), 4).unwrap();
        assert_eq!(ep.input, Size::new(3000, 1700), "an 82 MP intermediate is under the cap");
        assert_eq!(ep.tiles.len(), 2);
        for t in &ep.tiles {
            assert!(t.rect.width <= 2048 && t.rect.height <= 2048);
        }
        // Cores tile the image exactly once.
        let mut hits = vec![0u8; 3000 * 1700];
        for t in &ep.tiles {
            assert!(t.core.x >= t.rect.x && t.core.right() <= t.rect.right() && t.core.y >= t.rect.y && t.core.bottom() <= t.rect.bottom());
            for y in t.core.y..t.core.bottom() {
                for x in t.core.x..t.core.right() {
                    hits[(y * 3000 + x) as usize] += 1;
                }
            }
        }
        assert!(hits.iter().all(|h| *h == 1));
        let ep = esrgan_plan(Size::new(4000, 3000), Size::new(8000, 6000), 4).unwrap();
        assert!(ep.input.area() * 16 <= ESRGAN_MAX_OUTPUT_AREA, "{:?}", ep.input);
        assert!(ep.input.width * 4 >= 8000 && ep.input.height * 4 >= 6000, "still covers the target");
        assert!(tile_grid(Size::new(5000, 300), 2048, 32).iter().all(|t| t.rect.width <= 2048));
    }

    #[test]
    fn stitched_tiles_match_a_whole_image_upscale() {
        // A nearest-neighbour "model" is exact per pixel, so any seam would show.
        let x4 = |img: &RgbaImage| image::imageops::resize(img, img.width() * 4, img.height() * 4, image::imageops::FilterType::Nearest);
        let src = photo(300, 170).pixels;
        let tiles = tile_grid(Size::new(300, 170), 128, 16);
        assert!(tiles.len() > 4);
        let mut st = Stitcher::new(Size::new(300, 170));
        for t in &tiles {
            let png = tile_png_b64(&src, t).unwrap();
            st.add(t, &x4(&decode(&png))).unwrap();
        }
        let out = st.finish(&src).unwrap();
        assert_eq!(out, x4(&src));
        let mut bad = Stitcher::new(Size::new(300, 170));
        assert!(bad.add(&tiles[0], &RgbaImage::new(7, 7)).is_err());
    }

    #[test]
    fn stitched_result_keeps_source_alpha() {
        let mut src = photo(64, 64).pixels;
        for y in 0..32 {
            for x in 0..64 {
                src.get_pixel_mut(x, y)[3] = 0;
            }
        }
        let t = tile_grid(Size::new(64, 64), 2048, 32)[0];
        let mut st = Stitcher::new(Size::new(64, 64));
        let mut up = image::imageops::resize(&src, 256, 256, image::imageops::FilterType::Nearest);
        for p in up.pixels_mut() {
            p[3] = 255; // ESRGAN output is RGB
        }
        st.add(&t, &up).unwrap();
        let out = st.finish(&src).unwrap();
        assert_eq!(out.get_pixel(10, 10)[3], 0);
        assert_eq!(out.get_pixel(10, 250)[3], 255);
    }

    fn photo(w: u32, h: u32) -> LoadedImage {
        let pixels = RgbaImage::from_fn(w, h, |x, y| Rgba([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]));
        LoadedImage { pixels, format: "png", exif_orientation: 1, icc_profile: None, has_transparency: false, text: vec![] }
    }
    fn req(p: &str) -> GenerationRequest {
        GenerationRequest { prompt: p.into(), preserve_dimensions: true, ..Default::default() }
    }
    fn decode(b: &str) -> RgbaImage {
        imaging::decode_image(&b64_decode(b).unwrap()).unwrap().pixels
    }
    fn fake_backend(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_pixel(w, h, Rgba([9, 99, 199, 255]))
    }

    #[test]
    fn edit_request_and_restore_1920x1080() {
        let img = photo(1920, 1080);
        let mut r = req("make it night");
        r.resolution = ResolutionMode::Source;
        r.advanced.reference_detail = Some(ReferenceDetail::Full);
        let p = plan(&r, &PlanInputs { image_sizes: vec![img.size()], vram_total_mib: Some(16303), ..Default::default() }, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 7, std::slice::from_ref(&img), None, &BackendOptions::default()).unwrap();
        assert_eq!((j.request.width, j.request.height), (1920, 1088));
        assert!(j.request.ref_image_args.is_none(), "Full keeps the server's resize");
        assert_eq!(j.request.ref_images.len(), 1);
        assert!(j.request.init_image.is_none() && j.request.mask_image.is_none());
        let sent = decode(&j.request.ref_images[0]);
        assert_eq!(sent.dimensions(), (1920, 1088));
        // Original content is intact inside the padded reference.
        assert_eq!(imaging::crop(&sent, Rect::new(0, 4, 1920, 1080)), img.pixels);
        let out = postprocess(fake_backend(1920, 1088), &j.post).unwrap();
        assert_eq!(out.dimensions(), (1920, 1080));
    }

    #[test]
    fn multi_reference_order_preserved_in_request() {
        let imgs = vec![photo(640, 960), photo(800, 800), photo(1200, 600)];
        let r = req("person from image 1, clothes from image 2, light from image 3");
        let p = plan(&r, &PlanInputs { image_sizes: imgs.iter().map(|i| i.size()).collect(), vram_total_mib: Some(16303), ..Default::default() }, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, &imgs, None, &BackendOptions::default()).unwrap();
        assert_eq!(j.request.ref_images.len(), 3);
        let dims: Vec<(u32, u32)> = j.request.ref_images.iter().map(|b| decode(b).dimensions()).collect();
        assert!(dims[0].1 > dims[0].0, "first is portrait");
        assert_eq!(dims[1].0, dims[1].1, "second is square");
        assert!(dims[2].0 > dims[2].1, "third is landscape");
        for (w, h) in dims {
            assert!(w % 32 == 0 && h % 32 == 0);
            assert!((w as u64 * h as u64) <= (j.request.width as u64 * j.request.height as u64));
        }
    }

    #[test]
    fn inpaint_preserves_unmasked_pixels_exactly() {
        let img = photo(900, 700);
        let mut m = GrayImage::new(900, 700);
        for y in 300..360 {
            for x in 400..480 {
                m.put_pixel(x, y, Luma([255]));
            }
        }
        let mut r = req("remove it");
        r.mask = Some("input:m".into());
        let inputs = PlanInputs {
            image_sizes: vec![img.size()],
            mask: Some((Size::new(900, 700), imaging::mask_bbox(&m, 127), imaging::mask_coverage(&m, 127))),
            vram_total_mib: Some(16303),
            ..Default::default()
        };
        let p = plan(&r, &inputs, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap();
        assert!(j.request.init_image.is_some() && j.request.mask_image.is_some());
        assert_eq!(j.request.strength, Some(1.0));
        let bm = imaging::decode_image(&b64_decode(j.request.mask_image.as_ref().unwrap()).unwrap()).unwrap().pixels;
        assert_eq!(bm.dimensions(), (j.request.width, j.request.height));
        assert!(bm.pixels().all(|p| p[0] == 0 || p[0] == 255), "backend mask is binary");
        let out = postprocess(fake_backend(p.working.width, p.working.height), &j.post).unwrap();
        assert_eq!(out.dimensions(), (900, 700));
        let PostKind::Inpaint { blend, region, .. } = &j.post.kind else { panic!() };
        let mut changed_inside = false;
        for (x, y, px) in out.enumerate_pixels() {
            let inside = x >= region.x && x < region.right() && y >= region.y && y < region.bottom();
            let b = if inside { blend.get_pixel(x - region.x, y - region.y)[0] } else { 0 };
            if b == 0 {
                assert_eq!(px, img.pixels.get_pixel(x, y), "pixel {x},{y} changed outside mask");
            } else if b == 255 {
                changed_inside |= px != img.pixels.get_pixel(x, y);
            }
        }
        assert!(changed_inside);
    }

    fn inpaint_job(prompt: &str, action: InpaintAction) -> (LoadedImage, GrayImage, PreparedJob) {
        // A white box, painted over.
        let mut img = photo(900, 700);
        let mut m = GrayImage::new(900, 700);
        for y in 300..360 {
            for x in 400..480 {
                m.put_pixel(x, y, Luma([255]));
                img.pixels.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let mut r = req(prompt);
        r.mask = Some("input:m".into());
        r.inpaint_action = action;
        let inputs = PlanInputs {
            image_sizes: vec![img.size()],
            mask: Some((Size::new(900, 700), imaging::mask_bbox(&m, 127), imaging::mask_coverage(&m, 127))),
            vram_total_mib: Some(16303),
            ..Default::default()
        };
        let p = plan(&r, &inputs, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap();
        (img, m, j)
    }

    #[test]
    fn inpaint_sends_region_and_marked_guide() {
        let (_, _, j) = inpaint_job("a red hat", InpaintAction::Add);
        assert_eq!(j.request.ref_images.len(), 2, "region + guide");
        let (r1, g) = (decode(&j.request.ref_images[0]), decode(&j.request.ref_images[1]));
        assert_eq!(r1.dimensions(), (j.request.width, j.request.height));
        assert_eq!(j.request.init_image.as_ref(), Some(&j.request.ref_images[0]));
        assert!(g.width() % 32 == 0 && g.height() % 32 == 0);
        assert!((g.width() as u64 * g.height() as u64) < (r1.width() as u64 * r1.height() as u64) / 2, "guide is small");
        // The guide carries the highlight color (named in the prompt) where the mask is.
        let marked = g.pixels().filter(|p| p[0] == 255 && p[1] == 0 && p[2] == 0).count();
        assert!(marked > 0);
        assert!(j.request.prompt.contains("<image1>") && j.request.prompt.contains("marked in red in <image2>"));
        assert!(j.request.prompt.contains("add a red hat inside"), "{}", j.request.prompt);
    }

    #[test]
    fn large_inpaints_give_the_model_a_1mp_image_1() {
        let mut img = photo(3000, 2000);
        let mut m = GrayImage::new(3000, 2000);
        for y in 800..1000 {
            for x in 1200..1500 {
                m.put_pixel(x, y, Luma([255]));
                img.pixels.put_pixel(x, y, Rgba([255, 255, 255, 255]));
            }
        }
        let job = |detail: ReferenceDetail| {
            let mut r = req("a red hat");
            r.mask = Some("input:m".into());
            r.quality = crate::planner::Quality::Quality;
            r.advanced.reference_detail = Some(detail);
            let inputs = PlanInputs {
                image_sizes: vec![img.size()],
                mask: Some((Size::new(3000, 2000), imaging::mask_bbox(&m, 127), imaging::mask_coverage(&m, 127))),
                vram_total_mib: Some(32607),
                ..Default::default()
            };
            let p = plan(&r, &inputs, &RecommendedSettings::default()).unwrap();
            (prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap(), p)
        };
        let area = |b64: &str| {
            let d = decode(b64);
            d.width() as u64 * d.height() as u64
        };
        let (std, p) = job(ReferenceDetail::Standard);
        let canvas = p.working.area();
        assert!(canvas > 2_000_000, "2K inpaint: {:?}", p.working);
        assert_eq!(area(std.request.init_image.as_ref().unwrap()), canvas, "the painted image keeps the working size");
        assert!(area(&std.request.ref_images[0]) <= STANDARD_REFERENCE_AREA, "image 1 capped at 1 MP");
        assert!(area(&std.request.ref_images[1]) <= canvas / 4 + canvas / 20, "guide a quarter of the canvas");
        assert_eq!(std.request.ref_image_args.as_deref(), Some("resize_before_vae=false"), "encoded at those sizes");
        assert_eq!(p.reference_detail, Some(ReferenceDetail::Standard));
        // Full: as before 0.9.4 (image 1 = the painted image, the server resizes the references).
        let (full, _) = job(ReferenceDetail::Full);
        assert_eq!(full.request.init_image.as_ref(), Some(&full.request.ref_images[0]));
        assert!(full.request.ref_image_args.is_none());
    }

    #[test]
    fn remove_blurs_content_out_of_image_1() {
        let center = |j: &PreparedJob| {
            let r1 = decode(&j.request.ref_images[0]);
            let PostKind::Inpaint { region, .. } = &j.post.kind else { panic!() };
            let s = r1.width() as f64 / region.width as f64;
            *r1.get_pixel(((440 - region.x) as f64 * s) as u32, ((330 - region.y) as f64 * s) as u32)
        };
        let (_, _, edit) = inpaint_job("make it shiny", InpaintAction::Edit);
        assert_eq!(center(&edit), Rgba([255, 255, 255, 255]), "edits show the content");
        // The "remove ..." prompt turns a plain edit into a removal.
        let (_, _, rm) = inpaint_job("Remove the box.", InpaintAction::Edit);
        assert!(rm.request.prompt.contains("blurred out to remove the box"), "{}", rm.request.prompt);
        assert!(center(&rm).0[..3].iter().any(|&c| c < 230), "box erased: {:?}", center(&rm));
        assert_eq!(rm.request.init_image.as_ref(), Some(&rm.request.ref_images[0]));
    }

    #[test]
    fn remove_needs_no_prompt() {
        let (_, _, j) = inpaint_job("", InpaintAction::Remove);
        assert!(j.request.prompt.contains("to remove everything that was there"));
    }

    #[test]
    fn inpaint_action_subjects() {
        assert_eq!(InpaintAction::Edit.resolve("please remove the girl"), InpaintAction::Remove);
        assert_eq!(InpaintAction::Edit.resolve("make it red"), InpaintAction::Edit);
        assert_eq!(InpaintAction::Add.resolve("remove it"), InpaintAction::Add);
        assert_eq!(InpaintAction::Remove.subject("Remove the girl."), "the girl");
        assert_eq!(InpaintAction::Replace.subject("replace it with a dog"), "a dog");
        assert_eq!(InpaintAction::Add.subject("Add a cat"), "a cat");
        assert_eq!(InpaintAction::Edit.subject("make it blue"), "make it blue");
    }

    #[test]
    fn outpaint_preserves_original_region() {
        let img = photo(800, 600);
        let mut r = req("more beach");
        r.outpaint = Some(OutpaintSpec { left: 0.0, right: 50.0, top: 0.0, bottom: 0.0, units: ExpansionUnits::Percent });
        let p = plan(&r, &PlanInputs { image_sizes: vec![img.size()], vram_total_mib: Some(16303), ..Default::default() }, &RecommendedSettings::default()).unwrap();
        assert_eq!(p.output, Size::new(1200, 600));
        let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), None, &BackendOptions::default()).unwrap();
        assert!(j.request.prompt.contains("more beach"));
        let mask = imaging::decode_image(&b64_decode(j.request.mask_image.as_ref().unwrap()).unwrap()).unwrap().pixels;
        let op = p.outpaint.unwrap();
        let r0 = op.source_rect_working;
        assert_eq!(mask.get_pixel(r0.x + 5, r0.y + 5)[0], 0, "original area kept");
        assert_eq!(mask.get_pixel(op.working.canvas.width - 2, 10)[0], 255, "new area generated");
        let out = postprocess(fake_backend(p.working.width, p.working.height), &j.post).unwrap();
        assert_eq!(out.dimensions(), (1200, 600));
        // Everything left of the feather band equals the source exactly.
        let PostKind::Outpaint { feather, .. } = j.post.kind else { panic!() };
        for y in 0..600 {
            for x in 0..(800 - feather) {
                assert_eq!(out.get_pixel(x, y), img.pixels.get_pixel(x, y));
            }
        }
        assert_eq!(out.get_pixel(1150, 300), &Rgba([9, 99, 199, 255]));
    }

    #[test]
    fn alpha_noise_is_flattened_unless_transparency_intended() {
        let r = req("a red fox");
        let p = plan(&r, &PlanInputs { vram_total_mib: Some(16303), ..Default::default() }, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 5, &[], None, &BackendOptions::default()).unwrap();
        let mut noisy = fake_backend(p.working.width, p.working.height);
        noisy.put_pixel(3, 3, Rgba([1, 2, 3, 250]));
        let out = postprocess(noisy.clone(), &j.post).unwrap();
        assert!(out.pixels().all(|p| p[3] == 255));
        let r = req("a red fox on a transparent background");
        let j = prepare(&p, &r.prompt, 5, &[], None, &BackendOptions::default()).unwrap();
        assert!(j.request.prompt.starts_with("This is an RGBA image with transparency. a red fox on a transparent background."));
        assert!(j.request.prompt.ends_with("the background is transparent."));
        let out = postprocess(noisy, &j.post).unwrap();
        assert_eq!(out.get_pixel(3, 3)[3], 250);
    }

    #[test]
    fn generate_request_has_no_images() {
        let r = req("a red fox");
        let p = plan(&r, &PlanInputs { vram_total_mib: Some(16303), ..Default::default() }, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 5, &[], None, &BackendOptions::default()).unwrap();
        let v = serde_json::to_value(&j.request).unwrap();
        assert!(v.get("ref_images").is_none() && v.get("init_image").is_none());
        assert_eq!(v["seed"], 5);
        assert_eq!(v["width"], 1024);
        let out = postprocess(fake_backend(1024, 1024), &j.post).unwrap();
        assert_eq!(out.dimensions(), (1024, 1024));
    }

    #[test]
    fn transparent_source_alpha_survives_inpaint() {
        let mut img = photo(400, 400);
        for y in 0..50 {
            for x in 0..50 {
                img.pixels.put_pixel(x, y, Rgba([0, 0, 0, 0]));
            }
        }
        img.has_transparency = true;
        let mut m = GrayImage::new(400, 400);
        for y in 200..260 {
            for x in 200..260 {
                m.put_pixel(x, y, Luma([255]));
            }
        }
        let mut r = req("add a star");
        r.mask = Some("m".into());
        let inputs = PlanInputs { image_sizes: vec![img.size()], mask: Some((Size::new(400, 400), imaging::mask_bbox(&m, 127), 0.02)), vram_total_mib: Some(16303), ..Default::default() };
        let p = plan(&r, &inputs, &RecommendedSettings::default()).unwrap();
        let j = prepare(&p, &r.prompt, 1, std::slice::from_ref(&img), Some(&m), &BackendOptions::default()).unwrap();
        let out = postprocess(fake_backend(p.working.width, p.working.height), &j.post).unwrap();
        assert_eq!(out.get_pixel(10, 10)[3], 0, "transparent corner untouched");
    }
}
