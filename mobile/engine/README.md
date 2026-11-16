# Cutalong's phone engines

`mobile/engine` is one Capacitor plugin, **CutalongEngine** (npm package
`cutalong-engine`), that puts the Mac app's three command-line tools inside
the iPhone and Android apps and runs them in-process: **ffmpeg 6.0**,
**ffprobe 6.0** and **whisper-cli** from whisper.cpp **1.8.2**. They take the
same arguments they take on the Mac, so the code that builds those
arguments (`src/main/cut-render.ts`, `src/main/whisper-args.ts`,
`src/main/intake.ts`) can be shared. The contract is
[`src/definitions.ts`](src/definitions.ts).

Nothing built is committed: the libraries are built from pinned sources by
`scripts/build.sh`, in CI and on a Mac, and cached there.

## Using it in the app

Add it to the app's `package.json` and sync:

```json
"dependencies": { "cutalong-engine": "file:./engine" }
```

```sh
mobile/engine/scripts/build.sh ios       # or: android (see Building, below)
npx cap sync
```

Register it by name, as the contract says:

```ts
import { registerPlugin } from '@capacitor/core'
import type { EnginePlugin } from 'cutalong-engine'
const Engine = registerPlugin<EnginePlugin>('CutalongEngine')

const r = await Engine.run({ id: 'probe-1', tool: 'ffprobe', args: ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path] })
```

iOS picks the plugin up through Swift Package Manager (`Package.swift`; the
CLI names the package and its product `CutalongEngine`). Android picks up
the library module in `android/`. The app needs, beyond that:

- **iOS Info.plist**: `NSPhotoLibraryAddUsageDescription` = "Cutalong saves
  your exports to Photos." `saveToPhotos` asks only to add, never to read.
  The pickers need no permission (PHPicker and the document picker run
  outside the app).
- **Android**: nothing. The plugin's manifest brings
  `WRITE_EXTERNAL_STORAGE` for Android 9 and older only (saving to the
  gallery needs no permission from Android 10). The photo picker and the
  document picker need none.
- **Fonts for captions**: pass the folder of the app's bundled caption fonts
  to libass, as the desktop does: `subtitles='…':fontsdir='…'`. On Android
  that folder is all libass has: there is no system font provider, so a
  character none of the bundled fonts has is not drawn. iOS falls back to
  the system's fonts through Core Text. The caption faces are Archivo Black,
  Anton and Sora (`resources/fonts`).
- **A privacy manifest** before TestFlight: FFmpeg reads file sizes and
  times (`stat`, `fstat`), which Apple counts as a required-reason API.

### Folders

`info()` gives two absolute paths: `documents` (kept and backed up: iOS
`Documents`, Android `getFilesDir()`) and `cache` (the system may clear it:
iOS `Library/Caches`, Android `getCacheDir()`). Picked files are copied into
`documents/Imported`, keeping the name the person knows them by
(`name (2).mov` when it is taken), a megabyte at a time.

### Picking

Videos and pictures come from the photo picker, sound from the document
picker (Files on iOS; on Android the system's file picker, whose Images and
Videos reach the gallery too). Asked for sound together with videos or
pictures, iOS first asks "Photos" or "Files", since no one picker has both;
Android shows its file picker. A cancelled pick gives no files.

### Runs

- Each run is ffmpeg, ffprobe or whisper on a thread of its own with its own
  copy of every global the tools keep; any number can run at once, and
  their output never crosses.
- The result's `code` is the tool's exit code: 0, 1 on failure, 255 when
  cancelled. `cancel` stops a run within a frame or two (tens of
  milliseconds), and ffmpeg still finishes the file it was writing.
- `stdout` is everything written to stdout (up to 64 MB), as text:
  ffprobe's JSON, `-progress pipe:1`, ffmpeg's `-version`, `-encoders` and
  the rest. **Binary output must go to a file**, not to `-` or `pipe:1`.
