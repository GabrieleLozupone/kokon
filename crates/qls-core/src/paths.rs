//! Validation of filesystem paths received through MCP / HTTP. Rules:
//! - absolute local drive paths only (no UNC, device namespaces, or alternate streams);
//! - no `..` escaping an allowed root; symlinked parents are resolved before checking;
//! - only image extensions; size-limited inputs;
//! - outputs never overwrite existing files or any input file (a numbered suffix is added).

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult, ErrorCode};

pub const INPUT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "heic", "heif"];
pub const OUTPUT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp"];
pub const MAX_INPUT_BYTES: u64 = 200 * 1024 * 1024;

fn bad(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidPath, msg)
}

const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4",
    "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Lexically normalizes an absolute path (resolving `.` and `..`) after rejecting
/// dangerous forms. Relative paths are joined to `base` when given.
pub fn normalize(raw: &str, base: Option<&Path>) -> AppResult<PathBuf> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(bad("The path is empty."));
    }
    if s.contains('\0') || s.chars().any(|c| (c as u32) < 0x20) {
        return Err(bad("The path contains invalid characters."));
    }
    if s.starts_with(r"\\") || s.starts_with("//") {
        return Err(bad("Network and device paths are not allowed."));
    }
    let p = Path::new(s);
    let joined: PathBuf = if p.is_absolute() {
        p.to_path_buf()
    } else {
        match base {
            Some(b) if !s.contains(':') => b.join(p),
            _ => return Err(bad("Use an absolute path (for example C:\\Images\\photo.png).")),
        }
    };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::Prefix(pre) => {
                use std::path::Prefix;
                match pre.kind() {
                    Prefix::Disk(_) => out.push(pre.as_os_str()),
                    _ => return Err(bad("Network and device paths are not allowed.")),
                }
            }
            Component::RootDir => out.push(std::path::MAIN_SEPARATOR_STR),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() || out.parent().is_none() {
                    return Err(bad("The path escapes its folder."));
                }
            }
            Component::Normal(n) => {
                let name = n.to_string_lossy();
                if name.contains(':') {
                    return Err(bad("Alternate data streams are not allowed."));
                }
                let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
                if RESERVED.contains(&stem.trim_end().as_ref()) {
                    return Err(bad(format!("'{name}' is a reserved Windows name.")));
                }
                if name.ends_with(' ') || (name.ends_with('.') && name != "." && name != "..") {
                    return Err(bad("File names cannot end with a space or a dot."));
                }
                out.push(n);
            }
        }
    }
    Ok(out)
}

fn ext_of(p: &Path) -> Option<String> {
    p.extension().map(|e| e.to_string_lossy().to_ascii_lowercase())
}

/// Resolves symlinks/junctions on the deepest existing ancestor, then re-appends the rest.
fn resolve_existing_prefix(p: &Path) -> PathBuf {
    let mut existing = p.to_path_buf();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|s| s.to_os_string()), existing.parent()) {
            (Some(n), Some(parent)) => {
                rest.push(n);
                existing = parent.to_path_buf();
            }
            _ => return p.to_path_buf(),
        }
    }
    let mut resolved = dunce_canonical(&existing).unwrap_or(existing);
    for n in rest.into_iter().rev() {
        resolved.push(n);
    }
    resolved
}

/// `std::fs::canonicalize` returns `\\?\C:\...` on Windows; strip it for comparisons.
pub fn dunce_canonical(p: &Path) -> std::io::Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    let s = c.to_string_lossy();
    Ok(match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => c,
    })
}

fn starts_with_ci(p: &Path, root: &Path) -> bool {
    let a = p.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    let mut b = root.to_string_lossy().to_ascii_lowercase().replace('/', "\\");
    if !b.ends_with('\\') {
        b.push('\\');
    }
    a == b.trim_end_matches('\\') || a.starts_with(&b)
}

pub fn is_within(p: &Path, roots: &[PathBuf]) -> bool {
    let rp = resolve_existing_prefix(p);
    roots.iter().any(|r| {
        let rr = resolve_existing_prefix(r);
        starts_with_ci(&rp, &rr)
    })
}

