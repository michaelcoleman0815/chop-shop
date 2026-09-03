import type { TranscriptWord } from '../shared/types'

/**
 * Finds sung music inside a recording, from the transcript alone.
 *
 * A worship set matters more than it looks. A CCLI licence covers performing a
 * song in a service; it does not stop a Content ID match, and YouTube blocks a
 * claimed Short under three minutes outright rather than demonetising it. A
 * clip with a worship bed under it does not underperform, it disappears.
 *
 * Speech density cannot find it, because whisper transcribes singing as words:
 * measured across a real 138 minute service, every minute ran 60 to 180 words
 * including the worship set. What separates singing is repetition. Over that
 * same service, six consecutive minutes of a song held a 9 to 14 per cent
 * unique-word ratio with one line repeating seventeen times, while the most
 * repetitive preaching in the recording never fell below 37 per cent.
 */

/** Whisper marks passages it hears as music with these. */
const MUSIC_MARKS = /[♪♫♬\u{1F3B5}\u{1F3B6}]/u

export interface MusicRegion {
  startSec: number
  endSec: number
  /** Share of unique words, the thing that actually separates song from speech. */
  uniqueRatio: number
}

export interface MusicOptions {
  /** Below this share of unique words, a window is singing rather than talking. */
  uniqueBelow: number
  windowSec: number
  /** A single repetitive minute is a preacher making a point, not a song. */
  minRunSec: number
}

export const DEFAULT_MUSIC: MusicOptions = {
  // Calibrated against a full 138 minute service at this window size: the
  // worship set ran 0.16 to 0.30 and speech either side of it sat at 0.66 to
  // 0.76. Of 275 windows only thirteen fell below 0.36, twelve of them the
  // song. 0.32 takes the whole set and leaves the one repetitive passage of
  // preaching alone.
  uniqueBelow: 0.32,
  windowSec: 30,
  minRunSec: 75
}

export function detectMusic(
  words: TranscriptWord[],
  opts: MusicOptions = DEFAULT_MUSIC
): MusicRegion[] {
  if (words.length === 0) return []
  const end = words[words.length - 1].endSec
  const windows: { start: number; end: number; ratio: number; sung: boolean }[] = []

  for (let at = 0; at < end; at += opts.windowSec) {
    const inWindow = words.filter((w) => w.startSec >= at && w.startSec < at + opts.windowSec)
    // Too few words to judge: silence, or a pause between songs. Not evidence.
    if (inWindow.length < 20) continue
    const texts = inWindow.map((w) => w.text.trim().toLowerCase())
    const ratio = new Set(texts).size / texts.length
    const marked = inWindow.filter((w) => MUSIC_MARKS.test(w.text)).length
    windows.push({
      start: at,
      end: at + opts.windowSec,
      ratio,
      // Whisper's own music marks are worth as much as the ratio when it uses
      // them, and it does not use them on speech.
      sung: ratio < opts.uniqueBelow || marked >= 2
    })
  }

  const regions: MusicRegion[] = []
  let run: typeof windows = []
  const flush = (): void => {
    if (run.length === 0) return
    const span = run[run.length - 1].end - run[0].start
    if (span >= opts.minRunSec) {
      regions.push({
        startSec: run[0].start,
        endSec: run[run.length - 1].end,
        uniqueRatio: run.reduce((n, w) => n + w.ratio, 0) / run.length
      })
    }
    run = []
  }

  for (const w of windows) {
    if (w.sung) run.push(w)
    else flush()
  }
  flush()
  return regions
}

/** Whether a clip overlaps sung music enough to be at risk of a claim. */
export function overlapsMusic(
  startSec: number,
  endSec: number,
  regions: MusicRegion[]
): boolean {
  const length = Math.max(0.1, endSec - startSec)
  for (const r of regions) {
    const overlap = Math.min(endSec, r.endSec) - Math.max(startSec, r.startSec)
    // A second of a song bleeding into the top of a clip is not the problem a
    // whole verse under it is.
    if (overlap > Math.min(4, length * 0.15)) return true
  }
  return false
}
