import type { LabelFont } from './labels'
import type { MapStyle } from './types'

/**
 * The two looks a map shot has. Satellite-dark is NASA's Blue Marble taken
 * down to a night-time palette, so the outline and the type carry the shot.
 * Vintage is a parchment chart: old-style coastlines with ripples of ink
 * beside them, a graticule, a compass rose and a title pill.
 */

export interface MapLook {
  /** Under everything: the sea where no picture is drawn. */
  sea: string
  /** Land drawn from shapes, where it is (vintage, and the sea's edge in the dark style). */
  land: string | null
  /** Land laid over a satellite picture too coarse for the camera's distance. */
  coarseLand: string | null
  /** Laid over the satellite picture to bring it down, then its colour taken out by this much. */
  dim: string
  desaturate: number
  /** The frame's edges darker than its middle. */
  vignette: string
  coast: { color: string; width: number }
  border: { color: string; width: number; dash: number[] }
  /** Ink ripples beside the coast: widths and their colours, widest first. */
  waterlines: { width: number; color: string }[]
  graticule: { color: string; width: number; step: number } | null
  lakes: string | null
  rivers: { color: string; width: number } | null
  /** The subject: its fill, its outline, and the glow round the outline. */
  highlight: {
    fill: string
    fillAlpha: number
    /** How the fill goes on: screened on a photograph, so it lifts the land; laid over on paper. */
    blend: 'screen' | 'source-over'
    stroke: string
    width: number
    glow: string | null
  }
  /** How far everything but the subject dims as the subject fills, 0 to 1. */
  spotlight: number
  quiet: { fill: string; stroke: string }
  ridge: { color: string; core: string; width: number; glow: string | null }
  route: { color: string; width: number; dash: number[] }
  parallel: { color: string; width: number; gap: number }
  pin: { fill: string; ring: string; pulse: string; radius: number }
  /** Label faces and colours: a pin's name, a plate's, a country next door's, a line's. */
  fonts: { pin: LabelFont; plate: LabelFont; neighbour: LabelFont; line: LabelFont }
  text: { pin: string; plate: string; neighbour: string; line: string; halo: string; haloWidth: number }
}

const SORA = 'Sora'
const FELL = 'IM Fell English'

const withFont = new Map<string, MapLook>()

/**
 * A style's look for a map: its names set in the brand's face where the
 * map asks for one, so a branded video's maps speak in its type. The vintage
 * chart keeps its engraver's face: it is the style.
 */
export function lookFor(paint: { style: MapStyle; font?: string }): MapLook {
  const look = LOOKS[paint.style] ?? LOOKS['satellite-dark']
  const font = paint.font
  if (!font || paint.style === 'vintage' || font === look.fonts.pin.family) return look
  const key = `${paint.style}|${font}`
  let made = withFont.get(key)
  if (!made) {
    const f = look.fonts
    made = {
      ...look,
      fonts: {
        pin: { ...f.pin, family: font },
        plate: { ...f.plate, family: font },
        neighbour: { ...f.neighbour, family: font },
        line: { ...f.line, family: font }
      }
    }
    withFont.set(key, made)
  }
  return made
}

export const LOOKS: Record<MapStyle, MapLook> = {
  'satellite-dark': {
    sea: '#03070D',
    land: null,
    coarseLand: '#3A3B2C',
    dim: 'rgba(2, 6, 14, 0.5)',
    desaturate: 0.35,
    vignette: 'rgba(0, 0, 0, 0.6)',
    coast: { color: 'rgba(205, 225, 255, 0.28)', width: 1.1 },
    border: { color: 'rgba(225, 235, 255, 0.24)', width: 1.1, dash: [5, 5] },
    waterlines: [],
    graticule: null,
    lakes: null,
    rivers: null,
    highlight: { fill: '#FFF6D8', fillAlpha: 0.18, blend: 'screen', stroke: '#FFFFFF', width: 3.2, glow: '#FFD84D' },
    spotlight: 0.38,
    quiet: { fill: 'rgba(255, 255, 255, 0.05)', stroke: 'rgba(255, 255, 255, 0.4)' },
    ridge: { color: '#FF6B3D', core: '#FFE2C9', width: 3.4, glow: '#FF4A1C' },
    route: { color: '#FFFFFF', width: 4, dash: [16, 11] },
    parallel: { color: 'rgba(255, 255, 255, 0.85)', width: 4.2, gap: 15 },
    pin: { fill: '#FFFFFF', ring: '#0B0F17', pulse: 'rgba(255, 255, 255, 0.5)', radius: 9 },
    fonts: {
      pin: { family: SORA, weight: 700, size: 30, tracking: 0.6, uppercase: false },
      plate: { family: SORA, weight: 700, size: 30, tracking: 6, uppercase: true },
      neighbour: { family: SORA, weight: 600, size: 22, tracking: 4.5, uppercase: true },
      line: { family: SORA, weight: 600, size: 25, tracking: 2.4, uppercase: false }
    },
    text: {
      pin: '#FFFFFF',
      plate: 'rgba(255, 255, 255, 0.92)',
      neighbour: 'rgba(225, 233, 245, 0.62)',
      line: '#FFE7D6',
      halo: 'rgba(0, 0, 0, 0.75)',
      haloWidth: 5
    }
  },
  vintage: {
    sea: '#E6D6B4',
    land: '#D9C29A',
    coarseLand: null,
    dim: 'rgba(0, 0, 0, 0)',
    desaturate: 0,
    vignette: 'rgba(92, 62, 30, 0.55)',
    coast: { color: '#4A3420', width: 1.6 },
    border: { color: 'rgba(74, 52, 32, 0.6)', width: 1.2, dash: [7, 4, 2, 4] },
    waterlines: [
      { width: 34, color: 'rgba(74, 52, 32, 0.22)' },
      { width: 24, color: 'rgba(74, 52, 32, 0.32)' },
      { width: 14, color: 'rgba(74, 52, 32, 0.45)' }
    ],
    graticule: { color: 'rgba(84, 58, 34, 0.22)', width: 1, step: 10 },
    lakes: '#E6D6B4',
    rivers: { color: 'rgba(70, 92, 120, 0.45)', width: 1.1 },
    highlight: { fill: '#9E3B22', fillAlpha: 0.22, blend: 'source-over', stroke: '#5E2412', width: 3, glow: null },
    spotlight: 0,
    quiet: { fill: 'rgba(94, 36, 18, 0.06)', stroke: 'rgba(74, 52, 32, 0.55)' },
    ridge: { color: '#8E2E16', core: '#C8603A', width: 3.2, glow: null },
    route: { color: '#5E2412', width: 3.4, dash: [12, 9] },
    parallel: { color: 'rgba(74, 52, 32, 0.8)', width: 3.4, gap: 13 },
    pin: { fill: '#8E2E16', ring: '#F2E6CC', pulse: 'rgba(142, 46, 22, 0.35)', radius: 8 },
    fonts: {
      pin: { family: FELL, weight: 400, size: 32, tracking: 0.5, uppercase: false },
      plate: { family: FELL, weight: 400, size: 32, tracking: 5, uppercase: true },
      neighbour: { family: FELL, weight: 400, size: 25, tracking: 4, uppercase: true },
      line: { family: FELL, weight: 400, size: 28, tracking: 1.5, uppercase: false }
    },
    text: {
      pin: '#3B2614',
      plate: '#4A3420',
      neighbour: 'rgba(74, 52, 32, 0.78)',
      line: '#5E2412',
      halo: 'rgba(236, 222, 192, 0.85)',
      haloWidth: 4
    }
  }
}
