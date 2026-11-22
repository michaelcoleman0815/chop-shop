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
    id: 'sermon',
    name: 'Sermon',
    style: {
      ...BASE,
      // Lecrae's Shorts (docs/research/sermon-clips.md, "The owner's next three"): three words at a time at
      // most, small and clean in Inter, as said, punctuation and all, over the chest. The line the preacher
      // lands is set big in the heavy face, its key words in yellow on a line of their own.
      steady: true,
      wordsPerGroup: 3,
      fontFamily: 'Inter SemiBold',
      fontSizePx: 54,
      letterEm: 0.58,
      keyColor: '#FFD84D',
      keyFont: 'Inter ExtraBold',
      keyScale: 1.9,
      positionFrac: 0.52,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 3,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'sermon-red',
    name: 'Sermon red',
    style: {
      ...BASE,
      // The landed line in red, as Lecrae lands "That ain't / biblical": otherwise the Sermon look, three
      // words at a time in Inter. The red is the look's own, whatever accent the brand brings.
      steady: true,
      wordsPerGroup: 3,
      fontFamily: 'Inter SemiBold',
      fontSizePx: 54,
      letterEm: 0.58,
      keyColor: '#FF3B30',
      ownKey: true,
      keyFont: 'Inter ExtraBold',
      keyScale: 1.9,
      positionFrac: 0.52,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 3,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'sermon-word',
    name: 'Sermon one word',
    style: {
      ...BASE,
      // 2819 Church's Shorts: one word at a time, as said, in tall condensed capitals, big and white in the
      // middle of the frame. No punctuation, nothing picked out.
      wordsPerGroup: 1,
      fontFamily: 'Bebas Neue',
      fontSizePx: 230,
      // Bebas Neue's capitals run about 0.36 of the size each: a longer word fits by shrinking.
      letterEm: 0.3,
      plain: true,
      positionFrac: 0.52,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 4,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'sermon-quiet',
    name: 'Sermon quiet',
    style: {
      ...BASE,
      // The Life Church's newest Shorts: small lower-case words, three at a time, as said, under a hook card.
      steady: true,
      wordsPerGroup: 3,
      fontFamily: 'Inter SemiBold',
      fontSizePx: 48,
      letterEm: 0.56,
      lowercase: true,
      positionFrac: 0.52,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 3,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'sermon-box',
    name: 'Sermon square',
    style: {
      ...BASE,
      // Under a square picture on black: three words at a time, white on the black, the key words in yellow.
      steady: true,
      wordsPerGroup: 3,
      fontFamily: 'Inter SemiBold',
      fontSizePx: 58,
      letterEm: 0.58,
      keyColor: '#FFD84D',
      positionFrac: 0.84,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 0,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'sermon-build',
    name: 'Sermon build',
    style: {
      ...BASE,
      // Elevation's Shorts: the sentence building word by word as it is said, up to three lines, then clearing;
      // the words leant on in yellow.
      wordsPerGroup: 8,
      fontFamily: 'Inter ExtraBold',
      fontSizePx: 60,
      letterEm: 0.6,
      plain: true,
      build: true,
      keyColor: '#FFD84D',
      positionFrac: 0.66,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 2,
      shadowPx: 3,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'sermon-serif',
    name: 'Sermon serif',
    style: {
      ...BASE,
      // The Life Church's own Shorts (docs/research/sermon-clips.md, "The church's own clips"): one word at a
      // time in a bold display serif, as said, white with a soft shadow and the thinnest dark edge, over the
      // preacher's chest. No highlight: the word on screen is the word being said.
      wordsPerGroup: 1,
      fontFamily: 'DM Serif Display',
      // About 70% of the frame for a word like "whenever", as the church's own clips set it.
      fontSizePx: 180,
      // DM Serif Display's lower case averages 0.515 em (measured from the font): a longer word fits by shrinking.
      letterEm: 0.52,
      plain: true,
      positionFrac: 0.5,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 2,
      shadowPx: 5,
      uppercase: false,
      activeScale: 1
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
