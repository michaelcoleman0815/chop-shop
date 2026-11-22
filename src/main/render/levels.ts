import type { LevelKey } from '../../shared/edit'
import { FloatReader, platform } from '../platform'

/**
 * How loud a cut's voice is and how loud the room under it, measured on the
 * sound the cut keeps before anything is done to it, and what the render does
 * with that: how far it turns the voice up (never more than MOST_BOOST_DB),
 * and, for a voice in a room (a sermon), how much of the room it takes out
 * and which pauses it dips.
 *
 * Measured on two test sermons (docs/research/sermon-clips.md, "Quiet
 * sermons"): loudness alone turned a soft passage up 25 dB and the room with
 * it, to -30 dB in a room with air handling. afftdn tracking the noise as it
 * goes took 1.5 dB of that; afftdn given a print of the room first took 11.
 */

/** A stretch of a recording the cut plays: where it is read, and where it lands on the output clock. */
export interface SoundSpan {
  path: string
  /** Where it starts in the recording. */
  startSec: number
  /** Seconds of the recording it reads. */
  srcSec: number
  /** Where it starts on the output clock, and how long it plays there (speed makes the two differ). */
  outStart: number
  outSec: number
  /** The one channel that carries the sound, when the other is empty. */
  channel?: 0 | 1
}

/** The level of each WINDOW_SEC of one span, as read from the recording. */
export interface SpanLevels {
  span: SoundSpan
  db: Float32Array
}

/** What a cut's sound measured. */
export interface SoundLevels {
  /** Integrated loudness, LUFS. */
  lufs: number
  /** The room: the level of the quietest tenth of the windows, in dB. */
  roomDb: number
  spans: SpanLevels[]
}

/** The window levels are measured over: long enough to be steady, short enough to fall inside a pause. */
export const WINDOW_SEC = 0.05
const RATE = 16000
const WINDOW = RATE * WINDOW_SEC
/** At most this many stretches are read to measure a cut: the longest, which carry most of it. */
const MOST_SPANS = 48

/** The most the voice is turned up, in dB: past this a recording is left quieter than the target. */
export const MOST_BOOST_DB = 24
/**
 * loudnorm lifts a stretch quieter than the rest by up to about 5 dB more
 * than the whole (measured), and holds that gain through the pause after.
 */
const RIDE_DB = 5
/** Where the room should sit once the voice is at its target: 46 dB under a voice at -14 LUFS. */
const ROOM_QUIET_DB = -60
/** Less over than this, and the room is left as it was. */
const LEAST_CLEAN_DB = 4
/** The most afftdn is asked to take out: more and the voice starts to sound under water. */
const MOST_CLEAN_DB = 18
/** About what a clean led by a print of the room takes off it (measured: 10 to 13 dB). */
const CLEAN_TAKES_DB = 10
/** The most a pause is dipped. */
const MOST_DIP_DB = 8
/** A window counts as room when it is no louder than the room by this much; a run of them is a print. */
const PRINT_MARGIN_DB = 3
/** A pause is dipped only where it is all room: nothing in it louder than the room by this much. */
const PAUSE_MARGIN_DB = 6
/** How much room the print gathers, and the shortest run it takes. */
const PRINT_SEC = 1.5
const LEAST_RUN_SEC = 0.15
/**
 * The dip starts this long after a word, is all the way down this much later,
 * and is back this long before the next: close, since a pause in a clip is
 * 0.2 to 0.3 s, and safe, since it is dipped only where it measured as room.
 */
const DIP_AFTER_SEC = 0.06
const DIP_RAMP_SEC = 0.03
const DIP_BEFORE_SEC = 0.03

/** The 10th percentile of levels: the room, where a recording rests between words. */
export function roomOf(levels: Float32Array[]): number {
  const all = levels.flatMap((l) => Array.from(l)).sort((a, b) => a - b)
  if (all.length === 0) return -120
  return all[Math.floor(0.1 * (all.length - 1))]
}

/**
 * The cut's stretches of sound, measured in one ffmpeg run: each read from its
 * recording, joined, put through EBU R128 for the loudness, then the level of
 * every 50 ms. Null when there is nothing to measure or it could not be read.
 */
