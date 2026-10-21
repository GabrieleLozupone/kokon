//! Inference adapter for stable-diffusion.cpp's native async API (`/sdcpp/v1/*`).
//!
//! This is the only module that knows the sd-server wire format. Schemas were verified
//! against examples/server (api.md, routes_sdcpp.cpp, async_jobs.h) at commit 3f8527a:
//!   GET  /sdcpp/v1/capabilities
//!   POST /sdcpp/v1/img_gen            -> 202 {id, kind, status, created, poll_url}
//!   GET  /sdcpp/v1/jobs/{id}          -> {status: queued|generating|completed|failed|cancelled, ...}
//!   POST /sdcpp/v1/jobs/{id}/cancel   -> 200, or 409 while generating (not interruptible)
//!   POST /sdcpp/v1/upscale            -> 200 {images, upscaler, scale, width, height} (sync ESRGAN)
//!   POST /sdcpp/v1/text_gen           -> SSE delta/done/error (Kokon's engine: prompt enhancer)
//!
//! Request objects are merged field by field over the server's launch defaults
//! (`SDGenerationParams::from_json_str`), so omitted fields keep the CLI values.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};

// ---------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Guidance {
    pub txt_cfg: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub img_cfg: Option<f32>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct SampleParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduler: Option<String>,
    pub sample_steps: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow_shift: Option<f32>,
    /// Exact noise schedule, used verbatim (steps = len - 1, no shift).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub custom_sigmas: Vec<f32>,
    pub guidance: Guidance,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct VaeTilingParams {
    pub enabled: bool,
    /// Image pixels; 0 = backend default (256).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_size_w: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_size_h: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_overlap: Option<f32>,
}

/// Second pass of `img_gen` (`hires`): the first result is upscaled to the target size
/// (`upscaler` = built-in filter or an ESRGAN model stem from `--hires-upscalers-dir`)
/// and re-sampled with `denoising_strength`. Reference latents and the inpaint mask are
/// carried into the second pass (src/pipeline/image.cpp, commit 3f8527a).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct HiresParams {
    pub enabled: bool,
    pub upscaler: String,
    pub target_width: u32,
    pub target_height: u32,
    /// Effective refine steps (the server scales the schedule by the denoise strength).
    pub steps: u32,
    pub denoising_strength: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upscale_tile_size: Option<u32>,
}

/// Body of `POST /sdcpp/v1/img_gen`. Images are base64 PNG strings.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct ImgGenRequest {
    pub prompt: String,
    pub negative_prompt: String,
    pub width: u32,
    pub height: u32,
    pub seed: i64,
    pub batch_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strength: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub init_image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask_image: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ref_images: Vec<String>,
    /// Our images already arrive at exact working geometry, so input transforms are
    /// disabled (`mode=none`) to guarantee no crop/stretch happens server-side.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub image_preprocess: Vec<String>,
    /// e.g. "resize_before_vae=false": for Qwen-Image 2.1 the server otherwise resizes every
    /// reference to the output's area before encoding (pipeline/image.cpp), smaller ones too.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ref_image_args: Option<String>,
    pub sample_params: SampleParams,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vae_tiling_params: Option<VaeTilingParams>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hires: Option<HiresParams>,
    /// e.g. "easycache"; applies to both passes. Omitted = server default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_mode: Option<String>,
    /// e.g. "threshold=0.2".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_option: Option<String>,
    /// LoRAs, by path relative to the server's `--lora-model-dir`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub lora: Vec<LoraParam>,
    pub output_format: String,
    /// We write our own metadata after post-processing.
    pub embed_image_metadata: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoraParam {
    pub path: String,
    pub multiplier: f32,
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn b64_decode(s: &str) -> Result<Vec<u8>, AppError> {
    let s = s.split_once(";base64,").map(|(_, d)| d).unwrap_or(s);
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| AppError::new(ErrorCode::GenerationFailed, "The inference server returned an unreadable image.").detail(e.to_string()))
}

