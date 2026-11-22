# What editing skills Cutalong should build next

## Read this first: the real sample

**25 videos were measured, not the ~200 the brief asked for, and none was watched.** The run stopped there because every tool that can see or hear a video was unavailable:

- **NexLev (free plan):** the watching tool (`watch_youtube_video_and_ask`) and the frame tool (`extract_video_frames_for_editing_animation_and_camera_style`) are refused on the free plan. Transcripts are capped at 5 single and 2 bulk calls per 24 hours, and both caps were used.
- **VidIQ:** the account held 4 credits. A watch costs 10 (Shorts) or 25 (long-form) and a search costs 5, so no paid call was possible. 0 credits were spent.
- **Local measurement:** this container's network first blocked YouTube. With the owner's approval the network was opened briefly; YouTube then answered with its "confirm you're not a bot" check. Workarounds were not attempted and the network was restored. No video or audio was downloaded.

| | Count | Niches | Formats |
|---|---|---|---|
| Videos measured (caption timing) | 25, of which 23 have usable speech | business-entrepreneur 6, cooking 6, education-explainer 5, tech-review 4, personal-finance 3, science 1 | 24 Shorts, 1 long-form (Veritasium, 66 min) |
| Videos with frames or visuals observed | **0** | none | none |
| Queued with metadata only (not in observations.jsonl) | 19 | fitness 7, personal-finance 5, tech-review 3, education-explainer 2, cooking 2 | Shorts |

Channels in the measured sample: Alex Hormozi, Codie Sanchez, Zack D. Films, Kurzgesagt, Mrwhosetheboss, Nick DiGiovanni, Max the Meat Guy, Humphrey Yang and Veritasium. Views run from 506K to 329M (median 14M).

