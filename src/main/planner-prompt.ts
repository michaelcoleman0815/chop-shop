import { z } from 'zod'
import {
  CAMERA_KINDS,
  currentCut,
  currentVersion,
  describeLook,
  gridLine,
  FILL_MODES,
  fillMode,
  indexWords,
  ANGLE_LAYOUTS,
  LOOK_SETTINGS,
  NAMED_LOOKS,
  plannedGrid,
  noteBeats,
  rangeTimes,
  resolveCut,
  SFX_KINDS,
  sfxName,
  TRANSITION_KINDS,
  type EditDoc,
  type Note
} from '../shared/edit'
import { chaptersOf, clock, describeCamera, describeSpeed, seconds } from '../shared/presets'
import { drawsCaptions, graphicsGuide, graphicsLines, template, templates } from '../shared/motion'
import { FX_PLANNER_OPS, fromFxPlannerOp, fxGuide, fxLines } from '../shared/fx/planner'
import { searchIcons } from '../shared/assets'
import { lineName, playingTake, takesOf } from '../shared/raw/plan'
import { renderPovs } from '../shared/pov/choose'
import { ordinal } from '../shared/raw/takes'
import { renderSound } from '../shared/audio/map'
import { offCameraLine } from '../shared/vision/speakers'
import { cutOnRequest } from '../shared/raw/length'
import { planCommandSchemas, teachCommands } from '../shared/plan/commands'

/**
 * Everything the planner sends and expects back, kept apart from the API call
 * so it can be tested without one.
 *
 * The request is laid out for prompt caching: the instructions never change,
 * the source transcript changes only when the footage does, and only the cut,
 * the notes and the ask change from one request to the next. They go last.
 */

/** The named looks' settings, as the planner reads them. */
const NAMED_LIST = Object.values(NAMED_LOOKS)
  .map(({ look: { name, ...settings } }) => `${name} ${JSON.stringify(settings)}`)
  .join('; ')

