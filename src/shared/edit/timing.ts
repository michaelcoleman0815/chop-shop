import { z } from 'zod'

/**
 * Speed: how a stretch of recording maps onto the output clock when it plays
 * faster, slower, eased between speeds, or held still.
 *
 * Every speed change is a list of steps, each a stretch of source played at
 * one speed. A ramp is a handful of steps that ease from one speed to the
 * next, so the resolver, the preview and the renderer all share one exact
 * mapping: what the export stretches is what the captions follow.
 *
 * A leaf module, like transitions.ts, so the schema can use it.
 */

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
/** How long a speed ramp eases in and out unless asked otherwise: long enough to read as a ramp, not a jump. */
export const DEFAULT_RAMP_SEC = 0.4

/** Easing into a speed at the start and back to full speed at the end, in seconds of the finished video. */
export const RampSchema = z.object({
  inSec: z.number().min(0).max(5),
  outSec: z.number().min(0).max(5)
})
export type Ramp = z.infer<typeof RampSchema>

/** A freeze frame: the picture holds where a word ends, for `sec`, while the sound waits. */
export const FreezeSchema = z.object({
  word: z.string().min(1),
  sec: z.number().min(0.1).max(10)
})
export type Freeze = z.infer<typeof FreezeSchema>

/** A stretch of source played at one speed: `srcSec` of recording, at `speed` times. */
export interface SpeedStep {
  srcSec: number
  speed: number
}

/** Steps per ramp: about one every 40 ms on a typical ramp, too fine to see. */
const STEPS_PER_RAMP = 8

const smooth = (u: number): number => u * u * (3 - 2 * u)

/** How long a list of steps plays for. */
export function outLength(steps: SpeedStep[]): number {
  return steps.reduce((n, s) => n + s.srcSec / s.speed, 0)
}

/** How much source a list of steps covers. */
export function srcLength(steps: SpeedStep[]): number {
  return steps.reduce((n, s) => n + s.srcSec, 0)
}

/** Output seconds after a given offset into the source. Past the end, the last speed carries on. */
export function srcToOut(steps: SpeedStep[], srcOffset: number): number {
  let src = 0
  let out = 0
  for (const s of steps) {
    if (srcOffset <= src + s.srcSec) return out + (srcOffset - src) / s.speed
    src += s.srcSec
    out += s.srcSec / s.speed
  }
  const last = steps[steps.length - 1]
  return out + (srcOffset - src) / (last?.speed ?? 1)
}

/** Source seconds after a given offset into the output. Past the end, the last speed carries on. */
export function outToSrc(steps: SpeedStep[], outOffset: number): number {
  let src = 0
  let out = 0
  for (const s of steps) {
    const len = s.srcSec / s.speed
    if (outOffset <= out + len) return src + (outOffset - out) * s.speed
    src += s.srcSec
    out += len
  }
  const last = steps[steps.length - 1]
  return src + (outOffset - out) * (last?.speed ?? 1)
}

/** The speed playing at an output offset. */
export function speedAt(steps: SpeedStep[], outOffset: number): number {
  let out = 0
  for (const s of steps) {
    out += s.srcSec / s.speed
    if (outOffset < out) return s.speed
  }
  return steps[steps.length - 1]?.speed ?? 1
}

/**
 * The part of a list of steps covering source offsets from..to. Before the
 * start the first speed carries back, and past the end the last carries on,
 * which is what a picture moved by a J or L cut plays.
 */
export function sliceSteps(steps: SpeedStep[], from: number, to: number): SpeedStep[] {
  const out: SpeedStep[] = []
  if (from < -1e-9) out.push({ srcSec: Math.min(to, 0) - from, speed: steps[0]?.speed ?? 1 })
  let src = 0
  for (const s of steps) {
    const a = Math.max(from, src)
    const b = Math.min(to, src + s.srcSec)
    if (b - a > 1e-9) out.push({ srcSec: b - a, speed: s.speed })
    src += s.srcSec
  }
  // Past the end of the profile the last speed carries on.
  if (to > src + 1e-9) out.push({ srcSec: to - Math.max(from, src), speed: steps[steps.length - 1]?.speed ?? 1 })
  return merge(out)
}

/** Neighbouring steps at the same speed, as one. */
function merge(steps: SpeedStep[]): SpeedStep[] {
  const out: SpeedStep[] = []
  for (const s of steps) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.speed - s.speed) < 1e-9) last.srcSec += s.srcSec
    else out.push({ ...s })
  }
  return out
}

/**
 * The steps that play `outSec` of finished video at `speed`, easing from full
 * speed into it over `ramp.inSec` and back over `ramp.outSec`. Ramps longer
 * than the video allows are shortened in proportion.
 */
export function stepsForOutput(outSec: number, speed: number, ramp?: Ramp | null): SpeedStep[] {
  const s = clampSpeed(speed)
  let rin = ramp?.inSec ?? 0
  let rout = ramp?.outSec ?? 0
  if (rin + rout > outSec) {
    const k = outSec / (rin + rout)
    rin *= k
    rout *= k
  }
  const steps: SpeedStep[] = []
  const easing = (dur: number, from: number, to: number): void => {
    if (dur <= 1e-9) return
    const each = dur / STEPS_PER_RAMP
    for (let i = 0; i < STEPS_PER_RAMP; i++) {
      const v = from + (to - from) * smooth((i + 0.5) / STEPS_PER_RAMP)
      steps.push({ srcSec: each * v, speed: v })
    }
  }
  easing(rin, 1, s)
  const middle = outSec - rin - rout
  if (middle > 1e-9) steps.push({ srcSec: middle * s, speed: s })
  easing(rout, s, 1)
  return merge(steps)
}

/**
 * The steps that play `srcSec` of recording at `speed`, with the same ramps:
 * the finished length is whatever that takes.
 */
export function stepsForSource(srcSec: number, speed: number, ramp?: Ramp | null): SpeedStep[] {
  const s = clampSpeed(speed)
  if (!ramp || (ramp.inSec <= 0 && ramp.outSec <= 0)) return [{ srcSec, speed: s }]
  // Each ramp covers its length in source at the average of its two ends;
  // the middle covers the rest at `speed`.
  const per = (1 + s) / 2
  let rin = ramp.inSec
  let rout = ramp.outSec
  if ((rin + rout) * per > srcSec) {
    const k = srcSec / ((rin + rout) * per)
    rin *= k
    rout *= k
  }
  const out = rin + rout + Math.max(0, srcSec - (rin + rout) * per) / s
  const steps = stepsForOutput(out, s, { inSec: rin, outSec: rout })
  // The eased midpoints cover very nearly, not exactly, the source; the
  // steady middle (or the last step) takes up the difference.
  const diff = srcSec - srcLength(steps)
  const longest = steps.reduce((best, x, i) => (x.srcSec > steps[best].srcSec ? i : best), 0)
  steps[longest] = { ...steps[longest], srcSec: Math.max(1e-6, steps[longest].srcSec + diff) }
  return steps
}

export function clampSpeed(speed: number): number {
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed))
}

/** The atempo chain for a speed: each filter takes 0.5 to 100, so slower than half speed is chained. */
export function atempoChain(speed: number): string {
  const parts: string[] = []
  let left = clampSpeed(speed)
  while (left < 0.5) {
    parts.push('atempo=0.5')
    left /= 0.5
  }
  parts.push(`atempo=${left.toFixed(6)}`)
  return parts.join(',')
}
