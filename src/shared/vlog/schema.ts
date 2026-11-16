import { z } from 'zod'

/**
 * A vlog shoot, as Cutalong understood it: every clip with when and where it
 * was recorded, the stretches worth using, its moments described in a line,
 * the scenes of the day, and the story the edit tells. It rides along with
 * the edit document (EditDoc.vlog), so a later "make it shorter" or "more of
 * the dinner" works from what was watched instead of watching again.
 *
 * What the clips measured frame by frame stays in the cache beside each file
 * (main/vlog-watch); this is the summary an edit needs.
 */

/** What can be heard in a moment, from the sound alone. */
export const SOUND_EVENTS = ['speech', 'cheering', 'laughter', 'music', 'wind', 'noise', 'quiet'] as const
export type SoundEventKind = (typeof SOUND_EVENTS)[number]

/** What a moment is good for in a story. */
export const MOMENT_KINDS = ['establishing', 'action', 'talk', 'reaction', 'quiet'] as const
export type MomentKind = (typeof MOMENT_KINDS)[number]

/** The part a beat plays in the story. */
export const ROLES = ['hook', 'establishing', 'action', 'talk', 'reaction', 'payoff', 'close'] as const
export type Role = (typeof ROLES)[number]

/** Why a clip stays out of the story. */
export const LEFT_OUT = ['short', 'pocket', 'dark', 'shaky', 'blurred', 'duplicate', 'unreadable'] as const
export type LeftOut = (typeof LEFT_OUT)[number]

/** Who said what is in a moment. */
export const DESCRIBERS = ['claude', 'local', 'measurements'] as const
export type Describer = (typeof DESCRIBERS)[number]

const span = z.tuple([z.number(), z.number()])

export const GpsSchema = z.object({ lat: z.number(), lon: z.number() })
export type Gps = z.infer<typeof GpsSchema>

export const MomentSchema = z.object({
  /** m1, m2, ... across the shoot. */
  id: z.string().min(1),
  /** The clip's source id in the edit. */
  clip: z.string().min(1),
  inSec: z.number().min(0),
  outSec: z.number().min(0),
  /** Where it peaks: the second a shot of it is cut around. */
  peakSec: z.number().min(0),
  kind: z.enum(MOMENT_KINDS),
  /** Movement inside the frame, 0 still to 1 a lot. */
  motion: z.number().min(0).max(1),
  /** 1 a steady shot, 0 shaking hard. */
  steady: z.number().min(0).max(1),
  /** Exposure: 0 black to 1 white; well exposed sits near the middle. */
  light: z.number().min(0).max(1),
  /** Detail, 0 soft to 1 crisp. */
  sharp: z.number().min(0).max(1),
  /** How loud against the rest of the shoot, 0 to 1. */
  loud: z.number().min(0).max(1),
  sounds: z.array(z.enum(SOUND_EVENTS)),
  /** The largest face's share of the frame width, where faces were looked for (on a Mac). */
  face: z.number().min(0).max(1).nullable().optional(),
  /** How strong a moment it is for a story, 0 to 1. */
  interest: z.number().min(0).max(1),
  /** How good it looks, 0 to 1. */
  quality: z.number().min(0).max(1),
  /** One line: "walking into the venue, a crowd at the door". */
  description: z.string(),
  describedBy: z.enum(DESCRIBERS)
})
export type Moment = z.infer<typeof MomentSchema>

export const ClipSchema = z.object({
  /** The clip's source id in the edit, or c1, c2 ... for a clip left out of it. */
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string(),
  durationSec: z.number().min(0),
  /** When the camera says it was recorded, as it says it. */
  recordedAt: z.string().nullable(),
  /** When it was recorded once camera clocks are lined up, in seconds since 1970; null when nothing says. */
  at: z.number().nullable(),
  /** What was added to this camera's clock to line it up with the others. */
  clockFixSec: z.number().optional(),
  /** The camera, by make and model or by how it names its files. */
  camera: z.string(),
  gps: GpsSchema.nullable(),
  width: z.number().int().min(0),
  height: z.number().int().min(0),
  /** Someone talks in it, so its words were heard. */
  talking: z.boolean(),
  /** Share of it that sounds like speech. */
  speech: z.number().min(0).max(1),
  usable: z.array(span),
  /** Why it is not used, when it is not. */
  left: z.enum(LEFT_OUT).nullable(),
  /** The clip this one is a near-identical take of. */
  duplicateOf: z.string().optional(),
  scene: z.string().nullable(),
  /** A small colour signature: the look, for telling places and repeats apart. */
  look: z.array(z.number())
})
export type Clip = z.infer<typeof ClipSchema>

export const SceneSchema = z.object({
  /** sc1, sc2, ... in the order of the day. */
  id: z.string().min(1),
  /** A short name: "the airport", or "Morning, 9:12" when nothing better is known. */
  name: z.string(),
  clips: z.array(z.string()),
  startAt: z.number().nullable(),
  endAt: z.number().nullable(),
  place: GpsSchema.nullable()
})
export type Scene = z.infer<typeof SceneSchema>

/**
 * One beat of the story: a shot of a clip from inSec to outSec, or talking
 * cut on words from one word id to another.
 */
export const StoryBeatSchema = z.object({
  clip: z.string().min(1),
  role: z.enum(ROLES),
  scene: z.string().nullable(),
  moment: z.string().nullable(),
  inSec: z.number().nullable(),
  outSec: z.number().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable()
})
export type StoryBeat = z.infer<typeof StoryBeatSchema>

export const StorySchema = z.object({
  /** The length the story is cut to. */
  targetSec: z.number().positive(),
  /** True when the person asked for a length, so more footage keeps it. */
  lengthAsked: z.boolean(),
  /** 'auto' teases the strongest moment; 'none' starts with the day; else a moment or scene id to open on. */
  hook: z.string(),
  /** More or less of a scene, by id: 1.5 is half as much again, 0 leaves it out. */
  weights: z.record(z.string(), z.number().min(0).max(4)),
  /** Who put it together. */
  by: z.enum(['claude', 'local', 'rules']),
  beats: z.array(StoryBeatSchema)
})
export type Story = z.infer<typeof StorySchema>

export const VlogSchema = z.object({
  v: z.literal(1),
  clips: z.array(ClipSchema),
  moments: z.array(MomentSchema),
  scenes: z.array(SceneSchema),
  story: StorySchema,
  /** Who described the moments, and how many stills a service saw. */
  described: z.object({ by: z.enum(DESCRIBERS), model: z.string().nullable(), stills: z.number().int().min(0) }),
  /** Camera clocks lined up, said once. */
  clockNotes: z.array(z.string()).optional()
})
export type Vlog = z.infer<typeof VlogSchema>
