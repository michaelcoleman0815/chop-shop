import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nowhere' }, safeStorage: {} }))

import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../shared/edit'
import { planMotionCommand } from '../shared/motion'
import { offerPlan } from './planner'
import { PLANNER_SYSTEM, PlanSchema } from './planner-prompt'

/**
 * Maps: "/map Iceland" from the composer, read on this computer, and a map
 * asked for in words ("show where Iceland is"), which Claude plans like any
 * other request: as the map graphic, or as /map run by the plan. Both put
 * the map on the word that names the place, and ask rather than guess when
 * a name is two places.
 */

const said = 'This summer we drove right round Iceland and it was nothing like the pictures'.split(' ')
const doc = createDoc({
  id: 'd1',
  title: 'trip',
  source: { id: 's1', path: '/Users/you/Movies/trip.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 },
  words: wordsFromTranscript(
    said.map((text, i) => ({ text, startSec: 0.3 + i * 0.45, endSec: 0.65 + i * 0.45 })),
    's1'
  )
})
const ctx = { doc, resolved: resolveCut(currentCut(doc), doc.words, doc.sources), time: null, brandName: '' }

describe('/map', () => {
  it('puts the map on the word that names the place, with where its facts come from behind Details', () => {
    const r = planMotionCommand('map', 'Iceland', ctx)
    if ('problem' in r) throw new Error(r.problem)
    expect(r.op).toMatchObject({ op: 'motion-add', kind: 'map', text: ['Iceland'], from: 'w7', style: '' })
    expect(r.details.map((d) => d.label)).toEqual(expect.arrayContaining(['Area', 'Map data']))
    expect(r.details.find((d) => d.label === 'Area')?.value).toContain('The World Factbook')
  })

  it('reads a look, a corner and a route', () => {
    expect(planMotionCommand('map', 'vintage from Lisbon to Rio', ctx)).toMatchObject({
      op: { kind: 'map', style: 'vintage', text: ['from Lisbon to Rio'] }
    })
    expect(planMotionCommand('map', 'Iceland in the corner', ctx)).toMatchObject({ op: { kind: 'map', place: 'top-right' } })
  })

  it('asks which place a shared name means, and for a place when there is none', () => {
    expect(planMotionCommand('map', 'Georgia', ctx)).toEqual({ problem: expect.stringContaining('Georgia the country or the US state?') })
    expect(planMotionCommand('map', '', ctx)).toEqual({ problem: 'Tell me the place, like /map Iceland.' })
    expect(planMotionCommand('map', 'Atlantis', ctx)).toEqual({ problem: expect.stringContaining('find "Atlantis" on the map') })
  })
})

describe('a map asked for in words', () => {
  // What Claude plans for "show where Iceland is", in the plan's own shape.
  const plan = (ops: unknown[]) =>
    PlanSchema.parse({
      ops,
      summary: 'A map of Iceland comes in.',
      reply: 'A map of Iceland comes in as you name it.',
      notesHandled: [],
      needs: [],
      question: { text: '', options: [] }
    })

  it('is a graphic Claude is taught, with where it goes and how to name a place', () => {
    expect(PLANNER_SYSTEM).toContain('- map: A documentary map shot')
    expect(PLANNER_SYSTEM).toContain('"op":"motion-add","kind":"map"')
  })

  it('is offered as Claude plans it: the map on the word that names the place', () => {
    const map = { op: 'motion-add', kind: 'map', from: 'w7', to: '', text: ['Iceland'], items: [], values: [], box: [], icon: '', style: '', place: '', color: '', fx: [] }
    const r = offerPlan(doc, plan([map]), [])
    if (!r.ok) throw new Error(r.message)
    expect(r.ops).toEqual([expect.objectContaining({ op: 'motion-add', kind: 'map', from: 'w7', text: ['Iceland'] })])
    // The op is one the edit takes.
    expect(() => commit(doc, r.ops, r.summary)).not.toThrow()
  })

  it('or as /map, run by the plan the way it runs when typed', () => {
    const r = offerPlan(doc, plan([{ op: 'run', command: 'map', rest: 'Iceland', note: '' }]), [], [
      { command: 'map', summary: 'Fly in to a place on a dark satellite map: /map Iceland' }
    ])
    if (!r.ok) throw new Error(r.message)
    expect(r.steps).toEqual([{ command: { op: 'run', command: 'map', rest: 'Iceland', note: '' } }])
  })
})
