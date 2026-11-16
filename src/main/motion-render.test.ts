import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { buildRenderArgs, renderCut, type RenderSource } from './cut-render'
import { overlaySpans, renderCutMotion } from './motion-render'
import { probeMedia } from './inspiration/measure'

/**
 * Graphics in a real export: a clip made with lavfi, a graphic anchored to a
 * word, the cut rendered with ffmpeg, and frames read back before, during and
 * after it.
 */

function findFfmpeg(): string | null {
  for (const bin of [process.env.FFMPEG_PATH, 'ffmpeg']) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

const FFMPEG = findFfmpeg()
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))

describe('the final pass with graphics', () => {
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

  async function exportWith(doc: EditDoc, sources: RenderSource[], name: string): Promise<string> {
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const work = join(dir, `work-${name}`)
    const { overlays } = await renderCutMotion({
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
    expect(overlays.length).toBe(1)
    return renderCut(cut, resolved, sources, {
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
