/**
 * Letter outlines from the faces the app bundles (resources/fonts, TrueType),
 * for titles extruded into 3D. The same files the editor and the export set
 * flat titles in, read here without a font library: the tables a glyph's
 * outline needs (its character map, its contours and its advance), so an
 * extruded word has the very letters a flat one has. Kerning and ligatures
 * are left out; a variable face gives its default outlines.
 *
 * Runs anywhere: the editor, the export's 3D page, and Node for the tests.
 */

/** One step of an outline, in font units, y up. */
export type OutlineCmd = { m: [number, number] } | { l: [number, number] } | { q: [number, number, number, number] }

export interface Glyph {
  /** How far the pen moves after it, in font units. */
  advance: number
  /** Its contours, each starting with a move. */
  path: OutlineCmd[]
}

export interface GlyphFont {
  unitsPerEm: number
  ascender: number
  descender: number
  /** The outline for a character, or null when the face has none. */
  glyph(char: string): Glyph | null
}

class Reader {
  readonly view: DataView
  constructor(buf: ArrayBuffer | Uint8Array) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }
  u8 = (at: number): number => this.view.getUint8(at)
  u16 = (at: number): number => this.view.getUint16(at)
  i16 = (at: number): number => this.view.getInt16(at)
  u32 = (at: number): number => this.view.getUint32(at)
  tag = (at: number): string => String.fromCharCode(this.u8(at), this.u8(at + 1), this.u8(at + 2), this.u8(at + 3))
}

/** Reads a TrueType face. Throws when it is not one (a CFF face, a WOFF). */
export function parseFont(buf: ArrayBuffer | Uint8Array): GlyphFont {
  const r = new Reader(buf)
  const version = r.u32(0)
  if (version !== 0x00010000 && r.tag(0) !== 'true') throw new Error('Not a TrueType face.')
  const tables = new Map<string, number>()
  const count = r.u16(4)
  for (let i = 0; i < count; i++) tables.set(r.tag(12 + i * 16), r.u32(12 + i * 16 + 8))
  const table = (name: string): number => {
    const at = tables.get(name)
    if (at === undefined) throw new Error(`The face has no ${name} table.`)
    return at
  }
  const head = table('head')
  const unitsPerEm = r.u16(head + 18)
  const longLoca = r.i16(head + 50) === 1
  const numGlyphs = r.u16(table('maxp') + 4)
  const hhea = table('hhea')
  const ascender = r.i16(hhea + 4)
  const descender = r.i16(hhea + 6)
  const metrics = r.u16(hhea + 34)
  const hmtx = table('hmtx')
  const loca = table('loca')
  const glyf = table('glyf')
  const map = charMap(r, table('cmap'))

  const advance = (g: number): number => r.u16(hmtx + Math.min(g, metrics - 1) * 4)
  const offset = (g: number): number => (longLoca ? r.u32(loca + g * 4) : r.u16(loca + g * 2) * 2)

  const outlines = new Map<number, OutlineCmd[]>()
  const outline = (g: number, depth = 0): OutlineCmd[] => {
    const hit = outlines.get(g)
    if (hit) return hit
    const from = offset(g)
    const to = offset(g + 1)
    let path: OutlineCmd[] = []
    if (g < numGlyphs && to > from && depth < 8) {
      const at = glyf + from
      const contours = r.i16(at)
      path = contours >= 0 ? simpleGlyph(r, at, contours) : compoundGlyph(r, at, (c) => outline(c, depth + 1))
    }
    outlines.set(g, path)
    return path
  }

  return {
    unitsPerEm,
    ascender,
    descender,
    glyph(char) {
      const code = char.codePointAt(0)
      if (code === undefined) return null
      const g = map(code)
      if (g === 0 && char !== ' ') return null
      return { advance: advance(g), path: outline(g) }
    }
  }
}