export async function measureSound(ffmpeg: string, spans: SoundSpan[], signal?: AbortSignal): Promise<SoundLevels | null> {
  const kept = spans
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.srcSec >= WINDOW_SEC)
    .sort((a, b) => b.s.srcSec - a.s.srcSec)
    .slice(0, MOST_SPANS)
    .sort((a, b) => a.i - b.i)
    .map(({ s }) => s)
  if (kept.length === 0) return null
  // Each stretch exactly as long as it reads, in whole 16 kHz samples, so the levels split back by stretch.
  const samples = kept.map((s) => Math.max(1, Math.round(s.srcSec * RATE)))
  const inputs = kept.flatMap((s) => ['-ss', s.startSec.toFixed(3), '-t', (s.srcSec + 0.1).toFixed(3), '-vn', '-sn', '-dn', '-i', s.path])
  const chains = kept.map((s, k) => {
    const both = s.channel === undefined ? '' : `pan=stereo|c0=c${s.channel}|c1=c${s.channel},`
    return `[${k}:a]${both}aresample=48000,aformat=sample_fmts=flt:channel_layouts=stereo,apad,atrim=end_sample=${samples[k] * 3},asetpts=PTS-STARTPTS[m${k}]`
  })
  const joined = `${kept.map((_, k) => `[m${k}]`).join('')}concat=n=${kept.length}:v=0:a=1`
  const graph = [...chains, `${joined},ebur128=framelog=quiet,aresample=${RATE},pan=mono|c0=0.5*c0+0.5*c1[out]`].join(';')
  const args = ['-hide_banner', '-nostats', ...inputs, '-filter_complex', graph, '-map', '[out]', '-f', 'f32le', '-']

  // Squares summed per window, straight from the stream.
  const total = samples.reduce((a, b) => a + b, 0)
  const sums = new Float64Array(Math.ceil(total / WINDOW) + 1)
  let at = 0
  let stderr = ''
  const floats = new FloatReader()
  const r = await platform().run(ffmpeg, args, {
    signal,
    onBytes: (chunk) => {
      for (const v of floats.push(chunk)) {
        if (at < total) sums[Math.floor(at / WINDOW)] += v * v
        at++
      }
    },
    onStderr: (text) => (stderr = (stderr + text).slice(-8000))
  })
  if (r.code !== 0) return null
  const summary = stderr.slice(stderr.lastIndexOf('Integrated loudness:'))
  const lufs = Number(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(summary)?.[1] ?? NaN)
  // ebur128 says -70 for silence: there is no voice to set a level by.
  if (!Number.isFinite(lufs) || lufs <= -69) return null

  // Each stretch's windows: whole windows inside it, so none mixes two stretches.
  const out: SpanLevels[] = []
  let start = 0
  kept.forEach((span, k) => {
    const end = start + samples[k]
    const db: number[] = []
    for (let w = Math.ceil(start / WINDOW); (w + 1) * WINDOW <= end; w++) db.push(10 * Math.log10(sums[w] / WINDOW + 1e-12))
    out.push({ span, db: Float32Array.from(db) })
    start = end
  })
  return { lufs, roomDb: roomOf(out.map((s) => s.db)), spans: out }
}

