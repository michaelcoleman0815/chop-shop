import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc } from '../shared/edit'
import {
  buildFxScene,
  cutoutsDuring,
  cutoutView,
  programChains,
  runProgram,
  type CutoutTrack,
  type FxFrame,
  type FxStep,
  type Pixels
} from '../shared/fx'
import { renderCut, type RenderSource } from './cut-render'
import { loadMasks, renderCutFx } from './fx-render'
import { makeShapeClip, SHAPE_CLIP, shapeTrack } from './fx-shapes'
import { findFfmpeg } from './test-media'

/**
 * Scene effects, rendered for real.
 *
 * First, the picture work of every effect runs on the same pixels in
 * JavaScript (what the editor's preview shows) and in ffmpeg (what the export
 * writes), and the two must agree to the last bit. Then each effect is
 * exported from footage of simple shapes, with cut-outs of those shapes
 * standing in for Vision's, and the frames are measured: where the scan has
 * not reached is dark or empty, a shockwave bends the picture and then lets
 * it go, the background blurs while the person stays sharp.
 *
 * Set FX_FRAMES_DIR to keep frames and a contact sheet of every render.
 */

const FFMPEG = findFfmpeg()
const KEEP = process.env.FX_FRAMES_DIR

const { width: W, height: H } = SHAPE_CLIP

/** Words across the clip: one every half second. */
const WORDS = wordsFromTranscript(
  ['Here', 'it', 'comes', 'and', 'he', 'lands', 'right', 'there.'].map((text, i) => ({
    text,
    startSec: 0.2 + i * 0.45,
    endSec: 0.5 + i * 0.45
  })),
  's1'
)

function docWith(path: string, ops: unknown[]): { doc: EditDoc; cut: Cut } {
  const source = { id: 's1', path, durationSec: SHAPE_CLIP.sec, width: W, height: H, fps: SHAPE_CLIP.fps }
  const doc = createDoc({ id: 'd', title: 'Shapes', source, words: WORDS })
  // The footage's own size, so frames measure in its pixels and render quickly.
  const r = applyOps(
    currentCut(doc),
    [{ op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }, ...ops],
    { words: doc.words, sources: doc.sources }
  )
  expect(r.rejected).toEqual([])
  return { doc, cut: r.cut }
}

/** A test picture: gradients, a checker and a few hard edges. */
function testPicture(w: number, h: number): Pixels {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 4
      data[k] = Math.round((x * 255) / (w - 1))
      data[k + 1] = Math.round((y * 255) / (h - 1))
      data[k + 2] = ((x >> 4) + (y >> 4)) % 2 ? 210 : 40
      data[k + 3] = 255
    }
  return { data, width: w, height: h }
}

/** RGBA to ffmpeg's planar g, b, r. */
function planes(p: Pixels): Buffer {
  const n = p.width * p.height
  const out = Buffer.alloc(n * 3)
  for (let i = 0; i < n; i++) {
    out[i] = p.data[i * 4 + 1]
    out[n + i] = p.data[i * 4 + 2]
    out[2 * n + i] = p.data[i * 4]
  }
  return out
}

/** A program run by ffmpeg on one picture, with the frame's masks and shift maps as raw gbrp inputs. */
function inFfmpeg(ffmpeg: string, dir: string, program: FxStep[], pic: Pixels, frame: FxFrame, k: number): Pixels {
  const { width: w, height: h } = pic
  const n = w * h
  const raw = (name: string, data: Buffer): string[] => {
    const file = join(dir, name)
    writeFileSync(file, data)
    return ['-f', 'rawvideo', '-pix_fmt', 'gbrp', '-s', `${w}x${h}`, '-i', file]
  }
  const args = [...raw('pic.gbrp', planes(pic))]
  const maskInputs = frame.masks.map((m, i) => {
    const b = Buffer.alloc(n * 3)
    for (let p = 0; p < 3; p++) b.set(m.data, p * n)
    args.push(...raw(`m${i}.gbrp`, b))
    return 1 + i
  })
  const shiftInputs = frame.shifts.map((s, i) => {
    const b = Buffer.alloc(n * 3)
    for (let j = 0; j < n; j++) {
      b[j] = 128 + s.dy[j]
      b[n + j] = 128
      b[2 * n + j] = 128 + s.dx[j]
    }
    args.push(...raw(`s${i}.gbrp`, b))
    return 1 + frame.masks.length + i
  })
  const chains = ['[0:v]format=gbrp[t_pic]']
  const out = programChains(program, 't', maskInputs, shiftInputs, k, chains)
  const got = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      ...args,
      '-filter_complex',
      chains.join(';'),
      '-map',
      `[${out}]`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gbrp',
      '-'
    ],
    { maxBuffer: 1 << 28 }
  )
  const px = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    px[i * 4] = got[2 * n + i]
    px[i * 4 + 1] = got[i]
    px[i * 4 + 2] = got[n + i]
    px[i * 4 + 3] = 255
  }
  return { data: px, width: w, height: h }
}

