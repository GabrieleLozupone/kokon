//! What the first-run wizard installs: the stable-diffusion.cpp build the app was verified
//! with, the official Qwen-Image 2.1 Turbo weights, and the VRAM presets that choose between them.
//!
//! Every file is pinned by URL, size and SHA-256 (from the Hugging Face / GitHub APIs,
//! 2026-10-08; engines and upscaler 2026-10-12). If a link moves, the wizard reports it and
//! asks the user to download the file by hand from `page` and to open an issue at [`ISSUES_URL`].

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::config::{GpuBackend, TextEncoderPlacement};

/// Where users report broken download links. Set before publishing the repository.
pub const ISSUES_URL: &str = "https://github.com/GabrieleLozupone/kokon/issues/new";

/// Folder under the stable-diffusion.cpp folder that holds the Qwen weights.
pub const MODEL_SUBDIR: &str = "models/qwen21";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// stable-diffusion.cpp binaries (a zip extracted into the folder).
    Engine,
    Model,
}

/// Release of the engine builds below. Written into [`ENGINE_MARKER`] after extraction, so an
/// engine of another release (files present, marker missing or different) is updated. A newer
/// release published in the engine manifest replaces these at runtime ([`engine_tag`]).
pub const ENGINE_TAG: &str = "kokon-992-dfaab76";
/// File in an engine's folder naming the release it was extracted from.
pub const ENGINE_MARKER: &str = "kokon-engine.txt";

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Download {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: FileKind,
    pub url: &'static str,
    /// Tried in order when `url` fails for good (moved link, refused, changed file).
    pub fallback_urls: &'static [&'static str],
    /// Page where the file can be downloaded by hand when `url` stops working.
    pub page: &'static str,
    pub size: u64,
    pub sha256: &'static str,
    /// Destination relative to the stable-diffusion.cpp folder (for a zip: the archive path,
    /// extracted into its own folder and then deleted).
    pub dest: &'static str,
    /// Files a zip provides (relative to the stable-diffusion.cpp folder); their presence
    /// means it is installed.
    pub provides: &'static [&'static str],
    /// For an engine zip: the release its folder must be marked with ([`ENGINE_MARKER`]).
    pub engine_tag: Option<&'static str>,
}

/// `base` + a catalog path written with `/`, as native components. An absolute path (a model
/// downloaded into a folder of the user's, [`Download::at`]) is used as is.
pub fn join_rel(base: &Path, rel: &str) -> PathBuf {
    if Path::new(rel).is_absolute() {
        return PathBuf::from(rel);
    }
    rel.split('/').filter(|c| !c.is_empty()).fold(base.to_path_buf(), |p, c| p.join(c))
}

impl Download {
    pub fn is_zip(&self) -> bool {
        !self.provides.is_empty()
    }

    pub fn path(&self, sdcpp_dir: &Path) -> PathBuf {
        join_rel(sdcpp_dir, self.dest)
    }

    /// The file name it is saved under.
    pub fn file_name(&self) -> &'static str {
        self.dest.rsplit('/').next().unwrap_or(self.dest)
    }

    /// The same file, saved at `path` (anywhere) instead of the stable-diffusion.cpp folder.
    pub fn at(self, path: &Path) -> Download {
        Download { dest: Box::leak(path.to_string_lossy().into_owned().into_boxed_str()), ..self }
    }

    /// Every URL to try, in order.
    pub fn urls(&self) -> impl Iterator<Item = &'static str> {
        std::iter::once(self.url).chain(self.fallback_urls.iter().copied())
    }

    /// Installed: a zip's files exist (an engine's folder also carries its release marker), or
    /// the file exists with the expected size. The hash is checked after every download; a
    /// size match is enough for files already on disk.
    pub fn is_present(&self, sdcpp_dir: &Path) -> bool {
        if self.is_zip() {
            let files = self.provides.iter().all(|f| join_rel(sdcpp_dir, f).is_file());
            return files && self.engine_tag.is_none_or(|t| self.installed_tag(sdcpp_dir).as_deref() == Some(t));
        }
        std::fs::metadata(self.path(sdcpp_dir)).map(|m| m.is_file() && m.len() == self.size).unwrap_or(false)
    }

    /// The release an engine folder is marked with, if any.
    pub fn installed_tag(&self, sdcpp_dir: &Path) -> Option<String> {
        std::fs::read_to_string(zip_dir(self, sdcpp_dir).join(ENGINE_MARKER)).ok().map(|s| s.trim().to_string())
    }

    /// Marks an extracted engine with its release.
    pub fn write_tag(&self, sdcpp_dir: &Path) -> std::io::Result<()> {
        match self.engine_tag {
            Some(t) => std::fs::write(zip_dir(self, sdcpp_dir).join(ENGINE_MARKER), t),
            None => Ok(()),
        }
    }
}

/// Kokon's engine release: every engine is built from branch `kokon` of Kokon's
/// stable-diffusion.cpp fork (upstream plus the prompt enhancer's text generation and Kokon's
/// fixes) by `.github/workflows/kokon.yml`, with upstream's flags otherwise. CUDA builds use CUDA
/// graphs (ggml from Kokon's fork). Linux builds on Ubuntu 22.04 (smoke-tested on Ubuntu
/// 22.04/24.04, Debian 12, Fedora 40/42); macOS for 15.0 (upstream's Mac zip needs macOS 26).
/// Sizes and SHA-256 from GitHub's asset digests.
const KOKON_RELEASE: &str = "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/tag/kokon-992-dfaab76";
/// Upstream release the Windows CUDA runtime comes from (CUDA 12.8.1, the version the engines
/// are built with).
#[cfg(not(target_os = "linux"))]
const SDCPP_UPSTREAM_RELEASE: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-929-3f8527a";
/// Release the Linux CUDA runtime comes from (CUDA 12.8).
#[cfg(target_os = "linux")]
const KOKON_LINUX_RELEASE: &str = "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/tag/kokon-linux-1d0a58a";

/// CUDA 12 build; it runs on GTX 10xx to RTX 50xx.
#[cfg(not(target_os = "linux"))]
pub const ENGINE_CUDA: Download = Download {
    id: "engine_cuda",
    label: "stable-diffusion.cpp (CUDA 12)",
    kind: FileKind::Engine,
    url: "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-992-dfaab76/sd-kokon-dfaab76-bin-win-cuda12-x64.zip",
    fallback_urls: &[],
    page: KOKON_RELEASE,
    size: WIN_CUDA_SIZE,
    sha256: WIN_CUDA_SHA256,
    dest: "sd-kokon-dfaab76-bin-win-cuda12-x64.zip",
    provides: &["sd-server.exe", "stable-diffusion.dll", "ggml-cuda.dll"],
    engine_tag: Some(ENGINE_TAG),
};

