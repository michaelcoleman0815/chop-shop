import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { addAsset, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import { creditsText } from '../assets'
import { CAPTION_STYLE_PRESETS } from '../presets'
import {
  buildScene,
  chipKeepOut,
  chipList,
  chipPlaces,
  chipWidth,
  countText,
  DEFAULT_THEME,
  designSize,
  frameFor,
  graphicsGuide,
  layoutText,
  listsSaid,
  measurer,
  MOTION_FONTS,
  motionCommandEntries,
  planMotionCommand,
  renderFrame,
  speakerFace,
  template,
  textUnits,
  twoLines,
  typedFigures,
  usualFace,
  type FaceBox,
  type FaceSample,
  type IconNode,
  type Layer,
  type MotionScene,
  type TextLayer
} from '.'

/**
 * The graphics of a talking-head edit: a cloud of chips around the speaker,
 * a counter that rolls up to the figure said and a calendar that flips day by
 * day, a row of video cards, a page that slides in with a ring on one part,
 * and captions with the spoken word in a box. Drawn on the export's canvas
 * and checked on pixels where it matters: chips never on the face, a pill
 * that never changes size as it counts.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
const ICONS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../node_modules/lucide-static/icon-nodes.json', import.meta.url)), 'utf8')
) as Record<string, IconNode[]>

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const SCRIPT =
  'Here is my whole stack. I use Notion, Figma, Linear, Slack, Cursor, ChatGPT, Canva, Zapier, Raycast, Obsidian, Arc and Framer every day. ' +
  'This video got 683,594 views and then it hit a million views. Day one, day two, day three. That is it.'

function docWith(aspect: 'vertical' | 'wide', ops: (doc: EditDoc) => unknown[], script = SCRIPT): EditDoc {
  let t = 0.4
  const words = script.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.28 }
    t += 0.36
    return w
  })
  const vertical = aspect === 'vertical'
  const source = {
    id: 's1',
    path: '/take.mov',
    durationSec: t + 1,
    width: vertical ? 1080 : 1920,
    height: vertical ? 1920 : 1080,
    fps: 30
  }
  const doc = commit(
    createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') }),
    [{ op: 'aspect', aspect }],
    'x'
  ).doc
  const r = commit(doc, ops(doc), 'y')
  expect(r.rejected).toEqual([])
  return r.doc
}

/** The id of the nth word that is `text`, its punctuation aside, as a test names a moment. */
function idOf(doc: EditDoc, text: string, nth = 0): string {
  const hits = doc.words.filter((w) => w.text.toLowerCase().replace(/[^\w,]|,$/g, '') === text.toLowerCase())
  if (!hits[nth]) throw new Error(`no word ${text}`)
  return hits[nth].id
}

/** Faces through the whole cut, a sample a second, as face tracking gives them. */
const everySecond = (face: FaceBox): FaceSample[] => Array.from({ length: 40 }, (_, t) => ({ t, faces: [face] }))

function sceneOf(doc: EditDoc, faces?: FaceSample[]): MotionScene {
  const cut = currentCut(doc)
  return buildScene({
    cut,
    resolved: resolveCut(cut, doc.words, doc.sources),
    words: doc.words,
    size: designSize(cut.aspect, doc.sources[0]),
    theme: DEFAULT_THEME,
    faces,
    assets: doc.assets
  })
}

/** When a word is said on the output clock. */
function saidAt(doc: EditDoc, id: string): number {
  const cut = currentCut(doc)
  const w = resolveCut(cut, doc.words, doc.sources).words.find((x) => x.id === id)
  if (!w) throw new Error(`${id} is not in the cut`)
  return w.outStart
}

/** The scene drawn at t, full size, read back as RGBA. */
function draw(scene: MotionScene, t: number, images?: Map<string, unknown>) {
  const { width, height } = scene.size
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, scene.layers, scene.size, scene.size, {
    icons: (n) => ICONS[n],
    images: images as Map<string, CanvasImageSource> | undefined,
    createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement
  })
  const data = ctx.getImageData(0, 0, width, height).data
  const at = (x: number, y: number): number[] => {
    const i = (Math.round(y) * width + Math.round(x)) * 4
    return [data[i], data[i + 1], data[i + 2], data[i + 3]]
  }
  /** Pixels in a box that are drawn on (alpha over 128). */
  const lit = (x0: number, y0: number, w: number, h: number): number => {
    let n = 0
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, y0 + h); y++)
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, x0 + w); x++)
        if (data[(y * width + x) * 4 + 3] > 128) n++
    return n
  }
  /** The box around every pixel of a colour, or null when there is none. */
  const boxOf = (rgb: [number, number, number], tolerance = 24, alpha = 250) => {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        if (data[i + 3] < alpha) continue
        if (Math.abs(data[i] - rgb[0]) + Math.abs(data[i + 1] - rgb[1]) + Math.abs(data[i + 2] - rgb[2]) > tolerance)
          continue
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
    return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null
  }
  return { at, lit, boxOf, ctx }
}