/** What the render does with the sound. */
export interface SoundPlan {
  /** The loudness target, lowered when reaching it would turn the voice up more than MOST_BOOST_DB. Null leaves levels alone. */
  lufs: number | null
  /** Whether the target was lowered. */
  capped: boolean
  /** The room taken down: afftdn's reduction and its idea of the noise floor, in dB. Null leaves it. */
  clean: { reduceDb: number; floorDb: number } | null
  /** How far the pauses that are only room are dipped, in dB. */
  dipDb: number
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const tenth = (v: number): number => Math.round(v * 10) / 10

/**
 * How far to turn the voice up and how much room to take out, from what the
 * sound measured. `room` is for a voice in a room (edit/audio Voice.room):
 * the room comes up with the voice, so the more the voice is turned up, the
 * more of the room is taken out and the deeper the pauses are dipped.
 */
export function planSound(target: number | null, levels: SoundLevels | null, room: boolean): SoundPlan {
  if (!levels) return { lufs: target, capped: false, clean: null, dipDb: 0 }
  const capped = target !== null && target - levels.lufs > MOST_BOOST_DB
  const lufs = capped ? tenth(levels.lufs + MOST_BOOST_DB) : target
  if (!room) return { lufs, capped, clean: null, dipDb: 0 }
  const boost = lufs === null ? 0 : lufs - levels.lufs
  // Where the room would be heard: turned up with the voice, and a little more after a quiet stretch.
  const over = levels.roomDb + boost + RIDE_DB - ROOM_QUIET_DB
  if (over < LEAST_CLEAN_DB) return { lufs, capped, clean: null, dipDb: 0 }
  return {
    lufs,
    capped,
    clean: { reduceDb: tenth(Math.min(MOST_CLEAN_DB, over)), floorDb: tenth(clamp(levels.roomDb, -80, -20)) },
    dipDb: tenth(clamp(over - CLEAN_TAKES_DB, 0, MOST_DIP_DB))
  }
}

/** A stretch of a recording that is only room, for afftdn to learn the noise from. */
export interface PrintRun {
  path: string
  startSec: number
  sec: number
  channel?: 0 | 1
}

/**
 * The longest stretches that are only room, up to PRINT_SEC in all: runs of
 * windows no louder than the room by PRINT_MARGIN_DB, a window short of each
 * end so no word's edge comes in, in recording order.
 */
export function printRuns(levels: SoundLevels): PrintRun[] {
  const limit = levels.roomDb + PRINT_MARGIN_DB
  const runs: (PrintRun & { order: number })[] = []
  levels.spans.forEach(({ span, db }, k) => {
    let from = -1
    const close = (to: number): void => {
      // A window off each end.
      const a = from + 1
      const b = to - 1
      if ((b - a) * WINDOW_SEC >= LEAST_RUN_SEC)
        runs.push({
          path: span.path,
          startSec: span.startSec + a * WINDOW_SEC,
          sec: (b - a) * WINDOW_SEC,
          ...(span.channel === undefined ? {} : { channel: span.channel }),
          order: k * 1e6 + a
        })
      from = -1
    }
    for (let i = 0; i < db.length; i++) {
      if (db[i] <= limit) {
        if (from < 0) from = i
      } else if (from >= 0) close(i)
    }
    if (from >= 0) close(db.length)
  })
  const picked: typeof runs = []
  let sum = 0
  for (const run of [...runs].sort((a, b) => b.sec - a.sec)) {
    if (sum >= PRINT_SEC) break
    const sec = Math.min(run.sec, PRINT_SEC - sum)
    if (sec < LEAST_RUN_SEC) break
    picked.push({ ...run, sec })
    sum += sec
  }
  return picked.sort((a, b) => a.order - b.order).map(({ order: _o, ...run }) => run)
}

/**
 * The print as a file: the runs read and joined, at 48 kHz stereo, each
 * eased in and out over 5 ms so the joins do not click. Its length in
 * samples, which the render needs to take it off again; null when it could
 * not be made.
 */
export async function writePrint(ffmpeg: string, runs: PrintRun[], outPath: string, signal?: AbortSignal): Promise<number | null> {
  if (runs.length === 0) return null
  const samples = runs.map((r) => Math.round(r.sec * 48000))
  const inputs = runs.flatMap((r) => ['-ss', r.startSec.toFixed(3), '-t', (r.sec + 0.1).toFixed(3), '-vn', '-sn', '-dn', '-i', r.path])
  const chains = runs.map((r, k) => {
    const both = r.channel === undefined ? '' : `pan=stereo|c0=c${r.channel}|c1=c${r.channel},`
    const sec = samples[k] / 48000
    return (
      `[${k}:a]${both}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${samples[k]},asetpts=PTS-STARTPTS,` +
      `afade=t=in:d=0.005,afade=t=out:st=${Math.max(0, sec - 0.005).toFixed(6)}:d=0.005[p${k}]`
    )
  })
  const graph = [...chains, `${runs.map((_, k) => `[p${k}]`).join('')}concat=n=${runs.length}:v=0:a=1[out]`].join(';')
  const r = await platform().run(
    ffmpeg,
    ['-hide_banner', '-nostats', '-y', ...inputs, '-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_f32le', outPath],
    { signal }
  )
  return r.code === 0 ? samples.reduce((a, b) => a + b, 0) : null
}

/**
 * The voice's level over the video: down by `dipDb` in each pause between
 * words that is only room, from DIP_AFTER_SEC after a word to DIP_BEFORE_SEC
 * before the next, as straight ramps: a pause of 0.2 s is long enough. A pause with anything in it louder
 * than the room (a breath, laughter, an amen) is left alone, as is one the
 * measuring did not reach. Empty when nothing dips.
 */
export function pauseKeys(
  words: { outStart: number; outEnd: number }[],
  levels: SoundLevels,
  dipDb: number,
  durationSec: number
): LevelKey[] {
  if (dipDb <= 0) return []
  const limit = levels.roomDb + PAUSE_MARGIN_DB
  // Every measured window on the output clock.
  const windows: { a: number; b: number; db: number }[] = []
  for (const { span, db } of levels.spans) {
    const k = span.outSec / span.srcSec
    for (let i = 0; i < db.length; i++)
      windows.push({ a: span.outStart + i * WINDOW_SEC * k, b: span.outStart + (i + 1) * WINDOW_SEC * k, db: db[i] })
  }
  windows.sort((x, y) => x.a - y.a)
  const onlyRoom = (a: number, b: number): boolean => {
    const inside = windows.filter((w) => w.b > a && w.a < b)
    // Measured all the way across, and quiet all the way across.
    const covered = inside.length > 0 && inside[0].a <= a + WINDOW_SEC && inside[inside.length - 1].b >= b - WINDOW_SEC
    return covered && inside.every((w) => w.db <= limit)
  }
  const sorted = [...words].sort((a, b) => a.outStart - b.outStart)
  const keys: LevelKey[] = []
  const gaps: [number, number][] = []
  if (sorted.length === 0) return []
  gaps.push([0, sorted[0].outStart - DIP_BEFORE_SEC])
  for (let i = 1; i < sorted.length; i++) gaps.push([sorted[i - 1].outEnd + DIP_AFTER_SEC, sorted[i].outStart - DIP_BEFORE_SEC])
  gaps.push([sorted[sorted.length - 1].outEnd + DIP_AFTER_SEC, durationSec])
  for (const [a, b] of gaps) {
    if (b - a < 2 * DIP_RAMP_SEC + WINDOW_SEC - 1e-9 || !onlyRoom(a, b)) continue
    const last = keys[keys.length - 1]
    // Pauses never overlap, since words do not; one that starts where the last ended carries on down.
    if (last && last.t >= a) continue
    keys.push({ t: a, db: 0 }, { t: a + DIP_RAMP_SEC, db: -dipDb }, { t: b - DIP_RAMP_SEC, db: -dipDb }, { t: b, db: 0 })
  }
  return keys
}
