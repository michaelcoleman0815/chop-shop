import type { Gps } from './schema'

/**
 * When, where and on what a clip was recorded, read from the tags its file
 * carries. iPhones write the local time with its offset, the place as an
 * ISO 6709 string and the make and model; Android phones write a location
 * and their maker; a GoPro marks its streams and firmware; most cameras at
 * least write a creation time, and every camera names its files its own way.
 *
 * Pure: it reads ffprobe's JSON (intake's whole-stream probe), so it is
 * tested on recorded output.
 */

interface Tagged {
  tags?: Record<string, string | undefined>
}

export interface ShootTags {
  /** When it was recorded, as an ISO time, or null when the file does not say or says nonsense. */
  recordedAt: string | null
  camera: string
  gps: Gps | null
}

/** Tags by lower-cased name, the container's first, then each stream's. */
function allTags(json: { format?: Tagged; streams?: Tagged[] }): Map<string, string> {
  const out = new Map<string, string>()
  const add = (tags: Tagged['tags']): void => {
    for (const [k, v] of Object.entries(tags ?? {})) {
      const key = k.toLowerCase()
      if (typeof v === 'string' && v.trim() && !out.has(key)) out.set(key, v.trim())
    }
  }
  add(json.format?.tags)
  for (const s of json.streams ?? []) add(s.tags)
  return out
}

/** "+37.7749-122.4194+010.000/" as a place, or null. */
export function parseIso6709(text: string | undefined): Gps | null {
  const m = /^\s*([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text ?? '')
  if (!m) return null
  const lat = Number(m[1])
  const lon = Number(m[2])
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  // 0,0 is where a camera without a fix says it is.
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null
  return { lat, lon }
}

/** A recording time as an ISO string, or null when it is missing or a camera's placeholder. */
export function parseTime(text: string | undefined): string | null {
  if (!text) return null
  // "2026-05-01T09:12:05-0700" needs a colon in its offset to be read everywhere.
  const normal = text
    .trim()
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    .replace(' ', 'T')
  const ms = Date.parse(normal)
  if (!Number.isFinite(ms)) return null
  const year = new Date(ms).getUTCFullYear()
  // 1904 and 1970 are the zero of a clock nobody set; 2000 is a camera fresh out of the box.
  if (year < 2001 || year > 2100) return null
  return new Date(ms).toISOString()
}

/** What a camera names its files with: IMG_0042 is IMG, GX010042 is GX, DJI_0042 is DJI. */
export function fileFamily(name: string): string {
  const base = name.replace(/\.[^.]+$/, '')
  const m = /^([A-Za-z]{1,6})[_-]?\d/.exec(base)
  return m ? m[1].toUpperCase() : ''
}

const FAMILY_CAMERA: Record<string, string> = {
  GX: 'GoPro',
  GH: 'GoPro',
  GOPR: 'GoPro',
  GP: 'GoPro',
  DJI: 'DJI',
  PXL: 'Pixel',
  MVI: 'Canon',
  DSC: 'Sony',
  C: 'Sony'
}

export function readShootTags(json: { format?: Tagged; streams?: Tagged[] }, name: string): ShootTags {
  const tags = allTags(json)
  const recordedAt =
    parseTime(tags.get('com.apple.quicktime.creationdate')) ?? parseTime(tags.get('creation_time')) ?? null
  const gps =
    parseIso6709(tags.get('com.apple.quicktime.location.iso6709')) ??
    parseIso6709(tags.get('location')) ??
    parseIso6709(tags.get('location-eng')) ??
    null
  const make = tags.get('com.apple.quicktime.make') ?? tags.get('com.android.manufacturer') ?? tags.get('make') ?? ''
  const model = tags.get('com.apple.quicktime.model') ?? tags.get('com.android.model') ?? tags.get('model') ?? ''
  const handler = tags.get('handler_name') ?? ''
  const firmware = tags.get('firmware') ?? ''
  const encoder = tags.get('encoder') ?? ''
  let camera = [make, model.startsWith(make) ? model.slice(make.length).trim() : model].filter(Boolean).join(' ')
  if (!camera && (/gopro/i.test(handler) || /^H\d/.test(firmware))) camera = 'GoPro'
  if (!camera && /dji/i.test(`${handler} ${encoder}`)) camera = 'DJI'
  if (!camera) {
    const family = fileFamily(name)
    camera = FAMILY_CAMERA[family] ?? (family || 'camera')
  }
  return { recordedAt, camera, gps }
}
