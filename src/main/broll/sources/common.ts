import { promises as fs } from 'fs'
import type { Range } from '../../../shared/assets'
import { stretchFor } from '../../../shared/broll/policy'
import { inTime, type Quotas } from '../../../shared/broll/quota'
import type { Candidate, Fetched, FetchOptions, SourceId } from '../../../shared/broll/types'
import { encodeMp4, extFor, fileIn, MAX_LONG_SIDE, normalized, runFfmpeg } from '../files'
import { HttpError, type Http } from '../http'
import { excerptRemote } from '../relay'

/**
 * What every source shares: the HTTP helper, ffmpeg, the quotas, and how a
 * picked candidate becomes a file in the edit's folder: a picture or a short
 * clip downloaded whole, a stretch of a long video read through the relay,
 * a GIF made into a clip; then normalized and credited (main/broll/files).
 */

export interface SourceDeps {
  http: Http
  ffmpeg: string
  quotas?: Quotas
  /** The source's key, read from the keychain when it is needed and never kept. */
  key?: () => string | null
}

/** A source's limit reached: said plainly, with when it frees up. */
export class QuotaError extends Error {
  constructor(
    readonly source: SourceId,
    readonly retryInSec: number,
    name: string
  ) {
    super(`${name} has had all the searches it allows for now. It frees up ${inTime(retryInSec)}.`)
    this.name = 'QuotaError'
  }
}

/** Takes one request from a source's quota, or throws why not. */
export function take(deps: Pick<SourceDeps, 'quotas'>, id: SourceId, name: string): void {
  const t = deps.quotas?.take(id)
  if (t && !t.ok) throw new QuotaError(id, t.retryInSec, name)
}

/** The key, or a sentence saying it is missing. */
export function needKey(deps: SourceDeps, name: string): string {
  const k = deps.key?.()
  if (!k) throw new Error(`Add a ${name} key in Settings to search ${name}.`)
  return k
}

export function stripHtml(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, '’')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** The biggest picture or video a fetch keeps: plenty for any output. */
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024
export const MAX_CLIP_BYTES = 250 * 1024 * 1024

export const IMAGE_TYPES = ['image/']
export const VIDEO_TYPES = ['video/', 'application/octet-stream', 'binary/octet-stream']
export const AUDIO_TYPES = ['audio/', 'application/octet-stream', 'video/ogg', 'application/ogg']

/**
 * A picture at a link, saved into the folder and normalized. A GIF that
 * moves becomes a clip; a picture in a format the edit cannot play is
 * redrawn as a PNG.
 */
export async function savePicture(
  deps: SourceDeps,
  c: Candidate,
  url: string,
  dir: string,
  opts: FetchOptions & { headers?: Record<string, string>; hosts?: (h: string) => boolean } = {}
): Promise<Fetched> {
  const first = await fileIn(dir, c.title, 'download')
  const got = await deps.http.toFile(url, first, {
    accept: IMAGE_TYPES,
    maxBytes: MAX_IMAGE_BYTES,
    headers: opts.headers,
    hosts: opts.hosts,
    signal: opts.signal,
    onBytes: (n, of) => (of ? opts.onProgress?.(Math.round((n / of) * 90)) : undefined)
  })
  const ext = extFor(got.type, got.url) ?? 'jpg'
  try {
    if (ext === 'gif' || c.kind === 'gif') {
      const clip = await fileIn(dir, c.title, 'mp4')
      await encodeMp4(deps.ffmpeg, first, clip, { signal: opts.signal, loops: loopsFor(c, opts.seconds) })
      return await normalized(clip, { ...c, kind: 'gif' }, null, deps.ffmpeg)
    }
    if (!['jpg', 'png', 'webp', 'bmp'].includes(ext)) {
      const png = await fileIn(dir, c.title, 'png')
      await runFfmpeg(deps.ffmpeg, ['-loglevel', 'error', '-y', '-i', first, '-frames:v', '1', png], opts.signal)
      return await normalized(png, c, null, deps.ffmpeg)
    }
    const path = first.replace(/\.download$/, `.${ext}`)
    await fs.rename(first, path)
    return await normalized(path, c, null, deps.ffmpeg)
  } finally {
    await fs.rm(first, { force: true }).catch(() => undefined)
  }
}

