# Cutalong

A video editor you talk to, for YouTube creators. Drop in a recording and say what you want: "cut this for Shorts",
"make the hook punchier", "keep the calendar shot in colour". Cutalong cuts on the words, shows you a new version, and
keeps every version so nothing is lost. It runs on your own Mac or PC: your footage never leaves it.

## What it does

- **Takes any amount of footage.** Drop every file from a shoot at once and say what they are: Cutalong measures each
  one, works out which is the talking, which recording has the better sound and which is B-roll, and says so. The
  talking clips become one edit in the order they were shot, and a screen or recorder file with the better microphone
  is lined up under them by ear, to the hundredth of a second, for the words, the preview and the export.
- **Edits from what you say.** Requests in the chat and notes left while watching go to Claude, which proposes changes
  to the edit. Every change is checked before it is offered and lands as a named version. The B-roll you bring in is
  placed on the lines it shows, and when an edit wants more, Cutalong looks for clips for those moments. Pick a
  stretch on the beat strip (drag across it, Shift-click, or Shift and the arrows) and a note or a command acts on it
  alone: "between 0:12 and 0:31, four beats come in with a dissolve".
- **Cuts to a length.** "Make it 10 minutes", "cut it to 60 seconds", "remove my intro", "keep the full argument" or
  `/length 8-10 min` cut a talking head, a podcast or any edit on your Mac, keeping the hook, each section's point and
  the ending, and say what went. A topic to cut or focus on goes to the planner, and so does the rest of a sentence
  ("make it 60 seconds and add captions"). A length said of anything but the whole video ("fade in for about 2
  seconds") is the planner's too.
- **Finds your retakes.** Lines said again, restarted mid-sentence or broken off are found from the words and their
  timing, and the best take is kept with one click, a sentence ("use the second take") or the Takes panel.
- **Cuts on the words.** The recording is transcribed on your computer, split into beats, and every word's edges are
  tightened to its sound, so a cut lands a hair before a word instead of clipping it. When your face is on camera,
  Cutalong also watches your mouth: it lines the sound up with your lips and opens each cut on a still mouth. Strike
  words in the script view to remove them.
- **Presets are slash commands.** `/tighten`, `/snappy`, `/shorts`, `/captions` and `/hook` are built in. Save any style
  as your own command, and `/brand` puts your brand on an edit.
- **Videos you like are inspiration.** Paste a link and Cutalong measures its pattern: pace, cut length, colour,
  loudness and shape. It applies that pattern to your footage and never takes the other video's footage.
- **B-roll, images and icons.** `/broll` finds short clips, a link brings in an excerpt or an image, and `/icon`
  searches Lucide's 1,539 open-source icons. Outside material is kept short, cut to for what it shows, and credited
  in a file written beside every export.
- **Your brand, one per channel.** Drop in videos you have already made and Cutalong learns your look from them. Set a
  logo, caption colours, how captions sit, the faces your graphics use, and a few sentences on how you talk. New edits
  pick up your default brand by themselves; the brand name in a chat's header switches it to another, as a version
  undo takes back. What is learned from a brand's videos and chats stays with that brand. Edits from before brands
  stay in your first brand, and going back to an older Cutalong for a while loses nothing: the older one still opens
  what this one saved, and its brand changes come back with you.
- **A never list per brand.** Say "never use whooshes" or "no transitions on this channel" and that brand never gets
  them again: `/all` leaves them out and says so, a command for one says the channel never uses it, and Claude is told
  and checked. The list, with what you said, is on the Brand page, beside the B-roll sources: channels to look in
  first and ones never to use.
- **Ready to upload.** Beside every export go its captions as .srt and .vtt, word for word and to the hundredth what
  the picture shows, a description with chapters, credits and your brand's own lines, and three titles and 10 to 15
  tags. Claude writes the titles, opening and tags with your key; without it, they are made on your Mac from your
  words, and the chat says which.
- **Learns how you edit.** Give it a recording and the video you made from it, and it learns the pauses you leave, the
  fillers you cut and the take you keep. From your chats it learns what you ask for again and again. Both stay on your
  Mac, and you can see, edit or forget anything it learned on the Brand page.
- **Edits the way Premiere does.** Transitions (`/transition dissolve`, whip, push, wipe, dip), J and L cuts, speed,
  ramps, freeze frames and reverse, camera moves (`/pushin`, `/kenburns`, `/punchin`, `/pan`, `/shake`) and `/focus`
  for screen recordings. A music bed that dips under speech and cuts on its beat, voice polish, sound effects made on
  your Mac, looks and LUTs (`/warm`, `/cinematic`, `/look contrast 0.2`), chapters for YouTube, a second camera
  (`/angle`), and following the speaker when a wide shot is cropped to vertical (`/reframe`). `/all` puts on every
  finishing touch a video of its kind gets in one version: voice polish, a music bed, transitions where the sections
  change, a look, whooshes and chapters. Each one plays in the preview the moment it exists, exactly as it exports. Where something does not fit, such as a dissolve between
  words with no pause between them, it says so instead of pretending.
- **Any shape of picture.** A phone clip held upright in a wide video, a still, or a screen recording that a crop would
  cut to a sliver is shown whole on a blurred, darker copy of itself, in the preview and the export alike. Wide footage
  in a vertical video still fills the frame, as Shorts and Reels expect. `/fill blur` puts every picture of another
  shape on a blurred copy, "use black bars" (`/fill black`) gives plain bars, and `/fill crop` crops them all. An edit
  saved before this keeps the crop it had until `/fill auto` asks for the rest.
- **Motion graphics the way After Effects does.** Lower thirds, callouts, keyword pops, kinetic titles, hook banners,
  end cards, logos, market charts, screenshots of a page and a phone with logos going round it, each a slash command
  (`/lowerthird`, `/callout`, `/pop`, `/title`, …) that lands on the word you are watching.
- **Scene effects for gaming and commentary.** A blocky pixel scan that brings the items in one by one, or you, or the
  whole picture (`/scan`); a shockwave that bends the picture and shakes it on a hit or a landing (`/impact`); speed
  lines rushing past a clear middle (`/speedlines`); the background blurring behind you while you stay sharp
  (`/bgblur`); and 3D chrome or gold lettering for a title or a number counting up (`/chrome 1,000,000`). Ask in plain
  words ("add speed lines and an impact when he lands") or by command; `/hype` cuts the whole video fast with
  punch-ins, big captions, a scan to open and impacts on the big moments. On a Mac, Vision cuts the person and the
  objects out for them; elsewhere each effect works on the whole frame or a region and the reply says so.
- **Vlogs.** Drop a day of clips with "make a vlog" or `/vlog 8 min`. Cutalong watches every clip, leaves out the
  shaky, dark, pocket and repeated ones, works out the day from when and where each was shot, and tells it as a
  story: a tease of the best moment, the day in order, what you said to camera cut on the words, the payoff and a
  close. Ask for a length, an opening or more of a part, and each is a new version; the next day's clips join it.
- **Clips from long recordings.** `/clipping` on a stream, a Sunday service or a podcast finds the moments that stand
  on their own, leaves out the worship set, the announcements, the BRB screen and the sponsor read, and makes each one
  a vertical, captioned short you can open, change and export, or export all at once (`/clipping 10`,
  `/clipping the funny parts`).
- **Opens in Premiere.** `/premiere` writes the version as a Premiere project on your own files, with the better sound,
  cutaways, punch-ins, music and effects on their tracks, captions as an SRT, and markers for what stays in Cutalong.
- **Exports** with captions, logo and loudness set to -14 LUFS, rendered by ffmpeg in the colour QuickTime and Chrome
  show HD in (BT.709, and tagged so). The captions in the preview are the export's: the same words at the same size in
  the same place.

[docs/rebuild.md](docs/rebuild.md) has the plan and [docs/research](docs/research/editing-skills.md) has the research
behind the order the skills were built in.

## What runs where

Everything is processed and stored on your computer: transcription (whisper.cpp), listening, measuring and rendering
(ffmpeg), projects, assets, presets and your brand. Three things use the network:

- **Claude**, to turn what you say into changes, with your own Anthropic API key. Claude sees the transcript and the
  edit, never the footage itself. For a vlog it also sees three small stills from each moment, to say what is in it,
  unless "Let Claude see frames from my footage" is off in Settings. At export it writes the titles, the
  description's opening and the tags from the transcript, unless "Let Claude write titles, descriptions and tags" is
  off. The key is kept in the macOS keychain and only ever sent to Anthropic.
- **Fetching a link** you paste: a video through yt-dlp, or an image. `/broll` searches YouTube the same way, in your
  brand's preferred channels first.
- **The update check**, which reads this repository's GitHub Releases.

The editor plays your files from a small web server only this Mac can reach (127.0.0.1, behind a token made at each
launch), because that is what lets the player read and seek a long recording the way it reads a video online.

Other AI services (AssemblyAI, Deepgram and Gemini) can hear the words or judge a cut when you add their keys in
Settings. One switch turns all of them off, and nothing is sent to them without a key.

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
`scripts/fetch-ytdlp.sh` and `scripts/fetch-fonts.sh`. On Windows their Node twins do the same
(see [Windows](#windows)).

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

## Windows

Cutalong runs on Windows 10 and 11 on x64 too, and each release carries its installer beside the Mac's DMG:
`Cutalong-Setup-<version>-x64.exe` (for example `Cutalong-Setup-0.4.0-x64.exe`), with `latest.yml`, the file a PC's
copy reads to update itself. Each push to the Cutalong branch also makes a test installer,
`cutalong-windows-test-<run>` in the test build's artifacts, which is never published.

**Opening it the first time.** The installer is not signed yet, so SmartScreen stops it with "Windows protected your
PC" and "Unknown publisher". Choose **More info**, then **Run anyway**. It installs for the person who runs it, with no
administrator, and Cutalong is then in the Start menu. Updates after that come down and install by themselves, as on a
Mac, and SmartScreen does not ask again: it checks what a browser downloads, not what the app does.

**What is different on a PC.**

- Faces are found by YuNet, OpenCV's small face detector (MIT, `resources/faces`), in onnxruntime, where a Mac uses
  Vision. Following the speaker, `/reframe` and the mouth check give the same answers.
- whisper.cpp runs on the processor, built for AVX2 (Intel and AMD processors from about 2013 on); an older processor
  is told so in a sentence.
- Exports Cutalong does outside the edit (a clip, the timeline) encode with libx264 where a Mac uses VideoToolbox. The
  edit's own export is the same ffmpeg 6.1.1 on both.
- The API keys are encrypted for your Windows account (DPAPI) where a Mac keeps them in the keychain.
- A link that needs a sign-in can borrow Firefox's. Chrome, Edge and Brave lock theirs on Windows, and Safari is a
  Mac's alone, so Settings offers Firefox only and says why.
- Scene effects that cut out the person or the objects in the picture need Vision, which is a Mac's alone. On a PC each
  of them does its version on the whole frame or a region, and the reply says so in a sentence.
- A release published before Windows releases (0.3.2 and older), or one whose Windows build failed, has no
  `latest.yml`. A PC's copy then stays on the version it has, and Settings says the newest release has no Windows
  version yet.

**Building it on a PC.** Node 20, Git, and Visual Studio 2022 or its Build Tools with "Desktop development with C++"
(MSVC, CMake and the Windows SDK). Then, in Git Bash or PowerShell:

```bash
npm ci
node scripts/build-whisper.mjs        # whisper-cli.exe: CPU with AVX2, the C runtime linked in
node scripts/fetch-ytdlp.mjs          # yt-dlp.exe, checked against the SHA-256 pinned in the script
node scripts/fetch-fonts.mjs
node scripts/bundle-msvc-runtime.mjs  # the C++ runtime onnxruntime needs, put beside it
npm run dist:win                      # typecheck, build, and the installer, unsigned and not published
```

The installer lands in `release/` and the app, unpacked, in `release/win-unpacked`. Two checks say whether it works:
`node scripts/check-windows-binaries.mjs` says whether every helper needs only what Windows has, and
`node scripts/self-check-app.mjs release/win-unpacked/Cutalong.exe` opens the app in its self-check
(`src/main/self-check.ts`), which runs each helper, Skia and the face finder inside it, reads the update feed it will
check, and says what works.

**Tests.** `npm test` is the same suite as on a Mac. The programs tests stand in for (ffmpeg, whisper, yt-dlp) are small
scripts with a `#!` line, which `src/main/test-setup.ts` hands to Node on Windows; `CUTALONG_STAND_INS=node npm test`
does the same on a Mac or Linux. On Windows two tests of how a render killed by a signal is described are skipped,
since Windows ends a program with a code and has no signals to tell apart.

Signing is under [Signing on Windows](#signing-on-windows).

## Shipping an update

The app checks for updates 4 seconds after launch and every 6 hours after that. When one exists it
shows a banner: **Download update** → progress → **Restart & install**.

To publish one:

1. Bump the version: `npm version patch` (or `minor` / `major`).
2. Push the tag: `git push --follow-tags`.
3. `.github/workflows/release.yml` makes the GitHub Release as a draft, builds on macOS and on Windows at once, and
   publishes the release once both have uploaded: the DMG, the ZIP and `latest-mac.yml` from the Mac, and
   `Cutalong-Setup-<version>-x64.exe`, its `.blockmap` and `latest.yml` from Windows. The tag must be `v` and the
   version in `package.json`, which `npm version` makes it.

Every running copy picks it up on its next check. `latest-mac.yml` is the file electron-updater
actually reads on a Mac and `latest.yml` on Windows, and electron-builder writes both. Do not hand-edit the release
assets.

The draft stays out of sight of the updater until every file is in it. If the Windows build fails, the release is
still published for the Mac, the workflow fails to say Windows is missing, and running its windows job again adds the
installer to the published release.

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

### Signing on Windows

The Windows installer is unsigned until this is set up. It installs and updates all the same: SmartScreen asks once,
before the first run of a downloaded installer ("Unknown publisher", **More info**, **Run anyway**), and
electron-updater installs an unsigned update into an unsigned copy without asking. Signing puts a name on the
installer in place of "Unknown publisher", and SmartScreen stops asking once enough people have run files signed with
that name.

What to buy: **Azure Artifact Signing** (Microsoft's signing service, formerly Trusted Signing), on the Basic tier,
billed monthly to a pay-as-you-go Azure subscription (a free or trial subscription cannot use it; the current price is
on azure.microsoft.com/pricing/details/artifact-signing). Microsoft checks who you are against a government ID (a
business also by its records, which can take some weeks), and the certificate then says that name. A person signing
alone has to be in the United States or Canada; a registered business can be in more countries. A certificate bought
from a certificate authority works too, but its key has to live on a hardware token or in their cloud, which a GitHub
runner cannot reach without its own signing step; the workflow is set up for Artifact Signing.

Once it is bought, in the Azure portal:

1. Register the `Microsoft.CodeSigning` resource provider on the subscription.
2. Make an Artifact Signing account (Basic) in a region near you, and note its endpoint, such as
   `https://eus.codesigning.azure.net` for East US.
3. Under Identity validations, make a Public one (Individual, or Organization for a business) and finish it.
4. Under Certificate profiles, make a **Public Trust** profile from that validation. Its subject preview shows the
   name the certificate will carry (CN), exactly.
5. In Microsoft Entra ID, make an app registration, give it a client secret, and give it the **Artifact Signing
   Certificate Profile Signer** role on the signing account.

Then add seven repo secrets:

- `AZURE_TENANT_ID`: the directory (tenant) ID
- `AZURE_CLIENT_ID`: the app registration's application (client) ID
- `AZURE_CLIENT_SECRET`: its client secret's value
- `AZURE_SIGNING_ENDPOINT`: the account's endpoint, as in step 2
- `AZURE_SIGNING_ACCOUNT`: the Artifact Signing account's name
- `AZURE_SIGNING_PROFILE`: the certificate profile's name
- `WIN_PUBLISHER_NAME`: the CN from step 4, character for character (for a person, the legal name)

The release's windows job turns signing on when `AZURE_CLIENT_SECRET` is set, fails if any of the other six is
missing, signs with electron-builder's `win.azureSignOptions`, and checks the installer and the app are validly
signed before it uploads them. With none of the seven, it builds unsigned with a warning, as now.

One thing to know before turning it on: a signed copy installs only updates signed with the same publisher name, so
`WIN_PUBLISHER_NAME` must not change afterwards. A copy installed before signing takes the first signed update without
asking, as it takes any update.

## Layout

```
src/main                    Electron main: ffmpeg jobs, transcription, the planner, assets, updater
src/preload                 The contextBridge surface (window.chop)
src/renderer/src/cutalong   Cutalong: the sidebar, Start, threads, the editor, brand, presets, settings
src/shared                  The edit document, presets, inspiration, assets, audio and brand, with their tests
docs                        The rebuild plan, the research, and the brand guidelines
build                       Icon, entitlements, icon generator
```

## The name

The app is called Cutalong in the Dock, the menu bar, Finder and the installer, and new projects end in `.cutalong`.
Settings and projects made by Chop Shop are found where they were and open as before. The app id and the update feed
still say chopshop on purpose: changing them breaks auto-update for everyone who already has the app. When that is
worth doing, change `appId` in `electron-builder.yml`, `publish` there and in `dev-app-update.yml`, and `RELEASES_URL`
in `src/main/updater.ts`, in one release.

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
- **Type.** Figtree for the interface, Source Serif 4 for what people read (replies, the script, notes), JetBrains Mono for commands, timecode and file names. All three ship inside the app as Latin subsets under the SIL Open Font License: Figtree and JetBrains Mono from their `@fontsource` packages, Source Serif 4 in `src/renderer/src/cutalong/fonts/` with its licence (`SourceSerif4-OFL.txt`).
- **Voice.** First person, plain words, exact numbers. No exclamation marks, no emoji, no praise, never "clone".

The app icon is the Cutalong mark in white on a coral tile, drawn from the same geometry as the mark in the app by
`python3 build/make-icon.py`. The Chop Shop guidelines and designs are kept in [docs/archive](docs/archive).