/// CUDA 12.8.1, unchanged since the upstream release: no marker, never downloaded again.
#[cfg(not(target_os = "linux"))]
pub const CUDA_RUNTIME: Download = Download {
    id: "cuda_runtime",
    label: "CUDA 12 runtime (cuBLAS)",
    kind: FileKind::Engine,
    url: "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/cudart-sd-bin-win-cu12-x64.zip",
    fallback_urls: &[],
    page: SDCPP_UPSTREAM_RELEASE,
    size: 563_452_046,
    sha256: "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
    dest: "cudart-sd-bin-win-cu12-x64.zip",
    provides: &["cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
    engine_tag: None,
};

/// Same commit, Vulkan build: AMD, Intel and NVIDIA cards through the GPU driver's Vulkan
/// runtime (nothing else to install). Kept in its own folder so it can sit next to the
/// CUDA build.
#[cfg(not(target_os = "linux"))]
pub const ENGINE_VULKAN: Download = Download {
    id: "engine_vulkan",
    label: "stable-diffusion.cpp (Vulkan)",
    kind: FileKind::Engine,
    url: "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-992-dfaab76/sd-kokon-dfaab76-bin-win-vulkan-x64.zip",
    fallback_urls: &[],
    page: KOKON_RELEASE,
    size: WIN_VULKAN_SIZE,
    sha256: WIN_VULKAN_SHA256,
    dest: "engine-vulkan/sd-kokon-dfaab76-bin-win-vulkan-x64.zip",
    provides: &["engine-vulkan/sd-server.exe", "engine-vulkan/stable-diffusion.dll", "engine-vulkan/ggml-vulkan.dll"],
    engine_tag: Some(ENGINE_TAG),
};

/// Linux builds (upstream's Linux zips need glibc 2.38 and have no CUDA variant). The libraries
/// find each other and the CUDA runtime next to them (RPATH `$ORIGIN`).
#[cfg(target_os = "linux")]
pub const ENGINE_CUDA: Download = Download {
    id: "engine_cuda",
    label: "stable-diffusion.cpp (CUDA 12)",
    kind: FileKind::Engine,
    url: "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-992-dfaab76/sd-kokon-dfaab76-bin-Linux-Ubuntu-22.04-x86_64-cuda12.zip",
    fallback_urls: &[],
    page: KOKON_RELEASE,
    size: LINUX_CUDA_SIZE,
    sha256: LINUX_CUDA_SHA256,
    dest: "sd-kokon-dfaab76-bin-Linux-Ubuntu-22.04-x86_64-cuda12.zip",
    provides: &["sd-server", "libstable-diffusion.so", "libggml-cuda.so"],
    engine_tag: Some(ENGINE_TAG),
};

/// CUDA 12.8 runtime libraries (NVIDIA redistributables), next to the CUDA engine. Unchanged
/// since kokon-linux-1d0a58a: no marker, never downloaded again.
#[cfg(target_os = "linux")]
pub const CUDA_RUNTIME: Download = Download {
    id: "cuda_runtime",
    label: "CUDA 12 runtime (cuBLAS)",
    kind: FileKind::Engine,
    url: "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-linux-1d0a58a/cudart-sd-bin-linux-cu12-x64.zip",
    fallback_urls: &[],
    page: KOKON_LINUX_RELEASE,
    size: 593_744_419,
    sha256: "5b05f377ed203691ad22b471697efccd5c304ee0c6cc6f06c1acabcaa121f097",
    dest: "cudart-sd-bin-linux-cu12-x64.zip",
    provides: &["libcudart.so.12", "libcublas.so.12", "libcublasLt.so.12"],
    engine_tag: None,
};

#[cfg(target_os = "linux")]
pub const ENGINE_VULKAN: Download = Download {
    id: "engine_vulkan",
    label: "stable-diffusion.cpp (Vulkan)",
    kind: FileKind::Engine,
    url: "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-992-dfaab76/sd-kokon-dfaab76-bin-Linux-Ubuntu-22.04-x86_64-vulkan.zip",
    fallback_urls: &[],
    page: KOKON_RELEASE,
    size: LINUX_VULKAN_SIZE,
    sha256: LINUX_VULKAN_SHA256,
    dest: "engine-vulkan/sd-kokon-dfaab76-bin-Linux-Ubuntu-22.04-x86_64-vulkan.zip",
    provides: &["engine-vulkan/sd-server", "engine-vulkan/libstable-diffusion.so", "engine-vulkan/libggml-vulkan.so"],
    engine_tag: Some(ENGINE_TAG),
};

/// macOS 15+, universal binary with the Metal shaders embedded. Ad-hoc signed; downloaded by the
/// app (not a browser) it gets no quarantine flag.
pub const ENGINE_METAL: Download = Download {
    id: "engine_metal",
    label: "stable-diffusion.cpp (Metal)",
    kind: FileKind::Engine,
    url: "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-992-dfaab76/sd-kokon-dfaab76-bin-Darwin-macOS-15.0-universal.zip",
    fallback_urls: &[],
    page: KOKON_RELEASE,
    size: MACOS_METAL_SIZE,
    sha256: MACOS_METAL_SHA256,
    dest: "engine-metal/sd-kokon-dfaab76-bin-Darwin-macOS-15.0-universal.zip",
    provides: &["engine-metal/sd-server", "engine-metal/libstable-diffusion.dylib"],
    engine_tag: Some(ENGINE_TAG),
};

// From the kokon-992-dfaab76 release (GitHub asset digests, run 39228893955).
#[cfg(not(target_os = "linux"))]
const WIN_CUDA_SIZE: u64 = 343_689_852;
#[cfg(not(target_os = "linux"))]
const WIN_CUDA_SHA256: &str = "d4655d52d28cc8c60e01d11b6ef443671befad6731d68ff7bf75e56b5c324a10";
#[cfg(not(target_os = "linux"))]
const WIN_VULKAN_SIZE: u64 = 29_407_760;
#[cfg(not(target_os = "linux"))]
const WIN_VULKAN_SHA256: &str = "856310e71bec67a3323013d07af0cff48a73b915e2a95fe485070e9bfb8303f4";
#[cfg(target_os = "linux")]
const LINUX_CUDA_SIZE: u64 = 352_447_322;
#[cfg(target_os = "linux")]
const LINUX_CUDA_SHA256: &str = "6977f8d57acdc551bdaf3471aeca3076989717f16a8464ea0bfefbccab2adc65";
#[cfg(target_os = "linux")]
const LINUX_VULKAN_SIZE: u64 = 37_904_697;
#[cfg(target_os = "linux")]
const LINUX_VULKAN_SHA256: &str = "3a45ef1f2c4ea128d03edbcf162017fb1b6ff8bb2a8997a957a66879ba8b3842";
const MACOS_METAL_SIZE: u64 = 36_587_314;
const MACOS_METAL_SHA256: &str = "af7e6b376cca3cf86fffafc1efb48ddfc480bbf34364f6d648a3388dc7f1b07d";

/// The engine files of a backend, in download order: the engine manifest's release when one
/// newer than the built-in pins was applied ([`apply_engine_release`]), else the pins.
pub fn engine_downloads(backend: GpuBackend) -> Vec<Download> {
    let o = *ENGINE_OVERRIDE.read().unwrap();
    let (cuda, vulkan, metal) = o.map(|r| (r.cuda, r.vulkan, r.metal)).unwrap_or((ENGINE_CUDA, ENGINE_VULKAN, ENGINE_METAL));
    match backend {
        GpuBackend::Cuda => vec![cuda, CUDA_RUNTIME],
        GpuBackend::Vulkan => vec![vulkan],
        GpuBackend::Metal => vec![metal],
    }
}

/// The engine release the app wants installed: the manifest's, or [`ENGINE_TAG`].
pub fn engine_tag() -> &'static str {
    ENGINE_OVERRIDE.read().unwrap().map(|r| r.tag).unwrap_or(ENGINE_TAG)
}

