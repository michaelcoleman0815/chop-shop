import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CAPTIONS, type CaptionSpec } from '../shared/edit'
import { MOTION_FONTS } from '../shared/motion'
import { captionStyleFor, drawSubtitle, layoutSubtitle, styleCues, type TextMeasurer } from '../shared/subtitles'
import { buildAss } from './captions'
import { filterArg, findFfmpeg } from './test-media'

/**
 * The editor's preview draws captions with shared/subtitles; the export has
 * libass burn them from buildAss's file. Here both draw the same cue on the
 * same plain frame, libass through ffmpeg and the shared drawing on Skia, and
 * whatever each drew (text, outline, box and shadow) must cover the same
 * pixels: the same box within a pixel or two, and nearly every pixel shared.
 */

const FFMPEG = findFfmpeg()
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))
const GROUND = [0x3a, 0x6e, 0xa5]

/** Which pixels differ from the plain ground. */
function drawn(data: Uint8Array | Uint8ClampedArray, w: number, h: number, stride: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const d =
      Math.abs(data[i * stride] - GROUND[0]) +
      Math.abs(data[i * stride + 1] - GROUND[1]) +
      Math.abs(data[i * stride + 2] - GROUND[2])
    m[i] = d > 30 ? 1 : 0
  }
  return m
}

function boxOf(m: Uint8Array, w: number, h: number): [number, number, number, number] {
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x]) {
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x + 1)
        y1 = Math.max(y1, y + 1)
      }
  return [x0, y0, x1, y1]
}

/** Pixels both drew, over pixels either drew. */
function shared(a: Uint8Array, b: Uint8Array): number {
  let both = 0
  let either = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++
    if (a[i] || b[i]) either++
  }
  return either ? both / either : 1
}

