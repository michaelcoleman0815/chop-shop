import { spawn } from 'child_process'
import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Range } from '../../shared/assets'
import { creditLine, originFor } from '../../shared/broll/credit'
import { parseBanner, type ProbeInfo } from '../../shared/broll/probe'
import type { Candidate, Fetched } from '../../shared/broll/types'
import { importFile } from '../assets'

/**
 * Files for B-roll: names inside the edit's own assets folder, ffmpeg runs,
 * a stretch of a video made into an H.264 MP4 the preview and the export
 * both play, a GIF made into a clip, and every fetched file normalized the
 * way a file brought in from disk is (main/assets importFile), then given
 * its title, where it came from, and its credit.
 */

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'broll'

/** A new file's path in the folder, never one already there. */
export async function fileIn(dir: string, title: string, ext: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  return join(dir, `${slug(title)}-${Date.now().toString(36)}${randomBytes(2).toString('hex')}.${ext.replace(/^\./, '')}`)
}

const TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac'
}

/** The extension for what a server sent, from its type, else from the link. */
export function extFor(type: string, url: string): string | null {
  if (TYPES[type]) return TYPES[type]
  try {
    const m = /\.([a-z0-9]{2,4})$/i.exec(new URL(url).pathname)
    return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : null
  } catch {
    return null
  }
}

/** Runs ffmpeg to the end; rejects with its last words. */
export function runFfmpeg(ffmpeg: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', ...args], { signal })
    let err = ''
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-12_000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(err)
      else reject(new Error(err.trim().split('\n').slice(-3).join(' ') || `ffmpeg exited with ${code}`))
    })
  })
}

/** What ffmpeg's banner says about a file (shared/broll/probe), or null when it is no media at all. */
export async function probeFile(ffmpeg: string, path: string, signal?: AbortSignal): Promise<ProbeInfo | null> {
  const banner = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', path], { signal })
    let err = ''
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(0, 64_000)))
    child.on('error', reject)
    // ffmpeg with no output always exits 1; the banner is what is wanted.
    child.on('close', () => resolve(err))
  })
  return parseBanner(banner)
}

/** The longest side B-roll is kept at: enough for any output Cutalong makes. */
export const MAX_LONG_SIDE = 1920

/**
 * A stretch of a video (a file, or a link ffmpeg reads) as an H.264 MP4
 * that starts on its first frame: re-encoded, so the stretch is exact, with
 * the picture no bigger than it needs to be. B-roll plays muted over the
 * speaker, so the sound is left out unless asked for.
 */
export async function encodeMp4(
  ffmpeg: string,
  input: string,
  output: string,
  opts: { range?: Range | null; withSound?: boolean; maxLong?: number; loops?: number; signal?: AbortSignal } = {}
): Promise<void> {
  const long = opts.maxLong ?? MAX_LONG_SIDE
  const range = opts.range
  const part = `${output}.part.mp4`
  try {
    await runFfmpeg(
      ffmpeg,
      [
        '-loglevel',
        'error',
        '-y',
        ...(opts.loops && opts.loops > 0 ? ['-stream_loop', String(Math.round(opts.loops))] : []),
        ...(range ? ['-ss', range.startSec.toFixed(3)] : []),
        '-i',
        input,
        ...(range ? ['-t', Math.max(0.1, range.endSec - range.startSec).toFixed(3)] : []),
        '-map',
        '0:v:0',
        ...(opts.withSound ? ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '160k'] : ['-an']),
        '-vf',
        // Smaller to fit the longest side, never bigger: a small film stays its own size.
        `scale=w='min(iw,${long})':h='min(ih,${long})':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '18',
        '-movflags',
        '+faststart',
        part
      ],
      opts.signal
    )
    await fs.rename(part, output)
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => undefined)
    throw err
  }
}

/**
 * A fetched file, ready for an edit: measured as a file from disk is, then
 * given its title, where it came from and how it may be used, and its credit.
 */
export async function normalized(path: string, c: Candidate, range: Range | null, ffmpeg: string): Promise<Fetched> {
  const base = await importFile(path, { ffmpeg })
  const asset = { ...base, title: c.title || base.title, origin: originFor(c, range) }
  // Sounds have a length too; importFile leaves it out for audio.
  if (asset.kind === 'audio' && asset.durationSec === null && c.durationSec) asset.durationSec = c.durationSec
  return { asset, credit: creditLine(c, range) }
}