/** The character map: format 4 (the basic plane) or 12 (all of Unicode), Windows or Unicode platform. */
function charMap(r: Reader, cmap: number): (code: number) => number {
  const n = r.u16(cmap + 2)
  let best = -1
  let bestFormat = 0
  for (let i = 0; i < n; i++) {
    const platform = r.u16(cmap + 4 + i * 8)
    const encoding = r.u16(cmap + 4 + i * 8 + 2)
    const at = cmap + r.u32(cmap + 4 + i * 8 + 4)
    const format = r.u16(at)
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    if (!unicode || (format !== 4 && format !== 12)) continue
    if (format > bestFormat) {
      best = at
      bestFormat = format
    }
  }
  if (best < 0) return () => 0
  const at = best
  if (bestFormat === 12) {
    const groups = r.u32(at + 12)
    return (code) => {
      for (let i = 0; i < groups; i++) {
        const g = at + 16 + i * 12
        const start = r.u32(g)
        const end = r.u32(g + 4)
        if (code >= start && code <= end) return r.u32(g + 8) + (code - start)
      }
      return 0
    }
  }
  const segs = r.u16(at + 6) / 2
  const ends = at + 14
  const starts = ends + segs * 2 + 2
  const deltas = starts + segs * 2
  const ranges = deltas + segs * 2
  return (code) => {
    if (code > 0xffff) return 0
    for (let i = 0; i < segs; i++) {
      if (code > r.u16(ends + i * 2)) continue
      const start = r.u16(starts + i * 2)
      if (code < start) return 0
      const delta = r.i16(deltas + i * 2)
      const range = r.u16(ranges + i * 2)
      if (range === 0) return (code + delta) & 0xffff
      const g = r.u16(ranges + i * 2 + range + (code - start) * 2)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
}

const ON_CURVE = 1
const X_SHORT = 2
const Y_SHORT = 4
const REPEAT = 8
const X_SAME = 16
const Y_SAME = 32

function simpleGlyph(r: Reader, at: number, contours: number): OutlineCmd[] {
  const ends: number[] = []
  for (let i = 0; i < contours; i++) ends.push(r.u16(at + 10 + i * 2))
  const points = contours ? ends[contours - 1] + 1 : 0
  let p = at + 10 + contours * 2
  p += 2 + r.u16(p)
  const flags: number[] = []
  while (flags.length < points) {
    const f = r.u8(p++)
    flags.push(f)
    if (f & REPEAT) {
      let times = r.u8(p++)
      while (times-- > 0 && flags.length < points) flags.push(f)
    }
  }
  const xs: number[] = []
  let x = 0
  for (const f of flags) {
    if (f & X_SHORT) {
      const d = r.u8(p++)
      x += f & X_SAME ? d : -d
    } else if (!(f & X_SAME)) {
      x += r.i16(p)
      p += 2
    }
    xs.push(x)
  }
  const ys: number[] = []
  let y = 0
  for (const f of flags) {
    if (f & Y_SHORT) {
      const d = r.u8(p++)
      y += f & Y_SAME ? d : -d
    } else if (!(f & Y_SAME)) {
      y += r.i16(p)
      p += 2
    }
    ys.push(y)
  }
  const path: OutlineCmd[] = []
  let first = 0
  for (const end of ends) {
    const pts = []
    for (let i = first; i <= end; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & ON_CURVE) !== 0 })
    first = end + 1
    path.push(...contour(pts))
  }
  return path
}

/** One closed contour as moves, lines and quadratic curves, with the points two curves imply between them. */
function contour(pts: { x: number; y: number; on: boolean }[]): OutlineCmd[] {
  if (pts.length === 0) return []
  // Start on a point on the curve; when there is none, halfway between the first two.
  let start = pts.findIndex((q) => q.on)
  let ring = pts
  if (start < 0) {
    const a = pts[0]
    const b = pts[1] ?? pts[0]
    ring = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...pts]
    start = 0
  }
  const n = ring.length
  const at = (i: number): { x: number; y: number; on: boolean } => ring[(start + i) % n]
  const out: OutlineCmd[] = [{ m: [at(0).x, at(0).y] }]
  let control: { x: number; y: number } | null = null
  for (let i = 1; i <= n; i++) {
    const q = at(i)
    if (q.on) {
      out.push(control ? { q: [control.x, control.y, q.x, q.y] } : { l: [q.x, q.y] })
      control = null
    } else if (control) {
      const mid = { x: (control.x + q.x) / 2, y: (control.y + q.y) / 2 }
      out.push({ q: [control.x, control.y, mid.x, mid.y] })
      control = q
    } else control = q
  }
  return out
}

