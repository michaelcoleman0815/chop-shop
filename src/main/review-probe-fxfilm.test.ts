import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { renderCutFx } from './fx-render'
import { makeShapeClip, SHAPE_CLIP } from './fx-shapes'
import { findFfmpeg } from './test-media'

/**
 * Re-review of 6f973e6 (merge of 8edda62): cut-render.ts now carries both the scene effects (fx) and
 * the made video's old film (weave, dust, leaks). Neither side's tests render the two together. Here:
 * one render with speed lines and the film look, against the film alone and the speed lines alone.
 */

const FFMPEG = findFfmpeg()
const { width: W, height: H } = SHAPE_CLIP
const WORDS = wordsFromTranscript(
  ['Here', 'it', 'comes', 'and', 'he', 'lands', 'right', 'there.'].map((text, i) => ({ text, startSec: 0.2 + i * 0.45, endSec: 0.5 + i * 0.45 })),
  's1'
)

describe.skipIf(!FFMPEG)('scene effects and the film look in one export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let clip = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'probe-fxfilm-'))
    clip = makeShapeClip(ffmpeg, join(dir, 'shapes.mp4'))
  }, 120_000)
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const docWith = (ops: unknown[]): { doc: EditDoc; cut: Cut } => {
    const source = { id: 's1', path: clip, durationSec: SHAPE_CLIP.sec, width: W, height: H, fps: SHAPE_CLIP.fps }
    const doc = createDoc({ id: 'd', title: 'Shapes', source, words: WORDS })
    const r = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }, ...ops], { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return { doc, cut: r.cut }
  }
  const render = async (name: string, ops: unknown[]): Promise<string> => {
    const { doc, cut } = docWith(ops)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources: RenderSource[] = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const fx = await renderCutFx({ cut, resolved, words: doc.words, sources: doc.sources, quality: 'final', ffmpeg, workDir: join(dir, `fx-${name}`), tracks: [] })
    return renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, `${name}.mp4`), workDir: join(dir, `work-${name}`), quality: 'final', fx })
  }
  const frameAt = (path: string, t: number): Buffer =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 26 })
  const brightness = (rgb: Buffer, r: { x: number; y: number; w: number; h: number }): number => {
    let sum = 0
    let n = 0
    for (let y = Math.round(r.y * H); y < Math.round((r.y + r.h) * H); y++)
      for (let x = Math.round(r.x * W); x < Math.round((r.x + r.w) * W); x++) {
        const k = (y * W + x) * 3
        sum += 0.2126 * rgb[k] + 0.7152 * rgb[k + 1] + 0.0722 * rgb[k + 2]
        n++
      }
    return sum / Math.max(1, n)
  }
  const diff = (a: Buffer, b: Buffer): number => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
    return s / a.length
  }

  it('renders speed lines over the old film, and both show', async () => {
    const film = { op: 'look', set: { dust: 1, leak: 0.6, flicker: 0.4, weave: 1, sepia: 0.6 }, replace: true }
    const lines = { op: 'fx-add', kind: 'speedlines', from: 'w2', to: 'w5' }
    const plain = await render('plain', [])
    const filmOnly = await render('film', [film])
    const fxOnly = await render('lines', [lines])
    const both = await render('both', [film, lines])
    const t = 1.2
    const corners = { x: 0, y: 0, w: 0.25, h: 0.15 }
    const middle = { x: 0.35, y: 0.35, w: 0.3, h: 0.2 }
    const rows = {
      'speed lines in the corners (both - film)': brightness(frameAt(both, t), corners) - brightness(frameAt(filmOnly, t), corners),
      'speed lines in the corners (lines - plain)': brightness(frameAt(fxOnly, t), corners) - brightness(frameAt(plain, t), corners),
      'middle left clear (|both - film|)': Math.abs(brightness(frameAt(both, t), middle) - brightness(frameAt(filmOnly, t), middle)),
      'film over the picture (both vs lines, whole frame)': diff(frameAt(both, t), frameAt(fxOnly, t)),
      'film over the picture (film vs plain, whole frame)': diff(frameAt(filmOnly, t), frameAt(plain, t)),
      'after the lines (both vs film at 3.5 s)': diff(frameAt(both, 3.5), frameAt(filmOnly, 3.5))
    }
    for (const [k, v] of Object.entries(rows)) console.log(`${k}: ${v.toFixed(2)}`)
    expect(rows['speed lines in the corners (both - film)']).toBeGreaterThan(8)
    expect(rows['film over the picture (both vs lines, whole frame)']).toBeGreaterThan(4)
    expect(rows['after the lines (both vs film at 3.5 s)']).toBeLessThan(1.5)
  }, 600_000)
})
