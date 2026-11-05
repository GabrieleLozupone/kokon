//! Prompt enhancer: the Qwen3-VL 8B that Qwen-Image 2.1 already loads as its text encoder
//! rewrites the user's short instruction into a full English prompt (looking at the input
//! images for edits) before the image is generated. Runs on Kokon's engine builds only
//! (`Capabilities::text_generation`, `POST /sdcpp/v1/text_gen`); the server has no built-in
//! system prompt, so Kokon always sends one: the user's from Settings or the defaults below.
//! Design and the A/B behind these texts: docs/engineering-notes.md, "Prompt+".

use crate::config::AppConfig;
use crate::planner::{InpaintAction, ResolvedMode};
use crate::sdcpp::{TextGenRequest, TextSampling};

/// Built-in system prompt for text-to-image (engineering notes, "Prompt+"; decided 2026-10-18, revised
/// 2026-10-20). No example colours or objects: the model copies them into every prompt.
pub const T2I_SYSTEM_PROMPT: &str = r#"You write prompts for an image generation model. Expand the user's request into one detailed English paragraph that describes the finished image: subject, setting, composition, lighting and style.
- Keep everything the user specified about the image (objects, counts, colours, positions, style) and never contradict it. If the request is already detailed, keep all of it and only add what is missing. Leave out size and quality words (4K, HD, 16:9, resolution): the app sets the size.
- Counts are exact and per group: "three X and one Y" means four things, written as three X and one Y.
- Translate the meaning, not word by word. A "red" cat in Italian, French or Spanish is a ginger cat.
- Name the medium and style near the start. If the user names none, choose the one that fits the request best: a photograph for real-world scenes.
- Always describe the light: its source, direction and quality.
- Be concrete: specific colours that suit this scene, materials, where things are in the frame. Never write vague words like "various items".
- People: only what is visible (life stage, expression, pose, hair, clothing). No brand names unless the user gave them.
- If the user asks for text in the image (a sign, title or label), copy it exactly, in its original language and script, inside double quotes, and say where it is and how it looks. Otherwise write nothing about text.
- Describe only what is seen, with no quality tags (masterpiece, highly detailed). When the user says what the image is for, keep what that means for the look and write it as visible choices (how dark, how much empty space, how bold), not as the name of the device or use.
- Write in English whatever language the user writes in, about 80 to 150 words, in the present tense, as a description of the image, not as instructions. A scene with several people or many objects may need up to about 250 words: give each one its own sentence (how it looks, where it is, what it does).
Output only the prompt."#;

/// Built-in system prompt for image-grounded edits and combines.
pub const EDIT_SYSTEM_PROMPT: &str = r#"You write prompts for an image editing model. You see the input image and the user's instruction. Rewrite the instruction as one precise English editing instruction.
- Start with the operation (Change, Replace, Remove, Add, Turn, Place, ...) and say exactly what changes, where it is in the image and what it becomes. Make the change complete and clearly visible, not faint.
- Describe in detail only what changes. For everything else end with one sentence such as "Keep everything else in the image unchanged." Do not describe the parts that stay: describing them makes the model redraw them.
- People keep their face and identity, and the image keeps its medium (photo, painting, illustration), unless the user asks to change them.
- Base every detail on what is visible in the image and do not invent objects. Do only what the user asked: no extra fixes or additions.
- When something is removed or moved, its shadow and reflection go with it; say briefly what fills the empty area so the result looks natural.
- Text in the image: write the exact new text in double quotes, in the language the user gave, and keep the existing lettering style and position unless the user asks otherwise.
- Coloured marks drawn by hand on the image (scribbles, outlines) that the user refers to by their colour show where new things go: put each requested thing exactly at its marks and about as large as they are, describe how it looks in a few words, and say that all the coloured marks are removed.
- For a style or mood change (painting, season, night, ...), apply it fully to the whole image and end with "Keep the composition and the subjects unchanged." instead.
- With several input images, refer to them as <image1>, <image2>, ...: start with Place or Combine, say what is taken from each image and where it goes in the result.
- Write in English whatever language the user writes in, as one paragraph with no resolution or aspect ratio: about 20 to 60 words for one change; when the user asks for several changes, one sentence for each, up to about 150 words.
Output only the instruction."#;