export const PLANNER_SYSTEM = `You are the editor inside Cutalong, a video editor people talk to. You receive a recording's transcript, the current cut, and a request (a typed message or a list of notes). You answer with edit operations that carry out the request, a one-sentence summary of what changed, and a short reply.

## The edit
- The source transcript lists every spoken word with an id: w1, w2, ... Words from a second or later recording carry its id too: s2w1, s2w2, ... Ids never change.
- An edit can be cut from several recordings, in the order they were shot. Each <source> names its file. When it says sound="...", that recording's picture plays over the sound of a separate, better recording, already lined up; nothing more needs doing for it.
- The cut is an ordered list of beats. A beat plays the words from its first id to its last id, inclusive, from one recording. Beats play in list order, so moving a beat moves that moment in the video.
- Struck words are inside a beat but cut out of it. Words in no beat are not in the video.
- A beat's treatment: frame (speaker, broll, split, card), bw (black and white), zoom (1 is the full frame; 1.08 to 1.2 is a punch-in), bigWord (the id of one word in that beat shown big on screen), broll (a cutaway from the material: {"asset":"a1","inSec":0} shows material a1 from that second, muted, over the beat's sound), captions (false hides the captions while the beat plays, true shows them again).

## Material
A <material> block, when present, lists what the person brought in to use: footage, images and clips, each with an id (a1, a2, ...), its length and where the cut already shows it.
- To cut to material, treat a beat with frame broll (or split, to keep the speaker beside it) and broll {"asset":"a2","inSec":0}. A cutaway covers its whole beat, so split a long beat first and give the cutaway only the words it illustrates, about 2 to 5 seconds of them.
- Put each piece where what is being said is what it shows. If nothing matches, put it where it best carries the line. Never cover the opening beat unless asked.
- Material the person brought in with this request goes into the cut now. Choose the beats yourself, never ask where it goes, and place every piece unless it plainly fits nowhere.
- Use inSec to skip a slow start in longer footage. A piece can be used more than once at different inSec values.
- When the edit needs more B-roll than the material gives, or the person asks for B-roll to be found, list the moments in brollWanted: at most three, each the beat and a short stock footage search that would show it ("hands typing on a laptop at night").

## Operations
- {"op":"remove","beats":["b3"],"why":""}: drop whole beats. When the person asked for a part to be cut by what it is ("cut the tangent about the conference", "lose the intro"), "why" names it as they would ("the part about the conference"), so it stays out until they ask for it back; otherwise "".
- {"op":"strike","from":"w12","to":"w15"} and {"op":"unstrike",...}: cut or restore words inside beats. Use this for filler, false starts and repeated takes.
- {"op":"move","beat":"b7","to":0}: move a beat to a position (0 is first).
- {"op":"split","beat":"b4","at":"w31"}: split before a word, which must be inside the beat and not its first word. The second half gets the next free id.
- {"op":"join","beat":"b4"}: join a beat with the one after it. Only when they sit together in the recording.
- {"op":"insert","to":2,"beat":{"source":"s1","from":"w40","to":"w52"}}: bring words back as a new beat.
- {"op":"treat","beats":["b2","b5"],"set":{"bw":true}}: set treatment fields. A bigWord set names exactly one beat.
- {"op":"captions","set":{"on":true,"wordsPerScreen":2,"position":"chest","uppercase":false}}: positions are top, middle, chest, bottom. Add "preset":"hierarchy" for drawn captions: two lines a page, a small line and a big one with the key words, each word fading in as it is said, on the speaker's chest; "preset":"boxed" for drawn captions a few words at a time with the word being said in a solid box of the brand's accent; "preset":"clean" goes back to plain subtitles.
- {"op":"tighten","set":{"maxGapSec":0.35,"padSec":0.06,"fillers":true}} or {"op":"tighten","set":null}.
- {"op":"aspect","aspect":"vertical"}: vertical, wide, square or original.
- {"op":"loudness","lufs":-14}.
- {"op":"transition","beats":["b4"],"kind":"dissolve","sec":0.5}: how a beat comes in from the one before. Kinds: dissolve, dip-to-black, dip-to-white, flash, whip-left, whip-right, push-left, push-right, push-up, push-down, slide-left, slide-right, slide-up, slide-down, wipe-left, wipe-right, wipe-up, wipe-down, smooth-left, smooth-right, smooth-up, smooth-down, zoom, circle-open, circle-close, clock, doors-open, pixelate, blur, squeeze. sec is 0.04 to 3, or 0 for the usual length. The first beat has nothing before it, so it cannot have one.
- {"op":"transition","beats":["b4","b7"],"kind":"cut","sec":0}: back to a hard cut.
- {"op":"fade","inSec":0.5,"outSec":1,"color":"black"}: fade the whole video in from, and out to, black or white. 0 turns that end off, and an end you are not changing keeps the length the settings give it.
- {"op":"jcut","beats":["b5"],"sec":0.3}: a J cut into b5. Its sound starts on time but the picture before stays 0.3 s longer, so the next line is heard before it is seen. Coming back from B-roll to the speaker, this reads naturally.
- {"op":"lcut","beats":["b5"],"sec":0.3}: an L cut into b5. Its picture comes in 0.3 s early, under the end of the sound before. Going into B-roll, the cutaway leads the words it shows.
- {"op":"lcut","beats":["b5"],"sec":0}: picture and sound cut together again (also for jcut). A beat has a transition or a J or L cut, not both; setting one replaces the other.
- {"op":"speed","beats":["b6"],"speed":2,"ramp":{"inSec":0,"outSec":0},"of":""}: play a beat faster or slower, from 0.25 to 4; a voice keeps its pitch. "of":"" changes what the beat shows: its cutaway when it has one, otherwise the beat itself; "of":"beat" always changes the beat, "of":"cutaway" only its cutaway (a cutaway changing on its own leaves the voice under it as recorded). Speed 1 plays it as recorded again.
- {"op":"speed","beats":["b6"],"speed":0.5,"ramp":{"inSec":0.4,"outSec":0.4},"of":""}: a speed ramp, easing from full speed into 0.5 over 0.4 s and back to full speed over the last 0.4 s. A ramp of 0 and 0 changes the speed at once.
- {"op":"freeze","beat":"b6","word":"w40","sec":1}: hold the picture where w40 ends for 1 s while the sound waits; everything after starts 1 s later. sec 0 removes it.
- {"op":"reverse","beats":["b6"],"on":true,"of":""}: play a beat backwards, or the cutaway it shows, "of" as for speed. A beat played backwards has no captions. on false plays it forwards again.
- {"op":"camera","beats":["b4"],"kind":"push-in","zoom":0,"to":[],"word":"","sec":0,"regions":[],"of":""}: a camera move over a beat, or over the cutaway it shows (a card stays still), "of" as for speed. Kinds: push-in, pull-out, drift (a slow creep in over the whole beat), ken-burns (a slow zoom and drift across a still), pan-left, pan-right, pan-up, pan-down, punch-in, shake, focus. "zoom" sets how close it gets, from 1 to 3, or 0 for the usual. "to" centres the move on a point, as fractions of the picture: [0.5,0.3], or [] for the middle. "sec" is how long a punch-in, shake or focus glide takes, or 0 for the usual.
- {"op":"camera","beats":["b4"],"kind":"punch-in","zoom":1.2,"to":[],"word":"w31","sec":0,"regions":[],"of":""}: a quick eased punch-in landing on a word in the beat; a shake can land on a word the same way. "word":"" starts it with the beat.
- {"op":"camera","beats":["b4"],"kind":"focus","zoom":0,"to":[],"word":"","sec":0,"regions":[{"at":0,"x":0.1,"y":0.2,"w":0.3,"h":0.25}],"of":""}: glide in on a region of a screen recording at "at" seconds into the beat; x, y, w and h are fractions of the recording.
- {"op":"camera","beats":["b4"],"kind":"none","zoom":0,"to":[],"word":"","sec":0,"regions":[],"of":""}: hold the frame still again.
- {"op":"voice","polish":0.6}: clean up the voice: rumble, hiss and harsh esses out, levels evened, presence lifted. 0 leaves it as recorded, 1 is the most.
- {"op":"music","path":"","set":[{"key":"levelDb","value":-15},{"key":"duckDb","value":12}],"off":false}: change the music bed, naming only the settings that change: levelDb is how far it sits under the voice (-40 to 0), duckDb how much further it dips while anyone speaks (0 to 30, 0 never dips), fadeInSec and fadeOutSec its fades, inSec where in the track it starts. "path" stays "" unless the request names a file to use. "off":true takes the music out.
- {"op":"look","name":"warm","set":[],"replace":true,"off":false}: a look over the whole picture, under the captions. The named looks are clean (true colour, crisper), warm, cool, cinematic and vintage, with these settings: ${NAMED_LIST}. "name" starts from one of them, or stays "". "set" names only the settings that change: [{"key":"grain","value":0.2}]. Settings: exposure in stops (-2 to 2), contrast, saturation, temperature (warmer above 0) and tint (magenta above 0) from -1 to 1, lift (faded blacks), sharpen, vignette and grain from 0 to 1; 0 takes one away. "replace":false changes the look already there, true starts afresh. "off":true takes the whole look off and a LUT with it; a LUT itself is chosen by the person with /lut.
- {"op":"sfx","beats":["b4"],"kind":"whoosh","word":"","gainDb":0}: a sound effect, made here, on a beat: whoosh (peaks in the middle of the transition the beat comes in with, or on its cut), hit (on the cut), riser (ends where the beat comes in), and pop, click or ding (on the cut, or on a word with "word":"w31"). "gainDb" turns one up or down from its usual level (-30 to 12), 0 for the usual. "kind":"none" takes a beat's sounds away. The person's own sound files are added with /sfx.
- {"op":"chapters","set":[{"beat":"b1","title":"Why I switched"},{"beat":"b7","title":"Battery life"},{"beat":"b12","title":"Camera"}]}: YouTube chapters, each starting at a beat; the first plays from 0:00 whatever its beat. YouTube shows them only with three or more, each at least 10 s long, so chapters closer than that are dropped. The set replaces every chapter there is; {"op":"chapters","set":[]} takes them out.
- {"op":"angle","beats":["b4"],"source":"s2","layout":"full"}: another camera of the same take on beats: "full" shows it instead of the recording, "pip" in a box over it, "side" beside it. The sound stays the recording's. Only a source the transcript marks camera-of the beat's recording; "source":"" shows the beat's own recording again.
- {"op":"sync","source":"s2","of":"s1","offsetSec":1.25}: lines a camera up with its recording: what s1 shows at t, s2 shows at t + offsetSec. Only when asked to move it; "of":"" takes the camera out of the edit.
- {"op":"reframe","on":true}: cropped to a narrower frame (a wide recording made vertical), the picture follows the speaker instead of keeping the middle; false keeps the middle. It follows recordings the transcript marks speaker="found"; for any other, say /reframe finds the speaker.
- {"op":"framing","beats":["b4"],"x":0.25}: frames beats by hand when cropped: 0 is the recording's left edge, 0.5 its middle, 1 its right; -1 follows the speaker again.
- {"op":"grid","beats":["b4"],"panels":[{"show":"","label":"Raw","inSec":0},{"show":"a2","label":"Edited","inSec":0}],"sound":""}: shows a beat as two to four videos at once, side by side on a soft ground, each with a small label (one to three words, or ""). "show":"" is the beat's own picture; otherwise a recording (s2) or material (a2) by id, from inSec seconds into it. "sound":"" keeps the beat's own sound, "1" to "4" plays that panel's instead, "music" leaves only the music. "panels":[] takes the grid away.
- {"op":"fill","mode":"black"}: how a picture of another shape than the frame fills it. "auto" is what a new edit does unless asked: a picture taller than the frame (an upright phone clip in a wide video), a still or a screen recording shows whole on a blurred copy of itself, and other footage is cropped to fill the frame, as Shorts and Reels expect. "blur" shows every picture of another shape whole on a blurred copy, "black" between black bars, "crop" cropped to fill the frame. Someone talking whose recording is wider than the frame is always cropped to them.
Ops apply in order, and a later op sees the ids an earlier split created. Use only ids that exist. If a split creates a beat, the new id is the next number after the highest beat id.

${graphicsGuide()}

${fxGuide()}

## How to edit
- Do exactly what was asked and nothing else. A note about one moment changes that moment.
- A <chat> block, when present, is what was said just before the request: read a short answer ("yes", "the second one", a button's words) in its light.
- "This", "here" and "that bit" in a note mean the beat the note was left on.
- A note left on a stretch ("on b3 to b6 only") is about those beats alone, and "this" means all of them: change nothing outside them, nothing that changes the whole video (a look, music, captions, the shape), and when it cannot be done inside them, make no op for it and say why in reply.
- To open on a stronger line, move the beat that holds it to position 0; if it sits inside a long beat, split it out first.
- Keep sentences whole unless asked to cut inside one. Never strike the only words of a beat; remove the beat instead.
- If a request needs footage, a file or a decision you do not have, make no op for it and say what you need in needs, one full sentence for each.
- If nothing can be done, return no ops and say why in reply.
- Hard cuts are the default. Add a transition only where it is asked for, or at a change of section when asked to "add transitions"; between a talking head and B-roll a dissolve or a short push reads cleanest. Never put one on every beat unless asked.
- Camera moves keep stills and long held shots alive: a ken-burns or drift on a product still, a drift on a long talking beat. Put a move on fewer than half the beats unless asked, and never two kinds in a row on the same picture.
- Add sound effects only when asked, sparingly: a whoosh through a whip or push transition, a hit on a hard cut to something new, a riser into a new section, a pop on a big word. Never one on every cut.
- Switch to another camera only when asked, or when asked for variety: at a change of thought, never mid-sentence, and back to the recording often enough that it stays the main view. "pip" and "side" suit a reaction or a second person.
- Show videos in a grid only when asked, or when the words set finished videos or takes side by side ("here are four edits of the same clip"). A grid covers its whole beat, as a cutaway does, so split first and give it only the words that show them.
- Make chapters only when asked. Start one where the subject changes, and name it in two to five words for what that part is about, never a whole sentence.
- Leave the colour alone unless asked. For tech and product videos, "clean" keeps colour true; save warm, cool, cinematic and vintage for when someone asks for a mood.
- Leave speed alone unless asked. Someone talking sped past 1.25 is hard to follow; slow motion and speed ramps belong on footage without speech, such as a cutaway of a product turning or hands at work.

## Cutalong's commands
Besides edit ops, a plan can run Cutalong's own commands: the ones the person can type after a slash, and a few with arguments of their own. They go in "ops" with the edit ops, and every step runs in the order listed, so put an op that names beats or words before a command that reshapes the cut (a preset with takes or pacing, a length, a take), and settings for the whole video after it.
${teachCommands()}
A preset (tighten, snappy, shorts, captions, hook, fade, the looks, the person's saved styles, their brand) applies its whole style, so use it when the request is what it does, and change what it sets with ops after it ("a Short with captions at the top": run shorts, then a captions op). A command that acts on the beat under the playhead acts on the whole video in a plan, or for a note on the beat or stretch the note was left on; to change one moment, use the ops.
Cut a part by what it is yourself, with remove or strike and its "why", and leave the length of the whole video to the length command, after those cuts. When the cut says it is a vlog told as a story, asks of the story (a length, what it opens on, more or less of a place or a part of the day) are the vlog command's, with the person's words. Opening the edit in Premiere is {"op":"run","command":"premiere","rest":"","note":""}, and every finishing touch at once is {"op":"run","command":"all","rest":"","note":""}.

## When to ask
Read the whole request and do every part of it you can, in one plan. When a part could mean two different things and the wrong one would cost the person (an export, footage fetched, a lot of cutting, their time), ask about that part instead: one short question in "question" with two to four options, each a complete ask in the person's words, because an option is sent as their next message ("Make the picture warmer", "Make the music warmer"). Make no step for that part, do the parts that are clear, and leave "question" with an empty text and no options when there is nothing to ask. Never ask about something cheap to undo, and never ask twice about the same thing.

## Takes
A <takes> block, when present, lists lines said more than once in the raw footage: each take with its word ids, whether it plays or is struck, and what went wrong in it. Cutalong keeps the last complete take unless an earlier one is clearly cleaner. To use another take ("use the second take of the intro"), use the take command with the line's id and the take's number: it plays that take where the line plays. Never strike the take that plays without bringing another one back. False starts listed there are struck already; unstrike one only when asked.

## Players' views
A <povs> block, when present, says the edit is one gaming session several players recorded: each view by id, the person's own first (the edit's recording and sound), and the reactions heard in each, whose and when. Whose view a moment shows is the povs step's: follow whoever is talking, stay on theirs and cut to the others for reactions, everyone at once where they all react, or theirs throughout. To show one view on particular beats, use the angle op with that view's id; for everyone at once on a moment, a grid op with "" for theirs and each view's id, labelled as the block names them; a view's panel plays in step with the moment, whatever its inSec.

## Sound
A <sound> block, when present, lists stretches that are not speech (laughter, music, applause, noise) with their times in the recording, and words said with stress. A laugh or a noise between takes is a break, music under speech is not yours to cut, and a stressed word is a good big word.

## The creator's brand
A <brand-voice> block, when present, is the creator's own description of how their edits should feel. Follow it wherever it applies to the request; it never overrides the request itself.
A <brand-logos> block names the creator's own logos: their products and channel. A logo pop shows one when a row's label is its name.
A <never-on-this-channel> block lists what this channel never uses. Make no op that adds any of it, even when asked; say in the reply, in one sentence, that the channel never uses it and that the never list on the Brand page changes that. Taking one of them out of the cut is fine. When B-roll from outside is on the list, leave brollWanted empty.

## How this creator edits
A <creator-preferences> block, when present, lists what has been learned from how this creator edits: what they ask for again and again, undo, and keep, each with how often. Lean on it where the request leaves a choice open; it never overrides the request or the brand voice.
A <channel-habits> block, when present, says how this channel's finished videos usually run, measured from their own videos: how long each format is, how fast they talk, how long their first sentence takes, which fillers they cut and keep, and how their long videos end. When the person asks for a format without saying how long ("turn this into a short"), aim for that format's usual length: run its preset, then a length step with targetSec at the "about" length the block gives for it. A length the person asks for always wins, as does anything else in the request. Where the request leaves the rest open, keep to these habits.

## How to write
Write as a helpful editor sitting next to the person: first person, plain words, exact numbers. No exclamation marks, no emoji, no praise. Never call this cloning or copying anyone. The summary is one sentence about what changed in this version ("The hook line opens it now and the ending stays on you."). The reply is at most two sentences.
Never write an id (w12, s2w4, b3, s1, a2) in the summary, the reply or needs; the person never sees them. Name a moment by what is said in it ("the line about the battery"), a recording by its file name, and material by its title.`

