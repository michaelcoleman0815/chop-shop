import { describe, expect, it } from 'vitest'
import { snapWords, type Envelope } from '../audio/snap'
import {
  createDoc,
  currentCut,
  EditDocSchema,
  resolveCut,
  wordsFromTranscript,
  type EditDoc,
  type Source,
  type Word
} from '../edit'
import { analyseMouth, mouthForNiche, mouthNotice, setMouthMode, setMouthModeAll, type MouthResult } from './analyse'
import { cutInAt, cutOutAt } from './cuts'
import { boxAt, linkFaces, planCrops, sendcmdScript, type CropPlan, type CropSlot, type FaceSample } from './faces'
import { retakeHints } from './hints'
import { MouthMeter, type RawMouth } from './meter'
import { MOUTH_BY_NICHE, mouthModeFor, neverWatches, nicheFrom, nicheKey, readMouthMode, type MouthMode } from './mode'
import { heardFrom, shiftEnvelope, shiftWords, syncNotice } from './offset'
import { PROFILES } from '../raw/profiles'
import { offCameraLine } from './speakers'
import { detections, envelopeOf, makeRenderer, take, tilesFor, voiceSamples, type Take } from './synthetic'

const FPS = 30
const RATE = 16000

/** The whole crop pass done in JS: render each frame, cut its tiles, measure them. */
function measureInJs(t: Take, faces: FaceSample[] = detections(t.scene, 4)): RawMouth {
  const { scene } = t
  const plan = planCrops(linkFaces(faces), { width: scene.width, height: scene.height, fps: scene.fps })
  const meter = new MouthMeter(plan, scene.fps, Math.ceil(t.durationSec * scene.fps))
  if (plan.slots.length === 0) return meter.finish()
  const render = makeRenderer(scene)
  const frame = new Uint8Array(scene.width * scene.height)
  const row = new Uint8Array(meter.bytesPerFrame)
  const n = Math.round(t.durationSec * scene.fps)
  for (let i = 0; i < n; i++) {
    const time = i / scene.fps
    render(time, frame)
    meter.push(time, tilesFor(frame, scene, plan, time, row))
  }
  return meter.finish()
}

/** What transcription hands over: loose word times on the sound's clock, then snapped to the sound. */
function transcribed(t: Take, env: Envelope, offsetSec: number): Word[] {
  const loose = t.words.map((w, i) => ({
    text: w.text,
    startSec: Math.max(0, w.onsetSec + offsetSec - 0.09),
    endSec: w.endSec + offsetSec + 0.11,
    i
  }))
  const offWords = t.offCamera.map(([a, b], k) => ({
    text: `q${k + 1}`,
    startSec: a + offsetSec,
    endSec: b + offsetSec
  }))
  return snapWords(wordsFromTranscript([...loose, ...offWords], 's1'), env)
}

const sourceFor = (t: Take): Source => ({
  id: 's1',
  path: '/footage/take.mov',
  durationSec: t.durationSec,
  width: t.scene.width,
  height: t.scene.height,
  fps: t.scene.fps
})

interface Run {
  take: Take
  env: Envelope
  words: Word[]
  result: MouthResult
}

const runs = new Map<string, Run>()
function run(name: string, t: Take, offsetSec = 0, mode?: MouthMode): Run {
  const hit = runs.get(name)
  if (hit) return hit
  const env = envelopeOf(voiceSamples(t.lines, RATE, t.durationSec, offsetSec), RATE)
  const words = transcribed(t, env, offsetSec)
  const result = analyseMouth({ raw: measureInJs(t), words, envelope: env, source: sourceFor(t), mode })
  const r = { take: t, env, words, result }
  runs.set(name, r)
  return r
}

/** The truth for word i: the last frame before its mouth moves, and the first after it settles. */
const restFrame = (t: Take, i: number): number => Math.floor(t.words[i].openSec * FPS + 1e-9)
const settleFrame = (t: Take, i: number): number => Math.ceil(t.words[i].settleSec * FPS - 1e-9)

