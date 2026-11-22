/**
 * What ffmpeg's banner says about a file, read without ffprobe (the app
 * ships ffmpeg; main/inspiration/measure reads the same banner for size and
 * length). This reads more of it: the codec and its profile, the pixel
 * format, whether the picture carries transparency, the frame rate, and
 * whether it is a still. Cover art on a song is not a picture to use.
 */

export interface ProbeVideo {
  codec: string
  /** "4444" for ProRes 4444, "High" for H.264 High. */
  profile: string | null
  pixFmt: string | null
  /** Display size, after any rotation a phone recorded. */
  width: number
  height: number
  fps: number | null
  /** Transparency: true or false when the banner says, null when it cannot tell. */
  alpha: boolean | null
}

export interface ProbeInfo {
  /** ffmpeg's name for the container: "mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "png_pipe". */
  format: string
  durationSec: number | null
  video: ProbeVideo | null
  audio: { codec: string; sampleRate: number | null; channels: string | null } | null
  /** A single picture rather than moving footage. */
  still: boolean
}

const ALPHA_FORMATS = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya8|ya16|rgba64|bgra64)/

/** Pixel formats are the first word of the stream's details that names one. */
const PIX_FMT =
  /\b(yuva?[0-9a-z]+|yuvj[0-9a-z]+|rgba?[0-9a-z]*|bgra?[0-9a-z]*|argb|abgr|0rgb|rgb0|gbrap?[0-9a-z]*|gray[0-9a-z]*|ya8|ya16[a-z]*|pal8|nv12|nv21|p010[a-z]*|monob|monow)\b/

interface StreamText {
  head: string
  meta: string
}

/** Each stream's line and the metadata indented under it. */
function streams(stderr: string): StreamText[] {
  const lines = stderr.split(/\r?\n/)
  const out: StreamText[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!/^\s*Stream #\d+:\d+/.test(line)) continue
    const indent = line.length - line.trimStart().length
    const meta: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]
      const ind = next.length - next.trimStart().length
      if (/^\s*Stream #\d+:\d+/.test(next) || ind <= indent || /^\S/.test(next)) break
      meta.push(next.trim())
    }
    out.push({ head: line.trim(), meta: meta.join('\n') })
  }
  return out
}

export function parseBanner(stderr: string): ProbeInfo | null {
  const input = /Input #0, (.+?), from /.exec(stderr)
  if (!input) return null
  const format = input[1]
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const durationSec = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null

  let video: ProbeVideo | null = null
  let audio: ProbeInfo['audio'] = null
  for (const s of streams(stderr)) {
    const kind = /: (Video|Audio): (.*)$/.exec(s.head)
    if (!kind) continue
    const details = kind[2]
    if (kind[1] === 'Audio') {
      if (audio) continue
      const codec = /^([\w-]+)/.exec(details)?.[1] ?? 'unknown'
      const rate = /(\d+) Hz/.exec(details)
      const channels = /Hz, ([^,]+)/.exec(details)
      audio = { codec, sampleRate: rate ? Number(rate[1]) : null, channels: channels ? channels[1].trim() : null }
      continue
    }
    // Cover art on a song, or a thumbnail inside a container, is not footage.
    if (video || /\(attached pic\)/.test(details)) continue
    const codec = /^([\w-]+)/.exec(details)?.[1] ?? 'unknown'
    const profile = new RegExp(`^${codec}\\s*\\(([^)]+)\\)`).exec(details)?.[1] ?? null
    // The pixel format comes after the codec's own parentheses: "prores (4444) (ap4h / 0x68347061), yuva444p12le(...)".
    const afterCodec = details.slice(details.indexOf(',') + 1)
    const pixFmt = PIX_FMT.exec(afterCodec)?.[1] ?? null
    const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(afterCodec)
    if (!size) continue
    let width = Number(size[1])
    let height = Number(size[2])
    const rotation = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(`${s.meta}\n${stderr}`)
    if (rotation && Math.abs(Math.round(Number(rotation[1]) / 90)) % 2 === 1) [width, height] = [height, width]
    const fps = /(\d+(?:\.\d+)?) fps/.exec(details)
    const alphaMode = /alpha_mode\s*:\s*(\d)/i.exec(s.meta)
    let alpha: boolean | null
    if (codec === 'gif' || pixFmt === 'pal8') alpha = null
    else if (pixFmt && ALPHA_FORMATS.test(pixFmt)) alpha = true
    else if (alphaMode) alpha = alphaMode[1] === '1'
    // HEVC keeps its transparency in a second layer that ffmpeg before 7.1 does not decode: it cannot tell.
    else if (codec === 'hevc' && /mov|mp4/.test(format)) alpha = null
    else alpha = pixFmt ? false : null
    video = { codec, profile, pixFmt, width, height, fps: fps ? Number(fps[1]) : null, alpha }
  }
  if (!video && !audio) return null
  const imageFormat = /(_pipe|^image2)\b/.test(format)
  const still = !!video && !audio && (imageFormat || (durationSec === null && /^(png|mjpeg|webp|bmp|tiff)$/.test(video.codec)))
  return { format, durationSec: still ? null : durationSec, video, audio, still }
}
