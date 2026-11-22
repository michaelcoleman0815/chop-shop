import { centroids, clusterVoices, nearest, type Voiced } from './cluster'

/**
 * Who says each word: the transcript cut into stretches where a new speaker
 * could start (after a pause, or after a sentence ends), each stretch's voice
 * fingerprinted (main/speakers), the long stretches grouped into speakers
 * (cluster.ts) and the short ones matched to whoever they sound most like.
 * Long stretches are cut again into pieces of about two seconds, so someone
 * who talks straight over the end of another's sentence is still caught.
 */

/** A pause this long between two words is where another speaker could come in. */
const BREAK_GAP_SEC = 0.3
/** A stretch longer than this is cut into pieces of about PIECE_SEC, between words. */
const LONGEST_SEC = 3
const PIECE_SEC = 2
/** Stretches at least this long are grouped; shorter ones only say whom they sound like. */
export const RELIABLE_SEC = 1
/** Shorter than this, a stretch's voice is not fingerprinted at all: it goes with its neighbours. */
export const LEAST_SEC = 0.4
/** At most this many stretches are grouped, the longest; the rest are matched to the groups. */
const MOST_GROUPED = 600
/** A short stretch between two of one speaker, sounding no more like itself than this over them, is theirs. */
const SURE_MARGIN = 0.1

export interface SpokenWord {
  text: string
  startSec: number
  endSec: number
}

/** A stretch of the transcript: its words (by index) and the sound it spans. */
export interface Stretch {
  words: number[]
  startSec: number
  endSec: number
  /** Which unbroken run of speech it is a piece of: pieces of one run were cut apart mid-sentence. */
  run: number
}

const endsSentence = (text: string): boolean => /[.?!…]["”’)\]]*$/.test(text.trim())

/** The transcript cut where a new speaker could come in, long stretches cut again. */
export function stretchesOf(words: SpokenWord[]): Stretch[] {
  const runs: number[][] = []
  words.forEach((w, i) => {
    const prev = words[i - 1]
    const breaks = !prev || w.startSec - prev.endSec >= BREAK_GAP_SEC || endsSentence(prev.text)
    if (breaks) runs.push([i])
    else runs[runs.length - 1].push(i)
  })
  const out: Stretch[] = []
  runs.forEach((run, r) => {
    const sec = words[run[run.length - 1]].endSec - words[run[0]].startSec
    if (sec <= LONGEST_SEC) {
      out.push({ words: run, startSec: words[run[0]].startSec, endSec: words[run[run.length - 1]].endSec, run: r })
      return
    }
    // Into pieces of about PIECE_SEC, each ending on a word.
    const pieces = Math.max(2, Math.round(sec / PIECE_SEC))
    const each = sec / pieces
    let piece: number[] = []
    let from = words[run[0]].startSec
    for (const i of run) {
      piece.push(i)
      if (words[i].endSec - from >= each) {
        out.push({ words: piece, startSec: words[piece[0]].startSec, endSec: words[i].endSec, run: r })
        piece = []
        from = words[i].endSec
      }
    }
    if (piece.length > 0) {
      const last = out[out.length - 1]
      // A tail too short to stand alone joins the piece before it, when that piece is this run's.
      const tail = words[piece[piece.length - 1]].endSec - words[piece[0]].startSec
      if (tail < LEAST_SEC && last && last.run === r) {
        last.words.push(...piece)
        last.endSec = words[piece[piece.length - 1]].endSec
      } else out.push({ words: piece, startSec: words[piece[0]].startSec, endSec: words[piece[piece.length - 1]].endSec, run: r })
    }
  })
  return out
}

export interface Speakers {
  /** Each word's speaker, 0, 1, 2... in the order they are first heard; null where nothing could say. */
  words: (number | null)[]
  /** How many speakers, and each one's talking time in seconds. */
  talkSec: number[]
}

/**
 * Who says each word, from the stretches and their fingerprints (null for a
 * stretch too short to fingerprint). `speakers`, when known, is how many
 * people there are.
 */
export function speakersOf(
  words: SpokenWord[],
  stretches: Stretch[],
  prints: (Float32Array | null)[],
  opts: { speakers?: number } = {}
): Speakers {
  const sec = (s: Stretch): number => s.endSec - s.startSec
  // The longest reliable stretches are grouped.
  const reliable = stretches
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => prints[i] && sec(s) >= RELIABLE_SEC)
    .sort((a, b) => sec(b.s) - sec(a.s))
    .slice(0, MOST_GROUPED)
    .sort((a, b) => a.i - b.i)
  const label: (number | null)[] = stretches.map(() => null)
  const sure: number[] = stretches.map(() => 0)
  if (reliable.length === 0) {
    // Nothing long enough to tell voices apart: one speaker, if anyone was fingerprinted at all.
    prints.forEach((p, i) => p && (label[i] = 0))
  } else {
    const items: Voiced[] = reliable.map(({ s, i }) => ({ embedding: prints[i] as Float32Array, sec: sec(s) }))
    const groups = clusterVoices(items, opts)
    const centres = centroids(items, groups)
    reliable.forEach(({ i }, k) => {
      label[i] = groups[k]
      sure[i] = Infinity
    })
    // Everyone else is whoever they sound most like, with how much more like them than the next.
    stretches.forEach((_, i) => {
      const p = prints[i]
      if (label[i] !== null || !p) return
      const ranked = centres.map((c, k) => ({ k, s: nearest(p, [c]).similarity })).sort((a, b) => b.s - a.s)
      label[i] = ranked[0].k
      sure[i] = ranked.length > 1 ? ranked[0].s - ranked[1].s : Infinity
    })
  }
  // A short, unsure stretch between two of one speaker, close to both, is theirs; so is one never fingerprinted.
  for (let i = 0; i < stretches.length; i++) {
    if (sure[i] === Infinity && label[i] !== null) continue
    const before = stretches[i - 1]
    const after = stretches[i + 1]
    const near = (a: Stretch | undefined, b: Stretch | undefined): boolean => !!a && !!b && b.startSec - a.endSec < BREAK_GAP_SEC * 2
    const lb = i > 0 ? label[i - 1] : null
    const la = i + 1 < stretches.length ? label[i + 1] : null
    if (lb !== null && lb === la && near(before, stretches[i]) && near(stretches[i], after) && (label[i] === null || sure[i] < SURE_MARGIN))
      label[i] = lb
    else if (label[i] === null) label[i] = lb ?? la
  }
  // Nobody takes over for one piece in the middle of a sentence another is saying with no pause either side:
  // a piece of one unbroken run between two of the same run and the same speaker is theirs.
  for (let i = 1; i + 1 < stretches.length; i++) {
    const [a, b, c] = [stretches[i - 1], stretches[i], stretches[i + 1]]
    if (a.run === b.run && b.run === c.run && label[i - 1] === label[i + 1] && label[i - 1] !== null) label[i] = label[i - 1]
  }
  const byWord: (number | null)[] = words.map(() => null)
  stretches.forEach((s, i) => s.words.forEach((w) => (byWord[w] = label[i])))
  const count = Math.max(0, ...label.map((l) => (l === null ? -1 : l + 1)))
  const talkSec = Array.from({ length: count }, (_, k) =>
    stretches.reduce((t, s, i) => t + (label[i] === k ? sec(s) : 0), 0)
  )
  return { words: byWord, talkSec }
}
