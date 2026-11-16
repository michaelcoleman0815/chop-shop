# How Cutalong cuts a vlog shoot into a story

A vlog shoot is dozens or hundreds of short clips from a phone, an action camera or a drone, most of them pictures with their own sound, some of them the creator talking to the camera. An editor does not trim one long take. They choose moments and tell the day: a hook, where we are and why, scenes that build, a payoff, an ending. This note records what was measured to build that, what Cutalong does with it, and what is not known yet.

**Evidence labels:** **measured** (computed here from footage), **planted** (a synthetic shoot made with ffmpeg whose right answers are known), **estimate** (judgement).

## The reference vlog (measured, pattern only)

One finished event vlog was supplied as a reference: 4:08, 854 × 480. It was studied for its pattern only. No frame, sound or word of it is in this repository; the measurements below are numbers about its timing.

Cuts were found with ffmpeg's scene score (34 above 0.3), then checked by eye on contact sheets, which added 13 cuts the score missed in dim footage: **47 cuts, 48 shots**.

| Part | Shots | Median shot | Shots a minute |
|---|---|---|---|
| 0:00–0:30 | 15 | 0.97 s | 30 |
| of which the opening tease, 0:00–0:11 | 12 | 0.83 s | 63 |
| 0:30–2:00 | 21 | 4.10 s | 14 |
| 2:00–3:20 | 9 | 7.37 s | 6.8 |
| 3:20–end | 3 | (one shot of 42.8 s) | 3.8 |

- **Shape:** a tease of the night's big moment in the first 11 s, a title card, then the day in the order it happened, slowing as it goes, to a payoff held for 42.8 s, the longest shot in the video, and a short ending.
- **Talking:** speech is 50% of the running time. Shots where someone talks run longer (median 4.29 s, 18 shots) than shots without (median 2.65 s, 30 shots).
- **Music:** no steady bed. The beat periodicity of its sound stayed at or below 0.36 everywhere; on calibration files the same measure gave 0.94 for a music bed, 0.13 for speech and 0.23 for speech over music.

## What Cutalong does with it

The decisions live in `src/shared/vlog/`; the main process runs them (`src/main/vlog.ts`).

1. **Watching** (`vlog-watch.ts`, `frames.ts`, `sound.ts`, `moments.ts`): every clip is read once at 8 frames a second, 128 pixels on its long side, and once for its sound in 10 ms frames, and the result is cached by file. From that come when and where it was shot (creation time, an action camera's clock lined up with the phone's, GPS), which stretches are usable (shaky starts, a phone lowered at the end, pocket recordings, dark and soft clips are left out), near-identical takes, and moments, each with its motion, steadiness, light, interest and sounds (speech, laughter, cheering, applause, music, wind).
2. **Scenes** (`scenes.ts`): a new scene at a gap of 40 minutes, a move of 400 m, or a change of look after a few minutes. Clips with no time go with the timed clips they look like; a shoot with no times at all keeps the order of the file names. Scenes after the first day carry their day.
3. **Saying what is in a moment** (`main/vlog-describe.ts`): three small stills per moment go to Claude only with an Anthropic key and the Settings switch "Let Claude see frames from my footage" (on unless turned off); else to a vision model on this Mac through Ollama; else the measurements describe it. Nothing else leaves the Mac for this.
4. **The story** (`story.ts`, `main/vlog-story.ts`): a tease of the strongest moment (a few shots of about a second, landing on it), then the day in order, each scene opening on a steady establishing shot, then its action, its talking cut on words with the retakes struck, and a reaction; the strongest moment again in full as the payoff; a sign-off or a quiet shot to close. Claude, or the model picked to plan edits, may tell the story instead; its beats are checked like planner plans (clips and words it really has, shots inside usable footage) and fitted to the length.
5. **Pace** (`PACE` in `story.ts`, estimate from the table above): tease shots 1.2 s, about 2.5 s in the opening half minute, 2 to 5 s after, the payoff up to 10 s; talking runs as long as its sentences. The length the footage supports is 15% of the usable footage that is not talking plus 90% of the talking.
6. **Music**: a bed dropped with the shoot or put under it later (`/music`) dips 10–12 dB under the talking, and the shots are trimmed so each cut lands on its nearest beat.

## The planted shoot (planted)

55 clips through a day in six places (home, street, park, beach, dinner, a venue at night), made by `src/main/vlog-fixtures.ts` at 640 × 360, with six talking clips from the checked-in espeak recording, an action camera seven hours off, GPS on some clips, a clip with no time, an upright clip, a shaky start, a lowered phone, a pocket recording, a dim clip, a soft clip, a shaky clip, three near-identical takes and one highlight late at night (crowd noise, fast motion, flashing light).

| What | Result |
|---|---|
| Scenes | 6 found, one per planted place, in the order of the day |
| Clips kept or left out as planted | 55 of 55 (3 near-identical takes, 1 soft, 1 pocket, 1 dim, 1 shaky left out; shaky start trimmed to 1.63 s, lowered phone to 4.63 s of 6 s) |
| Tease | 3 shots from the venue, landing on the highlight |
| Talking | every scene with talking keeps its first sentence; retakes struck (the best take of 3 lines kept, 4 others removed) |
| Lengths asked (2 min, 45 s, half) | 120.0 s, 45.0 s, 40.0 s: within 0.1% |
| Real app, end to end | 55 clips to v1 in 14.8 s on Linux, 6 talking clips heard by a stand-in for whisper |
| Export, vertical and wide | 1080 × 1920 and 1920 × 1080, 1:00; 17 of 17 shots show their own clip at a sampled frame |
| Music under talking | the bed's tone 10.4 dB lower under the talking than under the shots (set to 12 dB) |

## Rebuilding the reference from its shots (measured)

The reference was cut into its shots, the 13.2 s tease and title left out (they copy later footage), each shot given a recording time from its place in the video, and the files shuffled. From measurements alone, with no words heard:

- The day came back in order: 3 scenes, in the reference's order.
- The strongest moment chosen was a cheering moment at 1:37 of the reference. The editor's payoff, the stage moment at about 3:17, scored second (interest 0.99 against 0.97, lower picture quality).
- With the talking not transcribed, the 42.8 s stage speech could only be a shot, not the payoff it is in the reference.

## Not known yet

- **Real phone footage.** Every threshold here comes from planted clips and one reference. Shake, darkness and near-identical takes need checking on real iPhone, GoPro and drone clips.
- **Claude and Ollama, live.** Both are tested with recorded answers only; neither was called.
- **Speed at scale on a Mac.** 200 planted clips of 3 s were watched in 6.1 s here; real 4K HEVC clips decode far slower, and hardware decoding was not tried.
- **Faces** are measured only on a Mac (the vision helper); on Linux they were not.
- **Reactions** go last in their scene, as the structure asks; in the rebuilt reference that moved one reaction after later action, which an editor might not do.
