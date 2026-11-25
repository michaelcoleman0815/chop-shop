import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, savedOps, wordsFromTranscript, type Cut, type Op } from '../edit'
import { timelineFor } from '../motion/timing'
import { clipSpan, placeClips, shiftAnchor, trackLayers, tracksOf, type TrackClip } from '.'

/**
 * Layer tracks as ops: what each does to a cut, what each refuses, and how
 * clips land on the edit's clock and become the compositor's layers.
 */

const words = wordsFromTranscript(
  ['So', 'this', 'is', 'the', 'new', 'laptop', 'and', 'it', 'is', 'thin'].map((text, i) => ({
    text,
    startSec: 0.2 + i * 0.5,
    endSec: 0.6 + i * 0.5
  })),
  's1'
)
const source = { id: 's1', path: '/a.mp4', durationSec: 6, width: 1080, height: 1920, fps: 30 }
const doc = createDoc({ id: 'd', title: 't', source, words })
const ctx = { words: doc.words, sources: doc.sources }

function run(ops: unknown[], cut: Cut = currentCut(doc)): { cut: Cut; rejected: string[] } {
  const r = applyOps(cut, ops, ctx)
  return { cut: r.cut, rejected: r.rejected.map((x) => x.reason) }
}

const timeline = (cut: Cut) => timelineFor(cut, resolveCut(cut, doc.words, doc.sources), doc.words)
const clip = (cut: Cut, id: string): TrackClip => tracksOf(cut).flatMap((t) => t.clips).find((c) => c.id === id) as TrackClip
const said = (cut: Cut, id: string) => resolveCut(cut, doc.words, doc.sources).words.find((w) => w.id === id) as { outStart: number; outEnd: number }

