import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type Op } from '../shared/edit'
import { num } from '../shared/anim'
import { timelineFor } from '../shared/motion'
import { trackLayers, tracksOf, type TrackClip } from '../shared/tracks'
import { followClips, followPathOf, followPlannedClips } from './clip-follow'
import { ROTO_GUIDE } from './roto-guide'
import type { PlanEditResult } from './planner'
import { ffmpegRun, findFfmpeg } from './test-media'
import { readTracked, trackObject, type TrackedObject } from './track'

/**
 * Following with scale: the Vision helper's --track answer read whether it
 * measured sizes or not; a clip and a mask that ask to follow given their
 * paths, by the planner and by the editor; a followed clip's keys moving and
 * growing with the object; and, on a Mac with the helper built, the helper
 * itself measuring an object that grows as it nears.
 */

describe('the helper’s answer to --track', () => {
  it('reads an answer from before sizes were measured: no scale, lost frames with no box or null', () => {
    const old = JSON.stringify({
      found: 'salient',
      start: [0.4, 0.4, 0.1, 0.1],
      width: 960,
      height: 540,
      samples: [{ t: 0, box: [0.4, 0.4, 0.1, 0.1], c: 1 }, { t: 0.1, c: 0.1 }, { t: 0.2, box: null, c: 0 }]
    })
    const r = readTracked(old) as TrackedObject
    expect(r.found).toBe('salient')
    expect(r.sized).toBeUndefined()
    expect(r.samples).toEqual([
      { t: 0, box: [0.4, 0.4, 0.1, 0.1], c: 1 },
      { t: 0.1, box: null, c: 0.1 },
      { t: 0.2, box: null, c: 0 }
    ])
    expect(r).toMatchObject({ width: 960, height: 540 })
  })

  it('reads one that measured sizes: sized, and each box’s scale', () => {
    const fresh = JSON.stringify({
      found: 'given',
      start: [0.4, 0.4, 0.1, 0.1],
      width: 640,
      height: 360,
      sized: true,
      samples: [{ t: 0, box: [0.4, 0.4, 0.1, 0.1], c: 1, s: 1 }, { t: 0.5, box: [0.375, 0.375, 0.15, 0.15], c: 0.9, s: 1.5 }, { t: 1, c: 0.2 }]
    })
    const r = readTracked(fresh) as TrackedObject
    expect(r.sized).toBe(true)
    expect(r.samples[1]).toEqual({ t: 0.5, box: [0.375, 0.375, 0.15, 0.15], c: 0.9, s: 1.5 })
    expect(r.samples[2]).toEqual({ t: 1, box: null, c: 0.2 })
    expect(readTracked('not json')).toBeNull()
    expect(readTracked('{"found":"given"}')).toBeNull()
  })
})

