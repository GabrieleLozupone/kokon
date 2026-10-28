#!/bin/bash
# The Mac engine's benchmark for testers: builds kokon-engine-mac, runs `bench` on Kokon's model files (a few
# minutes; the Mac should be plugged in and otherwise idle) and writes kokon-bench-report.md to paste in GitHub.
#
#   bash engine-mac/tools/bench.sh [--quick] [--encoder P --dit P --vae P]
#
# Needs the Xcode command line tools (`xcode-select --install`) and Kokon's models (Kokon set up once, or the three
# files passed by hand). Nothing is uploaded: the report is a text file.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$here" && swift build -c release 2>&1 | tail -1)
commit="$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)"
out="$PWD/kokon-bench-report.md"
KOKON_ENGINE_VERSION="0.1.1 (experimental), commit $commit" "$here/.build/release/kokon-engine-mac" bench --out "$out" "$@"