#[derive(Debug, Clone, Copy)]
struct EngineRelease {
    tag: &'static str,
    cuda: Download,
    vulkan: Download,
    metal: Download,
}

static ENGINE_OVERRIDE: std::sync::RwLock<Option<EngineRelease>> = std::sync::RwLock::new(None);

/// Tests that change or depend on the engine override take this lock.
#[cfg(test)]
pub(crate) static ENGINE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// One engine build in the manifest.
#[derive(Debug, Clone, PartialEq, serde::Deserialize, Serialize)]
pub struct ManifestAsset {
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

/// A release of Kokon's engines (`kokon-<n>-<commit>` in Kokon's stable-diffusion.cpp fork).
#[derive(Debug, Clone, PartialEq, serde::Deserialize, Serialize)]
pub struct KokonEngines {
    pub tag: String,
    /// Oldest app version the release works with (older apps ignore it).
    pub min_app: String,
    pub win_cuda: ManifestAsset,
    pub win_vulkan: ManifestAsset,
    pub linux_cuda: ManifestAsset,
    pub linux_vulkan: ManifestAsset,
    pub macos: ManifestAsset,
}

/// `engine.json` in the Kokon repository: the newest engine release tested with Kokon. Lets a
/// tested engine reach users without an app release. Apps from 0.10 read only the `kokon` entry;
/// the file's other keys (an upstream release) serve apps up to 0.9.4, which ignore this one.
#[derive(Debug, Clone, Default, PartialEq, serde::Deserialize, Serialize)]
pub struct EngineManifest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kokon: Option<KokonEngines>,
}

/// Build number of a Kokon engine release tag (`kokon-992-dfaab76` -> 992).
pub fn release_number(tag: &str) -> Option<u32> {
    tag.strip_prefix("kokon-")?.split('-').next()?.parse().ok()
}

