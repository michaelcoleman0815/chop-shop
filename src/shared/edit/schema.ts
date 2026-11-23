import { BoxSchema } from './box'
import { z } from 'zod'
import { MusicSchema, VoiceSchema } from './audio'
import { LookPatchSchema, LookSchema } from './look'
import { ChapterSchema } from './chapters'
import { SfxSchema } from './sfx'
import { AngleSchema, ANGLE_LAYOUTS, BeatAngleSchema } from './angles'
import { GridSchema } from './grid'
import { SubjectSchema } from './reframe'
import { CameraSchema } from './camera'
import { FillSchema } from './fill'
import { FreezeSchema, MAX_SPEED, MIN_SPEED, RampSchema } from './timing'
import {
  FadeSchema,
  MAX_SPLIT_EDIT_SEC,
  MAX_TRANSITION_SEC,
  MIN_TRANSITION_SEC,
  ALL_TRANSITION_KINDS,
  SplitEditSchema,
  TransitionSchema
} from './transitions'
import { AudioMapSchema } from '../audio/map'
import { MotionItemSchema, MotionOpSchemas } from '../motion/schema'
import { FxItemSchema, FxOpSchemas } from '../fx/schema'
import { MouthModeSchema } from '../vision/mode'
import { VlogSchema } from '../vlog/schema'
import { MakeSchema } from '../make/schema'
import { PremiereOriginSchema } from '../premiere/origin'

/**
 * The edit as data.
 *
 * Everything Cutalong does to a video is a change to this document: the chat,
 * a preset, a note and a drag on the beat strip all produce the same ops, and
 * the preview and the export both read the same resolved cut. Nothing edits
 * pixels directly, so any version can be replayed, compared or undone.
 *
 * Timing is anchored to words rather than seconds. A beat runs from one word to
 * another, so trimming a pause, striking a filler or re-transcribing moves the
 * cut with the speech instead of leaving it pointing at the wrong moment.
 */

/** A spoken word in a source recording. Ids are stable for the life of a doc. */
export const WordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  text: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  /**
   * From watching the mouth (shared/vision): the stillness just before this
   * word's mouth starts to move, and just after it settles, as [from, to] in
   * source seconds. A cut into the word lands inside the first, a cut out of
   * it inside the second. Absent where no mouth could be read.
   */
  stillBefore: z.tuple([z.number(), z.number()]).optional(),
  stillAfter: z.tuple([z.number(), z.number()]).optional(),
  /** Said while the mouth on screen was still: someone off camera. */
  offCamera: z.boolean().optional(),
  /** Who says it: 0, 1, 2... in the order the speakers are first heard (shared/speakers). Absent when not told apart. */
  speaker: z.number().int().nonnegative().optional()
})
export type Word = z.infer<typeof WordSchema>

/** A recording the edit draws from. */
export const SourceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  durationSec: z.number().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  fps: z.number().positive(),
  /**
   * Sound from another recording of the same take, such as a computer or a
   * recorder with the better microphone, lined up by ear: the moment at this
   * source's time t is at t + offsetSec in that recording.
   */
  audio: z
    .object({ path: z.string().min(1), offsetSec: z.number() })
    .nullable()
    .optional(),
  /** How its picture is encoded: HDR is converted first when it renders. Absent is ordinary video. */
  color: z.enum(['sdr', 'hlg', 'pq']).optional(),
  /**
   * How far the sound heard runs behind the picture, found by watching the
   * mouth, in seconds (negative: ahead). Render and preview read the sound
   * from t + offset while showing picture t, on top of `audio`'s own offset
   * when the sound is from another recording (vision/offset heardFrom), and
   * this source's words are on the picture's clock.
   */
  audioOffsetSec: z.number().min(-1).max(1).optional(),
  /** What watching the speaker's mouth found, and what this edit uses it for. */
  mouth: z
    .object({
      mode: MouthModeSchema,
      /** The offset measured, applied or not. */
      measuredOffsetSec: z.number().nullable(),
      confidence: z.number().min(0).max(1),
      /** Share of the speech during which a mouth could be read. */
      seenShare: z.number().min(0).max(1),
      /** The watched face's width, in source pixels and as a share of the frame's, for the niches that ask. */
      facePx: z.number().nonnegative().optional(),
      faceShare: z.number().min(0).max(1).optional(),
      /** Set in a sentence ("time my cuts to the sound only"), so the kind of video no longer decides it. */
      chosen: z.boolean().optional()
    })
    .optional(),
  /** Where the speaker was across the recording, found by face finding, for following them into a narrower frame. */
  subject: SubjectSchema.optional()
})
export type Source = z.infer<typeof SourceSchema>

