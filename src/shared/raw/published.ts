import { endsSentence, isMark, normWord, sameWord } from './text'

/**
 * A first cut scored against the edit a creator actually published.
 *
 * The published video is transcribed like the raw footage. Its words are
 * aligned to the raw words, which recovers what the editor kept: which
 * stretches of which recording, in what order, and which take of a repeated
 * line. That is compared with what Cutalong's cut plays, raw word by raw word.
 *
 * The alignment has to survive two transcripts of the same speech written
 * differently ("3" and "three", a word dropped here, misheard there), lines
 * moved (a hook played first), and takes with the same words. Words are
 * matched loosely, a forward cut costs a little and a jump back costs more,
 * and between takes that read alike the sound decides, when the caller can
 * compare it; otherwise the stretch is marked as one the words cannot settle.
 */

export interface TimedText {
  text: string
  startSec: number
  endSec: number
}

export interface RawWord extends TimedText {
  id: string
  source: string
}

export interface AlignCosts {
  /** Skipping ahead in the raw: an ordinary cut. */
  cut: number
  /** Going back in the raw, or repeating it: a line moved. */
  jump: number
  /** A published word with no raw word: misheard, or not from this footage. */
  insert: number
}

export const ALIGN_COSTS: AlignCosts = { cut: 1, jump: 4, insert: 1 }

/** Whether two strings differ by one letter at most: added, dropped or changed. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  let x = a.length - 1
  let y = b.length - 1
  while (x >= i && y >= i && a[x] === b[y]) {
    x--
    y--
  }
  return x - i < 1 && y - i < 1
}

/** How well two normal forms match: 2 the same word, 1 nearly (a plural, a letter off, a cut-off stem), -1 not. */
export function matchScore(a: string, b: string): number {
  if (!a || !b) return -1
  if (a === b) return 2
  if (sameWord(a, b) || sameWord(b, a)) return 1
  if (a.length >= 4 && b.length >= 4 && oneEditApart(a, b)) return 1
  const [s, l] = a.length <= b.length ? [a, b] : [b, a]
  if (s.length >= 4 && l.startsWith(s)) return 1
  return -1
}

/**
 * For each published token, the raw token it was said as, or null. Raw is
 * in recording order; the path through it may skip ahead (a cut), go back
 * (a line moved) or leave a published token unmatched. Ties go to the
 * earlier raw token; recoverEdit says where that choice is the words' alone.
 */
export function alignTokens(pub: string[], raw: string[], costs: AlignCosts = ALIGN_COSTS): (number | null)[] {
  const n = pub.length
  const m = raw.length
  if (n === 0) return []
  if (m === 0) return pub.map(() => null)
  if (n * m > 40_000_000) throw new Error(`Too much to align at once: ${n} by ${m} words.`)
  /** Where each cell's path came from: a raw position, START, FRESH (nothing matched before it), or SKIP (this token unmatched). */
  const START = -1
  const SKIP = -2
  const FRESH = -3
  const back = new Int32Array(n * m)
  let prev = new Float64Array(m)
  let cur = new Float64Array(m)
  const before = new Float64Array(m)
  const beforeAt = new Int32Array(m)
  const after = new Float64Array(m)
  const afterAt = new Int32Array(m)
  // The score of a path that has matched nothing yet.
  let none = 0
  for (let i = 0; i < n; i++) {
    const p = pub[i]
    if (i > 0) {
      // before[j]: the best of prev[0..j-2]; after[j]: the best of prev[j..m-1].
      let best = -Infinity
      let at = -1
      for (let j = 0; j < m; j++) {
        before[j] = best
        beforeAt[j] = at
        if (j >= 1 && prev[j - 1] > best) {
          best = prev[j - 1]
          at = j - 1
        }
      }
      best = -Infinity
      at = -1
      for (let j = m - 1; j >= 0; j--) {
        if (prev[j] > best) {
          best = prev[j]
          at = j
        }
        after[j] = best
        afterAt[j] = at
      }
    }
    for (let j = 0; j < m; j++) {
      let top = none
      let from = i === 0 ? START : FRESH
      if (i > 0) {
        if (j >= 1 && prev[j - 1] > top) {
          top = prev[j - 1]
          from = j - 1
        }
        if (before[j] - costs.cut > top) {
          top = before[j] - costs.cut
          from = beforeAt[j]
        }
        if (after[j] - costs.jump > top) {
          top = after[j] - costs.jump
          from = afterAt[j]
        }
      }
      let value = top + matchScore(p, raw[j])
      let link = from
      if (i > 0 && prev[j] - costs.insert > value) {
        value = prev[j] - costs.insert
        link = SKIP
      }
      cur[j] = value
      back[i * m + j] = link
    }
    none -= costs.insert
    ;[prev, cur] = [cur, prev]
  }
  let end = -1
  let top = none
  for (let j = 0; j < m; j++) {
    if (prev[j] > top) {
      top = prev[j]
      end = j
    }
  }
  const out: (number | null)[] = pub.map(() => null)
  let j = end
  for (let i = n - 1; i >= 0 && j >= 0; i--) {
    const link = back[i * m + j]
    if (link === SKIP) continue
    out[i] = matchScore(pub[i], raw[j]) > 0 ? j : null
    if (link === START || link === FRESH) break
    j = link
  }
  return out
}

