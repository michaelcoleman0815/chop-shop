import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  cameraPlan,
  createDoc,
  currentCut,
  focusSource,
  resolveCut,
  viewAt,
  windowAt,
  type Region
} from '../shared/edit'
import { renderCut } from './cut-render'
import { findFocus } from './focus'
import { ffmpegRun, findFfmpeg, frameColour } from './test-media'

const FFMPEG = findFfmpeg()

/** A region contains a point, given as fractions of the screen. */
const covers = (r: Region, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/**
 * A screen recording made with ffmpeg: a white screen, text typed in the top
 * left from 0.5 s to 2 s, a pause, then a cursor moving across the bottom
 * right from 3.5 s to 5.5 s, and a menu bar clock ticking all the while.
 */
describe.skipIf(!FFMPEG)('finding what matters in a screen recording', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let screen = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-focus-'))
    screen = join(dir, 'screen.mp4')
    // Seven characters typed a quarter second apart, 30 px apart, from (100, 120).
    const typed = Array.from(
      { length: 7 },
      (_, i) => `drawbox=x=${100 + i * 30}:y=120:w=24:h=24:color=black:t=fill:enable='gte(t,${0.5 + i * 0.25})'`
    )
    // A clock in the top right corner that changes every second.
    const clock = Array.from(
      { length: 6 },
      (_, s) => `drawbox=x=1220:y=8:w=${12 + (s % 3) * 8}:h=10:color=gray:t=fill:enable='between(t,${s},${s + 1})'`
    )
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=white:s=1280x720:r=30:d=6',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=16x16:r=30:d=6',
      '-filter_complex',
      `[0:v]${[...typed, ...clock].join(',')}[bg];[bg][1:v]overlay=x='800+(t-3.5)*150':y='500+(t-3.5)*40':enable='between(t,3.5,5.5)'`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      screen
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('moves in on the typing, then on to the cursor, ignoring the clock', async () => {
    const regions = await findFocus(ffmpeg, screen, 0, 6)
    expect(regions.length).toBeGreaterThanOrEqual(2)
    // First, where the typing is, starting as it starts.
    const first = regions[0]
    expect(first.at).toBeGreaterThanOrEqual(0.2)
    expect(first.at).toBeLessThanOrEqual(0.8)
    expect(covers(first, 0.08, 0.18)).toBe(true)
    expect(covers(first, 0.2, 0.18)).toBe(true)
    // Not dragged out to the clock in the far corner.
    expect(first.x + first.w).toBeLessThan(0.6)
    // Then the cursor, wherever it is when the frame gets there.
    const later = regions.filter((r) => r.at >= 3)
    expect(later.length).toBeGreaterThanOrEqual(1)
    const cursorAt = (t: number): [number, number] => [
      (800 + (t - 3.5) * 150 + 8) / 1280,
      (500 + (t - 3.5) * 40 + 8) / 720
    ]
    for (const r of later) {
      const [x, y] = cursorAt(Math.min(5.5, r.at + 0.5))
      expect(
        covers(r, x, y),
        `region at ${r.at.toFixed(2)} s holds the cursor at ${x.toFixed(2)}, ${y.toFixed(2)}`
      ).toBe(true)
    }
    // Nothing between the typing and the cursor moves it: it waits.
    expect(regions.filter((r) => r.at > 2.3 && r.at < 3)).toEqual([])
  })

  it('is followed in the export: the typing fills the frame once the camera gets there', async () => {
    const source = { id: 's1', path: screen, durationSec: 6, width: 1280, height: 720, fps: 30 }
    const doc = createDoc({ id: 'd', title: 'T', source, words: [] })
    const resolved0 = resolveCut(currentCut(doc), doc.words, doc.sources)
    const found = focusSource(resolved0, currentCut(doc), doc.sources, 'b1')!
    const regions = (await findFocus(ffmpeg, found.path, found.ranges[0].startSec, found.ranges[0].durationSec)).map(
      (g) => ({ ...g, at: found.toClock(0, g.at) })
    )
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'camera', beats: ['b1'], move: { kind: 'focus', regions } },
        { op: 'aspect', aspect: 'wide' },
        { op: 'loudness', lufs: null }
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const out = await renderCut(r.cut, resolved, [{ ...source, hasAudio: false }], {
      ffmpeg,
      outputPath: join(dir, 'followed.mp4'),
      workDir: join(dir, 'work'),
      quality: 'preview'
    })
    // Where the typed line lands once the frame has closed in on it, and how dark that band is.
    const plan = cameraPlan(r.cut.beats[0].treatment.camera!, resolved.durationSec, null, 16 / 9, 16 / 9)
    const w = windowAt(viewAt(plan, 1.9), plan.fw, plan.fh)
    const band = { x: (0.1 - w.x) / w.w, y: (0.17 - w.y) / w.h, w: 0.12 / w.w, h: 0.025 / w.h }
    const dark = (t: number): number => 255 - frameColour(ffmpeg, out, t, band).reduce((a, b) => a + b, 0) / 3
    expect(viewAt(plan, 1.9).zoom).toBeGreaterThan(2)
    // The full screen at the start: that part of the frame is blank. Closed in: it is the typed line.
    expect(dark(0.1)).toBeLessThan(20)
    expect(dark(1.9)).toBeGreaterThan(80)
  })

  it('finds nothing to follow in a still screen', async () => {
    const still = join(dir, 'still.mp4')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=white:s=640x360:r=30:d=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      still
    ])
    expect(await findFocus(ffmpeg, still, 0, 3)).toEqual([])
  })
})
