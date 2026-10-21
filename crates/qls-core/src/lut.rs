//! Colour LUTs in the `.cube` format (Adobe / DaVinci Resolve): parsing, applying one to an
//! image at an intensity, and the folder of LUTs the user has opened (most recent first).
//!
//! Kokon also ships a few looks of its own ([`PRESETS`]), built from simple colour math (no
//! third-party LUT files), listed with ids `kokon:<key>`.
//!
//! 3D tables use tetrahedral interpolation (what Resolve and most graders use), 1D tables
//! linear interpolation per channel. Values are display-referred: the image's 8-bit sRGB
//! values go in as 0-1 (through `DOMAIN_MIN`/`DOMAIN_MAX`), like every grading tool does.

use std::path::{Path, PathBuf};

use image::RgbaImage;
use serde::Serialize;

use crate::error::{AppError, AppResult, ErrorCode};

/// Largest 3D table accepted (129³ is the biggest size tools write; 65³ is common).
const MAX_3D: usize = 129;
const MAX_1D: usize = 65_536;
/// Largest .cube file read (a 129³ table as text is ~50 MB).
const MAX_FILE: u64 = 96 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LutKind {
    #[serde(rename = "1d")]
    OneD,
    #[serde(rename = "3d")]
    ThreeD,
}

#[derive(Debug, Clone)]
pub struct Lut {
    pub title: Option<String>,
    pub kind: LutKind,
    /// Entries per axis.
    pub size: usize,
    domain_min: [f32; 3],
    domain_max: [f32; 3],
    /// Output RGB; for 3D, red changes fastest (`r + g*n + b*n*n`).
    table: Vec<[f32; 3]>,
}

fn floats<const N: usize>(rest: &str, line: usize) -> Result<[f32; N], String> {
    let v: Vec<f32> = rest.split_whitespace().map(str::parse).collect::<Result<_, _>>().map_err(|_| format!("line {line}: expected {N} numbers"))?;
    v.try_into().map_err(|_| format!("line {line}: expected {N} numbers"))
}

