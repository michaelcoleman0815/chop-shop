# Raw footage: what comes in, and how a good editor cuts it

## Read this first

This is the study behind Cutalong's handling of raw recordings: takes, transcription, intake and sessions, and a cutting profile per niche. It was written before any of that was built.

**What it rests on.**

- **No raw footage was available**, and YouTube downloads are blocked from this machine. Nothing here was watched. NexLev and VidIQ were not used.
- **Published sources**, found with Exa search: editors' guides, tool documentation, papers, GitHub issues with experiments, and manufacturer pages. Each is cited inline and listed at the end.
- **Measurements made here**, on material this run made itself:
  - **A Whisper lab.** An 85 s talking-head "session" was synthesised with espeak-ng, with retakes planted in the patterns the owner described: whole lines said again, backing up a few words mid-sentence after a cut-off word, many takes of one line, a reworded take, a groan and a laugh breaking takes off, the intro redone at the end, meant repetition, fillers and a stutter. It was transcribed with Whisper **small** (an int8 CTranslate2 conversion found on npm, not the `small.en` ggml model Cutalong downloads, which huggingface.co blocks here) through faster-whisper 1.1.1, with settings that mirror whisper.cpp's: beam 5, best of 5, word timestamps, and the prompt and context options described in section 2. Ground truth is the splice log.
  - **whisper.cpp v1.8.2 itself**, the version `scripts/build-whisper.sh` builds, read in source for what each flag really does.
  - **The ffmpeg Cutalong ships**: the ffmpeg-static b6.1.1 macOS binaries (arm64 and x64), inspected for their build options and filters.
  - **ffmpeg-made fixtures** for variable frame rate, rotation and HDR tags, probed with ffmpeg 6.1.1.

**The owner's own retakes** (from the owner, through the coordinator): no spoken cue and no clap. When a line goes wrong they say the whole line again, or back up a few words and carry on mid-sentence. Anything from one to many takes per line. They make tech videos.

**Evidence labels**, as in `editing-skills.md`:

- **measured**: computed or checked by this run, on the fixtures and binaries above or in the whisper.cpp source. Synthetic speech is cleaner than a person, so lab numbers are a floor on how often Whisper goes wrong, not a rate.
- **reported**: from a cited source, not checked here.
- **estimate**: judgement, with no measurement behind it.

**Verbatim accuracy on real speech has to be measured on the owner's Mac**, with the real model and the owner's own footage. Nothing here can stand in for that.

## The findings that matter most

1. **Whisper can hide a retake inside one word.** When a line is said again straight away, Whisper may write it once and stretch one word over the pause and the second take. On a real 25-minute talking-head recording, 17 of the 22 cuts an editor still had to make by hand after a silence pass were this (davinci-resolve-mcp issue 125) [reported]. In the lab it happened in 3 of 6 runs with Cutalong's current settings, and not in the others: one word, "graphics", was given 4.8 s at a probability as low as 0.06, and a whole broken-off take vanished into it. Twice more, a whole 30-second window came back empty and 7 of 14 takes were gone [measured]. The tell is a word far longer than a word can be, usually with a low probability. Nothing downstream can see a retake the transcript does not contain, so this is checked and re-transcribed before takes are looked for.
2. **A prompt written in the verbatim style changes what Whisper writes down.** Without one, the cut-off "three ye—" was written as "3 years." and the restart as "For 3 years now", so the broken word looked whole [measured]. With a prompt that contains fillers and a false start, it wrote "three ye -  for three years now", keeping the fragment. OpenAI's own guide says the model may leave out filler words unless the prompt contains them [reported]. Papers measure Whisper keeping 41% of fillers and 63% of repetitions in spontaneous speech [reported].
3. **Two whisper.cpp flags do not do what their names suggest.** In v1.8.2, `-mc 0` drops every prompt, the initial prompt included, so "no context" and "a verbatim prompt" cannot be had together that way; `--carry-initial-prompt` with a small `-mc` gives a prompt on every window and no rolling context. And `--dtw` is silently disabled because whisper-cli turns flash attention on by default, which is why an earlier measurement here found DTW "changed no timing at all"; it needs `-nfa` [measured, in source].
4. **Retakes can be told from meant repetition by timing and sound.** A retake comes after a break: a word cut off, a pause, a breath or a drop in loudness, then words the speaker already said. Meant repetition ("never, never", "again and again") flows with no break [reported by editors and tool makers; the exact thresholds are an estimate]. When unsure, editors and the better tools keep both takes: a missed cut costs one click, a wrong cut costs a sentence (Cutora) [reported].
5. **On a tie, the later take usually wins, but not mechanically.** Editors pick the complete take first, then the one that says it right, then the best delivery; people repeat a line until they have it (Clipteach, ChatCut) [reported]. Descript's Remove Retakes keeps "the last good one" [reported]. Tools that act confidently are the ones creators complain about: Gling "will cut takes you meant to keep", Descript's Underlord "occasionally cuts a 'retake' that was actually a deliberate repetition" [reported].
6. **The shipped ffmpeg can do every conversion this needs.** Both macOS builds of ffmpeg-static b6.1.1 are configured with `--enable-libzimg` and contain `zscale`, `tonemap`, `lut3d`, `colorspace`, `vfrdet`, `blurdetect`, `freezedetect`, `axcorrelate`, `ebur128`, `astats` and `silencedetect` [measured]. A widely used Homebrew build has no zimg [reported], so the fallback still matters on a different ffmpeg.
7. **Two intake facts are wrong today.** `probe()` reads the stored size, so a portrait phone clip with a rotation matrix is treated as landscape [measured on a fixture]. And it reads `avg_frame_rate`, so a phone clip that dropped frames in low light (nominal 30, average 22.5 in the fixture) would be exported at 24 fps by `frameRate()` [measured].

## 1. How editors cut raw talking-head footage

### The passes

- **Log, group, pick, order, cut, level.** An editor watches everything once and marks what is not content (the countdown, "ok, again", the take dropped after three words), groups every line said more than once "even when the retake only redid the end of the sentence", picks one take per line, puts the lines in the script's order "whatever order they were filmed in", then cuts clean with "every cut in a pause" (Clipteach) [reported].
- **Selects, assembly, rough cut, fine cut**, each a separate pass, because each one's decisions are only makeable once the one before is settled (Addaly) [reported]. A stringout of every take in order shows what is missing and what sags.
- **The radio edit first.** For dialogue, build the conversation as sound, ignoring the picture: "Cut out the false starts, the repeated question, the interruption, the long pause where somebody thinks, the 'sorry, can I say that again'... If it does not hold as sound, no picture will fix it" (Addaly) [reported].
- **How much goes.** A tech creator working from an outline: 33 minutes of A-roll became a 12-minute video (Stephen Robles) [reported]. A reviewer who speaks from bullet points cuts "about a quarter" (Curtis Judd) [reported]. An hour of talking-head material for ten minutes of video is cited as typical (Sparki) [reported].

### Choosing a take

