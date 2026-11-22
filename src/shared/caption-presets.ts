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
      fontSizePx: 152,
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
        // over its capitals and its descent under its baseline, so a gap of 0 would leave about 55 px of air
        // between the small line's baseline and the big capitals. This brings it to about a quarter of a capital,
        // the closest it goes with a small line's tail (y, g) still clear of a big tall letter (h, B) under it.
        gapPx: -30,
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
      fontSizePx: 88,
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
      // Rodney Howard-Browne's Shorts (the owner's reference): one word at a time, as said, in clean heavy
      // capitals at the middle of the frame, white with a soft shadow, about 57 px tall on a 1080 × 1920 frame.
      // No punctuation, nothing picked out.
      wordsPerGroup: 1,
      fontFamily: 'Inter ExtraBold',
      fontSizePx: 96,
      letterEm: 0.6,
      plain: true,
      positionFrac: 0.52,
      textColor: '#ffffff',
      activeColor: '#ffffff',
      outlineColor: '#000000',
      outlinePx: 0,
      shadowPx: 3,
      uppercase: true,
      activeScale: 1
    }
  },
  {
    id: 'sermon-word-tall',
    name: 'Sermon one word, tall',
    style: {
      ...BASE,
      // 2819 Church's Shorts: one word at a time in tall condensed capitals, big and white in the middle.
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
    id: 'chop',
    name: 'Chop Shop',
    style: BASE
  }
]

export function presetById(id: string): CaptionPreset {
  return CAPTION_PRESETS.find((p) => p.id === id) ?? CAPTION_PRESETS[0]
}
