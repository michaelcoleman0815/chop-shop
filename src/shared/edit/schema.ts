import { z } from 'zod'
import { FadeSchema, MAX_TRANSITION_SEC, MIN_TRANSITION_SEC, TRANSITION_KINDS, TransitionSchema } from './transitions'

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
  endSec: z.number().nonnegative()
})
export type Word = z.infer<typeof WordSchema>

/** A recording the edit draws from. */
export const SourceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  durationSec: z.number().nonnegative(),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  fps: z.number().positive()
})
export type Source = z.infer<typeof SourceSchema>

/** A cutaway laid over a beat. Pattern only: never a reference video's own footage. */
export const BrollSchema = z.object({
  path: z.string().min(1),
  inSec: z.number().nonnegative(),
  muted: z.boolean()
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
  broll: BrollSchema.nullable()
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
  transition: TransitionSchema.optional()
})
export type Beat = z.infer<typeof BeatSchema>

export const CAPTION_POSITIONS = ['top', 'middle', 'chest', 'bottom'] as const

export const CaptionSpecSchema = z.object({
  on: z.boolean(),
  /** Words on screen at once. Two reads fastest on a phone. */
  wordsPerScreen: z.number().int().min(1).max(8),
  position: z.enum(CAPTION_POSITIONS),
  /** A caption look from shared/caption-presets. */
  preset: z.string().min(1),
  uppercase: z.boolean()
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

  // What follows was added after the first docs were saved, so every field is
  // optional: absent means the edit as it always was.

  /** The whole video fading in at the start and out at the end. */
  fade: FadeSchema.nullable().optional()
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
  z.object({ op: z.literal('remove'), beats: z.array(beatId).min(1) }),
  z.object({ op: z.literal('strike'), from: wordId, to: wordId }),
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
    kind: z.enum(['cut', ...TRANSITION_KINDS]),
    sec: z.number().min(MIN_TRANSITION_SEC).max(MAX_TRANSITION_SEC).optional()
  }),
  z.object({
    op: z.literal('fade'),
    inSec: z.number().min(0).max(5).optional(),
    outSec: z.number().min(0).max(5).optional(),
    color: z.enum(['black', 'white']).optional()
  })
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
  cut: CutSchema
})
export type Version = z.infer<typeof VersionSchema>

export const NoteSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  /** The beat the note was left on, if any. */
  beat: z.string().nullable(),
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
    range: z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() }).nullable()
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
  preset: z.string().nullable()
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
