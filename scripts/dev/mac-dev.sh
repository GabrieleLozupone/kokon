#!/usr/bin/env bash
# Runs Kokon from source on an Apple Silicon Mac (development build, no installer).
#
#   bash scripts/dev/mac-dev.sh            # build and start the app
#   bash scripts/dev/mac-dev.sh --check    # only check the prerequisites
#
# Needs: macOS 15+ (Sequoia), Xcode Command Line Tools, Rust (rustup), Node.js 22+.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
TRIPLE=aarch64-apple-darwin

fail() { echo "✗ $1"; exit 1; }
ok() { echo "✓ $1"; }

[ "$(uname -s)" = Darwin ] || fail "This script is for macOS."
[ "$(uname -m)" = arm64 ] || fail "Kokon on Mac needs Apple Silicon (M1 or newer)."
MACOS="$(sw_vers -productVersion)"
[ "${MACOS%%.*}" -ge 15 ] || fail "macOS $MACOS: Kokon needs macOS 15 (Sequoia) or newer."
ok "macOS $MACOS on $(sysctl -n machdep.cpu.brand_string), $(( $(sysctl -n hw.memsize) / 1073741824 )) GB unified memory"
xcode-select -p >/dev/null 2>&1 || fail "Xcode Command Line Tools missing: run  xcode-select --install"
ok "Xcode Command Line Tools"
command -v cargo >/dev/null || fail "Rust missing: run  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh  then open a new terminal"
ok "$(cargo --version)"
command -v node >/dev/null || fail "Node.js missing: install Node 22 LTS from https://nodejs.org (or  brew install node@22)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node $(node -v): version 22 or newer is needed."
ok "Node $(node -v)"
[ "${1:-}" = "--check" ] && exit 0

echo "→ JavaScript packages"
npm ci --no-audit --no-fund
(cd mcp && npm ci --no-audit --no-fund && npm run build)

echo "→ kokon-service (Rust, first build takes a few minutes)"
cargo build -p qls-service

# Tauri expects its sidecars under src-tauri/binaries with the target triple.
mkdir -p src-tauri/binaries
cp target/debug/kokon-service "src-tauri/binaries/kokon-service-$TRIPLE"
# Dev stand-in for the MCP executable (the Windows build packs Node into one .exe).
cat > "src-tauri/binaries/kokon-mcp-$TRIPLE" <<EOF
#!/bin/sh
exec node "$ROOT/mcp/build/kokon-mcp.cjs" "\$@"
EOF
chmod +x "src-tauri/binaries/kokon-mcp-$TRIPLE"

echo "→ Starting Kokon (close the window to stop)"
npx tauri dev
