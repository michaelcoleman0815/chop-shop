import type { Word } from '../edit/schema'
import { BANDS, HOP_SEC, type Features } from './features'

/**
 * Band energies for recordings that were never recorded: each word gets a
 * sound of its own (smooth in time and across bands, like a syllable), the
 * pauses get a quiet room, and a finished video is made by copying stretches
 * of those frames, louder, with a bed laid under them. Two takes of the same
 * line get different sounds, as they do when a person says it twice.
 *
 * Used by the tests and by the browser preview's stand-in for the main
 * process, so the real alignment runs on both without any audio.
 */

export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

const toPower = (db: number): number => 10 ** (db / 10)
const toDb = (p: number): number => 10 * Math.log10(p + 1e-12)

/** The sound of a recording whose words are known, with `voice` telling takes apart. */
export function synthRecording(
  words: Pick<Word, 'id' | 'startSec' | 'endSec'>[],
  durationSec: number,
  voice: (w: Pick<Word, 'id'>) => string = (w) => w.id
): Features {
  const frames = Math.ceil(durationSec / HOP_SEC)
  const data = new Float32Array(frames * BANDS)
  const room = seeded(hash('room' + durationSec))
  for (let i = 0; i < data.length; i++) data[i] = -72 + 3 * room()
  for (const w of words) {
    const a = Math.max(0, Math.floor(w.startSec / HOP_SEC))
    const b = Math.min(frames, Math.ceil(w.endSec / HOP_SEC))
    const r = seeded(hash(voice(w)))
    // A coarse grid of levels, every 4 frames and every 3 bands, smoothed between.
    const gt = Math.ceil((b - a) / 4) + 2
    const gb = Math.ceil(BANDS / 3) + 2
    const grid = Array.from({ length: gt * gb }, () => -38 + 26 * r())
    for (let t = a; t < b; t++) {
      const env = Math.sin((Math.PI * (t - a + 0.5)) / Math.max(1, b - a))
      for (let band = 0; band < BANDS; band++) {
        const x = (t - a) / 4
        const y = band / 3
        const x0 = Math.floor(x)
        const y0 = Math.floor(y)
        const fx = x - x0
        const fy = y - y0
        const g = (i: number, j: number): number => grid[Math.min(gt - 1, i) * gb + Math.min(gb - 1, j)]
        const level =
          g(x0, y0) * (1 - fx) * (1 - fy) +
          g(x0 + 1, y0) * fx * (1 - fy) +
          g(x0, y0 + 1) * (1 - fx) * fy +
          g(x0 + 1, y0 + 1) * fx * fy
        const v = level + 20 * Math.log10(Math.max(0.05, env)) - 4 * (band / BANDS)
        data[t * BANDS + band] = toDb(toPower(data[t * BANDS + band]) + toPower(v))
      }
    }
  }
  return { hopSec: HOP_SEC, bands: BANDS, frames, data }
}

export interface SynthPiece {
  rec: number
  rawStart: number
  rawEnd: number
}

/**
 * A finished video cut from recordings: the pieces in order, each `gainDb`
 * louder, with a bed `bedDb` loud (in each band) and slowly moving laid under
 * the whole thing, and `leadSec` of bed alone before the first piece.
 */
export function synthFinished(
  recordings: Features[],
  pieces: SynthPiece[],
  opts: { gainDb?: number; bedDb?: number | null; leadSec?: number; seed?: number } = {}
): { features: Features; outStarts: number[] } {
  const gain = opts.gainDb ?? 0
  const lead = Math.round((opts.leadSec ?? 0) / HOP_SEC)
  const parts = pieces.map((p) => ({
    ...p,
    a: Math.round(p.rawStart / HOP_SEC),
    b: Math.round(p.rawEnd / HOP_SEC)
  }))
  const frames = lead + parts.reduce((n, p) => n + (p.b - p.a), 0)
  const data = new Float32Array(frames * BANDS)
  for (let i = 0; i < lead * BANDS; i++) data[i] = -90
  const outStarts: number[] = []
  let at = lead
  for (const p of parts) {
    outStarts.push(at * HOP_SEC)
    const src = recordings[p.rec]
    for (let t = p.a; t < p.b; t++, at++) {
      for (let band = 0; band < BANDS; band++) {
        data[at * BANDS + band] = (t < src.frames ? src.data[t * BANDS + band] : -90) + gain
      }
    }
  }
  if (opts.bedDb !== null && opts.bedDb !== undefined) {
    const r = seeded(opts.seed ?? 99)
    const phase = Array.from({ length: BANDS }, () => r() * Math.PI * 2)
    for (let t = 0; t < frames; t++) {
      for (let band = 0; band < BANDS; band++) {
        const bed = opts.bedDb + 4 * Math.sin(t / 37 + phase[band]) + 2 * (r() - 0.5)
        data[t * BANDS + band] = toDb(toPower(data[t * BANDS + band]) + toPower(bed))
      }
    }
  }
  return { features: { hopSec: HOP_SEC, bands: BANDS, frames, data }, outStarts }
}
