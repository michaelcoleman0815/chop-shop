#!/usr/bin/env node
/**
 * Measures the bundled motion faces and writes src/shared/maps/metrics.ts:
 * each face's advance widths at 100 px, per weight, so map labels are placed
 * from fixed numbers. Placing them from what a canvas measures would let the
 * editor's Chromium and the export's Skia, which round glyphs differently,
 * put a label on different sides of a pin. Also prints each face's cap
 * height, ascent and descent, for MOTION_FONTS.
 *
 * Usage: node scripts/make-font-metrics.mjs
 */
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FACES = [
  { family: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', weights: [400] },
  { family: 'Anton', file: 'Anton-Regular.ttf', weights: [400] },
  { family: 'Sora', file: 'Sora.ttf', weights: [400, 500, 600, 700, 800] },
  { family: 'IM Fell English', file: 'IMFellEnglish-Regular.ttf', weights: [400] }
]

// Printable ASCII, then the accented letters place names use.
const CHARS = [
  ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
  ...'ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ',
  ...'ĀāĂăĄąĆćČčĎďĐđĒēĖėĘęĚěĞğĢģĪīĮįİıĶķĹĺĻļĽľŁłŃńŅņŇňŌōŐőŒœŔŕŘřŚśŞşŠšŢţŤťŪūŮůŰűŲųŸŹźŻżŽžȘșȚț',
  ...'’‘“”–—·•²³°′″'
]

const canvas = createCanvas(64, 64)
const ctx = canvas.getContext('2d')
const out = {}
for (const face of FACES) {
  GlobalFonts.registerFromPath(join(ROOT, 'resources/fonts', face.file), face.family)
  for (const w of face.weights) {
    ctx.font = `${w} 100px "${face.family}"`
    const widths = CHARS.map((c) => Math.round(ctx.measureText(c).width * 10) / 10)
    out[`${face.family}|${w}`] = widths
    const H = ctx.measureText('H')
    const box = ctx.measureText('Hxgjpqy')
    console.log(
      `${face.family} ${w}: cap ${(H.actualBoundingBoxAscent / 100).toFixed(2)}, ascent ${(box.fontBoundingBoxAscent / 100).toFixed(2)}, descent ${(box.fontBoundingBoxDescent / 100).toFixed(2)}`
    )
  }
}

const body = Object.entries(out)
  .map(([k, v]) => `  ${JSON.stringify(k)}: [${v.join(', ')}]`)
  .join(',\n')
const ts = `/**
 * Advance widths of the bundled motion faces at 100 px, written by
 * scripts/make-font-metrics.mjs from the font files: never by hand. Map labels
 * are placed from these, not from a canvas's own measuring, so the editor and
 * the export place every label the same way.
 */

/** The characters measured, in the order of each row. */
export const METRIC_CHARS = ${JSON.stringify(CHARS.join(''))}

/** "Family|weight" to advance widths at 100 px, one per character of METRIC_CHARS. */
export const ADVANCES: Record<string, number[]> = {
${body}
}
`
writeFileSync(join(ROOT, 'src/shared/maps/metrics.ts'), ts)
console.log(`wrote metrics for ${Object.keys(out).length} faces and weights, ${CHARS.length} characters each`)
