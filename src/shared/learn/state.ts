import type { Envelope } from '../audio/snap'
import { seconds } from '../presets/preset'
import { fitHabits, habitsStyle } from './habits'
import { CUTTERS, evaluateCutter, styleCutter, type CutterReport } from './metrics'
import type { Habits, LabelledPair } from './schema'
import { missedReason, summarizeLearning, type LearnSummary } from './summary'

/**
 * Everything the brand page shows about learning from someone's edits, from
 * the videos learned so far: how /tighten does against them, the habits they
 * add up to, and the sentence that says so.
 */

export interface LearnedVideo {
  id: string
  title: string
  /** File names of the recordings it was cut from. */
  recordings: string[]
  finished: string
  createdAt: string
  kept: number
  cut: number
  /** What could not be labelled, as sentences. */
  notes: string[]
}

export interface LearnState {
  videos: LearnedVideo[]
  /** How /tighten does against every learned video. */
  report: CutterReport | null
  /** The habits every learned video adds up to: what "Use these habits" keeps. */
  habits: Habits | null
  summary: LearnSummary | null
  /** Why the score is what it is, when one reason stands out. */
  aside: string | null
}

export const EMPTY_LEARN_STATE: LearnState = { videos: [], report: null, habits: null, summary: null, aside: null }

/** What learning from one more video comes back with. */
export type LearnRunResult =
  | { ok: true; video: LearnedVideo; state: LearnState }
  | { ok: false; message: string; state: LearnState }

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function learnedVideo(pair: LabelledPair): LearnedVideo {
  return {
    id: pair.id,
    title: pair.title,
    recordings: pair.recordings.map((r) => fileName(r.path)),
    finished: fileName(pair.finished.path),
    createdAt: pair.createdAt,
    kept: pair.words.filter((w) => w.label === 'kept').length,
    cut: pair.words.filter((w) => w.label === 'cut').length,
    notes: pair.issues.map((i) => i.text)
  }
}

export function learnState(
  pairs: LabelledPair[],
  opts: { envelope?: (pair: LabelledPair, source: string) => Envelope | null; at?: string } = {}
): LearnState {
  const videos = [...pairs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(learnedVideo)
  if (pairs.length === 0) return { ...EMPTY_LEARN_STATE }
  const tighten = CUTTERS[0]
  const report = evaluateCutter(tighten.cut, pairs, { envelope: opts.envelope })
  const habits = fitHabits(pairs, opts.at)
  const summary = summarizeLearning(report, habits, tighten.name)
  if (habits) {
    const mine = evaluateCutter(styleCutter(habitsStyle(habits)), pairs)
    if (mine.pauses.cutterSec !== null) {
      summary.details.push({
        label: `${tighten.name} with these habits`,
        value: `leaves pauses of ${seconds(mine.pauses.cutterSec)} on these videos`
      })
    }
  }
  return { videos, report, habits, summary, aside: missedReason(report) }
}
