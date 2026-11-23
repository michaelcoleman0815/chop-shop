import { exprOf, isKeyed, num, type Anim } from '../anim'
import type { Track } from '../tracks/schema'
import type { AudioFx, BusMix, FxOf, OwnMix } from './schema'

/**
 * The strips of an edit, which of them are heard, and the numbers the
 * export and the preview share: a strip's level and pan at a moment, keys
 * laid out as straight ramps, and the taps of the reverb and the echo, so
 * both play the same room and the same repeats.
 */

/** The parts of a cut the mixer reads; the whole Cut fits. */
export interface MixCut {
  voiceMix?: OwnMix
  musicMix?: OwnMix
  music?: { path: string } | null
  tracks?: Track[]
}

/** Whether a track makes a sound: a sound track, or a picture track holding a video whose sound is not left out. */
export function soundsOn(track: Track): boolean {
  if (track.kind === 'sound') return true
  return track.clips.some((c) => c.kind === 'video' && !c.muted)
}

export type StripKind = 'voice' | 'music' | 'track'

export interface Strip {
  /** "voice", "music", or the track's id: what a mix op names. */
  target: string
  kind: StripKind
  name: string
  mix: BusMix
  mute: boolean
  solo: boolean
}

/** Every strip of the edit: the voice, each track that sounds, and the music bed when there is one. */
export function stripsOf(cut: MixCut): Strip[] {
  const own = (target: 'voice' | 'music', name: string, m: OwnMix | undefined): Strip => ({
    target,
    kind: target,
    name,
    mix: { gainDb: m?.gainDb, pan: m?.pan, effects: m?.effects ?? [] },
    mute: !!m?.mute,
    solo: !!m?.solo
  })
  const out: Strip[] = [own('voice', 'Voice', cut.voiceMix)]
  for (const t of cut.tracks ?? []) {
    if (!soundsOn(t)) continue
    out.push({ target: t.id, kind: 'track', name: t.name, mix: t.mix ?? { effects: [] }, mute: t.mute, solo: t.solo })
  }
  if (cut.music) out.push(own('music', 'Music', cut.musicMix))
  return out
}

/** Which strips are heard: none that is muted, and when any is soloed, only those that are. */
export interface Heard {
  voice: boolean
  music: boolean
  track(track: Track): boolean
}

export function heardOf(cut: MixCut): Heard {
  const tracks = (cut.tracks ?? []).filter(soundsOn)
  const anySolo = !!cut.voiceMix?.solo || (!!cut.music && !!cut.musicMix?.solo) || tracks.some((t) => t.solo)
  return {
    voice: !cut.voiceMix?.mute && (!anySolo || !!cut.voiceMix?.solo),
    music: !cut.musicMix?.mute && (!anySolo || !!cut.musicMix?.solo),
    track: (t) => !t.mute && (!anySolo || t.solo)
  }
}

/** The effects that change the sound: not bypassed, and not set to do nothing. */
export function activeEffects(effects: AudioFx[] | undefined): AudioFx[] {
  return (effects ?? []).filter((fx) => !fx.bypass && !doesNothing(fx))
}

function doesNothing(fx: AudioFx): boolean {
  switch (fx.kind) {
    case 'eq':
      return fx.bands.every((b) => b.type !== 'notch' && Math.abs(b.gainDb) < 0.01)
    case 'compressor':
      return fx.ratio <= 1.001 && fx.makeupDb < 0.01
    case 'deesser':
      return fx.amount <= 0
    case 'reverb':
    case 'delay':
      return fx.mix <= 0
    default:
      return false
  }
}

const isZero = (a: Anim<number> | undefined): boolean => a === undefined || (!isKeyed(a) && Math.abs(a) < 1e-9)

/** Whether a strip changes nothing: as it comes, in the middle, with nothing that acts. */
export function isNeutral(mix: BusMix | undefined): boolean {
  return !mix || (isZero(mix.gainDb) && isZero(mix.pan) && activeEffects(mix.effects).length === 0)
}

/** A strip's level or pan at a moment of the video. */
export function valueAt(a: Anim<number> | undefined, t: number, durationSec: number): number {
  return num(a, t, durationSec, 0)
}