fn version_tuple(v: &str) -> Option<(u32, u32, u32)> {
    let mut it = v.trim().trim_start_matches('v').split(['.', '-']).map(|p| p.parse::<u32>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

/// Uses the manifest's Kokon release as the engine release when it is valid, meant for
/// `app_version`, and newer than the built-in pins (an app update that pins a newer engine is
/// never downgraded by an old manifest). Returns whether it is now in use.
pub fn apply_engine_release(m: &EngineManifest, app_version: &str) -> Result<bool, String> {
    let Some(k) = &m.kokon else {
        *ENGINE_OVERRIDE.write().unwrap() = None;
        return Ok(false);
    };
    let (Some(n), Some(builtin)) = (release_number(&k.tag), release_number(ENGINE_TAG)) else {
        return Err(format!("not a Kokon engine release tag: {}", k.tag));
    };
    if version_tuple(app_version) < version_tuple(&k.min_app) || version_tuple(&k.min_app).is_none() {
        return Ok(false);
    }
    if n <= builtin {
        *ENGINE_OVERRIDE.write().unwrap() = None;
        return Ok(false);
    }
    let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
    let tag = leak(k.tag.clone());
    let commit = k.tag.rsplit('-').next().unwrap_or_default();
    let release = format!("https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/{}/", k.tag);
    let page = leak(format!("https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/tag/{}", k.tag));
    let prefix = format!("sd-kokon-{commit}-bin-");
    let build = |a: &ManifestAsset, base: Download, folder: &str| -> Result<Download, String> {
        let file = a
            .url
            .strip_prefix(&release)
            .filter(|f| f.starts_with(&prefix) && f.ends_with(".zip") && !f.contains(['/', '\\']))
            .ok_or_else(|| format!("unexpected engine URL: {}", a.url))?;
        if a.sha256.len() != 64 || !a.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) || a.size == 0 {
            return Err(format!("bad size or SHA-256 for {}", a.url));
        }
        Ok(Download { url: leak(a.url.clone()), page, size: a.size, sha256: leak(a.sha256.clone()), dest: leak(format!("{folder}{file}")), engine_tag: Some(tag), ..base })
    };
    // Every build is checked, whatever the platform: a manifest is good or ignored as a whole.
    let win = (build(&k.win_cuda, ENGINE_CUDA, "")?, build(&k.win_vulkan, ENGINE_VULKAN, "engine-vulkan/")?);
    let linux = (build(&k.linux_cuda, ENGINE_CUDA, "")?, build(&k.linux_vulkan, ENGINE_VULKAN, "engine-vulkan/")?);
    let metal = build(&k.macos, ENGINE_METAL, "engine-metal/")?;
    let (cuda, vulkan) = if cfg!(target_os = "linux") { linux } else { win };
    *ENGINE_OVERRIDE.write().unwrap() = Some(EngineRelease { tag, cuda, vulkan, metal });
    Ok(true)
}

const QWEN_TE: &str = "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/tree/main";

const TURBO_GGUF: &str = "https://huggingface.co/DogukanUrker/Qwen-Image-2.1-Turbo-GGUF";

/// The image model: Qwen's official 8-step distilled Qwen-Image 2.1 (Qwen/Qwen-Image-2.1-Turbo,
/// Qwen Research License like the base model), as a GGUF converted with stable-diffusion.cpp.
/// Same-seed A/B on an RTX 5070 Ti (2026-10-10): ~2x faster than the 20-step base model at
/// equal quality, faithful edits. The base Qwen-Image 2.1 weights were dropped on 2026-10-09.
/// Every preset uses this 4-bit file (user choice, 2026-10-09; the repo's Q4_K was judged
/// almost identical to its Q8_0).
pub const TURBO_Q4_K: Download = Download {
    id: "turbo_q4_k",
    label: "Qwen-Image 2.1 Turbo Q4_K",
    kind: FileKind::Model,
    url: "https://huggingface.co/DogukanUrker/Qwen-Image-2.1-Turbo-GGUF/resolve/main/qwen-image-2.1-turbo-Q4_K.gguf",
    fallback_urls: &[],
    page: TURBO_GGUF,
    size: 4_050_916_384,
    sha256: "f8d5611b495848b632f8ae14dc7da6525fe2796eb80998f8dee5e04d0a2f69eb",
    dest: "models/qwen21/qwen-image-2.1-turbo-Q4_K.gguf",
    provides: &[],
    engine_tag: None,
};

/// The VAE of new installs (0.9.3): Qwen's VAE with the decoder fine-tuned by madebyollin
/// (author of TAESD) to remove the 2-px checkerboard of the original (#21). Same tensors and
/// shapes, Qwen Research License like the model. Same-seed A/B on 5 cases at 1536² (2026-10-16):
/// checkerboard 10–48% → 1–4% (coherent 2-px amplitude, noise ≈ 2–3%), slightly more fine
/// detail, colours within 1/255, same speed.
pub const VAE: Download = Download {
    id: "vae",
    label: "Qwen-Image 2.1 VAE (texture fix)",
    kind: FileKind::Model,
    url: "https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1/resolve/main/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors",
    fallback_urls: &[],
    page: "https://huggingface.co/madebyollin/texture-fix-vae-for-qwen-image-2.1",
    size: 675_509_688,
    sha256: "36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908",
    dest: "models/qwen21/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors",
    provides: &[],
    engine_tag: None,
};

/// Qwen's original VAE, installed up to 0.9.2. Kept while its owner has not chosen the texture
/// fix ([`official_vae`]); deleted once they have ([`unused_original_vae`]).
pub const VAE_ORIGINAL: Download = Download {
    id: "vae_original",
    label: "Qwen-Image 2.1 VAE",
    kind: FileKind::Model,
    url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors",
    fallback_urls: &[],
    page: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/main/vae",
    size: 675_509_688,
    sha256: "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9",
    dest: "models/qwen21/qwen_image_2.1_vae_bf16.safetensors",
    provides: &[],
    engine_tag: None,
};

/// The VAE the official files use in `sdcpp_dir`: the texture fix once it is there, else the
/// original of an earlier install (its owner has not accepted the new one), else the texture
/// fix to download. Updating is the user's choice, so nothing here downloads it uninvited.
pub fn official_vae(sdcpp_dir: &Path) -> Download {
    if !VAE.is_present(sdcpp_dir) && VAE_ORIGINAL.is_present(sdcpp_dir) { VAE_ORIGINAL } else { VAE }
}

/// The original VAE in the app's own folder once the texture fix replaced it: no profile
/// uses it any more, so it can be deleted.
pub fn unused_original_vae(cfg: &crate::config::AppConfig) -> Option<PathBuf> {
    let old = VAE_ORIGINAL.path(&cfg.sdcpp_dir);
    let used = cfg.profiles.iter().any(|p| p.vae == old);
    (VAE.is_present(&cfg.sdcpp_dir) && !used && old.is_file()).then_some(old)
}

/// Text encoder from Qwen's own GGUF repository (the one sd.cpp's docs point to).
pub const TEXT_ENCODER_Q4_K_M: Download = Download {
    id: "text_encoder_q4_k_m",
    label: "Qwen3-VL 8B text encoder Q4_K_M",
    kind: FileKind::Model,
    url: "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
    fallback_urls: &[],
    page: QWEN_TE,
    size: 5_027_784_800,
    sha256: "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
    dest: "models/qwen21/Qwen3VL-8B-Instruct-Q4_K_M.gguf",
    provides: &[],
    engine_tag: None,
};

pub const TEXT_ENCODER_Q8_0: Download = Download {
    id: "text_encoder_q8_0",
    label: "Qwen3-VL 8B text encoder Q8_0",
    kind: FileKind::Model,
    url: "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/Qwen3VL-8B-Instruct-Q8_0.gguf",
    fallback_urls: &[],
    page: QWEN_TE,
    size: 8_709_519_456,
    sha256: "0d264b3941185d00a74f75c4245521dae088ff1efc90ab8d1754e83f5844adb0",
    dest: "models/qwen21/Qwen3VL-8B-Instruct-Q8_0.gguf",
    provides: &[],
    engine_tag: None,
};

/// Vision projector: lets the text encoder see reference images (needed for editing).
pub const VISION_PROJECTOR: Download = Download {
    id: "vision_projector",
    label: "Qwen3-VL vision projector",
    kind: FileKind::Model,
    url: "https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-8B-Instruct-F16.gguf",
    fallback_urls: &[],
    page: QWEN_TE,
    size: 1_159_029_824,
    sha256: "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
    dest: "models/qwen21/mmproj-Qwen3VL-8B-Instruct-F16.gguf",
    provides: &[],
    engine_tag: None,
};

/// Name sd-server knows the upscaler by (its file stem in `--hires-upscalers-dir`).
pub const UPSCALER_NAME: &str = "4xNomos2_hq_mosr";
/// Folder of the upscaler, relative to the stable-diffusion.cpp folder.
pub const UPSCALERS_SUBDIR: &str = "models/upscalers";

/// 4xNomos2_hq_mosr by Philip Hofmann (CC BY 4.0), a MoSR model: enlarges results and runs
/// Upscale. Replaced the ESRGAN models on 2026-10-12: more natural skin, hair and text, and
/// ~8x faster than UltraSharp on an RTX 5070 Ti. Bundled with the app (copied into place at
/// start, see `installer::install_bundled`); downloaded from our mirror, then the author's
/// release, only when that copy is missing.
pub const UPSCALER: Download = Download {
    id: "upscaler",
    label: "4xNomos2 MoSR upscaler",
    kind: FileKind::Model,
    url: "https://github.com/GabrieleLozupone/kokon/releases/download/models-1/4xNomos2_hq_mosr.pth",
    fallback_urls: &["https://github.com/Phhofm/models/releases/download/4xNomos2_hq_mosr/4xNomos2_hq_mosr.pth"],
    page: "https://github.com/Phhofm/models/releases/tag/4xNomos2_hq_mosr",
    size: 17_213_494,
    sha256: "c60dbfc7e6f7d27e03517d1bec3f3cbd16e8cd4288eefd1358952f73f8497ddc",
    dest: "models/upscalers/4xNomos2_hq_mosr.pth",
    provides: &[],
    engine_tag: None,
};

const ESRGAN_MODELS: &str = "https://huggingface.co/uwg/upscaler/tree/main/ESRGAN";

/// 4x_NMKD-Superscale-SP_178000_G by Nmkd (ESRGAN, WTFPL): the default upscaler since
/// 2026-10-12. Sharper and more natural than UltraSharp on most renders; can draw a faint grid
/// on JPEG blocks and dark areas (`AppConfig::upscale_blend` tones it down).
pub const SUPERSCALE: Download = Download {
    id: "upscaler_superscale",
    label: "Superscale-SP upscaler",
    kind: FileKind::Model,
    url: "https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x_NMKD-Superscale-SP_178000_G.pth",
    fallback_urls: &[],
    page: ESRGAN_MODELS,
    size: 66_958_607,
    sha256: "1d1b0078fe71446e0469d8d4df59e96baa80d83cda600d68237d655830821bcc",
    dest: "models/upscalers/4x_NMKD-Superscale-SP_178000_G.pth",
    provides: &[],
    engine_tag: None,
};

/// 4x-UltraSharp by Kim2091 (ESRGAN, CC BY-NC-SA 4.0: non-commercial): the default before
/// 2026-10-12, now an optional download (very clean, but smooths skin into an AI look and can
/// invent lines).
pub const ULTRASHARP: Download = Download {
    id: "upscaler_ultrasharp",
    label: "UltraSharp upscaler",
    kind: FileKind::Model,
    url: "https://huggingface.co/uwg/upscaler/resolve/main/ESRGAN/4x-UltraSharp.pth",
    fallback_urls: &[],
    page: ESRGAN_MODELS,
    size: 66_961_958,
    sha256: "a5812231fc936b42af08a5edba784195495d303d5b3248c24489ef0c4021fe01",
    dest: "models/upscalers/4x-UltraSharp.pth",
    provides: &[],
    engine_tag: None,
};

/// Every upscaler model Kokon can install, in the order Settings lists them.
pub const UPSCALER_DOWNLOADS: &[Download] = &[SUPERSCALE, UPSCALER, ULTRASHARP];

/// The download of the upscaler named `name` (file stem).
pub fn upscaler_download(name: &str) -> Option<Download> {
    UPSCALER_DOWNLOADS.iter().copied().find(|d| d.dest.rsplit('/').next().and_then(|f| f.rsplit_once('.')).is_some_and(|(stem, _)| stem == name))
}

/// Upscaler files Settings offers to delete when they are not the selected model (in the
/// app's own folder only).
pub const LEGACY_UPSCALERS: &[&str] = &["models/upscalers/4x-UltraSharp.pth", "models/upscalers/4x_NMKD-Superscale-SP_178000_G.pth"];

/// Hardware presets: which weights to download and how to run them, by VRAM.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    /// Smallest reported VRAM (MiB) this preset is recommended for.
    pub min_vram_mib: u64,
    /// Name on a Mac: the unified memory sizes it is chosen for (through
    /// `planner::unified_memory_planning_mib`), since "12 GB" would read as RAM there.
    pub unified_label: &'static str,
    /// `summary` for a Mac (no "system RAM": it is the same memory).
    pub unified_summary: &'static str,
    /// The image model (a Turbo quantization).
    pub diffusion: Download,
    pub text_encoder: Download,
    pub text_encoder_placement: TextEncoderPlacement,
    /// Free VRAM sd-server leaves out of its budget (`--max-vram -N`). CUDA loads a kernel's code
    /// on first use, outside that budget: on an emulated 8 GB card 1 GiB left too little and the
    /// first job after every start crashed ("shared object initialization failed"); 1.5 GiB ran
    /// clean with the prompt enhancer still fully on the GPU (2026-10-19).
    pub vram_reserve_gib: f32,
    /// Measured on real hardware of this class (otherwise only derived).
    pub verified: bool,
    pub summary: &'static str,
}