/** Every layer, groups opened, with the group's own life as its children's limit. */
function flat(layers: Layer[]): Layer[] {
  return layers.flatMap((l) => (l.kind === 'group' ? [l, ...flat(l.children)] : [l]))
}

const ACCENT: [number, number, number] = [0xff, 0xd8, 0x4d]

describe('a counter', () => {
  const counted = (aspect: 'vertical' | 'wide') =>
    docWith(aspect, (d) => [
      {
        op: 'motion-add',
        kind: 'counter',
        from: idOf(d, '683,594'),
        to: `${idOf(d, 'million')}.end+1.2`,
        text: ['views'],
        items: [
          { label: '683,594', at: idOf(d, '683,594') },
          { label: '1,000,000', at: idOf(d, 'million') }
        ]
      }
    ])

  it('rolls up from the first figure to the second, landing as the second is said, and never goes back', () => {
    const doc = counted('wide')
    const scene = sceneOf(doc)
    const count = flat(scene.layers).find((l): l is TextLayer => l.kind === 'text' && !!l.count)!
    const show = (t: number): string => countText(count.count!, t - count.start, count.end - count.start)
    const first = saidAt(doc, idOf(doc, '683,594'))
    const land = saidAt(doc, idOf(doc, 'million'))
    expect(show(first)).toBe('683,594 views')
    expect(show(land)).toBe('1,000,000 views')
    expect(show(land + 0.5)).toBe('1,000,000 views')
    // Never more than 1.6 s rolling, and each frame on from the one before.
    let last = 683594
    let moving = 0
    for (let t = first; t <= land + 0.01; t += 1 / 30) {
      const v = Number(show(t).replace(/\D/g, ''))
      expect(v).toBeGreaterThanOrEqual(last)
      if (v > last) moving++
      last = v
    }
    expect(moving / 30).toBeLessThanOrEqual(1.65)
    expect(moving).toBeGreaterThan(10)
  })

  it('keeps the pill the same size while the figure grows a digit', () => {
    const doc = counted('wide')
    const scene = sceneOf(doc)
    const land = saidAt(doc, idOf(doc, 'million'))
    const rolling = draw(scene, land - 0.7).boxOf(ACCENT)
    const landed = draw(scene, land + 0.6).boxOf(ACCENT)
    expect(rolling).not.toBeNull()
    // Settled after its small push on landing: the same pill to the pixel.
    expect(landed).toEqual(rolling)
  })

  it('stays off the speaker’s face', () => {
    for (const aspect of ['vertical', 'wide'] as const) {
      const doc = counted(aspect)
      // A face high in the frame, leaving no room above it.
      const face: FaceBox = aspect === 'vertical' ? { x: 0.3, y: 0.12, w: 0.4, h: 0.2 } : { x: 0.4, y: 0.1, w: 0.2, h: 0.36 }
      const scene = sceneOf(doc, everySecond(face))
      const { width: W, height: H } = scene.size
      const d = draw(scene, saidAt(doc, idOf(doc, 'million')) + 0.6)
      expect(d.lit(face.x * W, face.y * H, face.w * W, face.h * H)).toBe(0)
      expect(d.boxOf(ACCENT)).not.toBeNull()
    }
  })

  it('stands beside the face at eye level in a wide frame, clear of captions on the chest', () => {
    const doc = counted('wide')
    const scene = sceneOf(doc)
    const pill = draw(scene, saidAt(doc, idOf(doc, 'million')) + 0.6).boxOf(ACCENT)
    expect(pill).not.toBeNull()
    // Drawn captions rest at 0.62 of the frame's height on the chest; the pill ends well above.
    expect(pill!.y1).toBeLessThan(1080 * 0.55)
    const face = usualFace('wide')
    expect(pill!.x1 < face.x * 1920 || pill!.x0 > (face.x + face.w) * 1920).toBe(true)
  })

  it('counts up from nothing to one figure, landing on its word', () => {
    const doc = docWith('vertical', (d) => [
      planOp(d, 'count', 'a million views', null)
    ])
    const item = currentCut(doc).motion[0]
    expect(item.from).toBe(`${idOf(doc, 'a')}-1.2`)
    const scene = sceneOf(doc)
    const count = flat(scene.layers).find((l): l is TextLayer => l.kind === 'text' && !!l.count)!
    const show = (t: number): string => countText(count.count!, t - count.start, count.end - count.start)
    const land = saidAt(doc, idOf(doc, 'a'))
    expect(show(count.start)).toBe('0 views')
    expect(show(land)).toBe('1,000,000 views')
  })

  it('flips a calendar to each day as it is said, the top half falling and the bottom landing', () => {
    const doc = docWith('wide', (d) => [planOp(d, 'flip', 'day 1 to 3', saidAt(d, idOf(d, 'one')))])
    const item = currentCut(doc).motion[0]
    expect(item.style).toBe('flip')
    expect(item.text).toEqual(['day'])
    expect(item.items.map((r) => r.label)).toEqual(['1', '2', '3'])
    const scene = sceneOf(doc)
    const numbers = (t: number): string[] =>
      flat(scene.layers)
        .filter((l): l is TextLayer => l.kind === 'text' && /^\d+$/.test(l.text) && t >= l.start && t < l.end)
        .map((l) => l.text)
    const two = saidAt(doc, idOf(doc, 'two'))
    // Before the turn: both halves show 1. During it: the new top behind the falling flap of the old.
    expect(numbers(two - 0.1).sort()).toEqual(['1', '1'])
    expect(numbers(two + 0.05).sort()).toEqual(['1', '1', '2'])
    expect(numbers(two + 0.25).sort()).toEqual(['1', '2', '2'])
    expect(numbers(two + 0.5).sort()).toEqual(['2', '2'])
    // It stands in the left of a wide frame, leaving the rest for a page moved over beside it.
    const d = draw(scene, two + 0.6)
    const { width: W, height: H } = scene.size
    expect(d.lit(0, 0, W * 0.36, H)).toBeGreaterThan(5000)
    expect(d.lit(W * 0.37, 0, W * 0.63, H)).toBe(0)
  })
})

