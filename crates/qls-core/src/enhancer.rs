//! Prompt enhancer: the Qwen3-VL 8B that Qwen-Image 2.1 already loads as its text encoder
//! rewrites the user's short instruction into a full English prompt (looking at the input
//! images for edits) before the image is generated. Runs on Kokon's engine builds only
//! (`Capabilities::text_generation`, `POST /sdcpp/v1/text_gen`); the server has no built-in
//! system prompt, so Kokon always sends one: the user's from Settings or the defaults below.
//! Design and the A/B behind these texts: docs/prompt-enhancer.md.

use crate::config::AppConfig;
use crate::planner::ResolvedMode;
use crate::sdcpp::{TextGenRequest, TextSampling};

/// Built-in system prompt for text-to-image (docs/prompt-enhancer.md, decided 2026-10-18, revised
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
- Write in English whatever language the user writes in, about 80 to 150 words, in the present tense, as a description of the image, not as instructions.
Output only the prompt."#;

/// Built-in system prompt for image-grounded edits and combines.
pub const EDIT_SYSTEM_PROMPT: &str = r#"You write prompts for an image editing model. You see the input image and the user's instruction. Rewrite the instruction as one precise English editing instruction.
- Start with the operation (Change, Replace, Remove, Add, Turn, Place, ...) and say exactly what changes, where it is in the image and what it becomes. Make the change complete and clearly visible, not faint.
- Describe in detail only what changes. For everything else end with one sentence such as "Keep everything else in the image unchanged." Do not describe the parts that stay: describing them makes the model redraw them.
- People keep their face and identity, and the image keeps its medium (photo, painting, illustration), unless the user asks to change them.
- Base every detail on what is visible in the image and do not invent objects. Do only what the user asked: no extra fixes or additions.
- When something is removed or moved, its shadow and reflection go with it; say briefly what fills the empty area so the result looks natural.
- Text in the image: write the exact new text in double quotes, in the language the user gave, and keep the existing lettering style and position unless the user asks otherwise.
- For a style or mood change (painting, season, night, ...), apply it fully to the whole image and end with "Keep the composition and the subjects unchanged." instead.
- With several input images, refer to them as <image1>, <image2>, ...: start with Place or Combine, say what is taken from each image and where it goes in the result.
- Write in English whatever language the user writes in, as one paragraph of about 20 to 60 words, with no resolution or aspect ratio.
Output only the instruction."#;

/// Longest custom system prompt accepted in Settings (characters).
pub const MAX_SYSTEM_PROMPT_CHARS: usize = 20_000;

/// The built-in prompts ask for ≤ 150 words (~200 tokens); the cap only stops a model that
/// does not end its turn.
pub const MAX_TOKENS: u32 = 512;

/// Qwen's recommended sampling for Qwen3-VL (vision-language), used for both prompts.
pub const SAMPLING: TextSampling = TextSampling { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, seed: -1 };

/// Text-to-image, edits and combines get the enhancer. Inpaint and outpaint wrap the prompt
/// in their own instructions, and upscales have no prompt.
pub fn applies(mode: ResolvedMode) -> bool {
    matches!(mode, ResolvedMode::Generate | ResolvedMode::Edit | ResolvedMode::MultiReference)
}

/// The system prompt for `mode`: the one saved in Settings, or the built-in one.
pub fn system_prompt(cfg: &AppConfig, mode: ResolvedMode) -> String {
    let (custom, default) = if mode == ResolvedMode::Generate { (&cfg.enhancer_t2i_prompt, T2I_SYSTEM_PROMPT) } else { (&cfg.enhancer_edit_prompt, EDIT_SYSTEM_PROMPT) };
    if custom.trim().is_empty() { default.to_string() } else { custom.trim().to_string() }
}

/// The `text_gen` request for a job: its seed (so the same seed writes the same prompt, and
/// Regenerate writes a new one) and, for edits, the references as the image model gets them.
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

/// The model's answer as a prompt: trimmed, without a "Prompt:" label or quotes around the
/// whole text. None when nothing usable is left.
pub fn clean(text: &str) -> Option<String> {
    let mut t = text.trim();
    for label in ["Prompt:", "Instruction:", "Editing instruction:"] {
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
        assert!(applies(ResolvedMode::Generate) && applies(ResolvedMode::Edit) && applies(ResolvedMode::MultiReference));
        assert!(!applies(ResolvedMode::Inpaint) && !applies(ResolvedMode::Outpaint) && !applies(ResolvedMode::Upscale));
        let mut cfg = AppConfig::default();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), T2I_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), EDIT_SYSTEM_PROMPT);
        assert_eq!(system_prompt(&cfg, ResolvedMode::MultiReference), EDIT_SYSTEM_PROMPT);
        cfg.enhancer_edit_prompt = "  Jewelry retouch rules.\n".into();
        cfg.enhancer_t2i_prompt = " \n ".into();
        assert_eq!(system_prompt(&cfg, ResolvedMode::Edit), "Jewelry retouch rules.");
        assert_eq!(system_prompt(&cfg, ResolvedMode::Generate), T2I_SYSTEM_PROMPT, "blank = built-in");
        assert!(T2I_SYSTEM_PROMPT.ends_with("Output only the prompt.") && EDIT_SYSTEM_PROMPT.contains("<image1>, <image2>"));
    }

    #[test]
    fn builtin_prompts_have_nothing_the_model_copies() {
        // Seen in real outputs (bench sysprompt-v2-20261019-155557): example colours ended up in
        // almost every prompt, and the text rule became "No text appears in the image."
        for p in [T2I_SYSTEM_PROMPT, EDIT_SYSTEM_PROMPT] {
            for leak in ["deep navy", "pale cream", "copper", "No text"] {
                assert!(!p.contains(leak), "{leak:?} in a built-in prompt");
            }
        }
        assert!(T2I_SYSTEM_PROMPT.contains("Otherwise write nothing about text."));
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
