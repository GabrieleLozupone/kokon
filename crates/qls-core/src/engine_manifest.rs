//! Engine updates without an app release: `engine.json` in the Kokon repository names the
//! newest stable-diffusion.cpp release tested with Kokon. The service reads its cached copy at
//! start and fetches a fresh one every [`CHECK_EVERY`]; a newer, valid release replaces the
//! catalog's engine pins ([`catalog::apply_engine_release`]), so the engine check reports an
//! update and the app offers the download (What's new / Setup), checked by SHA-256 as always.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::catalog::{self, EngineManifest};

/// Published from the repository's default branch.
pub const MANIFEST_URL: &str = "https://raw.githubusercontent.com/GabrieleLozupone/kokon/master/engine.json";
/// How old the cached manifest may get before it is fetched again (2.5 days).
pub const CHECK_EVERY: Duration = Duration::from_secs(60 * 3600);
/// How often the service looks at the cache's age.
const WAKE_EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Debug, Serialize, Deserialize)]
struct Cached {
    /// Seconds since the Unix epoch of the last successful fetch.
    checked_at: u64,
    manifest: EngineManifest,
}

fn cache_path() -> PathBuf {
    crate::config::config_dir().join("engine-manifest.json")
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn read_cache() -> Option<Cached> {
    serde_json::from_slice(&std::fs::read(cache_path()).ok()?).ok()
}

fn apply(m: &EngineManifest, app_version: &str) {
    match catalog::apply_engine_release(m, app_version) {
        Ok(true) => tracing::info!("engine manifest: release {} available", m.kokon.as_ref().map_or("", |k| k.tag.as_str())),
        Ok(false) => {}
        Err(e) => tracing::warn!("engine manifest ignored: {e}"),
    }
}

async fn fetch() -> Result<EngineManifest, String> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(20)).user_agent("kokon-service").build().map_err(|e| e.to_string())?;
    let r = client.get(MANIFEST_URL).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("HTTP {}", r.status()));
    }
    r.json::<EngineManifest>().await.map_err(|e| e.to_string())
}

/// Fetches the manifest when the cached one is older than [`CHECK_EVERY`] (or `force`), caches
/// it and applies it. Failures keep the last good release.
pub async fn check(app_version: &str, force: bool) {
    let cached = read_cache();
    if !force && cached.as_ref().is_some_and(|c| now().saturating_sub(c.checked_at) < CHECK_EVERY.as_secs()) {
        return;
    }
    match fetch().await {
        Ok(m) => {
            apply(&m, app_version);
            let c = Cached { checked_at: now(), manifest: m };
            if let Err(e) = std::fs::write(cache_path(), serde_json::to_vec_pretty(&c).unwrap_or_default()) {
                tracing::warn!("engine manifest: could not save the cache: {e}");
            }
        }
        Err(e) => tracing::info!("engine manifest: check failed ({e}); trying again later"),
    }
}

/// Applies the cached manifest right away, then checks for a newer one for as long as the
/// service runs.
pub async fn run(app_version: &'static str) {
    if let Some(c) = read_cache() {
        apply(&c.manifest, app_version);
    }
    loop {
        check(app_version, false).await;
        tokio::time::sleep(WAKE_EVERY).await;
    }
}
