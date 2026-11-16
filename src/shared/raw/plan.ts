import { currentCut } from '../edit/doc'
import { applyOps } from '../edit/ops'
import { indexWords, resolveCut, type Resolved } from '../edit/resolve'
import type { Cut, EditDoc, Op, Word } from '../edit/schema'
import { clock, seconds } from '../presets/preset'
import {
  analyzeTakes,
  DEFAULT_TAKES,
  ordinal,
  type TakeAudio,
  type TakeGroup,
  type TakesAnalysis,
  type TakesOptions
} from './takes'

/**
 * Takes as an edit: strikes on the takes that lose, a move when the keeper
 * was filmed somewhere else, one sentence for the version, and the removals
 * that were not certain enough, left in and offered instead.
 *
 * Nothing is deleted. A struck take stays in the doc, so "use the second
 * take of the intro" is a strike and an unstrike away, from a sentence, the
 * planner or the takes panel.
 */

/** At or above this a removal is made; between offerAt and this it is offered. */
export interface TakesThresholds {
  applyAt: number
  offerAt: number
}

export const DEFAULT_THRESHOLDS: TakesThresholds = { applyAt: 0.75, offerAt: 0.45 }

export interface TakesOffer {
  /** Where it plays in the cut, for "at 2:14". */
  outSec: number
  kind: 'retake' | 'false start' | 'set-up talk'
  /** What it is, in a few words, for the takes panel: "a possible retake of “The battery lasts”". */
  what: string
  ops: Op[]
}

export interface TakesPlan {
  ops: Op[]
  /** One sentence for the version, empty when there was nothing to do. */
  summary: string
  /** The sentence that offers the uncertain ones, empty when there are none. */
  offerText: string
  offers: TakesOffer[]
  counts: { lines: number; takes: number; falseStarts: number; setup: number; deadAirSec: number }
  analyses: TakesAnalysis[]
}

export interface TakesPlanOptions {
  takes?: TakesOptions
  thresholds?: TakesThresholds
  /** What Cutalong heard, by source id. */
  audio?: Record<string, TakeAudio | undefined>
}

/** The takes of every recording in a doc. */
export function takesOf(doc: EditDoc, opts: TakesPlanOptions = {}): TakesAnalysis[] {
  return doc.sources.map((s) => analyzeTakes(doc.words, s.id, opts.audio?.[s.id] ?? null, opts.takes ?? DEFAULT_TAKES))
}

interface Span {
  from: string
  to: string
}

/** Strike ops covering these spans, skipping words already struck, in word order. */
export function strikeOps(doc: EditDoc, spans: Span[], cut: Cut = currentCut(doc)): Op[] {
  const index = indexWords(doc.words)
  const removed = new Set(cut.removed)
  const marked = new Set<number>()
  for (const s of spans) {
    const a = index.pos.get(s.from)
    const b = index.pos.get(s.to)
    if (a === undefined || b === undefined) continue
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (!removed.has(index.words[i].id)) marked.add(i)
  }
  const sorted = [...marked].sort((x, y) => x - y)
  const ops: Op[] = []
  let runStart = -1
  let prev = -2
  const flush = (): void => {
    if (runStart >= 0) ops.push({ op: 'strike', from: index.words[runStart].id, to: index.words[prev].id })
  }
  for (const i of sorted) {
    const sameSource = prev >= 0 && index.words[prev].source === index.words[i].source
    if (i !== prev + 1 || !sameSource) {
      flush()
      runStart = i
    }
    prev = i
  }
  flush()
  return ops
}

/** Unstrike ops for spans, only over words currently struck. */
function unstrikeOps(doc: EditDoc, spans: Span[], cut: Cut): Op[] {
  const index = indexWords(doc.words)
  const removed = new Set(cut.removed)
  const ops: Op[] = []
  for (const s of spans) {
    const a = index.pos.get(s.from)
    const b = index.pos.get(s.to)
    if (a === undefined || b === undefined) continue
    let start = -1
    for (let i = a; i <= b + 1; i++) {
      const isStruck = i <= b && removed.has(index.words[i].id)
      if (isStruck && start < 0) start = i
      if (!isStruck && start >= 0) {
        ops.push({ op: 'unstrike', from: index.words[start].id, to: index.words[i - 1].id })
        start = -1
      }
    }
  }
  return ops
}