/** A stretch of one recording the published edit plays without a cut. */
export interface PlayedSpan {
  source: string
  /** On the recording's clock. */
  startSec: number
  endSec: number
  /** On the published video's clock. */
  pubStartSec: number
  pubEndSec: number
  /** Raw word positions, first and last. */
  from: number
  to: number
  /** Another stretch of the raw reads the same, and nothing could hear which was played. */
  ambiguous: boolean
  /** When ambiguous: the other stretches that read the same, as raw word positions. */
  twins?: { from: number; to: number }[]
}

export interface RecoveredEdit {
  /** For each published word, the raw word position it was said as, or null. */
  aligned: (number | null)[]
  spans: PlayedSpan[]
  /** Raw word ids the published edit plays. */
  kept: Set<string>
  /** Share of the published words found in the raw. */
  found: number
}

export interface RecoverOptions {
  costs?: AlignCosts
  /**
   * How alike the published sound over a stretch is to a raw stretch, higher
   * for more alike, when the caller can hear both. Takes with the same words
   * are told apart by it.
   */
  hear?: (pub: { startSec: number; endSec: number }, raw: { source: string; startSec: number; endSec: number }) => number
}

const tokenOf = (text: string): string => (isMark(text) ? '' : normWord(text))

/** Whether published words carry their times: auto-captions read as text do not (NaN). */
export function timed(words: TimedText[]): boolean {
  return words.length > 0 && words.every((w) => Number.isFinite(w.startSec) && Number.isFinite(w.endSec))
}

/** Published words from text alone, with no times: a caption track read as text. */
export function untimedWords(text: string): TimedText[] {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .split(/\s+/)
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => ({ text: t, startSec: Number.NaN, endSec: Number.NaN }))
}

/**
 * What the published edit plays, recovered from its words: the raw word each
 * published word was said as, the stretches played without a cut, and the
 * raw words inside them. A stretch ends where the raw skips ahead, goes back
 * or changes recording, or, when the published words are timed, where the
 * time between two words differs between the two clocks (a pause cut out).
 */