function differences(a: Pixels, b: Pixels): { count: number; worst: number } {
  let count = 0
  let worst = 0
  for (let i = 0; i < a.data.length; i++) {
    if ((i & 3) === 3) continue
    const d = Math.abs(a.data[i] - b.data[i])
    if (d) {
      count++
      worst = Math.max(worst, d)
    }
  }
  return { count, worst }
}

describe.skipIf(!FFMPEG)('the picture work is the same in the preview and the export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let tracks: CutoutTrack[] = []
  const path = '/shapes.mp4'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-fx-twins-'))
    tracks = [shapeTrack(path, 'person', join(dir, 'person')), shapeTrack(path, 'objects', join(dir, 'objects'))]
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const cases: { name: string; fx: Record<string, unknown>; at: number; wide?: boolean }[] = [
    { name: 'a scan over the whole frame, dimming what it has not reached', fx: { kind: 'scan', from: 'w1', on: 'frame' }, at: 0.55 },
    { name: 'a scan bringing objects in, filling them from around them', fx: { kind: 'scan', from: 'w1', on: 'objects' }, at: 0.6, wide: true },
    { name: 'a scan bringing the person in', fx: { kind: 'scan', from: 'w1', on: 'subject', style: 'down' }, at: 0.5, wide: true },
    {
      name: 'an impact bending the picture and shaking it',
      fx: { kind: 'impact', from: 'w6', at: [0.5, 0.5], extra: ['second-ring', 'streaks'] },
      at: 2.6
    },
    { name: 'a speed blur behind the person', fx: { kind: 'bgblur', from: 'w2', style: 'motion' }, at: 1.1, wide: true },
    { name: 'a soft blur around the middle, with no cut-out', fx: { kind: 'bgblur', from: 'w2', style: 'soft', on: 'frame' }, at: 1.1 }
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const { doc, cut } = docWith(path, [{ op: 'fx-add', ...c.fx }])
      const resolved = resolveCut(cut, doc.words, doc.sources)
      const size = { width: W, height: H }
      const scene = buildFxScene({
        cut,
        resolved,
        words: doc.words,
        sources: doc.sources,
        size,
        fps: 30,
        cutouts: (a, b) => cutoutsDuring(cut, resolved, doc.sources, tracks, a, b)
      })
      expect(scene.hidden).toEqual([])
      const plan = scene.plans[0]
      expect(plan.program.length).toBeGreaterThan(0)
      // A smaller working size than the design, as the preview has: everything scales.
      const w = 180
      const h = 320
      const view = cutoutView({ cut, resolved, sources: doc.sources, frame: size, tracks, loaded: await loadMasks(tracks) })
      const frame = plan.frame(c.at, w, h, view)
      const pic = testPicture(w, h)
      const js = runProgram(plan.program, pic, frame, w / W)
      const ff = inFfmpeg(ffmpeg, dir, plan.program, pic, frame, w / W)
      // The program did something, and both did the same thing: to the bit, but for a wide blur's last
      // rounding, where ffmpeg's x86 build fuses a multiply and an add (fx/pixels): one level, rarely.
      expect(differences(js, pic).count).toBeGreaterThan(50)
      const d = differences(js, ff)
      expect(d.worst).toBeLessThanOrEqual(1)
      expect(d.count).toBeLessThanOrEqual(Math.ceil(js.data.length * 0.0001))
      if (!c.wide) expect(d).toEqual({ count: 0, worst: 0 })
    })
  }
})

