import type { Resolved, ResolvedBeat } from './edit/resolve'
import type { Source, Word } from './edit/schema'

/**
 * Plain talk: the stretches of an edit where only the speaker is on screen, as against footage that changes by itself
 * (a cutaway, a screen, an article). Told to the planner before it plans, so it spreads what it adds over them, and
 * measured again in what it made, so a long stretch left bare is seen and filled (main/planner).
 */

export interface Talk {
  /** Its first and last words. */
  from: string
  to: string
  /** When it plays, in the edit's seconds. */
  start: number
  end: number
}

/** A stretch shorter than this is over before it is dull. */
const WORTH_NAMING = 6
/** The longest anyone should go with nothing new on screen. */
export const LONGEST_BARE = 12

/** Whether a beat shows a face: at its own readings, or at the one nearest when it is too short to hold any; null unread. */
export function showsSpeaker(beat: ResolvedBeat, resolved: Resolved, sources: Source[]): boolean | null {
  const pieces = resolved.pieces.filter((p) => p.beat === beat.id)
  const faces = sources.find((s) => s.id === pieces[0]?.source)?.faces
  if (!faces || faces.samples.length === 0 || pieces.length === 0) return null
  const from = Math.min(...pieces.map((p) => p.srcStart))
  const to = Math.max(...pieces.map((p) => p.srcEnd))
  const own = faces.samples.filter((s) => s.t >= from - 0.2 && s.t <= to + 0.2)
  const read = own.length ? own : [faces.samples.reduce((a, s) => (Math.abs(s.t - (from + to) / 2) < Math.abs(a.t - (from + to) / 2) ? s : a))]
  return read.filter((s) => s.faces.length > 0).length * 2 >= read.length
}

/** The stretches of plain talk; none where no faces have been read. */
export function talkStretches(resolved: Resolved, sources: Source[], own: (beat: string) => boolean = () => true): Talk[] {
  const out: Talk[] = []
  let open: Talk | null = null
  for (const b of resolved.beats) {
    const talk = own(b.id) && b.words.length > 0 && showsSpeaker(b, resolved, sources) === true
    if (!talk) {
      open = null
      continue
    }
    if (open) {
      open.to = b.words[b.words.length - 1]
      open.end = b.outEnd
    } else {
      open = { from: b.words[0], to: b.words[b.words.length - 1], start: b.outStart, end: b.outEnd }
      out.push(open)
    }
  }
  return out
}

/** The parts of those stretches with nothing up for too long, given when each graphic is up. */
export function bareStretches(talk: Talk[], up: { start: number; end: number }[], words: Resolved['words'], longest = LONGEST_BARE): Talk[] {
  const out: Talk[] = []
  for (const t of talk) {
    const over = up.filter((u) => u.end > t.start && u.start < t.end).sort((a, b) => a.start - b.start)
    let at = t.start
    const gaps: [number, number][] = []
    for (const u of over) {
      if (u.start > at) gaps.push([at, u.start])
      at = Math.max(at, u.end)
    }
    if (at < t.end) gaps.push([at, t.end])
    for (const [start, end] of gaps) {
      if (end - start <= longest) continue
      const said = words.filter((w) => w.outStart >= start - 0.01 && w.outEnd <= end + 0.3)
      if (said.length > 1) out.push({ from: said[0].id, to: said[said.length - 1].id, start, end })
    }
  }
  return out
}

/** What is said in a stretch, for a line about it. */
const saidIn = (t: Talk, words: Pick<Word, 'id' | 'text'>[], most: number): string => {
  const a = words.findIndex((w) => w.id === t.from)
  const b = words.findIndex((w) => w.id === t.to)
  const text = words.slice(a, b + 1).map((w) => w.text)
  return text.length > most ? `${text.slice(0, most).join(' ')} …` : text.join(' ')
}

/** The stretches worth naming, a line each, for the planner. */
export const talkLines = (talk: Talk[]): string[] =>
  talk.filter((t) => t.end - t.start >= WORTH_NAMING).map((t) => `${t.from} to ${t.to}: ${(t.end - t.start).toFixed(1)} s of plain talk`)

/** Stretches left bare, a line each, with what is said in them. */
export const bareLines = (bare: Talk[], words: Pick<Word, 'id' | 'text'>[]): string[] =>
  bare.map((t) => `${t.from} to ${t.to}, ${(t.end - t.start).toFixed(0)} seconds with nothing new on screen: “${saidIn(t, words, 60)}”`)