/** The op a slash command makes, as the app would add it. */
function planOp(doc: EditDoc, command: string, rest: string, time: number | null): Record<string, unknown> {
  const cut = currentCut(doc)
  const plan = planMotionCommand(command, rest, {
    doc,
    resolved: resolveCut(cut, doc.words, doc.sources),
    time,
    brandName: ''
  })
  if ('problem' in plan) throw new Error(plan.problem)
  return plan.op
}

describe('chips', () => {
  const NAMES = ['Notion', 'Figma', 'Linear', 'Slack', 'Cursor', 'ChatGPT', 'Canva', 'Zapier', 'Raycast', 'Obsidian', 'Arc', 'Framer']
  const FACES: Record<string, FaceBox[]> = {
    centred: [{ x: 0.35, y: 0.15, w: 0.3, h: 0.22 }],
    left: [{ x: 0.12, y: 0.2, w: 0.28, h: 0.2 }],
    right: [{ x: 0.55, y: 0.12, w: 0.3, h: 0.24 }],
    small: [{ x: 0.45, y: 0.3, w: 0.1, h: 0.1 }]
  }

  it('places a dozen clear of the face, inside the frame and clear of each other, wherever the face is', () => {
    for (const shape of [
      { width: 1080, height: 1920 },
      { width: 1920, height: 1080 },
      { width: 1080, height: 1080 }
    ]) {
      const frame = frameFor(shape)
      const sizes = NAMES.map((n) => ({ w: chipWidth(n, DEFAULT_THEME, frame), h: 69 * frame.u }))
      for (const [where, faces] of Object.entries(FACES)) {
        const { spots, scale } = chipPlaces(frame, faces, sizes)
        const placed = spots.filter((s): s is { x: number; y: number } => s !== null)
        expect(placed.length, `${where} in ${shape.width}x${shape.height}`).toBe(NAMES.length)
        const face = chipKeepOut(frame, speakerFace(frame, faces)).face
        const rects = placed.map((s, i) => ({
          x: s.x - (sizes[i].w * scale) / 2,
          y: s.y - (sizes[i].h * scale) / 2,
          w: sizes[i].w * scale,
          h: sizes[i].h * scale
        }))
        const meets = (a: (typeof rects)[number], b: (typeof rects)[number]): boolean =>
          a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        for (const [i, r] of rects.entries()) {
          expect(meets(r, face), `${NAMES[i]} on the face (${where})`).toBe(false)
          expect(r.x).toBeGreaterThanOrEqual(frame.safe.left - 0.5)
          expect(r.y).toBeGreaterThanOrEqual(frame.safe.top - 0.5)
          expect(r.x + r.w).toBeLessThanOrEqual(shape.width - Math.min(frame.safe.right, shape.width * 0.045) + 0.5)
          expect(r.y + r.h).toBeLessThanOrEqual(shape.height - frame.safe.bottom + 0.5)
          for (const other of rects.slice(i + 1)) expect(meets(r, other)).toBe(false)
        }
      }
    }
  })

  it('keeps every drawn pixel off the face, with faces from tracking or without', () => {
    for (const aspect of ['vertical', 'wide'] as const) {
      const doc = docWith(aspect, (d) => [planOp(d, 'chips', NAMES.join(', '), null)])
      const item = currentCut(doc).motion[0]
      expect(item.items.map((r) => r.label)).toEqual(NAMES)
      for (const faces of [FACES.centred, FACES.right, []]) {
        const samples: FaceSample[] | undefined = faces.length ? everySecond(faces[0]) : undefined
        const scene = sceneOf(doc, samples)
        const { width: W, height: H } = scene.size
        // Every chip in: just after the last is named.
        const d = draw(scene, saidAt(doc, idOf(doc, 'Framer')) + 0.6)
        const face = faces[0] ?? usualFace(aspect)
        expect(d.lit(face.x * W, face.y * H, face.w * W, face.h * H)).toBe(0)
        expect(d.lit(0, 0, W, H)).toBeGreaterThan(NAMES.length * 2000)
      }
    }
  })

  it('pops each in on its word, in the order they are named, and takes them out together', () => {
    const doc = docWith('vertical', (d) => [planOp(d, 'chips', 'Notion, Figma, Linear', null)])
    const item = currentCut(doc).motion[0]
    expect(item.items.map((r) => r.at)).toEqual([idOf(doc, 'Notion'), idOf(doc, 'Figma'), idOf(doc, 'Linear')])
    expect(item.from).toBe(idOf(doc, 'Notion'))
    expect(item.to).toBe(`${idOf(doc, 'Linear')}.end+1.5`)
    const scene = sceneOf(doc)
    const chips = scene.layers.filter((l) => l.kind === 'group')
    expect(chips).toHaveLength(3)
    const shown = (t: number): number =>
      chips.filter((g) => {
        const sx = g.transform?.scale as { keys: { t: number }[] }
        return t - g.start >= sx.keys[0].t + 0.05 && t < g.end
      }).length
    const figma = saidAt(doc, idOf(doc, 'Figma'))
    expect(shown(figma - 0.15)).toBe(1)
    expect(shown(figma + 0.1)).toBe(2)
    expect(shown(saidAt(doc, idOf(doc, 'Linear')) + 0.1)).toBe(3)
    // All three leave at the same moment.
    expect(new Set(chips.map((g) => g.end)).size).toBe(1)
  })

  it('finds the list in the speech when no names are given', () => {
    const doc = docWith('wide', (d) => [planOp(d, 'chips', '', saidAt(d, idOf(d, 'Slack')))])
    expect(chipList(currentCut(doc).motion[0]).map((c) => c.label)).toEqual(NAMES)
  })
})