/// Built-in system prompt for a new image made with reference images (people, products, a
/// place, a style), step 2 of 2: written from the request and one label per reference
/// ([`COMPOSE_LABEL_PROMPT`]), without the images. Shown the images, the 8B described the
/// references (their places, poses, what people held) instead of the requested scene, with any
/// system prompt (2026-10-22, bench sysprompt-v3-compose: "her on the sofa with the cat" came
/// back as the forest and the windowsill of the references); from labels it follows the request.
/// The image model still gets the references themselves, so identities come from them.
pub const COMPOSE_SYSTEM_PROMPT: &str = r#"You write prompts for an image generation model. The model also receives the user's reference images, numbered <image1>, <image2>, ...; you do not see them, only a short label for each. Turn the user's request into one English paragraph describing the finished new image.
- Start with what the image shows, in one sentence that contains everything the user asked for (the objects, the scene, the action, the kind of image).
- Refer to each reference the request uses as "the X from <imageN>", with X taken from its label, and describe it with the label's details so it stays recognizable. A person, animal or object appears as it is, in the new scene, doing what the user asks. A label that starts with "style" is a style for the whole image, not a thing to show.
- If the user asks for something new (a new product, a collaboration, a mix, a redesign), the new thing is the main subject: invent one concrete, surprising idea and describe its form and materials and which colours, logos, lettering and shapes it takes from each reference's label. When it joins several brands, every brand's logo and name is clearly visible on it.
- Then describe the setting and background with their colours and materials, where each subject is and how large, the camera view, and the light (source, direction, quality), with real shadows and reflections.
- Add nothing the user did not ask for. Keep everything the user specified and never contradict it; counts are exact. Write new text in the image only if the user gives it or asks for a name, title or slogan, copied exactly inside double quotes; never turn the words of the request into signs.
- Name the medium early: the user's, a style label's, else a photograph. Translate the meaning, not word by word. Present tense, only visible things, no quality tags, no resolution or aspect ratio.
- Write in English whatever language the user writes in: about 80 to 180 words, up to about 280 when the scene has several people or many objects, with a sentence for each.
Output only the prompt."#;

/// Built-in system prompt for video generation (text-to-video and image-to-video).
pub const VIDEO_SYSTEM_PROMPT: &str = r#"You write prompts for a video generation model. Expand the user's request into one vivid, cinematic English paragraph describing the continuous motion, subject action, environment, and camera movement.
- Specify clear, fluid, physical motion: how the subject moves, speeds up, pauses, or interacts with the surroundings.
- Describe camera movement precisely (e.g. static camera, gentle slow push in, smooth tracking shot, subtle panning).
- Mention lighting and atmosphere: direction of light, reflections, atmospheric depth, shadows in motion.
- Keep the description focused on a single coherent shot or sequence without jump cuts or abrupt scene transitions.
- If an input image is provided, maintain the subject's identity, clothes, setting, and style faithfully, focusing on how the scene comes alive with motion.
- Avoid vague quality buzzwords (photorealistic, 4K, 8K, high quality). Describe concrete visual elements instead.
- Write in English whatever language the user writes in, in present tense, around 60 to 120 words.
Output only the prompt."#;

/// Step 1 of a composition: each reference seen alone, with the user's request, and labelled by
/// what the request takes from it (a list of features, which the 8B keeps free of the photo's
/// context better than a sentence). With the request it labels the bowl a person holds, or a
/// photo's style, rather than the photo's main subject (A/B 2026-10-22: both lost without it).
pub const COMPOSE_LABEL_PROMPT: &str = r#"You label one reference image for a new picture the user asked for. Decide what the user's request takes from this image: a person, an animal, an object or product (also a small one inside the photo), a place, or only its style. Reply with a comma-separated list of that thing's own visible features, at most 25 words. Nothing else.
Fill in the pattern for its kind, replacing each <...> with what you see and leaving out any part you cannot see:
- person, <apparent gender and age>, <hair colour, length and style>, <skin tone>, <each clothing item with its colour>
- <animal kind>, <breed if clear>, <colours>, <fur>
- <object kind>, <brand>, <shape>, <colours>, <material>, <main printed words in quotes>
- <kind of place>, <main features>
- style, <medium>, <colour palette>, <kind of light>, <texture>
Describe the thing alone: never its action, pose, who holds it, what it rests on, its surroundings or background (except as the place or style when that is what the request takes)."#;