impl Lut {
    /// A 3D table of `size` entries per axis computed from a colour function (components 0-1).
    pub fn from_fn(title: &str, size: usize, f: impl Fn([f32; 3]) -> [f32; 3]) -> Lut {
        let top = (size - 1) as f32;
        let mut table = Vec::with_capacity(size * size * size);
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    table.push(f([r as f32 / top, g as f32 / top, b as f32 / top]).map(|v| v.clamp(0.0, 1.0)));
                }
            }
        }
        Lut { title: Some(title.into()), kind: LutKind::ThreeD, size, domain_min: [0.0; 3], domain_max: [1.0; 3], table }
    }

    /// Parses a `.cube` file. Errors are short, user-facing reasons.
    pub fn parse(text: &str) -> Result<Lut, String> {
        let mut title = None;
        let (mut size1, mut size3) = (None, None);
        let (mut dmin, mut dmax) = ([0.0f32; 3], [1.0f32; 3]);
        let mut table = Vec::new();
        for (i, raw) in text.lines().enumerate() {
            let line = i + 1;
            let l = raw.trim();
            if l.is_empty() || l.starts_with('#') {
                continue;
            }
            let (key, rest) = l.split_once(char::is_whitespace).map(|(k, r)| (k, r.trim())).unwrap_or((l, ""));
            let size = |r: &str| r.parse::<usize>().map_err(|_| format!("line {line}: bad size"));
            match key {
                "TITLE" => title = Some(rest.trim_matches('"').to_string()).filter(|t| !t.is_empty()),
                "LUT_1D_SIZE" => size1 = Some(size(rest)?),
                "LUT_3D_SIZE" => size3 = Some(size(rest)?),
                "DOMAIN_MIN" => dmin = floats::<3>(rest, line)?,
                "DOMAIN_MAX" => dmax = floats::<3>(rest, line)?,
                // Resolve's older form: one range for all channels.
                "LUT_1D_INPUT_RANGE" | "LUT_3D_INPUT_RANGE" => {
                    let [a, b] = floats::<2>(rest, line)?;
                    (dmin, dmax) = ([a; 3], [b; 3]);
                }
                _ if key.starts_with(|c: char| c.is_ascii_alphabetic()) => {} // other keywords
                _ => table.push(floats::<3>(l, line)?),
            }
        }
        let (kind, size) = match (size1, size3) {
            (Some(_), Some(_)) => return Err("LUTs with both a 1D and a 3D table are not supported".into()),
            (None, None) => return Err("not a .cube LUT (no LUT_3D_SIZE or LUT_1D_SIZE)".into()),
            (Some(n), None) => (LutKind::OneD, n),
            (None, Some(n)) => (LutKind::ThreeD, n),
        };
        let (max, want) = match kind {
            LutKind::OneD => (MAX_1D, size),
            LutKind::ThreeD => (MAX_3D, size.saturating_pow(3)),
        };
        if !(2..=max).contains(&size) {
            return Err(format!("unsupported table size {size}"));
        }
        if table.len() != want {
            return Err(format!("the table has {} entries instead of {want}", table.len()));
        }
        if (0..3).any(|c| dmax[c] <= dmin[c]) {
            return Err("DOMAIN_MAX must be above DOMAIN_MIN".into());
        }
        Ok(Lut { title, kind, size, domain_min: dmin, domain_max: dmax, table })
    }

    /// The LUT's output for one colour (components 0-1), clamped to 0-1.
    pub fn map(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let top = (n - 1) as f32;
        let mut x = [0.0f32; 3];
        for c in 0..3 {
            x[c] = ((rgb[c] - self.domain_min[c]) / (self.domain_max[c] - self.domain_min[c])).clamp(0.0, 1.0) * top;
        }
        let out = match self.kind {
            LutKind::OneD => {
                let mut o = [0.0f32; 3];
                for c in 0..3 {
                    let i = (x[c] as usize).min(n - 2);
                    let f = x[c] - i as f32;
                    o[c] = self.table[i][c] + f * (self.table[i + 1][c] - self.table[i][c]);
                }
                o
            }
            LutKind::ThreeD => {
                let (r, g, b) = ((x[0] as usize).min(n - 2), (x[1] as usize).min(n - 2), (x[2] as usize).min(n - 2));
                let (fr, fg, fb) = (x[0] - r as f32, x[1] - g as f32, x[2] - b as f32);
                let at = |dr: usize, dg: usize, db: usize| self.table[(r + dr) + (g + dg) * n + (b + db) * n * n];
                let c000 = at(0, 0, 0);
                let c111 = at(1, 1, 1);
                // Tetrahedral: the cube splits into six tetrahedra along its diagonal; the
                // ordering of the fractions picks the one the colour falls in.
                let (a, fa, b2, fb2, fc) = if fr > fg {
                    if fg > fb {
                        (at(1, 0, 0), fr, at(1, 1, 0), fg, fb)
                    } else if fr > fb {
                        (at(1, 0, 0), fr, at(1, 0, 1), fb, fg)
                    } else {
                        (at(0, 0, 1), fb, at(1, 0, 1), fr, fg)
                    }
                } else if fb > fg {
                    (at(0, 0, 1), fb, at(0, 1, 1), fg, fr)
                } else if fb > fr {
                    (at(0, 1, 0), fg, at(0, 1, 1), fb, fr)
                } else {
                    (at(0, 1, 0), fg, at(1, 1, 0), fr, fb)
                };
                let mut o = [0.0f32; 3];
                for c in 0..3 {
                    o[c] = c000[c] + fa * (a[c] - c000[c]) + fb2 * (b2[c] - a[c]) + fc * (c111[c] - b2[c]);
                }
                o
            }
        };
        out.map(|v| v.clamp(0.0, 1.0))
    }

    /// Applies the LUT to every pixel, blended with the original by `intensity` (0-1). Alpha
    /// is kept. Split across the CPU cores (a 4K image takes a fraction of a second).
    pub fn apply(&self, img: &RgbaImage, intensity: f32) -> RgbaImage {
        let t = intensity.clamp(0.0, 1.0);
        let mut out = img.clone();
        if t == 0.0 {
            return out;
        }
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16);
        let row = img.width() as usize * 4;
        let rows_per = (img.height() as usize).div_ceil(threads).max(1);
        std::thread::scope(|s| {
            for chunk in out.chunks_mut(rows_per * row.max(1)) {
                s.spawn(move || {
                    for p in chunk.as_chunks_mut::<4>().0 {
                        let src = [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0];
                        let m = self.map(src);
                        for c in 0..3 {
                            p[c] = ((src[c] + t * (m[c] - src[c])) * 255.0).round() as u8;
                        }
                    }
                });
            }
        });
        out
    }
}

