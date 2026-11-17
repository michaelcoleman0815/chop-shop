import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import { dirname, join, relative, resolve } from 'path'
import { createInterface } from 'readline'
import {
  audioRole,
  cubeHead,
  frameName,
  lottieHead,
  MIN_SEQUENCE_FRAMES,
  overlayWords,
  sequencePattern,
  tagsFor,
  UNSUPPORTED,
  type FrameName,
  type LibraryKind
} from '../../../shared/broll/files'
import { imageHead } from '../../../shared/broll/image-head'
import type { ProbeInfo } from '../../../shared/broll/probe'
import { overlap, stems } from '../../../shared/broll/text'
import { emptyReport, walk, type WalkedFile, type WalkReport } from './walk'

/**
 * The person's own folder of assets as an index: every video, picture,
 * overlay with transparency, image sequence, sound effect, music track,
 * LUT, font and Lottie animation in it, filed under the words of its
 * folders and name, with its length, size, transparency and loudness.
 *
 * Scanning again is incremental: a file whose size and modification time
 * have not changed keeps what was measured before, so only new and changed
 * files are opened. The index is kept as one line per file (JSONL) beside
 * the app's data and read back a line at a time.
 *
 * Nothing here touches the network: the library is never uploaded anywhere.
 */

/** One file of the library, in short keys: there can be tens of thousands. */
export interface LibraryItem {
  /** Path; for an image sequence, its ffmpeg pattern (glow_%04d.png). */
  p: string
  k: LibraryKind
  /** Bytes; for a sequence, its first frame's. */
  s: number
  /** Modification time, ms. */
  m: number
  /** Stems of the words it is filed under, space-separated. */
  t: string
  /** Its name, as shown. */
  n: string
  d?: number
  w?: number
  h?: number
  /** Transparency. */
  a?: 1
  /** Integrated loudness, LUFS. */
  l?: number
  /** Frames, for a sequence or a Lottie. */
  f?: number
  fps?: number
  /** Codec, as ffmpeg names it. */
  c?: string
  /** A LUT's grid size. */
  z?: number
  /** Why it could not be measured, when it could not. */
  e?: string
}

export interface UnsupportedGroup {
  ext: string
  what: string
  why: string
  count: number
  examples: string[]
}

export interface LibraryIndex {
  v: 1
  root: string
  scannedAt: string
  items: LibraryItem[]
  unsupported: UnsupportedGroup[]
  report: WalkReport
}

export interface ScanDeps {
  /** What ffmpeg says about a video or a sound (main/broll/files probeFile). */
  probe: (path: string, signal?: AbortSignal) => Promise<ProbeInfo | null>
  /** Integrated loudness, LUFS (main/music trackLoudness). */
  loudness?: (path: string, signal?: AbortSignal) => Promise<number | null>
  /** The first bytes of a file. */
  head?: (path: string, bytes: number) => Promise<Buffer>
}

export interface ScanOptions {
  /** Where the index is kept. */
  cacheDir: string
  deps: ScanDeps
  signal?: AbortSignal
  /** Files measured at once. Default 3: the machine has other work. */
  concurrency?: number
  /** Which sounds to measure the loudness of: short effects (the default), all of them, or none. */
  loudness?: 'sfx' | 'all' | 'none'
  onProgress?: (p: { files: number; indexed: number; measured: number }) => void
}

export interface ScanStats {
  files: number
  indexed: number
  reused: number
  measured: number
  failed: number
  ms: number
}

const VERSION = 1

export function indexPath(cacheDir: string, root: string): string {
  return join(cacheDir, `library-${createHash('sha1').update(root).digest('hex').slice(0, 12)}.jsonl`)
}

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const h = await fs.open(path, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await h.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await h.close()
  }
}