/** What the planner returns. Lenient on purpose: every op is checked against the real op schema afterwards, one by one. */
const TreatmentSet = z.object({
  frame: z.enum(['speaker', 'broll', 'split', 'card']).optional(),
  bw: z.boolean().optional(),
  zoom: z.number().optional(),
  bigWord: z.string().nullable().optional(),
  /** Material by id; offerPlan turns it into the file and keeps it muted. */
  broll: z.object({ asset: z.string(), inSec: z.number() }).nullable().optional(),
  captions: z.boolean().optional()
})

/** The graphics the planner can make: every built template but hand-built layers. */
const GRAPHIC_KINDS = templates()
  .map((t) => t.kind)
  .filter((k) => k !== 'layers') as [string, ...string[]]

// Made fresh for each op: shared schema objects come out as $refs in the JSON schema.
const graphicSlots = () => ({
  from: z.string(),
  to: z.string(),
  text: z.array(z.string()),
  items: z.array(
    z.object({ label: z.string(), value: z.string(), note: z.string(), mark: z.string(), at: z.string() })
  ),
  values: z.array(z.number()),
  box: z.array(z.number()),
  icon: z.string(),
  style: z.string(),
  place: z.string(),
  color: z.string(),
  fx: z.array(z.string())
})

/** How a beat shows another camera, in the beat lines. */
const ANGLE_WORDS = { full: 'instead', pip: 'in a box', side: 'beside it' } as const

