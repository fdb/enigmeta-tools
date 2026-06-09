#!/usr/bin/env bash
#
# Cloudflare Pages build script.
#
# Cloudflare's build image runs this; it ensures the Rust + wasm-pack toolchain
# is present (installing what's missing), then runs the normal site build.
# Set this as the Pages "Build command": bash scripts/cf-build.sh
# Build output directory: dist
set -euo pipefail

WASM_PACK_VERSION="0.13.1"

# 1. Rust toolchain — manage with rustup so we get a current stable (our deps
#    need >= 1.73), regardless of whatever the build image may preinstall.
if ! command -v rustup >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable
fi
export PATH="$HOME/.cargo/bin:$PATH"

rustup default stable
rustup target add wasm32-unknown-unknown

# 2. wasm-pack — download the prebuilt binary (no compile) if missing.
if ! command -v wasm-pack >/dev/null 2>&1; then
  pkg="wasm-pack-v${WASM_PACK_VERSION}-x86_64-unknown-linux-musl"
  url="https://github.com/rustwasm/wasm-pack/releases/download/v${WASM_PACK_VERSION}/${pkg}.tar.gz"
  curl -fsSL "$url" | tar -xz -C /tmp
  mkdir -p "$HOME/.cargo/bin"
  install -m 0755 "/tmp/${pkg}/wasm-pack" "$HOME/.cargo/bin/wasm-pack"
fi

# 3. Node dependencies — Cloudflare usually installs these first, but be safe.
[ -d node_modules ] || npm ci

# 4. Build the WASM + static site into dist/.
npm run build
