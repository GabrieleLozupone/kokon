#!/usr/bin/env bash
# Builds a portable ONNX Runtime for Kokon: baseline x86-64-v2 (SSE4.2 + POPCNT), with the
# AVX/AVX2/AVX-512 kernels still compiled and chosen at runtime by MLAS.
#
#   bash tools/ort-portable/build-ort-portable.sh
#
# Result: $KOKON_DEPS/ort-portable/lib/libonnxruntime.a (Linux) or onnxruntime.lib (Windows,
# see build-ort-portable.ps1). Point ORT_LIB_LOCATION at that lib folder when building Kokon:
#
#   export ORT_LIB_LOCATION=$HOME/kokon-deps/ort-portable/lib
#   cargo build -p qls-service --release
#
# Why not ort's prebuilt binaries: they are built with -march=x86-64-v3 / AVX2 baseline and
# stop with SIGILL on a Xeon X5670 (SSE4.2, no AVX). See README.md.
set -euo pipefail

ORT_VERSION="${ORT_VERSION:-v1.31.0}"
KOKON_DEPS="${KOKON_DEPS:-$HOME/kokon-deps}"
SRC="$KOKON_DEPS/onnxruntime"
BUILD="$KOKON_DEPS/ort-build"
PREFIX="$KOKON_DEPS/ort-portable"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "--clean" ]; then
  rm -rf "$BUILD" "$PREFIX"
fi

if [ ! -d "$SRC/.git" ]; then
  echo "==> Cloning ONNX Runtime $ORT_VERSION into $SRC"
  mkdir -p "$KOKON_DEPS"
  git clone --recursive --depth 1 --branch "$ORT_VERSION" https://github.com/microsoft/onnxruntime "$SRC"
fi

# The app and ORT must agree on the C++ toolchain: Ubuntu 22.04's g++ 11 is too old for the
# libstdc++ ORT is built with, and the release build uses g++-13 (docs/linux.md).
if command -v gcc-13 >/dev/null && command -v g++-13 >/dev/null; then
  export CC="${CC:-gcc-13}"
  export CXX="${CXX:-g++-13}"
fi

# MLAS keeps its FP16 conversion kernel in x86_64/cvtfp16Avx.S, with AVX512-FP16 mnemonics. CMake
# does not forward -m flags to the assembler, so that file assembles only when GNU as knows them:
# as 2.42 (this machine) does, Ubuntu 22.04's 2.38 does not — that is why the CI job failed there.
# The kernel is picked at runtime only on a CPU with AVX512-FP16, so when the assembler cannot
# assemble it, skip the file and the reference to it: the library still runs on every CPU Kokon
# supports, and MLAS uses its SSE2 kernel there, as it does on macOS.
if [ "$(uname -m)" = "x86_64" ] || [ "$(uname -m)" = "amd64" ]; then
  TMP="${TMPDIR:-/tmp}/kokon-ort-portable"
  mkdir -p "$TMP"
  printf '.intel_syntax noprefix\n\tvcvtneeph2ps ymm0, ymmword PTR [rdi]\n' > "$TMP/fp16.s"
  if command -v as >/dev/null && ! as -o "$TMP/fp16.o" "$TMP/fp16.s" 2>/dev/null; then
    echo "as does not know the AVX512-FP16 mnemonics ($(as --version | head -1))"
    echo "  Skipping MLAS's x86_64/cvtfp16Avx.S and the reference to its kernel."
    if [ -d "$SRC/.git" ]; then git -C "$SRC" checkout -- cmake/onnxruntime_mlas.cmake onnxruntime/core/mlas/lib/platform.cpp; fi
    sed -i 's|^\s*${MLAS_SRC_DIR}/x86_64/cvtfp16Avx\.S|        # cvtfp16Avx.S: assembler without AVX512-FP16|' "$SRC/cmake/onnxruntime_mlas.cmake"
    sed -i 's|this->CastF16ToF32Kernel = &MlasCastF16ToF32KernelAvx;|            /* assembler without AVX512-FP16: no kernel */|' "$SRC/onnxruntime/core/mlas/lib/platform.cpp"
    if grep -q '${MLAS_SRC_DIR}/x86_64/cvtfp16Avx\.S' "$SRC/cmake/onnxruntime_mlas.cmake"; then
      echo "  These patterns are for ONNX Runtime $ORT_VERSION; they did not match, so the build will stop at that file."
    fi
  fi
