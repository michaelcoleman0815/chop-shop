import type { ParticlePreset } from './schema'

/**
 * A particles clip added, as describePlan says it (shared/tracks/words):
 * "snow falls over the edit", "sparks fly over the edit".
 */

const DOES: Record<ParticlePreset, string> = {
  snow: 'snow falls',
  confetti: 'confetti falls',
  sparks: 'sparks fly',
  dust: 'dust floats',
  embers: 'embers rise',
  rain: 'rain falls',
  bokeh: 'soft lights drift',
  smoke: 'smoke rises'
}

export function particlePhrase(op: Record<string, unknown>): string {
  const preset = (op.particles as { preset?: ParticlePreset } | undefined)?.preset
  return `${preset && DOES[preset] ? DOES[preset] : 'particles drift'} over the edit`
}
