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
 * Each is a whole style taken from short-form video as it is captioned now,
 * measured frame by frame on YouTube Shorts (2026-11-21): the face and its
 * weight, the case, how big against the frame's width, how many words at once,
 * a soft shadow or a hard outline, a plate or none, and how the word being said
 * stands out. Sizes are for a frame 1080 wide (captionStyleFor scales them).
 * Only the faces the export carries (resources/fonts, shared/motion/fonts),
 * each a single weight under the name its file gives itself.
 */
const MONTSERRAT = 'Montserrat Thin ExtraBold'
const MONTSERRAT_BLACK = 'Montserrat Thin Black'
const INTER = 'Inter'
const INTER_EXTRA = 'Inter ExtraBold'
const TIKTOK_BLACK = 'TikTok Sans Light Black'
const TIKTOK = 'TikTok Sans Light ExtraBold'

export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: 'clean',
    name: 'Talking head',
    style: {
      ...BASE,
      // Two words, big, heavy geometric sans in sentence case, white, no outline, a soft shadow. The word being
      // said is the same white a weight heavier. As Alex Hormozi's shorts are captioned.
      wordsPerGroup: 2,
      fontFamily: MONTSERRAT,
      activeFontFamily: MONTSERRAT_BLACK,
      // Lower-case letters about 6% of the frame's width tall, as measured.
      fontSizePx: 150,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 4,
      shadowBlur: 14,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'sentence',
    name: 'Podcast',
    style: {
      ...BASE,
      // Three words in a plain bold grotesque, sentence case, white, a soft shadow and nothing else. As podcast
      // clips like Chris Williamson's are captioned.
      wordsPerGroup: 3,
      fontFamily: INTER,
      // Lower-case letters about 3.4% of the frame's width tall.
      fontSizePx: 96,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 3,
      shadowBlur: 12,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'feature',
    name: 'Interview',
    style: {
      ...BASE,
      // The word being said huge, the word said before it small on the line above, both white with a soft shadow.
      // As The Diary Of A CEO's clips are captioned.
      wordsPerGroup: 2,
      fontFamily: INTER_EXTRA,
      // The big word's capitals about 8% of the frame's width tall, the line above about two thirds of that.
      fontSizePx: 180,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 4,
      shadowBlur: 16,
      uppercase: false,
      activeScale: 1,
      second: {
        fontFamily: INTER,
        fontSizePx: 110,
        textColor: '#FFFFFF',
        outlineColor: '#000000',
        outlinePx: 0,
        shadowPx: 3,
        shadowBlur: 12,
        uppercase: false,
        // Tucked right onto the big word, as the reference sets it. A line's cell carries the face's whole ascent
        // over its capitals and its descent under its baseline, so a gap of 0 would leave about 75 px of air
        // between the small line's baseline and the big capitals. This brings it to about a quarter of a capital,
        // the closest it goes with a small line's tail (y, g) still clear of a big tall letter (h, B) under it.
        gapPx: -48,
        above: true
      }
    }
  },
  {
    id: 'punch',
    name: 'Loud',
    style: {
      ...BASE,
      // Three words in the heaviest geometric capitals, white, the word being said yellow, a thin black edge and
      // a hard shadow. As brand and challenge shorts are captioned (Red Bull's).
      wordsPerGroup: 3,
      fontFamily: MONTSERRAT_BLACK,
      // Capitals about 5% of the frame's width tall.
      fontSizePx: 118,
      textColor: '#FFFFFF',
      activeColor: '#FFD400',
      outlineColor: '#000000',
      outlinePx: 5,
      shadowPx: 5,
      shadowBlur: 0,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'karaoke',
    name: 'Word lights up',
    style: {
      ...BASE,
      // Every word white, the one being said green and a touch bigger, so the eye follows the voice.
      wordsPerGroup: 3,
      fontFamily: TIKTOK_BLACK,
      fontSizePx: 86,
      textColor: '#FFFFFF',
      activeColor: '#3EE07A',
      outlineColor: '#000000',
      outlinePx: 6,
      shadowPx: 0,
      shadowBlur: 0,
      uppercase: true,
      activeScale: 1.08
    }
  },
  {
    id: 'stack',
    name: 'Outlined',
    style: {
      ...BASE,
      // White in sentence case with a black stroke and no shadow: the text a phone's own editor puts on a video.
      wordsPerGroup: 4,
      fontFamily: TIKTOK,
      fontSizePx: 80,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 7,
      shadowPx: 0,
      shadowBlur: 0,
      uppercase: false,
      activeScale: 1
    }
  },
  {
    id: 'headline',
    name: 'Headline',
    style: {
      ...BASE,
      // Two words in tall condensed capitals, like a cover line.
      wordsPerGroup: 2,
      fontFamily: 'Bebas Neue',
      fontSizePx: 190,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 5,
      shadowBlur: 18,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'plate',
    name: 'Title plate',
    style: {
      ...BASE,
      // Black bold words on a white plate: how podcast clips put a question or a claim on screen.
      wordsPerGroup: 3,
      fontFamily: INTER_EXTRA,
      fontSizePx: 104,
      textColor: '#111111',
      activeColor: '#111111',
      outlineColor: '#FFFFFF',
      outlinePx: 18,
      shadowPx: 0,
      shadowBlur: 0,
      uppercase: false,
      activeScale: 1,
      boxColor: '#FFFFFF'
    }
  },
  {
    id: 'marker',
    name: 'Marker',
    style: {
      ...BASE,
      // Two words of dark type on a yellow highlighter.
      wordsPerGroup: 2,
      fontFamily: MONTSERRAT,
      fontSizePx: 76,
      textColor: '#111111',
      activeColor: '#111111',
      outlineColor: '#111111',
      outlinePx: 14,
      shadowPx: 0,
      shadowBlur: 0,
      uppercase: false,
      activeScale: 1,
      boxColor: '#FFE14D'
    }
  },
  {
    id: 'lower',
    name: 'Subtitle',
    style: {
      ...BASE,
      // Whole phrases, small and low, for when the face is the subject and the words only support it.
      wordsPerGroup: 6,
      fontFamily: INTER,
      fontSizePx: 56,
      textColor: '#FFFFFF',
      activeColor: '#FFFFFF',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 3,
      shadowBlur: 10,
      uppercase: false,
      activeScale: 1
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
