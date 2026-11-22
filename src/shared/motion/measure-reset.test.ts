import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../edit'
import { buildScene, DEFAULT_THEME, designSize, forgetMeasures, MOTION_FONTS, renderFrame, type MotionScene } from '.'

/**
 * The editor draws before its faces have loaded, so the first frame measures the fallback face. Those widths must
 * not outlive the load: once forgotten, the hook is laid out in the face it is drawn in, as a fresh canvas lays it
 * out, and its words no longer run into each other (the sermon hook "I'mNotJusta Conqueror").
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

function hookScene(): MotionScene {
  let t = 0.5
  const words = 'I am not just a conqueror, I am more than a conqueror through him.'.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += 0.4
    return w
  })
  const source = { id: 's1', path: '/sermon.mp4', durationSec: t + 1, width: 1920, height: 1080, fps: 30 }
  const doc = createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') })
  const r = commit(
    doc,
    [
      { op: 'aspect', aspect: 'vertical' },
      {
        op: 'motion-add',
        kind: 'banner',
        from: 'start',
        to: '4s',
        text: ['I’m Not Just a Conqueror, I’m More'],
        style: 'title',
        place: 'top'
      }
    ],
    'x'
  )
  expect(r.rejected).toEqual([])
  const cut = currentCut(r.doc)
  return buildScene({
    cut,
    resolved: resolveCut(cut, r.doc.words, r.doc.sources),
    words: r.doc.words,
    size: designSize(cut.aspect, r.doc.sources[0]),
    theme: DEFAULT_THEME
  })
}

/** A canvas whose measuring can be made to answer as a narrower fallback face would, while its faces load. */
function canvasLoading(width: number, height: number): { ctx: CanvasRenderingContext2D; loaded: () => void } {
  const real = createCanvas(width, height).getContext('2d')
  let loading = true
  const ctx = new Proxy(real, {
    get(target, prop) {
      if (prop === 'measureText')
        return (text: string) => {
          const m = target.measureText(text)
          return loading ? { ...m, width: m.width * 0.62 } : m
        }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target)
    }
  }) as unknown as CanvasRenderingContext2D
  return { ctx, loaded: () => (loading = false) }
}

function draw(ctx: CanvasRenderingContext2D, scene: MotionScene, t: number): Uint8ClampedArray {
  const { width, height } = scene.size
  ctx.clearRect(0, 0, width, height)
  renderFrame(ctx, t, scene.layers, scene.size, scene.size, {
    createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement
  })
  return ctx.getImageData(0, 0, width, height).data
}

const differing = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
  let n = 0
  for (let i = 3; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 64) n++
  return n
}

describe('measures taken before the faces loaded', () => {
  it('are forgotten, so the hook is laid out in the face it is drawn in', () => {
    const scene = hookScene()
    const { width, height } = scene.size
    const fresh = draw(createCanvas(width, height).getContext('2d') as unknown as CanvasRenderingContext2D, scene, 1.5)

    const { ctx, loaded } = canvasLoading(width, height)
    draw(ctx, scene, 1.5)
    loaded()
    // Kept, the narrow widths crowd the words together: the frame is not the fresh one.
    expect(differing(draw(ctx, scene, 1.5), fresh)).toBeGreaterThan(500)
    forgetMeasures()
    expect(differing(draw(ctx, scene, 1.5), fresh)).toBe(0)
  })
})
