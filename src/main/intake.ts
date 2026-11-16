import { spawn } from 'child_process'

/**
 * What a recording is, read once when it comes in: its shape as shown, its
 * real frame rate, its picture encoding and its sound. Raw footage breaks a
 * naive pipeline in a handful of ways (docs/research/raw-footage.md,
 * section 3): a phone's portrait clip is stored landscape with a rotation
 * flag; a phone or screen recorder writes a variable frame rate whose
 * average says 24 when it was shot at 30; an iPhone's HDR looks washed out
 * when converted as if it were ordinary video; a lavalier on one input
 * leaves the other channel empty. Each is a fact here, and each fact either
 * changes how the recording is cut and rendered or is said in a sentence.
 *
 * Nothing here needs Electron, so it runs in tests against real files.
 */

/** How a recording's picture is encoded, as far as rendering cares. */
export type ColorEncoding = 'sdr' | 'hlg' | 'pq'

export interface SourceFacts {
  /** Shown size, after the rotation a phone recorded. */
  width: number
  height: number
  /** Degrees clockwise the picture is turned for showing: 0, 90, 180 or 270. */
  rotation: number
  /** The rate to render at: the nominal rate when the file's frame rate varies. */
  fps: number
  /** True when frames come at uneven intervals (phones in low light, screen recorders). */
  vfr: boolean
  codec: string
  /** Bits per colour sample: 8, 10 or 12. */
  bitDepth: number
  color: ColorEncoding
  /** Dolby Vision metadata is present; profile 8.4 plays as HLG. */
  dolbyVision: boolean
  durationSec: number
  /**
   * The first sound stream. sampleFormat is how ffmpeg decodes it, which is
   * float for every compressed codec, so only a PCM codec says how it was recorded.
   */
  audio: { codec: string; channels: number; layout: string; sampleFormat: string; rate: number; streams: number } | null
}

/** ffprobe's arguments for everything intake reads. */
export const PROBE_ARGS = [
  '-v',
  'error',
  '-show_entries',
  'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,pix_fmt,bits_per_raw_sample,' +
    'color_transfer,color_primaries,channels,channel_layout,sample_fmt,sample_rate:stream_side_data:' +
    'stream_tags=rotate:format=duration',
  '-of',
  'json'
]

interface ProbeStream {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  pix_fmt?: string
  bits_per_raw_sample?: string
  color_transfer?: string
  color_primaries?: string
  channels?: number
  channel_layout?: string
  sample_fmt?: string
  sample_rate?: string
  side_data_list?: { side_data_type?: string; rotation?: number }[]
  tags?: { rotate?: string }
}

const rate = (r: string | undefined): number => {
  const [n, d] = String(r ?? '')
    .split('/')
    .map(Number)
  return n > 0 && d > 0 ? n / d : 0
}

/** Facts from ffprobe's JSON. Pure, so it is tested on recorded output too. */
export function readProbe(json: { streams?: ProbeStream[]; format?: { duration?: string } }): SourceFacts {
  const streams = json.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video') ?? {}
  const audio = streams.filter((s) => s.codec_type === 'audio')

  // Rotation: the display matrix in newer files, the rotate tag in older ones.
  const matrix = v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation
  const raw = matrix ?? Number(v.tags?.rotate ?? 0)
  const rotation = (((Math.round(raw / 90) * 90) % 360) + 360) % 360
  const turned = rotation === 90 || rotation === 270
  const codedW = Number(v.width ?? 0)
  const codedH = Number(v.height ?? 0)

  // Frame rate: the average is what the file averaged, which a phone that
  // dropped frames in the dark pulls under the rate it was shot at. The base
  // rate is what it was shot at, unless it is a timebase rather than a rate.
  const avg = rate(v.avg_frame_rate)
  const base = rate(v.r_frame_rate)
  const sane = (x: number): boolean => x >= 10 && x <= 120
  const vfr = sane(base) && avg > 0 && Math.abs(base - avg) / base > 0.01
  const fps = vfr ? base : sane(avg) ? avg : sane(base) ? base : 30

  const transfer = v.color_transfer ?? ''
  const color: ColorEncoding = transfer === 'arib-std-b67' ? 'hlg' : transfer === 'smpte2084' ? 'pq' : 'sdr'
  const bits =
    Number(v.bits_per_raw_sample) ||
    (/1[02]le|p010|p012/.test(v.pix_fmt ?? '') ? (/12/.test(v.pix_fmt ?? '') ? 12 : 10) : 8)
  const a = audio[0]
  return {
    width: turned ? codedH : codedW,
    height: turned ? codedW : codedH,
    rotation,
    fps: Math.round(fps * 1000) / 1000,
    vfr,
    codec: v.codec_name ?? '',
    bitDepth: bits,
    color,
    dolbyVision: !!v.side_data_list?.some((d) => /dovi|dolby/i.test(d.side_data_type ?? '')),
    durationSec: Number(json.format?.duration ?? 0),
    audio: a
      ? {
          codec: a.codec_name ?? '',
          channels: Number(a.channels ?? 0),
          layout: a.channel_layout ?? '',
          sampleFormat: a.sample_fmt ?? '',
          rate: Number(a.sample_rate ?? 0),
          streams: audio.length
        }
      : null
  }
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(out || err) : reject(new Error(err.trim().split('\n').pop()))))
  })
}

