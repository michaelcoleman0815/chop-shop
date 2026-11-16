import { levels, type Envelope } from '../audio/snap'
import { FACE_DESC, MOUTH_DESC, type RawMouth, type RawSlot } from './meter'

/**
 * From raw per-frame measurements to one mouth series: how much the watched
 * mouth is moving at each frame, in units of that face's own talking, with
 * the frames where it cannot be read marked as such.
 *
 * Every face is normalised against itself. The head's own movement is taken
 * out using the upper face: a nod moves both, talking moves the mouth. A
 * face counts only if its mouth is seen to move with the voice; a covered
 * mouth, a turned head, a dark or tiny face, and frames across a camera cut
 * are all left unread rather than guessed at.
 */

/** Voice activity on the audio's clock, 100 times a second. */
export interface Voice {
  hopSec: number
  on: Uint8Array
  /** Running count of voiced hops, for quick shares over any stretch. */
  prefix: Uint32Array
}

export function voiceFromEnvelope(env: Envelope): Voice {
  const n = env.db.length
  const on = new Uint8Array(n)
  if (n > 0) {
    const { threshold } = levels(env)
    for (let i = 0; i < n; i++) on[i] = env.db[i] >= threshold ? 1 : 0
    // Close gaps shorter than 80 ms, then drop blips shorter than 40 ms.
    const fill = (value: 0 | 1, maxRun: number): void => {
      let i = 0
      while (i < n) {
        if (on[i] === value) {
          i++
          continue
        }
        let j = i
        while (j < n && on[j] !== value) j++
        if (i > 0 && j < n && j - i <= maxRun) on.fill(value, i, j)
        i = j
      }
    }
    fill(1, Math.round(0.08 / env.hopSec))
    fill(0, Math.round(0.04 / env.hopSec))
  }
  const prefix = new Uint32Array(n + 1)
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + on[i]
  return { hopSec: env.hopSec, on, prefix }
}

/** Share of [from, to] that is voiced, 0 to 1. */
export function voicedShare(voice: Voice, from: number, to: number): number {
  const n = voice.on.length
  const a = Math.max(0, Math.min(n, Math.floor(from / voice.hopSec)))
  const b = Math.max(0, Math.min(n, Math.ceil(to / voice.hopSec)))
  return b > a ? (voice.prefix[b] - voice.prefix[a]) / (b - a) : 0
}

export interface TrackSummary {
  id: number
  slot: number
  /** True when this face's mouth was seen to move with the voice. */
  usable: boolean
  /** Why not, when it is not. */
  why: string | null
  /** Typical face width in source pixels, and as a share of the frame's width. */
  widthPx: number
  widthShare: number
  /** Seconds on screen, and seconds of that with a readable mouth. */
  seconds: number
  readableSec: number
  /** How much more the mouth moves with the voice than without it. */
  response: number
}

export interface MouthSeries {
  fps: number
  /** Source frame size in pixels. */
  width: number
  height: number
  /** Each frame's time in source seconds (the picture's clock). */
  times: Float64Array
  /**
   * How much the watched mouth moved into each frame, beyond what the head
   * did: 0 is still, 1 is this face's typical talking. NaN where it cannot be
   * read: no face, a covered mouth, a turned head, too dark, a camera cut.
   */
  talk: Float32Array
  /**
   * How open the watched mouth is: 0 at rest, 1 as open as it typically is
   * while talking. From the mouth's thumbnails (the way they vary most while
   * talking is opening and closing). NaN where it cannot be read. This is
   * what is lined up with the voice.
   */
  open: Float32Array
  /** The face track watched at each frame, -1 for none. */
  track: Int16Array
  /** How far the head moved into each frame, in face widths. */
  head: Float32Array
  /** 0 to 1: how far the watched face is from how it usually looks (turned away, looking down). */
  away: Float32Array
  /** Faces on screen at each frame. */
  faces: Uint8Array
  /** The watched face's centre (0 to 1) and width as a share of the frame's, NaN with no face. */
  x: Float32Array
  y: Float32Array
  size: Float32Array
  tracks: TrackSummary[]
}

