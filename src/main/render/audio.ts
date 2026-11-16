import type { LevelKey } from '../../shared/edit'

/**
 * The finishing filters for sound: a voice cleaned up, and a music bed's
 * level as an expression ffmpeg evaluates as it plays.
 */

const n = (v: number, digits = 6): string => (Math.abs(v) < 1e-12 ? '0' : v.toFixed(digits))

/** How late afftdn returns sound, in seconds. */
const AFFTDN_DELAY_SEC = 0.025

/**
 * A peak limiter that leaves the sound where it was, for 48 kHz sound.
 * alimiter looks ahead by its attack, 5 ms, and so returns the sound 240
 * samples late. Its own compensation (latency=1) depends on the size of the
 * frames it is handed: after a crossfade it left a sound effect 16 ms early
 * (measured on ffmpeg 6.1). The look-ahead is always exactly the attack, so
 * those 240 samples come off the front instead, and whoever follows pads the
 * end back to length.
 */
export function limiter(limit: number): string {
  return `alimiter=limit=${limit}:level=false:attack=5,atrim=start_sample=240,asetpts=PTS-STARTPTS`
}

/**
 * A voice cleaned up, from 0 (barely) to 1 (the most): rumble below 80 Hz
 * out, steady hiss and hum taken down by up to 18 dB, harsh esses softened,
 * the level evened by a gentle compressor, a little boxiness cut around
 * 250 Hz and presence lifted around 4 kHz, then peaks caught. The loudness
 * target is set afterwards, so polish never changes how loud it ends up.
 */
export function voicePolish(strength: number): string {
  const k = Math.min(1, Math.max(0, strength))
  return [
    'highpass=f=80:poles=2',
    // afftdn hands its sound back 25 ms late (measured on ffmpeg 6.1); those
    // 25 ms come off the front so the words stay on their captions.
    `afftdn=nr=${n(6 + 12 * k, 1)}:nf=-50:tn=1`,
    `atrim=start=${AFFTDN_DELAY_SEC},asetpts=PTS-STARTPTS`,
    `deesser=i=${n(0.5 + 0.2 * k, 2)}:m=0.5:f=0.5:s=o`,
    // A threshold of -24 dB, as ffmpeg wants it: a linear level.
    `acompressor=threshold=0.063:ratio=${n(2 + 2 * k, 2)}:attack=15:release=200:makeup=${n(1 + k, 2)}`,
    `equalizer=f=250:t=q:w=1:g=${n(-1.5 * k, 2)}`,
    `equalizer=f=4000:t=q:w=0.9:g=${n(1 + 2 * k, 2)}`,
    limiter(0.95)
  ].join(',')
}

/**
 * A level curve as an expression of t: straight ramps between keys, held
 * flat before the first and after the last, as a balanced tree of if()s so a
 * long video stays shallow for ffmpeg's parser.
 */
export function levelExpr(keys: LevelKey[]): string {
  if (keys.length === 0) return '0'
  if (keys.length === 1) return n(keys[0].db)
  const seg = (i: number): string => {
    const a = keys[i - 1]
    const b = keys[i]
    const len = Math.max(1e-6, b.t - a.t)
    return `(${n(a.db)}+(${n(b.db - a.db)})*(t-${n(a.t)})/${n(len)})`
  }
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return seg(lo)
    const mid = (lo + hi + 1) >> 1
    return `if(lt(t,${n(keys[mid - 1].t)}),${tree(lo, mid - 1)},${tree(mid, hi)})`
  }
  const last = keys[keys.length - 1]
  return `if(lt(t,${n(keys[0].t)}),${n(keys[0].db)},if(gte(t,${n(last.t)}),${n(last.db)},${tree(1, keys.length - 1)}))`
}

/** The volume filter that sets a bed `gainDb` loud and moves it along the keys. */
export function bedVolume(gainDb: number, keys: LevelKey[]): string {
  return `volume='pow(10,(${n(gainDb)}+${levelExpr(keys)})/20)':eval=frame`
}
