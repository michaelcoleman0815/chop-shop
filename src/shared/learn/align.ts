import type { Word } from '../edit/schema'
import { alignTokens } from './align-words'
import {
  bestShift,
  frameMismatch,
  HOP_SEC,
  patchCorrelation,
  speechLevel,
  stretchGain,
  type Features
} from './features'
import type { Issue, Piece } from './schema'
import { normToken } from './text'

/**
 * Maps a finished video back onto the raw recording, or recordings, it was
 * cut from: which stretch of which recording plays at each moment.
 *
 * The words say roughly where each part came from, in order with gaps and the
 * occasional section moved. The sound then settles it exactly: each word's
 * moment is found to the frame by matching band energies, which also decides
 * between two takes of the same line, finds the cut inside a pause the words
 * cannot see, and covers stretches where no one speaks.
 *
 * Music laid under the voice, a louder or compressed mix, a moved section,
 * B-roll over the picture and J and L cuts all leave the voice where it was,
 * so they are handled. What cannot be handled is said rather than guessed: a
 * stretch played faster, a finished video that is not from this recording,
 * or two takes that sound too alike to tell apart.
 */

export interface RecordingInput {
  id: string
  /** For sentences: the file name. */
  name?: string
  durationSec: number
  /** Words as the edit document holds them: snapped to the sound, in time order. */
  words: Word[]
  features: Features | null
}

export interface FinishedInput {
  name?: string
  durationSec: number
  words: { text: string; startSec: number; endSec: number }[]
  features: Features | null
}

export interface Alignment {
  /** False when there is nothing to label: no speech, or not from this recording. */
  ok: boolean
  /** In finished-video order. */
  pieces: Piece[]
  issues: Issue[]
  /** Finished words heard in the recording, of all of its words. */
  matched: number
  words: number
  /** Stretches of the recordings whose fate cannot be told, so their words are not labelled. */
  unsure: { source: string; startSec: number; endSec: number }[]
}

export interface AlignOptions {
  /** How far either side of where the words put a word its sound is looked for. */
  searchSec: number
  /** Below this a word did not sound like the recording. */
  matchFloor: number
  /** At or above this it plainly did. */
  goodMatch: number
  /** Offsets this close belong to one unbroken piece, when the sound was compared. */
  sameOffsetSec: number
  /** The same, when only the words were (their timing is looser). */
  wordsOnlySameOffsetSec: number
  /** How much more like the finished video one take must sound than another before I trust the choice. */
  takeMargin: number
  /** At most this much room is assumed past a first or last word when nothing marks the edge. */
  maxEdgeSec: number
  /** Frames that fail to match by this much end a piece. */
  mismatch: number
}

export const DEFAULT_ALIGN: AlignOptions = {
  searchSec: 0.3,
  matchFloor: 0.45,
  goodMatch: 0.55,
  sameOffsetSec: 0.035,
  wordsOnlySameOffsetSec: 0.12,
  takeMargin: 0.04,
  maxEdgeSec: 1,
  mismatch: 20
}

/** A raw word a finished word might be, and the offset that puts it there. */
interface Cand {
  rec: number
  word: number
  /** Raw time minus finished time, in seconds. */
  d: number
  score: number | null
  /** 1 for the same word, 0.6 for a near miss, less for a word the transcripts heard differently. */
  text: number
  /** How many words in a row match around it, itself included (at most 7): 3 or more is another take of the line. */
  context: number
  /** Taken from a neighbour's offset rather than from the words, so only looked for close by. */
  neighbour: boolean
}

interface Draft {
  rec: number
  d: number
  /** Finished word positions (into the token list) this piece was built from. */
  ks: number[]
  firstRaw: number
  lastRaw: number
  score: number | null
  outStart: number
  outEnd: number
  sureStart: boolean
  sureEnd: boolean
}

const MAX_CANDIDATES = 6
const EMIT = 4
const TEXT_WEIGHT = 0.3
const NULL_STEP = 0.3
const CUT_STEP = 0.6
const JUMP_STEP = 1.2
/** A word whose transcript says it is there but whose sound was never compared. */
const WORDS_ONLY_SCORE = 0.6

