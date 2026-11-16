import { isFiller } from '../fillers'
import { BUILT_IN_PRESETS, seconds, type Preset, type StyleSpec } from '../presets/preset'
import { normToken } from './text'
import type { Habits, LabelledPair, LabelledWord } from './schema'

/**
 * How the creator cuts, read from their own edits: the pauses they leave,
 * the room they keep either side of a cut, whether the ums and breaths go,
 * and which take of a line they keep. Then the same habits as a style, so
 * /tighten and /brand cut the way they do once they say so.
 */

/** Two words that play one after the other in the finished video. */
export interface Join {
  a: LabelledWord
  b: LabelledWord
  /** The pause between them in the recording, when b came straight after a there. */
  rawGap: number | null
  /** The pause between them in the finished video. */
  outGap: number
  /** A cut lies between them. */
  cut: boolean
}

/** A pause in the recording at least this long is a pause, not the space between two words of a phrase. */
export const PAUSE_SEC = 0.15
/** A finished-video gap longer than this is something else: a music break, a cutaway with no talking. */
const NOT_A_PAUSE_SEC = 2

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const percentile = (v: number[], p: number): number => {
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const r2 = (v: number): number => Math.round(v * 100) / 100
const r3 = (v: number): number => Math.round(v * 1000) / 1000

/** Each recording's words in recording order, with what came next in the same recording. */
function bySource(pair: LabelledPair): Map<string, LabelledWord[]> {
  const out = new Map<string, LabelledWord[]>()
  for (const w of pair.words) {
    const list = out.get(w.source)
    if (list) list.push(w)
    else out.set(w.source, [w])
  }
  for (const list of out.values()) list.sort((x, y) => x.startSec - y.startSec)
  return out
}

/** Which piece a kept word plays in, by index. */
function pieceOf(pair: LabelledPair, w: LabelledWord): number {
  let best = -1
  let most = 0
  pair.pieces.forEach((p, i) => {
    if (p.source !== w.source) return
    const o = Math.min(p.rawEnd, w.endSec) - Math.max(p.rawStart, w.startSec)
    if (o > most) {
      most = o
      best = i
    }
  })
  return best
}

export function joins(pair: LabelledPair): Join[] {
  const order = new Map<string, number>()
  for (const list of bySource(pair).values()) list.forEach((w, i) => order.set(w.id + '@' + w.source, i))
  const kept = pair.words
    .filter((w) => w.label === 'kept' && w.outStartSec !== null && w.outEndSec !== null)
    .sort((x, y) => x.outStartSec! - y.outStartSec!)
  const out: Join[] = []
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1]
    const b = kept[i]
    const adjacent =
      a.source === b.source && (order.get(b.id + '@' + b.source) ?? -1) === (order.get(a.id + '@' + a.source) ?? -9) + 1
    out.push({
      a,
      b,
      rawGap: adjacent ? Math.max(0, b.startSec - a.endSec) : null,
      outGap: Math.max(0, b.outStartSec! - a.outEndSec!),
      cut: pieceOf(pair, a) !== pieceOf(pair, b)
    })
  }
  return out
}

/** The pauses left in the finished video, where the speaker paused or a cut was made. */
export function retainedPauses(pair: LabelledPair): number[] {
  return joins(pair)
    .filter((j) => (j.cut || (j.rawGap ?? 0) >= PAUSE_SEC) && j.outGap <= NOT_A_PAUSE_SEC)
    .map((j) => j.outGap)
}

/** Pauses between words that follow each other in the recording: was each kept whole or shortened? */
export function pauseDecisions(pair: LabelledPair): { gap: number; shortened: boolean }[] {
  return joins(pair)
    .filter((j) => j.rawGap !== null && j.rawGap >= 0.1)
    .map((j) => ({ gap: j.rawGap!, shortened: j.outGap < j.rawGap! - 0.04 }))
}

/** Room either side of each cut whose edges were heard. */
/**
 * Room either side of each cut between two pieces that play back to back:
 * the split for the cuts whose position was heard, and the total (which is
 * exact either way) for all of them.
 */
