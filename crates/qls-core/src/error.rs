//! Application-level errors: a stable code, a short human message, optional suggestion,
//! and the raw technical detail (kept for Diagnostics, never shown by default).

use serde::{Deserialize, Serialize};
use std::fmt;

use crate::config::AppConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    OutOfMemory,
    MissingModel,
    InvalidConfig,
    ServerUnavailable,
    ServerStartFailed,
    ServerCrashed,
    MalformedRequest,
    Unsupported,
    ImageDecode,
    Filesystem,
    InvalidPath,
    InvalidInput,
    NotFound,
    QueueFull,
    Cancelled,
    GenerationFailed,
    Unauthorized,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), suggestion: None, detail: None }
    }
    pub fn detail(mut self, d: impl Into<String>) -> Self {
        self.detail = Some(d.into());
        self
    }
    pub fn suggest(mut self, s: impl Into<String>) -> Self {
        self.suggestion = Some(s.into());
        self
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }
    pub fn internal(e: impl fmt::Display) -> Self {
        Self::new(ErrorCode::Internal, "Something went wrong inside the app.").detail(e.to_string())
    }
    pub fn io(action: &str, path: &std::path::Path, e: std::io::Error) -> Self {
        let msg = match e.kind() {
            std::io::ErrorKind::NotFound => format!("File not found: {}", path.display()),
            std::io::ErrorKind::PermissionDenied => format!("Permission denied: {}", path.display()),
            _ => format!("Could not {action}: {}", path.display()),
        };
        Self::new(ErrorCode::Filesystem, msg).detail(e.to_string())
    }
    /// HTTP status used by the stable API.
    pub fn http_status(&self) -> u16 {
        match self.code {
            ErrorCode::InvalidInput | ErrorCode::InvalidPath | ErrorCode::MalformedRequest | ErrorCode::ImageDecode => 400,
            ErrorCode::Unauthorized => 401,
            ErrorCode::NotFound => 404,
            ErrorCode::QueueFull => 429,
            ErrorCode::Unsupported => 422,
            ErrorCode::ServerUnavailable | ErrorCode::ServerStartFailed | ErrorCode::ServerCrashed => 503,
            _ => 500,
        }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(s) = &self.suggestion {
            write!(f, " {s}")?;
        }
        Ok(())
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new(ErrorCode::Filesystem, "A file operation failed.").detail(e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

const OOM_PATTERNS: &[&str] = &[
    "out of memory",
    "cudamalloc failed",
    "cuda error: out of memory",
    "failed to allocate",
    "ggml_backend_cuda_buffer_type_alloc_buffer",
    "not enough memory",
    "cudaerrormemoryallocation",
    "failed during weight preparation",
];

pub fn looks_like_oom(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    OOM_PATTERNS.iter().any(|p| t.contains(p))
}

/// Translates a failed backend job (its error message plus the server log lines written
/// while it ran) into an application error. `size` is the working resolution and
/// `smaller` a suggested safer resolution.
pub fn translate_generation_failure(backend_message: &str, log_tail: &str, size: (u32, u32), smaller: Option<(u32, u32)>) -> AppError {
    let combined = format!("{backend_message}\n{log_tail}");
    let lc = combined.to_ascii_lowercase();
    if looks_like_oom(&combined) {
        let mut e = AppError::new(ErrorCode::OutOfMemory, format!("Not enough GPU memory for {}×{}.", size.0, size.1));
        e = match smaller {
            Some((w, h)) => e.suggest(format!("Try {w}×{h}, fewer reference images, or the Fast preset.")),
            None => e.suggest("Try a smaller resolution or fewer reference images."),
        };
        return e.detail(combined);
    }
    if lc.contains("requires qwen3-vl vision weights") || lc.contains("llm_vision") {
        return AppError::new(ErrorCode::InvalidConfig, "Image editing needs the vision projector (mmproj) model.")
            .suggest("Set the vision projector file in Settings.")
            .detail(combined);
    }
    if lc.contains("multiples of 32") {
        return AppError::new(ErrorCode::MalformedRequest, "The image size was not compatible with the model.").detail(combined);
    }
    if lc.contains("invalid") && lc.contains("request") {
        return AppError::new(ErrorCode::MalformedRequest, "The inference server rejected the request.").detail(combined);
    }
    AppError::new(ErrorCode::GenerationFailed, "Generation failed.").suggest("See Diagnostics for details.").detail(combined)
}

/// Translates sd-server startup output (process exited before becoming ready).
pub fn translate_startup_failure(log_tail: &str) -> AppError {
    let lc = log_tail.to_ascii_lowercase();
    if lc.contains("failed to open") || lc.contains("no such file") || lc.contains("does not exist") || lc.contains("file not found") {
        return AppError::new(ErrorCode::MissingModel, "A model file could not be opened.")
            .suggest("Check the model paths in Settings.")
            .detail(log_tail.to_string());
    }
    if looks_like_oom(log_tail) {
        return AppError::new(ErrorCode::OutOfMemory, "Not enough GPU memory to load the model.")
            .suggest("Close other apps that use the GPU, or lower the memory use in Settings → Performance.")
            .detail(log_tail.to_string());
    }
    if lc.contains("address already in use") || lc.contains("bind") && lc.contains("fail") {
        return AppError::new(ErrorCode::ServerStartFailed, "The inference server port is already in use.")
            .suggest(&format!("Close the program using the port, or change \"serverPort\" in {}.", AppConfig::path().display()))
            .detail(log_tail.to_string());
    }
    if lc.contains("cuda") && (lc.contains("no cuda") || lc.contains("cuda error") || lc.contains("no devices")) {
        return AppError::new(ErrorCode::ServerStartFailed, "CUDA is not available.")
            .suggest("Update the NVIDIA driver or select another device in Settings.")
            .detail(log_tail.to_string());
    }
    if lc.contains("unknown argument") || lc.contains("invalid argument") || lc.contains("unknown option") {
        return AppError::new(ErrorCode::InvalidConfig, "The inference server did not accept its launch options.")
            .suggest("Your stable-diffusion.cpp build may be older or newer than expected. See Diagnostics.")
            .detail(log_tail.to_string());
    }
    AppError::new(ErrorCode::ServerStartFailed, "The inference server failed to start.")
        .suggest("See Diagnostics for the server log.")
        .detail(log_tail.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oom_is_translated_with_suggestion() {
        let e = translate_generation_failure("generate_image returned empty results", "[ERROR] cudaMalloc failed: out of memory", (2048, 2048), Some((1536, 1536)));
        assert_eq!(e.code, ErrorCode::OutOfMemory);
        assert_eq!(e.message, "Not enough GPU memory for 2048×2048.");
        assert!(e.suggestion.unwrap().contains("1536×1536"));
        assert!(e.detail.unwrap().contains("cudaMalloc"));
    }

    #[test]
    fn generic_failure() {
        let e = translate_generation_failure("boom", "", (1024, 1024), None);
        assert_eq!(e.code, ErrorCode::GenerationFailed);
    }

    #[test]
    fn startup_failures() {
        assert_eq!(translate_startup_failure("failed to open 'x.gguf'").code, ErrorCode::MissingModel);
        assert_eq!(translate_startup_failure("ggml_backend_cuda_buffer_type_alloc_buffer: allocating").code, ErrorCode::OutOfMemory);
        assert_eq!(translate_startup_failure("error: unknown argument: --foo").code, ErrorCode::InvalidConfig);
        assert_eq!(translate_startup_failure("weird").code, ErrorCode::ServerStartFailed);
    }

    #[test]
    fn port_in_use_points_at_the_config_file() {
        let e = translate_startup_failure("bind() to 127.0.0.1:39150 failed: address already in use");
        assert_eq!(e.code, ErrorCode::ServerStartFailed);
        let s = e.suggestion.unwrap();
        assert!(s.contains("serverPort"), "{}", s);
        assert!(s.contains("config.json"), "{}", s);
    }

    #[test]
    fn statuses() {
        assert_eq!(AppError::invalid("x").http_status(), 400);
        assert_eq!(AppError::new(ErrorCode::NotFound, "x").http_status(), 404);
    }
}
