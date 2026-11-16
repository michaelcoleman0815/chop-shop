import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { clampExcerpt, defaultExcerpt, isImagePath, type Range } from '../shared/assets'
import type { Asset } from '../shared/edit'
import { probeMedia } from './inspiration/measure'
import { channelSearchUrl, orderFound, readSources, type FoundClip } from '../shared/broll-sources'

/**
 * Brings material into an edit: files already on disk, images from links,
 * short excerpts of videos at links (YouTube and anything else yt-dlp reads),
 * search results to choose B-roll from, and icons the renderer draws.
 *
 * Only the stretch that will be used is fetched from a video, at no more than
 * 1080p, and it keeps its title, channel and link so the export can credit
 * it. The binaries arrive as arguments, so the tests run without Electron.
 */

export type NewAsset = Omit<Asset, 'id'>

export interface AssetTools {
  ffmpeg: string
  ytdlp: string
  /** Where fetched material is kept for this edit. */
  dir: string
  /** A browser whose sign-in yt-dlp may use, for videos that ask for one. */
  signInFrom?: string | null
  signal?: AbortSignal
}

const AUDIO = /\.(mp3|m4a|aac|wav|aiff|flac|ogg)$/i
const MAX_IMAGE_BYTES = 25 * 1024 * 1024
const MAX_HEIGHT = 1080

const own = (): NewAsset['origin'] => ({ type: 'file', url: null, author: null, license: null, range: null })

function run(bin: string, args: string[], signal?: AbortSignal, onLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      const text = d.toString()
      stdout += text
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line.trim())
    })
    child.stderr.on('data', (d) => {
      const text = d.toString()
      stderr = (stderr + text).slice(-6000)
      if (onLine) for (const line of text.split('\n')) if (line.trim()) onLine(line.trim())
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(explain(stderr) ?? `${basename(bin)} exited with ${code}`))
    })
  })
}

/** yt-dlp's failures, as something a person can act on. */
export function explain(stderr: string): string | null {
  const last =
    stderr
      .trim()
      .split('\n')
      .reverse()
      .find((l) => /ERROR/.test(l)) ?? stderr.trim().split('\n').pop()
  if (!last) return null
  if (/sign in to confirm|not a bot|login required|cookies/i.test(stderr)) {
    return 'The site wants a signed-in browser before it will hand this over.'
  }
  if (/private video|video unavailable|has been removed/i.test(stderr)) return 'That video is private or gone.'
  if (/unsupported url/i.test(stderr)) return 'I can’t fetch from that site.'
  return last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '')
}

/** A file already on disk. It is used where it is, like footage. */
export async function importFile(path: string, tools: Pick<AssetTools, 'ffmpeg'>): Promise<NewAsset> {
  const title = basename(path, extname(path))
  if (AUDIO.test(path)) {
    return { kind: 'audio', path, title, durationSec: null, width: null, height: null, origin: own() }
  }
  const info = await probeMedia(tools.ffmpeg, path)
  const image = isImagePath(path)
  return {
    kind: image ? 'image' : 'video',
    path,
    title,
    durationSec: image ? null : info.durationSec,
    width: info.width,
    height: info.height,
    origin: own()
  }
}

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp'
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'asset'

/** An image at a link, downloaded into the edit's folder. */
export async function fetchImage(url: string, tools: Pick<AssetTools, 'ffmpeg' | 'dir' | 'signal'>): Promise<NewAsset> {
  const res = await fetch(url, { signal: tools.signal, redirect: 'follow' })
  if (!res.ok) throw new Error(`The image link answered ${res.status}.`)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const ext = IMAGE_TYPES[type]
  if (!ext)
    throw new Error(type.startsWith('image/') ? `${type} images are not supported yet.` : 'That link is not an image.')
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_IMAGE_BYTES) throw new Error('That image is over 25 MB.')
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('That image is over 25 MB.')
  await fs.mkdir(tools.dir, { recursive: true })
  const name = slug(basename(new URL(url).pathname, extname(new URL(url).pathname)))
  const path = join(tools.dir, `${name}-${Date.now().toString(36)}.${ext}`)
  await fs.writeFile(path, bytes)
  const info = await probeMedia(tools.ffmpeg, path)
  return {
    kind: 'image',
    path,
    title: name,
    durationSec: null,
    width: info.width,
    height: info.height,
    origin: { type: 'link', url, author: new URL(url).hostname, license: null, range: null }
  }
}