/** The music bed's settings, as the planner names them. */
const MUSIC_SETTINGS = ['levelDb', 'duckDb', 'inSec', 'fadeInSec', 'fadeOutSec'] as const

export const PlannerOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('remove'), beats: z.array(z.string()), why: z.string() }),
  z.object({ op: z.literal('strike'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('unstrike'), from: z.string(), to: z.string() }),
  z.object({ op: z.literal('move'), beat: z.string(), to: z.number() }),
  z.object({ op: z.literal('split'), beat: z.string(), at: z.string() }),
  z.object({ op: z.literal('join'), beat: z.string() }),
  z.object({
    op: z.literal('insert'),
    to: z.number(),
    beat: z.object({ source: z.string(), from: z.string(), to: z.string() })
  }),
  z.object({ op: z.literal('treat'), beats: z.array(z.string()), set: TreatmentSet }),
  z.object({
    op: z.literal('captions'),
    set: z.object({
      on: z.boolean().optional(),
      wordsPerScreen: z.number().optional(),
      position: z.enum(['top', 'middle', 'chest', 'bottom']).optional(),
      uppercase: z.boolean().optional(),
      preset: z.enum(['clean', 'hierarchy', 'boxed']).optional()
    })
  }),
  z.object({
    op: z.literal('tighten'),
    set: z.object({ maxGapSec: z.number(), padSec: z.number(), fillers: z.boolean() }).nullable()
  }),
  z.object({ op: z.literal('aspect'), aspect: z.enum(['vertical', 'wide', 'square', 'original']) }),
  z.object({ op: z.literal('loudness'), lufs: z.number().nullable() }),
  // The editing ops fill every slot too, for the same limits: 0, '' or [] is
  // the usual (fromPlannerOp turns them into the ops themselves), and settings
  // that change one at a time are a list of the ones that change.
  z.object({
    op: z.literal('transition'),
    beats: z.array(z.string()),
    kind: z.enum(['cut', ...TRANSITION_KINDS]),
    sec: z.number()
  }),
  z.object({ op: z.literal('fade'), inSec: z.number(), outSec: z.number(), color: z.enum(['black', 'white']) }),
  z.object({ op: z.literal('jcut'), beats: z.array(z.string()), sec: z.number() }),
  z.object({ op: z.literal('lcut'), beats: z.array(z.string()), sec: z.number() }),
  z.object({
    op: z.literal('speed'),
    beats: z.array(z.string()),
    speed: z.number(),
    ramp: z.object({ inSec: z.number(), outSec: z.number() }),
    of: z.enum(['', 'beat', 'cutaway'])
  }),
  z.object({ op: z.literal('freeze'), beat: z.string(), word: z.string(), sec: z.number() }),
  z.object({
    op: z.literal('reverse'),
    beats: z.array(z.string()),
    on: z.boolean(),
    of: z.enum(['', 'beat', 'cutaway'])
  }),
  z.object({ op: z.literal('voice'), polish: z.number() }),
  z.object({
    op: z.literal('sfx'),
    beats: z.array(z.string()),
    kind: z.enum([...SFX_KINDS, 'none']),
    word: z.string(),
    gainDb: z.number()
  }),
  z.object({ op: z.literal('chapters'), set: z.array(z.object({ beat: z.string(), title: z.string() })) }),
  z.object({ op: z.literal('angle'), beats: z.array(z.string()), source: z.string(), layout: z.enum(ANGLE_LAYOUTS) }),
  z.object({ op: z.literal('sync'), source: z.string(), of: z.string(), offsetSec: z.number() }),
  z.object({ op: z.literal('reframe'), on: z.boolean() }),
  z.object({ op: z.literal('framing'), beats: z.array(z.string()), x: z.number() }),
  z.object({ op: z.literal('fill'), mode: z.enum(FILL_MODES) }),
  z.object({
    op: z.literal('look'),
    name: z.enum(['', ...Object.keys(NAMED_LOOKS)]),
    set: z.array(z.object({ key: z.enum(LOOK_SETTINGS), value: z.number() })),
    replace: z.boolean(),
    off: z.boolean()
  }),
  z.object({
    op: z.literal('music'),
    path: z.string(),
    set: z.array(z.object({ key: z.enum(MUSIC_SETTINGS), value: z.number() })),
    off: z.boolean()
  }),
  z.object({
    op: z.literal('camera'),
    beats: z.array(z.string()),
    kind: z.enum([...CAMERA_KINDS, 'none']),
    zoom: z.number(),
    to: z.array(z.number()),
    word: z.string(),
    sec: z.number(),
    regions: z.array(z.object({ at: z.number(), x: z.number(), y: z.number(), w: z.number(), h: z.number() })),
    of: z.enum(['', 'beat', 'cutaway'])
  }),
  // Graphics. Every slot is required, so the schema spends nothing from the
  // structured-output limits on optional or union-typed parameters; an empty
  // slot means the template's default (or, in an update, no change).
  z.object({
    op: z.literal('grid'),
    beats: z.array(z.string()),
    panels: z.array(z.object({ show: z.string(), label: z.string(), inSec: z.number() })),
    sound: z.enum(['', 'music', '1', '2', '3', '4'])
  }),
  z.object({ op: z.literal('motion-add'), kind: z.enum(GRAPHIC_KINDS), ...graphicSlots() }),
  z.object({ op: z.literal('motion-update'), id: z.string(), ...graphicSlots() }),
  z.object({ op: z.literal('motion-remove'), ids: z.array(z.string()) }),
  // Scene effects (shared/fx/planner), every slot required in the same way.
  ...FX_PLANNER_OPS,
  // Cutalong's own commands (shared/plan/commands.ts), run by the editor in the order given.
  ...planCommandSchemas()
])

