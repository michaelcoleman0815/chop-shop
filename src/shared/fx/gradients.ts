import type { Mask, Pixels } from './pixels'

/**
 * Gradient maps: brightness in, colour out, the way After Effects' Colorama
 * recolours a white scan edge or a bevel's light into gold or a cyan sea.
 * Each preset runs from its shadow to its highlight, so a bevel's dark side
 * and its lit side come out as two colours of the same family.
 */

export const GRADIENT_NAMES = ['gold', 'caribbean', 'ember', 'violet', 'ice', 'chrome', 'mono'] as const
export type GradientName = (typeof GRADIENT_NAMES)[number]

/** Stops from 0 (darkest) to 1 (brightest). */
export const GRADIENTS: Record<GradientName, { title: string; stops: [number, string][] }> = {
  gold: {
    title: 'gold',
    stops: [
      [0, '#1A0B00'],
      [0.3, '#6B3300'],
      [0.55, '#D97A00'],
      [0.75, '#FFC531'],
      [0.9, '#FFF0B3'],
      [1, '#FFFFFF']
    ]
  },
  // The cyan and teal of a Caribbean sea, after the preset the scan edge is usually mapped through.
  caribbean: {
    title: 'cyan and teal',
    stops: [
      [0, '#001A22'],
      [0.3, '#004E63'],
      [0.55, '#00A6A6'],
      [0.75, '#3FF0E0'],
      [0.9, '#C9FFF8'],
      [1, '#FFFFFF']
    ]
  },
  ember: {
    title: 'ember',
    stops: [
      [0, '#160000'],
      [0.3, '#7A1000'],
      [0.55, '#F04A00'],
      [0.75, '#FFA03C'],
      [0.9, '#FFE7C2'],
      [1, '#FFFFFF']
    ]
  },
  violet: {
    title: 'violet',
    stops: [
      [0, '#0C001F'],
      [0.3, '#41009E'],
      [0.55, '#9B1CFF'],
      [0.75, '#DD80FF'],
      [0.9, '#F8E3FF'],
      [1, '#FFFFFF']
    ]
  },
  ice: {
    title: 'ice blue',
    stops: [
      [0, '#000E1C'],
      [0.3, '#0A3A8C'],
      [0.55, '#2F8CFF'],
      [0.75, '#9FD8FF'],
      [0.9, '#E6F6FF'],
      [1, '#FFFFFF']
    ]
  },
  // Polished steel: dark bands and bright ones, as a mirror finish reflects a sky and a floor.
  chrome: {
    title: 'chrome',
    stops: [
      [0, '#0E1013'],
      [0.25, '#3A4048'],
      [0.5, '#9AA3AD'],
      [0.7, '#E9EEF2'],
      [0.85, '#B8C0C8'],
      [1, '#FFFFFF']
    ]
  },
  mono: {
    title: 'white',
    stops: [
      [0, '#000000'],
      [1, '#FFFFFF']
    ]
  }
}

export function isGradient(name: string): name is GradientName {
  return (GRADIENT_NAMES as readonly string[]).includes(name)
}

const hex = (c: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim())
  const n = m ? parseInt(m[1], 16) : 0xffffff
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * 256 colours, R G B in a row each, for brightness 0 to 255. A colour of
 * the person's own (#RRGGBB) becomes a gradient of its own: black to it to
 * white, so it reads the way a preset does.
 */
export function gradientLut(name: string): Uint8Array {
  const stops: [number, string][] = isGradient(name)
    ? GRADIENTS[name].stops
    : /^#[0-9a-f]{6}$/i.test(name.trim())
      ? [
          [0, '#000000'],
          [0.6, name.trim()],
          [1, '#FFFFFF']
        ]
      : GRADIENTS.gold.stops
  const lut = new Uint8Array(256 * 3)
  const rgb = stops.map(([p, c]) => [p, ...hex(c)] as [number, number, number, number])
  for (let v = 0; v < 256; v++) {
    const t = v / 255
    let i = 1
    while (i < rgb.length - 1 && rgb[i][0] < t) i++
    const a = rgb[i - 1]
    const b = rgb[i]
    const k = b[0] - a[0] <= 1e-9 ? 1 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])))
    for (let c = 0; c < 3; c++) lut[v * 3 + c] = Math.round(a[c + 1] + (b[c + 1] - a[c + 1]) * k)
  }
  return lut
}

/** The colour a gradient gives at a brightness from 0 to 1, as #RRGGBB. */
export function gradientAt(name: string, t: number): string {
  const lut = gradientLut(name)
  const v = Math.round(Math.min(1, Math.max(0, t)) * 255) * 3
  return `#${[lut[v], lut[v + 1], lut[v + 2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`.toUpperCase()
}

/**
 * Recolours a picture through a gradient by its brightness (Rec. 709),
 * keeping its alpha: a gradient map, as the export's lut1d of the same table
 * would (fx/ffmpeg cube1d).
 */
export function gradientMap(p: Pixels, name: string): Pixels {
  const lut = gradientLut(name)
  const out = { data: new Uint8ClampedArray(p.data.length), width: p.width, height: p.height }
  for (let k = 0; k < p.data.length; k += 4) {
    const y = Math.round(0.2126 * p.data[k] + 0.7152 * p.data[k + 1] + 0.0722 * p.data[k + 2])
    out.data[k] = lut[y * 3]
    out.data[k + 1] = lut[y * 3 + 1]
    out.data[k + 2] = lut[y * 3 + 2]
    out.data[k + 3] = p.data[k + 3]
  }
  return out
}

/** The same, from a brightness mask straight to colour, with alpha from another mask. */
export function colourise(light: Mask, alpha: Mask, name: string): Pixels {
  const lut = gradientLut(name)
  const out = { data: new Uint8ClampedArray(light.data.length * 4), width: light.width, height: light.height }
  for (let i = 0, k = 0; i < light.data.length; i++, k += 4) {
    const y = light.data[i] * 3
    out.data[k] = lut[y]
    out.data[k + 1] = lut[y + 1]
    out.data[k + 2] = lut[y + 2]
    out.data[k + 3] = alpha.data[i]
  }
  return out
}

/**
 * A gradient as a 1D .cube file for ffmpeg's lut1d, which maps each channel
 * by itself: run on a picture already turned to grey, it is the gradient map.
 */
export function cube1d(name: string): string {
  const lut = gradientLut(name)
  const lines = ['TITLE "Cutalong gradient map"', 'LUT_1D_SIZE 256']
  for (let v = 0; v < 256; v++)
    lines.push([lut[v * 3], lut[v * 3 + 1], lut[v * 3 + 2]].map((c) => (c / 255).toFixed(6)).join(' '))
  return `${lines.join('\n')}\n`
}