/** A PNG the renderer drew (an icon), saved into the edit's folder. */
export async function saveImage(
  bytes: Buffer,
  name: string,
  origin: NewAsset['origin'],
  tools: Pick<AssetTools, 'ffmpeg' | 'dir'>
): Promise<NewAsset> {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) throw new Error('That image could not be saved.')
  await fs.mkdir(tools.dir, { recursive: true })
  const path = join(tools.dir, `${slug(name)}-${Date.now().toString(36)}.png`)
  await fs.writeFile(path, bytes)
  const info = await probeMedia(tools.ffmpeg, path)
  return { kind: 'image', path, title: name, durationSec: null, width: info.width, height: info.height, origin }
}

const signIn = (from?: string | null): string[] => (from ? ['--cookies-from-browser', from] : [])

/** The yt-dlp arguments that fetch only one stretch of a video, at no more than 1080p. */
export function excerptArgs(
  url: string,
  range: Range,
  outTemplate: string,
  opts: { ffmpeg: string; signInFrom?: string | null; maxHeight?: number }
): string[] {
  const h = opts.maxHeight ?? MAX_HEIGHT
  return [
    '--no-playlist',
    '--newline',
    '--download-sections',
    `*${range.startSec.toFixed(2)}-${range.endSec.toFixed(2)}`,
    // Without this the excerpt starts at the keyframe before it, seconds early.
    '--force-keyframes-at-cuts',
    '-f',
    `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
    '--merge-output-format',
    'mp4',
    '--ffmpeg-location',
    opts.ffmpeg,
    ...signIn(opts.signInFrom),
    '--progress-template',
    'PCT %(progress._percent_str)s',
    '--print',
    'after_move:FILE %(filepath)s',
    '-o',
    outTemplate,
    url
  ]
}

export interface VideoInfo {
  title: string
  author: string | null
  durationSec: number | null
}

/** Title, channel and length, from yt-dlp's info JSON. */
export function parseInfo(json: string): VideoInfo {
  const d = JSON.parse(json) as Record<string, unknown>
  const handle = typeof d.uploader_id === 'string' && d.uploader_id.startsWith('@') ? d.uploader_id : null
  const author =
    handle ?? (typeof d.channel === 'string' ? d.channel : typeof d.uploader === 'string' ? d.uploader : null)
  return {
    title: typeof d.title === 'string' ? d.title : 'Video',
    author,
    durationSec: typeof d.duration === 'number' ? d.duration : null
  }
}

/** A short excerpt of a video at a link, with what is needed to credit it. */
export async function fetchExcerpt(
  url: string,
  range: Range | null,
  tools: AssetTools,
  onProgress: (percent: number) => void = () => undefined
): Promise<NewAsset> {
  const info = parseInfo(
    await run(tools.ytdlp, ['-J', '--no-playlist', ...signIn(tools.signInFrom), url], tools.signal)
  )
  const stretch = range ? clampExcerpt(range, info.durationSec) : defaultExcerpt(info.durationSec ?? 30)
  await fs.mkdir(tools.dir, { recursive: true })
  const out = join(tools.dir, `${slug(info.title)}-${Math.round(stretch.startSec)}s-%(id)s.%(ext)s`)
  let file: string | null = null
  await run(tools.ytdlp, excerptArgs(url, stretch, out, tools), tools.signal, (line) => {
    const pct = /PCT\s+([\d.]+)%/.exec(line)
    if (pct) onProgress(Math.round(Number(pct[1])))
    if (line.startsWith('FILE ')) file = line.slice(5).trim()
  })
  if (!file) throw new Error('The download finished but left no file.')
  const probe = await probeMedia(tools.ffmpeg, file)
  return {
    kind: 'video',
    path: file,
    title: info.title,
    durationSec: probe.durationSec,
    width: probe.width,
    height: probe.height,
    origin: { type: 'video', url, author: info.author, license: null, range: stretch }
  }
}

export type Candidate = FoundClip

/**
 * Search results from yt-dlp's flat playlist JSON, with the channel each is
 * from. A channel's own search lists its videos with the channel said once,
 * at the top, so that fills in what an entry leaves out.
 */
export function parseSearch(json: string): Candidate[] {
  const d = JSON.parse(json) as { entries?: Record<string, unknown>[] } & Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  return (d.entries ?? []).flatMap((e) => {
    const url =
      typeof e.url === 'string' ? e.url : typeof e.id === 'string' ? `https://www.youtube.com/watch?v=${e.id}` : null
    if (!url || typeof e.title !== 'string') return []
    const author = str(e.channel) ?? str(e.uploader) ?? str(d.channel) ?? str(d.uploader)
    const handle = [e.uploader_id, d.uploader_id].map(str).find((h) => h?.startsWith('@')) ?? null
    const channelId = str(e.channel_id) ?? str(d.channel_id)
    const channelUrl = str(e.channel_url) ?? str(e.uploader_url) ?? str(d.channel_url) ?? str(d.uploader_url)
    return [
      {
        url,
        title: e.title,
        author,
        durationSec: typeof e.duration === 'number' ? e.duration : null,
        // The channel, as far as yt-dlp says it.
        ...(channelId ? { channelId } : {}),
        ...(channelUrl ? { channelUrl } : {}),
        ...(handle ? { handle } : {})
      }
    ]
  })
}