export function cutPadding(pair: LabelledPair): { before: number[]; after: number[]; total: number[] } {
  const before: number[] = []
  const after: number[] = []
  const total: number[] = []
  const kept = pair.words.filter((w) => w.label === 'kept')
  const inPiece = (i: number): LabelledWord[] => kept.filter((w) => pieceOf(pair, w) === i)
  const order = pair.pieces.map((_, i) => i).sort((x, y) => pair.pieces[x].outStart - pair.pieces[y].outStart)
  for (let k = 1; k < order.length; k++) {
    const p = pair.pieces[order[k - 1]]
    const q = pair.pieces[order[k]]
    if (Math.abs(q.outStart - p.outEnd) > 0.01) continue
    const pw = inPiece(order[k - 1])
    const qw = inPiece(order[k])
    if (pw.length === 0 || qw.length === 0) continue
    const a = p.rawEnd - Math.max(...pw.map((w) => w.endSec))
    const b = Math.min(...qw.map((w) => w.startSec)) - q.rawStart
    if (a <= -0.02 || a >= 1 || b <= -0.02 || b >= 1) continue
    total.push(Math.max(0, a) + Math.max(0, b))
    if (p.sureEnd && q.sureStart) {
      after.push(Math.max(0, a))
      before.push(Math.max(0, b))
    }
  }
  return { before, after, total }
}

/** Ums and uhs inside kept speech: the words either side of them were kept. */
export function fillerFates(pair: LabelledPair): boolean[] {
  const out: boolean[] = []
  for (const list of bySource(pair).values()) {
    const real = list.filter((w) => !isFiller(w.text))
    list.forEach((w) => {
      if (!isFiller(w.text) || (w.label !== 'kept' && w.label !== 'cut')) return
      const prev = [...real].reverse().find((x) => x.endSec <= w.startSec + 1e-6)
      const next = real.find((x) => x.startSec >= w.endSec - 1e-6)
      if (prev?.label === 'kept' && next?.label === 'kept') out.push(w.label === 'cut')
    })
  }
  return out
}

/** Breaths between kept words (an um beside one does not count as a word), and whether each was cut. */
export function breathFates(pair: LabelledPair): boolean[] {
  const lists = bySource(pair)
  const out: boolean[] = []
  for (const b of pair.breaths) {
    const list = (lists.get(b.source) ?? []).filter((w) => !isFiller(w.text))
    const prev = [...list].reverse().find((x) => x.endSec <= b.startSec + 0.02)
    const next = list.find((x) => x.startSec >= b.endSec - 0.02)
    if (prev?.label === 'kept' && next?.label === 'kept') out.push(!b.kept)
  }
  return out
}

/** A line said more than once: its takes in recording order, and which one was kept. */
export interface TakeGroup {
  source: string
  takes: { startSec: number; endSec: number }[]
  kept: number
}

/**
 * Lines said more than once, read from the labels: a stretch that was cut,
 * whose opening words are said again somewhere in kept speech close by
 * (within 90 s), is another take of that line. A restart that backs up a
 * few words counts: the abandoned take ends where the next one picks up
 * again. The kept take can sit anywhere in a longer kept stretch, since it
 * is usually played straight on from what came before it.
 */
