//! Scene reading for the layers lab's "Blend into scene": the Prompt+ model (the Qwen3-VL text
//! encoder, `POST /sdcpp/v1/text_gen`) answers fixed questions about the place a pasted object
//! stands in (surface under it, light, shadows). The lab builds the edit's prompt from the answers,
//! so effects the surface does not have are never named: a prompt that names reflections or water
//! makes Qwen-Image add water on dry ground (bench 2026-11-02, `bench/20261102-200503-scene-integration`:
//! right on 4 of 4 scenes with both seeds, ~2 s on a 5070 Ti).

use serde::{Deserialize, Serialize};

use crate::sdcpp::{TextGenRequest, TextSampling};

/// The questions. The answers are fixed phrases the parser maps to ids.
pub const SYSTEM_PROMPT: &str = r#"You look at a photo where an object was pasted in, and describe the place it stands in, so it can be blended in.
Answer with JSON only, no other text, with these keys:
"surface": what is directly under and around the object's base, one of "dry hard ground", "wet ground", "puddle or standing water", "glossy or polished surface", "grass", "sand or soil", "snow", "carpet or fabric", "other".
"light": the scene's main light, one of "direct sunlight", "overcast daylight", "window light", "indoor lamps", "night".
"hard_shadows": true if the scene shows hard-edged shadows, else false.
"light_from": where the main light comes from, one of "left", "right", "front", "behind", "above".
"shadows_fall": the direction the scene's shadows fall on the ground, one of "left", "right", "towards the viewer", "away from the viewer", "under the objects".
"colour": the light's colour, one of "warm", "neutral", "cool".
"object_in": whether the object stands in "sun", "shade" or "both"."#;

/// Low temperature: the same scene reads the same way (both bench seeds gave identical answers).
const SAMPLING: TextSampling = TextSampling {
    temperature: 0.2,
    top_p: 0.8,
    top_k: 20,
    presence_penalty: 0.0,
    seed: -1,
};
/// The answer is ~60 tokens.
const MAX_TOKENS: u32 = 200;

/// What the scene does to the object, as ids (the lab shows them as words the user can change).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SceneReading {
    /// dry, wet, water, glossy, grass, soil, snow, fabric, other
    pub surface: String,
    /// sun, overcast, window, lamps, night
    pub light: String,
    pub hard_shadows: bool,
    /// left, right, front, behind, above
    pub light_from: String,
    /// left, right, front (towards the viewer), back (away), under
    pub shadows_fall: String,
    /// warm, neutral, cool
    pub colour: String,
    /// sun, shade, both
    pub object_in: String,
    /// Every answer was understood; false = some are the defaults (the lab says so).
    pub complete: bool,
}

impl Default for SceneReading {
    /// What is safe when nothing is known: dry ground, soft shadow under the object (no water, no
    /// reflection named).
    fn default() -> Self {
        Self {
            surface: "dry".into(),
            light: "overcast".into(),
            hard_shadows: false,
            light_from: "above".into(),
            shadows_fall: "under".into(),
            colour: "neutral".into(),
            object_in: "both".into(),
            complete: false,
        }
    }
}

/// The request for one object (`name`, as the lab names its layer) in `image` (base64, the image
/// as the edit model gets it).
pub fn request(image: String, name: &str, seed: i64) -> TextGenRequest {
    let name = name.trim().to_lowercase();
    TextGenRequest {
        prompt: format!("The pasted object is the {name}. Describe the place it stands in."),
        system_prompt: SYSTEM_PROMPT.into(),
        images: vec![image],
        max_tokens: MAX_TOKENS,
        sampling: TextSampling { seed, ..SAMPLING },
        stream: true,
    }
}

const SURFACES: &[(&str, &str)] = &[
    ("dry hard ground", "dry"),
    ("wet ground", "wet"),
    ("puddle or standing water", "water"),
    ("glossy or polished surface", "glossy"),
    ("grass", "grass"),
    ("sand or soil", "soil"),
    ("snow", "snow"),
    ("carpet or fabric", "fabric"),
    ("other", "other"),
];
const LIGHTS: &[(&str, &str)] = &[
    ("direct sunlight", "sun"),
    ("overcast daylight", "overcast"),
    ("window light", "window"),
    ("indoor lamps", "lamps"),
    ("night", "night"),
];
const FROM: &[(&str, &str)] = &[
    ("left", "left"),
    ("right", "right"),
    ("front", "front"),
    ("behind", "behind"),
    ("above", "above"),
];
const FALLS: &[(&str, &str)] = &[
    ("left", "left"),
    ("right", "right"),
    ("towards the viewer", "front"),
    ("away from the viewer", "back"),
    ("under the objects", "under"),
];
const COLOURS: &[(&str, &str)] = &[("warm", "warm"), ("neutral", "neutral"), ("cool", "cool")];
const PLACES: &[(&str, &str)] = &[("sun", "sun"), ("shade", "shade"), ("both", "both")];