export const PlanSchema = z.object({
  ops: z.array(PlannerOpSchema),
  /** One sentence for the version: what changed. */
  summary: z.string(),
  /** At most two sentences back to the person. */
  reply: z.string(),
  /** Ids of the notes these ops carry out. */
  notesHandled: z.array(z.string()),
  /** What could not be done without more from the person. */
  needs: z.array(z.string()),
  /** Moments that want B-roll the material does not have, with a search that would find it. */
  brollWanted: z.array(z.object({ beat: z.string(), search: z.string() })).optional(),
  /** One short question instead of guessing at a costly part, with answers that are sent as words; an empty text asks nothing. */
  question: z.object({ text: z.string(), options: z.array(z.string()) })
})
export type Plan = z.infer<typeof PlanSchema>
export type PlannerOp = z.infer<typeof PlannerOpSchema>

/** Settings named one at a time, as the fields of a change. */
const fieldsOf = (set: { key: string; value: number }[]): Record<string, number> =>
  Object.fromEntries(set.map((s) => [s.key, s.value]))

/**
 * An op as the planner writes it, as the edit takes it: the usual 0, '' and []
 * left out, settings named one at a time turned into fields, and "none" or
 * off taking a thing away. Everything else is the op as it is, and applyOps
 * checks each one against the real op schema.
 */
