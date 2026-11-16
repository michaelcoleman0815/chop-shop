import { z } from 'zod'

/**
 * The audio map: what the recording sounds like, word by word and stretch
 * by stretch, from the same 16 kHz mono stream the cut listens to.
 *
 * - Per word, its loudness and its pitch (autocorrelation f0), so stressed
 *   words stand out and takes can be compared on energy and pitch movement.
 * - Stretches of the recording as speech, music, laughter, applause, noise
 *   (a cough, a bump) or silence, so a laugh between takes reads as a break
 *   and music under a voice is known.
 *
 * Everything is measured, nothing is downloaded or sent anywhere, and the
 * classes are heuristics from four plain measures (loudness, how much it
 * varies, how periodic the sound is, how often it crosses zero), checked in
 * map.test.ts on synthetic sounds with known answers.
 */

export const SOUND_KINDS = ['speech', 'music', 'laughter', 'applause', 'noise', 'silence'] as const
export type SoundKind = (typeof SOUND_KINDS)[number]

export const AudioMapSchema = z.object({
  v: z.literal(1),
  /** Loudness in dBFS and pitch in Hz (null when unvoiced), by word id. */
  words: z.record(z.string(), z.tuple([z.number(), z.number().nullable()])),
  segments: z.array(z.object({ kind: z.enum(SOUND_KINDS), startSec: z.number(), endSec: z.number() })),
  /** Words said with stress: louder and higher than the words around them. */
  emphasis: z.array(z.string()),
  /** Room tone and typical speech, in dBFS. */
  level: z.object({ floor: z.number(), speech: z.number() })
})
export type AudioMap = z.infer<typeof AudioMapSchema>

/** Measures every 10 ms. */
export interface Frames {
  hopSec: number
  db: Float32Array
  /** Zero crossings per sample, 0 to 1: high for hiss, applause and fricatives. */
  zcr: Float32Array
  /** Pitch in Hz, 0 when unvoiced. */
  f0: Float32Array
  /** How periodic, 0 to 1: high for voices and notes, low for noise. */
  voicing: Float32Array
}

const RATE = 16000
const HOP = 160
/** Pitch is read at 8 kHz over 32 ms, between 70 and 420 Hz, every other frame. */
const DEC = 2
const WIN = 256
const MIN_LAG = Math.floor(RATE / DEC / 420)
const MAX_LAG = Math.ceil(RATE / DEC / 70)

/**
 * Builds the frame measures from samples as they stream in, so an hour of
 * audio never sits in memory: only the samples of the frame in progress
 * are kept between chunks.
 */
export class FrameBuilder {
  private db: number[] = []
  private zcr: number[] = []
  private f0: number[] = []
  private voicing: number[] = []
  private tail = new Float32Array(0)
  private readonly x = new Float32Array(WIN)
  private readonly energy = new Float64Array(WIN + 1)

  /** Frames quieter than this (dBFS) skip the pitch search. */
  constructor(private readonly threshold = -50) {}

  push(chunk: Float32Array): void {
    const data = new Float32Array(this.tail.length + chunk.length)
    data.set(this.tail)
    data.set(chunk, this.tail.length)
    // A frame needs a whole pitch window after its start.
    const need = WIN * DEC
    let i = 0
    for (; i + need <= data.length; i += HOP) this.frame(data, i, false)
    this.tail = data.slice(i)
  }

  finish(): Frames {
    const data = this.tail
    for (let i = 0; i + HOP <= data.length; i += HOP) this.frame(data, i, true)
    this.tail = new Float32Array(0)
    return {
      hopSec: HOP / RATE,
      db: Float32Array.from(this.db),
      zcr: Float32Array.from(this.zcr),
      f0: Float32Array.from(this.f0),
      voicing: Float32Array.from(this.voicing)
    }
  }