const named = (name: string | undefined, fallback: string): string => name ?? fallback
const clock = (sec: number): string => {
  const total = Math.max(0, Math.round(sec))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function alignPair(
  recordings: RecordingInput[],
  finished: FinishedInput,
  options: Partial<AlignOptions> = {}
): Alignment {
  const o = { ...DEFAULT_ALIGN, ...options }
  const issues: Issue[] = []
  const finName = named(finished.name, 'the finished video')

  const rawToks: { rec: number; word: number }[] = []
  const rawTexts: string[] = []
  recordings.forEach((r, ri) =>
    r.words.forEach((w, wi) => {
      const t = normToken(w.text)
      if (t) {
        rawToks.push({ rec: ri, word: wi })
        rawTexts.push(t)
      }
    })
  )
  const finWords = [...finished.words].sort((a, b) => a.startSec - b.startSec)
  const finToks: { word: number; tok: string }[] = []
  finWords.forEach((w, i) => {
    const t = normToken(w.text)
    if (t) finToks.push({ word: i, tok: t })
  })

  const fail = (): Alignment => ({ ok: false, pieces: [], issues, matched: 0, words: finToks.length, unsure: [] })
  if (rawToks.length === 0) {
    const names = recordings.map((r) => named(r.name, 'the recording')).join(' or ')
    issues.push({
      kind: 'no-speech-recording',
      text: `I couldn't hear any speech in ${names}, so there is nothing to line up.`
    })
    return fail()
  }
  if (finToks.length === 0) {
    issues.push({
      kind: 'no-speech-finished',
      text: `I couldn't hear any speech in ${finName}, so there is nothing to line up.`
    })
    return fail()
  }

  const F = finished.features
  const sound = F !== null && recordings.some((r) => r.features !== null)
  const tol = sound ? o.sameOffsetSec : o.wordsOnlySameOffsetSec
  const hop = F?.hopSec ?? HOP_SEC
  const rawStartOf = (c: Cand): number => recordings[c.rec].words[c.word].startSec
  const finWord = (k: number): { text: string; startSec: number; endSec: number } => finWords[finToks[k].word]

  // 1. The words: one reading of the whole video, in runs.
  const path = alignTokens(
    finToks.map((t) => t.tok),
    rawTexts
  )

  // 2. Candidates for each finished word: the reading's choice, the same words
  // elsewhere in the recording (another take), and the offsets its
  // neighbours sit at (for a word the transcripts heard differently).
  const bigrams = new Map<string, number[]>()
  const trigrams = new Map<string, number[]>()
  for (let g = 0; g < rawTexts.length; g++) {
    if (g + 1 < rawTexts.length) push(bigrams, `${rawTexts[g]} ${rawTexts[g + 1]}`, g)
    if (g >= 1 && g + 1 < rawTexts.length) push(trigrams, `${rawTexts[g - 1]} ${rawTexts[g]} ${rawTexts[g + 1]}`, g)
  }
  const anchorOf = (k: number): number => {
    for (let dist = 0; dist < finToks.length; dist++) {
      if (k - dist >= 0 && path[k - dist] >= 0) return path[k - dist] + dist
      if (k + dist < finToks.length && path[k + dist] >= 0) return path[k + dist] - dist
    }
    return 0
  }

  const cands: Cand[][] = finToks.map((ft, k) => {
    const fw = finWord(k)
    const tok = ft.tok
    const gs = new Set<number>()
    if (path[k] >= 0) gs.add(path[k])
    const prev = finToks[k - 1]?.tok
    const next = finToks[k + 1]?.tok
    const twins: number[] = []
    if (prev && next) twins.push(...(trigrams.get(`${prev} ${tok} ${next}`) ?? []))
    if (next) twins.push(...(bigrams.get(`${tok} ${next}`) ?? []))
    if (prev) twins.push(...(bigrams.get(`${prev} ${tok}`) ?? []).map((g) => g + 1))
    const anchor = anchorOf(k)
    for (const g of [...new Set(twins)].sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor))) {
      if (gs.size >= MAX_CANDIDATES) break
      if (rawTexts[g] === tok) gs.add(g)
    }
    const list: Cand[] = [...gs].map((g) => {
      const { rec, word } = rawToks[g]
      let left = 0
      while (left < 3 && k - left - 1 >= 0 && g - left - 1 >= 0 && finToks[k - left - 1].tok === rawTexts[g - left - 1])
        left++
      let right = 0
      while (
        right < 3 &&
        k + right + 1 < finToks.length &&
        g + right + 1 < rawTexts.length &&
        finToks[k + right + 1].tok === rawTexts[g + right + 1]
      )
        right++
      return {
        rec,
        word,
        d: recordings[rec].words[word].startSec - fw.startSec,
        score: null,
        text: rawTexts[g] === tok ? 1 : 0.6,
        context: (rawTexts[g] === tok ? 1 : 0) + left + right,
        neighbour: false
      }
    })
    for (const nb of [k - 1, k + 1]) {
      const g = path[nb]
      if (nb < 0 || nb >= finToks.length || g === undefined || g < 0) continue
      const { rec, word } = rawToks[g]
      const d = recordings[rec].words[word].startSec - finWord(nb).startSec
      if (list.some((c) => c.rec === rec && Math.abs(c.d - d) < 0.05)) continue
      const at = nearestWord(recordings[rec].words, fw.startSec + d)
      if (at < 0) continue
      const same = normToken(recordings[rec].words[at].text) === tok
      list.push({ rec, word: at, d, score: null, text: same ? 0.9 : 0.2, context: 0, neighbour: true })
    }
    return list
  })

  // 3. The sound: each candidate moved to where its word actually sounds
  // alike, and scored for how alike.
  if (sound && F) {
    const radius = Math.round(o.searchSec / hop)
    const patch = (k: number): [number, number] => {
      const fw = finWord(k)
      let a = Math.max(0, Math.floor((fw.startSec - 0.06) / hop))
      let b = Math.min(F.frames, Math.ceil((fw.endSec + 0.06) / hop))
      if (b - a < 8) {
        const mid = (a + b) >> 1
        a = Math.max(0, mid - 4)
        b = Math.min(F.frames, a + 8)
      }
      return [a, b]
    }
    const refine = (k: number, list: Cand[]): void => {
      const [a, b] = patch(k)
      for (const c of list) {
        if (c.score !== null) continue
        const R = recordings[c.rec].features
        if (!R) continue
        const m = bestShift(F, a, b - a, R, c.d / hop, c.neighbour ? 5 : radius)
        if (m) {
          c.d = m.shift * hop
          c.score = m.score
        } else c.score = -1
      }
      // Two candidates that ended up at the same moment are one.
      list.sort((x, y) => (y.score ?? 0) - (x.score ?? 0))
      for (let i = list.length - 1; i > 0; i--) {
        if (list.slice(0, i).some((c) => c.rec === list[i].rec && Math.abs(c.d - list[i].d) < 0.02)) list.splice(i, 1)
      }
      for (let i = list.length - 1; i >= 0; i--) if (list[i].score !== null && list[i].score! < 0) list.splice(i, 1)
      if (list.length > 2 * MAX_CANDIDATES) list.length = 2 * MAX_CANDIDATES
    }
    cands.forEach((list, k) => refine(k, list))
    // A word one transcript missed has no candidate in the take it came
    // from, so each word is also tried where its neighbours' takes sit,
    // twice over so it reaches across a missing word or two.
    for (let pass = 0; pass < 2; pass++) {
      const added = cands.map((list, k) => {
        const fw = finWord(k)
        const fresh: Cand[] = []
        for (const nb of [k - 1, k + 1]) {
          for (const c of cands[nb] ?? []) {
            if ((c.score ?? 0) < o.matchFloor) continue
            if ([...list, ...fresh].some((x) => x.rec === c.rec && Math.abs(x.d - c.d) < 0.05)) continue
            const at = nearestWord(recordings[c.rec].words, fw.startSec + c.d)
            if (at < 0) continue
            const same = normToken(recordings[c.rec].words[at].text) === finToks[k].tok
            fresh.push({
              rec: c.rec,
              word: at,
              d: c.d,
              score: null,
              text: same ? 0.9 : 0.2,
              context: 0,
              neighbour: true
            })
          }
        }
        return fresh
      })
      added.forEach((fresh, k) => {
        if (fresh.length === 0) return
        cands[k].push(...fresh)
        refine(k, cands[k])
      })
    }
  }

  // 4. One path through the candidates: alike-sounding words, few cuts.
  const emit = (c: Cand): number => EMIT * ((c.score ?? WORDS_ONLY_SCORE) - o.matchFloor) + TEXT_WEIGHT * c.text
  const step = (a: Cand | null, b: Cand | null): number => {
    if (!a || !b) return -NULL_STEP
    if (a.rec === b.rec && Math.abs(a.d - b.d) <= tol && rawStartOf(b) >= rawStartOf(a) - 0.05) return 0
    if (a.rec === b.rec && rawStartOf(b) > rawStartOf(a)) return -CUT_STEP
    return -JUMP_STEP
  }
  const choice = viterbi(cands, emit, step)

  // 5. Pieces: runs of words at one offset in one recording.
  let drafts: Draft[] = []
  choice.forEach((c, k) => {
    if (!c) return
    const last = drafts[drafts.length - 1]
    const lastCand = last ? choice[last.ks[last.ks.length - 1]] : null
    if (last && lastCand && step(lastCand, c) === 0) {
      last.ks.push(k)
      last.firstRaw = Math.min(last.firstRaw, c.word)
      last.lastRaw = Math.max(last.lastRaw, c.word)
    } else {
      drafts.push({
        rec: c.rec,
        d: c.d,
        ks: [k],
        firstRaw: c.word,
        lastRaw: c.word,
        score: c.score,
        outStart: 0,
        outEnd: 0,
        sureStart: false,
        sureEnd: false
      })
    }
  })
  for (const p of drafts) {
    const ds = p.ks.map((k) => choice[k]!.d).sort((a, b) => a - b)
    p.d = ds[ds.length >> 1]
    const scores = p.ks.map((k) => choice[k]!.score).filter((s): s is number => s !== null)
    p.score = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null
  }
  // A piece's offset, heard over all of it rather than word by word.
  if (sound && F) {
    for (const p of drafts) {
      const R = recordings[p.rec].features
      if (!R) continue
      const a = Math.max(0, Math.floor((finWord(p.ks[0]).startSec - 0.02) / hop))
      const b = Math.min(F.frames, Math.ceil((finWord(p.ks[p.ks.length - 1]).endSec + 0.02) / hop))
      const m = b - a >= 8 ? bestShift(F, a, b - a, R, p.d / hop, 4) : null
      if (m) {
        p.d = m.shift * hop
        p.score = m.score
      }
    }
  }
  // Pieces split only by a word the transcripts disagree on are one piece.
  drafts = drafts.reduce<Draft[]>((acc, p) => {
    const last = acc[acc.length - 1]
    const words = recordings[p.rec].words
    if (
      last &&
      last.rec === p.rec &&
      Math.abs(last.d - p.d) <= Math.min(tol, 0.015) &&
      words[p.firstRaw].startSec >= words[last.lastRaw].startSec - 0.05
    ) {
      last.ks.push(...p.ks)
      last.lastRaw = Math.max(last.lastRaw, p.lastRaw)
      last.firstRaw = Math.min(last.firstRaw, p.firstRaw)
      return acc
    }
    acc.push(p)
    return acc
  }, [])

  // A stretch played faster than it was recorded shows up as a string of
  // short pieces whose offsets creep the same way, word after word. If its
  // sound matches once stretched back to the recording's pace, it was sped
  // up: that is said, and none of it is labelled.
  const handled = new Set<number>()
  const spedUp: { rec: number; f0: number; f1: number; r0: number; r1: number; factor: number }[] = []
  if (sound && F) {
    const creeps = (p: Draft, q: Draft, sign: number): boolean => {
      if (p.rec !== q.rec || p.ks.length > 4 || q.ks.length > 4) return false
      const words = recordings[p.rec].words
      if (words[q.firstRaw].startSec <= words[p.lastRaw].startSec) return false
      const gap = finWord(q.ks[0]).startSec - finWord(p.ks[p.ks.length - 1]).endSec
      const stepSec = q.d - p.d
      return gap < 0.3 && Math.abs(stepSec) > tol && Math.sign(stepSec) === sign
    }
    const found: typeof spedUp = []
    let i = 0
    while (i + 2 < drafts.length) {
      const sign = Math.sign(drafts[i + 1].d - drafts[i].d)
      let j = i
      while (sign !== 0 && j + 1 < drafts.length && creeps(drafts[j], drafts[j + 1], sign)) j++
      let hit = false
      if (j - i >= 2) {
        const run = drafts.slice(i, j + 1)
        // The pieces either side of a sped-up stretch may have joined the run; try without them too.
        for (const part of [run, run.slice(1), run.slice(0, -1), run.slice(1, -1)].filter((r) => r.length >= 3)) {
          const words = recordings[part[0].rec].words
          const lastPart = part[part.length - 1]
          const f0 = finWord(part[0].ks[0]).startSec
          const f1 = finWord(lastPart.ks[lastPart.ks.length - 1]).endSec
          const r0 = words[part[0].firstRaw].startSec
          const r1 = words[lastPart.lastRaw].endSec
          const factor = speedChange(F, recordings[part[0].rec], f0, f1, r0, r1)
          if (!factor) continue
          found.push({ rec: part[0].rec, f0, f1, r0, r1, factor })
          hit = true
          break
        }
      }
      i = hit ? j + 1 : i + 1
    }
    // Neighbouring findings that agree are one stretch, and every word inside it is settled.
    for (const s of found.sort((a, b) => a.f0 - b.f0)) {
      const last = spedUp[spedUp.length - 1]
      if (last && last.rec === s.rec && s.f0 - last.f1 < 2.5 && Math.abs(s.factor - last.factor) < 0.15) {
        last.f1 = Math.max(last.f1, s.f1)
        last.r1 = Math.max(last.r1, s.r1)
        last.factor = Math.round(((last.r1 - last.r0) / (last.f1 - last.f0)) * 100) / 100
      } else spedUp.push({ ...s })
    }
    const inside = (k: number, s: (typeof spedUp)[number]): boolean => {
      const fw = finWord(k)
      return (fw.startSec + fw.endSec) / 2 >= s.f0 - 0.02 && (fw.startSec + fw.endSec) / 2 <= s.f1 + 0.02
    }
    finToks.forEach((_, k) => {
      if (spedUp.some((s) => inside(k, s))) handled.add(k)
    })
    drafts = drafts.filter((p) => !p.ks.every((k) => handled.has(k)))
    for (const p of drafts) {
      if (!p.ks.some((k) => handled.has(k))) continue
      p.ks = p.ks.filter((k) => !handled.has(k))
      p.firstRaw = Math.min(...p.ks.map((k) => choice[k]!.word))
      p.lastRaw = Math.max(...p.ks.map((k) => choice[k]!.word))
    }
    for (const k of handled) choice[k] = null
  }

  // 6. Edges. Between two pieces that follow each other, the cut is found in
  // the gap between their words; elsewhere a piece reaches out until its
  // sound stops matching.
  for (const p of drafts) {
    const words = recordings[p.rec].words
    p.outStart = words[p.firstRaw].startSec - p.d
    p.outEnd = words[p.lastRaw].endSec - p.d
  }
  const gains = drafts.map((p) => {
    const R = recordings[p.rec].features
    if (!sound || !F || !R) return 0
    const a = Math.max(0, Math.floor(p.outStart / hop))
    const b = Math.min(F.frames, Math.ceil(p.outEnd / hop))
    return stretchGain(F, a, R, a + Math.round(p.d / hop), Math.max(1, b - a))
  })
  const unmatchedBetween = (p: Draft, q: Draft): number => {
    let n = 0
    for (let k = p.ks[p.ks.length - 1] + 1; k < q.ks[0]; k++) if (!choice[k]) n++
    return n
  }
  drafts.forEach((p, i) => {
    const q = drafts[i + 1]
    if (!q) return
    if (unmatchedBetween(p, q) <= 2 && q.outStart - p.outEnd < 3) {
      const cut =
        sound && F && recordings[p.rec].features && recordings[q.rec].features
          ? changepoint(F, recordings[p.rec].features!, recordings[q.rec].features!, p, q, gains[i], gains[i + 1])
          : { at: (p.outEnd + q.outStart) / 2, sure: false }
      p.outEnd = cut.at
      q.outStart = cut.at
      p.sureEnd = cut.sure
      q.sureStart = cut.sure
    } else {
      const room = Math.max(0, q.outStart - p.outEnd)
      const right = reach(F, recordings[p.rec], p, gains[i], 1, Math.min(o.maxEdgeSec, room / 2), o, sound)
      const left = reach(F, recordings[q.rec], q, gains[i + 1], -1, Math.min(o.maxEdgeSec, room / 2), o, sound)
      p.outEnd = right.at
      p.sureEnd = right.sure
      q.outStart = left.at
      q.sureStart = left.sure
    }
  })
  if (drafts.length > 0) {
    const first = drafts[0]
    const last = drafts[drafts.length - 1]
    const left = reach(F, recordings[first.rec], first, gains[0], -1, Math.min(o.maxEdgeSec, first.outStart), o, sound)
    first.outStart = left.at
    first.sureStart = left.sure
    const right = reach(
      F,
      recordings[last.rec],
      last,
      gains[drafts.length - 1],
      1,
      Math.min(o.maxEdgeSec, Math.max(0, finished.durationSec - last.outEnd)),
      o,
      sound
    )
    last.outEnd = right.at
    last.sureEnd = right.sure
  }

  const pieces: Piece[] = drafts
    .map((p) => {
      const rec = recordings[p.rec]
      const rawStart = Math.max(0, p.outStart + p.d)
      const rawEnd = Math.min(rec.durationSec || Infinity, p.outEnd + p.d)
      return {
        source: rec.id,
        rawStart,
        rawEnd,
        outStart: rawStart - p.d,
        outEnd: rawEnd - p.d,
        match: p.score,
        sureStart: p.sureStart,
        sureEnd: p.sureEnd
      }
    })
    .filter((p) => p.rawEnd - p.rawStart > 0.02)

  // 7. Stretches with sound but no words, which no piece explains: looked for
  // anywhere in the recordings.
  if (sound && F) {
    for (const gap of soundWithoutPieces(F, pieces, finished.durationSec)) {
      const found = searchEverywhere(F, gap, recordings, o)
      if (found) pieces.push(found)
    }
    pieces.sort((a, b) => a.outStart - b.outStart)
  }

  // 8. What could not be handled, said rather than guessed.
  const unsure: Alignment['unsure'] = []
  for (const s of spedUp) {
    const rec = recordings[s.rec]
    unsure.push({ source: rec.id, startSec: s.r0, endSec: s.r1 })
    issues.push({
      kind: 'speed',
      source: rec.id,
      outStart: s.f0,
      outEnd: s.f1,
      factor: s.factor,
      text: `${clock(s.f0)} to ${clock(s.f1)} plays about ${s.factor.toFixed(2)} times as fast as the recording. I can't label sped-up stretches yet, so I left those words out.`
    })
  }
  const covered = (k: number): boolean => {
    const fw = finWord(k)
    const mid = (fw.startSec + fw.endSec) / 2
    return pieces.some((p) => mid >= p.outStart - 0.02 && mid <= p.outEnd + 0.02)
  }
  const settled = (k: number): boolean => handled.has(k) || (choice[k] !== null && covered(k))
  for (const run of unmatchedRuns(choice, path, rawToks, recordings, settled)) {
    const f0 = finWord(run.ks[0]).startSec
    const f1 = finWord(run.ks[run.ks.length - 1]).endSec
    if (run.raw) {
      const speed = sound && F ? speedChange(F, recordings[run.raw.rec], f0, f1, run.raw.start, run.raw.end) : null
      const rec = recordings[run.raw.rec]
      unsure.push({ source: rec.id, startSec: run.raw.start, endSec: run.raw.end })
      if (speed) {
        issues.push({
          kind: 'speed',
          source: rec.id,
          outStart: f0,
          outEnd: f1,
          factor: speed,
          text: `${clock(f0)} to ${clock(f1)} plays about ${speed.toFixed(2)} times as fast as the recording. I can't label sped-up stretches yet, so I left those words out.`
        })
      } else {
        issues.push({
          kind: 'unmatched',
          source: rec.id,
          outStart: f0,
          outEnd: f1,
          text: `${clock(f0)} to ${clock(f1)} says what the recording says but doesn't sound like it, so I left those ${run.ks.length} words out.`
        })
      }
    } else if (run.ks.length >= 3) {
      issues.push({
        kind: 'unmatched',
        outStart: f0,
        outEnd: f1,
        text: `${run.ks.length} words at ${clock(f0)} aren't in the recording at all, a voice-over perhaps.`
      })
    }
  }

  // Two takes that sounded alike: neither is labelled. A rival is the same
  // line said elsewhere (three or more words in a row match there too). With
  // the sound, it counts when the stretch around the word, inside the piece
  // that was chosen, sounds about as much like the rival take as like the
  // chosen one; with the words alone, when as many words around it match.
  const draftOf = new Map<number, Draft>()
  for (const p of drafts) for (const k of p.ks) draftOf.set(k, p)
  let alike = 0
  choice.forEach((c, k) => {
    if (!c) return
    const rivals = cands[k].filter(
      (x) =>
        x !== c &&
        !x.neighbour &&
        x.text >= 1 &&
        x.context >= 3 &&
        (x.rec !== c.rec || Math.abs(rawStartOf(x) - rawStartOf(c)) > 0.3)
    )
    if (rivals.length === 0) return
    let rival: Cand | undefined
    const p = draftOf.get(k)
    const R = p ? recordings[p.rec].features : null
    if (sound && F && p && R && c.score !== null) {
      const fw = finWord(k)
      const a = Math.max(0, Math.round(Math.max(p.outStart, fw.startSec - 1.5) / hop))
      const b = Math.min(F.frames, Math.round(Math.min(p.outEnd, fw.endSec + 1.5) / hop))
      if (b - a < 8) return
      const mine = patchCorrelation(F, a, R, a + Math.round(p.d / hop), b - a)
      rival = rivals.find((x) => {
        const Rx = recordings[x.rec].features
        const theirs = Rx && x.score !== null ? bestShift(F, a, b - a, Rx, x.d / hop, 2) : null
        return theirs !== null && Number.isFinite(mine) && theirs.score >= mine - o.takeMargin
      })
    } else if (c.score === null) {
      rival = rivals.find((x) => x.context >= Math.min(c.context, 4))
    }
    if (!rival) return
    alike++
    for (const x of [c, rival]) {
      const w = recordings[x.rec].words[x.word]
      unsure.push({ source: recordings[x.rec].id, startSec: w.startSec, endSec: w.endSec })
    }
  })
  if (alike > 0) {
    issues.push({
      kind: sound ? 'alike-takes' : 'words-only',
      text: sound
        ? `${alike} ${alike === 1 ? 'word was' : 'words were'} said in takes too alike to tell apart, so I left them out.`
        : 'I matched these on the words alone, so where a line was said twice I left both takes out.'
    })
  }

  const matched = choice.filter((c, k) => c && covered(k) && (c.score === null || c.score >= o.goodMatch)).length
  const enough = finToks.length >= 5 ? matched / finToks.length >= 0.3 : matched >= Math.ceil(finToks.length / 2)
  if (!enough) {
    issues.length = 0
    const names = recordings.map((r) => named(r.name, 'the recording')).join(' and ')
    issues.push({
      kind: 'not-from-recording',
      text: `${capital(finName)} doesn't seem to come from ${names}: only ${matched} of its ${finToks.length} words match.`
    })
    return { ok: false, pieces: [], issues, matched, words: finToks.length, unsure: [] }
  }

  for (const rec of recordings) {
    if (rec.words.length > 0 && !pieces.some((p) => p.source === rec.id)) {
      issues.push({
        kind: 'unused-recording',
        source: rec.id,
        text: `Nothing from ${named(rec.name, 'one of the recordings')} is in the finished video.`
      })
    }
  }

  return { ok: true, pieces, issues, matched, words: finToks.length, unsure: mergeSpans(unsure) }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** The word starting nearest a time, by binary search. */
