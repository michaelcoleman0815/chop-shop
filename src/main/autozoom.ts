import { punchIn } from './reframe'
import type { TranscriptWord, ZoomKeyframe } from '../shared/types'

/**
 * Places punch-ins without anyone marking them by hand.
 *
 * Emphasis in speech shows up as a word held longer than its neighbours, so the
 * outliers by duration are the candidates. Punches are spaced out because a
 * clip that zooms every two seconds reads as a glitch rather than emphasis.
 */
export function autoZooms(words: TranscriptWord[], clipDurationSec: number): ZoomKeyframe[] {
  if (words.length < 4) return []

  const durations = words.map((w) => w.endSec - w.startSec).filter((d) => d > 0)
  if (durations.length === 0) return []
  const sorted = [...durations].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]

  // At most one punch every 6 seconds, and never more than three in a clip.
  const minGap = 6
  const maxPunches = Math.max(1, Math.min(3, Math.floor(clipDurationSec / 8)))

  const candidates = words
    .filter((w) => w.endSec - w.startSec > median * 1.6 && w.startSec > 1)
    .sort((a, b) => b.endSec - b.startSec - (a.endSec - a.startSec))

  const chosen: TranscriptWord[] = []
  for (const word of candidates) {
    if (chosen.length >= maxPunches) break
    if (chosen.every((c) => Math.abs(c.startSec - word.startSec) >= minGap)) chosen.push(word)
  }

  return chosen
    .sort((a, b) => a.startSec - b.startSec)
    .flatMap((w) => punchIn(w.startSec, Math.max(0.6, w.endSec - w.startSec), 1.22, 0.5, 0.45))
}
