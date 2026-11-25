import { createCanvas, GlobalFonts, type Canvas } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  countText,
  drawFrame,
  ease,
  flatten,
  keys,
  layoutText,
  measurer,
  MOTION_FONTS,
  morphPoints,
  num,
  parsePath,
  polylineLength,
  renderFrame,
  shapeCmds,
  spring,
  subpathLengths,
  tail,
  textUnits,
  type IconNode,
  type Layer,
  type TextLayer
} from '.'

/**
 * The drawing code, checked on real pixels: frames are drawn with Skia
 * through @napi-rs/canvas, the canvas the export uses, and read back.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
const ICONS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../node_modules/lucide-static/icon-nodes.json', import.meta.url)), 'utf8')
) as Record<string, IconNode[]>

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

type C2D = CanvasRenderingContext2D

function frame(width: number, height: number): { canvas: Canvas; ctx: C2D } {
  const canvas = createCanvas(width, height)
  return { canvas, ctx: canvas.getContext('2d') as unknown as C2D }
}

function px(ctx: C2D, x: number, y: number): number[] {
  return Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data)
}

const resources = { icons: (name: string) => ICONS[name] }

const rect = (over: Partial<Extract<Layer, { kind: 'shape' }>> = {}): Layer => ({
  kind: 'shape',
  start: 0,
  end: 10,
  shape: { type: 'rect', w: 100, h: 100 },
  fill: '#ff0000',
  transform: { x: 200, y: 200 },
  ...over
})

describe('motion blur', () => {
  const scratch = {
    createCanvas: (w: number, h: number) => createCanvas(w, h) as unknown as HTMLCanvasElement
  }
  // A white square crossing the frame at 1000 design pixels a second, centre at 600 at 0.5 s.
  const moving = (blur?: Layer['motionBlur']): Layer =>
    rect({ fill: '#ffffff', transform: { x: keys([0, 100], [1, 1100]), y: 500 }, motionBlur: blur })

  it('streaks a fast move along its path', () => {
    const sharp = frame(1200, 1000)
    drawFrame(sharp.ctx, 0.5, [moving()], { width: 1200, height: 1000 }, scratch)
    const smeared = frame(1200, 1000)
    drawFrame(smeared.ctx, 0.5, [moving({ shutter: 0.05, samples: 12 })], { width: 1200, height: 1000 }, scratch)
    // The square runs from 550 to 650 now; across a 1/20 s shutter it spans 525 to 675.
    expect(px(sharp.ctx, 600, 500)[3]).toBe(255)
    expect(px(smeared.ctx, 600, 500)[3]).toBeGreaterThan(250)
    for (const x of [535, 665]) {
      expect(px(sharp.ctx, x, 500)[3], `sharp ${x}`).toBe(0)
      const a = px(smeared.ctx, x, 500)[3]
      expect(a, `smeared ${x}`).toBeGreaterThan(30)
      expect(a, `smeared ${x}`).toBeLessThan(120)
    }
    expect(px(smeared.ctx, 690, 500)[3]).toBe(0)
    // Up and down it is as sharp as ever.
    expect(px(smeared.ctx, 600, 445)[3]).toBe(0)
  })

  it('leaves a still layer exactly as it was, and draws sharp without a scratch canvas', () => {
    const still = rect({ fill: '#ffffff', motionBlur: { shutter: 0.05 } })
    const a = frame(400, 400)
    drawFrame(a.ctx, 1, [still], { width: 400, height: 400 }, scratch)
    const b = frame(400, 400)
    drawFrame(b.ctx, 1, [rect({ fill: '#ffffff' })], { width: 400, height: 400 })
    expect(
      Buffer.from(a.ctx.getImageData(0, 0, 400, 400).data).equals(Buffer.from(b.ctx.getImageData(0, 0, 400, 400).data))
    ).toBe(true)
    const c = frame(1200, 1000)
    drawFrame(c.ctx, 0.5, [moving({ shutter: 0.05 })], { width: 1200, height: 1000 })
    expect(px(c.ctx, 665, 500)[3]).toBe(0)
  })

  it('blurs a fast move at the frame’s shutter, as the export draws it, and leaves slower moves and stills sharp', () => {
    // The export's shutter at 30 fps: half a frame. A square whipping across at 7200 px a second, 240 px a
    // frame, a fifth of the frame's width: across 1/60 s it spans 490 to 710.
    const withShutter = { ...scratch, shutter: 0.5 / 30 }
    const whip = rect({ fill: '#ffffff', transform: { x: keys([0, -3000], [1, 4200]), y: 500 } })
    const blurred = frame(1200, 1000)
    drawFrame(blurred.ctx, 0.5, [whip], { width: 1200, height: 1000 }, withShutter)
    // It moves further than it is wide while the shutter is open, so even its middle is part see-through.
    expect(px(blurred.ctx, 600, 500)[3]).toBeGreaterThan(180)
    expect(px(blurred.ctx, 600, 500)[3]).toBeLessThan(245)
    for (const x of [500, 700]) {
      const a = px(blurred.ctx, x, 500)[3]
      expect(a, `blurred ${x}`).toBeGreaterThan(20)
      expect(a, `blurred ${x}`).toBeLessThan(160)
    }
    expect(px(blurred.ctx, 716, 500)[3]).toBe(0)
    // 33 px a frame, slower than a creator's sliding card: crisp, as theirs are.
    const slow = frame(1200, 1000)
    drawFrame(slow.ctx, 0.5, [moving()], { width: 1200, height: 1000 }, withShutter)
    expect(px(slow.ctx, 546, 500)[3]).toBe(0)
    expect(px(slow.ctx, 554, 500)[3]).toBe(255)
    // A layer that names a shutter keeps its own.
    const own = frame(1200, 1000)
    drawFrame(own.ctx, 0.5, [moving({ shutter: 0.05, samples: 12 })], { width: 1200, height: 1000 }, withShutter)
    expect(px(own.ctx, 665, 500)[3]).toBeGreaterThan(30)
    // Still: the same pixels as with no shutter at all.
    const a = frame(400, 400)
    drawFrame(a.ctx, 1, [rect({ fill: '#ffffff' })], { width: 400, height: 400 }, withShutter)
    const b = frame(400, 400)
    drawFrame(b.ctx, 1, [rect({ fill: '#ffffff' })], { width: 400, height: 400 })
    expect(
      Buffer.from(a.ctx.getImageData(0, 0, 400, 400).data).equals(Buffer.from(b.ctx.getImageData(0, 0, 400, 400).data))
    ).toBe(true)
  })

  it('streaks words as they rise in, and a card as it grows, by how far they go', () => {
    const withShutter = { ...scratch, shutter: 0.5 / 30 }
    // A word rising 480 px in a quarter second on an expo ease-out: fast at the start.
    const word: TextLayer = {
      kind: 'text',
      start: 0,
      end: 3,
      text: 'RISE',
      font: { family: 'Inter ExtraBold', size: 120 },
      fill: '#ffffff',
      align: 'center',
      valign: 'middle',
      transform: { x: 600, y: 500 },
      animators: [{ by: 'word', duration: 0.25, ease: 'snap', from: { y: 480 } }]
    }
    const rows = (ctx: C2D): number => {
      // How many rows across the word's middle column are part lit: a streak has many, a sharp word few.
      let n = 0
      for (let y = 300; y < 900; y++) {
        const a = px(ctx, 600, y)[3]
        if (a > 10 && a < 245) n++
      }
      return n
    }
    // Its first frame, 132 px across the shutter: fast enough to blur.
    const sharp = frame(1200, 1000)
    drawFrame(sharp.ctx, 0.02, [word], { width: 1200, height: 1000 }, scratch)
    const streaked = frame(1200, 1000)
    drawFrame(streaked.ctx, 0.02, [word], { width: 1200, height: 1000 }, withShutter)
    expect(rows(streaked.ctx)).toBeGreaterThan(rows(sharp.ctx) + 20)
    // A big card bursting up from a tenth of its size streaks outward at its edges.
    const card = rect({ fill: '#ffffff', shape: { type: 'rect', w: 800, h: 800 }, transform: { x: 600, y: 500, scale: keys([0, 0.1, 'snap'], [0.25, 1]) } })
    const grown = frame(1200, 1000)
    drawFrame(grown.ctx, 0.02, [card], { width: 1200, height: 1000 }, withShutter)
    const plain = frame(1200, 1000)
    drawFrame(plain.ctx, 0.02, [card], { width: 1200, height: 1000 }, scratch)
    const soft = (ctx: C2D): number => {
      let n = 0
      for (let x = 600; x < 1200; x++) {
        const a = px(ctx, x, 500)[3]
        if (a > 10 && a < 245) n++
      }
      return n
    }
    expect(soft(grown.ctx)).toBeGreaterThan(soft(plain.ctx) + 10)
  })

  it('keeps a moving layer’s own parts over each other: dark lines on white paper stay dark', () => {
    // A white page with a dark rule across it, sliding slowly up: each moment is drawn whole before they are
    // averaged. Drawn straight into the average, the rule was added onto the paper and washed out to white.
    const page: Layer = {
      kind: 'group',
      start: 0,
      end: 3,
      transform: { x: 600, y: keys([0, 520], [1, 480]) },
      children: [
        { kind: 'shape', start: 0, end: 3, shape: { type: 'rect', w: 400, h: 300 }, fill: '#ffffff' },
        { kind: 'shape', start: 0, end: 3, shape: { type: 'rect', w: 300, h: 40 }, fill: '#202020' }
      ]
    }
    const f = frame(1200, 1000)
    drawFrame(f.ctx, 0.5, [page], { width: 1200, height: 1000 }, { ...scratch, shutter: 0.05 })
    const [r, g, b, a] = px(f.ctx, 600, 500)
    expect(a).toBeGreaterThan(250)
    expect(Math.max(r, g, b)).toBeLessThan(60)
    // And the paper round it is still white.
    expect(px(f.ctx, 600, 440)[0]).toBeGreaterThan(245)
  })
})

describe('easing', () => {
  it('matches After Effects and CSS curves at their ends and middles', () => {
    expect(ease('linear', 0.3)).toBeCloseTo(0.3)
    expect(ease('easy-ease', 0.5)).toBeCloseTo(0.5, 3)
    expect(ease('easy-ease', 0.1)).toBeLessThan(0.05)
    expect(ease('ease-in', 0.25)).toBeLessThan(0.25)
    expect(ease('ease-out', 0.25)).toBeGreaterThan(0.25)
    expect(ease({ bezier: [0, 0, 1, 1] }, 0.42)).toBeCloseTo(0.42, 4)
    expect(ease('hold', 0.99)).toBe(0)
    expect(ease('hold', 1)).toBe(1)
    for (const curve of ['snap', 'smooth', 'overshoot', 'bounce', 'spring', 'elastic'] as const) {
      expect(ease(curve, 0)).toBeCloseTo(0, 5)
      expect(ease(curve, 1)).toBeCloseTo(1, 5)
    }
  })

  it('springs overshoot and settle inside their segment', () => {
    const samples = Array.from({ length: 101 }, (_, i) => spring(i / 100, 0.4))
    expect(Math.max(...samples)).toBeGreaterThan(1.03)
    expect(Math.abs(spring(0.97, 0.4) - 1)).toBeLessThan(0.01)
    const backOut = Array.from({ length: 101 }, (_, i) => ease('overshoot', i / 100))
    expect(Math.max(...backOut)).toBeGreaterThan(1.05)
    // No bounce is critically damped: it never passes 1.
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => spring(i / 100, 0)))).toBeLessThanOrEqual(1)
  })
})

describe('keyframes', () => {
  it('interpolates through each segment’s ease, counting from the start or the end', () => {
    expect(num(keys([0, 0], [1, 10]), 0.5, 3)).toBeCloseTo(5)
    expect(num(keys([0, 0, 'hold'], [1, 10]), 0.9, 3)).toBe(0)
    expect(num(keys([0, 0], [1, 10]), 2, 3)).toBe(10)
    // 0.5 s before the end of a 2 s layer is local 1.5.
    const exit = { keys: [{ t: 0, v: 0 }, ...tail([0.5, 1])] }
    expect(num(exit, 1.5, 2)).toBeCloseTo(1)
    expect(num(exit, 0.75, 2)).toBeCloseTo(0.5)
  })
})

describe('geometry', () => {
  it('reads SVG path data, arcs and relative commands included', () => {
    // A circle of radius 10 drawn as two arcs.
    const circle = parsePath('M0 10A10 10 0 1 1 20 10A10 10 0 1 1 0 10Z')
    expect(polylineLength(flatten(circle, 0.1)[0])).toBeCloseTo(2 * Math.PI * 10, 0)
    // Flags written together, as minified SVG does.
    const arc = parsePath('M0 0a5 5 0 015 5')
    expect(arc[arc.length - 1].slice(-2)).toEqual([5, 5])
    const rel = parsePath('m10 10h20v20h-20z')
    expect(subpathLengths(rel)[0]).toBeCloseTo(80)
  })

  it('measures shapes, so strokes can draw on by length', () => {
    expect(subpathLengths(shapeCmds({ type: 'rect', w: 100, h: 50 }))[0]).toBeCloseTo(300)
    const ring = subpathLengths(shapeCmds({ type: 'ellipse', w: 200, h: 200 }))[0]
    expect(ring).toBeGreaterThan(626)
    expect(ring).toBeLessThan(630)
    expect(
      subpathLengths(
        shapeCmds({
          type: 'arrow',
          points: [
            [0, 0],
            [100, 0]
          ],
          head: 20
        })
      )
    ).toHaveLength(2)
  })

  it('morphs between shapes point for point', () => {
    const a = { type: 'rect' as const, w: 100, h: 100 }
    const b = { type: 'ellipse' as const, w: 100, h: 100 }
    const half = morphPoints(a, b, 0.5)
    expect(half).toHaveLength(96)
    // The corner of the square comes halfway to the circle.
    const far = Math.max(...half.map(([x, y]) => Math.hypot(x, y)))
    expect(far).toBeLessThan(Math.hypot(50, 50))
    expect(far).toBeGreaterThan(50)
  })
})

describe('drawing frames', () => {
  it('fills a shape where it should be, only while it is on', () => {
    const { ctx } = frame(400, 400)
    drawFrame(ctx, 0.5, [rect({ start: 1, end: 2 })], { width: 400, height: 400 })
    expect(px(ctx, 200, 200)[3]).toBe(0)
    drawFrame(ctx, 1.5, [rect({ start: 1, end: 2 })], { width: 400, height: 400 })
    expect(px(ctx, 200, 200)).toEqual([255, 0, 0, 255])
    expect(px(ctx, 270, 200)[3]).toBe(0)
  })

  it('fades through an eased keyframe', () => {
    const layer = rect({ transform: { x: 200, y: 200, opacity: keys([0, 0, 'easy-ease'], [1, 1]) } })
    const { ctx } = frame(400, 400)
    renderFrame(ctx, 0.5, [layer], { width: 400, height: 400 }, { width: 400, height: 400 })
    expect(Math.abs(px(ctx, 200, 200)[3] - 128)).toBeLessThanOrEqual(2)
    renderFrame(ctx, 0.2, [layer], { width: 400, height: 400 }, { width: 400, height: 400 })
    expect(Math.abs(px(ctx, 200, 200)[3] - Math.round(ease('easy-ease', 0.2) * 255))).toBeLessThanOrEqual(2)
  })

  it('scales and turns around the anchor point', () => {
    const { ctx } = frame(400, 400)
    // Scaled 2x about its own centre, the square reaches 100 px either side.
    drawFrame(ctx, 0, [rect({ transform: { x: 200, y: 200, scale: 2 } })], { width: 400, height: 400 })
    expect(px(ctx, 290, 200)[3]).toBe(255)
    // Anchored at its left edge, it grows rightwards only.
    const { ctx: c2 } = frame(400, 400)
    drawFrame(c2, 0, [rect({ transform: { x: 150, y: 200, anchorX: -50, scaleX: 2 } })], { width: 400, height: 400 })
    expect(px(c2, 340, 200)[3]).toBe(255)
    expect(px(c2, 140, 200)[3]).toBe(0)
  })

  it('draws a stroke on along its length', () => {
    const line: Layer = {
      kind: 'shape',
      start: 0,
      end: 2,
      shape: {
        type: 'line',
        points: [
          [100, 200],
          [500, 200]
        ]
      },
      stroke: { color: '#ffffff', width: 10, cap: 'butt' },
      trim: { end: keys([0, 0], [1, 1]) }
    }
    const { ctx } = frame(600, 400)
    drawFrame(ctx, 0.5, [line], { width: 600, height: 400 })
    expect(px(ctx, 200, 200)[3]).toBe(255)
    expect(px(ctx, 280, 200)[3]).toBe(255)
    expect(px(ctx, 320, 200)[3]).toBe(0)
    expect(px(ctx, 450, 200)[3]).toBe(0)
  })

  it('draws Lucide icons as strokes in a colour', () => {
    const icon: Layer = {
      kind: 'image',
      start: 0,
      end: 1,
      icon: 'square',
      w: 240,
      h: 240,
      color: '#00ff00',
      transform: { x: 200, y: 200 }
    }
    const { ctx } = frame(400, 400)
    drawFrame(ctx, 0, [icon], { width: 400, height: 400 }, resources)
    // Lucide's square is a 18-unit rect at (3, 3) with rounded corners: its left edge is at x = 80 + 30.
    expect(px(ctx, 110, 200)[1]).toBeGreaterThan(200)
    expect(px(ctx, 200, 200)[3]).toBe(0)
    // An icon that does not exist draws nothing and throws nothing.
    expect(() =>
      drawFrame(ctx, 0, [{ ...icon, icon: 'no-such-icon' }], { width: 400, height: 400 }, resources)
    ).not.toThrow()
  })

  it('clips to a mask and paints gradients across a shape', () => {
    const { ctx } = frame(400, 400)
    drawFrame(
      ctx,
      0,
      [rect({ shape: { type: 'rect', w: 300, h: 300 }, mask: { shape: { type: 'rect', w: 100, h: 100 } } })],
      {
        width: 400,
        height: 400
      }
    )
    expect(px(ctx, 200, 200)[3]).toBe(255)
    expect(px(ctx, 300, 200)[3]).toBe(0)
    const { ctx: g } = frame(400, 400)
    drawFrame(
      g,
      0,
      [
        rect({
          shape: { type: 'rect', w: 300, h: 100 },
          fill: {
            gradient: 'linear',
            angle: 0,
            stops: [
              [0, '#ff0000'],
              [1, '#0000ff']
            ]
          }
        })
      ],
      { width: 400, height: 400 }
    )
    const left = px(g, 60, 200)
    const right = px(g, 340, 200)
    expect(left[0]).toBeGreaterThan(200)
    expect(right[2]).toBeGreaterThan(200)
  })

  it('multiplies opacity through groups', () => {
    const { ctx } = frame(400, 400)
    const group: Layer = {
      kind: 'group',
      start: 0,
      end: 1,
      transform: { opacity: 0.5 },
      children: [rect({ transform: { x: 200, y: 200, opacity: 0.5 } })]
    }
    drawFrame(ctx, 0, [group], { width: 400, height: 400 })
    expect(Math.abs(px(ctx, 200, 200)[3] - 64)).toBeLessThanOrEqual(2)
  })

  it('scales shadows and blurs with the canvas, so a small preview matches the export', () => {
    const scene: Layer[] = [
      rect({
        shape: { type: 'rect', w: 400, h: 200, radius: 40 },
        transform: { x: 540, y: 600 },
        fill: '#ffffff',
        effects: { shadow: { color: 'rgba(0,0,0,0.9)', blur: 30, y: 40 } }
      }),
      rect({
        shape: { type: 'ellipse', w: 300, h: 300 },
        transform: { x: 540, y: 1200 },
        fill: '#ff00ff',
        effects: { blur: 24 }
      })
    ]
    const design = { width: 1080, height: 1920 }
    const big = frame(1080, 1920)
    renderFrame(big.ctx, 0, scene, design, design)
    const small = frame(270, 480)
    renderFrame(small.ctx, 0, scene, design, { width: 270, height: 480 })
    // The big frame shrunk to the small one, then compared alpha by alpha.
    const shrunk = frame(270, 480)
    ;(shrunk.ctx as unknown as { imageSmoothingQuality: string }).imageSmoothingQuality = 'high'
    shrunk.ctx.drawImage(big.canvas as unknown as CanvasImageSource, 0, 0, 270, 480)
    const a = small.ctx.getImageData(0, 0, 270, 480).data
    const b = shrunk.ctx.getImageData(0, 0, 270, 480).data
    let diff = 0
    for (let i = 3; i < a.length; i += 4) diff += Math.abs(a[i] - b[i])
    expect(diff / (a.length / 4)).toBeLessThan(2)
    // The shadow falls 40 design pixels down, 10 at quarter size.
    expect(px(small.ctx, 135, 150 + 25 + 8)[3]).toBeGreaterThan(60)
  })

  it('blurs a picture or a shape on a canvas its own size, as a filter on the frame would', () => {
    const size = { width: 900, height: 600 }
    let made = 0
    const scratch = {
      ...resources,
      createCanvas: (w: number, h: number) => {
        made++
        return createCanvas(w, h) as unknown as HTMLCanvasElement
      }
    }
    /** Mean difference per channel between the two ways of blurring one layer, and the result. */
    const compare = (layer: Layer): { mean: number; fast: C2D } => {
      const fast = frame(900, 600)
      renderFrame(fast.ctx, 1, [layer], size, size, scratch)
      const plain = frame(900, 600)
      renderFrame(plain.ctx, 1, [layer], size, size, resources)
      const a = fast.ctx.getImageData(0, 0, 900, 600).data
      const b = plain.ctx.getImageData(0, 0, 900, 600).data
      let diff = 0
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
      return { mean: diff / a.length, fast: fast.ctx }
    }
    // A turned tile, a ring, and a square half off the frame, whose blur still reaches the frame's edge.
    const tile = compare(
      rect({
        shape: { type: 'rect', w: 180, h: 120, radius: 24 },
        transform: { x: 300, y: 260, rotation: 20 },
        fill: '#2E7DFF',
        effects: { blur: 9 }
      })
    )
    expect(made).toBeGreaterThan(0)
    expect(tile.mean).toBeLessThan(0.05)
    expect(px(tile.fast, 300, 260)[3]).toBe(255)
    const ring = compare(
      rect({
        shape: { type: 'ellipse', w: 160, h: 160 },
        transform: { x: 700, y: 300 },
        fill: undefined,
        stroke: { color: '#FFD84D', width: 14 },
        effects: { blur: 5 }
      })
    )
    expect(ring.mean).toBeLessThan(0.05)
    const edge = px(ring.fast, 700 + 80, 300)[3]
    expect(edge).toBeGreaterThan(40)
    expect(edge).toBeLessThan(250)
    const half = compare(
      rect({
        shape: { type: 'rect', w: 200, h: 200 },
        transform: { x: 20, y: 300 },
        fill: '#FF4D4D',
        effects: { blur: 6 }
      })
    )
    expect(half.mean).toBeLessThan(0.05)
    expect(px(half.fast, 0, 300)[3]).toBeGreaterThan(250)
    // With a glow the two order the glow's blur and the layer's differently; the halo differs a little.
    const glowing = compare(
      rect({
        shape: { type: 'rect', w: 180, h: 120, radius: 24 },
        transform: { x: 300, y: 260 },
        fill: '#2E7DFF',
        effects: { blur: 9, glow: { color: 'rgba(255,255,255,0.5)', blur: 12 } }
      })
    )
    expect(glowing.mean).toBeLessThan(2)
  })

  it('blurs words, and a group of them on a pill, on canvases their own size too, as a filter on the frame would', () => {
    const size = { width: 900, height: 600 }
    const sizes: number[] = []
    const scratch = {
      ...resources,
      createCanvas: (w: number, h: number) => {
        sizes.push(w * h)
        return createCanvas(w, h) as unknown as HTMLCanvasElement
      }
    }
    const compare = (layer: Layer): number => {
      const fast = frame(900, 600)
      renderFrame(fast.ctx, 1, [layer], size, size, scratch)
      const plain = frame(900, 600)
      renderFrame(plain.ctx, 1, [layer], size, size, resources)
      const a = fast.ctx.getImageData(0, 0, 900, 600).data
      const b = plain.ctx.getImageData(0, 0, 900, 600).data
      let diff = 0
      for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
      return diff / a.length
    }
    const words: TextLayer = {
      kind: 'text',
      start: 0,
      end: 3,
      text: 'Deep work',
      font: { family: 'Sora', size: 48 },
      fill: '#18160F',
      align: 'center',
      valign: 'middle',
      effects: { blur: 4 },
      transform: { x: 450, y: 200 },
      animators: [{ by: 'word', duration: 0.4, from: { opacity: 0, x: 40 } }]
    }
    expect(compare(words)).toBeLessThan(0.1)
    // A far word in a cloud: a pill with a shadow and its word, the group turned a little and blurred.
    const pill: Layer = {
      kind: 'group',
      start: 0,
      end: 3,
      effects: { blur: 5 },
      transform: { x: 450, y: 400, rotation: -6, scale: 0.9 },
      children: [
        {
          kind: 'shape',
          start: 0,
          end: 3,
          shape: { type: 'rect', w: 300, h: 80, radius: 40 },
          fill: '#FFFFFF',
          effects: { shadow: { color: 'rgba(0, 0, 0, 0.3)', blur: 20, y: 8 } }
        },
        { ...words, effects: undefined, transform: { x: 0, y: 0 }, animators: undefined }
      ]
    }
    // Its shadow is blurred in a different order the two ways, so the soft edge differs by a fraction of a level.
    expect(compare(pill)).toBeLessThan(0.5)
    // Never a canvas as big as the frame: each a fraction of it.
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.max(...sizes)).toBeLessThan(900 * 600 * 0.5)
  })
})

