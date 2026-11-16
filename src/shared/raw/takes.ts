import type { Word } from '../edit/schema'
import {
  contentTokens,
  endsSentence,
  FUNCTION_WORDS,
  GRAMMATICAL_DOUBLES,
  GROANS,
  hasSetupWord,
  isCue,
  isFiller,
  isLaughWord,
  isMark,
  lcs,
  looksCutOff,
  meantRepeat,
  normWord,
  sameWord,
  setupShare,
  sharedPrefix
} from './text'

/**
 * Finding takes in a raw recording, from the words and their timing, with
 * the sound as a second opinion.
 *
 * People redo lines two ways. They say the whole line again, often several
 * times, sometimes reworded. Or they back up a few words and carry on from
 * there mid-sentence: "I've been using this for three yea— for three years
 * now". Both leave the same trace: a break (a word cut off, a pause, a
 * filler, a breath or a drop in loudness) followed by words the speaker has
 * already said. Repetition people mean ("never, never", "again and again")
 * flows on without a break, and that is what tells the two apart.
 *
 * Everything here is pure and works on any doc, so the editor, the planner
 * and the commands all see the same takes. Each finding carries a
 * confidence; below the line a removal is offered, never made.
 */

/** What Cutalong heard while listening, per word and between words. Optional: takes work from words alone. */
export interface TakeAudio {
  /** Loudness in dBFS and pitch in Hz (null when unvoiced), by word id. */
  words: Record<string, [number, number | null]>
  /** Sound with no words in the transcript: a breath, a laugh, a groan, a cough or a bump. */
  unworded: { startSec: number; endSec: number; kind: string }[]
}

export interface TakesOptions {
  /** Find mid-sentence restarts. */
  restarts: boolean
  /** Find lines said more than once. */
  lines: boolean
  /** Find stumbles on one function word ("the the the"). */
  stutters: boolean
  /** Find set-up talk at the head and tail ("is it recording?"). */
  setup: boolean
  /** A pause at least this long, alone, is a break a retake can follow. */
  breakSec: number
  /** Lines further apart than this are only matched when they are near-identical. */
  windowSec: number
}

export const DEFAULT_TAKES: TakesOptions = {
  restarts: true,
  lines: true,
  stutters: true,
  setup: true,
  breakSec: 0.3,
  windowSec: 150
}

/** Why a take is not the one to keep. */
export type TakeIssue =
  | 'broken off'
  | 'restart'
  | 'stumble'
  | 'filler'
  | 'groan'
  | 'laugh'
  | 'long pause'
  | 'stretched word'
  | 'slow'
  | 'quiet'

export interface Take {
  /** First and last word ids, inclusive. */
  from: string
  to: string
  startSec: number
  endSec: number
  /** Said to the end, not abandoned. */
  complete: boolean
  /** From 0 to 1: how cleanly it was delivered. */
  fluency: number
  issues: TakeIssue[]
  /** Words the take covers once it is struck: the take and whatever hangs off it (a groan, a "sorry", a lone "-"). */
  span: { from: string; to: string }
}

export interface TakeGroup {
  id: string
  /** The first words of the fullest take, for the reply and the panel. */
  label: string
  takes: Take[]
  /** The take to keep, by index into takes. */
  chosen: number
  /** Why that take, in a phrase that can follow "the 4th take of the intro,". */
  reason: string
  /** From 0 to 1: that these really are takes of one line. */
  confidence: number
  /** True when the line opens the recording. */
  intro: boolean
}

/** A fragment abandoned mid-sentence and the words it was restarted with. */
export interface Restart {
  kind: 'restart' | 'stutter'
  /** The abandoned words, to strike, inclusive. */
  from: string
  to: string
  /** The first kept word of the continuation. */
  at: string
  atSec: number
  confidence: number
  /** The repeated words, for the reply: "for three". */
  repeated: string
}

export interface SetupTalk {
  from: string
  to: string
  where: 'head' | 'tail'
  startSec: number
  endSec: number
  confidence: number
}

export interface TakesAnalysis {
  source: string
  groups: TakeGroup[]
  restarts: Restart[]
  setup: SetupTalk[]
  /** Spoken cues found between takes ("let me say that again"), struck with the take before them. */
  cues: { from: string; to: string }[]
}

interface W {
  i: number
  id: string
  text: string
  norm: string
  start: number
  end: number
  mark: boolean
  filler: boolean
  groan: boolean
  laugh: boolean
  content: boolean
  cutOff: boolean
}

interface Line {
  n: number
  /** Positions into the word list, kept words only. */
  idx: number[]
  tokens: string[]
  start: number
  end: number
  endsSentence: boolean
  endsCutOff: boolean
  /** A groan, laugh or filler right after it. */
  brokenAfter: boolean
  gapAfter: number
  /** Position of its last word, content or not. */
  lastI: number
}

const clamp = (v: number, lo = 0, hi = 1): number => Math.min(hi, Math.max(lo, v))

/** Words that are set-up talk on their own when a real pause follows: "okay", "alright". */
const BARE_SETUP: ReadonlySet<string> = new Set(['okay', 'ok', 'alright', 'right', 'cool', 'ready'])