/// Built-in system prompt for a painted area (a brushed edit without coloured marks), added
/// 2026-11-04. The enhancer sees the untouched region with the area outlined (the image model's own
/// copy is blurred there for Remove and Replace) and writes the whole instruction for the action;
/// for Remove also what is seen in the object's place (only its name made Qwen paint it again).
/// Sent as it is in pipeline::written_inpaint_prompt.
pub const AREA_SYSTEM_PROMPT: &str = r#"You write the instruction for an image editing model that changes one area of a picture. You see the picture with that area outlined by a bright line; what is inside the line is shown as it is. The model will get the picture with that area blurred out and must redraw it from your words alone. The user's message gives the line's colour, the action, the words your text must start with, and the user's own words, in any language, or none.
- Start with exactly the given words and write in English, 20 to 60 words in all.
- Remove: name everything inside the line as one thing (the main object with whatever is on it or in it), then, in a second sentence, describe what is seen there instead: the background that continues from just outside the line, with its surface, material, colours, texture or pattern and light, as if the thing had never been there, with no shadow or mark of it left.
- Change: say what inside the line changes and what it becomes, and that the rest of it stays as it is.
- Replace: name what is inside the line and what replaces it, then describe the new thing: what it is, its colours and materials, its size fitting the area and the scene's perspective, light matching the scene and its shadow on the surface under it.
- Add: describe the new thing put inside the line: what it is, its colours and materials, where it stands, its size fitting the scene's perspective, light matching the scene and its shadow.
- Keep everything the user asked for and never contradict it; base every detail on what you see. With no words from the user, choose what fits the scene best.
- Never describe anything outside the line except as what continues into it. Never mention the line, its colour, a mask, a blur or an area.
Output only the instruction."#;

/// Built-in system prompt for Expand (outpaint), added 2026-11-04: the enhancer sees the canvas
/// with the new borders still empty and writes what they show; the outpaint instruction
/// (pipeline::effective_prompt) goes in front of it, as for typed words.
pub const EXPAND_SYSTEM_PROMPT: &str = r#"You help an image model extend a picture beyond its borders. You see the picture on a larger canvas whose new border areas are still empty and flat. The user's message says which sides grow and gives the user's own wishes, in any language, or none.
- Write one English paragraph of 30 to 90 words describing what the new areas show so that the whole picture continues naturally past each growing side: what continues there and how it ends at the new edge.
- Keep the same medium, style, light, colours and perspective as the picture. Keep everything the user asked for and put it in the new areas.
- Describe only what the new areas add. Never add new people, animals or main subjects unless the user asks.
- Never mention borders, empty areas, a canvas or extending.
Output only the description."#;

/// The area and Expand texts are short (at most ~90 words).
pub const AREA_MAX_TOKENS: u32 = 256;

/// Prompt+ "Detailed" (2026-11-04, Gabriele: "give more context to the generator"): added after
/// any system prompt, built-in or the user's, it replaces the length asked there. More context
/// only about what is in the picture or what changes, never what is absent or untouched (a list of
/// what stays makes Qwen redraw it; a "no X" puts X in). Not A/B-tested yet.
pub const DETAIL_SCENE: &str = "\n\nDetailed mode: this replaces the length given above. Write 200 to 350 words, up to about 450 when there are several people or many objects. Give the image generator more context about everything that is in the picture: each subject's materials, textures, small details and expression, the setting and the objects in the background, the camera (distance, angle, lens, depth of field), the light and how it falls on each surface, and the colours. Describe only what is there; never write what is absent or what to avoid.";
pub const DETAIL_EDIT: &str = "\n\nDetailed mode: this replaces the length given above. Write 60 to 150 words, up to about 250 for several changes. Give the image editor more context about the change only: the new things' materials, textures and colours, their exact place and size, how the light of the scene falls on them, their shadows and reflections, and how they meet what is around them. Never describe the parts that stay, and never write what must not be added.";
pub const DETAIL_AREA: &str = "\n\nDetailed mode: this replaces the length given above. Write 50 to 120 words, with more context about what is seen inside the line after the edit: materials, textures, colours, light, shadows and how it meets what is around it. Never write what must not be added.";
pub const DETAIL_EXPAND: &str = "\n\nDetailed mode: this replaces the length given above. Write 80 to 180 words, with more context about what the new areas show: materials, textures, colours, the light and how far things are. Never write what is absent.";

