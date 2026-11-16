#!/usr/bin/env bash
# Builds Cutalong's phone engines: ffmpeg 6.0 with the libraries the renderer
# needs, whisper.cpp, and the engine library that runs them in-process.
#
#   scripts/build.sh fetch               clone every source at its pinned tag
#   scripts/build.sh deps    TARGET      freetype, fribidi, harfbuzz, libass,
#                                        zimg, libwebp, dav1d (static, PIC)
#   scripts/build.sh ffmpeg  TARGET      ffmpeg 6.0, shared (LGPL relinking)
#   scripts/build.sh whisper TARGET      whisper.cpp, static
#   scripts/build.sh core    TARGET      the engine library
#   scripts/build.sh target  TARGET      all four; finished stages are kept
#   scripts/build.sh android             both ABIs, into android/src/main/jniLibs
#   scripts/build.sh ios                 device and simulator, as xcframeworks
#                                        in ios/Frameworks
#
# TARGET is android-arm64-v8a, android-x86_64, ios-arm64, ios-sim-arm64,
# ios-sim-x86_64 or host (this machine, for working on the engine).
#
# Android needs ANDROID_NDK_ROOT, nasm (x86_64), meson, ninja, pkg-config,
# autoconf, automake and libtool. iOS needs Xcode and the same tools, from
# Homebrew. Everything is built under .build/ (CE_BUILD to move it).
# CE_IOS_SIM_ARCHS picks the simulator slices: "arm64" (default) or
# "arm64 x86_64" for Intel Macs too.
set -euo pipefail

ENGINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/env.sh
. "$ENGINE/scripts/lib/env.sh"
# shellcheck source=lib/ffmpeg.sh
. "$ENGINE/scripts/lib/ffmpeg.sh"
# shellcheck source=lib/whisper.sh
. "$ENGINE/scripts/lib/whisper.sh"
# shellcheck source=lib/core.sh
. "$ENGINE/scripts/lib/core.sh"

cmd=${1:-}
case $cmd in
  fetch) fetch_all ;;
  deps | ffmpeg | whisper | core)
    [ -n "${2:-}" ] || die "$cmd needs a target"
    fetch_all
    use_target "$2"
    "build_$cmd"
    ;;
  target)
    [ -n "${2:-}" ] || die "target needs a target"
    fetch_all
    build_target "$2"
    ;;
  android)
    fetch_all
    build_target android-arm64-v8a
    build_target android-x86_64
    package_android
    ;;
  ios)
    fetch_all
    build_target ios-arm64
    for a in ${CE_IOS_SIM_ARCHS:-arm64}; do build_target "ios-sim-$a"; done
    package_ios
    ;;
  package-android) package_android ;;
  package-ios) package_ios ;;
  *)
    sed -n '2,23p' "$0" >&2
    exit 2
    ;;
esac