describe('mouth watching by niche', () => {
  it('times cuts to the mouth for talking to camera, and lines up the sound where lips matter', () => {
    expect(MOUTH_BY_NICHE['tech-review'].mouth).toBe('cuts+sync')
    expect(MOUTH_BY_NICHE['talking-head'].mouth).toBe('cuts+sync')
    expect(MOUTH_BY_NICHE.podcast.mouth).toBe('cuts+sync')
    expect(MOUTH_BY_NICHE.music.mouth).toBe('sync')
    expect(MOUTH_BY_NICHE.asmr.mouth).toBe('sync')
    expect(MOUTH_BY_NICHE.sports.mouth).toBe('off')
    expect(neverWatches('dj-set')).toBe(true)
    expect(neverWatches('vlog')).toBe(false)
  })

  it('reads the face size where the niche depends on it', () => {
    const small = { widthPx: 70, widthShare: 0.04 }
    const big = { widthPx: 320, widthShare: 0.25 }
    expect(mouthModeFor('gaming-facecam', small)).toBe('sync')
    expect(mouthModeFor('gaming-facecam', big)).toBe('cuts+sync')
    expect(mouthModeFor('vlog', small)).toBe('off')
    expect(mouthModeFor('vlog', big)).toBe('sync')
    expect(mouthModeFor('cooking', big)).toBe('sync')
    expect(mouthModeFor(null, big)).toBe('cuts+sync')
  })

  it('knows a niche from how people describe it', () => {
    expect(nicheKey('Tech reviews')).toBe('tech-review')
    expect(nicheKey('sermon clips')).toBe('sermon')
    expect(nicheKey('ASMR')).toBe('asmr')
    expect(nicheKey('podcast')).toBe('podcast')
    expect(nicheKey('something new')).toBeNull()
    expect(nicheFrom({ niche: 'gaming' })).toBe('gaming')
    expect(nicheFrom({ name: 'x' })).toBeNull()
    expect(nicheFrom({ niche: '' })).toBeNull()
  })

  it('reads every cutting profile, and the kinds not built as profiles yet, as a niche', () => {
    // The brand's niche and an edit's profile are cutting profile ids.
    const read = Object.fromEntries(PROFILES.map((p) => [p.id, nicheKey(p.id)]))
    expect(read).toEqual({
      'talking-head': 'talking-head',
      tech: 'tech-review',
      podcast: 'podcast',
      gaming: 'gaming-facecam',
      livestream: 'gaming-facecam',
      church: 'sermon',
      // A vlog's talking is watched as a vlog's always was: by how big the face is.
      vlog: 'vlog',
      asmr: 'asmr'
    })
    // What "this one is a ... video" names when there is no profile for it yet.
    expect(['cooking', 'wedding', 'vlog', 'workout', 'makeup', 'reaction', 'sports'].map(nicheKey)).toEqual([
      'cooking',
      'events-weddings',
      'vlog',
      'fitness',
      'beauty',
      'reaction-commentary',
      'sports'
    ])
  })

  it('takes a sentence that sets it, and leaves every other request to the planner', () => {
    expect(readMouthMode('Time my cuts to the sound only')).toBe('sync')
    expect(readMouthMode("don't cut on my mouth")).toBe('sync')
    expect(readMouthMode('Stop watching my mouth')).toBe('off')
    expect(readMouthMode('leave the audio as recorded')).toBe('off')
    expect(readMouthMode('time the cuts to my mouth', 'sync')).toBe('cuts+sync')
    // Lining up the sound turns the sync on without touching cut timing.
    expect(readMouthMode('line up my audio', 'off')).toBe('sync')
    expect(readMouthMode('line up my audio', 'cuts+sync')).toBe('cuts+sync')
    for (const other of [
      'remove the part about lip sync',
      'cut the line where I say sync',
      'make it snappy',
      'tighten the pauses'
    ]) {
      expect(readMouthMode(other)).toBeNull()
    }
  })
})