/** A cutaway laid over a beat. Pattern only: never a reference video's own footage. */
export const BrollSchema = z.object({
  path: z.string().min(1),
  inSec: z.number().nonnegative(),
  muted: z.boolean(),
  /** The cutaway's own speed, under a voice that plays as recorded: a product spin slowed to 0.5. */
  speed: z.number().min(MIN_SPEED).max(MAX_SPEED).optional(),
  /** Easing into that speed and back. */
  ramp: RampSchema.nullable().optional(),
  /** Played backwards: a spin that turns the other way. */
  reverse: z.boolean().optional(),
  /** The frame moving over it: a Ken Burns drift across a product still. */
  camera: CameraSchema.optional(),
  /** In a split, the cutaway in the lower half and the speaker above it, as Impaulsive stacks footage under Logan. */
  below: z.boolean().optional(),
  /** In a split, a line of this colour along the seam between the halves (Impaulsive's green, #36E05A). */
  seam: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
})
export type Broll = z.infer<typeof BrollSchema>

export const FRAMES = ['speaker', 'broll', 'split', 'card'] as const

/** How a beat looks. Every field has a neutral value, so a new beat looks like the recording. */
export const TreatmentSchema = z.object({
  /** What fills the frame: the speaker, a cutaway, both side by side, or a title card. */
  frame: z.enum(FRAMES),
  /** Black and white. */
  bw: z.boolean(),
  /** 1 is the full frame; 1.15 is a 15% punch in. */
  zoom: z.number().min(1).max(2),
  /** A word in this beat that lands big on screen, by id. */
  bigWord: z.string().nullable(),
  broll: BrollSchema.nullable(),
  // Added later, so optional with no default: absent is the beat as recorded.
  // (No defaults here: the treat op merges a partial of this schema, and zod
  // would fill a default into every partial and reset the field.)
  /** Playback speed of the whole beat, sound and picture: 2 is twice as fast. Pitch is kept. */
  speed: z.number().min(MIN_SPEED).max(MAX_SPEED).optional(),
  /**
   * Where a punch-in sits up and down the picture: 0 keeps the top edge, 1 the foot. Absent is the middle.
   * From the top, a punch-in keeps heads and leaves out a stream's lower thirds.
   */
  zoomAt: z.number().min(0).max(1).optional(),
  /** Easing from full speed into `speed` at the start, and back at the end. */
  ramp: RampSchema.nullable().optional(),
  /** A freeze frame: the picture holds where a word ends while the sound waits. */
  freeze: FreezeSchema.nullable().optional(),
  /** Played backwards, sound and picture. */
  reverse: z.boolean().optional(),
  /** The frame moving over the speaker: a push-in, a punch-in on a word, a pan. */
  camera: CameraSchema.optional(),
  /** Another camera of the same take shown for this beat: instead, in a box over it, or beside it (edit/angles). */
  angle: BeatAngleSchema.nullable().optional(),
  /** Where the picture is centred when it is cropped to a narrower frame, by hand: 0 the left edge, 1 the right. */
  framing: z.number().min(0).max(1).nullable().optional(),
  /** Two to four pictures at once in a grid, each with a label, instead of the frame above (edit/grid). */
  grid: GridSchema.nullable().optional(),
  /** False hides the captions while this beat plays (over a title, a screen recording); absent follows the video's. */
  captions: z.boolean().optional(),
  /** A shaky handheld shot held still in the export, the picture cropped in a little to hide the edges it moves. */
  steady: z.boolean().optional()
})
export type Treatment = z.infer<typeof TreatmentSchema>