const ARGS_ARE_WORDS = 1
const ARGS_ARE_XY = 2
const HAS_SCALE = 8
const MORE = 32
const HAS_XY_SCALE = 64
const HAS_2X2 = 128

/** A glyph made of others (an accented letter), each moved and scaled into place. */
function compoundGlyph(r: Reader, at: number, part: (g: number) => OutlineCmd[]): OutlineCmd[] {
  const path: OutlineCmd[] = []
  let p = at + 10
  const f2dot14 = (o: number): number => r.i16(o) / 16384
  for (;;) {
    const flags = r.u16(p)
    const g = r.u16(p + 2)
    p += 4
    let dx = 0
    let dy = 0
    if (flags & ARGS_ARE_WORDS) {
      dx = r.i16(p)
      dy = r.i16(p + 2)
      p += 4
    } else {
      dx = (r.u8(p) << 24) >> 24
      dy = (r.u8(p + 1) << 24) >> 24
      p += 2
    }
    // Point-matched placement is rare in Latin faces: the part stays where it is drawn.
    if (!(flags & ARGS_ARE_XY)) dx = dy = 0
    let a = 1
    let b = 0
    let c = 0
    let d = 1
    if (flags & HAS_SCALE) {
      a = d = f2dot14(p)
      p += 2
    } else if (flags & HAS_XY_SCALE) {
      a = f2dot14(p)
      d = f2dot14(p + 2)
      p += 4
    } else if (flags & HAS_2X2) {
      a = f2dot14(p)
      b = f2dot14(p + 2)
      c = f2dot14(p + 4)
      d = f2dot14(p + 6)
      p += 8
    }
    const move = (x: number, y: number): [number, number] => [a * x + c * y + dx, b * x + d * y + dy]
    for (const cmd of part(g)) {
      if ('m' in cmd) path.push({ m: move(...cmd.m) })
      else if ('l' in cmd) path.push({ l: move(...cmd.l) })
      else path.push({ q: [...move(cmd.q[0], cmd.q[1]), ...move(cmd.q[2], cmd.q[3])] })
    }
    if (!(flags & MORE)) break
  }
  return path
}

export interface LaidGlyph {
  char: string
  /** Where its origin sits, in font units, from the block's own origin. */
  x: number
  y: number
  glyph: Glyph
}

/**
 * A title's letters on their lines, in font units: each line centred on x 0
 * (or set to the left or right of it), the block centred on y 0 by the height
 * of its capitals, a line apart by the face's own spacing.
 */
export function layoutGlyphs(font: GlyphFont, text: string, align: 'left' | 'center' | 'right' = 'center'): LaidGlyph[] {
  const lines = text.split('\n')
  const lineHeight = (font.ascender - font.descender) * 1.05
  const cap = font.unitsPerEm * 0.7
  const out: LaidGlyph[] = []
  const top = ((lines.length - 1) * lineHeight) / 2
  lines.forEach((line, i) => {
    const glyphs: { char: string; glyph: Glyph }[] = []
    for (const char of Array.from(line)) {
      const glyph = font.glyph(char) ?? font.glyph('?')
      if (glyph) glyphs.push({ char, glyph })
    }
    const width = glyphs.reduce((w, g) => w + g.glyph.advance, 0)
    let x = align === 'left' ? 0 : align === 'right' ? -width : -width / 2
    const y = top - i * lineHeight - cap / 2
    for (const g of glyphs) {
      out.push({ ...g, x, y })
      x += g.glyph.advance
    }
  })
  return out
}