function prepare(words: Word[]): W[] {
  const sorted = [...words].sort((a, b) => a.startSec - b.startSec)
  return sorted.map((w, i) => {
    const mark = isMark(w.text)
    const filler = !mark && isFiller(w.text)
    const norm = mark ? '' : normWord(w.text)
    const groan = !mark && GROANS.has(norm)
    const laugh = !mark && isLaughWord(w.text)
    const next = sorted[i + 1]
    return {
      i,
      id: w.id,
      text: w.text,
      norm,
      start: w.startSec,
      end: w.endSec,
      mark,
      filler,
      groan,
      laugh,
      content: !mark && !filler && !groan && !laugh && norm !== '',
      // Cut off when written so, or when Whisper put a lone "-" right after it.
      cutOff:
        looksCutOff(w.text) ||
        (!!next && isMark(next.text) && /[-—–]/.test(next.text) && next.startSec - w.endSec < 0.5)
    }
  })
}

/** Median of a list, or null when empty. */
function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

export function analyzeTakes(
  words: Word[],
  source: string,
  audio: TakeAudio | null = null,
  opts: TakesOptions = DEFAULT_TAKES
): TakesAnalysis {
  const all = prepare(words.filter((w) => w.source === source))
  const result: TakesAnalysis = { source, groups: [], restarts: [], setup: [], cues: [] }
  if (all.length === 0) return result

  const db = (w: W): number | null => audio?.words[w.id]?.[0] ?? null
  const f0 = (w: W): number | null => audio?.words[w.id]?.[1] ?? null
  const unwordedIn = (a: number, b: number, kinds: string[]): boolean =>
    !!audio?.unworded.some((u) => u.endSec > a && u.startSec < b && kinds.includes(u.kind))

  /** A loudness drop at a word: it sits well under the speaker's level just before it. */
  const dropAt = (p: number): boolean => {
    const here = db(all[p])
    if (here === null) return false
    const before = all
      .slice(Math.max(0, p - 8), p)
      .map(db)
      .filter((v): v is number => v !== null)
    const ref = median(before)
    return ref !== null && here <= ref - 6
  }

  const struck = new Set<number>()
  const hidden = hiddenPauses(all)
  /** The pause between two neighbouring words, counting one hidden inside either. */
  const pauseBetween = (a: W, b: W): number => Math.max(b.start - a.end, hidden[a.i], hidden[b.i])

  // Stumbles on one function word: "the the the screen". Whisper drops most
  // of these itself; the ones it keeps flow with almost no gap.
  if (opts.stutters) {
    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i]
      if (!a.content || !FUNCTION_WORDS.has(a.norm) || GRAMMATICAL_DOUBLES.has(a.norm)) continue
      let j = i
      while (
        j + 1 < all.length &&
        all[j + 1].content &&
        all[j + 1].norm === a.norm &&
        pauseBetween(all[j], all[j + 1]) < 0.35
      )
        j++
      if (
        j > i &&
        !meantRepeat(
          all
            .slice(i, j + 1)
            .map((w) => w.text)
            .join(' ')
        )
      ) {
        for (let k = i; k < j; k++) struck.add(k)
        result.restarts.push({
          kind: 'stutter',
          from: a.id,
          to: all[j - 1].id,
          at: all[j].id,
          atSec: all[j].start,
          confidence: 0.85,
          repeated: a.text.replace(/[^\p{L}\p{N}']/gu, '')
        })
        i = j
      }
    }
  }

  // Mid-sentence restarts: a break, then words just said.
  const content = all.filter((w) => w.content && !struck.has(w.i))
  if (opts.restarts) {
    for (let c = 1; c < content.length; c++) {
      const k = content[c]
      const p = content[c - 1]
      if (struck.has(p.i) || struck.has(k.i)) continue
      const between = all.slice(p.i + 1, k.i)
      const gap = pauseBetween(p, k)
      // A cue said just before the restart ("the speakers are loud, sorry,
      // let me say that again") sits between the repeated words and the
      // break: look past it for the fragment.
      let cueLen = 0
      for (let t = Math.min(7, c); t >= 2; t--) {
        if (isCue(content.slice(c - t, c).map((w) => w.text))) {
          cueLen = t
          break
        }
      }
      const marked = p.cutOff || between.some((w) => w.mark)
      const filled = between.some((w) => w.filler)
      const groaned = between.some((w) => w.groan || w.laugh) || unwordedIn(p.end, k.start, ['groan', 'laugh'])
      const cued = cueLen > 0 || (isCue(between.filter((w) => !w.mark).map((w) => w.text)) && between.length > 0)
      const dropped = dropAt(p.i)
      const breath = unwordedIn(p.end, k.start, ['breath'])
      // Whisper starts a new sentence where it heard one: a capitalised "For"
      // or "The" after a word that ends nothing, or a full stop after a word
      // no sentence ends on ("So the best camera for.").
      const capital = FUNCTION_WORDS.has(k.norm) && k.norm !== 'i' && /^[A-Z]/.test(k.text) && !endsSentence(p.text)
      const dangling = FUNCTION_WORDS.has(p.norm) && endsSentence(p.text)
      const eps = 0.02
      const strong =
        gap >= opts.breakSec - eps ||
        marked ||
        filled ||
        groaned ||
        cued ||
        dangling ||
        ((dropped || breath || capital) && gap >= opts.breakSec * 0.5 - eps)
      // Without one, only a long run said again counts, and less surely:
      // people do not repeat three or more words in a row for emphasis. A
      // fallback window can close every gap, so very long runs need none.
      const runOn = gap < 0.12

      // The longest run before the break that the words after it repeat.
      // Only the last word before the break may be a cut-off stem of its twin.
      let best = 0
      let mismatches = 0
      const end = c - cueLen
      const maxL = Math.min(30, end)
      for (let L = maxL; L >= 1; L--) {
        const A = content.slice(end - L, end)
        const B = content.slice(c, c + L)
        if (B.length < L) continue
        if (A.some((w) => struck.has(w.i))) continue
        // The fragment is one breath group: no long pause inside it.
        let inner = false
        for (let t = 1; t < A.length; t++) if (A[t].start - A[t - 1].end >= 0.6) inner = true
        if (inner) continue
        let miss = 0
        let ok = sameWord(A[0].norm, B[0].norm)
        for (let t = 1; ok && t < L; t++) {
          if (!sameWord(A[t].norm, B[t].norm, t === L - 1)) {
            miss++
            if (L < 4 || miss > 1 || t === L - 1) ok = false
          }
        }
        if (ok) {
          best = L
          mismatches = miss
          break
        }
      }
      if (best === 0) continue
      // A soft break (a short gap and nothing else) only counts for a long run,
      // and no gap at all only for a very long one.
      if (!strong && best < (runOn ? 5 : 3)) continue
      const A = content.slice(end - best, end)
      const B = content.slice(c, c + best)
      const phrase = [...A, ...B].map((w) => w.text).join(' ')
      if (meantRepeat(phrase)) continue

      // A whole sentence said again is a repeated line, not a restart; the
      // line pass decides between such takes.
      const afterB = content.slice(c + best, c + best + 3)
      const lineGoesOn =
        afterB.length > 0 && !endsSentence(B[B.length - 1].text) && afterB[0].start - B[B.length - 1].end < 0.6
      const cutStem =
        A[A.length - 1].norm.length < B[B.length - 1].norm.length &&
        sameWord(A[A.length - 1].norm, B[B.length - 1].norm, true)
      if (!lineGoesOn && !cutStem && !marked) continue

      // A single repeated content word needs more than a pause to count.
      const single = best === 1
      const contentWord = single && !FUNCTION_WORDS.has(A[0].norm)
      let conf = 0.35 + 0.12 * Math.min(best, 4) - 0.08 * mismatches
      if (marked || cutStem) conf += 0.15
      if (filled || groaned) conf += 0.1
      if (cued) conf += 0.15
      if (gap >= 0.5) conf += 0.1
      else if (gap >= opts.breakSec) conf += 0.05
      if (dropped || breath) conf += 0.1
      if (capital) conf += 0.05
      if (contentWord && !marked && !cutStem && !filled) conf -= 0.2
      if (dangling) conf += 0.05
      if (!strong) conf -= best >= 5 ? 0.05 : 0.15
      conf = clamp(conf, 0, 0.98)

      const first = A[0]
      const last = all[k.i - 1]
      for (let i = first.i; i < k.i; i++) struck.add(i)
      result.restarts.push({
        kind: 'restart',
        from: first.id,
        to: last.id,
        at: k.id,
        atSec: k.start,
        confidence: conf,
        repeated: B.map((w) => w.text.replace(/[^\p{L}\p{N}'’-]/gu, '')).join(' ')
      })
    }
  }

  // Lines: what is left, broken at sentence ends and long pauses.
  const lines: Line[] = []
  /** A line from the positions of its words, struck ones left out. */
  const makeLine = (cur: number[]): Line | null => {
    const idx = cur.filter((i) => all[i].content)
    if (idx.length === 0) return null
    const lastI = cur[cur.length - 1]
    const lastContent = all[idx[idx.length - 1]]
    const next = all.find((w, j) => j > lastI && !struck.has(j))
    const after = all.slice(lastI + 1, (next?.i ?? all.length - 1) + 1)
    return {
      n: lines.length,
      idx,
      tokens: idx.map((i) => all[i].norm),
      start: all[cur[0]].start,
      end: all[lastI].end,
      endsSentence: endsSentence(lastContent.text),
      endsCutOff: lastContent.cutOff,
      brokenAfter:
        (!!next && (next.groan || next.laugh || next.filler)) ||
        after.some((w) => w.groan || w.laugh) ||
        unwordedIn(all[lastI].end, next?.start ?? all[lastI].end + 1, ['groan', 'laugh']),
      gapAfter: next ? next.start - all[lastI].end : Infinity,
      lastI
    }
  }
  {
    let cur: number[] = []
    const flush = (): void => {
      const line = makeLine(cur)
      if (line) lines.push(line)
      cur = []
    }
    for (let i = 0; i < all.length; i++) {
      if (struck.has(i)) continue
      const w = all[i]
      const prevI = cur.length ? cur[cur.length - 1] : -1
      const prev = prevI >= 0 ? all[prevI] : null
      // A cut restart joins its two sides seamlessly, so the pause that
      // counts is the one before the abandoned fragment, not the fragment's
      // own length: "So [the best camera for] the best camera" is one line.
      const firstStruck = prev ? all.slice(prevI + 1, i).find((x) => struck.has(x.i)) : undefined
      const pause = prev ? (firstStruck ? firstStruck.start : w.start) - prev.end : 0
      // Starting the line over is a new take: after a pause for its first two
      // words, and with no pause at all for its first three.
      const opening = cur.filter((x) => all[x].content).slice(0, 3)
      const ahead = all
        .slice(i)
        .filter((x) => x.content && !struck.has(x.i))
        .slice(0, 3)
      const matches = (n: number): boolean =>
        opening.length >= n &&
        ahead.length >= n &&
        opening.slice(0, n).every((x, t) => sameWord(all[x].norm, ahead[t].norm))
      const over =
        cur.length > 0 &&
        all[cur[0]].i !== i &&
        ((matches(2) && !!prev && pauseBetween(prev, w) >= 0.3) ||
          (matches(3) && cur.filter((x) => all[x].content).length >= 3))
      if (prev && (pause >= 0.6 || over)) flush()
      cur.push(i)
      if (w.content && (endsSentence(w.text) || w.cutOff)) flush()
      else if (w.groan || w.laugh) flush()
    }
    flush()
  }
  mergeSplitTakes(lines, all, opts)
  splitRunOns(lines, all, hidden, (from, to) => makeLine(range(from, to).filter((i) => !struck.has(i))))

  // Set-up talk at the head and the tail.
  const setupLines = new Set<number>()
  if (opts.setup && lines.length > 1) {
    for (const where of ['head', 'tail'] as const) {
      const order = where === 'head' ? lines : [...lines].reverse()
      for (const line of order) {
        const texts = line.idx.map((i) => all[i].text)
        const share = setupShare(texts)
        const near = where === 'head' ? line.start - lines[0].start <= 30 : lines[lines.length - 1].end - line.end <= 20
        const before = lines[line.n - 1]
        const after = lines[line.n + 1]
        const pause =
          where === 'head'
            ? after
              ? pauseBetween(all[line.lastI], all[after.idx[0]])
              : line.gapAfter
            : before
              ? pauseBetween(all[before.lastI], all[line.idx[0]])
              : 0
        // Set-up talk names the recording ("is it recording?", "cut"), or is a
        // bare "okay" with a real pause after it. A lone "So" is speech.
        const bare = texts.length <= 3 && texts.map(normWord).every((w) => BARE_SETUP.has(w))
        if (!near || texts.length > 8 || share < 0.7 || !(hasSetupWord(texts) || (bare && pause >= 1))) break
        setupLines.add(line.n)
        result.setup.push({
          from: all[line.idx[0]].id,
          to: all[line.idx[line.idx.length - 1]].id,
          where,
          startSec: line.start,
          endSec: line.end,
          confidence: clamp((share >= 0.9 ? 0.75 : 0.6) + (pause >= 0.8 ? 0.15 : 0))
        })
      }
    }
  }

  if (!opts.lines) return finish(result, all)

  // Link each line to the earlier line it most resembles.
  const cueLines = new Set<number>()
  const parent = lines.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const linkConf = new Map<number, number>()

  const abandoned = (m: Line, j: Line): boolean =>
    m.endsCutOff || m.brokenAfter || !m.endsSentence || m.tokens.length <= j.tokens.length - 2
  /** Matches too weak alone, kept to be confirmed by the lines around them. */
  const candidates: { j: Line; m: Line; conf: number }[] = []

  for (const j of lines) {
    if (setupLines.has(j.n) || j.tokens.length < 2) continue
    if (isCue(j.idx.map((i) => all[i].text)) && j.tokens.length <= 6) {
      cueLines.add(j.n)
      continue
    }
    let best: { m: Line; conf: number } | null = null
    for (let mi = j.n - 1; mi >= 0; mi--) {
      const m = lines[mi]
      if (setupLines.has(m.n) || cueLines.has(m.n) || m.tokens.length < 2) continue
      const apart = j.start - m.end
      const near = apart <= opts.windowSec && j.n - m.n <= 14
      const a = m.tokens
      const b = j.tokens
      const shared = lcs(a, b)
      const full = shared / Math.max(a.length, b.length)
      const startsAlike = sharedPrefix(a, b) >= 1
      // An abandoned take: a prefix of the later one, perhaps ending on a
      // stem of the word it was cut from.
      const stem = (x: string, y: string): boolean => sameWord(x, y, true)
      const prefixShare = a.length < b.length ? lcs(a, b.slice(0, a.length + 2), stem) / a.length : 0
      // A later take can also be the shorter one, reworded down: "welcome
      // back to the channel" said again as "welcome back". Offered unless
      // the lines around it say the same.
      const laterPrefix = b.length < a.length ? lcs(b, a.slice(0, b.length + 2)) / b.length : 0
      // An abandoned take stops on a word the later take says too, or on a
      // stem of one, or stops at a break. "We shall fight on the beaches, we
      // shall fight on the landing grounds" diverges and flows on: one line.
      const lastA = a[a.length - 1]
      const stopsOnKeptWord = b.slice(Math.max(0, a.length - 2), a.length + 2).some((x) => stem(lastA, x))
      const breakAfter = m.endsCutOff || m.brokenAfter || m.gapAfter >= opts.breakSec - 0.02
      let conf = 0
      let reworded = false
      if (prefixShare >= 0.8 && a.length >= 2 && startsAlike && abandoned(m, j) && (stopsOnKeptWord || breakAfter)) {
        conf = 0.6 + 0.08 * Math.min(a.length, 4) + (m.endsCutOff ? 0.1 : 0)
      } else if (laterPrefix >= 0.85 && b.length >= 3 && startsAlike && !j.endsCutOff) {
        reworded = true
        conf = 0.55
      } else if (full >= 0.6 && shared >= 3) {
        // Complete takes must end alike too, or they are two lines that start
        // the same way ("we shall fight on the beaches, we shall fight on the
        // landing grounds") and say different things.
        const tailA = a.slice(-3)
        const tailB = b.slice(-3)
        const endsAlike = lcs(tailA, tailB) >= Math.min(2, tailA.length, tailB.length) || full >= 0.85
        if (!endsAlike) continue
        conf = 0.45 + 0.5 * full + (startsAlike ? 0 : -0.1)
        // The last word is usually what a line is about: "we tested the
        // battery" and "we tested the screen" are two lines. When it differs,
        // the match is offered at most, and a run of lines that all start the
        // same way and end differently is a list, not takes.
        if (!sameWord(a[a.length - 1], b[b.length - 1])) {
          conf -= 0.3
          const parallel = [lines[m.n - 1], lines[j.n + 1]].some(
            (o) =>
              !!o &&
              sharedPrefix(o.tokens, b) >= 2 &&
              !sameWord(o.tokens[o.tokens.length - 1], b[b.length - 1]) &&
              !sameWord(o.tokens[o.tokens.length - 1], a[a.length - 1])
          )
          if (parallel) continue
        }
      } else continue
      // Something said between the two that is not another take of them.
      const others = lines.slice(m.n + 1, j.n).filter((l) => !cueLines.has(l.n) && l.tokens.length >= 2)
      const between = others.filter((l) => find(l.n) !== find(m.n))
      // A shortened rewording away from its twin waits for the lines around
      // it to confirm it: the intro said again as a whole.
      if (reworded && (!near || between.length > 0)) {
        candidates.push({ j, m, conf: 0.65 })
        continue
      }
      if (!near) {
        // Far apart: only a near-identical line of some length, like the
        // intro said again at the end.
        if (full < 0.85 || Math.min(a.length, b.length) < 5) continue
        conf -= 0.1
      }
      if (between.length > 0) {
        if (full < 0.75 && prefixShare < 0.8) continue
        conf -= 0.15
      }
      const gapBefore = j.start - lines[j.n - 1].end
      if (gapBefore >= 1) conf += 0.05
      if (lines.slice(m.n + 1, j.n).some((l) => cueLines.has(l.n))) conf += 0.15
      // A finished sentence said again straight away is someone meaning it:
      // a refrain, a chant. A retake of a whole line comes after a real pause.
      if (full >= 0.9 && m.endsSentence && !m.brokenAfter && !m.endsCutOff) {
        if (apart < 0.5) conf -= 0.35
        else if (apart < 0.8) conf -= 0.15
      }
      if (meantRepeat(`${all[m.idx[m.idx.length - 1]].text} ${all[j.idx[0]].text}`)) conf -= 0.2
      if (!best || conf > best.conf) best = { m, conf }
    }
    if (best && best.conf >= 0.4) {
      parent[find(j.n)] = find(best.m.n)
      linkConf.set(j.n, clamp(best.conf, 0, 0.98))
    } else if (best) candidates.push({ j, m: best.m, conf: best.conf })
  }

  // A weak match is confirmed when the line right after each of the two is a
  // take of the same line too: the intro said again as a whole, its first
  // sentence reworded.
  for (const { j, m, conf } of candidates) {
    if (linkConf.has(j.n)) continue
    const nj = lines[j.n + 1]
    const nm = lines[m.n + 1]
    if (nj && nm && find(nj.n) === find(nm.n) && nj.n !== nm.n) {
      parent[find(j.n)] = find(m.n)
      linkConf.set(j.n, clamp(conf + 0.25, 0, 0.9))
    }
  }

  // Groups of two or more lines are takes of one line.
  const byRoot = new Map<number, Line[]>()
  for (const l of lines) byRoot.set(find(l.n), [...(byRoot.get(find(l.n)) ?? []), l])

  const firstContent = lines.find((l) => !setupLines.has(l.n) && !cueLines.has(l.n))
  let g = 0
  for (const members of byRoot.values()) {
    if (members.length < 2) continue
    members.sort((x, y) => x.start - y.start)
    const confs = members.slice(1).map((l) => linkConf.get(l.n) ?? 0.5)
    const confidence = confs.reduce((s, c) => s + c, 0) / confs.length

    const longest = members.reduce((a, b) => (b.tokens.length > a.tokens.length ? b : a))
    const takes: Take[] = members.map((l, t) => {
      const later = members.slice(t + 1)
      const isPrefixOfLater = later.some(
        (x) =>
          l.tokens.length <= x.tokens.length - 2 &&
          lcs(l.tokens, x.tokens.slice(0, l.tokens.length + 2), (p, q) => sameWord(p, q, true)) / l.tokens.length >= 0.8
      )
      const complete =
        !l.endsCutOff && !(isPrefixOfLater && (!l.endsSentence || l.brokenAfter)) && !(l.brokenAfter && !l.endsSentence)
      return takeOf(l, complete, all, struck, result.restarts, audio)
    })
    scoreDelivery(takes, members, all, audio, db, f0)

    const chosen = choose(takes)
    const label = phraseOf(longest, all)
    result.groups.push({
      id: `g${++g}`,
      label,
      takes,
      chosen: chosen.index,
      reason: chosen.reason,
      confidence,
      intro: !!firstContent && members.some((l) => l.n === firstContent.n)
    })
  }

  mergeSentenceTakes(result, all)

  // Cue lines that sit between takes go with the take before them.
  for (const n of cueLines) {
    const l = lines[n]
    const nextLine = lines[n + 1]
    if (nextLine && linkConf.has(nextLine.n)) {
      result.cues.push({ from: all[l.idx[0]].id, to: all[l.idx[l.idx.length - 1]].id })
    }
  }

  return finish(result, all)
}

/**
 * A retake of several sentences shows up as one group per sentence, take k
 * of each following take k of the one before. Those are one group: the
 * person made two takes of the intro, not two takes each of two lines.
 */
function mergeSentenceTakes(result: TakesAnalysis, all: W[]): void {
  const at = new Map(all.map((w) => [w.id, w.i]))
  const nothingBetween = (a: Take, b: Take): boolean => {
    const from = at.get(a.span.to) ?? -1
    const to = at.get(b.from) ?? -1
    if (to <= from || b.startSec - a.endSec > 1.5) return false
    return all.slice(from + 1, to).every((w) => !w.content)
  }
  result.groups.sort((x, y) => x.takes[0].startSec - y.takes[0].startSec)
  for (let k = 0; k + 1 < result.groups.length; k++) {
    const a = result.groups[k]
    const b = result.groups.find(
      (g) => g !== a && g.takes.length === a.takes.length && g.takes.every((t, i) => nothingBetween(a.takes[i], t))
    )
    if (!b) continue
    const takes: Take[] = a.takes.map((ta, i) => {
      const tb = b.takes[i]
      return {
        from: ta.from,
        to: tb.to,
        startSec: ta.startSec,
        endSec: tb.endSec,
        complete: ta.complete && tb.complete,
        fluency: Math.min(ta.fluency, tb.fluency),
        issues: [...ta.issues, ...tb.issues],
        span: { from: ta.span.from, to: tb.span.to }
      }
    })
    const chosen = choose(takes)
    result.groups[k] = {
      ...a,
      takes,
      chosen: chosen.index,
      reason: chosen.reason,
      confidence: (a.confidence + b.confidence) / 2,
      intro: a.intro || b.intro
    }
    result.groups.splice(result.groups.indexOf(b), 1)
    k--
  }
}

/**
 * A take with a long pause in the middle of a sentence ("Pixel 9 ... Pro and
 * the Watch") is split in two by the pause. When the two halves together
 * match another line far better than either half does, they are one take.
 */
function mergeSplitTakes(lines: Line[], all: W[], opts: TakesOptions): void {
  void all
  const best = (tokens: string[], skip: Set<number>, near: Line): number => {
    let top = 0
    for (const o of lines) {
      if (skip.has(o.n) || Math.abs(o.start - near.start) > opts.windowSec || o.tokens.length < 2) continue
      top = Math.max(top, lcs(tokens, o.tokens) / Math.max(tokens.length, o.tokens.length))
    }
    return top
  }
  for (let k = 0; k + 1 < lines.length; k++) {
    const l = lines[k]
    const r = lines[k + 1]
    if (l.endsSentence || l.endsCutOff || l.brokenAfter || r.start - l.end > 1.5) continue
    const skip = new Set([l.n, r.n])
    const joined = [...l.tokens, ...r.tokens]
    const together = best(joined, skip, l)
    const apart = Math.max(best(l.tokens, skip, l), best(r.tokens, skip, r))
    if (together >= 0.8 && together >= apart + 0.15) {
      lines.splice(k + 1, 1)
      lines[k] = {
        ...l,
        idx: [...l.idx, ...r.idx],
        tokens: joined,
        end: r.end,
        endsSentence: r.endsSentence,
        endsCutOff: r.endsCutOff,
        brokenAfter: r.brokenAfter,
        gapAfter: r.gapAfter,
        lastI: r.lastI
      }
      lines.forEach((x, n) => (x.n = n))
      k--
    }
  }
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k)

/**
 * Whisper sometimes loses the punctuation and the pauses for a stretch and
 * writes one long run of lower-case words, a word stretched over each
 * silence: "okay that is it for today hey everyone welcome back today i'm
 * reviewing". Such a run is split where a take inside it starts or ends:
 * where three or more words open another line, one of them a word with
 * meaning (two at a hidden pause); where a hidden pause ends another whole
 * line the run begins with; and where a hidden pause closes set-up talk at
 * the head or opens it at the tail. Never after a word with punctuation of
 * its own: there Whisper was writing properly.
 */
function splitRunOns(lines: Line[], all: W[], hidden: number[], make: (from: number, to: number) => Line | null): void {
  const opens = (rest: string[], self: Line, min: number): boolean =>
    lines.some((o) => {
      if (o === self || o.tokens.length < 3) return false
      const n = sharedPrefix(o.tokens, rest)
      return n >= min && o.tokens.slice(0, n).some((t) => !FUNCTION_WORDS.has(t))
    })
  const beginsWith = (l: Line, s: number): boolean =>
    lines.some(
      (o) => o !== l && o.tokens.length >= 3 && o.tokens.length === s && sharedPrefix(o.tokens, l.tokens) === s
    )
  const setupTalk = (texts: string[], pause: number): boolean =>
    texts.length > 0 &&
    texts.length <= 8 &&
    setupShare(texts) >= 0.7 &&
    (hasSetupWord(texts) || (pause >= 1 && texts.map(normWord).every((w) => BARE_SETUP.has(w))))
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k]
    const n = l.tokens.length
    if (n < 3) continue
    const texts = l.idx.map((i) => all[i].text)
    const pauseAt = (s: number): number => Math.max(hidden[l.idx[s - 1]], hidden[l.idx[s]])
    // Which side of a stretched word its silence is on: before it when
    // Whisper began a sentence with it, after it otherwise.
    const capital = (s: number): boolean => /^\p{Lu}/u.test(texts[s]) && all[l.idx[s]].norm !== 'i'
    const sidedPause = (s: number): number =>
      Math.max(capital(s - 1) ? 0 : hidden[l.idx[s - 1]], capital(s) ? hidden[l.idx[s]] : 0)
    const plain = (s: number): boolean => !/[.,;:!?]["')\]]*$/.test(texts[s - 1])
    const cuts = new Set<number>()
    // Set-up talk said straight into the take, up to a hidden pause: the
    // longest such head, the shortest such tail.
    if (k === 0) {
      for (let s = Math.min(8, n - 2); s >= 1; s--) {
        if (plain(s) && sidedPause(s) >= 0.6 && setupTalk(texts.slice(0, s), sidedPause(s))) {
          cuts.add(s)
          break
        }
      }
    }
    if (k === lines.length - 1) {
      for (let s = n - 1; s >= Math.max(1, n - 8); s--) {
        if (plain(s) && sidedPause(s) >= 0.6 && setupTalk(texts.slice(s), sidedPause(s))) {
          cuts.add(s)
          break
        }
      }
    }
    for (let s = 2; s <= n - 1; s++) {
      if (!plain(s)) continue
      const pause = pauseAt(s)
      if (
        (n >= 8 && s <= n - 3 && opens(l.tokens.slice(s), l, pause >= 0.3 ? 2 : 3)) ||
        (pause >= 0.3 && n - s >= 3 && beginsWith(l, s))
      ) {
        cuts.add(s)
      }
    }
    // Parts of at least two words, except set-up talk.
    const sorted = [...cuts].sort((a, b) => a - b).filter((s, i, xs) => i === 0 || s - xs[i - 1] >= 2)
    if (sorted.length === 0) continue
    const parts: Line[] = []
    const bounds = [0, ...sorted, n]
    for (let p = 0; p + 1 < bounds.length; p++) {
      const from = l.idx[bounds[p]]
      const to = p + 2 < bounds.length ? l.idx[bounds[p + 1]] - 1 : l.lastI
      const part = make(from, to)
      if (part) parts.push(part)
    }
    lines.splice(k, 1, ...parts)
    k += parts.length - 1
  }
  lines.forEach((x, i) => (x.n = i))
}

/**
 * Whisper often stretches a word over the silence beside it, so a pause can
 * hide inside a word: "shines" lasting 2.4 s. A word far longer than the
 * speaker's own pace needs for its letters holds about that much silence,
 * before it or after it; which side, the words alone cannot tell.
 */
function hiddenPauses(all: W[]): number[] {
  // Digits are spoken long: "5090" is "fifty ninety".
  const letters = (w: W): number => w.norm.replace(/\p{N}/gu, 'xxx').replace(/[^\p{L}]/gu, '').length
  const nominal = (w: W): number => 0.1 + 0.05 * Math.min(letters(w), 14)
  const ratios = all.filter((w) => w.content && letters(w) >= 2).map((w) => (w.end - w.start) / nominal(w))
  const pace = clamp(median(ratios) ?? 1, 0.5, 2)
  return all.map((w) => {
    if (w.mark) return 0
    const expected = pace * nominal(w)
    const dur = w.end - w.start
    return dur >= 1.8 * expected && dur - expected >= 0.25 ? dur - expected : 0
  })
}

function finish(result: TakesAnalysis, all: W[]): TakesAnalysis {
  void all
  result.groups.sort((a, b) => a.takes[0].startSec - b.takes[0].startSec)
  result.groups.forEach((grp, i) => (grp.id = `g${i + 1}`))
  return result
}

/** The words of a line as a take: its span runs on over the marks, fillers and groans that hang off it. */
function takeOf(
  l: Line,
  complete: boolean,
  all: W[],
  struck: Set<number>,
  restarts: Restart[],
  audio: TakeAudio | null
): Take {
  const first = all[l.idx[0]]
  const last = all[l.idx[l.idx.length - 1]]
  // Hanging words: marks, fillers, groans and laughs up to the next content word.
  let end = last.i
  while (end + 1 < all.length && !all[end + 1].content && !struck.has(end + 1)) end++
  const issues: TakeIssue[] = []
  if (!complete) issues.push('broken off')
  const inside = all.slice(first.i, last.i + 1)
  // One issue per filler: three "uh"s are a worse take than one.
  for (const w of inside) if (w.filler) issues.push('filler')
  if (inside.some((w) => w.groan)) issues.push('groan')
  if (inside.some((w) => w.laugh)) issues.push('laugh')
  if (restarts.some((r) => r.atSec > first.start && r.atSec <= last.end + 0.01)) {
    issues.push(
      restarts.some((r) => r.kind === 'restart' && r.atSec > first.start && r.atSec <= last.end) ? 'restart' : 'stumble'
    )
  }
  for (let t = 1; t < l.idx.length; t++) {
    if (all[l.idx[t]].start - all[l.idx[t - 1]].end >= 0.8) {
      issues.push('long pause')
      break
    }
  }
  // A word stretched over a pause inside the line is how a swallowed take
  // shows. The first and last words take the silence around a line, so they
  // do not count.
  if (l.idx.slice(1, -1).some((i) => all[i].end - all[i].start >= 1.2)) issues.push('stretched word')
  void audio
  return {
    from: first.id,
    to: last.id,
    startSec: first.start,
    endSec: last.end,
    complete,
    fluency: 1,
    issues,
    span: { from: first.id, to: all[end].id }
  }
}

/**
 * Delivery: fluency from what went wrong in each take, pace against the
 * others, and, when Cutalong listened, energy and pitch movement.
 */
function scoreDelivery(
  takes: Take[],
  members: Line[],
  all: W[],
  audio: TakeAudio | null,
  db: (w: W) => number | null,
  f0: (w: W) => number | null
): void {
  const pace = members.map((l) => l.tokens.length / Math.max(0.3, l.end - l.start))
  const paceRef = median(pace) ?? 0
  const energy = members.map((l) => median(l.idx.map((i) => db(all[i])).filter((v): v is number => v !== null)))
  const energyRef = median(energy.filter((v): v is number => v !== null))
  const movement = members.map((l) => {
    const p = l.idx.map((i) => f0(all[i])).filter((v): v is number => v !== null && v > 0)
    if (p.length < 3) return null
    const semis = p.map((hz) => 12 * Math.log2(hz / 100))
    return Math.max(...semis) - Math.min(...semis)
  })
  const movementRef = median(movement.filter((v): v is number => v !== null))

  takes.forEach((take, t) => {
    let f = 1
    const count = (issue: TakeIssue): number => take.issues.filter((x) => x === issue).length
    f -= 0.12 * Math.min(3, count('filler'))
    f -= 0.25 * count('restart')
    f -= 0.15 * count('stumble')
    f -= 0.1 * count('long pause')
    f -= 0.3 * count('stretched word')
    f -= 0.3 * (count('groan') + count('laugh'))
    if (paceRef > 0 && pace[t] < paceRef * 0.75 && takes.length > 2) {
      f -= 0.1
      take.issues.push('slow')
    }
    if (audio && energyRef !== null && energy[t] !== null && (energy[t] as number) < energyRef - 4) {
      f -= 0.1
      take.issues.push('quiet')
    }
    if (audio && movementRef !== null && movement[t] !== null && (movement[t] as number) < movementRef * 0.5) f -= 0.05
    if (!take.complete) f *= 0.5
    take.fluency = clamp(f)
  })
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']

/** "the 2nd", "the 11th": a take's number as the reply says it. */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

export { ORDINALS }

/**
 * The take to keep: the last complete one, unless an earlier complete one
 * was clearly more fluent. With no complete take, the fullest one.
 */
export function choose(takes: Take[]): { index: number; reason: string } {
  const complete = takes.map((t, i) => ({ t, i })).filter((x) => x.t.complete)
  if (complete.length === 0) {
    const fullest = takes.reduce(
      (best, t, i) => (t.endSec - t.startSec > takes[best].endSec - takes[best].startSec ? i : best),
      0
    )
    return { index: fullest, reason: 'the fullest of them, though none was finished' }
  }
  const last = complete[complete.length - 1]
  const clean = complete.filter((x) => x.t.fluency >= 0.85)
  const better = complete.filter((x) => x.i !== last.i && x.t.fluency >= last.t.fluency + 0.25)
  if (better.length > 0) {
    const pick = better.reduce((a, b) =>
      b.t.fluency > a.t.fluency || (b.t.fluency === a.t.fluency && b.i > a.i) ? b : a
    )
    const only = clean.length === 1 && clean[0].i === pick.i
    return { index: pick.i, reason: only ? 'the only one without a stumble' : 'the cleanest delivery' }
  }
  if (complete.length === 1) return { index: last.i, reason: 'the only complete one' }
  if (clean.length === 1 && clean[0].i === last.i && takes.length > 2) {
    return { index: last.i, reason: 'the only one without a stumble' }
  }
  return { index: last.i, reason: 'the last complete one' }
}

/** The opening words of a line, cleaned up for a reply: "The RTX 5090 is the fastest". */
function phraseOf(l: Line, all: W[], max = 6): string {
  const words = l.idx.slice(0, max).map((i) => all[i].text.replace(/[.,!?;:]+$/, ''))
  return words.join(' ') + (l.idx.length > max ? '…' : '')
}

/** Content tokens of a word list, exported for tests and the planner. */
export function tokensOf(words: Word[]): string[] {
  return contentTokens(words.map((w) => w.text))
}
