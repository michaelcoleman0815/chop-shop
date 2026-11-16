# Cutalong: the rebuild

Chop Shop is becoming **Cutalong**, a video editor people talk to. This page is the map: what was built, how it fits together, what runs where, and what comes next. The design system is published at https://claude.ai/artifact/AsZpkLeXa7pLaqMZkipqLh; the UI rules live in `.claude/skills/cutalong-ui/SKILL.md`.

## Principles

- **The edit is data.** Every change to a video is an op on one document. The chat, presets, notes, the script view and the beat strip all speak the same ops, so every version can be replayed, compared or undone, and a model's proposal can be checked before anything moves.
- **Timing is anchored to words**, not seconds, and the words are tightened to their sound. Strikes, tightening and re-transcription move the cut with the speech, and cuts land a hair before an onset.
- **Local first.** Processing and storage happen on the owner's computer: transcription (whisper.cpp), listening, measuring and rendering (ffmpeg), projects, assets, presets and the brand. Only two things use the network: Claude, for turning words into edits, and fetching a video from a link. Beyond those, other AI services sit behind one switch in Settings, on by default: nothing goes to one until its key is added, then only the sound (to Deepgram or AssemblyAI, to hear every um and false start) or short excerpts (to Google Gemini, to judge a take), and turning it off stops them all except the one request that deletes what AssemblyAI still holds from a job.
- **Talk, don't configure.** Settings are sentences and slash commands. Numbers live behind Details.
- **Pattern, not footage.** A video someone likes is measured for its pattern only. Material pulled into an edit (B-roll, excerpts, icons) is short, cut to for what it shows, and credited in every export.

## Map

