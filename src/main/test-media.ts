import { execFileSync, spawnSync } from 'child_process'
import { existsSync } from 'fs'

/**
 * Measuring rendered files in tests, with nothing but ffmpeg: the mean colour
 * of a frame or part of one, how many frames there are, how long the sound
 * runs, and how loud one tone is inside a mix. Tests make their own footage
 * with lavfi, so every number here comes from a file the test just rendered.
 *
 * Only tests import this.
 */

export function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    candidates.splice(1, 0, require('ffmpeg-static') as string)
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

/** Runs ffmpeg quietly and throws with its last words when it fails. */
export function ffmpegRun(ffmpeg: string, args: string[]): void {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] })
}

/** Everything ffmpeg prints while decoding a file to nothing. */
function decodeLog(ffmpeg: string, args: string[]): string {
  const r = spawnSync(ffmpeg, ['-hide_banner', ...args, '-f', 'null', '-'], { encoding: 'utf8' })
  return `${r.stdout ?? ''}${r.stderr ?? ''}`
}

/**
 * A clip from lavfi sources: `video` and `audio` are lavfi graphs, each given
 * its own duration. Encoded small and fast.
 */
export function makeClip(ffmpeg: string, path: string, video: string, audio: string | null): string {
  const args = ['-f', 'lavfi', '-i', video]
  if (audio) args.push('-f', 'lavfi', '-i', audio)
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  if (audio) args.push('-c:a', 'aac', '-b:a', '128k', '-shortest')
  ffmpegRun(ffmpeg, [...args, path])
  return path
}

/**
 * One clip made of solid colours in turn, each with its own tone, so a test
 * can tell from any frame and any moment of sound which stretch it came from.
 */
export function makeColourClip(
  ffmpeg: string,
  path: string,
  parts: { color: string; hz: number; sec: number }[],
  size = '320x180'
): string {
  const v = parts.map((p, i) => `color=c=${p.color}:s=${size}:r=30:d=${p.sec}[v${i}]`)
  const a = parts.map((p, i) => `sine=frequency=${p.hz}:sample_rate=48000:duration=${p.sec}[a${i}]`)
  const pads = parts.map((_, i) => `[v${i}][a${i}]`).join('')
  ffmpegRun(ffmpeg, [
    '-filter_complex',
    [...v, ...a, `${pads}concat=n=${parts.length}:v=1:a=1[v][a]`].join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    path
  ])
  return path
}

export type Rgb = [number, number, number]

/**
 * The mean colour of the frame at `atSec`, or of a region of it given as
 * fractions of the frame ({ x: 0, y: 0, w: 0.5, h: 1 } is the left half).
 */
export function frameColour(
  ffmpeg: string,
  path: string,
  atSec: number,
  region: { x: number; y: number; w: number; h: number } | null = null
): Rgb {
  const crop = region ? `crop=iw*${region.w}:ih*${region.h}:iw*${region.x}:ih*${region.y},` : ''
  const out = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      atSec.toFixed(3),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      `${crop}scale=1:1:flags=area,format=rgb24`,
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1024 }
  )
  return [out[0], out[1], out[2]]
}

/** Frames in the first video stream, counted by decoding. */
export function countFrames(ffmpeg: string, path: string): number {
  const log = decodeLog(ffmpeg, ['-i', path, '-map', '0:v:0'])
  const all = [...log.matchAll(/frame=\s*(\d+)/g)]
  return all.length ? Number(all[all.length - 1][1]) : 0
}

/** How long the first audio stream runs, by decoding it. */
export function audioSeconds(ffmpeg: string, path: string): number {
  const log = decodeLog(ffmpeg, ['-i', path, '-map', '0:a:0'])
  const all = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)]
  if (!all.length) return 0
  const m = all[all.length - 1]
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
}

/**
 * The level of one tone in a stretch of sound, in dB: a narrow band-pass
 * around it, then the mean volume. Silence reads about -90.
 */
