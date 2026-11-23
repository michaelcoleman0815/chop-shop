import type { Cut } from '../../shared/edit/schema'
import {
  activeEffects,
  delayTaps,
  heardOf,
  isNeutral,
  rampKeys,
  reverbStages,
  soundsOn,
  type AudioFx,
  type BusMix,
  type MixKey,
  type Tap
} from '../../shared/mix'
import { isKeyed, num } from '../../shared/anim'
import { AFFTDN_DELAY_SEC, bedVolume, levelExpr } from './audio'

/**
 * The mixer in the export: each strip's effects as ffmpeg filters, then its
 * level and its place between the speakers. Every filter here is in an
 * ffmpeg built without its GPL parts, so a phone mixes the same way
 * (render/lgpl). The preview plays an approximation of this (renderer
 * mix-graph); this is the reference.
 *
 * Effects run in their order before the fader, as a desk's inserts do. The
 * voice's effects run before its loudness is set, as the polish does, and its
 * level, pan and mute after, so the loudness target does not undo the fader.
 */

const n = (v: number, digits = 6): string => (Math.abs(v) < 1e-12 ? '0' : v.toFixed(digits))
const lin = (db: number): string => n(Math.pow(10, db / 20))

/** A strip as one pass plays it: its level and pan, moving along keys at seconds of the video, its effects, and whether it is heard. */
export interface BusPlan {
  gainDb: number
  gainKeys: MixKey[]
  pan: number
  panKeys: MixKey[]
  effects: AudioFx[]
  /** Muted, or left out while another strip is soloed. */
  silent: boolean
}

/** The edit's strips that change anything: the voice's, the music's, and each track's by id. */
export interface MixPlan {
  voice: BusPlan | null
  music: BusPlan | null
  tracks: Record<string, BusPlan>
}

function busPlan(mix: BusMix | undefined, silent: boolean, durationSec: number): BusPlan | null {
  if (!silent && isNeutral(mix)) return null
  const gain = mix?.gainDb
  const pan = mix?.pan
  return {
    gainDb: isKeyed(gain) ? 0 : num(gain, 0, durationSec, 0),
    gainKeys: rampKeys(gain, durationSec),
    pan: isKeyed(pan) ? 0 : num(pan, 0, durationSec, 0),
    panKeys: rampKeys(pan, durationSec),
    effects: activeEffects(mix?.effects),
    silent
  }
}

/** What the mixer does to this cut, or null when nobody has touched it. */
export function mixPlan(cut: Cut, durationSec: number): MixPlan | null {
  const heard = heardOf(cut)
  const tracks: Record<string, BusPlan> = {}
  for (const t of cut.tracks ?? []) {
    if (!soundsOn(t)) continue
    const plan = busPlan(t.mix, !heard.track(t), durationSec)
    if (plan) tracks[t.id] = plan
  }
  const voice = busPlan(cut.voiceMix, !heard.voice, durationSec)
  const music = cut.music ? busPlan(cut.musicMix, !heard.music, durationSec) : null
  if (!voice && !music && Object.keys(tracks).length === 0) return null
  return { voice, music, tracks }
}

// ---------- One effect ----------

/** The taps of an echo, as aecho's delays and decays. */
const taps = (list: Tap[]): string => `delays=${list.map((t) => n(t.ms, 1)).join('|')}:decays=${list.map((t) => n(t.g)).join('|')}`

/**
 * An effect from the sound labelled `from` to `to`. Most are one filter on
 * the way; the reverb splits the sound, so what it hands back is a list of
 * chains. Filters that hand their sound back late (afftdn, alimiter) take
 * that delay off the front, as the voice's polish does (render/audio).
 */
export function fxChains(fx: AudioFx, from: string, to: string): string[] {
  const line = (filters: string): string[] => [`[${from}]${filters}[${to}]`]
  switch (fx.kind) {
    case 'eq':
      return line(fx.bands.map(eqBand).join(','))
    case 'highpass':
      return line(`highpass=f=${n(fx.freq, 1)}:poles=2:t=q:w=0.707`)
    case 'lowpass':
      return line(`lowpass=f=${n(fx.freq, 1)}:poles=2:t=q:w=0.707`)
    case 'compressor':
      // ffmpeg takes the threshold and the makeup as linear levels.
      return line(
        `acompressor=threshold=${lin(fx.thresholdDb)}:ratio=${n(fx.ratio, 2)}:attack=${n(fx.attackMs, 2)}:release=${n(fx.releaseMs, 1)}:makeup=${lin(fx.makeupDb)}`
      )
    case 'gate':
      return line(
        `agate=threshold=${lin(fx.thresholdDb)}:ratio=10:range=${lin(fx.rangeDb)}:attack=${n(fx.attackMs, 2)}:release=${n(fx.releaseMs, 1)}`
      )
    case 'deesser':
      return line(`deesser=i=${n(fx.amount, 3)}:m=${n(Math.min(1, 0.3 + 0.5 * fx.amount), 3)}:f=0.5:s=o`)
    case 'noise':
      return line(`afftdn=nr=${n(fx.reduceDb, 1)}:nf=${n(fx.floorDb, 1)}:tn=1,atrim=start=${AFFTDN_DELAY_SEC},asetpts=PTS-STARTPTS`)
    case 'limiter':
      // alimiter looks ahead by its attack, 5 ms, and so returns the sound 240 samples late (render/audio limiter).
      return line(
        `alimiter=limit=${lin(fx.ceilingDb)}:level=false:attack=5:release=${n(fx.releaseMs, 1)},atrim=start_sample=240,asetpts=PTS-STARTPTS`
      )
    case 'delay': {
      // The sound itself at what the mix leaves of it, and each repeat at its level.
      const list = delayTaps(fx)
      if (list.length === 0) return line('anull')
      return line(`aecho=in_gain=${n(1 - fx.mix)}:out_gain=1:${taps(list)}`)
    }
    case 'reverb': {
      // Three stages of reflections (shared/mix reverbStages): the first gives only reflections, the next two
      // pass theirs on with their own added. Then the room at its level against the sound, mixed under it.
      const { stages, scale } = reverbStages(fx.room)
      const [first, ...rest] = stages
      const wet = [`aecho=in_gain=0:out_gain=1:${taps(first)}`, ...rest.map((s) => `aecho=in_gain=1:out_gain=1:${taps(s)}`)]
      return [
        `[${from}]asplit=2[${to}d][${to}w]`,
        `[${to}w]${wet.join(',')},volume=${n(scale * fx.mix)}[${to}r]`,
        `[${to}d]volume=${n(1 - fx.mix)}[${to}s]`,
        `[${to}s][${to}r]amix=inputs=2:duration=first:normalize=0[${to}]`
      ]
    }
  }
}