/// Ordered by VRAM. Cards report a bit less than their nominal size (16 GB → 16303 MiB),
/// so thresholds sit between classes.
pub const PRESETS: &[Preset] = &[
    // Beta (0.9.3): the 12 GB files, with the planner's smaller working sizes. Emulated 8 GB on a
    // 5070 Ti ran every mode without running out of memory (2026-10-14); users report it works
    // on an RTX 3060 Ti and an RTX 5050 Laptop (1–2 min per edit). Not offered on Macs, whose
    // 16 GB models plan below this and stay on the 12 GB preset's Mac name.
    Preset {
        id: "8gb",
        label: "8 GB (beta)",
        unified_label: "",
        unified_summary: "",
        min_vram_mib: 0,
        diffusion: TURBO_Q4_K,
        text_encoder: TEXT_ENCODER_Q4_K_M,
        text_encoder_placement: TextEncoderPlacement::Ram,
        vram_reserve_gib: 1.5,
        verified: false,
        summary: "4-bit model; text encoder in system RAM; images of about 1 megapixel",
    },
    Preset {
        id: "12gb",
        label: "12 GB",
        unified_label: "16–24 GB Mac",
        unified_summary: "4-bit image model and text encoder; images of about 1–1.5 megapixels",
        min_vram_mib: 10 * 1024,
        diffusion: TURBO_Q4_K,
        text_encoder: TEXT_ENCODER_Q4_K_M,
        text_encoder_placement: TextEncoderPlacement::Ram,
        vram_reserve_gib: 1.0,
        verified: true,
        summary: "4-bit model; text encoder in system RAM; smaller working sizes",
    },
    Preset {
        id: "16gb",
        label: "16 GB",
        unified_label: "32–36 GB Mac",
        unified_summary: "4-bit image model and text encoder; native 2K for Quality",
        min_vram_mib: 14 * 1024,
        diffusion: TURBO_Q4_K,
        text_encoder: TEXT_ENCODER_Q4_K_M,
        text_encoder_placement: TextEncoderPlacement::Ram,
        vram_reserve_gib: 1.0,
        verified: true,
        summary: "4-bit model; text encoder in system RAM; native 2K for Quality",
    },
    Preset {
        id: "24gb",
        label: "24 GB",
        unified_label: "48 GB Mac",
        unified_summary: "4-bit image model and text encoder; larger edits fit",
        min_vram_mib: 20 * 1024,
        diffusion: TURBO_Q4_K,
        text_encoder: TEXT_ENCODER_Q4_K_M,
        text_encoder_placement: TextEncoderPlacement::Ram,
        vram_reserve_gib: 1.0,
        verified: false,
        summary: "4-bit model; text encoder in system RAM; larger edits fit",
    },
    Preset {
        id: "32gb",
        label: "32 GB+",
        unified_label: "64 GB+ Mac",
        unified_summary: "4-bit image model and 8-bit text encoder",
        min_vram_mib: 28 * 1024,
        diffusion: TURBO_Q4_K,
        text_encoder: TEXT_ENCODER_Q8_0,
        text_encoder_placement: TextEncoderPlacement::Ram,
        vram_reserve_gib: 1.0,
        verified: false,
        summary: "4-bit model and 8-bit text encoder",
    },
];

pub const DEFAULT_PRESET: &str = "16gb";

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

impl Preset {
    /// Offered on this kind of memory: presets without a Mac name are for graphics cards only.
    pub fn offered(&self, unified: bool) -> bool {
        !unified || !self.unified_label.is_empty()
    }
}

/// The preset for a card with `vram_mib` (None: unknown GPU → the 16 GB default); `unified`
/// for a Mac's planning memory. Below every threshold, the smallest preset offered.
pub fn recommended_preset(vram_mib: Option<u64>, unified: bool) -> &'static Preset {
    let offered = || PRESETS.iter().filter(move |p| p.offered(unified));
    match vram_mib {
        Some(v) => offered().rev().find(|p| v >= p.min_vram_mib).or_else(|| offered().next()).unwrap(),
        None => preset(DEFAULT_PRESET).unwrap(),
    }
}