function nearestWord(words: Word[], t: number): number {
  if (words.length === 0) return -1
  let lo = 0
  let hi = words.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].startSec < t) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(words[lo - 1].startSec - t) < Math.abs(words[lo].startSec - t)) return lo - 1
  return lo
}

/** The best path through candidates, where null is "this word is not in the recording". */
function viterbi(
  cands: Cand[][],
  emit: (c: Cand) => number,
  step: (a: Cand | null, b: Cand | null) => number
): (Cand | null)[] {
  const states = cands.map((list) => [...list, null] as (Cand | null)[])
  let score = states[0].map((s) => (s ? emit(s) : 0))
  const back: number[][] = [states[0].map(() => -1)]
  for (let k = 1; k < states.length; k++) {
    const next: number[] = []
    const from: number[] = []
    for (const s of states[k]) {
      let best = -Infinity
      let at = -1
      states[k - 1].forEach((p, i) => {
        const v = score[i] + step(p, s)
        if (v > best) {
          best = v
          at = i
        }
      })
      next.push(best + (s ? emit(s) : 0))
      from.push(at)
    }
    score = next
    back.push(from)
  }
  let at = score.indexOf(Math.max(...score))
  const out: (Cand | null)[] = new Array(states.length).fill(null)
  for (let k = states.length - 1; k >= 0; k--) {
    out[k] = states[k][at]
    at = back[k][at]
  }
  return out
}

