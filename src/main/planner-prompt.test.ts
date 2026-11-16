import { describe, expect, it } from 'vitest'
import { addNote, commit, createDoc, currentCut, wordsFromTranscript, OpSchema } from '../shared/edit'
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

  it('carries what has been learned about the creator in a block of its own, only when there is some', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const learned = ['You undo zoom punch-ins (3 of 4)', 'Captions at chest height (every edit)']
    const text = renderRequest(doc, 'tighten it', [], 'Warm and quick.', learned)
    expect(text).toContain(
      '<creator-preferences>\n- You undo zoom punch-ins (3 of 4)\n- Captions at chest height (every edit)\n</creator-preferences>'
    )
    // After the brand voice, before the request.
    expect(text.indexOf('<brand-voice>')).toBeLessThan(text.indexOf('<creator-preferences>'))
    expect(text.indexOf('<creator-preferences>')).toBeLessThan(text.indexOf('<request>'))
    expect(renderRequest(doc, 'tighten it', [], '', [])).not.toContain('creator-preferences')
    expect(renderRequest(doc, 'tighten it', [])).not.toContain('creator-preferences')
    expect(PLANNER_SYSTEM).toContain('<creator-preferences>')
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