export function recoverEdit(published: TimedText[], raw: RawWord[], opts: RecoverOptions = {}): RecoveredEdit {
  const clocked = timed(published)
  const pubAt = published.map((_, i) => i).filter((i) => tokenOf(published[i].text) !== '')
  const rawAt = raw.map((_, i) => i).filter((i) => tokenOf(raw[i].text) !== '')
  const rawTokens = rawAt.map((i) => tokenOf(raw[i].text))
  const path = alignTokens(
    pubAt.map((i) => tokenOf(published[i].text)),
    rawTokens,
    opts.costs
  )
  const aligned: (number | null)[] = published.map(() => null)
  path.forEach((k, n) => {
    if (k !== null) aligned[pubAt[n]] = rawAt[k]
  })

  // Runs of published words played straight through.
  const spans: PlayedSpan[] = []
  let open: PlayedSpan | null = null
  let lastPub = -1
  for (let k = 0; k < published.length; k++) {
    const j = aligned[k]
    if (j === null) continue
    const w = raw[j]
    const p = published[k]
    const continues =
      open !== null &&
      w.source === open.source &&
      j > open.to &&
      j - open.to <= 4 &&
      (!clocked || Math.abs(p.startSec - published[lastPub].startSec - (w.startSec - raw[open.to].startSec)) <= 0.35)
    if (open && continues) {
      open.to = j
      open.endSec = w.endSec
      open.pubEndSec = p.endSec
    } else {
      if (open) spans.push(open)
      open = {
        source: w.source,
        startSec: w.startSec,
        endSec: w.endSec,
        pubStartSec: p.startSec,
        pubEndSec: p.endSec,
        from: j,
        to: j,
        ambiguous: false
      }
    }
    lastPub = k
  }
  if (open) spans.push(open)

  // Stretches that read the same as another stretch: other takes of the line.
  const rank = new Map(rawAt.map((i, k) => [i, k]))
  for (const s of spans) {
    const a = rank.get(s.from)
    const z = rank.get(s.to)
    if (a === undefined || z === undefined || z - a + 1 < 3) continue
    const len = z - a + 1
    const others: number[] = []
    for (let k = 0; k + len <= rawTokens.length; k++) {
      if (Math.abs(k - a) < len) continue
      const first = raw[rawAt[k]]
      const last = raw[rawAt[k + len - 1]]
      if (first.source !== last.source) continue
      let same = 0
      for (let t = 0; t < len; t++) if (matchScore(rawTokens[a + t], rawTokens[k + t]) > 0) same++
      if (same >= Math.ceil(len * 0.9)) others.push(k)
    }
    if (others.length === 0) continue
    // Hearing which take was played needs the published words' times.
    if (!opts.hear || !clocked) {
      s.ambiguous = true
      s.twins = others.map((k) => ({ from: rawAt[k], to: rawAt[k + len - 1] }))
      continue
    }
    const pub = { startSec: s.pubStartSec, endSec: s.pubEndSec }
    const heard = (k: number): number =>
      opts.hear!(pub, { source: raw[rawAt[k]].source, startSec: raw[rawAt[k]].startSec, endSec: raw[rawAt[k + len - 1]].endSec })
    const scores = [{ k: a, v: heard(a) }, ...others.map((k) => ({ k, v: heard(k) }))].sort((x, y) => y.v - x.v)
    // Too close to call by ear as well.
    if (scores.length > 1 && scores[0].v - scores[1].v < 0.02) {
      s.ambiguous = true
      s.twins = others.map((k) => ({ from: rawAt[k], to: rawAt[k + len - 1] }))
      continue
    }
    const pick = scores[0].k
    if (pick === a) continue
    const shift = pick - a
    for (let k = 0; k < published.length; k++) {
      const at = aligned[k]
      const r = at === null ? undefined : rank.get(at)
      if (r !== undefined && r >= a && r <= z && published[k].startSec >= s.pubStartSec - 0.01 && published[k].endSec <= s.pubEndSec + 0.01)
        aligned[k] = rawAt[r + shift]
    }
    s.from = rawAt[a + shift]
    s.to = rawAt[z + shift]
    s.startSec = raw[s.from].startSec
    s.endSec = raw[s.to].endSec
    s.source = raw[s.from].source
  }

  const kept = new Set<string>()
  for (const s of spans) for (let j = s.from; j <= s.to; j++) kept.add(raw[j].id)
  const found = path.filter((k) => k !== null).length
  return { aligned, spans, kept, found: pubAt.length ? found / pubAt.length : 0 }
}

// ---------- Scoring ----------

/** A line said more than once, as the takes analysis finds it. */
export interface TakeGroupLike {
  label: string
  takes: { from: string; to: string }[]
}

export interface GapStats {
  count: number
  medianSec: number
  p90Sec: number
  /** Share of the running time spent in pauses longer than 0.25 s. */
  pauseShare: number
}

export interface TakeAgreement {
  label: string
  /** The take each edit plays, by index; -1 when it plays none of them, -2 when the words cannot say which. */
  published: number
  cut: number
}