/**
 * One unit of the edit, usually a phrase. Anchored beats run from word `from`
 * to word `to` inclusive; unanchored ones (a reaction shot, a pause held on
 * purpose) use `inSec` and `outSec` instead.
 */
export const BeatSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  from: z.string().nullable(),
  to: z.string().nullable(),
  inSec: z.number().nonnegative().nullable(),
  outSec: z.number().nonnegative().nullable(),
  /** Room kept before the first word and after the last, so cuts do not clip consonants. */
  padIn: z.number().min(0).max(1),
  padOut: z.number().min(0).max(1),
  treatment: TreatmentSchema,
  /** How this beat comes in from the one before. Absent is a hard cut. */
  transition: TransitionSchema.optional(),
  /** A J or L cut into this beat: its picture and its sound change at different moments. */
  splitEdit: SplitEditSchema.optional(),
  /** Sound effects on this beat's moment or on its words (edit/sfx). */
  sfx: z.array(SfxSchema).max(12).optional(),
  /** One of the moments of a cold open: played first, ahead of the conversation it comes from (op cold-open). */
  coldOpen: z.boolean().optional()
})
export type Beat = z.infer<typeof BeatSchema>

export const CAPTION_POSITIONS = ['top', 'middle', 'chest', 'bottom'] as const
export const KEY_LOOKS = ['serif', 'dark', 'punch'] as const
export type KeyLook = (typeof KEY_LOOKS)[number]

export const CaptionSpecSchema = z.object({
  on: z.boolean(),
  /** Words on screen at once. Two reads fastest on a phone. */
  wordsPerScreen: z.number().int().min(1).max(8),
  position: z.enum(CAPTION_POSITIONS),
  /** A caption look from shared/caption-presets, or one the graphics draw (shared/motion/captions). */
  preset: z.string().min(1),
  uppercase: z.boolean(),
  // Added later, so optional: absent is no word picked out.
  /** Words set in the look's key colour, by id: the ones the speaker leans on. */
  keys: z.array(z.string()).optional(),
  /**
   * How a key word is set, by id, where its meaning asks for more than size (drawn captions): serif for a
   * tender or grave word, dark for a word of horror or contempt (red serif), punch for a word that hits
   * (heavy capitals). The Diary of a CEO sets its big words this way.
   */
  keyLooks: z.record(z.string(), z.enum(KEY_LOOKS)).optional()
})
export type CaptionSpec = z.infer<typeof CaptionSpecSchema>

/** Pauses longer than maxGapSec are cut back to padSec either side. */
export const TightenSpecSchema = z.object({
  maxGapSec: z.number().min(0.05).max(5),
  padSec: z.number().min(0).max(0.5),
  fillers: z.boolean()
})
export type TightenSpec = z.infer<typeof TightenSpecSchema>

export const ASPECTS = ['vertical', 'wide', 'square', 'original'] as const
export const AspectSchema = z.enum(ASPECTS)
export type Aspect = z.infer<typeof AspectSchema>

