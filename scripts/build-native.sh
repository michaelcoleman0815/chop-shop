#!/usr/bin/env bash
# Builds the macOS Vision helper used for subject tracking.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/resources/bin"
# Built for the oldest macOS the app runs on, not the build machine's own.
MIN_MACOS="$("$ROOT/scripts/macos-min.sh")"
swiftc -O -target "arm64-apple-macos$MIN_MACOS" -o "$ROOT/resources/bin/chopshop-vision" "$ROOT/src/native/vision.swift" \
  -framework Vision -framework AVFoundation -framework CoreImage
echo "built resources/bin/chopshop-vision for macOS $MIN_MACOS and later"
