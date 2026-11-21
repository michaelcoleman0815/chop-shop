import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  resolveCut,
  srcToOut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved
} from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import {
  audioSeconds,
  countFrames,
  findFfmpeg,
  frameColour,
  makeBurstClip,
  makeColourClip,
  meanLevel,
  onsets,
  toneLevel,
  type Rgb
} from './test-media'

const FFMPEG = findFfmpeg()

/**
 * Speed, freeze frames and reverse rendered for real. The recording is four
 * colours in turn, each with its own tone and one word over it, so any frame
 * says which moment of the recording shows, and any stretch of sound says
 * which moment plays and at what pitch.
 */
const PARTS = [
  { color: 'red', hz: 440, sec: 1.5 },
  { color: '0x00c000', hz: 550, sec: 1.5 },
  { color: 'blue', hz: 660, sec: 1.5 },
  { color: 'yellow', hz: 770, sec: 1.5 }
]
const WORDS = [
  { text: 'Red.', startSec: 0.3, endSec: 1.2 },
  { text: 'Green.', startSec: 1.8, endSec: 2.7 },
  { text: 'Blue.', startSec: 3.3, endSec: 4.2 },
  { text: 'Yellow.', startSec: 4.8, endSec: 5.7 }
]
const HZ: Record<string, number> = { 'Red.': 440, 'Green.': 550, 'Blue.': 660, 'Yellow.': 770 }

const isRed = (c: Rgb): boolean => c[0] > 180 && c[1] < 80 && c[2] < 80
const isGreen = (c: Rgb): boolean => c[1] > 150 && c[0] < 80 && c[2] < 80
const isBlue = (c: Rgb): boolean => c[2] > 150 && c[0] < 80 && c[1] < 80
const isYellow = (c: Rgb): boolean => c[0] > 180 && c[1] > 180 && c[2] < 80
const isMagenta = (c: Rgb): boolean => c[0] > 180 && c[2] > 180 && c[1] < 80
const isCyan = (c: Rgb): boolean => c[1] > 180 && c[2] > 180 && c[0] < 80

