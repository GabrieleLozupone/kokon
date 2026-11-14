//! AI marking of the images Kokon saves: an XMP packet with IPTC's Digital Source Type (the
//! vocabulary Google, Meta and Adobe read to label AI images) and Kokon as the creator tool, in
//! every PNG, JPEG and WebP Kokon writes (results, Save as, the copies for MCP). Unsigned: like any
//! metadata it can be removed; a signed C2PA manifest would need a certificate (decided 2026-11-04:
//! XMP only for 0.12; the Code of Practice on marking AI content, Sub-measure 1.1.1, leaves the
//! signature out "in a local deployment scenario"). The second layer, in the pixels, is the
//! invisible watermark of watermark.rs (docs/ai-marking.md).

use crate::store::GenerationRecord;

const IPTC_TYPES: &str = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const XMP_NS: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";

/// The IPTC Digital Source Types that say "made or changed with generative AI".
pub const AI_TYPES: [&str; 2] = ["trainedAlgorithmicMedia", "compositeWithTrainedAlgorithmicMedia"];

/// The IPTC Digital Source Type of a result: made by the model from words (and references), an
/// image changed by it, or (an upscale or a colour LUT of an imported photo) only enhanced. A
/// type set on the record wins: an upscale or LUT takes its parent's (engine.rs `mark`), an
/// enhanced import that was AI-made already keeps AI.
pub fn source_type(rec: &GenerationRecord) -> &'static str {
    const KNOWN: [&str; 3] = [AI_TYPES[0], AI_TYPES[1], "algorithmicallyEnhanced"];
    if let Some(t) = rec.source_type.as_deref().and_then(|t| KNOWN.iter().find(|a| **a == t)) {
        return t;
    }
    match rec.mode.as_str() {
        "generate" | "compose" => "trainedAlgorithmicMedia",
        // Of a Kokon result: still the model's picture; of an imported photo: enhanced only.
        "upscale" | "lut" if rec.parent_id.is_none() => "algorithmicallyEnhanced",
        _ => "compositeWithTrainedAlgorithmicMedia",
    }
}

/// The attributes for an rdf:Description (also added to the Ultra HDR JPEG's own XMP).
pub fn attributes(rec: &GenerationRecord) -> String {
    format!(
        r#"xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" Iptc4xmpExt:DigitalSourceType="{IPTC_TYPES}{}" xmp:CreatorTool="Kokon {}" xmp:CreateDate="{}""#,
        source_type(rec),
        escape(&rec.app_version),
        escape(&local_time(&rec.created_at)),
    )
}

/// The record's time (UTC, "...Z") on this computer's clock with its offset ("...+01:00"):
/// Windows and many photo viewers show XMP dates as written and drop the zone, so a UTC time
/// showed an hour early in Europe in winter. The same moment; unchanged if it doesn't parse.
fn local_time(rfc3339: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|t| t.with_timezone(&chrono::Local).to_rfc3339_opts(chrono::SecondsFormat::Secs, false))
        .unwrap_or_else(|_| rfc3339.to_string())
}

/// The whole XMP packet.
pub fn xmp(rec: &GenerationRecord) -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Kokon\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description rdf:about=\"\" {}/></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>",
        attributes(rec)
    )
}

/// Is the result AI-generated or AI-manipulated (marked with the watermark too)? Only an
/// enhancement of an imported image is not (the Commission's Art. 50 guidelines: rescaling, colour
/// adjustments and sharpening are standard editing), unless that import was AI-made already.
pub fn is_ai(rec: &GenerationRecord) -> bool {
    AI_TYPES.contains(&source_type(rec))
}

/// The AI Digital Source Type an image file declares (XMP, or a C2PA manifest's actions, which
/// carry the same IPTC term as text), if any. Read from the bytes: no parser needed for one term.
pub fn declared_ai_type(bytes: &[u8]) -> Option<&'static str> {
    const KEY: &[u8] = b"digitalsourcetype/";
    let lower: Vec<u8> = bytes.iter().map(u8::to_ascii_lowercase).collect();
    let mut best = None;
    let mut from = 0;
    while let Some(i) = lower[from..].windows(KEY.len()).position(|w| w == KEY) {
        let at = from + i + KEY.len();
        let tail = &bytes[at..bytes.len().min(at + 64)];
        let word: String = tail.iter().take_while(|b| b.is_ascii_alphanumeric()).map(|&b| b as char).collect();
        // The composite term names the whole when both appear (an edited AI image).
        match AI_TYPES.iter().find(|t| **t == word) {
            Some(&"compositeWithTrainedAlgorithmicMedia") => return Some(AI_TYPES[1]),
            Some(t) => best = Some(*t),
            None => {}
        }
        from = at;
    }
    best
}

