import type { Cut } from '../edit/schema'
import type { Resolved } from '../edit/resolve'
import { seconds, type StyleSpec } from '../presets/preset'

/**
 * A video someone likes, turned into plain facts and a style.
 *
 * Only the pattern is taken: how often the shot changes, how fast it opens,
 * how much is black and white, how loud, how quickly the person talks. The
 * video's footage, audio and likeness are never used in an edit.
 */

/** What the picture and sound measure as. Produced by main/inspiration. */
export interface VideoMeasures {
  durationSec: number
  /** The span actually measured; long videos are measured from the start. */
  measuredSec: number
  width: number
  height: number
  hasAudio: boolean
  /** Times where the shot changes. */
  cuts: number[]
  /** Share of sampled frames with no colour, black frames excluded. Null when nothing was sampled. */
  bwShare: number | null
  /** Integrated loudness. Null without audio. */
  loudnessLufs: number | null
}

export interface SpeechMeasures {
  words: number
  wordsPerMinute: number
  /** How long the longer pauses run: the 90th percentile of the gaps between words. */
  pauseP90Sec: number
  longestPauseSec: number
  firstWordSec: number
}

export interface InspirationFacts {
  durationSec: number
  aspect: 'vertical' | 'square' | 'wide'
  shots: number
  /** Median shot length. The median, because one long closing shot drags a mean. */
  secondsPerShot: number
  cutsPerMinute: number
  firstCutSec: number | null
  cutsInFirst3s: number
  bwShare: number
  loudnessLufs: number | null
  speech: SpeechMeasures | null
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}

export function measureSpeech(words: { startSec: number; endSec: number }[]): SpeechMeasures | null {
  if (words.length < 5) return null
  const sorted = [...words].sort((a, b) => a.startSec - b.startSec)
  const span = sorted[sorted.length - 1].endSec - sorted[0].startSec
  if (span <= 0) return null
  const gaps = sorted.slice(1).map((w, i) => Math.max(0, w.startSec - sorted[i].endSec))
  return {
    words: sorted.length,
    wordsPerMinute: sorted.length / (span / 60),
    pauseP90Sec: percentile(gaps, 0.9),
    longestPauseSec: gaps.length ? Math.max(...gaps) : 0,
    firstWordSec: sorted[0].startSec
  }
}

export function aspectOf(width: number, height: number): InspirationFacts['aspect'] {
  if (width <= 0 || height <= 0) return 'wide'
  const r = height / width
  return r > 1.2 ? 'vertical' : r < 0.83 ? 'wide' : 'square'
}

export function summarize(m: VideoMeasures, speech: SpeechMeasures | null = null): InspirationFacts {
  const span = Math.max(0.1, Math.min(m.measuredSec || m.durationSec, m.durationSec || m.measuredSec))
  const cuts = [...new Set(m.cuts)].filter((c) => c > 0.1 && c < span - 0.1).sort((a, b) => a - b)
  const edges = [0, ...cuts, span]
  const lengths = edges.slice(1).map((t, i) => t - edges[i])
  return {
    durationSec: m.durationSec,
    aspect: aspectOf(m.width, m.height),
    shots: lengths.length,
    secondsPerShot: median(lengths),
    cutsPerMinute: cuts.length / (span / 60),
    firstCutSec: cuts[0] ?? null,
    cutsInFirst3s: cuts.filter((c) => c < 3).length,
    bwShare: m.bwShare ?? 0,
    loudnessLufs: m.loudnessLufs,
    speech
  }
}

/** Rounds to a step without float noise: 0.6, not 0.6000000000000001. */
const round = (v: number, step: number): number => {
  const places = Math.max(0, -Math.floor(Math.log10(step)))
  return Number((Math.round(v / step) * step).toFixed(places))
}
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * The style a video measures as. Captions are not here: they cannot be read
 * from numbers, and a guess presented as a measurement would be worse than
 * leaving them as they are.
 */
