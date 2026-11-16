import { loudness, type Heard } from './sound'
import type { LeftOut, MomentKind, SoundEventKind } from './schema'
import type { ClipSeries, WatchedClip } from './watched'

/**
 * The stretches of a clip worth using, and the moments in them.
 *
 * A phone clip starts while the phone comes up and ends as it goes down; in
 * between it may be dark in a pocket, swing past something fast, or lose
 * focus. Each eighth of a second is judged on four things: too dark, shaking
 * hard, sweeping fast (the phone raised, lowered or whipped round), or soft
 * against the sharpest footage of its scene. What is left in runs of a second
 * or more is usable. A clip with nothing usable is left out, and says why.
 *
 * The usable stretches are cut into moments where the picture turns into
 * something else, and long ones every few seconds, and each moment is
 * measured: how much moves in it, how steady and well exposed it is, how loud
 * and what can be heard. Those numbers are what a story is chosen from when
 * nothing has looked at the pictures, and what Claude reads beside them when
 * it has.
 */

/** Shaking harder than this, as a share of the frame each eighth of a second, is not usable. */
export const SHAKE_BAD = 0.055
/** Sweeping faster than this, as a share of the frame each eighth of a second: the phone going up or down. */
export const SWEEP_BAD = 0.045
/** Darker than this mean brightness is too dark to show. */
export const DARK = 0.08
/** Softer than this share of the scene's sharpest footage is out of focus or smeared. */
export const SOFT = 0.45
/** A picture change this large inside a clip starts a new moment. */
export const NEW_VIEW = 0.3
/** The shortest usable stretch, and the longest gap of bad frames bridged inside one. */
const MIN_RUN_SEC = 1
const BRIDGE_SEC = 0.375
/** Moments are cut to about this long. */
const MOMENT_SEC = 6
/** A clip shorter than this is an accident. */
const MIN_CLIP_SEC = 1.2

