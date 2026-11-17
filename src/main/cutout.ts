import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { pictureSpan, type Cut, type Resolved, type Source } from '../shared/edit'
import { cutoutFor, effectsOf, followObjects, type CutoutKind, type CutoutSample, type CutoutTrack } from '../shared/fx'

/**
 * Cut-outs of a recording, for the effects that use them: the person, or
 * the objects in the picture, as masks a few times a second.
 *
 * On a Mac they come from Vision through the helper that already finds faces
 * (src/native/vision.swift, --masks), the same way detectFaces asks it
 * (main/track.ts). Anything that can answer the same way can stand in: the
 * tests use shapes. Masks are kept beside the recording's other analysis,
 * keyed by the file and when it last changed, and a stretch already cut out
 * is never asked for again. Without the helper (the phone, Windows, Linux)
 * there are none, and every effect does its version that needs none.
 */

export interface CutoutRequest {
  video: string
  kind: CutoutKind
  startSec: number
  durationSec: number
  /** Samples a second. */
  rate: number
  /** Where the masks are written. */
  outDir: string
  /** The masks' long side, in pixels. */
  size: number
}

/** What a helper answers: masks, numbered the way it found them. */
export interface CutoutAnswer {
  width: number
  height: number
  samples: CutoutSample[]
}

/** Whatever makes cut-outs: the Mac's Vision, or a stand-in. */
export interface CutoutHelper {
  /** What it can cut out on this computer. */
  can(): Promise<{ person: boolean; objects: boolean }>
  find(req: CutoutRequest, signal?: AbortSignal): Promise<CutoutAnswer>
}

/** How often each kind is sampled, and how big its masks are. Objects cost Vision more. */
export const CUTOUT_RATE: Record<CutoutKind, number> = { person: 10, objects: 6 }
export const CUTOUT_SIZE = 512

/** Runs the helper and reads the JSON it prints. */
function ask(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `vision exit ${code}`))))
  })
}

/** chopshop-vision --masks: Vision's person segmentation, and its foreground instance masks for objects. */
export function visionHelper(bin: string): CutoutHelper {
  let known: Promise<{ person: boolean; objects: boolean }> | null = null
  return {
    can: () => {
      if (!known)
        known =
          existsSync(bin)
            ? ask(bin, ['--masks-check'])
                .then((json) => {
                  const r = JSON.parse(json) as { person?: unknown; objects?: unknown }
                  return { person: r.person === true, objects: r.objects === true }
                })
                // A helper from before cut-outs fails the check: it has none.
                .catch(() => ({ person: false, objects: false }))
            : Promise.resolve({ person: false, objects: false })
      return known
    },
    find: async (req, signal) => {
      const json = await ask(
        bin,
        [
          '--masks',
          req.kind,
          req.video,
          req.outDir,
          req.startSec.toFixed(3),
          req.durationSec.toFixed(3),
          String(req.rate),
          String(req.size)
        ],
        signal
      )
      return JSON.parse(json) as CutoutAnswer
    }
  }
}

async function keyFor(path: string): Promise<string> {
  const stat = await fs.stat(path)
  return createHash('sha1').update(`${path} ${stat.mtimeMs} ${stat.size}`).digest('hex').slice(0, 16)
}

/** Where a recording's cut-outs of a kind are kept. */
async function folderFor(dir: string, path: string, kind: CutoutKind): Promise<string> {
  return join(dir, await keyFor(path), kind)
}

/** A recording's cut-outs of a kind, as kept; null when there are none yet or the file has changed. */
export async function readCutouts(dir: string, path: string, kind: CutoutKind): Promise<CutoutTrack | null> {
  try {
    const folder = await folderFor(dir, path, kind)
    const track = JSON.parse(await fs.readFile(join(folder, 'track.json'), 'utf8')) as CutoutTrack
    return track.path === path && track.kind === kind ? track : null
  } catch {
    return null
  }
}

/** The stretches of a track's recording it covers, from its samples: a gap over twice the spacing ends one. */
export function covered(track: CutoutTrack | null, rate: number): { from: number; to: number }[] {
  if (!track || track.samples.length === 0) return []
  const out: { from: number; to: number }[] = []
  const gap = 2 / rate + 1e-3
  for (const s of track.samples) {
    const last = out[out.length - 1]
    if (last && s.t - last.to <= gap) last.to = s.t
    else out.push({ from: s.t, to: s.t })
  }
  return out
}