describe('text', () => {
  const sora = (over: Partial<TextLayer> = {}): TextLayer => ({
    kind: 'text',
    start: 0,
    end: 4,
    text: 'Most people never open the settings',
    font: { family: 'Sora', size: 80, weight: 700 },
    align: 'center',
    valign: 'middle',
    maxWidth: 600,
    transform: { x: 540, y: 960 },
    ...over
  })

  it('measures with measureText, wraps to the width and centres each line', () => {
    const { ctx } = frame(1080, 1920)
    const block = layoutText(measurer(ctx), sora())
    expect(block.words.map((w) => w.text)).toEqual(['Most', 'people', 'never', 'open', 'the', 'settings'])
    expect(block.lines.length).toBeGreaterThanOrEqual(2)
    for (const line of block.lines) {
      expect(line.w).toBeLessThanOrEqual(600)
      expect(line.x + line.w / 2).toBeCloseTo(0, 5)
    }
    expect(block.top + block.h / 2).toBeCloseTo(0, 5)
    // Upper case and tracking change the measure, not the words.
    const wide = layoutText(
      measurer(ctx),
      sora({ font: { family: 'Sora', size: 80, tracking: 20, uppercase: true }, maxWidth: undefined })
    )
    expect(wide.words[0].text).toBe('MOST')
    expect(wide.lines).toHaveLength(1)
  })

  it('balances lines when asked, so no word is left alone', () => {
    const { ctx } = frame(1080, 1920)
    const layer = sora({ text: 'Subscribe for part two', font: { family: 'Archivo Black', size: 70 }, maxWidth: 733 })
    const greedy = layoutText(measurer(ctx), layer)
    const even = layoutText(measurer(ctx), { ...layer, balance: true })
    expect(greedy.lines.map((l) => l.words.length)).toEqual([3, 1])
    expect(even.lines).toHaveLength(2)
    expect(even.lines[1].words.length).toBeGreaterThan(1)
    expect(even.w).toBeLessThan(greedy.w)
    // One line stays one line.
    expect(layoutText(measurer(ctx), { ...layer, text: 'Subscribe', balance: true }).lines).toHaveLength(1)
  })

  it('spaces letters by the font’s tracking, where the layout measured them', () => {
    const layer = sora({
      text: 'HI HI',
      align: 'left',
      valign: 'baseline',
      maxWidth: undefined,
      transform: { x: 100, y: 400 },
      font: { family: 'Sora', size: 100, weight: 700, tracking: 60 },
      fill: '#ffffff'
    })
    const { ctx } = frame(1080, 1920)
    drawFrame(ctx, 1, [layer], { width: 1080, height: 1920 })
    const { block } = textUnits(ctx, layer, 1)
    const [first, last] = block.words
    const i = last.chars[1]
    expect(px(ctx, 100 + last.x + i.x + i.w / 2, 400 - 30)[3]).toBeGreaterThan(200)
    // Between the words, nothing.
    expect(px(ctx, 100 + (first.x + first.w + last.x) / 2, 400 - 30)[3]).toBe(0)
  })

  it('draws text where the layout puts it', () => {
    const { ctx } = frame(1080, 1920)
    drawFrame(ctx, 1, [sora({ text: 'HELLO', fill: '#ffffff', font: { family: 'Anton', size: 200 } })], {
      width: 1080,
      height: 1920
    })
    const data = ctx.getImageData(340, 860, 400, 200).data
    let lit = 0
    for (let i = 3; i < data.length; i += 4) if (data[i] > 200) lit++
    expect(lit).toBeGreaterThan(8000)
    expect(px(ctx, 100, 100)[3]).toBe(0)
  })

  it('pops each word when it is said', () => {
    const layer = sora({
      text: '',
      spans: [
        { text: 'Lock', t: 0, end: 0.4 },
        { text: 'it', t: 1, end: 1.3 }
      ],
      animators: [{ by: 'word', timing: 'spoken', duration: 0.2, ease: 'overshoot', from: { scale: 0.2, opacity: 0 } }]
    })
    const { ctx } = frame(1080, 1920)
    const before = textUnits(ctx, layer, 0.5)
    expect(before.words[0].opacity).toBe(1)
    expect(before.words[1].opacity).toBe(0)
    const popping = textUnits(ctx, layer, 1.1)
    expect(popping.words[1].scale).toBeGreaterThan(0.2)
    expect(popping.words[1].scale).toBeLessThan(1.2)
    // The second word's pixels appear only once it is said.
    const box = before.block.words[1]
    const at = (t: number): number => {
      const f = frame(1080, 1920)
      drawFrame(f.ctx, t, [layer], { width: 1080, height: 1920 })
      const d = f.ctx.getImageData(
        Math.round(540 + box.x),
        Math.round(960 + box.baseline - box.cap),
        Math.round(box.w),
        Math.round(box.cap)
      ).data
      let lit = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) lit++
      return lit
    }
    expect(at(0.5)).toBe(0)
    expect(at(1.5)).toBeGreaterThan(200)
  })

  it('puts a plate behind the block and a box behind the word being said', () => {
    const layer = sora({
      text: '',
      maxWidth: undefined,
      spans: [
        { text: 'Turn', t: 0 },
        { text: 'it', t: 1 },
        { text: 'off', t: 2 }
      ],
      plate: { color: '#0000ff', radius: 20, padX: 40, padY: 30 },
      active: { color: '#15161a', box: { color: '#ffd84d', move: 0 } }
    })
    const { ctx } = frame(1080, 1920)
    drawFrame(ctx, 2.5, [layer], { width: 1080, height: 1920 })
    const { block } = textUnits(ctx, layer, 2.5)
    // Plate padding, left of the first word.
    expect(px(ctx, 540 + block.left - 20, 960)).toEqual([0, 0, 255, 255])
    // The box sits behind "off", the word being said.
    const off = block.words[2]
    const boxLeft = px(ctx, 540 + off.x - 4, 960 + off.baseline - off.cap / 2)
    expect(boxLeft[0]).toBeGreaterThan(240)
    expect(boxLeft[2]).toBeLessThan(120)
  })

  it('gives each line its own plate: hugging the capitals, coloured by span, one after another', () => {
    const layer = sora({
      text: '',
      align: 'left',
      valign: 'top',
      maxWidth: undefined,
      transform: { x: 100, y: 400 },
      font: { family: 'Sora', size: 80, weight: 700, lineHeight: 1.7 },
      spans: [{ text: 'Sam Lee' }, { text: '\nFounder', scale: 0.6 }],
      plate: {
        color: '#0000ff',
        spanColors: ['#0000ff', '#ff0000'],
        perLine: true,
        hug: true,
        stagger: 0.5,
        padX: 20,
        padY: 20,
        scaleX: {
          keys: [
            { t: 0, v: 0 },
            { t: 0.2, v: 1 }
          ]
        },
        edge: { color: '#00ff00', width: 10 }
      }
    })
    const { ctx } = frame(1080, 1920)
    const { block } = textUnits(ctx, layer, 0.3)
    const [name, role] = block.lines
    // The plates run on their own time: at 0.3 s the first is in, the second not yet begun.
    drawFrame(ctx, 0.3, [layer], { width: 1080, height: 1920 })
    const nameMid = 400 + name.baseline - name.cap / 2
    const roleMid = 400 + role.baseline - role.cap / 2
    expect(px(ctx, 100 - 5, nameMid)).toEqual([0, 0, 255, 255])
    expect(px(ctx, 100 - 15, nameMid)).toEqual([0, 255, 0, 255])
    expect(px(ctx, 100 - 5, roleMid)[3]).toBe(0)
    // Later the second line has its own plate in the second span's colour.
    const later = frame(1080, 1920)
    drawFrame(later.ctx, 1, [layer], { width: 1080, height: 1920 })
    expect(px(later.ctx, 100 - 5, roleMid)).toEqual([255, 0, 0, 255])
    // Hugging: between the two lines' plates the picture shows through.
    const nameBottom = 400 + name.baseline + 20
    const roleTop = 400 + role.baseline - role.cap - 20 * 0.6
    expect(roleTop - nameBottom).toBeGreaterThan(10)
    expect(px(later.ctx, 100 - 5, (nameBottom + roleTop) / 2)[3]).toBe(0)
  })

  it('counts numbers in fixed-width digits', () => {
    const count = { from: 0, to: 47, decimals: 0, suffix: '%', progress: keys([0, 0], [1, 1]) }
    expect(countText(count, 0.5, 2)).toBe('24%')
    expect(countText(count, 2, 2)).toBe('47%')
    expect(countText({ from: 0, to: 3200, decimals: 0, prefix: '$', group: true, progress: 1 }, 0, 1)).toBe('$3,200')
    const { ctx } = frame(400, 400)
    const m = measurer(ctx)
    const w = (text: string): number =>
      layoutText(m, sora({ text, font: { family: 'Sora', size: 80, tabular: true } })).w
    expect(w('11')).toBeCloseTo(w('88'), 5)
  })

  it('draws text behind the person where a matte says they are', () => {
    const matte = frame(400, 400)
    matte.ctx.fillStyle = '#ffffff'
    matte.ctx.fillRect(0, 0, 200, 400)
    const layer: Layer = rect({ shape: { type: 'rect', w: 300, h: 100 }, behind: true })
    const { ctx } = frame(400, 400)
    drawFrame(
      ctx,
      0,
      [layer],
      { width: 400, height: 400 },
      {
        matte: matte.canvas as unknown as CanvasImageSource,
        createCanvas: (w, h) => createCanvas(w, h) as unknown as { getContext(kind: '2d'): C2D | null }
      }
    )
    // Hidden on the person's side, drawn on the other.
    expect(px(ctx, 150, 200)[3]).toBe(0)
    expect(px(ctx, 300, 200)[3]).toBe(255)
  })
})