describe.skipIf(!FFMPEG)('captions in the preview, against libass in the export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-subtitles-'))
    for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const WIDE: [number, number] = [1920, 1080]
  const TALL: [number, number] = [1080, 1920]
  const THREE = ['Bright', 'colours', 'everywhere.']
  const FIVE = ['Bright', 'colours', 'all', 'over', 'everywhere.']
  type Case = {
    name: string
    spec: Partial<CaptionSpec>
    size: [number, number]
    words: string[]
    active: number
    keys?: number[]
    /**
     * Pixels both must share. Small text (under about 60 px) is mostly the soft edge of its letters, where
     * libass and Skia antialias a little differently, so it shares fewer while sitting in the same place.
     */
    shared?: number
  }
  const cases: Case[] = [
    { name: 'clean, wide', spec: { preset: 'clean', position: 'chest' }, size: WIDE, words: THREE, active: 2 },
    { name: 'clean, vertical', spec: { preset: 'clean', position: 'chest' }, size: TALL, words: THREE, active: 1 },
    // The word being said scaled up, and a group too wide for one line.
    { name: 'punch, wide', spec: { preset: 'punch', position: 'chest' }, size: WIDE, words: THREE, active: 1 },
    {
      name: 'stack, vertical',
      spec: { preset: 'stack', position: 'middle', wordsPerScreen: 5 },
      size: TALL,
      words: FIVE,
      active: 1
    },
    // A plate behind three words, spaces and all.
    {
      name: 'marker, wide',
      spec: { preset: 'marker', position: 'top' },
      size: WIDE,
      words: ['Bright', 'and', 'bold'],
      active: 1
    },
    // Bold on a face of one weight, with a shadow.
    {
      name: 'sentence, wide',
      spec: { preset: 'sentence', position: 'bottom', wordsPerScreen: 4 },
      size: WIDE,
      words: FIVE.slice(0, 4),
      active: 0
    },
    // One word big, the rest of its group small under it.
    {
      name: 'feature, vertical',
      spec: { preset: 'feature', position: 'middle', wordsPerScreen: 5 },
      size: TALL,
      words: FIVE,
      active: 1
    },
    // The sentence building over two lines, the words not said yet holding their places, two in the accent.
    // The words landed on in yellow, in the look's own face and size.
    {
      name: 'sermon key words, vertical',
      spec: { preset: 'sermon', position: 'middle', wordsPerScreen: 3 },
      size: TALL,
      words: ['still', 'sits', 'down.'],
      active: 2,
      keys: [1, 2],
      shared: 0.92
    },
    {
      name: 'sermon, vertical',
      spec: { preset: 'sermon', position: 'middle', wordsPerScreen: 3 },
      size: TALL,
      words: ['to', 'the', 'flag.'],
      active: 1,
      // Small, thin and with no outline, the strokes are mostly antialiased edge, where libass and Skia shade
      // differently; where they sit is held by the box check above, to 2 px.
      shared: 0.9
    },
    {
      name: 'sermon one word tall, vertical',
      spec: { preset: 'sermon-word-tall', position: 'middle', wordsPerScreen: 1, uppercase: true },
      size: TALL,
      words: ['Believer.'],
      active: 0
    },
    {
      name: 'sermon one word, vertical',
      spec: { preset: 'sermon-word', position: 'middle', wordsPerScreen: 1, uppercase: true },
      size: TALL,
      words: ['Believer.'],
      active: 0
    },
    {
      name: 'sermon red key word, vertical',
      spec: { preset: 'sermon-red', position: 'middle', wordsPerScreen: 3 },
      size: TALL,
      words: ["That", "ain't", 'biblical.'],
      active: 2,
      keys: [2],
      shared: 0.92
    },
    {
      name: 'sermon quiet, vertical',
      spec: { preset: 'sermon-quiet', position: 'middle', wordsPerScreen: 3 },
      size: TALL,
      words: ['She', 'was', 'healed.'],
      active: 1,
      shared: 0.87
    },
    {
      name: 'sermon build, vertical',
      spec: { preset: 'sermon-build', position: 'chest', wordsPerScreen: 8, uppercase: true },
      size: TALL,
      words: ['Even', 'if', 'you', 'were', 'the', 'one', 'who', 'let', 'go.'],
      active: 5,
      keys: [0, 1]
    },
    // The owner's six reference reels: each face as libass finds it by name, the italic and the bold by the
    // full names their files give them.
    {
      name: 'film one word, vertical',
      spec: { preset: 'film-word', position: 'chest', wordsPerScreen: 1, uppercase: true },
      size: TALL,
      words: ['Assumptions.'],
      active: 0
    },
    {
      name: 'whisper, vertical',
      spec: { preset: 'whisper', position: 'middle', wordsPerScreen: 1 },
      size: TALL,
      words: ['hungry'],
      active: 0,
      shared: 0.92
    },
    {
      name: 'stage capitals, vertical',
      spec: { preset: 'stage-caps', position: 'middle', wordsPerScreen: 2, uppercase: true },
      size: TALL,
      words: ['Sorry,', 'you'],
      active: 1,
      shared: 0.92
    },
    {
      name: 'wide capitals, vertical',
      spec: { preset: 'wide-caps', position: 'middle', wordsPerScreen: 2, uppercase: true },
      size: TALL,
      words: ['Encourage', 'a'],
      active: 0
    },
    {
      name: 'serif capitals, vertical',
      spec: { preset: 'serif-caps', position: 'middle', wordsPerScreen: 2, uppercase: true },
      size: TALL,
      words: ['Relationships', 'in'],
      active: 1,
      shared: 0.9
    },
    // A line filling in place in a narrow column, its key word in the italic serif at one and a half times.
    {
      name: 'editorial, vertical',
      spec: { preset: 'editorial', position: 'chest', wordsPerScreen: 6 },
      size: TALL,
      words: ['it', 'took', '13', 'years', 'for', 'Joseph'],
      active: 3,
      keys: [2, 5],
      shared: 0.92
    }
  ]

  for (const c of cases) {
    it(`draws ${c.name} where libass burns it`, () => {
      const [w, h] = c.size
      const style = captionStyleFor({ ...DEFAULT_CAPTIONS, ...c.spec }, w)
      const words = c.words.map((text, i) => ({
        text,
        startSec: 0.5 + i * 0.6,
        endSec: 1 + i * 0.6,
        ...(c.keys?.includes(i) ? { key: true } : {})
      }))
      const cue = styleCues(words, style).find((q) => q.active === c.active)
      if (!cue) throw new Error('no cue')
      // libass, through the export's own subtitle file.
      const ass = join(dir, 'captions.ass')
      writeFileSync(ass, buildAss(words, w, h, style))
      const burned = execFileSync(
        ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=0x3a6ea5:s=${w}x${h}:d=4:r=10,format=rgb24`,
          '-vf',
          `subtitles=${filterArg(ass)}:fontsdir=${filterArg(FONTS)}`,
          '-ss',
          (cue.start + 0.2).toFixed(2),
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-'
        ],
        { maxBuffer: w * h * 4 }
      )
      // The preview's drawing, on Skia at the same size.
      const canvas = createCanvas(w, h)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#3a6ea5'
      ctx.fillRect(0, 0, w, h)
      const layout = layoutSubtitle(cue, style, { width: w, height: h }, ctx as unknown as TextMeasurer)
      drawSubtitle(
        ctx as unknown as CanvasRenderingContext2D,
        layout,
        1,
        (cw, ch) => createCanvas(cw, ch) as unknown as HTMLCanvasElement
      )
      const a = drawn(burned, w, h, 3)
      const b = drawn(ctx.getImageData(0, 0, w, h).data, w, h, 4)
      const boxA = boxOf(a, w, h)
      const boxB = boxOf(b, w, h)
      expect(boxA[2], 'libass drew something').toBeGreaterThan(0)
      const worst = Math.max(...boxA.map((v, i) => Math.abs(v - boxB[i])))
      expect(worst, `libass ${boxA}, preview ${boxB}`).toBeLessThanOrEqual(2)
      expect(shared(a, b)).toBeGreaterThan(c.shared ?? 0.95)
    })
  }
})
