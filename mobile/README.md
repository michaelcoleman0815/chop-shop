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

`npm run sync` builds the app and copies it into `ios/` (Swift Package Manager, no CocoaPods) and `android/`; open them in Xcode or Android Studio. The engine (`engine/`, its README says how) is a plugin like the others: its libraries are built by `engine/scripts/build.sh ios` and `engine/scripts/build.sh android` on a Mac or Linux with the NDK, or come from CI, into `engine/ios/Frameworks` and `engine/android/src/main/jniLibs`, and `npx cap sync` adds it to both projects.

## In CI

`.github/workflows/mobile-engine.yml` runs on every push to `claude/mobile`. After the engines' own self-test it builds the app on them and keeps:

- `cutalong-android-debug-apk`: `Cutalong-debug.apk`, signed with the debug key, for arm64 phones and x86_64 emulators. To install it, open it on the phone (or `adb install Cutalong-debug.apk`) and let the app that opens it install unknown apps.
- `cutalong-ios-simulator-app`: the app for an Apple-silicon Mac's simulator. Unzip it and drag `App.app` onto the simulator.
- `android-app-drive` and `ios-app-drive`: what the app's own flow did on the emulator and the simulator. `screens/` has a screenshot at each step, `light-…` for the flow and `dark-…` for the dark tour, `drive-report.json` and `tour-report.json` what the app saw (how the web view looked and moved, the crew at work, each view transition), `Exports/` the exports and what went beside them, and the app's log, with `memory.txt`, the app's memory every 15 s (on iOS with its web views', and `webkit-log.txt`, what WebKit said of the page's process).

The flow is the app's own (`src/host/drive.ts`), in builds made with `CUTALONG_DRIVE=1` (the APK and the simulator build; never a store build). It runs only when the app finds `drive.json` in its documents, which only the runner can put there: `ci/android-drive.sh` and `ci/ios-drive.sh` put the whisper model where the app keeps it, the clips `ci/make-footage.py` made where the engine's importer copies what a person picks, and the plan. The app then picks them with + (the picker's own screens are the one thing left out), sorts and transcribes them, makes v1, applies /shorts, opens the editor and exports, goes back to the chat to watch the crew at the export, and opens the Crew page, Brand and Settings' Licences; at each step it waits for the runner's screenshot. Then the runner turns the system dark with reduced motion (on Android, animations off, which its web view reports as reduced motion), adds `"tour": "dark"` to the plan and starts the app again, and the tour opens the same project: Start, the editor, the crew at a second export in the thread, the thread with it in, the Crew page and Brand. `ci/check-drive.py` then measures each export on the runner with ffprobe and ffmpeg.

## The Anthropic key

The key is kept in the iOS Keychain or the Android Keystore (`src/host/boot.ts`) and only ever sent to Anthropic, by the page's own fetch. The phone answers the same key calls as the Mac (`hasApiKey`, `checkKey`, `setApiKey`, `clearApiKey` in `src/host/api.ts`), so a gate in the shared app that asks for a working key before anything runs works on a phone without a change here. CI's flow runs without a key; once such a gate is in, the flow needs a key from a repository secret, handed to the app by `ci/android-drive.sh` and `ci/ios-drive.sh` and saved as a person would save it, or a way past the gate for CI.

## Licences

On a phone, Settings ends with Licences (`src/renderer/src/cutalong/screens/Licences.tsx`): FFmpeg and the rest of the engine, the whisper models, the caption fonts and the page's npm packages, each with its licence to read, and for the parts under the LGPL where their source is (`engine/` at the commit the app was built from, which the build records) and how to put a changed build of them in the app. `node scripts/licences.mjs` fetches the texts from each source at the commit `engine/scripts/versions.env` pins, into `public/licences`; run it again when a pin changes. The npm packages are listed by `vite.config.ts` as the page is built, from what is in it.

## Store builds

When the flow has passed on both phones, the same workflow builds for TestFlight and for Google Play's internal testing track, each only when its secrets are set in the repository (Settings, Secrets and variables, Actions). Without them those jobs are skipped, and the Store secrets job says which are missing. The app id is `social.brewed.cutalong`; the version is the one in the root `package.json` and the build number is the workflow's run number.

TestFlight:

- `APP_STORE_CONNECT_ISSUER_ID`: the issuer ID on App Store Connect's Users and Access, Integrations, App Store Connect API.
- `APP_STORE_CONNECT_KEY_ID`: the key's ID there.
- `APP_STORE_CONNECT_KEY_P8`: the whole of the key's `.p8` file, as text. The key's role must let Xcode manage certificates and profiles (Admin does).
- `APPLE_TEAM_ID`: the team's ID, on the developer account's Membership page.

The app's record is made in App Store Connect first, for the bundle ID `social.brewed.cutalong`. Xcode signs the archive with those keys and uploads it; App Store Connect processes it before testers see it, and asks about export compliance for each build unless the app's Info.plist answers it.

Google Play:

- `PLAY_UPLOAD_KEYSTORE_BASE64`: the upload keystore (`.jks` or `.keystore`), base64-encoded (`base64 -i upload.jks`).
- `PLAY_UPLOAD_KEYSTORE_PASSWORD`: the keystore's password.
- `PLAY_UPLOAD_KEY_ALIAS`: the upload key's alias in it.
- `PLAY_UPLOAD_KEY_PASSWORD`: the upload key's password.
- `PLAY_SERVICE_ACCOUNT_JSON`: the JSON key of a Google Cloud service account that has release access to the app in the Play Console (Users and permissions).

The app is made in the Play Console first, with Play App Signing, and its first bundle is uploaded there by hand: the job keeps each signed bundle as the `cutalong-play-bundle` artifact. After that each run releases its bundle on the internal track (`ci/play-upload.py`).

Pinned exactly: Capacitor 8.6.2 (`@capacitor/core`, `cli`, `ios`, `android`), `@capacitor/filesystem` 8.1.5, `@capacitor/preferences` 8.0.1, `@capacitor/keyboard` 8.0.6, `@capacitor/file-transfer` 2.0.6, `@capacitor-community/keep-awake` 8.0.1 and `capacitor-secure-storage-plugin` 0.13.0.