/** The index kept from the last scan, or nothing. `skips` are JSON files already found not to be Lottie. */
export async function loadIndex(
  cacheDir: string,
  root: string
): Promise<(LibraryIndex & { skips: Map<string, { s: number; m: number }> }) | null> {
  const file = indexPath(cacheDir, resolve(root))
  try {
    await fs.access(file)
  } catch {
    return null
  }
  const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  let header: { v: number; root: string; scannedAt: string } | null = null
  let report: WalkReport = emptyReport()
  let unsupported: UnsupportedGroup[] = []
  const items: LibraryItem[] = []
  const skips = new Map<string, { s: number; m: number }>()
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      if (!header) {
        if (row.v !== VERSION || row.root !== resolve(root)) return null
        header = row as unknown as { v: number; root: string; scannedAt: string }
        continue
      }
      if (row.summary === true) {
        report = { ...emptyReport(), ...(row.report as WalkReport) }
        unsupported = (row.unsupported as UnsupportedGroup[]) ?? []
      } else if (typeof row.j === 'string') skips.set(row.j, { s: Number(row.s), m: Number(row.m) })
      else if (typeof row.p === 'string' && typeof row.k === 'string') items.push(row as unknown as LibraryItem)
    } catch {
      // A line cut short by a crash is skipped; the next scan writes it again.
    }
  }
  return header ? { v: VERSION, root: header.root, scannedAt: header.scannedAt, items, unsupported, report, skips } : null
}

/** Runs at most `n` jobs at once. */
function pool(n: number): { run: (job: () => Promise<void>) => Promise<void>; idle: () => Promise<void> } {
  let active = 0
  const waiting: (() => void)[] = []
  const settled = new Set<Promise<void>>()
  return {
    async run(job) {
      while (active >= n) await new Promise<void>((r) => waiting.push(r))
      active++
      const p = job().finally(() => {
        active--
        settled.delete(p)
        waiting.shift()?.()
      })
      settled.add(p)
    },
    async idle() {
      while (settled.size) await Promise.allSettled([...settled])
    }
  }
}

interface Sequence {
  first: FrameName
  firstPath: string
  firstSize: number
  m: number
  count: number
  /** The frames, while there are too few to be a sequence; dropped once there are enough. */
  few: WalkedFile[]
}

/** Measures one file into its index entry, or null when it is nothing to index (a JSON that is not Lottie). */
async function measure(
  f: WalkedFile,
  deps: Required<Pick<ScanDeps, 'head'>> & ScanDeps,
  opts: { loudness: 'sfx' | 'all' | 'none'; signal?: AbortSignal }
): Promise<LibraryItem | null> {
  const tags = tagsFor(f.rel)
  const base = { p: f.path, s: f.size, m: f.mtimeMs, t: stems(tags.join(' ')).join(' '), n: f.name }
  const kind = f.cls.is
  if (kind === 'font') return { ...base, k: 'font' }
  if (kind === 'lut') {
    const head = (await deps.head(f.path, 4096)).toString('utf8')
    const cube = cubeHead(head)
    if (f.name.toLowerCase().endsWith('.cube') && !cube) return { ...base, k: 'lut', e: 'Not a LUT this app can read.' }
    return { ...base, k: 'lut', ...(cube ? { z: cube.size } : {}) }
  }
  if (kind === 'json') {
    if (f.size > 50 * 1024 * 1024) return null
    const head = lottieHead((await deps.head(f.path, 65_536)).toString('utf8'))
    if (!head) return null
    return { ...base, k: 'lottie', w: head.width, h: head.height, fps: head.fps, f: head.frames, d: Number((head.frames / head.fps).toFixed(3)) }
  }
  if (kind === 'image') {
    const head = imageHead(await deps.head(f.path, 65_536))
    if (head && !head.animated) {
      const over = head.alpha === true
      return { ...base, k: over ? 'overlay' : 'image', w: head.width, h: head.height, ...(over ? { a: 1 as const } : {}) }
    }
    // An animated picture, or one the header reader does not know: ffmpeg measures it.
  }
  const info = await deps.probe(f.path, opts.signal)
  if (!info) return { ...base, k: kind === 'audio' ? 'sfx' : kind === 'image' ? 'image' : 'video', e: 'ffmpeg could not read it.' }
  if (info.video && (kind !== 'audio' || !info.audio)) {
    const v = info.video
    const alpha = v.alpha === true
    // Moving pictures with transparency are overlays; so are the codecs made for it, filed as overlays.
    const over = alpha || (v.alpha === null && overlayWords(tags) && /^(prores|qtrle|png|hevc|vp8|vp9)$/.test(v.codec))
    const still = info.still || kind === 'image'
    return {
      ...base,
      k: over ? 'overlay' : still ? 'image' : 'video',
      w: v.width,
      h: v.height,
      c: v.codec,
      ...(info.durationSec && !still ? { d: Number(info.durationSec.toFixed(3)) } : {}),
      ...(v.fps && !still ? { fps: v.fps } : {}),
      ...(alpha ? { a: 1 as const } : {})
    }
  }
  if (info.audio) {
    const d = info.durationSec
    const role = audioRole(tags, d)
    const item: LibraryItem = { ...base, k: role, c: info.audio.codec, ...(d ? { d: Number(d.toFixed(3)) } : {}) }
    const measureIt = opts.loudness === 'all' || (opts.loudness === 'sfx' && role === 'sfx' && (d ?? 0) <= 30)
    if (measureIt && deps.loudness) {
      const l = await deps.loudness(f.path, opts.signal).catch(() => null)
      if (l !== null && Number.isFinite(l)) item.l = Number(l.toFixed(1))
    }
    return item
  }
  return { ...base, k: 'video', e: 'It has neither a picture nor a sound.' }
}

