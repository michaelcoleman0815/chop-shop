import { FACT_SOURCE } from './facts'
import type { MapSourceId } from './spec'

/**
 * Where a map's data comes from and on what terms, in one place: the export's
 * credits list what a shot drew on, and Details says where its facts came
 * from. Natural Earth, the Census Bureau, the Factbook and NASA put their
 * work in the public domain (NASA asks to be acknowledged); PB2002's
 * conversion is under the Open Data Commons Attribution License, which asks
 * for the credit below wherever it is used.
 */

export interface MapSource {
  id: MapSourceId
  /** As a line in the credits. */
  credit: string
  licence: string
  /** Whether the terms ask for the credit; the others are credited anyway, as a courtesy. */
  required: boolean
  url: string
}

export const MAP_SOURCES: Record<MapSourceId, MapSource> = {
  naturalearth: {
    id: 'naturalearth',
    credit: 'Map data: Natural Earth (naturalearthdata.com)',
    licence: 'Public domain',
    required: false,
    url: 'https://www.naturalearthdata.com/'
  },
  census: {
    id: 'census',
    credit: 'US state boundaries: US Census Bureau, cartographic boundary files 2017',
    licence: 'Public domain',
    required: false,
    url: 'https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html'
  },
  factbook: {
    id: 'factbook',
    credit: `Facts: ${FACT_SOURCE.title}, ${FACT_SOURCE.publisher} (${FACT_SOURCE.edition})`,
    licence: 'Public domain',
    required: false,
    url: 'https://www.cia.gov/the-world-factbook/'
  },
  nasa: {
    id: 'nasa',
    credit:
      "Satellite imagery: NASA Blue Marble, shaded relief and bathymetry, from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS)",
    licence: 'NASA open data; no copyright, acknowledgement requested',
    required: false,
    url: 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api'
  },
  pb2002: {
    id: 'pb2002',
    credit:
      'Tectonic plate boundaries: Bird, P. (2003), An updated digital model of plate boundaries, Geochemistry Geophysics Geosystems 4(3), 1027; GIS conversion by Hugo Ahlenius, Nordpil',
    licence: 'Open Data Commons Attribution License 1.0',
    required: true,
    url: 'https://github.com/fraxen/tectonicplates'
  }
}

/** The credits lines for what some map shots drew on, required ones first, each once. */
export function mapCreditLines(ids: Iterable<MapSourceId>): string[] {
  const list = [...new Set(ids)].map((id) => MAP_SOURCES[id]).filter(Boolean)
  return list
    .sort((a, b) => Number(b.required) - Number(a.required))
    .map((s) => `${s.credit} · ${s.licence} · ${s.url}`)
}