describe('video cards', () => {
  it('shows each video’s thumbnail, title and views pill, in a row, and credits the thumbnails', () => {
    let doc = docWith('wide', () => [])
    const thumb = addAsset(doc, {
      kind: 'image',
      path: '/thumb.jpg',
      title: 'I tried every AI editor',
      durationSec: null,
      width: 1280,
      height: 720,
      origin: { type: 'link', url: 'https://www.youtube.com/watch?v=abc', author: '@someone', license: null, range: null }
    })
    doc = thumb.doc
    doc = commit(
      doc,
      [
        planOp(
          doc,
          'videos',
          `${thumb.asset.id} | I tried every AI video editor so you do not have to | 492K views · 1 mo ago\nMy desk setup for 2026 | 1.2M views · 3 mo ago`,
          saidAt(doc, idOf(doc, 'This'))
        )
      ],
      'cards'
    ).doc
    const item = currentCut(doc).motion[0]
    expect(item.kind).toBe('video-cards')
    expect(item.items.map((r) => [r.value, r.note])).toEqual([
      [thumb.asset.id, '492K views · 1 mo ago'],
      ['', '1.2M views · 3 mo ago']
    ])
    expect(template('video-cards')!.pictures!(item)).toEqual([thumb.asset.id])
    expect(creditsText(doc)).toContain('https://www.youtube.com/watch?v=abc')
    // Drawn: a red thumbnail where the first card's picture goes, the accent pill under each.
    const scene = sceneOf(doc)
    const red = createCanvas(64, 36)
    const rctx = red.getContext('2d')
    rctx.fillStyle = '#ff0000'
    rctx.fillRect(0, 0, 64, 36)
    const d = draw(scene, scene.items[0].start + 1.2, new Map([[thumb.asset.id, red]]))
    const pills = d.boxOf(ACCENT)
    const thumbBox = d.boxOf([255, 0, 0], 30)
    expect(thumbBox).not.toBeNull()
    expect(pills).not.toBeNull()
    // The pill sits under the thumbnail, and the row stays inside the frame.
    expect(pills!.y0).toBeGreaterThan(thumbBox!.y1)
    expect(d.lit(0, 0, 60, 1080)).toBe(0)
    expect(d.lit(1860, 0, 60, 1080)).toBe(0)
  })

  it('cuts a long title to two lines', () => {
    const t = 'I tried every single AI video editor for thirty days so that you never have to do it yourself'
    const cut = twoLines(t, 'Sora', 30, 380)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut.length).toBeLessThan(t.length)
    expect(twoLines('Short', 'Sora', 30, 380)).toBe('Short')
  })

  it('keeps every title to two lines as the drawing wraps it, so none runs into its pill', () => {
    // Long titles whose long words break early, as archive.org gives NASA's school contacts:
    // under two lines' worth of letters, the second still wrapped to three on its card.
    const titles = [
      'California Students Speak with Station Crew',
      'Space Station Commander Discusses Life in Space with Ukrainian Students',
      'Hadfield Shares The Excitement Of Space With Canadian Students'
    ]
    const doc = docWith('wide', () => [])
    const op = planOp(doc, 'videos', titles.map((t) => `${t} | 2 yr ago`).join('\n'), saidAt(doc, idOf(doc, 'This')))
    const scene = sceneOf(commit(doc, [op], 'cards').doc)
    const texts: TextLayer[] = []
    const walk = (layers: Layer[]): void => {
      for (const l of layers) {
        if (l.kind === 'text') texts.push(l)
        else if (l.kind === 'group') walk(l.children)
      }
    }
    walk(scene.layers)
    const shown = texts.filter((t) => t.maxWidth !== undefined && t.text !== '2 yr ago')
    expect(shown).toHaveLength(3)
    const ctx = createCanvas(16, 16).getContext('2d') as unknown as CanvasRenderingContext2D
    for (const t of shown) expect(layoutText(measurer(ctx), t).lines.length).toBeLessThanOrEqual(2)
    expect(shown[1].text.endsWith('…')).toBe(true)
    // Cut a word at a time, never inside one.
    for (const [i, t] of shown.entries()) expect(titles[i].startsWith(t.text.replace(/…$/, ''))).toBe(true)
  })
})

