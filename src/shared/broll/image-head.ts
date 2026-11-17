/**
 * A picture's size, and whether it has transparency, from the first bytes of
 * its file: PNG, JPEG (turned as its EXIF says), GIF, WebP and BMP. The
 * library indexer reads a few kilobytes instead of starting ffmpeg for every
 * photo in a folder. Null for anything it cannot read, which ffmpeg then
 * measures.
 */

export interface ImageHead {
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp'
  width: number
  height: number
  /** True or false when the file says; null when it cannot tell without decoding. */
  alpha: boolean | null
  /** An animated PNG, GIF or WebP. */
  animated: boolean
}

const u16be = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1]
const u32be = (b: Uint8Array, at: number): number => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3]
const u16le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8)
const u24le = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n))

function png(b: Uint8Array): ImageHead | null {
  if (b.length < 33 || ascii(b, 12, 4) !== 'IHDR') return null
  const width = u32be(b, 16)
  const height = u32be(b, 20)
  const colour = b[25]
  let alpha: boolean | null = colour === 6 || colour === 4 ? true : null
  let animated = false
  // Chunks up to the picture data say whether a palette or a colour key is transparent, and whether it moves.
  let at = 8
  while (at + 8 <= b.length) {
    const len = u32be(b, at)
    const type = ascii(b, at + 4, 4)
    if (type === 'tRNS') alpha = true
    if (type === 'acTL') animated = true
    if (type === 'IDAT' || type === 'IEND') break
    at += 12 + len
  }
  if (alpha === null && at + 8 <= b.length) alpha = false
  return { format: 'png', width, height, alpha, animated }
}

/** The EXIF orientation in an APP1 segment, 1 when there is none. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (ascii(b, start, 6) !== 'Exif\0\0') return 1
  const tiff = start + 6
  const little = ascii(b, tiff, 2) === 'II'
  const r16 = (at: number): number => (little ? u16le(b, at) : u16be(b, at))
  const r32 = (at: number): number => (little ? (u16le(b, at) | (u16le(b, at + 2) << 16)) >>> 0 : u32be(b, at))
  const ifd = tiff + r32(tiff + 4)
  if (ifd + 2 > end) return 1
  const count = r16(ifd)
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > end) break
    if (r16(e) === 0x0112) return r16(e + 8)
  }
  return 1
}

function jpeg(b: Uint8Array): ImageHead | null {
  let at = 2
  let orientation = 1
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) {
      at++
      continue
    }
    const marker = b[at + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      at += marker === 0xff ? 1 : 2
      continue
    }
    const len = u16be(b, at + 2)
    if (marker === 0xe1) orientation = exifOrientation(b, at + 4, Math.min(b.length, at + 2 + len))
    const sof = (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
    if (sof) {
      if (at + 9 > b.length) return null
      let height = u16be(b, at + 5)
      let width = u16be(b, at + 7)
      if (orientation >= 5 && orientation <= 8) [width, height] = [height, width]
      return { format: 'jpeg', width, height, alpha: false, animated: false }
    }
    if (marker === 0xda || marker === 0xd9) return null
    at += 2 + len
  }
  return null
}

function gif(b: Uint8Array): ImageHead | null {
  if (b.length < 10) return null
  // More than one image descriptor would need a walk through the frames; a GIF is taken to move.
  return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8), alpha: null, animated: true }
}

function webp(b: Uint8Array): ImageHead | null {
  if (b.length < 30 || ascii(b, 8, 4) !== 'WEBP') return null
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8 ') {
    return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, alpha: false, animated: false }
  }
  if (chunk === 'VP8L') {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0
    return {
      format: 'webp',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      alpha: ((bits >> 28) & 1) === 1,
      animated: false
    }
  }
  if (chunk === 'VP8X') {
    const flags = b[20]
    return {
      format: 'webp',
      width: u24le(b, 24) + 1,
      height: u24le(b, 27) + 1,
      alpha: (flags & 0x10) !== 0,
      animated: (flags & 0x02) !== 0
    }
  }
  return null
}

function bmp(b: Uint8Array): ImageHead | null {
  if (b.length < 30) return null
  const width = (b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24)) | 0
  const height = (b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)) | 0
  const bits = u16le(b, 28)
  return { format: 'bmp', width: Math.abs(width), height: Math.abs(height), alpha: bits === 32 ? null : false, animated: false }
}

export function imageHead(b: Uint8Array): ImageHead | null {
  if (b.length < 12) return null
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return png(b)
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b)
  if (ascii(b, 0, 4) === 'GIF8') return gif(b)
  if (ascii(b, 0, 4) === 'RIFF') return webp(b)
  if (ascii(b, 0, 2) === 'BM') return bmp(b)
  return null
}
