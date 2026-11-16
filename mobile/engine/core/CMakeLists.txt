# The engine library: ffmpeg's and ffprobe's fftools (ffmpeg-kit's
# thread-safe 6.0 copies, in fftools/), whisper.cpp's whisper-cli, and the run
# manager that gives each run its own thread, output and exit code.
#
# scripts/build.sh configures this with the prefixes its earlier stages
# installed into; see the README for building by hand.
cmake_minimum_required(VERSION 3.20)
project(cutalong_engine C CXX)

set(CE_PLATFORM "host" CACHE STRING "android, ios or host")
set(CE_FFMPEG_PREFIX "" CACHE PATH "ffmpeg's install prefix, with ffmpeg-private/ beside lib/")
set(CE_WHISPER_PREFIX "" CACHE PATH "whisper.cpp's install prefix")
set(CE_WHISPER_SRC "" CACHE PATH "whisper.cpp's source tree, for examples/cli")
option(CE_BUILD_CLI "Also build ce-cli, a command-line harness for testing on the host" OFF)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_VISIBILITY_PRESET hidden)
set(CMAKE_CXX_VISIBILITY_PRESET hidden)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(PRIV "${CE_FFMPEG_PREFIX}/ffmpeg-private")
if(NOT EXISTS "${PRIV}/config.h")
  message(FATAL_ERROR "No ffmpeg build at ${CE_FFMPEG_PREFIX}: run scripts/build.sh ffmpeg <target> first")
endif()

# The flags ffmpeg's own build compiles fftools with, less its warnings: the
# fftools here are ffmpeg-kit's, which ffmpeg's -Werror set was never run on.
file(READ "${PRIV}/fftools.cflags" FFTOOLS_CFLAGS)
string(STRIP "${FFTOOLS_CFLAGS}" FFTOOLS_CFLAGS)
separate_arguments(FFTOOLS_CFLAGS UNIX_COMMAND "${FFTOOLS_CFLAGS}")
list(FILTER FFTOOLS_CFLAGS EXCLUDE REGEX "^-W")
list(FILTER FFTOOLS_CFLAGS EXCLUDE REGEX "^-fdiagnostics-color")

set(TOOL_STDIO "${CMAKE_CURRENT_SOURCE_DIR}/src/tool_stdio.h")

file(GLOB FFTOOLS_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/fftools/*.c")
set(WHISPER_EXAMPLES "${CE_WHISPER_SRC}/examples")
set(WHISPER_CLI_SOURCES
  "${WHISPER_EXAMPLES}/cli/cli.cpp"
  "${WHISPER_EXAMPLES}/common.cpp"
  "${WHISPER_EXAMPLES}/common-ggml.cpp"
  "${WHISPER_EXAMPLES}/common-whisper.cpp"
  "${WHISPER_EXAMPLES}/grammar-parser.cpp")

set(ENGINE_SOURCES src/engine.c src/whisper_main.cpp)
if(CE_PLATFORM STREQUAL "android")
  list(APPEND ENGINE_SOURCES src/jni.c)
endif()

add_library(cutalong_engine SHARED ${ENGINE_SOURCES} ${FFTOOLS_SOURCES} ${WHISPER_CLI_SOURCES})

target_include_directories(cutalong_engine PRIVATE
  include
  src
  fftools
  "${PRIV}"
  "${CE_WHISPER_PREFIX}/include"
  "${WHISPER_EXAMPLES}")

set_source_files_properties(${FFTOOLS_SOURCES} PROPERTIES
  COMPILE_OPTIONS "${FFTOOLS_CFLAGS};-include;${TOOL_STDIO};-Wno-deprecated-declarations")
set_source_files_properties(src/engine.c PROPERTIES
  COMPILE_OPTIONS "${FFTOOLS_CFLAGS};-Wno-deprecated-declarations")
set_source_files_properties(${WHISPER_CLI_SOURCES} PROPERTIES
  COMPILE_OPTIONS "-include;${TOOL_STDIO};-Wno-deprecated-declarations")
set_source_files_properties("${WHISPER_EXAMPLES}/cli/cli.cpp" PROPERTIES
  COMPILE_DEFINITIONS "main=ce_whisper_cli_main")

set(FFMPEG_LIBS avfilter avformat avcodec swresample swscale avutil)
foreach(lib ${FFMPEG_LIBS})
  if(APPLE)
    target_link_libraries(cutalong_engine PRIVATE "${CE_FFMPEG_PREFIX}/lib/lib${lib}.dylib")
  else()
    target_link_libraries(cutalong_engine PRIVATE "${CE_FFMPEG_PREFIX}/lib/lib${lib}.so")
  endif()
endforeach()

# whisper.cpp and ggml, linked in whole from their static libraries: whisper,
# then the backends this build has, then ggml's base.
set(WHISPER_LIBS whisper ggml ggml-cpu)
if(CE_PLATFORM STREQUAL "ios")
  list(APPEND WHISPER_LIBS ggml-metal ggml-blas)
endif()
list(APPEND WHISPER_LIBS ggml-base)
set(WHISPER_ARCHIVES)
foreach(lib ${WHISPER_LIBS})
  list(APPEND WHISPER_ARCHIVES "${CE_WHISPER_PREFIX}/lib/lib${lib}.a")
endforeach()
if(APPLE)
  target_link_libraries(cutalong_engine PRIVATE ${WHISPER_ARCHIVES})
else()
  target_link_libraries(cutalong_engine PRIVATE "-Wl,--start-group" ${WHISPER_ARCHIVES} "-Wl,--end-group")
endif()

find_package(Threads REQUIRED)
target_link_libraries(cutalong_engine PRIVATE Threads::Threads)

if(CE_PLATFORM STREQUAL "android")
  target_link_libraries(cutalong_engine PRIVATE log android m dl)
  # Android 15 devices with 16 KB pages, and Google Play, need it.
  target_link_options(cutalong_engine PRIVATE
    "-Wl,-z,max-page-size=16384"
    "-Wl,--exclude-libs,ALL"
    "-Wl,--no-undefined")
elseif(CE_PLATFORM STREQUAL "ios")
  set_target_properties(cutalong_engine PROPERTIES
    OUTPUT_NAME CutalongEngineCore
    PREFIX ""
    SUFFIX ""
    INSTALL_NAME_DIR "@rpath/CutalongEngineCore.framework"
    BUILD_WITH_INSTALL_NAME_DIR ON)
  target_link_libraries(cutalong_engine PRIVATE
    "-framework Foundation" "-framework Metal" "-framework Accelerate")
  target_link_options(cutalong_engine PRIVATE "-Wl,-exported_symbol,_ce_*")
elseif(NOT APPLE)
  target_link_options(cutalong_engine PRIVATE "-Wl,--exclude-libs,ALL")
endif()

if(CE_BUILD_CLI)
  add_executable(ce-cli tests/ce_cli.c)
  target_include_directories(ce-cli PRIVATE include)
  target_link_libraries(ce-cli PRIVATE cutalong_engine Threads::Threads)
endif()