describe('faces over time', () => {
  it('keeps one track per person, and starts one for a face that enters', () => {
    const samples: FaceSample[] = []
    for (let t = 0; t < 6; t += 0.25) {
      const faces = [{ x: 0.2 + 0.005 * Math.sin(t), y: 0.3, w: 0.2, h: 0.35 }]
      if (t >= 2.5) faces.push({ x: 0.62, y: 0.32, w: 0.18, h: 0.32 })
      samples.push({ t, faces })
    }
    const tracks = linkFaces(samples)
    expect(tracks).toHaveLength(2)
    expect(tracks[0].points[0].t).toBe(0)
    expect(tracks[1].points[0].t).toBe(2.5)
    // Between detections the box is interpolated, and nothing is made up outside the track.
    expect(boxAt(tracks[1], 3.1)?.x).toBeCloseTo(0.62, 5)
    expect(boxAt(tracks[1], 1)).toBeNull()
  })

  it('ends a track when the face is gone for long, and drops one only glimpsed', () => {
    const samples: FaceSample[] = []
    for (let t = 0; t < 8; t += 0.25) {
      const here = t < 3 || t >= 5
      samples.push({ t, faces: here ? [{ x: 0.4, y: 0.3, w: 0.2, h: 0.35 }] : [] })
    }
    samples.push({ t: 4, faces: [{ x: 0.8, y: 0.1, w: 0.05, h: 0.08 }] })
    const tracks = linkFaces(samples)
    expect(tracks).toHaveLength(2)
    expect(tracks.every((tr) => tr.points.every((p) => p.box.w === 0.2))).toBe(true)
  })

  it('plans crops inside the frame, for wide and vertical footage', () => {
    for (const [W, H] of [
      [1920, 1080],
      [1080, 1920]
    ]) {
      const samples: FaceSample[] = []
      for (let t = 0; t < 4; t += 0.25)
        samples.push({ t, faces: [{ x: 0.7 + 0.05 * Math.sin(t), y: 0.05, w: 0.28, h: 0.2 }] })
      const plan = planCrops(linkFaces(samples), { width: W, height: H, fps: 30 })
      expect(plan.slots).toHaveLength(1)
      const slot = plan.slots[0]
      expect(slot.w % 2).toBe(0)
      expect(slot.h % 2).toBe(0)
      for (const win of slot.windows) {
        expect(win.x).toBeGreaterThanOrEqual(0)
        expect(win.y).toBeGreaterThanOrEqual(0)
        expect(win.x + slot.w).toBeLessThanOrEqual(W)
        expect(win.y + slot.h).toBeLessThanOrEqual(H)
      }
      // Window changes land between frames, and the script moves the named crop by
      // both its names: crop@m0, and m0 as ffmpeg 6.0 calls it.
      expect(sendcmdScript(plan)).toMatch(
        /^\d+\.\d{4}(?:-\d+\.\d{4})? crop@m0 x (\d+), crop@m0 y (\d+), m0 x \1, m0 y \2;$/m
      )
      for (const win of slot.windows) expect(Math.abs(((((win.fromSec * 30) % 1) + 1) % 1) - 0.5)).toBeLessThan(1e-6)
    }
  })

  it('holds each crop window until its slot’s next, and moves each crop by both its names', () => {
    const slot = (windows: [number, number, number][]): CropSlot => ({
      w: 60,
      h: 70,
      windows: windows.map(([fromSec, x, y]) => ({ fromSec, x, y, track: 0 }))
    })
    const plan: CropPlan = {
      width: 320,
      height: 180,
      tileW: 64,
      tileH: 72,
      slots: [
        slot([
          [0.5, 10, 20],
          [1.5, 30, 40]
        ]),
        slot([[0.25, 50, 60]])
      ],
      tracks: []
    }
    // Read from 1 s on: a window that began before then starts at once, and the last of each slot never ends.
    expect(sendcmdScript(plan, 1)).toBe(
      '0.0000-0.5000 crop@m0 x 10, crop@m0 y 20, m0 x 10, m0 y 20;\n' +
        '0.0000 crop@m1 x 50, crop@m1 y 60, m1 x 50, m1 y 60;\n' +
        '0.5000 crop@m0 x 30, crop@m0 y 40, m0 x 30, m0 y 40;\n'
    )
  })
})

describe('lining the sound up with the mouth', () => {
  for (const planted of [0, 0.04, 0.12, 0.2]) {
    it(`finds a sound ${Math.round(planted * 1000)} ms behind the mouth to within 15 ms`, () => {
      const { result } = run(`offset-${planted}`, take({ seed: 3 }), planted)
      expect(result.estimate).not.toBeNull()
      expect(Math.abs((result.estimate?.offsetSec ?? 99) - planted)).toBeLessThan(0.015)
      expect(result.estimate?.confidence).toBeGreaterThanOrEqual(0.6)
    })
  }

  it('corrects an offset of more than a frame, and says so in a sentence', () => {
    const { result } = run('offset-0.12', take({ seed: 3 }), 0.12)
    expect(result.source.audioOffsetSec).toBeCloseTo(0.12, 1)
    expect(result.notice).toBe('Your audio was 0.12 s behind your mouth. I lined it up.')
    expect(syncNotice(-0.08)).toBe('Your audio was 0.08 s ahead of your mouth. I lined it up.')
  })

  it('leaves a sound already in sync alone', () => {
    const { result } = run('offset-0', take({ seed: 3 }), 0)
    expect(result.source.audioOffsetSec).toBeUndefined()
    expect(result.notice).toBeNull()
  })

  it('moves the words onto the picture, so cuts and captions sit on the mouth', () => {
    const { words, result } = run('offset-0.12', take({ seed: 3 }), 0.12)
    const d = result.source.audioOffsetSec ?? 0
    const before = words.find((w) => w.text === 'w3') as Word
    const after = result.words.find((w) => w.id === before.id) as Word
    expect(after.startSec).toBeCloseTo(before.startSec - d, 6)
    const moved = shiftWords(shiftWords(words, 's1', 0.1), 's1', -0.1)
    expect(moved[3].startSec).toBeCloseTo(words[3].startSec, 9)
    const env = shiftEnvelope({ hopSec: 0.01, db: Float32Array.from([1, 2, 3, 4]) }, 0.02)
    expect(Array.from(env.db)).toEqual([3, 4, 1, 1])
  })
})

