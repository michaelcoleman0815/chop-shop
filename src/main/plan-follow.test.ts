import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nowhere' }, safeStorage: {} }))

import { applyOps, commit, createDoc, currentCut, resolveCut, srcTimeAt, wordsFromTranscript, type Op } from '../shared/edit'
import { spanFor, template, timelineFor } from '../shared/motion'
import { FOLLOW_RATE, followOf, followWindow, type Track } from './plan-follow'
import { offerTrackedPlan } from './planner'
import { PlanSchema } from './planner-prompt'

/**
 * A graphic the planner pins to what the speaker holds up: the plan is
 * dry-run, the object found and followed in the recording where the graphic
 * lands, and its path kept on the graphic's op. A graphic that cannot follow
 * stays where it is put, said in one sentence.
 */

const source = { id: 's1', path: '/Users/you/Movies/phone.mov', durationSec: 12, width: 1080, height: 1920, fps: 30 }
const said: [string, number, number][] = [
  ['Look', 0.5, 0.8],
  ['at', 0.85, 0.95],
  ['this', 1.0, 1.4],
  ['phone.', 1.45, 2.0],
  ['It', 4.5, 4.6],
  ['folds', 4.65, 5.0],
  ['in', 5.05, 5.15],
  ['half.', 5.2, 5.8]
]
const doc = createDoc({
  id: 'd',
  title: 'phone',
  source,
  words: wordsFromTranscript(
    said.map(([text, startSec, endSec]) => ({ text, startSec, endSec })),
    's1'
  )
})

const graphic = (extra: Record<string, unknown> = {}) => ({
  op: 'motion-add',
  kind: 'keyword',
  from: 'w3',
  to: 'w8.end',
  text: ['Folds in half'],
  items: [],
  values: [],
  box: [],
  icon: '',
  style: '',
  place: '',
  color: '',
  fx: [],
  pin: 'object',
  ...extra
})
const plan = (ops: unknown[]) =>
  PlanSchema.parse({ ops, summary: 'It follows the phone.', reply: 'Done.', notesHandled: [], needs: [], question: { text: '', options: [] } })

/** A phone sliding across the picture, as the Vision helper would follow it. */
const sliding: Track = async (_path, _start, duration, rate = FOLLOW_RATE) => ({
  found: 'hand',
  samples: Array.from({ length: Math.floor(duration * rate) + 1 }, (_, i) => ({
    t: i / rate,
    box: [0.1 + 0.04 * (i / rate), 0.4, 0.2, 0.15] as [number, number, number, number],
    c: 0.9
  }))
})

