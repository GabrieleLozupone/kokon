#!/usr/bin/env bash
# Builds the Linux release on Ubuntu 22.04 (a WSL distro works): kokon-service, kokon-mcp and the
# Kokon packages ("Kokon_<version>_amd64.deb", "Kokon-<version>-1.x86_64.rpm"), copied to
# dist-release/ with their updater entries.
#
#   bash scripts/build-release-linux.sh --setup   # once: system packages, Rust, Node 22
#   bash scripts/build-release-linux.sh
#
# Ubuntu 22.04 on purpose: binaries built there (glibc 2.35) also run on Debian 12, Ubuntu 24.04
# and Fedora; the engine is built the same way (stable-diffusion.cpp fork, kokon-linux branch).
# Run it from a clone on the Linux file system, never from /mnt/c: npm would replace the
# Windows node_modules with Linux binaries, and builds there are very slow.
set -euo pipefail
cd "$(dirname "$0")/.."
TRIPLE=x86_64-unknown-linux-gnu

case "$(pwd)" in /mnt/*) echo "✗ Run this from a clone on the Linux file system (e.g. git clone /mnt/c/AI/qwen-local-studio ~/kokon), not $(pwd)."; exit 1 ;; esac

if [ "${1:-}" = "--setup" ]; then
  sudo apt-get update
  sudo apt-get install -y build-essential curl wget file pkg-config libssl-dev libgtk-3-dev \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf
  # Not Ubuntu's cargo package (too old for this workspace): rustup's current stable.
  command -v rustup >/dev/null || [ -x "$HOME/.cargo/bin/rustup" ] || curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  if ! node --version 2>/dev/null | grep -q '^v2[2-9]'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  echo "✓ Ready. Open a new shell (for cargo) and run: bash scripts/build-release-linux.sh"
  exit 0
fi

. "$HOME/.cargo/env" 2>/dev/null || true
cargo --version | grep -qE "^cargo 1.(8[4-9]|9[0-9]|[1-9][0-9]{2})" || { echo "✗ $(cargo --version) is too old (Ubuntu's package?): sudo apt remove cargo rustc, then run with --setup."; exit 1; }
for c in cargo node npm pkg-config; do command -v "$c" >/dev/null || { echo "✗ $c not found: run with --setup first."; exit 1; }; done
pkg-config --exists webkit2gtk-4.1 || { echo "✗ webkit2gtk-4.1 not found: run with --setup first."; exit 1; }

echo "1/5 Packages"
npm ci --no-audit --no-fund
(cd mcp && npm ci --no-audit --no-fund)

echo "2/5 Tests (Rust core + frontend)"
cargo test -p qls-core --release --quiet
# The MCP protocol test runs the newest target/*/kokon-service: build this version's first.
cargo build -p qls-service --release
npx vitest run

echo "3/5 kokon-service (release)"
mkdir -p src-tauri/binaries
cp target/release/kokon-service "src-tauri/binaries/kokon-service-$TRIPLE"

echo "4/5 kokon-mcp + MCP tests (they drive the bundle and the service built above)"
(cd mcp && npm run build:exe && npx vitest run)

echo "5/5 Kokon packages (signed for the in-app updater)"
# Updates are verified against the public key in tauri.conf.json: same key as Windows and Mac.
if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  KEY="$HOME/.tauri/kokon-updater.key"
  [ -f "$KEY" ] || KEY="$(ls /mnt/c/Users/*/.tauri/kokon-updater.key 2>/dev/null | head -1)"
  [ -f "$KEY" ] || { echo "✗ Updater signing key not found (~/.tauri/kokon-updater.key; see docs/releasing.md)"; exit 1; }
  export TAURI_SIGNING_PRIVATE_KEY="$KEY"
fi
npx tauri build --target "$TRIPLE"

BUNDLE="target/$TRIPLE/release/bundle"
DEB="$(ls -t "$BUNDLE"/deb/*.deb | head -1)"
RPM="$(ls -t "$BUNDLE"/rpm/*.rpm | head -1)"
mkdir -p dist-release
for p in "$DEB" "$RPM"; do
  [ -f "$p.sig" ] || npx tauri signer sign -f "$TAURI_SIGNING_PRIVATE_KEY" "$p"
done
node scripts/release/updater.mjs fragment linux-x86_64-deb "$DEB"
node scripts/release/updater.mjs fragment linux-x86_64-rpm "$RPM"
# The engine-free binaries must run on Debian 12 / Ubuntu 22.04 (glibc 2.35).
for f in "target/$TRIPLE/release/kokon" target/release/kokon-service; do
  printf '%s needs ' "$f"; objdump -T "$f" | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1
done
ls -lh dist-release/*.deb dist-release/*.rpm
echo "Packages: $(pwd)/dist-release"
