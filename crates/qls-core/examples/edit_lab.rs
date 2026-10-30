//! Exports the exact sd-server request Kokon sends for a brushed edit, an Expand or a plain edit,
//! and runs Kokon's own post-processing on a raw result. Used by `scripts/dev/inpaint-explore.py`.
//!
//! `cargo run -p qls-core --example edit_lab -- prepare <dir> <quality> <image> inpaint <mask> <action> <prompt>`
//! `cargo run -p qls-core --example edit_lab -- prepare <dir> <quality> <image> outpaint <l> <r> <t> <b> <prompt>`
//! `cargo run -p qls-core --example edit_lab -- prepare <dir> <quality> <image> edit <prompt>`
//! `cargo run -p qls-core --example edit_lab -- finish <dir> <raw.png> <out.png> [nomatch]`
//!
//! `prepare` writes request.json (the img_gen body), meta.json (plan geometry), args.json, and for
//! an inpaint blend.png (the soft paste-back mask at source resolution, inside the region).
//! `finish` re-plans from args.json (planning is deterministic) and applies `pipeline::postprocess`
//! (Lanczos only: the app may enlarge an Expand with ESRGAN in between).

use qls_core::geometry::{ExpansionUnits, Size};
use qls_core::planner::{GenerationRequest, InpaintAction, Mode, OutpaintSpec, Quality, plan};
use qls_core::{config::AppConfig, engine, imaging, pipeline};
use serde_json::{Value, json};
use std::path::Path;

fn job(args: &[String]) -> (pipeline::PreparedJob, qls_core::planner::Plan) {
    let quality: Quality = serde_json::from_value(json!(args[0])).unwrap();
    let img = imaging::load_image(args[1].as_ref()).unwrap();
    let mut req = GenerationRequest { quality, preserve_dimensions: true, ..Default::default() };
    let mut mask = None;
    match args[2].as_str() {
        "inpaint" => {
            let m = imaging::mask_from_image(&imaging::load_image(args[3].as_ref()).unwrap());
            req.mode = Mode::Inpaint;
            req.mask = Some("m".into());
            req.inpaint_action = serde_json::from_value::<InpaintAction>(json!(args[4])).unwrap();
            req.prompt = args[5].clone();
            mask = Some(m);
        }
        "outpaint" => {
            let n = |i: usize| args[i].parse::<f64>().unwrap();
            req.mode = Mode::Outpaint;
            req.outpaint = Some(OutpaintSpec { left: n(3), right: n(4), top: n(5), bottom: n(6), units: ExpansionUnits::Pixels });
            req.prompt = args[7].clone();
        }
        "edit" => {
            req.mode = Mode::Edit;
            req.prompt = args[3].clone();
        }
        m => panic!("unknown mode {m}"),
    }
    let cfg = AppConfig::default();
    let info = mask.as_ref().map(|m| (Size::new(m.width(), m.height()), imaging::mask_bbox(m, 16), imaging::mask_coverage(m, 16)));
    let p = plan(&req, &engine::plan_inputs(&cfg, vec![img.size()], info, Some(16303)), &cfg.profile().recommended_settings).unwrap();
    let j = pipeline::prepare(&p, &req.prompt, 1, std::slice::from_ref(&img), mask.as_ref(), &Default::default()).unwrap();
    (j, p)
}

fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let dir = Path::new(&a[1]);
    match a[0].as_str() {
        "prepare" => {
            std::fs::create_dir_all(dir).unwrap();
            let args = &a[2..];
            let (j, p) = job(args);
            std::fs::write(dir.join("args.json"), serde_json::to_string(args).unwrap()).unwrap();
            std::fs::write(dir.join("request.json"), serde_json::to_string(&j.request).unwrap()).unwrap();
            let mut meta = json!({ "working": p.working, "content": p.content, "output": p.output, "inpaint_region": p.inpaint_region, "outpaint": p.outpaint, "notes": p.notes });
            if let pipeline::PostKind::Inpaint { blend, .. } = &j.post.kind {
                blend.save(dir.join("blend.png")).unwrap();
            }
            if let pipeline::PostKind::Outpaint { feather, .. } = &j.post.kind {
                meta["feather"] = Value::from(*feather);
            }
            std::fs::write(dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap()).unwrap();
        }
        "finish" => {
            let args: Vec<String> = serde_json::from_str(&std::fs::read_to_string(dir.join("args.json")).unwrap()).unwrap();
            let (mut j, _) = job(&args);
            // `nomatch`: the paste-back without the colour match (the earlier behaviour, for A/B).
            if a.get(4).map(String::as_str) == Some("nomatch") {
                match &mut j.post.kind {
                    pipeline::PostKind::Inpaint { regen, .. } => *regen = None,
                    pipeline::PostKind::Outpaint { match_colors, .. } => *match_colors = false,
                    pipeline::PostKind::Plain => {}
                }
            }
            let raw = image::open(&a[2]).unwrap().to_rgba8();
            pipeline::postprocess(raw, &j.post).unwrap().save(&a[3]).unwrap();
        }
        c => panic!("unknown command {c}"),
    }
}
