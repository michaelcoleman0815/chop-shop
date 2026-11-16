import type { EditDoc, Word } from '../edit/schema'
import { frameAt, type MouthSeries } from './series'

/**
 * Who is talking. Speech in the audio while the mouth on screen stays still
 * is someone off camera: a question from behind the camera, a co-host out of
 * shot, a voice on a call. Those words are marked so takes and the planner
 * can treat them differently (keep the question as context, cut it, or put
 * it on screen as text).
 *
 * Only words whose mouth could be read count either way. With no face, a
 * covered mouth or a turned head there is nothing to say, and nothing is
 * marked.
 */

export interface OffCameraOptions {
  /** A word whose mouth moves less than this on average (in units of the face's talking) was not said by it. */
  still: number
  /**
   * ...and whose mouth stays this closed (0 at rest, 1 typically open): a
   * held vowel moves little but is open, so it still belongs to the face.
   */
  closed: number
  /** Most of the word's frames must have a readable mouth. */
  readable: number
  /** Shorter stretches than this are left alone: one quiet "mm" is not someone else. */
  minSec: number
  /** Words this close together belong to one stretch. */
  joinSec: number
}

export const DEFAULT_OFF_CAMERA: OffCameraOptions = {
  still: 0.22,
  closed: 0.3,
  readable: 0.75,
  minSec: 0.5,
  joinSec: 0.7
}

/** Marks the words said while the watched mouth was still, and clears the mark everywhere else. */
export function markOffCamera(words: Word[], series: MouthSeries, opts: OffCameraOptions = DEFAULT_OFF_CAMERA): Word[] {
  const quietMouth = new Map<string, boolean>()
  for (const w of words) {
    const a = Math.max(0, frameAt(series, w.startSec))
    const b = frameAt(series, w.endSec)
    if (b < a) continue
    let read = 0
    let sum = 0
    let peak = 0
    let open = 0
    for (let i = a; i <= b; i++) {
      const v = series.talk[i]
      const o = series.open[i]
      if (!Number.isFinite(v) || !Number.isFinite(o)) continue
      read++
      sum += v
      open += o
      peak = Math.max(peak, v)
    }
    const frames = b - a + 1
    if (read / frames < opts.readable) continue
    quietMouth.set(w.id, sum / read < opts.still && peak < opts.still * 3 && open / read < opts.closed)
  }

  // Stretches of quiet-mouthed words, long enough to be someone else speaking.
  const sorted = [...words].sort((a, b) =>
    a.source === b.source ? a.startSec - b.startSec : a.source < b.source ? -1 : 1
  )
  const marked = new Set<string>()
  let run: Word[] = []
  const close = (): void => {
    if (run.length > 0) {
      const spoken = run.reduce((s, w) => s + (w.endSec - w.startSec), 0)
      if (spoken >= opts.minSec) for (const w of run) marked.add(w.id)
    }
    run = []
  }
  for (const w of sorted) {
    const prev = run[run.length - 1]
    if (quietMouth.get(w.id) === true) {
      if (prev && (prev.source !== w.source || w.startSec - prev.endSec > opts.joinSec)) close()
      run.push(w)
    } else close()
  }
  close()
  return words.map(({ offCamera: _o, ...w }) => (marked.has(w.id) ? { ...w, offCamera: true } : w))
}

/** Runs of words said off camera, as [first id, last id] per source, in order. */
export function offCameraRuns(doc: Pick<EditDoc, 'words'>): { source: string; from: string; to: string }[] {
  const runs: { source: string; from: string; to: string }[] = []
  let open: { source: string; from: string; to: string } | null = null
  for (const w of doc.words) {
    if (w.offCamera && open && open.source === w.source) open.to = w.id
    else if (w.offCamera) {
      open = { source: w.source, from: w.id, to: w.id }
      runs.push(open)
    } else open = null
  }
  return runs
}

/**
 * One line for the planner's request, or null when nobody spoke off camera:
 * "Said off camera ...: w12-w18, w240-w251."
 */
export function offCameraLine(doc: Pick<EditDoc, 'words'>): string | null {
  const runs = offCameraRuns(doc)
  if (runs.length === 0) return null
  const spans = runs.map((r) => (r.from === r.to ? r.from : `${r.from}-${r.to}`))
  return `Said off camera, while the mouth on screen was still (such as a question from behind the camera): ${spans.join(', ')}.`
}