/// Everything a preset needs on `backend` in `sdcpp_dir`, in download order (small, essential
/// files first). Superscale-SP is the default upscaler on PCs only (on Metal it takes minutes
/// per image).
pub fn downloads_for(p: &Preset, backend: GpuBackend, sdcpp_dir: &Path) -> Vec<Download> {
    let mut v = engine_downloads(backend);
    v.push(UPSCALER);
    if backend != GpuBackend::Metal {
        v.push(SUPERSCALE);
    }
    v.extend([official_vae(sdcpp_dir), VISION_PROJECTOR, p.text_encoder, p.diffusion]);
    v
}

/// The model files a profile can download: official files it points to that are not there
/// (a piece the user chose to download, or an official file deleted from their folder), each
/// saved where the profile expects it. Existing files are never replaced, whatever their name.
pub fn profile_model_downloads(profile: &crate::config::ModelProfile) -> Vec<Download> {
    let official = [TURBO_Q4_K, VAE, VAE_ORIGINAL, TEXT_ENCODER_Q4_K_M, TEXT_ENCODER_Q8_0, VISION_PROJECTOR];
    profile
        .files()
        .into_iter()
        .filter(|(_, p, _)| !p.exists())
        .filter_map(|(_, p, _)| {
            let name = p.file_name()?.to_string_lossy().to_string();
            official.iter().find(|d| d.file_name().eq_ignore_ascii_case(&name)).map(|d| d.at(p))
        })
        .collect()
}

/// Everything a user profile needs on `backend`: the engine, the upscalers, then the model
/// files of [`profile_model_downloads`]. The official profile uses [`downloads_for`].
pub fn downloads_for_profile(profile: &crate::config::ModelProfile, backend: GpuBackend) -> Vec<Download> {
    let mut v = engine_downloads(backend);
    v.push(UPSCALER);
    if backend != GpuBackend::Metal {
        v.push(SUPERSCALE);
    }
    v.extend(profile_model_downloads(profile));
    v
}

/// Folder a zip is extracted into: the folder of its `dest`.
pub fn zip_dir(d: &Download, sdcpp_dir: &Path) -> PathBuf {
    d.path(sdcpp_dir).parent().map(Path::to_path_buf).unwrap_or_else(|| sdcpp_dir.to_path_buf())
}

