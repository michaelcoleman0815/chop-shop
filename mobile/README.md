# Cutalong on a phone

The iPhone and Android app: a Capacitor app that shows the same React app as the Mac (`src/renderer/src/cutalong`, with `src/renderer/src/cutalong/phone.css` over its layout) and runs the same main-process work (`src/main`) on the phone. ffmpeg, ffprobe and whisper.cpp run inside the app through the `CutalongEngine` plugin, whose contract is `engine/src/definitions.ts`. `docs/rebuild.md` has the overview, under Phone.

- `src/host/boot.ts` starts the phone's host: asks the engine where the app's storage is, installs the phone's platform (`src/host/platform.ts`) for the shared work, copies the caption fonts, reads the settings and keys, and hands the app its API (`src/host/api.ts`).
- `src/host/engine.ts` registers the plugin. In a browser its web fallback (`src/host/engine-web.ts`) talks to the dev bridge.
- `src/host/services.ts` and `src/host/http.ts`: other AI services, through the Mac's gate, sent by the phone's own HTTP.
- `src/host/limits.ts`: what is on the Mac for now, one sentence each.

## Run it here, through the dev bridge

The bridge (`dev/engine-bridge.mjs`) is the engine on this computer: it runs the real ffmpeg and ffprobe with the arguments the app gives, a stand-in for whisper, keeps the app's files on this disk, serves them with Range requests as a phone's web view does, and serves the built app.

```sh
npm install            # at the repository's root: React and the shared code's packages
cd mobile
npm install            # Capacitor and its plugins, pinned
npm run build          # the app, into dist
npm run bridge -- --pick-from ~/clips
```

Then open http://127.0.0.1:8737 in Chromium with the device toolbar at a phone's size (390×844, 412×915 or 360×740), or drive it with Playwright using `isMobile` and `hasTouch`. Rebuild after a change; the bridge serves `dist`.

Bridge options:

- `--root DIR`: where the phone's Documents, Caches and Photos folders are (default `mobile/.bridge`). An export saved to Photos lands in `DIR/Photos`.
- `--pick-from DIR`: what + picks. Without it, + opens the browser's file picker and uploads what you choose. A test can also queue the next pick with `POST /engine/pick-next {"paths": [...]}`.
- `--as ios|android`: which hardware encoder the bridge says it has (`h264_videotoolbox` or `h264_mediacodec`). It runs that encoder's arguments with x264.
- `--ffmpeg PATH`, `--ffprobe PATH` (or `FFMPEG_PATH`, `FFPROBE_PATH`): run the ffmpeg 6.0 build to match the phone's version. Whatever the build, the bridge refuses a command that names a GPL filter or x264 itself, the way the phone's LGPL ffmpeg would.
- `--whisper PATH`: a real `whisper-cli`. Without it a stand-in answers: the words in the file `CUTALONG_WHISPER_MANIFEST` names, for a recording of the length it lists, or no words.
- `--model-file PATH`: a file served as the transcription model's download. Without it the bridge downloads the real model.
- `--port N` (default 8737).

The page's content security policy lets it reach only itself and Anthropic, so in a browser the other AI services are refused; on a phone the app reaches them with its own HTTP.

## Tests

From the repository's root: `npx vitest run mobile/` runs the phone host's tests (the whole flow on a phone built from this computer, the platform, the services' gate and what the app can reach), and `npm run typecheck` in `mobile/` checks the app and its tests.

## On a phone

Nothing native can be built on Linux. `npm run sync` builds the app and copies it into `ios/` (Swift Package Manager, no CocoaPods) and `android/`; open them in Xcode or Android Studio.

The engine's native code goes in `engine/ios` and `engine/android`, with a `Package.swift` at `engine/` for Swift Package Manager; then `npx cap sync` adds it to both projects. Until then Android refers to `engine/android` without it, and iOS leaves the engine out.

Pinned exactly: Capacitor 8.6.2 (`@capacitor/core`, `cli`, `ios`, `android`), `@capacitor/filesystem` 8.1.5, `@capacitor/preferences` 8.0.1, `@capacitor/keyboard` 8.0.6, `@capacitor/file-transfer` 2.0.6, `@capacitor-community/keep-awake` 8.0.1 and `capacitor-secure-storage-plugin` 0.13.0.
