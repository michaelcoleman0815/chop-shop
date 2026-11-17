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

The flow is the app's own (`src/host/drive.ts`), in builds made with `CUTALONG_DRIVE=1` (the APK and the simulator build; never a store build). It runs only when the app finds `drive.json` in its documents, which only the runner can put there: `ci/android-drive.sh` and `ci/ios-drive.sh` put the whisper model where the app keeps it, the clips `ci/make-footage.py` made where the engine's importer copies what a person picks, and the plan. The app starts with no key, so Start is the steps to get one: the drive pastes a key Anthropic turns down, then one it takes, as a person would. It then picks the clips with + (the picker's own screens are the one thing left out), sorts and transcribes them, makes v1, applies /shorts, opens the editor and exports, goes back to the chat to watch the crew at the export, and opens the Crew page, Brand and Settings' Licences; at each step it waits for the runner's screenshot. On Start, in the thread and in the editor's note box it also types with the keyboard up, the box at rest and grown past six lines, and from the note box it goes Back with the keyboard still up; the runners show the phones' own keyboards for this (`ci/start-emulator.sh`, and the simulator's hardware keyboard off in the workflow). Then the runner turns the system dark with reduced motion (on Android, animations off, which its web view reports as reduced motion), adds `"tour": "dark"` to the plan and starts the app again, with the key saved and Anthropic down: the tour asks for a change in the thread, which Anthropic cannot plan while the gate stays open for the key it took, then opens the same project from Start's card: the editor with its first frame showing, the crew at a second export in the thread, the thread with it in, the Crew page and Brand. `ci/check-drive.py` then checks the key gate both ways, the preview from the chat and from Start, the text boxes with the keyboard up (one thin line at rest with its hint on it, six lines grown, and they and their buttons above the keyboard), Back from the note box, and measures each export on the runner with ffprobe and ffmpeg.

While a drive runs, Anthropic is stood in for inside the app (`src/host/standin.ts`): the shared work reaches Anthropic through the page's fetch, which the drive answers as the API would, so nothing leaves the emulator or the simulator. A key starting `sk-ant-` works and one ending `-refused`, `-no-credit` or `-busy` is answered so; a message read before its footage gets a route from its words and files, a plan comes back empty, and anything else is a request Claude cannot take. In the dark tour every message is answered 529, overloaded. The same build in a browser through the dev bridge drives the same way.

## The Anthropic key

Nothing works on the phone without an Anthropic key, as on the Mac: the gate is the shared one (`src/shared/setup/gate.ts`), with the same steps on Start, the same cost line, and the same rules. Without a key, or with one Anthropic turns down, Start shows the steps and the step that fixes it, and whatever is asked for says so and offers them; a key Anthropic accepted before keeps the gate open while it is busy, down or out of reach, and the request that meets that says so.

The key is kept in the iOS Keychain or the Android Keystore (`src/host/boot.ts`) and only ever sent to Anthropic, by the page's own fetch. Whether Anthropic accepted it is remembered as a fingerprint of the key, never the key, in the app's settings in Preferences, which the shared work reads and writes through the app's own copy of them (`sharedSettings` in `src/host/settings.ts`), so a setting changed in the app never writes over it. The phone answers the same key calls as the Mac (`hasApiKey`, `checkKey`, `setApiKey`, `clearApiKey` in `src/host/api.ts`), and its page names the device in its own words: `src/shims/platform.ts` stands in for `src/shared/platform.ts` there (`vite.config.ts`), so a sentence says this phone, this iPhone's Keychain or this phone's Android Keystore, where the Mac's says this Mac and its keychain.

## Licences

On a phone, Settings ends with Licences (`src/renderer/src/cutalong/screens/Licences.tsx`): FFmpeg and the rest of the engine, the whisper models, the caption fonts and the page's npm packages, each with its licence to read, and for the parts under the LGPL where their source is (`engine/` at the commit the app was built from, which the build records) and how to put a changed build of them in the app. `node scripts/licences.mjs` fetches the texts from each source at the commit `engine/scripts/versions.env` pins, into `public/licences`; run it again when a pin changes. The npm packages are listed by `vite.config.ts` as the page is built, from what is in it.

## Store builds

When the flow has passed on both phones, the same workflow builds for TestFlight and for Google Play's internal testing track, each only when its secrets are set in the repository (Settings, Secrets and variables, Actions). Without them those jobs are skipped, and the Store secrets job says which are missing. The app id is `social.brewed.cutalong`; the version is the one in the root `package.json` and the build number is the workflow's run number.

TestFlight:

- `APP_STORE_CONNECT_ISSUER_ID`: the issuer ID on App Store Connect's Users and Access, Integrations, App Store Connect API.
- `APP_STORE_CONNECT_KEY_ID`: the key's ID there.
- `APP_STORE_CONNECT_KEY_P8`: the whole of the key's `.p8` file, as text. The key's role must let Xcode manage certificates and profiles (Admin does).
- `APPLE_TEAM_ID`: the team's ID, on the developer account's Membership page.

The app's record is made in App Store Connect first, for the bundle ID `social.brewed.cutalong`. Xcode signs the archive with those keys and uploads it; App Store Connect processes it before testers see it. The app's `Info.plist` answers export compliance (`ITSAppUsesNonExemptEncryption` is false: the app's only encryption is the system's, HTTPS through the web view and URLSession, and the Keychain; the engine's ffmpeg has no TLS library and reads only files on the phone), so it does not ask for each build.

The app's privacy manifest (`ios/App/App/PrivacyInfo.xcprivacy`) declares the APIs Apple asks a reason for that the app uses: file timestamps (the Filesystem plugin's stat and the engine's ffmpeg, on files in the app's container) and user defaults (the Preferences plugin, for the app's own settings). The engine's plugin carries its own. In CI, `ci/privacy-apis.py` reads every binary in the built app for the functions, constants and selectors on Apple's list and fails when one is used and not declared, or declared and not used.

The icons are drawn from the Mac app's mark by `scripts/make-icons.py`, at the sizes each store and launcher asks for: one 1024 px opaque square for iOS, which Xcode makes the rest from; Android's adaptive icon (the coral behind the mark, which also serves as Android 13's themed icon) and the 48 dp icons for Android 7, square and round. `python3 scripts/make-icons.py --play icon.png` writes the 512 px icon the Play Console's listing asks for.

Google Play:

- `PLAY_UPLOAD_KEYSTORE_BASE64`: the upload keystore (`.jks` or `.keystore`), base64-encoded (`base64 -i upload.jks`).
- `PLAY_UPLOAD_KEYSTORE_PASSWORD`: the keystore's password.
- `PLAY_UPLOAD_KEY_ALIAS`: the upload key's alias in it.
- `PLAY_UPLOAD_KEY_PASSWORD`: the upload key's password.
- `PLAY_SERVICE_ACCOUNT_JSON`: the JSON key of a Google Cloud service account that has release access to the app in the Play Console (Users and permissions).

The app is made in the Play Console first, with Play App Signing, and its first bundle is uploaded there by hand: the job keeps each signed bundle as the `cutalong-play-bundle` artifact. After that each run releases its bundle on the internal track (`ci/play-upload.py`).

Pinned exactly: Capacitor 8.6.2 (`@capacitor/core`, `cli`, `ios`, `android`), `@capacitor/filesystem` 8.1.5, `@capacitor/preferences` 8.0.1, `@capacitor/keyboard` 8.0.6, `@capacitor/file-transfer` 2.0.6, `@capacitor-community/keep-awake` 8.0.1 and `capacitor-secure-storage-plugin` 0.13.0.