/**
 * Indexes a folder, reusing what the last scan measured for every file that
 * has not changed, and keeps the index for next time. Returns the index and
 * what the scan did.
 */
export async function scanLibrary(folder: string, opts: ScanOptions): Promise<{ index: LibraryIndex; stats: ScanStats }> {
  const started = Date.now()
  const root = resolve(folder)
  const deps = { head: readHead, ...opts.deps }
  const loudness = opts.loudness ?? 'sfx'
  const previous = await loadIndex(opts.cacheDir, root)
  const before = new Map<string, LibraryItem>()
  for (const it of previous?.items ?? []) before.set(it.p, it)
  const skipsBefore = previous?.skips ?? new Map<string, { s: number; m: number }>()
  if (previous) previous.items.length = 0

  await fs.mkdir(opts.cacheDir, { recursive: true })
  const file = indexPath(opts.cacheDir, root)
  const part = `${file}.${process.pid}.part`
  const out = createWriteStream(part, 'utf8')
  const write = (row: object): Promise<void> =>
    new Promise((resolve) => (out.write(`${JSON.stringify(row)}\n`) ? resolve() : out.once('drain', () => resolve())))

  const report = emptyReport()
  const items: LibraryItem[] = []
  const unsupported = new Map<string, UnsupportedGroup>()
  const stats: ScanStats = { files: 0, indexed: 0, reused: 0, measured: 0, failed: 0, ms: 0 }
  const jobs = pool(Math.max(1, opts.concurrency ?? 3))
  const sequences = new Map<string, Sequence>()
  let lastProgress = 0

  const keep = async (item: LibraryItem): Promise<void> => {
    items.push(item)
    stats.indexed++
    if (item.e) stats.failed++
    await write(item)
  }

  const index = async (f: WalkedFile): Promise<void> => {
    const old = before.get(f.path)
    // An unchanged file keeps what was measured, a failure included: it is tried again once it changes.
    if (old && old.s === f.size && old.m === f.mtimeMs) {
      stats.reused++
      await keep(old)
      return
    }
    const skipped = f.cls.is === 'json' ? skipsBefore.get(f.path) : undefined
    if (skipped && skipped.s === f.size && skipped.m === f.mtimeMs) {
      await write({ j: f.path, s: f.size, m: f.mtimeMs })
      return
    }
    await jobs.run(async () => {
      try {
        const item = await measure(f, deps, { loudness, signal: opts.signal })
        stats.measured++
        if (item) await keep(item)
        // A JSON file that is not an animation is remembered, so the next scan does not open it again.
        else if (f.cls.is === 'json') await write({ j: f.path, s: f.size, m: f.mtimeMs })
      } catch (err) {
        if (opts.signal?.aborted) return
        stats.measured++
        await keep({
          p: f.path,
          k: f.cls.is === 'audio' ? 'sfx' : f.cls.is === 'image' ? 'image' : 'video',
          s: f.size,
          m: f.mtimeMs,
          t: stems(tagsFor(f.rel).join(' ')).join(' '),
          n: f.name,
          e: err instanceof Error ? err.message.slice(0, 200) : 'It could not be read.'
        })
      }
    })
  }

  /** A folder's numbered frames, settled: a sequence when there are enough, else each frame as the picture it is. */
  const settle = async (dir: string): Promise<void> => {
    for (const [key, seq] of sequences) {
      if (!key.startsWith(`${dir}\u0000`)) continue
      sequences.delete(key)
      if (seq.count < MIN_SEQUENCE_FRAMES) {
        for (const f of seq.few) await index(f)
        continue
      }
      const pattern = join(dir, sequencePattern(seq.first))
      const old = before.get(pattern)
      if (old && old.f === seq.count && old.m === seq.m) {
        stats.reused++
        await keep(old)
        continue
      }
      await jobs.run(async () => {
        const head = imageHead(await deps.head(seq.firstPath, 65_536).catch(() => Buffer.alloc(0)))
        const tags = tagsFor(relative(root, join(dir, seq.first.prefix || 'sequence')))
        const alpha = head?.alpha === true
        stats.measured++
        await keep({
          p: pattern,
          k: alpha || overlayWords(tags) ? 'overlay' : 'sequence',
          s: seq.firstSize,
          m: seq.m,
          t: stems(tags.join(' ')).join(' '),
          n: `${seq.first.prefix.replace(/[_\-. ]+$/, '') || 'frames'} (${seq.count} frames)`,
          f: seq.count,
          // Sequences carry no rate; 30 frames a second is what most are rendered at.
          fps: 30,
          d: Number((seq.count / 30).toFixed(3)),
          ...(head ? { w: head.width, h: head.height } : {}),
          ...(alpha ? { a: 1 as const } : {})
        })
      })
    }
  }

  await write({ v: VERSION, root, scannedAt: new Date().toISOString() })
  try {
    for await (const entry of walk(root, { report, signal: opts.signal })) {
      if ('done' in entry) {
        await settle(entry.done)
        continue
      }
      stats.files = report.files
      if (entry.cls.is === 'unsupported') {
        const ext = entry.name.slice(entry.name.lastIndexOf('.') + 1).toLowerCase()
        const g = unsupported.get(ext) ?? { ext, what: entry.cls.what, why: entry.cls.why, count: 0, examples: [] }
        g.count++
        if (g.examples.length < 5) g.examples.push(entry.path)
        unsupported.set(ext, g)
        continue
      }
      const frame = entry.cls.is === 'image' ? frameName(entry.name) : null
      if (frame) {
        const key = `${dirname(entry.path)}\u0000${frame.prefix}\u0000${frame.ext}\u0000${frame.digits}`
        const seq = sequences.get(key)
        if (!seq) sequences.set(key, { first: frame, firstPath: entry.path, firstSize: entry.size, m: entry.mtimeMs, count: 1, few: [entry] })
        else {
          seq.count++
          seq.m = Math.max(seq.m, entry.mtimeMs)
          if (frame.frame < seq.first.frame) {
            seq.first = frame
            seq.firstPath = entry.path
            seq.firstSize = entry.size
          }
          if (seq.count < MIN_SEQUENCE_FRAMES) seq.few.push(entry)
          else seq.few = []
        }
        continue
      }
      await index(entry)
      if (opts.onProgress && Date.now() - lastProgress > 250) {
        lastProgress = Date.now()
        opts.onProgress({ files: report.files, indexed: stats.indexed, measured: stats.measured })
      }
    }
    await jobs.idle()
    for (const pkg of report.packages) {
      const known = UNSUPPORTED[pkg.ext]
      if (!known) continue
      const g = unsupported.get(pkg.ext) ?? { ext: pkg.ext, ...known, count: 0, examples: [] }
      g.count++
      if (g.examples.length < 5) g.examples.push(pkg.path)
      unsupported.set(pkg.ext, g)
    }
    stats.files = report.files
    const groups = [...unsupported.values()].sort((a, b) => b.count - a.count)
    // The summary goes last, so a reader of the first line sees the version and root at once.
    await write({ summary: true, report, unsupported: groups })
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())))
    if (opts.signal?.aborted) {
      await fs.rm(part, { force: true })
    } else {
      await fs.rename(part, file)
    }
    stats.ms = Date.now() - started
    opts.onProgress?.({ files: report.files, indexed: stats.indexed, measured: stats.measured })
    return {
      index: { v: VERSION, root, scannedAt: new Date().toISOString(), items, unsupported: groups, report },
      stats
    }
  } catch (err) {
    out.destroy()
    await fs.rm(part, { force: true }).catch(() => undefined)
    throw err
  }
}

