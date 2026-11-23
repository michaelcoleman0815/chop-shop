import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, wordsFromTranscript, type EditDoc, type Op } from '../shared/edit'
import { fromPlannerOp, PLANNER_SYSTEM, readPlan, renderRequest } from './planner-prompt'
import { FAMILY_GUIDES } from './planner-guides'

/**
 * Claude mixing through the plan tool, end to end: a plan handed over as
 * Claude writes it is read, each mix form becomes the op the edit takes and
 * is applied, and the request shows the strips back, with the mixer's guide
 * only when the ask or the cut needs it.
 */

const words = wordsFromTranscript(
  ['So', 'this', 'is', 'the', 'new', 'mic', 'and', 'it', 'sounds', 'warm'].map((text, i) => ({
    text,
    startSec: 0.2 + i * 0.4,
    endSec: 0.5 + i * 0.4
  })),
  's1'
)
const source = { id: 's1', path: '/take.mp4', durationSec: 5, width: 1080, height: 1920, fps: 30 }
const base = createDoc({ id: 'd', title: 't', source, words })
const ctx = { words: base.words, sources: base.sources, assets: [] }

function withOps(doc: EditDoc, ops: Op[]): EditDoc {
  const r = commit(doc, ops, 'mixed')
  expect(r.rejected).toEqual([])
  return r.doc
}

const blank = { set: [], keys: [], mute: '', solo: '', effects: '', spec: '' }

describe('Claude mixing through the plan tool', () => {
  const doc = withOps(base, [
    { op: 'clip-add', kind: 'sound', src: '/ding.wav', from: 'w3', to: '1s' },
    { op: 'music', set: { path: '/bed.mp3' } }
  ] as Op[])

  it('reads a plan of mix forms and carries each one out', () => {
    const handed = {
      ops: [
        { op: 'mix', ...blank, target: 'voice', effects: 'add', spec: '[{"kind":"highpass","freq":90},{"kind":"compressor","thresholdDb":-20,"ratio":3}]' },
        { op: 'mix', ...blank, target: 't1', set: [{ key: 'pan', value: -0.6 }, { key: 'gainDb', value: -4 }] },
        // Claude may leave out the empty slots; they are put back.
        { op: 'mix', target: 'music', keys: [{ key: 'gainDb', t: 1, v: 0 }, { key: 'gainDb', t: 2, v: -12 }], set: [], mute: '', solo: '', effects: '' }
      ],
      summary: 'The voice is cleaned up and the ding sits left.',
      reply: 'Done.',
      notesHandled: [],
      needs: [],
      question: { text: '', options: [] }
    }
    const read = readPlan(handed)
    expect(read?.unread).toBe(0)
    const ops = (read?.plan.ops ?? []).map(fromPlannerOp) as Op[]
    const r = applyOps(currentCut(doc), ops, ctx)
    expect(r.rejected).toEqual([])
    expect(r.cut.voiceMix?.effects.map((f) => f.kind)).toEqual(['highpass', 'compressor'])
    expect(r.cut.tracks?.[0].mix).toEqual({ gainDb: -4, pan: -0.6, effects: [] })
    expect(r.cut.musicMix?.gainDb).toEqual({ keys: [{ t: 1, v: 0 }, { t: 2, v: -12 }] })
  })

  it('reports a form whose effects it cannot read, and carries out the rest', () => {
    const ops = [
      { op: 'mix', ...blank, target: 'voice', effects: 'add', spec: '[{"kind":"flanger"}]' },
      { op: 'mix', ...blank, target: 'voice', mute: 'on' }
    ].map((o) => fromPlannerOp(readPlan({ ops: [o], summary: '', reply: '', notesHandled: [], needs: [], question: { text: '', options: [] } })!.plan.ops[0])) as Op[]
    const r = applyOps(currentCut(doc), ops, ctx)
    expect(r.rejected).toHaveLength(1)
    expect(r.cut.voiceMix).toMatchObject({ mute: true })
  })

  it('names the mixer and its op in the instructions, and sends its guide only when the ask or the cut needs it', () => {
    expect(PLANNER_SYSTEM).toContain('mixer: op mix sets')
    expect(FAMILY_GUIDES.map((f) => f.name)).toContain('mixer')
    const plain = renderRequest(doc, 'tighten it up and add chapters', [])
    expect(plain).not.toContain('<guide mixer>')
    expect(plain).not.toContain('<mix>')
    const asked = renderRequest(doc, 'put a little reverb on the ding', [])
    expect(asked).toContain('<guide mixer>')
    // Every strip, so the planner knows what it can mix.
    expect(asked).toMatch(/<mix>\nvoice level 0 pan 0 \| no effects\nt1 "Sound 1" level 0 pan 0 \| no effects\nmusic level 0 pan 0 \| no effects\n<\/mix>/)
    // Once mixed, every request carries the strips and the guide.
    const mixed = withOps(doc, [{ op: 'mix', target: 'voice', gainDb: -2 } as Op])
    const later = renderRequest(mixed, 'tighten it up', [])
    expect(later).toContain('<mix>\nvoice level -2 pan 0 | no effects\nt1')
    expect(later).toContain('<guide mixer>')
  })
})
