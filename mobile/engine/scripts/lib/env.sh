# Sourced by scripts/build.sh: sources, and the compilers and flags for each
# target. The CI caches of built libraries are keyed on this file, among
# others, since a change here changes what they were built with.

# shellcheck source=../versions.env
. "$ENGINE/scripts/versions.env"
BUILD="${CE_BUILD:-$ENGINE/.build}"
SOURCES="${CE_SOURCES:-$BUILD/sources}"
JOBS="${CE_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"
FFMPEG_LIBS="avutil swresample swscale avcodec avformat avfilter"

die() {
  echo "build.sh: $*" >&2
  exit 1
}
log() { echo "==> $*" >&2; }

if command -v ninja >/dev/null 2>&1; then GENERATOR=Ninja; else GENERATOR="Unix Makefiles"; fi

# ---------------------------------------------------------------------------
# Sources

patch_sum() {
  if [ -d "$ENGINE/patches/$1" ]; then
    cat "$ENGINE/patches/$1"/*.patch | shasum | cut -d' ' -f1
  else
    echo none
  fi
}

fetch_one() { # name repo tag commit
  local name=$1 repo=$2 tag=$3 commit=$4
  local dir="$SOURCES/$name" stamp="$SOURCES/$name.fetched"
  local want
  want="$commit $(patch_sum "$name")"
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ]; then return; fi
  rm -rf "$dir" "$stamp"
  mkdir -p "$SOURCES"
  log "fetch $name $tag"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$repo" "$dir"
  local got
  got=$(git -C "$dir" rev-parse HEAD)
  [ "$got" = "$commit" ] || die "$name $tag is $got, not $commit"
  if [ -d "$ENGINE/patches/$name" ]; then
    local p
    for p in "$ENGINE/patches/$name"/*.patch; do
      log "patch $name with $(basename "$p")"
      git -C "$dir" apply "$p"
    done
  fi
  echo "$want" >"$stamp"
}

fetch_all() {
  fetch_one ffmpeg "$FFMPEG_REPO" "$FFMPEG_TAG" "$FFMPEG_COMMIT"
  # ffmpeg names its version from git when it can; a release says "6.0".
  echo "${FFMPEG_TAG#n}" >"$SOURCES/ffmpeg/VERSION"
  fetch_one freetype "$FREETYPE_REPO" "$FREETYPE_TAG" "$FREETYPE_COMMIT"
  fetch_one fribidi "$FRIBIDI_REPO" "$FRIBIDI_TAG" "$FRIBIDI_COMMIT"
  fetch_one harfbuzz "$HARFBUZZ_REPO" "$HARFBUZZ_TAG" "$HARFBUZZ_COMMIT"
  fetch_one libass "$LIBASS_REPO" "$LIBASS_TAG" "$LIBASS_COMMIT"
  fetch_one zimg "$ZIMG_REPO" "$ZIMG_TAG" "$ZIMG_COMMIT"
  fetch_one libwebp "$LIBWEBP_REPO" "$LIBWEBP_TAG" "$LIBWEBP_COMMIT"
  fetch_one dav1d "$DAV1D_REPO" "$DAV1D_TAG" "$DAV1D_COMMIT"
  fetch_one whisper "$WHISPER_REPO" "$WHISPER_TAG" "$WHISPER_COMMIT"
}

# ---------------------------------------------------------------------------
# Targets

use_target() {
  TARGET=$1
  OUT="$BUILD/$TARGET"
  PREFIX="$OUT/prefix"
  WPREFIX="$OUT/whisper"
  WORK="$OUT/work"
  mkdir -p "$PREFIX/lib/pkgconfig" "$PREFIX/include" "$WPREFIX" "$WORK"
  export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
  export PKG_CONFIG_PATH=""
  CMAKE_ARGS=()
  FFMPEG_ARGS=()
  AUTOCONF_HOST=""
  MESON_CROSS=""
  case $TARGET in
    android-*) use_android ;;
    ios-*) use_ios ;;
    host) use_host ;;
    *) die "unknown target $TARGET" ;;
  esac
  export CC CXX AR RANLIB
}

use_android() {
  PLATFORM=android
  ABI=${TARGET#android-}
  local cpu
  case $ABI in
    arm64-v8a) TRIPLE=aarch64-linux-android; ARCH=aarch64; cpu=aarch64 ;;
    x86_64) TRIPLE=x86_64-linux-android; ARCH=x86_64; cpu=x86_64 ;;
    *) die "unknown Android ABI $ABI" ;;
  esac
  NDK="${ANDROID_NDK_ROOT:-${ANDROID_NDK_HOME:-}}"
  [ -n "$NDK" ] && [ -d "$NDK" ] || die "set ANDROID_NDK_ROOT to an Android NDK"
  local host_tag=linux-x86_64
  [ "$(uname -s)" = Darwin ] && host_tag=darwin-x86_64
  TC="$NDK/toolchains/llvm/prebuilt/$host_tag"
  CC="$TC/bin/${TRIPLE}${ANDROID_API}-clang"
  CXX="$TC/bin/${TRIPLE}${ANDROID_API}-clang++"
  AR="$TC/bin/llvm-ar"
  RANLIB="$TC/bin/llvm-ranlib"
  STRIP="$TC/bin/llvm-strip"
  NM="$TC/bin/llvm-nm"
  SYSROOT="$TC/sysroot"
  [ -x "$CC" ] || die "no $CC: is ANDROID_NDK_ROOT an NDK?"
  T_CFLAGS="-fPIC -DANDROID -ffunction-sections -fdata-sections -fstack-protector-strong"
  # Android 15 devices with 16 KB pages, and Google Play, need it.
  T_LDFLAGS="-Wl,-z,max-page-size=16384"
  STL_LIBS="-lc++_shared"
  CMAKE_ARGS=(
    "-DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake"
    "-DANDROID_ABI=$ABI"
    "-DANDROID_PLATFORM=android-$ANDROID_API"
    "-DANDROID_STL=c++_shared")
  AUTOCONF_HOST=$TRIPLE
  write_meson_cross android linux "" "$cpu"
  FFMPEG_ARGS=(
    --target-os=android --arch="$ARCH" --enable-cross-compile --sysroot="$SYSROOT"
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --nm="$NM" --strip="$STRIP"
    --enable-jni --enable-mediacodec)
  if [ "$ARCH" = x86_64 ]; then FFMPEG_ARGS+=(--x86asmexe=nasm); fi
}

use_ios() {
  PLATFORM=ios
  local subsystem
  case $TARGET in
    ios-arm64) SDK=iphoneos; ARCH=arm64; CLANG_TARGET="arm64-apple-ios$IOS_MIN"; subsystem=ios ;;
    ios-sim-arm64) SDK=iphonesimulator; ARCH=arm64; CLANG_TARGET="arm64-apple-ios$IOS_MIN-simulator"; subsystem=ios-simulator ;;
    ios-sim-x86_64) SDK=iphonesimulator; ARCH=x86_64; CLANG_TARGET="x86_64-apple-ios$IOS_MIN-simulator"; subsystem=ios-simulator ;;
    *) die "unknown iOS target $TARGET" ;;
  esac
  SYSROOT="$(xcrun --sdk "$SDK" --show-sdk-path)"
  CC="$(xcrun --sdk "$SDK" -f clang)"
  CXX="$(xcrun --sdk "$SDK" -f clang++)"
  AR="$(xcrun --sdk "$SDK" -f ar)"
  RANLIB="$(xcrun --sdk "$SDK" -f ranlib)"
  STRIP="$(xcrun --sdk "$SDK" -f strip)"
  NM="$(xcrun --sdk "$SDK" -f nm)"
  T_CFLAGS="-target $CLANG_TARGET -isysroot $SYSROOT -fPIC"
  T_LDFLAGS="-target $CLANG_TARGET -isysroot $SYSROOT"
  STL_LIBS="-lc++"
  CMAKE_ARGS=(
    -DCMAKE_SYSTEM_NAME=iOS
    "-DCMAKE_OSX_SYSROOT=$SYSROOT"
    "-DCMAKE_OSX_ARCHITECTURES=$ARCH"
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=$IOS_MIN"
    "-DCMAKE_C_FLAGS=-target $CLANG_TARGET"
    "-DCMAKE_CXX_FLAGS=-target $CLANG_TARGET"
    -DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO)
  local cpu=aarch64
  [ "$ARCH" = x86_64 ] && cpu=x86_64
  AUTOCONF_HOST="$cpu-apple-darwin"
  write_meson_cross darwin xnu "$subsystem" "$cpu"
  FFMPEG_ARGS=(
    --target-os=darwin --arch="$ARCH" --enable-cross-compile --sysroot="$SYSROOT"
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --nm="$NM" --strip="$STRIP"
    --enable-videotoolbox --enable-audiotoolbox --install-name-dir=@rpath)
  if [ "$ARCH" = x86_64 ]; then FFMPEG_ARGS+=(--x86asmexe=nasm); fi
}

use_host() {
  PLATFORM=host
  CC=${CC:-clang}
  CXX=${CXX:-clang++}
  AR=${AR:-ar}
  RANLIB=${RANLIB:-ranlib}
  STRIP=strip
  NM=nm
  T_CFLAGS="-fPIC"
  T_LDFLAGS=""
  STL_LIBS="-lstdc++"
  [ "$(uname -s)" = Darwin ] && STL_LIBS="-lc++"
  CMAKE_ARGS=("-DCMAKE_C_COMPILER=$CC" "-DCMAKE_CXX_COMPILER=$CXX")
  FFMPEG_ARGS=(--cc="$CC" --cxx="$CXX")
  if [ "$(uname -s)" = Darwin ]; then
    FFMPEG_ARGS+=(--enable-videotoolbox --enable-audiotoolbox --install-name-dir=@rpath)
  fi
}

meson_list() { # words -> 'a', 'b'
  local out="" w
  for w in "$@"; do out="$out${out:+, }'$w'"; done
  echo "$out"
}

write_meson_cross() { # system kernel subsystem cpu
  MESON_CROSS="$OUT/meson-cross.ini"
  local sub=""
  [ -n "$3" ] && sub="subsystem = '$3'"
  # shellcheck disable=SC2086
  cat >"$MESON_CROSS" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
pkg-config = 'pkg-config'
nasm = 'nasm'

[built-in options]
c_args = [$(meson_list $T_CFLAGS)]
cpp_args = [$(meson_list $T_CFLAGS)]
c_link_args = [$(meson_list $T_LDFLAGS)]
cpp_link_args = [$(meson_list $T_LDFLAGS)]

[properties]
pkg_config_libdir = '$PREFIX/lib/pkgconfig'
needs_exe_wrapper = true

[host_machine]
system = '$1'
kernel = '$2'
$sub
cpu_family = '$4'
cpu = '$4'
endian = 'little'
EOF
}

# A finished stage leaves a stamp inside what it built, so a cache of that
# folder says the stage is done.
stage_done() { [ -f "$1/.$2.done" ]; }
stage_mark() { date >"$1/.$2.done"; }
