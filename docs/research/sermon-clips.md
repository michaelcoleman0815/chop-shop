# Sermon clips: how the most-watched ones are edited

The study behind Cutalong's sermon clip defaults: the Sermon caption look (`src/shared/caption-presets.ts`), the
sermon clip profile's length and pauses (`CLIP_PROFILES.church` in `src/shared/clipping/profile.ts`), and the clip
finder's guidance to open on the claim (`src/main/clips.ts`). Made on 21 November 2026 for The Life Church, whose
social media manager will cut clips from each Sunday service with Cutalong.

## What it rests on

- **66 clips analysed; 54 were sermon clips.** The other 12 (trending-audio memes, reaction videos, narrated stock,
  street interviews, a worship song, commentary, AI-made video, a political selfie video, music-only, a promo) were set aside.
- **28 churches or preachers and 12 repost pages.** 24 big-church official clips, 14 small or mid-size church clips,
  15 from repost pages and 1 independent teacher. Picked by real view counts.
- **46 YouTube, 8 TikTok, 0 Instagram.** Instagram Reels need a login to download, so none were checked; the big
  churches post the same clips there.
- **How:** each clip at 360p, one frame every 3 s with a spectrogram, loudness, pauses and cuts measured with
  ffmpeg, openings and endings from Whisper small.en. Video and audio were deleted after each batch. Caption
  animation, film grain and sound effects can't be judged reliably from frames 3 s apart, so those findings are limited.

## Findings

### Captions

- **Burned-in captions:** 37 of 54. Of the 17 without, 9 are 16:9 uploads.
- **Style:** 27 bold word-group styles and 10 plain subtitles.
- **Case** (37 captioned): ALL CAPS 21, sentence case 11, lowercase 5. Within the bold styles, ALL CAPS is 20 of 27.
- **Font:** heavy geometric or rounded sans (Montserrat or Poppins Black type) 17, condensed (Bebas or Oswald type) 7,
  plain regular sans 9, slab 2, serif 1, monospace 1, script 0.
- **Words on screen:** 2–4 in 20; 5 or more in 15, mostly plain subtitles; one at a time in 2.
- **Size and position:** bold styles span about half the frame width. 20 sit mid-frame (45–60% of the height),
  15 lower (62–85%), 2 in a top band.
- **Colour:** white text in 35 of 37. A key word picked out in colour in 13 of 37: yellow 6, cyan 2, green 2,
  blue 1, orange 1, multicolour 1. Only 1 also enlarges it.
- **Edges:** every bold style read had a soft drop shadow or thin dark outline; none had a thick sticker stroke.
  4 of 37 put a box behind the text; none box a single word.
- **Animation:** 8 build word by word or show one word at a time. Emojis in captions: 0.

### Look

- **Format:** full-frame vertical crop of the stage feed in 34 of 54, letterboxed or templated on black in 8,
  horizontal 16:9 in 12. Blurred-background bars: 0.
- **Framing:** big-church crops sit medium to medium-close (waist or chest up). Small churches tend to hold one medium-wide shot.
- **Angles:** 34 switch angles. Big-church multicam switches every 3–8 s by eye.
- **B-roll:** 6 of 54, mostly audience reactions. No nature or stock B-roll in any sermon clip.
- **Grade:** natural 35, cinematic or moody 10, warm 6, desaturated 2, black and white 1. Black fades at top and
  bottom in 3 (Furtick and Elevation). Punch-ins or slow push-ins in 7.

### Text beyond captions

- **None at all:** 28 of 54.
- **Hook or title text:** 11 (4 only in the first 1–10 s).
- **Logo or watermark:** 13. Scripture reference: 8. End card or call to action: 8. Preacher's name: 2.

### Music

- **A bed under the voice:** 24 of 54 (19 added in the edit, 5 live keys or band from the room). Dry: 27. Only at the end: 3.
- **Kind:** nearly all sustained, non-rhythmic held tones: ambient pads or held keys. One cinematic score and one sermon-jam bed.
- **Level:** a median 11.9 dB (IQR 7.9–15.3) under the speech, against 28.2 dB of quiet in dry clips. No consistent climax swell.
- **Sound effects:** none detected.
- **Views:** median 470K with a bed against 173K dry, confounded by channel size.