/// Validates an input image path. `roots`: when non-empty, the file must be inside one.
pub fn validate_input_image(raw: &str, base: Option<&Path>, roots: &[PathBuf]) -> AppResult<PathBuf> {
    let p = normalize(raw, base)?;
    match ext_of(&p) {
        Some(e) if INPUT_EXTENSIONS.contains(&e.as_str()) => {}
        _ => return Err(bad("Only PNG, JPEG, WebP, BMP, GIF, TIFF and HEIC images are supported.")),
    }
    if !roots.is_empty() && !is_within(&p, roots) {
        return Err(bad(format!("{} is outside the allowed folders.", p.display())));
    }
    let meta = std::fs::metadata(&p).map_err(|e| AppError::io("read the image", &p, e))?;
    if !meta.is_file() {
        return Err(bad(format!("{} is not a file.", p.display())));
    }
    if meta.len() > MAX_INPUT_BYTES {
        return Err(bad("The image file is larger than 200 MB."));
    }
    Ok(p)
}

pub fn sanitize_file_stem(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let mut out = String::new();
    for c in cleaned.chars() {
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let out = out.trim_matches('-').chars().take(60).collect::<String>().to_lowercase();
    if out.is_empty() { "image".into() } else { out }
}

/// A project title as a folder name, as readable as it can stay: letters, digits, spaces and
/// `-_.,()&'` are kept, anything else becomes a space; at most 60 characters, no leading or
/// trailing dots or spaces (Windows drops them), and the names Windows reserves (CON, NUL, COM1...)
/// get a `_`. None when nothing is left.
pub fn folder_name(s: &str) -> Option<String> {
    let kept: String = s.chars().map(|c| if c.is_alphanumeric() || " -_.,()&'".contains(c) { c } else { ' ' }).collect();
    let words = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = words.chars().take(60).collect();
    out = out.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if out.is_empty() {
        return None;
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        out.push('_');
    }
    Some(out)
}

/// Resolves where to write an output. Adds `.png` if no extension; requires an allowed
/// root; never returns an existing path or one of `inputs` (adds -1, -2, ...).
pub fn resolve_output_path(raw: &str, base: Option<&Path>, roots: &[PathBuf], inputs: &[PathBuf]) -> AppResult<PathBuf> {
    let mut p = normalize(raw, base)?;
    match ext_of(&p) {
        None => {
            p.set_extension("png");
        }
        Some(e) if OUTPUT_EXTENSIONS.contains(&e.as_str()) => {}
        Some(_) => return Err(bad("Output files must end in .png, .jpg or .webp.")),
    }
    if !is_within(&p, roots) {
        return Err(bad(format!("{} is outside the allowed output folders.", p.display())));
    }
    Ok(unique_path(p, inputs))
}

pub fn unique_path(p: PathBuf, avoid: &[PathBuf]) -> PathBuf {
    let collides = |c: &Path| c.exists() || avoid.iter().any(|a| a.to_string_lossy().eq_ignore_ascii_case(&c.to_string_lossy()));
    if !collides(&p) {
        return p;
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "png".into());
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    for i in 1..10_000 {
        let c = dir.join(format!("{stem}-{i}.{ext}"));
        if !collides(&c) {
            return c;
        }
    }
    dir.join(format!("{stem}-{}.{ext}", uuid::Uuid::new_v4().simple()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_titles_become_folder_names() {
        assert_eq!(folder_name("Holiday photos: Rome / 2026").as_deref(), Some("Holiday photos Rome 2026"));
        assert_eq!(folder_name("  ...a red car, at night...  ").as_deref(), Some("a red car, at night"));
        assert_eq!(folder_name("Café & Bär (v2)").as_deref(), Some("Café & Bär (v2)"));
        assert_eq!(folder_name("con").as_deref(), Some("con_"));
        assert_eq!(folder_name("COM1.txt").as_deref(), Some("COM1.txt_"));
        assert_eq!(folder_name("Comet").as_deref(), Some("Comet"));
        assert_eq!(folder_name("<>:\"/\\|?*"), None);
        assert_eq!(folder_name(""), None);
        assert_eq!(folder_name(&"a".repeat(200)).map(|s| s.len()), Some(60));
    }

    #[test]
    fn normalize_rejects_dangerous_forms() {
        for bad_path in [
            r"\\server\share\a.png",
            r"\\?\C:\a.png",
            r"\\.\PhysicalDrive0",
            "//server/x.png",
            r"C:\images\a.png:stream",
            r"C:\images\CON.png",
            r"C:\images\nul",
            "",
            "a\0b",
            r"C:\..\..\Windows",
        ] {
            assert!(normalize(bad_path, None).is_err(), "{bad_path:?} accepted");
        }
        assert!(normalize("relative.png", None).is_err());
        assert!(normalize(r"C:relative.png", Some(Path::new(r"C:\base"))).is_err(), "drive-relative");
    }

    #[test]
    #[cfg(windows)]
    fn normalize_resolves_dots() {
        assert_eq!(normalize(r"C:\a\b\..\c\.\d.png", None).unwrap(), PathBuf::from(r"C:\a\c\d.png"));
        assert_eq!(normalize(r"assets\hero.png", Some(Path::new(r"C:\proj"))).unwrap(), PathBuf::from(r"C:\proj\assets\hero.png"));
        assert_eq!(normalize("C:/a/b.png", None).unwrap(), PathBuf::from(r"C:\a\b.png"));
    }

    #[test]
    #[cfg(unix)]
    fn normalize_resolves_dots_unix() {
        assert_eq!(normalize("/a/b/../c/./d.png", None).unwrap(), PathBuf::from("/a/c/d.png"));
        assert_eq!(normalize("assets/hero.png", Some(Path::new("/proj"))).unwrap(), PathBuf::from("/proj/assets/hero.png"));
    }

    #[test]
    #[cfg(unix)]
    fn traversal_outside_root_is_rejected_unix() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let roots = vec![root.clone()];
        assert!(resolve_output_path("assets/hero.png", Some(&root), &roots, &[]).unwrap().ends_with("hero.png"));
        assert!(resolve_output_path("../outside.png", Some(&root), &roots, &[]).is_err());
        assert!(resolve_output_path("assets/../../proj2/x.png", Some(&root), &roots, &[]).is_err());
        assert!(!is_within(&dir.path().join("proj2").join("x.png"), &roots));
    }

    #[test]
    #[cfg(windows)]
    fn traversal_outside_root_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("proj");
        std::fs::create_dir_all(root.join("assets")).unwrap();
        let roots = vec![root.clone()];
        let ok = resolve_output_path(r"assets\hero.png", Some(&root), &roots, &[]).unwrap();
        assert!(ok.ends_with("hero.png"));
        let escape = resolve_output_path(r"..\outside.png", Some(&root), &roots, &[]);
        assert!(escape.is_err());
        let sneaky = resolve_output_path(r"assets\..\..\proj2\x.png", Some(&root), &roots, &[]);
        assert!(sneaky.is_err());
        // Prefix trick: C:\...\proj2 must not count as inside C:\...\proj
        let sibling = dir.path().join("proj2").join("x.png");
        assert!(!is_within(&sibling, &roots));
    }

    #[test]
    fn outputs_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![dir.path().to_path_buf()];
        let existing = dir.path().join("a.png");
        std::fs::write(&existing, b"x").unwrap();
        let p = resolve_output_path(&existing.to_string_lossy(), None, &roots, &[]).unwrap();
        assert_eq!(p.file_name().unwrap(), "a-1.png");
        let input = dir.path().join("b.png");
        let p = resolve_output_path(&input.to_string_lossy(), None, &roots, std::slice::from_ref(&input)).unwrap();
        assert_eq!(p.file_name().unwrap(), "b-1.png");
        let p = resolve_output_path(&dir.path().join("noext").to_string_lossy(), None, &roots, &[]).unwrap();
        assert_eq!(p.extension().unwrap(), "png");
        assert!(resolve_output_path(&dir.path().join("x.exe").to_string_lossy(), None, &roots, &[]).is_err());
    }

    #[test]
    fn input_validation() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("in.png");
        std::fs::write(&img, b"fake").unwrap();
        let roots = vec![dir.path().to_path_buf()];
        assert!(validate_input_image(&img.to_string_lossy(), None, &roots).is_ok());
        assert!(validate_input_image(&img.to_string_lossy(), None, &[]).is_ok());
        assert!(validate_input_image(&dir.path().join("missing.png").to_string_lossy(), None, &roots).is_err());
        let txt = dir.path().join("a.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(validate_input_image(&txt.to_string_lossy(), None, &roots).is_err());
        let other = tempfile::tempdir().unwrap();
        let outside = other.path().join("o.png");
        std::fs::write(&outside, b"x").unwrap();
        assert!(validate_input_image(&outside.to_string_lossy(), None, &roots).is_err());
    }

    #[test]
    fn stems() {
        assert_eq!(sanitize_file_stem("A hero image: sunset / city!"), "a-hero-image-sunset-city");
        assert_eq!(sanitize_file_stem("../../etc"), "etc");
        assert_eq!(sanitize_file_stem("???"), "image");
    }
}
