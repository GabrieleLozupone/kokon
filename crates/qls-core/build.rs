// macOS: ONNX Runtime's CoreML code (in the static runtime `ort` downloads for the Mac) calls
// `___isPlatformVersionAtLeast` (Objective-C `@available`), which lives in clang's runtime library.
// The release build (thin LTO) did not get it and every binary with qls-core failed to link
// (0.12.0, 2026-11-04; dev builds linked). Linking libclang_rt.osx.a from the toolchain fixes it.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let Ok(out) = std::process::Command::new("clang").arg("--print-runtime-dir").output() else { return };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if std::path::Path::new(&dir).join("libclang_rt.osx.a").is_file() {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    } else {
        println!("cargo:warning=libclang_rt.osx.a not found in {dir}: a release build may fail to link ONNX Runtime");
    }
}
