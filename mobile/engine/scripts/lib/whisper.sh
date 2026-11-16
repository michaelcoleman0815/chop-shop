# Sourced by scripts/build.sh: whisper.cpp and ggml as static libraries in
# $WPREFIX, linked whole into the engine library. The CI cache of $WPREFIX is
# keyed on this file, env.sh and versions.env.
#
# iOS: Metal with its shaders embedded (no .metallib to ship) and Accelerate.
# Android: the CPU backend. GGML_NATIVE is off and the NDK cross-compiles,
# so ggml asks for no instruction set beyond the ABI's own: NEON on arm64,
# which every arm64 phone has, and SSE4.2 on x86_64, which is for the
# emulator and runs on any (slowly next to a phone; it is there for testing).

build_whisper() {
  if stage_done "$WPREFIX" whisper; then
    log "$TARGET: whisper.cpp already built"
    return
  fi
  log "$TARGET: whisper.cpp $WHISPER_TAG"
  local bdir="$WORK/whisper" extra=()
  case $PLATFORM in
    ios) extra=(-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DGGML_BLAS=ON -DGGML_BLAS_VENDOR=Apple) ;;
    *) extra=(-DGGML_METAL=OFF) ;;
  esac
  rm -rf "$bdir"
  cmake -S "$SOURCES/whisper" -B "$bdir" -G "$GENERATOR" ${CMAKE_ARGS[@]+"${CMAKE_ARGS[@]}"} \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$WPREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF \
    -DCMAKE_C_VISIBILITY_PRESET=hidden -DCMAKE_CXX_VISIBILITY_PRESET=hidden \
    -DWHISPER_BUILD_EXAMPLES=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_SERVER=OFF \
    -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DGGML_CCACHE=OFF "${extra[@]}"
  cmake --build "$bdir" -j "$JOBS"
  cmake --install "$bdir" >/dev/null
  stage_mark "$WPREFIX" whisper
}
