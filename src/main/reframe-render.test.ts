import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Op
} from '../shared/edit'
import { renderCut } from './cut-render'
import { findFfmpeg, gradientWindow, makeClip, makeGradientStill } from './test-media'

const FFMPEG = findFfmpeg()

/** A bright box, the "speaker", walking across a dark wide picture: its centre at this share of the width at t. */
const boxAt = (t: number): number => (126 + 48 * t) / 640

const SAID = [0, 1, 2].flatMap((k) =>
  ['One', 'two', 'three.'].map((text, i) => ({
    text,
    startSec: 0.4 + k * 2.4 + i * 0.5,
    endSec: 0.8 + k * 2.4 + i * 0.5
  }))
)

/** Where the bright box is across an output frame, as a share of its width; null when it is out of the frame. */
function boxIn(ffmpeg: string, path: string, frame: number): number | null {
  const raw = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      path,
      '-vf',
      `select=eq(n\\,${frame}),scale=60:-2,format=gray`,
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1 << 20 }
  )
  const width = 60
  let sum = 0
  let n = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] > 128) {
      sum += i % width
      n++
    }
  }
  return n > 4 ? (sum / n + 0.5) / width : null
}

describe.skipIf(!FFMPEG)('following the speaker into a vertical frame', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-reframe-'))
    const path = makeClip(
      ffmpeg,
      join(dir, 'walk.mp4'),
      `color=black:s=640x360:r=30:d=8,format=gray,geq=lum='if(between(X,96+48*T,156+48*T)*between(Y,130,230),235,32)'`,
      null
    )
    // The speaker as face finding would report them, twice a second.
    const subject = { hz: 2, x: Array.from({ length: 16 }, (_, i) => Math.round(boxAt(i / 2) * 1e4) / 1e4) }
    const source = { id: 's1', path, durationSec: 8, width: 640, height: 360, fps: 30, subject }
    doc = createDoc({ id: 'd', title: 'Walk', source, words: wordsFromTranscript(SAID, 's1') })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const render = async (ops: Op[], name: string, d = doc): Promise<{ out: string; cut: Cut }> => {
    const r = applyOps(
      currentCut(d),
      [
        { op: 'aspect', aspect: 'vertical' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null },
        ...ops
      ],
      d
    )
    expect(r.rejected).toEqual([])
    const out = await renderCut(
      r.cut,
      resolveCut(r.cut, d.words, d.sources),
      d.sources.map((s) => ({ ...s, hasAudio: false })),
      {
        ffmpeg,
        outputPath: join(dir, `${name}.mp4`),
        workDir: join(dir, `work-${name}`),
        quality: 'preview'
      }
    )
    return { out, cut: r.cut }
  }

  it('keeps the speaker in the frame as they walk across, where the middle loses them', async () => {
    const middle = await render([], 'middle')
    const { out, cut } = await render([{ op: 'reframe', on: true }], 'follow')
    const resolved = resolveCut(cut, doc.words, doc.sources)
    let seen = 0
    for (const p of resolved.pieces) {
      for (const f of [0.2, 0.5, 0.8].map((k) => Math.round((p.outStart + (p.outEnd - p.outStart) * k) * 30))) {
        const x = boxIn(ffmpeg, out, f)
        // Always in the frame, and near its middle: within the dead zone and a glide of it.
        expect(x, `frame ${f}`).not.toBeNull()
        expect(Math.abs((x as number) - 0.5), `frame ${f}`).toBeLessThan(0.3)
        seen++
      }
    }
    expect(seen).toBeGreaterThanOrEqual(9)
    // Kept in the middle, the speaker is out of the frame at the start, and at its edge by the end.
    const first = Math.round((resolved.pieces[0].outStart + 0.1) * 30)
    const last = Math.round((resolved.durationSec - 0.2) * 30)
    for (const f of [first, last]) {
      const x = boxIn(ffmpeg, middle.out, f)
      expect(x === null || Math.abs(x - 0.5) > 0.4, `frame ${f}: ${x}`).toBe(true)
    }
  })

  it('frames a beat by hand: its left edge in the frame, over whatever following would do', async () => {
    const still = makeGradientStill(ffmpeg, join(dir, 'gradient.png'), '640x360')
    const gradient: EditDoc = { ...doc, sources: doc.sources.map((s) => ({ ...s, path: still })) }
    const { out, cut } = await render(
      [
        { op: 'reframe', on: true },
        { op: 'framing', beats: ['b2'], x: 0 }
      ],
      'by-hand',
      gradient
    )
    const resolved = resolveCut(cut, gradient.words, gradient.sources)
    const b2 = resolved.beats.find((b) => b.id === 'b2')!
    const w = gradientWindow(ffmpeg, out, (b2.outStart + b2.outEnd) / 2)
    // The window is 0.316 of the picture wide; at the left edge it runs from 0 to there.
    expect(w.left).toBeLessThan(0.03)
    expect(Math.abs(w.right - 0.3164)).toBeLessThan(0.03)
  })
})