describe('dashes and mosaics', () => {
  const scratch = { createCanvas: (w: number, h: number) => createCanvas(w, h) as unknown as HTMLCanvasElement }

  it('dashes a stroke: lit dashes with gaps between, along the whole edge', () => {
    const f = frame(400, 200)
    drawFrame(
      f.ctx,
      0,
      [rect({ fill: undefined, shape: { type: 'rect', w: 300, h: 100 }, stroke: { color: '#ffffff', width: 4, cap: 'butt', dash: [10, 10] }, transform: { x: 200, y: 100 } })],
      { width: 400, height: 200 }
    )
    // Along the top edge, at y = 50: on for ten pixels, off for ten.
    let on = 0
    let off = 0
    for (let x = 60; x < 340; x++) (px(f.ctx, x, 50)[3] > 128 ? on++ : off++)
    expect(on).toBeGreaterThan(100)
    expect(off).toBeGreaterThan(100)
  })

  it('draws a picture as a mosaic of square blocks', () => {
    // A white circle as a mosaic of 20 px blocks: every block is one flat colour.
    const scratchCanvas = createCanvas(40, 40)
    const sc = scratchCanvas.getContext('2d')
    sc.fillStyle = '#ffffff'
    sc.beginPath()
    sc.arc(20, 20, 18, 0, Math.PI * 2)
    sc.fill()
    const images = new Map([['a1', scratchCanvas as unknown as CanvasImageSource]])
    const f = frame(200, 200)
    drawFrame(f.ctx, 0, [{ kind: 'image', start: 0, end: 1, asset: 'a1', w: 160, h: 160, pixelate: 20, transform: { x: 100, y: 100 } }], { width: 200, height: 200 }, { ...scratch, images })
    for (const [bx, by] of [
      [20, 20],
      [80, 80],
      [100, 40]
    ]) {
      const first = px(f.ctx, bx + 3, by + 3)
      for (const [dx, dy] of [
        [16, 3],
        [3, 16],
        [16, 16]
      ])
        expect(px(f.ctx, bx + dx, by + dy), `block at ${bx},${by}`).toEqual(first)
    }
    // Lit in the middle, clear at the corners.
    expect(px(f.ctx, 100, 100)[3]).toBe(255)
    expect(px(f.ctx, 25, 25)[3]).toBeLessThan(200)
  })
})