/// Message shown when a download keeps failing (moved link, changed file, server down).
pub fn manual_download_hint(d: &Download, sdcpp_dir: &Path) -> String {
    let target = if d.is_zip() { format!("extract it into {}", zip_dir(d, sdcpp_dir).display()) } else { format!("save it as {}", d.path(sdcpp_dir).display()) };
    format!(
        "Download {} by hand from {} and {target}, then press Check again. Please also open an issue at {ISSUES_URL} so the link can be fixed.",
        d.label, d.page
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_follow_vram() {
        assert_eq!(recommended_preset(Some(12_288), false).id, "12gb");
        assert_eq!(recommended_preset(Some(11_264), false).id, "12gb", "RTX 2080 Ti");
        assert_eq!(recommended_preset(Some(10_240), false).id, "12gb", "RTX 3080 10 GB");
        assert_eq!(recommended_preset(Some(8_188), false).id, "8gb");
        assert_eq!(recommended_preset(Some(6_144), false).id, "8gb", "smaller cards get the lightest preset");
        assert_eq!(recommended_preset(Some(16_303), false).id, "16gb");
        assert_eq!(recommended_preset(Some(24_564), false).id, "24gb");
        assert_eq!(recommended_preset(Some(32_607), false).id, "32gb");
        assert_eq!(recommended_preset(Some(49_140), false).id, "32gb");
        assert_eq!(recommended_preset(None, false).id, "16gb");
        // Macs never get the graphics-card-only 8 GB preset.
        assert_eq!(recommended_preset(Some(5_000), true).id, "12gb");
        assert!(!preset("8gb").unwrap().offered(true) && preset("12gb").unwrap().offered(true));
    }

    #[test]
    fn catalog_is_well_formed() {
        let all = [ENGINE_CUDA, CUDA_RUNTIME, ENGINE_VULKAN, ENGINE_METAL, TURBO_Q4_K, VAE, VAE_ORIGINAL, TEXT_ENCODER_Q4_K_M, TEXT_ENCODER_Q8_0, VISION_PROJECTOR, UPSCALER, SUPERSCALE, ULTRASHARP];
        for d in all {
            assert!(d.urls().all(|u| u.starts_with("https://")), "{}", d.id);
            assert_eq!(d.sha256.len(), 64, "{}", d.id);
            assert!(d.sha256.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{}", d.id);
            assert!(d.size > 0);
            assert!(!d.dest.contains('\\') && d.provides.iter().all(|f| !f.contains('\\')), "portable paths: {}", d.id);
            assert_eq!(d.is_zip(), d.kind == FileKind::Engine, "{}", d.id);
        }
        // Every engine build is marked with this release; the unchanged CUDA runtime is not.
        for d in [ENGINE_CUDA, ENGINE_VULKAN, ENGINE_METAL] {
            assert_eq!(d.engine_tag, Some(ENGINE_TAG), "{}", d.id);
            let commit = ENGINE_TAG.rsplit('-').next().unwrap();
            assert!(d.url.contains(&format!("-{commit}")), "{}", d.id);
        }
        assert_eq!(CUDA_RUNTIME.engine_tag, None);
        // sd-server finds the upscaler by file stem in the upscalers folder.
        assert_eq!(UPSCALER.dest, format!("{UPSCALERS_SUBDIR}/{UPSCALER_NAME}.pth"));
        assert_eq!(UPSCALER.urls().count(), 2, "mirror, then the author's release");
        assert!(LEGACY_UPSCALERS.iter().all(|f| f.starts_with(UPSCALERS_SUBDIR) && *f != UPSCALER.dest));
        // Every model offered in Settings can be installed, except the plain resize.
        for (name, _) in crate::config::UPSCALER_CHOICES {
            assert_eq!(upscaler_download(name).is_some(), *name != crate::config::LANCZOS, "{name}");
        }
        assert_eq!(upscaler_download(crate::config::UPSCALER_CHOICES[0].0).unwrap().id, "upscaler_superscale");
        let metal = downloads_for(&PRESETS[0], GpuBackend::Metal, Path::new("new"));
        assert!(metal.iter().all(|d| d.id != "upscaler_superscale"), "Macs default to Lanczos: no Superscale download");
        for p in PRESETS {
            let cuda = downloads_for(p, GpuBackend::Cuda, Path::new("new"));
            assert_eq!(cuda.len(), 8);
            assert!(cuda.iter().any(|d| d.id == "upscaler") && cuda.iter().any(|d| d.id == "upscaler_superscale"), "MoSR (bundled) and the default model");
            let vk = downloads_for(p, GpuBackend::Vulkan, Path::new("new"));
            assert_eq!(vk.len(), 7);
            assert!(vk.iter().all(|d| d.id != "engine_cuda" && d.id != "cuda_runtime"));
        }
    }

    fn manifest(n: u32) -> EngineManifest {
        let asset = |f: &str| ManifestAsset {
            url: format!("https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-{n}-abcdef0/sd-kokon-abcdef0-bin-{f}.zip"),
            size: 1,
            sha256: "0".repeat(64),
        };
        EngineManifest {
            kokon: Some(KokonEngines {
                tag: format!("kokon-{n}-abcdef0"),
                min_app: "0.10.0".into(),
                win_cuda: asset("win-cuda12-x64"),
                win_vulkan: asset("win-vulkan-x64"),
                linux_cuda: asset("Linux-Ubuntu-22.04-x86_64-cuda12"),
                linux_vulkan: asset("Linux-Ubuntu-22.04-x86_64-vulkan"),
                macos: asset("Darwin-macOS-15.0-universal"),
            }),
        }
    }

    fn edit(n: u32, f: impl FnOnce(&mut KokonEngines)) -> EngineManifest {
        let mut m = manifest(n);
        f(m.kokon.as_mut().unwrap());
        m
    }

    #[test]
    fn engine_manifest_overrides_only_newer_releases() {
        let _guard = ENGINE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(release_number(ENGINE_TAG), Some(992));
        assert_eq!(apply_engine_release(&manifest(992), "0.10.0"), Ok(false), "same as built in");
        assert_eq!(engine_tag(), ENGINE_TAG);
        assert_eq!(apply_engine_release(&manifest(1000), "0.9.4"), Ok(false), "too old an app");
        assert_eq!(apply_engine_release(&manifest(1000), "0.10.0"), Ok(true));
        assert_eq!(engine_tag(), "kokon-1000-abcdef0");
        let cuda = &engine_downloads(GpuBackend::Cuda);
        assert_eq!(cuda[0].engine_tag, Some("kokon-1000-abcdef0"));
        assert_eq!(cuda[0].provides, ENGINE_CUDA.provides);
        assert!(cuda[0].page.ends_with("/kokon-1000-abcdef0"));
        assert_eq!(cuda[1].id, "cuda_runtime");
        let vulkan = engine_downloads(GpuBackend::Vulkan)[0];
        if cfg!(target_os = "linux") {
            assert_eq!(cuda[0].dest, "sd-kokon-abcdef0-bin-Linux-Ubuntu-22.04-x86_64-cuda12.zip");
            assert_eq!(vulkan.dest, "engine-vulkan/sd-kokon-abcdef0-bin-Linux-Ubuntu-22.04-x86_64-vulkan.zip");
        } else {
            assert_eq!(cuda[0].dest, "sd-kokon-abcdef0-bin-win-cuda12-x64.zip");
            assert_eq!(vulkan.dest, "engine-vulkan/sd-kokon-abcdef0-bin-win-vulkan-x64.zip");
        }
        assert_eq!(engine_downloads(GpuBackend::Metal)[0].dest, "engine-metal/sd-kokon-abcdef0-bin-Darwin-macOS-15.0-universal.zip");
        // Only that release's downloads in the fork, with a real hash; any bad build rejects it all.
        assert!(apply_engine_release(&edit(1001, |k| k.win_cuda.url = "https://example.com/sd.zip".into()), "0.10.0").is_err());
        assert!(apply_engine_release(&edit(1001, |k| k.macos.sha256 = "xyz".into()), "0.10.0").is_err());
        let other_commit = "https://github.com/GabrieleLozupone/stable-diffusion.cpp/releases/download/kokon-1001-abcdef0/sd-kokon-1234567-bin-win-vulkan-x64.zip";
        assert!(apply_engine_release(&edit(1001, |k| k.linux_vulkan.url = other_commit.into()), "0.10.0").is_err(), "another commit's build");
        assert!(apply_engine_release(&edit(1001, |k| k.tag = "master-1001-abcdef0".into()), "0.10.0").is_err());
        assert_eq!(engine_tag(), "kokon-1000-abcdef0", "a bad manifest keeps the last good release");
        // An app that pins a newer engine drops an older manifest release.
        assert_eq!(apply_engine_release(&manifest(980), "0.10.0"), Ok(false));
        assert_eq!(engine_tag(), ENGINE_TAG);
        // engine.json as published: the upstream keys for apps up to 0.9.4 next to Kokon's.
        let json = include_str!("../../../engine.json");
        let m: EngineManifest = serde_json::from_str(json).unwrap();
        assert!(apply_engine_release(&m, "0.10.0").is_ok());
        assert_eq!(apply_engine_release(&EngineManifest::default(), "0.10.0"), Ok(false));
        assert_eq!(engine_tag(), ENGINE_TAG);
    }

    #[test]
    fn published_engine_json_matches_the_built_in_pins() {
        // engine.json on master and the app's pins name the same release and the same files, so a
        // release never ships pins its own manifest disagrees with.
        let m: EngineManifest = serde_json::from_str(include_str!("../../../engine.json")).unwrap();
        let k = m.kokon.expect("engine.json has a kokon entry");
        assert_eq!(k.tag, ENGINE_TAG);
        assert!(version_tuple(env!("CARGO_PKG_VERSION")) >= version_tuple(&k.min_app), "min_app {} above this app", k.min_app);
        assert_eq!((k.macos.size, k.macos.sha256.as_str()), (MACOS_METAL_SIZE, MACOS_METAL_SHA256));
        assert_eq!(k.macos.url, ENGINE_METAL.url);
        #[cfg(not(target_os = "linux"))]
        {
            assert_eq!((k.win_cuda.url.as_str(), k.win_cuda.size, k.win_cuda.sha256.as_str()), (ENGINE_CUDA.url, WIN_CUDA_SIZE, WIN_CUDA_SHA256));
            assert_eq!((k.win_vulkan.url.as_str(), k.win_vulkan.size, k.win_vulkan.sha256.as_str()), (ENGINE_VULKAN.url, WIN_VULKAN_SIZE, WIN_VULKAN_SHA256));
        }
        #[cfg(target_os = "linux")]
        {
            assert_eq!((k.linux_cuda.url.as_str(), k.linux_cuda.size, k.linux_cuda.sha256.as_str()), (ENGINE_CUDA.url, LINUX_CUDA_SIZE, LINUX_CUDA_SHA256));
            assert_eq!((k.linux_vulkan.url.as_str(), k.linux_vulkan.size, k.linux_vulkan.sha256.as_str()), (ENGINE_VULKAN.url, LINUX_VULKAN_SIZE, LINUX_VULKAN_SHA256));
        }
    }

    #[test]
    fn engines_of_another_release_need_updating() {
        let dir = tempfile::tempdir().unwrap();
        for f in ENGINE_CUDA.provides.iter().chain(CUDA_RUNTIME.provides) {
            std::fs::write(join_rel(dir.path(), f), b"x").unwrap();
        }
        assert!(!ENGINE_CUDA.is_present(dir.path()), "an engine without the marker is from an older release");
        assert!(CUDA_RUNTIME.is_present(dir.path()), "the runtime needs no marker");
        std::fs::write(dir.path().join(ENGINE_MARKER), "kokon-old").unwrap();
        assert!(!ENGINE_CUDA.is_present(dir.path()));
        ENGINE_CUDA.write_tag(dir.path()).unwrap();
        assert_eq!(ENGINE_CUDA.installed_tag(dir.path()).as_deref(), Some(ENGINE_TAG));
        assert!(ENGINE_CUDA.is_present(dir.path()));
        // Each build has its own marker: the CUDA one does not count for Vulkan.
        std::fs::create_dir_all(dir.path().join("engine-vulkan")).unwrap();
        for f in ENGINE_VULKAN.provides {
            std::fs::write(join_rel(dir.path(), f), b"x").unwrap();
        }
        assert!(!ENGINE_VULKAN.is_present(dir.path()));
        ENGINE_VULKAN.write_tag(dir.path()).unwrap();
        assert!(dir.path().join("engine-vulkan").join(ENGINE_MARKER).is_file());
        assert!(ENGINE_VULKAN.is_present(dir.path()));
    }

    #[test]
    fn user_profiles_download_only_missing_official_files() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("own");
        std::fs::create_dir_all(&own).unwrap();
        // The user's diffusion model is there; the VAE is the official file (deleted, or chosen
        // to download); the text encoder is the user's own and missing (a drive not connected).
        std::fs::write(own.join("turbo_int8.safetensors"), b"x").unwrap();
        let vae = own.join(VAE.file_name());
        let p = crate::config::ModelProfile::user(own.join("turbo_int8.safetensors"), vae.clone(), own.join("mine.safetensors"), Some(dir.path().join("dl").join(VISION_PROJECTOR.file_name())));
        let models = profile_model_downloads(&p);
        assert_eq!(models.iter().map(|d| d.id).collect::<Vec<_>>(), ["vae", "vision_projector"], "own files are never downloaded");
        assert_eq!(models[0].path(Path::new("ignored")), vae, "saved where the profile expects it");
        assert_eq!(models[1].path(dir.path()), dir.path().join("dl").join(VISION_PROJECTOR.file_name()));
        assert_eq!((models[0].size, models[0].sha256), (VAE.size, VAE.sha256));
        // An official name with other content (wrong size) is the user's file: never replaced.
        std::fs::write(&vae, b"mine").unwrap();
        assert_eq!(profile_model_downloads(&p).len(), 1);
        let all = downloads_for_profile(&p, GpuBackend::Vulkan);
        assert_eq!(all.iter().map(|d| d.id).collect::<Vec<_>>(), ["engine_vulkan", "upscaler", "upscaler_superscale", "vision_projector"]);
    }

    #[test]
    fn texture_fix_vae_replaces_the_original_only_once_downloaded() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        std::fs::create_dir_all(join_rel(d, MODEL_SUBDIR)).unwrap();
        let fill = |f: Download| std::fs::File::create(f.path(d)).unwrap().set_len(f.size).unwrap();
        let mut cfg = crate::config::AppConfig { sdcpp_dir: d.to_path_buf(), ..Default::default() };
        cfg.normalize();
        // A new install gets the texture fix.
        assert_eq!(official_vae(d).id, "vae");
        assert_eq!(cfg.profile().vae, VAE.path(d));
        // An earlier install keeps its original VAE until the user accepts the new one.
        fill(VAE_ORIGINAL);
        cfg.normalize();
        assert_eq!(official_vae(d).id, "vae_original");
        assert_eq!(cfg.profile().vae, VAE_ORIGINAL.path(d));
        assert!(downloads_for(preset("16gb").unwrap(), GpuBackend::Cuda, d).iter().all(|x| x.id != "vae"), "never downloaded uninvited");
        assert_eq!(unused_original_vae(&cfg), None, "in use");
        // Once downloaded, the official files switch and the original can go.
        fill(VAE);
        cfg.normalize();
        assert_eq!(cfg.profile().vae, VAE.path(d));
        assert_eq!(unused_original_vae(&cfg), Some(VAE_ORIGINAL.path(d)));
        // ...unless the user's own profile points to it.
        cfg.set_user_files(crate::config::ModelProfile::user(d.join("m.gguf"), VAE_ORIGINAL.path(d), d.join("te.gguf"), None));
        assert_eq!(unused_original_vae(&cfg), None);
        assert!(!cfg.uses_improved_vae());
        // Accepting it moves that profile to the app's copy; the user's file is never deleted
        // (only the app's folder is cleaned, and only files no profile uses).
        cfg.use_improved_vae();
        assert!(cfg.uses_improved_vae());
        assert_eq!(cfg.profile().vae, VAE.path(d));
        assert_eq!(unused_original_vae(&cfg), Some(VAE_ORIGINAL.path(d)));
    }

    #[test]
    fn presence_checks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!VAE.is_present(dir.path()));
        std::fs::create_dir_all(join_rel(dir.path(), MODEL_SUBDIR)).unwrap();
        std::fs::write(VAE.path(dir.path()), b"short").unwrap();
        assert!(!VAE.is_present(dir.path()), "a partial file is not installed");
        for f in ENGINE_CUDA.provides {
            std::fs::write(dir.path().join(f), b"x").unwrap();
        }
        ENGINE_CUDA.write_tag(dir.path()).unwrap();
        assert!(ENGINE_CUDA.is_present(dir.path()));
        let hint = manual_download_hint(&ENGINE_CUDA, dir.path());
        assert!(hint.contains("extract it into") && hint.contains(ISSUES_URL));
        // The Vulkan build lives in its own folder: the CUDA files don't count for it.
        assert!(!ENGINE_VULKAN.is_present(dir.path()));
        std::fs::create_dir_all(dir.path().join("engine-vulkan")).unwrap();
        for f in ENGINE_VULKAN.provides {
            std::fs::write(join_rel(dir.path(), f), b"x").unwrap();
        }
        ENGINE_VULKAN.write_tag(dir.path()).unwrap();
        assert!(ENGINE_VULKAN.is_present(dir.path()));
        let mut cfg = crate::config::AppConfig::default();
        cfg.sdcpp_dir = dir.path().to_path_buf();
        cfg.gpu_backend = GpuBackend::Vulkan;
        if !cfg!(target_os = "macos") {
            // The Vulkan build is a Windows or Linux download (no Mac one).
            assert_eq!(cfg.server_exe(), join_rel(dir.path(), ENGINE_VULKAN.provides[0]), "installer and launcher agree on the path");
        }
        cfg.gpu_backend = GpuBackend::Metal;
        if !cfg!(windows) {
            assert_eq!(cfg.server_exe(), join_rel(dir.path(), ENGINE_METAL.provides[0]));
        }
        assert!(manual_download_hint(&ENGINE_VULKAN, dir.path()).contains("engine-vulkan"));
    }
}
