import type { EditDoc } from '../shared/edit'
import { CLIP_HIGH_Y, CLIP_LOW_Y, combineReadings, ire, SAT_FULL, type ScopeReading } from '../shared/scopes/maths'
import { platform } from './platform'

/**
 * What a recording's picture measures, for Claude to grade by: ffmpeg's
 * signalstats at a few frames across it (luma's extremes, its 10th and 90th
 * percentiles and its mean, the mean of U and V, the mean saturation), and
 * the share of each frame blown to white or crushed to black, counted from
 * the same frame's luma. Measured when footage comes in (cut-work
 * readFootage) and kept on the source; for an edit made before, at its first
 * plan, and kept here for the file as it is. It runs ffmpeg through the
 * platform (main/platform), as the rest of the shared work does.
 */

/** Frames measured, as shares of the way through. */
const AT = [0.1, 0.3, 0.5, 0.7, 0.9]
/** Each frame is measured this wide: enough for the numbers, quick to read. */
const WIDTH = 256

/** signalstats' numbers for one frame, by name (YMIN, YLOW, YAVG, YHIGH, YMAX, UAVG, VAVG, SATAVG...). */
export function parseSignalstats(log: string): Record<string, number>[] {
  const frames: Record<string, number>[] = []
  let now: Record<string, number> | null = null
  for (const line of log.split(/\r?\n/)) {
    if (/\bframe:\s*\d+/.test(line) && /pts/.test(line)) {
      now = {}
      frames.push(now)
      continue
    }
    const m = /lavfi\.signalstats\.([A-Z]+)=(-?[\d.]+)/.exec(line)
    if (m) {
      if (!now) {
        now = {}
        frames.push(now)
      }
      now[m[1]] = Number(m[2])
    }
  }
  return frames.filter((f) => Object.keys(f).length > 0)
}

/** ffmpeg's arguments for one frame at `at` seconds: its stats to the log, its luma, U and V planes to stdout. */
export function scopeArgs(path: string, at: number): string[] {
  return [
    '-hide_banner',
    '-nostats',
    '-ss',
    Math.max(0, at).toFixed(3),
    '-i',
    path,
    '-an',
    '-frames:v',
    '1',
    '-vf',
    `scale=${WIDTH}:-2:flags=area:out_range=tv,format=yuv444p,signalstats,metadata=mode=print`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'yuv444p',
    'pipe:1'
  ]
}

async function run(ffmpeg: string, args: string[]): Promise<{ out: Uint8Array; log: string; ok: boolean }> {
  const parts: Uint8Array[] = []
  let log = ''
  try {
    const r = await platform().run(ffmpeg, args, { onBytes: (b) => parts.push(b), onStderr: (t) => (log += t) })
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      out.set(p, at)
      at += p.length
    }
    return { out, log: log || r.stderr, ok: r.code === 0 }
  } catch {
    return { out: new Uint8Array(0), log, ok: false }
  }
}

/** One frame's reading, or null when it could not be read. */
async function frameReading(ffmpeg: string, path: string, at: number): Promise<ScopeReading | null> {
  const { out, log, ok } = await run(ffmpeg, scopeArgs(path, at))
  const stats = parseSignalstats(log)[0]
  if (!ok || !stats || stats.YAVG === undefined) return null
  // The luma plane comes first: count what sits at white and at black.
  const h = Math.floor(out.length / (WIDTH * 3))
  const pixels = WIDTH * h
  let high = 0
  let low = 0
  for (let i = 0; i < pixels; i++) {
    const y = out[i]
    if (y >= CLIP_HIGH_Y) high++
    if (y <= CLIP_LOW_Y) low++
  }
  return {
    lumaMin: ire(stats.YMIN),
    lumaMax: ire(stats.YMAX),
    lumaLow: ire(stats.YLOW),
    lumaHigh: ire(stats.YHIGH),
    lumaAvg: ire(stats.YAVG),
    clipHigh: pixels ? (high / pixels) * 100 : 0,
    clipLow: pixels ? (low / pixels) * 100 : 0,
    sat: ((stats.SATAVG ?? 0) / SAT_FULL) * 100,
    u: (stats.UAVG ?? 128) - 128,
    v: (stats.VAVG ?? 128) - 128,
    frames: 1
  }
}

/** A recording's reading across a few frames, or null when none could be read. */
export async function measureScopes(ffmpeg: string, path: string, durationSec: number): Promise<ScopeReading | null> {
  const times = durationSec > 0.5 ? AT.map((f) => f * durationSec) : [0]
  const readings: ScopeReading[] = []
  for (const at of times) {
    const r = await frameReading(ffmpeg, path, at)
    if (r) readings.push(r)
  }
  const all = combineReadings(readings)
  return all ? round(all) : null
}

const round = (r: ScopeReading): ScopeReading =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'frames' ? v : Math.round(v * 100) / 100])) as ScopeReading

/** Readings made at a plan, by file as it was when measured, for edits whose sources were brought in before scopes. */
const measured = new Map<string, ScopeReading | null>()

async function fileKey(path: string): Promise<string | null> {
  try {
    const st = await platform().files.stat(path)
    return st && !st.directory ? `${path} ${st.mtimeMs} ${st.size}` : null
  } catch {
    return null
  }
}

/**
 * The edit with every recording's reading: those it has kept, and for the
 * rest, ones measured now (or at an earlier plan of the same file). A file
 * that is not there, or a machine that cannot measure, leaves it without.
 */
export async function withScopes(doc: EditDoc, ffmpeg?: string): Promise<EditDoc> {
  if (doc.sources.every((s) => s.scopes)) return doc
  try {
    // A phone runs ffmpeg inside the app, without the filters' log this reads: it plans without scopes for now.
    if (!ffmpeg && platform().kind === 'phone') return doc
    const bin = ffmpeg ?? platform().tool('ffmpeg')
    const sources = await Promise.all(
      doc.sources.map(async (s) => {
        if (s.scopes) return s
        const key = await fileKey(s.path)
        if (!key) return s
        if (!measured.has(key)) measured.set(key, await measureScopes(bin, s.path, s.durationSec).catch(() => null))
        const r = measured.get(key)
        return r ? { ...s, scopes: r } : s
      })
    )
    return { ...doc, sources }
  } catch {
    return doc
  }
}
