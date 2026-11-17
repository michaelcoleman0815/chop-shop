import data from './data/facts.json'

/**
 * Facts a map shows under a country's name: its area, its population and its
 * capital. They come only from this table, which scripts/make-map-data.mjs
 * builds from The World Factbook (CIA, public domain), the edition with July
 * 2015 estimates, and every line says where it came from, for Details and for
 * the export's credits. A request or a model never supplies a figure: a
 * country the table does not have shows its name and nothing under it.
 */

export interface FactSource {
  title: string
  publisher: string
  edition: string
  licence: string
  via: string
}

interface Row {
  name: string
  area: number | null
  land: number | null
  water: number | null
  areaText: string
  population: number | null
  populationText: string
  populationYear: number | null
  capital: string | null
  capitalAt: [number, number] | null
  gec: string
}

const TABLE = data as unknown as { source: FactSource; countries: Record<string, Row> }

export const FACT_SOURCE: FactSource = TABLE.source

/** The year the edition's estimates are for. */
const FACT_YEAR = Number(/\d{4}/.exec(FACT_SOURCE.edition)?.[0] ?? 2015)

/** "The World Factbook, Central Intelligence Agency (July 2015 estimates), public domain". */
export function sourceLine(source: FactSource = FACT_SOURCE): string {
  return `${source.title}, ${source.publisher} (${source.edition}), ${source.licence.toLowerCase()}`
}

export type FactKind = 'area' | 'population' | 'capital'

export interface Fact {
  kind: FactKind
  /** As the map shows it: "39,800 mi² (103,000 km²)". */
  text: string
  /** As the table gives it, for Details: "103,000 sq km". */
  given: string
  source: FactSource
}

/** Square kilometres in a square mile, exactly. */
const KM2_PER_MI2 = 2.589988110336

/** Significant figures a figure is given to: 103,000 is three, 9,826,675 is seven. */
export function significant(n: number): number {
  const digits = String(Math.round(Math.abs(n))).replace(/0+$/, '')
  return Math.max(1, digits.length)
}

/** A number rounded to some significant figures. */
function round(n: number, figures: number): number {
  if (n === 0) return 0
  const k = 10 ** (Math.floor(Math.log10(Math.abs(n))) + 1 - figures)
  return Math.round(n / k) * k
}

const grouped = (n: number): string => Math.round(n).toLocaleString('en-US')

/** "9.83 million" for millions, "103,000" below that. */
function amount(n: number): string {
  if (n >= 1e6) {
    const m = round(n, 3) / 1e6
    return `${m >= 100 ? Math.round(m) : Number(m.toPrecision(3))} million`
  }
  return grouped(n)
}

/**
 * An area in square miles, then square kilometres: the conversion is rounded
 * to as many significant figures as the given number has, and never more than
 * three, as a documentary rounds it ("39,800 mi² (103,000 km²)").
 */
export function areaLine(km2: number): string {
  const figures = Math.min(3, significant(km2))
  const mi2 = round(km2 / KM2_PER_MI2, figures)
  const km = round(km2, Math.min(3, significant(km2)))
  return `${amount(mi2)} mi² (${amount(km)} km²)`
}

/** The table's row for a country by its id (ISL), or null. */
export function factsRow(country: string): Row | null {
  return TABLE.countries[country] ?? null
}

/** The facts asked for, in the order asked, that the table has for a country. */
export function factsFor(country: string, kinds: FactKind[] = ['area']): Fact[] {
  const row = factsRow(country)
  if (!row) return []
  const out: Fact[] = []
  for (const kind of kinds) {
    if (kind === 'area' && row.area && row.area > 0) {
      out.push({ kind, text: areaLine(row.area), given: row.areaText, source: FACT_SOURCE })
    }
    if (kind === 'population' && row.population && row.population > 0) {
      // A figure the table gives no year for is from the same edition as the rest.
      const year = ` (${row.populationYear ?? FACT_YEAR} estimate)`
      out.push({
        kind,
        text: `Population ${amount(round(row.population, 3))}${year}`,
        given: row.populationText,
        source: FACT_SOURCE
      })
    }
    if (kind === 'capital' && row.capital) {
      out.push({ kind, text: `Capital: ${row.capital}`, given: row.capital, source: FACT_SOURCE })
    }
  }
  return out
}

/** Where a country's capital is, from the same table, for a pin. */
export function capitalOf(country: string): { name: string; at: [number, number] } | null {
  const row = factsRow(country)
  return row?.capital && row.capitalAt ? { name: row.capital, at: row.capitalAt } : null
}