- **Complete first, then right, then delivery.** "Pick one take per line: the complete one first, then the one that says it right, then the best delivery with the eyes on the lens. On a tie, the later take usually wins: people repeat a line until they feel they have it" (Clipteach) [reported].
- **Later, but not mechanically.** "If several attempts are complete, usually prefer the later one... But do not choose the last attempt mechanically. If the later attempt is missing needed context... keep the more complete version" (ChatCut's talking-head guide) [reported].
- **Descript's default** is the same: Remove Retakes "detects repeated attempts at the same line and keeps the last good one", and Descript's own sample prompt says "use the last complete take in most cases" [reported].
- **What "best" means** splits into accuracy, clarity, performance and continuity, and the normal case is that takes differ on each (ReadyForm) [reported]. One tool scores completeness, fluency, pace close to the other takes, recognition clarity and loudness, and "if we're not sure two takes are the same line, we keep both... Takes that say different things are never treated as repeats, even if they start the same way" (Cutora) [reported].
- **Never stitch fragments.** "Do not combine incomplete pieces from different attempts into one artificial sentence", but keep a useful lead-in from an earlier attempt when the kept take does not repeat it (ChatCut) [reported].
- **Takes from a stretch out of order.** A line redone later (the whole intro, at the end of the session) belongs where the line goes, not where it was filmed (Clipteach) [reported].

### False starts, restarts and stutters

- **A false start**: keep one complete attempt; "cut from just before the first try to just before the second, ideally at a stop consonant" (Pierson) [reported].
- **A restart mid-sentence** is the owner's usual pattern: "I've been using this for three yea— for three years now", "So the best camera for— the best camera for beginners is...". The abandoned fragment runs from where the repeated words first start to the restart, including any "uh" or silence; everything said before the repeated words stays ("So" stays when the restart does not repeat it) [the owner, via the coordinator]. The cut-off word may arrive partial or be missing altogether [measured: Whisper completed it without a verbatim prompt].
- **Stutters** ("the the the screen"): Whisper drops many repetitions on its own (finding 2). A repeated function word with no pause is a stutter; a repeated content word with a comma is usually emphasis [estimate].
- **Spoken retake cues** exist ("okay, again", "let me say that again", "one more time", "from the top", "cut", "wait"), and the later take is the one to keep (Tastebud, Clipteach) [reported]. The owner uses none, so cues raise confidence but are never needed.

### Where to cut

- **In a pause or a breath.** "A cut inside a phrase produces a small click of wrongness even when the words are grammatical. A cut at a breath is inaudible. Put the breath at the head of the incoming clip, not the tail of the outgoing one" (Addaly) [reported].
- **Keep the first breath, drop the later one**: the earlier breath belongs to the speaker's cadence at that moment (Transom) [reported]. Include the breath before a sentence starts; we notice when breaths are missing (Larry Jordan) [reported].
- **Just before a stop consonant** (P, B, T, D, K, G), whose closure is a split second of silence; never inside a vowel, M, N or S (Pierson) [reported]. Cut about 2 frames before the transient of the incoming word for the same speaker (Kook & Hoomen) [reported]. Cutalong's word snapping already places edges 10 ms before an onset and 30 ms after a decay.
- **Gaps between sentences** of about a third of a second sound natural, and a comma about half that (Larry Jordan) [reported]. Measured snappy Shorts keep 0.05 to 0.15 s at joins (`editing-skills.md`) [measured there].

### Which pauses to keep

- **Function, not volume.** "Dead air is not a pause: dead air is a gap with no function, while a pause is often where emphasis lands or the next thought forms"; micro-pauses before a key point stay (Sparki) [reported].
- **Emotional material keeps its pauses**; DOAC's grief clip is the example in `editing-skills.md` [reported there].
- **Comedy is the exception that proves it**: "The only reason to pause is when the joke demands the pause" (Roger Nygard, quoting Jeff Schaffer) [reported].
- **Over-cleaning** makes "a person who apparently does not breathe": remove the tics that obstruct, leave the ones that are thinking (Addaly) [reported].

### Hiding jump cuts

In order of preference: a cutaway; a punch-in to about 110 to 120%, alternating wide and tight rather than punching in twice in a row; a speed ramp or dissolve; or leaving the jump cut, which talking-head viewers accept as honest compression (Addaly, Woven) [reported]. A room-tone bed under the whole scene hides the joins in sound (Addaly) [reported].

## 2. Transcription realities

### Does Whisper keep what was actually said?

Mostly not, and how much it drops depends on the model and the moment.

- **Fillers.** In spontaneous non-native English, Whisper detected 64 of 157 fillers (0.41), the fewest of five systems; Speechmatics found 0.84 and RevAI 0.97 (arXiv 2503.06924) [reported]. On web speech, base Whisper large-v3 recovered fillers with an F1 of 0.117, and a model fine-tuned on 4.5 hours of verbatim transcripts reached 0.819 (Keeping the Ums, 2026) [reported]. In psychiatric interviews filled pauses were the most frequently omitted words (ICNLSP 2025) [reported].
- **Repeated words.** 25 of 40 repetitions kept (0.63) in the non-native study [reported]. On stuttered podcast speech, Whisper v3 turned "which is which is terrible which is" into "which is terrible which is terrible", a regression from v2 on verbatim word repetitions; Whisper hallucinated on 14% of stuttered clips against 3.3% of fluent ones (Sridhar et al., Interspeech 2025) [reported].
- **Why.** Whisper was trained on transcripts that mix verbatim and "intended" styles, and its own evaluation normaliser deletes hmm, mm, mhm, mmm, uh and um (Whisper paper, Appendix C; CrisperWhisper) [reported].
- **In the lab** (synthetic speech, so a floor): with no prompt, "the the the screen" came out as "the screen" in most runs, "um" and "uh" mostly survived, and the groan "ugh" was never written as itself: as "uh", as nothing, or once as "ah hogwarts" [measured]. "Never, never" survived every run; "again and again and again" lost a repeat in some prompted runs [measured].

**Confidence:** high that Whisper as Cutalong runs it drops many fillers and some repetitions and partial words; medium on how many for this owner, because every rate above comes from other people's speech.

### Swallowed retakes

The failure that matters most for this owner, documented with measurements in davinci-resolve-mcp issue 125 [reported]:

- When a speaker re-reads a sentence immediately, Whisper "outputs the text once, aligns it to the first take, and absorbs 'pause + entire second take' into the duration of a single word". Measured there: a single word spanning 6.06 s, another 4.4 s.
- It happened in full-pass and isolated-window transcription alike, so it is not caused by previous-text conditioning.
- On English TTS with 15 planted retakes, 1 was swallowed, the same way; "TTS-synthesized retakes are too clean", so real speech should do it more.
- **Detection that worked there:** any word of 1.2 s or more marked the swallow point, with no false alarms in 191 s. **Recovery that worked:** re-transcribe the window on its own, and if a word is still stretched, re-transcribe again without the first take's span, so Whisper cannot align the second take onto it: 4 exact hits, 3 flagged for review and 1 miss out of 8.

In the lab the same signature appeared: "graphics" spanning 34.6 to 39.4 s at probability 0.15 to 0.37, swallowing a groan, a pause and a whole broken-off take [measured].

### Conditioning on previous text

- **What it does.** Each 30 s window is decoded with the previous window's text as a prompt. OpenAI's docstring: disabling it "may make the text inconsistent across windows, but the model becomes less prone to getting stuck in a failure loop, such as repetition looping or timestamps going out of sync" [reported].
- **How it fails.** Repeated hallucinated text after silence (PR 1253, faster-whisper issue 465, Hugging Face issue 21467), and timestamp offsets that accumulate (discussion 89). "Inaccurate end timestamps cause the next window to start too late and miss what was spoken" (PR 1253) [reported]. That last failure would drop exactly the speech this owner needs.
- **Is it what swallows a retake?** No source shows that, and the issue-125 measurement found the swallow with isolated windows too [reported]. In the lab, turning conditioning off without a prompt did not prevent it: a take was swallowed in all 5 such runs. A carried verbatim prompt with no rolling context lost nothing in 9 runs [measured].

**Decision:** turn rolling context off, because its failure modes (loops, drift, late window starts) are the wrong ones for retakes, and catch swallows separately.

### whisper.cpp v1.8.2, flag by flag

Checked in the source of the version `scripts/build-whisper.sh` builds [measured, in source]:

| Flag | What it really does in v1.8.2 |
|---|---|
| `--prompt TEXT` | Tokenised and placed in the rolling context for the first window, then pushed out by decoded text. |
| `--carry-initial-prompt` | Keeps the initial prompt and prepends it to every window. Rolling context fills whatever budget is left. |
| `-mc N` (`--max-context`) | The prompt budget is `min(N, n_text_ctx/2)`, 224 tokens for Whisper. **`-mc 0` turns off every prompt, the initial one included** (`if (params.n_max_text_ctx > 0 ...)`). A carried prompt longer than the budget is cut to its *last* `N-1` tokens, leaving no room for rolling context. |
| Temperature fallback | When a window fails its entropy or log-probability check it is retried hotter; above 0.5 the prompt is dropped for that retry. |
| `--dtw small.en` | Presets exist for tiny, base, small and medium (plain and `.en`) and large v1 to v3 turbo. **Disabled with a warning when flash attention is on, and whisper-cli turns flash attention on by default**: DTW needs `-nfa`. |
| `-ojf` | Full JSON: per token, `text`, `offsets`, `id`, `p` (probability) and `t_dtw`, the token's onset in units of 10 ms (each DTW step is 20 ms). Segment offsets do not use DTW. |
| `-ml 1 -sow` | One word per segment, split on word boundaries rather than tokens. |
| `-sns` | Suppresses non-speech tokens. |
| `--vad` | Built-in VAD, but it needs a separate Silero model file, which would be a new download. |

**What this means for Cutalong's call:** `--prompt` with a verbatim-style text and the vocabulary at its end, `--carry-initial-prompt`, `-mc` set so the prompt fills the budget (no rolling context), `--dtw <model>` with `-nfa`, `-ojf` for probabilities and DTW onsets, and `-ml 1 -sow` as now.

### Prompts

- **Style, not instructions.** "The model will tend to follow the style of the prompt" (Jong Wook Kim, OpenAI); a prompt with fillers and punctuation keeps both (discussion 625) [reported]. One user found disfluency prompts reliable on tiny but much less so on larger models (discussion 1174) [reported].
- **Vocabulary.** OpenAI's guide: a prompt fixes misrecognised words and acronyms, such as "DALL·E" written as "DALI"; only the final 224 tokens count [reported]. Supplying a dictionary of obscure words on every window "is very effective at boosting recognition of some words" (PR 1040) [reported].
- **In the lab**, the spoken "Sony Z V E 10" came out as "Sony Mi Mi 10" or "Sony MIDI 10" with no prompt, "Sony ZV -10" with the verbatim prompt carried on every window, and "Sony ZV -E10" once the product names were in that prompt. "RTX 5090" (spoken by the synthesiser as "five thousand and ninety") was written "590" or "5000" in every run, except 2 of 5 times when the names were in the prompt and each stretch was transcribed alone [measured]. Numbers followed the prompt's style too: "three" with the prompt, "3" without, so take matching treats them as equal.

### Speech the transcript leaves out

- A published pipeline feeds the speech regions an ASR left untranscribed to a voice-activity model and classifies what it finds, beating both a CRNN and a forced aligner at finding filled pauses (Ge et al., via CrisperWhisper) [reported].
- Cutalong already measures loudness every 10 ms. Voice activity from that envelope, compared with the words, finds speech with no words: a swallowed take, a dropped false start, a laugh, a cough [estimate; tested on fixtures in the build].

### The lab, in numbers

The 85 s synthetic session holds 14 planted takes and restarts, plus a groan and a laugh. Whisper small (int8) through faster-whisper 1.1.1, beam 5, best of 5, word timestamps; 33 runs in all [measured]:

| Setting (the whisper.cpp equivalent) | Runs | Planted takes lost, per run (of 14) | Runs with one word stretched over 2 s | Cut-off "ye-" kept | "the the" kept |
|---|---|---|---|---|---|
| Cutalong today: no prompt, rolling context, temperature fallback | 6 | 0, 2, 7, 7, 1, 2 | 3 | 0 of 6 | 0 of 6 |
| The same without temperature fallback (`-nf`) | 4 | 0 every run | 0 | 0 of 4 | 0 of 4 |
| No context and no prompt (`-mc 0`) | 5 | 2 every run | 5 | 0 of 5 | 0 of 5 |
| Verbatim prompt, first window only (`--prompt`) | 1 | 0 | 0 | 1 of 1 | 0 of 1 |
| Prompt on every window, rolling context too (`--carry-initial-prompt`) | 2 | 0, 0 | 0 | 2 of 2 | 1 of 2 |
| **Prompt on every window, no rolling context** (the new call) | 9 | 0 every run | 0 | 9 of 9 | 0 of 9 |
| Each voiced stretch transcribed alone, prompt carried (the second pass) | 6 | 0 every run | 0 | 6 of 6 | 6 of 6 |

- **The two runs that lost 7 takes** each had a 30-second hole (25.3 s to 55.3 s) where the transcript has no words at all: the window holding the five takes of the RTX line came back empty. Envelope voice activity would see 30 s of speech with no words there, which is exactly what the second pass looks for.
- **The swallow** ("graphics" stretched over 4.8 s, probability as low as 0.06) appeared in 3 of 6 runs with today's settings and in every run with no context and no prompt.
- **Temperature fallback is where today's run-to-run differences come from**: without it the same settings gave the same 199 words four times. It stays on, because it is what breaks repetition loops, and the second pass catches what it costs.
- **The groan "ugh" was never written as itself** in 33 runs: "uh" mostly, nothing, and once "ah hogwarts". It has to be found in the sound.
- **Speed**: the no-rolling-context runs took 18 to 52 s against 42 to 66 s for today's, on this CPU.

Synthetic speech is "too clean" (issue 125 found the same), so these are floors: real retakes will be swallowed more often, not less.

## 3. Technical realities

### Variable frame rate

- **Phones and screen recorders write VFR**, and the header still says 30; editors that place frames on a fixed grid without reading timestamps drift out of sync (Shotstack, Versely, Adobe) [reported]. An iPhone drops its capture rate in dim light (ffmpeg-micro) [reported].
- **Detection**: compare `r_frame_rate` with `avg_frame_rate` (a difference over about 1%), count frame durations, or run `vfrdet` (Shotstack, ffmpeg-micro) [reported]. On a fixture that dropped two of every three frames for 1.5 s: `r_frame_rate=30/1`, `avg_frame_rate=45/2`, `vfrdet` 2 of 87, packet durations 75 × 33 ms and 15 × 100 ms [measured].
- **Fix**: render to a constant rate with the `fps` filter at the nominal rate. Cutalong's renderer already starts every piece with `fps=`; the fault is the rate it picks (finding 7).

### Rotation

Phones store portrait video landscape with a display matrix. On a fixture made with `-display_rotation 90`: ffprobe reports 320x240 with side data `DisplayMatrix` rotation 90, and ffmpeg's default autorotation decodes 240x320 frames [measured]. `probeMedia()` in `inspiration/measure.ts` already swaps width and height; `probe()` in `ffmpeg.ts`, which `cut:prepare` uses, does not [measured].

### HDR

- **iPhone 12 and later record 10-bit HEVC in Dolby Vision profile 8.4, whose base layer is HLG**: ffprobe shows `color_transfer=arib-std-b67`, `bt2020` primaries, `yuv420p10le`, and a `DOVI configuration record` side data block (ffmpeg-micro, Encode Wiki) [reported]. Android flagships record HLG or PQ (`smpte2084`) [reported]. Fixtures with those tags probe exactly so [measured].
- **Ignored, it looks washed out**: low contrast, lifted blacks, drained colour, because `scale` resizes and never converts transfer [reported].
- **The conversion**: linearise, tone-map in float, map BT.2020 to BT.709, re-encode tagged: `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`. `desat=0` keeps faces from bleaching; `npl=100` suits HLG; PQ graded at 1000 nits can look better with a higher `npl` (ffmpeg-micro, Encode Wiki) [reported]. The chain runs on an HLG fixture with ffmpeg 6.1.1 [measured].
- **Dolby Vision**: profile 8.4 is handled as HLG; profile 5 (no standard base layer) comes out green and purple without Dolby Vision processing, which `zscale` cannot do (Encode Wiki) [reported].
- **Branch on the transfer only**: a BT.2020 file with an SDR transfer is wide gamut, not HDR, and 10-bit is not HDR (ffmpeg-micro, sdrtohdr.com) [reported].

### Log footage

| Profile | How a file says so | Evidence |
|---|---|---|
| Apple Log (iPhone 15 Pro and later) | QuickTime keys `com.apple.rec2020.apple-log`; Apple Log 2: `com.apple.apple-wide-gamut.apple-log` | Develop Log, ffcine profile.rs [reported] |
| DJI D-Log, D-Log M, D-Log2 | Colour tags say `bt709` for log and normal alike; the mode is in the `djmd` metadata track, or the key `com.dji.camera.ColorGammaSxS` | ffcine, dji-clip-color [reported] |
| Panasonic V-Log | The `com.panasonic.Semi-Pro.metadata.xml` tag includes `V-Log` and `V-Gamut` | EOSHD forum, ExifTool [reported] |
| Sony S-Log3 | A sidecar `.XML` (and Sony's embedded real-time metadata) names the capture gamma and gamut | MediaTools Pro, Adobe [reported] |
| Canon Log 3 | No reliable tag; a 10-bit Canon file without an HDR tag is probably C-Log 3 (medium confidence) | ffcine [reported] |

- **From the picture**: no true black, held-down highlights and weak colour; one tool converts on that evidence only when it knows the maker and the file is 10-bit, and otherwise names the clip as log and leaves it flat (heyeddie) [reported]. Middle grey sits near 49% in Apple Log, 54% in D-Log M and 40% in D-Log, so the wrong curve shifts exposure (Develop Log) [reported].
- **Cutalong cannot ship manufacturers' LUTs** (licences). It takes a `.cube` the person chooses, or applies a built-in approximation that says it is one [estimate].

### 10-bit HEVC

HEVC Main 10 decodes to `yuv420p10le`, which ffmpeg converts to 8-bit for export; it is only HDR when the transfer says so [reported; fixtures probe as Main 10, measured].

### Chaptered files

- **GoPro**: `GH` (AVC) or `GX` (HEVC), then a two-digit chapter, then a four-digit file number: `GX010119`, `GX020119`, `GX030119` are one recording. Chapters split at 4 GB on older models, 12 GB on newer ones (GoPro, GoPro Labs) [reported]. A group is the shared file number, not the chapter prefix: two recordings both start `GH01` [reported].
- **DJI**: sequential `DJI_0001.MP4` and onwards, with `.SRT` telemetry, and numbering restarts after a format (XAppSet) [reported].
- **Canon** MP4 splits at about 4 GB, or after about 29:50 at 59.94p and 59:50 otherwise (Canon) [reported].
- **Joining**: the concat demuxer with stream copy, when codec, size, frame rate and audio layout match; GoPro Labs maps only the video, audio and metadata streams (Jeff Geerling, GoPro Labs) [reported]. A camera can change frame rate mid-recording under thermal load, which breaks a lossless join (XAppSet) [reported].

### Audio

- **Split and safety channels.** RØDE Wireless GO II in split mode puts each transmitter on its own channel; in merged mode a safety channel records "a second track... at -20 dB" (RØDE) [reported]. DJI Mic 2's Safety Track lowers the right channel by 6 dB [reported]. So a stereo camera track can be two different microphones, or one microphone twice at two levels.
- **A dead channel.** A mono microphone into a stereo camera input often lands on one channel, and many camera apps record mono from the 3.5 mm jack (smartfilming) [reported]. The sign is one channel tens of decibels below the other [estimate; fixture in the build].
- **32-bit float** transmitters and recorders (DJI Mic 2, Zoom F-series) avoid clipping by design; ffmpeg reads them as `pcm_f32le` [reported].
- **Separate recorders and drift.** Sync by sound is the norm: Premiere, Resolve and Final Cut all sync by waveform, and PluralEyes went into limited maintenance in 2023 (Metavert) [reported]. Correlating loudness or onset envelopes works across very different microphones, and the peak's height against the rest gives a confidence (Metavert, polysync) [reported]. Clocks differ by 5 to 100 ppm; 50 ppm is 180 ms an hour; measure offsets in windows and fit a line (Metavert, Nodaro) [reported]. PluralEyes needs 5 to 10 s of shared sound [reported].
- **Wind and hum.** Wind is low-frequency rumble a high-pass reduces, though "severe wind rumble that's clipped the microphone's input stage" cannot be repaired (TryUncle) [reported]. Hum sits at 50 or 60 Hz and its harmonics [estimate].

### OBS multi-track recordings

OBS records up to six audio tracks; track 1 is the full mix by convention, and tracks 2 and up hold the microphone, game and chat alone (OBS) [reported]. Players and some editors read track 1 only, which is "the #1 multi-track complaint: my mic is missing" (formatif) [reported]. MKV or Hybrid MP4 hold the tracks; FLV holds one [reported].

## 4. What existing tools do

| Tool | Retakes | Silence | Where it fails |
|---|---|---|---|
| Descript | Remove Retakes keeps "the last good one"; Underlord does it on request | Removes fillers and pauses | "Aggressive... occasionally cuts a 'retake' that was actually a deliberate repetition" (Chase Jarvis); left 28.6% redundant words in TimeBolt's benchmark [reported] |
| Gling | Cuts bad takes, keeps the last | Silences and fillers, with a pace setting | "Confident rather than cautious — it will cut takes you meant to keep" (AISO Tools); "always ruins jokes" (a creator, via Creator Tribune); left about a quarter of fillers [reported] |
| AutoCut Repeat (Premiere, Resolve) | Finds repeated takes, "works even if you slightly rephrase", optional reference script | AutoCut Silences, by level | Retakes are a paid add-on; review is the workflow [reported] |
| TimeBolt | UmCheck finds repeated phrases with a 5 to 50 line look-ahead | Silence by level | Vendor's own benchmark: F1 90.6% against Gling 85.4% and Descript 80.4%, all near 97% safe; run by TimeBolt [reported] |
| Recut | None | Silence | Retakes stay [reported] |
| Premiere text-based editing | None: "you read the transcript and delete the weaker take yourself" | Pauses (as short as 0.1 s) and "uh", "umm" | Bulk deletion removes pauses left for effect (RedShark News) [reported] |
| DaVinci Resolve 20 | IntelliScript builds a timeline from a script | AI IntelliCut "Remove silence" | Editions differ; earlier silence removal was Studio only [reported] |

The pattern: silence is solved, retakes are where tools differ, and the complaints are all about confident cuts of things that were meant. None of the public pages describes how a tool decides that two takes are the same line [reported].

## 5. Niches

Each niche: what the raw footage is, what editors cut and keep, the rules, what Cutalong can measure to recognise it, and what Cutalong should do by default. The common niches go deeper. Tech, the owner's niche, goes deepest.

### Talking head: commentary, education, finance, business

- **Raw footage.** One camera, often a second angle or a phone, and a lavalier or shotgun; 15 to 60 minutes for a 5 to 20 minute video; usable share about a third to three quarters (Robles, Judd, Sparki) [reported].
- **Cut**: false starts, retakes, set-up talk ("is it recording?"), dead air, fillers that obstruct. **Keep**: one complete take per line, breaths at the head of sentences, pauses before key points.
- **Rules**: section 1. Scripted pieces run almost seamless (0 to 7% pause share); unscripted business talking head keeps 6 to 22% (`editing-skills.md`) [measured there].
- **Signals**: speech over 70% of the running time, one voice, a static frame with few scene changes, 130 to 220 words a minute, retake density [estimate].
- **Default**: takes on; tighten to a 0.35 s maximum gap; cut on words; keep laughter.

### Tech reviews and unboxing (the owner's niche)

**What comes in.**

- **Talking head with the product in hand**, from an outline rather than a script, so many restarts (Robles, Judd) [reported].
- **Products held up to the lens.** Autofocus hunts and glare flares as the product comes close. One creator covers their eyes so face detection lets go and the lens focuses on the product (Robles) [reported].
- **Macro and turntable B-roll**: textures, ports, the camera bump, rotating on a turntable; reviews "live or die on B-roll" (Alan Spicer) [reported].
- **Hands-on demos and comparisons**: side by side with a competitor, next to a common object for scale (Spicer) [reported].
- **Phone and computer screen recordings**, with their own dead time: loading spinners, typing, hunting through menus (Skillrove, Cubix) [reported].
- **Unboxings**: long, but the edit is "about the moment of opening: what is in the box, how it feels, first reactions. It moves fast" (Umbrella Creators) [reported].
- **Spec explanations, benchmarks, sponsor reads, "link in the description".**

**What editors cut and keep.**

- **Cut**: restarts and retakes, the stretch where focus is pulsing, loading and typing (or speed them up 3 to 6×), searching through menus, the wrong click and its recovery (Skillrove, stepvideo) [reported].
- **Keep**: the complete take of each line; the reveal; "the beat right after a navigation completes. Viewers need a second to register the new screen" (stepvideo); silent reading of a result on screen ("Silence alone is never an instruction to cut", Cubix) [reported].
- **Unboxing beats**: seal, lid off, the reveal, what is in the box, first reaction; repetition goes [reported; the order of beats is an estimate].

**Pacing.** The four Mrwhosetheboss Shorts measured in `observations.jsonl` [measured there]:

| | Air purifier | Screen protector | DJI Neo | Apple Watch | Median |
|---|---|---|---|---|---|
| Effective wpm | 213 | 220 | 218 | 246 | 219 |
| Est. pause share | 4.2% | 6.7% | 4.0% | 3.4% | 4.1% |
| First word | 0.24 s | 0.00 s | 0.08 s | 0.00 s | 0.04 s |
| Words in first 3 s | 9.6 | 10.3 | 10.1 | 8.2 | 9.9 |
| Mean retained gap per caption line | 0.087 s | 0.128 s | 0.083 s | 0.060 s | 0.085 s |
| 90th-percentile retained gap | 0.39 s | 0.43 s | 0.29 s | 0.26 s | 0.34 s |

All four are "tight". Tech long-form is different: MKBHD runs 7.4 cuts a minute, 48% talking head and 43% B-roll, with a long verdict hold late in the video (PandaStudio, via `editing-skills.md`) [reported there].

**Focus hunting.**

- Sharpness is measured per frame as the variance of the Laplacian, or with ffmpeg's `blurdetect` (MBARI, OpenCV) [reported]. Absolute values depend on the scene, so thresholds are relative to the clip's own baseline (LexData) [reported].
- Hunting is an oscillation: a patented method counts sharp-blurry-sharp transitions within a window, and several cycles in a short time mean the camera is hunting (US patent 10194072) [reported]. EditLint flags "a rhythmic in-out blurring pattern... detected by analysing the variance of sharpness scores across a short window" [reported].
- **For Cutalong**: sample `blurdetect` a few times a second, and flag windows where sharpness crosses its own median band two or more times within about 1.5 s while the frame stays the same shot [estimate; tested on a fixture in the build].

**Transcription.** Product names and model numbers are what Whisper mangles: "Sony ZV-E10" came out as "Sony Mi Mi 10" without a vocabulary prompt [measured]. The vocabulary comes from the edit's title, the brand's voice notes, and a short list of product names the creator keeps on the brand page.

**Signals.** Model numbers in the transcript (letters and digits: M4, RTX 5090, Pixel 9 Pro), spec words (GB, mAh, Hz, nits, fps, benchmark), "sponsored by", "link in the description", screen-recording traits (frames frozen for seconds at a time, a 60 fps capture with no camera noise) [estimate].

**Default.** Takes on, with the tech vocabulary in the prompt; tighten tight (0.25 s maximum gap, the measured joins); cut on words; flag focus hunting and offer to cut it; treat frozen screen-recording stretches longer than 2 s as dead time to offer for removal; keep short reading holds after a screen changes.

### Podcasts and interviews

- **Raw footage.** Multi-camera or multi-track: Riverside records each participant locally and uploads a track per speaker; Zoom and OBS produce one or more files (Riverside, slicecut) [reported]. 30 to 120 minutes.
- **Cut**: the warm-up ("are we recording?"), the long goodbye, false starts, tangents that do not pay off, crosstalk nobody can follow (slicecut) [reported]. **Keep**: laughter, fillers that sound like conversation ("a podcast stripped of every um sounds scripted"), the natural rhythm (slicecut) [reported].
- **Rules**: switch to the speaker on a point and the listener for a reaction; automatic switching misses reactions (slicecut); DOAC switches on turn changes and keeps laughter (`editing-skills.md`) [reported].
- **Signals**: two or more voices (pitch clusters or separate channels and tracks), long duration, laughter, overlapping speech [estimate].
- **Default**: takes on but conservative (offer rather than apply below high confidence); tighten loosely (0.6 s); keep laughter; keep fillers.

### Gaming

- **Raw footage.** One to several hours of capture, often OBS multi-track (game, microphone, chat), a facecam, 60 fps (OBS, gameclip) [reported].
- **Cut**: menus, loading, respawn timers, walking, lobbies, queues (gameclip, Mellius) [reported]. **Keep**: 3 to 5 s of setup before each moment and a beat after the payoff; reactions; clutches in real time; montage the grind (gameclip, Mellius) [reported].
- **Signals**: a 16:9 screen capture at 60 fps, separate game and microphone tracks, continuous game audio under speech, long duration [estimate].
- **Default**: dead time is game time with no speech and little motion; cut on moments, not every pause; keep reactions; never treat repeated game lines as retakes.

### Livestream VODs: IRL and Just Chatting

- **Raw footage.** 2 to 12 hours; a platform VOD has everything mixed into one track; local recordings can have separate tracks (Umbrella Creators) [reported].
- **Cut** the "stream furniture": starting soon, BRB, ad breaks, queues, repeated alerts, uncleared background music, long thank-yous to viewers (Umbrella Creators, StreamGen, Frameotter) [reported]. **Keep**: the story of the stream, one goal and its result; chat messages the streamer answers, put on screen [reported].
- **Signals**: very long duration; minutes of music with no speech at the start (starting soon) and in the middle (BRB) over a frozen frame; sections Twitch muted for music play as dead air (Frameotter) [reported].
- **Default**: offer to cut music-only and frozen stretches over 30 s; keep talk; takes off (streamers do not retake).

### Cooking

- **Raw footage.** Overhead as the spine and a side or 30° angle for the sear, pour, fold and cut-through (Vidmoat); long waits [reported].
- **Cut or compress**: repetition (chopping the second onion), waiting (simmer, bake) to a few seconds plus a timer (Umbrella Creators) [reported]. **Keep**: transformations, technique at 1× ("Never speed up the moment you are asking somebody to copy"), the payoff with the longest hold; the sizzle is "the music" (Vidmoat) [reported].
- **Signals**: low speech share with continuous motion, broadband sizzle and knife transients, an overhead frame [estimate].
- **Default**: keep non-speech sound (do not tighten across sizzle); cut on words only where there is speech; speed changes are left to the planner until a speed op exists.

### Fitness

- **Raw footage.** Demonstrations from several angles, sets and rests, gym noise, music (Increditors) [reported].
- **Cut**: dead space, mistakes, low-energy moments; rests unless it is a follow-along (Increditors) [reported]. **Keep**: form demonstrations, on-screen timers and rep counts for follow-alongs; voice at -6 to -3 dB and music at -18 to -12 dB under instruction (Increditors) [reported].
- **Signals**: a music bed, counting in the transcript ("one, two, three"), rhythmic motion [estimate].
- **Default**: keep counts; for follow-alongs never cut rest periods (timing is the content); cut on the beat for montages (needs beat tracking: not built).

### Beauty and fashion

- **Raw footage.** Long application at close range, product shots, a before and after; talk-through, voiceover or no talk (Viryze) [reported].
- **Cut**: most of the blending ("just going in once and then going out once", Adobe's Shirin Nahvi); cut out before the hand comes down [reported]. **Keep**: product shots with names and shades, the fix of a mistake at normal speed, the reveal (GoScript) [reported].
- **Signals**: a close face, long stretches of hands near the face, product names [estimate].
- **Default**: takes on for talk-through; keep the before and after; skin tone must not shift (no colour look by default).

### Vlogs and travel

- **Raw footage.** Hundreds of short clips from a phone, a GoPro, maybe a drone; for a 2 to 3 minute video about 20 to 30 good clips, cutting 85% (FirstCut Studio) [reported]. Wind and traffic on the microphone (TryUncle) [reported].
- **Cut**: shaky starts and ends, near-identical takes, screen locks, accidental recordings (Sparki) [reported]. **Keep**: the hook, highlight, transition and close of each place (Sparki) [reported].
- **Rules**: order by date first, and fix a wrong camera clock (Sparki); cuts every 2 to 5 s on the music (FirstCut) [reported].
- **Signals**: many files, handheld motion, low-frequency wind energy, DJI files [estimate].
- **Default**: order by creation time; join chapters; keep ambient sound; takes only on talking segments.

### DIY, crafts, woodworking and automotive

- **Raw footage.** Hours, often over a hundred clips, each with a few seconds of usable action (John Heisz) [reported]; loud tools; time-lapses.
- **Cut**: setup changes, waiting ("viewers do not need to watch paint dry, they need to see the color arrive"); label each clip change or wait (GoScript) [reported]. **Keep**: one honest wide shot of the full process; tool sounds at 1× in short bursts, often louder than the voice (Abdullah Yahya, GoScript) [reported].
- **Signals**: loud broadband bursts (saws, sanders), low speech share, long duration [estimate].
- **Default**: do not tighten across tool sound; takes only on talking segments; offer long quiet stretches with little motion for removal.

### Church services and sermons

- **Raw footage.** 60 to 150 minutes from a switched multi-camera feed; worship set, announcements, sermon (`worship.ts`, `shots.ts`) [measured on a real 138 minute service, in the classic code].
- **Cut**: the worship set from any clip: "a clip with a worship bed under it does not underperform, it disappears", because YouTube blocks a claimed Short under three minutes (`worship.ts`) [reported in code]. **Keep**: one idea per clip, 30 to 60 s, captions (`editing-skills.md`) [reported there].
- **Signals**: duration; sung music found by repetition (unique-word ratio under 0.32 over 30 s windows, `DEFAULT_MUSIC`) [measured in code]; camera cuts every few seconds; applause.
- **Default**: never cut inside a worship set; never treat repeated lyrics as retakes; takes off; tighten loosely; keep pauses in prayer.

### Music: performances, covers and DJ sets

- **Raw footage.** Many takes against a playback or backing track, five to twenty-five full takes (Resolve Tutorials); DJ sets of an hour or more with a mixer recording (Cevylo) [reported].
- **Rules**: sync every take to the reference track, then cut on the beat with the master audio continuous while the picture changes (Hanna Eng, Cevylo) [reported].
- **Signals**: music over 80% of the running time, strong beat periodicity, repeated lyrics [estimate].
- **Default**: no tightening, no takes; the audio map labels music so nothing cuts inside it. Beat cutting is not built.

### Comedy and sketches

- **Raw footage.** Several takes per line, coverage from two or three cameras (PremiumBeat) [reported].
- **Rules**: kill pauses unless the joke demands one; never cut away before the punch line ends; reactions often get the laugh; a deliberate awkward pause may be the joke (Nygard, ArcFlo, Menges) [reported]. "There is no correct number of frames before a laugh" (ArcFlo) [reported].
- **Signals**: high retake density, laughter, several angles [estimate].
- **Default**: takes on but never automatic between two complete takes (performance is a judgement); tighten except pauses before a punch line, which Cutalong cannot find alone: the planner decides.

### Sports and highlights

- **Raw footage.** Full games; broadcast footage belongs to its rights holder (NFL Films, via Clyper) [reported].
- **Signals of a highlight**: crowd noise peaks and commentator volume, scoreboard changes, whistles, celebrations; "combine two or more signals" (Domer) [reported].
- **Rules**: context beat, action, reaction; slow motion once, for the best moment (Domer, Clyper) [reported].
- **Default**: not a cut-the-words niche; Cutalong offers crowd-peak moments (needs audio map peaks) and leaves selection to the person. Highlight finding is not built.

### Events and weddings

- **Raw footage.** Hours from several cameras; the officiant's lavalier or a recorder is the cleanest audio (Love Story Editing) [reported].
- **Rules**: "Viewers forgive a soft shot. They will not forgive vows they cannot hear"; one chosen audio source per moment; mix around -16 LUFS (Love Story Editing, Wedit) [reported]. Highlight film 3 to 5 minutes, teaser 30 to 60 s (FilmScribe) [reported].
- **Signals**: separate recorder files, long duration, music, applause, speeches [estimate].
- **Default**: prefer the recorder's audio (sessions); keep vows and speeches whole; takes off.

### ASMR

- **Rules**: "Silence is a tool, not a problem. A 2-second pause in ASMR is intentional"; hold a trigger 20 to 30 s; minimal cuts; gentle denoise (3 to 6 dB) or none (Umbrella Creators) [reported]. Cut on the transient with 5 to 15 ms crossfades; loudness around -18 to -14 LUFS (Domer) [reported]. Room tone, not digital silence (ASMR Creator Gear) [reported].
- **Signals**: very quiet integrated loudness, whispering (little voicing), tapping transients, few words [estimate].
- **Default**: never tighten; never remove fillers or breaths; takes only on spoken mistakes and only when offered; no loudness push to -14 without asking.

### Kids, family and pets

- **Raw footage.** Many short phone clips; the moment "happens between ten minutes of waiting and three shaky angles" (Sparki) [reported].
- **Rules**: keep the lead-in, the action and the reaction together; do not imply a different outcome by cutting (Sparki); keep genuine expressions, cut duplicates (FirstCut) [reported]. Retakes are left out by default and can be added back as bloopers (cutzio) [reported].
- **Signals**: high-pitched voices, barking, low speech share, many short files [estimate].
- **Default**: keep laughter and natural sound; no tightening across non-speech; privacy: nothing leaves the computer anyway.

### Reaction and commentary over someone else's footage

- **Raw footage.** A screen or source video plus a facecam, often picture-in-picture; two audio sources (vidIQ, CapCut) [reported].
- **Rules**: cut dead stretches of silently watching; pause the source to comment; keep the source lower than the voice; use only the source footage needed; "there is no universally safe number of seconds" (vidIQ, Techtippr) [reported]. YouTube's reused-content policy covers compilations "with little or no narrative" (Clyper) [reported].
- **Signals**: two audio sources, picture-in-picture, the creator's speech interleaved with source audio [estimate].
- **Default**: never treat lines in the source as the creator's retakes (only the creator's voice track counts when tracks are separate); cut silent watching over 3 s.

## 6. From the study to the build

### Takes

- **Detection** works from words and timing first, sound second, cues last:
  - a **restart** is a break (a pause over about 0.3 s, a cut-off or fragment word, a filler, a breath or a loudness drop) followed by words the speaker just said; the abandoned fragment runs from the first repeated word to the restart;
  - a **repeated line** is the same or a reworded sentence after a pause, matched fuzzily on content words with numbers and contractions normalised;
  - a **broken-off take** is a prefix of a later line, or one interrupted by a laugh, sigh or "ugh";
  - **meant repetition** flows with no break, or repeats a content word for emphasis.
- **Choice**: the last complete, fluent take, unless an earlier one is clearly more fluent by delivery (stumbles, energy, pace, pitch movement from the audio map). The reply says why.
- **Confidence** on every decision; below the line, the material stays and the reply offers the cut ("I left one possible retake in at 2:14. Say 'cut it' and it goes.").
- **Ops**: strikes on the rejected takes, splits and a move when the kept take was filmed elsewhere; alternates stay in the document, so "use the second take of the intro" is one sentence, locally or through the planner.

### Transcription

- `--prompt` in the verbatim style with the vocabulary last, `--carry-initial-prompt`, `-mc` set so the prompt fills the budget, `--dtw <model> -nfa`, `-ojf`, `-ml 1 -sow`.
- **A second pass** over swallow suspects (words over 1.2 s, or stretched and improbable) and voiced spans with no words: each span transcribed alone with no context and merged back.
- **Verbatim accuracy to be measured on the owner's Mac.**

### Intake

Record VFR, rotation, HDR transfer, suspected log, bit depth, chapters, the audio layout and the kind of footage on each source; tone-map HDR and convert log as the first filter of each piece; honour rotation; join chapters; use the best channel; say what was found in one sentence and up to three facts.

### Sessions

Order a shoot's files by creation time; join chapters; sync a separate recorder by cross-correlating loudness envelopes, fit drift across windows, and prefer the recorder's audio.

**Several players' recordings of one gaming session** line up by their voice chat, the one sound every recording shares (`shared/pov/lineup`). Matched over a whole long session, game sound nobody shares can drown the chat. On the owner's two three-player sessions (70 and 83 minutes, six pairs) the whole match correlated at only 0.26 to 0.38, under the 0.55 the line-up asked for, though it beat every other lag clearly; three fixed 90 s stretches (start, middle, end) were heard clearly in 0 to 2 of 3 per pair; so neither session lined up at all [measured]. What a stretch check needs is talk, not length:

- **Where both talk.** A minute's stretch, two in each sixth of what the recordings share, placed where both are active together. On synthetic 2.5-hour sessions whose chat talks 2 to 12% of the time, 0 to 5 of 12 evenly spread minutes were heard clearly and 7 to 12 of the 12 talkiest, every one right to a frame, and none of another evening's recording [measured]. Longer stretches did worse (90 s: 5 to 11 of 12; 120 s: 1 to 12): with little said, a longer window is mostly game, and the match falls.
- **Three that agree.** Sure takes three or more stretches on one line within 50 ms (a steady drift between the recorders' clocks, at most 500 ppm); the line gives the line-up in the middle of what they share and the drift. On the owner's sessions, 4 to 11 of 12 agreed in four of the six pairs (drift 0.03 to 0.15 s over the session); the other two pairs line up through the third recording, so both sessions line up whole [measured].
- **Enough of the recordings for the whole match.** With a minute's minimum overlap, the whole match locked onto a minute at the ends by chance whenever talk was 12% of the time or less; with a quarter of the shorter recording, up to ten minutes, it found the line-up from 6% up, and the stretches then confirmed it to 2 ms with the drift to 6 ms [measured, synthetic]. Under that, the recording is said not to line up.

A line-up the whole session agrees on but no three stretches confirm is unsure: the recording goes in and is heard, the reply says so and how to check it (a moment everyone hears, `/angle sync <name> +0.1`), and the first cut does not cut to it until `/povs` is asked.

**The voice chat's own delay** limits all of this. A player's voice is in their own recording at once and reaches the others' a moment later, so a minute where one player talks lines up a little differently from one where the other does. Across every minute heard clearly in the owner's pairs, the line-ups spread 150 to 250 ms about the fitted line in five of the six (the sixth had six minutes heard), and in one pair they moved with who was louder (correlation 0.82; about +230 ms when one talked, -110 ms when the other did) [measured]. So a line-up the talkiest minutes agree on can be out by about the chat's delay, a few frames, when one player did the talking in them: on the owner's four sure pairs it sat 22 to 175 ms from the line through every minute heard [measured]. Telling the minutes apart by who is talking and taking the middle would remove it; until then a shared moment checked by eye settles it.

**Who said or did what** takes two recordings that were running. A word goes to the recording that has it loudest against its own speech, by 3 dB; where only one recording was running, everything said is loudest in it, whoever said it. In one of the owner's sessions, where their recording started 13.5 minutes before the others, every word of that stretch went to the owner, and the others' shouts through the chat became 276 of the owner's screams in its first ten minutes [measured]; now a word needs two recordings that heard it, and a laugh or a bang one other recording running to weigh it against.

**The owner's two sessions, cut** (the lab's `povs`, a 20-minute window of each, as they come in): 117 and 153 shots, 51 and 74 cuts to another player's reaction and back, 9 and 11 grids of everyone, the shortest shot 1.64 and 1.55 s; following whoever talks, 205 and 217 shots [measured]. Two things to look at with the footage: in both, the loudest microphone was not the owner's, so it has to be told whose view is home; and the owner's words run wide, about one in six 8 dB or more over their middle, so 96 and 89 of them read as screams in 20 minutes where the others had 0 to 9 [measured]. Whether those are screams or just loud talk needs eyes.

### Cutting profiles

| Profile | Silences kept | Cut on | Takes | Dead time |
|---|---|---|---|---|
| Talking head | Pauses up to 0.35 s; laughter | Words | On | Set-up talk, unworded noise |
| Tech | Pauses up to 0.25 s; reading holds after a screen change | Words | On, tech vocabulary | Focus hunting; frozen screen over 2 s |
| Podcast | Pauses up to 0.6 s; laughter; fillers | Words | Offered, not applied, below high confidence | Warm-up and goodbye |
| Gaming | Game sound | Moments | Off | Quiet with little motion |
| Livestream | Talk | Moments | Off | Music-only and frozen stretches |
| Church | Prayer pauses; never inside worship | Words, outside music | Off | Worship set (for clips) |
| ASMR | Everything | Sound | Offered only | None |
| Cooking, DIY, vlog, fitness, beauty, music, comedy, sports, events, kids and pets, reaction | Profiles where the study is thin are listed as not built. | | | |

## 7. The real footage lab

The synthetic lab above tells whether the takes planner finds what was planted. The real footage lab tells whether Cutalong's first cut of a creator's own raw footage comes close to the edit they published. It runs the app's own code on the footage and scores the result against the published video. Nothing from the footage goes into the repository: no transcripts, quotes, titles, file names or ids. Only the method and aggregate numbers are written here.

**Running the app's code outside the app.** `node scripts/lab.mjs <entry> [args]` bundles an entry in `tests/lab` against `src/`, with Electron stubbed (`tests/lab/electron-stub.cjs`), and runs it in plain node. The folders the app would use come from `LAB_USERDATA` (models, settings, the brand), `LAB_APP` (`resources/bin/whisper-cli`, `resources/fonts`), `LAB_TEMP` and `LAB_VIDEOS`. The entries:

| Entry | What runs | Writes |
|---|---|---|
| `prepare` | `cut:session` (which file is the talking, which the better sound, which B-roll; measured, as with no key), then `cut:prepare` on the talking clips: the verbatim transcription with its second listen, words snapped to the sound, the audio map | The roles and the prepared doc (v1: the recording split into beats) |
| `v1` | The first cut by the app's planners, as the chat runs them with the brand's niche: `takes`, `tighten`, `snappy`, `length:SEC`, `under:SEC` | Per policy, the doc with that version, and every beat that plays and every run of words cut, with the reason (which take, a false start, set-up talk, a filler, a line cut for length) |
| `clip` | `/clipping`'s `findClips` with the app's own tools; whoever picks is whoever the app would choose (Claude with a key, Ollama when it runs, otherwise measuring) | The clips with their words, the plan, the reply and the clip-quality verdicts |
| `hear` | `main/transcribe`, verbatim or tidy | The words, for the published video |
| `render` | `cut:render`, final quality | The export |
| `score` | `shared/raw/published` | The scores below |
| `sync` | `shared/audio/offset`'s `estimateOffset` over the whole overlap of two recordings, then window by window, with a line fitted through the windows | The offset, how sure it is, and the drift in ms an hour (on a synthetic pair with a planted 3.217 s offset and -500 ppm, it found 3.21 s at the start and -533 ppm, spread 2.8 ms) |
| `povs` | Several players' recordings of one gaming session dropped in together, as the chat runs them: `cut:session` finds the session and lines each up with the person's own by the voice chat (`main/session-povs`), `cut:prepare` reads theirs, `pov:listen` hears each other view on their clock, and `shared/pov` cuts between them as the session comes in (the sure views only) and by who is talking. `--window` reads only that many seconds of theirs; `--keep` saves the heard edit (words and sound maps), which holds what was said, so it stays with the footage | The line-up (offset, sure or not, the stretches that agreed, how much they share, the drift), whether the loudest microphone is theirs, who said each word, the reactions heard, and per mode the shots, the shortest, and the seconds each view shows; numbers and the app's sentences only |

**Scoring against the published edit** (`src/shared/raw/published.ts`). The published video is transcribed the same way as the raw. Its words are aligned to the raw words with a path that may skip ahead (a cut, cheap), jump back (a line moved, dearer) or leave a word unmatched, matching words loosely (`3` and `three`, a plural, a letter off, a cut-off stem), so two transcripts of the same speech line up through Whisper's slips. Runs of words played straight through, on both clocks at once, are the stretches the editor kept. Where another stretch of the raw reads the same (a take with the same words), the sound decides when the published video is at hand (loudness compared at the two places), and otherwise the stretch is marked as one the words cannot settle and left out of take agreement. From that:

- **kept words**: of the raw words the cut plays, the share the published edit plays (precision), and the reverse (recall), by count and by seconds said;
- **takes**: for each line said more than once, the take each edit plays, and how often they agree where both play one;
- **running time**: raw, the cut, and published, and the pace as each plays, in words a minute;
- **the opening**: whether both open on the same raw sentence, or on takes of the same line;
- **pauses**: between neighbouring words as each plays: median, 90th percentile, and the share of time in pauses over 0.25 s.

**When the published words have no times.** A published video's auto-captions read as text come in playing order with no timings. They still align (stretches then end only where the raw skips, jumps or changes recording), and they still give kept words, takes, the opening and the pace; the published pauses and telling same-worded takes apart by ear need the times, so those are left out.

**What the words cannot tell**: picture-only material (screen recordings, B-roll, text on screen), music and sound effects, a voiceover recorded elsewhere (its words go unmatched, which `found` shows), and speed changes.

**Tuning.** Decision logic is changed only with tests on synthetic fixtures, as in the lab above, and checked on some of the real projects while others are held out, so a change that only fits the footage it was tuned on shows.

## Sources

Editing practice
- Clipteach, raw takes to finished intro: https://www.clipteach.com/blog/from-raw-takes-to-finished-intro
- ScriptCut, A-roll editing guide: https://scriptcut.io/blog/a-roll-editing-guide
- ChatCut talking-head guide (skills directory): https://www.skillsdirectory.com/skills/chatcut-inc-talking-head-guide
- Addaly, selects and the assembly: https://addaly.com/learn/ai-video/selects-and-the-assembly
- Addaly, cutting a dialogue scene: https://addaly.com/learn/video-editing/cutting-a-dialogue-scene
- ReadyForm, editing multiple takes: https://www.readyform.ai/blog/how-to-edit-multiple-takes-into-one-video
- Sparki, talking-head editing: https://sparki.io/blog/talking-head-editing-agent
- Cutora, pauses and retakes: https://dev.to/mo-cutoraai/deciding-what-to-cut-in-a-talking-head-video-pauses-are-easy-retakes-are-not-389a
- Tastebud, talking head and founder video: https://www.aitastebud.com/learn/toolkit/people-on-camera/talking-head-and-founder-video
- Larry Jordan, dialog editing: https://larryjordan.com/articles/fcp-x-better-dialog-editing/
- Transom, remember to breathe: https://transom.org/2022/remember-to-breathe/
- Jeff Pierson, editing speech: https://jeffapierson.com/journal_tools/training/08-audio-production/03-editing-speech.html
- Kook & Hoomen, cut on the sound: https://kookenhoomen.com/motion/cut-the-sequence-on-the-sound/
- Woven, jump cuts: https://www.woven.video/guides/jump-cut
- Stephen Robles, workflow: https://www.youtube.com/watch?v=Wn7V3WLBjPw
- Curtis Judd, workflow: https://www.youtube.com/watch?v=5YWkbiXQnh0

Transcription
- Sridhar et al., Whisper on stuttered speech (Interspeech 2025): https://www.isca-archive.org/interspeech_2025/sridhar25_interspeech.pdf
- Keeping the Ums (WAC 2026): https://aclanthology.org/2026.wac-1.18.pdf
- What Whisper misses in clinical interviews (ICNLSP 2025): https://aclanthology.org/2025.icnlsp-1.36.pdf
- ASR for non-native English, disfluencies: https://arxiv.org/pdf/2503.06924
- CrisperWhisper: https://arxiv.org/html/2408.16589
- Transcription policy as a latent variable: https://arxiv.org/html/2607.18934
- davinci-resolve-mcp issue 125, swallowed retakes: https://github.com/samuelgursky/davinci-resolve-mcp/issues/125
- WhisperX drops repeated words: https://github.com/m-bain/whisperX/issues/827
- openai/whisper discussions 1174 (fillers), 625 (prompt style), 2003 (repetitions), 89 (timestamps and conditioning), 192 (repetition): https://github.com/openai/whisper/discussions/1174, https://github.com/openai/whisper/discussions/625, https://github.com/openai/whisper/discussions/2003, https://github.com/openai/whisper/discussions/89, https://github.com/openai/whisper/discussions/192
- openai/whisper PRs 1253 (repeated prompt) and 1040 (initial prompt on every window): https://github.com/openai/whisper/pull/1253, https://github.com/openai/whisper/pull/1040
- openai/whisper transcribe.py: https://raw.githubusercontent.com/openai/whisper/main/whisper/transcribe.py
- faster-whisper issue 465: https://github.com/SYSTRAN/faster-whisper/issues/465
- Hugging Face transformers issue 21467: https://github.com/huggingface/transformers/issues/21467
- OpenAI speech-to-text guide, prompting (mirror): https://developer-openai-com.sitemirror.store/api/docs/guides/speech-to-text/
- whisper.cpp v1.8.2 source: https://github.com/ggml-org/whisper.cpp/tree/v1.8.2 (`examples/cli/cli.cpp`, `src/whisper.cpp`)

Technical
- Shotstack, VFR: https://shotstack.io/learn/variable-frame-rate-video/
- Versely, VFR and captions: https://www.versely.studio/blog/variable-frame-rate-breaks-your-caption-timing
- Adobe, VFR in Premiere: https://community.adobe.com/questions-729/faq-how-to-work-with-variable-frame-rate-vfr-media-in-premiere-pro-1349720
- ffmpeg-micro, VFR and sync: https://www.ffmpeg-micro.com/blog/ffmpeg-audio-out-of-sync-isn-t-the-codec-it-s-the-frame-rate
- ffmpeg-micro, HDR to SDR: https://www.ffmpeg-micro.com/blog/ffmpeg-hdr-to-sdr-stop-iphone-uploads-coming-out-gray
- Encode Wiki, HDR: https://encode.wiki/hdr
- sdrtohdr.com, HDR to SDR: https://sdrtohdr.com/blog/hdr-to-sdr
- media-os ffmpeg-hdr-color skill: https://github.com/damionrashford/media-os/blob/main/skills/ffmpeg-hdr-color/SKILL.md
- Develop Log, which log: https://developlog.app/guides/which-log-is-my-video
- ffcine profile detection: https://docs.rs/ffcine-core/latest/src/ffcine_core/profile.rs.html
- dji-clip-color: https://github.com/erik-sutton95/dji-clip-color
- EOSHD forum, V-Log metadata: https://www.eoshd.com/comments/topic/87436-ho-to-check-if-a-video-clip-is-in-v-log/
- heyeddie, log footage: https://www.heyeddie.ai/help/log-footage-luts-and-rec709
- Adobe, log auto-detection: https://helpx.adobe.com/nz/premiere-pro/using/auto-detection-of-log-camera-formats-and-raw-media.html
- MediaTools Pro, sidecars: https://mediatoolspro.com/docs/troubleshooting/metadata.html
- GoPro file naming: https://community.gopro.com/s/article/GoPro-Camera-File-Naming-Convention?language=en_US
- GoPro Labs, chapters: https://gopro.github.io/labs/control/chapters/
- XAppSet, reassembling chapters: https://www.xappset.com/xrecovery/solutions/reassemble-chaptered-video/
- Canon, split MP4: https://support.usa.canon.com/kb/s/article/ART115948
- Jeff Geerling, joining GoPro files: https://www.jeffgeerling.com/blog/2021/how-join-multiple-mp4-files-gopro-ffmpeg/
- RØDE, safety channel: https://help.rode.com/hc/en-us/articles/6933730433167-How-does-the-Wireless-GO-II-s-safety-channel-work
- RØDE, merged and split modes: https://rode.com/en-us/about/news-info/wireless-go-ii-merged-and-split-modes-what-they-are-and-when-to-use-them
- smartfilming, split channels: https://smartfilming.blog/2021/05/04/44-split-channels-dual-mono-audio-from-the-rode-wireless-go-ii-in-lumafusion/
- DJI Mic 2 manual: https://en.manual.ly/dji/dji-mic-2/manual
- Metavert, multicam and audio sync: https://metavert.io/multicam-sync
- Nodaro, audio sync: https://nodaroai.github.io/app.nodaro.ai/nodes/processing-audio/audio-sync.md
- polysync: https://github.com/jianshuo/polysync
- PluralEyes troubleshooting: https://help.maxon.net/rg/en-us/Content/html/Pluraleyes-troubleshoot-the-sync.html
- OBS, multi-track audio: https://obsproject.com/kb/advanced-recording-guide-and-multi-track-audio
- formatif, OBS tracks: https://formatif.net/blog/obs-multi-track-audio-separate-remux
- TryUncle, travel audio in Resolve: https://tryuncle.com/learn/davinci-resolve/davinci-resolve-for-travel-and-vlog-content-creators-where-to-start
- EditLint, blur detection: https://editlint.com/features/detect-blurry.html
- US patent 10194072, focus hunt: https://exa.ai/library/legal/patent/vvtwqtwzhw8
- MBARI, sharpness metrics: https://docs.mbari.org/triton-video-sampling/algorithm/metrics/
- LexData, focus measurement: https://www.lexdatalabs.com/blog/camera-focus-measurement-computer-vision

Tools
- Descript, Remove Retakes: https://www.descript.com/ai/remove-retakes and https://www.descript.com/features
- Descript, Underlord primer: https://www.descript.com/blog/article/underlord-ai-video-editor-primer
- Chase Jarvis, Underlord: https://chasejarvis.com/blog/descript-underlord-ai/
- Gling: https://www.gling.ai/save-time
- AISO Tools, Gling review: https://aisotools.com/blog/gling-review-2026
- Creator Tribune, Gling review: https://creatortribune.com/gling-ai-review/
- TimeBolt, bad-take benchmark: https://www.timebolt.io/blog/timebolt-vs-gling-vs-descript-who-removes-bad-takes-better-in-scripted-video
- AutoCut Repeat: https://www.autocut.com/en/autocutrepeat/
- PxlSafe, Premiere silence and fillers: https://www.pxlsafe.com/remove-silence-premiere-pro
- Umless, Premiere and retakes: https://umless.thoufeekxlabs.com/premiere-pro-silence-remover/
- Cutora, silence in Premiere and Resolve: https://usecutora.com/answers/silence-removal-in-premiere-pro-and-davinci-resolve

Niches
- Alan Spicer, product reviews: https://alanspicer.com/how-to-film-product-reviews-youtube/
- Umbrella Creators, product reviews: https://umbrellacreators.com/blog/how-to-edit-product-review-videos
- Skillrove, screen recordings: https://skillrove.dev/guides/edit-a-screen-recording-into-a-tutorial
- Cubix, screen recordings: https://cubix.design/guides/edit-screen-recordings
- stepvideo, screen recordings: https://stepvideo.io/blog/make-screen-recordings-look-professional
- Kredos Media, screen recordings: https://www.kredosmedia.com/article/screen-recording-editing
- gameclip, gaming: https://gameclip.io/blog/how-to-edit-gaming-videos
- Mellius, gaming: https://melliusai.com/edit-gaming-video
- Umbrella Creators, livestream VODs: https://umbrellacreators.com/blog/how-to-edit-livestream-vods-into-youtube-videos
- StreamGen, VOD editing: https://streamgen.cc/blog/twitch-vod-editor/
- Frameotter, stream to video: https://frameotter.com/stream-to-video
- Umbrella Creators, cooking: https://umbrellacreators.com/blog/youtube-editor-for-cooking-channels
- Vidmoat, cooking: https://www.vidmoat.com/blog/edit-cooking-videos
- Increditors, fitness: https://increditors.com/video-editing-fitness-wellness-youtubers/
- Adobe, makeup tutorials with Shirin Nahvi: https://www.youtube.com/watch?v=9x1w21gwO8M
- Viryze, makeup tutorials: https://viryze.com/blog/film-makeup-tutorials-tiktok
- GoScript, beauty tutorials: https://www.goscript.app/blog/beauty-content-filming-tutorials
- Sparki, travel vlog: https://sparki.io/blog/how-to-edit-a-travel-vlog
- FirstCut Studio, travel: https://firstcutstudio.xyz/blog/how-to-edit-travel-videos-phone
- John Heisz, editing builds: https://ibuildit.ca/projects/how-i-edit-video/
- Abdullah Yahya, home improvement: https://abdullahyahya.com/2022/12/editing-home-improvement-videos/
- GoScript, long builds: https://www.goscript.app/blog/diy-content-speeding-up-long-builds
- Hanna Eng, music videos: https://www.hanna-eng.com/guides/monter-un-clip-musical/
- Resolve Tutorials, music video: https://www.youtube.com/watch?v=hEXs0J_Rtr8
- Cevylo, DJ sets: https://cevylo.com/how-to-edit-a-dj-set-video
- Roger Nygard, editing comedy (CineMontage): https://cinemontage.org/want-to-edit-funnier-let-roger-nygard-show-you-how/
- ArcFlo, comedy timing: https://arcflo.app/resources/how-to-edit-comedy-for-timing
- Austen Menges, comedy rules: https://www.austenmenges.com/blog/professional-comedy-editing-rules
- PremiumBeat, comedy scenes: https://www.premiumbeat.com/blog/how-to-edit-comedy-scenes-for-maximum-laughs/
- Domer, sports highlights: https://domer.io/blog/pro-sports-highlight-video-social-media-workflow
- Clyper, highlight videos: https://www.clyper.io/guides/how-to-make-a-highlight-video
- Love Story Editing, weddings: https://lovestoryediting.com/wedding-video-editing-guides/how-to-edit-wedding-videos-a-complete-guide-for-pros/
- FilmScribe, weddings: https://filmscribe.ai/en/guides/how-to-edit-a-wedding-video
- Wedit, wedding audio: https://wedit.video/wedding-video-editing/
- Umbrella Creators, ASMR: https://umbrellacreators.com/blog/youtube-editor-for-asmr-creators
- Domer, ASMR audio: https://domer.io/blog/asmr-video-microphone-settings-editing-techniques
- ASMR Creator Gear: https://asmrcreatorgear.com/how-to-edit-asmr-audio.html
- Sparki, pet vlogs: https://sparki.io/vlog/pet
- FirstCut Studio, family videos: https://firstcutstudio.xyz/blog/how-to-edit-family-videos
- cutzio, funny moments: https://cutzio.app/styles/funny-moments
- vidIQ, reaction videos: https://vidiq.com/blog/post/make-youtube-reaction-videos/
- CapCut, picture-in-picture reactions: https://www.capcut.com/create/picture-in-picture-editing-reaction-videos
- Techtippr, reaction videos: https://techtippr.com/how-to-make-a-reaction-video/
- Riverside editor: https://riverside.com/video-editor
- slicecut, video podcasts: https://slicecut.io/guides/how-to-edit-a-video-podcast/