/** Preferred channels searched for one query: each is a call to YouTube, so a few, in the order listed. */
export const PREFERRED_SEARCHES = 4

/**
 * Videos to choose B-roll from, without downloading any of them. The
 * brand's preferred channels are searched first and what they have comes
 * first; nothing from a blocked channel or website comes back.
 */
export async function searchVideos(
  query: string,
  tools: AssetTools,
  count = 5,
  lists: { prefer: string[]; block: string[] } = { prefer: [], block: [] }
): Promise<{
  results: (Candidate & { preferred: boolean })[]
  blocked: number
  /** Preferred channels that answered the search with something; `tried` of them were asked. */
  looked: number
  tried: number
}> {
  const q = query.replace(/[\r\n]+/g, ' ').trim()
  if (!q) return { results: [], blocked: 0, looked: 0, tried: 0 }
  const prefer = readSources(lists.prefer).sources
  const block = readSources(lists.block).sources
  const channels = prefer
    .map((s) => channelSearchUrl(s, q))
    .filter((u): u is string => !!u)
    .slice(0, PREFERRED_SEARCHES)
  // Long videos are rarely good B-roll and slow to scrub; prefer short ones.
  const shortest = (list: Candidate[]): Candidate[] =>
    [...list].sort((a, b) => (a.durationSec ?? 600) - (b.durationSec ?? 600))
  const preferredRuns: Candidate[][] = []
  for (const url of channels) {
    const json = await run(
      tools.ytdlp,
      ['--flat-playlist', '-J', '--playlist-end', '3', ...signIn(tools.signInFrom), url],
      tools.signal
    ).catch(() => null)
    preferredRuns.push(json ? shortest(parseSearch(json)) : [])
  }
  // More from the general search when some are going to be left out.
  const wanted = count + (block.length ? 5 : 0)
  const json = await run(
    tools.ytdlp,
    ['--flat-playlist', '-J', ...signIn(tools.signInFrom), `ytsearch${wanted}:${q}`],
    tools.signal
  )
  const ordered = orderFound(preferredRuns, shortest(parseSearch(json)), { prefer, block })
  // A channel was looked in only when it answered: one yt-dlp could not search, or that had nothing, was not.
  const looked = preferredRuns.filter((found) => found.length > 0).length
  return { results: ordered.results.slice(0, count), blocked: ordered.blocked, looked, tried: channels.length }
}