/**
 * Where between two pieces the cut falls: each frame of the gap belongs to
 * the piece whose recording explains it, and the cut is where that changes.
 * When the gap is a pause buried under music, every point explains it about
 * as well; then the cut is the middle of the points that do, and not sure.
 */
function changepoint(
  F: Features,
  RP: Features,
  RQ: Features,
  p: Draft,
  q: Draft,
  gainP: number,
  gainQ: number
): { at: number; sure: boolean } {
  const hop = F.hopSec
  const u = p.outEnd
  const v = q.outStart
  if (v - u < 2 * hop) return { at: (u + v) / 2, sure: v - u > -0.04 }
  const t0 = Math.round(u / hop)
  const t1 = Math.round(v / hop)
  const sP = Math.round(p.d / hop)
  const sQ = Math.round(q.d / hop)
  const cap = (x: number): number => (Number.isFinite(x) ? Math.min(x, 400) : 400)
  const cp: number[] = []
  const cq: number[] = []
  for (let t = t0; t < t1; t++) {
    cp.push(cap(frameMismatch(F, t, RP, t + sP, gainP)))
    cq.push(cap(frameMismatch(F, t, RQ, t + sQ, gainQ)))
  }
  // total(c) = sum of cp before c + sum of cq from c on.
  const n = t1 - t0
  const totals: number[] = []
  let before = 0
  let after = cq.reduce((a, b) => a + b, 0)
  for (let c = 0; c <= n; c++) {
    totals.push(before + after)
    if (c < n) {
      before += cp[c]
      after -= cq[c]
    }
  }
  const best = Math.min(...totals)
  // What counts as about as good grows with the gap, so long buried pauses read as unsure.
  const slack = 3 + 0.02 * n
  let lo = -1
  let hi = -1
  totals.forEach((v2, c) => {
    if (v2 <= best + slack) {
      if (lo < 0) lo = c
      hi = c
    }
  })
  const at = (t0 + (lo + hi) / 2) * hop
  return { at, sure: (hi - lo) * hop <= 0.04 }
}