  private frame(data: Float32Array, at: number, short: boolean): void {
    let sum = 0
    let crossings = 0
    for (let k = at; k < at + HOP; k++) {
      sum += data[k] * data[k]
      if (k > at && data[k] >= 0 !== data[k - 1] >= 0) crossings++
    }
    const db = 10 * Math.log10(sum / HOP + 1e-12)
    const n = this.db.length
    this.db.push(db)
    this.zcr.push(crossings / HOP)
    if (short || db < this.threshold) {
      this.f0.push(0)
      this.voicing.push(0)
      return
    }
    // Every other frame borrows the pitch of the one before, when it had one.
    if (n % 2 === 1 && this.voicing[n - 1] > 0) {
      this.f0.push(this.f0[n - 1])
      this.voicing.push(this.voicing[n - 1])
      return
    }
    const { x, energy } = this
    let mean = 0
    for (let k = 0; k < WIN; k++) {
      x[k] = (data[at + k * DEC] + data[at + k * DEC + 1]) / 2
      mean += x[k]
    }
    mean /= WIN
    energy[0] = 0
    for (let k = 0; k < WIN; k++) {
      x[k] -= mean
      energy[k + 1] = energy[k] + x[k] * x[k]
    }
    // Normalised autocorrelation; the energies come from running sums.
    const corr = (lag: number): number => {
      let num = 0
      for (let k = 0; k + lag < WIN; k++) num += x[k] * x[k + lag]
      const e1 = energy[WIN - lag]
      const e2 = energy[WIN] - energy[lag]
      return num / Math.sqrt(e1 * e2 + 1e-12)
    }
    let best = 0
    let lagAt = 0
    for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
      const r = corr(lag)
      if (r > best) {
        best = r
        lagAt = lag
      }
    }
    // The fundamental, not a multiple of it: the shortest lag nearly as good.
    for (let div = 4; div >= 2 && lagAt > 0; div--) {
      const lag = Math.round(lagAt / div)
      if (lag >= MIN_LAG && corr(lag) >= best * 0.9) {
        lagAt = lag
        break
      }
    }
    this.f0.push(best >= 0.5 && lagAt > 0 ? RATE / DEC / lagAt : 0)
    this.voicing.push(Math.max(0, best))
  }
}

/** Frame measures of a whole buffer at 16 kHz: for tests and short clips. */
export function framesOf(samples: Float32Array, threshold = -50): Frames {
  const b = new FrameBuilder(threshold)
  b.push(samples)
  return b.finish()
}

interface Timed {
  id: string
  startSec: number
  endSec: number
}

const median = (v: number[]): number => {
  if (v.length === 0) return NaN
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const percentile = (v: ArrayLike<number>, p: number): number => {
  const s = Array.from(v)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] : -90
}

