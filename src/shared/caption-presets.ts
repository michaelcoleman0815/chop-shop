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
 *
 * Drawn from what short-form captions do now (watched 2026-11-21 on YouTube
 * Shorts: talking heads like Alex Hormozi and The Diary Of A CEO, brand clips
 * like Red Bull's): two to four words at a time, a heavy face, white with a
 * hard dark edge and a drop shadow so they read on any picture, and the word
 * being said picked out by colour or size, never by a gimmick. Only the faces
 * the export carries (resources/fonts): Archivo Black for weight, Anton for
 * condensed size, Sora for a quiet subtitle. The first is the one a person
 * sees first; Clean is also the default (DEFAULT_CAPTIONS).
 */
export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'clean',
    name: 'Clean',
    style: {
      ...BASE,
      // The talking-head look: three words in sentence case, heavy, white, a thin edge and a drop shadow.
      wordsPerGroup: 3,
      fontFamily: 'Archivo Black',
      fontSizePx: 72,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 3,
      shadowPx: 5,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'punch',
    name: 'Bold',
    style: {
      ...BASE,
      // Loud and short: three words in capitals, the one being said in yellow and a touch bigger.
      wordsPerGroup: 3,
      fontFamily: 'Archivo Black',
      fontSizePx: 92,
      textColor: '#FFFFFF',
      activeColor: '#FFD400',
      outlineColor: '#000000',
      outlinePx: 9,
      shadowPx: 5,
      uppercase: true,
      activeScale: 1.1
    }
  },
  {
    id: 'karaoke',
    name: 'Word lights up',
    style: {
      ...BASE,
      // Every word white, the one being said lit green and popped, so the eye follows the voice.
      wordsPerGroup: 3,
      fontFamily: 'Archivo Black',
      fontSizePx: 84,
      textColor: '#FFFFFF',
      activeColor: '#3EE07A',
      outlineColor: '#000000',
      outlinePx: 8,
      shadowPx: 4,
      uppercase: true,
      activeScale: 1.12
    }
  },
  {
    id: 'headline',
    name: 'Headline',
    style: {
      ...BASE,
      // Two words, condensed and enormous, like a cover line.
      wordsPerGroup: 2,
      fontFamily: 'Anton',
      fontSizePx: 150,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 6,
      shadowPx: 6,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'feature',
    name: 'One big word',
    style: {
      ...BASE,
      // The word being said carries the frame; the rest of its line runs small beneath it.
      wordsPerGroup: 4,
      fontFamily: 'Anton',
      fontSizePx: 170,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 6,
      shadowPx: 6,
      uppercase: false,
      activeScale: 1,
      second: {
        fontFamily: 'Sora',
        fontSizePx: 64,
        textColor: '#FFFFFF',
        outlineColor: '#000000',
        outlinePx: 4,
        shadowPx: 4,
        uppercase: false,
        bold: true,
        gapPx: 100
      }
    }
  },
  {
    id: 'plate',
    name: 'Boxed',
    style: {
      ...BASE,
      // White capitals on a black plate: the plate does the legibility work, so no outline and no colour change.
      wordsPerGroup: 3,
      fontFamily: 'Archivo Black',
      fontSizePx: 70,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlinePx: 16,
      shadowPx: 0,
      uppercase: true,
      activeScale: 1,
      boxColor: '#0B0B0E'
    }
  },
  {
    id: 'marker',
    name: 'Marker',
    style: {
      ...BASE,
      // Two words in dark type on a yellow highlighter, in sentence case.
      wordsPerGroup: 2,
      fontFamily: 'Archivo Black',
      fontSizePx: 74,
      textColor: '#111111',
      activeColor: '#111111',
      outlineColor: '#111111',
      outlinePx: 14,
      shadowPx: 0,
      uppercase: false,
      activeScale: 1,
      boxColor: '#FFE14D'
    }
  },
  {
    id: 'stack',
    name: 'Stack',
    style: {
      ...BASE,
      // Four words on two lines of heavy capitals, the one being said in yellow.
      wordsPerGroup: 4,
      fontFamily: 'Archivo Black',
      fontSizePx: 80,
      textColor: '#FFFFFF',
      activeColor: '#FFD400',
      outlineColor: '#000000',
      outlinePx: 9,
      shadowPx: 4,
      uppercase: true,
      activeScale: 1.05
    }
  },
  {
    id: 'sentence',
    name: 'Subtitle',
    style: {
      ...BASE,
      // Whole phrases in sentence case, sitting low: for when the face is the subject and the words support it.
      wordsPerGroup: 6,
      fontFamily: 'Sora',
      fontSizePx: 50,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 3,
      shadowPx: 3,
      uppercase: false,
      activeScale: 1,
      bold: true
    }
  },
  {
    id: 'lower',
    name: 'Lower third',
    style: {
      ...BASE,
      wordsPerGroup: 6,
      fontSizePx: 64,
      outlinePx: 6,
      shadowPx: 3,
      activeScale: 1.0
    }
  },
  {
    id: 'chop',
    name: 'Chop Shop',
    style: BASE
  }
]

export function presetById(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0]
}
