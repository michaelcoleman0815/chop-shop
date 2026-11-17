/**
 * Just enough of HLS (RFC 8216) to take a stretch of a trailer without
 * downloading the rest: the renditions a master playlist offers, the
 * segments of one rendition with their times, and which of them cover a
 * stretch. Steam serves its store trailers this way, as fragmented MP4:
 * one init segment, then independent segments a few seconds long.
 */

export interface Variant {
  uri: string
  bandwidth: number
  width: number | null
  height: number | null
  codecs: string | null
  /** The audio group it plays with, when the sound is a rendition of its own. */
  audio: string | null
}

export interface Rendition {
  type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS'
  group: string
  uri: string | null
  isDefault: boolean
}

export interface Segment {
  uri: string
  startSec: number
  durationSec: number
}

export interface MediaPlaylist {
  /** The init segment fragmented MP4 needs before any other, when there is one. */
  init: string | null
  segments: Segment[]
  totalSec: number
  /** Encrypted segments cannot be used; nothing here decrypts. */
  encrypted: boolean
  /** Whether every segment starts on a keyframe, so any run of them plays on its own. */
  independent: boolean
}

/** Attributes of a tag line: BANDWIDTH=2600000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=940x528. */
export function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  const body = line.slice(line.indexOf(':') + 1)
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  for (let m = re.exec(body); m; m = re.exec(body)) out[m[1]] = m[2].replace(/^"|"$/g, '')
  return out
}

const resolve = (uri: string, base: string): string => new URL(uri, base).href

export function isMaster(text: string): boolean {
  return /#EXT-X-STREAM-INF:/.test(text)
}

/** The renditions a master playlist offers, with their addresses made whole. */
export function parseMaster(text: string, base: string): { variants: Variant[]; renditions: Rendition[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const variants: Variant[] = []
  const renditions: Rendition[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attributes(line)
      const type = a.TYPE as Rendition['type']
      if (type)
        renditions.push({
          type,
          group: a['GROUP-ID'] ?? '',
          uri: a.URI ? resolve(a.URI, base) : null,
          isDefault: a.DEFAULT === 'YES'
        })
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attributes(line)
      // The address is the next line that is not a tag or a comment.
      let j = i + 1
      while (j < lines.length && (lines[j] === '' || lines[j].startsWith('#'))) j++
      if (j >= lines.length) break
      const size = /^(\d+)x(\d+)$/.exec(a.RESOLUTION ?? '')
      variants.push({
        uri: resolve(lines[j], base),
        bandwidth: Number(a.BANDWIDTH ?? a['AVERAGE-BANDWIDTH'] ?? 0) || 0,
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        codecs: a.CODECS ?? null,
        audio: a.AUDIO ?? null
      })
      i = j
    }
  }
  return { variants, renditions }
}

/**
 * The rendition to fetch: the tallest that is no taller than `maxHeight`,
 * or the shortest when every one is taller; the most bandwidth on a tie.
 */
export function pickVariant(variants: Variant[], maxHeight: number): Variant | null {
  if (variants.length === 0) return null
  const known = variants.filter((v) => v.height !== null)
  if (known.length === 0) return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0]
  const fits = known.filter((v) => (v.height ?? 0) <= maxHeight)
  const pool = fits.length ? fits : [[...known].sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]]
  return [...pool].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)[0]
}

/** One rendition's playlist: its init segment and its segments, each with when it starts. */
export function parseMedia(text: string, base: string): MediaPlaylist {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  let init: string | null = null
  let encrypted = false
  const independent = lines.includes('#EXT-X-INDEPENDENT-SEGMENTS')
  const segments: Segment[] = []
  let at = 0
  let pending: number | null = null
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = attributes(line).URI
      if (uri) init = resolve(uri, base)
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = attributes(line).METHOD
      if (method && method !== 'NONE') encrypted = true
    } else if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice('#EXTINF:'.length))
      pending = Number.isFinite(d) && d > 0 ? d : 0
    } else if (line && !line.startsWith('#') && pending !== null) {
      segments.push({ uri: resolve(line, base), startSec: at, durationSec: pending })
      at += pending
      pending = null
    }
  }
  return { init, segments, totalSec: at, encrypted, independent }
}

/**
 * The segments that cover a stretch, and the stretch they really span: it
 * starts where the first of them starts, so a run of independent segments
 * plays from its first frame.
 */
export function segmentsFor(
  playlist: MediaPlaylist,
  range: { startSec: number; endSec: number }
): { segments: Segment[]; startSec: number; endSec: number } {
  const picked = playlist.segments.filter(
    (s) => s.startSec + s.durationSec > range.startSec + 1e-6 && s.startSec < range.endSec - 1e-6
  )
  if (picked.length === 0) return { segments: [], startSec: range.startSec, endSec: range.startSec }
  const last = picked[picked.length - 1]
  return { segments: picked, startSec: picked[0].startSec, endSec: last.startSec + last.durationSec }
}

/** An ISO 8601 duration as DASH writes it ("PT1M15.9S", "PT1H2M3S"), in seconds, or null. */
export function isoSeconds(value: string): number | null {
  const v = value.trim()
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(v)
  if (!m || v === 'P' || v === 'PT') return null
  const [d, h, min, s] = m.slice(1).map((x) => (x ? Number(x) : 0))
  return d * 86400 + h * 3600 + min * 60 + s
}

/**
 * The length and largest picture a DASH manifest (MPD) describes, read from
 * its text: Steam lists one beside each trailer's HLS, and its few kilobytes
 * say what the trailer is before any of it is fetched.
 */
export function mpdFacts(xml: string): { durationSec: number | null; width: number | null; height: number | null } {
  const mpd = /<MPD\b[^>]*>/i.exec(xml)?.[0] ?? ''
  const length = /\bmediaPresentationDuration="([^"]+)"/.exec(mpd)?.[1]
  let width = 0
  let height = 0
  for (const tag of xml.match(/<(?:AdaptationSet|Representation)\b[^>]*>/gi) ?? []) {
    if (/\b(?:contentType|mimeType)="audio/i.test(tag)) continue
    const w = Number(/\b(?:maxWidth|width)="(\d+)"/.exec(tag)?.[1] ?? 0)
    const h = Number(/\b(?:maxHeight|height)="(\d+)"/.exec(tag)?.[1] ?? 0)
    if (w * h > width * height) [width, height] = [w, h]
  }
  return { durationSec: length ? isoSeconds(length) : null, width: width || null, height: height || null }
}