/** How many times a short loop plays to cover the shot. */
function loopsFor(c: Candidate, seconds?: number): number {
  if (!seconds || !c.durationSec || c.durationSec <= 0) return 0
  return Math.min(20, Math.max(0, Math.ceil(seconds / c.durationSec) - 1))
}

/**
 * A video at a link into the folder: a short one downloaded whole and kept
 * as it is when it already plays everywhere (H.264 or VP9 in MP4 or WebM),
 * a long one read only for the stretch it needs. Licensed long videos give a
 * minute at most and someone else's clip thirty seconds (shared/broll/policy).
 */
export async function saveVideo(
  deps: SourceDeps,
  c: Candidate,
  url: string,
  dir: string,
  opts: FetchOptions & { hosts?: (h: string) => boolean; headers?: Record<string, string>; wholeUpTo?: number } = {}
): Promise<Fetched> {
  const range = stretchFor(c, opts.seconds)
  const maxLong = longSideFor(opts.output)
  const wholeUpTo = opts.wholeUpTo ?? MAX_CLIP_BYTES
  if (!range && wholeUpTo > 0 && (c.bytes === null || c.bytes <= wholeUpTo)) {
    const first = await fileIn(dir, c.title, 'download')
    try {
      const got = await deps.http.toFile(url, first, {
        accept: VIDEO_TYPES,
        maxBytes: wholeUpTo,
        timeoutMs: 45_000,
        headers: opts.headers,
        hosts: opts.hosts,
        signal: opts.signal,
        onBytes: (n, of) => (of ? opts.onProgress?.(Math.round((n / of) * 90)) : undefined)
      })
      const ext = extFor(got.type, got.url) ?? 'mp4'
      if (ext === 'mp4' || ext === 'mov' || ext === 'webm' || ext === 'm4v') {
        const path = first.replace(/\.download$/, `.${ext}`)
        await fs.rename(first, path)
        return await normalized(path, c, null, deps.ffmpeg)
      }
      // Ogg Theora and the like: the preview cannot play them, so they become H.264.
      const clip = await fileIn(dir, c.title, 'mp4')
      await encodeMp4(deps.ffmpeg, first, clip, { signal: opts.signal, maxLong })
      return await normalized(clip, c, null, deps.ffmpeg)
    } finally {
      await fs.rm(first, { force: true }).catch(() => undefined)
    }
  }
  const stretch: Range = range ?? { startSec: 0, endSec: Math.min(c.durationSec ?? opts.seconds ?? 8, 60) }
  const clip = await fileIn(dir, `${c.title}-${Math.round(stretch.startSec)}s`, 'mp4')
  opts.onProgress?.(10)
  await excerptRemote(deps.http, deps.ffmpeg, url, stretch, clip, { signal: opts.signal, hosts: opts.hosts, maxLong })
  opts.onProgress?.(95)
  return normalized(clip, c, stretch, deps.ffmpeg)
}

/** A sound at a link into the folder, normalized. */
export async function saveSound(
  deps: SourceDeps,
  c: Candidate,
  url: string,
  dir: string,
  opts: FetchOptions & { headers?: Record<string, string>; hosts?: (h: string) => boolean } = {}
): Promise<Fetched> {
  const first = await fileIn(dir, c.title, 'download')
  try {
    const got = await deps.http.toFile(url, first, {
      accept: AUDIO_TYPES,
      maxBytes: 80 * 1024 * 1024,
      headers: opts.headers,
      hosts: opts.hosts,
      signal: opts.signal
    })
    const ext = extFor(got.type, got.url) ?? 'mp3'
    const path = first.replace(/\.download$/, `.${ext === 'oga' ? 'ogg' : ext}`)
    await fs.rename(first, path)
    return await normalized(path, { ...c, kind: 'audio' }, null, deps.ffmpeg)
  } finally {
    await fs.rm(first, { force: true }).catch(() => undefined)
  }
}

/** The longest side to keep a video at for an output: its own long side, at least 1080 and at most 3840. */
export function longSideFor(output?: { width: number; height: number }): number {
  if (!output) return MAX_LONG_SIDE
  return Math.min(3840, Math.max(1080, Math.max(output.width, output.height)))
}

/** A quota or an HTTP failure keeps its own words; anything else gets the source's name. */
export function failure(name: string, err: unknown): Error {
  if (err instanceof QuotaError || err instanceof HttpError) return err
  return new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`)
}
