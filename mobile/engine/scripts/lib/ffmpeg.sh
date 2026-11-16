# Sourced by scripts/build.sh: the libraries ffmpeg needs, then ffmpeg 6.0
# itself, installed into $PREFIX. The CI cache of $PREFIX is keyed on this
# file, env.sh, versions.env and the patches.

meson_build() { # name src [options...]
  local name=$1 src=$2
  shift 2
  local bdir="$WORK/$name" cross=()
  rm -rf "$bdir"
  [ -n "$MESON_CROSS" ] && cross=(--cross-file "$MESON_CROSS")
  meson setup "$bdir" "$src" ${cross[@]+"${cross[@]}"} --prefix "$PREFIX" --libdir lib \
    --buildtype release --default-library static -Db_staticpic=true "$@"
  ninja -C "$bdir" -j "$JOBS"
  ninja -C "$bdir" install >/dev/null
}

cmake_build() { # name src [options...]
  local name=$1 src=$2
  shift 2
  local bdir="$WORK/$name"
  rm -rf "$bdir"
  cmake -S "$src" -B "$bdir" -G "$GENERATOR" ${CMAKE_ARGS[@]+"${CMAKE_ARGS[@]}"} \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$bdir" -j "$JOBS"
  cmake --install "$bdir" >/dev/null
}

build_deps() {
  if stage_done "$PREFIX" deps; then
    log "$TARGET: libraries already built"
    return
  fi
  log "$TARGET: freetype"
  cmake_build freetype "$SOURCES/freetype" \
    -DFT_DISABLE_ZLIB=TRUE -DFT_DISABLE_BZIP2=TRUE -DFT_DISABLE_PNG=TRUE \
    -DFT_DISABLE_HARFBUZZ=TRUE -DFT_DISABLE_BROTLI=TRUE

  log "$TARGET: fribidi"
  meson_build fribidi "$SOURCES/fribidi" -Ddocs=false -Dbin=false -Dtests=false

  log "$TARGET: harfbuzz"
  meson_build harfbuzz "$SOURCES/harfbuzz" -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled \
    -Dcairo=disabled -Dchafa=disabled -Dicu=disabled -Dgraphite2=disabled -Dtests=disabled \
    -Ddocs=disabled -Dutilities=disabled -Dintrospection=disabled -Dbenchmark=disabled \
    -Dcoretext=disabled

  # Core Text gives iOS the system's fonts for characters the caption fonts
  # lack. Android has no font provider libass can use: only the fonts in
  # fontsdir (the app's bundled ones) are drawn there.
  log "$TARGET: libass"
  local coretext=disabled
  [ "$PLATFORM" = ios ] && coretext=enabled
  meson_build libass "$SOURCES/libass" -Dfontconfig=disabled -Ddirectwrite=disabled \
    -Dcoretext=$coretext -Dlibunibreak=disabled -Drequire-system-font-provider=false \
    -Dtest=disabled -Dcompare=disabled -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled

  log "$TARGET: zimg"
  if [ ! -x "$SOURCES/zimg/configure" ]; then
    (cd "$SOURCES/zimg" && ./autogen.sh >/dev/null)
  fi
  rm -rf "$WORK/zimg"
  mkdir -p "$WORK/zimg"
  local host=()
  [ -n "$AUTOCONF_HOST" ] && host=(--host="$AUTOCONF_HOST")
  (cd "$WORK/zimg" &&
    STL_LIBS="$STL_LIBS" CFLAGS="-O2 $T_CFLAGS" CXXFLAGS="-O2 $T_CFLAGS" LDFLAGS="$T_LDFLAGS" \
      "$SOURCES/zimg/configure" ${host[@]+"${host[@]}"} --prefix="$PREFIX" --libdir="$PREFIX/lib" \
      --disable-shared --enable-static --with-pic >/dev/null &&
    make -j "$JOBS" >/dev/null && make install >/dev/null)

  log "$TARGET: libwebp"
  cmake_build libwebp "$SOURCES/libwebp" -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF \
    -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF -DWEBP_BUILD_IMG2WEBP=OFF \
    -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF \
    -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_LIBWEBPMUX=ON

  log "$TARGET: dav1d"
  meson_build dav1d "$SOURCES/dav1d" -Denable_tools=false -Denable_tests=false \
    -Denable_examples=false -Denable_asm=true

  stage_mark "$PREFIX" deps
}

