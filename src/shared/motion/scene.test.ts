import { describe, expect, it } from 'vitest'
import {
  applyOps,
  commit,
  createDoc,
  currentCut,
  EditDocSchema,
  OpSchema,
  resolveCut,
  wordsFromTranscript,
  type EditDoc
} from '../edit'
import { describePlan } from '../presets'
import { activeSpans, buildScene, DEFAULT_THEME, parseAnchor, parseLength, type MotionScene } from '.'

/**
 * Graphics as ops on the edit: added, changed and removed as versions, and
 * resolved onto the output clock through the cut, so they follow the speech.
 */

const source = { id: 's1', path: '/take.mov', durationSec: 12, width: 1080, height: 1920, fps: 30 }
const words = wordsFromTranscript(
  [
    ['So', 0.5, 0.7],
    ["here's", 0.72, 1.0],
    ['the', 1.02, 1.1],
    ['thing.', 1.12, 1.5],
    ['Um', 2.4, 2.6],
    ['most', 2.7, 2.95],
    ['people', 3.0, 3.4],
    ['never', 3.45, 3.8],
    ['open', 3.85, 4.1],
    ['the', 4.12, 4.2],
    ['settings.', 4.25, 4.9]
  ].map(([text, startSec, endSec]) => ({
    text: text as string,
    startSec: startSec as number,
    endSec: endSec as number
  })),
  's1'
)

const box = { kind: 'shape' as const, shape: { type: 'rect' as const, w: 100, h: 100 }, fill: '#ff0000' }
const custom = (from: string, to = '', extra: Record<string, unknown> = {}) => ({
  op: 'motion-add' as const,
  kind: 'layers' as const,
  from,
  to,
  layers: [box],
  ...extra
})

function scene(doc: EditDoc): MotionScene {
  const cut = currentCut(doc)
  return buildScene({
    cut,
    resolved: resolveCut(cut, doc.words, doc.sources),
    words: doc.words,
    size: { width: 1080, height: 1920 },
    theme: DEFAULT_THEME
  })
}

const fresh = (): EditDoc => createDoc({ id: 'd', title: 't', source, words })

describe('anchors', () => {
  it('reads words, beats, the cut’s ends, offsets and lengths', () => {
    expect(parseAnchor('w12')).toEqual({ on: 'id', id: 'w12', edge: 'start', offset: 0 })
    expect(parseAnchor('w12.end')).toEqual({ on: 'id', id: 'w12', edge: 'end', offset: 0 })
    expect(parseAnchor('w12-0.3')).toEqual({ on: 'id', id: 'w12', edge: 'start', offset: -0.3 })
    expect(parseAnchor('b3.end+1')).toEqual({ on: 'id', id: 'b3', edge: 'end', offset: 1 })
    expect(parseAnchor('end-2')).toEqual({ on: 'cut', id: null, edge: 'end', offset: -2 })
    expect(parseAnchor('start')).toEqual({ on: 'cut', id: null, edge: 'start', offset: 0 })
    expect(parseAnchor('12')).toBeNull()
    expect(parseAnchor('w12.middle')).toBeNull()
    expect(parseAnchor('start.end')).toBeNull()
    expect(parseAnchor('')).toBeNull()
    expect(parseLength('4s')).toBe(4)
    expect(parseLength('1.5 s')).toBe(1.5)
    expect(parseLength('w4')).toBeNull()
  })
})

describe('motion ops', () => {
  it('leaves documents saved before graphics existed readable, with none', () => {
    const doc = fresh()
    const old = JSON.parse(JSON.stringify(doc)) as { versions: { cut: Record<string, unknown> }[] }
    for (const v of old.versions) delete v.cut.motion
    const parsed = EditDocSchema.parse(old)
    expect(currentCut(parsed).motion).toEqual([])
  })

  it('adds a graphic as an op the schema knows, with the next id', () => {
    expect(OpSchema.safeParse(custom('w6')).success).toBe(true)
    let doc = commit(fresh(), [custom('w6')], 'x').doc
    doc = commit(doc, [custom('w8')], 'x').doc
    expect(currentCut(doc).motion.map((m) => m.id)).toEqual(['m1', 'm2'])
    // Slots it left out take their defaults.
    expect(currentCut(doc).motion[0]).toMatchObject({ to: '', text: [], style: '', fx: [] })
  })

  it('refuses what it cannot place, with a sentence, and leaves the cut alone', () => {
    const doc = fresh()
    const cut = currentCut(doc)
    const ctx = { words: doc.words, sources: doc.sources }
    const r = applyOps(
      cut,
      [
        custom('w99'),
        custom('w6', 'b9'),
        custom('w6', '', { color: 'yellow' }),
        { ...custom('w6'), layers: [] },
        { op: 'motion-update', id: 'm7', style: 'bar' },
        { op: 'motion-remove', ids: ['m3'] },
        { op: 'motion-add', kind: 'layers', from: 'later' }
      ],
      ctx
    )
    expect(r.applied).toHaveLength(0)
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'There is no word or beat w99.',
      'There is no word or beat b9.',
      'yellow is not a colour I can use; give it as #RRGGBB.',
      'A custom graphic needs at least one layer.',
      'There is no graphic m7.',
      'There is no graphic m3.',
      'There is no word or beat later.'
    ])
    expect(r.cut).toBe(cut)
  })

  it('changes only what an update names, and removes by id', () => {
    let doc = commit(fresh(), [custom('w6', '3s', { text: ['one'], place: 'top' })], 'x').doc
    doc = commit(doc, [{ op: 'motion-update', id: 'm1', to: '', text: [], place: 'bottom', color: '#ff0000' }], 'x').doc
    expect(currentCut(doc).motion[0]).toMatchObject({ to: '3s', text: ['one'], place: 'bottom', color: '#ff0000' })
    doc = commit(doc, [{ op: 'motion-update', id: 'm1', color: 'none', to: 'none' }], 'x').doc
    expect(currentCut(doc).motion[0]).toMatchObject({ color: '', to: '' })
    doc = commit(doc, [{ op: 'motion-remove', ids: ['m1'] }], 'x').doc
    expect(currentCut(doc).motion).toEqual([])
  })

  it('says what changed in the version summary', () => {
    const doc = fresh()
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(describePlan([custom('w6')] as never, r, r)).toBe('A custom graphic of one layer comes in.')
    expect(describePlan([{ op: 'motion-remove', ids: ['m1', 'm2'] }], r, r)).toBe('Two graphics are gone.')
  })
})

