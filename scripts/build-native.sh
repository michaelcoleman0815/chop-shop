#!/usr/bin/env bash
# Builds the macOS Vision helper used for subject tracking.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/resources/bin"
swiftc -O -o "$ROOT/resources/bin/chopshop-vision" "$ROOT/src/native/vision.swift" \
  -framework Vision -framework AVFoundation -framework CoreImage 2>/dev/null
echo "built resources/bin/chopshop-vision"