describe('a page that slides in with a ring', () => {
  function withPage(style: string, box: number[]): { doc: EditDoc; id: string } {
    const base = docWith('wide', () => [])
    const page = addAsset(base, {
      kind: 'image',
      path: '/page.png',
      title: 'channel',
      durationSec: null,
      width: 1200,
      height: 1600,
      origin: { type: 'link', url: 'https://example.com/@channel', author: 'example.com', license: null, range: null }
    })
    const doc = commit(
      page.doc,
      [{ op: 'motion-add', kind: 'screenshot', from: idOf(base, 'This'), to: '4s', text: [page.asset.id], style, box }],
      'page'
    ).doc
    return { doc, id: page.asset.id }
  }

  it('comes in from the right and rings the region once it has come to rest', () => {
    const box = [0.4, 0.3, 0.2, 0.1]
    const { doc, id } = withPage('slide', box)
    const scene = sceneOf(doc)
    const start = scene.items[0].start
    const page = createCanvas(120, 160)
    const pctx = page.getContext('2d')
    pctx.fillStyle = '#ffffff'
    pctx.fillRect(0, 0, 120, 160)
    const images = new Map([[id, page]])
    // It starts off the right edge, comes to rest in the middle, and leaves a little way back to the right.
    const card = scene.layers.find((l) => l.kind === 'group')!
    const xs = (card.transform?.x as { keys: { t: number; v: number }[] }).keys
    expect(xs[0].v).toBeGreaterThan(1920)
    expect(xs[1].v).toBe(960)
    expect(xs[xs.length - 1].v).toBeGreaterThan(960)
    expect(xs[xs.length - 1].v).toBeLessThan(1020)
    // On its way in, no ring yet; it starts drawing as the page comes to rest, round the region, in the accent.
    expect(draw(scene, start + 0.3, images).boxOf(ACCENT, 40)).toBeNull()
    const ring = draw(scene, start + 1.5, images).boxOf(ACCENT, 40)
    expect(ring).not.toBeNull()
    const [bx, by, bw, bh] = box
    expect(ring!.x0).toBeLessThan(bx * 1920)
    expect(ring!.x1).toBeGreaterThan((bx + bw) * 1920)
    expect(ring!.y0).toBeLessThan(by * 1080)
    expect(ring!.y1).toBeGreaterThan((by + bh) * 1080)
    // Not far off it, even with the slow push.
    expect(ring!.x0).toBeGreaterThan(bx * 1920 - 60)
    expect(ring!.x1).toBeLessThan((bx + bw) * 1920 + 60)
  })

  it('rings the region in other styles only when asked, and reads ring and slide from /screenshot', () => {
    const plain = sceneOf(withPage('still', [0.4, 0.3, 0.2, 0.1]).doc)
    const shapes = flat(plain.layers).filter((l) => l.kind === 'shape' && l.stroke && l.trim)
    expect(shapes).toHaveLength(0)
    const { doc } = withPage('scroll', [])
    const op = planOp(doc, 'screenshot', 'slide ring', null)
    expect(op).toMatchObject({ style: 'slide', fx: ['ring'] })
  })

  it('sends the chips round the speaker off as it slides in over them, and leaves them be when it does not', () => {
    // A list, then the page straight after it: the chips' call holds them a second past the list,
    // into the page's first second, as a plan writes it.
    const base = docWith('wide', () => [])
    const page = addAsset(base, {
      kind: 'image',
      path: '/page.png',
      title: 'page',
      durationSec: null,
      width: 1200,
      height: 1600,
      origin: { type: 'link', url: 'https://example.com/', author: 'example.com', license: null, range: null }
    })
    const chips = {
      op: 'motion-add',
      kind: 'chips',
      from: idOf(base, 'Notion'),
      to: `${idOf(base, 'Framer')}.end+1.5`,
      items: ['Notion', 'Figma', 'Linear', 'Slack'].map((label) => ({ label, at: idOf(base, label) }))
    }
    const slide = { op: 'motion-add', kind: 'screenshot', from: idOf(base, 'Arc'), to: '4s', text: [page.asset.id], style: 'slide' }
    const alone = sceneOf(commit(page.doc, [chips], 'chips').doc)
    const both = sceneOf(commit(page.doc, [chips, slide], 'both').doc)
    const card = both.items.find((i) => i.kind === 'screenshot')!
    const before = alone.items.find((i) => i.kind === 'chips')!
    const after = both.items.find((i) => i.kind === 'chips')!
    expect(before.end).toBeGreaterThan(card.start + 1)
    // Gone as the card arrives, every layer with them, and arriving as they did.
    expect(after.start).toBeCloseTo(before.start, 5)
    expect(after.end).toBeLessThanOrEqual(card.start + 0.2)
    expect(Math.max(...flat(after.layers).map((l) => l.end))).toBeLessThanOrEqual(card.start + 0.2)
  })
})