export interface ClipSignals {
  hopSec: number
  light: number[]
  sharp: number[]
  /** Fast back-and-forth of the camera, share of the frame per step. */
  shake: number[]
  /** How fast the camera sweeps, share of the frame per step. */
  sweep: number[]
  /** Movement inside the frame once the camera's is taken out, 0 to 1. */
  action: number[]
  change: number[]
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
const round3 = (v: number): number => Math.round(v * 1000) / 1000

function middle(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** A moving average over `half` steps either side. */
function smooth(v: number[], half: number): number[] {
  const out = new Array<number>(v.length)
  for (let i = 0; i < v.length; i++) {
    let s = 0
    let n = 0
    for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
      s += v[k]
      n++
    }
    out[i] = s / Math.max(1, n)
  }
  return out
}

/** The camera's shake, sweep and the rest, step by step, from what the picture measured. */
export function signalsOf(series: ClipSeries): ClipSignals {
  const fps = Math.round(1 / series.hopSec)
  // The first frame has nothing before it; it moves as the second does.
  const dx = series.dx.map((v, i) => (i === 0 ? (series.dx[1] ?? 0) : v))
  const dy = series.dy.map((v, i) => (i === 0 ? (series.dy[1] ?? 0) : v))
  const slowX = smooth(dx, Math.round(fps / 2))
  const slowY = smooth(dy, Math.round(fps / 2))
  // How far each step jumps off the camera's smooth path. Shaking is that
  // happening step after step: the middle of a second's jumps, so one odd
  // step (a big shape crossing the frame, a flash) is not a shake.
  const jolt = dx.map((v, i) => Math.hypot(v - slowX[i], dy[i] - slowY[i]))
  const shake = jolt.map((_, i) => middle(jolt.slice(Math.max(0, i - 4), i + 5)))
  const sweep = slowX.map((v, i) => Math.hypot(v, slowY[i]))
  return {
    hopSec: series.hopSec,
    light: series.luma,
    sharp: series.sharp,
    shake: shake.map(round3),
    sweep: sweep.map(round3),
    action: series.diff
      .map((v, i) => (i === 0 ? (series.diff[1] ?? 0) : v))
      .map((v) => round3(clamp01((v - 0.004) / 0.05))),
    change: series.change
  }
}

/** The sharpest the clip gets, for comparing clips of one scene: its 80th percentile. */
export function sharpnessOf(series: ClipSeries | null): number {
  if (!series || series.sharp.length === 0) return 0
  const s = [...series.sharp].sort((a, b) => a - b)
  return s[Math.floor(0.8 * (s.length - 1))]
}

export interface MomentDraft {
  inSec: number
  outSec: number
  peakSec: number
  kind: MomentKind
  motion: number
  steady: number
  light: number
  sharp: number
  loud: number
  sounds: SoundEventKind[]
  face: number | null
  interest: number
  quality: number
}

export interface ClipReading {
  usable: [number, number][]
  left: LeftOut | null
  moments: MomentDraft[]
}

/** How well a brightness is exposed: 0 black or burnt out, 1 in the middle. */
export function exposure(light: number): number {
  if (light < DARK) return 0
  if (light < 0.25) return clamp01((light - DARK) / (0.25 - DARK))
  if (light <= 0.75) return 1
  return clamp01(1 - (light - 0.75) / 0.25) * 0.7 + 0.3
}

const EVENT_WEIGHT: Partial<Record<SoundEventKind, number>> = {
  cheering: 1,
  laughter: 0.8,
  music: 0.3,
  speech: 0.35
}

/**
 * Reads one clip. `sharpRef` is how sharp the best footage of its scene is;
 * without it, the clip is compared with its own sharpest stretch.
 */
export function readClip(
  watched: WatchedClip,
  opts: { sharpRef?: number; speech?: [number, number][] } = {}
): ClipReading {
  const duration = watched.durationSec
  if (!watched.series || watched.series.luma.length < 2) {
    return { usable: [], left: 'unreadable', moments: [] }
  }
  if (duration < MIN_CLIP_SEC) return { usable: [], left: 'short', moments: [] }
  const sig = signalsOf(watched.series)
  const hop = sig.hopSec
  const n = sig.light.length
  const ref = Math.max(opts.sharpRef ?? 0, sharpnessOf(watched.series), 1e-3)
  const dark = sig.light.map((l) => l < DARK)
  const shaky = sig.shake.map((s) => s > SHAKE_BAD)
  const sweeping = sig.sweep.map((s) => s > SWEEP_BAD)
  const soft = sig.sharp.map((s) => s < SOFT * ref)
  const ok = dark.map((d, i) => !d && !shaky[i] && !sweeping[i] && !soft[i])

  // Bad stretches shorter than a bridge inside good footage are kept: a jolt is not a cut.
  const bridge = Math.round(BRIDGE_SEC / hop)
  for (let i = 0; i < n; ) {
    if (ok[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && !ok[j]) j++
    if (i > 0 && j < n && j - i <= bridge) for (let k = i; k < j; k++) ok[k] = true
    i = j
  }
  const usable: [number, number][] = []
  for (let i = 0; i < n; ) {
    if (!ok[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && ok[j]) j++
    const a = i * hop
    const b = Math.min(duration, j * hop)
    if (b - a >= MIN_RUN_SEC) usable.push([round3(a), round3(b)])
    i = j
  }

  const share = (flags: boolean[]): number => flags.filter(Boolean).length / Math.max(1, flags.length)
  if (usable.length === 0 || usable.every(([a, b]) => b - a < 1.5)) {
    const meanLight = mean(sig.light)
    const left: LeftOut =
      meanLight < 0.06
        ? 'pocket'
        : share(dark) >= 0.5
          ? 'dark'
          : share(shaky) + share(sweeping) >= share(soft)
            ? 'shaky'
            : 'blurred'
    return { usable, left, moments: [] }
  }

  // Moments: each usable stretch cut where the view changes, then every few
  // seconds. A change counts when the palette a second either side differs
  // too, so a flash of light or a shape crossing the lens is not a new view.
  const palette = watched.series.palette ?? []
  const viewChanges = (t: number): boolean => {
    const before = palette[Math.max(0, Math.floor(t) - 1)]
    const after = palette[Math.min(palette.length - 1, Math.ceil(t) + 1)]
    if (!before || !after) return true
    let d = 0
    for (let k = 0; k < before.length; k++) d += Math.abs(before[k] - (after[k] ?? 0))
    return d / 2 >= 0.25
  }
  const spans: [number, number][] = []
  for (const [a, b] of usable) {
    const cuts = [a]
    for (let i = Math.ceil(a / hop) + 1; i < Math.floor(b / hop) - 1; i++) {
      const t = i * hop
      if (sig.change[i] >= NEW_VIEW && t - cuts[cuts.length - 1] >= 1.5 && b - t >= 1.5 && viewChanges(t))
        cuts.push(round3(t))
    }
    cuts.push(b)
    for (let k = 0; k < cuts.length - 1; k++) {
      const from = cuts[k]
      const to = cuts[k + 1]
      const pieces = Math.max(1, Math.round((to - from) / MOMENT_SEC))
      for (let p = 0; p < pieces; p++)
        spans.push([round3(from + ((to - from) * p) / pieces), round3(from + ((to - from) * (p + 1)) / pieces)])
    }
  }
  const heard = watched.heard
  const speech = opts.speech ?? heard?.speech ?? []
  const moments = spans.map(([a, b]) => measureMoment(watched, sig, heard, speech, a, b, ref))
  return { usable, left: null, moments }
}

/** Seconds of [a, b] that [c, d] covers. */
const overlap = (a: number, b: number, c: number, d: number): number => Math.max(0, Math.min(b, d) - Math.max(a, c))

function measureMoment(
  watched: WatchedClip,
  sig: ClipSignals,
  heard: Heard | null,
  speech: [number, number][],
  a: number,
  b: number,
  ref: number
): MomentDraft {
  const hop = sig.hopSec
  const i0 = Math.max(0, Math.floor(a / hop))
  const i1 = Math.min(sig.light.length, Math.max(i0 + 1, Math.ceil(b / hop)))
  const slice = (v: number[]): number[] => v.slice(i0, i1)
  const motion = clamp01(mean(slice(sig.action)))
  const steady = clamp01(1 - mean(slice(sig.shake)) / (SHAKE_BAD * 1.2))
  const light = clamp01(mean(slice(sig.light)))
  const sharp = clamp01(mean(slice(sig.sharp)) / ref)
  const dbAt = (t: number): number => heard?.db[Math.min(heard.db.length - 1, Math.max(0, Math.round(t / 0.1)))] ?? -90
  const dbs: number[] = []
  for (let t = a; t < b; t += 0.1) dbs.push(dbAt(t))
  const loud = heard ? loudness(dbs.sort((x, y) => x - y)[Math.floor(0.8 * (dbs.length - 1))] ?? -90) : 0
  const len = b - a
  const sounds: SoundEventKind[] = []
  for (const e of heard?.events ?? []) {
    const o = overlap(a, b, e.startSec, e.endSec)
    const counts = o >= 0.25 * len || ((e.kind === 'cheering' || e.kind === 'laughter') && o >= 0.5)
    if (counts && e.kind !== 'quiet' && e.kind !== 'noise' && !sounds.includes(e.kind)) sounds.push(e.kind)
  }
  const talk = speech.reduce((t, [c, d]) => t + overlap(a, b, c, d), 0) / Math.max(0.01, len)
  if (talk >= 0.25 && !sounds.includes('speech')) sounds.push('speech')
  const faces = watched.faces?.filter((f) => f.t >= a - 0.5 && f.t <= b + 0.5) ?? null
  const face = faces && faces.length ? Math.max(...faces.map((f) => f.share)) : null

  // The peak: where most moves, most is heard, and a cheer or a laugh is.
  let peak = (a + b) / 2
  let best = -Infinity
  for (let i = i0; i < i1; i++) {
    const t = i * hop
    const inEvent = (heard?.events ?? []).some(
      (e) => (e.kind === 'cheering' || e.kind === 'laughter') && t >= e.startSec && t < e.endSec
    )
    const score =
      sig.action[i] + 0.6 * loudness(dbAt(t)) + (inEvent ? 0.5 : 0) - 0.5 * Math.min(1, sig.shake[i] / SHAKE_BAD)
    if (score > best) {
      best = score
      peak = t
    }
  }
  const eventScore = Math.max(0, ...sounds.map((s) => EVENT_WEIGHT[s] ?? 0))
  const interest = clamp01(0.42 * motion + 0.25 * loud + 0.33 * eventScore + (face ? 0.1 * Math.min(1, face * 3) : 0))
  const quality = clamp01(Math.sqrt(steady) * exposure(light) * Math.sqrt(Math.min(1, sharp)))
  const kind: MomentKind =
    talk >= 0.5
      ? 'talk'
      : sounds.includes('laughter') || (sounds.includes('cheering') && (face ?? 0) > 0.15 && motion < 0.4)
        ? 'reaction'
        : motion >= 0.45 || sounds.includes('cheering')
          ? 'action'
          : motion < 0.12 && loud < 0.3
            ? 'quiet'
            : 'establishing'
  return {
    inSec: round3(a),
    outSec: round3(b),
    peakSec: round3(Math.min(b, Math.max(a, peak))),
    kind,
    motion: round3(motion),
    steady: round3(steady),
    light: round3(light),
    sharp: round3(Math.min(1, sharp)),
    loud: round3(loud),
    sounds,
    face: face === null ? null : round3(face),
    interest: round3(interest),
    quality: round3(quality)
  }
}

/** Values in a look: the palette, then the framing in colour, then in brightness. */
const PALETTE_SIZE = 12
const GRID_SIZE = 27
const THUMB_SIZE = 64

/**
 * The clip's look: the median palette and framing over its usable stretches
 * (or the whole clip), once a second, as one list: twelve palette shares,
 * twenty-seven framing colours, then sixty-four framing brightnesses.
 */
export function lookOf(series: ClipSeries | null, usable: [number, number][] = []): number[] {
  if (!series || series.grid.length === 0) return []
  const at = (k: number): boolean =>
    usable.length === 0 || usable.some(([a, b]) => k >= Math.floor(a) && k <= Math.ceil(b))
  const medianOf = (rows: number[][], size: number): number[] => {
    const use = rows.filter((_, k) => at(k))
    const pick = use.length ? use : rows
    if (pick.length === 0 || pick[0].length !== size) return new Array(size).fill(0)
    return pick[0].map((_, c) => {
      const v = pick.map((r) => r[c]).sort((x, y) => x - y)
      return round3(v[Math.floor(v.length / 2)])
    })
  }
  return [
    ...medianOf(series.palette ?? [], PALETTE_SIZE),
    ...medianOf(series.grid, GRID_SIZE),
    ...medianOf(series.thumb ?? [], THUMB_SIZE)
  ]
}

/** How different two places look, whatever the framing: half the palettes' total difference, 0 to 1. */
export function placeDistance(a: number[], b: number[]): number {
  if (a.length < PALETTE_SIZE || b.length < PALETTE_SIZE) return 1
  let d = 0
  for (let i = 0; i < PALETTE_SIZE; i++) d += Math.abs(a[i] - b[i])
  return Math.min(1, d / 2)
}

/** How different two framings are: the mean difference of their colours and brightness in place, 0 to 1. */
export function frameDistance(a: number[], b: number[]): number {
  const size = PALETTE_SIZE + GRID_SIZE + THUMB_SIZE
  if (a.length < size || b.length < size) return 1
  let d = 0
  for (let i = PALETTE_SIZE; i < size; i++) d += Math.abs(a[i] - b[i])
  return d / (GRID_SIZE + THUMB_SIZE)
}