// ---------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CapModel {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub stem: String,
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CapLimits {
    #[serde(default)]
    pub min_width: u32,
    #[serde(default)]
    pub max_width: u32,
    #[serde(default)]
    pub min_height: u32,
    #[serde(default)]
    pub max_height: u32,
    #[serde(default)]
    pub max_batch_count: u32,
    #[serde(default)]
    pub max_queue_size: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
pub struct CapUpscaler {
    #[serde(default)]
    pub name: String,
    /// True for a model-backed upscaler (false for built-in filters).
    #[serde(default)]
    pub model: bool,
    /// Usable with `POST /sdcpp/v1/upscale` (RGB ESRGAN models).
    #[serde(default)]
    pub image_upscale: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Capabilities {
    #[serde(default)]
    pub model: CapModel,
    #[serde(default)]
    pub supported_modes: Vec<String>,
    #[serde(default)]
    pub samplers: Vec<String>,
    #[serde(default)]
    pub schedulers: Vec<String>,
    #[serde(default)]
    pub output_formats: Vec<String>,
    #[serde(default)]
    pub limits: CapLimits,
    #[serde(default)]
    pub features_by_mode: serde_json::Value,
    #[serde(default)]
    pub defaults_by_mode: serde_json::Value,
    #[serde(default)]
    pub upscalers: Vec<CapUpscaler>,
    /// Whether any RGB ESRGAN model is available for `/sdcpp/v1/upscale`.
    #[serde(default)]
    pub upscale: bool,
    /// Whether `/sdcpp/v1/text_gen` works with the loaded model (Kokon's engine builds only).
    #[serde(default)]
    pub text_generation: bool,
}

impl Capabilities {
    pub fn img_feature(&self, name: &str) -> bool {
        self.features_by_mode.get("img_gen").and_then(|f| f.get(name)).and_then(|v| v.as_bool()).unwrap_or(false)
    }
    pub fn supports_img_gen(&self) -> bool {
        self.supported_modes.iter().any(|m| m == "img_gen")
    }
    /// True when `name` is a model-backed upscaler the server can load (hires and,
    /// if `image` is set, the standalone upscale endpoint).
    pub fn has_upscaler(&self, name: &str, image: bool) -> bool {
        self.upscalers.iter().any(|u| u.model && u.name == name && (!image || u.image_upscale))
    }
    /// True when the loaded diffusion model is the file we expect (path compare is
    /// case/slash-insensitive, since Windows paths come back with forward slashes).
    pub fn model_matches(&self, expected: &std::path::Path) -> bool {
        let norm = |s: &str| s.replace('\\', "/").to_ascii_lowercase();
        let want = norm(&expected.to_string_lossy());
        let got = norm(&self.model.path);
        if !got.is_empty() {
            return got == want || want.ends_with(&got) || got.ends_with(&want);
        }
        let file = expected.file_name().map(|f| f.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        self.model.name.to_ascii_lowercase() == file
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobAccepted {
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendJobStatus {
    Queued,
    Generating,
    Completed,
    Failed,
    Cancelled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct JobError {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JobImage {
    #[serde(default)]
    pub index: u32,
    pub b64_json: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct JobResult {
    #[serde(default)]
    pub images: Vec<JobImage>,
    #[serde(default)]
    pub output_format: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BackendJob {
    pub id: String,
    pub status: BackendJobStatus,
    #[serde(default)]
    pub queue_position: u32,
    #[serde(default)]
    pub result: Option<JobResult>,
    #[serde(default)]
    pub error: Option<JobError>,
}

/// Body of `POST /sdcpp/v1/upscale`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpscaleRequest {
    pub image: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upscaler: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tile_size: Option<u32>,
    pub output_format: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpscaleResponse {
    #[serde(default)]
    pub images: Vec<JobImage>,
    #[serde(default)]
    pub upscaler: String,
    #[serde(default)]
    pub scale: u32,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
}

/// Sampling of `POST /sdcpp/v1/text_gen` (`temperature` 0 = greedy).
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct TextSampling {
    pub temperature: f32,
    pub top_p: f32,
    pub top_k: u32,
    pub presence_penalty: f32,
    /// Negative = the server picks one.
    pub seed: i64,
}

/// Body of `POST /sdcpp/v1/text_gen`: one chat turn for the LLM the model uses as its text
/// encoder.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextGenRequest {
    pub prompt: String,
    /// Always sent; "" means no system turn (the server has no built-in prompt).
    pub system_prompt: String,
    /// Base64 images shown before the prompt (`<image1>`, `<image2>`, ... when several).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    pub max_tokens: u32,
    pub sampling: TextSampling,
    pub stream: bool,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
pub struct TextUsage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
}

/// The `done` event of `text_gen` (the whole reply with `stream: false`).
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TextGenDone {
    #[serde(default)]
    pub text: String,
    /// "stop", "length" or "cancelled".
    #[serde(default)]
    pub finish_reason: String,
    #[serde(default)]
    pub seed: i64,
    #[serde(default)]
    pub usage: TextUsage,
    /// Seconds: prepare_s, image_s, prefill_s, decode_s.
    #[serde(default)]
    pub timings: serde_json::Value,
}

/// Splits a `text/event-stream` body into (event, data) pairs. Bytes are buffered until the
/// blank line that ends an event, so a chunk may end inside a line or a UTF-8 character.
/// Comment lines (": waiting for the model") are skipped.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<(String, String)> {
        self.buf.extend(chunk.iter().filter(|&&b| b != b'\r'));
        let mut events = Vec::new();
        while let Some(end) = self.buf.windows(2).position(|w| w == b"\n\n") {
            let block: Vec<u8> = self.buf.drain(..end + 2).collect();
            let text = String::from_utf8_lossy(&block[..end]);
            let (mut event, mut data) = (String::new(), Vec::new());
            for line in text.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_string();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if !data.is_empty() || !event.is_empty() {
                events.push((if event.is_empty() { "message".into() } else { event }, data.join("\n")));
            }
        }
        events
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CancelOutcome {
    Cancelled,
    /// The backend cannot interrupt a job that is already generating.
    NotInterruptible,
    AlreadyFinished,
    NotFound,
}

// ---------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct SdcppClient {
    base: String,
    http: reqwest::Client,
}

fn unavailable(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorCode::ServerUnavailable, "The inference server is not reachable.").detail(e.to_string())
}

impl SdcppClient {
    pub fn new(port: u16) -> Self {
        let http = reqwest::Client::builder()
            .no_proxy()
            .connect_timeout(Duration::from_secs(3))
            .build()
            .expect("http client");
        Self { base: format!("http://127.0.0.1:{port}"), http }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub async fn capabilities(&self, timeout: Duration) -> Result<Capabilities, AppError> {
        let r = self.http.get(format!("{}/sdcpp/v1/capabilities", self.base)).timeout(timeout).send().await.map_err(unavailable)?;
        if !r.status().is_success() {
            return Err(AppError::new(ErrorCode::ServerUnavailable, "The inference server did not report its capabilities.")
                .detail(format!("HTTP {}", r.status())));
        }
        r.json::<Capabilities>().await.map_err(|e| {
            AppError::new(ErrorCode::Unsupported, "The program on the inference port does not look like stable-diffusion.cpp.").detail(e.to_string())
        })
    }

    pub async fn submit(&self, req: &ImgGenRequest) -> Result<JobAccepted, AppError> {
        let body = serde_json::to_vec(req).map_err(AppError::internal)?;
        let r = self
            .http
            .post(format!("{}/sdcpp/v1/img_gen", self.base))
            .header("Content-Type", "application/json")
            .body(body)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .map_err(unavailable)?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        match status {
            200 | 202 => serde_json::from_str(&text)
                .map_err(|e| AppError::new(ErrorCode::Unsupported, "Unexpected reply from the inference server.").detail(format!("{e}: {text}"))),
            429 => Err(AppError::new(ErrorCode::QueueFull, "The inference server queue is full.").detail(text)),
            400 => Err(AppError::new(ErrorCode::MalformedRequest, "The inference server rejected the request.").detail(text)),
            _ => Err(AppError::new(ErrorCode::GenerationFailed, "The inference server returned an error.").detail(format!("HTTP {status}: {text}"))),
        }
    }

    /// Synchronous ESRGAN pass. It waits for the server's generation lock, so the
    /// timeout covers a job that might still be finishing.
    pub async fn upscale(&self, req: &UpscaleRequest) -> Result<UpscaleResponse, AppError> {
        let body = serde_json::to_vec(req).map_err(AppError::internal)?;
        let r = self
            .http
            .post(format!("{}/sdcpp/v1/upscale", self.base))
            .header("Content-Type", "application/json")
            .body(body)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(unavailable)?;
        let status = r.status().as_u16();
        let text = r.text().await.unwrap_or_default();
        let server_error = || serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or_else(|| text.clone());
        match status {
            200 => {
                let resp: UpscaleResponse = serde_json::from_str(&text)
                    .map_err(|e| AppError::new(ErrorCode::Unsupported, "Unexpected reply from the upscaler.").detail(format!("{e}: {}", &text[..text.len().min(300)])))?;
                if resp.images.is_empty() {
                    return Err(AppError::new(ErrorCode::GenerationFailed, "The upscaler returned no image."));
                }
                Ok(resp)
            }
            404 => Err(AppError::new(ErrorCode::Unsupported, "This sd-server build has no upscale endpoint.").detail(text)),
            400 => Err(AppError::new(ErrorCode::MalformedRequest, "The upscaler rejected the image.").detail(server_error())),
            _ => Err(AppError::new(ErrorCode::GenerationFailed, "The upscaler failed.").detail(format!("HTTP {status}: {}", server_error()))),
        }
    }

    /// Streams `POST /sdcpp/v1/text_gen`: `on_delta` gets each piece of text as it is written.
    /// `cancelled` is checked a few times a second; returning true drops the connection, which
    /// stops the generation on the server. `idle` limits the wait for the next chunk (the
    /// server first waits for a running generation, then reads the images).
    pub async fn text_gen(&self, req: &TextGenRequest, idle: Duration, mut on_delta: impl FnMut(&str), cancelled: impl Fn() -> bool) -> Result<TextGenDone, AppError> {
        use futures_util::StreamExt;
        let cancel_err = || AppError::new(ErrorCode::Cancelled, "Cancelled.");
        let failed = |detail: String| AppError::new(ErrorCode::GenerationFailed, "The prompt enhancer failed.").detail(detail);
        let body = serde_json::to_vec(&TextGenRequest { stream: true, ..req.clone() }).map_err(AppError::internal)?;
        let r = self
            .http
            .post(format!("{}/sdcpp/v1/text_gen", self.base))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .body(body)
            .send()
            .await
            .map_err(unavailable)?;
        let status = r.status().as_u16();
        if status != 200 {
            let text = r.text().await.unwrap_or_default();
            let msg = serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or(text);
            return Err(match status {
                404 => AppError::new(ErrorCode::Unsupported, "This inference engine cannot write prompts.").detail(msg),
                400 => AppError::new(ErrorCode::MalformedRequest, "The inference server rejected the prompt request.").detail(msg),
                _ => failed(format!("HTTP {status}: {msg}")),
            });
        }
        let mut stream = r.bytes_stream();
        let mut parser = SseParser::default();
        let mut last_chunk = std::time::Instant::now();
        loop {
            let chunk = tokio::select! {
                c = stream.next() => c,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    if cancelled() {
                        return Err(cancel_err());
                    }
                    if last_chunk.elapsed() > idle {
                        return Err(failed(format!("no answer for {} s", idle.as_secs())));
                    }
                    continue;
                }
            };
            let bytes = match chunk {
                Some(Ok(b)) => b,
                Some(Err(e)) => return Err(failed(format!("connection broke: {e}"))),
                None => return Err(failed("the stream ended without an answer".into())),
            };
            last_chunk = std::time::Instant::now();
            for (event, data) in parser.push(&bytes) {
                let json = serde_json::from_str::<serde_json::Value>(&data).ok();
                match event.as_str() {
                    "delta" => {
                        if let Some(t) = json.as_ref().and_then(|v| v["text"].as_str()) {
                            on_delta(t);
                        }
                    }
                    "done" => {
                        return serde_json::from_str(&data)
                            .map_err(|e| AppError::new(ErrorCode::Unsupported, "Unexpected reply from the prompt enhancer.").detail(format!("{e}: {data}")));
                    }
                    "error" => return Err(failed(json.as_ref().and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or(data))),
                    _ => {}
                }
            }
            if cancelled() {
                return Err(cancel_err());
            }
        }
    }

    pub async fn job(&self, id: &str) -> Result<BackendJob, AppError> {
        let r = self
            .http
            .get(format!("{}/sdcpp/v1/jobs/{}", self.base, id))
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .map_err(unavailable)?;
        match r.status().as_u16() {
            200 => r.json().await.map_err(|e| AppError::new(ErrorCode::Unsupported, "Unexpected job status format.").detail(e.to_string())),
            404 | 410 => Err(AppError::new(ErrorCode::NotFound, "The inference job is no longer known to the server.")),
            s => Err(AppError::new(ErrorCode::GenerationFailed, "Could not read job status.").detail(format!("HTTP {s}"))),
        }
    }

    pub async fn cancel(&self, id: &str) -> Result<CancelOutcome, AppError> {
        let r = self
            .http
            .post(format!("{}/sdcpp/v1/jobs/{}/cancel", self.base, id))
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(unavailable)?;
        let status = r.status().as_u16();
        Ok(match status {
            200 => {
                let job: Option<BackendJob> = r.json().await.ok();
                match job.map(|j| j.status) {
                    Some(BackendJobStatus::Cancelled) | None => CancelOutcome::Cancelled,
                    _ => CancelOutcome::AlreadyFinished,
                }
            }
            409 => CancelOutcome::NotInterruptible,
            404 | 410 => CancelOutcome::NotFound,
            _ => CancelOutcome::NotInterruptible,
        })
    }
}

/// Parses `stable-diffusion.cpp version X, commit abc123` from `--help` output.
pub fn parse_version_banner(text: &str) -> Option<String> {
    let line = text.lines().find(|l| l.contains("stable-diffusion.cpp version"))?;
    Some(line.trim().trim_start_matches("stable-diffusion.cpp").trim().to_string())
}

/// A one-shot HTTP server on 127.0.0.1 for tests: answers the first request with `status`
/// and `chunks` (sent `gap` apart, then the connection closes) and hands back the request body.
#[cfg(test)]
pub(crate) async fn fake_server(status: u16, content_type: &'static str, chunks: Vec<String>, gap: Duration) -> (u16, tokio::sync::oneshot::Receiver<String>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut req = Vec::new();
        let mut buf = [0u8; 8192];
        // Headers, then Content-Length bytes of body.
        let body = loop {
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap())).unwrap_or(0);
                if req.len() >= end + 4 + len {
                    break String::from_utf8_lossy(&req[end + 4..end + 4 + len]).to_string();
                }
            }
        };
        let _ = tx.send(body);
        let head = format!("HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n");
        if sock.write_all(head.as_bytes()).await.is_err() {
            return;
        }
        for c in chunks {
            tokio::time::sleep(gap).await;
            if sock.write_all(c.as_bytes()).await.is_err() {
                return; // the client hung up (cancel)
            }
        }
    });
    (port, rx)
}

/// SSE chunks of a `text_gen` that writes `pieces` and ends with `done`.
#[cfg(test)]
pub(crate) fn sse_answer(pieces: &[&str], finish: &str) -> Vec<String> {
    let mut v = vec![": waiting for the model\n\n".to_string()];
    for p in pieces {
        v.push(format!("event: delta\ndata: {}\n\n", serde_json::json!({ "text": p })));
    }
    let done = serde_json::json!({ "text": pieces.concat(), "finish_reason": finish, "seed": 7, "usage": { "prompt_tokens": 60, "completion_tokens": pieces.len() } });
    v.push(format!("event: done\ndata: {done}\n\n"));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text_req() -> TextGenRequest {
        TextGenRequest {
            prompt: "un gatto".into(),
            system_prompt: "sys".into(),
            images: vec![],
            max_tokens: 64,
            sampling: TextSampling { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, seed: 7 },
            stream: false,
        }
    }

    #[tokio::test]
    async fn text_gen_streams_deltas_and_returns_done() {
        let (port, body) = fake_server(200, "text/event-stream", sse_answer(&["A tabby", " cat on", " a sill."], "stop"), Duration::from_millis(5)).await;
        let mut seen = Vec::new();
        let done = SdcppClient::new(port).text_gen(&text_req(), Duration::from_secs(10), |d| seen.push(d.to_string()), || false).await.unwrap();
        assert_eq!(seen, ["A tabby", " cat on", " a sill."]);
        assert_eq!((done.text.as_str(), done.finish_reason.as_str(), done.seed, done.usage.completion_tokens), ("A tabby cat on a sill.", "stop", 7, 3));
        let sent: serde_json::Value = serde_json::from_str(&body.await.unwrap()).unwrap();
        assert_eq!(sent["stream"], true, "always streamed");
        assert_eq!((sent["prompt"].as_str(), sent["system_prompt"].as_str()), (Some("un gatto"), Some("sys")));
    }

    #[tokio::test]
    async fn text_gen_errors_and_cancel() {
        // A failure after the stream started.
        let chunks = vec!["event: delta\ndata: {\"text\":\"A\"}\n\n".into(), "event: error\ndata: {\"error\":\"out of memory\"}\n\n".into()];
        let (port, _) = fake_server(200, "text/event-stream", chunks, Duration::from_millis(1)).await;
        let e = SdcppClient::new(port).text_gen(&text_req(), Duration::from_secs(10), |_| {}, || false).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::GenerationFailed);
        assert_eq!(e.detail.as_deref(), Some("out of memory"));
        // An engine without the endpoint, and a model without text generation.
        let (port, _) = fake_server(404, "text/plain", vec!["Not Found".into()], Duration::ZERO).await;
        assert_eq!(SdcppClient::new(port).text_gen(&text_req(), Duration::from_secs(10), |_| {}, || false).await.unwrap_err().code, ErrorCode::Unsupported);
        let (port, _) = fake_server(400, "application/json", vec!["{\"error\":\"model has no text generation\"}".into()], Duration::ZERO).await;
        let e = SdcppClient::new(port).text_gen(&text_req(), Duration::from_secs(10), |_| {}, || false).await.unwrap_err();
        assert_eq!((e.code, e.detail.as_deref()), (ErrorCode::MalformedRequest, Some("model has no text generation")));
        // The stream ends without `done`.
        let (port, _) = fake_server(200, "text/event-stream", vec!["event: delta\ndata: {\"text\":\"A\"}\n\n".into()], Duration::ZERO).await;
        assert_eq!(SdcppClient::new(port).text_gen(&text_req(), Duration::from_secs(10), |_| {}, || false).await.unwrap_err().code, ErrorCode::GenerationFailed);
        // Cancel while the server is silent (waiting for the model).
        let (port, _) = fake_server(200, "text/event-stream", sse_answer(&["late"], "stop"), Duration::from_secs(30)).await;
        let t = std::time::Instant::now();
        let cancel_at = t + Duration::from_millis(300);
        let e = SdcppClient::new(port).text_gen(&text_req(), Duration::from_secs(60), |_| {}, || std::time::Instant::now() > cancel_at).await.unwrap_err();
        assert_eq!(e.code, ErrorCode::Cancelled);
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        // No answer within `idle`.
        let (port, _) = fake_server(200, "text/event-stream", sse_answer(&["late"], "stop"), Duration::from_secs(30)).await;
        let e = SdcppClient::new(port).text_gen(&text_req(), Duration::from_millis(400), |_| {}, || false).await.unwrap_err();
        assert!(e.code == ErrorCode::GenerationFailed && e.detail.unwrap().contains("no answer"));
    }

    #[test]
    fn request_serialization_matches_native_schema() {
        let req = ImgGenRequest {
            prompt: "change the red car to a black Porsche".into(),
            negative_prompt: String::new(),
            width: 1920,
            height: 1088,
            seed: 42,
            batch_count: 1,
            strength: None,
            init_image: None,
            mask_image: None,
            ref_images: vec!["AAA".into(), "BBB".into()],
            image_preprocess: vec!["target=ref,mode=none".into()],
            ref_image_args: None,
            sample_params: SampleParams {
                sample_method: Some("euler".into()),
                scheduler: None,
                sample_steps: 30,
                flow_shift: None,
                custom_sigmas: Vec::new(),
                guidance: Guidance { txt_cfg: 6.0, img_cfg: None },
            },
            vae_tiling_params: None,
            hires: None,
            cache_mode: None,
            cache_option: None,
            lora: Vec::new(),
            output_format: "png".into(),
            embed_image_metadata: false,
        };
        let v: serde_json::Value = serde_json::to_value(&req).unwrap();
        assert_eq!(v["width"], 1920);
        assert_eq!(v["height"], 1088);
        assert_eq!(v["sample_params"]["sample_method"], "euler");
        assert_eq!(v["sample_params"]["sample_steps"], 30);
        assert_eq!(v["sample_params"]["guidance"]["txt_cfg"], 6.0);
        assert!(v["sample_params"].get("scheduler").is_none(), "omitted -> backend default");
        assert!(v["sample_params"]["guidance"].get("img_cfg").is_none());
        assert_eq!(v["ref_images"][0], "AAA");
        assert_eq!(v["ref_images"][1], "BBB", "reference order preserved");
        assert!(v.get("init_image").is_none());
        assert!(v.get("mask_image").is_none());
        assert!(v.get("strength").is_none());
        assert!(v.get("vae_tiling_params").is_none());
        assert_eq!(v["embed_image_metadata"], false);
        assert_eq!(v["image_preprocess"][0], "target=ref,mode=none");
        assert!(v.get("hires").is_none() && v.get("cache_mode").is_none() && v.get("cache_option").is_none(), "server defaults apply");
        assert!(v["sample_params"].get("custom_sigmas").is_none(), "default schedule");
        // Turbo: exact schedule.
        let turbo = ImgGenRequest { sample_params: SampleParams { custom_sigmas: vec![1.0, 0.5, 0.0], ..req.sample_params.clone() }, ..req };
        let v = serde_json::to_value(&turbo).unwrap();
        assert_eq!(v["sample_params"]["custom_sigmas"][1], 0.5);
    }

    #[test]
    fn hires_cache_and_tiling_serialization() {
        let req = ImgGenRequest {
            prompt: "a cabin".into(),
            width: 1376,
            height: 768,
            hires: Some(HiresParams {
                enabled: true,
                upscaler: "RealESRGAN_x4plus".into(),
                target_width: 2048,
                target_height: 1152,
                steps: 6,
                denoising_strength: 0.35,
                upscale_tile_size: None,
            }),
            cache_mode: Some("easycache".into()),
            cache_option: Some("threshold=0.2".into()),
            vae_tiling_params: Some(VaeTilingParams { enabled: false, ..Default::default() }),
            ..Default::default()
        };
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["hires"]["enabled"], true);
        assert_eq!(v["hires"]["upscaler"], "RealESRGAN_x4plus");
        assert_eq!((v["hires"]["target_width"].as_u64(), v["hires"]["target_height"].as_u64()), (Some(2048), Some(1152)));
        assert_eq!(v["hires"]["steps"], 6);
        assert!((v["hires"]["denoising_strength"].as_f64().unwrap() - 0.35).abs() < 1e-6);
        assert!(v["hires"].get("upscale_tile_size").is_none());
        assert!(v["hires"].get("scale").is_none(), "target size wins over scale");
        assert_eq!(v["cache_mode"], "easycache");
        assert_eq!(v["cache_option"], "threshold=0.2");
        // Only `enabled` is sent, so the server keeps its configured tile size.
        assert_eq!(v["vae_tiling_params"], serde_json::json!({"enabled": false}));
    }

    #[test]
    fn upscale_request_and_response() {
        let r = UpscaleRequest { image: "AAA".into(), upscaler: Some("RealESRGAN_x4plus".into()), tile_size: None, output_format: "png".into() };
        assert_eq!(serde_json::to_value(&r).unwrap(), serde_json::json!({"image": "AAA", "upscaler": "RealESRGAN_x4plus", "output_format": "png"}));
        let resp: UpscaleResponse = serde_json::from_str(
            r#"{"images":[{"index":0,"b64_json":"iVBOR"}],"upscaler":"RealESRGAN_x4plus","scale":4,"repeats":1,"width":5504,"height":3072,"output_format":"png"}"#,
        )
        .unwrap();
        assert_eq!((resp.scale, resp.width, resp.height), (4, 5504, 3072));
        assert_eq!(resp.images[0].b64_json, "iVBOR");
    }

    #[test]
    fn job_status_parsing() {
        let done = r#"{"completed":1791295347,"created":1791295301,"error":null,"id":"job_1","kind":"img_gen","queue_position":0,
            "result":{"images":[{"b64_json":"iVBORw0K","index":0}],"output_format":"png"},"started":1791295302,"status":"completed"}"#;
        let j: BackendJob = serde_json::from_str(done).unwrap();
        assert_eq!(j.status, BackendJobStatus::Completed);
        assert_eq!(j.result.unwrap().images[0].b64_json, "iVBORw0K");
        let failed = r#"{"id":"job_2","status":"failed","error":{"code":"generation_failed","message":"generate_image returned empty results"}}"#;
        let j: BackendJob = serde_json::from_str(failed).unwrap();
        assert_eq!(j.status, BackendJobStatus::Failed);
        assert_eq!(j.error.unwrap().code, "generation_failed");
        let weird: BackendJob = serde_json::from_str(r#"{"id":"x","status":"paused"}"#).unwrap();
        assert_eq!(weird.status, BackendJobStatus::Unknown);
    }

    #[test]
    fn capabilities_parsing_and_model_match() {
        let caps: Capabilities = serde_json::from_str(r#"{"model":{"name":"qwen-image-2.1-UC-Q4_K_M.gguf","path":"C:/AI/sdcpp/models/qwen21/qwen-image-2.1-UC-Q4_K_M.gguf","stem":"x"},
            "supported_modes":["img_gen"],"features_by_mode":{"img_gen":{"cancel_generating":false,"ref_images":true}},
            "limits":{"max_width":4096,"max_height":4096,"min_width":64,"min_height":64,"max_batch_count":8,"max_queue_size":64}}"#).unwrap();
        assert!(caps.supports_img_gen());
        assert!(caps.img_feature("ref_images"));
        assert!(!caps.img_feature("cancel_generating"));
        assert!(caps.model_matches(std::path::Path::new(r"C:\AI\sdcpp\models\qwen21\qwen-image-2.1-UC-Q4_K_M.gguf")));
        assert!(!caps.model_matches(std::path::Path::new(r"C:\AI\sdcpp\models\other.gguf")));
        assert_eq!(caps.limits.max_width, 4096);
        assert!(!caps.upscale && caps.upscalers.is_empty(), "older servers: no upscaler fields");
        assert!(!caps.text_generation, "official engines: no text endpoint");
        let caps: Capabilities = serde_json::from_str(r#"{"text_generation":true}"#).unwrap();
        assert!(caps.text_generation);

        let caps: Capabilities = serde_json::from_str(
            r#"{"upscale":true,"upscalers":[{"name":"Lanczos","model":false,"image_upscale":false},
                {"name":"RealESRGAN_x4plus","model":true,"image_upscale":true},{"name":"ltx_latent","model":true,"image_upscale":false}]}"#,
        )
        .unwrap();
        assert!(caps.upscale);
        assert!(caps.has_upscaler("RealESRGAN_x4plus", true));
        assert!(caps.has_upscaler("ltx_latent", false) && !caps.has_upscaler("ltx_latent", true));
        assert!(!caps.has_upscaler("Lanczos", false), "built-in filters are not models");
    }

    #[test]
    fn text_gen_request_matches_api() {
        let r = TextGenRequest {
            prompt: "un gatto".into(),
            system_prompt: String::new(),
            images: vec![],
            max_tokens: 512,
            sampling: TextSampling { temperature: 0.7, top_p: 0.8, top_k: 20, presence_penalty: 1.5, seed: 42 },
            stream: true,
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["system_prompt"], "", "always sent: the server has no built-in prompt");
        assert!(v.get("images").is_none());
        assert_eq!((v["max_tokens"].as_u64(), v["sampling"]["top_k"].as_u64(), v["sampling"]["seed"].as_i64()), (Some(512), Some(20), Some(42)));
        assert!((v["sampling"]["presence_penalty"].as_f64().unwrap() - 1.5).abs() < 1e-6);
        let v = serde_json::to_value(TextGenRequest { images: vec!["AAA".into()], ..r }).unwrap();
        assert_eq!(v["images"][0], "AAA");
    }

    #[test]
    fn sse_parser_splits_events_across_chunks() {
        // The documented stream, cut at awkward places: inside a line, inside "é", in "\r\n".
        let body = ": waiting for the model\r\n\r\nevent: delta\r\ndata: {\"text\":\"A caf\u{e9}\"}\r\n\r\nevent: delta\ndata: {\"text\":\" at night\"}\n\nevent: done\ndata: {\"text\":\"A caf\u{e9} at night\",\"finish_reason\":\"stop\",\"seed\":7,\"usage\":{\"prompt_tokens\":96,\"completion_tokens\":4},\"timings\":{\"decode_s\":0.1}}\n\n";
        let bytes = body.as_bytes();
        let e_acute = body.find('\u{e9}').unwrap();
        let cuts = [5, 24, 30, e_acute + 1, e_acute + 2, 90, bytes.len()];
        let mut p = SseParser::default();
        let mut events = Vec::new();
        let mut start = 0;
        for &c in &cuts {
            events.extend(p.push(&bytes[start..c]));
            start = c;
        }
        assert_eq!(events.len(), 3, "{events:?}");
        assert_eq!(events[0], ("delta".to_string(), "{\"text\":\"A caf\u{e9}\"}".to_string()));
        assert_eq!(events[1].0, "delta");
        let done: TextGenDone = serde_json::from_str(&events[2].1).unwrap();
        assert_eq!((done.text.as_str(), done.finish_reason.as_str(), done.seed), ("A caf\u{e9} at night", "stop", 7));
        assert_eq!(done.usage, TextUsage { prompt_tokens: 96, completion_tokens: 4 });
        // An event without an `event:` line, and the error event.
        assert_eq!(p.push(b"data: x\n\nevent: error\ndata: {\"error\":\"boom\"}\n\n"), vec![("message".into(), "x".into()), ("error".into(), "{\"error\":\"boom\"}".into())]);
        assert!(p.push(b"event: delta\ndata: {\"te").is_empty(), "incomplete event waits");
    }

    #[test]
    fn base64_roundtrip_and_data_urls() {
        let data = vec![0u8, 1, 2, 250];
        assert_eq!(b64_decode(&b64(&data)).unwrap(), data);
        assert_eq!(b64_decode(&format!("data:image/png;base64,{}", b64(&data))).unwrap(), data);
        assert!(b64_decode("!!!").is_err());
    }

    #[test]
    fn version_banner() {
        assert_eq!(parse_version_banner("stable-diffusion.cpp version unknown, commit 3f8527a\nUsage: ...").unwrap(), "version unknown, commit 3f8527a");
        assert!(parse_version_banner("nothing").is_none());
    }
}