/** The beat a word sits in, by position in the cut. */
function beatOf(cut: Cut, doc: EditDoc, wordId: string): number {
  const index = indexWords(doc.words)
  const p = index.pos.get(wordId)
  if (p === undefined) return -1
  return cut.beats.findIndex((b) => {
    if (b.from === null || b.to === null) return false
    const a = index.pos.get(b.from)
    const z = index.pos.get(b.to)
    return a !== undefined && z !== undefined && a <= p && p <= z
  })
}

/**
 * Ops that move a take's words to play where an earlier take of the same
 * line sat: split them out of their beat, then move the pieces in front of
 * the beat holding the earlier take.
 */
function moveOps(doc: EditDoc, cut: Cut, take: Span, target: Span): { ops: Op[]; cut: Cut } {
  const context = { words: doc.words, sources: doc.sources }
  const index = indexWords(doc.words)
  let running = cut
  const ops: Op[] = []
  const push = (op: Op): boolean => {
    const r = applyOps(running, [op], context)
    if (r.applied.length === 0) return false
    running = r.cut
    ops.push(op)
    return true
  }
  const splitBefore = (wordId: string): void => {
    const bi = beatOf(running, doc, wordId)
    if (bi < 0) return
    const beat = running.beats[bi]
    if (beat.from !== wordId) push({ op: 'split', beat: beat.id, at: wordId })
  }
  const afterTake = index.words[(index.pos.get(take.to) ?? -1) + 1]
  splitBefore(take.from)
  if (afterTake && afterTake.source === index.words[index.pos.get(take.to) ?? 0]?.source) splitBefore(afterTake.id)
  splitBefore(target.from)
  // The beats that now hold exactly the take, in order.
  const a = index.pos.get(take.from) ?? 0
  const z = index.pos.get(take.to) ?? 0
  const moving = running.beats
    .filter((b) => {
      if (b.from === null || b.to === null) return false
      const p = index.pos.get(b.from)
      const q = index.pos.get(b.to)
      return p !== undefined && q !== undefined && p >= a && q <= z
    })
    .map((b) => b.id)
  let to = beatOf(running, doc, target.from)
  if (to < 0) return { ops: [], cut }
  for (const id of moving) {
    const at = running.beats.findIndex((b) => b.id === id)
    if (at < 0) continue
    const dest = at < to ? to - 1 : to
    if (at !== dest) push({ op: 'move', beat: id, to: dest })
    to = running.beats.findIndex((b) => b.id === id) + 1
  }
  return { ops, cut: running }
}