describe('blurring what moves inside a still group', () => {
  it('keeps a board’s still paper exactly its colour while a card slides fast across it', () => {
    const scratch = { createCanvas: (w: number, h: number) => createCanvas(w, h) as unknown as HTMLCanvasElement, shutter: 0.5 / 30 }
    const board: Layer = {
      kind: 'group',
      start: 0,
      end: 2,
      children: [
        { kind: 'shape', start: 0, end: 2, shape: { type: 'rect', w: 1200, h: 1000 }, fill: '#FAF5F2', transform: { x: 600, y: 500 } },
        // A card whipping across at 240 px a frame.
        { kind: 'shape', start: 0, end: 2, shape: { type: 'rect', w: 200, h: 120 }, fill: '#FFFFFF', transform: { x: keys([0, -3000], [1, 4200]), y: 300 } }
      ]
    }
    const f = frame(1200, 1000)
    drawFrame(f.ctx, 0.5, [board], { width: 1200, height: 1000 }, scratch)
    // Far from the card, the paper is the paper.
    expect(px(f.ctx, 300, 800)).toEqual([250, 245, 242, 255])
    // The card streaks: part-covered along its path.
    expect(px(f.ctx, 700, 300)[0]).toBeGreaterThanOrEqual(250)
  })
})

describe('animating on twos', () => {
  it('holds each pose for two frames at 24 fps when a layer steps at 12', () => {
    const slide = (fps?: number): Layer => rect({ fill: '#ffffff', fps, transform: { x: keys([0, 100], [1, 1100]), y: 500 } })
    const leftEdge = (l: Layer, t: number): number => {
      const f = frame(1200, 1000)
      drawFrame(f.ctx, t, [l], { width: 1200, height: 1000 })
      for (let x = 0; x < 1200; x++) if (px(f.ctx, x, 500)[3] > 128) return x
      return -1
    }
    // Smooth: every frame moves. On twos: frames 3 and 4 of a 24 fps second show the same pose.
    expect(leftEdge(slide(), 3 / 24)).not.toBe(leftEdge(slide(), 4 / 24))
    expect(leftEdge(slide(12), 2 / 24 + 0.001)).toBe(leftEdge(slide(12), 3 / 24 + 0.001))
    expect(leftEdge(slide(12), 3 / 24 + 0.001)).not.toBe(leftEdge(slide(12), 4 / 24 + 0.001))
  })
})
