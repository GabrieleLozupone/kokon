//! The process's one ONNX Runtime environment. `ort` allows a single environment per process: the
//! fast stickers (matting.rs) and the AI watermark (watermark/) each built their own, so whichever
//! ran second failed ("only one environment is allowed per process"; seen on the Mac 2026-11-04: a
//! sticker first, then every result unwatermarked). Both take it from here.

use std::path::Path;
use std::sync::OnceLock;

use ort::environment::Environment;
use ort::session::Session;
use ort::session::builder::{AutoDevicePolicy, GraphOptimizationLevel};

static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

/// The shared environment, built on first use (a cheap handle: clones share it).
pub fn environment() -> Result<Environment, String> {
    ENV.get_or_init(|| ort::init().with_name("kokon").build().map_err(|e| e.to_string())).clone()
}

/// A CPU session of the model at `path` on `threads` threads (graph optimised).
///
/// The CPU is asked for explicitly. `ort` (rc.14) sets every new session to pick its device "for
/// efficiency", and the only macOS runtime it downloads has CoreML, so on a Mac the session went to
/// the Neural Engine: creating BiRefNet's session waited on ANECompilerService for 13+ minutes and
/// never finished (M2 Pro, 2026-11-04; the quick cut-out "did nothing"). An explicit CPU provider
/// list did not stop it, only the device policy does. On the CPU: session 1.4 s, matte ~6 s there.
pub fn cpu_session(env: &Environment, path: &Path, threads: usize) -> Result<Session, String> {
    Session::builder(env)
        .map_err(|e| e.to_string())?
        .with_auto_device(AutoDevicePolicy::PreferCPU)
        .map_err(|e| e.to_string())?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|e| e.to_string())?
        .with_intra_threads(threads)
        .map_err(|e| e.to_string())?
        .commit_from_file(path)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn one_environment_for_everyone() {
        let a = super::environment().unwrap();
        let b = super::environment().unwrap();
        drop((a, b));
        assert!(super::environment().is_ok());
    }
}