export function styleFromFacts(f: InspirationFacts): StyleSpec {
  const style: StyleSpec = { aspect: f.aspect === 'square' ? 'square' : f.aspect }
  if (f.shots > 1) {
    style.pace = { secondsPerShot: clamp(round(f.secondsPerShot, 0.1), 0.6, 12) }
    // A single camera only reaches a fast pace by punching in between shots.
    if (f.secondsPerShot < 4) style.punchIn = { scale: 1.12 }
  }
  if (f.firstCutSec !== null && f.firstCutSec < 3) {
    const short = f.durationSec <= 90
    style.hook = { firstCutSec: clamp(round(f.firstCutSec, 0.1), 0.3, 3), strongestFirst: short && f.firstCutSec <= 1.5 }
  }
  if (f.bwShare >= 0.1) style.bw = { share: round(f.bwShare, 0.01) }
  if (f.loudnessLufs !== null && Number.isFinite(f.loudnessLufs)) {
    style.loudness = { lufs: clamp(Math.round(f.loudnessLufs), -24, -9) }
  }
  if (f.speech) {
    style.tighten = { maxGapSec: clamp(round(f.speech.pauseP90Sec, 0.05), 0.15, 0.8), padSec: 0.06, fillers: true }
  }
  if (f.aspect === 'vertical' && f.durationSec <= 61) style.maxLengthSec = 60
  else if (f.aspect === 'vertical' && f.durationSec <= 91) style.maxLengthSec = 90
  return style
}

function fractionWords(share: number): string {
  if (share < 0.15) return 'now and then'
  if (share < 0.3) return 'about a quarter of the time'
  if (share < 0.42) return 'about a third of the time'
  if (share < 0.6) return 'about half the time'
  if (share < 0.8) return 'most of the time'
  return 'nearly all the time'
}