/** The part of a doc that changes from version to version. */
export const CutSchema = z.object({
  /** In playing order. */
  beats: z.array(BeatSchema),
  /** Struck words, by id: text-based editing. They stay in the doc and can come back. */
  removed: z.array(z.string()),
  tighten: TightenSpecSchema.nullable(),
  captions: CaptionSpecSchema,
  aspect: AspectSchema,
  /** Integrated loudness the master is set to, in LUFS. Null leaves the audio as recorded. */
  loudness: z.number().min(-30).max(-6).nullable(),
  /** Motion graphics over the picture, drawn in order. Cuts saved before graphics existed have none. */
  motion: z.array(MotionItemSchema).default([]),

  // What follows was added after the first docs were saved, so every field is
  // optional: absent means the edit as it always was.

  /** The whole video fading in at the start and out at the end. */
  fade: FadeSchema.nullable().optional(),
  /** The voice cleaned up: rumble, hiss and harsh esses out, levels evened, presence lifted. */
  voice: VoiceSchema.optional(),
  /** A music bed under the whole video, dipping whenever anyone speaks. */
  music: MusicSchema.nullable().optional(),
  /** A look over the whole picture: colour, a LUT, sharpening, a vignette, grain. */
  look: LookSchema.nullable().optional(),
  /** YouTube chapters, each starting at a beat (edit/chapters). */
  chapters: z.array(ChapterSchema).optional(),
  /** Other cameras of the same takes, each lined up with its recording (edit/angles). */
  angles: z.array(AngleSchema).max(16).optional(),
  /** Words as they should read, by id, where the transcript misheard them: what the captions and the script show. */
  spelled: z.record(z.string(), z.string()).optional(),
  /** Cropped to a narrower frame, the picture follows the speaker rather than staying in the middle (edit/reframe). */
  reframe: z.boolean().optional(),
  /**
   * Jump cuts hidden with a punch-in (edit/jumps): where a cut leaves out a
   * stretch of one shot, the picture after it is shown closer, alternating
   * wide and close, so the jump reads as a cut. Absent, as in an edit made
   * before it existed, leaves every jump as it is.
   */
  punchJumps: z.boolean().optional(),
  /**
   * Which of the person's brands this version is made in, by id (shared/brands):
   * its captions, logo, graphics, never list and B-roll sources. Absent, as in
   * an edit made before there could be more than one, the brand from then
   * (shared/brands legacyBrandId). Only the cut says it: a version's ops
   * never carry the brand op that sets it (edit/doc).
   */
  brand: z.string().min(1).max(80).optional(),
  /**
   * How a picture of another shape fills the frame (edit/fill). A new edit
   * says auto: a picture taller than the frame, a still or a screen recording
   * sits whole on a blurred copy of itself, and other footage is cropped to
   * fill. "blur" puts every one on a blurred copy, "black" between black bars,
   * and "crop" crops them all. Absent, as in an edit made before the fill, is
   * the crop it always had. Only the cut says it: a version's ops never carry
   * a fill (edit/doc).
   */
  fill: FillSchema.optional(),
  /**
   * Scene effects on the picture itself (shared/fx): a pixel scan, an impact,
   * speed lines, the background blurred behind someone. Only the cut says
   * them: a version's ops never carry the fx ops, so 0.2.13, which drops
   * this field, still opens the edit (without them).
   */
  fx: z.array(FxItemSchema).max(60).optional(),
  /**
   * The picture as a box on black inside the frame (edit/box): a square in a
   * 9:16 video, the hook above it and the captions below. Absent fills the
   * frame. Only the cut says it: a version's ops never carry a box (edit/doc).
   */
  box: BoxSchema.optional()
})
export type Cut = z.infer<typeof CutSchema>

/** A beat to add. Ids are assigned on insert. */
export const BeatInputSchema = z.object({
  source: z.string().min(1),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  inSec: z.number().nonnegative().nullable().optional(),
  outSec: z.number().nonnegative().nullable().optional(),
  treatment: TreatmentSchema.partial().optional()
})
export type BeatInput = z.infer<typeof BeatInputSchema>

const beatId = z.string().min(1)
const wordId = z.string().min(1)
const pad = z.number().min(0).max(1)

