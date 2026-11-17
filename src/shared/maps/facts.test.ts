import { describe, expect, it } from 'vitest'
import { areaLine, capitalOf, FACT_SOURCE, factsFor, factsRow, significant, sourceLine } from './facts'

describe('facts from the World Factbook', () => {
  it('says where they come from: the Factbook, its edition, and that it is public domain', () => {
    expect(FACT_SOURCE).toMatchObject({
      title: 'The World Factbook',
      publisher: 'Central Intelligence Agency',
      licence: 'Public domain'
    })
    expect(FACT_SOURCE.edition).toMatch(/2015/)
    expect(sourceLine()).toBe('The World Factbook, Central Intelligence Agency (July 2015 estimates), public domain')
  })

  it('gives an area in square miles and square kilometres, rounded as the figure is given', () => {
    expect(areaLine(103_000)).toBe('39,800 mi² (103,000 km²)')
    expect(areaLine(69_700)).toBe('26,900 mi² (69,700 km²)')
    expect(areaLine(9_826_675)).toBe('3.79 million mi² (9.83 million km²)')
    expect(areaLine(298)).toBe('115 mi² (298 km²)')
    expect(significant(103_000)).toBe(3)
    expect(significant(9_826_675)).toBe(7)
  })

  it('shows Iceland’s area as the table has it, with the figure it came from', () => {
    const [area] = factsFor('ISL')
    expect(area).toMatchObject({ kind: 'area', text: '39,800 mi² (103,000 km²)', given: '103,000 sq km' })
    expect(area.source).toBe(FACT_SOURCE)
  })

  it('shows population with the year of its estimate, and the capital', () => {
    const [population, capital] = factsFor('ISL', ['population', 'capital'])
    expect(population.text).toBe('Population 332,000 (2015 estimate)')
    expect(population.given).toBe('331,918 (July 2015 est.)')
    expect(capital.text).toBe('Capital: Reykjavik')
    expect(capitalOf('ISL')).toEqual({ name: 'Reykjavik', at: [-21.95, 64.15] })
    // A figure the table gives no year for is from the same edition.
    expect(factsFor('FRA', ['population'])[0].text).toMatch(/\(2015 estimate\)$/)
  })

  it('tells Georgia the country’s facts from nothing else', () => {
    expect(factsRow('GEO')).toMatchObject({ name: 'Georgia', area: 69_700, capital: 'Tbilisi' })
    // A US state is not in the Factbook: no facts rather than made-up ones.
    expect(factsFor('US-13')).toEqual([])
  })

  it('shows nothing for a place the table does not have', () => {
    expect(factsFor('XXX')).toEqual([])
    expect(capitalOf('XXX')).toBeNull()
  })

  it('has a row for nearly every country the map draws', async () => {
    const { countries } = await import('./gazetteer')
    const all = [...countries().keys()]
    const covered = all.filter((id) => factsRow(id))
    expect(covered.length / all.length).toBeGreaterThan(0.95)
  })
})
