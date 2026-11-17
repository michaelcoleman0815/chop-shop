#!/usr/bin/env bash
# Builds a self-contained whisper-cli into resources/bin.
#
# Static, with the Metal shaders embedded, so the binary carries no dylib
# dependencies and runs from inside the app bundle without rpath fixups.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$ROOT/.build/whisper.cpp"
OUT="$ROOT/resources/bin"
REF="${WHISPER_REF:-v1.8.2}"
# Built for the oldest macOS the app runs on, not for the build machine's own
# version, which is what cmake would pick and which a newer runner would raise.
# The Metal shaders are embedded as source and compiled on the Mac at run time.
MIN_MACOS="$("$ROOT/scripts/macos-min.sh")"
export MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS"

mkdir -p "$OUT"

if [ ! -d "$WORK/.git" ]; then
  echo "Cloning whisper.cpp $REF"
  git clone --depth 1 --branch "$REF" https://github.com/ggml-org/whisper.cpp "$WORK"
fi

cmake -S "$WORK" -B "$WORK/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET="$MIN_MACOS" \
  -DBUILD_SHARED_LIBS=OFF \
  -DGGML_METAL=ON \
  -DGGML_METAL_EMBED_LIBRARY=ON \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON >/dev/null

cmake --build "$WORK/build" --config Release --target whisper-cli -j"$(sysctl -n hw.ncpu)" >/dev/null

cp "$WORK/build/bin/whisper-cli" "$OUT/whisper-cli"
chmod +x "$OUT/whisper-cli"

echo "built $OUT/whisper-cli for macOS $MIN_MACOS and later"
otool -L "$OUT/whisper-cli" | grep -v '/usr/lib/\|/System/' | tail -n +2 || true