/** True when lines other than this group's takes play between its first take and the keeper. */
function filmedElsewhere(group: TakeGroup, words: Word[]): boolean {
  const first = group.takes[0]
  const keep = group.takes[group.chosen]
  if (group.chosen === 0) return false
  const inGroup = (t: number): boolean => group.takes.some((x) => t >= x.startSec - 0.01 && t <= x.endSec + 0.01)
  return words.some(
    (w) =>
      w.startSec > first.endSec + 0.01 &&
      w.endSec < keep.startSec - 0.01 &&
      !inGroup(w.startSec) &&
      /[\p{L}\p{N}]/u.test(w.text)
  )
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** How a line is named in a reply: "the intro", or its opening words in quotes. */
export function lineName(group: TakeGroup): string {
  return group.intro ? 'the intro' : `“${group.label}”`
}

/** Where a word plays in a resolved cut, or null when it does not play. */
function outTime(resolved: Resolved, wordId: string): number | null {
  return resolved.words.find((w) => w.id === wordId)?.outStart ?? null
}

/** The nearest kept word at or after a word, for timing an offer that is not yet cut. */
function playsAt(resolved: Resolved, doc: EditDoc, wordId: string): number {
  const direct = outTime(resolved, wordId)
  if (direct !== null) return direct
  const index = indexWords(doc.words)
  const p = index.pos.get(wordId) ?? 0
  for (let i = p; i < index.words.length; i++) {
    const t = outTime(resolved, index.words[i].id)
    if (t !== null) return t
  }
  return resolved.durationSec
}

export function planTakes(doc: EditDoc, opts: TakesPlanOptions = {}, from: Cut = currentCut(doc)): TakesPlan {
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS
  const analyses = takesOf(doc, opts)
  const context = { words: doc.words, sources: doc.sources }
  const removed = new Set(from.removed)

  const sure: Span[] = []
  const offered: { span: Span[]; kind: TakesOffer['kind']; what: string; at: string }[] = []
  let takes = 0
  let falseStarts = 0
  let setup = 0
  const applied: TakeGroup[] = []
  const moves: { group: TakeGroup }[] = []

  for (const a of analyses) {
    const sourceWords = doc.words.filter((w) => w.source === a.source)
    for (const r of a.restarts) {
      // Already cut by the person, or by an earlier /takes: nothing to say.
      if (removed.has(r.from) && removed.has(r.to)) continue
      if (r.confidence >= thresholds.applyAt) {
        sure.push(r)
        falseStarts++
      } else if (r.confidence >= thresholds.offerAt) {
        offered.push({
          span: [r],
          kind: 'false start',
          what: `a possible false start before “${r.repeated}”`,
          at: r.from
        })
      }
    }
    for (const s of a.setup) {
      if (removed.has(s.from) && removed.has(s.to)) continue
      if (s.confidence >= thresholds.applyAt) {
        sure.push(s)
        setup++
      } else if (s.confidence >= thresholds.offerAt) {
        offered.push({ span: [s], kind: 'set-up talk', what: 'what may be set-up talk', at: s.from })
      }
    }
    for (const g of a.groups) {
      const losing = g.takes.filter((_, i) => i !== g.chosen)
      const open = losing.filter((t) => !(removed.has(t.from) && removed.has(t.to)))
      if (open.length === 0) continue
      if (g.confidence >= thresholds.applyAt) {
        sure.push(...open.map((t) => t.span))
        takes += open.length
        applied.push(g)
        if (filmedElsewhere(g, sourceWords)) moves.push({ group: g })
      } else if (g.confidence >= thresholds.offerAt) {
        offered.push({
          span: open.map((t) => t.span),
          kind: 'retake',
          what: `a possible retake of ${lineName(g)}`,
          at: open[0].from
        })
      }
    }
    for (const c of a.cues) {
      if (applied.length > 0) sure.push(c)
    }
  }

  // Strikes first, then the moves, worked out against the running cut.
  let ops = strikeOps(doc, sure, from)
  let running = applyOps(from, ops, context).cut
  for (const { group } of moves) {
    const keep = group.takes[group.chosen]
    const first = group.takes[0]
    const moved = moveOps(doc, running, keep, first)
    ops = [...ops, ...moved.ops]
    running = moved.cut
  }

  const before = resolveCut(from, doc.words, doc.sources)
  const after = resolveCut(running, doc.words, doc.sources)
  const index = indexWords(doc.words)
  let speech = 0
  for (const id of running.removed) {
    if (removed.has(id)) continue
    const w = index.words[index.pos.get(id) ?? -1]
    if (w) speech += w.endSec - w.startSec
  }
  const deadAirSec = Math.max(0, before.durationSec - after.durationSec - speech)

  const offers: TakesOffer[] = offered
    .map((o) => ({
      outSec: playsAt(after, doc, o.at),
      kind: o.kind,
      what: o.what,
      ops: strikeOps(doc, o.span, running)
    }))
    .filter((o) => o.ops.length > 0)
    .sort((x, y) => x.outSec - y.outSec)

  return {
    ops,
    summary: sentence(applied, takes, falseStarts, setup, deadAirSec),
    offerText: offerSentence(offers),
    offers,
    counts: { lines: applied.length, takes, falseStarts, setup, deadAirSec },
    analyses
  }
}

function sentence(groups: TakeGroup[], takes: number, falseStarts: number, setup: number, deadAir: number): string {
  const removedParts: string[] = []
  if (takes > 0) removedParts.push(plural(takes, 'other take'))
  if (falseStarts > 0) removedParts.push(plural(falseStarts, 'false start'))
  if (setup > 0) removedParts.push(setup === 1 ? 'the set-up talk' : `${setup} stretches of set-up talk`)
  if (deadAir >= 1) removedParts.push(`${deadAir >= 60 ? clock(deadAir) : seconds(deadAir)} of dead air`)
  if (removedParts.length === 0) return ''
  if (groups.length === 1) {
    const g = groups[0]
    return `I kept the ${ordinal(g.chosen + 1)} take of ${lineName(g)}, ${g.reason}, and removed ${listOf(removedParts)}.`
  }
  if (groups.length > 1) {
    return `I kept the best take of ${groups.length} lines and removed ${listOf(removedParts)}.`
  }
  return `I removed ${listOf(removedParts)}.`
}

/** "I left one possible retake in at 2:14. Say “cut it” and it goes." */
function offerSentence(offers: TakesOffer[]): string {
  if (offers.length === 0) return ''
  if (offers.length === 1) {
    const o = offers[0]
    const what = o.kind === 'set-up talk' ? 'what may be set-up talk' : `one possible ${o.kind}`
    return `I left ${what} in at ${clock(o.outSec)}. Say “cut it” and it goes.`
  }
  const kinds = new Set(offers.map((o) => o.kind))
  const only = kinds.size === 1 ? [...kinds][0] : null
  const what =
    only === 'retake' ? 'possible retakes' : only === 'false start' ? 'possible false starts' : 'possible cuts'
  const times = offers.map((o) => clock(o.outSec))
  return `I left ${offers.length} ${what} in, at ${listOf(times)}. Say “cut them” and they go.`
}

/**
 * Ops that switch a line to another of its takes: bring that take back,
 * strike the one playing now, and move it into place when it was filmed
 * somewhere else.
 */
export function useTakeOps(doc: EditDoc, group: TakeGroup, takeIndex: number, cut: Cut = currentCut(doc)): Op[] {
  const take = group.takes[takeIndex]
  if (!take) return []
  const context = { words: doc.words, sources: doc.sources }
  const removed = new Set(cut.removed)
  const playing = group.takes.filter((t, i) => i !== takeIndex && !(removed.has(t.from) && removed.has(t.to)))
  let ops: Op[] = [
    ...unstrikeOps(doc, [take.span], cut),
    ...strikeOps(
      doc,
      playing.map((t) => t.span),
      cut
    )
  ]
  let running = applyOps(cut, ops, context).cut
  const sourceWords = doc.words.filter((w) => w.source === doc.words.find((x) => x.id === take.from)?.source)
  const probe = { ...group, chosen: takeIndex }
  if (takeIndex > 0 && filmedElsewhere(probe, sourceWords)) {
    // Already in place when it plays right before the first take's beat.
    const at = beatOf(running, doc, take.from)
    const target = beatOf(running, doc, group.takes[0].from)
    if (at < 0 || target < 0 || at > target || running.beats[at]?.from !== take.from) {
      const moved = moveOps(doc, running, take, group.takes[0])
      ops = [...ops, ...moved.ops]
      running = moved.cut
    }
  }
  return ops
}

/** Which take of a group plays now, or -1 when none does. */
export function playingTake(group: TakeGroup, cut: Cut): number {
  const removed = new Set(cut.removed)
  const live = group.takes
    .map((t, i) => ({ i, live: !removed.has(t.from) || !removed.has(t.to) }))
    .filter((x) => x.live)
  return live.length === 1 ? live[0].i : live.length === 0 ? -1 : live[live.length - 1].i
}

export { DEFAULT_TAKES }