- `stderr` is the last 64 KB. Every line of both comes as a `line` event
  (`\r` ends a line too, so ffmpeg's stats line comes each time it changes),
  before the run's result.
- There is no stdin: `-i -` reads nothing, and ffmpeg never waits for keys.
- whisper prints its progress with `-pp`, as on the Mac. It uses
  `min(4, cores)` threads unless given `-t`; on a phone that keeps it on the
  big cores.

### Encoders, and the desktop's arguments

There is no libx264 or libx265 (they are GPL). The renderer's
`-c:v libx264 -preset P -crf N` becomes the phone's hardware encoder with a
bitrate, since neither hardware encoder takes a CRF:

| | iOS | Android |
| --- | --- | --- |
| H.264 | `-c:v h264_videotoolbox -b:v 12M` | `-c:v h264_mediacodec -b:v 12M` |
| HEVC | `-c:v hevc_videotoolbox -b:v 8M -tag:v hvc1` | `-c:v hevc_mediacodec -b:v 8M` |

`-pix_fmt yuv420p` (or `nv12`) works with both, and so do `-g` and
`-profile:v high`. The MediaCodec encoder pads a width or height that is not
a multiple of 16 (1080) and crops it back in the stream's headers; the
self-test reads colours at the edges of a 1080x1920 export to catch a
misaligned picture. `info().encoders` lists the hardware encoders this
phone can actually start, not just the ones compiled in: an Android phone
without an HEVC encoder has no `hevc_mediacodec` there. The self-test's
mapping (`example/src/selftest.ts`, `useHardwareEncoder`) is CRF 14 or less
→ 20M, 20 or less → 12M, more → 5M.

Besides those, everything ffmpeg has natively is built, so among what the
app uses: the encoders `aac`, `pcm_s16le`, `pcm_f32le`, `flac`, `rawvideo`,
`mjpeg`, `png`, `libwebp` and `libopus` (Opus, about a third the size of FLAC
for speech); the muxers `mp4`, `mov`, `ipod` (.m4a), `matroska`, `webm`,
`wav`, `flac`, `ogg`, `opus`, `segment`, `f32le`, `rawvideo`, `image2` and
`null`; the decoders for what cameras and phones write (H.264, HEVC
including 10-bit, ProRes, AAC, ALAC, Opus, AMR, MP3, MJPEG, AV1 by dav1d,
WebP, PNG) and the `concat` demuxer.

What else differs from the Mac's ffmpeg 6.0:

- **`perspective`, `boxblur` and `eq` are not here**: they are GPL-only
  (so are `hqdn3d` and `cropdetect`). The desktop's camera moves use
  `perspective` (`src/main/render/camera.ts`); on the phone a camera move is
  `scale` and `crop` (or `zoompan`). A blurred background fill is `gblur`
  with `colorchannelmixer` to darken it, never `boxblur` or `eq`.
- **`sendcmd` and `asendcmd` targets**: in 6.0 a filter written
  `volume@duck` is named `duck`, not `volume@duck` as in 6.1 and later, so a
  command sent to `volume@duck` reaches nothing. Send it to the filter's
  class (`volume`) or to `duck`.
- **No lavfi input device** (`-f lavfi -i color=…`; libavdevice is not
  built). Filter sources inside `-filter_complex` work, as the self-test's
  own renders show.
- **End every sound chain in `aformat`**, as the desktop does
  (`aformat=channel_layouts=stereo:sample_rates=48000`): in 6.0, `loudnorm`
  then `aresample` straight into `aac` fails to agree on a channel layout.
- **A looped input cannot hang a run**: in 6.0 a `-stream_loop` input whose
  output ends first left ffmpeg waiting for ever after finishing. The
  engine's fftools are fixed (`core/fftools/fftools_ffmpeg_demux.c`,
  `thread_stop`); the Mac's ffmpeg 6.0 still has it.

## What is built

| | Version | Licence | How |
| --- | --- | --- | --- |
| FFmpeg | 6.0 (`n6.0`) | LGPL 2.1 or later | shared libraries |
| libass | 0.17.4 | ISC | static, inside libavfilter |
| FreeType | 2.14.3 | FreeType Licence | static, inside libavfilter |
| FriBidi | 1.0.16 | LGPL 2.1 or later | static, inside libavfilter |
| HarfBuzz | 11.5.1 | MIT | static, inside libavfilter |
| zimg | 3.0.6 | WTFPL | static, inside libavfilter |
| libwebp | 1.5.0 | BSD 3-clause | static, inside libavcodec |
| dav1d | 1.5.3 | BSD 2-clause | static, inside libavcodec |
| Opus | 1.6.1 | BSD 3-clause | static, inside libavcodec |
| whisper.cpp, ggml | 1.8.2 | MIT | static, inside the engine library |