/// A LUT in the library, for the picker.
#[derive(Debug, Clone, Serialize)]
pub struct LutEntry {
    /// The LUT's id in the API: the file name without `.cube`, or `kokon:<key>` for a preset.
    pub name: String,
    /// The `.cube` file's TITLE; a preset's display name.
    pub title: Option<String>,
    pub kind: LutKind,
    pub size: usize,
    /// One of Kokon's presets (always listed, can't be removed).
    pub builtin: bool,
}

/// One of the looks Kokon ships.
pub struct Preset {
    pub key: &'static str,
    pub title: &'static str,
    look: fn([f32; 3]) -> [f32; 3],
}

const PRESET_PREFIX: &str = "kokon:";
const PRESET_SIZE: usize = 33;

fn luma([r, g, b]: [f32; 3]) -> f32 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

/// Per-channel gains, then the original luminance restored: a colour shift that keeps brightness.
fn tint(c: [f32; 3], gains: [f32; 3]) -> [f32; 3] {
    let t = [c[0] * gains[0], c[1] * gains[1], c[2] * gains[2]];
    let (l0, l1) = (luma(c), luma(t));
    if l1 <= 1e-6 { t } else { t.map(|v| v * l0 / l1) }
}

fn saturate(c: [f32; 3], s: f32) -> [f32; 3] {
    let l = luma(c);
    c.map(|v| l + (v - l) * s)
}

/// S-curve contrast around mid grey (`k` 0 = none, 1 = a full smoothstep).
fn contrast(c: [f32; 3], k: f32) -> [f32; 3] {
    c.map(|v| {
        let v = v.clamp(0.0, 1.0);
        v + k * (v * v * (3.0 - 2.0 * v) - v)
    })
}

/// Lifts the blacks to `lift` and lowers the whites to `1 - roll`.
fn fade(c: [f32; 3], lift: f32, roll: f32) -> [f32; 3] {
    c.map(|v| lift + v * (1.0 - lift - roll))
}

/// Kokon's presets, in the order the picker shows them.
pub const PRESETS: &[Preset] = &[
    // Qwen-Image tends to a warm, yellowish cast: pull it back towards neutral.
    Preset { key: "neutral", title: "Neutral (less yellow)", look: |c| tint(c, [0.97, 0.985, 1.08]) },
    Preset { key: "warm", title: "Warm", look: |c| tint(c, [1.06, 1.0, 0.9]) },
    Preset { key: "cool", title: "Cool", look: |c| tint(c, [0.93, 0.995, 1.09]) },
    Preset {
        key: "teal-orange",
        title: "Teal & Orange",
        look: |c| {
            let l = luma(c);
            let (sh, hi) = ((1.0 - l) * (1.0 - l), l * l);
            let t = [c[0] - 0.05 * sh + 0.05 * hi, c[1] + 0.01 * sh + 0.01 * hi, c[2] + 0.06 * sh - 0.06 * hi];
            contrast(saturate(t, 1.08), 0.12)
        },
    },
    Preset { key: "vivid", title: "Vivid", look: |c| contrast(saturate(c, 1.3), 0.2) },
    Preset { key: "soft-film", title: "Soft Film", look: |c| tint(fade(saturate(contrast(c, 0.15), 0.9), 0.04, 0.03), [1.02, 1.0, 0.97]) },
    Preset { key: "matte", title: "Matte", look: |c| fade(saturate(c, 0.85), 0.08, 0.04) },
    Preset { key: "black-white", title: "Black & White", look: |c| contrast([luma(c); 3], 0.2) },
];

fn preset(name: &str) -> Option<&'static Preset> {
    let key = name.strip_prefix(PRESET_PREFIX)?;
    PRESETS.iter().find(|p| p.key == key)
}

/// The LUTs the user has opened, copied into the app's data folder so they stay available
/// (`<data>/luts/<name>.cube`). Most recently used first; using one moves it to the top.
pub struct LutLibrary {
    dir: PathBuf,
}

/// How many LUTs the library keeps (the oldest beyond this are removed).
const KEEP: usize = 30;

