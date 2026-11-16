# Cutalong

A video editor you talk to, for YouTube creators. Drop in a recording and say what you want: "cut this for Shorts",
"make the hook punchier", "keep the calendar shot in colour". Cutalong cuts on the words, shows you a new version, and
keeps every version so nothing is lost. It runs on your own Mac: your footage never leaves it.

The app still installs as **Chop Shop** while the new name is cleared (see [The name](#the-name)).

## What it does

- **Edits from what you say.** Requests in the chat and notes left while watching go to Claude, which proposes changes
  to the edit. Every change is checked before it is offered and lands as a named version.
- **Cuts on the words.** The recording is transcribed on your computer, split into beats, and every word's edges are
  tightened to its sound, so a cut lands a hair before a word instead of clipping it. Strike words in the script view
  to remove them.
- **Presets are slash commands.** `/tighten`, `/snappy`, `/shorts`, `/captions` and `/hook` are built in. Save any style
  as your own command, and `/brand` puts your brand on an edit.
- **Videos you like are inspiration.** Paste a link and Cutalong measures its pattern: pace, cut length, colour,
  loudness and shape. It applies that pattern to your footage and never takes the other video's footage.
- **B-roll, images and icons.** `/broll` finds short clips, a link brings in an excerpt or an image, and `/icon`
  searches Lucide's 1,539 open-source icons. Outside material is kept short, cut to for what it shows, and credited
  in a file written beside every export.
- **Your brand.** Drop in videos you have already made and Cutalong learns your look from them. Set a logo, caption
  colours, how captions sit, and a few sentences on how you talk. New edits pick it up by themselves.
- **Exports** with captions, logo and loudness set to -14 LUFS, rendered by ffmpeg.
- **The classic tools** are one click away in the sidebar: the clip finder, the timeline editor and Live Buffer.

Premiere Pro and After Effects-level skills are being built now: transitions, J and L cuts, music that ducks under
speech, voice polish, colour, speed ramps, camera moves and reframing, and keyframed motion graphics for titles,
callouts and kinetic captions. [docs/rebuild.md](docs/rebuild.md) has the plan and
[docs/research](docs/research/editing-skills.md) has the research behind the order.

## What runs where

Everything is processed and stored on your computer: transcription (whisper.cpp), listening, measuring and rendering
(ffmpeg), projects, assets, presets and your brand. Three things use the network:

- **Claude**, to turn what you say into changes, with your own Anthropic API key. Claude sees the transcript and the
  edit, never the footage. The key is kept in the macOS keychain and only ever sent to Anthropic.
- **Fetching a link** you paste: a video through yt-dlp, or an image.
- **The update check**, which reads this repository's GitHub Releases.

## Getting started

Add your Anthropic API key in **Settings** (bottom of the sidebar). The transcription model downloads the first time
it is needed, or from Settings.

## Running it

```bash
npm install
npm run dev
```

`npm run dev` starts Vite with hot reload for the renderer and restarts the main process on change.

Native helpers are not checked in (`resources/bin` is ignored). Build or fetch them once with
`scripts/build-whisper.sh`, `scripts/build-native.sh` (the Vision helper used for face tracking),
`scripts/fetch-ytdlp.sh` and `scripts/fetch-fonts.sh`.

### Tests

```bash
npm test            # unit tests, plus real ffmpeg renders on clips the tests make themselves
npm run typecheck   # both processes, and every IPC channel the preload uses has a handler
```

### The interface without Electron

The renderer runs in a plain browser on a mock of the main process that answers with the real shared logic, so every
screen can be reached and screenshotted:

```bash
npx electron-vite build
cd out/renderer && python3 -m http.server 5199
```

## Building a local .app

```bash
npm run dist
```

The DMG and ZIP land in `release/`. Without an Apple Developer ID the build is unsigned: macOS will
warn on first open (right-click → Open once), and auto-update falls back to opening the releases page
instead of installing silently. See "Signing" below.

## Shipping an update

The app checks for updates 4 seconds after launch and every 6 hours after that. When one exists it
shows a banner: **Download update** → progress → **Restart & install**.

To publish one:

1. Bump the version: `npm version patch` (or `minor` / `major`).
2. Push the tag: `git push --follow-tags`.
3. `.github/workflows/release.yml` builds on macOS and publishes a GitHub Release with the DMG, ZIP
   and `latest-mac.yml`.

Every running copy picks it up on its next check. `latest-mac.yml` is the file electron-updater
actually reads, and electron-builder writes it automatically. Do not hand-edit the release assets.

Prerequisites, one time only:

- Create the GitHub repo `michaelcoleman0815/chop-shop` and push to it. If you rename it, update `publish`
  in `electron-builder.yml`, `dev-app-update.yml`, and `RELEASES_URL` in `src/main/updater.ts`.
- Keep the repo **public**, or auto-update has to ship a GitHub token inside the app to read
  releases. A private repo means switching to a `generic` provider on your own host instead.

### Signing

macOS refuses to swap an app bundle in place unless it is signed, so unsigned builds detect updates
but cannot install them. The banner turns into "open releases" and you replace the app by hand. With
a $99/yr Apple Developer ID, export the certificate as a `.p12`, base64 it, and add two repo secrets:

- `CSC_LINK`: the base64 of the `.p12`
- `CSC_KEY_PASSWORD`: its password

The workflow already passes both through, and updates then install on restart with no prompts.

The certificate has to be a **Developer ID Application** one. "Apple Development" and "Mac App
Distribution" are the two that get picked by mistake, and neither can sign an app distributed outside
the App Store.

### Notarization

Signing is enough for the updater, but a build downloaded fresh is still refused by Gatekeeper until
Apple has notarized it. Three more secrets turn that on:

- `APPLE_ID`: the Apple ID that owns the membership
- `APPLE_APP_SPECIFIC_PASSWORD`: generated at appleid.apple.com, not the account password
- `APPLE_TEAM_ID`: the ten-character team ID from the developer portal

Notarization is only attempted alongside a certificate, since Apple has to have something validly
signed to accept. Set the certificate without these three and the build still succeeds, with a
warning that the result will not open on a machine that has not seen it before. Notarization adds a
few minutes to the release, most of it waiting on Apple.

## Layout

```
src/main                    Electron main: ffmpeg jobs, transcription, the planner, assets, updater
src/preload                 The contextBridge surface (window.chop)
src/renderer/src/cutalong   Cutalong: the sidebar, Start, threads, the editor, brand, presets, settings
src/renderer/src/legacy     The classic tools, loaded only at #classic
src/shared                  The edit document, presets, inspiration, assets, audio and brand, with their tests
docs                        The rebuild plan, the research, and the brand guidelines
build                       Icon, entitlements, icon generator
```

## The name

The window and the interface say Cutalong. The app id, product name and update feed still say Chop Shop on purpose:
renaming them breaks auto-update for everyone who already has the app, and the new name needs a trademark and domain
check first. When it is cleared, change `appId` and `productName` in `electron-builder.yml`, `publish` there and in
`dev-app-update.yml`, and `RELEASES_URL` in `src/main/updater.ts`, in one release.

## Classic tools

The tools Chop Shop started with are still here, under **Classic tools** in the sidebar.

- **Clip Studio** (the clip finder): open a long video, let Claude find the moments worth clipping, and export each
  as a 9:16, 1:1 or original-ratio MP4.
- **Timeline editor**: a multi-track timeline with the tools an editor's hands already know.
- **Live Buffer**: keep the last 15 s to 5 min of any screen or window in memory and grab it with a global hotkey, the
  way a stream clipper does. Nothing is written to disk until you press the key.

### Permissions

Live Buffer needs **Screen & System Audio Recording** in System Settings → Privacy & Security. The
app links straight to the pane when the permission is missing. macOS does not expose system audio to
screen capture, so only the microphone can be mixed in.

### Hotkeys

| Key       | Where                  | Does                             |
| --------- | ---------------------- | -------------------------------- |
| `⌘⇧C`     | anywhere on the system | Grab the buffered tail           |
| `Space`   | Clip Studio            | Play / pause                     |
| `I` / `O` | Clip Studio            | Set in / out point               |
| `←` `→`   | Clip Studio            | Step one frame (hold `⇧` for 5s) |

The global hotkey is editable in Settings using Electron accelerator syntax. If another app already
owns the combination, registration fails silently and the old hotkey stops working.

### How the buffer works

`MediaRecorder` is rotated every 4 seconds, so each retained blob is a complete, independently
decodable WebM segment. A grab flushes the in-flight segment, concatenates the retained ones
losslessly, then trims the tail to the configured length and re-encodes to H.264. That is why grabs
land on a clean boundary instead of producing a file that only some players can open.

Memory is the real limit on buffer length: 5 minutes at 8 Mbps is roughly 300 MB held in the
renderer.

## Troubleshooting

**"Electron.app was not opened because it contains malware" / the dev app dies with SIGKILL.**
This is macOS, not your code. The Electron runtime npm downloads is ad-hoc signed, and unpacking the
zip breaks the signature seal; XProtect has also flagged older Electron builds outright. `npm run
dev` uses Electron 44 and `scripts/prepare-electron.mjs` re-signs the runtime after every install, so
this heals itself. To fix it by hand:

```bash
codesign --force --deep --sign - node_modules/electron/dist/Electron.app
```

If macOS already moved it to the Trash, `rm -rf node_modules/electron && npm install` puts it back.
Pin Electron forward rather than back, because old majors are what trip the malware rules.

**`npm ci` warns about node-abi and Node 20.** electron-builder 26 prefers Node 22.12+. Packaging
works on Node 20 for this project because it has no native modules, but move to Node 22 if a build
ever fails inside `app-builder`.

## Brand

[docs/brand-guidelines.pdf](docs/brand-guidelines.pdf) is printed from
[docs/brand/guidelines.html](docs/brand/guidelines.html) (`node docs/brand/print.cjs`). The values in it are the ones
the app is built from, in `src/renderer/src/cutalong/tokens.json`; a test fails if the stylesheet drifts from them. The
rules for building interface live in [.claude/skills/cutalong-ui/SKILL.md](.claude/skills/cutalong-ui/SKILL.md).

- **Colour.** A warm grey ground (`#F5F5F3`), white cards and ink (`#15161A`). Coral (`#FF5A36`) marks the cut and
  nothing else: the playhead, the mark, the assistant's avatar. Never text, never a button fill.
- **Type.** Figtree for everything people read; JetBrains Mono for commands, timecode and file names.
- **Voice.** First person, plain words, exact numbers. No exclamation marks, no emoji, no praise, never "clone".

The Chop Shop guidelines are kept in [docs/archive](docs/archive/chop-shop-brand-guidelines.pdf). The app icon is still
the Chop Shop mark, generated by `python3 build/make-icon.py`; it changes with the name.