/// The answer's phrase as an id: the exact phrase, else one the answer contains or that contains
/// it ("puddle" -> water), else None.
fn pick(v: Option<&serde_json::Value>, table: &[(&str, &str)]) -> Option<String> {
    let s = v?.as_str()?.trim().to_lowercase();
    if s.is_empty() {
        return None;
    }
    table
        .iter()
        .find(|(p, _)| *p == s)
        .or_else(|| {
            table
                .iter()
                .find(|(p, _)| s.contains(p) || p.contains(s.as_str()))
        })
        .map(|(_, id)| id.to_string())
}

/// The model's answer -> a reading. Each answer it did not give, or gave outside the list, is the
/// default (`complete` false); no JSON at all -> None.
pub fn parse(text: &str) -> Option<SceneReading> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let v: serde_json::Value = serde_json::from_str(text.get(start..=end)?).ok()?;
    let d = SceneReading::default();
    let mut complete = true;
    let mut get = |key: &str, table: &[(&str, &str)], fallback: &str| {
        pick(v.get(key), table).unwrap_or_else(|| {
            complete = false;
            fallback.to_string()
        })
    };
    let surface = get("surface", SURFACES, &d.surface);
    let light = get("light", LIGHTS, &d.light);
    let light_from = get("light_from", FROM, &d.light_from);
    let shadows_fall = get("shadows_fall", FALLS, &d.shadows_fall);
    let colour = get("colour", COLOURS, &d.colour);
    let object_in = get("object_in", PLACES, &d.object_in);
    let hard_shadows = match v.get("hard_shadows") {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::String(s))
            if s.eq_ignore_ascii_case("true") || s.eq_ignore_ascii_case("false") =>
        {
            s.eq_ignore_ascii_case("true")
        }
        _ => {
            complete = false;
            d.hard_shadows
        }
    };
    Some(SceneReading {
        surface,
        light,
        hard_shadows,
        light_from,
        shadows_fall,
        colour,
        object_in,
        complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_bench_answers() {
        // The street (bench 2026-11-02), as the model wrote it.
        let r = parse("{\n  \"surface\": \"dry hard ground\",\n  \"light\": \"direct sunlight\",\n  \"hard_shadows\": true,\n  \"light_from\": \"left\",\n  \"shadows_fall\": \"right\",\n  \"colour\": \"warm\",\n  \"object_in\": \"sun\"\n}").unwrap();
        assert_eq!(
            r,
            SceneReading {
                surface: "dry".into(),
                light: "sun".into(),
                hard_shadows: true,
                light_from: "left".into(),
                shadows_fall: "right".into(),
                colour: "warm".into(),
                object_in: "sun".into(),
                complete: true
            }
        );
        // The puddle, with text around the JSON and a code fence.
        let r = parse("Here it is:\n```json\n{\"surface\": \"wet ground\", \"light\": \"overcast daylight\", \"hard_shadows\": false, \"light_from\": \"above\", \"shadows_fall\": \"under the objects\", \"colour\": \"cool\", \"object_in\": \"shade\"}\n```").unwrap();
        assert_eq!(
            (
                r.surface.as_str(),
                r.shadows_fall.as_str(),
                r.hard_shadows,
                r.complete
            ),
            ("wet", "under", false, true)
        );
    }

    #[test]
    fn near_answers_and_defaults() {
        // A shorter phrase than asked, a string boolean, a missing key, an answer outside the list.
        let r = parse(r#"{"surface": "puddle", "light": "sunlight", "hard_shadows": "true", "light_from": "upper left", "colour": "purple"}"#).unwrap();
        assert_eq!(
            (r.surface.as_str(), r.light.as_str(), r.hard_shadows),
            ("water", "sun", true)
        );
        assert_eq!(
            (
                r.light_from.as_str(),
                r.shadows_fall.as_str(),
                r.colour.as_str()
            ),
            ("left", "under", "neutral")
        );
        assert!(!r.complete);
        assert_eq!(parse("I can't tell."), None);
        assert_eq!(parse("{not json}"), None);
        // The safe default names no water.
        assert_eq!(SceneReading::default().surface, "dry");
    }

    #[test]
    fn request_names_the_object() {
        let r = request("AAA".into(), " Woman ", 7);
        assert!(
            r.prompt.contains("the woman.")
                && r.images == vec!["AAA".to_string()]
                && r.sampling.seed == 7
                && r.system_prompt == SYSTEM_PROMPT
        );
    }
}