/// A file name kept as the user wrote it (it is shown in the list), minus characters no file
/// system allows.
fn display_name(stem: &str) -> String {
    let s: String = stem.chars().map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { '-' } else { c }).take(100).collect();
    let s = s.trim().trim_matches('.').trim().to_string();
    if s.is_empty() { "LUT".into() } else { s }
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorCode::InvalidInput, msg)
}

impl LutLibrary {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, name: &str) -> AppResult<PathBuf> {
        if name.is_empty() || name.len() > 120 || name.contains(['/', '\\', ':']) || name.starts_with('.') {
            return Err(invalid(format!("Not a LUT name: {name}")));
        }
        Ok(self.dir.join(format!("{name}.cube")))
    }

    fn files(&self) -> Vec<(PathBuf, std::time::SystemTime)> {
        let mut v: Vec<_> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cube")))
            .map(|p| {
                let t = std::fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                (p, t)
            })
            .collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    }

    /// The user's LUTs, most recently used first (files that no longer parse are skipped),
    /// then Kokon's presets.
    pub fn list(&self) -> Vec<LutEntry> {
        let own = self.files().into_iter().filter_map(|(p, _)| {
            let name = p.file_stem()?.to_string_lossy().into_owned();
            let lut = Lut::parse(&std::fs::read_to_string(&p).ok()?).ok()?;
            Some(LutEntry { name, title: lut.title, kind: lut.kind, size: lut.size, builtin: false })
        });
        let presets = PRESETS.iter().map(|p| LutEntry { name: format!("{PRESET_PREFIX}{}", p.key), title: Some(p.title.into()), kind: LutKind::ThreeD, size: PRESET_SIZE, builtin: true });
        own.chain(presets).collect()
    }

    /// Copies a `.cube` file into the library (the same file opened again is not duplicated).
    pub fn import(&self, src: &Path) -> AppResult<LutEntry> {
        let meta = std::fs::metadata(src).map_err(|e| AppError::io("read the LUT", src, e))?;
        if !meta.is_file() || meta.len() > MAX_FILE {
            return Err(invalid("That file is not a .cube LUT Kokon can read."));
        }
        let bytes = std::fs::read(src).map_err(|e| AppError::io("read the LUT", src, e))?;
        let text = String::from_utf8_lossy(&bytes);
        let lut = Lut::parse(&text).map_err(|why| invalid(format!("This LUT can't be used: {why}.")))?;
        std::fs::create_dir_all(&self.dir).map_err(|e| AppError::io("create the LUT folder", &self.dir, e))?;
        let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let base = display_name(&stem);
        let mut name = base.clone();
        for i in 2.. {
            let p = self.path(&name)?;
            match std::fs::read(&p) {
                Ok(existing) if existing == bytes => break,
                Ok(_) => name = format!("{base}-{i}"),
                Err(_) => {
                    crate::engine::write_atomic(&p, &bytes)?;
                    break;
                }
            }
        }
        self.touch(&name);
        self.prune();
        Ok(LutEntry { name, title: lut.title, kind: lut.kind, size: lut.size, builtin: false })
    }

    pub fn load(&self, name: &str) -> AppResult<Lut> {
        if let Some(p) = preset(name) {
            return Ok(Lut::from_fn(p.title, PRESET_SIZE, p.look));
        }
        let p = self.path(name)?;
        let text = std::fs::read_to_string(&p).map_err(|_| AppError::new(ErrorCode::NotFound, format!("The LUT \"{name}\" is no longer in Kokon's LUT list.")))?;
        Lut::parse(&text).map_err(|why| invalid(format!("This LUT can't be used: {why}.")))
    }

    /// Moves a LUT to the top of the list.
    pub fn touch(&self, name: &str) {
        if let Ok(p) = self.path(name)
            && let Ok(f) = std::fs::File::options().append(true).open(&p)
        {
            let _ = f.set_modified(std::time::SystemTime::now());
        }
    }

    pub fn remove(&self, name: &str) -> AppResult<()> {
        if preset(name).is_some() {
            return Err(invalid("Kokon's own LUTs can't be removed."));
        }
        let p = self.path(name)?;
        match std::fs::remove_file(&p) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io("remove the LUT", &p, e)),
        }
    }

    fn prune(&self) {
        for (p, _) in self.files().into_iter().skip(KEEP) {
            let _ = std::fs::remove_file(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3D identity of size `n`, with each output passed through `f`.
    fn cube3(n: usize, f: impl Fn([f32; 3]) -> [f32; 3]) -> String {
        let mut s = format!("TITLE \"test\"\n# comment\nLUT_3D_SIZE {n}\n\n");
        let top = (n - 1) as f32;
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let o = f([r as f32 / top, g as f32 / top, b as f32 / top]);
                    s.push_str(&format!("{:.6} {:.6} {:.6}\n", o[0], o[1], o[2]));
                }
            }
        }
        s
    }

    fn close(a: [f32; 3], b: [f32; 3]) -> bool {
        (0..3).all(|c| (a[c] - b[c]).abs() < 1e-4)
    }

    #[test]
    fn identity_and_linear_luts_are_exact() {
        let id = Lut::parse(&cube3(17, |c| c)).unwrap();
        assert_eq!((id.kind, id.size, id.title.as_deref()), (LutKind::ThreeD, 17, Some("test")));
        let lin = Lut::parse(&cube3(5, |[r, g, b]| [0.5 * r + 0.25 * g, g, 1.0 - b])).unwrap();
        for c in [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.3, 0.7, 0.1], [0.91, 0.12, 0.55], [0.5, 0.5, 0.5]] {
            assert!(close(id.map(c), c), "{c:?}");
            // Tetrahedral interpolation reproduces any linear map exactly, between grid points too.
            let [r, g, b] = c;
            assert!(close(lin.map(c), [0.5 * r + 0.25 * g, g, 1.0 - b]), "{c:?} -> {:?}", lin.map(c));
        }
    }

    #[test]
    fn tetrahedral_interpolation_follows_the_diagonal() {
        // 2³ table, black everywhere except white at (1,1,1): along the grey axis the output
        // rises linearly (trilinear would give t³).
        let lut = Lut::parse(&cube3(2, |[r, g, b]| if r + g + b > 2.5 { [1.0; 3] } else { [0.0; 3] })).unwrap();
        assert!(close(lut.map([0.5, 0.5, 0.5]), [0.5; 3]));
        assert!(close(lut.map([0.8, 0.2, 0.2]), [0.2; 3]), "the smallest fraction sets the white share");
    }

    #[test]
    fn one_d_luts_and_domains() {
        let lut = Lut::parse("LUT_1D_SIZE 3\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n0 0 0\n0.5 0.5 1\n1 1 1\n").unwrap();
        assert_eq!(lut.kind, LutKind::OneD);
        // Input 1.0 is the middle of a 0-2 domain.
        assert!(close(lut.map([1.0, 0.5, 1.0]), [0.5, 0.25, 1.0]));
        let old = Lut::parse("LUT_3D_INPUT_RANGE 0 2\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
        assert!(close(old.map([1.0, 1.0, 1.0]), [0.5; 3]));
    }

    #[test]
    fn bad_files_say_why() {
        assert!(Lut::parse("hello").unwrap_err().contains("not a .cube"));
        assert!(Lut::parse("LUT_3D_SIZE 2\n0 0 0\n").unwrap_err().contains("1 entries instead of 8"));
        assert!(Lut::parse("LUT_3D_SIZE 2\n0 0\n").unwrap_err().contains("line 2"));
        assert!(Lut::parse("LUT_3D_SIZE 1000\n").unwrap_err().contains("size"));
        assert!(Lut::parse("LUT_1D_SIZE 2\nLUT_3D_SIZE 2\n").is_err());
        assert!(Lut::parse("LUT_1D_SIZE 2\nDOMAIN_MIN 1 1 1\nDOMAIN_MAX 0 0 0\n0 0 0\n1 1 1\n").is_err());
    }

    #[test]
    fn apply_blends_by_intensity_and_keeps_alpha() {
        let invert = Lut::parse(&cube3(9, |[r, g, b]| [1.0 - r, 1.0 - g, 1.0 - b])).unwrap();
        let img = RgbaImage::from_fn(37, 23, |x, y| image::Rgba([(x * 7) as u8, (y * 11) as u8, 200, (x + y) as u8]));
        let full = invert.apply(&img, 1.0);
        let half = invert.apply(&img, 0.5);
        assert_eq!(invert.apply(&img, 0.0), img);
        for (x, y, p) in img.enumerate_pixels() {
            let f = full.get_pixel(x, y);
            assert_eq!([f[0], f[1], f[2], f[3]], [255 - p[0], 255 - p[1], 55, p[3]]);
            assert!(half.get_pixel(x, y).0[..3].iter().all(|&v| (127..=128).contains(&v)));
        }
    }

    #[test]
    fn presets_are_listed_after_the_users_luts_and_behave() {
        let dir = tempfile::tempdir().unwrap();
        let lib = LutLibrary::new(dir.path().join("luts"));
        let list = lib.list();
        assert_eq!(list.len(), PRESETS.len(), "presets even with no LUT folder yet");
        assert!(list.iter().all(|e| e.builtin && e.name.starts_with("kokon:") && e.title.is_some()));
        let grey = [0.5, 0.5, 0.5];
        let get = |k: &str| lib.load(&format!("kokon:{k}")).unwrap();
        let n = get("neutral").map([0.8, 0.75, 0.55]);
        assert!(n[2] > 0.55 && n[0] < 0.8, "less yellow: {n:?}");
        let w = get("warm").map(grey);
        assert!(w[0] > w[2]);
        let c = get("cool").map(grey);
        assert!(c[2] > c[0]);
        let bw = get("black-white").map([0.9, 0.2, 0.4]);
        assert!((bw[0] - bw[1]).abs() < 1e-4 && (bw[1] - bw[2]).abs() < 1e-4);
        assert!(get("matte").map([0.0; 3])[0] > 0.05, "lifted blacks");
        for p in PRESETS {
            let lut = get(p.key);
            for v in [[0.0; 3], [1.0; 3], [0.2, 0.6, 0.9], grey] {
                assert!(lut.map(v).iter().all(|x| (0.0..=1.0).contains(x)), "{}", p.key);
            }
            // Mid grey stays roughly mid grey: looks, not exposure changes.
            assert!((luma(lut.map(grey)) - 0.5).abs() < 0.06, "{} {:?}", p.key, lut.map(grey));
        }
        assert!(lib.remove("kokon:warm").is_err());
        assert!(lib.load("kokon:nope").is_err());
        // A user's own file comes first.
        let src = dir.path().join("Mine.cube");
        std::fs::write(&src, cube3(2, |c| c)).unwrap();
        lib.import(&src).unwrap();
        let list = lib.list();
        assert_eq!((list[0].name.as_str(), list[0].builtin), ("Mine", false));
        assert_eq!(list.len(), PRESETS.len() + 1);
    }

    #[test]
    fn library_imports_lists_recent_first_and_removes() {
        let dir = tempfile::tempdir().unwrap();
        let lib = LutLibrary::new(dir.path().join("luts"));
        let src = dir.path().join("Warm Film.cube");
        std::fs::write(&src, cube3(2, |c| c)).unwrap();
        let a = lib.import(&src).unwrap();
        assert_eq!(a.name, "Warm Film");
        assert_eq!(lib.import(&src).unwrap().name, "Warm Film", "the same file is not copied twice");
        // Another file with the same name gets its own entry.
        let other = dir.path().join("sub");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("Warm Film.cube"), cube3(3, |c| c)).unwrap();
        let b = lib.import(&other.join("Warm Film.cube")).unwrap();
        assert_eq!(b.name, "Warm Film-2");
        std::thread::sleep(std::time::Duration::from_millis(20));
        lib.touch("Warm Film");
        let names: Vec<_> = lib.list().into_iter().filter(|e| !e.builtin).map(|e| e.name).collect();
        assert_eq!(names, ["Warm Film", "Warm Film-2"]);
        assert_eq!(lib.load("Warm Film-2").unwrap().size, 3);
        lib.remove("Warm Film").unwrap();
        assert_eq!(lib.list().iter().filter(|e| !e.builtin).count(), 1);
        assert!(lib.load("../secret").is_err());
        assert_eq!(display_name(" a:b?.cube. "), "a-b-.cube");
        let bad = dir.path().join("bad.cube");
        std::fs::write(&bad, "LUT_3D_SIZE 2\n0 0 0\n").unwrap();
        assert!(lib.import(&bad).unwrap_err().message.contains("can't be used"));
    }
}