export interface SeriesOptions {
  /** Darker faces than this (0 to 255) are not read: noise outweighs motion. */
  minLum: number
  /** Flatter faces than this (spread of brightness) are not read. */
  minContrast: number
  /** Faces narrower than this in source pixels are not read. */
  minFacePx: number
  /** A face must move its mouth this many times more with the voice than without it. */
  minResponse: number
  /** Seconds of voice with a readable mouth needed before a face counts. */
  minVoicedSec: number
  /**
   * The voice is on the picture's clock (the offset is known), so silence and
   * speech can be told apart frame by frame. Otherwise only stretches that
   * hold whatever the offset count.
   */
  aligned: boolean
}

export const DEFAULT_SERIES: SeriesOptions = {
  minLum: 32,
  minContrast: 4,
  minFacePx: 40,
  minResponse: 2.5,
  minVoicedSec: 1.5,
  aligned: false
}

function quantile(values: ArrayLike<number>, p: number): number {
  const v = Array.from(values).filter((x) => Number.isFinite(x))
  if (v.length === 0) return NaN
  v.sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))]
}

const median3 = (a: number, b: number, c: number): number =>
  a > b ? (b > c ? b : a > c ? c : a) : a > c ? a : b > c ? c : b

/** Zero-mean distance between two block descriptors, in grey levels. */
function descDistance(d: Uint8Array, at: number, ref: Float32Array): number {
  let m = 0
  for (let i = 0; i < ref.length; i++) m += d[at + i]
  m /= ref.length
  let s = 0
  for (let i = 0; i < ref.length; i++) s += Math.abs(d[at + i] - m - ref[i])
  return s / ref.length
}

/** How much structure a descriptor has: the spread of its block means. */
function descSpread(d: Uint8Array, at: number, size: number): number {
  let m = 0
  for (let i = 0; i < size; i++) m += d[at + i]
  m /= size
  let s = 0
  for (let i = 0; i < size; i++) s += (d[at + i] - m) ** 2
  return Math.sqrt(s / size)
}

/** The per-block median of zero-mean descriptors over chosen frames. */
function template(d: Uint8Array, size: number, frames: number[]): Float32Array {
  const ref = new Float32Array(size)
  if (frames.length === 0) return ref
  const cols: number[][] = Array.from({ length: size }, () => [])
  for (const i of frames) {
    let m = 0
    for (let k = 0; k < size; k++) m += d[i * size + k]
    m /= size
    for (let k = 0; k < size; k++) cols[k].push(d[i * size + k] - m)
  }
  for (let k = 0; k < size; k++) ref[k] = quantile(cols[k], 0.5)
  return ref
}

/**
 * How open the mouth is, frame by frame: the main way its thumbnail varies
 * (fitted on `fit`, frames with the head still), measured on `frames`, with
 * slow drift taken out over two seconds and scaled to its spread. The sign
 * is left to whoever compares it with the voice.
 */
