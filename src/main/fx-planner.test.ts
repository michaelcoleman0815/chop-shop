import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { applyOps, createDoc, currentCut, opsInside, resolveCut, wordsFromTranscript, type Op } from '../shared/edit'
import { effectsOf, FX_KINDS, fxNotice, planFxCommand } from '../shared/fx'
import { describePlan, describeStyle, planStyle, SKILL_PRESETS } from '../shared/presets'
import { fromPlannerOp, PLANNER_SYSTEM, PlanSchema, PlannerOpSchema, renderRequest } from './planner-prompt'

/**
 * Scene effects reach the edit in words: through the planner, whose ops for
 * them fill every slot and become the edit's own ops, and through /scan,
 * /impact, /speedlines and /bgblur, which read the words after them. A
 * version that adds one this computer cannot cut out says what it does
 * instead.
 */

const words = wordsFromTranscript(
  ['Watch', 'the', 'items', 'appear', 'then', 'I', 'fly', 'in', 'and', 'land', 'right', 'here', 'with', 'one', 'million'].map(
    (text, i) => ({ text, startSec: 0.4 + i * 0.5, endSec: 0.8 + i * 0.5 })
  ),
  's1'
)
const source = { id: 's1', path: '/game.mp4', durationSec: 9, width: 1920, height: 1080, fps: 30 }
const fresh = () => createDoc({ id: 'd', title: 'Game', source, words })
const context = (doc: ReturnType<typeof fresh>) => ({ words: doc.words, sources: doc.sources })

