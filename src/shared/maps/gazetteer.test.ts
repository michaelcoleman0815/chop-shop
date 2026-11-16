import { describe, expect, it } from 'vitest'
import { lookup, normalize, plate, readMapQuery, whichOne } from './gazetteer'

describe('finding places from words', () => {
  it('finds a country by its name, in any case and without its accents', () => {
    expect(lookup('Iceland')[0]).toMatchObject({ kind: 'country', id: 'ISL', name: 'Iceland' })
    expect(lookup('iceland')[0]?.id).toBe('ISL')
    expect(lookup('Côte d’Ivoire')[0]?.id).toBe('CIV')
    expect(normalize('São Tomé & Príncipe')).toBe('sao tome and principe')
  })

  it('finds a country by its everyday and former names', () => {
    expect(lookup('Holland')[0]?.id).toBe('NLD')
    expect(lookup('Burma')[0]?.id).toBe('MMR')
    expect(lookup('the States').map((p) => p.id)).toContain('USA')
    expect(lookup('UK')[0]?.id).toBe('GBR')
    expect(lookup('Ivory Coast')[0]?.id).toBe('CIV')
  })

  it('reads "show where Iceland is" as Iceland', () => {
    const q = readMapQuery('show where Iceland is')
    expect(q.stops).toHaveLength(1)
    expect(q.stops[0].map((p) => p.id)).toEqual(['ISL'])
    expect(q.ambiguous).toBeNull()
  })

  it('frames a country by its main land, not its far islands', () => {
    const usa = lookup('United States')[0]
    // The lower 48: Alaska and Hawaii are framed only when named.
    expect(usa.box[0]).toBeGreaterThan(-130)
    expect(usa.box[1]).toBeGreaterThan(24)
    const france = lookup('France')[0]
    expect(france.box[0]).toBeGreaterThan(-6)
    expect(france.box[1]).toBeGreaterThan(41)
    // Fiji is boxed across the date line, east of it.
    const fiji = lookup('Fiji')[0]
    expect(fiji.box[2] - fiji.box[0]).toBeLessThan(10)
  })

  it('reads a route from one place to another, with Rio as Rio de Janeiro', () => {
    const q = readMapQuery('from Lisbon to Rio')
    expect(q.route?.from).toMatchObject({ kind: 'city', name: 'Lisbon', country: 'PRT' })
    expect(q.route?.to).toMatchObject({ kind: 'city', name: 'Rio de Janeiro', country: 'BRA' })
    expect(q.stops).toEqual([[q.route?.from, q.route?.to]])
  })

  it('reads the Mid-Atlantic Ridge between the North American and Eurasian plates', () => {
    const q = readMapQuery('the Mid-Atlantic Ridge between the North American and Eurasian plates')
    expect(q.lines.map((l) => l.id)).toEqual(['line:mid-atlantic-ridge'])
    expect(q.plates).toEqual(['NA', 'EU'])
    expect(q.stops[0].map((p) => p.id)).toEqual(['line:mid-atlantic-ridge'])
  })

  it('reads the ridge between the plates, with no plates named', () => {
    const q = readMapQuery('show the Mid-Atlantic Ridge between the plates')
    expect(q.lines.map((l) => l.name)).toEqual(['Mid-Atlantic Ridge'])
    expect(q.plates).toEqual([])
  })

  it('knows the plates by their names and adjectives', () => {
    expect(plate('North American')?.code).toBe('NA')
    expect(plate('Eurasian plate')?.code).toBe('EU')
    expect(plate('Nazca')?.code).toBe('NZ')
    expect(plate('Atlantis')).toBeNull()
    expect(readMapQuery('the Pacific plate').plates).toEqual(['PA'])
    // The ocean is not the plate.
    expect(readMapQuery('the Pacific').plates).toEqual([])
  })

  it('reads a chain of places, one after another', () => {
    const q = readMapQuery('Iceland, then Norway')
    expect(q.stops.map((s) => s.map((p) => p.id))).toEqual([['ISL'], ['NOR']])
    const both = readMapQuery('Iceland and Norway')
    expect(both.stops.map((s) => s.map((p) => p.id))).toEqual([['ISL', 'NOR']])
  })

  it('reads a style, facts and a latitude from the words', () => {
    const q = readMapQuery('an old vintage map of Iceland with its population and the Arctic Circle')
    expect(q.style).toBe('vintage')
    expect(q.facts).toContain('population')
    expect(q.latitudes.map((l) => l.name)).toEqual(['Arctic Circle'])
    expect(q.stops[0].map((p) => p.id)).toEqual(['ISL'])
  })

  it('finds regions and continents', () => {
    expect(readMapQuery('Scandinavia').stops[0][0]).toMatchObject({ kind: 'region', members: ['NOR', 'SWE', 'DNK'] })
    const europe = readMapQuery('map of Europe').stops[0][0]
    expect(europe.kind).toBe('region')
    expect(europe.members).toContain('FRA')
    // Europe is framed without the far east of Russia.
    expect(europe.box[2]).toBeLessThan(60)
  })
})

describe('Georgia, and other names more than one place has', () => {
  it('asks when nothing said tells the country from the US state', () => {
    const q = readMapQuery('Georgia')
    expect(q.ambiguous?.name).toBe('georgia')
    expect(q.ambiguous?.options.map((p) => p.kind).sort()).toEqual(['country', 'state'])
    expect(whichOne('georgia', q.ambiguous?.options ?? [])).toBe('Georgia the country or the US state?')
  })

  it('takes the US state when the words say so', () => {
    for (const said of ['the state of Georgia', 'Georgia, USA', 'Georgia in the US', 'show Georgia state']) {
      const q = readMapQuery(said)
      expect(q.ambiguous, said).toBeNull()
      expect(q.stops[0][0], said).toMatchObject({ kind: 'state', id: 'US-13' })
    }
  })

  it('takes the country when the words say so', () => {
    for (const said of ['Georgia the country', 'Georgia in the Caucasus', 'the country of Georgia']) {
      const q = readMapQuery(said)
      expect(q.ambiguous, said).toBeNull()
      expect(q.stops[0][0], said).toMatchObject({ kind: 'country', id: 'GEO' })
    }
  })

  it('takes the state when a city in it is named, and shows the city', () => {
    const q = readMapQuery('Atlanta, Georgia')
    expect(q.ambiguous).toBeNull()
    expect(q.stops[0].map((p) => p.name)).toEqual(['Atlanta'])
    // Tbilisi settles it the other way.
    const t = readMapQuery('Tbilisi in Georgia')
    expect(t.ambiguous).toBeNull()
    expect(t.stops[0].map((p) => p.name)).toEqual(['Tbilisi'])
  })

  it('shows a city-state as its country, not its capital', () => {
    expect(readMapQuery('Luxembourg').stops[0][0]).toMatchObject({ kind: 'country', id: 'LUX' })
    expect(readMapQuery('Singapore').ambiguous).toBeNull()
  })

  it('takes New York the city unless the state is named', () => {
    expect(readMapQuery('New York').stops[0][0]).toMatchObject({ kind: 'city', name: 'New York' })
    expect(readMapQuery('New York state').stops[0][0]).toMatchObject({ kind: 'state', id: 'US-36' })
  })

  it('asks between Washington the city and the state', () => {
    const q = readMapQuery('Washington')
    expect(q.ambiguous?.options.map((p) => p.kind).sort()).toEqual(['city', 'state'])
  })

  it('finds nothing in words that name no place', () => {
    const q = readMapQuery('make it pop more')
    expect(q.stops).toEqual([])
    expect(q.route).toBeNull()
  })
})
