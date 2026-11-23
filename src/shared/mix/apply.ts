import { isKeyed, type Anim } from '../anim'
import type { Cut } from '../edit/schema'
import type { Track } from '../tracks/schema'
import { GAIN_MAX_DB, GAIN_MIN_DB, MAX_EFFECTS, type AudioFx, type BusMix, type MixOp, type OwnMix } from './schema'

/**
 * The mix op, applied to a cut. A strip that is not there, a level past the
 * fader's ends, a pan past either speaker, an effect to take off that is not
 * on, is refused with a sentence that says why, and the cut is left as it
 * was. A strip set back to as it comes is taken out of the cut altogether, so
 * an edit nobody mixed stays as it was saved.
 */

export type MixResult = { ok: true; cut: Cut } | { ok: false; reason: string }

class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason)
}

const values = (a: Anim<number>): number[] => (isKeyed(a) ? a.keys.map((k) => k.v) : [a])

function checkGain(a: Anim<number> | undefined): Anim<number> | undefined {
  if (a === undefined) return undefined
  if (values(a).some((v) => v < GAIN_MIN_DB - 1e-9 || v > GAIN_MAX_DB + 1e-9))
    refuse(`A level goes from ${GAIN_MIN_DB} dB to +${GAIN_MAX_DB} dB. To silence a sound, mute it.`)
  return !isKeyed(a) && Math.abs(a) < 1e-9 ? undefined : a
}

function checkPan(a: Anim<number> | undefined): Anim<number> | undefined {
  if (a === undefined) return undefined
  if (values(a).some((v) => v < -1 - 1e-9 || v > 1 + 1e-9)) refuse('Pan goes from -1, all the way left, to 1, all the way right.')
  return !isKeyed(a) && Math.abs(a) < 1e-9 ? undefined : a
}

/** The chain after the op: replaced, added to, and taken from, in that order. */
function chainAfter(was: AudioFx[], op: MixOp): AudioFx[] {
  let chain = op.effects ?? was
  if (op.add) chain = [...chain, ...op.add]
  if (op.remove && op.remove.length > 0) {
    const byPlace = new Set<number>()
    for (const r of op.remove) {
      if (typeof r === 'number') {
        if (r > chain.length) refuse(`There is no effect ${r} on it: it has ${chain.length === 0 ? 'none' : chain.length === 1 ? 'one' : chain.length}.`)
        byPlace.add(r - 1)
      } else {
        const found = chain.map((fx, i) => (fx.kind === r ? i : -1)).filter((i) => i >= 0)
        if (found.length === 0) refuse(`There is no ${r} on it to take off.`)
        for (const i of found) byPlace.add(i)
      }
    }
    chain = chain.filter((_, i) => !byPlace.has(i))
  }
  if (chain.length > MAX_EFFECTS) refuse(`A strip holds at most ${MAX_EFFECTS} effects.`)
  return chain
}

/** A strip as the op leaves it, or undefined when it changes nothing. */
function mixAfter(was: BusMix | undefined, op: MixOp): BusMix | undefined {
  const next: BusMix = {
    ...(op.gainDb !== undefined ? optional('gainDb', checkGain(op.gainDb)) : optional('gainDb', was?.gainDb)),
    ...(op.pan !== undefined ? optional('pan', checkPan(op.pan)) : optional('pan', was?.pan)),
    effects: chainAfter(was?.effects ?? [], op)
  }
  return next.gainDb === undefined && next.pan === undefined && next.effects.length === 0 ? undefined : next
}

const optional = <K extends string, V>(key: K, v: V | undefined): Partial<Record<K, V>> =>
  (v === undefined ? {} : { [key]: v }) as Partial<Record<K, V>>

function ownAfter(was: OwnMix | undefined, op: MixOp): OwnMix | undefined {
  const mix = mixAfter(was, op)
  const mute = op.mute ?? was?.mute ?? false
  const solo = op.solo ?? was?.solo ?? false
  if (!mix && !mute && !solo) return undefined
  return { ...(mix ?? { effects: [] }), ...(mute ? { mute: true } : {}), ...(solo ? { solo: true } : {}) }
}

export function applyMixOp(cut: Cut, op: MixOp): MixResult {
  try {
    return { ok: true, cut: step(cut, op) }
  } catch (err) {
    if (err instanceof Refused) return { ok: false, reason: err.message }
    throw err
  }
}

function step(cut: Cut, op: MixOp): Cut {
  if (op.target === 'voice') {
    const { voiceMix: _was, ...rest } = cut
    const mix = ownAfter(cut.voiceMix, op)
    return mix ? { ...rest, voiceMix: mix } : rest
  }
  if (op.target === 'music') {
    if (!cut.music) refuse('There is no music to mix. Choose a track for the bed first.')
    const { musicMix: _was, ...rest } = cut
    const mix = ownAfter(cut.musicMix, op)
    return mix ? { ...rest, musicMix: mix } : rest
  }
  const tracks = cut.tracks ?? []
  const i = tracks.findIndex((t) => t.id === op.target)
  if (i < 0) refuse(`There is no track ${op.target}. Mix the voice, the music, or a track by its id.`)
  const was = tracks[i]
  const { mix: _mix, ...bare } = was
  const mix = mixAfter(was.mix, op)
  const track: Track = {
    ...bare,
    ...(mix ? { mix } : {}),
    mute: op.mute ?? was.mute,
    solo: op.solo ?? was.solo
  }
  const out = [...tracks]
  out[i] = track
  return { ...cut, tracks: out }
}