describe('the planner and scene effects', () => {
  it('shows an example of every effect that parses, converts and applies', () => {
    const examples = [...PLANNER_SYSTEM.matchAll(/\{"op":"fx-add"[^\n]*?\}(?=: )/g)].map((m) => JSON.parse(m[0]))
    expect(examples.map((e) => e.kind).sort()).toEqual([...FX_KINDS].sort())
    const doc = createDoc({
      id: 'g',
      title: 'g',
      source: { ...source, durationSec: 40 },
      words: wordsFromTranscript(
        Array.from({ length: 60 }, (_, i) => ({ text: `word${i + 1}`, startSec: 0.5 + i * 0.6, endSec: 0.9 + i * 0.6 })),
        's1'
      )
    })
    const ops = examples.map((e) => fromPlannerOp(PlannerOpSchema.parse(e)))
    const r = applyOps(currentCut(doc), ops as Op[], context(doc))
    expect(r.rejected).toEqual([])
    expect(effectsOf(r.cut)).toHaveLength(FX_KINDS.length)
  })

  it('takes a plan that adds, changes and removes effects, every slot filled', () => {
    const doc = fresh()
    const plan = PlanSchema.parse({
      ops: [
        { op: 'fx-add', kind: 'scan', from: 'w3', to: '', on: 'objects', at: [], style: '', color: 'caribbean', strength: 0, extra: ['flash-objects', 'sparkly'] },
        { op: 'fx-add', kind: 'impact', from: 'w10', to: '', on: 'auto', at: [], style: 'ground', color: '', strength: 1.4, extra: ['second-ring'] },
        { op: 'fx-update', id: 'x1', from: '', to: '', on: '', at: [], style: 'down', color: '', strength: 0, extra: ['none'] },
        { op: 'fx-remove', ids: ['x2'] }
      ],
      summary: 'The items scan in and the landing hits.',
      reply: 'Done.',
      notesHandled: [],
      needs: [],
      question: { text: '', options: [] }
    })
    const r = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp) as Op[], context(doc))
    expect(r.rejected).toEqual([])
    const [scan] = effectsOf(r.cut)
    expect(effectsOf(r.cut)).toHaveLength(1)
    // Changed where asked, kept where the slot was empty; an extra it does not know was dropped, then all were taken away.
    expect(scan).toMatchObject({ kind: 'scan', from: 'w3', on: 'objects', style: 'down', color: 'caribbean', extra: [] })
  })

  it('asks for every slot of an effect op, so the structured output allows it', () => {
    const schema = z.toJSONSchema(PlanSchema) as unknown as {
      properties: { ops: { items: { anyOf?: Record<string, unknown>[]; oneOf?: Record<string, unknown>[] } } }
    }
    const options = schema.properties.ops.items.anyOf ?? schema.properties.ops.items.oneOf ?? []
    const fx = options.filter((o) => {
      const op = (o as { properties?: { op?: { const?: string } } }).properties?.op?.const
      return typeof op === 'string' && op.startsWith('fx-')
    }) as { properties: Record<string, unknown>; required: string[] }[]
    expect(fx).toHaveLength(3)
    for (const o of fx) expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort())
  })

  it('tells the planner which effects the cut has', () => {
    const doc = fresh()
    const r = applyOps(currentCut(doc), [{ op: 'fx-add', kind: 'bgblur', from: 'w6', to: 'w9', style: 'motion' }], context(doc))
    const withFx = { ...doc, versions: [...doc.versions.slice(0, -1), { ...doc.versions[doc.versions.length - 1], cut: r.cut }] }
    const request = renderRequest(withFx, 'blur behind me', [])
    expect(request).toContain('<effects>')
    expect(request).toMatch(/x1 bgblur \[0:0\d-0:0\d\] from w6 to w9 \| style motion/)
  })

  it('keeps an effect off a stretch a note was not left on', () => {
    const doc = fresh()
    const cut = currentCut(doc)
    const split = applyOps(cut, [{ op: 'split', beat: cut.beats[0].id, at: 'w8' }], context(doc)).cut
    const [first, second] = split.beats.map((b) => b.id)
    const r = opsInside(split, [{ op: 'fx-add', kind: 'impact', from: 'w10' }] as Op[], [first], context(doc))
    expect(r.inside).toEqual([])
    expect(r.outside[0].reason).toMatch(/effect outside the stretch/)
    expect(opsInside(split, [{ op: 'fx-add', kind: 'impact', from: 'w10' }] as Op[], [second], context(doc)).inside).toHaveLength(1)
  })

  it('says what the version did in words', () => {
    const doc = fresh()
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    const ops: Op[] = [
      { op: 'fx-add', kind: 'scan', from: 'w3' },
      { op: 'fx-add', kind: 'speedlines', from: 'w7' }
    ] as Op[]
    const r = applyOps(currentCut(doc), ops, context(doc))
    const text = describePlan(r.applied, before, resolveCut(r.cut, doc.words, doc.sources), r.cut)
    expect(text).toBe('A pixel scan brings the objects in and speed lines rush past.')
  })
})

