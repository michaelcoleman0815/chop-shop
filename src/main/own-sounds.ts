import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, extname, join, relative } from 'path'
import { bestSounds, fitOf, landOf, OwnSoundSchema, pickable, soundKindOf, SOUND_KINDS, type OwnSound, type SoundKind } from '../shared/sounds'

/**
 * The person's own sounds, read for the planner (shared/sounds): every short sound file in their sounds folders,
 * with what it is, how long it sounds and where its moment falls. Each file is measured once and remembered by its
 * size and date, so opening a chat reads nothing but a list.
 *
 * A file kept only in iCloud (a placeholder, with nothing of it on this Mac) is left alone: reading it would
 * download it.
 */

const SOUND_FILE = /\.(wav|mp3|m4a|aif|aiff|flac|ogg|caf)$/i
/** Longer than this is music or a recording, not an effect. */
const MAX_SEC = 8
/** How many of a kind are measured to choose from, taken evenly from all the folders they are in. */
const MEASURED_OF_KIND = 60
const RATE = 48000

/** The name a person would call a file: no library codes, take numbers in brackets or file type. */
export function soundName(file: string): string {
  const name = basename(file, extname(file))
    .replace(/^ES[_ ]/, '')
    .replace(/ - SFX Producer\b/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (name || basename(file)).slice(0, 80)
}

/** What a sound's samples say: how long it sounds, its silence before, its loudest moment and its loudest sample. */
export function measureSamples(x: Float32Array): { sec: number; leadSec: number; peakAt: number; peakDb: number; hits: number } | null {
  const hop = RATE / 200
  const n = Math.floor(x.length / hop)
  if (n < 2) return null
  const env = new Float32Array(n)
  let peak = 0
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = i * hop; j < (i + 1) * hop; j++) {
      sum += x[j] * x[j]
      peak = Math.max(peak, Math.abs(x[j]))
    }
    env[i] = Math.sqrt(sum / hop)
  }
  let at = 0
  for (let i = 1; i < n; i++) if (env[i] > env[at]) at = i
  if (peak < 1e-4) return null
  // It sounds from where it is within 40 dB of its loudest to where it last is.
  const floor = env[at] * 0.01
  const from = env.findIndex((v) => v > floor)
  let to = n - 1
  while (to > from && env[to] <= floor) to--
  // Attacks: the level jumping, at least 80 ms apart.
  let hits = 0
  let last = -99
  for (let i = 1; i < n; i++)
    if (env[i] > 0.35 * env[at] && env[i] > 1.8 * env[Math.max(0, i - 4)] && i - last > 16) {
      hits++
      last = i
    }
  return {
    hits,
    sec: (to + 1 - from) / 200,
    leadSec: from / 200,
    peakAt: (at - from) / 200,
    peakDb: Math.max(-120, Math.min(0, 20 * Math.log10(peak)))
  }
}

function decode(ffmpeg: string, path: string): Promise<Float32Array> {
  return new Promise((resolve, reject) =>
    execFile(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', path, '-t', String(MAX_SEC + 4), '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'],
      { encoding: 'buffer', maxBuffer: 64 << 20 },
      (err, out) => (err ? reject(err) : resolve(new Float32Array(out.buffer, out.byteOffset, Math.floor(out.length / 4)).slice()))
    )
  )
}

interface Found {
  path: string
  size: number
  mtime: number
}

/** The sound files in a folder, three folders down, leaving out what is only in iCloud. */
async function filesIn(root: string, depth = 0): Promise<Found[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const out: Found[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const path = join(root, e.name)
    if (e.isDirectory() && depth < 3) out.push(...(await filesIn(path, depth + 1)))
    else if (e.isFile() && SOUND_FILE.test(e.name)) {
      const st = await fs.stat(path).catch(() => null)
      if (st && st.size > 0 && (st.blocks === undefined || st.blocks > 0)) out.push({ path, size: st.size, mtime: Math.round(st.mtimeMs) })
    }
  }
  return out
}

interface Kept extends Found {
  /** What was measured; null for a file that could not be read, or is no effect. */
  sound: (OwnSound & { fit: number }) | null
}

/** One file, read: null when it is too long to be an effect, silent, or no sound at all. */
export async function readOwnSound(ffmpeg: string, path: string, kind: SoundKind): Promise<(OwnSound & { fit: number }) | null> {
  const x = await decode(ffmpeg, path).catch(() => null)
  const m = x && measureSamples(x)
  if (!m || m.sec > MAX_SEC || m.leadSec > 30) return null
  return {
    path,
    name: soundName(path),
    kind,
    sec: m.sec,
    leadSec: m.leadSec,
    landSec: landOf(kind, m.sec, m.peakAt),
    peakDb: m.peakDb,
    fit: fitOf(kind, { sec: m.sec, peakAt: m.peakAt, hits: Math.max(1, m.hits), peakDb: m.peakDb }) ?? 0
  }
}

/** `n` of a list, spread evenly over it. */
const spread = <T>(list: T[], n: number): T[] => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]))

/**
 * The best of the person's own sounds, kind by kind (shared/sounds bestSounds): sorted by name, the likely ones
 * measured, and what was measured remembered in `index` by each file's size and date.
 */
export async function ownSounds(ffmpeg: string, folders: string[], index: string): Promise<OwnSound[]> {
  const found = (
    await Promise.all(
      folders.map(async (root) =>
        (await filesIn(root)).map((f) => {
          const folder = basename(dirname(f.path))
          return {
            ...f,
            kind: soundKindOf(soundName(f.path), folder),
            theirs: (SOUND_KINDS as readonly string[]).includes(folder.toLowerCase()),
            ok: pickable(relative(root, f.path))
          }
        })
      )
    )
  ).flat()
  const likely = SOUND_KINDS.filter((k) => k !== 'other').flatMap((kind) => {
    const of = found.filter((f) => f.kind === kind && (f.ok || f.theirs)).sort((a, b) => a.path.localeCompare(b.path))
    return [...of.filter((f) => f.theirs), ...spread(of.filter((f) => !f.theirs), MEASURED_OF_KIND)]
  })
  if (likely.length === 0) return []
  const kept = new Map<string, Kept>()
  const saved = await fs.readFile(index, 'utf8').then((t) => JSON.parse(t) as unknown, () => null)
  for (const k of Array.isArray(saved) ? (saved as Kept[]) : [])
    if (k && typeof k.path === 'string' && (k.sound === null || OwnSoundSchema.safeParse(k.sound).success)) kept.set(k.path, k)
  let changed = likely.length !== kept.size
  const out: (Kept & { theirs: boolean })[] = []
  const queue = [...likely]
  const work = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const had = kept.get(f.path)
      const same = had && had.size === f.size && had.mtime === f.mtime && (had.sound === null || had.sound.kind === f.kind)
      if (!same) changed = true
      const sound = same ? had.sound : await readOwnSound(ffmpeg, f.path, f.kind)
      out.push({ path: f.path, size: f.size, mtime: f.mtime, sound, theirs: f.theirs })
    }
  }
  await Promise.all(Array.from({ length: 6 }, work))
  if (changed) {
    const part = `${index}.part`
    const text = JSON.stringify(out.map(({ theirs: _theirs, ...k }) => k))
    await fs.mkdir(dirname(index), { recursive: true }).catch(() => undefined)
    await fs.writeFile(part, text).then(() => fs.rename(part, index)).catch(() => undefined)
  }
  return bestSounds(out.flatMap((k) => (k.sound ? [{ ...k.sound, theirs: k.theirs }] : [])))
}