Every source is pinned to a tag and checked against the commit it named
(`scripts/versions.env`); `patches/ffmpeg` holds one upstream fix.

FFmpeg is configured LGPL-only (no `--enable-gpl`, no `--enable-nonfree`),
shared, with `--disable-programs --disable-avdevice --disable-postproc
--disable-autodetect` and `--enable-libass --enable-libfreetype
--enable-libfribidi --enable-libzimg --enable-libwebp --enable-libdav1d
--enable-libopus --enable-zlib`; on iOS `--enable-videotoolbox --enable-audiotoolbox`, on
Android `--enable-jni --enable-mediacodec`. The CI log prints its `License:`
line ("LGPL version 2.1 or later") and external libraries on every build.

- **iOS**: iOS 15 and up. Seven dynamic frameworks (`libavutil`,
  `libswresample`, `libswscale`, `libavcodec`, `libavformat`, `libavfilter`
  and `CutalongEngineCore`), each an xcframework for devices (arm64) and the
  simulator (arm64; `CE_IOS_SIM_ARCHS="arm64 x86_64"` adds Intel Macs).
  whisper runs on the GPU with Metal (its shaders built in) and Accelerate;
  in the simulator, whose Metal cannot run ggml's kernels, on the CPU.
- **Android**: API 24 and up, `arm64-v8a` (phones) and `x86_64` (the
  emulator). The `.so` files are 16 KB page aligned, as Android 15 devices
  with 16 KB pages need. whisper runs on the CPU: NEON on arm64, the ABI's
  baseline that every arm64 phone has; x86_64 gets SSE4.2, enough to test
  with. Encoding uses MediaCodec through the JVM the plugin hands ffmpeg.

`core/` is the engine library: ffmpeg-kit's thread-safe fftools for 6.0
(LGPL 2.1 or later, changed as each file's header says), whisper-cli's own
`main`, and the run manager (`core/src/engine.c`) with its C API
(`core/include/cutalong_engine.h`). Only the `ce_*` functions are exported.

## Building

Everything is built under `.build/` (`CE_BUILD` moves it); finished stages
are kept, so a second build only rebuilds what changed.

**iOS, on a Mac** with Xcode and Homebrew:

```sh
brew install nasm ninja meson autoconf automake libtool pkg-config
export LIBTOOLIZE=glibtoolize
mobile/engine/scripts/build.sh ios          # → ios/Frameworks/*.xcframework
```

**Android, on a Mac or Linux**, with the NDK (CI uses 27.2.12479018):

```sh
export ANDROID_NDK_ROOT=~/Library/Android/sdk/ndk/27.2.12479018
mobile/engine/scripts/build.sh android      # → android/src/main/jniLibs
```

A first build takes about an hour on a laptop; after that only the engine
library is rebuilt (a minute). `scripts/build.sh` with no arguments lists the
rest: one stage or one target at a time, and `host`, which builds the engine
for the machine itself with `ce-cli` (`core/tests/ce_cli.c`) for working on
the engine without a phone.

Signing: nothing here is signed for distribution. The frameworks are signed
ad hoc so the simulator loads them, and an app's own build signs them again
when it embeds them, as TestFlight needs; there is nothing else to change
for that.

## The self-test

`example/` is a small Capacitor app around the plugin. Launched with its
self-test flag it runs, on the phone's own ffmpeg, ffprobe and whisper:

- what the build has: versions, the hardware encoders, the LGPL
  configuration, every filter the renderer and the app use (and none
  GPL-only), every encoder, decoder, muxer and demuxer the app uses;
- probes of 1080p H.264 with sound, an iPhone-like HEVC portrait with a
  rotation, 10-bit HLG, a WAV of speech, PNG, WebP, AVIF, ALAC, an Opus
  voice note and Motion JPEG, read as the desktop's `readProbe` reads them;
  six probes at once;
- renders of a seek and trim with scale, crop and pad, `xfade`, `zscale`
  from HLG, a 3D LUT, captions in the three bundled faces, a PNG logo,
  ducked music with `amix`, `sidechaincompress`, `atempo` and `loudnorm`,
  NV12 at 1080p into the hardware encoder, HEVC, the portrait turned
  upright, WebP and AVIF stills; the app's own final export (1080x1920,
  its encoder settings, `+faststart`, keyframes every 2 s); a chunk of a long
  cut (Matroska with PCM sound) and two joined by the concat demuxer; the
  blurred background fill; one graph of the filters the app's phone path
  uses; ALAC to WAV, Opus to FLAC, speech to Opus, Motion JPEG to JPEG. Each
  output's size, length, sound and colours at known moments are checked
  against the same render made on the CI runner with libx264;