describe.skipIf(!FFMPEG)('rendering speed, freeze frames and reverse', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let spoken: EditDoc
  let silent: EditDoc
  let sources: RenderSource[]
  let spin = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-speed-'))
    const path = makeColourClip(ffmpeg, join(dir, 'take.mp4'), PARTS)
    // A cutaway: magenta, cyan, then white, a second each.
    spin = makeColourClip(ffmpeg, join(dir, 'spin.mp4'), [
      { color: 'magenta', hz: 300, sec: 1 },
      { color: 'cyan', hz: 300, sec: 1 },
      { color: 'white', hz: 300, sec: 1 }
    ])
    const source = { id: 's1', path, durationSec: 6, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    const flat = (doc: EditDoc, ops: unknown[]): EditDoc => {
      const r = applyOps(
        currentCut(doc),
        [...ops, { op: 'aspect', aspect: 'original' }, { op: 'loudness', lufs: null }],
        {
          words: doc.words,
          sources: doc.sources
        }
      )
      expect(r.rejected).toEqual([])
      return { ...doc, versions: [{ ...doc.versions[0], cut: r.cut }] }
    }
    // One word per colour, each its own beat.
    spoken = flat(createDoc({ id: 'd', title: 'T', source, words: wordsFromTranscript(WORDS, 's1') }), [])
    // The whole recording as one beat, with no words to frame it.
    const none = createDoc({ id: 'e', title: 'T', source, words: [] })
    silent = flat(none, [
      { op: 'remove', beats: ['b1'] },
      { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 6 } }
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const withOps = (doc: EditDoc, ops: unknown[]): Cut => {
    const r = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const render = async (
    doc: EditDoc,
    cut: Cut,
    name: string,
    maxInputs?: number
  ): Promise<{ out: string; resolved: Resolved }> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      maxInputs
    })
    return { out, resolved }
  }
  /** Each word's tone plays across the stretch its caption shows for, louder than any other tone. */
  const expectCaptionsOnTheirSound = (out: string, resolved: Resolved): void => {
    for (const w of resolved.words) {
      const hz = HZ[w.text]
      const from = w.outStart + 0.08
      const len = Math.max(0.1, w.outEnd - w.outStart - 0.16)
      const own = toneLevel(ffmpeg, out, from, len, hz)
      for (const other of Object.values(HZ).filter((h) => h !== hz)) {
        expect(own, `${w.text} at ${w.outStart.toFixed(2)} s against ${other} Hz`).toBeGreaterThan(
          toneLevel(ffmpeg, out, from, len, other) + 15
        )
      }
    }
  }

  it('plays a beat twice as fast at the same pitch', async () => {
    const { out } = await render(silent, withOps(silent, [{ op: 'speed', beats: ['b1'], speed: 2 }]), 'double')
    expect(countFrames(ffmpeg, out)).toBe(90)
    expect(Math.abs(audioSeconds(ffmpeg, out) - 3)).toBeLessThan(0.03)
    expect(isRed(frameColour(ffmpeg, out, 0.4))).toBe(true)
    expect(isGreen(frameColour(ffmpeg, out, 1.1))).toBe(true)
    expect(isBlue(frameColour(ffmpeg, out, 1.9))).toBe(true)
    expect(isYellow(frameColour(ffmpeg, out, 2.6))).toBe(true)
    // atempo keeps the pitch: red's 440 Hz, not the octave above it.
    expect(toneLevel(ffmpeg, out, 0.1, 0.5, 440)).toBeGreaterThan(toneLevel(ffmpeg, out, 0.1, 0.5, 880) + 20)
    expect(toneLevel(ffmpeg, out, 2.3, 0.5, 770)).toBeGreaterThan(toneLevel(ffmpeg, out, 2.3, 0.5, 1540) + 20)
  })

  it('eases into slow motion and back, the picture and sound where the steps put them', async () => {
    const cut = withOps(silent, [{ op: 'speed', beats: ['b1'], speed: 0.5, ramp: { inSec: 0.6, outSec: 0.6 } }])
    const { out, resolved } = await render(silent, cut, 'ramp')
    const piece = resolved.pieces[0]
    expect(Math.abs(countFrames(ffmpeg, out) - Math.round(resolved.durationSec * 30))).toBeLessThanOrEqual(1)
    // Every colour change lands where the time map says.
    for (const [src, before, after] of [
      [1.5, isRed, isGreen],
      [3, isGreen, isBlue],
      [4.5, isBlue, isYellow]
    ] as const) {
      const at = srcToOut(piece.steps!, src)
      expect(before(frameColour(ffmpeg, out, at - 0.1)), `before ${src} s at ${at.toFixed(2)}`).toBe(true)
      expect(after(frameColour(ffmpeg, out, at + 0.1)), `after ${src} s at ${at.toFixed(2)}`).toBe(true)
    }
    // Slowed sound at its own pitch.
    const mid = srcToOut(piece.steps!, 2.25)
    expect(toneLevel(ffmpeg, out, mid - 0.3, 0.6, 550)).toBeGreaterThan(
      toneLevel(ffmpeg, out, mid - 0.3, 0.6, 275) + 20
    )
  })

  it('keeps every caption on its word when a beat is sped up', async () => {
    const { out, resolved } = await render(
      spoken,
      withOps(spoken, [
        { op: 'speed', beats: ['b2'], speed: 2 },
        { op: 'speed', beats: ['b3'], speed: 0.5, ramp: { inSec: 0.3, outSec: 0.3 } }
      ]),
      'captions'
    )
    expectCaptionsOnTheirSound(out, resolved)
  })

  it('plays a beat backwards, picture and sound', async () => {
    const { out } = await render(silent, withOps(silent, [{ op: 'reverse', beats: ['b1'], on: true }]), 'reverse')
    expect(countFrames(ffmpeg, out)).toBe(180)
    expect(isYellow(frameColour(ffmpeg, out, 0.75))).toBe(true)
    expect(isBlue(frameColour(ffmpeg, out, 2.25))).toBe(true)
    expect(isGreen(frameColour(ffmpeg, out, 3.75))).toBe(true)
    expect(isRed(frameColour(ffmpeg, out, 5.25))).toBe(true)
    expect(toneLevel(ffmpeg, out, 0.2, 0.6, 770)).toBeGreaterThan(toneLevel(ffmpeg, out, 0.2, 0.6, 440) + 20)
    expect(toneLevel(ffmpeg, out, 5.0, 0.6, 440)).toBeGreaterThan(toneLevel(ffmpeg, out, 5.0, 0.6, 770) + 20)
    // Backwards at double speed: half as long, yellow first.
    const fast = await render(
      silent,
      withOps(silent, [
        { op: 'reverse', beats: ['b1'], on: true },
        { op: 'speed', beats: ['b1'], speed: 2 }
      ]),
      'reverse-fast'
    )
    expect(countFrames(ffmpeg, fast.out)).toBe(90)
    expect(isYellow(frameColour(ffmpeg, fast.out, 0.35))).toBe(true)
    expect(isRed(frameColour(ffmpeg, fast.out, 2.6))).toBe(true)
  })

  it('brings a sped-up picture in early on an L cut, at its own speed', async () => {
    const cut = withOps(spoken, [
      { op: 'speed', beats: ['b2'], speed: 0.5 },
      { op: 'lcut', beats: ['b2'], sec: 0.3 }
    ])
    const { out, resolved } = await render(spoken, cut, 'lcut-slow')
    const beat = resolved.beats[1]
    expect(beat.pictureStart).toBeCloseTo(beat.outStart - 0.3, 6)
    // Green under the end of red's word, which is still heard.
    expect(isGreen(frameColour(ffmpeg, out, beat.outStart - 0.15))).toBe(true)
    expect(isRed(frameColour(ffmpeg, out, beat.outStart - 0.45))).toBe(true)
    expectCaptionsOnTheirSound(out, resolved)
  })

  it('holds a frame on a word while the sound waits, then carries on', async () => {
    const { out, resolved } = await render(
      spoken,
      withOps(spoken, [{ op: 'freeze', beat: 'b2', word: 'w2', sec: 1 }]),
      'freeze'
    )
    const hold = resolved.pieces.find((p) => p.hold !== undefined)!
    expect(Math.abs(countFrames(ffmpeg, out) - Math.round(resolved.durationSec * 30))).toBeLessThanOrEqual(1)
    // Green, still, and silent for the whole second.
    const a = frameColour(ffmpeg, out, hold.outStart + 0.15)
    const b = frameColour(ffmpeg, out, hold.outEnd - 0.15)
    expect(isGreen(a)).toBe(true)
    expect(b).toEqual(a)
    expect(meanLevel(ffmpeg, out, hold.outStart + 0.05, 0.9)).toBeLessThan(-60)
    // Then the rest: blue's word after it, on time.
    expectCaptionsOnTheirSound(out, resolved)
  })

  it('speeds a cutaway while the voice under it keeps its pace', async () => {
    const cut = withOps(spoken, [
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: spin, inSec: 0, muted: true } } },
      { op: 'speed', beats: ['b2'], speed: 2 }
    ])
    const { out, resolved } = await render(spoken, cut, 'cutaway-speed')
    const beat = resolved.beats[1]
    // Twice as fast: magenta for 0.5 s, then cyan.
    expect(isMagenta(frameColour(ffmpeg, out, beat.outStart + 0.25))).toBe(true)
    expect(isCyan(frameColour(ffmpeg, out, beat.outStart + 0.75))).toBe(true)
    expectCaptionsOnTheirSound(out, resolved)
  })

  it('plays a cutaway backwards over the same stretch of its footage', async () => {
    const cut = withOps(spoken, [
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: spin, inSec: 0.5, muted: true } } },
      { op: 'reverse', beats: ['b2'], on: true }
    ])
    const { out, resolved } = await render(spoken, cut, 'cutaway-reverse')
    const beat = resolved.beats[1]
    const len = beat.outEnd - beat.outStart
    // Footage 0.5 to 0.5 + len, from the far end: cyan first, magenta last.
    expect(isCyan(frameColour(ffmpeg, out, beat.outStart + 0.15))).toBe(true)
    expect(isMagenta(frameColour(ffmpeg, out, beat.outStart + len - 0.2))).toBe(true)
    // The voice under it plays forwards.
    expectCaptionsOnTheirSound(out, resolved)
  })

  it('freezes a cutaway with the beat, and picks it up where it stopped', async () => {
    const cut = withOps(spoken, [
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: spin, inSec: 0.5, muted: true } } },
      { op: 'freeze', beat: 'b2', word: 'w2', sec: 1 }
    ])
    const { out, resolved } = await render(spoken, cut, 'cutaway-freeze')
    const hold = resolved.pieces.find((p) => p.hold !== undefined)!
    const beat = resolved.beats[1]
    // 0.98 s in, the cutaway is at 1.48 s: cyan, held for the second.
    expect(hold.outStart - beat.outStart).toBeCloseTo(0.98, 6)
    expect(isMagenta(frameColour(ffmpeg, out, beat.outStart + 0.3))).toBe(true)
    const a = frameColour(ffmpeg, out, hold.outStart + 0.2)
    expect(isCyan(a)).toBe(true)
    expect(frameColour(ffmpeg, out, hold.outEnd - 0.2)).toEqual(a)
    expect(isCyan(frameColour(ffmpeg, out, hold.outEnd + 0.05))).toBe(true)
  })

  it('renders the same in passes as in one', async () => {
    const cut = withOps(spoken, [
      { op: 'speed', beats: ['b1'], speed: 1.5, ramp: { inSec: 0.2, outSec: 0 } },
      { op: 'freeze', beat: 'b2', word: 'w2', sec: 0.5 },
      { op: 'reverse', beats: ['b3'], on: true },
      { op: 'speed', beats: ['b4'], speed: 0.5 }
    ])
    const one = await render(spoken, cut, 'passes-whole', Infinity)
    const passes = await render(spoken, cut, 'passes-split', 2)
    expect(countFrames(ffmpeg, passes.out)).toBe(countFrames(ffmpeg, one.out))
    for (const t of [0.3, 1.2, 1.9, 2.6, 3.5, 4.6, 5.5]) {
      const a = frameColour(ffmpeg, one.out, t)
      const b = frameColour(ffmpeg, passes.out, t)
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c]), `${t}s channel ${c}`).toBeLessThan(12)
    }
    expectCaptionsOnTheirSound(passes.out, passes.resolved)
  })
})

