# Portable ONNX Runtime for Kokon

`ort`'s prebuilt ONNX Runtime binaries are built with an **AVX2 baseline**
(`-march=x86-64-v3` on Linux, `/arch:AVX2` on Windows). On a CPU without AVX2 — a Xeon X5670
(SSE4.2, no AVX) or any pre-2011 processor — `kokon-service` stops with `SIGILL` in a static
initializer before `main`, so the app cannot start. See [docs/linux.md](../../docs/linux.md).

This folder builds ONNX Runtime from source with the **lowest baseline Kokon supports** while
keeping MLAS's AVX/AVX2/AVX-512 kernels, which ONNX Runtime chooses **at runtime**:

| Platform | Baseline | Why |
|---|---|---|
| Linux x86-64 | `-march=x86-64-v2` (SSE4.2 + POPCNT) | same floor as the Rust code |
| Windows x64 | MSVC default (SSE2) + no `/arch:AVX*` | runs on every supported CPU |

`onnxruntime_USE_AVX`, `onnxruntime_USE_AVX2` and `onnxruntime_USE_AVX512` are **OFF**: they
change the baseline of the non-MLAS code. MLAS still compiles the fast kernels with their own
per-file flags (`-mavx2`, …) and picks one with `GetMlasPlatform()` at runtime, so a modern CPU
keeps AVX2/AVX-512 performance.

The CMake wrapper bundles ONNX Runtime's static libraries into one archive
(`libonnxruntime.a` / `onnxruntime.lib`), the layout `ort-sys` expects when `ORT_LIB_LOCATION`
points at the folder. It is based on
[pykeio/ort-artifacts `src/static-build/CMakeLists.txt`](https://github.com/pykeio/ort-artifacts/blob/main/src/static-build/CMakeLists.txt)
(Apache-2.0).

## Linux

```bash
bash tools/ort-portable/build-ort-portable.sh          # add --clean to rebuild from scratch
export ORT_LIB_LOCATION=$HOME/kokon-deps/ort-portable/lib
cargo build -p qls-service --release
./target/release/kokon-service --version                # must not SIGILL on SSE4.2
```

The release script (`scripts/build-release-linux.sh`) defaults to
`$HOME/kokon-deps/ort-portable/lib` and stops with a clear message if it is missing.

## Windows

```powershell
powershell -ExecutionPolicy Bypass -File tools\ort-portable\build-ort-portable.ps1
$env:ORT_LIB_LOCATION = "$env:USERPROFILE\kokon-deps\ort-portable\lib"
powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

Needs Visual Studio 2022 or newer (Desktop C++), CMake ≥ 3.26, Python 3 and Git.

The script asks `vswhere` which Visual Studio is installed and picks the matching CMake
generator; if CMake cannot use it (a newer Visual Studio, a runner image without the Visual
Studio generator), it retries with Ninja after importing the MSVC environment from
`vcvarsall.bat`. `KOKON_CMAKE_GENERATOR` overrides the choice, e.g. `Ninja` from a Developer
PowerShell.

Dependency patches: ONNX Runtime runs them with `patch --binary --ignore-whitespace -p1`, which
compares bytes, and its `.gitattributes` (`* text=auto`) makes a Windows checkout CRLF while the
dependency sources come from zip archives with LF. Two things the CI showed: a CRLF copy of a
patch file is refused by every patch tool, and the same `onnx.patch` that GNU patch 2.7.6 applies
failed in two hunks with the runner's patch (Strawberry) — no line-ending rule controls that. So
the script clones with `core.autocrlf=false`, keeps the `.patch` files as LF, and patches ONNX
with `git apply -p1 --ignore-whitespace`, which compares lines and behaves the same everywhere.
It stops with the file named if the patch is not applied in the sources CMake downloaded: without
those hunks ONNX is different (`ONNX_MINIMAL_BUILD`, `assertions.h`, `tensor.h`,
`scoped_resource.h`).

## Requirements and notes

- ONNX Runtime **v1.31.0** is the version `ort = 2.0.0-rc.14` (feature `api-31`) expects.
  Change `ORT_VERSION` and `ort` together.
- The build is large: a few GB of disk and ~30–90 minutes depending on the machine.
- The assembler must know the **AVX512-FP16** mnemonics for MLAS's `x86_64/cvtfp16Avx.S`; CMake
  forwards no `-m` flags to it. GNU as 2.38 (Ubuntu 22.04, the CI image) does not, as 2.42 does.
  `build-ort-portable.sh` checks this and skips the file and the reference to its kernel when the
  assembler cannot assemble it: that kernel is only chosen on an AVX512-FP16 CPU, so the library
  behaves the same on every CPU Kokon supports.
- Build Linux releases on **Ubuntu 22.04** (glibc 2.35) so the static archive and the app match
  the supported floor. The local Mint 24.04 build is for validation only.
- Do not add `-march=native`, `/arch:AVX`, `/arch:AVX2`, or turn `USE_AVX2` back on: that
  reintroduces the crash on SSE4.2/AVX-only CPUs.
- Verify the result on the oldest CPU available (this repository's target is a Xeon X5670).
