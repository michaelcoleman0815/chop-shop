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
    id: 'feature',
    name: 'Feature',
    style: {
      ...BASE,
      // One word carries the frame; the sentence finishes quietly beneath it.
      wordsPerGroup: 5,
      fontFamily: 'Anton',
      fontSizePx: 112,
      positionFrac: 0.42,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 3,
      shadowPx: 0,
      uppercase: false,
      activeScale: 1,
      second: {
        fontFamily: 'Sora',
        fontSizePx: 42,
        textColor: '#ffffff',
        outlineColor: '#000000',
        outlinePx: 2,
        shadowPx: 3,
        uppercase: false,
        bold: true,
        gapPx: 96
      }
    }
  },
  {
    id: 'marker',
    name: 'Marker',
    style: {
      ...BASE,
      // A highlighter pen: one word at a time on a block of colour, dark text.
      wordsPerGroup: 1,
      fontSizePx: 78,
      positionFrac: 0.28,
      textColor: '#16151a',
      activeColor: '#16151a',
      outlinePx: 12,
      shadowPx: 0,
      uppercase: false,
      activeScale: 1,
      boxColor: '#c8f04a'
    }
  },
  {
    id: 'headline',
    name: 'Headline',
    style: {
      ...BASE,
      // Condensed and enormous, sitting high like a cover line.
      wordsPerGroup: 2,
      fontFamily: 'Anton',
      fontSizePx: 132,
      positionFrac: 0.68,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 4,
      shadowPx: 0,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'plate',
    name: 'Plate',
    style: {
      ...BASE,
      // One word on a solid block, centred. The plate does the legibility work,
      // so there is no outline and no per-word colour change.
      wordsPerGroup: 1,
      fontSizePx: 86,
      positionFrac: 0.5,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlinePx: 14,
      shadowPx: 0,
      uppercase: true,
      activeScale: 1,
      boxColor: '#08080b'
    }
  },
  {
    id: 'stack',
    name: 'Stack',
    style: {
      ...BASE,
      // Two lines of heavy uppercase with the spoken line picked out in yellow,
      // over a hard black edge that survives any background.
      wordsPerGroup: 5,
      fontSizePx: 74,
      positionFrac: 0.34,
      textColor: '#ffffff',
      activeColor: '#ffd400',
      outlineColor: '#000000',
      outlinePx: 9,
      shadowPx: 0,
      uppercase: true,
      activeScale: 1.05
    }
  },
  {
    id: 'sentence',
    name: 'Sentence',
    style: {
      ...BASE,
      // Sentence case, no shouting, sitting low. For talking heads where the
      // face is the subject and the words are support.
      wordsPerGroup: 4,
      fontFamily: 'Sora',
      fontSizePx: 46,
      positionFrac: 0.17,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 3,
      shadowPx: 3,
      uppercase: false,
      activeScale: 1,
      bold: true
    }
  },
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