function eqBand(b: { type: string; freq: number; gainDb: number; q: number }): string {
  const f = n(b.freq, 1)
  switch (b.type) {
    case 'lowshelf':
      // A slope of 1, as Web Audio's shelves have, so the preview's shelf is this one.
      return `lowshelf=f=${f}:t=s:w=1:g=${n(b.gainDb, 2)}`
    case 'highshelf':
      return `highshelf=f=${f}:t=s:w=1:g=${n(b.gainDb, 2)}`
    case 'notch':
      return `bandreject=f=${f}:t=q:w=${n(b.q, 3)}`
    default:
      return `equalizer=f=${f}:t=q:w=${n(b.q, 3)}:g=${n(b.gainDb, 2)}`
  }
}

/**
 * A strip's effects, from `from` to `to`, in order, padded or trimmed back to
 * `totalSec` exactly: no chains at all when it has none.
 */
export function effectChains(effects: AudioFx[], from: string, to: string, totalSec: number): string[] {
  if (effects.length === 0) return []
  const chains: string[] = []
  let at = from
  effects.forEach((fx, i) => {
    const out = `${to}e${i}`
    chains.push(...fxChains(fx, at, out))
    at = out
  })
  chains.push(`[${at}]apad,atrim=duration=${n(totalSec)}[${to}]`)
  return chains
}

// ---------- Level and pan ----------

/**
 * Pan as Web Audio's StereoPannerNode does it on a stereo sound, so the
 * preview and the export agree: to the left, the right side folds into the
 * left as it goes; to the right, the left into the right. At 0 it is as it was.
 */
function panCoefficients(p: number): { ll: number; lr: number; rl: number; rr: number } {
  const x = Math.min(1, Math.max(-1, p))
  if (x <= 0) {
    const a = ((x + 1) * Math.PI) / 2
    return { ll: 1, lr: Math.cos(a), rl: 0, rr: Math.sin(a) }
  }
  const a = (x * Math.PI) / 2
  return { ll: Math.cos(a), lr: 0, rl: Math.sin(a), rr: 1 }
}

/** A still pan, as the pan filter's gains. */
export function panFilter(p: number): string {
  const c = panCoefficients(p)
  return `pan=stereo|c0=${n(c.ll)}*c0+${n(c.lr)}*c1|c1=${n(c.rl)}*c0+${n(c.rr)}*c1`
}

/** A moving pan: the same law, worked out for every sample from the keys (each channel's expression keeps its own variables). */
export function movingPan(keys: MixKey[]): string {
  const p = levelExpr(keys.map((k) => ({ t: k.t, db: Math.min(1, Math.max(-1, k.v)) })))
  const left = `st(0,${p});if(lte(ld(0),0),val(0)+val(1)*cos((ld(0)+1)*PI/2),val(0)*cos(ld(0)*PI/2))`
  const right = `st(0,${p});if(lte(ld(0),0),val(1)*sin((ld(0)+1)*PI/2),val(1)+val(0)*sin(ld(0)*PI/2))`
  return `aeval=exprs='${left}|${right}':c=same`
}

/** Pan for a sound, still or moving; nothing when it sits in the middle. */
export function panFilters(pan: number, keys: MixKey[]): string[] {
  if (keys.length > 0) return [movingPan(keys)]
  return Math.abs(pan) > 1e-6 ? [panFilter(pan)] : []
}

/**
 * A strip's level, pan and mute as filters on the way, or nothing when they
 * change nothing. A moving level is worked out every 10 ms, as the music's is.
 */
export function levelFilters(plan: BusPlan): string[] {
  if (plan.silent) return ['volume=0']
  const out: string[] = []
  if (plan.gainKeys.length > 0) out.push('asetnsamples=n=480', bedVolume(0, plan.gainKeys.map((k) => ({ t: k.t, db: k.v }))))
  else if (Math.abs(plan.gainDb) > 1e-6) out.push(`volume=${plan.gainDb.toFixed(2)}dB`)
  return [...out, ...panFilters(plan.pan, plan.panKeys)]
}

/** A strip from `from` to `to`: its effects, then its level and pan. Labels `from` straight through when it changes nothing. */
export function busChains(plan: BusPlan, from: string, to: string, totalSec: number): string[] {
  const fx = plan.silent ? [] : effectChains(plan.effects, from, `${to}fx`, totalSec)
  const at = fx.length > 0 ? `${to}fx` : from
  const level = levelFilters(plan)
  return [...fx, `[${at}]${level.length > 0 ? level.join(',') : 'anull'}[${to}]`]
}