/**
 * How far a piece reaches past its outer word, frame by frame, while the
 * finished video still sounds like the recording there. Stops where it
 * clearly stops matching (sure) or at the limit (not sure).
 */
function reach(
  F: Features | null,
  rec: RecordingInput,
  p: Draft,
  gain: number,
  dir: 1 | -1,
  limitSec: number,
  o: AlignOptions,
  sound: boolean
): { at: number; sure: boolean } {
  const from = dir > 0 ? p.outEnd : p.outStart
  const R = rec.features
  if (!sound || !F || !R) return { at: from + dir * Math.min(0.06, limitSec), sure: false }
  const hop = F.hopSec
  const s = Math.round(p.d / hop)
  const steps = Math.floor(limitSec / hop)
  let t = dir > 0 ? Math.ceil(from / hop) - 1 : Math.floor(from / hop)
  let good = t
  let bad = 0
  for (let i = 0; i < steps; i++) {
    t += dir
    if (t < 0 || t >= F.frames || t + s < 0 || t + s >= R.frames) return { at: edgeOf(good, dir, hop), sure: true }
    const m = frameMismatch(F, t, R, t + s, gain)
    if (m > o.mismatch) {
      if (++bad >= 4) return { at: edgeOf(good, dir, hop), sure: true }
    } else {
      bad = 0
      good = t
    }
  }
  return { at: edgeOf(good, dir, hop), sure: false }
}