describe('tracks and clips', () => {
  it('puts a clip on a new layer track when there is none, and numbers both', () => {
    const { cut, rejected } = run([{ op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w5', fileSec: 3 }])
    expect(rejected).toEqual([])
    const tracks = tracksOf(cut)
    expect(tracks.map((t) => [t.id, t.name, t.kind])).toEqual([['t1', 'Layer 1', 'picture']])
    expect(tracks[0].clips[0]).toMatchObject({ id: 'c1', kind: 'video', src: '/b.mp4', from: 'w5', in: 0, speed: 1, blend: 'normal', fit: 'contain' })
    // A sound goes on a sound track of its own.
    const more = run([{ op: 'clip-add', kind: 'sound', src: '/whoosh.wav', from: 'w2' }], cut).cut
    expect(tracksOf(more).map((t) => [t.id, t.kind])).toEqual([
      ['t1', 'picture'],
      ['t2', 'sound']
    ])
  })

  it('puts a clip that would overlap one on the top track onto a new track above it, as a timeline does', () => {
    const { cut, rejected } = run([
      { op: 'clip-add', kind: 'text', text: { value: 'One' }, from: 'start', to: '3s' },
      { op: 'clip-add', kind: 'solid', color: '#000000', from: 'start+1', to: '3s' },
      { op: 'clip-add', kind: 'text', text: { value: 'Two' }, from: 'start+4', to: '1s' }
    ])
    expect(rejected).toEqual([])
    expect(tracksOf(cut).map((t) => [t.id, t.clips.map((c) => c.id)])).toEqual([
      ['t1', ['c1']],
      ['t2', ['c2', 'c3']]
    ])
  })

  it('keeps a length asked for however short: a flash of a few frames, not five seconds', () => {
    const { cut, rejected } = run([
      { op: 'clip-add', kind: 'solid', color: '#FFFFFF', from: 'start+1', to: '0.1s' },
      { op: 'clip-add', kind: 'solid', color: '#000000', from: 'start+2', to: '0.034s' }
    ])
    expect(rejected).toEqual([])
    const tl = timeline(cut)
    const flash = clipSpan(tl, clip(cut, 'c1'))!
    expect(flash.end - flash.start).toBeCloseTo(0.1, 5)
    const frame = clipSpan(tl, clip(cut, 'c2'))!
    expect(frame.end - frame.start).toBeCloseTo(0.034, 5)
  })

  it('refuses a clip on a word the edit does not have, a video with no file, and a title with no words', () => {
    const { rejected } = run([
      { op: 'clip-add', kind: 'image', src: '/p.png', from: 'w99' },
      { op: 'clip-add', kind: 'video', from: 'start' },
      { op: 'clip-add', kind: 'text', from: 'start' }
    ])
    expect(rejected).toEqual([
      'Its start w99 names a word or beat this edit does not have.',
      'A video clip needs its file.',
      'A title needs its words.'
    ])
  })

  it('places a clip on its anchor and runs it its natural length: the rest of its file, or 5 s for a still', () => {
    const { cut } = run([
      { op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w3', in: 1, fileSec: 3, speed: 2 },
      { op: 'clip-add', kind: 'image', src: '/p.png', from: 'start+0.5' }
    ])
    const tl = timeline(cut)
    const at = said(cut, 'w3').outStart
    expect(clipSpan(tl, clip(cut, 'c1'))).toEqual({ start: at, end: Math.min(tl.duration, at + (3 - 1) / 2) })
    expect(clipSpan(tl, clip(cut, 'c2'))).toEqual({ start: 0.5, end: Math.min(tl.duration, 5.5) })
  })

  it('trims a head by seconds, moving the file with it so what plays stays in place', () => {
    const base = run([{ op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w2', fileSec: 10, to: '3s' }]).cut
    const before = clipSpan(timeline(base), clip(base, 'c1'))!
    const { cut, rejected } = run([{ op: 'clip-trim', clip: 'c1', edge: 'in', by: 0.5 }], base)
    expect(rejected).toEqual([])
    const c = clip(cut, 'c1')
    expect(c.from).toBe('w2+0.5')
    expect(c.in).toBeCloseTo(0.5, 6)
    // The tail stays where it was.
    const after = clipSpan(timeline(cut), c)!
    expect(after.start).toBeCloseTo(before.start + 0.5, 6)
    expect(after.end).toBeCloseTo(before.end, 6)
  })

  it('will not trim a head before its file begins, and stops a slip at either end of the file', () => {
    const base = run([{ op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w4', in: 0.3, fileSec: 2 }]).cut
    const head = run([{ op: 'clip-trim', clip: 'c1', edge: 'in', by: -5 }], base).cut
    // Pulled out as far as its file allows: 0.3 s earlier, from its first frame.
    expect(clip(head, 'c1').in).toBeCloseTo(0, 6)
    expect(clipSpan(timeline(head), clip(head, 'c1'))!.start).toBeCloseTo(said(base, 'w4').outStart - 0.3, 6)
    expect(run([{ op: 'clip-trim', clip: 'c1', edge: 'slip', by: -1 }], base).rejected).toEqual(['c1 cannot slip before the start of its file.'])
    expect(run([{ op: 'clip-trim', clip: 'c1', edge: 'slip', by: 2 }], base).rejected).toEqual(['c1 cannot slip past the end of its file.'])
    expect(clip(run([{ op: 'clip-trim', clip: 'c1', edge: 'slip', by: 0.5 }], base).cut, 'c1').in).toBeCloseTo(0.8, 6)
  })

  it('trims a tail to a word, or by seconds, and never past its file', () => {
    const base = run([{ op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w2', fileSec: 2.5 }]).cut
    const onWord = run([{ op: 'clip-trim', clip: 'c1', edge: 'out', to: 'w4.end' }], base).cut
    expect(clip(onWord, 'c1').to).toBe('w4.end')
    expect(clipSpan(timeline(onWord), clip(onWord, 'c1'))!.end).toBeCloseTo(said(base, 'w4').outEnd, 6)
    const shorter = run([{ op: 'clip-trim', clip: 'c1', edge: 'out', by: -1 }], base).cut
    const s = clipSpan(timeline(shorter), clip(shorter, 'c1'))!
    expect(s.end - s.start).toBeCloseTo(1.5, 3)
    expect(run([{ op: 'clip-trim', clip: 'c1', edge: 'out', by: 2 }], base).rejected).toEqual(['c1 cannot run that long: its file ends sooner.'])
  })

  it('splits a clip at a word: the second half starts later in the file, and its keys carry on where they were', () => {
    const base = run([
      { op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'start', fileSec: 20 },
      { op: 'key-set', clip: 'c1', prop: 'opacity', t: 0, v: 0 },
      { op: 'key-set', clip: 'c1', prop: 'opacity', t: 2, v: 1 }
    ]).cut
    const { cut, rejected } = run([{ op: 'clip-split', clip: 'c1', at: 'w3' }], base)
    expect(rejected).toEqual([])
    const at = said(base, 'w3').outStart
    expect(clip(cut, 'c1').to).toBe('w3')
    const tail = clip(cut, 'c2')
    // Its end stays where it was: the clip ran to the end of the edit, and still does.
    expect(clipSpan(timeline(cut), tail)!.end).toBeCloseTo(clipSpan(timeline(base), clip(base, 'c1'))!.end, 6)
    expect(tail).toMatchObject({ from: 'w3' })
    expect(tail.in).toBeCloseTo(at, 6)
    // Half way up the fade at the split, then on to full by the same moment as before.
    const keys = (tail.opacity as { keys: { t: number; v: number }[] }).keys
    expect(keys[0].t).toBe(0)
    expect(keys[0].v).toBeCloseTo(at / 2, 6)
    expect(keys[1].t).toBeCloseTo(2 - at, 6)
  })

  it('keeps a split title’s end where it was when its end was a length', () => {
    const base = run([{ op: 'clip-add', kind: 'text', text: { value: 'Hi' }, from: 'start', to: '3s' }]).cut
    const { cut } = run([{ op: 'clip-split', clip: 'c1', at: 'start+1' }], base)
    expect(clip(cut, 'c2').to).toBe('2s')
    expect(clipSpan(timeline(cut), clip(cut, 'c2'))).toEqual({ start: 1, end: 3 })
  })

  it('sets and takes off keys, replacing one already at that moment', () => {
    const base = run([{ op: 'clip-add', kind: 'image', src: '/p.png', from: 'start', transform: { scale: 1.2 } }]).cut
    const keyed = run(
      [
        { op: 'key-set', clip: 'c1', prop: 'scale', t: 0, v: 1 },
        { op: 'key-set', clip: 'c1', prop: 'scale', t: 1, v: 1.5, ease: 'easy-ease' },
        { op: 'key-set', clip: 'c1', prop: 'scale', t: 1, v: 1.4 },
        { op: 'key-set', clip: 'c1', prop: 'crop.left', t: 0.5, v: 0.1 }
      ],
      base
    ).cut
    const c = clip(keyed, 'c1')
    expect(c.transform?.scale).toEqual({ keys: [{ t: 0, v: 1 }, { t: 1, v: 1.4 }] })
    expect(c.crop?.left).toEqual({ keys: [{ t: 0.5, v: 0.1 }] })
    const off = run([{ op: 'key-remove', clip: 'c1', prop: 'scale', t: 1 }], keyed).cut
    expect(clip(off, 'c1').transform?.scale).toEqual({ keys: [{ t: 0, v: 1 }] })
    expect(run([{ op: 'key-remove', clip: 'c1', prop: 'rotation', t: 0 }], keyed).rejected).toEqual(['There is no key at 0 s to take off.'])
    expect(run([{ op: 'key-set', clip: 'c1', prop: 'volume', t: 0, v: -6 }], keyed).rejected).toEqual(['An image clip has no sound to set.'])
  })

  it('keeps a locked track as it is, and restacks, hides and solos tracks', () => {
    const base = run([
      { op: 'clip-add', kind: 'image', src: '/a.png', from: 'start' },
      { op: 'track-add', kind: 'picture' },
      { op: 'clip-add', kind: 'solid', color: '#000000', from: 'w2', track: 't2', opacity: 0.5 },
      { op: 'track-update', track: 't1', locked: true }
    ]).cut
    expect(run([{ op: 'clip-remove', clips: ['c1'] }], base).rejected).toEqual(['Layer 1 is locked. Unlock it to change its clips.'])
    const moved = run([{ op: 'track-update', track: 't2', at: 0 }], base).cut
    expect(tracksOf(moved).map((t) => t.id)).toEqual(['t2', 't1'])
    const tl = timeline(base)
    expect(placeClips(tracksOf(base), tl).map((p) => p.clip.id)).toEqual(['c1', 'c2'])
    const hidden = run([{ op: 'track-update', track: 't1', hidden: true }], base).cut
    expect(placeClips(tracksOf(hidden), tl).map((p) => p.clip.id)).toEqual(['c2'])
    const solo = run([{ op: 'track-update', track: 't1', solo: true }], base).cut
    expect(placeClips(tracksOf(solo), tl).map((p) => p.clip.id)).toEqual(['c1'])
  })

  it('draws a title clip with the shadow, glow, edge, lean and spacing asked for', () => {
    const { cut, rejected } = run([
      {
        op: 'clip-add',
        kind: 'text',
        from: 'w2',
        text: {
          value: 'NOT COOKED',
          size: 160,
          color: '#FFFFFF',
          shadow: true,
          glow: { color: '#FF3B30', blur: 40 },
          outline: { color: '#000000', width: 6 },
          slant: true,
          tracking: 8,
          lineHeight: 0.9,
          uppercase: true
        }
      }
    ])
    expect(rejected).toEqual([])
    const [title] = trackLayers(cut, timeline(cut), { width: 1920, height: 1080 })
    expect(title).toMatchObject({
      kind: 'text',
      font: { size: 160, tracking: 8, lineHeight: 0.9, uppercase: true, slant: 0.2126 },
      stroke: { color: '#000000', width: 6 },
      effects: { glow: { color: '#FF3B30', blur: 40 }, shadow: { color: 'rgba(0, 0, 0, 0.6)' } }
    })
  })

  it('hands the compositor one layer per picture clip, centred, blended and faded as set', () => {
    const { cut } = run([
      { op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w2', fileSec: 2, blend: 'multiply', opacity: 0.8, transform: { scale: 0.5 } },
      { op: 'clip-add', kind: 'text', text: { value: 'THIN' }, from: 'w9' },
      { op: 'clip-add', kind: 'sound', src: '/s.wav', from: 'start' }
    ])
    const layers = trackLayers(cut, timeline(cut), { width: 1080, height: 1920 })
    expect(layers.map((l) => l.kind)).toEqual(['video', 'text'])
    expect(layers[0]).toMatchObject({
      kind: 'video',
      src: '/b.mp4',
      w: 1080,
      h: 1920,
      blend: 'multiply',
      transform: { x: 540, y: 960, scale: 0.5, opacity: 0.8 }
    })
    expect(layers[1]).toMatchObject({ kind: 'text', text: 'THIN', valign: 'middle' })
  })

  it('moves an anchor by seconds, and is never kept in a version’s ops', () => {
    expect(shiftAnchor('w12.end+0.3', 0.2)).toBe('w12.end+0.5')
    expect(shiftAnchor('start', 1.25)).toBe('start+1.25')
    expect(shiftAnchor('w3+0.5', -0.5)).toBe('w3')
    const ops: Op[] = [
      { op: 'clip-add', kind: 'image', src: '/p.png', from: 'start', to: '', in: 0, speed: 1, fit: 'contain', blend: 'normal', muted: false },
      { op: 'aspect', aspect: 'vertical' }
    ]
    expect(savedOps(ops).map((o) => o.op)).toEqual(['aspect'])
  })
})

describe('trimming the edit itself', () => {
  it('moves a beat’s first or last word, and refuses a word from another recording or past its other edge', () => {
    const beat = currentCut(doc).beats[0]
    const { cut, rejected } = run([
      { op: 'trim', beat: beat.id, edge: 'in', word: 'w2' },
      { op: 'trim', beat: beat.id, edge: 'out', word: 'w8' }
    ])
    expect(rejected).toEqual([])
    expect(cut.beats[0]).toMatchObject({ from: 'w2', to: 'w8' })
    expect(run([{ op: 'trim', beat: beat.id, edge: 'in', word: 'w9' }], cut).rejected).toEqual(['w9 comes after w8.'])
    expect(run([{ op: 'trim', beat: beat.id, edge: 'in' }], cut).rejected).toEqual([
      `${beat.id} is cut on words; say which word it should start on.`
    ])
  })
})