/**
 * Speech at speed, timed to the millisecond: each word a tone burst, so the
 * moment every word starts in the render can be heard and set against the
 * moment its caption shows.
 */
describe.skipIf(!FFMPEG)('speech at speed', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-speech-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps every word on its caption, sped up, slowed down and eased', async () => {
    // Four sentences of six words, 0.25 s each and 0.15 s apart, 0.9 s between sentences.
    const said: { text: string; startSec: number; endSec: number }[] = []
    let t = 0.6
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < 6; i++) {
        said.push({ text: i === 5 ? `end${s}.` : `word${s}${i}`, startSec: t, endSec: t + 0.25 })
        t += i === 5 ? 1.15 : 0.4
      }
    }
    const durationSec = Math.ceil(t + 1)
    const path = makeBurstClip(ffmpeg, join(dir, 'speech.mp4'), said, durationSec)
    const source = { id: 's1', path, durationSec, width: 320, height: 180, fps: 30 }
    const base = createDoc({ id: 'd', title: 'T', source, words: wordsFromTranscript(said, 's1') })
    const r = applyOps(
      currentCut(base),
      [
        { op: 'speed', beats: ['b1'], speed: 1.5 },
        { op: 'speed', beats: ['b2'], speed: 0.7 },
        { op: 'speed', beats: ['b3'], speed: 0.5, ramp: { inSec: 0.3, outSec: 0.3 } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      { words: base.words, sources: base.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, base.words, base.sources)
    const out = await renderCut(r.cut, resolved, [{ ...source, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'speech-out.mp4'),
      workDir: join(dir, 'work'),
      quality: 'final'
    })
    const heard = onsets(ffmpeg, out, -30, 0.05)
    const off = (w: { outStart: number }): number => Math.min(...heard.map((h) => Math.abs(h - w.outStart))) * 1000
    // Steady speeds land within 25 ms; an eased ramp, played a stretch at a time, within 30 ms.
    // The same on ffmpeg 6.0, which ignores atempo's tempo command, as on 6.1 and 7.
    for (const w of resolved.words.filter((w) => w.id !== 'w1')) {
      expect(off(w), `${w.id} in ${w.beat}`).toBeLessThan(w.beat === 'b3' ? 30 : 25)
    }
  })
})