/**
 * Every change to a cut. The chat planner, presets, notes and direct
 * manipulation all speak this, which is what makes versions replayable and
 * lets a model's proposal be checked before anything moves.
 */
export const OpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('remove'),
    beats: z.array(beatId).min(1),
    /**
     * Why, where it matters later (shared/raw/length): "length" for lines cut
     * to reach a length asked for, which a longer ask brings back; or what the
     * person asked to have cut ("the intro", "the part about the conference"),
     * which stays out until they ask for it back.
     */
    why: z.string().min(1).optional()
  }),
  z.object({ op: z.literal('strike'), from: wordId, to: wordId }),
  // A word as it should read where the transcript misheard it ("Okay, a loss" that was "obey the laws").
  z.object({ op: z.literal('respell'), word: wordId, text: z.string().trim().min(1).max(60) }),
  z.object({ op: z.literal('unstrike'), from: wordId, to: wordId }),
  z.object({ op: z.literal('move'), beat: beatId, to: z.number().int().min(0) }),
  z.object({ op: z.literal('split'), beat: beatId, at: wordId }),
  z.object({ op: z.literal('join'), beat: beatId }),
  z.object({ op: z.literal('pad'), beat: beatId, padIn: pad.optional(), padOut: pad.optional() }),
  z.object({ op: z.literal('treat'), beats: z.array(beatId).min(1), set: TreatmentSchema.partial() }),
  z.object({ op: z.literal('insert'), to: z.number().int().min(0), beat: BeatInputSchema }),
  z.object({ op: z.literal('captions'), set: CaptionSpecSchema.partial() }),
  z.object({ op: z.literal('tighten'), set: TightenSpecSchema.nullable() }),
  z.object({ op: z.literal('aspect'), aspect: AspectSchema }),
  z.object({ op: z.literal('loudness'), lufs: z.number().min(-30).max(-6).nullable() }),
  // How beats come in: a transition from the beat before, or 'cut' for a hard cut.
  z.object({
    op: z.literal('transition'),
    beats: z.array(beatId).min(1),
    kind: z.enum(['cut', ...ALL_TRANSITION_KINDS]),
    sec: z.number().min(MIN_TRANSITION_SEC).max(MAX_TRANSITION_SEC).optional()
  }),
  z.object({
    op: z.literal('fade'),
    inSec: z.number().min(0).max(5).optional(),
    outSec: z.number().min(0).max(5).optional(),
    color: z.enum(['black', 'white']).optional()
  }),
  // Split edits into beats: sec 0 puts picture and sound back together.
  z.object({ op: z.literal('jcut'), beats: z.array(beatId).min(1), sec: z.number().min(0).max(MAX_SPLIT_EDIT_SEC) }),
  z.object({ op: z.literal('lcut'), beats: z.array(beatId).min(1), sec: z.number().min(0).max(MAX_SPLIT_EDIT_SEC) }),
  // Speed of a beat, or of the cutaway it shows; 1 with no ramp is as recorded.
  z.object({
    op: z.literal('speed'),
    beats: z.array(beatId).min(1),
    speed: z.number().min(MIN_SPEED).max(MAX_SPEED),
    ramp: RampSchema.nullable().optional(),
    of: z.enum(['beat', 'cutaway']).optional()
  }),
  // A freeze frame on a word; sec 0 removes it.
  z.object({ op: z.literal('freeze'), beat: beatId, word: wordId, sec: z.number().min(0).max(10) }),
  // Backwards, a beat or the cutaway it shows.
  z.object({
    op: z.literal('reverse'),
    beats: z.array(beatId).min(1),
    on: z.boolean(),
    of: z.enum(['beat', 'cutaway']).optional()
  }),
  // The voice cleaned up; 0 leaves it as recorded.
  // room: the room under the voice taken down as well (edit/audio Voice); absent keeps what the cut has.
  z.object({ op: z.literal('voice'), polish: z.number().min(0).max(1), room: z.boolean().optional() }),
  // A sound effect added to beats, on a word when it names one; null takes the beats' sounds away.
  z.object({ op: z.literal('sfx'), beats: z.array(beatId).min(1), add: SfxSchema.nullable() }),
  // YouTube chapters, each at a beat, in any order; null takes them out.
  z.object({ op: z.literal('chapters'), set: z.array(ChapterSchema).max(100).nullable() }),
  // A look over the whole picture, or changes to it; replace starts it afresh, keeping the LUT; null takes it off.
  z.object({ op: z.literal('look'), set: LookPatchSchema.nullable(), replace: z.boolean().optional() }),
  // A music bed, or changes to it; null takes it out.
  z.object({ op: z.literal('music'), set: MusicSchema.partial().nullable() }),
  // A cold open: these moments, in this order, played first, ahead of the conversation they come from, hard cut
  // into each other, with a short dip to black into the conversation. Again, it replaces the cold open there was;
  // with no bites, it takes the cold open out.
  z.object({
    op: z.literal('cold-open'),
    bites: z.array(z.object({ from: wordId, to: wordId })).max(16)
  }),
  // Another camera of a recording, lined up by offsetSec; of null takes the camera out of the edit.
  z.object({
    op: z.literal('sync'),
    source: z.string().min(1),
    of: z.string().min(1).nullable(),
    offsetSec: z.number().optional()
  }),
  // Follow the speaker when the picture is cropped to a narrower frame, or keep it in the middle.
  z.object({ op: z.literal('reframe'), on: z.boolean() }),
  // Jump cuts punched in, wide and close in turn, or left as they are (edit/jumps).
  z.object({ op: z.literal('punch-jumps'), on: z.boolean() }),
  // The brand the edit is made in, by id (shared/brands); what that brand changes comes as other ops beside it.
  z.object({ op: z.literal('brand'), id: z.string().min(1).max(80) }),
  // How pictures of another shape fill the frame: as an edit does unless asked, on a blurred copy, between black bars, or cropped.
  z.object({ op: z.literal('fill'), mode: FillSchema }),
  // The picture as a box on black inside the frame, as a square in a 9:16 video; null fills the frame again.
  z.object({ op: z.literal('box'), set: BoxSchema.nullable() }),
  // Where beats are centred when cropped, by hand; null follows the speaker or the middle again.
  z.object({ op: z.literal('framing'), beats: z.array(beatId).min(1), x: z.number().min(0).max(1).nullable() }),
  // Which camera beats show, and how; null shows their own recording again.
  z.object({
    op: z.literal('angle'),
    beats: z.array(beatId).min(1),
    source: z.string().min(1).nullable(),
    layout: z.enum(ANGLE_LAYOUTS).optional()
  }),
  // A camera move over a beat, or over the cutaway it shows; null holds the frame still.
  z.object({
    op: z.literal('camera'),
    beats: z.array(beatId).min(1),
    move: CameraSchema.nullable(),
    of: z.enum(['beat', 'cutaway']).optional()
  }),
  // motion-add, motion-update, motion-remove: graphics over the picture (shared/motion).
  ...MotionOpSchemas,
  // fx-add, fx-update, fx-remove: scene effects on the picture (shared/fx), never kept in a version's ops.
  ...FxOpSchemas
])
export type Op = z.infer<typeof OpSchema>
export type OpName = Op['op']