/// The longest a Detailed text runs (~450 words; ~1.4 tokens a word).
const DETAIL_MAX_TOKENS: u32 = 1024;

/// A Prompt+ request made "Detailed": its system prompt ends with the length and context of the
/// kind it is (a new image, an edit, a painted area, an expansion), and longer texts are allowed.
pub fn detailed(mut req: TextGenRequest, mode: ResolvedMode) -> TextGenRequest {
    let add = if req.system_prompt == AREA_SYSTEM_PROMPT {
        DETAIL_AREA
    } else if req.system_prompt == EXPAND_SYSTEM_PROMPT {
        DETAIL_EXPAND
    } else if matches!(mode, ResolvedMode::Generate | ResolvedMode::Compose) {
        DETAIL_SCENE
    } else {
        DETAIL_EDIT
    };
    req.system_prompt.push_str(add);
    req.max_tokens = req.max_tokens.max(DETAIL_MAX_TOKENS);
    req
}

/// Longest label kept (a model that rambles is cut, the label is only a hint).
pub const LABEL_MAX_TOKENS: u32 = 96;

/// Longest custom system prompt accepted in Settings (characters).
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 20_000;

/// The built-in prompts ask for up to ~300 words for crowded scenes (~400 tokens); the cap only
/// stops a model that does not end its turn. 512 cut long scene descriptions mid-sentence
/// (2026-10-22); 1024 tokens take ~8 s at the measured ~127 tok/s.
pub const MAX_TOKENS: u32 = 1024;

/// Qwen's recommended sampling for Qwen3-VL (vision-language), used for both prompts.
pub const SAMPLING: TextSampling = TextSampling { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, seed: -1 };

/// Text-to-image, new images from references, edits, combines and video get the enhancer. Inpaint
/// and outpaint wrap the prompt in their own instructions, and upscales have no prompt.
pub fn applies(mode: ResolvedMode) -> bool {
    matches!(mode, ResolvedMode::Generate | ResolvedMode::Compose | ResolvedMode::Edit | ResolvedMode::MultiReference | ResolvedMode::Video)
}

/// [`applies`], and inpaints and expansions: coloured marks written as an edit of the marked
/// region (the edit prompt knows marks named by colour), a painted area and an expansion with
/// their own prompts ([`area_request`], [`expand_request`]) inside Kokon's instructions.
pub fn applies_to(mode: ResolvedMode, _marks: bool) -> bool {
    applies(mode) || matches!(mode, ResolvedMode::Inpaint | ResolvedMode::Outpaint)
}

/// What the user's words were, for the area and Expand prompts.
fn words(prompt: &str) -> String {
    let p = prompt.trim();
    if p.is_empty() { "(none)".into() } else { p.to_string() }
}