export function takeGroups(pair: LabelledPair): TakeGroup[] {
  const groups: TakeGroup[] = []
  for (const [source, list] of bySource(pair)) {
    // Runs of the same fate, ignoring ums and words that are neither kept nor cut.
    const runs: { label: 'kept' | 'cut'; words: LabelledWord[]; toks: string[] }[] = []
    for (const w of list) {
      const tok = normToken(w.text)
      if (!tok || isFiller(w.text) || (w.label !== 'kept' && w.label !== 'cut')) continue
      const last = runs[runs.length - 1]
      if (last && last.label === w.label) {
        last.words.push(w)
        last.toks.push(tok)
      } else runs.push({ label: w.label, words: [w], toks: [tok] })
    }
    // Kept takes by where they start: run and word.
    const linked = new Map<string, { run: number; at: number; length: number; cuts: number[] }>()
    runs.forEach((run, i) => {
      if (run.label !== 'cut' || run.toks.length < 2) return
      const need = Math.min(3, run.toks.length)
      const opening = run.toks.slice(0, need)
      let best: { run: number; at: number; distance: number } | null = null
      runs.forEach((kept, j) => {
        if (kept.label !== 'kept') return
        for (let p = 0; p + need <= kept.toks.length; p++) {
          if (opening.some((t, q) => kept.toks[p + q] !== t)) continue
          const distance = Math.abs(kept.words[p].startSec - run.words[0].startSec)
          if (distance <= 90 && (!best || distance < best.distance)) best = { run: j, at: p, distance }
        }
      })
      const found = best as { run: number; at: number; distance: number } | null
      if (!found) return
      const key = `${found.run}:${found.at}`
      const entry = linked.get(key) ?? { run: found.run, at: found.at, length: run.toks.length, cuts: [] }
      entry.cuts.push(i)
      entry.length = Math.max(entry.length, run.toks.length)
      linked.set(key, entry)
    })
    for (const entry of linked.values()) {
      const keptRun = runs[entry.run]
      const keptTake = {
        startSec: keptRun.words[entry.at].startSec,
        endSec: keptRun.words[Math.min(keptRun.words.length - 1, entry.at + entry.length - 1)].endSec
      }
      const takes = [
        ...entry.cuts.map((i) => ({
          startSec: runs[i].words[0].startSec,
          endSec: runs[i].words[runs[i].words.length - 1].endSec
        })),
        keptTake
      ].sort((a, b) => a.startSec - b.startSec)
      groups.push({ source, takes, kept: takes.indexOf(keptTake) })
    }
  }
  return groups
}

/** Fits the habits across every learned video. Null when there is nothing to learn from. */
export function fitHabits(pairs: LabelledPair[], at = new Date().toISOString()): Habits | null {
  const scored = pairs.filter((p) => p.words.some((w) => w.label === 'kept'))
  if (scored.length === 0) return null
  const pauses = scored.flatMap(retainedPauses)
  const decisions = scored.flatMap(pauseDecisions)
  const pads = scored.map(cutPadding)
  const before = pads.flatMap((p) => p.before)
  const after = pads.flatMap((p) => p.after)
  const total = pads.flatMap((p) => p.total)
  const fillers = scored.flatMap(fillerFates)
  const breaths = scored.flatMap(breathFates)
  const groups = scored.flatMap(takeGroups)
  const shortened = decisions.filter((d) => d.shortened).length
  return {
    videos: scored.length,
    words: scored.reduce((n, p) => n + p.words.filter((w) => w.label === 'kept' || w.label === 'cut').length, 0),
    pauses:
      pauses.length >= 3
        ? { medianSec: r3(median(pauses)), p90Sec: r3(percentile(pauses, 0.9)), count: pauses.length }
        : null,
    pauseCuts: decisions.length >= 3 ? { n: shortened, of: decisions.length } : null,
    maxPauseSec: decisions.length >= 3 && shortened > 0 ? r3(threshold(decisions)) : null,
    // The split is only claimed from cuts that were heard, and only when
    // there are enough of them to stand for the rest.
    pad:
      before.length >= 3 && before.length >= 0.3 * total.length
        ? { beforeSec: r3(median(before)), afterSec: r3(median(after)), count: before.length, heard: true }
        : total.length >= 2
          ? { beforeSec: r3(median(total) / 2), afterSec: r3(median(total) / 2), count: total.length, heard: false }
          : null,
    fillers: fillers.length ? { n: fillers.filter(Boolean).length, of: fillers.length } : null,
    breaths: breaths.length ? { n: breaths.filter(Boolean).length, of: breaths.length } : null,
    lastTake: groups.length
      ? { n: groups.filter((g) => g.kept === g.takes.length - 1).length, of: groups.length }
      : null,
    learnedAt: at
  }
}

/**
 * The pause length that best separates the pauses kept whole from those
 * shortened: everything up to it kept, everything past it cut back.
 */
function threshold(decisions: { gap: number; shortened: boolean }[]): number {
  const sorted = [...decisions].sort((a, b) => a.gap - b.gap)
  let best = { at: Math.max(0.05, sorted[0].gap - 0.01), errors: Infinity }
  for (let i = 0; i <= sorted.length; i++) {
    const at =
      i === 0
        ? sorted[0].gap - 0.01
        : i === sorted.length
          ? sorted[i - 1].gap + 0.01
          : (sorted[i - 1].gap + sorted[i].gap) / 2
    let errors = 0
    for (const d of sorted) if (d.gap <= at ? d.shortened : !d.shortened) errors++
    if (errors < best.errors) best = { at, errors }
  }
  return clamp(best.at, 0.05, 5)
}

