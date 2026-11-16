import { atempoChain, srcLength, type SpeedStep } from '../../shared/edit'

/**
 * Speed as ffmpeg filters, from the same steps the resolver laid out, so the
 * export stretches exactly what the captions were timed against.
 */

const n = (v: number): string => v.toFixed(6)

/**
 * A setpts filter that plays the steps: each frame's time in the source,
 * T, becomes its time in the output. The expression is a balanced tree of
 * if()s over the step boundaries, so a long ramp stays shallow for ffmpeg's
 * expression parser.
 */
export function speedPts(steps: SpeedStep[]): string {
  const bounds: number[] = []
  const outs: number[] = []
  let src = 0
  let out = 0
  for (const s of steps) {
    bounds.push(src)
    outs.push(out)
    src += s.srcSec
    out += s.srcSec / s.speed
  }
  const leaf = (k: number): string => `${n(outs[k])}+(T-${n(bounds[k])})/${n(steps[k].speed)}`
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return leaf(lo)
    const mid = (lo + hi + 1) >> 1
    return `if(lt(T,${n(bounds[mid])}),${tree(lo, mid - 1)},${tree(mid, hi)})`
  }
  return `setpts='(${tree(0, steps.length - 1)})/TB'`
}

/**
 * How far ahead of its time map atempo plays sound, in seconds, by speed:
 * measured on ffmpeg 6.1 with tone bursts, at the moment each reaches half
 * its level (the mean of twelve; each burst varies by about 10 ms either
 * side). Delaying the sound by this keeps speech on its captions.
 */
const ATEMPO_LEAD: [number, number][] = [
  [0.25, 0.094],
  [0.3, 0.079],
  [0.4, 0.06],
  [0.5, 0.034],
  [0.6, 0.03],
  [0.7, 0.026],
  [0.8, 0.022],
  [0.9, 0.021],
  [1.1, 0.017],
  [1.25, 0.014],
  [1.5, 0.012],
  [2, 0.011],
  [3, 0.006],
  [4, 0.004]
]

export function atempoLead(speed: number): number {
  if (Math.abs(speed - 1) < 1e-6) return 0
  const pts = ATEMPO_LEAD
  if (speed <= pts[0][0]) return pts[0][1]
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x0, y0] = pts[i - 1]
    if (speed <= x1) return y0 + ((y1 - y0) * (speed - x0)) / (x1 - x0)
  }
  return pts[pts.length - 1][1]
}

/** The speed most of the steps' playing time is at: a ramp's steady middle. */
function mainSpeed(steps: SpeedStep[]): number {
  return steps.reduce((best, s) => (s.srcSec / s.speed > best.srcSec / best.speed ? s : best), steps[0]).speed
}

/**
 * The sound of the steps, played at their speeds with atempo, which keeps the
 * pitch. A ramp is one atempo told each new speed at its step's moment in the
 * recording, so the sound runs on without a seam; atempo takes 0.5 to 100, so
 * a profile that goes slower than half speed runs through two, each at the
 * square root. The result is delayed by atempo's lead at the main speed.
 * `from` is the input label and `to` the output; `name` keeps the filter
 * names this makes unique in the graph.
 */
export function speedSound(steps: SpeedStep[], from: string, to: string, name: string): string {
  const lead = Math.round(atempoLead(mainSpeed(steps)) * 1000)
  // adelay leaves timestamps that no longer count the samples; they are counted again after it.
  const delay = `${lead > 0 ? `,adelay=delays=${lead}:all=1` : ''},asetpts=N/SR/TB`
  if (steps.length === 1) return `[${from}]asetpts=PTS-STARTPTS,${atempoChain(steps[0].speed)}${delay}[${to}]`
  const twice = steps.some((s) => s.speed < 0.5)
  const tempo = (speed: number): string => n(twice ? Math.sqrt(speed) : speed)
  const commands: string[] = []
  let at = 0
  for (const s of steps) {
    commands.push(`${n(at)} atempo@${name}a tempo ${tempo(s.speed)}`)
    if (twice) commands.push(`${n(at)} atempo@${name}b tempo ${tempo(s.speed)}`)
    at += s.srcSec
  }
  const first = tempo(steps[0].speed)
  return (
    `[${from}]asetpts=PTS-STARTPTS,asetnsamples=n=480,asendcmd=c='${commands.join(';')}',` +
    `atempo@${name}a=${first}${twice ? `,atempo@${name}b=${first}` : ''}${delay}[${to}]`
  )
}

/**
 * How much of a recording is played backwards at a time. The reverse filter
 * holds every frame it is given until the last arrives, so a long stretch is
 * read in slices of at most this, each reversed on its own, latest first.
 */
export const REVERSE_SLICE_SEC = 2

/** The slices a stretch played backwards is read in, in source order, all the same length. */
export function reverseSlices(start: number, len: number): { start: number; len: number }[] {
  const n = Math.max(1, Math.ceil(len / REVERSE_SLICE_SEC - 1e-9))
  return Array.from({ length: n }, (_, i) => ({ start: start + (len * i) / n, len: len / n }))
}

/** Whether steps change anything. */
export function changesSpeed(steps: SpeedStep[] | undefined): steps is SpeedStep[] {
  return !!steps && steps.some((s) => Math.abs(s.speed - 1) > 1e-6)
}

/** How much source a list of steps reads. */
export function sourceFor(steps: SpeedStep[] | undefined, fallback: number): number {
  return steps ? srcLength(steps) : fallback
}