function openness(slot: RawSlot, fit: number[], frames: number[], times: Float64Array): Map<number, number> {
  const D = MOUTH_DESC.w * MOUTH_DESC.h
  const out = new Map<number, number>()
  if (fit.length < 10) return out
  const centred = (i: number, v: Float64Array): void => {
    let m = 0
    for (let k = 0; k < D; k++) m += slot.mouthDesc[i * D + k]
    m /= D
    for (let k = 0; k < D; k++) v[k] = slot.mouthDesc[i * D + k] - m
  }
  const mean = new Float64Array(D)
  const v = new Float64Array(D)
  for (const i of fit) {
    centred(i, v)
    for (let k = 0; k < D; k++) mean[k] += v[k] / fit.length
  }
  const cov = new Float64Array(D * D)
  for (const i of fit) {
    centred(i, v)
    for (let a = 0; a < D; a++) {
      const da = v[a] - mean[a]
      for (let b = 0; b < D; b++) cov[a * D + b] += da * (v[b] - mean[b])
    }
  }
  // The first principal component, by power iteration.
  let pc = new Float64Array(D).fill(1 / Math.sqrt(D))
  for (let it = 0; it < 50; it++) {
    const next = new Float64Array(D)
    for (let a = 0; a < D; a++) for (let b = 0; b < D; b++) next[a] += cov[a * D + b] * pc[b]
    const norm = Math.hypot(...next)
    if (!(norm > 0)) return out
    pc = next.map((x) => x / norm)
  }
  const raw: number[] = []
  for (const i of frames) {
    centred(i, v)
    let p = 0
    for (let k = 0; k < D; k++) p += (v[k] - mean[k]) * pc[k]
    raw.push(p)
  }
  // Take out drift (a face box sliding a little) with a four-second running mean.
  const detrended: number[] = []
  let lo = 0
  let hi = 0
  let sum = 0
  for (let k = 0; k < frames.length; k++) {
    while (hi < frames.length && times[frames[hi]] <= times[frames[k]] + 2) sum += raw[hi++]
    while (times[frames[lo]] < times[frames[k]] - 2) sum -= raw[lo++]
    detrended.push(raw[k] - sum / (hi - lo))
  }
  const spread = Math.sqrt(detrended.reduce((s2, x) => s2 + x * x, 0) / Math.max(1, detrended.length))
  if (!(spread > 0)) return out
  frames.forEach((i, k) => out.set(i, detrended[k] / spread))
  return out
}

interface TrackRead {
  summary: TrackSummary
  slot: RawSlot
  frames: number[]
  talk: Map<number, number>
  open: Map<number, number>
  head: Map<number, number>
  away: Map<number, number>
}