**What was measured.** For each video this run computed the speech timeline from the timed caption lines of the final upload (YouTube's automatic captions, returned by NexLev): speech rate, an estimate of how much non-speech time remains, gaps left at caption-line boundaries, time to the first word, words in the first 3 seconds, and stretches tagged [Music], [Laughter] or [Applause]. Views and titles come from search results. Cut times, captions, motion, sound effects and colour were **not** measured. The renderer-side columns of `observations.jsonl` (`cutsPerMinute`, caption style, SFX) are null for that reason.

**What was reported by others.** Everything visual, every motion detail and every SFX or music detail in this report comes from published analyses, found with Exa web search, and from Raylight's motion reference library (product films measured frame by frame). They are cited inline. The two most-used sources are PandaStudio, whose 22 videos were measured frame by frame and with ffmpeg scene detection, and Viibeo, whose 54 viral Shorts were measured from storyboard frames. Both sell AI video tools, so treat their rules as measured but interested.

**Evidence labels used throughout:**

- **measured**: computed by this run from the 25 videos.
- **observed**: seen directly in frames or by watching. **No skill reaches this level in this run.**
- **reported**: from published analyses or the motion library, not checked here.
- **estimate**: judgement, with no measurement behind it.

Each skill in `skills-catalog.json` carries `evidence.level` and `evidence.confidence`, so thin conclusions stay visible.

Files:
- `docs/research/observations.jsonl`: one record per measured video, as specified, plus pacing fields such as `pauseShareEst` and `retainedGapPerCaptionLineP90Sec`. The three Hormozi records also carry a clearly labelled channel-level note from a published teardown.
- `docs/research/skills-catalog.json`: 36 skills, ranked.

## Tools and credits used

| Connector | Calls | What came back | Credits |
|---|---|---|---|
| NexLev (free plan) | 39 | 29 returned data: 17 YouTube searches, 2 indexed searches, 1 channel Shorts list, 1 video details, 1 subtitle record, 5 single transcripts, 2 bulk transcripts of 10. 2 were refused by the plan (watch, frames). 8 hit the daily cap (6 single, 2 bulk). | No credit meter on the free plan. The binding limits are the per-tool caps above. |
| VidIQ | 2 (balance, usage list) | Balance 4 credits (0 of 150 renewable, resets 2026-11-25; 4 add-on) | 0 spent. Every analysis call costs more than the balance, so the 80% rule never came into play. |
| Exa | 10 (9 searches, 1 page read) | Published studies and teardowns | Not reported by the tool |
| Raylight | 3 (2 library searches, 1 read of 3 shots) | Frame-measured motion data from product films | Not reported by the tool |
| Environment | 3 (1 read, 2 changes) | Network opened with the owner's approval, then restored to its previous limited setting | none |

## Method

1. **Sampling.** Creator-name searches (NexLev `youtube_search`) for each niche, picking each channel's highest-view Shorts and recent long-form. A channel name is marked "inferred" where it came from the search query rather than from the video record.
2. **Measurement.** Caption lines from the transcript tool, plus a small script that does not see the video, compute for each video:
   - **Effective speech rate**: words divided by the time from the first to the last word.
   - **Estimated pause share**: time each caption line takes beyond `syllables × fast articulation time × 1.25`. The fast articulation time is the speaker's own 25th-percentile seconds per syllable. Long multi-syllable words are therefore not counted as pauses, but gaps shorter than about 0.2 s cannot be seen.
   - **Retained gap per caption line**: that excess, as a mean and a 90th percentile.
   - **First-word time** and **words in the first 3 s**.
   - **[Music] / [Laughter] tags**, which the caption system emits only when there is no speech.

   Videos are labelled:
   - **tight**: est. pause share ≤8% and ≤2.5 pauses over 0.5 s per minute.
   - **moderate**: est. pause share ≤16%.
   - **natural**: otherwise.

   All of these numbers are estimates.
3. **Secondary research.** Searches aimed at studies that measured shot length, captions, B-roll, sound and motion, preferring pages with sample sizes. One read of a 22-video study. The Raylight library was used for motion timing.
4. **Ranking.** `priority = 10 × estimatedShare × impact ÷ buildEffort`.
   - `estimatedShare` (0 to 1) is how common the skill is among successful videos of the format it applies to. It is measured where possible, otherwise taken from the cited studies.
   - `impact` (1 to 5) is how much the skill changes how good an edit looks. This is my judgement.
   - `buildEffort` (1 to 5) is my estimate against the current code: ops in `src/shared/edit/schema.ts`, and a renderer in `src/main/cut-render.ts` that already does crop/scale punch-ins, `hue=s=0`, overlays, libass captions through an ASS file, and loudnorm.

   The formula deliberately favours cheap, common wins. For an impact-first view, the five skills with impact 5 are: cold open, word-timed captions, pause trimming, clip finding and vertical reframing.

## What "snappy" means, in measured terms

These are measured on 23 videos with speech: 22 Shorts and 1 long-form. They are estimates from caption timing, which cannot see cut frames or gaps under about 0.2 s.

- **Speech starts immediately.** The first word comes at a median of 0.04 s. 22 of 23 videos speak within 0.25 s, all 23 within 0.4 s. There is no logo, greeting or title-first open in any of them.
- **The first 3 seconds are dense.** A median of 10 words is spoken in the first 3 s (IQR 7 to 12), about 200 words per minute from frame one.
- **The words-per-minute rate is far above conversational speech.** The effective rate has a median of 210 wpm (IQR 183 to 220, maximum 246 in a Mrwhosetheboss Short), against roughly 150 wpm that is usually quoted for conversation. That figure is a general reference, not measured here. While talking, speakers run at a median of 4.9 syllables per second.
- **Very little non-speech survives, and it depends on whether the speech was scripted:**

| Class | Videos | Est. pause share | Mean retained gap per caption line | 90th-percentile retained gap | Who |
|---|---|---|---|---|---|
| tight | 13 | median 3% (IQR 2 to 5%) | 0.06 s | 0.26 s | Zack D. Films, Kurzgesagt, Mrwhosetheboss, Humphrey Yang, Codie Sanchez (1), Nick DiGiovanni (1) |
| moderate | 6 | median 11% | 0.21 s | 0.62 s | Hormozi (2), Codie Sanchez (2), Nick DiGiovanni (1), Veritasium (long-form) |
| natural | 4 | median 26% | 0.55 s | 1.30 s | Hormozi call-in Q&A; cooking reaction/action Shorts |

  Scripted narration runs almost seamless: 0 to 7%, with Zack D. Films at 0 to 2%. Unscripted business talking-head keeps 6 to 22%, highest in caller Q&A where the question itself is the hook. Cooking and reaction formats keep the most, because action carries the beat between lines.
- **What a target looks like for Cutalong's tighten.** For talking-head Shorts, aim for a retained gap of about 0.05 to 0.15 s at phrase joins, with no unplanned gap over about 0.3 s. That corresponds to a pause share of 3 to 8%. Long-form and conversational clips can keep 10 to 15%. The current defaults pad 0.08 s before and 0.12 s after each beat, so a joint keeps up to 0.20 s. That sits at the loose end of "tight" and suits moderate edits. For a snappy preset, padIn of about 0.05 to 0.06 s and padOut of about 0.08 to 0.10 s match the measured joints better. This is an inference, to be confirmed with real cut frames (see the last section).
- **Whether cuts land before word onsets, and whether breaths are removed, could not be measured** (no audio or frames). Reported:
  - Cuts fall on pauses in the voice, so picture and sentence move together (Viibeo, 54 Shorts).
  - Trims land between beats, never inside sentences (PandaStudio, 22 videos).
  - Speaker switches land exactly on turn changes (DOAC teardown).
  - Kinetic text finishes its move on the stressed syllable, starting 8 frames early (CraftingUI).
  - Breaths are removed or reduced in Hormozi-style audio (EditorDuel).
- **"Snappy" is not "every second".** Reported frame counts put the median viral Short at a 4.7 s shot, the fastest quarter at 2.8 s, and the first visual change at about 1.9 s (Viibeo). Hormozi cuts every 3.5 to 5.6 s, but on idea boundaries and with alternating crops and drift zooms, so nothing is ever still (PandaStudio). MKBHD runs 7.4 cuts per minute (PandaStudio). MrBeast dropped from 38 to 23 cuts per minute mid-video between 2023 and 2024 (Tubefilter). The snap comes from removing dead air plus a steady clock of visible changes, not from cut count alone.

Other measured signals:
- **[Music]-only stretches** appear in 8 of 25 videos, for example a musical sting right after the hook line in Hormozi's "You Need to Build the Right Foundation" at 0:05.
- **Fillers** survive in the captions of 3 videos. This is a floor, because the caption system drops most fillers.
- **Laughter** is tagged in 1 video.
- **Two Shorts are carried by music or picture with almost no speech:** Max the Meat Guy's "Jumbo Chili Cheese Dog" (329M views, 3 words) and a Kurzgesagt Short with no captions.

## The top 25 skills

Ranked by priority. Each entry gives `[evidence level, confidence]` and the wave; full parameters, detection, rendering and acceptance tests are in `skills-catalog.json`.

1. **Cold open on the first claim** (`cold-open-hook`) [measured, high] wave 1. Strike everything before the first sentence that makes a claim, asks a question, gives a number or makes a promise. Speech should start by 0.25 s with captions from frame one. It holds in 23 of 23 measured videos and in both published frame studies (all 13 Shorts reach speech within 2.5 s; long-form gives its thesis within 10 s). It is the cheapest high-impact rule available, built from existing strike and remove ops plus a hook finder in the planner.

2. **Hard stop after the payoff** (`end-on-payoff`) [reported, medium] wave 1. No outro, no "follow for more", no fade. Cut within a beat of the last payoff word, or on a 1.5 to 2 s card restating the title. None of 22 measured top videos had an outro (PandaStudio). It ranks high because it is trivial, not because it is the strongest lever.

3. **Alternating punch-in crops on beat boundaries** (`alternating-punch-in`) [reported, medium] wave 1. Toggle between wide (1.0) and tight (about 1.15 to 1.5x) framing at each idea boundary, anchored on the face, so one camera reads as coverage. Reported in all 3 Hormozi Shorts studied, in DOAC monologues every 5 to 6 s, and in sermon-clip guides. The renderer already crops per beat; what is needed is an alternation preset and face anchoring.

4. **Word-timed captions with one emphasis rule** (`active-word-captions`) [reported, high] wave 1. Burned captions in every Short:
   - 1 to 4 words per screen (median 3), a new group every 0.8 to 1.0 s.
   - High contrast, in a band 48 to 66% down the frame.
   - Exactly one emphasis mechanism per video (weight, or colour, or a box) on the operative word.
   - An optional active-word pop or karaoke fill, and per-speaker colours.

   This is reported consistently: all 13 measured Shorts, the Hormozi and DOAC specs, and church guides that call captions mandatory and keep them to one line of 22 characters or fewer. Because the renderer already burns an ASS file through libass, pops (`\t` scale transforms), karaoke (`\k`) and per-word weight or colour are pure ffmpeg work.

5. **Keep the texture** (`keep-texture-policy`) [measured (weak), low] wave 1. By default, talking-head edits remove dead air but keep ums, laughs and room sound, and keep long pauses on emotional material. Fillers are stripped only for scripted pieces. Reported for every measured talking-head video and for DOAC's grief clip. This is a planner default on the existing `fillers` flag.

6. **Snappy pause and breath removal** (`tight-pause-trim`) [measured, medium] wave 1. Turn tighten into a target-driven skill:
   - a pause-share target per format (about 5% for Shorts, about 12% for long-form);
   - a retained-gap target (about 0.12 s for Shorts);
   - 10 to 20 ms crossfades at every audio join;
   - breaths cut or ducked;
   - cuts only between beats.

   Measured: 19 of 23 videos are tight or moderate.

7. **Zoning and safe areas** (`caption-zoning`) [reported, medium] wave 1 (needs face detection). Reserve the caption band for the whole video, keep graphics in the top ~40%, never cover a face, never stack two text elements in one zone, and stay out of the platform UI. This held in all 22 videos of one study.

8. **Pattern-interrupt clock** (`static-stretch-guard`) [reported, high] wave 1. A planner and QA rule:
   - In Shorts, something visible changes every 3 to 8 s (aim for about 5), and the first change comes by 2 s.
   - In long-form, the layout flips every 20 to 40 s.
   - Fill any gap with the cheapest change available: a punch-in, a keyword pop, a cutaway.

   Three independent frame counts agree. Cutalong's reference measurement already reports cuts and pace, so it can check this.

9. **Look presets** (`look-presets`) [reported, low] wave 1. Saturated, high-contrast looks for entertainment; a LUT on sermon clips "so they don't look flat in the feed"; black and white for emotional beats (this already exists); grain and vignette for documentary tone. Uses ffmpeg `lut3d`, `eq`, `noise` and `vignette`.

10. **Hook banner and end card** (`title-banner`) [reported, low] wave 1. A banner naming the payoff from 0:00 that exits by about 5.5 s (DOAC: white box, black caps), plus an optional 1.5 to 2 s end card. Uses drawbox and drawtext, or ASS.

11. **Keyword pops instead of subtitles in long-form** (`keyword-pops`) [reported, medium] wave 1. Top long-form channels burned no subtitles in 0 of 502 classified frames (PandaStudio). Instead they pop 1 to 4 load-bearing words, timed to finish on the stressed syllable, and use 2 to 4 quote cards per video. This extends the existing big word to multiple pops with styles, and turns full captions off by default for long-form.

12. **Find the clip** (`clip-finder`) [reported, medium] wave 1 (needs segment scoring). From sermons, podcasts and streams, pick 30 to 90 s segments with one idea, a hook in the first 3 s, and the payoff at 55 to 85% of the clip. Reported for all 13 measured Shorts and for DOAC (payoffs at 55, 62 and 69%). This matters most for the church audience: sermon guides say one clip, one idea, 30 to 60 s.

13. **Voice polish** (`voice-polish`) [reported, low] wave 1. High-pass, denoise, compression, de-ess and breath reduction before the existing −14 LUFS pass. Uses ffmpeg `afftdn` or `arnndn`, `acompressor` and `deesser`.

14. **Music bed with ducking** (`music-bed-ducking`) [measured, medium] wave 1. Measured: [Music]-only stretches in 8 of 25 videos. Reported:
   - Sermon clips use a bed (about −18 to −24 LUFS is suggested).
   - Hormozi listicles carry a faint bed.
   - DOAC clips are dry.

   Uses `sidechaincompress` keyed on the voice, then loudnorm. Default to dry for podcasts and emotional clips.

15. **Face-tracked vertical reframing** (`vertical-reframe`) [reported, medium] wave 1 (needs face tracking). 16:9 sermon, podcast and stream footage to 9:16 with a smoothed crop path that follows the speaker. It is a standard step in sermon workflows. An `aspect` op exists; whether it tracks the subject needs checking.

16. **Sound effects on accents** (`sfx-accents`) [reported, low] wave 1. Whooshes on zooms and transitions, pops on text, risers before reveals, impacts on cuts. Density is a style dial:
   - nearly every cut (MrBeast);
   - sparse (modern Hormozi);
   - none (DOAC).

   Uses `adelay` and `amix` from a licensed sample set. This run could not count SFX, because captions don't tag them.

17. **Pull the payoff forward** (`hook-pull-forward`) [reported, low] wave 1. Copy the strongest line to 0:00 as a teaser, optionally muting the operative words behind a card until the payoff (DOAC's "redacted" hook), or open on the most extreme moment and rewind (MrBeast). Needs a new mute-span op; otherwise uses `move`, `insert` and a card.

18. **B-roll matched to the words** (`broll-matcher`) [reported, medium] wave 1. Short literal cutaways of 1.5 to 4 s, placed where something concrete is named. The share varies by style:

| Style | B-roll share |
|---|---|
| Modern Hormozi | 0% |
| DOAC | 0 to 6.5% of runtime |
| MKBHD | 43% of frames |

   Rendering already exists; the work is noun matching, sourcing and licences.

19. **Ken Burns on stills** (`ken-burns-stills`) [reported, low] wave 1. Slow pan and zoom across photos and documents. Photo pans and collages make up 40 of 212 indexed explainer motion-graphics moments (Artiphik). Uses `zoompan` on the image.

20. **Drift zoom over holds** (`drift-zoom`) [reported, low] wave 1. A slow push of a few percent across any beat over about 8 s, so nothing is static (Hormozi holds a 15 s listening shot this way). Uses `crop` with time expressions.

21. **Listicle counter and progress bar** (`list-counter`) [reported, low] wave 1. A numbered pill that increments as each item is spoken, with an optional thin progress bar. Uses drawtext and drawbox with enable windows.

22. **Lower thirds and spec cards** (`lower-thirds`) [reported, low] wave 1, polished in wave 2. Name tags for podcasts and sermons, spec and credit cards for reviews. Measured product-film moves give the timing: position moves median 218 ms, fades about 100 ms, and exits faster than entrances. Use ASS `\move`/`\fad` now and eased curves in the compositor later.

23. **Screen-recording zoom-pans** (`screen-zoom`) [reported, low] wave 1. Eased zooms into the part of a capture being discussed: about 1 s moves in Shorts and 1.5 to 2.5 s in long-form, optionally following the cursor. Uses `crop` and `scale` with eased keyframes through sendcmd.

24. **Camera follows the voice** (`speaker-follow`) [reported, medium] wave 1 (needs diarization). For podcasts and Q&A:
   - Switch to the active speaker at each turn: 7 switches in 115.6 s in one DOAC clip.
   - Show the listener only in 1 to 1.5 s reaction cutaways.
   - Colour captions per speaker (host yellow, guest white).

   Rendered with per-speaker crops; the work is in diarization and face tracks.

25. **Cut to the music beat** (`beat-synced-montage`) [reported, low] wave 1 (needs beat tracking). Land cuts, punch zooms and impacts on downbeats in montage, food, travel and highlight sequences. Reported in gaming-montage guides; this run saw 2 music-carried Shorts.

Ranks 26 to 36 are in the catalog:
- animated callouts: the first compositor skill, with draw-on strokes of 160 to 200 ms;
- J/L cuts;
- the transitions kit (hard cuts stay the default);
- split screen, picture-in-picture and cutout;
- kinetic typography: lines that build word by word, with a highlight sweep;
- emoji and stickers;
- speed ramps;
- maps and charts;
- 2.5D parallax;
- matte reveals and 3D;
- motion tracking.

The "After Effects-level" items rank low here because of their cost and because their reported prevalence is concentrated in explainer and documentary long-form, not because they don't matter. Typography is 26% of indexed explainer motion-graphics moments (56 of 212), and infographics and charts a further 53% (113 of 212).

## How niches differ

**Measured in this run** (small samples):

| Niche | Videos with speech | Effective wpm | Est. pause share | Notes |
|---|---|---|---|---|
| Education explainers (Zack D. Films, Kurzgesagt) | 4 | 190 | 1% | Scripted narration, near-seamless; one Kurzgesagt Short had no speech captions at all |
| Personal finance (Humphrey Yang) | 3 | 210 | 2% | Scripted to camera; numbers lead every hook |
| Tech reviews (Mrwhosetheboss) | 4 | 219 | 4% | The "$X vs $Y" title spoken as the first line; fastest delivery in the sample (up to 246 wpm) |
| Business (Hormozi, Codie Sanchez) | 6 | 213 | 11% | Unscripted talking head keeps rhythm pauses; call-in Q&A keeps the caller's long question (22%) |
| Cooking (Nick DiGiovanni, Max the Meat Guy) | 5 | 183 | 25% | Action carries the beat between lines; day-counter narration ("Day 1 ... Day 60"); one music-only Short |
| Science long-form (Veritasium) | 1 | 161 | 14% | Music-only stretches in the intro (0:09, 0:21); first word at 0.16 s |

**Reported, for niches this run could not measure:**
- **Podcast clips (DOAC):** dry audio (no music or SFX, laughter kept), per-speaker caption colours, a title banner gone by 5.5 s, cuts every 4.1 to 6.3 s through speaker switches, almost no B-roll.
- **Church and sermon clips:** captions mandatory (single line, Montserrat Black, accent colour on key words), a music bed under the preacher, punch-ins on key lines, stock B-roll on non-essential stretches, a LUT, 30 to 60 s, one idea per clip.
- **Gaming highlights:** beat markers, zoom punches, 2 to 3-frame shakes, a white flash on the drop, slow-motion zooms (25 to 50% speed, 110 to 130% scale), meme sound effects.
- **Entertainment (MrBeast):** 23 to 38 cuts per minute mid-video, an impact or whoosh on nearly every cut, a saturated grade, Komika Axis captions on Shorts, a cold open on the most extreme moment.
- **Tech long-form (MKBHD):** 7.4 cuts per minute, 48% talking head and 43% B-roll, no burned captions, spec cards, one 32 to 55 s verdict hold at 72 to 92% of runtime.
- **Explainers and essays (Vox, Johnny Harris, Cleo Abram):** kinetic type on stressed syllables, highlight sweeps, zooming annotated maps, charts that grow when the number is spoken, paper textures with 2.5D parallax, often animated at 12 fps for a hand-made feel.

**No data at all** (neither measured nor reported in enough detail): fitness (7 queued), vlog and lifestyle, travel, beauty, comedy and sketch, true crime and documentary, sports highlights. Treat any claim about these as an estimate.

## Recommended build order

Waves follow the rule in the brief:
- **Wave 1** only needs the ffmpeg renderer, extending its filter graph and ASS file, with no compositor.
- **Wave 2** needs the planned WebGL compositor.
- **Wave 3** is the rest: lower-prevalence items and ones that need a heavy new subsystem.

**Wave 1: ffmpeg renderer**

- **1a, rules and filters on top of existing ops:**
  - cold-open-hook
  - end-on-payoff
  - keep-texture-policy
  - alternating-punch-in
  - tight-pause-trim (targets, crossfaded joins, breaths)
  - active-word-captions (ASS pop, karaoke, emphasis, speaker colours)
  - static-stretch-guard
  - title-banner
  - keyword-pops
  - look-presets
  - voice-polish
  - music-bed-ducking
  - sfx-accents
  - hook-pull-forward (new mute-span op)
  - broll-matcher
  - ken-burns-stills
  - drift-zoom
  - list-counter
  - lower-thirds (ASS)
- **1b, still ffmpeg to render but each needs a new analysis component:**
  - caption-zoning (face boxes)
  - vertical-reframe (face tracking)
  - clip-finder (segment scoring)
  - screen-zoom (target regions)
  - speaker-follow (diarization)
  - beat-synced-montage (beat tracking and a licensed music library)
- **Edit-document additions this implies:** per-format tighten targets and breath mode; caption animation, emphasis and speaker-colour fields; a drift amount per beat; mute spans; music and SFX tracks with ducking; overlay elements (banner, counter, lower third); a grade/LUT setting; crop paths.

**Wave 2: compositor**
- kinetic-typography
- annotation-callouts
- split-pip-cutout (person matte)
- the polished versions of wave-1 graphics: eased custom-curve lower thirds, springy sticker pops, highlight sweeps

**Wave 3: the rest**
- j-l-cuts (separate audio and video in/out per beat)
- transitions-kit (beyond hard cuts)
- emoji-sticker-meme
- speed-ramp
- maps-charts
- parallax-2-5d
- masks-reveals-3d
- motion-tracking

Before building past wave 1a, run the batch measurement below on 150+ videos to replace "reported" with "measured" for captions, cut rate, B-roll share and SFX. Several orderings could change, notably sfx-accents, broll-matcher and transitions-kit.

## Scaling to hundreds of videos on the owner's computer

YouTube is not blocked there, and Cutalong already has the measuring parts:
- `src/main/inspiration/measure.ts`:
  - `measureVideo()` probes the file, finds cuts from ffmpeg's scene score on a 320 px copy, samples colour with signalstats for the black-and-white share, and measures loudness with ebur128.
  - `contactSheet()` tiles frames for a model to read.
- `src/main/transcribe.ts`: whisper `base.en`, `small.en` or `medium.en`.
- `src/main/whisper-parse.ts`: `tokensToWords()` gives word timings.

A batch script (a Node/TypeScript runner that imports those modules) would work like this.

**Input:** `queue.csv` with url, niche and format. Start with the 19 queued here and the 25 measured here (to calibrate against this run), then add about 150 more found with NexLev search, which still works on the free plan. Aim for at least 10 videos per niche across all 17 niches.

**For each video:**
1. **Fetch small.** Shorts:

   `yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" -o tmp/%(id)s.%(ext)s URL`

   Long-form, adding `--download-sections "*0-180"` (or a hook window plus one mid-video window):

   `yt-dlp -f "bv*[height<=480]+ba/b[height<=480]" --download-sections "*0-180" -o tmp/%(id)s.%(ext)s URL`

   Use the owner's own cookies only if they choose to, as the project's youtube-download skill allows, and keep to YouTube's terms.
2. **Measure the picture.** `measureVideo(path, { ffmpeg, maxSec: 600 })` gives cuts, bwShare and loudnessLufs. Derive cuts per minute, median shot length, time to first cut, and the longest static stretch.
3. **Measure the words.** `transcribe()` with `small.en`, then `tokensToWords()`. Compute speech rate, pause share and the retained-gap distribution exactly, with no caption-line estimate.
4. **Answer the snappy question.** For every cut that falls inside speech:
   - `leadMs = nextWord.start − cutTime` (snappy if 0 to 120 ms);
   - `gapAtCut = nextWord.start − prevWord.end`;
   - check whether the cut lands inside a word.

   Run `silencedetect=n=-35dB:d=0.08` on the audio for the gap distribution. Flag breaths as 150 to 500 ms low-level noise bursts in gaps.
5. **Look at what numbers can't show.** `contactSheet()` at each cut ±0.2 s and at 2 fps through the first 6 s. A vision model then labels:
   - captions: words per screen, band, case, emphasis;
   - transitions;
   - zooms;
   - graphics and B-roll layout.

   A second pass at 0.1 s spacing around three text events times the caption animation.
6. **Listen for what words can't show.** Run an onset detector on the audio residual after removing speech (or around cut and zoom times) to count SFX and estimate music-bed level under the voice.
7. **Record, then delete.** Append one line in the `observations.jsonl` schema, with measured fields (`cutTimes`, `medianGapAtCutsSec`, `leadBeforeOnsetMs`, `lufs`, `bwShare`). Then delete the media file at once, in a `finally` block, so a crash never leaves footage behind. Space downloads out with backoff. Keep no frames beyond the contact sheets the model reads, and delete those too.

**Cost and time (estimate):**
- A 480p Short is roughly 3 to 6 MB; a 3-minute long-form section roughly 15 to 25 MB.
- Measuring takes tens of seconds per video.
- Whisper `small.en` runs at about real time to a few times real time on a CPU.

At those rates 200 videos is an overnight run, and only one video is ever on disk at a time. Feed the output into the same ranking (`priority = 10 × share × impact ÷ effort`) to update `skills-catalog.json`, switching each skill's evidence level to measured or observed as the data arrives.

## Sources (reported evidence)

- PandaStudio, 22-video retention study: https://www.writepanda.ai/blog/retention-editing-7-laws/
- PandaStudio, Hormozi teardown: https://www.writepanda.ai/blog/hormozi-style-shorts-editing/
- PandaStudio, DOAC teardown: https://www.writepanda.ai/blog/how-diary-of-a-ceo-edits-podcast-clips/
- PandaStudio, MKBHD measured: https://www.writepanda.ai/blog/mkbhd-editing-style-measured/
- PandaStudio, AI-editing defaults: https://www.writepanda.ai/blog/edit-videos-with-ai-agents/
- Viibeo, 54 viral Shorts pacing study: https://www.viibeo.com/research/viral-shorts-pacing
- Viibeo, renderer notes: https://www.viibeo.com/blog/how-an-ai-video-maker-turns-prompts-into-videos
- SNAPlab, TikTok average shot length: https://snaplab.blog/2025/03/03/is-tiktok-really-as-fast-as-we-think/
- Tubefilter, MrBeast cut counts: https://www.tubefilter.com/2024/03/04/mrbeast-editing-style-number-of-cuts-per-video/
- Shorty, MrBeast style: https://shortyedit.com/edit-like/mrbeast
- EditorDuel, Hormozi playbook: https://blog.editorduel.com/blog/alex-hormozi-retention-first-editing-playbook
- STEALSHOT, DOAC long-form: https://stealshot.com/brand/thediaryofaceo
- Church Media Training, sermon clips: https://www.churchmediatraining.com/blog/social-media-sermon-clips-premiere-pro-editing-walkthrough
- ReachRight, sermon clips: https://reachrightstudios.com/blog/sermon-clips-for-social-media/
- believers.site, sermon repurposing: https://believers.site/repurposing-broadcast-strategies-for-youtube-shorts-a-bbc-in
- DOR, gaming montage: https://clip.dor.gg/en/blog/how-to-make-gaming-montage
- Mark Studios, gaming montage: https://www.markstudios.com/blog/how-to-make-a-gaming-montage
- Adobe Video World, gaming editing: https://adobevideoworld.com/gaming-video-editing/
- CraftingUI, word-by-word on the voice-over: https://craftingui.com/motion/entries/word-by-word-on-the-vo
- Easy-Peasy, Vox-style guide: https://easy-peasy.ai/blog/how-to-make-vox-style-videos-with-ai
- Artiphik, 212 indexed motion-graphics moments: https://artiphik.com/tools/motion-graphics-examples
- TikTok content analysis, 100 videos: https://doaj.org/article/df32fa5a653f4343acc4f714bc684108
- Raylight motion reference library: shots 21233b523c33/1-3, f3c523c84569/1 and f41065d6467c/2, product films measured frame by frame. Position moves median 218 ms (IQR 117 to 480), scale moves 360 ms (mostly 1 to 8% drifts), fades 100 ms, path draw-ons 160 to 200 ms, typewriter stagger 32 to 57 ms per character, nearly all on custom cubic-bezier curves.
- What creators want automated:
  - vidIQ poll: of 31,000+ people, 71% would pick a video editor over a scriptwriter or thumbnail designer. https://vidiq.com/blog/post/ai-tools-edit-youtube-videos/
  - Adobe Express survey (n=384, December 2025): editing tops AI use at 58%, then transitions and effects 42%, music selection 37%; the most-wanted features are auto-repurposing (19%) and instant platform-specific edits (14%). https://www.adobe.com/express/learn/blog/ai-video-tools

## Appendix: queued videos (metadata only, not yet measured)

These were picked and registered but their transcripts hit the daily cap. Use them as the first rows of the batch run's `queue.csv` (Shorts: `https://www.youtube.com/shorts/<id>`).

- **cooking**: `tQWg27P9zM4` This Tuna Tastes Like Steak (Max the Meat Guy, 77.0M views); `ajDa3jQjO6U` 100 Layer Beef Monster (Max the Meat Guy, 68.0M views)
- **education-explainer**: `RzwaiFvyN6s` How do Lasers Work? (Kurzgesagt, 12.0M views); `xP2tHAXjZhI` How many organs can YOU live without? Turns out: More than we thought. (Kurzgesagt, 6.7M views)
- **fitness**: `Z9mlsyV7Hek` Creatine: Everything You Need To Know (Jeff Nippard, 31.0M views); `bvwg4D9UWGI` Best Push Workout (Chest, Shoulders & Triceps) (Jeff Nippard, 17.0M views); `KBPBBMgkp1s` I Lost Muscle (Jeff Nippard, 19.0M views); `PjBdgLNxud0` I Watched Every Sam Sulek Video (A Scientific Analysis) (Jeff Nippard, 37.0M views); `mX2X5L-S_fI` The Dangers Of Steroids (Will Tennyson, 11.0M views); `tjy1hdUxI-U` The hardest workout machine you'll ever try (Will Tennyson, 19.0M views); `UPLGWppyd9E` Science Lifter vs Regular Lifter (Who's Stronger?) (Will Tennyson, 5.6M views)
- **personal-finance**: `Q-GvKMi6olo` Selling my Diet Coke Silver Bar (Humphrey Yang, 1.7M views); `sSe6irl_4mA` How Much Money I Spent On My Wedding (Graham Stephan, 2.7M views); `xBSchTg1tEM` How My Assistant Turned $10,000 into MILLIONS (Graham Stephan, 1.4M views); `HdoLUIPLlDo` Why Graham Stephan QUIT Real Estate Investing (unverified (Graham Stephan clip), 5.8M views); `2bdiHB-7oTE` The Worst Investment Of Graham Stephan's Career (unverified (Graham Stephan clip), 1.5M views)
- **tech-review**: `rBmcemHrqB4` USB Colors Actually Matter! (Linus Tech Tips, 2.3M views); `zH9bqwNShiM` What's the Worst Tech Linus Still Uses? (Linus Tech Tips, 2.4M views); `1lNq0QY9vD4` The Last Tech Tip You'll need (Linus Tech Tips, 3.4M views)
