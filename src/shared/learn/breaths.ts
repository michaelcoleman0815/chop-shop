import { levels, type Envelope } from '../audio/snap'
import type { Word } from '../edit/schema'
import { tilt, type Features } from './features'

/**
 * Breaths in a recording: stretches clearly above the room but well below
 * the voice, 0.1 to 0.8 s long, and noisy rather than voiced (about as much
 * energy up high as down low). Found so the habits can say whether the
 * creator keeps them.
 *
 * Listening snaps a word's edges onto any sound right beside it, so a breath
 * just after a word or just before one often ends up inside that word's
 * edges. Breaths are therefore looked for everywhere and only refused where
 * they run into the middle of a word, where the speech itself is.
 */

export interface FoundBreath {
  startSec: number
  endSec: number
}

const MIN_FRAMES = 10
const MAX_FRAMES = 80
/** How far in from each edge of a word its speech is taken to start and stop. */
const CORE_SEC = 0.05

export function findBreaths(words: Word[], env: Envelope, features: Features | null = null): FoundBreath[] {
  if (env.db.length === 0 || words.length < 2) return []
  const { floor, speech } = levels(env)
  const hop = env.hopSec
  const cores = [...words]
    .sort((a, b) => a.startSec - b.startSec)
    .map((w) => {
      const mid = (w.startSec + w.endSec) / 2
      return w.endSec - w.startSec > 2 * CORE_SEC ? [w.startSec + CORE_SEC, w.endSec - CORE_SEC] : [mid, mid]
    })
  const breathy = (t: number): boolean => {
    const v = env.db[t]
    if (!(v > floor + 9 && v < speech - 3)) return false
    return features === null || tilt(features, t) > -12
  }
  const out: FoundBreath[] = []
  let c = 0
  const close = (start: number, last: number): void => {
    const n = last - start + 1
    if (n < MIN_FRAMES || n > MAX_FRAMES) return
    const a = start * hop
    const b = (last + 1) * hop
    while (c < cores.length && cores[c][1] < a) c++
    let inSpeech = 0
    for (let i = c; i < cores.length && cores[i][0] < b; i++) {
      inSpeech += Math.max(0, Math.min(b, cores[i][1]) - Math.max(a, cores[i][0]))
    }
    if (inSpeech <= 0.25 * (b - a)) out.push({ startSec: a, endSec: b })
  }
  let start = -1
  let last = -1
  let holes = 0
  for (let t = 0; t < env.db.length; t++) {
    if (breathy(t)) {
      if (start < 0) start = t
      last = t
      holes = 0
    } else if (start >= 0 && ++holes > 2) {
      close(start, last)
      start = -1
      holes = 0
    }
  }
  if (start >= 0) close(start, last)
  return out
}
