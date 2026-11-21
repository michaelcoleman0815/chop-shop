import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import * as SIMPLE_ICONS from 'simple-icons'
import INDEX from 'simple-icons/icons.json'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import {
  buildScene,
  DEFAULT_THEME,
  designSize,
  findLogo,
  initials,
  logoLookup,
  marksFrom,
  MOTION_FONTS,
  planMotionCommand,
  renderFrame,
  titleToSlug,
  type FaceSample,
  type ImageLayer,
  type LogoEntry,
  type MotionScene,
  type MotionTheme
} from '.'

/**
 * Logo pops: brand marks from Simple Icons, the creator's own logos, and
 * letters when there is neither; bouncing in beside the speaker as each
 * brand is named. Checked on the export's canvas.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
const ENTRIES = INDEX as unknown as LogoEntry[]
const LOGOS = logoLookup(ENTRIES, marksFrom(SIMPLE_ICONS as unknown as Record<string, unknown>))

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const SCRIPT = 'You can buy Bitcoin today and hold Ethereum next to it, then post about it on Twitter tonight.'

function docWith(aspect: 'vertical' | 'wide', ops: unknown[]): EditDoc {
  let t = 0.5
  const words = SCRIPT.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += 0.4
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
  const r = commit(
    createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') }),
    [{ op: 'aspect', aspect }, ...ops],
    'x'
  )
  expect(r.rejected).toEqual([])
  return r.doc
}

function sceneOf(doc: EditDoc, theme: MotionTheme = DEFAULT_THEME, faces?: FaceSample[]): MotionScene {
  const cut = currentCut(doc)
  return buildScene({
    cut,
    resolved: resolveCut(cut, doc.words, doc.sources),
    words: doc.words,
    size: designSize(cut.aspect, doc.sources[0]),
    theme,
    faces
  })
}

function draw(scene: MotionScene, t: number, images = new Map<string, CanvasImageSource>()) {
  const { width, height } = scene.size
  const ctx = createCanvas(width, height).getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, scene.layers, scene.size, scene.size, { logos: LOGOS, images })
  const data = ctx.getImageData(0, 0, width, height).data
  return {
    at: (x: number, y: number): number[] => {
      const i = (Math.round(y) * width + Math.round(x)) * 4
      return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    },
    lit: (x0: number, y0: number, w: number, h: number): number => {
      let n = 0
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, y0 + h); y++)
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, x0 + w); x++)
          if (data[(y * width + x) * 4 + 3] > 128) n++
      return n
    }
  }
}

const near = (rgb: number[], hex: string, tol = 24): boolean => {
  const n = parseInt(hex.slice(1), 16)
  return (
    Math.abs(rgb[0] - (n >> 16)) < tol &&
    Math.abs(rgb[1] - ((n >> 8) & 255)) < tol &&
    Math.abs(rgb[2] - (n & 255)) < tol
  )
}

describe('brand marks', () => {
  it('turns names into the package’s slugs, and finds brands by older names', () => {
    expect(titleToSlug('Node.js')).toBe('nodedotjs')
    expect(titleToSlug('C++')).toBe('cplusplus')
    expect(titleToSlug('X')).toBe('x')
    expect(findLogo('Bitcoin', ENTRIES)?.slug).toBe('bitcoin')
    expect(findLogo('Twitter', ENTRIES)?.slug).toBe('x')
    expect(findLogo('Not a real brand at all', ENTRIES)).toBeNull()
    expect(LOGOS('twitter')?.title).toBe('X')
    expect(LOGOS('bitcoin')?.hex).toBe('F7931A')
    expect(initials('Field Notes')).toBe('FN')
  })
})

describe('logo pops', () => {
  it('pops each brand in as it is named, on a tile in its own colour', () => {
    const doc = docWith('wide', [
      { op: 'motion-add', kind: 'logo', from: 'w4', to: '4s', text: ['Bitcoin', 'Ethereum'] }
    ])
    const scene = sceneOf(doc)
    const item = scene.items[0]
    const [btc, eth] = item.layers as ImageLayer[]
    expect(btc.logo).toBe('bitcoin')
    expect(eth.logo).toBe('ethereum')
    const words = resolveCut(currentCut(doc), doc.words, doc.sources).words
    const bitcoin = words[3].outStart
    const ethereum = words[7].outStart
    const at = (l: ImageLayer): [number, number] => [l.transform?.x as number, l.transform?.y as number]
    // Not before it is named; settled and in colour half a second after.
    expect(draw(scene, bitcoin - 0.35).lit(...at(btc), 1, 1)).toBe(0)
    const settled = draw(scene, bitcoin + 0.6)
    const [bx, by] = at(btc)
    expect(near(settled.at(bx - btc.w * 0.4, by), '#F7931A')).toBe(true)
    // The mark is white on the tile.
    let white = 0
    for (let dx = -40; dx <= 40; dx += 4)
      for (let dy = -40; dy <= 40; dy += 4) if (near(settled.at(bx + dx, by + dy), '#FFFFFF', 30)) white++
    expect(white).toBeGreaterThan(20)
    // Ethereum waits for its own word.
    expect(settled.lit(...at(eth), 1, 1)).toBe(0)
    expect(draw(scene, ethereum + 0.6).lit(...at(eth), 1, 1)).toBeGreaterThan(0)
    // Gone at the end.
    expect(draw(scene, item.end).lit(0, 0, 1920, 1080)).toBe(0)
  })

  it('finds a brand by an older name, and shows letters for one it does not know', () => {
    const scene = sceneOf(
      docWith('vertical', [{ op: 'motion-add', kind: 'logo', from: 'w1', to: '6s', text: ['Twitter', 'Zorblax Labs'] }])
    )
    const [twitter, unknown] = scene.items[0].layers as ImageLayer[]
    const f = draw(scene, scene.items[0].end - 0.5)
    // X's tile is black.
    expect(
      near(f.at((twitter.transform?.x as number) - twitter.w * 0.42, twitter.transform?.y as number), '#000000')
    ).toBe(true)
    // The unknown brand: a dark tile with "ZL" in white.
    expect(unknown.fallback?.text).toBe('ZL')
    const ux = unknown.transform?.x as number
    const uy = unknown.transform?.y as number
    expect(near(f.at(ux - unknown.w * 0.42, uy), '#2B2B30')).toBe(true)
    let white = 0
    for (let dx = -50; dx <= 50; dx += 5)
      for (let dy = -30; dy <= 30; dy += 5) if (near(f.at(ux + dx, uy + dy), '#FFFFFF', 30)) white++
    expect(white).toBeGreaterThan(5)
  })

  it('uses the creator’s own logo by its name before any mark', () => {
    const path = '/brand/fieldnotes.png'
    const theme = { ...DEFAULT_THEME, logos: [{ name: 'Field Notes', path }] }
    const scene = sceneOf(
      docWith('wide', [{ op: 'motion-add', kind: 'logo', from: 'w1', text: ['field notes'] }]),
      theme
    )
    const layer = scene.items[0].layers[0] as ImageLayer
    expect(layer.file).toBe(path)
    expect(layer.logo).toBeUndefined()
    // A green square standing in for the picture, cut to the tile.
    const pic = createCanvas(64, 64)
    const pctx = pic.getContext('2d')
    pctx.fillStyle = '#00C853'
    pctx.fillRect(0, 0, 64, 64)
    const f = draw(scene, scene.items[0].end - 0.5, new Map([[`file:${path}`, pic as unknown as CanvasImageSource]]))
    expect(near(f.at(layer.transform?.x as number, layer.transform?.y as number), '#00C853')).toBe(true)
    // The tile's rounded corner is cut away.
    const cx = (layer.transform?.x as number) - layer.w / 2 + 4
    const cy = (layer.transform?.y as number) - layer.h / 2 + 4
    expect(f.at(cx, cy)[1]).toBeLessThan(150)
  })

  it('goes beside the speaker on the side with room, clear of the face', () => {
    const face = { x: 0.3, y: 0.2, w: 0.14, h: 0.3 }
    const scene = sceneOf(
      docWith('wide', [{ op: 'motion-add', kind: 'logo', from: 'w4', to: '4s', text: ['Bitcoin', 'Ethereum'] }]),
      DEFAULT_THEME,
      [{ t: 0, faces: [face] }]
    )
    for (const l of scene.items[0].layers as ImageLayer[]) {
      // The face is left of centre, so the logos go right of it.
      expect(l.transform?.x as number).toBeGreaterThan((face.x + face.w) * 1920 + l.w / 2 - 1)
    }
    const f = draw(scene, scene.items[0].end - 0.3)
    expect(f.lit(face.x * 1920, face.y * 1080, face.w * 1920, face.h * 1080)).toBe(0)
  })

  it('keeps four logos inside the frame in every style, in both shapes', () => {
    for (const aspect of ['vertical', 'wide'] as const)
      for (const style of ['tile', 'coin', 'bare']) {
        const scene = sceneOf(
          docWith(aspect, [
            {
              op: 'motion-add',
              kind: 'logo',
              from: 'w1',
              to: '6s',
              style,
              text: ['Bitcoin', 'Ethereum', 'X', 'Solana']
            }
          ])
        )
        const { width, height } = scene.size
        const f = draw(scene, scene.items[0].end - 0.5)
        const edges =
          f.lit(0, 0, width, 2) +
          f.lit(0, height - 2, width, 2) +
          f.lit(0, 0, 2, height) +
          f.lit(width - 2, 0, 2, height)
        expect(edges, `${aspect} ${style}`).toBe(0)
        expect(f.lit(0, 0, width, height), `${aspect} ${style}`).toBeGreaterThan(20000)
      }
  })

  it('reads /logo into brands to pop', () => {
    const doc = docWith('wide', [])
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(
      planMotionCommand('logo', 'coin Bitcoin, Ethereum', { doc, resolved, time: null, brandName: '' })
    ).toMatchObject({
      op: { kind: 'logo', style: 'coin', items: [{ label: 'Bitcoin' }, { label: 'Ethereum' }] }
    })
    expect(planMotionCommand('logo', '', { doc, resolved, time: null, brandName: '' })).toEqual({
      problem: 'Tell me the brand, like /logo Bitcoin.'
    })
  })
})