/** What of [from, to] is not yet covered. */
export function missing(have: { from: number; to: number }[], from: number, to: number, rate: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  let at = from
  for (const h of [...have].sort((a, b) => a.from - b.from)) {
    if (h.to < at - 1 / rate) continue
    if (h.from > to) break
    if (h.from > at + 1 / rate) out.push({ from: at, to: Math.min(to, h.from) })
    at = Math.max(at, h.to)
  }
  if (at < to - 1 / rate) out.push({ from: at, to })
  return out
}

/**
 * A recording's cut-outs of a kind across a stretch of it, made where they
 * are not kept yet and kept with the rest. Objects are followed from sample
 * to sample, so each keeps one id however Vision numbered them.
 */
export async function findCutouts(opts: {
  dir: string
  helper: CutoutHelper
  path: string
  kind: CutoutKind
  from: number
  to: number
  signal?: AbortSignal
}): Promise<CutoutTrack> {
  const { kind, path } = opts
  const rate = CUTOUT_RATE[kind]
  const folder = await folderFor(opts.dir, path, kind)
  await fs.mkdir(folder, { recursive: true })
  const kept = await readCutouts(opts.dir, path, kind)
  const gaps = missing(covered(kept, rate), Math.max(0, opts.from), opts.to, rate)
  if (gaps.length === 0 && kept) return kept
  let width = kept?.width ?? 0
  let height = kept?.height ?? 0
  const fresh: CutoutSample[] = []
  for (const g of gaps) {
    const answer = await opts.helper.find(
      { video: path, kind, startSec: g.from, durationSec: Math.max(1 / rate, g.to - g.from), rate, outDir: folder, size: CUTOUT_SIZE },
      opts.signal
    )
    if (answer.width > 0 && answer.height > 0) {
      width = answer.width
      height = answer.height
    }
    fresh.push(...answer.samples)
  }
  // Samples from every pass, in order, the same moment once; objects followed through all of them.
  const byTime = new Map<string, CutoutSample>()
  for (const s of [...(kept?.samples ?? []), ...fresh]) byTime.set(s.t.toFixed(3), s)
  const samples = [...byTime.values()].sort((a, b) => a.t - b.t)
  const track: CutoutTrack = {
    path,
    kind,
    width,
    height,
    samples: kind === 'objects' ? followObjects(samples) : samples
  }
  await fs.writeFile(join(folder, 'track.json.tmp'), JSON.stringify(track))
  await fs.rename(join(folder, 'track.json.tmp'), join(folder, 'track.json'))
  return track
}

/** One stretch of a recording an effect shows, and the kind of cut-out it wants of it. */
export interface CutoutNeed {
  path: string
  kind: CutoutKind
  from: number
  to: number
}

/**
 * What an edit's effects want cut out: for each effect that uses a
 * cut-out, the stretches of the recordings its span shows, a little either
 * side, merged per recording and kind.
 */
export function cutoutNeeds(cut: Cut, resolved: Resolved, sources: Source[], spans: { id: string; start: number; end: number }[]): CutoutNeed[] {
  const wants: CutoutNeed[] = []
  for (const item of effectsOf(cut)) {
    const span = spans.find((s) => s.id === item.id)
    if (!span) continue
    const kind = cutoutFor(item)
    if (!kind) continue
    for (const p of resolved.pieces) {
      const pic = pictureSpan(p)
      if (pic.outEnd <= span.start || pic.outStart >= span.end) continue
      const beat = cut.beats.find((b) => b.id === p.beat)
      const source = sources.find((s) => s.id === p.source)
      if (!beat || !source || beat.treatment.frame !== 'speaker') continue
      const lo = Math.min(pic.srcStart, pic.srcEnd)
      const hi = Math.max(pic.srcStart, pic.srcEnd)
      wants.push({ path: source.path, kind, from: Math.max(0, lo - 0.25), to: Math.min(source.durationSec || hi + 0.25, hi + 0.25) })
    }
  }
  // One stretch per recording and kind where they touch.
  const merged: CutoutNeed[] = []
  for (const w of wants.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind) || a.from - b.from)) {
    const last = merged[merged.length - 1]
    if (last && last.path === w.path && last.kind === w.kind && w.from <= last.to + 0.5) last.to = Math.max(last.to, w.to)
    else merged.push({ ...w })
  }
  return merged
}