const TIGHTEN = BUILT_IN_PRESETS.find((p) => p.command === 'tighten')!
const BASE = TIGHTEN.style.tighten!

/** The habits as a style: pauses cut where the creator cuts them, with their room either side. */
export function habitsStyle(h: Habits): StyleSpec {
  const pad = h.pad ?? (h.pauses ? { beforeSec: h.pauses.medianSec / 2, afterSec: h.pauses.medianSec / 2 } : null)
  const keepsEveryPause = h.pauseCuts !== null && h.pauseCuts.n === 0
  const maxGap = keepsEveryPause ? 5 : (h.maxPauseSec ?? BASE.maxGapSec)
  const style: StyleSpec = {
    tighten: {
      maxGapSec: clamp(r2(maxGap), 0.05, 5),
      padSec: pad ? clamp(r2((pad.beforeSec + pad.afterSec) / 2), 0, 0.5) : BASE.padSec,
      fillers: h.fillers && h.fillers.of > 0 ? h.fillers.n / h.fillers.of >= 0.5 : BASE.fillers
    }
  }
  if (pad) style.pad = { inSec: clamp(r2(pad.beforeSec), 0, 1), outSec: clamp(r2(pad.afterSec), 0, 1) }
  return style
}

/** The slash commands with /tighten cutting the creator's way, once they have chosen to use their habits. */
export function withHabits(presets: Preset[], habits: Habits | null): Preset[] {
  if (!habits) return presets
  return presets.map((p) => (p.command === 'tighten' && p.builtIn ? habitTighten(p, habits) : p))
}

function habitTighten(p: Preset, h: Habits): Preset {
  const style = habitsStyle(h)
  const t = style.tighten!
  const room = !style.pad
    ? ''
    : h.pad && !h.pad.heard
      ? `, leaving ${seconds(style.pad.inSec + style.pad.outSec)} at each cut`
      : `, leaving ${seconds(style.pad.inSec)} before the words and ${seconds(style.pad.outSec)} after`
  const summary =
    t.maxGapSec >= 5
      ? `Cuts the way you do: pauses stay as you leave them${t.fillers ? ', the ums go' : ''}.`
      : `Cuts pauses the way you do: past ${seconds(t.maxGapSec)}${room}${t.fillers ? ', and the ums' : ''}.`
  return { ...p, summary, style }
}

/** How often, in words. */
export function often(n: number, of: number): string {
  const share = of > 0 ? n / of : 0
  if (n === of) return 'always'
  if (n === 0) return 'never'
  if (share >= 0.85) return 'almost always'
  if (share >= 0.6) return 'usually'
  if (share >= 0.4) return 'about half the time'
  if (share >= 0.15) return 'now and then'
  return 'rarely'
}

/** The habits in one clause or two, for the sentence on the brand page. */
export function habitsSentence(h: Habits): string {
  const parts: string[] = []
  if (h.pauses) parts.push(`leave pauses of about ${seconds(h.pauses.medianSec)}`)
  if (h.lastTake) parts.push(`${often(h.lastTake.n, h.lastTake.of)} keep your last take`)
  else if (h.fillers) parts.push(`${often(h.fillers.n, h.fillers.of)} cut your ums`)
  if (parts.length === 0) return ''
  return `You ${parts.join(' and ')}.`
}

/** At most three facts, most telling first. */
export function habitFacts(h: Habits): string[] {
  const facts: string[] = []
  if (h.pauses) facts.push(`Pauses about ${seconds(h.pauses.medianSec)}`)
  if (h.lastTake) facts.push(`Last take kept ${h.lastTake.n} of ${h.lastTake.of} times`)
  if (h.pad) {
    facts.push(
      h.pad.heard
        ? `${seconds(h.pad.beforeSec)} before a cut, ${seconds(h.pad.afterSec)} after`
        : `${seconds(h.pad.beforeSec + h.pad.afterSec)} of room at a cut`
    )
  }
  if (h.fillers) facts.push(`${h.fillers.n} of ${h.fillers.of} ums cut`)
  if (h.breaths) facts.push(`${h.breaths.n} of ${h.breaths.of} breaths cut`)
  return facts.slice(0, 3)
}

