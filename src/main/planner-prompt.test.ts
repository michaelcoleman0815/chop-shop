import { describe, expect, it } from 'vitest'
import { addNote, applyOps, commit, createDoc, currentCut, wordsFromTranscript, OpSchema } from '../shared/edit'
import { PLANNER_SYSTEM, PlanSchema, renderRequest, renderTranscript } from './planner-prompt'

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

describe('the planner request', () => {
  it('lists every word with its id, a sentence per line', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderTranscript(doc)).toBe(
      [
        '<source id="s1" length="0:12">',
        "[0:00.5] w1 So | w2 here's | w3 the | w4 thing.",
        '[0:02.4] w5 Um | w6 most | w7 people | w8 never | w9 open | w10 the | w11 settings.',
        '</source>'
      ].join('\n')
    )
  })

  it('describes the cut, its looks, struck words and the notes', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = commit(
      doc,
      [
        { op: 'strike', from: 'w5', to: 'w5' },
        { op: 'treat', beats: ['b2'], set: { bw: true, bigWord: 'w11' } }
      ],
      'x'
    ).doc
    doc = addNote(doc, 'Make this one punchier.', 'b2')
    const text = renderRequest(doc, '', doc.notes)
    expect(text).toContain('<cut version 2; runs 0:04;')
    expect(text).toContain('b1 [0:00-0:01] speaker | w1-w4 "So ... thing."')
    expect(text).toContain('b2 [0:01-0:04] speaker, bw, big word w11 | w5-w11 "Um ... settings." | struck w5')
    expect(text).toContain('n1 (left on b2): Make this one punchier.')
    expect(text.endsWith('Carry out the notes.')).toBe(true)
    expect(currentCut(doc).removed).toEqual(['w5'])
  })

  it('fences a typed request so it reads as a request', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(doc, 'Open on the settings line', [])).toMatch(
      /<request>\nOpen on the settings line\n<\/request>$/
    )
  })

  it('documents ops the real schema accepts', () => {
    // Every example op in the instructions must be a valid op, or the model
    // is being taught something the document will reject.
    const examples = [...PLANNER_SYSTEM.matchAll(/\{"op":[^\n]*?\}(?=: |\. | or |\.$|$)/gm)].map((m) => m[0])
    expect(examples.length).toBeGreaterThanOrEqual(10)
    for (const json of examples) {
      if (json.includes('...')) continue
      expect(OpSchema.safeParse(JSON.parse(json)).success, json).toBe(true)
    }
  })

  it('teaches transitions and fades, and every one of them applies', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source,
      words: [...words, ...wordsFromTranscript([{ text: 'Done.', startSec: 6, endSec: 6.4 }], 's1', 'x')]
    })
    expect(PLANNER_SYSTEM).toContain('{"op":"transition"')
    expect(PLANNER_SYSTEM).toContain('{"op":"fade"')
    const plan = PlanSchema.parse({
      ops: [
        { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.5 },
        { op: 'transition', beats: ['b2'], kind: 'whip-left' },
        { op: 'transition', beats: ['b2'], kind: 'cut' },
        { op: 'transition', beats: ['b2'], kind: 'dip-to-white', sec: 0.8 },
        { op: 'fade', inSec: 0.5, outSec: 1, color: 'black' }
      ],
      summary: 'Beat 2 dips through white and the video fades in and out.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.applied).toHaveLength(5)
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain('comes in with dip-to-white 0.8 s')
    expect(text).toContain('fades in over 0.5 s and out over 1.0 s through black')
  })

  it('teaches J and L cuts, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"jcut"')
    expect(PLANNER_SYSTEM).toContain('{"op":"lcut"')
    const plan = PlanSchema.parse({
      ops: [
        { op: 'lcut', beats: ['b2'], sec: 0.3 },
        { op: 'jcut', beats: ['b2'], sec: 0.4 },
        { op: 'jcut', beats: ['b2'], sec: 0 },
        { op: 'lcut', beats: ['b2'], sec: 0.25 }
      ],
      summary: 'Beat 2 comes in on an L cut.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.beats[1].splitEdit).toEqual({ kind: 'l', sec: 0.25 })
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    expect(renderRequest(after, '', [])).toContain('L cut in, 0.25 s')
  })

  it('teaches speed, freeze frames and reverse, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    for (const op of ['speed', 'freeze', 'reverse']) expect(PLANNER_SYSTEM).toContain(`{"op":"${op}"`)
    const plan = PlanSchema.parse({
      ops: [
        { op: 'speed', beats: ['b1'], speed: 1.2 },
        { op: 'speed', beats: ['b2'], speed: 0.5, ramp: { inSec: 0.4, outSec: 0.4 } },
        { op: 'freeze', beat: 'b2', word: 'w7', sec: 1 },
        { op: 'reverse', beats: ['b1'], on: true }
      ],
      summary: 'Beat 2 slows down.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain('speed 1.2x, backwards')
    expect(text).toContain('speed 0.5x, easing in over 0.4 s and out over 0.4 s, freezes on w7 for 1.0 s')
  })

  it('teaches camera moves, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"camera"')
    const plan = PlanSchema.parse({
      ops: [
        { op: 'camera', beats: ['b1'], move: { kind: 'drift' } },
        { op: 'camera', beats: ['b2'], move: { kind: 'punch-in', word: 'w7', zoom: 1.2 } },
        {
          op: 'camera',
          beats: ['b2'],
          move: { kind: 'focus', regions: [{ at: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.25 }] }
        },
        { op: 'camera', beats: ['b1'], move: null }
      ],
      summary: 'Beat 2 moves in on the settings.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.beats[0].treatment.camera).toBeUndefined()
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    expect(renderRequest(after, '', [])).toContain('camera focus on 1 region')
  })

  it('accepts a plan shaped like the instructions say', () => {
    const plan = {
      ops: [
        { op: 'move', beat: 'b2', to: 0 },
        { op: 'treat', beats: ['b2'], set: { zoom: 1.12 } }
      ],
      summary: 'The settings line opens it now.',
      reply: 'Moved it to the front and punched in.',
      notesHandled: ['n1'],
      needs: []
    }
    expect(PlanSchema.safeParse(plan).success).toBe(true)
  })
})
