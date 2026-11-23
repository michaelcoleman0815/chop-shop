import { z } from 'zod'
import { AnimNumSchema } from '../anim'

/**
 * The mixer: each sound in the edit as a strip, the way a mixing desk in
 * Premiere or a DAW has one. The edit's own voice is one, the music bed is
 * one, and so is every layer track that sounds (a sound track, or a picture
 * track whose videos carry sound). A strip has a level (its fader, in dB), a
 * place between the speakers (pan, -1 left to 1 right), and a chain of
 * effects that run in order before the fader. Level and pan are keyframeable
 * on the edit's clock (seconds of the video), which is automation.
 *
 * The export is the reference (main/render/mix); the preview plays an
 * approximation of it through Web Audio (renderer mix-graph). This file
 * stands alone (zod and the keyframe schemas), so the edit and the tracks'
 * schemas can include it without a cycle.
 */

export const FX_KINDS = [
  'eq',
  'highpass',
  'lowpass',
  'compressor',
  'gate',
  'deesser',
  'noise',
  'reverb',
  'delay',
  'limiter'
] as const
export type FxKind = (typeof FX_KINDS)[number]

export const EQ_BAND_TYPES = ['peak', 'lowshelf', 'highshelf', 'notch'] as const
export type EqBandType = (typeof EQ_BAND_TYPES)[number]

/** At most this many bands on one EQ. */
export const MAX_EQ_BANDS = 6
/** At most this many effects on one strip. */
export const MAX_EFFECTS = 12

/** A fader's range, in dB: far enough down to all but vanish, a little above as recorded. */
export const GAIN_MIN_DB = -60
export const GAIN_MAX_DB = 12

const bypass = z.boolean().default(false)

export const EqBandSchema = z.object({
  type: z.enum(EQ_BAND_TYPES).default('peak'),
  freq: z.number().min(20).max(20000),
  /** Up or down at the band, in dB; a notch takes it all out and ignores this. */
  gainDb: z.number().min(-24).max(24).default(0),
  /** How narrow the band is: 0.7 is broad, 4 narrow; shelves ignore it. */
  q: z.number().min(0.1).max(18).default(1)
})
export type EqBand = z.infer<typeof EqBandSchema>

export const AudioFxSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('eq'), bypass, bands: z.array(EqBandSchema).min(1).max(MAX_EQ_BANDS) }),
  /** Takes out what is below `freq`: rumble, wind, handling. */
  z.object({ kind: z.literal('highpass'), bypass, freq: z.number().min(20).max(2000).default(80) }),
  /** Takes out what is above `freq`: hiss, or a muffled, far-off sound. */
  z.object({ kind: z.literal('lowpass'), bypass, freq: z.number().min(500).max(20000).default(12000) }),
  /** Evens the level: what goes over the threshold is turned down by the ratio. */
  z.object({
    kind: z.literal('compressor'),
    bypass,
    thresholdDb: z.number().min(-60).max(0).default(-18),
    ratio: z.number().min(1).max(20).default(3),
    attackMs: z.number().min(0.1).max(200).default(10),
    releaseMs: z.number().min(10).max(2000).default(150),
    makeupDb: z.number().min(0).max(24).default(0)
  }),
  /** Closes under the threshold, turning the gaps down by `rangeDb`: breaths, room, bleed. */
  z.object({
    kind: z.literal('gate'),
    bypass,
    thresholdDb: z.number().min(-80).max(0).default(-45),
    rangeDb: z.number().min(-80).max(0).default(-30),
    attackMs: z.number().min(0.1).max(200).default(5),
    releaseMs: z.number().min(10).max(2000).default(200)
  }),
  /** Harsh esses softened, from 0 (barely) to 1. */
  z.object({ kind: z.literal('deesser'), bypass, amount: z.number().min(0).max(1).default(0.5) }),
  /** Steady hiss and hum taken down by `reduceDb`, as it is heard going along. */
  z.object({
    kind: z.literal('noise'),
    bypass,
    reduceDb: z.number().min(1).max(40).default(12),
    floorDb: z.number().min(-80).max(-20).default(-50)
  }),
  /** A room around the sound: its size from 0 (a small room) to 1 (a hall), and how much of it is heard. */
  z.object({
    kind: z.literal('reverb'),
    bypass,
    room: z.number().min(0).max(1).default(0.5),
    mix: z.number().min(0).max(1).default(0.2)
  }),
  /** An echo: repeats `timeMs` apart, each `feedback` of the one before. */
  z.object({
    kind: z.literal('delay'),
    bypass,
    timeMs: z.number().min(20).max(2000).default(250),
    feedback: z.number().min(0).max(0.9).default(0.3),
    mix: z.number().min(0).max(1).default(0.25)
  }),
  /** Peaks held under the ceiling. */
  z.object({
    kind: z.literal('limiter'),
    bypass,
    ceilingDb: z.number().min(-12).max(0).default(-1),
    releaseMs: z.number().min(1).max(1000).default(50)
  })
])
export type AudioFx = z.infer<typeof AudioFxSchema>
export type FxOf<K extends FxKind> = Extract<AudioFx, { kind: K }>

/** A strip's level, place and effects. Absent level and pan are 0: as it comes, in the middle. */
export const BusMixSchema = z.object({
  /** The fader, in dB: a value or keys at seconds of the video. */
  gainDb: AnimNumSchema.optional(),
  /** -1 is hard left, 1 hard right: a value or keys at seconds of the video. */
  pan: AnimNumSchema.optional(),
  effects: z.array(AudioFxSchema).max(MAX_EFFECTS).default([])
})
export type BusMix = z.infer<typeof BusMixSchema>

/**
 * The voice's strip, and the music bed's: their mute and solo live here, as a
 * track's live on the track (shared/tracks).
 */
export const OwnMixSchema = BusMixSchema.extend({
  mute: z.boolean().optional(),
  solo: z.boolean().optional()
})
export type OwnMix = z.infer<typeof OwnMixSchema>

/** What a mix op can be aimed at: the voice, the music bed, or a layer track by id. */
export const MIX_TARGETS = ['voice', 'music'] as const

/**
 * The mixer's op. `effects` replaces the whole chain; `add` puts effects at
 * its end; `remove` takes effects off by place (1 is the first) or by kind.
 * Level and pan, given, replace what was there, keys and all.
 */
export const MixOpSchema = z.object({
  op: z.literal('mix'),
  /** "voice", "music", or a track's id. */
  target: z.string().min(1).max(16),
  gainDb: AnimNumSchema.optional(),
  pan: AnimNumSchema.optional(),
  mute: z.boolean().optional(),
  solo: z.boolean().optional(),
  effects: z.array(AudioFxSchema).max(MAX_EFFECTS).optional(),
  add: z.array(AudioFxSchema).max(MAX_EFFECTS).optional(),
  remove: z.array(z.union([z.number().int().min(1).max(MAX_EFFECTS), z.enum(FX_KINDS)])).max(MAX_EFFECTS).optional()
})
export type MixOp = z.infer<typeof MixOpSchema>

/** An effect of a kind at its usual settings, the way the menu adds one. */
export function defaultFx(kind: FxKind): AudioFx {
  if (kind === 'eq') return AudioFxSchema.parse({ kind, bands: [{ type: 'peak', freq: 1000, gainDb: 0, q: 1 }] })
  return AudioFxSchema.parse({ kind })
}
