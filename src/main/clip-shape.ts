import type { SuggestedClip, TranscriptWord } from '../shared/types'

export interface RawClip {
  startSec: number
  endSec: number
  title: string
  hook: string
  reason: string
  score: number
}

/**
 * Renders the transcript as timestamped lines.
 *
 * Word-level timing is what the captions need but it is noise to a reader, and
 * it triples the token count. Lines break on sentence ends and on pauses, which
 * is also where a clip can legitimately start or stop.
 */
export function transcriptLines(words: TranscriptWord[]): string {
  const lines: string[] = []
  let current: TranscriptWord[] = []

  const flush = (): void => {
    if (current.length === 0) return
    lines.push(`[${current[0].startSec.toFixed(1)}] ${current.map((w) => w.text).join(' ')}`)
    current = []
  }

  for (let i = 0; i < words.length; i++) {
    current.push(words[i])
    const endsSentence = /[.!?]$/.test(words[i].text)
    const gap = words[i + 1] ? words[i + 1].startSec - words[i].endSec : 0
    if (endsSentence || gap > 0.8 || current.length >= 30) flush()
  }
  flush()

  return lines.join('\n')
}

/**
 * Trusts the model's judgement about which moments matter, and nothing about
 * its arithmetic. Times get clamped to the video, snapped to word boundaries so
 * a clip never opens mid-word, and dropped if they are too short to use.
 */
export function normaliseClips(
  clips: RawClip[],
  words: TranscriptWord[],
  durationSec: number
): SuggestedClip[] {
  const snap = (t: number, pick: (w: TranscriptWord) => number): number => {
    let best: number | null = null
    for (const w of words) {
      const v = pick(w)
      if (Math.abs(v - t) < 1.2 && (best === null || Math.abs(v - t) < Math.abs(best - t))) {
        best = v
      }
    }
    return best ?? t
  }

  return clips
    .map((c) => {
      const rawStart = Math.min(c.startSec, c.endSec)
      const rawEnd = Math.max(c.startSec, c.endSec)
      const start = Math.max(0, Math.min(durationSec, snap(rawStart, (w) => w.startSec)))
      const end = Math.max(0, Math.min(durationSec, snap(rawEnd, (w) => w.endSec)))
      return {
        startSec: start,
        // A little lead-out stops the last word being clipped by the encoder.
        endSec: Math.min(durationSec, end + 0.15),
        title: c.title.trim(),
        hook: c.hook.trim(),
        reason: c.reason.trim(),
        score: Math.max(0, Math.min(100, Math.round(c.score)))
      }
    })
    .filter((c) => c.endSec - c.startSec >= 5)
    .sort((a, b) => b.score - a.score)
}