| Where                                        | What                                                                                                                                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/edit/`                           | The edit document: zod schemas, ops (`applyOps`), resolution (`resolveCut`: pieces, output times, caption pages), versions and notes.                                                  |
| `src/shared/presets/`                        | Slash commands: built-ins (`/tighten`, `/snappy`, `/shorts`, `/captions`, `/hook`), saved styles, `planStyle` (style to ops), `describePlan` (ops to a sentence).                      |
| `src/shared/inspiration/`                    | Facts, style and the reply for a video someone likes; `cutShape` and `likeness` for "comes out 92% alike".                                                                             |
| `src/shared/assets.ts`                       | Excerpt ranges and limits, icon search and drawing, which beat an asset lands on, credits.                                                                                             |
| `src/shared/audio/snap.ts`                   | Moving each word's edges onto its sound.                                                                                                                                               |
| `src/shared/motion/`                         | Motion graphics: templates, the slash commands that place them on a word, and drawing them the same way in the preview and the export.                                                |
| `src/shared/vision/`                         | Watching the speaker's mouth: face tracks, crop plan, talking and openness per face, the audio offset, cut hints, who is talking, retake hints, mode by niche.                         |
| `src/shared/brand.ts`                        | The brand, learning a look from the owner's own videos, `/brand`.                                                                                                                      |
| `src/main/cutalong.ts`                       | IPC for everything above.                                                                                                                                                              |
| `src/main/cut-render.ts`                     | The renderer of record: each piece its own seeked input, looks as filters, chunking for long cuts, captions in brand colours, logo, loudness.                                          |
| `src/main/premiere-cut.ts`                   | `/premiere`: a version as an xmeml project on the person's own files, checked frame by frame against the export by playing it back with ffmpeg.                                       |
| `src/main/inspiration/measure.ts`            | Cuts, black and white, loudness and contact sheets, measured with ffmpeg alone.                                                                                                        |
| `src/main/audio-envelope.ts`                 | Loudness every 10 ms, streamed from ffmpeg.                                                                                                                                            |
| `src/main/mouth.ts`                          | One ffmpeg pass cropping every face to a small grey tile each frame; `watchClip` runs it on every talking clip as footage comes in, with the Mac's face boxes.                         |
| `src/main/assets.ts`                         | Files, image links, video excerpts and search via yt-dlp, saved icons.                                                                                                                 |
| `src/main/planner.ts`, `planner-prompt.ts`   | Requests and notes to ops with Claude (claude-opus-5-5, adaptive thinking, structured output, prompt caching, server-side refusal fallback). Every op is dry-run before it is offered. |
| `src/main/providers/`                        | Other AI services: the one gate every request to them goes through, their keys, transcription with Deepgram or AssemblyAI, and judging excerpts with Google Gemini.                    |
| `src/main/preset-store.ts`, `brand-store.ts` | Saved commands and the brand, as JSON in userData.                                                                                                                                     |
| `src/renderer/src/cutalong/`                 | The app: rail, Start, thread, editor, projects, brand, presets, settings. `useCutalong` is the session; `usePlayer` plays a cut straight off the source.                               |

## How an edit moves

1. **Footage in.** `cut:prepare` probes the file, transcribes it (or reuses the clip finder's transcript), listens to the audio to tighten every word, watches the speaker's mouth (lines the sound up with it, times cuts to it, marks voices from off camera), splits speech into beats, and makes v1. The brand goes on as v2 when it is set to.
2. **Changes.** A preset runs `planStyle`; a sentence or a set of notes goes to the planner; the script view strikes words; assets land on beats. All of them commit ops as a new version with a one-sentence summary.
3. **Preview.** The editor plays the resolved cut straight off the recording, seeking between pieces, with captions, punch-ins, black and white, big words and cutaways drawn live.
4. **Export.** `cut:render` renders the document with ffmpeg and writes a credits file beside the video when outside material is used.

## Working on it

- `npm test` runs the unit tests and real ffmpeg renders and measurements on clips the tests make themselves (with `FFMPEG_PATH`, `ffmpeg-static`, or the `ffmpeg` on the PATH).
- The Mac app ships ffmpeg 6.0: `ffmpeg-static`'s newest Mac build, older than its Linux one. 6.0 has no `cover` transitions, ignores atempo's tempo command, and repeats a frame when xfade runs over long pictures, so the renderer avoids all three. Run the render tests against 6.0 as well (`FFMPEG_PATH=… npm test`, with the Linux build from the `ffmpeg-static` b6.0 release); the Mac test build runs them on its own copy.
- `npm run typecheck` checks both processes and that every IPC channel the preload uses has a handler.
- The renderer runs in a plain browser with a mock of the main process (`cutalong/mock.ts`) that answers with the real shared logic. Build with `npx electron-vite build`, serve `out/renderer`, and drive it with Playwright to see screens without Electron.

## Status

Built and tested: the edit document, presets and slash commands, inspiration measuring, the renderer of record, the planner, assets (files, image links, video excerpts, B-roll search, icons, credits), listening for snappy cuts, the brand with learning, chats saved with their projects, Settings (the Claude key, checked as it is saved; the transcription model; the export folder; video sign-in; updates), other AI services behind one switch (transcription that keeps every um, judging takes from their sound and picture), planning edits on a local model through Ollama, raw footage (takes, verbatim transcription, intake that reads and fixes each recording, the audio map, cutting profiles by kind of video), learning from the creator's own edits and chats, calm motion throughout, and the Cutalong shell. The editing skills: transitions, J and L cuts, speed, ramps, freeze and reverse, camera moves and `/focus`, a music bed that dips under speech and cuts on its beat, voice polish, sound effects, looks and LUTs, chapters, a second camera, following the speaker, and `/premiere`; and motion graphics from slash commands. Each plays in the preview from the source files and exports through the renderer of record, and the render tests pass on ffmpeg 6.0, 6.1 and 7.0. An edit takes any number of files: they are measured and sorted into talking, better sound and B-roll, the talking clips become one edit, the better sound is lined up under them by ear, and the planner places the B-roll and asks for more where the edit wants it. The editor plays files from a local HTTP server, because Chromium's player does not resume byte ranges through Electron's protocol bridge. The classic tools are gone.

Not yet: B-roll audio, picture-only transitions where the sound runs straight through (today a transition needs a pause or spare footage either side of the cut), a second camera found at intake rather than added with `/angle`, following the speaker off a Mac (it needs `chopshop-vision`), and a renamed app id. The window says Cutalong, but `appId`, `productName` and the update feed still say Chop Shop on purpose: renaming them breaks auto-update for existing installs, and the name needs a trademark and domain check first.

## Next

1. **Skills from research.** `docs/research/` has the observations, a ranked skills catalogue and a three-wave build order. Wave 1, which fits the ffmpeg renderer, is built; wave 2 needs the compositor.
2. **The compositor.** WebGL with WebCodecs, so preview equals export and keyframed motion work (kinetic type, transitions, tracking, masks) becomes possible.
3. **Automations.** A rail item for recurring jobs that run on the owner's computer: "when a video lands in this folder or a livestream ends, find the best moments, cut them as Shorts in my brand, caption them, and queue them for me." Runs land in a review queue by default; posting is a separate opt-in; each run has a spending cap on Claude calls; outside material is always credited.
4. **Strategy chats.** Talk through what to make next, grounded in the channel's own numbers (read-only, with the owner's sign-in), the brand, and what has performed. The result is a plan that can start edits or automations.
5. **Lip landmarks, and calibrating the mouth on real footage.** Watching the mouth runs on ffmpeg alone and was measured on synthetic takes only. On a Mac with Xcode's command-line tools:
   - Give `chopshop-vision` a `--mouth` mode: `VNDetectFaceLandmarksRequest` on frames read in order with `AVAssetReader` (not the image generator, which is slow at full frame rate), only around pauses and over a minute of speech. Per face it adds the inner-lip opening (the gap between the inner lips' top and bottom midpoints over the distance between the eyes) and `yaw`, `roll` and `pitch` (pitch needs macOS 12). The new fields are optional, so `detectFaces` and `buildTrack` keep working.
   - Feed the lip opening to `series.ts` in place of the thumbnail openness, and mark frames with `yaw` over about 45 degrees unreadable. The offset and cut timing need no other change.
   - Measure `naturalLeadSec` once, on a take recorded with the camera's own microphone, so the lips' natural lead over the voice is not read as latency.
   - Try `-hwaccel videotoolbox` for the crop pass; decoding is its main cost, and it could not be tried off a Mac.