/** The library's entries that match some words, best first. */
export function searchLibrary(
  items: LibraryItem[],
  query: string,
  opts: { kinds?: LibraryKind[]; count?: number } = {}
): { item: LibraryItem; score: number }[] {
  const want = stems(query).map((s) => ({ stem: s, weight: 1 }))
  if (want.length === 0) return []
  const kinds = opts.kinds ? new Set(opts.kinds) : null
  const out: { item: LibraryItem; score: number }[] = []
  for (const item of items) {
    if (item.e || (kinds && !kinds.has(item.k))) continue
    const have = item.t ? item.t.split(' ') : []
    // The name counts too, for files whose folder words are all there is.
    const score = overlap(want, have.length ? have : stems(item.n, { file: true }))
    if (score > 0) out.push({ item, score })
  }
  return out.sort((a, b) => b.score - a.score || (b.item.w ?? 0) - (a.item.w ?? 0)).slice(0, opts.count ?? 20)
}

/**
 * What a scan found, in a sentence for Settings: "12,400 files: 3,100 clips,
 * 1 LUT. I cannot use Premiere motion graphics templates (214); Settings
 * says why."
 */
export function describeIndex(index: LibraryIndex): string {
  const count = (k: LibraryKind[]): number => index.items.filter((i) => k.includes(i.k) && !i.e).length
  const n = (x: number): string => x.toLocaleString('en-US')
  const kinds: [number, string, string][] = [
    [count(['video']), 'clip', 'clips'],
    [count(['image']), 'picture', 'pictures'],
    [count(['overlay', 'sequence']), 'overlay', 'overlays'],
    [count(['sfx']), 'sound effect', 'sound effects'],
    [count(['music']), 'music track', 'music tracks'],
    [count(['lut']), 'LUT', 'LUTs'],
    [count(['font']), 'font', 'fonts'],
    [count(['lottie']), 'Lottie animation', 'Lottie animations']
  ]
  const parts = kinds.filter(([c]) => c > 0).map(([c, one, many]) => `${n(c)} ${c === 1 ? one : many}`)
  const cannot = index.unsupported.map((g) => `${g.what} (${n(g.count)})`)
  const failed = index.items.filter((i) => i.e).length
  return [
    `${n(index.report.files)} files: ${parts.join(', ') || 'nothing I can use yet'}.`,
    cannot.length ? `I cannot use ${cannot.join(', ')}; Settings says why.` : '',
    failed ? `${n(failed)} could not be read.` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

