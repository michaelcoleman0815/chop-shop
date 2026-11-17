/**
 * A stand-in for the PB2002 plates, for tests and for checking the drawing
 * where the real files cannot be downloaded. It is NOT geography: a few
 * straight runs roughly where the Atlantic's plate boundaries are, and four
 * boxes for plates, in PB2002's GeoJSON shape. Nothing in the app reads it;
 * the app only ever draws the plates it downloaded.
 */

type Run = [number, number][]

const line = (a: string, b: string, coordinates: Run): object => ({
  type: 'Feature',
  properties: { LAYER: 'plate boundary', Name: `${a}-${b}`, PlateA: a, PlateB: b, Type: '' },
  geometry: { type: 'LineString', coordinates }
})

const plate = (code: string, name: string, ring: Run): object => ({
  type: 'Feature',
  properties: { LAYER: 'plate', Code: code, PlateName: name },
  geometry: { type: 'Polygon', coordinates: [ring] }
})

// A zig-zag, as ridges offset along their transform faults.
const zigzag = (from: [number, number], to: [number, number], steps: number): Run => {
  const out: Run = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    out.push([from[0] + (to[0] - from[0]) * f + (i % 2 ? 0.8 : -0.8), from[1] + (to[1] - from[1]) * f])
  }
  return out
}

export const STANDIN_BOUNDARIES = {
  type: 'FeatureCollection',
  features: [
    line('NA', 'EU', zigzag([-29, 39.5], [-18, 63.5], 14)),
    line('NA', 'EU', zigzag([-18, 63.5], [-8, 72], 8)),
    line('NA', 'AF', zigzag([-46, 15], [-29, 39.5], 12)),
    line('SA', 'AF', zigzag([-14, -54], [-46, 15], 24)),
    line('EU', 'AF', [
      [-29, 39.5],
      [-15, 37],
      [-6, 36]
    ])
  ]
}

export const STANDIN_PLATES = {
  type: 'FeatureCollection',
  features: [
    plate('NA', 'North America', [
      [-170, 15],
      [-46, 15],
      [-29, 39.5],
      [-18, 63.5],
      [-8, 72],
      [-8, 84],
      [-170, 84],
      [-170, 15]
    ]),
    plate('EU', 'Eurasia', [
      [-8, 72],
      [-18, 63.5],
      [-29, 39.5],
      [-15, 37],
      [-6, 36],
      [60, 36],
      [60, 84],
      [-8, 84],
      [-8, 72]
    ]),
    plate('AF', 'Africa', [
      [-46, 15],
      [-14, -54],
      [50, -54],
      [50, 36],
      [-6, 36],
      [-15, 37],
      [-29, 39.5],
      [-46, 15]
    ]),
    plate('SA', 'South America', [
      [-90, -60],
      [-14, -54],
      [-46, 15],
      [-90, 15],
      [-90, -60]
    ])
  ]
}