describe('following, from a request to a path to the keys', () => {
  const words = wordsFromTranscript(
    ['Here', 'is', 'the', 'phone', 'I', 'use', 'every', 'day'].map((text, i) => ({ text, startSec: 0.2 + i * 0.5, endSec: 0.6 + i * 0.5 })),
    's1'
  )
  const source = { id: 's1', path: '/footage/a.mp4', durationSec: 5, width: 1920, height: 1080, fps: 30 }
  const doc = createDoc({ id: 'd', title: 't', source, words })
  const ctx = { words: doc.words, sources: doc.sources, assets: doc.assets }
  const run = (ops: unknown[], cut: Cut = currentCut(doc)): Cut => {
    const r = applyOps(cut, ops, ctx)
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const clipOf = (cut: Cut, id: string): TrackClip => tracksOf(cut).flatMap((t) => t.clips).find((c) => c.id === id) as TrackClip
  // An object in the middle of the picture that doubles in size over two seconds.
  const growing: TrackedObject = {
    found: 'hand',
    sized: true,
    samples: Array.from({ length: 25 }, (_, i) => {
      const t = i / 12
      const w = 0.1 * (1 + Math.min(2, t) / 2)
      return { t, box: [0.5 - w / 2, 0.5 - w / 2, w, w] as [number, number, number, number], c: 0.9 }
    })
  }
  const calls: { file: string; start: number; duration: number; box?: number[] }[] = []
  const track = async (file: string, start: number, duration: number, _rate?: number, box?: [number, number, number, number]): Promise<TrackedObject> => {
    calls.push({ file, start, duration, box })
    return growing
  }

  it('gives a clip asked to follow its path, and its layer moves and grows with the object', async () => {
    calls.length = 0
    const asked = run([{ op: 'clip-add', kind: 'text', text: { value: 'LOOK' }, from: 'w2', to: '2s', follow: { scale: true } }])
    const { ops, said } = await followClips(asked, doc, track)
    expect(said).toBe('')
    expect(ops).toHaveLength(1)
    // It follows in the recording on screen, from the moment the clip starts.
    expect(calls[0].file).toBe('/footage/a.mp4')
    expect(calls[0].start).toBeCloseTo(0.7, 1)
    const cut = run(ops, asked)
    const path = clipOf(cut, 'c1').follow?.path
    expect(path).toMatchObject({ source: 's1', sized: true })
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const layers = trackLayers(cut, timelineFor(cut, resolved, doc.words), { width: 1920, height: 1080 }, undefined, {
      cut,
      resolved,
      pictures: doc.sources
    })
    const tf = layers[0].transform
    // It starts where it was put, the frame's middle, and grows with the object to about twice its size.
    expect(num(tf?.x, 0, 2)).toBeCloseTo(960, 0)
    expect(num(tf?.scale, 0, 2)).toBeCloseTo(1, 2)
    expect(num(tf?.scale, 1, 2)).toBeCloseTo(1.5, 1)
    expect(num(tf?.scale, 2, 2)).toBeCloseTo(2, 1)
  })

  it('does not grow a clip whose path was followed by a helper that kept one size', async () => {
    const asked = run([{ op: 'clip-add', kind: 'solid', color: '#000000', from: 'w2', to: '2s', follow: { scale: true } }])
    const { ops } = await followClips(asked, doc, async () => ({ ...growing, sized: undefined }))
    const cut = run(ops, asked)
    expect(clipOf(cut, 'c1').follow?.path?.sized).toBe(false)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const layers = trackLayers(cut, timelineFor(cut, resolved, doc.words), { width: 1920, height: 1080 }, undefined, { cut, resolved, pictures: doc.sources })
    expect(num(layers[0].transform?.scale, 2, 2)).toBeCloseTo(1, 3)
  })

  it('follows what a mask covers, from where it is as its clip starts', async () => {
    calls.length = 0
    const asked = run([
      { op: 'clip-add', kind: 'solid', color: '#000000', from: 'w2', to: '2s', masks: [{ ellipse: [860, 440, 200, 200], follow: { scale: true } }] }
    ])
    const { ops } = await followClips(asked, doc, track)
    // The oval in the frame, as shares of the recording's picture, which fills it.
    expect(calls[0].box?.map((v) => Math.round(v * 1000) / 1000)).toEqual([0.448, 0.407, 0.104, 0.185])
    const cut = run(ops, asked)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const layers = trackLayers(cut, timelineFor(cut, resolved, doc.words), { width: 1920, height: 1080 }, undefined, { cut, resolved, pictures: doc.sources })
    const mt = layers[0].masks?.[0].transform
    expect(num(mt?.scale, 0, 2)).toBeCloseTo(1, 2)
    expect(num(mt?.scale, 2, 2)).toBeCloseTo(2, 1)
    // Around the object's middle, which is the frame's.
    expect(num(mt?.x, 1, 2)).toBeCloseTo(960, 0)
  })

  it('makes a path from the helper’s samples, a box every twelfth of a second', () => {
    const path = followPathOf({ clip: 'c1', mask: null, file: '/x.mp4', source: 's1', start: 2, duration: 1 }, growing)
    expect(path).toMatchObject({ source: 's1', at: 2, sized: true })
    expect(path?.boxes).toHaveLength(13)
    expect(followPathOf({ clip: 'c1', mask: null, file: '/x.mp4', source: 's1', start: 2, duration: 1 }, { found: 'given', samples: [] })).toBeNull()
  })

  it('follows what a plan asks to as it is offered, and says so when there is no Vision', async () => {
    const op = { op: 'clip-add', kind: 'text', text: { value: 'LOOK' }, from: 'w2', to: '2s', follow: { scale: true } } as unknown as Op
    const offered: PlanEditResult = {
      ok: true,
      ops: [op],
      steps: [{ ops: [op] }],
      question: null,
      summary: '',
      reply: '',
      notesHandled: [],
      needs: [],
      rejected: [],
      brollWanted: []
    }
    const followed = await followPlannedClips(doc, offered, track)
    if (!followed.ok) throw new Error('not ok')
    expect(followed.ops).toHaveLength(2)
    expect(followed.steps).toHaveLength(2)
    expect((followed.ops[1] as { follow?: { path?: unknown } }).follow?.path).toBeTruthy()
    const without = await followPlannedClips(doc, offered, async () => {
      throw new Error('Following an object needs the Mac’s Vision.')
    })
    if (!without.ok) throw new Error('not ok')
    expect(without.ops).toHaveLength(1)
    expect(without.rejected).toEqual(['Following something in the picture needs Cutalong on a Mac, so it stays where it is put.'])
  })
})

describe('the mattes guide', () => {
  const doc = createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/a.mp4', durationSec: 3, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript([{ text: 'Hello', startSec: 0.2, endSec: 0.6 }], 's1')
  })
  const cut = currentCut(doc)

  it('comes with an ask for masks, mattes, keys or following, or a cut that has them, and not with an everyday one', () => {
    for (const ask of ['rotoscope my hand', 'put the title behind me', 'cut me out', 'key out the green screen', 'mask the logo', 'track the phone', 'make it follow the cup', 'add a chroma key'])
      expect(ROTO_GUIDE.wanted(ask, cut), ask).toBe(true)
    for (const ask of [
      'make this an 8 minute review, start with the strongest line, cut the rambling, captions, upbeat music, chapters, and B-roll of the phone when I mention it',
      'add a music track under the intro',
      'put it on a new track'
    ])
      expect(ROTO_GUIDE.wanted(ask, cut), ask).toBe(false)
    const masked = applyOps(cut, [{ op: 'clip-add', kind: 'solid', color: '#000000', from: 'w1', masks: [{ ellipse: [0, 0, 10, 10] }] }], doc).cut
    expect(ROTO_GUIDE.wanted('make it warmer', masked)).toBe(true)
    expect(ROTO_GUIDE.index.length).toBeLessThan(400)
  })
})

