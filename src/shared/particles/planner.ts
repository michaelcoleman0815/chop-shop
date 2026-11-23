import { tracksOf } from '../tracks/resolve'
import type { Track } from '../tracks/schema'
import { PRESETS } from './presets'
import { PARTICLE_KEYS, PARTICLE_PRESETS, type ParticleSpec } from './schema'

/**
 * Particles as the planner writes them: a clip-add of kind "particles" with
 * the preset and what changes from it in the clip's `spec`, flat
 * (`{"preset":"snow","rate":90}`), so the plan's schema gains nothing but the
 * kind's name (shared/tracks/planner). Its full guide goes with a request
 * that speaks of particles, or with a cut that has them (main/planner-guides).
 */

/** Keys a clip has of its own as well: a video's speed, a title's words, the clip's blend. */
const SHARED = new Set<string>(['speed', 'text', 'blend'])

/**
 * A spec with the particles' settings gathered under `particles`, for a
 * particles clip, or for a change that plainly speaks of particles (it names
 * a preset, a rate, gravity...). Anything else comes back as it was.
 */
export function liftParticles(raw: unknown, kind?: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const spec = raw as Record<string, unknown>
  const own = PARTICLE_KEYS.some((k) => !SHARED.has(k) && k in spec)
  if (kind !== 'particles' && !own) return raw
  const out: Record<string, unknown> = { ...spec }
  const particles: Record<string, unknown> = { ...((spec.particles as Record<string, unknown> | undefined) ?? {}) }
  for (const k of PARTICLE_KEYS) {
    // The clip's blend already has add and normal.
    if (k === 'blend' || !(k in out)) continue
    if (k === 'text' && typeof out.text !== 'string') continue
    particles[k] = out[k]
    delete out[k]
  }
  out.particles = particles
  return out
}

/** A particles clip's own slots, as the planner fills them: its words on a text emitter, its colour. */
export function particleSlots(op: { text: string; color: string }, spec: ParticleSpec | undefined): ParticleSpec {
  return {
    ...(op.text ? { emitter: 'text' as const, text: op.text } : {}),
    ...(op.color ? { colors: [op.color] } : {}),
    ...spec
  }
}

/** A clip's particles as a line says them: its spec, exactly. */
export function particleWords(spec: ParticleSpec | undefined): string {
  return `particles ${JSON.stringify(spec ?? {})}`
}

/** Whether a cut already has particles on its tracks. */
export function hasParticles(cut: { tracks?: Track[] }): boolean {
  return tracksOf(cut).some((t) => t.clips.some((c) => c.kind === 'particles'))
}

/** Words that ask for particles. */
export const PARTICLE_ASK = /\b(snow(ing|fall|flakes?)?|confetti|sparks?|sparkles?|embers?|rain(ing|drops?)?|dust|bokeh|smoke|smoky|particles?|fireworks?|flurr(y|ies))\b/i

/** The always-on line for the planner's instructions. */
export const PARTICLES_INDEX = `particles: ${PARTICLE_PRESETS.join(', ')} over the picture, a clip-add of kind "particles" with its preset and changes in "spec".`

const usual = '"track":"","src":"","text":"","color":"","in":0,"speed":0,"fit":"","blend":"","opacity":0,"volume":0'

/** The full guide, sent with a request that needs it. */
export function particlesGuide(): string {
  const presets = PARTICLE_PRESETS.map((p) => `${p} (${PRESETS[p].summary.toLowerCase()})`).join(', ')
  return `## Particles
A particles clip on a picture track draws a seeded system over the frame, the same in the preview and the export. Presets: ${presets}. Pick the preset, then change only what the ask needs.
- {"op":"clip-add","kind":"particles",${usual},"from":"w12","to":"6s","spec":"{\\"preset\\":\\"snow\\"}"}: snow over the speaker from w12 for six seconds. "to":"" is five seconds; to the end, "to":"end".
- {"op":"clip-add","kind":"particles",${usual},"from":"b4","to":"b4.end","spec":"{\\"preset\\":\\"confetti\\",\\"emitter\\":\\"point\\",\\"area\\":[0.5,1,0.5,1],\\"direction\\":-90,\\"spread\\":50,\\"speed\\":1500,\\"burst\\":220,\\"rate\\":0}"}: a confetti cannon fired up from the bottom when b4 starts.
- {"op":"clip-add","kind":"particles","track":"","src":"","text":"LAUNCH","color":"#FFC94D","in":0,"speed":0,"fit":"","blend":"","opacity":0,"volume":0,"from":"w30","to":"3s","spec":"{\\"preset\\":\\"sparks\\",\\"speed\\":120,\\"gravity\\":200,\\"rate\\":400}"}: sparks born along the letters of a word ("text"), in a colour ("color").
- {"op":"clip-update","clip":"c3","track":"","from":"","to":"","spec":"{\\"rate\\":140,\\"wind\\":-60}"}: changes a particles clip's settings; naming a "preset" starts afresh from it.
- {"op":"key-set","clip":"c3","prop":"rate","t":2,"v":0,"ease":""}: keys on "rate" (and "opacity", like any clip) let it build up or die away.
Settings in "spec", each optional: "emitter" point, line, box, edge (just outside the frame) or text; "area" [x0,y0,x1,y1] as shares of the frame (a box, a line from one corner to the other, or a point at its centre); "edge" top, bottom, left, right or around; "rate" a second; "burst" at the start; "life" seconds; "speed"; "direction" degrees (0 right, 90 down, -90 up); "spread" degrees; "gravity" (below 0 rises); "wind" (below 0 blows left); "turbulence"; "drag" 0 to 2; "spin" degrees a second; "size" and "sizeEnd"; "colors" (each takes one) and "colorEnd"; "alpha", "fadeIn", "fadeOut" 0 to 1; "flicker"; "sprite" dot, square, streak, star or image (the picture in "src"); "soft" 0 to 1; "variance"; "prerun" seconds already run when it starts; "max" alive at once (at most 2000); "seed" another fall of the same kind. Lengths are pixels of a frame 1080 high (scaled to the real one), speeds a second. "blend" "add" makes it glow.`
}