/// A painted area (no marks): `image` is the untouched region with the area outlined in `color`.
pub fn area_request(action: InpaintAction, color: &str, prompt: &str, image: String, seed: i64) -> TextGenRequest {
    let (act, start) = match action {
        InpaintAction::Remove => ("remove", "Remove"),
        InpaintAction::Edit => ("change", "Change"),
        InpaintAction::Replace => ("replace", "Replace"),
        InpaintAction::Add => ("add", "Add"),
    };
    // The app puts the action's words in front of what the user types: only the rest is theirs.
    let typed = if action == InpaintAction::Edit { prompt.trim().strip_prefix("Change").map(str::trim).unwrap_or(prompt.trim()).to_string() } else { action.subject(prompt) };
    TextGenRequest {
        prompt: format!("Line colour: {color}\nAction: {act}\nStart with: {start}\nThe user's words: {}", words(&typed)),
        system_prompt: AREA_SYSTEM_PROMPT.into(),
        images: vec![image],
        max_tokens: AREA_MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// An expansion: `image` is the canvas with the new areas empty; `sides` names them ("left and top").
pub fn expand_request(sides: &str, prompt: &str, image: String, seed: i64) -> TextGenRequest {
    TextGenRequest {
        prompt: format!("Growing sides: {sides}\nThe user's wishes: {}", words(prompt)),
        system_prompt: EXPAND_SYSTEM_PROMPT.into(),
        images: vec![image],
        max_tokens: AREA_MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// The system prompt for `mode`: the one saved in Settings, or the built-in one.
pub fn system_prompt(cfg: &AppConfig, mode: ResolvedMode) -> String {
    let (custom, default) = match mode {
        ResolvedMode::Generate => (&cfg.enhancer_t2i_prompt, T2I_SYSTEM_PROMPT),
        ResolvedMode::Compose => (&cfg.enhancer_compose_prompt, COMPOSE_SYSTEM_PROMPT),
        ResolvedMode::Video => (&cfg.enhancer_video_prompt, VIDEO_SYSTEM_PROMPT),
        _ => (&cfg.enhancer_edit_prompt, EDIT_SYSTEM_PROMPT),
    };
    if custom.trim().is_empty() { default.to_string() } else { custom.trim().to_string() }
}

/// The `text_gen` request for a job: its seed (so the same seed writes the same prompt, and
/// Regenerate writes a new one) and, for edits and compositions, the references as the image
/// model gets them.
pub fn request(cfg: &AppConfig, mode: ResolvedMode, prompt: &str, images: Vec<String>, seed: i64) -> TextGenRequest {
    TextGenRequest {
        prompt: prompt.trim().to_string(),
        system_prompt: system_prompt(cfg, mode),
        images: if mode == ResolvedMode::Generate { Vec::new() } else { images },
        max_tokens: MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// Step 1 of a composition: the label request for one reference (as the image model gets it),
/// with the user's request.
pub fn label_request(image: String, request: &str, seed: i64) -> TextGenRequest {
    TextGenRequest {
        prompt: format!("The user's request for the new picture: {}\nLabel what it takes from this image.", request.trim()),
        system_prompt: COMPOSE_LABEL_PROMPT.into(),
        images: vec![image],
        max_tokens: LABEL_MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// A label as the model wrote it, on one line and without a closing full stop.
pub fn clean_label(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    one_line.trim().trim_end_matches('.').trim().chars().take(400).collect()
}

/// Step 2 of a composition: the request with the references' labels, without the images.
pub fn compose_request(cfg: &AppConfig, labels: &[String], prompt: &str, seed: i64) -> TextGenRequest {
    let refs: Vec<String> = labels.iter().enumerate().map(|(i, l)| format!("<image{}>: {l}", i + 1)).collect();
    TextGenRequest {
        prompt: format!("References:\n{}\n\nRequest: {}", refs.join("\n"), prompt.trim()),
        system_prompt: system_prompt(cfg, ResolvedMode::Compose),
        images: Vec::new(),
        max_tokens: MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

/// The model's answer as a prompt: trimmed, without a "Prompt:" label or quotes around the
/// whole text. None when nothing usable is left.
pub fn clean(text: &str) -> Option<String> {
    let mut t = text.trim();
    for label in ["Prompt:", "Instruction:", "Editing instruction:", "Description:"] {
        if t.get(..label.len()).is_some_and(|head| head.eq_ignore_ascii_case(label)) {
            t = t[label.len()..].trim_start();
        }
    }
    // Quotes around everything, but not quoted text inside (text to render in the image).
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') && !t[1..t.len() - 1].contains('"') {
        t = t[1..t.len() - 1].trim();
    }
    (!t.is_empty()).then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_and_prompts() {
        assert!(applies(ResolvedMode::Generate) && applies(ResolvedMode::Edit) && applies(ResolvedMode::MultiReference) && applies(ResolvedMode::Compose));
        assert!(!applies(ResolvedMode::Inpaint) && !applies(ResolvedMode::Outpaint) && !applies(ResolvedMode::Upscale));
        // A painted area and Expand have prompts of their own; an upscale has no prompt.
        assert!(applies_to(ResolvedMode::Inpaint, false) && applies_to(ResolvedMode::Outpaint, false) && !applies_to(ResolvedMode::Upscale, false));
        let mut cfg = AppConfig::default();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), T2I_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), EDIT_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::MultiReference), EDIT_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::Compose), COMPOSE_SYSTEM_PROMPT);
        cfg.enhancer_edit_prompt = "  Jewelry retouch rules.\n".into();
        cfg.enhancer_t2i_prompt = " \n ".into();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), "Jewelry retouch rules.");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), T2I_SYSTEM_PROMPT, "blank = built-in");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Compose), COMPOSE_SYSTEM_PROMPT, "an edit prompt does not change compose");
        cfg.enhancer_compose_prompt = "Product shots only.".into();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Compose), "Product shots only.");
        assert!(T2I_SYSTEM_PROMPT.ends_with("Output only the prompt.") && EDIT_SYSTEM_PROMPT.contains("<image1>, <image2>"));
    }

    #[test]
    fn builtin_prompts_have_nothing_the_model_copies() {
        // Seen in real outputs (bench sysprompt-v2-20261019-155557): example colours ended up in
        // almost every prompt, and the text rule became "No text appears in the image."
        for p in [T2I_SYSTEM_PROMPT, EDIT_SYSTEM_PROMPT, COMPOSE_SYSTEM_PROMPT, COMPOSE_LABEL_PROMPT, AREA_SYSTEM_PROMPT, EXPAND_SYSTEM_PROMPT] {
            for leak in ["deep navy", "pale cream", "copper", "No text"] {
                assert!(!p.contains(leak), "{leak:?} in a built-in prompt");
            }
        }
        assert!(T2I_SYSTEM_PROMPT.contains("Otherwise write nothing about text."));
        // The layers lab's New objects: the user names marks by colour; Prompt+ places things there.
        assert!(EDIT_SYSTEM_PROMPT.contains("Coloured marks drawn by hand"));
    }

    #[test]
    fn request_uses_job_seed_and_images_only_for_edits() {
        let cfg = AppConfig::default();
        let r = request(&cfg, ResolvedMode::Edit, " rendi la macchina nera ", vec!["PNG".into()], 1234);
        assert_eq!((r.prompt.as_str(), r.images.len(), r.sampling.seed, r.max_tokens), ("rendi la macchina nera", 1, 1234, MAX_TOKENS));
        assert_eq!((r.sampling.temperature, r.sampling.top_p, r.sampling.top_k, r.sampling.presence_penalty), (0.7, 0.8, 20, 1.5));
        assert!(r.stream);
        let r = request(&cfg, ResolvedMode::Generate, "un gatto", vec!["PNG".into()], 1);
        assert!(r.images.is_empty() && r.system_prompt == T2I_SYSTEM_PROMPT);
        // Compose: each reference labelled alone, then the scene from the labels, without images.
        let l = label_request("A".into(), " la ciotola su un tavolo ", 5);
        assert_eq!((l.images.len(), l.system_prompt.as_str(), l.sampling.seed, l.max_tokens), (1, COMPOSE_LABEL_PROMPT, 5, LABEL_MAX_TOKENS));
        assert!(l.prompt.contains("la ciotola su un tavolo\n"), "the label knows what the request takes");
        let labels = vec!["person, female, dark hair; style: photo".to_string(), "cat, orange tabby; style: photo".to_string()];
        let r = compose_request(&cfg, &labels, " lei sul divano con il gatto ", 5);
        assert!(r.images.is_empty() && r.system_prompt == COMPOSE_SYSTEM_PROMPT && r.sampling.seed == 5);
        assert_eq!(r.prompt, "References:\n<image1>: person, female, dark hair; style: photo\n<image2>: cat, orange tabby; style: photo\n\nRequest: lei sul divano con il gatto");
        assert_eq!(clean_label(" cat,\n orange tabby.\n"), "cat, orange tabby");
    }

    #[test]
    fn detailed_asks_for_more_context_of_its_kind() {
        let cfg = AppConfig::default();
        let t = detailed(request(&cfg, ResolvedMode::Generate, "un gatto", vec![], 1), ResolvedMode::Generate);
        assert!(t.system_prompt.starts_with(T2I_SYSTEM_PROMPT) && t.system_prompt.ends_with(DETAIL_SCENE));
        let e = detailed(request(&cfg, ResolvedMode::Edit, "x", vec!["P".into()], 1), ResolvedMode::Edit);
        assert!(e.system_prompt.ends_with(DETAIL_EDIT));
        let a = detailed(area_request(InpaintAction::Remove, "cyan", "", "P".into(), 1), ResolvedMode::Inpaint);
        assert!(a.system_prompt.ends_with(DETAIL_AREA) && a.max_tokens == DETAIL_MAX_TOKENS);
        let x = detailed(expand_request("left", "", "P".into(), 1), ResolvedMode::Outpaint);
        assert!(x.system_prompt.ends_with(DETAIL_EXPAND));
        // Only what is there: no "keep" lists, no "no X".
        for d in [DETAIL_SCENE, DETAIL_EDIT, DETAIL_AREA, DETAIL_EXPAND] {
            assert!(d.contains("replaces the length") && !d.contains("unchanged"));
        }
        assert!(450.0 * 1.4 < DETAIL_MAX_TOKENS as f64);
    }

    #[test]
    fn area_and_expand_requests() {
        let r = area_request(InpaintAction::Remove, "magenta", "  ", "PNG".into(), 7);
        assert_eq!(r.prompt, "Line colour: magenta\nAction: remove\nStart with: Remove\nThe user's words: (none)");
        // The action's words the app puts in front are not the user's.
        assert!(area_request(InpaintAction::Remove, "magenta", "Remove ", "PNG".into(), 7).prompt.ends_with("(none)"));
        assert!(area_request(InpaintAction::Remove, "magenta", "Remove the lamp", "PNG".into(), 7).prompt.ends_with("words: the lamp"));
        assert_eq!((r.images.len(), r.system_prompt.as_str(), r.sampling.seed, r.max_tokens), (1, AREA_SYSTEM_PROMPT, 7, AREA_MAX_TOKENS));
        let r = area_request(InpaintAction::Add, "cyan", " un vaso di fiori ", "PNG".into(), 1);
        assert!(r.prompt.ends_with("Action: add\nStart with: Add\nThe user's words: un vaso di fiori"));
        let r = expand_request("left and right", "", "PNG".into(), 3);
        assert_eq!(r.prompt, "Growing sides: left and right\nThe user's wishes: (none)");
        assert!(r.system_prompt == EXPAND_SYSTEM_PROMPT && r.images.len() == 1);
        // The instruction around it is Kokon's: the text is only what goes in the area.
        assert!(AREA_SYSTEM_PROMPT.contains("Never mention the line") && EXPAND_SYSTEM_PROMPT.contains("Never mention borders"));
    }

    #[test]
    fn compose_prompt_makes_a_new_picture() {
        // "Keep everything else unchanged" turns a composition into an edit of image 1.
        assert!(!COMPOSE_SYSTEM_PROMPT.contains("unchanged"));
        assert!(COMPOSE_SYSTEM_PROMPT.contains("<image1>, <image2>") && COMPOSE_SYSTEM_PROMPT.contains("new image"));
        assert!(!COMPOSE_LABEL_PROMPT.contains("unchanged"));
        // Long scenes are allowed for, within the token cap (~1.4 tokens a word at most).
        assert!(COMPOSE_SYSTEM_PROMPT.contains("280") && T2I_SYSTEM_PROMPT.contains("250"));
        assert!(300.0 * 1.4 < MAX_TOKENS as f64);
    }

    #[test]
    fn cleaning() {
        assert_eq!(clean("  A watercolour fox.\n").as_deref(), Some("A watercolour fox."));
        assert_eq!(clean("Prompt: A fox.").as_deref(), Some("A fox."));
        assert_eq!(clean("\"A fox in snow.\"").as_deref(), Some("A fox in snow."));
        let sign = "A shop sign reading \"CAFÉ\" above the door, lit by \"warm\" lamps.";
        assert_eq!(clean(sign).as_deref(), Some(sign), "inner quotes are text to render");
        assert_eq!(clean("\"OPEN\" glows in red neon above a \"BAR\"").as_deref(), Some("\"OPEN\" glows in red neon above a \"BAR\""));
        assert_eq!(clean(" \n "), None);
        assert_eq!(clean("Prompt:"), None);
        assert_eq!(clean("Ünïcode first").as_deref(), Some("Ünïcode first"), "no slicing inside a character");
    }
}
