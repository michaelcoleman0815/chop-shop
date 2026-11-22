#!/usr/bin/env node
/**
 * Prints what a caption face's file says about itself: its names (the family
 * libass matches a style's Fontname against), its weight, and the vertical
 * metrics MOTION_FONTS keeps (shared/motion/fonts.ts) as fractions of the em.
 * Reads the TrueType tables directly, so it needs nothing installed.
 *
 * Usage: node scripts/read-font.mjs resources/fonts/Inter-Bold.ttf [...]
 */
import { readFileSync } from 'fs'
import { basename } from 'path'

function tables(buf) {
  const n = buf.readUInt16BE(4)
  const out = {}
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16
    out[buf.toString('latin1', at, at + 4)] = buf.readUInt32BE(at + 8)
  }
  return out
}

function names(buf, at) {
  const count = buf.readUInt16BE(at + 2)
  const strings = at + buf.readUInt16BE(at + 4)
  const out = {}
  for (let i = 0; i < count; i++) {
    const r = at + 6 + i * 12
    const [platform, , language, id, length, offset] = [0, 2, 4, 6, 8, 10].map((o) => buf.readUInt16BE(r + o))
    if (platform !== 3 || language !== 0x409 || out[id]) continue
    const raw = buf.subarray(strings + offset, strings + offset + length)
    let s = ''
    for (let j = 0; j < raw.length; j += 2) s += String.fromCharCode(raw.readUInt16BE(j))
    out[id] = s
  }
  return out
}

for (const file of process.argv.slice(2)) {
  const buf = readFileSync(file)
  const t = tables(buf)
  const upm = buf.readUInt16BE(t.head + 18)
  const os2 = t['OS/2']
  const version = buf.readUInt16BE(os2)
  const weight = buf.readUInt16BE(os2 + 4)
  const typoAsc = buf.readInt16BE(os2 + 68)
  const typoDesc = buf.readInt16BE(os2 + 70)
  const winAsc = buf.readUInt16BE(os2 + 74)
  const winDesc = buf.readUInt16BE(os2 + 76)
  const cap = version >= 2 ? buf.readInt16BE(os2 + 88) : null
  const hheaAsc = buf.readInt16BE(t.hhea + 4)
  const hheaDesc = buf.readInt16BE(t.hhea + 6)
  const n = names(buf, t.name)
  const f = (v) => (v === null ? null : +(v / upm).toFixed(3))
  console.log(
    JSON.stringify({
      file: basename(file),
      family: n[1],
      style: n[2],
      full: n[4],
      postscript: n[6],
      typographic: n[16] ?? null,
      weight,
      upm,
      cap: f(cap),
      ascent: f(hheaAsc),
      descent: f(-hheaDesc),
      typo: [f(typoAsc), f(-typoDesc)],
      winAscent: `${winAsc} / ${upm}`,
      winDescent: `${winDesc} / ${upm}`
    })
  )
}
