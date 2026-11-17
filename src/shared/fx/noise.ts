/**
 * Randomness that is the same everywhere: the editor's preview, the export
 * and the tests draw the same speed lines, the same ragged scan edge and the
 * same shake from the same numbers, because every random value here is a
 * hash of where and when it is asked for, never Math.random.
 */

/** A 32-bit hash of whole numbers, well spread: a change of one in any input changes about half the bits. */
export function hash(...ns: number[]): number {
  let h = 0x811c9dc5
  for (const n of ns) {
    h = Math.imul(h ^ (n | 0), 0x01000193)
    h ^= h >>> 15
    h = Math.imul(h, 0x2c1b3c6d)
    h ^= h >>> 12
  }
  h = Math.imul(h ^ (h >>> 16), 0x297a2d39)
  return (h ^ (h >>> 15)) >>> 0
}

/** A number from 0 up to (not including) 1 for these whole numbers. */
export function rand(...ns: number[]): number {
  return hash(...ns) / 4294967296
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)

/** Smooth value noise on a grid of whole numbers, from 0 to 1. */
export function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = fade(x - x0)
  const fy = fade(y - y0)
  const a = rand(seed, x0, y0)
  const b = rand(seed, x0 + 1, y0)
  const c = rand(seed, x0, y0 + 1)
  const d = rand(seed, x0 + 1, y0 + 1)
  const top = a + (b - a) * fx
  const bottom = c + (d - c) * fx
  return top + (bottom - top) * fy
}

/**
 * Turbulence, as After Effects' Turbulent Displace uses it: octaves of value
 * noise, each twice as fine and half as strong, from -1 to 1. `evolve` slides
 * the pattern through time so an edge boils instead of sitting still.
 */
export function turbulence(x: number, y: number, seed: number, octaves = 3, evolve = 0): number {
  let sum = 0
  let weight = 0
  let k = 1
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x * k + evolve * 0.7 * k, y * k - evolve * 0.4 * k, seed + o * 101) * 2 - 1) / k
    weight += 1 / k
    k *= 2
  }
  return sum / weight
}

/**
 * After Effects' wiggle(): a smooth random wander, `freq` times a second,
 * from -1 to 1. Two calls with different seeds give the two axes of a shake.
 */
export function wiggle(t: number, freq: number, seed: number): number {
  const x = t * freq
  const i = Math.floor(x)
  const f = fade(x - i)
  const a = rand(seed, i) * 2 - 1
  const b = rand(seed, i + 1) * 2 - 1
  return a + (b - a) * f
}