export const VersionSchema = z.object({
  n: z.number().int().positive(),
  at: z.string(),
  /** One sentence in the app's voice: "The hook word is bigger and the ending stays on you." */
  summary: z.string(),
  /** What changed from the version before. */
  ops: z.array(OpSchema),
  /** The whole cut as of this version, so restoring never depends on replaying. */
  cut: CutSchema,
  /** Set when this version brings an earlier one back as it was (undo): that version's number. */
  restores: z.number().int().positive().optional()
})
export type Version = z.infer<typeof VersionSchema>

export const NoteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** The beat the note was left on, if any. */
  beat: z.string().nullable(),
  /**
   * The stretch picked on the beat strip when the note was left, by its first
   * and last beat, and every beat it held then: the note is about those only,
   * or what is left of them once an end is cut.
   */
  range: z.object({ from: z.string(), to: z.string(), beats: z.array(z.string()).optional() }).optional(),
  status: z.enum(['open', 'applied', 'dismissed']),
  /** The version the note was written against. */
  version: z.number().int().positive()
})
export type Note = z.infer<typeof NoteSchema>

/**
 * Something brought in to use in the edit: a file, an image from a link, an
 * excerpt of someone else's video, an icon. Where it came from travels with
 * it, so every export can credit what it used.
 */
export const AssetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['video', 'image', 'audio']),
  /** The local copy the edit plays from. */
  path: z.string().min(1),
  title: z.string(),
  durationSec: z.number().nonnegative().nullable(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  origin: z.object({
    type: z.enum(['file', 'link', 'video', 'icon']),
    url: z.string().nullable(),
    /** Channel, creator or set, for the credit line. */
    author: z.string().nullable(),
    /** Known licence, or null when using it is the editor's own call. */
    license: z.string().nullable(),
    /** The stretch taken from a longer video. */
    range: z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }).nullable(),
    /**
     * The credit line in the form its source asks for ("Photo by … on
     * Unsplash", "Powered by GIPHY"), for B-roll found by Cutalong
     * (main/broll); the upload kit prints it in place of the parts above.
     */
    credit: z.string().optional()
  })
})
export type Asset = z.infer<typeof AssetSchema>

