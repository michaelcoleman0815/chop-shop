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
