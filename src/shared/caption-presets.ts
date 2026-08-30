import type { CaptionStyle } from './types'

export interface CaptionPreset {
  id: string
  name: string
  style: CaptionStyle
}

const BASE: CaptionStyle = {
  wordsPerGroup: 4,
  fontFamily: 'Archivo Black',
  fontSizePx: 84,
  positionFrac: 0.72,
  textColor: '#F2F1EE',
  activeColor: '#FF6076',
  outlineColor: '#16151A',
  outlinePx: 8,
  shadowPx: 0,
  uppercase: true,
  activeScale: 1.08
}

/**
 * Named looks rather than a pile of sliders. Each is a whole configuration, so
 * switching preset changes size, position, colour and rhythm together, which is
 * how these actually differ in practice.
 */
export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'chop',
    name: 'Chop Shop',
    style: BASE
  },
  {
    id: 'punch',
    name: 'Punch',
    style: {
      ...BASE,
      wordsPerGroup: 3,
      fontSizePx: 104,
      positionFrac: 0.62,
      outlinePx: 12,
      activeScale: 1.16
    }
  },
  {
    id: 'lower',
    name: 'Lower third',
    style: {
      ...BASE,
      wordsPerGroup: 6,
      fontSizePx: 62,
      positionFrac: 0.86,
      outlinePx: 6,
      activeScale: 1.0
    }
  },
  {
    id: 'clean',
    name: 'Clean',
    style: {
      ...BASE,
      fontFamily: 'Sora',
      fontSizePx: 70,
      uppercase: false,
      activeColor: '#F2F1EE',
      outlinePx: 6,
      activeScale: 1.0,
      shadowPx: 4
    }
  },
  {
    id: 'karaoke',
    name: 'Karaoke',
    style: {
      ...BASE,
      wordsPerGroup: 5,
      fontSizePx: 76,
      positionFrac: 0.78,
      textColor: '#8B8880',
      activeColor: '#F2F1EE',
      activeScale: 1.12
    }
  }
]

export function presetById(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0]
}
