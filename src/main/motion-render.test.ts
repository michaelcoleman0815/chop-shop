import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addAsset, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { buildRenderArgs, frameSize, renderCut, type RenderSource } from './cut-render'
import { createCanvas } from '@napi-rs/canvas'
import { designSize, renderFrame } from '../shared/motion'
import { overlaySpans, renderCutMotion, sceneForCut, subtitleCut, subtitlePass } from './motion-render'
import { probeMedia } from './inspiration/measure'

/**
 * Graphics in a real export: a clip made with lavfi, a graphic anchored to a
 * word, the cut rendered with ffmpeg, and frames read back before, during and
 * after it.
 */

/** The same search cut-render.test.ts makes: FFMPEG_PATH, then ffmpeg-static, then the PATH. */
function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    candidates.splice(1, 0, require('ffmpeg-static') as string)
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

const FFMPEG = findFfmpeg()
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))

describe('the final pass with graphics', () => {
  it('lays graphics out in the frame the renderer makes', () => {
    // The editor draws in designSize; the export renders frameSize. They must agree.
    for (const aspect of ['vertical', 'wide', 'square', 'original'] as const) {
      for (const source of [
        { width: 1920, height: 1080 },
        { width: 3840, height: 2160 },
        { width: 1080, height: 1920 },
        { width: 1000, height: 750 }
      ]) {
        expect(designSize(aspect, source)).toEqual(frameSize(aspect, source))
      }
    }
  })

  it('lays each overlay over the captions and under the logo, shifted to its start', () => {
    const args = buildRenderArgs(
      [{ path: '/a.mov', startSec: 0, durationSec: 4, hasAudio: true, treatment: null, broll: null }],
      {
        width: 540,
        height: 960,
        fps: 30,
        assPath: '/c.ass',
        fontsDir: null,
        loudness: null,
        quality: 'preview',
        outputPath: '/out.mp4',
        logo: { path: '/logo.png', corner: 'top-left', opacity: 1 },
        overlays: [
          { path: '/m0.mov', startSec: 1.5, durationSec: 1 },
          { path: '/m1.mov', startSec: 3, durationSec: 0.5 }
        ]
      }
    )
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(args.slice(args.indexOf('/m0.mov') - 1, args.indexOf('/m0.mov') + 1)).toEqual(['-i', '/m0.mov'])
    expect(graph).toContain('[1:v]setpts=PTS-STARTPTS+1.500/TB[mo0]')
    expect(graph).toContain('[vsub][mo0]overlay=0:0:eof_action=pass[vmo0]')
    expect(graph).toContain('[vmo0][mo1]overlay=0:0:eof_action=pass[vmo1]')
    expect(graph).toContain('[vmo1][logo]overlay')
    // Without graphics the graph is exactly what it was.
    const plain = buildRenderArgs(
      [{ path: '/a.mov', startSec: 0, durationSec: 4, hasAudio: true, treatment: null, broll: null }],
      {
        width: 540,
        height: 960,
        fps: 30,
        assPath: null,
        fontsDir: null,
        loudness: null,
        quality: 'preview',
        outputPath: '/o.mp4'
      }
    )
    expect(plain.join(' ')).not.toContain('overlay')
  })

  it('leaves captions the graphics draw out of the subtitle pass, and only those', () => {
    const source = { id: 's1', path: '/x.mov', durationSec: 4, width: 1080, height: 1920, fps: 30 }
    const words = wordsFromTranscript([{ text: 'Hello', startSec: 0.5, endSec: 0.9 }], 's1')
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const plain = currentCut(doc)
    expect(subtitleCut(plain)).toBe(plain)
    const drawn = commit(doc, [{ op: 'captions', set: { preset: 'hierarchy' } }], 'x').doc
    const cut = currentCut(drawn)
    expect(subtitleCut(cut).captions).toEqual({ ...cut.captions, on: false })
    const scene = sceneForCut({
      cut,
      resolved: resolveCut(cut, words, [source]),
      words,
      sources: [source],
      brand: null
    })
    expect(scene.layers.length).toBe(1)
  })

  it('keeps words said under a card or a title out of the subtitles, and nothing else', () => {
    const source = { id: 's1', path: '/x.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 }
    const said = 'So what is the FOMO and partnership? It is simple and it is yours to keep.'
    let t = 0.3
    const words = wordsFromTranscript(
      said.split(' ').map((text) => {
        const w = { text, startSec: t, endSec: t + 0.3 }
        t += 0.4
        return w
      }),
      's1'
    )
    const doc = commit(
      createDoc({ id: 'd', title: 't', source, words }),
      [{ op: 'motion-add', kind: 'title', from: 'w1', to: '2s', text: ['So what is the', 'FOMO & partnership?'] }],
      'x'
    ).doc
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, words, [source])
    const scene = sceneForCut({ cut, resolved, words, sources: [source], brand: null })
    const title = scene.items[0]
    const pass = subtitlePass(cut, resolved, scene)
    expect(pass.cut).toBe(cut)
    const under = (w: { outStart: number; outEnd: number }): boolean => w.outEnd > title.start && w.outStart < title.end
    expect(resolved.words.some(under)).toBe(true)
    expect(pass.resolved.words.some(under)).toBe(false)
    expect(pass.resolved.words).toEqual(resolved.words.filter((w) => !under(w)))
    expect(pass.resolved.pieces).toBe(resolved.pieces)
    // With no card, the very same objects.
    const plain = currentCut(createDoc({ id: 'p', title: 't', source, words }))
    const r = resolveCut(plain, words, [source])
    expect(
      subtitlePass(plain, r, sceneForCut({ cut: plain, resolved: r, words, sources: [source], brand: null }))
    ).toEqual({
      cut: plain,
      resolved: r
    })
  })

  it('merges stretches until there are few enough inputs', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      kind: 'shape' as const,
      start: i,
      end: i + 0.2,
      shape: { type: 'rect' as const, w: 10, h: 10 }
    }))
    expect(overlaySpans(many, 40, 12).length).toBeLessThanOrEqual(12)
    expect(overlaySpans(many, 40, 100)).toHaveLength(30)
  })
})

