import type { TranscriptWord, ZoomKeyframe } from '../shared/types'

/**
 * Sounds people make while thinking. Deliberately conservative: "like",
 * "actually" and "literally" carry meaning often enough that cutting them
 * mangles sentences, so they are not here.
 */
const FILLERS = new Set([
  'um',
  'umm',
  'ummm',
  'uh',
  'uhh',
  'uhhh',
  'er',
  'erm',
  'ah',
  'ahh',
  'hmm',
  'mhm',
  'mm'
])

export interface TightenOptions {
  /** Silence longer than this is cut back to padSec. */
  maxGapSec: number
  /** Breathing room kept around speech so cuts do not clip consonants. */
  padSec: number
  removeFillers: boolean
}

export const DEFAULT_TIGHTEN: TightenOptions = {
  maxGapSec: 0.5,
  padSec: 0.09,
  removeFillers: true
}

export interface Segment {
  start: number
  end: number
}

function isFiller(word: string): boolean {
  return FILLERS.has(word.toLowerCase().replace(/[^a-z]/gi, ''))
}

/**
 * Works out which spans of the clip to keep.
 *
 * Kept words extend the current span while the gap before them is short. A
 * filler forces the span closed at the filler's start and the next one open at
 * its end, so the sound is genuinely gone. Merging across it instead would
 * leave the "um" audible while the caption dropped the word, which is worse
 * than not cutting at all.
 */
export function buildKeepSegments(
  words: TranscriptWord[],
  clipDurationSec: number,
  opts: TightenOptions = DEFAULT_TIGHTEN
): Segment[] {
  const segments: Segment[] = []
  let current: Segment | null = null
  let cutAt: number | null = null

  for (const word of words) {
    if (opts.removeFillers && isFiller(word.text)) {
      if (current) current.end = Math.min(current.end, word.startSec)
      cutAt = word.endSec
      continue
    }

    let start = Math.max(0, word.startSec - opts.padSec)
    const end = Math.min(clipDurationSec, word.endSec + opts.padSec)
    if (cutAt !== null) start = Math.max(start, cutAt)

    if (current && cutAt === null && start - current.end <= opts.maxGapSec) {
      current.end = Math.max(current.end, end)
    } else {
      if (current && current.end > current.start + 0.02) segments.push(current)
      current = { start, end: Math.max(start, end) }
    }
    cutAt = null
  }

  if (current && current.end > current.start + 0.02) segments.push(current)
  return segments.length > 0 ? segments : [{ start: 0, end: clipDurationSec }]
}

export function keptDuration(segments: Segment[]): number {
  return segments.reduce((total, s) => total + (s.end - s.start), 0)
}

/**
 * Maps a time on the original clip to its position after the cuts.
 *
 * A time inside a removed span collapses to the start of the next kept span,
 * which is where it will actually appear.
 */
export function remapTime(t: number, segments: Segment[]): number {
  let elapsed = 0
  for (const s of segments) {
    if (t < s.start) return elapsed
    if (t <= s.end) return elapsed + (t - s.start)
    elapsed += s.end - s.start
  }
  return elapsed
}

/** Drops words that were cut away and re-times the survivors. */
export function tightenWords(words: TranscriptWord[], segments: Segment[]): TranscriptWord[] {
  return words
    .filter((w) => segments.some((s) => w.startSec >= s.start - 1e-6 && w.startSec < s.end))
    .map((w) => ({
      text: w.text,
      startSec: remapTime(w.startSec, segments),
      endSec: remapTime(Math.min(w.endSec, segments[segments.length - 1].end), segments)
    }))
    .filter((w) => w.endSec > w.startSec)
}

export function tightenZooms(zooms: ZoomKeyframe[], segments: Segment[]): ZoomKeyframe[] {
  return zooms.map((z) => ({ ...z, atSec: remapTime(z.atSec, segments) }))
}

/**
 * Builds the ffmpeg select expression for the kept spans.
 *
 * select drops the frames outside them and setpts closes the holes, so the same
 * expression has to drive the audio or the two drift apart.
 */
export function selectExpr(segments: Segment[]): string {
  return segments
    .map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`)
    .join('+')
}
