#!/usr/bin/env bash
# Compile the Swift sidecar to vendor/macos-mcp-helper.
#
# Why we avoid `swift build`: on macOS hosts where the Command Line Tools'
# Swift toolchain is older than the installed SDK (Sonoma+ moves fast),
# swift-package crashes with a dyld symbol error inside llbuild. swiftc
# itself handles the mismatch fine once we drop -target.
#
# Requirements:
#   - macOS 13+
#   - Command Line Tools (`xcode-select --install`) — kept up to date
#   - If `swiftc` errors with "this SDK is not supported by the compiler",
#     run: softwareupdate --list, then sudo softwareupdate -i "<latest CLT>"

set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="vendor"
OUT_BIN="$OUT_DIR/macos-mcp-helper"
SRC="swift-helper/Sources/MacosMcpHelper"

mkdir -p "$OUT_DIR"

# Universal binary: build arm64 + x86_64 slices, lipo together.
ARM_BIN="$OUT_DIR/.helper.arm64"
X86_BIN="$OUT_DIR/.helper.x86_64"

echo "[build-helper] compiling arm64 slice…"
swiftc -O -parse-as-library \
  -sdk "${MACOS_MCP_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk}" \
  -target arm64-apple-macos14.0 \
  -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit \
  -framework CoreGraphics -framework UniformTypeIdentifiers -framework Foundation \
  -o "$ARM_BIN" \
  "$SRC"/*.swift

if [[ "${BUILD_UNIVERSAL:-0}" == "1" ]]; then
  echo "[build-helper] compiling x86_64 slice…"
  swiftc -O -parse-as-library \
    -sdk "${MACOS_MCP_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk}" \
    -target x86_64-apple-macos14.0 \
    -framework AppKit -framework ApplicationServices -framework ScreenCaptureKit \
    -framework CoreGraphics -framework UniformTypeIdentifiers -framework Foundation \
    -o "$X86_BIN" \
    "$SRC"/*.swift
  echo "[build-helper] lipo into universal…"
  lipo -create -output "$OUT_BIN" "$ARM_BIN" "$X86_BIN"
  rm -f "$ARM_BIN" "$X86_BIN"
else
  mv "$ARM_BIN" "$OUT_BIN"
fi

chmod 755 "$OUT_BIN"
ls -lh "$OUT_BIN"
file "$OUT_BIN"
echo "[build-helper] done."