/** A point on a moving level or pan, at seconds of the video. */
export interface MixKey {
  t: number
  v: number
}

/** Eased stretches are laid out in this many straight pieces. */
const EASED_STEPS = 12

/**
 * Keys as straight ramps between points, for the export's expressions and
 * the preview's ramps alike: a straight key stays one point, an eased stretch
 * becomes a dozen, and a held one a step. Empty for a value that does not move.
 */
export function rampKeys(a: Anim<number> | undefined, durationSec: number): MixKey[] {
  // An expression (shared/anim/expr) is read off at twenty moments a second, as the clips' levels are.
  if (exprOf(a)) {
    const steps = Math.max(2, Math.min(4000, Math.ceil(durationSec * 20) + 1))
    return Array.from({ length: steps }, (_, i) => {
      const t = (durationSec * i) / (steps - 1)
      return { t, v: num(a, t, durationSec, 0) }
    })
  }
  if (!isKeyed(a) || a.keys.length === 0) return []
  const at = (k: { t: number; from?: 'start' | 'end' }): number => (k.from === 'end' ? durationSec - k.t : k.t)
  const keys = [...a.keys].sort((x, y) => at(x) - at(y))
  const out: MixKey[] = [{ t: at(keys[0]), v: keys[0].v }]
  for (let i = 1; i < keys.length; i++) {
    const ta = at(keys[i - 1])
    const tb = at(keys[i])
    const ease = keys[i - 1].ease
    if (ease === 'hold') {
      out.push({ t: Math.max(ta, tb - 0.001), v: keys[i - 1].v }, { t: tb, v: keys[i].v })
      continue
    }
    if (ease !== undefined && ease !== 'linear' && tb - ta > 0.01) {
      for (let s = 1; s < EASED_STEPS; s++) {
        const t = ta + ((tb - ta) * s) / EASED_STEPS
        out.push({ t, v: num(a, t, durationSec, 0) })
      }
    }
    out.push({ t: tb, v: keys[i].v })
  }
  return out
}

// ---------- The reverb's room and the echo's repeats ----------

/** One reflection: how late, in milliseconds, and how loud. */
export interface Tap {
  ms: number
  g: number
}

/** Four stages of reflections, as shares of the room's length, each set apart from the others. */
const STAGES = [
  [0.011, 0.017, 0.023, 0.031, 0.041, 0.053, 0.067],
  [0.013, 0.029, 0.043, 0.061, 0.079, 0.097, 0.113],
  [0.019, 0.037, 0.059, 0.083, 0.107, 0.131, 0.157],
  [0.029, 0.053, 0.089, 0.127, 0.163, 0.199, 0.233]
]
const STAGE_SPAN = STAGES.reduce((s, row) => s + row[row.length - 1], 0)

/** How long the room rings, in seconds, from 0 (a small room) to 1 (a hall): to 60 dB down. */
export const roomSec = (room: number): number => 0.4 + 2.6 * Math.min(1, Math.max(0, room))

/**
 * The reverb as four stages of reflections, one after the other: the first
 * gives only reflections, the rest pass what they are given on with their own
 * added, so the room is 7 x 8 x 8 x 8 = 3,584 reflections. Each is quieter
 * the later it falls, so the whole room dies away to 60 dB down over its
 * length, 0.4 s in a small room and 3 s in a hall. `scale` brings the
 * reflections to the level of the sound that made them. The export runs the
 * stages as echoes (main/render/mix), the preview the same reflections as an
 * impulse (mix-graph), so both hear one room.
 */
export function reverbStages(room: number): { stages: Tap[][]; scale: number } {
  const stages = stagesOf(room)
  // Reflections that land on the same sample add up, as they do in the export's echoes: the level is the impulse's own.
  const ir = impulseOf(stages, 48000)
  return { stages, scale: 1 / Math.sqrt(ir.reduce((e, v) => e + v * v, 0)) }
}

function stagesOf(room: number): Tap[][] {
  const lengthMs = roomSec(room) * 1000
  return STAGES.map((row) =>
    row.map((share) => {
      const ms = Math.round(((share * lengthMs) / STAGE_SPAN) * 10) / 10
      return { ms, g: Math.pow(10, (-3 * ms) / lengthMs) * 0.7 }
    })
  )
}

