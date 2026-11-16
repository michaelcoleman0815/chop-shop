import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * What leaves the Mac for another AI service is made here, with ffmpeg, and
 * it is only ever these two things: the sound of a recording, for
 * transcription, and short low-resolution excerpts, for judging a take. The
 * video file itself is never sent anywhere.
 */

export interface SpeechAudio {
  path: string
  bytes: number
  contentType: 'audio/ogg' | 'audio/flac'
  durationSec: number
}

/**
 * The sound of a recording, mono at 16 kHz: Opus in Ogg at 48 kbps, about
 * 22 MB an hour, with timing that starts exactly where the recording does
 * (Opus carries its encoder delay in the header and decoders take it off).
 * An ffmpeg built without libopus gets FLAC instead, ffmpeg's own encoder:
 * lossless, about three times the size, and just as exact.
 */
export async function extractSpeech(
  ffmpeg: string,
  input: string,
  dir: string,
  durationSec: number
): Promise<SpeechAudio> {
  const common = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input]
  const sound = ['-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000']
  const ogg = join(dir, 'speech.ogg')
  try {
    await run(ffmpeg, [...common, ...sound, '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', ogg])
    return { path: ogg, bytes: (await fs.stat(ogg)).size, contentType: 'audio/ogg', durationSec }
  } catch (err) {
    if (!/libopus|Unknown encoder|Encoder not found/i.test(message(err))) throw err
  }
  const flac = join(dir, 'speech.flac')
  await run(ffmpeg, [...common, ...sound, '-c:a', 'flac', flac])
  return { path: flac, bytes: (await fs.stat(flac)).size, contentType: 'audio/flac', durationSec }
}

export interface Excerpt {
  path: string
  bytes: number
  durationSec: number
}

/** The longest side of an excerpt. Enough to see a face, a focus pull or a blown highlight. */
export const EXCERPT_LONG_SIDE = 640

/**
 * A short, low-resolution copy of one stretch of a recording, with its sound
 * in mono: H.264 within 640 pixels on the long side at 24 fps, AAC at 64 kbps.
 */
export async function cutExcerpt(
  ffmpeg: string,
  clip: { sourcePath: string; startSec: number; endSec: number },
  out: string
): Promise<Excerpt> {
  const durationSec = clip.endSec - clip.startSec
  await run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-y',
    // Before -i, so only the stretch is read; re-encoding keeps it frame-accurate.
    '-ss',
    clip.startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    clip.sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-sn',
    '-dn',
    '-vf',
    `scale=w=${EXCERPT_LONG_SIDE}:h=${EXCERPT_LONG_SIDE}:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=24`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '30',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-ac',
    '1',
    '-movflags',
    '+faststart',
    out
  ])
  return { path: out, bytes: (await fs.stat(out)).size, durationSec }
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-400) || `ffmpeg exit ${code}`))
    )
  })
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