describe('the scene', () => {
  it('puts a graphic on its word, and moves it when the cut changes', () => {
    let doc = commit(fresh(), [custom('w7', '2s')], 'x').doc
    const before = scene(doc).items[0]
    const said = resolveCut(currentCut(doc), doc.words, doc.sources).words.find((w) => w.id === 'w7')!
    expect(before.at).toBeCloseTo(said.outStart)
    expect(before.end - before.at).toBeCloseTo(2)
    expect(before.layers[0].start).toBeCloseTo(before.start)
    // Cutting the first beat pulls "people" earlier, and the graphic with it.
    doc = commit(doc, [{ op: 'remove', beats: ['b1'] }], 'x').doc
    const after = scene(doc).items[0]
    const now = resolveCut(currentCut(doc), doc.words, doc.sources).words.find((w) => w.id === 'w7')!
    expect(after.at).toBeCloseTo(now.outStart)
    expect(after.at).toBeLessThan(before.at - 0.5)
    // Moving its beat to the front moves it to the front.
    doc = commit(doc, [{ op: 'move', beat: 'b2', to: 0 }], 'x').doc
    expect(scene(doc).items[0].at).toBeLessThan(1.5)
  })

  it('lands on the next word said when its own is struck, and hides when its beat is gone', () => {
    let doc = commit(fresh(), [custom('w7', '1s')], 'x').doc
    doc = commit(doc, [{ op: 'strike', from: 'w7', to: 'w7' }], 'x').doc
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(scene(doc).items[0].at).toBeCloseTo(r.words.find((w) => w.id === 'w8')!.outStart)
    doc = commit(doc, [{ op: 'remove', beats: ['b2'] }], 'x').doc
    const s = scene(doc)
    expect(s.items).toHaveLength(0)
    expect(s.hidden).toEqual([{ id: 'm1', reason: 'What it was on is no longer in the cut.' }])
  })

  it('ends on an anchor, a length, the cut’s end, or its own length', () => {
    const doc = commit(
      fresh(),
      [custom('start', 'w4.end'), custom('w6', '1.5s'), custom('w6', 'end'), custom('w6'), custom('w9', 'w6')],
      'x'
    ).doc
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    const [a, b, c, d, e] = scene(doc).items
    expect(a.start).toBe(0)
    expect(a.end).toBeCloseTo(r.words.find((w) => w.id === 'w4')!.outEnd)
    expect(b.end - b.at).toBeCloseTo(1.5)
    expect(c.end).toBeCloseTo(r.durationSec)
    // A custom graphic lasts 3 s by itself, held to the end of the cut.
    expect(d.end).toBeCloseTo(Math.min(r.durationSec, d.at + 3))
    // An end that comes before the start once the cut is arranged falls back to the length.
    expect(e.end).toBeCloseTo(Math.min(r.durationSec, e.at + 3))
  })

  it('times hand-built layers from the graphic’s start, or from anchors', () => {
    const doc = commit(
      fresh(),
      [
        custom('w6', '3s', {
          layers: [
            { ...box, start: 0.5, end: 1 },
            { ...box, start: 'w8', end: 'w9.end' }
          ]
        })
      ],
      'x'
    ).doc
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    const item = scene(doc).items[0]
    expect(item.layers[0].start).toBeCloseTo(item.start + 0.5)
    expect(item.layers[0].end).toBeCloseTo(item.start + 1)
    expect(item.layers[1].start).toBeCloseTo(r.words.find((w) => w.id === 'w8')!.outStart)
    expect(item.layers[1].end).toBeCloseTo(r.words.find((w) => w.id === 'w9')!.outEnd)
  })

  it('finds the stretches with something to draw, merging short gaps', () => {
    const l = (start: number, end: number) => ({ ...box, start, end })
    expect(activeSpans([l(1, 2), l(2.1, 3), l(5, 6), l(5.5, 7)], 10)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 7 }
    ])
    expect(activeSpans([l(-1, 0.5), l(9, 12)], 10)).toEqual([
      { start: 0, end: 0.5 },
      { start: 9, end: 10 }
    ])
  })
})
