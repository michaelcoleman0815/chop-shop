import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { addAsset, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import { buildScene, DEFAULT_THEME, designSize, layerTravel, MOTION_FONTS, templates } from '.'

/**
 * Every graphic glides rather than jumps: stepped frame by frame through its life at 30 fps, no part of it moves
 * further in one frame than the creators' own graphics do. Measured on their videos (Nov 2026): Jordan Welch's
 * fastest moves, a dial whipping round and a phone gliding in, cover about 4% of the frame's width a frame; Ali
 * Abdaal's cards sliding in from off the frame on a long quint ease cover 10 to 13% in their first frame, and his
 * icons pop from 80% of their size. Ours had slid in at 29% and grown from nothing at 11%. A stop-motion collage
 * (Deep End with Lecrae's title card) jumps on purpose, a guest rising more than half the way in one pose.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const SCRIPT =
  'Most people never open the settings. The main camera is 48 megapixels and it costs $999 with a 120 Hz screen. ' +
  'Bitcoin then Ethereum and Solana. First lock the exposure, second set the white balance, third turn off ' +
  'stabilisation. That is all, so subscribe.'

function docFor(aspect: 'vertical' | 'wide'): EditDoc {
  let t = 0.5
  const words = SCRIPT.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += 0.4
    return w
  })
  const vertical = aspect === 'vertical'
  const source = { id: 's1', path: '/take.mov', durationSec: t + 1, width: vertical ? 1080 : 1920, height: vertical ? 1920 : 1080, fps: 30 }
  let doc = createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') })
  // Pictures for the graphics that show one: a phone screenshot, a wide page, a thumbnail.
  for (const [path, width, height] of [
    ['/p1.png', 1290, 2796],
    ['/p2.png', 1920, 1080],
    ['/p3.png', 1280, 720]
  ] as const)
    doc = addAsset(doc, {
      kind: 'image',
      path,
      title: path,
      durationSec: null,
      width,
      height,
      origin: { type: 'file', url: null, author: null, license: null, range: null }
    }).doc
  return doc
}

/** The furthest any part of a graphic moves in one frame, as a share of the frame's width. */
function worstFrame(doc: EditDoc, call: Record<string, unknown>): number | null {
  const made = commit(doc, [{ op: 'motion-add', ...call }] as never, 'x')
  if (made.rejected.length) return null
  const cut = currentCut(made.doc)
  const scene = buildScene({
    cut,
    resolved: resolveCut(cut, made.doc.words, made.doc.sources),
    words: made.doc.words,
    size: designSize(cut.aspect, made.doc.sources[0]),
    theme: DEFAULT_THEME,
    assets: made.doc.assets
  })
  const ctx = createCanvas(scene.size.width, scene.size.height).getContext('2d') as unknown as CanvasRenderingContext2D
  let worst = 0
  for (const layer of scene.layers)
    for (let t = layer.start; t < layer.end; t += 1 / 30) worst = Math.max(worst, layerTravel(ctx, layer, t, 1 / 30, scene.size))
  return worst / scene.size.width
}

describe('graphics glide', () => {
  for (const aspect of ['vertical', 'wide'] as const)
    it(`moves no graphic further in a frame than the creators do, in a ${aspect} frame`, () => {
      const doc = commit(docFor(aspect), [{ op: 'aspect', aspect }], 'x').doc
      const over: string[] = []
      let checked = 0
      for (const tpl of templates()) {
        const styles = tpl.styles?.length ? tpl.styles : ['']
        for (const style of styles) {
          const share = worstFrame(doc, { kind: tpl.kind, ...tpl.example.call, ...(style ? { style } : {}) })
          if (share === null) continue
          checked++
          // A card sliding in from off the frame may cover what Ali Abdaal's do; everything else stays near Jordan Welch's.
          const offFrame = (tpl.kind === 'screenshot' && style === 'slide') || (tpl.kind === 'video-cards' && style === 'list')
          // Stop-motion collage moves in big poses on purpose: Deep End's guest rises 55% of the way in one pose.
          const stopMotion = tpl.kind === 'end-card' && style === 'collage'
          const most = stopMotion ? 0.3 : offFrame ? 0.15 : 0.09
          if (share > most) over.push(`${tpl.kind}${style ? `:${style}` : ''} ${(share * 100).toFixed(1)}%`)
        }
      }
      expect(checked).toBeGreaterThan(40)
      expect(over).toEqual([])
    }, 120_000)
})