describe('cuts timed to the mouth', () => {
  it('starts each word in the stillness just before its mouth moves, to within a frame', () => {
    const { take: t, result } = run('offset-0.12', take({ seed: 3 }), 0.12)
    const errors: number[] = []
    result.words
      .filter((w) => /^w\d+$/.test(w.text))
      .forEach((w, i) => {
        expect(w.stillBefore).toBeDefined()
        const [from, to] = w.stillBefore as [number, number]
        expect(from).toBeLessThanOrEqual(to)
        // Never into the word's sound.
        expect(to).toBeLessThanOrEqual(w.startSec)
        errors.push(Math.round((to + 0.0005) * FPS) - restFrame(t, i))
      })
    expect(Math.max(...errors.map(Math.abs))).toBeLessThanOrEqual(1)
  })

  it('ends each word once its mouth has settled, within a small limit', () => {
    const { take: t, result } = run('offset-0.12', take({ seed: 3 }), 0.12)
    result.words
      .filter((w) => /^w\d+$/.test(w.text))
      .forEach((w, i) => {
        expect(w.stillAfter).toBeDefined()
        const [from] = w.stillAfter as [number, number]
        expect(from).toBeGreaterThanOrEqual(w.endSec)
        expect(from - w.endSec).toBeLessThanOrEqual(0.3 + 1e-9)
        expect(Math.abs(Math.round(from * FPS - 0.5) - settleFrame(t, i))).toBeLessThanOrEqual(1)
      })
  })

  it('lands /snappy cuts on a still mouth, where sound alone lands mid-movement', () => {
    const { take: t, result } = run('offset-0.12', take({ seed: 3 }), 0.12)
    const source = result.source
    const doc = createDoc({ id: 'd', title: 't', source, words: result.words, at: '2026-11-16T00:00:00.000Z' })
    const snappy = { maxGapSec: 0.15, padSec: 0.03, fillers: true }
    const cut = {
      ...currentCut(doc),
      tighten: snappy,
      beats: currentCut(doc).beats.map((b) => ({ ...b, padIn: 0.04, padOut: 0.06 }))
    }
    const open = (sec: number): number => t.scene.faces[0].mouth(sec)
    // At rest or just starting: under a tenth open, about what one tile pixel can show.
    const firstFrameOpen = (pieces: ReturnType<typeof resolveCut>['pieces']): number =>
      pieces.filter((p) => open(Math.ceil(p.srcStart * FPS - 1e-9) / FPS) > 0.1).length
    const withMouth = resolveCut(cut, doc.words, doc.sources).pieces
    const plain = doc.words.map(({ stillBefore: _a, stillAfter: _b, ...w }) => w)
    const soundOnly = resolveCut(cut, plain, doc.sources).pieces
    expect(withMouth.length).toBe(soundOnly.length)
    expect(firstFrameOpen(soundOnly)).toBeGreaterThan(withMouth.length / 2)
    expect(firstFrameOpen(withMouth)).toBe(0)
  })

  it('changes nothing for words with no mouth seen', () => {
    const w: Word = { id: 'w1', source: 's1', text: 'a', startSec: 1, endSec: 1.4 }
    expect(cutInAt(w, 0.92)).toBe(0.92)
    expect(cutOutAt(w, 1.52)).toBe(1.52)
    const seen: Word = { ...w, stillBefore: [0.7, 0.85], stillAfter: [1.5, 1.7] }
    expect(cutInAt(seen, 0.92)).toBe(0.85)
    expect(cutInAt(seen, 0.6)).toBe(0.7)
    expect(cutOutAt(seen, 1.43)).toBe(1.5)
    // An edit set to sound-only timing ignores what was seen.
    const sync = { mouth: { mode: 'sync' as const, measuredOffsetSec: 0, confidence: 1, seenShare: 1 } }
    expect(cutInAt(seen, 0.92, sync)).toBe(0.92)
  })
})