describe('boxed captions', () => {
  it('puts the word being said in a solid box of the accent, the rest of the page plain', () => {
    const doc = docWith('vertical', () => [{ op: 'captions', set: { on: true, preset: 'boxed', wordsPerScreen: 3 } }])
    const scene = sceneOf(doc)
    const pages = scene.layers.filter((l): l is TextLayer => l.kind === 'text')
    expect(pages.length).toBeGreaterThan(5)
    expect(pages.every((p) => (p.spans?.length ?? 0) <= 4)).toBe(true)
    const figma = saidAt(doc, idOf(doc, 'Figma'))
    const page = pages.find((p) => figma >= p.start && figma < p.end)!
    const ctx = createCanvas(10, 10).getContext('2d') as unknown as CanvasRenderingContext2D
    const units = textUnits(ctx, page, figma + 0.05)
    expect(units.block.words[units.active].text).toBe('Figma')
    // The box is drawn in the accent behind that word; before the page there is none.
    const d = draw(scene, figma + 0.1)
    const box = d.boxOf(ACCENT)
    expect(box).not.toBeNull()
    expect(box!.x1 - box!.x0).toBeGreaterThan(80)
    expect(draw(scene, 0.01).boxOf(ACCENT)).toBeNull()
  })

  it('darkens a word only as its box comes onto it, so no word is ever dark off its box', () => {
    const doc = docWith('vertical', () => [{ op: 'captions', set: { on: true, preset: 'boxed', wordsPerScreen: 3 } }])
    const scene = sceneOf(doc)
    const INK: [number, number, number] = [0x15, 0x16, 0x1a]
    // The first moments after each word starts, when the box is still on its way from the word before.
    for (const word of ['use', 'Notion', 'Figma', 'Linear']) {
      for (const after of [0.002, 0.02, 0.05]) {
        const d = draw(scene, saidAt(doc, idOf(doc, word)) + after)
        const box = d.boxOf(ACCENT, 40, 200)
        const ink = d.boxOf(INK, 20)
        if (!ink) continue
        expect(box, `${word} +${after}`).not.toBeNull()
        // Dark letters lie on the box, never off it on the picture.
        expect(ink.x0, `${word} +${after}`).toBeGreaterThanOrEqual(box!.x0 - 2)
        expect(ink.x1, `${word} +${after}`).toBeLessThanOrEqual(box!.x1 + 2)
      }
    }
  })

  it('is a preset: /boxed', async () => {
    const { CAPTION_STYLE_PRESETS } = await import('../presets')
    expect(CAPTION_STYLE_PRESETS.find((p) => p.command === 'boxed')?.style.captions).toMatchObject({ preset: 'boxed' })
  })
})