/** The stages as one impulse at `rate`: each stage late by whole samples, as aecho counts them (its delay cut down to a sample). */
function impulseOf(stages: Tap[][], rate: number): Float32Array {
  const at = (ms: number): number => Math.floor((ms * rate) / 1000)
  let taps: { at: number; g: number }[] = stages[0].map((t) => ({ at: at(t.ms), g: t.g }))
  for (const stage of stages.slice(1)) {
    const next: { at: number; g: number }[] = []
    for (const a of taps) {
      next.push(a)
      for (const b of stage) next.push({ at: a.at + at(b.ms), g: a.g * b.g })
    }
    taps = next
  }
  const out = new Float32Array(Math.max(...taps.map((t) => t.at)) + 1)
  for (const t of taps) out[t.at] += t.g
  return out
}

/** The reverb's reflections as one impulse, for a convolver: at `rate` samples a second, brought to level by its scale. */
export function reverbImpulse(room: number, rate: number): Float32Array {
  const stages = stagesOf(room)
  const ir = impulseOf(stages, rate)
  const scale = 1 / Math.sqrt(ir.reduce((e, v) => e + v * v, 0))
  return ir.map((v) => v * scale)
}

/** The echo's repeats, as many as are heard: each `timeMs` after the last at `feedback` of its level, the first at `mix`. */
export function delayTaps(fx: FxOf<'delay'>): Tap[] {
  const taps: Tap[] = []
  let g = fx.mix
  for (let k = 1; k <= 32 && g >= 0.001 && k * fx.timeMs <= 30_000; k++) {
    taps.push({ ms: k * fx.timeMs, g })
    g *= fx.feedback
  }
  return taps
}

// ---------- Words ----------

export const FX_LABEL: Record<AudioFx['kind'], string> = {
  eq: 'EQ',
  highpass: 'High-pass',
  lowpass: 'Low-pass',
  compressor: 'Compressor',
  gate: 'Gate',
  deesser: 'De-esser',
  noise: 'Noise reduction',
  reverb: 'Reverb',
  delay: 'Echo',
  limiter: 'Limiter'
}

const hz = (f: number): string => (f >= 1000 ? `${Math.round(f / 100) / 10} kHz` : `${Math.round(f)} Hz`)
const db = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10} dB`

/** An effect in a few words: "compressor -18 dB 3:1", "reverb room 0.5 mix 0.2". */
export function fxWords(fx: AudioFx): string {
  const off = fx.bypass ? ' (bypassed)' : ''
  switch (fx.kind) {
    case 'eq':
      return `eq ${fx.bands.map((b) => (b.type === 'notch' ? `notch ${hz(b.freq)}` : `${b.type} ${hz(b.freq)} ${db(b.gainDb)}${b.type === 'peak' ? ` q ${b.q}` : ''}`)).join(', ')}${off}`
    case 'highpass':
    case 'lowpass':
      return `${fx.kind} ${hz(fx.freq)}${off}`
    case 'compressor':
      return `compressor ${db(fx.thresholdDb)} ${fx.ratio}:1${fx.makeupDb ? ` makeup ${db(fx.makeupDb)}` : ''}${off}`
    case 'gate':
      return `gate ${db(fx.thresholdDb)} range ${db(fx.rangeDb)}${off}`
    case 'deesser':
      return `deesser ${fx.amount}${off}`
    case 'noise':
      return `noise down ${fx.reduceDb} dB${off}`
    case 'reverb':
      return `reverb room ${fx.room} mix ${fx.mix}${off}`
    case 'delay':
      return `delay ${fx.timeMs} ms feedback ${fx.feedback} mix ${fx.mix}${off}`
    case 'limiter':
      return `limiter ${db(fx.ceilingDb)}${off}`
  }
}

/** A level or pan for the request: "-6", or its keys "10:0 12:-20". */
export function animWords(a: Anim<number> | undefined): string {
  if (a === undefined) return '0'
  if (!isKeyed(a)) return `${Math.round(a * 100) / 100}`
  return `keys ${a.keys.map((k) => `${k.t}:${k.v}`).join(' ')}`
}
