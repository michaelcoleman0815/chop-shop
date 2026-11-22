import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, type Cut, type EditDoc } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { countFrames, findFfmpeg, ffmpegRun } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * A shaky shot held still (Treatment.steady), rendered for real. The shot is a
 * white square on a fixed grain, the frame wandering as a hand holds it, up to
 * about 15 px off and back; how far the square moves from frame to frame says
 * how shaky it is. (A regular grid would not do: a stabiliser matches blocks,
 * and a pattern that repeats every few pixels matches in many places.)
 */
describe.skipIf(!FFMPEG)('steadying a shaky shot', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-steady-'))
    const path = join(dir, 'shaky.mp4')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:s=720x440:r=30:d=3,noise=alls=70:allf=0,gblur=sigma=1.5,' +
        'drawbox=x=330:y=190:w=60:h=60:color=white:t=fill,' +
        "crop=w=640:h=360:x='40+12*sin(n*0.9)+5*sin(n*2.1)':y='40+10*cos(n*1.1)+4*sin(n*2.7)'",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      path
    ])
    const source = { id: 's1', path, durationSec: 3, width: 640, height: 360, fps: 30 }
    sources = [{ ...source, hasAudio: false }]
    doc = createDoc({ id: 's', title: 'Shaky', source, words: [] })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const cutWith = (ops: unknown[]): Cut => {
    const r = applyOps(
      currentCut(doc),
      [...ops, { op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    return r.cut
  }

  /** How far the white square moves between frames, on average, in pixels of a 160-wide picture. */
  const shake = async (cut: Cut, name: string): Promise<number> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final'
    })
    expect(countFrames(ffmpeg, out)).toBe(Math.round(resolved.durationSec * 30))
    const [w, h] = [160, 90]
    const raw = execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', out, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-'],
      { maxBuffer: 1 << 24 }
    )
    const centres: [number, number][] = []
    for (let f = 0; f + w * h <= raw.length; f += w * h) {
      let sx = 0
      let sy = 0
      let n = 0
      for (let i = 0; i < w * h; i++) {
        if (raw[f + i] < 235) continue
        sx += i % w
        sy += Math.floor(i / w)
        n++
      }
      if (n > 0) centres.push([sx / n, sy / n])
    }
    // The first and last frames of a stabiliser settle; the middle is what is watched.
    const middle = centres.slice(5, -5)
    let moved = 0
    for (let i = 1; i < middle.length; i++) moved += Math.hypot(middle[i][0] - middle[i - 1][0], middle[i][1] - middle[i - 1][1])
    return moved / (middle.length - 1)
  }

  it('holds it still, the picture cropped in a little, at its full length', async () => {
    const shaky = await shake(cutWith([]), 'as-shot')
    const steadied = await shake(cutWith([{ op: 'treat', beats: ['b1'], set: { steady: true } }]), 'steadied')
    expect(shaky).toBeGreaterThan(2)
    expect(steadied).toBeLessThan(shaky * 0.35)
  })
})