/// Any IPTC Digital Source Type term the bytes declare (the composite AI term first when several).
fn declared_type(bytes: &[u8]) -> Option<String> {
    if let Some(t) = declared_ai_type(bytes) {
        return Some(t.into());
    }
    const KEY: &[u8] = b"digitalsourcetype/";
    let lower: Vec<u8> = bytes.iter().map(u8::to_ascii_lowercase).collect();
    let i = lower.windows(KEY.len()).position(|w| w == KEY)? + KEY.len();
    let word: String = bytes[i..bytes.len().min(i + 64)].iter().take_while(|b| b.is_ascii_alphanumeric()).map(|&b| b as char).collect();
    (!word.is_empty()).then_some(word)
}

/// The XMP CreatorTool (attribute or element form), if any.
fn creator_tool(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let i = text.find("xmp:CreatorTool")? + "xmp:CreatorTool".len();
    let rest = &text[i..];
    let v = if let Some(r) = rest.strip_prefix("=\"") { r.split('"').next() } else { rest.strip_prefix('>').and_then(|r| r.split('<').next()) }?;
    let v = v.trim();
    (!v.is_empty() && v.len() < 200).then(|| v.to_string())
}

/// What an image's AI markings say, for "Check an image" (the Code of Practice's Commitment 2: a
/// free, local detection anyone can run; nothing is kept). Reads the metadata (IPTC Digital Source
/// Type in XMP or C2PA, CreatorTool, whether a C2PA manifest is present: not verified) and the
/// TrustMark P watermark. `ai`: one of them says made or changed with AI.
pub fn check(sdcpp_dir: &std::path::Path, bytes: &[u8]) -> crate::error::AppResult<serde_json::Value> {
    use sha2::Digest;
    let img = crate::imaging::decode_image(bytes)?.pixels;
    let source = declared_type(bytes);
    let declared_ai = source.as_deref().is_some_and(|t| AI_TYPES.contains(&t));
    let c2pa = bytes.windows(4).any(|w| w == b"jumb") && bytes.windows(4).any(|w| w == b"c2pa");
    let watermark = if crate::watermark::installed(sdcpp_dir) {
        // Another app's TrustMark only with the strongest error correction: the weaker schemas
        // accept ~2 % of unmarked images by chance (32 of 1567 on 2026-11-04, none as Kokon's).
        match crate::watermark::detect(sdcpp_dir, &img)? {
            Some(f) if f.kokon || f.schema == "BCH_SUPER" => serde_json::json!({ "checked": true, "found": true, "kokon": f.kokon, "text": f.text, "schema": f.schema }),
            _ => serde_json::json!({ "checked": true, "found": false, "kokon": false }),
        }
    } else {
        serde_json::json!({ "checked": false })
    };
    let wm_kokon = watermark["kokon"].as_bool().unwrap_or(false);
    Ok(serde_json::json!({
        "ai": declared_ai || wm_kokon,
        "metadata": { "digital_source_type": source, "ai": declared_ai, "creator_tool": creator_tool(bytes), "c2pa_manifest": c2pa },
        "watermark": watermark,
        "width": img.width(),
        "height": img.height(),
        "sha256": hex::encode(sha2::Sha256::digest(bytes)),
        "checked_at": chrono::Local::now().to_rfc3339(),
        "checker": format!("Kokon {} (XMP/C2PA reader, TrustMark P decoder)", crate::engine::APP_VERSION),
    }))
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// A JPEG with the XMP as an APP1 segment after SOI (and after a JFIF APP0, which comes first).
pub fn jpeg_with_xmp(jpeg: &[u8], xmp: &str) -> Vec<u8> {
    if jpeg.len() < 4 || jpeg[..2] != [0xFF, 0xD8] {
        return jpeg.to_vec();
    }
    let mut at = 2;
    if jpeg[2..4] == [0xFF, 0xE0] && jpeg.len() >= 6 {
        at = (4 + u16::from_be_bytes([jpeg[4], jpeg[5]]) as usize).min(jpeg.len());
    }
    let payload = [XMP_NS, xmp.as_bytes()].concat();
    let mut out = Vec::with_capacity(jpeg.len() + payload.len() + 4);
    out.extend_from_slice(&jpeg[..at]);
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&payload);
    out.extend_from_slice(&jpeg[at..]);
    out
}

