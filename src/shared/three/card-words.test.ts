import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MOTION_FONTS } from '../motion'
import { wordsPicture } from './browser'
import { Object3DSchema } from './spec'

/** A card's words drawn as the 3D page draws them, on the export's canvas: a size, a colour and a weight asked for. */
const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
const before = (globalThis as { document?: unknown }).document

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
  // The page's document, as far as the card's words need one: a canvas to draw on.
  ;(globalThis as { document?: unknown }).document = { createElement: () => createCanvas(1, 1) }
})

afterAll(() => {
  ;(globalThis as { document?: unknown }).document = before
})

function red(o: Parameters<typeof wordsPicture>[0]): number {
  const pic = wordsPicture(o, 400, 300)!
  const canvas = pic.image as unknown as ReturnType<typeof createCanvas>
  const data = canvas.getContext('2d').getImageData(0, 0, 400, 300).data
  let n = 0
  for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60) n++
  return n
}

describe('a 3D card’s words', () => {
  it('takes a size, a colour and a weight, and keeps a fifth of the card’s height when asked none', () => {
    const card = { id: 'o1', type: 'card' as const, title: '3', w: 400, h: 300, color: '#202020' }
    expect(Object3DSchema.safeParse({ ...card, titleSize: 180, titleColor: '#FF0000', titleWeight: 800 }).success).toBe(true)
    // Asked in red, the number is red; at 180 px it is far bigger than at the default of 60.
    const big = red({ ...card, titleSize: 180, titleColor: '#FF0000' })
    const plain = red({ ...card, titleColor: '#FF0000' })
    expect(plain).toBeGreaterThan(50)
    expect(big).toBeGreaterThan(plain * 5)
    // Left as it was, the words are in the ink that reads on the card: no red.
    expect(red(card)).toBe(0)
  })
})
