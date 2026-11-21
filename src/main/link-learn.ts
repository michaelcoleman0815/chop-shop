import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { captionKind, captionWords, type CaptionKind } from '../shared/caption-words'
import type { Aspect, HeardWord } from '../shared/channel-habits'
import { aspectOf } from '../shared/inspiration/facts'
import { explain, YTDLP_ENV } from './assets'

/**
 * One of the person's own videos read from its link, for the habits the
 * Brand page learns: its title, its length, its shape and its captions in
 * English. Nothing of the video itself is downloaded, so there is no picture
 * and no sound to measure; yt-dlp is given the binary and a folder, so this
 * runs without Electron.
 */

export interface LinkRead {
  title: string
  durationSec: number
  /** Null when the link says nothing of its shape. */
  aspect: Aspect | null
  /** The captions' words, and whether someone wrote them; null when it has none in English. */
  captions: { words: HeardWord[]; written: boolean } | null
}

export interface LinkTools {
  ytdlp: string
  /** An empty folder of its own for what yt-dlp writes; emptied by the caller. */
  dir: string
  signInFrom?: string | null
  signal?: AbortSignal
}

/** English and the forms YouTube gives it: written captions come first wherever both exist. */
const LANGS = ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU', 'en-orig']

/** yt-dlp's arguments: the link's details and its English captions, and no video. */
export function linkArgs(url: string, dir: string, signInFrom?: string | null): string[] {
  return [
    '--skip-download',
    '--no-playlist',
    '--write-info-json',
    '--no-write-playlist-metafiles',
    '--write-subs',
    '--write-auto-subs',
    '--sub-langs',
    LANGS.join(','),
    '--sub-format',
    'json3/vtt/srt/best',
    // Captions that will not come are no reason to fail: the length still counts.
    '--ignore-no-formats-error',
    ...(signInFrom ? ['--cookies-from-browser', signInFrom] : []),
    '-o',
    join(dir, 'link.%(ext)s'),
    url
  ]
}

interface Info {
  title?: unknown
  duration?: unknown
  width?: unknown
  height?: unknown
  webpage_url?: unknown
  subtitles?: Record<string, unknown> | null
}

/** The best caption file there: written before automatic, then by language, json3 before WebVTT before SubRip. */
export function pickCaptions(
  names: string[],
  written: string[]
): { name: string; kind: CaptionKind; written: boolean } | null {
  const formats: CaptionKind[] = ['json3', 'vtt', 'srt']
  const found = names
    .map((name) => {
      const m = /^link\.([^.]+)\.(json3|vtt|srt)$/i.exec(name)
      const kind = captionKind(name)
      return m && kind ? { name, lang: m[1], kind, written: written.includes(m[1]) } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
  const order = (l: string): number => (LANGS.includes(l) ? LANGS.indexOf(l) : LANGS.length)
  found.sort(
    (a, b) =>
      Number(b.written) - Number(a.written) ||
      order(a.lang) - order(b.lang) ||
      formats.indexOf(a.kind) - formats.indexOf(b.kind)
  )
  const best = found[0]
  return best ? { name: best.name, kind: best.kind, written: best.written } : null
}

/** A link's shape: from its picture's size, or a Shorts address, or not known. */
export function linkAspect(url: string, info: Info): Aspect | null {
  const w = typeof info.width === 'number' ? info.width : 0
  const h = typeof info.height === 'number' ? info.height : 0
  if (w > 0 && h > 0) return aspectOf(w, h)
  const page = typeof info.webpage_url === 'string' ? info.webpage_url : ''
  return /\/shorts\//i.test(url) || /\/shorts\//i.test(page) ? 'vertical' : null
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal, env: YTDLP_ENV })
    let stderr = ''
    child.stdout.on('data', () => undefined)
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-6000)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(explain(stderr) ?? `yt-dlp stopped with code ${code}.`))
    )
  })
}

export async function readLink(url: string, tools: LinkTools): Promise<LinkRead> {
  await run(tools.ytdlp, linkArgs(url, tools.dir, tools.signInFrom), tools.signal)
  const names = await fs.readdir(tools.dir)
  const infoName = names.find((n) => n.endsWith('.info.json'))
  if (!infoName) throw new Error('That link gave no details to read.')
  const info = JSON.parse(await fs.readFile(join(tools.dir, infoName), 'utf8')) as Info
  const durationSec = typeof info.duration === 'number' ? info.duration : NaN
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error('That link doesn’t say how long its video is.')
  const written = Object.keys(info.subtitles ?? {})
  const pick = pickCaptions(names, written)
  let captions: LinkRead['captions'] = null
  if (pick) {
    const words = captionWords(await fs.readFile(join(tools.dir, pick.name), 'utf8'), pick.kind)
    if (words.length > 0) captions = { words, written: pick.written }
  }
  return {
    title: typeof info.title === 'string' && info.title.trim() ? info.title.trim() : url,
    durationSec,
    aspect: linkAspect(url, info),
    captions
  }
}

/** Whether something added on the Brand page is a link rather than a file. */
export const isLink = (s: string): boolean => /^https?:\/\//i.test(s.trim())

/** A link as it is named in a line: its site and the rest, without the scheme. */
export function linkName(url: string): string {
  try {
    const u = new URL(url)
    const said = `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname}${u.search}`
    return said.length > 60 ? `${said.slice(0, 59)}…` : said
  } catch {
    return url.slice(0, 60)
  }
}