function readTrack(
  raw: RawMouth,
  slot: RawSlot,
  slotIndex: number,
  id: number,
  frames: number[],
  voice: Voice | null,
  cut: (i: number) => boolean,
  opts: SeriesOptions
): TrackRead {
  const { times, fps } = raw
  const widthPx = quantile(
    frames.map((i) => slot.faceW[i]),
    0.5
  )
  const summary: TrackSummary = {
    id,
    slot: slotIndex,
    usable: false,
    why: null,
    widthPx,
    widthShare: widthPx / Math.max(1, raw.width),
    seconds: frames.length / fps,
    readableSec: 0,
    response: 0
  }
  const result: TrackRead = {
    summary,
    slot,
    frames,
    talk: new Map(),
    open: new Map(),
    head: new Map(),
    away: new Map()
  }
  const share = (i: number, half: number): number =>
    voice ? voicedShare(voice, times[i] - half, times[i] + half) : NaN
  // With the offset unknown, deep silence and being near the voice both hold
  // whatever it is (up to the 0.4 s the search covers). Once it is known,
  // the gaps between words count as silence and the words as speech.
  const silent = (i: number): boolean => share(i, opts.aligned ? 0.1 : 0.45) === 0
  const voiced = (i: number): boolean => (opts.aligned ? share(i, 0.05) >= 0.5 : share(i, 0.45) >= 0.25)

  // Pose: how different the face looks from its usual self.
  const faceSize = FACE_DESC.w * FACE_DESC.h
  const seen = frames.filter((i) => Number.isFinite(slot.lum[i]))
  const faceRef = template(slot.faceDesc, faceSize, seen)
  const faceDist = new Map(seen.map((i) => [i, descDistance(slot.faceDesc, i * faceSize, faceRef)]))
  const fd = [...faceDist.values()]
  const fdMed = quantile(fd, 0.5)
  const fdMad = quantile(
    fd.map((v) => Math.abs(v - fdMed)),
    0.5
  )
  for (const [i, d] of faceDist) result.away.set(i, Math.max(0, Math.min(1, (d - fdMed) / (6 * fdMad + 6))))
  for (const i of frames) {
    const fw = slot.faceW[i] * slot.scale
    result.head.set(i, Number.isFinite(slot.shift[i]) && fw > 0 ? slot.shift[i] / fw : NaN)
  }

  if (widthPx < opts.minFacePx) {
    summary.why = 'too small'
    return result
  }

  // Frames whose mouth can be read at all.
  const lumMed = quantile(
    seen.map((i) => slot.lum[i]),
    0.5
  )
  const conMed = quantile(
    seen.map((i) => slot.con[i]),
    0.5
  )
  if (!(lumMed >= opts.minLum) || !(conMed >= opts.minContrast)) {
    summary.why = 'too dark'
    return result
  }
  const readable = frames.filter(
    (i) =>
      Number.isFinite(slot.mouth[i]) &&
      Number.isFinite(slot.nose[i]) &&
      slot.lum[i] >= opts.minLum &&
      slot.con[i] >= opts.minContrast &&
      slot.faceW[i] >= opts.minFacePx &&
      slot.shift[i] < 2.4 &&
      !cut(i) &&
      (result.away.get(i) ?? 1) < 0.85
  )

  // A covered mouth either loses its structure (a hand flattens the lips
  // away) or looks unlike itself at rest or talking (a microphone in front).
  const mouthSize = MOUTH_DESC.w * MOUTH_DESC.h
  const restFrames = voice ? readable.filter(silent) : readable
  const restSet = restFrames.length >= 10 ? restFrames : readable
  const mouthRef = template(slot.mouthDesc, mouthSize, restSet)
  const md = new Map(readable.map((i) => [i, descDistance(slot.mouthDesc, i * mouthSize, mouthRef)]))
  const mdTypical = quantile([...md.values()], 0.75)
  const structure = new Map(readable.map((i) => [i, descSpread(slot.mouthDesc, i * mouthSize, mouthSize)]))
  const restStructure = quantile(
    restSet.map((i) => structure.get(i) ?? 0),
    0.5
  )
  const covered = (i: number): boolean =>
    (md.get(i) ?? 0) > Math.max(22, 2.5 * mdTypical) || (structure.get(i) ?? 0) < 0.45 * restStructure
  const usable = readable.filter((i) => !covered(i))
  if (usable.length < fps) {
    summary.why = 'not seen long enough'
    return result
  }

  // Levels at rest, the head's share of the mouth's change, then the rest is talking.
  const quiet = voice ? usable.filter(silent) : []
  const base = quiet.length >= fps * 0.5 ? quiet : usable
  // The nose moves with the head, but not with a blink or a word.
  const ref = slot.nose
  const u0 = quantile(
    base.map((i) => ref[i]),
    quiet.length >= fps * 0.5 ? 0.5 : 0.3
  )
  const stillHead = base.filter((i) => ref[i] <= u0 * 1.25)
  const m0 = quantile(
    (stillHead.length >= 10 ? stillHead : base).map((i) => slot.mouth[i]),
    quiet.length >= fps * 0.5 ? 0.5 : 0.2
  )
  const at = new Map(usable.map((i) => [i, true]))
  const upperNear = (i: number): number => {
    let u = ref[i]
    for (const j of [i - 1, i + 1]) if (at.has(j) && ref[j] > u) u = ref[j]
    return u
  }
  const moving = base.filter((i) => upperNear(i) > u0 + Math.max(0.4, 0.4 * u0))
  let k = 2.5
  if (quiet.length >= fps * 0.5 && moving.length >= 8) {
    const ratios = moving.map((i) => Math.max(0, slot.mouth[i] - m0) / (upperNear(i) - u0))
    k = Math.max(1, Math.min(4, quantile(ratios, 0.9)))
  }
  const rawTalk = new Map<number, number>()
  for (const i of usable) rawTalk.set(i, Math.max(0, slot.mouth[i] - m0 - k * Math.max(0, upperNear(i) - u0)))
  // A three-frame median: one odd frame (a keyframe, a flicker) is not talking.
  const filtered = new Map<number, number>()
  for (const i of usable) {
    const a = rawTalk.get(i - 1) ?? rawTalk.get(i) ?? 0
    const b = rawTalk.get(i) ?? 0
    const c = rawTalk.get(i + 1) ?? rawTalk.get(i) ?? 0
    filtered.set(i, median3(a, b, c))
  }

  const talking = voice ? usable.filter(voiced) : []
  // Near the voice the mouth is moving much of the time, so its typical
  // talking sits high in the spread there.
  const speak =
    talking.length >= fps * 0.6
      ? quantile(
          talking.map((i) => filtered.get(i) ?? 0),
          0.8
        )
      : quantile([...filtered.values()], 0.9)
  const noise = quantile(
    (stillHead.length >= 10 ? stillHead : base).map((i) => Math.abs(slot.mouth[i] - m0)),
    0.5
  )
  summary.readableSec = usable.length / fps
  if (!(speak > Math.max(0.8, 4 * noise))) {
    summary.why = 'mouth does not move'
    return result
  }
  for (const [i, v] of filtered) result.talk.set(i, v / speak)
  const steady = usable.filter((i) => ref[i] <= u0 + Math.max(0.4, 0.4 * u0))
  const open = openness(slot, steady.length >= fps * 2 ? steady : usable, usable, times)
  // Which way is open: the way that goes with the voice. Then 0 at rest and 1 typically open.
  if (voice && open.size > 0) {
    const near = (i: number): number => share(i, opts.aligned ? 0.05 : 0.3)
    const xs = [...open.keys()]
    const mx = xs.reduce((a, i) => a + (open.get(i) ?? 0), 0) / xs.length
    const my = xs.reduce((a, i) => a + near(i), 0) / xs.length
    const cov = xs.reduce((a, i) => a + ((open.get(i) ?? 0) - mx) * (near(i) - my), 0)
    const sign = cov < 0 ? -1 : 1
    const oriented = (i: number): number => sign * (open.get(i) ?? 0)
    const rest = quantile(
      (quiet.length >= fps * 0.5 ? quiet : usable).map(oriented),
      quiet.length >= fps * 0.5 ? 0.5 : 0.2
    )
    const wide = quantile((talking.length >= fps * 0.6 ? talking : usable).map(oriented), 0.8)
    const span = wide - rest > 1e-6 ? wide - rest : 1
    for (const i of xs) result.open.set(i, (oriented(i) - rest) / span)
  } else for (const [i, v] of open) result.open.set(i, v)

  if (voice) {
    const voicedSec = talking.length / fps
    const mean = (xs: number[]): number =>
      xs.reduce((s, i) => s + (result.talk.get(i) ?? 0), 0) / Math.max(1, xs.length)
    const response = quiet.length >= fps * 0.5 ? mean(talking) / Math.max(0.05, mean(quiet)) : Infinity
    summary.response = Number.isFinite(response) ? response : 0
    if (voicedSec < opts.minVoicedSec) {
      summary.why = 'too little speech seen'
      return result
    }
    if (response < opts.minResponse) {
      summary.why = 'mouth does not move with the voice'
      return result
    }
  }
  summary.usable = true
  return result
}