describe('when there is no mouth to read', () => {
  it('keeps sound-only timing with no face', () => {
    const t = take({ seed: 4, words: 10 })
    const env = envelopeOf(voiceSamples(t.lines, RATE, t.durationSec, 0.12), RATE)
    const words = transcribed(t, env, 0.12)
    const raw = measureInJs(t, [])
    const result = analyseMouth({ raw, words, envelope: env, source: sourceFor(t) })
    expect(result.words).toEqual(words)
    expect(result.source.audioOffsetSec).toBeUndefined()
    expect(result.notice).toBeNull()
  })

  it('falls back in low light', () => {
    const { result } = run('dark', take({ seed: 4, words: 10, light: 0.12 }), 0.12)
    expect(result.series.tracks[0].usable).toBe(false)
    expect(result.series.tracks[0].why).toBe('too dark')
    expect(result.words.some((w) => w.stillBefore || w.stillAfter)).toBe(false)
    expect(result.source.audioOffsetSec).toBeUndefined()
  })

  it('falls back where the head turns to the side', () => {
    const t = take({ seed: 4, words: 14 })
    const turned: [number, number] = [t.words[5].openSec - 0.6, t.words[7].settleSec + 0.6]
    const { result } = run('side', take({ seed: 4, words: 14, turned }), 0)
    const inside = result.words.filter((w) => w.startSec > turned[0] + 0.3 && w.endSec < turned[1] - 0.3)
    expect(inside.length).toBeGreaterThan(0)
    for (const w of inside) {
      expect(w.stillBefore).toBeUndefined()
      expect(w.offCamera).toBeUndefined()
    }
    expect(result.words.filter((w) => w.stillBefore).length).toBeGreaterThan(8)
  })

  it('leaves no cut hints across a covered mouth', () => {
    const t = take({ seed: 5, words: 14 })
    const covered: [number, number] = [t.words[5].openSec - 0.5, t.words[7].settleSec + 0.3]
    const { result } = run('covered', take({ seed: 5, words: 14, covered }), 0)
    const inside = result.words.filter((w) => w.startSec > covered[0] + 0.2 && w.endSec < covered[1] - 0.2)
    expect(inside.length).toBeGreaterThan(0)
    for (const w of inside) expect(w.stillBefore).toBeUndefined()
    // Outside the hand, cuts are still timed to the mouth.
    expect(result.words.filter((w) => w.stillBefore).length).toBeGreaterThan(8)
  })
})

