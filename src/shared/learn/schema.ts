import { z } from 'zod'

/**
 * What learning from an edit keeps, on this computer: for each raw word,
 * whether the creator kept it and where it landed, the stretches of the
 * recording that play, and the cuts between them in milliseconds. Labels and
 * metadata only. The footage stays where it is, named by its path.
 */

/**
 * kept and cut are the creator's decisions. unsure is a word whose fate the
 * sound could not settle (a sped-up stretch, two takes too alike); unused is
 * recording far from anything in the video, likely material for another one.
 * Neither of those is scored.
 */
export const LABELS = ['kept', 'cut', 'unsure', 'unused'] as const
export const LabelSchema = z.enum(LABELS)
export type Label = z.infer<typeof LabelSchema>

export const LabelledWordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  text: z.string(),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  label: LabelSchema,
  /** Where a kept word plays in the finished video. */
  outStartSec: z.number().nullable(),
  outEndSec: z.number().nullable()
})
export type LabelledWord = z.infer<typeof LabelledWordSchema>

/** A stretch of one recording that plays in the finished video. */
export const PieceSchema = z.object({
  source: z.string().min(1),
  rawStart: z.number(),
  rawEnd: z.number(),
  outStart: z.number(),
  outEnd: z.number(),
  /** How alike it sounded, up to 1; null when only the words were compared. */
  match: z.number().nullable(),
  /**
   * Whether each edge was heard. A cut inside a pause that sits under music
   * could be anywhere in the pause; then the edge is the middle of where it
   * could be, and not sure.
   */
  sureStart: z.boolean(),
  sureEnd: z.boolean()
})
export type Piece = z.infer<typeof PieceSchema>

/** A stretch of a recording that was cut, between two that play. */
export const CutSchema = z.object({
  source: z.string().min(1),
  startMs: z.number().int(),
  endMs: z.number().int(),
  /** Words inside it. Zero for a pause cut short. */
  words: z.number().int().nonnegative(),
  /** Both edges were heard, not inferred. */
  sure: z.boolean()
})
export type CutSpan = z.infer<typeof CutSchema>

export const BreathSchema = z.object({
  source: z.string().min(1),
  startSec: z.number(),
  endSec: z.number(),
  kept: z.boolean()
})
export type Breath = z.infer<typeof BreathSchema>

export const ISSUE_KINDS = [
  'no-speech-recording',
  'no-speech-finished',
  'not-from-recording',
  'speed',
  'unmatched',
  'words-only',
  'unused-recording',
  'alike-takes'
] as const

/** Something learning could not handle, said rather than guessed. */
export const IssueSchema = z.object({
  kind: z.enum(ISSUE_KINDS),
  /** One sentence for the person. */
  text: z.string(),
  source: z.string().optional(),
  outStart: z.number().optional(),
  outEnd: z.number().optional(),
  /** For a speed change: how much faster it plays. */
  factor: z.number().optional()
})
export type Issue = z.infer<typeof IssueSchema>

export const MediaRefSchema = z.object({
  path: z.string().min(1),
  durationSec: z.number().nonnegative(),
  /** Size and modified time when learned, so a file changed since can be noticed. */
  bytes: z.number().nonnegative().nullable(),
  modifiedAt: z.string().nullable()
})

export const LabelledPairSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  /** The finished video's name. */
  title: z.string(),
  createdAt: z.string(),
  recordings: z.array(MediaRefSchema.extend({ id: z.string().min(1) })).min(1),
  finished: MediaRefSchema,
  words: z.array(LabelledWordSchema),
  pieces: z.array(PieceSchema),
  cuts: z.array(CutSchema),
  breaths: z.array(BreathSchema),
  issues: z.array(IssueSchema),
  /** Finished-video words heard in the recordings, of all of them. */
  matched: z.object({ words: z.number().int().nonnegative(), of: z.number().int().nonnegative() })
})
export type LabelledPair = z.infer<typeof LabelledPairSchema>

const count = z.object({ n: z.number().int().nonnegative(), of: z.number().int().nonnegative() })

/**
 * How the creator cuts, fitted from their own edits. It lives on the brand
 * and is only ever replaced when the person says so.
 */
export const HabitsSchema = z.object({
  /** How many videos and labelled words the habits come from. */
  videos: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  /** The pauses left where the speaker paused or a cut was made. */
  pauses: z
    .object({
      medianSec: z.number().nonnegative(),
      p90Sec: z.number().nonnegative(),
      count: z.number().int().nonnegative()
    })
    .nullable(),
  /** Pauses between words that follow each other in the recording, and how many of them were shortened. */
  pauseCuts: count.nullable(),
  /** Pauses up to this long were kept whole and longer ones shortened. Null when none was shortened. */
  maxPauseSec: z.number().positive().nullable(),
  /** Room left before the first word after a cut, and after the last word before one. */
  pad: z
    .object({
      beforeSec: z.number().nonnegative(),
      afterSec: z.number().nonnegative(),
      count: z.number().int().nonnegative()
    })
    .nullable(),
  /** Ums and uhs inside kept speech, and how many were cut. */
  fillers: count.nullable(),
  /** Breaths between kept words, and how many were cut. */
  breaths: count.nullable(),
  /** Lines said more than once with one take kept, and how often that was the last take. */
  lastTake: count.nullable(),
  learnedAt: z.string()
})
export type Habits = z.infer<typeof HabitsSchema>
