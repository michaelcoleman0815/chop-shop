import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => '/nowhere' }, safeStorage: {} }))

import { commit, createDoc, currentCut, OpSchema, resolveCut, wordsFromTranscript, type Op } from '../shared/edit'
import { designSize } from '../shared/motion'
import { renderCut } from './cut-render'
import { renderCutMotion, subtitlePass } from './motion-render'
import { followObjects } from './plan-follow'
import type { PlanEditResult } from './planner'
import { findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()
const VISION = process.platform === 'darwin' && existsSync(join(process.cwd(), 'resources', 'bin', 'chopshop-vision'))
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))

/**
 * A graphic pinned to an object, from end to end on a Mac: an orange card
 * slides across a grainy room as it is talked about, the plan's graphic (a
 * red square just above the card) is pinned to it, Vision follows the card,
 * and the export is read back: the square moves as the card does.
 */
describe.skipIf(!FFMPEG || !VISION)('a pinned graphic in a real export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let path = ''
  const W = 960
  const H = 540

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-follow-'))
    path = join(dir, 'card.mp4')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x404040:s=${W}x${H}:r=30:d=4,noise=alls=25:allf=0`,
      '-f',
      'lavfi',
      '-i',
      'color=c=0xff8a1f:s=140x140:r=30:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=330:sample_rate=48000:duration=4',
      '-filter_complex',
      `[0][1]overlay=x='100+150*t':y=260:shortest=1,format=yuv420p[v]`,
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      path
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** Where the pixels of one colour are in a frame of the export, and how many. */
  const centroid = (frame: Buffer, w: number, is: (r: number, g: number, b: number) => boolean) => {
    let sx = 0
    let sy = 0
    let n = 0
    for (let i = 0; i + 2 < frame.length; i += 3) {
      if (!is(frame[i], frame[i + 1], frame[i + 2])) continue
      const p = i / 3
      sx += p % w
      sy += Math.floor(p / w)
      n++
    }
    return { x: sx / n, y: sy / n, n }
  }

  it('moves the graphic with the card it is pinned to', async () => {
    const source = { id: 's1', path, durationSec: 4, width: W, height: H, fps: 30 }
    const said: [string, number, number][] = [
      ['Look', 0.3, 0.6],
      ['at', 0.65, 0.8],
      ['this', 0.85, 1.1],
      ['card', 1.15, 1.5],
      ['moving', 1.55, 2.0],
      ['right', 2.05, 2.4],
      ['across', 2.45, 3.0],
      ['here.', 3.05, 3.6]
    ]
    const words = wordsFromTranscript(
      said.map(([text, startSec, endSec]) => ({ text, startSec, endSec })),
      's1'
    )
    let doc = createDoc({ id: 'f', title: 'Card', source, words })
    doc = commit(doc, [{ op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }], 'Setup.').doc
    // The square sits just above where the card is as "this" is said, in design pixels.
    const design = designSize('original', source)
    const s = design.width / W
    const square = OpSchema.parse({
      op: 'motion-add',
      kind: 'layers',
      from: 'w3',
      to: 'w8.end',
      layers: [
        {
          kind: 'shape',
          shape: { type: 'rect', w: 60 * s, h: 60 * s },
          fill: '#ff0000',
          transform: { x: (100 + 150 * 0.85 + 70) * s, y: 200 * s }
        }
      ]
    }) as Op
    const offered: PlanEditResult = {
      ok: true,
      ops: [square],
      steps: [{ ops: [square] }],
      question: null,
      summary: 'A square follows the card.',
      reply: '',
      notesHandled: [],
      needs: [],
      rejected: [],
      brollWanted: []
    }
    const pinned = await followObjects(doc, offered, [0])
    if (!pinned.ok) throw new Error(pinned.message)
    expect(pinned.rejected).toEqual([])
    expect((pinned.ops[0] as { follow?: unknown }).follow).toBeTruthy()
    doc = commit(doc, pinned.ops, pinned.summary).doc

    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = [{ ...source, hasAudio: true }]
    const work = join(dir, 'work')
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
    expect(scene.hidden).toEqual([])
    const pass = subtitlePass(cut, resolved, scene)
    const out = await renderCut(pass.cut, pass.resolved, sources, {
      ffmpeg,
      outputPath: join(dir, 'export.mp4'),
      workDir: work,
      quality: 'preview',
      overlays
    })
    const item = scene.items[0]
    // A frame of the export, at the clip's own size.
    const grab = (t: number): { frame: Buffer; w: number } => {
      const raw = execFileSync(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', out, '-frames:v', '1', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        { maxBuffer: 64 * 1024 * 1024 }
      )
      expect(raw.length).toBe(W * H * 3)
      return { frame: raw, w: W }
    }
    const red = (r: number, g: number, b: number): boolean => r > 170 && g < 90 && b < 90
    const orange = (r: number, g: number, b: number): boolean => r > 200 && g > 100 && g < 175 && b < 90
    const seen = [item.at + 0.4, Math.min(item.end - 0.3, item.at + 1.8)].map((t) => {
      const { frame, w } = grab(t)
      return { square: centroid(frame, w, red), card: centroid(frame, w, orange) }
    })
    for (const f of seen) {
      expect(f.square.n).toBeGreaterThan(200)
      expect(f.card.n).toBeGreaterThan(2000)
    }
    const cardMoved = seen[1].card.x - seen[0].card.x
    const squareMoved = seen[1].square.x - seen[0].square.x
    expect(cardMoved).toBeGreaterThan(120)
    expect(Math.abs(squareMoved - cardMoved)).toBeLessThan(12)
    expect(Math.abs(seen[1].square.y - seen[0].square.y)).toBeLessThan(8)
  }, 180_000)
})