describe('effect commands', () => {
  const resolved = () => {
    const doc = fresh()
    return resolveCut(currentCut(doc), doc.words, doc.sources)
  }

  it('reads where it works, its style, colour, extras, strength and length', () => {
    const scan = planFxCommand('scan', 'me down cyan', { resolved: resolved(), time: null })
    expect(scan).toMatchObject({ op: { kind: 'scan', on: 'subject', style: 'down', color: 'caribbean', from: 'w1' } })
    const lines = planFxCommand('speedlines', 'across black strong 2s', { resolved: resolved(), time: null })
    expect(lines).toMatchObject({ op: { kind: 'speedlines', style: 'across', color: '#000000', strength: 1.5, to: '2s', from: 'w1' } })
  })

  it('lands on the word it names, when that is said', () => {
    const hit = planFxCommand('impact', 'ground double land', { resolved: resolved(), time: 0.5 })
    expect(hit).toMatchObject({ op: { kind: 'impact', style: 'ground', extra: ['second-ring'], from: 'w10' } })
  })

  it('says so when a word cannot be read', () => {
    const r = planFxCommand('impact', 'zigzag', { resolved: resolved(), time: 0.5 })
    expect(r).toEqual({ problem: expect.stringMatching(/^I can't place “zigzag” in an impact\. Try \/impact/) })
  })

  it('every command makes an op the edit takes', () => {
    const doc = fresh()
    for (const command of ['scan', 'impact', 'speedlines', 'bgblur']) {
      const plan = planFxCommand(command, '', { resolved: resolved(), time: 2 })
      if ('problem' in plan) throw new Error(plan.problem)
      expect(applyOps(currentCut(doc), [plan.op as Op], context(doc)).rejected).toEqual([])
    }
  })
})

describe('without cut-outs', () => {
  const none = { person: false, objects: false }
  const after = (ops: unknown[]) => {
    const doc = fresh()
    return { before: currentCut(doc), cut: applyOps(currentCut(doc), ops as Op[], context(doc)).cut }
  }

  it('says in one sentence what an effect does instead', () => {
    const scan = after([{ op: 'fx-add', kind: 'scan', from: 'w3' }])
    expect(fxNotice(scan.before, scan.cut, none)).toBe(
      'Cut-outs need Vision on a Mac, so the scan brings in the whole frame rather than each object.'
    )
    const both = after([
      { op: 'fx-add', kind: 'scan', from: 'w3', on: 'subject' },
      { op: 'fx-add', kind: 'bgblur', from: 'w6' }
    ])
    expect(fxNotice(both.before, both.cut, none)).toBe(
      'Cut-outs need Vision on a Mac, so the scan brings in the whole frame rather than you alone and the blur softens the edges and keeps the middle sharp.'
    )
  })

  it('says nothing when none is needed, or this computer has them', () => {
    const placed = after([
      { op: 'fx-add', kind: 'impact', from: 'w10', at: [0.5, 0.7] },
      { op: 'fx-add', kind: 'speedlines', from: 'w7' },
      { op: 'fx-add', kind: 'scan', from: 'w1', on: 'frame' }
    ])
    expect(fxNotice(placed.before, placed.cut, none)).toBeNull()
    const blur = after([{ op: 'fx-add', kind: 'bgblur', from: 'w6' }])
    expect(fxNotice(blur.before, blur.cut, { person: true, objects: false })).toBeNull()
  })
})

describe('the hype edit', () => {
  it('cuts fast and puts a scan at the start and speed lines into impacts on a few big cuts', () => {
    const long = createDoc({
      id: 'h',
      title: 'Hype',
      source: { ...source, durationSec: 60 },
      words: wordsFromTranscript(
        Array.from({ length: 120 }, (_, i) => ({
          text: i % 9 === 8 ? `word${i + 1}.` : `word${i + 1}`,
          startSec: 0.3 + i * 0.48,
          endSec: 0.7 + i * 0.48
        })),
        's1'
      )
    })
    const hype = SKILL_PRESETS.find((p) => p.command === 'hype')
    expect(hype?.title).toBe('Hype edit')
    const plan = planStyle(long, hype!.style)
    const r = applyOps(currentCut(long), plan.ops, context(long))
    expect(r.rejected).toEqual([])
    const fx = effectsOf(r.cut)
    expect(fx[0]).toMatchObject({ kind: 'scan', on: 'frame', from: 'w1' })
    const impacts = fx.filter((x) => x.kind === 'impact')
    const lines = fx.filter((x) => x.kind === 'speedlines')
    expect(impacts.length).toBeGreaterThanOrEqual(3)
    expect(lines).toHaveLength(impacts.length)
    // Each rush ends on the word its impact lands on, and that word opens a beat, with a whoosh and a hit on its cut.
    const resolved = resolveCut(r.cut, long.words, long.sources)
    const times: number[] = []
    for (const [i, hit] of impacts.entries()) {
      expect(lines[i]).toMatchObject({ from: `${hit.from}-0.8`, to: hit.from })
      const rb = resolved.beats.find((b) => b.words[0] === hit.from)
      expect(rb).toBeDefined()
      const kinds = (r.cut.beats[rb!.index].sfx ?? []).map((e) => e.kind)
      expect(kinds).toEqual(expect.arrayContaining(['whoosh', 'hit']))
      times.push(rb!.outStart)
    }
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(6)
    expect(times[0]).toBeGreaterThanOrEqual(2.5)
    expect(describeStyle(hype!.style)).toContain('Impacts on the big moments')
  })
})
