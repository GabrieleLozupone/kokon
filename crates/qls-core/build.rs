// Linking the ONNX Runtime that `ort` downloads (AI watermark, fast stickers) into release builds.
//
// macOS: its CoreML code calls `___isPlatformVersionAtLeast` (Objective-C `@available`), which lives in
// clang's runtime library. The release build (thin LTO) did not get it and every binary with qls-core
// failed to link (0.12.0, 2026-11-04; dev builds linked). Linking libclang_rt.osx.a fixes it.
//
// Linux: it is built with GCC 13 and needs its libstdc++ (GLIBCXX_3.4.32); Ubuntu 22.04, which the
// .deb, .rpm and Docker image are built on so they run on glibc 2.35, has GCC 11's. With g++-13
// installed (ubuntu-toolchain-r PPA; docs/linux.md), its libstdc++.a is put in a folder of its own
// and found before the system's .so: the service carries the newer libstdc++ statically and users
// need nothing new. Without g++-13 the system's is used (enough on Ubuntu 24.04 and newer).
use std::path::Path;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => clang_runtime(),
        Ok("linux") => static_libstdcxx(),
        _ => {}
    }
}

fn clang_runtime() {
    let Ok(out) = Command::new("clang").arg("--print-runtime-dir").output() else { return };
    let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if Path::new(&dir).join("libclang_rt.osx.a").is_file() {
        println!("cargo:rustc-link-search=native={dir}");
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
    } else {
        println!("cargo:warning=libclang_rt.osx.a not found in {dir}: a release build may fail to link ONNX Runtime");
    }
}

fn static_libstdcxx() {
    for v in (13..=20).rev() {
        let Ok(out) = Command::new(format!("g++-{v}")).arg("-print-file-name=libstdc++.a").output() else { continue };
        let lib = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !out.status.success() || !Path::new(&lib).is_absolute() || !Path::new(&lib).is_file() {
            continue;
        }
        let dir = Path::new(&std::env::var("OUT_DIR").unwrap()).join("static-libstdcxx");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(&lib, dir.join("libstdc++.a")).unwrap();
        println!("cargo:rustc-link-search=native={}", dir.display());
        return;
    }
}
