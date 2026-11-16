import { run, stderrLines } from './plugins'

/**
 * The phone's own ffmpeg and ffprobe measuring files, the same measurements
 * tools/measure.py makes on the CI runner, so the two can be compared.
 */

/** The probe arguments the desktop app uses (src/main/intake.ts PROBE_ARGS). */
export const PROBE_ARGS = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json']

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  profile?: string
  width?: number
  height?: number
  pix_fmt?: string
  color_transfer?: string
  color_primaries?: string
  sample_rate?: string
  channels?: number
  side_data_list?: { rotation?: number }[]
  tags?: Record<string, string>
}

export interface ProbeJson {
  streams?: ProbeStream[]
  format?: { format_name?: string; duration?: string; size?: string }
}

export interface Facts {
  format: string | undefined
  duration: number
  bytes: number
  video: {
    codec?: string
    width?: number
    height?: number
    pix_fmt?: string
    rotation: number
    color_transfer?: string | null
    color_primaries?: string | null
  } | null
  audio: { codec?: string; sample_rate: number; channels?: number } | null
}

function rotationOf(s: ProbeStream): number {
  const side = (s.side_data_list ?? []).find((d) => typeof d.rotation === 'number')
  if (side) return Math.round(side.rotation as number)
  if (s.tags?.rotate) return -Number(s.tags.rotate)
  return 0
}

export function factsOf(json: ProbeJson): Facts {
  const streams = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.find((s) => s.codec_type === 'audio')
  return {
    format: json.format?.format_name,
    duration: Math.round(Number(json.format?.duration ?? 0) * 1000) / 1000,
    bytes: Number(json.format?.size ?? 0),
    video: v
      ? {
          codec: v.codec_name,
          width: v.width,
          height: v.height,
          pix_fmt: v.pix_fmt,
          rotation: rotationOf(v),
          color_transfer: v.color_transfer ?? null,
          color_primaries: v.color_primaries ?? null
        }
      : null,
    audio: a ? { codec: a.codec_name, sample_rate: Number(a.sample_rate ?? 0), channels: a.channels } : null
  }
}

export async function probe(path: string): Promise<{ json: ProbeJson; facts: Facts; stdout: string }> {
  const r = await run('ffprobe', [...PROBE_ARGS, path])
  if (r.code !== 0) throw new Error(`ffprobe ${path} exited ${r.code}: ${r.stderr.slice(-500)}`)
  const json = JSON.parse(r.stdout) as ProbeJson
  return { json, facts: factsOf(json), stdout: r.stdout }
}

const MEAN = /mean:\[(\d+) (\d+) (\d+)/

/** The mean colour of a region of the frame at t, as [r, g, b]. */
export async function meanColour(path: string, t: number, x: number, y: number, w: number, h: number): Promise<number[]> {
  const input = t ? ['-ss', t.toFixed(3), '-i', path] : ['-i', path]
  return meanColourOf(input, `crop=${w}:${h}:${x}:${y}`)
}

/** The mean colour of the first frame of an input (its options and -i), after a filter. */
export async function meanColourOf(input: string[], filter = 'null'): Promise<number[]> {
  const r = await run('ffmpeg', ['-hide_banner', ...input, '-frames:v', '1', '-vf', `${filter},format=gbrp,showinfo`, '-f', 'null', '-'])
  // The first frame shown is the one at t (see tools/measure.py).
  for (const line of stderrLines(r)) {
    const m = MEAN.exec(line)
    if (m) return [Number(m[3]), Number(m[1]), Number(m[2])]
  }
  throw new Error(`no colour from ${input.join(' ')} (exit ${r.code}): ${r.stderr.slice(-400)}`)
}

/** volumedetect's mean volume, in dB. */
export async function meanVolume(input: string[]): Promise<number> {
  const r = await run('ffmpeg', ['-hide_banner', ...input, '-af', 'volumedetect', '-f', 'null', '-'])
  const m = /mean_volume:\s+(-?[\d.]+) dB/.exec(r.stderr)
  if (!m) throw new Error(`no volume from ${input.join(' ')} (exit ${r.code}): ${r.stderr.slice(-400)}`)
  return Number(m[1])
}

/** When the video's keyframes fall, in seconds. */
export async function keyframeTimes(path: string): Promise<number[]> {
  const r = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path])
  if (r.code !== 0) throw new Error(`ffprobe keyframes of ${path} exited ${r.code}: ${r.stderr.slice(-300)}`)
  return r.stdout
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => /^-?[\d.]+$/.test(l))
    .map((l) => Math.round(Number(l) * 1000) / 1000)
}

const LOUDNESS = /I:\s+(-?[\d.]+) LUFS/

export async function loudness(path: string): Promise<number> {
  const r = await run('ffmpeg', ['-hide_banner', '-i', path, '-af', 'ebur128', '-f', 'null', '-'])
  const found = [...r.stderr.matchAll(new RegExp(LOUDNESS, 'g'))]
  if (!found.length) throw new Error(`no loudness for ${path} (exit ${r.code})`)
  return Number(found[found.length - 1][1])
}

export function colourClose(a: number[], b: number[], tolerance: number): boolean {
  return a.length === 3 && b.length === 3 && a.every((v, i) => Math.abs(v - b[i]) <= tolerance)
}