export interface CutScore {
  /** Of the raw words the cut plays, the share the published edit plays too. */
  precision: number
  /** Of the raw words the published edit plays, the share the cut plays too. */
  recall: number
  /** The same, weighted by how long each word is said. */
  precisionSec: number
  recallSec: number
  /** Every line said more than once: the take each edit plays. */
  takes: TakeAgreement[]
  /** Lines where both play a take, and of those, where it is the same one. */
  takesBoth: number
  takesSame: number
  runningSec: { raw: number; cut: number; published: number }
  /** Words a minute as each plays: the pace, which untimed published words still give. */
  wpm: { cut: number; published: number }
  opening: { same: boolean; published: string; cut: string }
  /** The published pauses need its words' times: null for words read as text. */
  pauses: { published: GapStats | null; cut: GapStats }
  /** Share of the published words found in the raw. */
  found: number
}

const round = (x: number): number => Math.round(x * 1000) / 1000

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const at = (sorted.length - 1) * q
  const lo = Math.floor(at)
  const hi = Math.ceil(at)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo)
}

/** Pauses between neighbouring words, as they play. */
export function gapStats(words: TimedText[], durationSec: number): GapStats {
  const gaps: number[] = []
  for (let i = 1; i < words.length; i++) gaps.push(Math.max(0, words[i].startSec - words[i - 1].endSec))
  const sorted = [...gaps].sort((a, b) => a - b)
  const long = gaps.filter((g) => g > 0.25).reduce((s, g) => s + g, 0)
  return {
    count: gaps.length,
    medianSec: round(quantile(sorted, 0.5)),
    p90Sec: round(quantile(sorted, 0.9)),
    pauseShare: durationSec > 0 ? round(long / durationSec) : 0
  }
}

/** Words said a minute over a running time, punctuation marks not counted. */
export function wordsPerMinute(words: TimedText[], durationSec: number): number {
  return durationSec > 0 ? round((words.filter((w) => tokenOf(w.text) !== '').length / durationSec) * 60) : 0
}

/** Which take a set of played raw words plays: the one with most of its words played, if at least half. */
export function takePlayed(group: TakeGroupLike, raw: RawWord[], played: Set<string>): number {
  const pos = new Map(raw.map((w, i) => [w.id, i]))
  let best = -1
  let share = 0.5 - 1e-9
  group.takes.forEach((t, k) => {
    const a = pos.get(t.from)
    const b = pos.get(t.to)
    if (a === undefined || b === undefined) return
    let n = 0
    let on = 0
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (tokenOf(raw[i].text) === '') continue
      n++
      if (played.has(raw[i].id)) on++
    }
    if (n > 0 && on / n > share) {
      share = on / n
      best = k
    }
  })
  return best
}

/** A sentence number for each raw word: a sentence ends at a full stop, a change of recording, or a pause of 0.6 s. */
function sentencesOf(raw: RawWord[]): number[] {
  const out: number[] = []
  let n = 0
  raw.forEach((w, i) => {
    out.push(n)
    const next = raw[i + 1]
    if (!next || endsSentence(w.text) || next.source !== w.source || next.startSec - w.endSec >= 0.6) n++
  })
  return out
}

export interface ScoreInput {
  /** Every raw word, in recording order (the doc's words). */
  raw: RawWord[]
  /** How long the raw recordings run, together. */
  rawSec: number
  /** The cut: the raw words it plays, in playing order, timed on its own clock. */
  cut: { words: (TimedText & { id: string })[]; durationSec: number }
  /** The published video: its words on its own clock, and how long it runs. */
  published: { words: TimedText[]; durationSec: number }
  /** Lines said more than once. */
  groups: TakeGroupLike[]
  recover?: RecoverOptions
}

