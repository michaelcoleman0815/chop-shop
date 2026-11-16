import { levels, type Envelope } from './snap'

/** A stretch of a recording, in seconds. */
export interface Span {
  startSec: number
  endSec: number
}

export interface VoicedOptions {
  /** Quiet shorter than this does not end a run: the gaps inside a sentence. */
  minGapSec: number
  /** Added at each end, so a run starts and ends in quiet. */
  padSec: number
  /** Runs shorter than this are clicks, not sound worth listening to. */
  minSec: number
}

export const DEFAULT_VOICED: VoicedOptions = { minGapSec: 0.35, padSec: 0.15, minSec: 0.08 }

/**
 * Where there is sound above the room: runs of loud frames, joined across
 * the short gaps between words, by the same threshold the cut snaps words
 * to. Speech, a laugh, a cough and music all count; telling them apart is
 * for the words and the audio map.
 */
export function voicedRegions(env: Envelope, opts: VoicedOptions = DEFAULT_VOICED): Span[] {
  const n = env.db.length
  if (n === 0 || env.hopSec <= 0) return []
  const { threshold } = levels(env)
  const hop = env.hopSec
  const out: Span[] = []
  let start = -1
  let last = -1
  for (let i = 0; i < n; i++) {
    if (env.db[i] >= threshold) {
      if (start < 0) start = i
      last = i
    } else if (start >= 0 && (i - last) * hop > opts.minGapSec) {
      out.push({ startSec: start * hop, endSec: (last + 1) * hop })
      start = -1
    }
  }
  if (start >= 0) out.push({ startSec: start * hop, endSec: (last + 1) * hop })
  const total = n * hop
  return out
    .filter((r) => r.endSec - r.startSec >= opts.minSec)
    .map((r) => ({ startSec: Math.max(0, r.startSec - opts.padSec), endSec: Math.min(total, r.endSec + opts.padSec) }))
}