const edgeOf = (frame: number, dir: 1 | -1, hop: number): number => (dir > 0 ? (frame + 1) * hop : frame * hop)

/** Stretches of the finished video with sound in them that no piece covers. */
function soundWithoutPieces(F: Features, pieces: Piece[], durationSec: number): { start: number; end: number }[] {
  const hop = F.hopSec
  const levels: number[] = []
  for (let t = 0; t < F.frames; t++) levels.push(speechLevel(F, t))
  const sorted = [...levels].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -100
  const spans = [...pieces].sort((a, b) => a.outStart - b.outStart)
  const gaps: { start: number; end: number }[] = []
  let cursor = 0
  for (const p of spans) {
    if (p.outStart - cursor >= 0.5) gaps.push({ start: cursor, end: p.outStart })
    cursor = Math.max(cursor, p.outEnd)
  }
  if (durationSec - cursor >= 0.5) gaps.push({ start: cursor, end: durationSec })
  return gaps
    .filter((g) => {
      const a = Math.floor(g.start / hop)
      const b = Math.min(F.frames, Math.ceil(g.end / hop))
      let loud = 0
      for (let t = a; t < b; t++) if (levels[t] > floor + 15) loud++
      return b > a && loud / (b - a) >= 0.4
    })
    .slice(0, 12)
}

