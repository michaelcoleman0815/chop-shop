# Sourced by scripts/build.sh: the engine library (core/), and packaging
# everything for the plugin: jniLibs for Android, xcframeworks for iOS.
# Never cached; it takes a minute.

build_core() {
  stage_done "$PREFIX" ffmpeg || die "$TARGET: build ffmpeg first"
  stage_done "$WPREFIX" whisper || die "$TARGET: build whisper.cpp first"
  log "$TARGET: engine library"
  local bdir="$WORK/core" cli=OFF
  [ "$PLATFORM" = host ] && cli=ON
  rm -rf "$bdir"
  cmake -S "$ENGINE/core" -B "$bdir" -G "$GENERATOR" ${CMAKE_ARGS[@]+"${CMAKE_ARGS[@]}"} \
    -DCMAKE_BUILD_TYPE=Release -DCE_PLATFORM="$PLATFORM" -DCE_FFMPEG_PREFIX="$PREFIX" \
    -DCE_WHISPER_PREFIX="$WPREFIX" -DCE_WHISPER_SRC="$SOURCES/whisper" -DCE_BUILD_CLI=$cli
  cmake --build "$bdir" -j "$JOBS"
  rm -rf "$OUT/core"
  mkdir -p "$OUT/core"
  case $PLATFORM in
    android) cp "$bdir/libcutalong_engine.so" "$OUT/core/" ;;
    ios) cp "$bdir/CutalongEngineCore" "$OUT/core/" ;;
    host)
      cp "$bdir"/libcutalong_engine.* "$OUT/core/"
      cp "$bdir/ce-cli" "$OUT/core/"
      ;;
  esac
}

build_target() {
  use_target "$1"
  build_deps
  build_ffmpeg
  build_whisper
  build_core
}

package_android() {
  local abi dst lib
  for abi in arm64-v8a x86_64; do
    use_target "android-$abi"
    dst="$ENGINE/android/src/main/jniLibs/$abi"
    rm -rf "$dst"
    mkdir -p "$dst"
    for lib in $FFMPEG_LIBS; do cp "$PREFIX/lib/lib$lib.so" "$dst/"; done
    cp "$OUT/core/libcutalong_engine.so" "$dst/"
    cp "$SYSROOT/usr/lib/$TRIPLE/libc++_shared.so" "$dst/"
    "$STRIP" --strip-unneeded "$dst"/*.so
    log "android $abi: $(du -sh "$dst" | cut -f1) in $dst"
  done
}

framework_plist() { # name bundle-id platform version
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>$1</string>
  <key>CFBundleIdentifier</key><string>$2</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$1</string>
  <key>CFBundlePackageType</key><string>FMWK</string>
  <key>CFBundleShortVersionString</key><string>$4</string>
  <key>CFBundleVersion</key><string>$4</string>
  <key>CFBundleSupportedPlatforms</key><array><string>$3</string></array>
  <key>MinimumOSVersion</key><string>$IOS_MIN</string>
</dict>
</plist>
EOF
}

# One slice's frameworks: the six ffmpeg libraries and the engine.
ios_slice_frameworks() { # target
  use_target "$1"
  local fwdir="$OUT/frameworks" platform=iPhoneOS lib real fw
  [ "$SDK" = iphonesimulator ] && platform=iPhoneSimulator
  rm -rf "$fwdir"
  mkdir -p "$fwdir"
  for lib in $FFMPEG_LIBS; do
    fw="$fwdir/lib$lib.framework"
    mkdir -p "$fw/Headers"
    real=$(cd "$PREFIX/lib" && ls lib$lib.*.*.*.dylib | head -1)
    cp "$PREFIX/lib/$real" "$fw/lib$lib"
    "$STRIP" -x "$fw/lib$lib"
    cp -R "$PREFIX/include/lib$lib/." "$fw/Headers/"
    framework_plist "lib$lib" "app.cutalong.engine.lib$lib" "$platform" "${FFMPEG_TAG#n}" >"$fw/Info.plist"
  done
  fw="$fwdir/CutalongEngineCore.framework"
  mkdir -p "$fw/Headers" "$fw/Modules"
  cp "$OUT/core/CutalongEngineCore" "$fw/CutalongEngineCore"
  "$STRIP" -x "$fw/CutalongEngineCore"
  cp "$ENGINE/core/include/cutalong_engine.h" "$fw/Headers/"
  cat >"$fw/Modules/module.modulemap" <<EOF
framework module CutalongEngineCore {
  umbrella header "cutalong_engine.h"
  export *
}
EOF
  framework_plist CutalongEngineCore app.cutalong.engine.core "$platform" 0.1.0 >"$fw/Info.plist"
}

package_ios() {
  local sims=${CE_IOS_SIM_ARCHS:-arm64} arch name dst first bins
  ios_slice_frameworks ios-arm64
  for arch in $sims; do ios_slice_frameworks "ios-sim-$arch"; done
  dst="$ENGINE/ios/Frameworks"
  rm -rf "$dst"
  mkdir -p "$dst" "$BUILD/ios-sim/frameworks"
  first=$(echo "$sims" | awk '{print $1}')
  for name in $(cd "$BUILD/ios-arm64/frameworks" && ls -d ./*.framework); do
    name=$(basename "$name" .framework)
    # The simulator slices become one framework, joined with lipo if two.
    rm -rf "$BUILD/ios-sim/frameworks/$name.framework"
    cp -R "$BUILD/ios-sim-$first/frameworks/$name.framework" "$BUILD/ios-sim/frameworks/"
    if [ "$(echo "$sims" | wc -w)" -gt 1 ]; then
      bins=()
      for arch in $sims; do bins+=("$BUILD/ios-sim-$arch/frameworks/$name.framework/$name"); done
      lipo -create "${bins[@]}" -output "$BUILD/ios-sim/frameworks/$name.framework/$name"
    fi
    xcodebuild -create-xcframework \
      -framework "$BUILD/ios-arm64/frameworks/$name.framework" \
      -framework "$BUILD/ios-sim/frameworks/$name.framework" \
      -output "$dst/$name.xcframework" >/dev/null
  done
  log "ios: $(du -sh "$dst" | cut -f1) in $dst"
}