### Structure

- **Length:** median 68 s (IQR 42–108). Under 30 s: 7; 30–60: 16; 60–90: 10; 90–120: 8; over 120: 13.
  The biggest hits are 169 s (30.9M), 178 s (9.3M), 43 s (3.9M) and 59 s (3.0M).
- **Opening:** the thesis or strongest line in 25, mid-thought in 8, a story 7, scripture 6, a question 3. 33 of 54 start on the claim with no setup.
- **Ending:** a landing line in 41, a question to the viewer 7, a declaration or altar call 4. 42 of 54 end within 1 s of the last word.
- **Pace:** median 155 words a minute.
- **Pauses:** 29 of 54 have no silence of 0.25 s or more; only 6 keep noticeable pauses.
- **Congregation:** applause, laughter, cheering, "amen" and "that's right" are kept wherever present.

## Style families

- **A. Bold caption cut: 24 of 54, median 412K views, 51.2M in total.** A vertical crop with bold captions:
  2–4 words in 19, ALL CAPS in 18, an accent colour on key words in 11, a bed in 10. A median 62 s at 173 words a minute.
  The strongest variant (Furtick and Elevation) adds fast multicam, a crushed-black grade, black fades top and bottom,
  yellow or blue key words mid-frame and a low pad bed.
- **B. Raw service cut: 17 of 54, median 97K.** Footage as recorded, 8 horizontal; no captions in 12. A median 93 s.
- **C. Packaged template: 13 of 54, median 116K.** Letterbox, frame or split layouts with persistent title or
  scripture bars, logos and end cards; music in 10.

## The church's own clips

The owner's reference is The Life Church's own channel (youtube.com/@thelifechurchal/shorts), not the megachurch
clips above; bold all-caps karaoke captions read as someone else's style there. Six of its Shorts were looked at
(CYFV_87bmxk, s5balNuYrck, iKRo1-A93w4, 1p17CjLawuk, 8UKm433e7hk, N6XfXRVeER0). Three looks:

- **One word at a time** ("THE DEVIL ISN'T YOUR PROBLEM.", its most-viewed): a bold display serif, lowercase as
  said, white with a soft shadow, over the preacher's chest at about half the frame's height; a tight chest-up crop
  on a dark, warm stage.
- **Black-and-white card** ("He Sent Them Into the Storm on Purpose", the newest): the picture as a rounded card on
  black, tall condensed capitals wiping in across the middle, a film streak.
- **Hook box, then quiet captions** ("She Was Never Coming Home. Then He Prayed."): a white box with black text for
  the first seconds, then small light lowercase captions fading in word by word, a light-leak glow.

The first is the default sermon look; the other two are to follow.

## The owner's six references

After the serif look was turned down, the owner sent six Shorts as the bar: Elevation Church (l-jS5mk65Vo,
JaEFDNQ_2aE, M27ZaS1fZX8), Rodney Howard-Browne (fTkDXLidGok), 2819 Church (xGW9pTfs9_k) and The Life Church of
Athens (962VOGlt8xE). Each was sampled at 1 and 8 frames a second, measured with ffmpeg's signalstats and ebur128,
and its sound drawn as a spectrogram. Against them, a clip Cutalong made from the Athens service:

| | Mean luma (0–255) | Saturation | Captions | Bed |
|---|---|---|---|---|
| Elevation, l-jS5 | 75 | 7.0 | small caps building word by word, 2 lines, key words yellow | chords changing about every 2 s |
| Elevation, JaEF | 40 | 5.5 | one word, caps, peach | sustained pad |
| Elevation, M27Z | 56 | 12.6 | small lowercase building, 2–3 lines, key words yellow | chords under the voice |
| Howard-Browne, fTkD | 71 | 24.6 | 2–3 words, heavy caps, white | chords under the voice |
| 2819 Church, xGW9 | 57 | 3.9 | one word, condensed caps, white | chords under the voice |
| The Life Church, 962V | 105 | 12.3 | one word, serif lowercase, blue-grey | faint |
| **Cutalong (before)** | **126** | **18.2** | one word, serif, 180 px | one held chord |

What the gap was, in order of how much it showed:

- **The picture.** The references are low-key and muted: mean luma 40 to 75, saturation 4 to 13. The stream runs
  near 125 and 18. They are framed chest-up. Cutalong kept the stream's whole height, so the preacher stood waist-up
  against a bright screen, and the stream's scripture banner along the bottom 30% was cut off at both sides.
- **The captions.** Two of Elevation's three, and the most polished of the six, build the sentence as it is said.
  Small heavy capitals (about 3% of the frame's height) go over the chest. Each line is laid out whole from its
  first word, so nothing moves as it fills. The words the preacher leans on are set in yellow, and the lines clear
  at the sentence's end. None of the six has a plate, a bounce or an emoji.
- **The bed.** All of them have one, and it moves: the spectrograms show the chord changing every two to four
  seconds. A single held chord reads as a hum, or as nothing.

## The owner's next three

The owner then sent three more and asked for four things: no two reels alike, fonts that are not chunky
capitals or a serif, fewer words on screen, and the picture as a square inside the 9:16 frame. The three were
Lecrae's Deep End clips (NncJ8uBv9XI, Yp7Az1j5GHw) and The Life Church of Athens' "She Was Never Coming Home"
(N6XfXRVeER0).

- **Lecrae:** everyday captions are two or three words at a time, small, in Inter, as said, punctuation
  and all ("of the United States", "neighborhood."). The line he lands is big and heavy on two lines, its key
  words in yellow or red on the second ("He still / sits down.", "That ain't / biblical"). Archive stills and
  B-roll cut in, and the grade is dark and warm.
- **The Life Church:** a white card with dark title-case words states the hook for the first four seconds ("The
  Doctors Said She'd Never Recover"). The captions under it are small lower-case words, three at a time.
- **Elevation** (from the first six): the picture is a 4:5 box on black inside the 9:16 frame.

## The owner's six reels, 22 November

Six more vertical sermon reels the owner likes, every caption change measured frame by frame on the 720 × 1280 files (the sizes below are cap heights at 1080 × 1920). What they share is restraint: wide stage shots from a live camera, few cuts or none, no hook text on screen, and small, still captions that change with each word or two, with no pop, no highlight and nothing round them. Each has one face.

| Reel | Captions | Cutting and picture |
|---|---|---|
| "He shows us" | One word, heavy grotesque capitals (Helvetica Bold), off-white #F0F0E7, cap 72 px, low on the chest (0.64 of the height); punctuation gone, apostrophes kept; blink off at breaths | Two angles, 3 angle cuts and 3 bare jump cuts in 56 s; warm soft film grade, highlights rolled off, red halation, softened edges |
| "Our hearts are ready" | One word (up to three short ones), white italic Didone serif, cap 54 px, dead centre; as said, punctuation kept; held a second, then blank in each pause | Black-and-white slow-motion worship B-roll under a voice, 5 hard cuts and one 1.5 s dissolve, slow push-ins, fade to black |
| "If I have nothing" | One or two words, tight Helvetica Bold capitals, cap 45 px, dead centre; commas and quotes kept; blank in pauses | 12 handheld shots averaging 5.9 s, focus pulls into cuts, a 4-frame white flash in, a film-burn flicker out; low-key, cream highlights |
| "I came to save a life" | One or two words, very wide heavy capitals (Druk Wide), cap 50 px, dead centre, set smaller rather than wrapped | 18 long live-camera stage shots averaging 7.9 s, 5 jump cuts; cool blue LED wall, crushed blacks; fade to black |
| "Planted in the house" | One or two words, condensed serif capitals, cap 64 px, dead centre, letters touching; punctuation gone | One uncut 78 s stage take, live pans and pushes; low-key teal and orange; a 0.4 s orange film burn to end |
| "Not every delay" | Sans lines (Instrument Sans Bold, sentence case, punctuation kept) in a column half the frame wide at 0.70 of the height, filling in word by word in place; names, numbers and theme words swapped into an italic serif at 1.5 times on the same baseline | One orbiting handheld take, no cuts; matte, lifted, muted grade |

Cutalong carries them as six caption looks (Film, one word; Whisper; Stage capitals; Wide capitals; Serif capitals; Editorial) in four free faces bundled under the SIL Open Font License (Instrument Serif and its italic, Instrument Sans Bold, Archivo Expanded Black), and as six picture looks that take turns with the first six in a set of clips: a warm film grade, black and white with a fade out, a matte muted picture, a cool stage and a low warm one, and a white flash in. All keep the chest-up crop from the top of the picture rather than the reels' wide shots: wider, a church stream's scripture along the foot of the frame comes into the clip. None puts a hook on screen, as none of these reels does. The editorial look's italic words are the ones Claude marks as leaned on.

## Restarts

Played back, the six sample clips from the owner's own Sunday service had the preacher "stuttering": lines broken off and begun again, which a church's editor cuts and the reels above never let through. Heard closely, there were 18 of them in the six, such as "religion never- religion never points you to God", "we- we just- we can't find it", "I don't want- I don't want what you believe", "and so he was in- in that- in that place", and "till his blood became- or his sweat became".

The words did not have them. An hour's service is heard fast for its moments (the small model, one guess at each step, no prompt), and that hearing smooths a restart into one line: the words say "religion never points" while the sound says it twice, so nothing knew to cut it, and the captions did not show it either.

So each moment picked is heard again, closely, before it is made into an edit (`closely` in `src/main/clipping.ts`), on the same model with a prompt that writes broken-off words with a dash (`CLOSE_PROMPT` in `src/shared/clipping/restarts.ts`). On the six clips the small model with that prompt marked the restarts with dashes; the large turbo model wrote most of them with commas, and medium was two to three times slower. Heard closely, a minute of the service took 4 to 9 s on the owner's Mac. The close hearing's words stand in for the first only where they agree: at least 80% of the words first heard are heard again, and no more than half as many again. Its words also run on into the pause after them ("Nah." held 4.3 s, "20," 6.5 s), and in a service the band or the room fills that pause, so the sound does not pull them back; held, the pauses were hidden from the tightening and two clips came out 5 and 10 s longer. So a word heard both times keeps the end the first hearing gave it, and a word only heard closely runs no longer than its letters take to say. With that, five of the six clips came out 3 to 7 s shorter, by their restarts, and the sixth the same length: it now plays the "20" of "Ephesians 6:20", which the first cut had clipped.

Released as 0.3.7, the owner heard the first clip lose half its first word, and the captions read as out of time. Measured against the clips' own sound, word by word, the captions sat where they had (a median 0.00 s off, 0.06 s on average); what was wrong was the cut. Whisper's edges for words said without a pause between were as much as 0.27 s out, and a strike cuts where they say: "religion" ended the sentence before and began this one, the close hearing wrote the first with a dash, and striking it took "Re-" off the clip's first word, which then played as "It kills people" under a caption saying RELIGION. In the fifth, "God's will to- that she was" played as "God's will, she was". So (`cutsOnPauses`) the cut after a restart moves to the end of the last pause before the word kept, so long as that is after the last struck word has begun, and a clip opens in the breath before its first word (a pause of 0.1 s or more, longer than the stop inside "reli-gion", within 0.35 s). The cut before a restart stays where Whisper put it: moved on into a pause, it brought back what he broke off. A clip's first word heard both whole and broken off opens on the whole one.

The edit's finished version strikes what he broke off (`restartsIn`): a word with a dash, back to where he starts the line again; a few words said twice straight away ("you ever, you ever studied", "as he is, as he is present"); and a few grammar words broken off at a comma ("we just, we can't"). What he says twice on purpose stays: a word three times or more ("this, this, this, this, this and this", "no, no, no"), a line said again after a full stop ("He did. He did."), and anything longer ("it's gonna be one of those days, it's gonna be one of those days"). The first version, the moment as it was said, keeps every word, and in the script the struck words show crossed out, so each is a click from coming back.

## Quiet sermons

A service is often recorded from across the room, and quietly. Every clip is set to -14 LUFS, the loudness YouTube plays Shorts at (YouTube turns a louder video down but never a quieter one up), with peaks held at -1.5 dB true peak. The owner asked whether it turns a quiet sermon up, with a limit. It did turn it up, with no limit, and the room came up with the voice.

Measured on two test sermons made with the Mac's own voice (no one's recording): a normal passage at -33 LUFS, a soft one 12 dB under it and a loud one, over pink noise as a room makes it. loudnorm turned the normal passage up 19 dB, the soft one 25 dB (it lifts a stretch quieter than the rest by up to about 5 dB more than the whole, and holds that gain through the pause after), and the loud one 15 dB. In a quiet room, at -72 dB, the room ended at -48 to -55 dB; in a room with air handling, at -55 dB, at -30 to -37 dB, which is heard in every pause.

What Cutalong does now (`src/main/render/levels.ts`):

- **No more than 24 dB up.** Before a cut renders, the sound it keeps is measured (`measureSound`): its loudness, and the room, the level of its quietest tenth in 50 ms windows. A voice too quiet to reach the target in 24 dB is turned up 24 dB and left quieter than the target (`planSound`). This holds for every cut with a loudness target, not only sermons.
- **The room taken down by as much as it would be heard.** A sermon clip's voice is a voice in a room (`room` on the church profile, `Voice.room` on the edit). Where the room would sit once turned up with the voice, plus the 5 dB loudnorm adds after a quiet stretch, is set against -60 dB, 46 dB under a voice at -14 LUFS, and afftdn takes out up to 18 dB of the difference. afftdn listening as it goes took 1.5 dB off the room in a test, whatever it was asked for; given a print of the room first, it took 11. So the render finds the longest stretches that are only room (`printRuns`), up to 1.5 s, puts them in a file, plays the file through afftdn ahead of the cut's sound so it learns the noise from it, and takes the print off again with afftdn's 25 ms (`roomClean` in `src/main/render/audio.ts`). The print is an input of its own, so nothing waits on the cut's sound for it.
- **The pauses that are only room dipped.** Where the room would still be heard past what the clean takes, up to 8 dB more comes off each pause between words, from 0.06 s after one word to 0.03 s before the next (`pauseKeys`): a pause of 0.2 s is long enough, and a clip's are 0.2 to 0.3 s. A pause is dipped only where every 50 ms of it measured as room, so a breath, laughter or an amen in it is left alone.

Through the real export, on the test sermons cut as a clip is (pauses of 0.2 to 0.3 s), the pauses came out 10 to 19 dB quieter in the quiet room (-48 to -57 dB before, -62 to -72 after) and 5 to 15 dB quieter in the noisy one (-31 to -40 before, -36 to -55 after); the voice stayed at the target and every word where it was (`src/main/room-render.test.ts`). The pauses that came down least, 5 to 8 dB, came down by the clean alone: the dip left them, as something in them measured louder than the room.

## What Cutalong does with it

A set of clips takes six looks in turn (`ClipProfile.looks` in `src/shared/clipping/profile.ts`). With only
three, and one grade and one font across them, the owner saw "mostly just one style". So each look now differs
from the others in picture, captions, accent and frame:

| Look | Picture | Captions | Frame |
|---|---|---|---|
| Square | low-key and muted | three words beneath it in Inter, key words yellow (`sermon-box`); Claude's hook above it (banner `title`) | a square on black (`Cut.box`) |
| Feature | dark warm brown, as Lecrae's | three words in Inter; the landed line big, its key words yellow on their own line (`sermon`) | full |
| Hook card | the room as it looks, barely darkened, as The Life Church's | Claude's hook on a white card for four seconds (banner `card`), then lower-case words (`sermon-quiet`) | full |
| One word | dark, cold navy, nearly no colour | one word at a time in clean heavy Inter capitals, about 57 px tall, at the middle, as Rodney Howard-Browne's Shorts (s4ZSnKLhnIk) set them (`sermon-word`); 2819 Church's tall Bebas Neue version is `sermon-word-tall` | full |
| Red line | black and white, hard and grainy | as Feature, but the landed line in red, the only colour on screen (`sermon-red`) | full |
| Portrait | dark and muted teal, as Elevation's | the sentence building in capitals, key words yellow (`sermon-build`) | a 4:5 picture on black |

The square is the sharpest from a 720p stream: it is made about 2.1 times larger, where full frame is 3.8.

Claude marks the key words and writes each clip's hook in one call for the set (`src/main/key-words.ts`).

### Before that: Elevation's look

The owner turned down its face (Montserrat ExtraBold) and its eight words a screen. The building captions stay as
the "Sermon build" preset, now in Inter ExtraBold. What else carried over:

- **Captions (Sermon build):**
  - Up to eight words a screen, broken at the sentence's end, at a pause and at a comma.
  - Each word shows from when it is said. The group is laid out whole from its first word (`build`), and it holds
    0.6 s after its last word.
  - Claude marks the words the preacher leans on, once for the whole set (`src/main/key-words.ts`). They are set in
    the brand's accent, yellow by default.
  - Word times come from Whisper's alignment pass.
  - The church's own serif stays as "Sermon serif".
- **Framing:** a 1.45× punch-in from the top of the picture (`zoomAt: 0`). It keeps heads, makes the frame
  chest-up and leaves out the bottom 31%, where the stream lays its scripture and lower thirds.
- **Following:** the closer window follows sooner, since a preacher who walks leaves it faster. Its slack, glide
  and smoothing all shrink by the punch-in (`pieceFraming`). Where his face turns away, his body is followed instead
  (`subjectFrom`).
- **Shots:** a service's stream cuts to a camera at the back of the room, where the preacher stands between the
  congregation's shoulders. None of the references has a shot like that. The Mac's Vision helper reports the people
  it sees as well as the faces. A moment where two or more people stand close to the camera (`crowdShare` in
  `src/shared/edit/reframe.ts`) for 30% or more of its length gives way to one filmed from the front. Claude picks
  four spare moments for this, and the reply says how many were left out. Where fewer than five are filmed from
  the front, the best of the others fill the set to five.
- **Grade:** exposure −0.5, contrast +0.25, saturation −0.45, a little warmth, a deep vignette, light sharpening and
  grain. A stream frame then measures luma 69, saturation 8.
- **Bed:** a slow I–V–vi–IV progression, four seconds a chord, with soft piano notes (`src/main/pads.ts`). It sits
  about 12 dB under the voice and dips while he preaches.
- **Length:** 30–90 s, aiming for 60.
- **Pauses:** cut over 0.4 s; laughter and applause stay.
- **Sentences:** every clip opens and ends on a whole sentence (`fitPick` in `src/shared/clipping/shape.ts`).
- **Opening:** the clip finder is told to open on the claim itself where the moment is a point, not a story.
  Claude then chooses where each clip opens, at a clause start in its first quarter, so it opens on the line
  rather than the run-up: "Religion kills people, God saves people", not "And, but if you will study religion".
  The filler a breath opens with (and, but, so, um, uh, well, you know) is always dropped
  (`src/shared/clipping/opening.ts`), and a clip is never left shorter than its kind's least length.
- **What a stream can't give:** a 720p stream made 1.45× closer is soft beside a cinema camera's 4K. The camera's
  own files, or a 1080p export of the stream, close most of that gap.

## The clips

Number | link | channel | views | length | family: style

- 01 | https://youtu.be/2rQ_hNLK7k0 | In Touch Ministries | 3,935,718 | 43 s | B: TV multicam crop, bold serif sentence-case subtitles
- 02 | https://youtu.be/nYCh70iGOq0 | Life.Church | 30,857,490 | 169 s | A: one locked wide shot, small heavy caps, soft bed, testimony
- 03 | https://www.tiktok.com/@stevenfurtick/video/7692179100521286926 | stevenfurtick | 2,400,000 | 71 s | A: fast multicam, caps with blue key words, key-phrase callout, black fades, bed
- 04 | https://youtu.be/jMMF5w9IjD8 | Elevation Church | 386,376 | 68 s | A: multicam, rounded lowercase with yellow key words, moody grade, bed
- 05 | https://youtu.be/rrA0X3EkUPw | The Potter's House of Dallas | 3,532,874 | 155 s | C: 16:9 mini-film with location B-roll, teal grade, score, logo
- 06 | https://www.tiktok.com/@iammiketodd/video/7594917713575775518 | Michael Todd | 1,100,000 | 93 s | B: raw multicam, no captions, TikTok hook box, crowd kept
- 07 | https://youtu.be/ttajLNSm1SA | Tony Evans | 263,324 | 45 s | A: 4:5 single camera with punch-ins, condensed captions, end-card CTA
- 08 | https://youtu.be/qKm_cctvlTo | Going Beyond Ministries (Priscilla Shirer) | 202,900 | 177 s | B: multicam crop, no text, applause kept
- 09 | https://youtu.be/FtRYCWgNsEg | Jackie Hill Perry | 477,686 | 60 s | A: arena multicam, small caps, teal grade, pauses kept
- 10 | https://youtu.be/ATkUJOuFMuY | John Mark Comer | 30,072 | 180 s | B: seated two-camera documentary, lower-third subtitles, CTA card
- 12 | https://www.tiktok.com/@pastorjerryeze/video/7703942411885481237 | Pastor Jerry Eze | 1,300,000 | 25 s | C: prayer livestream, logo, follow lower-thirds, live keys
- 13 | https://youtu.be/3hSibVhbknA | BoldMultiMedia | 9,280,306 | 178 s | A: panel multicam, heavy italic caps of 1–3 words, soft bed
- 14 | https://youtu.be/N6dVBvLJrl8 | BoldMultiMedia | 1,036,801 | 29 s | A: podcast single camera, outlined caps, white-box hook for 3 s
- 15 | https://youtu.be/8TSx5s8iJXA | 21st Century Revival | 580,626 | 151 s | A: archive pulpit footage, slab lowercase with yellow word, audience cutaways, bed
- 17 | https://youtu.be/CYV3frvaD-g | FACELESS LORE | 124,110 | 42 s | B: 16:9 livestream re-upload, ministry lower-third and logo
- 19 | https://youtu.be/e14fel74_Uc | Woke Preacher Clips | 173,129 | 57 s | B: static livestream, purple title box with emoji
- 20 | https://www.tiktok.com/@sermon.clips/video/7582966884300033293 | sermon.clips | 53,800 | 40 s | C: 16:9 on black, scripture header, small subtitles, bed
- 21 | https://youtu.be/Ww8UMSC2jmY | Steven Furtick | 66,573 | 19 s | A: desaturated film look, small typewriter caps, left-aligned
- 22 | https://www.tiktok.com/@elevationchurch/video/7685123970126875934 | elevationchurch | 437,800 | 124 s | A: multicam, caps with yellow key words and scripture tags, black fades, bed
- 23 | https://youtu.be/d9itIaeionw | The Potter's House of Dallas | 747,753 | 43 s | C: caps on a dark pill box, fixed sermon-title bar, logo strip
- 24 | https://youtu.be/cyGzcNq7Ouo | Transformation Church | 213,046 | 36 s | B: two setups, tiny thin subtitles, pauses kept
- 28 | https://youtu.be/xGW9pTfs9_k | 2819 Church | 1,395,727 | 38 s | A: handheld multicam, one big condensed word at a time, dark grade, bed
- 31 | https://youtu.be/Zbeubn1Bg48 | LifePoint Church | 6,139 | 35 s | A: single camera, outlined caps with cyan word
- 32 | https://youtu.be/BkhNvZWsMoQ | Faith Chapel | 4,517 | 27 s | A: wide stage crop, caps with a bigger green word, low bed
- 33 | https://youtu.be/R6Ldl1L-UhU | KeyLifeNetwork | 229,590 | 94 s | A: seated single camera, big condensed caps, URL watermark
- 34 | https://youtu.be/ECt8ZlJbpnk | CCOAN - Almere | 1,829,447 | 55 s | B: 4:5 handheld on black, logo, live keys
- 35 | https://youtu.be/dFhIF1FCS6Q | CB Barthlow | 8,479 | 29 s | A: single camera, small bold italic caps, contrarian opener
- 37 | https://youtu.be/kyQcVG76wYU | Heart of Worship Church | 1,574 | 31 s | C: hook box, scripture slides, logo, caps with yellow word
- 38 | https://youtu.be/oZhHZPlxgDk | Highlands Church | 3,884 | 105 s | B: 16:9 static wide, slides cut in, series bumper
- 39 | https://youtu.be/in0N7askf_I | Grace Hill Church | 2,281 | 176 s | B: 16:9 static livestream, scripture overlays, pauses kept
- 40 | https://youtu.be/JjdzoDA5dZ0 | Celebration Church Tri-Cities | 2,496 | 53 s | B: question hook for the first second, small subtitles, soft bed
- 41 | https://youtu.be/P4KJh_0fTwY | Royalty Christian Centre | 1,733 | 68 s | C: 16:9 with logo cards, name lower-third, live band
- 43 | https://youtu.be/1WzcPoZ8ZUE | Wolobah Kennedy | 5,354 | 52 s | C: framed on black, persistent quote headline, boxed captions, loud bed
- 44 | https://youtu.be/HvyitRrA748 | Saintwave Culture | 11,389 | 25 s | A: rounded frame on black, slab lowercase with multicolour words
- 45 | https://youtu.be/LJGB2M5RViY | Love Is Stronger Than Death | 6,173 | 6 s | B: one line, no text, band under
- 47 | https://youtu.be/U1s5kabUorA | BoldMultiMedia | 780,783 | 64 s | A: podcast multicam with split-screen reactions, condensed caps
- 48 | https://youtu.be/x5KRQ8MdjtM | 21st Century Revival | 1,358,961 | 60 s | A: one yellow italic word at a time, Like/Share/Subscribe box
- 49 | https://youtu.be/pkS1GNLR3xs | getupchurch | 201,565 | 121 s | B: 16:9 archive film, boxed subtitles, soft bed
- 50 | https://youtu.be/GuItSMkfj1Q | Sheepsoftheshepherd | 24,423 | 151 s | C: 16:9 split with scripture poster, yellow key words
- 51 | https://www.tiktok.com/@iammiketodd/video/7595572069706796319 | Michael Todd | 797,900 | 44 s | A: black-and-white grade, slow push-ins, one long caps line
- 52 | https://www.tiktok.com/@stevenfurtick/video/7694785007235222798 | stevenfurtick | 503,000 | 103 s | A: multicam, caps with yellow key words, black fades, low bed
- 53 | https://www.tiktok.com/@pastorjerryeze/video/7694936786073586965 | Pastor Jerry Eze | 610,500 | 75 s | C: stream above blue prayer-point cards, logo, live keys
- 54 | https://youtu.be/KBBXWj9RdFI | Christ's Commission Fellowship | 116,364 | 105 s | C: branded template with title bar, scripture cards, subscribe end card
- 55 | https://youtu.be/1DAZ413Wiwo | Joel Osteen | 268,146 | 103 s | A: tight punch-ins, outlined sentence case of 2–4 words, logo
- 56 | https://youtu.be/tNlIoCeGyLk | Desiring God | 3,013,191 | 59 s | C: captions in a black top band, word-by-word reveal, soft bed
- 58 | https://youtu.be/TWS0QDRZOsQ | For the Gospel | 34,708 | 85 s | B: 16:9 conference panel, cinematic multicam, ends on a punchline
- 59 | https://youtu.be/U1D-GMrdCl8 | theosagapeministries | 33,112 | 105 s | C: 16:9 sermon jam with still B-roll and a strong bed
- 60 | https://youtu.be/VZJ50-sxVfg | Pastor Greg Laurie | 6,106 | 141 s | B: 16:9 multicam, no text, laughter kept
- 61 | https://youtu.be/YV-lYsSHSpU | Free Chapel | 97,138 | 168 s | B: 16:9 multicam with crowd wides, altar-call ending
- 62 | https://youtu.be/XRtsNMgqAEQ | Antioch East AME Church | 93 | 71 s | A: OpusClip output, heavy caps with green word, low position
- 63 | https://youtu.be/6CT6k8vE1zw | Verity Baptist | 203 | 108 s | B: 16:9 static wide, subscribe pop-up, 21 s end screen
- 64 | https://youtu.be/U0P0Igk_kt8 | Desiring God | 825,689 | 161 s | C: top-band caption template, soft bed
- 65 | https://youtu.be/v0ILV8ve_pY | Highlands Church | 2,167 | 34 s | A: single camera, condensed caps with orange words, soft bed
- 66 | https://youtu.be/QB45OTElta0 | LifePoint Church | 4,723 | 89 s | A: multicam, caps with cyan word, ends on a question