/** Decimated copy of features: averages of `factor` frames, for a quick first look. */
function decimate(f: Features, factor: number): Features {
  const frames = Math.floor(f.frames / factor)
  const data = new Float32Array(frames * f.bands)
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < f.bands; b++) {
      let s = 0
      for (let i = 0; i < factor; i++) s += f.data[(t * factor + i) * f.bands + b]
      data[t * f.bands + b] = s / factor
    }
  }
  return { hopSec: f.hopSec * factor, bands: f.bands, frames, data }
}

const decimated = new WeakMap<Features, Features>()
const coarse = (f: Features): Features => {
  let d = decimated.get(f)
  if (!d) decimated.set(f, (d = decimate(f, 5)))
  return d
}

/** Finds a stretch of the finished video anywhere in the recordings by its sound alone. */
function searchEverywhere(
  F: Features,
  gap: { start: number; end: number },
  recordings: RecordingInput[],
  o: AlignOptions
): Piece | null {
  const cf = coarse(F)
  const a = Math.floor(gap.start / cf.hopSec)
  const len = Math.min(Math.floor((gap.end - gap.start) / cf.hopSec), 30)
  if (len < 6) return null
  let best: { rec: number; at: number; score: number } | null = null
  recordings.forEach((r, ri) => {
    if (!r.features) return
    const cr = coarse(r.features)
    // Every other coarse frame first, then the neighbours of the best.
    const look = (p: number): void => {
      const s = patchCorrelation(cf, a, cr, p, len)
      if (Number.isFinite(s) && (!best || s > best.score)) best = { rec: ri, at: p, score: s }
    }
    for (let p = 0; p + len <= cr.frames; p += 2) look(p)
    const b = best as { rec: number; at: number; score: number } | null
    if (b && b.rec === ri) {
      look(b.at - 1)
      look(b.at + 1)
    }
  })
  const found = best as { rec: number; at: number; score: number } | null
  if (!found || found.score < o.goodMatch) return null
  const rec = recordings[found.rec]
  const R = rec.features as Features
  const fa = Math.floor(gap.start / F.hopSec)
  const flen = Math.min(F.frames - fa, Math.round((gap.end - gap.start) / F.hopSec))
  const shiftAround = found.at * 5 - a * 5
  const m = bestShift(F, fa, flen, R, shiftAround, 8)
  if (!m || m.score < o.goodMatch + 0.1) return null
  const d = m.shift * F.hopSec
  const rawStart = Math.max(0, gap.start + d)
  const rawEnd = Math.min(rec.durationSec || Infinity, gap.end + d)
  return {
    source: rec.id,
    rawStart,
    rawEnd,
    outStart: rawStart - d,
    outEnd: rawEnd - d,
    match: m.score,
    sureStart: false,
    sureEnd: false
  }
}

