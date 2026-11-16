import { levels, type Envelope } from '../audio/snap'
import type { Word } from '../edit/schema'
import { tilt, type Features } from './features'

/**
 * Breaths in the pauses of a recording: stretches between words that are
 * clearly above the room but well below the voice, 0.1 to 0.8 s long, and
 * noisy rather than voiced (as much energy up high as down low). Found so
 * the habits can say whether the creator keeps them.
 *
 * A breath right against a word may already be inside that word's edges,
 * because listening snaps a word onto any sound at its start; those are not
 * counted, so this reads the breaths in the open.
 */

export interface FoundBreath {
  startSec: number
  endSec: number
}

const EDGE_SEC = 0.04
const MIN_FRAMES = 10
const MAX_FRAMES = 80

export function findBreaths(words: Word[], env: Envelope, features: Features | null = null): FoundBreath[] {
  if (env.db.length === 0 || words.length < 2) return []
  const { floor, speech } = levels(env)
  const hop = env.hopSec
  const sorted = [...words].sort((a, b) => a.startSec - b.startSec)
  const out: FoundBreath[] = []
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1].endSec + EDGE_SEC
    const to = sorted[i].startSec - EDGE_SEC
    if (to - from < MIN_FRAMES * hop) continue
    const a = Math.ceil(from / hop)
    const b = Math.min(env.db.length, Math.floor(to / hop))
    const breathy = (t: number): boolean => {
      const v = env.db[t]
      if (!(v > floor + 9 && v < speech - 3)) return false
      return features === null || tilt(features, t) > -12
    }
    let start = -1
    let holes = 0
    let last = -1
    const close = (): void => {
      if (start >= 0) {
        const n = last - start + 1
        if (n >= MIN_FRAMES && n <= MAX_FRAMES) out.push({ startSec: start * hop, endSec: (last + 1) * hop })
      }
      start = -1
      holes = 0
    }
    for (let t = a; t < b; t++) {
      if (breathy(t)) {
        if (start < 0) start = t
        last = t
        holes = 0
      } else if (start >= 0 && ++holes > 2) close()
    }
    close()
  }
  return out
}