/** Every number, for Details. */
export function habitDetails(h: Habits): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = []
  if (h.pauses) {
    rows.push({
      label: 'Pauses you leave',
      value: `${seconds(h.pauses.medianSec)} typically, ${seconds(h.pauses.p90Sec)} (9 in 10)`
    })
  }
  if (h.pauseCuts) {
    rows.push({
      label: 'Pauses you shorten',
      value:
        h.maxPauseSec !== null
          ? `${h.pauseCuts.n} of ${h.pauseCuts.of}, from ${seconds(h.maxPauseSec)} up`
          : `none of ${h.pauseCuts.of}`
    })
  }
  if (h.pad)
    rows.push({
      label: 'Room at a cut',
      value: h.pad.heard
        ? `${seconds(h.pad.beforeSec)} before, ${seconds(h.pad.afterSec)} after (${h.pad.count} cuts)`
        : `${seconds(h.pad.beforeSec + h.pad.afterSec)} in all, split not heard (${h.pad.count} cuts)`
    })
  if (h.fillers) rows.push({ label: 'Ums and uhs cut', value: `${h.fillers.n} of ${h.fillers.of}` })
  if (h.breaths) rows.push({ label: 'Breaths cut', value: `${h.breaths.n} of ${h.breaths.of}` })
  if (h.lastTake)
    rows.push({ label: 'Last take kept', value: `${h.lastTake.n} of ${h.lastTake.of} lines said more than once` })
  return rows
}

/** The habits without when they were fitted: fitting the same edits twice gives the same key. */
export function habitsKey(h: Habits): string {
  const { videos, words, pauses, pauseCuts, maxPauseSec, pad, fillers, breaths, lastTake } = h
  return JSON.stringify({ videos, words, pauses, pauseCuts, maxPauseSec, pad, fillers, breaths, lastTake })
}

/** What keeping the habits does, in a sentence. */
export function habitsUseSentence(h: Habits): string {
  const t = habitsStyle(h).tighten!
  if (t.maxGapSec >= 5) {
    return `With these, /tighten and /brand leave your pauses as they are${t.fillers ? ' and cut the ums' : ''}.`
  }
  const what = t.fillers
    ? `the ums and any pause past ${seconds(t.maxGapSec)}`
    : `any pause past ${seconds(t.maxGapSec)}`
  const room = !h.pad
    ? ''
    : h.pad.heard
      ? `, leaving ${seconds(h.pad.beforeSec)} before the words and ${seconds(h.pad.afterSec)} after`
      : `, leaving ${seconds(h.pad.beforeSec + h.pad.afterSec)} at each cut`
  return `With these, /tighten and /brand cut ${what}${room}.`
}

/** What would change if new habits replaced the ones in use, as short lines; empty when nothing would. */
export function habitChanges(current: Habits | null, next: Habits): string[] {
  if (!current) return []
  const out: string[] = []
  const sec = (v: number | null | undefined): string | null => (v === null || v === undefined ? null : seconds(v))
  const how = (c: { n: number; of: number } | null): string | null => (c ? often(c.n, c.of) : null)
  // Only what would cut differently or read differently, said as the new value and the old.
  const clause = (what: string, now: string | null, was: string | null): void => {
    if (now !== was)
      out.push(now === null ? `no ${what} (was ${was})` : `${what} ${now}${was === null ? '' : ` (was ${was})`}`)
  }
  clause('pauses about', sec(next.pauses?.medianSec), sec(current.pauses?.medianSec))
  clause('pauses cut past', sec(next.maxPauseSec), sec(current.maxPauseSec))
  const total = (h: Habits): number | null => (h.pad ? h.pad.beforeSec + h.pad.afterSec : null)
  if (current.pad?.heard && next.pad?.heard) {
    clause('room before a cut', sec(next.pad.beforeSec), sec(current.pad.beforeSec))
    clause('room after a cut', sec(next.pad.afterSec), sec(current.pad.afterSec))
  } else clause('room at a cut', sec(total(next)), sec(total(current)))
  clause('ums cut', how(next.fillers), how(current.fillers))
  clause('breaths cut', how(next.breaths), how(current.breaths))
  clause('last take kept', how(next.lastTake), how(current.lastTake))
  return out
}