fi

# ONNX Runtime applies its own patch with `patch --binary --ignore-whitespace -p1`, which compares
# bytes: the .patch files must be the bytes the repository stores (that is why the clone is made
# with core.autocrlf=false and the files are taken from git). And the ONNX patch is not byte-exact
# against the sources it patches — its context has 4-space indentation where ONNX v1.22.0 has 2 — so
# it only applies with whitespace tolerance and fuzz, and implementations disagree: the CI runner's
# patch 2.5.9 refused two hunks that GNU patch 2.7.6 applies. patches/onnx-v1.22.0.patch is the same
# hunks written against the pinned sources, so any implementation applies them; if the pin is a
# different version, keep upstream's file and say so.
ONNX_PIN='onnx;https://github.com/onnx/onnx/archive/refs/tags/v1.22.0.zip;2b2cd58ac7a26df5371266149e0c76776330cdf1'
DEPS="$SRC/cmake/external/onnxruntime_external_deps.cmake"
if grep -q "^$ONNX_PIN$" "$SRC/cmake/deps.txt" && [ -f "$HERE/patches/onnx-v1.22.0.patch" ]; then
  # Only the branch CMake uses when it finds patch; the other one stays empty on purpose.
  sed -i "s|^\s*set(ONNXRUNTIME_ONNX_PATCH_COMMAND \${Patch_EXECUTABLE} --binary --ignore-whitespace -p1 < \${PROJECT_SOURCE_DIR}/patches/onnx/onnx.patch)|  set(ONNXRUNTIME_ONNX_PATCH_COMMAND \${Patch_EXECUTABLE} --binary --ignore-whitespace -p1 < $HERE/patches/onnx-v1.22.0.patch)|" "$DEPS"
else
  echo "  The ONNX patch used is the one in the clone: patches/onnx-v1.22.0.patch was generated for ONNX v1.22.0, and the pin is not that."
fi
if ! command -v patch >/dev/null; then
  echo "✗ patch is not installed: ONNX Runtime would skip its dependency patches and build ONNX without them"
  exit 1
fi

GEN=()
if command -v ninja >/dev/null; then
  GEN=(-G Ninja)
fi

# x86-64-v2 is SSE4.2 + POPCNT, the floor we support. The USE_AVX* options control the
# baseline of the rest of ORT; the MLAS AVX/AVX2/AVX-512 kernels keep their own per-file
# flags and are selected at runtime, so newer CPUs still get them.
MARCH=()
case "$(uname -m)" in
  x86_64|amd64) MARCH=(-DCMAKE_C_FLAGS="-march=x86-64-v2" -DCMAKE_CXX_FLAGS="-march=x86-64-v2") ;;
esac

echo "==> Configuring ONNX Runtime (portable, CPU only)"
cmake -S "$HERE" -B "$BUILD" "${GEN[@]}" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" \
  -DONNXRUNTIME_SOURCE_DIR="$SRC" \
  "${MARCH[@]}" \
  -Donnxruntime_USE_AVX=OFF \
  -Donnxruntime_USE_AVX2=OFF \
  -Donnxruntime_USE_AVX512=OFF \
  -Donnxruntime_BUILD_UNIT_TESTS=OFF \
  -Donnxruntime_CLIENT_PACKAGE_BUILD=ON \
  -Donnxruntime_USE_KLEIDIAI=OFF \
  --compile-no-warning-as-error

echo "==> Building (this takes a while)"
cmake --build "$BUILD" --config Release --parallel "$(nproc)"

echo "==> Installing to $PREFIX"
cmake --install "$BUILD" --config Release

LIB="$PREFIX/lib/libonnxruntime.a"
[ -f "$LIB" ] || { echo "✗ $LIB was not produced"; exit 1; }
echo "✓ Portable ONNX Runtime: $LIB ($(du -h "$LIB" | cut -f1))"
echo "  Use: export ORT_LIB_LOCATION=$PREFIX/lib"
