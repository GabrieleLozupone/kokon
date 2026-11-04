//! The process's one ONNX Runtime environment. `ort` allows a single environment per process: the
//! fast stickers (matting.rs) and the AI watermark (watermark/) each built their own, so whichever
//! ran second failed ("only one environment is allowed per process"; seen on the Mac 2026-11-04: a
//! sticker first, then every result unwatermarked). Both take it from here.

use std::sync::OnceLock;

use ort::environment::Environment;

static ENV: OnceLock<Result<Environment, String>> = OnceLock::new();

/// The shared environment, built on first use (a cheap handle: clones share it).
pub fn environment() -> Result<Environment, String> {
    ENV.get_or_init(|| ort::init().with_name("kokon").build().map_err(|e| e.to_string())).clone()
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
