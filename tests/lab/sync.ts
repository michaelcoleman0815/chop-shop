/**
 * How far one recording's sound sits from another's, and whether that drifts:
 * the app's own estimateOffset (shared/audio/offset) over the whole overlap,
 * then again window by window around that offset, with a line fitted through
 * the windows' offsets. For POVs of one session that share a voice chat.
 *
 *   node scripts/lab.mjs sync <out.json> <a> <b> [windowSec=60]
 *
 * Each file can be a short excerpt (say ten minutes of each POV). The offset
 * means: the moment at time t in a is at t + offsetSec in b.
 */
import { writeFileSync } from 'fs'
import { loudnessEnvelope } from '../../src/main/audio-envelope'
import { FFMPEG_PATH } from '../../src/main/ffmpeg'
import { estimateOffset, trustworthy, type Offset } from '../../src/shared/audio/offset'
import type { Envelope } from '../../src/shared/audio/snap'
import { fail } from './handlers'

function slice(env: Envelope, fromSec: number, toSec: number): Envelope {
  const a = Math.max(0, Math.round(fromSec / env.hopSec))
  const b = Math.min(env.db.length, Math.round(toSec / env.hopSec))
  return { hopSec: env.hopSec, db: Float32Array.from({ length: Math.max(0, b - a) }, (_, i) => env.db[a + i]) }
}

/** A least-squares line through (t, offset), and the spread about it. */
function fit(points: { t: number; offsetSec: number }[]): { slope: number; intercept: number; residualSec: number } | null {
  if (points.length < 2) return null
  const n = points.length
  const mt = points.reduce((s, p) => s + p.t, 0) / n
  const mo = points.reduce((s, p) => s + p.offsetSec, 0) / n
  let num = 0
  let den = 0
  for (const p of points) {
    num += (p.t - mt) * (p.offsetSec - mo)
    den += (p.t - mt) ** 2
  }
  const slope = den > 0 ? num / den : 0
  const intercept = mo - slope * mt
  const residualSec = Math.sqrt(points.reduce((s, p) => s + (p.offsetSec - (intercept + slope * p.t)) ** 2, 0) / n)
  return { slope, intercept, residualSec }
}

const round = (x: number, k = 1000): number => Math.round(x * k) / k

async function main(): Promise<void> {
  const [out, aPath, bPath, windowArg] = process.argv.slice(2)
  if (!out || !aPath || !bPath) throw new Error('usage: sync <out.json> <a> <b> [windowSec]')
  const windowSec = Number(windowArg ?? 60)
  const a = await loudnessEnvelope(FFMPEG_PATH, aPath)
  const b = await loudnessEnvelope(FFMPEG_PATH, bPath)
  const whole = estimateOffset(a, b)
  const windows: { t: number; offset: Offset | null; trusted: boolean }[] = []
  const aSec = a.db.length * a.hopSec
  if (whole) {
    for (let t = 0; t + windowSec <= aSec + 1e-6; t += windowSec) {
      // The window, found in b within a few seconds of the whole offset.
      const from = t + whole.offsetSec - 5
      const piece = slice(b, Math.max(0, from), t + windowSec + whole.offsetSec + 5)
      const o = estimateOffset(slice(a, t, t + windowSec), piece, { maxLagSec: windowSec + 10 })
      const offset = o ? { ...o, offsetSec: round(o.offsetSec + Math.max(0, from) - t) } : null
      windows.push({ t, offset, trusted: trustworthy(offset) })
    }
  }
  const trusted = windows.filter((w) => w.trusted && w.offset).map((w) => ({ t: w.t + windowSec / 2, offsetSec: (w.offset as Offset).offsetSec }))
  const line = fit(trusted)
  const result = {
    aSec: round(aSec, 10),
    bSec: round(b.db.length * b.hopSec, 10),
    whole,
    trustedWhole: trustworthy(whole),
    windowSec,
    windows: windows.map((w) => ({ t: w.t, ...(w.offset ?? {}), trusted: w.trusted })),
    drift: line
      ? { ppm: round(line.slope * 1e6, 10), msPerHour: round(line.slope * 3600 * 1000, 10), residualMs: round(line.residualSec * 1000, 10), windows: trusted.length }
      : null
  }
  writeFileSync(out, JSON.stringify(result, null, 1))
  process.stderr.write(
    whole
      ? `offset ${whole.offsetSec.toFixed(3)} s, confidence ${whole.confidence.toFixed(2)}, margin ${whole.margin.toFixed(2)}, ` +
          `${trusted.length} of ${windows.length} windows trusted` +
          (result.drift ? `, drift ${result.drift.msPerHour} ms an hour (spread ${result.drift.residualMs} ms)` : '') +
          '\n'
      : 'no overlap long enough to say\n'
  )
}

main().catch(fail)
