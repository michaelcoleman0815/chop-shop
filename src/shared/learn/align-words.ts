import { nearMatch } from './text'

/**
 * Lines a finished video's words up against the raw recording's, as ordered
 * runs that may jump.
 *
 * A finished video is the recording with stretches cut out, so its words
 * mostly appear in the same order with gaps: a forward skip is a cut. Now and
 * then a section is moved earlier or later, which is a jump backwards. Both
 * are allowed and both cost something, so the cheapest reading is the one
 * with the fewest, longest runs. Words only one transcript heard are allowed
 * too, at a small cost, because two transcripts of the same sound never
 * agree completely.
 *
 * Where the same line was said twice, the words cannot tell the takes apart.
 * This picks one; the sound decides between them afterwards (see align.ts).
 */

export interface TokenAlignOptions {
  /** Score for the same word, and for a near miss. */
  match: number
  near: number
  /** Cost of taking a different word inside a run, for a word one transcript misheard. */
  substitute: number
  /** Cost of a finished word that is not in the recording at all. */
  unmatched: number
  /** Cost of skipping forward in the recording: a cut. */
  forward: number
  /** Cost of going back, or repeating: a moved section. */
  backward: number
  /** Roughly how many cells one pass may hold; longer videos are aligned in overlapping chunks. */
  cells: number
  /** Words of context either side of a chunk. */
  overlap: number
}

export const DEFAULT_TOKEN_ALIGN: TokenAlignOptions = {
  match: 1,
  near: 0.6,
  substitute: 0.8,
  unmatched: 0.4,
  forward: 0.8,
  backward: 1.6,
  cells: 4_000_000,
  overlap: 40
}

const NEG = -1e9

/** For each finished word, the index of the raw word it is, or -1. */
export function alignTokens(fin: string[], raw: string[], options: Partial<TokenAlignOptions> = {}): Int32Array {
  const o = { ...DEFAULT_TOKEN_ALIGN, ...options }
  const out = new Int32Array(fin.length).fill(-1)
  if (fin.length === 0 || raw.length === 0) return out

  // Words as numbers, and the near misses worked out once per pair of distinct words.
  const vocab = new Map<string, number>()
  const id = (t: string): number => {
    let v = vocab.get(t)
    if (v === undefined) vocab.set(t, (v = vocab.size))
    return v
  }
  const rawIds = Int32Array.from(raw, id)
  const finIds = Int32Array.from(fin, id)
  const rawVocab = [...new Set(rawIds)]
  const words = [...vocab.keys()]
  const near = new Map<number, Set<number>>()
  for (const f of new Set(finIds)) {
    const set = new Set<number>()
    for (const r of rawVocab) if (r !== f && nearMatch(words[f], words[r])) set.add(r)
    if (set.size) near.set(f, set)
  }
  const score = (f: number, r: number): number => (f === r ? o.match : near.get(f)?.has(r) ? o.near : -o.substitute)

  const m = raw.length
  const per = Math.max(30, Math.floor(o.cells / m) - 2 * o.overlap)
  for (let c0 = 0; c0 < fin.length; c0 += per) {
    const c1 = Math.min(fin.length, c0 + per)
    const s = Math.max(0, c0 - o.overlap)
    const e = Math.min(fin.length, c1 + o.overlap)
    const path = alignChunk(finIds.subarray(s, e), rawIds, score, o)
    for (let i = c0; i < c1; i++) out[i] = path[i - s]
  }
  return out
}

/**
 * One pass of the alignment. Two states per cell: the finished word is raw
 * word j (A), or it is in no raw word and the last one matched was j (U).
 */
function alignChunk(
  fin: Int32Array,
  raw: Int32Array,
  score: (f: number, r: number) => number,
  o: TokenAlignOptions
): Int32Array {
  const n = fin.length
  const m = raw.length
  let prevA = new Float64Array(m)
  let prevU = new Float64Array(m)
  let curA = new Float64Array(m)
  let curU = new Float64Array(m)
  // How each cell was reached: 0 start, 1 from A(j-1), 2 from U(j-1), 3 jump forward, 4 jump back.
  const howA = new Uint8Array(n * m)
  // For jumps: the cell jumped from, times two, plus one when it was a U cell.
  const fromA = new Int32Array(n * m)
  // 0 start, 1 from A(j), 2 from U(j).
  const howU = new Uint8Array(n * m)
  const sufVal = new Float64Array(m)
  const sufAt = new Int32Array(m)

  for (let i = 0; i < n; i++) {
    const row = i * m
    if (i === 0) {
      for (let j = 0; j < m; j++) {
        const sc = score(fin[0], raw[j])
        curA[j] = sc > 0 ? sc : NEG
        curU[j] = -o.unmatched
      }
    } else {
      // Best previous cell at or after each j, for jumps back.
      let best = NEG
      let bestAt = -1
      for (let j = m - 1; j >= 0; j--) {
        const a = prevA[j]
        const u = prevU[j]
        const v = a >= u ? a : u
        if (v > best) {
          best = v
          bestAt = a >= u ? j * 2 : j * 2 + 1
        }
        sufVal[j] = best
        sufAt[j] = bestAt
      }
      let pre = NEG
      let preAt = -1
      for (let j = 0; j < m; j++) {
        // Forward jumps come from j-2 or earlier: j-1 is plain continuation.
        if (j >= 2) {
          const a = prevA[j - 2]
          const u = prevU[j - 2]
          const v = a >= u ? a : u
          if (v > pre) {
            pre = v
            preAt = a >= u ? (j - 2) * 2 : (j - 2) * 2 + 1
          }
        }
        const sc = score(fin[i], raw[j])
        let v = NEG
        let how = 0
        let from = -1
        if (j >= 1) {
          if (prevA[j - 1] >= prevU[j - 1]) {
            v = prevA[j - 1]
            how = 1
          } else {
            v = prevU[j - 1]
            how = 2
          }
        }
        // A jump only lands on a real match; a misheard word is only taken inside a run.
        if (sc > 0) {
          const fwd = pre - o.forward
          if (fwd > v) {
            v = fwd
            how = 3
            from = preAt
          }
          const back = sufVal[j] - o.backward
          if (back > v) {
            v = back
            how = 4
            from = sufAt[j]
          }
        }
        curA[j] = v <= NEG / 2 ? NEG : v + sc
        howA[row + j] = how
        fromA[row + j] = from
        if (prevA[j] >= prevU[j]) {
          curU[j] = prevA[j] - o.unmatched
          howU[row + j] = 1
        } else {
          curU[j] = prevU[j] - o.unmatched
          howU[row + j] = 2
        }
      }
    }
    ;[prevA, curA] = [curA, prevA]
    ;[prevU, curU] = [curU, prevU]
  }

  // Back from the best last cell.
  let j = 0
  let inA = true
  let best = NEG
  for (let k = 0; k < m; k++) {
    if (prevA[k] > best) {
      best = prevA[k]
      j = k
      inA = true
    }
    if (prevU[k] > best) {
      best = prevU[k]
      j = k
      inA = false
    }
  }
  const path = new Int32Array(n).fill(-1)
  for (let i = n - 1; i >= 0; i--) {
    const cell = i * m + j
    if (inA) {
      path[i] = j
      const how = howA[cell]
      if (how === 0 || i === 0) break
      if (how === 1) j -= 1
      else if (how === 2) {
        j -= 1
        inA = false
      } else {
        const from = fromA[cell]
        j = from >> 1
        inA = (from & 1) === 0
      }
    } else {
      path[i] = -1
      const how = howU[cell]
      if (how === 0 || i === 0) break
      inA = how === 1
    }
  }
  return path
}
