//! Example projects added on the first launch: real results made by Kokon (see
//! `marketing/showcase/PROMPTS.md`, resized by `scripts/make-examples.py`), stored as
//! ordinary generations so they open, compare and edit like the user's own work.

use std::path::Path;

use serde::Serialize;

use crate::engine::{APP_VERSION, Engine};
use crate::error::{AppError, AppResult};
use crate::geometry::Expansion;
use crate::imaging;
use crate::planner::{GenerationRequest, InpaintAction, Mode, OutpaintSpec, Quality};
use crate::store::{GenerationRecord, InputRecord, ReferenceRecord};

/// One version of an example: made from the previous step of its project (none for the first).
struct Step {
    name: &'static str,
    image: &'static [u8],
    mode: Mode,
    prompt: &'static str,
    seed: i64,
    quality: Quality,
    seconds: u64,
    inpaint: Option<(InpaintAction, &'static [u8])>,
    /// Outpaint: expansion in pixels of the previous step.
    expand: Option<Expansion>,
}

struct Project {
    title: &'static str,
    steps: &'static [Step],
}

macro_rules! asset {
    ($f:literal) => {
        include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/examples/", $f))
    };
}

const fn step(name: &'static str, image: &'static [u8], mode: Mode, prompt: &'static str, seed: i64, quality: Quality, seconds: u64) -> Step {
    Step { name, image, mode, prompt, seed, quality, seconds, inpaint: None, expand: None }
}

/// The first project is the one the tour walks through.
static PROJECTS: &[Project] = &[
    Project {
        title: "Italian street café",
        steps: &[
            step("street", asset!("street.jpg"), Mode::Generate, "Editorial photograph of a sunny cobblestone street in a small Italian coastal town, a pastel yellow café with outdoor wooden tables and potted lemon trees, a red vintage scooter parked in front of the café, warm late-morning light, 35mm, shallow depth of field, highly detailed, realistic", 1101, Quality::Quality, 46),
            Step { inpaint: Some((InpaintAction::Remove, asset!("street-mask.png"))), ..step("street-removed", asset!("street-removed.jpg"), Mode::Inpaint, "the red scooter", 7, Quality::Quality, 33) },
            Step { inpaint: Some((InpaintAction::Add, asset!("street-add-mask.png"))), ..step("street-cat", asset!("street-cat.jpg"), Mode::Inpaint, "a ginger cat sitting on the cobblestones, looking at the camera", 13, Quality::Quality, 31) },
        ],
    },
    Project {
        title: "Lake cabin, summer to winter",
        steps: &[
            step("cabin", asset!("cabin.jpg"), Mode::Generate, "Photograph of a small wooden cabin with a stone chimney on the shore of a calm alpine lake, pine forest and tall mountains behind, clear summer midday, crisp reflections on the water, wide angle, highly detailed, realistic landscape photography", 2202, Quality::Quality, 39),
            step("cabin-winter", asset!("cabin-winter.jpg"), Mode::Edit, "Make it a snowy winter night: snow on the roof, trees and shore, the lake partly frozen, warm golden light glowing from the cabin windows, stars in the sky. Keep the composition unchanged.", 3, Quality::Quality, 53),
        ],
    },
    Project {
        title: "Paris bakery sign",
        steps: &[
            step("bakery", asset!("bakery.jpg"), Mode::Generate, "Photograph of a charming bakery storefront in Paris, dark green painted wooden facade, large gold lettering sign above the window that reads \"BOULANGERIE\", window display full of croissants and baguettes, flower boxes, soft morning light, realistic, highly detailed", 3303, Quality::Quality, 39),
            step("bakery-text", asset!("bakery-text.jpg"), Mode::Edit, "Change the gold sign text to \"KOKON CAFÉ\" in the same gold lettering style. Keep everything else unchanged.", 5, Quality::Quality, 54),
        ],
    },
    Project {
        title: "Lighthouse, wider",
        steps: &[
            step("lighthouse", asset!("lighthouse.jpg"), Mode::Generate, "Photograph of a white and red lighthouse on a rocky cliff above a turquoise sea, golden sunset light, gentle waves, a few seagulls, realistic, highly detailed, coastal landscape photography", 6606, Quality::Balanced, 22),
            Step { expand: Some(Expansion { left: 355, right: 356, top: 0, bottom: 0 }), ..step("lighthouse-wide", asset!("lighthouse-wide.jpg"), Mode::Outpaint, "continue the rocky coastline and the turquoise sea at golden sunset", 9, Quality::Balanced, 55) },
        ],
    },
    Project {
        title: "Potter, as a watercolor",
        steps: &[
            step("potter", asset!("potter.jpg"), Mode::Generate, "Portrait photograph of a young ceramic artist in her sunlit studio, holding a freshly glazed blue bowl, shelves of handmade pottery behind her, linen apron, natural window light, warm and friendly expression, 85mm lens, realistic, highly detailed", 4404, Quality::Quality, 38),
            step("potter-watercolor", asset!("potter-watercolor.jpg"), Mode::Edit, "Turn it into a hand-painted watercolor illustration with soft ink outlines and visible paper texture. Keep the person, pose and composition the same.", 11, Quality::Quality, 55),
        ],
    },
];

/// An example project as the desktop app stores it: a title and its versions, oldest first.
#[derive(Debug, Clone, Serialize)]
pub struct ExampleProject {
    pub title: String,
    pub generations: Vec<String>,
}

impl Engine {
    /// Adds the example projects to the gallery (again, if they were deleted) and returns
    /// them. Ids are fixed, so calling this twice does not duplicate anything.
    pub fn install_examples(&self) -> AppResult<Vec<ExampleProject>> {
        let store = &self.store;
        let dir = store.examples_dir();
        std::fs::create_dir_all(&dir).map_err(|e| AppError::io("create the examples folder", &dir, e))?;
        let model = self.config().profile().model_name();
        let mut out = Vec::new();
        for (pi, project) in PROJECTS.iter().enumerate() {
            let mut prev: Option<GenerationRecord> = None;
            let mut ids = Vec::new();
            for (si, s) in project.steps.iter().enumerate() {
                let id = format!("example-{}", s.name);
                if let Ok(g) = store.get_generation(&id)
                    && Path::new(&g.file_path).is_file()
                {
                    ids.push(id);
                    prev = Some(g);
                    continue;
                }
                let file = dir.join(format!("{}.jpg", s.name));
                std::fs::write(&file, s.image).map_err(|e| AppError::io("store the example", &file, e))?;
                let img = imaging::decode_image(s.image)?.pixels;
                // The previous version as this one's reference, the way an edit records it.
                let reference: Option<InputRecord> = match &prev {
                    Some(p) => Some(store.put_input(&std::fs::read(&p.file_path).map_err(|e| AppError::io("read the example", Path::new(&p.file_path), e))?, Some(&format!("{}.jpg", p.id)), Some(&p.file_path))?),
                    None => None,
                };
                let mask = match s.inpaint {
                    Some((_, png)) => Some(store.put_input(png, Some("mask.png"), None)?),
                    None => None,
                };
                let request = GenerationRequest {
                    prompt: s.prompt.into(),
                    mode: s.mode,
                    images: prev.iter().map(|p| format!("gen:{}", p.id)).collect(),
                    mask: mask.as_ref().map(|m| format!("input:{}", m.id)),
                    inpaint_action: s.inpaint.map(|(a, _)| a).unwrap_or_default(),
                    outpaint: s.expand.map(|e| OutpaintSpec { left: e.left as f64, right: e.right as f64, top: e.top as f64, bottom: e.bottom as f64, ..Default::default() }),
                    quality: s.quality,
                    seed: Some(s.seed),
                    client: Some("example".into()),
                    parent_id: prev.as_ref().map(|p| p.id.clone()),
                    preserve_dimensions: true,
                    ..Default::default()
                };
                let mode = serde_json::to_value(s.mode).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
                let rec = GenerationRecord {
                    id: id.clone(),
                    // Older than anything the user makes, in project order.
                    created_at: format!("2026-10-10T09:{:02}:{:02}.000Z", pi * 5, si * 10),
                    mode,
                    prompt: s.prompt.into(),
                    original_prompt: None,
                    loras: vec![],
                    negative_prompt: String::new(),
                    seed: s.seed,
                    width: img.width(),
                    height: img.height(),
                    working_width: img.width(),
                    working_height: img.height(),
                    model: model.clone(),
                    sampler: "euler".into(),
                    scheduler: None,
                    steps: 8,
                    cfg: 1.0,
                    strength: None,
                    quality: serde_json::to_value(s.quality).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
                    resolution: "auto".into(),
                    references: reference
                        .iter()
                        .map(|r| ReferenceRecord { index: 0, input_id: r.id.clone(), original_path: r.original_path.clone(), width: r.width, height: r.height })
                        .collect(),
                    mask_input_id: mask.map(|m| m.id),
                    outpaint: s.expand,
                    file_path: file.to_string_lossy().into_owned(),
                    extra_paths: vec![],
                    favorite: false,
                    parent_id: prev.as_ref().map(|p| p.id.clone()),
                    duration_ms: s.seconds * 1000,
                    notes: vec!["Example made by Kokon, resized for the installer.".into()],
                    app_version: APP_VERSION.into(),
                    backend_version: None,
                    client: Some("example".into()),
                    request: serde_json::to_value(&request).unwrap_or_default(),
                    pipeline: None,
                };
                if let Ok(j) = imaging::encode_jpeg(&imaging::thumbnail(&img, 512), 85) {
                    let _ = std::fs::write(store.thumb_path(&id), j);
                }
                store.insert_generation(&rec)?;
                ids.push(id);
                prev = Some(rec);
            }
            out.push(ExampleProject { title: project.title.into(), generations: ids });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn example_assets_match_their_chains() {
        for p in PROJECTS {
            let mut prev: Option<(u32, u32)> = None;
            for s in p.steps {
                let im = imaging::decode_image(s.image).unwrap().pixels;
                let size = (im.width(), im.height());
                if let Some((_, mask)) = s.inpaint {
                    let m = imaging::decode_image(mask).unwrap().pixels;
                    assert_eq!((m.width(), m.height()), prev.unwrap(), "{}: mask fits the image it was painted on", s.name);
                }
                if let Some(e) = s.expand {
                    let (w, h) = prev.unwrap();
                    assert_eq!(size, (w + e.left + e.right, h + e.top + e.bottom), "{}: expansion adds up", s.name);
                }
                if matches!(s.mode, Mode::Edit | Mode::Inpaint) {
                    assert_eq!(Some(size), prev, "{}: edits keep the size", s.name);
                }
                prev = Some(size);
            }
        }
    }
}
