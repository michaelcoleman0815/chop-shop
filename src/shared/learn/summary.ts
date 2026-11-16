import { seconds } from '../presets/preset'
import { habitDetails, habitFacts, habitsSentence } from './habits'
import type { CutterReport } from './metrics'
import type { Habits } from './schema'

/**
 * What learning from someone's edits says back: one plain sentence, at most
 * three facts, and every number behind Details.
 */

export interface LearnSummary {
  sentence: string
  facts: string[]
  details: { label: string; value: string }[]
}

const pct = (v: number): string => `${Math.round(v * 100)}%`

/** "Across 3 videos, I cut what you cut 91% of the time and kept what you kept 96%." */
export function accuracySentence(report: CutterReport): string {
  if (report.videos === 0 || report.words === 0) return ''
  const across = report.videos === 1 ? 'On this video' : `Across ${report.videos} videos`
  const keeps = report.keeps === null ? null : pct(report.keeps)
  if (report.removals.recall === null) {
    return keeps ? `${across}, you kept every word, and I kept ${keeps} of them.` : ''
  }
  return `${across}, I cut what you cut ${pct(report.removals.recall)} of the time${keeps ? ` and kept what you kept ${keeps}` : ''}.`
}

export function summarizeLearning(report: CutterReport, habits: Habits | null, cutterName = '/tighten'): LearnSummary {
  const sentence = [accuracySentence(report), habits ? habitsSentence(habits) : ''].filter(Boolean).join(' ')
  const facts = habits ? habitFacts(habits) : []
  const r = report.removals
  const details: { label: string; value: string }[] = [
    { label: 'Videos', value: String(report.videos) },
    { label: 'Words compared', value: String(report.words) }
  ]
  if (r.recall !== null)
    details.push({ label: `${cutterName} cut what you cut`, value: `${r.both} of ${r.creator} (${pct(r.recall)})` })
  if (r.precision !== null) {
    details.push({ label: `What ${cutterName} cut, you cut`, value: `${r.both} of ${r.cutter} (${pct(r.precision)})` })
  }
  if (report.keeps !== null) details.push({ label: `${cutterName} kept what you kept`, value: pct(report.keeps) })
  if (r.missedInTakes > 0) {
    details.push({ label: 'Missed words in retakes', value: `${r.missedInTakes} of ${r.creator - r.both}` })
  }
  if (report.boundaryMs.median !== null) {
    details.push({
      label: 'Same cut, how far apart',
      value: `${report.boundaryMs.median} ms typically, ${report.boundaryMs.p90} ms (9 in 10)`
    })
  }
  if (report.pauses.creatorSec !== null && report.pauses.cutterSec !== null) {
    details.push({
      label: 'Pauses left',
      value: `yours ${seconds(report.pauses.creatorSec)}, ${cutterName} ${seconds(report.pauses.cutterSec)}`
    })
  }
  if (habits) details.push(...habitDetails(habits))
  return { sentence: sentence || "I couldn't learn anything from these yet.", facts, details }
}

/**
 * Why the score is what it is, when one reason dominates: a cutter that
 * does not look for retakes misses most of what a creator who does many
 * retakes cuts.
 */
export function missedReason(report: CutterReport, cutterName = '/tighten'): string | null {
  const missed = report.removals.creator - report.removals.both
  if (missed < 5 || report.removals.missedInTakes < missed / 2) return null
  return `Most of what I missed were earlier takes of a line. ${cutterName} doesn't look for retakes yet.`
}