- two cuts built by the desktop renderer itself (`buildRenderArgs`, written
  out by `example/tools/desktop-args.test.ts`), libx264 swapped for the
  hardware encoder;
- raw output as the app writes it: sound as `pcm_f32le` in 30 s `f32le`
  segment files under `cache/cutalong/cutalong-raw-*`, video as `rawvideo`
  segments;
- whisper with the desktop's arguments and parser on the speech, against
  the words it says and when: base.en for captions, and base.en and
  small.en as the app calls them (`-ojf`, a prompt, `--carry-initial-prompt`,
  `-mc`, `--dtw`, `-nfa`), the models in `documents/Cutalong/models`;
- cancelling a long render; a 60 s 1080p render with captions, a logo and
  loudness, its time and memory, and its `-progress pipe:1` lines arriving
  while it runs;
- playing local files in the WebView from `Capacitor.convertFileSrc`,
  seeking and reading a frame's colour, near the start and 45 s into the
  60 s export;
- `saveToPhotos`, and the importer (on Android through the gallery and
  back).

It writes `selftest.json` (every check, its time and what it saw, and the
key numbers) to the app's documents.

**In CI** (`.github/workflows/mobile-engine.yml`, on every push to
`claude/mobile`): the sample media and what each render should come out as
are made on Ubuntu (`example/tools/make_media.py`); Android runs the test app
on an API 34 x86_64 emulator, iOS on an iPhone simulator; each prints the
report and fails unless every check passed (`example/tools/check_report.py`);
a last job measures every export again with the runner's own ffmpeg
(`example/tools/check_exports.py`). The APK, the simulator app, the reports
and the exports are kept as artifacts.

**By hand**, with the engine built for the platform:

```sh
cd mobile/engine/example
npm ci
python3 tools/make_media.py /tmp/media ../../..   # needs an ffmpeg with libx264, libx265, libwebp, AV1
node build.mjs /tmp/media
node native.mjs android                           # or ios; then build and run it as any Capacitor app
ci/fetch-models.sh /tmp/models                    # base.en and small.en
ci/android-selftest.sh android/app/build/outputs/apk/debug/app-debug.apk /tmp/models /tmp/out
```

`ci/ios-selftest.sh` does the same on a booted simulator. On a phone, launch
the app and tap "Run the self-test" (put the models in its documents'
`Cutalong/models` folder first for the whisper checks); on iOS the report
is in the Files app, under the app. The pickers need a person: "Pick
videos" and "Pick a sound" try them.

## Licences

FFmpeg and FriBidi are under the GNU Lesser General Public License, version
2.1 or later, and so is the engine library, which contains FFmpeg's fftools
(changed). An app that ships them must:

- say so, with the licence's text and the other components' notices (the
  table above), for example on an About or Licences screen;
- offer the source of exactly what it ships: this folder at the commit the
  app was built from, which pins and fetches every source and holds every
  change;
- let people relink: the LGPL parts are separate dynamic libraries
  (`.so` files on Android, frameworks on iOS), rebuilt with
  `scripts/build.sh` from changed sources and swapped in by name; on iOS
  the swapped app must then be signed again by whoever installs it;
- not forbid reverse engineering for debugging such changes.

FreeType's licence asks for a credit in the documentation: "Portions of this
software are copyright © The FreeType Project (www.freetype.org). All
rights reserved."