function list(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

/**
 * What was understood, as one plain sentence: the reply in the thread. The
 * numbers behind each clause are in factDetails, one tap away.
 */
export function factsReply(f: InspirationFacts): string {
  const said: string[] = []
  if (f.firstCutSec !== null && f.firstCutSec <= 1.2) {
    said.push(f.cutsInFirst3s >= 3 ? `opens fast, with ${f.cutsInFirst3s} cuts in the first three seconds` : 'opens fast')
  } else if (f.shots > 1 && (f.firstCutSec === null || f.firstCutSec > 5)) {
    said.push(`holds its first shot for ${seconds(f.firstCutSec ?? f.durationSec)}`)
  }
  said.push(f.shots <= 1 ? 'stays on one shot the whole way' : `changes shot about every ${seconds(f.secondsPerShot)}`)
  if (f.bwShare >= 0.1) said.push(`goes black and white ${fractionWords(f.bwShare)}`)
  if (f.speech) {
    const wpm = Math.round(f.speech.wordsPerMinute / 5) * 5
    if (f.speech.wordsPerMinute >= 175) said.push(`talks fast, about ${wpm} words a minute`)
    else if (f.speech.wordsPerMinute <= 120) said.push(`talks slowly, about ${wpm} words a minute`)
    if (f.speech.pauseP90Sec <= 0.25) said.push('leaves almost no pauses')
  }
  return `Got it. It ${list(said)}.`
}

/** Every measurement, for Details. */
export function factDetails(f: InspirationFacts): { label: string; value: string }[] {
  const rows = [
    { label: 'Length', value: seconds(f.durationSec) },
    { label: 'Shape', value: f.aspect === 'vertical' ? 'Vertical' : f.aspect === 'square' ? 'Square' : 'Wide' },
    { label: 'Shots', value: String(f.shots) },
    { label: 'Per shot', value: seconds(f.secondsPerShot) },
    { label: 'Cuts a minute', value: String(Math.round(f.cutsPerMinute)) },
    { label: 'First cut', value: f.firstCutSec === null ? 'None' : seconds(f.firstCutSec) },
    { label: 'Black and white', value: `${Math.round(f.bwShare * 100)}%` },
    { label: 'Loudness', value: f.loudnessLufs === null ? 'No audio' : `${Math.round(f.loudnessLufs)} LUFS` }
  ]
  if (f.speech) {
    rows.push(
      { label: 'Words a minute', value: String(Math.round(f.speech.wordsPerMinute)) },
      { label: 'Longer pauses', value: seconds(f.speech.pauseP90Sec) }
    )
  }
  return rows
}

/** The same shape measures, taken from a cut instead of a video. */
export interface CutShape {
  durationSec: number
  /** Output times where something visibly changes. */
  changes: number[]
  secondsPerShot: number
  firstCutSec: number | null
  bwShare: number
}

/**
 * Where a cut visibly changes: a jump in the source, another recording, or a
 * change of treatment. A beat boundary in continuous speech with nothing else
 * changing is invisible, and is not counted as a shot.
 */
export function cutShape(cut: Cut, resolved: Resolved): CutShape {
  const byId = new Map(cut.beats.map((b) => [b.id, b]))
  const look = (beatId: string): string => {
    const t = byId.get(beatId)?.treatment
    return t ? `${t.frame}|${t.bw}|${t.zoom.toFixed(3)}|${t.broll?.path ?? ''}` : ''
  }
  const changes: number[] = []
  let bw = 0
  resolved.pieces.forEach((p, i) => {
    if (byId.get(p.beat)?.treatment.bw) bw += p.outEnd - p.outStart
    const prev = resolved.pieces[i - 1]
    if (!prev) return
    const jump = prev.source !== p.source || Math.abs(prev.srcEnd - p.srcStart) > 0.04
    if (jump || look(prev.beat) !== look(p.beat)) changes.push(p.outStart)
  })
  const edges = [0, ...changes, resolved.durationSec]
  const lengths = edges.slice(1).map((t, i) => t - edges[i]).filter((l) => l > 0)
  return {
    durationSec: resolved.durationSec,
    changes,
    secondsPerShot: median(lengths),
    firstCutSec: changes[0] ?? null,
    bwShare: resolved.durationSec > 0 ? bw / resolved.durationSec : 0
  }
}

/** How close a ratio is to 1, from 1 (equal) toward 0. */
const closeness = (a: number, b: number, k = 1): number =>
  a > 0 && b > 0 ? Math.exp(-k * Math.abs(Math.log(a / b))) : a === b ? 1 : 0

/**
 * How alike a cut is to the video it was styled on, from 0 to 1, over what
 * both can be measured on: pace, how fast it opens, and black and white. The
 * parts are in likenessParts so Details can show where the gap is.
 */
export function likenessParts(ref: InspirationFacts, shape: CutShape): { label: string; score: number; weight: number }[] {
  const parts: { label: string; score: number; weight: number }[] = []
  if (ref.shots > 1) parts.push({ label: 'Pace', score: closeness(shape.secondsPerShot, ref.secondsPerShot, 1.2), weight: 0.5 })
  if (ref.firstCutSec !== null) {
    const opens = shape.firstCutSec ?? shape.durationSec
    parts.push({ label: 'Opening', score: closeness(Math.max(opens, 0.3), Math.max(ref.firstCutSec, 0.3)), weight: 0.25 })
  }
  if (ref.bwShare >= 0.1 || shape.bwShare >= 0.1) {
    parts.push({ label: 'Black and white', score: 1 - Math.min(1, Math.abs(shape.bwShare - ref.bwShare) * 1.5), weight: 0.25 })
  }
  return parts
}

export function likeness(ref: InspirationFacts, shape: CutShape): number {
  const parts = likenessParts(ref, shape)
  const weight = parts.reduce((s, p) => s + p.weight, 0)
  if (weight === 0) return 1
  return Math.round((parts.reduce((s, p) => s + p.score * p.weight, 0) / weight) * 100) / 100
}

/** Everything the thread needs to answer a pasted video. */
export interface InspirationStudy {
  source: { url: string | null; path: string; title: string | null; durationSec: number }
  facts: InspirationFacts
  style: StyleSpec
  /** The reply, one plain sentence. */
  reply: string
  /** Up to three facts shown under the reply. */
  chips: string[]
  /** Every measurement, behind Details. */
  details: { label: string; value: string }[]
  /** A free command name to save the style under, without the slash. */
  command: string
  /** Set when part of the study could not run, in a sentence. */
  note: string | null
}