const FFMPEG = findFfmpeg()
const VISION = process.platform === 'darwin' && existsSync(join(process.cwd(), 'resources', 'bin', 'chopshop-vision'))

describe.skipIf(!FFMPEG || !VISION)('the Mac’s helper measuring a growing object', () => {
  let dir = ''
  let clip = ''
  // A patterned card in the middle of a plain room, 80 px across, growing by 60 px a second.
  const size = (t: number): number => 80 + 60 * t

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-grow-'))
    clip = join(dir, 'grow.mp4')
    ffmpegRun(FFMPEG as string, [
      '-f',
      'lavfi',
      '-i',
      'color=c=0x406080:s=640x360:d=3:r=30',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x160:d=3:r=30',
      '-filter_complex',
      "[1:v]scale=w='80+t*60':h='80+t*60':eval=frame[o];[0:v][o]overlay=x='320-overlay_w/2':y='180-overlay_h/2':eval=frame,format=yuv420p",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      clip
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reports the box growing with it, and its scale, where Vision’s tracker alone would keep the first size', async () => {
    const r = await trackObject(clip, 0, 2.5, 6, [0.4375, 0.3889, 0.125, 0.2222])
    expect(r.sized).toBe(true)
    const seen = r.samples.filter((s) => s.box)
    expect(seen.length).toBeGreaterThanOrEqual(r.samples.length * 0.9)
    for (const s of seen.filter((x) => x.t >= 1)) {
      const want = size(s.t) / 80
      expect(s.s, `at ${s.t.toFixed(2)}s`).toBeGreaterThan(want * 0.88)
      expect(s.s, `at ${s.t.toFixed(2)}s`).toBeLessThan(want * 1.12)
      // Its middle stays the card's.
      expect(s.box![0] + s.box![2] / 2).toBeCloseTo(0.5, 1)
    }
  }, 90_000)
})
