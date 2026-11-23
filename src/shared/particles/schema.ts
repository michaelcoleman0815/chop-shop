import { z } from 'zod'
import { AnimNumSchema, ColorSchema } from '../anim'

/**
 * Particles: snow, confetti, sparks and the rest, as a clip on a picture
 * track. A clip carries a preset and the settings it changes from it
 * (`{ preset: 'snow', rate: 80 }`); everything else comes from the preset.
 *
 * This file stands alone (zod and the keyframe schemas), so the tracks'
 * schema can include it without a cycle. Lengths are design pixels of the
 * full-size frame, times seconds, angles degrees (0 points right, 90 down).
 */

export const PARTICLE_PRESETS = ['snow', 'confetti', 'sparks', 'dust', 'embers', 'rain', 'bokeh', 'smoke'] as const
export type ParticlePreset = (typeof PARTICLE_PRESETS)[number]

/** Where particles are born: a point, along a line, inside a box, just outside the frame's edge, or on a word's outline. */
export const EMITTERS = ['point', 'line', 'box', 'edge', 'text'] as const
export type Emitter = (typeof EMITTERS)[number]

export const EDGES = ['top', 'bottom', 'left', 'right', 'around'] as const
export type Edge = (typeof EDGES)[number]

/** What each particle is drawn as: a dot (soft with `soft`), a square that tumbles, a streak along its path, a star, or a picture. */
export const SPRITES = ['dot', 'square', 'streak', 'star', 'image'] as const
export type Sprite = (typeof SPRITES)[number]

/** No more particles than this live at once, whatever a setting asks: a frame's cost stays bounded. */
export const MAX_PARTICLES = 2000

const share = z.number().min(0).max(1)

export const ParticleSpecSchema = z.object({
  preset: z.enum(PARTICLE_PRESETS).optional(),
  emitter: z.enum(EMITTERS).optional(),
  /** The emitter's place as shares of the frame, [x0, y0, x1, y1]: a box, a line from one corner to the other, or a point at its centre. */
  area: z.array(z.number().min(-1).max(2)).length(4).optional(),
  /** Which edge an edge emitter runs along. */
  edge: z.enum(EDGES).optional(),
  /** The words a text emitter is born on. */
  text: z.string().min(1).max(60).optional(),
  /** Particles born a second; keyframeable. */
  rate: AnimNumSchema.optional(),
  /** Particles born at once when the clip starts. */
  burst: z.number().int().min(0).max(MAX_PARTICLES).optional(),
  /** Seconds each lives, give or take its variance. */
  life: z.number().min(0.05).max(60).optional(),
  /** Pixels a second at birth. */
  speed: z.number().min(0).max(20_000).optional(),
  /** Degrees they set off in: 0 right, 90 down, -90 up. */
  direction: z.number().min(-720).max(720).optional(),
  /** The cone around the direction, in degrees: 360 is every way. */
  spread: z.number().min(0).max(360).optional(),
  /** Pixels a second, a second, downward; below 0 they rise. */
  gravity: z.number().min(-20_000).max(20_000).optional(),
  /** Pixels a second, a second, to the right; below 0 to the left. */
  wind: z.number().min(-20_000).max(20_000).optional(),
  /** How hard a swirling air pushes them about, in pixels a second, a second. */
  turbulence: z.number().min(0).max(20_000).optional(),
  /** How much of their speed the air takes each second: 0 none, 1 a lot. */
  drag: z.number().min(0).max(20).optional(),
  /** Degrees a second each turns, either way. */
  spin: z.number().min(0).max(3600).optional(),
  /** Pixels across at birth, and at the end of its life. */
  size: z.number().min(0.5).max(1000).optional(),
  sizeEnd: z.number().min(0).max(2000).optional(),
  /** Each particle takes one of these. */
  colors: z.array(ColorSchema).min(1).max(8).optional(),
  /** The colour each turns to by the end of its life. */
  colorEnd: ColorSchema.optional(),
  /** How see-through each is at its fullest, 0 to 1. */
  alpha: share.optional(),
  /** Shares of its life spent fading in and fading out. */
  fadeIn: share.optional(),
  fadeOut: share.optional(),
  /** How much each flickers, 0 to 1, as embers do. */
  flicker: share.optional(),
  sprite: z.enum(SPRITES).optional(),
  /** A dot's edge: 0 hard, 1 a soft glow. */
  soft: share.optional(),
  /** Seconds of its path a streak shows behind it. */
  stretch: z.number().min(0).max(1).optional(),
  /** Times a second a square tumbles over, as confetti does. */
  flip: z.number().min(0).max(20).optional(),
  /** How much each particle differs from the next in size, speed and life, 0 to 1. */
  variance: share.optional(),
  /** Add brightens what is under it, as light does; normal lays over it. */
  blend: z.enum(['add', 'normal']).optional(),
  /** Seconds run before the clip starts, so the frame is already full. */
  prerun: z.number().min(0).max(30).optional(),
  /** At most this many alive at once. */
  max: z.number().int().min(1).max(MAX_PARTICLES).optional(),
  /** Another seed is another fall of the same snow. */
  seed: z.number().int().min(0).max(1_000_000_000).optional()
})
export type ParticleSpec = z.infer<typeof ParticleSpecSchema>

/** The names a spec may carry, for lifting them out of a clip's settings (shared/particles/planner). */
export const PARTICLE_KEYS = Object.keys(ParticleSpecSchema.shape) as (keyof ParticleSpec)[]