describe('the commands, and what they read in the speech', () => {
  it('reads figures typed after /count and /flip', () => {
    expect(typedFigures('683,594 to 1,000,000 views')).toMatchObject({
      values: [683594, 1000000],
      written: ['683,594', '1,000,000'],
      after: 'views'
    })
    expect(typedFigures('to a million subscribers')).toMatchObject({ values: [1000000], written: ['1,000,000'], after: 'subscribers' })
    expect(typedFigures('day 1-3', true)).toMatchObject({ values: [1, 2, 3], before: 'day' })
    expect(typedFigures('DAY 1, DAY 2, DAY 5', true).values).toEqual([1, 2, 5])
  })

  it('lands /count’s figures on the words that say them', () => {
    const doc = docWith('wide', () => [])
    const op = planOp(doc, 'count', '683,594 to 1,000,000 views', null)
    expect(op).toMatchObject({
      kind: 'counter',
      from: idOf(doc, '683,594'),
      to: `${idOf(doc, 'million')}.end+1.2`,
      text: ['views'],
      items: [
        { label: '683,594', at: idOf(doc, '683,594') },
        { label: '1,000,000', at: idOf(doc, 'a') }
      ]
    })
  })

  it('puts cards and a page asked for in the chat where the speaker talks about them', () => {
    let doc = docWith('wide', () => [], `${SCRIPT} Here are my latest videos. This is my channel page.`)
    const cards = planOp(doc, 'videos', 'One | 1K views · 1 wk ago\nTwo | 2K views · 2 wk ago', null)
    // Several videos are "videos", not the "video" said earlier about one.
    expect(cards.from).toBe(idOf(doc, 'videos'))
    doc = addAsset(doc, {
      kind: 'image',
      path: '/page.png',
      title: 'channel',
      durationSec: null,
      width: 1200,
      height: 1600,
      origin: { type: 'file', url: null, author: null, license: null, range: null }
    }).doc
    const page = planOp(doc, 'screenshot', 'slide ring right', null)
    expect(page).toMatchObject({ from: idOf(doc, 'channel'), style: 'slide', fx: ['ring'], place: 'right' })
    // At the playhead, they go where it is, as every graphic does.
    expect(planOp(doc, 'screenshot', 'slide', 2).from).not.toBe(idOf(doc, 'channel'))
  })

  it('finds lists of names in speech', () => {
    const doc = docWith('wide', () => [], 'I use Notion for notes, Figma for design and Linear. Then I rest. We met Sam today.')
    const cut = currentCut(doc)
    const lists = listsSaid(resolveCut(cut, doc.words, doc.sources))
    expect(lists.map((l) => l.names)).toEqual([['Notion', 'Figma', 'Linear']])
  })

  it('is in the slash menu Claude is sent, each graphic with an example to learn it from', () => {
    // Plain words are Claude's to read: it runs a graphic as the command in the menu (docs/rebuild.md).
    const menu = motionCommandEntries()
    for (const command of ['chips', 'count', 'flip', 'videos', 'screenshot'])
      expect(menu.find((c) => c.command === command)?.summary, command).toContain(`/${command} `)
    expect(CAPTION_STYLE_PRESETS.find((p) => p.command === 'boxed')?.style.captions).toMatchObject({ on: true, preset: 'boxed' })
  })

  it('moves the way the house does: nothing from nothing, out quicker than in and eased out', () => {
    const doc = docWith('wide', (d) => [
      planOp(d, 'chips', '', saidAt(d, idOf(d, 'Slack'))),
      planOp(d, 'count', '683,594 to 1,000,000 views', null),
      planOp(d, 'videos', 'One video | 1K views · 1 wk ago\nAnother | 2K views · 2 wk ago', saidAt(d, idOf(d, 'This')))
    ])
    const scene = sceneOf(doc)
    const keyed = (a: unknown): { t: number; v: number; ease?: unknown; from?: string }[] =>
      a && typeof a === 'object' && 'keys' in a ? (a as { keys: { t: number; v: number }[] }).keys : []
    for (const item of scene.items) {
      for (const l of flat(item.layers)) {
        const tr = l.transform ?? {}
        // Each enters from a little smaller, never from nothing.
        const scale = keyed(tr.scale)
        if (scale.length) expect(scale[0].v, item.kind).toBeGreaterThanOrEqual(0.8)
        // And leaves eased out, never easing in as it goes.
        for (const k of [...scale, ...keyed(tr.opacity), ...keyed(tr.y)])
          expect(k.ease, `${item.kind} ${JSON.stringify(k)}`).not.toBe('ease-in')
      }
    }
  })

  it('keeps a calendar beside a page in view, whichever was added first', () => {
    let doc = docWith('wide', () => [])
    const page = addAsset(doc, {
      kind: 'image',
      path: '/page.png',
      title: 'channel',
      durationSec: null,
      width: 1200,
      height: 1600,
      origin: { type: 'link', url: 'https://example.com/@channel', author: 'example.com', license: null, range: null }
    })
    doc = page.doc
    const day = idOf(doc, 'Day')
    doc = commit(
      doc,
      [
        planOp(doc, 'flip', 'day 1 to 3', saidAt(doc, idOf(doc, 'one'))),
        { op: 'motion-add', kind: 'screenshot', from: day, to: `${idOf(doc, 'three')}.end+1`, text: [page.asset.id], style: 'slide', place: 'right' }
      ],
      'pair'
    ).doc
    const scene = sceneOf(doc)
    // The calendar's tab, in the accent, shows over the page's dark ground, left of the page.
    const d = draw(scene, saidAt(doc, idOf(doc, 'two')) + 0.6, new Map([[page.asset.id, createCanvas(60, 80)]]))
    const tab = d.boxOf(ACCENT, 30)
    expect(tab).not.toBeNull()
    expect(tab!.x1).toBeLessThan(1920 * 0.41)
  })

  it('pushes a page or photo in on its own side of the frame, never over the calendar beside it', () => {
    // A landscape photo held still, and a tall page that rises: both push in at the end.
    for (const [style, width, height] of [
      ['still', 1920, 1280],
      ['rise', 1200, 3600]
    ] as const) {
      for (const place of ['right', 'left'] as const) {
        let doc = docWith('wide', () => [])
        const pic = addAsset(doc, {
          kind: 'image',
          path: '/pic.png',
          title: 'pic',
          durationSec: null,
          width,
          height,
          origin: { type: 'link', url: 'https://example.com/', author: 'example.com', license: null, range: null }
        })
        doc = pic.doc
        const from = idOf(doc, 'Day')
        const to = `${idOf(doc, 'That')}.end+1`
        doc = commit(
          doc,
          [
            { op: 'motion-add', kind: 'counter', from, to, style: 'flip', place: place === 'right' ? 'left' : 'right', text: ['DAY'], items: [{ label: '1', at: from }] },
            { op: 'motion-add', kind: 'screenshot', from, to, text: [pic.asset.id], style, place }
          ],
          'pair'
        ).doc
        const scene = sceneOf(doc)
        const shot = scene.items.find((i) => i.kind === 'screenshot')!
        const card = shot.layers.find((l) => l.kind === 'group')!
        const last = (v: unknown): number => {
          const k = (v as { keys: { v: number }[] }).keys
          return k[k.length - 1].v
        }
        const cw = 1920 * 0.42
        const x = last(card.transform!.x)
        const scale = last(card.transform!.scale)
        const side = place === 'right' ? 1 : -1
        const inner = 1920 / 2 + side * 1920 * 0.12 - (side * cw) / 2
        const label = `${style} ${place}`
        // It did push in, out from the edge that faces the calendar, and stays in the frame.
        expect(scale, label).toBeGreaterThan(1.2)
        expect(x - (side * scale * cw) / 2, label).toBeCloseTo(inner, 0)
        expect(x - (scale * cw) / 2, label).toBeGreaterThanOrEqual(-0.5)
        expect(x + (scale * cw) / 2, label).toBeLessThanOrEqual(1920.5)
        // And the calendar's tab still shows, clear of it, at the end.
        const d = draw(scene, shot.end - 0.35, new Map([[pic.asset.id, createCanvas(60, 40)]]))
        const tab = d.boxOf(ACCENT, 30)
        expect(tab, label).not.toBeNull()
        if (place === 'right') expect(tab!.x1, label).toBeLessThan(inner)
        else expect(tab!.x0, label).toBeGreaterThan(inner)
      }
    }
  })

  it('tells the planner when each graphic fits', () => {
    const guide = graphicsGuide()
    for (const kind of ['chips', 'counter', 'video-cards']) expect(guide).toContain(`"kind":"${kind}"`)
    expect(guide).toContain('chips, each on the word that names it')
    expect(guide).toContain('"preset":"boxed"')
  })
})