/** Reads a recording's facts with ffprobe. */
export async function probeSource(ffprobe: string, path: string): Promise<SourceFacts> {
  return readProbe(JSON.parse(await run(ffprobe, [...PROBE_ARGS, path])))
}

/**
 * The colour conversion that goes first in a recording's chain when it
 * renders, or null for ordinary video. HDR is turned to linear light, tone
 * mapped in float so highlights roll off instead of clipping, moved from
 * BT.2020 to BT.709 and tagged so; desat=0 keeps faces from bleaching
 * (section 3, HDR). Without zscale, a plain colour-space conversion keeps it
 * from looking washed out, without the tone mapping.
 */
export function colorConversion(color: ColorEncoding | undefined, zscale = true): string | null {
  if (!color || color === 'sdr') return null
  const tin = color === 'hlg' ? 'arib-std-b67' : 'smpte2084'
  if (!zscale) return 'colorspace=all=bt709:iall=bt2020:fast=1,format=yuv420p'
  // PQ is graded brighter than HLG's reference white, so it is read against
  // a higher peak (section 3, HDR).
  const npl = color === 'hlg' ? 100 : 203
  return (
    `zscale=tin=${tin}:pin=bt2020:min=bt2020nc:rin=tv:t=linear:npl=${npl},format=gbrpf32le,` +
    'zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p'
  )
}

/** Whether this ffmpeg has the zscale filter, asked once per binary. */
const zscaleCache = new Map<string, Promise<boolean>>()
export function hasZscale(ffmpeg: string): Promise<boolean> {
  let hit = zscaleCache.get(ffmpeg)
  if (!hit) {
    hit = run(ffmpeg, ['-hide_banner', '-filters'])
      .then((out) => / zscale /.test(out))
      .catch(() => false)
    zscaleCache.set(ffmpeg, hit)
  }
  return hit
}

/**
 * What came in, in one plain sentence, and at most three facts as chips.
 * Only what matters to the person: the things Cutalong fixed for them.
 */
export function intakeReply(name: string, f: SourceFacts): { sentence: string; facts: string[] } {
  const fixes: string[] = []
  const facts: string[] = []
  if (f.color !== 'sdr') {
    fixes.push(`it's HDR, so I'll convert its colour for export`)
    facts.push(f.color === 'hlg' ? (f.dolbyVision ? 'Dolby Vision, HLG base' : 'HDR, HLG') : 'HDR, PQ')
  }
  if (f.rotation !== 0) {
    fixes.push(`it was recorded turned, so I'll keep it ${f.height > f.width ? 'upright' : 'level'}`)
    facts.push(`${f.width}x${f.height} as shown`)
  }
  if (f.vfr) {
    fixes.push(`its frame rate varies, so I'll export a steady ${Math.round(f.fps * 100) / 100} fps`)
    facts.push('Variable frame rate')
  }
  if (f.audio === null) facts.push('No sound')
  // AAC, MP3 and Opus all decode to float; only float PCM was recorded that way.
  else if (/^pcm_f(32|64)/.test(f.audio.codec)) facts.push('32-bit float sound')
  const sentence = fixes.length === 0 ? '' : `${name}: ${listOf(fixes)}.`
  return { sentence: sentence.charAt(0).toUpperCase() + sentence.slice(1), facts: facts.slice(0, 3) }
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/**
 * Files one camera split from a single recording: GoPro's GH or GX, then a
 * two-digit chapter, then the recording's four-digit number. Grouped by that
 * number, in chapter order. Other files stand alone.
 */
export function chapterGroups(paths: string[]): string[][] {
  const groups = new Map<string, { chapter: number; path: string }[]>()
  const alone: string[][] = []
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() ?? p
    const m = /^(G[HX])(\d{2})(\d{4})\.(mp4|mov)$/i.exec(name)
    if (!m) {
      alone.push([p])
      continue
    }
    const key = `${m[1].toUpperCase()}${m[3]}`
    groups.set(key, [...(groups.get(key) ?? []), { chapter: Number(m[2]), path: p }])
  }
  return [...[...groups.values()].map((g) => g.sort((a, b) => a.chapter - b.chapter).map((x) => x.path)), ...alone]
}