/**
 * The mouth series for a recording. `envelope` is the sound on its own
 * clock; it is only used to learn each face's levels and whether its mouth
 * goes with the voice, which holds even if sound and picture are a few
 * hundred milliseconds apart.
 */
export function mouthSeries(
  raw: RawMouth,
  envelope: Envelope | null,
  opts: SeriesOptions = DEFAULT_SERIES
): MouthSeries {
  const n = raw.times.length
  const voice = envelope && envelope.db.length > 0 ? voiceFromEnvelope(envelope) : null
  const g = quantile(raw.global, 0.5)
  const cutAt = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (raw.global[i] > Math.max(14, 8 * g)) cutAt[i] = 1
  // A camera cut spoils the frame it lands on and the one after.
  const cut = (i: number): boolean => cutAt[i] === 1 || (i > 0 && cutAt[i - 1] === 1)

  const reads: TrackRead[] = []
  raw.slots.forEach((slot, s) => {
    const byTrack = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const id = slot.track[i]
      if (id < 0) continue
      const list = byTrack.get(id)
      if (list) list.push(i)
      else byTrack.set(id, [i])
    }
    for (const [id, frames] of byTrack) reads.push(readTrack(raw, slot, s, id, frames, voice, cut, opts))
  })

  const series: MouthSeries = {
    fps: raw.fps,
    width: raw.width,
    height: raw.height,
    times: raw.times,
    talk: new Float32Array(n).fill(NaN),
    open: new Float32Array(n).fill(NaN),
    track: new Int16Array(n).fill(-1),
    head: new Float32Array(n).fill(NaN),
    away: new Float32Array(n).fill(NaN),
    faces: new Uint8Array(n),
    x: new Float32Array(n).fill(NaN),
    y: new Float32Array(n).fill(NaN),
    size: new Float32Array(n).fill(NaN),
    tracks: reads.map((r) => r.summary)
  }
  const place = (r: TrackRead, i: number): void => {
    series.x[i] = r.slot.cx[i]
    series.y[i] = r.slot.cy[i]
    series.size[i] = r.slot.faceW[i] / Math.max(1, raw.width)
  }
  for (const r of reads) for (const i of r.frames) series.faces[i]++

  // Which face to watch at each frame: among the usable ones on screen, the
  // one talking most over the last half second, held until another talks more.
  const usable = reads.filter((r) => r.summary.usable)
  const smoothTalk = (r: TrackRead, i: number): number => {
    let s = 0
    let c = 0
    for (let j = i - Math.round(raw.fps * 0.25); j <= i + Math.round(raw.fps * 0.25); j++) {
      const v = r.talk.get(j)
      if (v !== undefined) {
        s += v
        c++
      }
    }
    return c > 0 ? s / c : -1
  }
  let current: TrackRead | null = null
  for (let i = 0; i < n; i++) {
    const here = usable.filter((r) => r.talk.has(i) || r.away.has(i))
    if (here.length === 0) {
      current = null
    } else if (here.length === 1) {
      current = here[0]
    } else {
      const scored = here.map((r) => ({ r, s: smoothTalk(r, i) })).sort((a, b) => b.s - a.s)
      const held = current && here.includes(current) ? smoothTalk(current, i) : -Infinity
      if (!current || !here.includes(current) || scored[0].s > held + 0.25) current = scored[0].r
    }
    if (!current) {
      // No usable face: still say where the face is looking, for retake hints.
      const any = reads.find((r) => r.away.has(i))
      if (any) {
        series.away[i] = any.away.get(i) ?? NaN
        series.head[i] = any.head.get(i) ?? NaN
        place(any, i)
      }
      continue
    }
    place(current, i)
    series.track[i] = current.summary.id
    series.talk[i] = current.talk.get(i) ?? NaN
    series.open[i] = current.open.get(i) ?? NaN
    series.head[i] = current.head.get(i) ?? NaN
    series.away[i] = current.away.get(i) ?? NaN
  }
  return series
}

/** The frame showing at time `t`: the last one at or before it. -1 before the first. */
export function frameAt(series: { times: Float64Array }, t: number): number {
  const times = series.times
  if (times.length === 0 || t < times[0]) return -1
  let lo = 0
  let hi = times.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid] <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Share of the voice, over a span of the picture's clock, during which a mouth could be read. */
export function readableShare(series: MouthSeries, voice: Voice, from = 0, to = Infinity): number {
  let voiced = 0
  let read = 0
  for (let i = 0; i < series.times.length; i++) {
    const t = series.times[i]
    if (t < from || t > to) continue
    if (voicedShare(voice, t - 0.5 / series.fps, t + 0.5 / series.fps) < 0.5) continue
    voiced++
    if (Number.isFinite(series.talk[i])) read++
  }
  return voiced > 0 ? read / voiced : 0
}