describe('a graphic pinned to an object, as it is planned', () => {
  it('follows the object from the moment the graphic lands, and keeps the path on the op', async () => {
    const track = vi.fn(sliding)
    const r = await offerTrackedPlan(doc, plan([graphic()]), [], undefined, track)
    if (!r.ok) throw new Error(r.message)
    expect(r.rejected).toEqual([])
    expect(track).toHaveBeenCalledTimes(1)
    const [path, start, duration] = track.mock.calls[0]
    expect(path).toBe(source.path)
    // Where "this" is said in the recording, and on to the end of "half." as the graphic is.
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const tl = timelineFor(cut, resolved, doc.words)
    const tpl = template('keyword')!
    const span = spanFor(tl, 'w3', 'w8.end', tpl.length, tpl.lead)!
    const landing = resolved.pieces.find((p) => span.at >= p.outStart && span.at < p.outEnd)!
    expect(start).toBeCloseTo(srcTimeAt(landing, span.at), 6)
    expect(start + duration).toBeCloseTo(5.8, 1)
    const op = r.ops[0] as Extract<Op, { op: 'motion-add' }>
    expect(op.follow).toMatchObject({ source: 's1', step: 1 / FOLLOW_RATE })
    expect(op.follow!.at).toBeCloseTo(start, 6)
    expect(op.follow!.boxes.length).toBe(Math.floor(duration * FOLLOW_RATE + 1e-6) + 1)
    expect(op.follow!.boxes.every(Boolean)).toBe(true)
    // The plan's steps hold the same op, and the edit takes it.
    expect(r.steps).toEqual([{ ops: r.ops }])
    const done = commit(doc, r.ops, r.summary).doc
    expect(currentCut(done).motion?.[0].follow?.boxes.length).toBe(op.follow!.boxes.length)
  })

  it('leaves a graphic not pinned as it is, and asks nothing of the Mac', async () => {
    const track = vi.fn(sliding)
    const r = await offerTrackedPlan(doc, plan([graphic({ pin: '' })]), [], undefined, track)
    if (!r.ok) throw new Error(r.message)
    expect(track).not.toHaveBeenCalled()
    expect((r.ops[0] as { follow?: unknown }).follow).toBeUndefined()
  })

  it('says so when the graphic is over a card, with nothing of the speaker to follow', async () => {
    const track = vi.fn(sliding)
    const card = { op: 'treat', beats: ['b1'], set: { frame: 'card', bw: false } }
    const ops = [card, graphic()]
    const r = await offerTrackedPlan(doc, plan(ops), [], undefined, track)
    if (!r.ok) throw new Error(r.message)
    expect(track).not.toHaveBeenCalled()
    expect(r.ops).toHaveLength(2)
    expect(r.rejected).toEqual(['One graphic is not over your own picture, so there is nothing for it to follow.'])
  })

  it('stays where it is put when the object is not found, or the computer has no Vision', async () => {
    const nothing: Track = async () => {
      throw new Error('there is nothing in the picture to follow')
    }
    const lost = await offerTrackedPlan(doc, plan([graphic()]), [], undefined, nothing)
    if (!lost.ok) throw new Error(lost.message)
    expect(lost.rejected).toEqual(['I could not find the thing you hold up for one graphic, so it stays where it is put.'])
    expect((lost.ops[0] as { follow?: unknown }).follow).toBeUndefined()
    const notMac: Track = async () => {
      throw new Error('Following an object needs the Mac’s Vision.')
    }
    const windows = await offerTrackedPlan(doc, plan([graphic()]), [], undefined, notMac)
    if (!windows.ok) throw new Error(windows.message)
    expect(windows.rejected).toEqual([
      'Pinning a graphic to something you hold up needs Cutalong on a Mac, so it stays where it is put.'
    ])
    expect(windows.ops).toHaveLength(1)
  })

  it('pins each graphic of a plan to its own moment', async () => {
    const track = vi.fn(sliding)
    const second = graphic({ from: 'w6', to: '1s', text: ['Folds'] })
    const r = await offerTrackedPlan(doc, plan([graphic({ to: '1s' }), second]), [], undefined, track)
    if (!r.ok) throw new Error(r.message)
    expect(track).toHaveBeenCalledTimes(2)
    const starts = track.mock.calls.map((c) => c[1])
    expect(starts[1]).toBeGreaterThan(starts[0] + 2)
    expect(r.ops.every((o) => 'follow' in o && o.follow)).toBe(true)
  })
})

describe('the path a graphic keeps', () => {
  it('keeps a box a sample, at its own time, and drops what is lost or not a number', () => {
    const f = followOf('s1', 3, 0.5, {
      found: 'salient',
      samples: [
        { t: 0, box: [0.1, 0.1, 0.2, 0.2], c: 1 },
        { t: 1 / 12, box: null, c: 0.1 },
        { t: 2 / 12, box: [NaN, 0.1, 0.2, 0.2], c: 0.5 },
        { t: 6 / 12, box: [0.123456, 0.1, 0.2, 0.2], c: 0.8 }
      ]
    })!
    expect(f.at).toBe(3)
    expect(f.boxes).toEqual([[0.1, 0.1, 0.2, 0.2], null, null, null, null, null, [0.1235, 0.1, 0.2, 0.2]])
    expect(followOf('s1', 0, 1, { found: 'hand', samples: [{ t: 0, box: null, c: 0 }] })).toBeNull()
  })

  it('is followed through the recording past a cut pause, to the last moment the graphic is over it', () => {
    const cut = applyOps(currentCut(doc), [{ op: 'tighten', set: { maxGapSec: 0.3, padSec: 0.05, fillers: true } }], {
      words: doc.words,
      sources: doc.sources
    }).cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const tl = timelineFor(cut, resolved, doc.words)
    const span = spanFor(tl, 'w3', 'w8.end', 3, 0)!
    const w = followWindow(cut, resolved, span)!
    expect(w.source).toBe('s1')
    expect(w.start).toBeCloseTo(1.0, 1)
    expect(w.start + w.duration).toBeCloseTo(5.8, 1)
    // The pause is gone from the output, not from what is followed.
    expect(span.end - span.at).toBeLessThan(w.duration - 1)
  })
})
