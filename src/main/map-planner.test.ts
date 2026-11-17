import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nowhere' }, safeStorage: {} }))

import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type Note } from '../shared/edit'
import { planMotionCommand } from '../shared/motion'
import { planMapRequest } from './planner'

/**
 * Maps asked for in words: "/map Iceland" from the composer, and a plain
 * request that names nothing but places, which needs no model. Both put the
 * map on the word that names the place, and ask rather than guess when a
 * name is two places.
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

describe('a request for a map in plain words', () => {
  it('places it on the word, with no model', () => {
    const r = planMapRequest(doc, 'show where Iceland is', [])
    expect(r).toMatchObject({ ok: true, reply: 'A map of Iceland comes in as the place is named.' })
    if (!r?.ok) throw new Error('no plan')
    expect(r.ops).toEqual([expect.objectContaining({ op: 'motion-add', kind: 'map', from: 'w7' })])
    // The op is one the edit takes.
    expect(() => commit(doc, r.ops, r.summary)).not.toThrow()
  })

  it('puts a place that is never said at the start, and says so', () => {
    const r = planMapRequest(doc, 'show where Norway is', [])
    expect(r).toMatchObject({ ok: true, reply: expect.stringContaining('comes in at the start, since the place is never said') })
  })

  it('asks rather than guesses which Georgia, and leaves anything more to the planner', () => {
    expect(planMapRequest(doc, 'show where Georgia is', [])).toMatchObject({ ok: true, ops: [], reply: expect.stringContaining('Georgia the country or the US state?') })
    expect(planMapRequest(doc, 'cut the intro and show where Iceland is', [])).toBeNull()
    const notes: Note[] = [{ id: 'n1', text: 'Tighten the start.', beat: 'b1', status: 'open', version: 1 }]
    expect(planMapRequest(doc, 'show where Iceland is', notes)).toBeNull()
  })
})