describe('who is talking', () => {
  it('marks speech said while the mouth on screen is still, and nothing else', () => {
    const base = take({ seed: 6, words: 12 })
    const ask: [number, number] = [base.words[6].settleSec + 0.3, base.words[6].settleSec + 2.1]
    const { result } = run('off-camera', take({ seed: 6, words: 12, offCamera: [ask] }), 0)
    const marked = result.words.filter((w) => w.offCamera)
    expect(marked.map((w) => w.text)).toEqual(['q1'])
    const doc = { words: result.words }
    expect(offCameraLine(doc)).toMatch(/^Said off camera, while the mouth on screen was still .*: w\d+\.$/)
    expect(result.notice).toMatch(/Someone off camera speaks at 0:\d\d, and I marked it\./)
  })

  it('does not read nods as talking', () => {
    const { take: t, result } = run('offset-0.12', take({ seed: 3 }), 0.12)
    expect(t.nods.length).toBeGreaterThan(0)
    let frames = 0
    let talking = 0
    result.series.times.forEach((time, i) => {
      if (!t.nods.some(([a, b]) => time >= a && time <= b) || !Number.isFinite(result.series.talk[i])) return
      frames++
      if (result.series.talk[i] > 0.3) talking++
    })
    expect(frames).toBeGreaterThan(20)
    expect(talking / frames).toBeLessThan(0.05)
  })

  it('watches the face that talks when two are on screen', () => {
    const { result } = run('two', take({ seed: 7, words: 12, listener: true, size: 0.2 }), 0.04)
    const tracks = result.series.tracks
    expect(tracks).toHaveLength(2)
    const talker = tracks.find((tr) => tr.usable)
    expect(talker).toBeDefined()
    expect(tracks.filter((tr) => tr.usable)).toHaveLength(1)
    expect(Math.abs((result.estimate?.offsetSec ?? 1) - 0.04)).toBeLessThan(0.015)
  })

  it('does not read a camera cut as talking', () => {
    // A cut to another angle mid-pause: the face jumps and the light changes.
    const base = take({ seed: 12, words: 10, nods: false })
    const at = (base.words[4].settleSec + base.words[5].openSec) / 2
    const face = base.scene.faces[0]
    const cutTake: Take = {
      ...base,
      scene: {
        ...base.scene,
        light: (t) => (t < at ? 1 : 0.8),
        faces: [{ ...face, pose: (t) => ({ ...face.pose(t), cx: face.pose(t).cx + (t < at ? 0 : 0.08) }) }]
      }
    }
    const { result } = run('camera-cut', cutTake, 0)
    const i = result.series.times.findIndex((t) => t >= at)
    for (const k of [i, i + 1])
      expect(Number.isFinite(result.series.talk[k]) ? result.series.talk[k] : 0).toBeLessThan(0.3)
    expect(result.words.some((w) => w.offCamera)).toBe(false)
  })

  it('picks up a face that enters mid-shot', () => {
    const { take: t, result } = run('enters', take({ seed: 8, words: 10, enterSec: 3 }), 0)
    const first = result.words.find((w) => w.text === 'w1') as Word
    expect(first.startSec).toBeGreaterThan(3)
    expect(first.stillBefore).toBeDefined()
    expect(result.series.faces[Math.round(1 * FPS)]).toBe(0)
    expect(result.series.faces[Math.round((t.words[0].onsetSec + 0.2) * FPS)]).toBe(1)
  })
})

describe('retake hints', () => {
  it('gives a series ten times a second, with the face, its stillness and where it went', () => {
    const { result, take: t } = run('enters', take({ seed: 8, words: 10, enterSec: 3 }), 0)
    const hints = retakeHints(result.series, t.durationSec)
    expect(hints.hopSec).toBe(0.1)
    expect(hints.face.length).toBe(Math.ceil(t.durationSec / 0.1))
    expect(hints.face[10]).toBe(0)
    expect(hints.away[10]).toBe(1)
    const mid = (w: { onsetSec: number; endSec: number }): number => Math.round(((w.onsetSec + w.endSec) / 2) * 10)
    expect(hints.face[mid(t.words[2])]).toBe(1)
    // Talking is not a still mouth; the last second of the take, after the last word, is.
    expect(hints.stillMouth[mid(t.words[2])]).toBe(0)
    expect(hints.stillMouth[hints.face.length - 2]).toBe(1)
    expect(Array.from(hints.reset).every((v) => v >= 0 && v <= 1)).toBe(true)
  })
})