export const EditDocSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.string(),
  sources: z.array(SourceSchema).min(1),
  /** Every word of every source, sorted by source then time. */
  words: z.array(WordSchema),
  versions: z.array(VersionSchema).min(1),
  notes: z.array(NoteSchema),
  /** Material brought in for the edit. Docs saved before assets existed have none. */
  assets: z.array(AssetSchema).default([]),
  /** The preset command last applied, without its slash. */
  preset: z.string().nullable(),
  /** What each recording sounds like, by source id (shared/audio/map). Absent until listened to. */
  audio: z.record(z.string(), AudioMapSchema).optional(),
  /** The cutting profile this edit asked for ("this one is a podcast"), over the brand's niche. */
  profile: z.string().optional(),
  /**
   * The vlog shoot this edit tells the story of (shared/vlog): its clips,
   * moments, scenes and story. One that cannot be read is dropped rather
   * than keeping the edit from opening.
   */
  vlog: VlogSchema.optional().catch(undefined),
  /**
   * What a video made from nothing was made from (shared/make): its brief,
   * script, style bible, shots and narration, so a later ask makes again only
   * what it changes. One that cannot be read is dropped rather than keeping
   * the edit from opening.
   */
  make: MakeSchema.optional().catch(undefined),
  /**
   * The Premiere sequence this edit was made from (shared/premiere): its cuts
   * stay as Premiere has them, and what is added goes back as tracks of its
   * own. One that cannot be read is dropped rather than keeping the edit from
   * opening.
   */
  premiere: PremiereOriginSchema.optional().catch(undefined)
})
export type EditDoc = z.infer<typeof EditDocSchema>

export const DEFAULT_TREATMENT: Treatment = {
  frame: 'speaker',
  bw: false,
  zoom: 1,
  bigWord: null,
  broll: null
}

export const DEFAULT_CAPTIONS: CaptionSpec = {
  on: true,
  wordsPerScreen: 3,
  position: 'chest',
  preset: 'clean',
  uppercase: false
}

/** Where YouTube, TikTok and Instagram all normalise speech to. */
export const DEFAULT_LOUDNESS = -14

export const DEFAULT_PAD_IN = 0.08
export const DEFAULT_PAD_OUT = 0.12