/** The cut against the published edit: kept words, takes, length, opening and pauses. */
export function scoreCut(input: ScoreInput): CutScore & { edit: RecoveredEdit } {
  const { raw, cut, published } = input
  const edit = recoverEdit(published.words, raw, input.recover)
  const played = new Set(cut.words.map((w) => w.id))
  // Where the words cannot say which of two same-worded takes was played, a
  // word of either counts as the other: playing the twin is no miss.
  const twinOf = new Map<string, string[]>()
  for (const s of edit.spans) {
    for (const t of s.twins ?? []) {
      for (let k = 0; k <= s.to - s.from && t.from + k <= t.to; k++) {
        const a = raw[s.from + k].id
        const b = raw[t.from + k].id
        twinOf.set(a, [...(twinOf.get(a) ?? []), b])
        twinOf.set(b, [...(twinOf.get(b) ?? []), a])
      }
    }
  }
  const kept = (id: string): boolean => edit.kept.has(id) || (twinOf.get(id) ?? []).some((t) => edit.kept.has(t))
  const plays = (id: string): boolean => played.has(id) || (twinOf.get(id) ?? []).some((t) => played.has(t))
  let cutBoth = 0
  let cutBothSec = 0
  let pubBoth = 0
  let pubBothSec = 0
  let cutN = 0
  let cutSec = 0
  let pubN = 0
  let pubSec = 0
  for (const w of raw) {
    if (tokenOf(w.text) === '') continue
    const sec = Math.max(0.01, w.endSec - w.startSec)
    if (played.has(w.id)) {
      cutN++
      cutSec += sec
      if (kept(w.id)) {
        cutBoth++
        cutBothSec += sec
      }
    }
    if (edit.kept.has(w.id)) {
      pubN++
      pubSec += sec
      if (plays(w.id)) {
        pubBoth++
        pubBothSec += sec
      }
    }
  }
  const pos = new Map(raw.map((w, i) => [w.id, i]))
  const unsure = (g: TakeGroupLike): boolean =>
    edit.spans.some(
      (s) =>
        s.ambiguous &&
        g.takes.some((t) => {
          const a = pos.get(t.from) ?? -1
          const b = pos.get(t.to) ?? -1
          return s.from <= Math.max(a, b) && s.to >= Math.min(a, b)
        })
    )
  const takes = input.groups.map((g) => ({
    label: g.label,
    published: unsure(g) ? -2 : takePlayed(g, raw, edit.kept),
    cut: takePlayed(g, raw, played)
  }))
  const both2 = takes.filter((t) => t.published >= 0 && t.cut >= 0)
  // The opening: the first line each plays, the same when it is one raw sentence or takes of one line.
  const sentence = sentencesOf(raw)
  const firstPub = edit.aligned.find((j) => j !== null && tokenOf(raw[j].text) !== '') ?? null
  const firstCutId = cut.words.find((w) => tokenOf(w.text) !== '')?.id
  const firstCut = firstCutId !== undefined ? (pos.get(firstCutId) ?? null) : null
  const groupOf = (i: number): number =>
    input.groups.findIndex((g) =>
      g.takes.some((t) => {
        const a = pos.get(t.from)
        const b = pos.get(t.to)
        return a !== undefined && b !== undefined && i >= Math.min(a, b) && i <= Math.max(a, b)
      })
    )
  const same =
    firstPub !== null &&
    firstCut !== null &&
    (sentence[firstPub] === sentence[firstCut] || (groupOf(firstPub) >= 0 && groupOf(firstPub) === groupOf(firstCut)))
  const lineAt = (i: number | null): string =>
    i === null
      ? ''
      : raw
          .filter((_, k) => sentence[k] === sentence[i])
          .slice(0, 12)
          .map((w) => w.text)
          .join(' ')
  return {
    precision: round(cutN ? cutBoth / cutN : 0),
    recall: round(pubN ? pubBoth / pubN : 0),
    precisionSec: round(cutSec ? cutBothSec / cutSec : 0),
    recallSec: round(pubSec ? pubBothSec / pubSec : 0),
    takes,
    takesBoth: both2.length,
    takesSame: both2.filter((t) => t.published === t.cut).length,
    runningSec: { raw: round(input.rawSec), cut: round(cut.durationSec), published: round(published.durationSec) },
    wpm: { cut: wordsPerMinute(cut.words, cut.durationSec), published: wordsPerMinute(published.words, published.durationSec) },
    opening: { same, published: lineAt(firstPub), cut: lineAt(firstCut) },
    pauses: {
      published: timed(published.words) ? gapStats(published.words, published.durationSec) : null,
      cut: gapStats(cut.words, cut.durationSec)
    },
    found: round(edit.found),
    edit
  }
}