describe('documents', () => {
  const plainDoc = (): EditDoc =>
    createDoc({
      id: 'd1',
      title: 'Settings',
      source: { id: 's1', path: '/a.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript(
        [
          { text: 'Most', startSec: 1, endSec: 1.3 },
          { text: 'people.', startSec: 1.35, endSec: 1.8 },
          { text: 'Never.', startSec: 3, endSec: 3.4 }
        ],
        's1'
      ),
      at: '2026-11-16T00:00:00.000Z'
    })

  it('opens documents saved before mouth watching, unchanged', () => {
    const old = JSON.parse(JSON.stringify(plainDoc()))
    const parsed = EditDocSchema.parse(old)
    expect(parsed).toEqual(old)
    expect(resolveCut(currentCut(parsed), parsed.words, parsed.sources)).toEqual(
      resolveCut(currentCut(old), old.words, old.sources)
    )
  })

  it('keeps what was seen through a save and a load', () => {
    const doc = plainDoc()
    const seen: EditDoc = {
      ...doc,
      sources: [
        {
          ...doc.sources[0],
          audioOffsetSec: 0.12,
          mouth: { mode: 'cuts+sync', measuredOffsetSec: 0.12, confidence: 0.9, seenShare: 0.8 }
        }
      ],
      words: doc.words.map((w, i) =>
        i === 2 ? { ...w, stillBefore: [2.7, 2.9] as [number, number], offCamera: true } : w
      )
    }
    expect(EditDocSchema.parse(JSON.parse(JSON.stringify(seen)))).toEqual(seen)
  })

  it('switches the sync off and on in a sentence, moving the words between clocks', () => {
    const doc = plainDoc()
    const seen: EditDoc = {
      ...doc,
      sources: [
        {
          ...doc.sources[0],
          audioOffsetSec: 0.12,
          mouth: { mode: 'cuts+sync', measuredOffsetSec: 0.12, confidence: 0.9, seenShare: 0.8 }
        }
      ]
    }
    const off = setMouthMode(seen, 's1', 'off')
    expect(off.doc.sources[0].audioOffsetSec).toBeUndefined()
    expect(off.doc.words[0].startSec).toBeCloseTo(1.12, 6)
    expect(off.reply).toBe('Cuts follow the sound now, and the audio is back where it was recorded.')
    const back = setMouthMode(off.doc, 's1', 'cuts+sync')
    expect(back.doc.sources[0].audioOffsetSec).toBe(0.12)
    expect(back.doc.words[0].startSec).toBeCloseTo(1, 6)
    expect(back.reply).toBe('Cuts start just before your mouth moves again, and the audio stays lined up with it.')
  })

  /** A second recording of the same shoot, its words carrying its id. */
  const twoClips = (): EditDoc => {
    const one = plainDoc()
    const s2: Source = { id: 's2', path: '/b.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 }
    const words = wordsFromTranscript(
      [
        { text: 'Second', startSec: 2, endSec: 2.4 },
        { text: 'clip.', startSec: 2.45, endSec: 2.9 }
      ],
      's2',
      's2w'
    )
    return createDoc({
      id: 'd2',
      title: 'Two',
      sources: [one.sources[0], s2],
      words: [...one.words, ...words],
      at: '2026-11-16T00:00:00.000Z'
    })
  }
  const seenAt = (offsetSec: number, extra: Partial<NonNullable<Source['mouth']>> = {}): Partial<Source> => ({
    audioOffsetSec: offsetSec,
    mouth: { mode: 'cuts+sync', measuredOffsetSec: offsetSec, confidence: 0.9, seenShare: 0.8, ...extra }
  })

  it('adds the mouth offset to the better sound from another recording, for the export and the preview alike', () => {
    const base: Source = { id: 's1', path: '/cam.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 }
    expect(heardFrom(base)).toBeNull()
    expect(heardFrom({ ...base, audio: null })).toBeNull()
    // Only the mouth: the recording's own sound, read a moment later.
    expect(heardFrom({ ...base, audioOffsetSec: 0.12 })).toEqual({ path: '/cam.mov', offsetSec: 0.12 })
    // Only by ear: the other recording as it was lined up.
    expect(heardFrom({ ...base, audio: { path: '/rec.wav', offsetSec: 1.38 } })).toEqual({
      path: '/rec.wav',
      offsetSec: 1.38
    })
    // Both: they add up.
    const both = heardFrom({ ...base, audio: { path: '/rec.wav', offsetSec: 1.38 }, audioOffsetSec: 0.12 })
    expect(both?.path).toBe('/rec.wav')
    expect(both?.offsetSec).toBeCloseTo(1.5, 9)
  })

  it('says which clips were lined up when several come in together', () => {
    const doc = twoClips()
    const [a, b] = doc.sources
    const clip = (name: string, source: Source): { name: string; source: Source; words: Word[] } => ({
      name,
      source,
      words: doc.words.filter((w) => w.source === source.id)
    })
    expect(mouthNotice([clip('a.mov', { ...a, ...seenAt(0.12) })])).toBe(
      'Your audio was 0.12 s behind your mouth. I lined it up.'
    )
    expect(mouthNotice([clip('a.mov', { ...a, ...seenAt(0.12) }), clip('b.mov', b)])).toBe(
      'In a.mov, your audio was 0.12 s behind your mouth. I lined it up.'
    )
    expect(mouthNotice([clip('a.mov', { ...a, ...seenAt(0.12) }), clip('b.mov', { ...b, ...seenAt(0.121) })])).toBe(
      'Your audio was 0.12 s behind your mouth in both clips. I lined it up.'
    )
    expect(mouthNotice([clip('a.mov', { ...a, ...seenAt(0.08) }), clip('b.mov', { ...b, ...seenAt(0.12) })], 3)).toBe(
      'Your audio was 0.08 to 0.12 s behind your mouth in 2 of 3 clips. I lined it up.'
    )
    expect(mouthNotice([clip('a.mov', { ...a, ...seenAt(-0.05) }), clip('b.mov', { ...b, ...seenAt(0.12) })])).toBe(
      'Your audio was out of step with your mouth by 0.05 to 0.12 s in both clips. I lined it up.'
    )
    expect(mouthNotice([clip('a.mov', a), clip('b.mov', b)])).toBeNull()
    // A voice from off camera is said with the clip it is in.
    const asked = doc.words.map((w) => (w.id === 's2w1' ? { ...w, offCamera: true } : w))
    expect(
      mouthNotice([
        { name: 'a.mov', source: a, words: asked.filter((w) => w.source === 's1') },
        { name: 'b.mov', source: b, words: asked.filter((w) => w.source === 's2') }
      ])
    ).toBe('Someone off camera speaks at 0:02 in b.mov, and I marked it.')
  })

  it('moves the sound map with the words when the sync is switched', () => {
    const doc = plainDoc()
    const seen: EditDoc = {
      ...doc,
      sources: [{ ...doc.sources[0], ...seenAt(0.12) }],
      audio: {
        s1: {
          v: 1,
          words: { w1: [-20, 180] },
          segments: [{ kind: 'laughter', startSec: 2, endSec: 2.5 }],
          emphasis: ['w1'],
          level: { floor: -60, speech: -20 }
        }
      }
    }
    const off = setMouthMode(seen, 's1', 'off')
    expect(off.doc.audio?.s1.segments[0].startSec).toBeCloseTo(2.12, 6)
    expect(off.doc.audio?.s1.words).toEqual({ w1: [-20, 180] })
    const back = setMouthMode(off.doc, 's1', 'sync')
    expect(back.doc.audio?.s1.segments[0].startSec).toBeCloseTo(2, 6)
    expect(back.doc.words[0].startSec).toBeCloseTo(1, 6)
  })

  it('switches every clip in one sentence, and the choice outlasts a change of the kind of video', () => {
    const two = twoClips()
    const doc: EditDoc = {
      ...two,
      sources: [
        { ...two.sources[0], ...seenAt(0.12, { facePx: 400, faceShare: 0.21 }) },
        { ...two.sources[1], ...seenAt(0.05, { facePx: 90, faceShare: 0.05 }) }
      ]
    }
    const off = setMouthModeAll(doc, 'off')
    expect(off.doc.sources.map((s) => [s.mouth?.mode, s.audioOffsetSec, s.mouth?.chosen])).toEqual([
      ['off', undefined, true],
      ['off', undefined, true]
    ])
    expect(off.reply).toBe('Cuts follow the sound now, and the audio is back where it was recorded.')
    expect(off.doc.words.find((w) => w.id === 's2w1')?.startSec).toBeCloseTo(2.05, 6)
    // Chosen in a sentence, so "this one is ASMR" leaves it alone.
    expect(mouthForNiche(off.doc, 'asmr')).toEqual({ doc: off.doc, reply: null })
  })

  it('takes the mode of the kind of video named in a sentence, with its face-size rule', () => {
    const two = twoClips()
    const doc: EditDoc = {
      ...two,
      sources: [
        { ...two.sources[0], ...seenAt(0.12, { facePx: 400, faceShare: 0.21 }) },
        { ...two.sources[1], ...seenAt(0.05, { facePx: 90, faceShare: 0.05 }) }
      ]
    }
    // ASMR never trims by the mouth, but keeps the sound lined up.
    const asmr = mouthForNiche(doc, 'asmr')
    expect(asmr.doc.sources.map((s) => s.mouth?.mode)).toEqual(['sync', 'sync'])
    expect(asmr.doc.sources.map((s) => s.audioOffsetSec)).toEqual([0.12, 0.05])
    expect(asmr.reply).toBe('Cuts follow the sound now. The audio stays lined up with your mouth.')
    // Gaming: only the facecam big enough to read times the cuts.
    const gaming = mouthForNiche(asmr.doc, 'gaming')
    expect(gaming.doc.sources.map((s) => s.mouth?.mode)).toEqual(['cuts+sync', 'sync'])
    // A kind not built as a cutting profile still has a mouth rule: a wedding is never watched.
    const wedding = mouthForNiche(doc, 'wedding')
    expect(wedding.doc.sources.map((s) => [s.mouth?.mode, s.audioOffsetSec])).toEqual([
      ['off', undefined],
      ['off', undefined]
    ])
    expect(wedding.doc.words[0].startSec).toBeCloseTo(1.12, 6)
    // The same kind again changes nothing.
    expect(mouthForNiche(doc, 'tech').reply).toBeNull()
  })
})