/**
 * Runs of finished words that are not settled: left out of the path, or in no
 * piece, and not already explained (a sped-up stretch). Each comes with the
 * stretch of recording its words were read as, when they were.
 */
function unmatchedRuns(
  choice: (Cand | null)[],
  path: Int32Array,
  rawToks: { rec: number; word: number }[],
  recordings: RecordingInput[],
  settled: (k: number) => boolean
): { ks: number[]; raw: { rec: number; start: number; end: number } | null }[] {
  const runs: { ks: number[]; raw: { rec: number; start: number; end: number } | null }[] = []
  let ks: number[] = []
  const flush = (): void => {
    if (ks.length === 0) return
    // The recording words the transcript read these as, if they run in order.
    const gs = ks.map((k) => path[k]).filter((g) => g >= 0)
    let raw: { rec: number; start: number; end: number } | null = null
    if (gs.length >= Math.max(2, Math.ceil(ks.length * 0.6))) {
      const first = rawToks[gs[0]]
      const last = rawToks[gs[gs.length - 1]]
      const ordered = gs.every((g, i) => i === 0 || (g > gs[i - 1] && g - gs[i - 1] <= 3))
      if (ordered && first.rec === last.rec) {
        const words = recordings[first.rec].words
        raw = { rec: first.rec, start: words[first.word].startSec, end: words[last.word].endSec }
      }
    }
    if (raw ? ks.length >= 2 : ks.length >= 1) runs.push({ ks, raw })
    ks = []
  }
  choice.forEach((_, k) => {
    if (settled(k)) flush()
    else ks.push(k)
  })
  flush()
  return runs
}

/**
 * Whether a stretch the words matched but the sound did not plays faster or
 * slower than the recording: the sound matches once the finished video's
 * frames are stretched back to the recording's timing. The factor, or null.
 */
function speedChange(F: Features, rec: RecordingInput, f0: number, f1: number, r0: number, r1: number): number | null {
  const R = rec.features
  if (!R || f1 - f0 < 0.8 || r1 - r0 < 0.8) return null
  const hop = F.hopSec
  const factor = (r1 - r0) / (f1 - f0)
  if (Math.abs(factor - 1) < 0.06) return null
  const length = Math.round((r1 - r0) / hop)
  const data = new Float32Array(length * F.bands)
  for (let i = 0; i < length; i++) {
    const at = f0 / hop + i / factor
    const t = Math.floor(at)
    const w = at - t
    for (let b = 0; b < F.bands; b++) {
      const x0 = F.data[Math.min(F.frames - 1, Math.max(0, t)) * F.bands + b]
      const x1 = F.data[Math.min(F.frames - 1, Math.max(0, t + 1)) * F.bands + b]
      data[i * F.bands + b] = x0 * (1 - w) + x1 * w
    }
  }
  const stretched: Features = { hopSec: hop, bands: F.bands, frames: length, data }
  const scaled = bestShift(stretched, 0, length, R, r0 / hop, 30)
  const plain = bestShift(F, Math.round(f0 / hop), Math.round((f1 - f0) / hop), R, (r0 - f0) / hop, 30)
  if (!scaled || scaled.score < 0.6) return null
  if (plain && plain.score > scaled.score - 0.15) return null
  return Math.round(factor * 100) / 100
}

/** Overlapping stretches of the same recording, merged. */
export function mergeSpans<T extends { source: string; startSec: number; endSec: number }>(spans: T[]): T[] {
  const sorted = [...spans].sort((a, b) =>
    a.source === b.source ? a.startSec - b.startSec : a.source < b.source ? -1 : 1
  )
  const out: T[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && last.source === s.source && s.startSec <= last.endSec + 0.01)
      last.endSec = Math.max(last.endSec, s.endSec)
    else out.push({ ...s })
  }
  return out
}