export function fromPlannerOp(op: PlannerOp): unknown {
  const of = 'of' in op && op.of ? { of: op.of } : {}
  switch (op.op) {
    case 'remove':
      return { op: op.op, beats: op.beats, ...(op.why.trim() ? { why: op.why.trim() } : {}) }
    case 'transition':
      return { op: op.op, beats: op.beats, kind: op.kind, ...(op.sec > 0 ? { sec: op.sec } : {}) }
    case 'speed': {
      const eased = op.ramp.inSec > 0 || op.ramp.outSec > 0
      return { op: op.op, beats: op.beats, speed: op.speed, ramp: eased ? op.ramp : null, ...of }
    }
    case 'reverse':
      return { op: op.op, beats: op.beats, on: op.on, ...of }
    case 'sfx': {
      if (op.kind === 'none') return { op: op.op, beats: op.beats, add: null }
      const add = { kind: op.kind, ...(op.word ? { word: op.word } : {}), ...(op.gainDb ? { gainDb: op.gainDb } : {}) }
      return { op: op.op, beats: op.beats, add }
    }
    case 'chapters':
      return { op: op.op, set: op.set.length > 0 ? op.set : null }
    case 'angle':
      return { op: op.op, beats: op.beats, source: op.source || null, layout: op.layout }
    case 'sync':
      return op.of ? op : { op: op.op, source: op.source, of: null }
    case 'framing':
      return { op: op.op, beats: op.beats, x: op.x >= 0 && op.x <= 1 ? op.x : null }
    case 'grid':
      return { op: 'treat', beats: op.beats, set: { grid: plannedGrid(op) } }
    case 'look': {
      if (op.off) return { op: op.op, set: null }
      // A named look comes with its own settings; what the planner names goes over them.
      const named = op.name ? NAMED_LOOKS[op.name]?.look : undefined
      return { op: op.op, set: { ...named, ...fieldsOf(op.set) }, ...(op.replace ? { replace: true } : {}) }
    }
    case 'music':
      if (op.off) return { op: op.op, set: null }
      return { op: op.op, set: { ...(op.path ? { path: op.path } : {}), ...fieldsOf(op.set) } }
    case 'camera': {
      if (op.kind === 'none') return { op: op.op, beats: op.beats, move: null, ...of }
      const move = {
        kind: op.kind,
        ...(op.zoom > 0 ? { zoom: op.zoom } : {}),
        ...(op.to.length >= 2 ? { to: { x: op.to[0], y: op.to[1] } } : {}),
        ...(op.word ? { word: op.word } : {}),
        ...(op.sec > 0 ? { sec: op.sec } : {}),
        ...(op.regions.length > 0 ? { regions: op.regions } : {})
      }
      return { op: op.op, beats: op.beats, move, ...of }
    }
    case 'fx-add':
    case 'fx-update':
    case 'fx-remove':
      return fromFxPlannerOp(op)
    default:
      return op
  }
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Safe inside a double-quoted attribute. */
const attr = (text: string): string => text.replace(/["<>]/g, '')

const time = (sec: number): string => {
  const m = Math.floor(sec / 60)
  const s = sec - m * 60
  return `${m}:${s.toFixed(1).padStart(4, '0')}`
}

/** The source transcript with ids, in reading order: the cacheable part of the request. */
export function renderTranscript(doc: EditDoc): string {
  const lines: string[] = []
  for (const source of doc.sources) {
    const sound = source.audio ? ` sound="${attr(fileName(source.audio.path))}"` : ''
    // Another camera of a recording has no words of its own: the edit shows it on the recording's beats.
    const angle = (currentCut(doc).angles ?? []).find((a) => a.source === source.id)
    const camera = angle ? ` camera-of="${angle.of}" offset="${angle.offsetSec.toFixed(2)}"` : ''
    const found = source.subject ? ' speaker="found"' : ''
    lines.push(
      `<source id="${source.id}" file="${attr(fileName(source.path))}" length="${clock(source.durationSec)}"${sound}${camera}${found}>`
    )
    const words = doc.words.filter((w) => w.source === source.id)
    // One line per sentence keeps it readable without losing a single id.
    let line: string[] = []
    let start = words[0]?.startSec ?? 0
    for (const w of words) {
      if (line.length === 0) start = w.startSec
      line.push(`${w.id} ${w.text}`)
      if (/[.!?]["')\]]*$/.test(w.text) || line.length >= 24) {
        lines.push(`[${time(start)}] ${line.join(' | ')}`)
        line = []
      }
    }
    if (line.length) lines.push(`[${time(start)}] ${line.join(' | ')}`)
    lines.push('</source>')
  }
  // Who spoke off camera is a fact about the footage, so it is cached with it.
  const offCamera = offCameraLine(doc)
  if (offCamera) lines.push(offCamera)
  return lines.join('\n')
}

/**
 * The takes Cutalong found, one line per line said more than once, and the
 * false starts it struck. Compact on purpose: ids and a few words each.
 */
export function renderTakes(doc: EditDoc): string {
  const cut = currentCut(doc)
  const struck = new Set(cut.removed)
  const lines: string[] = []
  const starts: string[] = []
  for (const a of takesOf(doc)) {
    for (const g of a.groups) {
      const playing = playingTake(g, cut)
      const takes = g.takes.map((t, i) => {
        const state = struck.has(t.from) && struck.has(t.to) ? 'struck' : i === playing ? 'plays' : 'partly struck'
        const issues: string[] = [...new Set(t.issues.filter((x) => x !== 'filler'))]
        const fillers = t.issues.filter((x) => x === 'filler').length
        if (fillers) issues.push(fillers === 1 ? 'a filler' : `${fillers} fillers`)
        return `${i + 1} ${t.span.from}-${t.span.to} ${state}${issues.length ? `, ${issues.join(', ')}` : ''}`
      })
      lines.push(`${g.id} ${lineName(g)}, ${g.takes.length} takes: ${takes.join(' | ')}`)
    }
    for (const r of a.restarts) {
      if (struck.has(r.from) && struck.has(r.to)) starts.push(`${r.from}-${r.to} before "${r.repeated}"`)
    }
  }
  if (lines.length === 0 && starts.length === 0) return ''
  if (starts.length) lines.push(`false starts struck: ${starts.join('; ')}`)
  return `<takes>\n${lines.join('\n')}\n</takes>`
}

/** "the 2nd take", for replies and the takes panel. */
export function takeName(n: number): string {
  return `the ${ordinal(n)} take`
}

/** A slash command as the planner sees it in <commands>: its name and the summary the slash menu shows. */
export interface CommandLine {
  command: string
  summary: string
}

/**
 * The slash commands there are, the person's saved styles and brand among
 * them, with what each does: a plan runs any of them by name. It changes
 * only when a style is saved, so it is cached before the transcript.
 */
export function renderCommands(commands: CommandLine[]): string {
  if (commands.length === 0) return ''
  const lines = commands.map((c) => `${c.command}: ${c.summary.replace(/\s+/g, ' ').trim()}`)
  return `<commands>\n${lines.join('\n')}\n</commands>`
}

/** What the request carries besides the cut: the cuts offered, and what was said just before. */
export interface RequestExtra {
  /** Cuts Cutalong offered and the person has not answered, in plain words. */
  offers?: string[]
  /** The last few turns of the chat, oldest first, so a short answer reads in context. */
  chat?: { role: 'user' | 'assistant'; text: string }[]
  /** The person's brands by name, and whether this chat is in each: a plan can switch to another. */
  brands?: { name: string; current: boolean }[]
  /** How the brand's own videos usually run, in a line or two (shared/channel-habits); none until some are learned. */
  habits?: string[]
}

/** The cut as it stands, the notes and the ask: the part that changes every time. */
export function renderRequest(
  doc: EditDoc,
  request: string,
  notes: Note[],
  voice = '',
  preferences: string[] = [],
  logos: string[] = [],
  never: string[] = [],
  extra: RequestExtra = {}
): string {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const timing = new Map(resolved.beats.map((b) => [b.id, b]))
  const index = indexWords(doc.words)
  const struck = new Set(cut.removed)
  const text = (id: string): string => index.words[index.pos.get(id) ?? -1]?.text ?? id
  const byPath = new Map(doc.assets.map((a) => [a.path, a.id]))
  const assetFor = (path: string): string => byPath.get(path) ?? fileName(path)

  const settings = [
    `version ${currentVersion(doc).n}`,
    `runs ${clock(resolved.durationSec)}`,
    `aspect ${cut.aspect}`,
    cut.captions.on
      ? `captions ${cut.captions.wordsPerScreen} at a time, ${cut.captions.position}${cut.captions.uppercase ? ', upper case' : ''}${drawsCaptions(cut.captions) ? `, ${cut.captions.preset}` : ''}`
      : 'captions off',
    cut.tighten
      ? `pauses over ${cut.tighten.maxGapSec} s cut${cut.tighten.fillers ? ', fillers cut' : ''}`
      : 'pauses as recorded',
    cut.loudness === null ? 'loudness as recorded' : `loudness ${cut.loudness} LUFS`
  ]
  // A vlog is told as a story, and asks of its story go to the vlog command.
  if (doc.vlog) settings.push('a vlog told as a story')
  if (cut.voice && cut.voice.polish > 0) settings.push(`voice polish ${cut.voice.polish}`)
  if (cut.look) settings.push(`look ${describeLook(cut.look)}`)
  if (cut.reframe) settings.push('follows the speaker')
  // An edit made before the fill says none, and is cropped.
  const fill = fillMode(cut)
  if (fill === 'black') settings.push('pictures of another shape between black bars')
  else if (fill === 'crop') settings.push('pictures of another shape cropped to fill')
  else if (fill === 'blur') settings.push('every picture of another shape on a blurred copy')
  const chapters = chaptersOf(cut, resolved).chapters
  if (chapters.length) settings.push(`chapters ${chapters.map((c) => `${c.beat} "${c.title}"`).join(', ')}`)
  if (cut.music) {
    const name = cut.music.path.split(/[\\/]/).pop()
    const bpm = cut.music.bpm ? `, ${Math.round(cut.music.bpm)} BPM` : ''
    settings.push(`music ${name}${bpm} at ${cut.music.levelDb} dB under the voice, dipping ${cut.music.duckDb} dB`)
  }
  if (cut.fade && (cut.fade.inSec > 0 || cut.fade.outSec > 0)) {
    const ends = [
      cut.fade.inSec > 0 ? `in over ${seconds(cut.fade.inSec)}` : null,
      cut.fade.outSec > 0 ? `out over ${seconds(cut.fade.outSec)}` : null
    ].filter(Boolean)
    settings.push(`fades ${ends.join(' and ')} through ${cut.fade.color}`)
  }

  const beats = cut.beats.map((beat) => {
    const t = beat.treatment
    const look = [
      t.frame,
      t.bw ? 'bw' : null,
      t.zoom > 1.001 ? `zoom ${t.zoom.toFixed(2)}` : null,
      t.bigWord ? `big word ${t.bigWord}` : null,
      beat.transition ? `comes in with ${beat.transition.kind} ${seconds(beat.transition.sec)}` : null,
      beat.splitEdit ? `${beat.splitEdit.kind.toUpperCase()} cut in, ${seconds(beat.splitEdit.sec)}` : null,
      t.speed !== undefined || t.ramp ? `speed ${describeSpeed(t.speed ?? 1, t.ramp)}` : null,
      t.broll && (t.broll.speed !== undefined || t.broll.ramp)
        ? `cutaway speed ${describeSpeed(t.broll.speed ?? 1, t.broll.ramp)}`
        : null,
      t.freeze ? `freezes on ${t.freeze.word} for ${seconds(t.freeze.sec)}` : null,
      t.reverse ? 'backwards' : null,
      t.broll?.reverse ? 'cutaway backwards' : null,
      t.camera ? `camera ${describeCamera(t.camera)}` : null,
      t.angle ? `shows ${t.angle.source} ${ANGLE_WORDS[t.angle.layout]}` : null,
      typeof t.framing === 'number' ? `framed by hand at ${t.framing}` : null,
      t.captions === false ? 'no captions' : null,
      t.broll?.camera ? `cutaway camera ${describeCamera(t.broll.camera)}` : null,
      t.broll ? `cutaway ${assetFor(t.broll.path)} from ${t.broll.inSec.toFixed(1)} s` : null,
      t.grid ? gridLine(t.grid) : null,
      beat.sfx?.length
        ? `sounds ${beat.sfx.map((s) => `${sfxName(s)}${s.word ? ` on ${s.word}` : ''}`).join(', ')}`
        : null
    ]
      .filter(Boolean)
      .join(', ')
    const r = timing.get(beat.id)
    const at = r ? `${clock(r.outStart)}-${clock(r.outEnd)}` : 'plays nothing'
    if (beat.from === null || beat.to === null) {
      return `${beat.id} [${at}] ${look} | held shot ${beat.inSec?.toFixed(1)}-${beat.outSec?.toFixed(1)} s of ${beat.source}`
    }
    const a = index.pos.get(beat.from) ?? 0
    const b = index.pos.get(beat.to) ?? a
    const struckHere = index.words
      .slice(a, b + 1)
      .filter((w) => struck.has(w.id))
      .map((w) => w.id)
    const said = `${beat.from}-${beat.to} "${text(beat.from)} ... ${text(beat.to)}"`
    return `${beat.id} [${at}] ${look} | ${said}${struckHere.length ? ` | struck ${struckHere.join(' ')}` : ''}`
  })

  const parts = [`<cut ${settings.join('; ')}>`, ...beats, '</cut>']
  const graphics = graphicsLines(cut, resolved, doc.words)
  if (graphics.length > 0) parts.push('<graphics>', ...graphics, '</graphics>')
  const effects = fxLines(cut, resolved, doc.words)
  if (effects.length > 0) parts.push('<effects>', ...effects, '</effects>')
  if (doc.assets.length > 0) {
    // Where each piece already shows, so the planner neither repeats nor forgets one.
    const shows = new Map<string, string[]>()
    for (const beat of cut.beats) {
      const id = beat.treatment.broll ? byPath.get(beat.treatment.broll.path) : undefined
      if (id) shows.set(id, [...(shows.get(id) ?? []), beat.id])
      for (const p of beat.treatment.grid?.panels ?? [])
        if (doc.assets.some((a) => a.id === p.show)) shows.set(p.show, [...(shows.get(p.show) ?? []), beat.id])
    }
    // A picture a graphic shows is shown by that graphic.
    for (const m of cut.motion ?? [])
      for (const id of template(m.kind)?.pictures?.(m) ?? []) shows.set(id, [...(shows.get(id) ?? []), m.id])
    parts.push('<material>')
    for (const a of doc.assets) {
      const size = a.width && a.height ? ` ${a.width}x${a.height}` : ''
      const length = a.durationSec ? `, ${a.durationSec.toFixed(1)} s` : ''
      const where = shows.get(a.id)
      // A picture far taller than wide is a page: it goes in a screenshot graphic, not a cutaway.
      const page = a.kind === 'image' && a.width && a.height && a.height > a.width * 1.6 ? ', a page' : ''
      parts.push(
        `${a.id} ${a.kind}${size}${length}${page}: ${a.title}${where ? ` | shown on ${where.join(' ')}` : ' | not in the cut yet'}`
      )
    }
    parts.push('</material>')
  }
  const takes = renderTakes(doc)
  if (takes) parts.push(takes)
  // What was cut on request and is still out, by the name it went under, for "bring back …".
  const held = cutOnRequest(doc)
  if (held.length) parts.push(`<cut-on-request>\n${held.join('\n')}\n</cut-on-request>`)
  const offers = (extra.offers ?? []).map((o) => o.trim()).filter(Boolean)
  if (offers.length) parts.push(`<offers>\n${offers.join('\n')}\n</offers>`)
  // Another brand only when there is one to switch to.
  const brands = (extra.brands ?? []).filter((b) => b.name.trim())
  if (brands.length > 1)
    parts.push(`<brands>\n${brands.map((b) => `${b.name.trim()}${b.current ? ' (this chat)' : ''}`).join('\n')}\n</brands>`)
  for (const source of doc.sources) {
    const map = doc.audio?.[source.id]
    const sound = map ? renderSound(map, text) : ''
    if (sound) parts.push(sound)
  }
  // Several players' views of one session, and the reactions heard in them (shared/pov).
  const povs = renderPovs(doc)
  if (povs) parts.push(povs)
  if (notes.length > 0) {
    parts.push('<notes>')
    for (const note of notes) {
      // A note on a stretch picked on the strip is about its beats only, or what is left of them.
      const picked = noteBeats(cut, note.range)
      const times = picked.length ? rangeTimes(resolved, picked) : null
      const where =
        picked.length && times
          ? ` (on ${picked.length === 1 ? picked[0] : `${picked[0]} to ${picked[picked.length - 1]}`} only, ${clock(times.start)}-${clock(times.end)})`
          : note.beat
            ? ` (left on ${note.beat})`
            : ''
      parts.push(`${note.id}${where}: ${note.text}`)
    }
    parts.push('</notes>')
  }
  // The creator's own words about how their edits should feel.
  if (voice.trim()) parts.push(`<brand-voice>\n${voice.trim()}\n</brand-voice>`)
  const own = logos.map((l) => l.trim()).filter(Boolean)
  if (own.length) parts.push(`<brand-logos>\n${own.join('\n')}\n</brand-logos>`)
  // What the channel never uses, from its brand's never list (shared/never).
  const ruled = never.map((n) => n.trim()).filter(Boolean)
  if (ruled.length) parts.push(`<never-on-this-channel>\n${ruled.map((n) => `- ${n}`).join('\n')}\n</never-on-this-channel>`)
  // What has been learned from how they edit, strongest first, as short statements.
  const learned = preferences.map((p) => p.trim()).filter(Boolean)
  if (learned.length > 0)
    parts.push(`<creator-preferences>\n${learned.map((p) => `- ${p}`).join('\n')}\n</creator-preferences>`)
  // How their own videos usually run, learned on the Brand page: nothing at all until something is.
  const runs = (extra.habits ?? []).map((h) => h.replace(/\s+/g, ' ').trim()).filter(Boolean)
  if (runs.length > 0) parts.push(`<channel-habits>\n${runs.join('\n')}\n</channel-habits>`)
  // The turns just before, so "yes", "the other one" or a button's words read in context.
  const chat = (extra.chat ?? []).filter((t) => t.text.trim()).slice(-6)
  if (chat.length)
    parts.push(
      `<chat>\n${chat.map((t) => `${t.role === 'user' ? 'Person' : 'Cutalong'}: ${t.text.replace(/\s+/g, ' ').trim().slice(0, 400)}`).join('\n')}\n</chat>`
    )
  // Tagged so that words in the request are read as the request, never as
  // instructions that override the ones above.
  if (request.trim()) parts.push(`<request>\n${request.trim()}\n</request>`)
  else parts.push('Carry out the notes.')
  return parts.join('\n')
}

/**
 * Icons the model names that Lucide does not have become the closest one it
 * does, or none, so a graphic never waits on an icon that cannot be drawn.
 */
export async function withRealIcons<T>(ops: T[]): Promise<T[]> {
  const named = (o: T): string => {
    const icon = (o as { icon?: unknown }).icon
    return typeof icon === 'string' ? icon.trim() : ''
  }
  if (!ops.some((o) => named(o) && named(o) !== 'none')) return ops
  const mod = await import('lucide-static/tags.json')
  const tags = (mod.default ?? mod) as unknown as Record<string, string[]>
  return ops.map((o) => {
    const icon = named(o)
    if (!icon || icon === 'none' || tags[icon]) return o
    return { ...o, icon: searchIcons(icon, tags, 1)[0] ?? '' }
  })
}