/** The map from frame measures and the transcript's words. */
export function buildAudioMap(frames: Frames, words: Timed[]): AudioMap {
  const n = frames.db.length
  const hop = frames.hopSec
  const floor = percentile(frames.db, 0.1)
  const loud = floor + Math.max(8, (percentile(frames.db, 0.9) - floor) / 3)
  const at = (sec: number): number => Math.max(0, Math.min(n - 1, Math.floor(sec / hop)))

  // Per word: its loudest stretch and its median pitch.
  const perWord: AudioMap['words'] = {}
  const levels: number[] = []
  for (const w of words) {
    const a = at(w.startSec)
    const b = Math.max(a + 1, at(w.endSec))
    const dbs: number[] = []
    const pitches: number[] = []
    for (let i = a; i < b; i++) {
      dbs.push(frames.db[i])
      if (frames.f0[i] > 0) pitches.push(frames.f0[i])
    }
    const top = percentile(dbs, 0.8)
    const f0 = pitches.length >= 2 ? median(pitches) : null
    perWord[w.id] = [Math.round(top * 10) / 10, f0 === null ? null : Math.round(f0)]
    if (top >= loud) levels.push(top)
  }
  const speech = levels.length ? median(levels) : percentile(frames.db, 0.9)

  // Stress: a word clearly louder and higher than its neighbours.
  const emphasis: string[] = []
  words.forEach((w, k) => {
    const [db, f0] = perWord[w.id]
    if (db < loud || w.endSec - w.startSec < 0.12) return
    const near = words.slice(Math.max(0, k - 4), k + 5).filter((x) => x.id !== w.id)
    const dbs = near.map((x) => perWord[x.id][0]).filter((v) => v >= loud)
    const f0s = near.map((x) => perWord[x.id][1]).filter((v): v is number => v !== null)
    if (dbs.length < 2) return
    const louder = db - median(dbs) >= 4
    const higher = f0 !== null && f0s.length >= 2 && f0 / median(f0s) >= 1.12
    if (louder && (higher || db - median(dbs) >= 6)) emphasis.push(w.id)
  })

  // Stretches: runs of sound, joined across gaps under 0.3 s, each judged
  // as a whole so its edges sit on its own frames; long runs are judged two
  // seconds at a time, since music can start under a voice.
  const covered = new Uint8Array(n)
  for (const w of words) for (let i = at(w.startSec); i <= at(w.endSec); i++) covered[i] = 1
  const gapFrames = Math.round(0.3 / hop)
  const runs: [number, number][] = []
  let runStart = -1
  let lastLoud = -1
  for (let i = 0; i < n; i++) {
    if (frames.db[i] < loud) continue
    if (runStart < 0) runStart = i
    else if (i - lastLoud > gapFrames) {
      runs.push([runStart, lastLoud + 1])
      runStart = i
    }
    lastLoud = i
  }
  if (runStart >= 0) runs.push([runStart, lastLoud + 1])

  const judge = (a: number, b: number): SoundKind => {
    let loudCount = 0
    let wordCount = 0
    let voiced = 0
    let z = 0
    const dbs: number[] = []
    for (let i = a; i < b; i++) {
      if (frames.db[i] < loud) continue
      loudCount++
      wordCount += covered[i]
      voiced += frames.voicing[i]
      z += frames.zcr[i]
      dbs.push(frames.db[i])
    }
    if (loudCount === 0) return 'silence'
    if (wordCount / loudCount >= 0.5) return 'speech'
    const v = voiced / loudCount
    const zc = z / loudCount
    const spread = percentile(dbs, 0.9) - percentile(dbs, 0.1)
    const fill = loudCount / (b - a)
    const sec = (b - a) * hop
    if (v < 0.35 && zc >= 0.2) return sec >= 1 ? 'applause' : 'noise'
    if (v >= 0.5 && spread < 8 && fill >= 0.8) return sec >= 1.5 ? 'music' : 'noise'
    if (v >= 0.4 && fill < 0.8) return sec <= 6 ? 'laughter' : 'music'
    return 'noise'
  }
  const pieces: AudioMap['segments'] = []
  const piece = (kind: SoundKind, a: number, b: number): void => {
    const startSec = Math.round(a * hop * 100) / 100
    const endSec = Math.round(b * hop * 100) / 100
    const last = pieces[pieces.length - 1]
    if (last && last.kind === kind && startSec - last.endSec < 0.31) last.endSec = endSec
    else pieces.push({ kind, startSec, endSec })
  }
  const step = Math.round(2 / hop)
  const judgeSpan = (a: number, b: number): void => {
    if (b - a <= 2 * step) piece(judge(a, b), a, b)
    else for (let k = a; k < b; k += step) piece(judge(k, Math.min(b, k + step)), k, Math.min(b, k + step))
  }
  // Within a run, speech is where the words are; sound right before or after
  // them that no word covers for 0.4 s or more is judged on its own.
  const alone = Math.round(0.4 / hop)
  for (const [a, b] of runs) {
    let spoken = false
    for (let i = a; i < b && !spoken; i++) spoken = covered[i] === 1
    if (!spoken) {
      judgeSpan(a, b)
      continue
    }
    let k = a
    while (k < b) {
      let e = k
      while (e < b && covered[e] === covered[k]) e++
      // The short gaps between words, and breath at their edges, are speech.
      if (covered[k] || e - k < alone) piece('speech', k, e)
      else judgeSpan(k, e)
      k = e
    }
  }
  // The quiet between runs.
  const joined: AudioMap['segments'] = []
  let cursor = 0
  for (const p of pieces) {
    if (p.startSec - cursor >= 0.3) joined.push({ kind: 'silence', startSec: cursor, endSec: p.startSec })
    joined.push(p)
    cursor = p.endSec
  }
  const total = Math.round(n * hop * 100) / 100
  if (total - cursor >= 0.3) joined.push({ kind: 'silence', startSec: cursor, endSec: total })

  return {
    v: 1,
    words: perWord,
    segments: joined,
    emphasis,
    level: { floor: Math.round(floor * 10) / 10, speech: Math.round(speech * 10) / 10 }
  }
}

/** What takes needs from the map: per-word sound, and the sounds between words. */
export function takeAudioOf(map: AudioMap): {
  words: Record<string, [number, number | null]>
  unworded: { startSec: number; endSec: number; kind: string }[]
} {
  return {
    words: map.words,
    unworded: map.segments
      .filter((s) => s.kind === 'laughter' || s.kind === 'noise' || s.kind === 'applause')
      .map((s) => ({ startSec: s.startSec, endSec: s.endSec, kind: s.kind === 'laughter' ? 'laugh' : s.kind }))
  }
}

const clockOf = (sec: number): string => {
  const t = Math.max(0, Math.round(sec))
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/**
 * The map as a few lines for the planner: the stretches that are not speech
 * or silence, and the stressed words. Short on purpose: a few dozen tokens.
 */
export function renderSound(map: AudioMap, text: (id: string) => string): string {
  const notable = map.segments.filter(
    (s) => s.kind !== 'speech' && s.kind !== 'silence' && s.endSec - s.startSec >= 0.3
  )
  const parts: string[] = []
  if (notable.length) {
    parts.push(
      notable
        .slice(0, 24)
        .map((s) => `${s.kind} ${clockOf(s.startSec)}-${clockOf(s.endSec)}`)
        .join('; ')
    )
  }
  if (map.emphasis.length)
    parts.push(
      `stressed: ${map.emphasis
        .slice(0, 24)
        .map((id) => `${id} "${text(id)}"`)
        .join(', ')}`
    )
  if (parts.length === 0) return ''
  return `<sound>\n${parts.join('\n')}\n</sound>`
}
