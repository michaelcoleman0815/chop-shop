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

/** A step this long or longer is played on its own; shorter ones, a ramp's, are played together. */
const CHUNK_SEC = 0.15

/**
 * The steps played as stretches of sound: each long step alone, and each run
 * of a ramp's short steps as one stretch at the speed that takes exactly as
 * long as they do. atempo needs some sound to work on; a ramp's steps are
 * 30 ms or so each, too short to stretch cleanly one by one.
 */
export function soundChunks(steps: SpeedStep[]): SpeedStep[] {
  const chunks: { srcSec: number; outSec: number }[] = []
  let open: { srcSec: number; outSec: number } | null = null
  for (const s of steps) {
    if (s.srcSec >= CHUNK_SEC) {
      if (open) chunks.push(open)
      open = null
      chunks.push({ srcSec: s.srcSec, outSec: s.srcSec / s.speed })
      continue
    }
    open = open ?? { srcSec: 0, outSec: 0 }
    open.srcSec += s.srcSec
    open.outSec += s.srcSec / s.speed
  }
  if (open) chunks.push(open)
  return chunks.map((c) => ({ srcSec: c.srcSec, speed: c.srcSec / c.outSec }))
}

/**
 * The sound of the steps, played at their speeds with atempo, which keeps the
 * pitch (and chains for slower than half speed). One speed is one atempo,
 * delayed by its lead. Several, a ramp, are played a stretch at a time
 * (soundChunks), each from its own moment of the recording, delayed by its
 * own lead and cut to exactly its length, then joined, so every stretch
 * starts where the picture's does. (Telling one atempo each new speed as it
 * plays would avoid the joins, but ffmpeg 6.0, the one the Mac app ships,
 * ignores atempo's tempo command and plays the whole ramp at its first speed.)
 * `from` is the input label and `to` the output; `name` keeps the labels this
 * makes unique in the graph.
 */
export function speedSound(steps: SpeedStep[], from: string, to: string, name: string): string {
  // adelay leaves timestamps that no longer count the samples; they are counted again after it.
  const delayed = (speed: number): string => {
    const lead = Math.round(atempoLead(speed) * 1000)
    return `${lead > 0 ? `,adelay=delays=${lead}:all=1` : ''},asetpts=N/SR/TB`
  }
  const tempo = (speed: number): string => (Math.abs(speed - 1) < 1e-6 ? 'anull' : atempoChain(speed))
  if (steps.length === 1) {
    return `[${from}]asetpts=PTS-STARTPTS,${tempo(steps[0].speed)}${delayed(steps[0].speed)}[${to}]`
  }
  const chunks = soundChunks(steps)
  const labels = chunks.map((_, i) => `${name}k${i}`)
  const parts = [`[${from}]asetpts=PTS-STARTPTS,asplit=${chunks.length}${labels.map((l) => `[${l}i]`).join('')}`]
  let at = 0
  chunks.forEach((c, i) => {
    parts.push(
      `[${labels[i]}i]atrim=start=${n(at)}:end=${n(at + c.srcSec)},asetpts=PTS-STARTPTS,${tempo(c.speed)}` +
        `${delayed(c.speed)},apad,atrim=duration=${n(c.srcSec / c.speed)}[${labels[i]}]`
    )
    at += c.srcSec
  })
  parts.push(`${labels.map((l) => `[${l}]`).join('')}concat=n=${chunks.length}:v=0:a=1,asetpts=N/SR/TB[${to}]`)
  return parts.join(';')
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
