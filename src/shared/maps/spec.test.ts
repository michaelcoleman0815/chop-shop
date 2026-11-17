import { describe, expect, it } from 'vitest'
import { ease } from '../motion/ease'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../edit'
import { buildScene, DEFAULT_THEME, MotionCallSchema, template, type MapLayer } from '../motion'
import { creditsText } from '../assets'
import { mapCredits, mapDetails, mapProblem, readMapCommand } from './command'
import { decodePlates } from './geo'
import { platesFromGeoJson } from './plates'
import { mapRequest } from './request'
import { mapShot, mapShotLayers } from './shot'
import { FLY } from './camera'
import { specFor, timeline } from './spec'
import { STANDIN_BOUNDARIES, STANDIN_PLATES } from './standin'
import { MAP_SOURCES } from './sources'

describe('a map shot from a place and a length', () => {
  it('builds Iceland: the camera, the outline, the Arctic Circle, the name and its area', () => {
    const shot = mapShot('Iceland', 6)
    if (!shot.ok) throw new Error(shot.problem)
    expect(shot.call).toMatchObject({ kind: 'map', from: 'start', to: '6s', text: ['Iceland'], style: 'satellite-dark' })
    // It is an ordinary graphic call.
    expect(MotionCallSchema.safeParse(shot.call).success).toBe(true)
    const { spec } = shot
    expect(spec.stops).toHaveLength(1)
    expect(spec.open).toBe('world')
    expect(spec.features).toContainEqual(expect.objectContaining({ type: 'area', ref: { country: 'ISL' }, tone: 'accent' }))
    expect(spec.features).toContainEqual(expect.objectContaining({ type: 'line', look: 'parallel', label: 'Arctic Circle' }))
    expect(spec.titles).toEqual([expect.objectContaining({ name: 'Iceland', facts: [expect.objectContaining({ text: '39,800 mi² (103,000 km²)' })] })])
    expect(spec.sources).toEqual(expect.arrayContaining(['naturalearth', 'nasa', 'factbook']))
    expect(shot.details[0].value).toContain('The World Factbook')
    expect(shot.credits.some((c) => c.includes('NASA'))).toBe(true)
  })

  it('times the shot: what it came for draws on as the camera settles, not after it stops, all inside the length', () => {
    const { spec } = mapShot('Iceland', 6) as Extract<ReturnType<typeof mapShot>, { ok: true }>
    const [stop] = spec.stops
    expect(stop.arrive).toBeGreaterThan(1)
    expect(stop.arrive).toBeLessThan(3.1)
    expect(stop.leave).toBe(6)
    // How far the camera has come at a moment of its flight in.
    const along = (t: number): number => ease(FLY, t / stop.arrive)
    const outline = spec.features.find((f) => f.type === 'area')!
    // The outline starts once the camera is nearly there and before it has stopped: no dead air between.
    expect(along(outline.show.from)).toBeGreaterThan(0.85)
    expect(outline.show.from).toBeLessThan(stop.arrive - 0.5)
    // The name follows once the camera is all but down; everything else after the outline.
    expect(along(spec.titles[0].show.from)).toBeGreaterThan(0.95)
    for (const f of spec.features) {
      expect(f.show.from).toBeGreaterThanOrEqual(outline.show.from)
      expect(f.show.to).toBeLessThanOrEqual(6)
    }
    // Stops one after another share the time without overlapping.
    const t = timeline(8, 2)
    expect(t[0].leave).toBeLessThan(t[1].arrive)
    expect(t[1].leave).toBe(8)
  })

  it('brings the names round a place in a wave that closes up, the best known first', () => {
    const { spec } = mapShot('France', 6) as Extract<ReturnType<typeof mapShot>, { ok: true }>
    const starts = spec.features.filter((f) => f.type === 'label' && f.look === 'neighbour').map((f) => f.show.from)
    expect(starts.length).toBeGreaterThan(3)
    const gaps = starts.slice(1).map((s, i) => s - starts[i])
    expect(gaps.every((g) => g > 0)).toBe(true)
    // Not a metronome: each gap no longer than the one before, and the whole wave inside a third of a second.
    expect(gaps.every((g, i) => i === 0 || g <= gaps[i - 1] + 1e-9)).toBe(true)
    expect(starts[starts.length - 1] - starts[0]).toBeLessThan(0.3)
  })

  it('draws a route between two cities with a pin at each end, the far pin landing with the arrow', () => {
    const shot = mapShot('from Lisbon to Rio', 6)
    if (!shot.ok) throw new Error(shot.problem)
    const pins = shot.spec.features.filter((f) => f.type === 'pin')
    expect(pins.map((p) => (p.type === 'pin' ? p.label : ''))).toEqual(['Lisbon', 'Rio de Janeiro'])
    const route = shot.spec.features.find((f) => f.type === 'line' && f.look === 'route')!
    // The line takes 1.1 seconds to draw; the far pin comes as it gets there.
    expect(pins[1].show.from).toBeCloseTo(route.show.from + 1.1, 5)
    // The title wraps between the names, never inside one: "Lisbon to / Rio de Janeiro".
    expect(shot.spec.titles[0].name.split(' ')).toEqual(['Lisbon', 'to', 'Rio de Janeiro'])
  })

  it('draws the Mid-Atlantic Ridge between the plates named, and names them', () => {
    const shot = mapShot('the Mid-Atlantic Ridge between the North American and Eurasian plates', 6)
    if (!shot.ok) throw new Error(shot.problem)
    const line = shot.spec.features.find((f) => f.type === 'line' && f.look === 'ridge')
    expect(line?.type === 'line' && 'boundary' in line.ref ? line.ref.boundary.pairs : null).toEqual([['NA', 'EU']])
    const plates = shot.spec.features.filter((f) => f.type === 'label' && f.look === 'plate').map((f) => (f.type === 'label' ? f.text : ''))
    expect(plates).toEqual(['North American Plate', 'Eurasian Plate'])
    expect(shot.spec.titles[0]).toMatchObject({ name: 'Mid-Atlantic Ridge', sub: 'Between the North American and Eurasian plates' })
    // PB2002's licence asks to be credited, first.
    expect(shot.credits[0]).toContain('Bird')
    expect(shot.credits[0]).toContain('Open Data Commons Attribution License')
    // With no plates named, the whole ridge and the four plates round it.
    const all = mapShot('show the Mid-Atlantic Ridge between the plates', 6)
    if (!all.ok) throw new Error(all.problem)
    const pairs = all.spec.features.find((f) => f.type === 'line' && f.look === 'ridge')
    expect(pairs?.type === 'line' && 'boundary' in pairs.ref ? pairs.ref.boundary.pairs.length : 0).toBe(3)
  })

  it('asks which Georgia, with the choices', () => {
    const shot = mapShot('Georgia', 6)
    expect(shot.ok).toBe(false)
    if (shot.ok) return
    expect(shot.problem).toBe('Georgia the country or the US state?')
    expect(shot.options).toEqual(['Georgia (country)', 'Georgia (US state)'])
    expect(mapShot('Georgia, US state', 6).ok).toBe(true)
  })

  it('chains a shot from the one before: it opens where that one ended', () => {
    const iceland = mapShot('Iceland', 6)
    if (!iceland.ok) throw new Error(iceland.problem)
    const norway = mapShot('Norway', 6, { after: iceland })
    if (!norway.ok) throw new Error(norway.problem)
    expect(norway.spec.open).toEqual(iceland.lastBox)
    expect(norway.call.values).toEqual([...iceland.lastBox])
  })

  it('is drawn the same way as a graphic in a cut as on its own', () => {
    const shot = mapShot('Iceland', 6)
    if (!shot.ok) throw new Error(shot.problem)
    const source = { id: 's1', path: '/x.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 }
    // Long enough for the whole six seconds of map after the word Iceland.
    const said = 'We flew to Iceland last week and it was cold and dark and wet but the light was something else'.split(' ')
    const words = wordsFromTranscript(
      said.map((text, i) => ({ text, startSec: 0.5 + i * 0.5, endSec: 0.9 + i * 0.5 })),
      's1'
    )
    const doc = commit(createDoc({ id: 'd', title: 't', source, words }), [{ op: 'motion-add', ...shot.call, from: 'w4' }], 'map').doc
    const cut = currentCut(doc)
    const scene = buildScene({ cut, resolved: resolveCut(cut, words, [source]), words, size: { width: 1920, height: 1080 }, theme: DEFAULT_THEME })
    expect(scene.hidden).toEqual([])
    const fromCut = scene.items[0].layers.find((l): l is MapLayer => l.kind === 'map') as MapLayer
    // On the edit it starts a tenth of a second early, as every graphic's entrance does; the same length alone draws the same.
    const same = mapShot('Iceland', fromCut.end - fromCut.start)
    if (!same.ok) throw new Error(same.problem)
    const alone = mapShotLayers(same, { width: 1920, height: 1080 }).find((l): l is MapLayer => l.kind === 'map') as MapLayer
    expect(fromCut.map.stops).toEqual(alone.map.stops)
    expect(fromCut.map.features).toEqual(alone.map.features)
    // A full-frame map holds the captions, as a card does; one in a corner does not.
    expect(scene.items[0].covers).toBe('card')
    expect(template('map')?.coversFor?.(MotionCallSchema.parse({ ...shot.call, place: 'top-right' }))).toBeUndefined()
  })

  it('never shows a figure a call writes: facts come only from the table', () => {
    const r = specFor('Iceland', { duration: 6 })
    if (!r.ok) throw new Error(r.problem)
    const source = { id: 's1', path: '/x.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 }
    const said = 'Iceland is an island in the north of the Atlantic with more sheep than people'.split(' ')
    const words = wordsFromTranscript(said.map((text, i) => ({ text, startSec: 0.5 + i * 0.5, endSec: 0.9 + i * 0.5 })), 's1')
    const doc = commit(
      createDoc({ id: 'd', title: 't', source, words }),
      [{ op: 'motion-add', kind: 'map', from: 'w1', text: ['Iceland', 'population 9 million'] }],
      'x'
    ).doc
    const cut = currentCut(doc)
    const scene = buildScene({ cut, resolved: resolveCut(cut, words, [source]), words, size: { width: 1920, height: 1080 }, theme: DEFAULT_THEME })
    // The words ask for the population; the figure is the table's, never the call's.
    const texts = JSON.stringify(scene.layers)
    expect(texts).not.toContain('9 million')
    expect(texts).toContain('Population 332,000 (2015 estimate)')
  })

  it('says why a map cannot be drawn', () => {
    expect(template('map')?.check(MotionCallSchema.parse({ kind: 'map', from: 'start', text: [] }))).toBe('A map needs a place, like /map Iceland.')
    expect(template('map')?.check(MotionCallSchema.parse({ kind: 'map', from: 'start', text: ['Atlantis'] }))).toBe('I could not find Atlantis on the map.')
    expect(template('map')?.check(MotionCallSchema.parse({ kind: 'map', from: 'start', text: ['Iceland'], style: 'neon' }))).toMatch(/satellite-dark or vintage/)
  })
})

describe('/map and map requests in words', () => {
  it('reads a style, a place in the frame and facts out of the words', () => {
    expect(readMapCommand('Iceland')).toEqual({ query: 'Iceland', style: '', place: '', facts: null })
    expect(readMapCommand('vintage Iceland with its population')).toEqual({ query: 'Iceland', style: 'vintage', place: '', facts: ['population'] })
    expect(readMapCommand('Iceland in the top right corner')).toMatchObject({ query: 'Iceland', place: 'top-right' })
    expect(readMapCommand('Iceland, no facts').facts).toEqual([])
    expect(mapProblem('Georgia')).toBe('Georgia the country or the US state? Say /map Georgia, the country, or /map Georgia, US state.')
    expect(mapProblem('')).toBe('Tell me the place, like /map Iceland.')
  })

  const source = { id: 's1', path: '/x.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 }
  const said = 'The Mid-Atlantic Ridge runs right through Iceland and it is still spreading'.split(' ')
  const words = wordsFromTranscript(said.map((text, i) => ({ text, startSec: 0.4 + i * 0.4, endSec: 0.7 + i * 0.4 })), 's1')
  const doc = createDoc({ id: 'd', title: 't', source, words })

  it('takes "show where Iceland is" as a map on the word Iceland', () => {
    const r = mapRequest(doc, 'show where Iceland is')
    // The graphic keeps the places part of the request, as a person would have typed it into its Place field.
    expect(r).toMatchObject({ kind: 'map', said: true, call: { kind: 'map', text: ['Iceland'], from: 'w7' }, name: 'a map of Iceland' })
    expect(mapRequest(doc, 'where is Iceland?')).toMatchObject({ call: { text: ['Iceland'] } })
    expect(mapRequest(doc, 'show me a map of Iceland please')).toMatchObject({ call: { text: ['Iceland'] } })
  })

  it('takes the ridge between the plates as a map, on the word that names it', () => {
    const r = mapRequest(doc, 'show the Mid-Atlantic Ridge between the plates')
    expect(r).toMatchObject({
      kind: 'map',
      said: true,
      call: { from: 'w2', text: ['the Mid-Atlantic Ridge between the plates'] },
      name: 'a map of the Mid-Atlantic Ridge'
    })
  })

  it('leaves a request that asks for more than a map to the planner', () => {
    expect(mapRequest(doc, 'cut the intro and show where Iceland is')).toBeNull()
    expect(mapRequest(doc, 'make the captions bigger')).toBeNull()
    expect(mapRequest(doc, 'Iceland')).toBeNull()
  })

  it('asks which Georgia rather than guessing', () => {
    expect(mapRequest(doc, 'show where Georgia is')).toEqual({ kind: 'problem', problem: expect.stringContaining('Georgia the country or the US state?') })
  })

  it('puts the facts’ source and the data behind Details', () => {
    const rows = mapDetails(['Iceland'], '', [])
    expect(rows[0]).toEqual({ label: 'Area', value: '103,000 sq km, from The World Factbook, Central Intelligence Agency (July 2015 estimates), public domain' })
    expect(rows.map((r) => r.label)).toEqual(['Area', 'Map data', 'Satellite pictures'])
  })
})

describe('credits for the data a map draws on', () => {
  it('lists the plate data, whose licence asks for it, before the rest', () => {
    const lines = mapCredits([{ kind: 'map', text: ['the Mid-Atlantic Ridge'], style: '' }, { kind: 'map', text: ['Iceland'], style: 'vintage' }])
    expect(lines[0]).toContain(MAP_SOURCES.pb2002.credit)
    expect(lines.some((l) => l.includes('Natural Earth'))).toBe(true)
    expect(lines.filter((l) => l.includes('Natural Earth'))).toHaveLength(1)
  })

  it('writes them into the export’s credits file', () => {
    const source = { id: 's1', path: '/x.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 }
    const words = wordsFromTranscript([{ text: 'Iceland', startSec: 0.5, endSec: 1 }], 's1')
    const doc = commit(createDoc({ id: 'd', title: 'Trip', source, words }), [{ op: 'motion-add', kind: 'map', from: 'w1', text: ['Iceland'] }], 'x').doc
    const text = creditsText(doc) ?? ''
    expect(text).toContain('Credits for Trip')
    expect(text).toContain('NASA Blue Marble')
    expect(text).toContain('The World Factbook')
    // Nothing to credit without a map.
    expect(creditsText(createDoc({ id: 'e', title: 'Plain', source, words }))).toBeNull()
  })
})

describe('the plates, as the download turns them into the app’s own form', () => {
  it('keeps every boundary and plate, by PB2002’s codes, and reads back the same places', () => {
    const file = platesFromGeoJson(STANDIN_BOUNDARIES, STANDIN_PLATES)
    expect(file.boundaries.map((b) => `${b.a}-${b.b}`)).toEqual(['NA-EU', 'NA-EU', 'NA-AF', 'SA-AF', 'EU-AF'])
    expect(file.plates.map((p) => p.code)).toEqual(['NA', 'EU', 'AF', 'SA'])
    const plates = decodePlates(file)
    expect(plates.boundaries[0].pts.length).toBe(2 * 15)
    expect(plates.plates.get('NA')?.name).toBe('North America')
  })

  it('leaves out what it cannot read rather than failing', () => {
    const file = platesFromGeoJson(
      { features: [{ properties: { Name: 'xx' }, geometry: { type: 'LineString', coordinates: [[0, 0]] } }, null] },
      { nonsense: true }
    )
    expect(file.boundaries).toEqual([])
    expect(file.plates).toEqual([])
  })
})