/// A WebP with the XMP in an "XMP " chunk: a simple file (one VP8/VP8L chunk) becomes an extended
/// one (VP8X first, with the XMP flag, and the alpha flag when `alpha`).
pub fn webp_with_xmp(webp: &[u8], xmp: &str, width: u32, height: u32, alpha: bool) -> Vec<u8> {
    if webp.len() < 20 || &webp[..4] != b"RIFF" || &webp[8..12] != b"WEBP" {
        return webp.to_vec();
    }
    let body = &webp[12..];
    let mut chunks = Vec::with_capacity(webp.len() + xmp.len() + 40);
    if &body[..4] == b"VP8X" {
        chunks.extend_from_slice(body);
        chunks[8] |= 0x04;
    } else {
        let mut vp8x = [0u8; 10];
        vp8x[0] = 0x04 | if alpha { 0x10 } else { 0 };
        vp8x[4..7].copy_from_slice(&(width.max(1) - 1).to_le_bytes()[..3]);
        vp8x[7..10].copy_from_slice(&(height.max(1) - 1).to_le_bytes()[..3]);
        chunks.extend_from_slice(b"VP8X");
        chunks.extend_from_slice(&10u32.to_le_bytes());
        chunks.extend_from_slice(&vp8x);
        chunks.extend_from_slice(body);
    }
    chunks.extend_from_slice(b"XMP ");
    chunks.extend_from_slice(&(xmp.len() as u32).to_le_bytes());
    chunks.extend_from_slice(xmp.as_bytes());
    if xmp.len() % 2 == 1 {
        chunks.push(0);
    }
    let mut out = Vec::with_capacity(chunks.len() + 12);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((chunks.len() + 4) as u32).to_le_bytes());
    out.extend_from_slice(b"WEBP");
    out.extend_from_slice(&chunks);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(mode: &str, parent: Option<&str>) -> GenerationRecord {
        let mut r: GenerationRecord = serde_json::from_value(serde_json::json!({
            "id": "g", "created_at": "2026-11-04T10:00:00+01:00", "mode": mode, "prompt": "", "negative_prompt": "",
            "seed": 1, "width": 8, "height": 8, "working_width": 8, "working_height": 8, "model": "", "sampler": "",
            "steps": 8, "cfg": 1.0, "quality": "", "resolution": "", "references": [], "file_path": "f", "app_version": "0.12.0", "favorite": false, "duration_ms": 0, "notes": [], "extra_paths": [], "request": null,
        }))
        .unwrap();
        r.parent_id = parent.map(str::to_string);
        r
    }

    #[test]
    fn create_date_is_local_time() {
        let utc = "2026-11-11T14:45:06.123Z";
        let local = local_time(utc);
        assert!(!local.ends_with('Z'), "{local}");
        let back = chrono::DateTime::parse_from_rfc3339(&local).unwrap();
        assert_eq!(back.timestamp(), chrono::DateTime::parse_from_rfc3339(utc).unwrap().timestamp());
        assert_eq!(back.offset().local_minus_utc(), back.with_timezone(&chrono::Local).offset().local_minus_utc());
        assert_eq!(local_time("not a date"), "not a date");
        let mut r = rec("generate", None);
        r.created_at = utc.into();
        assert!(attributes(&r).contains(&format!("xmp:CreateDate=\"{local}\"")));
    }

    #[test]
    fn source_types() {
        assert_eq!(
            source_type(&rec("generate", None)),
            "trainedAlgorithmicMedia"
        );
        assert_eq!(
            source_type(&rec("compose", None)),
            "trainedAlgorithmicMedia"
        );
        for m in ["edit", "inpaint", "outpaint", "multi_reference", "layers"] {
            assert_eq!(
                source_type(&rec(m, None)),
                "compositeWithTrainedAlgorithmicMedia",
                "{m}"
            );
        }
        assert_eq!(
            source_type(&rec("upscale", None)),
            "algorithmicallyEnhanced"
        );
        assert_eq!(
            source_type(&rec("lut", Some("p"))),
            "compositeWithTrainedAlgorithmicMedia"
        );
        // An enhanced import that was AI-made keeps its type, and is AI.
        let mut up = rec("upscale", None);
        assert!(!is_ai(&up));
        up.source_type = Some("trainedAlgorithmicMedia".into());
        assert_eq!(source_type(&up), "trainedAlgorithmicMedia");
        assert!(is_ai(&up) && is_ai(&rec("edit", None)));
        up.source_type = Some("made up".into());
        assert_eq!(source_type(&up), "algorithmicallyEnhanced");
        let x = xmp(&rec("generate", None));
        assert!(x.contains(r#"Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia""#));
        assert!(
            x.contains(r#"xmp:CreatorTool="Kokon 0.12.0""#) && x.ends_with("<?xpacket end=\"w\"?>")
        );
    }

    #[test]
    fn reads_the_declared_type() {
        let x = xmp(&rec("generate", None));
        assert_eq!(declared_ai_type(format!("junk{x}junk").as_bytes()), Some("trainedAlgorithmicMedia"));
        assert_eq!(declared_ai_type(xmp(&rec("edit", None)).as_bytes()), Some("compositeWithTrainedAlgorithmicMedia"));
        assert_eq!(declared_ai_type(xmp(&rec("upscale", None)).as_bytes()), None);
        // A C2PA action names the type in its own casing; a camera photo has none.
        assert_eq!(declared_ai_type(b"..http://cv.iptc.org/newscodes/DigitalSourceType/trainedAlgorithmicMedia\x00.."), Some("trainedAlgorithmicMedia"));
        assert_eq!(declared_ai_type(b"digitalsourcetype/digitalCapture"), None);
        assert_eq!(declared_ai_type(b""), None);
    }

    #[test]
    fn check_reads_the_metadata_without_the_models() {
        let img = image::RgbaImage::from_pixel(9, 7, image::Rgba([10, 20, 30, 255]));
        let jpg = jpeg_with_xmp(&crate::imaging::encode_jpeg(&img, 90).unwrap(), &xmp(&rec("edit", None)));
        let r = check(std::path::Path::new("no-models-here"), &jpg).unwrap();
        assert_eq!(r["ai"], true);
        assert_eq!(r["metadata"]["digital_source_type"], "compositeWithTrainedAlgorithmicMedia");
        assert_eq!(r["metadata"]["creator_tool"], "Kokon 0.12.0");
        assert_eq!(r["metadata"]["c2pa_manifest"], false);
        assert_eq!(r["watermark"]["checked"], false);
        assert_eq!(r["sha256"].as_str().unwrap().len(), 64);
        let plain = check(std::path::Path::new("no-models-here"), &crate::imaging::encode_jpeg(&img, 90).unwrap()).unwrap();
        assert_eq!((plain["ai"].as_bool(), plain["metadata"]["digital_source_type"].is_null()), (Some(false), true));
        assert_eq!(creator_tool(b"<xmp:CreatorTool>Adobe Photoshop 26.0</xmp:CreatorTool>").as_deref(), Some("Adobe Photoshop 26.0"));
    }

    #[test]
    fn jpeg_and_webp_carry_it_and_still_decode() {
        let img = image::RgbaImage::from_pixel(9, 7, image::Rgba([10, 20, 30, 128]));
        let x = xmp(&rec("edit", None));
        let jpg = jpeg_with_xmp(&crate::imaging::encode_jpeg(&img, 90).unwrap(), &x);
        assert!(jpg.windows(XMP_NS.len()).any(|w| w == XMP_NS));
        assert_eq!(image::load_from_memory(&jpg).unwrap().width(), 9);
        let webp = webp_with_xmp(
            &crate::imaging::encode_webp_lossless(&img).unwrap(),
            &x,
            9,
            7,
            true,
        );
        assert_eq!(&webp[12..16], b"VP8X");
        assert_eq!(
            u32::from_le_bytes(webp[4..8].try_into().unwrap()) as usize,
            webp.len() - 8
        );
        assert!(webp.windows(4).any(|w| w == b"XMP "));
        let back = image::load_from_memory(&webp).unwrap().to_rgba8();
        assert_eq!(
            (back.width(), back.height(), back.get_pixel(0, 0)[3]),
            (9, 7, 128)
        );
    }
}