build_ffmpeg() {
  if stage_done "$PREFIX" ffmpeg; then
    log "$TARGET: ffmpeg already built"
    return
  fi
  stage_done "$PREFIX" deps || die "$TARGET: build the libraries first"
  local bdir="$WORK/ffmpeg"
  rm -rf "$bdir"
  mkdir -p "$bdir"
  log "$TARGET: ffmpeg $FFMPEG_TAG"
  # LGPL only: no --enable-gpl, no --enable-nonfree, nothing GPL enabled.
  # Shared libraries, so the LGPL parts can be relinked.
  (cd "$bdir" && "$SOURCES/ffmpeg/configure" \
    --prefix="$PREFIX" \
    ${FFMPEG_ARGS[@]+"${FFMPEG_ARGS[@]}"} \
    --enable-shared --disable-static --enable-pic \
    --disable-programs --disable-doc --disable-avdevice --disable-postproc --disable-debug \
    --disable-autodetect --enable-pthreads --enable-zlib \
    --enable-libass --enable-libfreetype --enable-libfribidi --enable-libzimg \
    --enable-libwebp --enable-libdav1d \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --extra-cflags="-O2 $T_CFLAGS -I$PREFIX/include" \
    --extra-cxxflags="-O2 $T_CFLAGS -I$PREFIX/include" \
    --extra-ldflags="$T_LDFLAGS -L$PREFIX/lib" \
    --extra-libs="$STL_LIBS -lm" >"$bdir/configure.log" 2>&1) || {
    tail -40 "$bdir/configure.log"
    tail -60 "$bdir/ffbuild/config.log" 2>/dev/null || true
    die "$TARGET: ffmpeg configure failed"
  }
  grep -E "^License:" "$bdir/configure.log" >&2 || true
  grep -A6 "^External libraries:" "$bdir/configure.log" >&2 || true
  make -C "$bdir" -j "$JOBS" >/dev/null
  make -C "$bdir" install >/dev/null

  # What the fftools in core/ need beyond the public headers: every header
  # in the tree, the build's own config, and the flags it compiled them
  # with. (ffmpeg adds -DHAVE_AV_CONFIG_H to library objects only, never to
  # fftools, so it is not here either.)
  local priv="$PREFIX/ffmpeg-private"
  rm -rf "$priv"
  mkdir -p "$priv"
  (cd "$SOURCES/ffmpeg" && find . -name '*.h' -not -path './.git/*' | tar -cf - -T -) | (cd "$priv" && tar -xf -)
  (cd "$bdir" && find . -name '*.h' | tar -cf - -T -) | (cd "$priv" && tar -xf -)
  sed -n 's/^CPPFLAGS=//p; s/^CFLAGS=//p' "$bdir/ffbuild/config.mak" | tr '\n' ' ' >"$priv/fftools.cflags"
  cp "$bdir/configure.log" "$priv/configure.log"

  if [ "$PLATFORM" = ios ]; then frameworkize_install_names; fi
  stage_mark "$PREFIX" ffmpeg
}

# On iOS each library ships as a framework: libavcodec.framework/libavcodec.
# Their names inside each other say so before anything links against them.
frameworkize_install_names() {
  local lib dep real old
  for lib in $FFMPEG_LIBS; do
    real=$(cd "$PREFIX/lib" && ls lib$lib.*.*.*.dylib | head -1)
    install_name_tool -id "@rpath/lib$lib.framework/lib$lib" "$PREFIX/lib/$real"
    for dep in $FFMPEG_LIBS; do
      old=$(otool -L "$PREFIX/lib/$real" | awk '{print $1}' | grep "@rpath/lib$dep\.[0-9]*\.dylib" || true)
      if [ -n "$old" ]; then
        install_name_tool -change "$old" "@rpath/lib$dep.framework/lib$dep" "$PREFIX/lib/$real"
      fi
    done
  done
}
