import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { describe, expect, it } from 'vitest'
import { addNote, applyOps, commit, createDoc, currentCut, wordsFromTranscript, OpSchema } from '../shared/edit'
import { templates } from '../shared/motion'
import { PLANNER_SYSTEM, PlanSchema, renderRequest, renderTranscript, withRealIcons } from './planner-prompt'

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

  it('teaches every graphic there is, with an example that parses and applies', () => {
    expect(PLANNER_SYSTEM).toContain('## Graphics')
    // A longer recording, so every example's anchors exist.
    const long = createDoc({
      id: 'g',
      title: 'g',
      source: { ...source, durationSec: 40 },
      words: wordsFromTranscript(
        Array.from({ length: 40 }, (_, i) => ({
          text: `word${i + 1}`,
          startSec: 0.5 + i * 0.6,
          endSec: 0.9 + i * 0.6
        })),
        's1'
      )
    })
    const examples = [...PLANNER_SYSTEM.matchAll(/\{"op":"motion-add"[^\n]*?\}(?=: )/g)].map((m) => JSON.parse(m[0]))
    const kinds = templates()
      .map((t) => t.kind)
      .filter((k) => k !== 'layers')
    expect(examples.map((e) => e.kind).sort()).toEqual([...kinds].sort())
    for (const kind of kinds) expect(PLANNER_SYSTEM).toContain(`\n- ${kind}: `)
    const r = applyOps(currentCut(long), examples, { words: long.words, sources: long.sources })
    expect(r.rejected).toEqual([])
    expect(r.applied).toHaveLength(examples.length)
  })

  it('accepts graphics in a plan, and they pass the dry run', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const slots = { to: '', items: [], values: [], icon: '', place: '', color: '', fx: [] }
    const plan = PlanSchema.parse({
      ops: [
        { op: 'motion-add', kind: 'callout', from: 'w9', text: ['Settings'], box: [], style: 'spec', ...slots },
        { op: 'motion-update', id: 'm1', from: '', text: [], box: [0.5, 0.4], style: '', ...slots },
        { op: 'motion-remove', ids: ['m1'] }
      ],
      summary: 'A callout points at the settings, then goes.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const r = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    expect(r.applied.map((o) => o.op)).toEqual(['motion-add', 'motion-update', 'motion-remove'])
  })

  it('shows the cut’s graphics in the request', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = commit(doc, [{ op: 'motion-add', kind: 'callout', from: 'w9', text: ['Settings'], style: 'circle' }], 'x').doc
    const text = renderRequest(doc, 'Make it an arrow', [])
    expect(text).toContain('<graphics>\nm1 callout [0:02-0:04] from w9 | text "Settings" | style circle\n</graphics>')
  })

  it('makes icon names real before the dry run', async () => {
    const [kept, fixed, none] = await withRealIcons([{ icon: 'camera' }, { icon: 'a camera' }, { icon: '' }])
    expect(kept.icon).toBe('camera')
    expect(fixed.icon).toBe('camera')
    expect(none.icon).toBe('')
  })

  it('keeps the plan’s schema inside the limits of structured output', () => {
    // Claude's structured output allows at most 24 optional and 16 union-typed
    // parameters in all, and no recursion. Every slot of a graphic is required for this.
    const schema = (betaZodOutputFormat(PlanSchema) as unknown as { schema: unknown }).schema
    let optional = 0
    let unions = 0
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
        const required = new Set((n.required as string[] | undefined) ?? [])
        for (const [k, v] of Object.entries(n.properties as Record<string, Record<string, unknown>>)) {
          if (!required.has(k)) optional++
          if (Array.isArray(v.anyOf) || Array.isArray(v.oneOf) || Array.isArray(v.type)) unions++
        }
      }
      if (n.type === 'array' && n.items && Array.isArray((n.items as Record<string, unknown>).anyOf)) unions++
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(schema)
    expect(optional).toBeLessThanOrEqual(24)
    expect(unions).toBeLessThanOrEqual(16)
    expect(JSON.stringify(schema)).not.toContain('$ref')
  })
})