export function toneLevel(ffmpeg: string, path: string, startSec: number, durationSec: number, hz: number): number {
  const log = decodeLog(ffmpeg, [
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    path,
    '-map',
    '0:a:0',
    '-af',
    `bandpass=f=${hz}:width_type=q:w=12,bandpass=f=${hz}:width_type=q:w=12,volumedetect`
  ])
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(log)
  return m ? Number(m[1]) : -91
}

/** The mean level of a stretch of sound, in dB. */
export function meanLevel(ffmpeg: string, path: string, startSec: number, durationSec: number, filter = ''): number {
  const log = decodeLog(ffmpeg, [
    '-ss',
    startSec.toFixed(3),
    '-t',
    durationSec.toFixed(3),
    '-i',
    path,
    '-map',
    '0:a:0',
    '-af',
    `${filter ? `${filter},` : ''}volumedetect`
  ])
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(log)
  return m ? Number(m[1]) : -91
}

/**
 * A recording of speech-like bursts: a 600 Hz tone during each word and
 * silence between, over a plain picture, so every word's onset can be heard.
 */
export function makeBurstClip(
  ffmpeg: string,
  path: string,
  words: { startSec: number; endSec: number }[],
  durationSec: number,
  size = '320x180'
): string {
  const gates = words.map((w) => `between(t,${w.startSec},${w.endSec})`).join('+')
  return makeClip(
    ffmpeg,
    path,
    `color=c=0x3a6ea5:s=${size}:r=30:d=${durationSec}`,
    `aevalsrc=exprs='0.4*sin(2*PI*600*t)*(${gates})':s=48000:d=${durationSec}`
  )
}

/** Where each sound starts after a silence, in seconds; `filter` picks out one part of the sound first. */
export function onsets(ffmpeg: string, path: string, noiseDb = -30, minSilenceSec = 0.08, filter = ''): number[] {
  const af = `${filter ? `${filter},` : ''}silencedetect=n=${noiseDb}dB:d=${minSilenceSec}`
  const log = decodeLog(ffmpeg, ['-i', path, '-map', '0:a:0', '-af', af])
  return [...log.matchAll(/silence_end: (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
}

/** Integrated loudness and true peak of the first audio stream, from ebur128. */
export function loudnessOf(ffmpeg: string, path: string): { lufs: number; truePeak: number } {
  const log = decodeLog(ffmpeg, ['-i', path, '-map', '0:a:0', '-af', 'ebur128=peak=true'])
  const summary = log.slice(log.lastIndexOf('Summary:'))
  const num = (re: RegExp): number => Number(re.exec(summary)?.[1] ?? NaN)
  return { lufs: num(/I:\s+(-?\d+(?:\.\d+)?) LUFS/), truePeak: num(/Peak:\s+(-?\d+(?:\.\d+)?) dBFS/) }
}

/** A gradient picture: red rising from left to right, green from top to bottom. */
export const GRADIENT = `geq=r='255*X/W':g='255*Y/H':b=0`

/**
 * A still of the gradient, so the colour at any edge of a frame made from it
 * says where in it that edge falls.
 */
export function makeGradientStill(ffmpeg: string, path: string, size = '1920x1080'): string {
  ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', `color=black:s=${size},format=rgb24,${GRADIENT}`, '-frames:v', '1', path])
  return path
}

/**
 * Where a frame made from the gradient sits in it: its left, right, top and
 * bottom edges as fractions of the picture, read from the edges' colour.
 */
export function gradientWindow(
  ffmpeg: string,
  path: string,
  atSec: number
): { left: number; right: number; top: number; bottom: number } {
  const strip = 0.01
  const left = frameColour(ffmpeg, path, atSec, { x: 0, y: 0.45, w: strip, h: 0.1 })[0] / 255
  const right = frameColour(ffmpeg, path, atSec, { x: 1 - strip, y: 0.45, w: strip, h: 0.1 })[0] / 255
  const top = frameColour(ffmpeg, path, atSec, { x: 0.45, y: 0, w: 0.1, h: strip })[1] / 255
  const bottom = frameColour(ffmpeg, path, atSec, { x: 0.45, y: 1 - strip, w: 0.1, h: strip })[1] / 255
  return { left, right, top, bottom }
}
