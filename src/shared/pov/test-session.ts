import type { Envelope } from '../audio/snap'

/**
 * Synthetic loudness of a gaming session for the tests: one voice chat
 * shared by every player's recording, each recording's own game noise over
 * it, each started and stopped at its own time. Made-up, repeatable, and
 * quick enough to make an hour of.
 */

export const HOP = 0.01

/** A repeatable pseudo-random stream. */
export function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** A voice chat's loudness on home's clock: syllables in phrases, with pauses between. */
export function voiceChat(sec: number, seed: number): Float32Array {
  const r = rng(seed)
  const db = new Float32Array(Math.round(sec / HOP)).fill(-70)
  let t = 0.3
  while (t < sec) {
    const phrase = 1 + r() * 3
    const end = Math.min(sec, t + phrase)
    while (t < end) {
      const syl = 0.08 + r() * 0.25
      const loud = -24 + r() * 8
      for (let i = Math.round(t / HOP); i < Math.min(db.length, Math.round((t + syl) / HOP)); i++) db[i] = loud
      t += syl + 0.03 + r() * 0.12
    }
    t += 0.4 + r() * 2.5
  }
  return db
}

/**
 * A voice chat that hardly talks: bursts of 4 to 20 seconds, with quiet
 * between them so talk is `share` of the time, as in a long session where
 * everyone is busy playing.
 */
export function sparseChat(sec: number, share: number, seed: number): Float32Array {
  const r = rng(seed)
  const db = new Float32Array(Math.round(sec / HOP)).fill(-70)
  let t = 5
  while (t < sec) {
    const burst = 4 + r() * 16
    const end = Math.min(sec, t + burst)
    while (t < end) {
      const phrase = Math.min(end, t + 1 + r() * 3)
      while (t < phrase) {
        const syl = 0.08 + r() * 0.25
        const loud = -24 + r() * 8
        for (let i = Math.round(t / HOP); i < Math.min(db.length, Math.round((t + syl) / HOP)); i++) db[i] = loud
        t += syl + 0.03 + r() * 0.12
      }
      t += 0.4 + r() * 1.5
    }
    t += ((burst * (1 - share)) / share) * (0.3 + 1.4 * r())
  }
  return db
}

const mix = (a: number, b: number): number => 10 * Math.log10(10 ** (a / 10) + 10 ** (b / 10))

/**
 * One player's recording: from home's `startSec` (so home's t is this one's
 * t + offset with offset = -startSec), `sec` long, the voice chat in it at
 * `gainDb` and game noise of its own; its clock running `rate` times home's.
 */
export function recording(chat: Float32Array, startSec: number, sec: number, seed: number, gainDb = 0, rate = 1): Envelope {
  const r = rng(seed)
  const db = new Float32Array(Math.round(sec / HOP))
  let game = -50
  for (let i = 0; i < db.length; i++) {
    // Game sound: a wandering bed with bangs of its own.
    game = Math.max(-60, Math.min(-28, game + (r() - 0.5) * 3))
    const bang = r() < 0.002 ? -14 : -80
    const h = Math.round((startSec + (i * HOP) / rate) / HOP)
    const voice = h >= 0 && h < chat.length ? chat[h] + gainDb : -80
    db[i] = mix(mix(voice, game), bang)
  }
  return { hopSec: HOP, db }
}
