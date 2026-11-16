import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addNote,
  applyOps,
  commit,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  OpSchema
} from '../shared/edit'
import { docFor } from '../shared/raw/eval'
import { FIXTURES } from '../shared/raw/fixtures'
import { planTakes, takesOf, switchTakeOps } from '../shared/raw/plan'
import { offerPlan } from './planner'
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
        '<source id="s1" file="take.mov" length="0:12">',
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

  it('lists the takes, and a swap of takes is a plan the document accepts', () => {
    const f = FIXTURES.find((x) => x.name === 'the intro redone after a run of other lines')
    if (!f) throw new Error('fixture missing')
    const { doc: raw } = docFor(f)
    const doc = commit(raw, planTakes(raw).ops, 'Takes.').doc
    const text = renderRequest(doc, 'Use the first take of the intro.', [])
    const block = /<takes>\n([\s\S]*?)\n<\/takes>/.exec(text)?.[1] ?? ''
    expect(block).toMatch(/^g1 the intro, 2 takes: 1 w1-w\d+ struck \| 2 w\d+-w\d+ plays$/)
    expect(text.indexOf('<takes>')).toBeGreaterThan(text.indexOf('</cut>'))
    expect(PLANNER_SYSTEM).toContain('unstrike that take')

    // The plan a planner should return for the request.
    const group = takesOf(doc)[0].groups[0]
    const ops = switchTakeOps(doc, group, 0)
    const plan = { ops, summary: 'The first take of the intro plays now.', reply: 'Done.', notesHandled: [], needs: [] }
    expect(PlanSchema.safeParse(plan).success).toBe(true)
    for (const op of ops) expect(OpSchema.safeParse(op).success, JSON.stringify(op)).toBe(true)
    const dry = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    const spoken = resolveCut(dry.cut, doc.words, doc.sources).words.map((w) => w.text)
    expect(spoken.slice(0, 4).join(' ')).toBe('Hey everyone, welcome back.')
    expect(spoken.filter((w) => w === 'Hey').length).toBe(1)
  })

  it('tells the planner what the recording sounds like, when it was heard', () => {
    const plain = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(plain, 'x', [])).not.toContain('<sound>')
    const heard = {
      ...plain,
      audio: {
        s1: {
          v: 1 as const,
          words: { w8: [-12, 190] as [number, number | null] },
          segments: [
            { kind: 'speech' as const, startSec: 0.5, endSec: 4.9 },
            { kind: 'laughter' as const, startSec: 5.2, endSec: 6.4 }
          ],
          emphasis: ['w8'],
          level: { floor: -60, speech: -20 }
        }
      }
    }
    expect(renderRequest(heard, 'x', [])).toContain('<sound>\nlaughter 0:05-0:06\nstressed: w8 "never"\n</sound>')
    expect(PLANNER_SYSTEM).toContain('A <sound> block')
  })

  it('leaves the takes out when there are none', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(doc, 'x', [])).not.toContain('<takes>')
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

describe('several recordings and material', () => {
  const second = { id: 's2', path: '/Users/me/MVI_9294.MP4', durationSec: 8, width: 1920, height: 1080, fps: 30 }
  const sound = { path: '/Users/me/2026-10-16 20-49-09.mp4', offsetSec: 3.42 }

  it('names each recording, and the file its sound comes from', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      sources: [{ ...source, audio: sound }, second],
      words
    })
    const text = renderTranscript(doc)
    expect(text).toContain('<source id="s1" file="take.mov" length="0:12" sound="2026-10-16 20-49-09.mp4">')
    expect(text).toContain('<source id="s2" file="MVI_9294.MP4" length="0:08">')
  })

  it('lists the material, where it shows, and teaches a cutaway the document accepts', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = addAsset(doc, {
      kind: 'video',
      path: '/Users/me/MVI_9294.MP4',
      title: 'MVI_9294',
      durationSec: 10,
      width: 1920,
      height: 1080,
      origin: { type: 'file', url: null, author: null, license: null, range: null }
    }).doc
    expect(renderRequest(doc, 'place it', [])).toContain('a1 video 1920x1080, 10.0 s: MVI_9294 | not in the cut yet')
    const plan = PlanSchema.parse({
      ops: [{ op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { asset: 'a1', inSec: 1.5 } } }],
      summary: 'MVI_9294 cuts in on b2.',
      reply: 'I put MVI_9294 over b2, s1 still plays under it.',
      notesHandled: [],
      needs: ['a second angle for w6-w8'],
      brollWanted: [{ beat: 'b2', search: 'settings menu on a phone' }]
    })
    const offered = offerPlan(doc, plan, [])
    if (!offered.ok) throw new Error('expected a plan')
    expect(offered.ops).toEqual([
      {
        op: 'treat',
        beats: ['b2'],
        set: { frame: 'broll', broll: { path: '/Users/me/MVI_9294.MP4', inSec: 1.5, muted: true } }
      }
    ])
    // No ids reach the person.
    expect(offered.summary).toBe('MVI_9294 cuts in on beat 2.')
    expect(offered.reply).toBe('I put MVI_9294 over beat 2, take.mov still plays under it.')
    expect(offered.needs).toEqual(['A second angle for “most … never”.'])
    expect(offered.brollWanted).toEqual([{ beat: 'b2', search: 'settings menu on a phone' }])
    const shown = commit(doc, offered.ops, offered.summary).doc
    expect(renderRequest(shown, '', [])).toContain('cutaway a1 from 1.5 s')
    expect(renderRequest(shown, '', [])).toContain('| shown on b2')
  })

  it('leaves out a cutaway to material that does not exist, in one plain sentence', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const plan = PlanSchema.parse({
      ops: [
        { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { asset: 'a9', inSec: 0 } } },
        { op: 'remove', beats: ['b7'] }
      ],
      summary: 's',
      reply: 'r',
      notesHandled: [],
      needs: []
    })
    const offered = offerPlan(doc, plan, [])
    if (!offered.ok) throw new Error('expected a plan')
    expect(offered.ops).toEqual([])
    expect(offered.rejected).toEqual(['2 changes did not fit the cut, so I left them out.'])
    expect(offered.brollWanted).toEqual([])
  })
})