describe.skipIf(!FFMPEG)('exporting graphics', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-motion-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function clip(name: string, w: number, h: number): string {
    const path = join(dir, name)
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:s=${w}x${h}:r=30:d=4`,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=48000:duration=4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path
    ])
    return path
  }

  /** One frame of a video as RGB bytes. */
  function frameAt(path: string, t: number, w: number, h: number): Buffer {
    const raw = execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', path, '-frames:v', '1'].concat([
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ]),
      { maxBuffer: 64 * 1024 * 1024 }
    )
    expect(raw.length).toBe(w * h * 3)
    return raw
  }
  const rgb = (f: Buffer, w: number, x: number, y: number): number[] => {
    const i = (Math.round(y) * w + Math.round(x)) * 3
    return [f[i], f[i + 1], f[i + 2]]
  }

  async function exportWith(doc: EditDoc, sources: RenderSource[], name: string, spans = 1): Promise<string> {
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const work = join(dir, `work-${name}`)
    const { overlays, scene } = await renderCutMotion({
      cut,
      resolved,
      words: doc.words,
      sources,
      assets: doc.assets,
      brand: null,
      quality: 'preview',
      ffmpeg,
      workDir: join(work, 'motion'),
      fontsDir: FONTS
    })
    expect(overlays.length).toBe(spans)
    // As the app's export does.
    const pass = subtitlePass(cut, resolved, scene)
    return renderCut(pass.cut, pass.resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}-export.mp4`),
      workDir: work,
      quality: 'preview',
      overlays
    })
  }

  const words = (): ReturnType<typeof wordsFromTranscript> =>
    wordsFromTranscript(
      [
        { text: 'Lock', startSec: 0.3, endSec: 0.6 },
        { text: 'the', startSec: 0.65, endSec: 0.8 },
        { text: 'exposure.', startSec: 1.6, endSec: 2.2 },
        { text: 'Done.', startSec: 2.6, endSec: 3.1 }
      ],
      's1'
    )

  // A red square 200 design pixels wide at the centre, from "exposure" for one second.
  const square = {
    op: 'motion-add' as const,
    kind: 'layers' as const,
    from: 'w3',
    to: '1s',
    layers: [
      {
        kind: 'shape' as const,
        shape: { type: 'rect' as const, w: 200, h: 200 },
        fill: '#ff0000',
        transform: { x: 0, y: 0 }
      }
    ]
  }

  for (const [shape, sw, sh, ow, oh] of [
    ['vertical', 640, 360, 540, 960],
    ['wide', 640, 360, 960, 540]
  ] as const) {
    it(`draws a graphic only while it is on, where it belongs (${shape})`, async () => {
      const path = clip(`${shape}.mp4`, sw, sh)
      const source = { id: 's1', path, durationSec: 4, width: sw, height: sh, fps: 30 }
      const design = shape === 'vertical' ? { w: 1080, h: 1920 } : { w: 1920, h: 1080 }
      const centred = {
        ...square,
        layers: [{ ...square.layers[0], transform: { x: design.w / 2, y: design.h / 2 } }]
      }
      const doc = commit(
        createDoc({ id: 'm', title: 'Motion', source, words: words() }),
        [{ op: 'aspect', aspect: shape }, centred],
        'Square.'
      ).doc
      const out = await exportWith(doc, [{ ...source, hasAudio: true }], shape)
      const info = await probeMedia(ffmpeg, out)
      expect([info.width, info.height]).toEqual([ow, oh])
      const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
      const at = resolved.words.find((w) => w.id === 'w3')!.outStart
      expect(Math.abs(info.durationSec - resolved.durationSec)).toBeLessThan(0.15)

      const before = frameAt(out, at - 0.3, ow, oh)
      const during = frameAt(out, at + 0.5, ow, oh)
      const after = frameAt(out, Math.min(resolved.durationSec - 0.1, at + 1.3), ow, oh)
      const centre = [ow / 2, oh / 2] as const
      const red = rgb(during, ow, ...centre)
      expect(red[0]).toBeGreaterThan(200)
      expect(red[1]).toBeLessThan(70)
      // The square is 200 design pixels: 100 output pixels at half size. Just outside it is the clip.
      const edge = rgb(during, ow, ow / 2 + 60, oh / 2)
      expect(Math.abs(edge[0] - 128)).toBeLessThan(12)
      for (const f of [before, after]) {
        const grey = rgb(f, ow, ...centre)
        expect(Math.abs(grey[0] - 128)).toBeLessThan(12)
        expect(Math.abs(grey[1] - 128)).toBeLessThan(12)
      }
    })
  }

  it('draws hierarchy captions in place of the subtitles', async () => {
    const path = clip('captions.mp4', 360, 640)
    const source = { id: 's1', path, durationSec: 4, width: 360, height: 640, fps: 30 }
    const doc = commit(
      createDoc({ id: 'c', title: 'Captions', source, words: words() }),
      [
        { op: 'aspect', aspect: 'vertical' },
        // At the top, so the page and where subtitles would sit (a little lower) are told apart.
        { op: 'captions', set: { on: true, preset: 'hierarchy', position: 'top' } }
      ],
      'Captions.'
    ).doc
    const out = await exportWith(doc, [{ ...source, hasAudio: true }], 'captions')
    const [ow, oh] = [540, 960]
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    // Settled on the second page, "exposure", after it has faded in and before it goes.
    const said = resolved.words.find((w) => w.id === 'w3')!.outStart + 0.45
    // White letters where the graphics put the page (its top 11% down), and nowhere else.
    const bright = (f: Buffer, y0: number, y1: number): number => {
      let n = 0
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < ow; x++) {
          const [r, g, b] = rgb(f, ow, x, y)
          if (r > 215 && g > 215 && b > 215) n++
        }
      return n
    }
    const during = frameAt(out, said, ow, oh)
    const page = bright(during, Math.round(oh * 0.09), Math.round(oh * 0.17))
    expect(page).toBeGreaterThan(300)
    expect(bright(during, 0, Math.round(oh * 0.09)) + bright(during, Math.round(oh * 0.17), oh)).toBe(0)
    // As many white pixels as the graphics alone draw: the subtitle pass added no words of its own.
    const scene = sceneForCut({ cut: currentCut(doc), resolved, words: doc.words, sources: [source], brand: null })
    const canvas = createCanvas(ow, oh)
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    renderFrame(ctx, said, scene.layers, scene.size, { width: ow, height: oh })
    const drawn = ctx.getImageData(0, 0, ow, oh).data
    let own = 0
    for (let i = 0; i < drawn.length; i += 4)
      if (drawn[i + 3] > 200 && drawn[i] > 215 && drawn[i + 1] > 215 && drawn[i + 2] > 215) own++
    expect(page / own).toBeGreaterThan(0.8)
    expect(page / own).toBeLessThan(1.2)
  })

  it('exports a captured page as a screenshot, and never fetches a picture from a link', async () => {
    // A page of four colour bands, on disk as a capture is; and a second picture whose path is a link.
    const page = createCanvas(430, 1720)
    const pctx = page.getContext('2d')
    for (const [i, colour] of ['#E53935', '#43A047', '#1E88E5', '#FDD835'].entries()) {
      pctx.fillStyle = colour
      pctx.fillRect(0, i * 430, 430, 430)
    }
    const png = join(dir, 'page.png')
    writeFileSync(png, page.toBuffer('image/png'))
    let asked = 0
    const server = createServer((_req, res) => {
      asked++
      res.end()
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    try {
      const path = clip('shot.mp4', 640, 360)
      const source = { id: 's1', path, durationSec: 4, width: 640, height: 360, fps: 30 }
      const picture = (at: string, title: string) => ({
        kind: 'image' as const,
        path: at,
        title,
        durationSec: null,
        width: 430,
        height: 1720,
        origin: {
          type: 'link' as const,
          url: 'https://example.com/',
          author: 'example.com',
          license: null,
          range: null
        }
      })
      let doc = createDoc({ id: 's', title: 'Shot', source, words: words() })
      doc = addAsset(doc, picture(png, 'page')).doc
      doc = addAsset(doc, picture(`http://127.0.0.1:${port}/page.png`, 'linked')).doc
      doc = commit(
        doc,
        [
          { op: 'aspect', aspect: 'wide' },
          { op: 'motion-add', kind: 'screenshot', from: 'w1', to: '0.9s', text: ['a1'], style: 'still' },
          { op: 'motion-add', kind: 'screenshot', from: 'w4', to: '1s', text: ['a2'], style: 'still' }
        ],
        'Shots.'
      ).doc
      expect(currentCut(doc).motion).toHaveLength(2)
      // Two stretches of graphics: the page, then the one whose picture was never loaded.
      const out = await exportWith(doc, [{ ...source, hasAudio: true }], 'shot', 2)
      const [ow, oh] = [960, 540]
      const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
      const at = resolved.words.find((w) => w.id === 'w1')!.outStart
      const during = frameAt(out, at + 0.5, ow, oh)
      // The top of the page in the middle of the frame, the dark around it, the clip back after.
      const top = rgb(during, ow, ow / 2, oh * 0.2)
      expect(top[0]).toBeGreaterThan(200)
      expect(top[1]).toBeLessThan(80)
      expect(Math.max(...rgb(during, ow, 8, 8))).toBeLessThan(24)
      const after = frameAt(out, at + 1.0, ow, oh)
      expect(Math.abs(rgb(after, ow, ow / 2, oh * 0.2)[0] - 128)).toBeLessThan(12)
      // The picture at a link was left alone: no request reached it.
      expect(asked).toBe(0)
    } finally {
      server.close()
    }
  })

  it('exports a cut with no graphics exactly as before', async () => {
    const path = clip('plain.mp4', 640, 360)
    const source = { id: 's1', path, durationSec: 4, width: 640, height: 360, fps: 30 }
    const doc = createDoc({ id: 'p', title: 'Plain', source, words: words() })
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const { overlays } = await renderCutMotion({
      cut,
      resolved,
      words: doc.words,
      sources: [source],
      assets: [],
      brand: null,
      quality: 'preview',
      ffmpeg,
      workDir: join(dir, 'plain-motion'),
      fontsDir: FONTS
    })
    expect(overlays).toEqual([])
    expect(existsSync(join(dir, 'plain-motion'))).toBe(false)
  })
})