describe.skipIf(!FFMPEG)('scene effects, exported', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let clip = ''
  let tracks: CutoutTrack[] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-fx-'))
    clip = makeShapeClip(ffmpeg, join(dir, 'shapes.mp4'))
    tracks = [shapeTrack(clip, 'person', join(dir, 'person')), shapeTrack(clip, 'objects', join(dir, 'objects'))]
    if (KEEP) mkdirSync(KEEP, { recursive: true })
  }, 120_000)
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const render = async (name: string, ops: unknown[], withTracks = true): Promise<{ out: string; doc: EditDoc; cut: Cut }> => {
    const { doc, cut } = docWith(clip, ops)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources: RenderSource[] = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const fx = await renderCutFx({
      cut,
      resolved,
      words: doc.words,
      sources: doc.sources,
      quality: 'final',
      ffmpeg,
      workDir: join(dir, `fx-${name}`),
      tracks: withTracks ? tracks : []
    })
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      fx
    })
    if (KEEP) sheet(ffmpeg, out, join(KEEP, `${name}.png`))
    return { out, doc, cut }
  }

  /** The frame at t as RGB bytes, at the output's size. */
  const frameAt = (path: string, t: number): Buffer =>
    execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { maxBuffer: 1 << 26 }
    )
  /** Mean brightness of a region, as fractions of the frame. */
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
  /** How much a region changes from pixel to pixel across: sharp detail is high, a speed blur low. */
  const detail = (rgb: Buffer, r: { x: number; y: number; w: number; h: number }): number => {
    let sum = 0
    let n = 0
    for (let y = Math.round(r.y * H); y < Math.round((r.y + r.h) * H); y++)
      for (let x = Math.round(r.x * W); x < Math.round((r.x + r.w) * W) - 1; x++) {
        const k = (y * W + x) * 3
        sum += Math.abs(rgb[k] - rgb[k + 3]) + Math.abs(rgb[k + 1] - rgb[k + 4])
        n++
      }
    return sum / Math.max(1, n)
  }
  const diff = (a: Buffer, b: Buffer): number => {
    let s = 0
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
    return s / a.length
  }

  let plain = ''
  it('renders the clip without effects, to measure against', async () => {
    plain = (await render('plain', [])).out
    expect(brightness(frameAt(plain, 0.6), { x: 0, y: 0, w: 1, h: 0.3 })).toBeGreaterThan(40)
  }, 120_000)

  it('scans the whole frame in from dark, upward, with a glowing edge, and leaves it as it was', async () => {
    const { out } = await render('scan-frame', [{ op: 'fx-add', kind: 'scan', from: 'w1', on: 'frame' }], false)
    // w1 is said at 0.2 s; the scan starts a tenth before and sweeps up over about a second, quickest in the middle.
    const early = frameAt(out, 0.6)
    const before = frameAt(plain, 0.6)
    // The top has not been reached: dark. The bottom has: as it was.
    expect(brightness(early, { x: 0, y: 0, w: 1, h: 0.2 })).toBeLessThan(0.45 * brightness(before, { x: 0, y: 0, w: 1, h: 0.2 }))
    expect(Math.abs(brightness(early, { x: 0, y: 0.85, w: 1, h: 0.15 }) - brightness(before, { x: 0, y: 0.85, w: 1, h: 0.15 }))).toBeLessThan(6)
    // After the effect, the picture is the plain render's.
    expect(diff(frameAt(out, 2.4), frameAt(plain, 2.4))).toBeLessThan(1)
  }, 120_000)

  it('brings the objects in one by one, each filled from around it until the scan reaches it', async () => {
    const { out } = await render('scan-objects', [{ op: 'fx-add', kind: 'scan', from: 'w1', on: 'objects', color: 'caribbean' }])
    const square = { x: 0.16, y: 0.27, w: 0.12, h: 0.06 }
    const diamond = { x: 0.66, y: 0.865, w: 0.08, h: 0.03 }
    // Upward: the diamond, lowest, comes in first; the square, highest, last.
    const t = 0.5
    const now = frameAt(out, t)
    const was = frameAt(plain, t)
    const red = (rgb: Buffer, r: typeof square): number => {
      let sum = 0
      let n = 0
      for (let y = Math.round(r.y * H); y < Math.round((r.y + r.h) * H); y++)
        for (let x = Math.round(r.x * W); x < Math.round((r.x + r.w) * W); x++) {
          sum += rgb[(y * W + x) * 3] - rgb[(y * W + x) * 3 + 2]
          n++
        }
      return sum / n
    }
    // The red square is not there yet: its place shows the ground around it.
    expect(red(was, square)).toBeGreaterThan(120)
    expect(red(now, square)).toBeLessThan(60)
    // Later every object is back.
    const end = frameAt(out, 1.75)
    expect(red(end, square)).toBeGreaterThan(110)
    expect(brightness(end, diamond)).toBeGreaterThan(120)
  }, 120_000)

  it('sends a shockwave through the picture on the word, shakes it, and lets it go', async () => {
    const { out } = await render('impact', [
      { op: 'fx-add', kind: 'impact', from: 'w6', at: [0.5, 0.45], extra: ['second-ring', 'flash'] }
    ])
    // w6 lands at 2.45 s.
    expect(diff(frameAt(out, 2.3), frameAt(plain, 2.3))).toBeLessThan(1)
    expect(diff(frameAt(out, 2.62), frameAt(plain, 2.62))).toBeGreaterThan(4)
    expect(diff(frameAt(out, 3.5), frameAt(plain, 3.5))).toBeLessThan(1)
  }, 120_000)

  it('grades the picture an effect worked on, when a LUT is on too', async () => {
    // A LUT that leaves every colour as it is: the frames must be the effect's own.
    const lut = join(dir, 'same.cube')
    writeFileSync(lut, ['LUT_1D_SIZE 2', '0 0 0', '1 1 1', ''].join('\n'))
    const scan = [{ op: 'fx-add', kind: 'scan', from: 'w1', on: 'frame' }]
    const { out } = await render('scan-lut', [...scan, { op: 'look', set: { lut: { path: lut, strength: 1 } } }], false)
    const bare = (await render('scan-bare', scan, false)).out
    const top = { x: 0, y: 0, w: 1, h: 0.2 }
    // Still dark where the scan has not reached, as without the LUT.
    expect(Math.abs(brightness(frameAt(out, 0.6), top) - brightness(frameAt(bare, 0.6), top))).toBeLessThan(3)
    expect(brightness(frameAt(out, 0.6), top)).toBeLessThan(0.45 * brightness(frameAt(plain, 0.6), top))
  }, 180_000)

  it('rushes speed lines past a clear middle', async () => {
    const { out } = await render('speedlines', [{ op: 'fx-add', kind: 'speedlines', from: 'w2', to: 'w5' }])
    const now = frameAt(out, 1.2)
    const was = frameAt(plain, 1.2)
    // The corners brighten with white lines; the middle is left alone.
    const corners = brightness(now, { x: 0, y: 0, w: 0.25, h: 0.15 }) - brightness(was, { x: 0, y: 0, w: 0.25, h: 0.15 })
    const middle = Math.abs(brightness(now, { x: 0.35, y: 0.35, w: 0.3, h: 0.2 }) - brightness(was, { x: 0.35, y: 0.35, w: 0.3, h: 0.2 }))
    expect(corners).toBeGreaterThan(8)
    expect(middle).toBeLessThan(2)
  }, 120_000)

  it('blurs the background behind the person while they stay sharp, and without a cut-out keeps the middle sharp', async () => {
    const { out } = await render('bgblur', [{ op: 'fx-add', kind: 'bgblur', from: 'w2', to: 'w6', style: 'motion' }])
    const now = frameAt(out, 1.3)
    const was = frameAt(plain, 1.3)
    const ground = { x: 0.02, y: 0.02, w: 0.3, h: 0.12 }
    const person = { x: 0.42, y: 0.5, w: 0.16, h: 0.2 }
    expect(detail(now, ground)).toBeLessThan(0.6 * detail(was, ground))
    // The person's edge is still crisp: across their middle, the step from ground to person is kept.
    const edge = { x: 0.28, y: 0.6, w: 0.12, h: 0.04 }
    expect(detail(now, edge)).toBeGreaterThan(0.7 * detail(was, edge))
    expect(Math.abs(brightness(now, person) - brightness(was, person))).toBeLessThan(4)

    const region = await render('bgblur-region', [{ op: 'fx-add', kind: 'bgblur', from: 'w2', to: 'w6' }], false)
    const r = frameAt(region.out, 1.3)
    // The encoder's own noise, added after the blur, keeps some detail on footage this small.
    expect(detail(r, ground)).toBeLessThan(0.8 * detail(was, ground))
    expect(Math.abs(brightness(r, person) - brightness(was, person))).toBeLessThan(4)
  }, 120_000)
})

/** A contact sheet of a render: a frame every tenth of a second over its first 3.2 s. */
function sheet(ffmpeg: string, path: string, out: string): void {
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    path,
    '-vf',
    'fps=10,scale=180:-2,tile=8x4:padding=2',
    '-frames:v',
    '1',
    out
  ])
}
