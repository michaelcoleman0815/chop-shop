import { z } from 'zod'
import type { Beat, Cut } from './schema'

/**
 * A picture of another shape than the frame: a phone clip held upright in a
 * wide video, a still, a screen recording in a vertical one.
 *
 * Cropping such a picture to fill the frame keeps less than half of it, so
 * where that loses what matters it is shown whole instead, on a blurred,
 * darker copy of the same picture. The copy is made small, blurred there and
 * scaled back up, which is cheap and soft; the preview draws it the same way
 * from the frame on screen, and the export makes it with ffmpeg from the same
 * numbers, so the two look alike.
 *
 * A new edit does this ('auto') for a picture taller than the frame (a phone
 * clip in a YouTube video), a still, and a screen recording. Wide footage in
 * a vertical frame fills it, cropped, as Shorts, Reels and TikTok expect:
 * blurred bars there read as reposted footage. Someone talking whose
 * recording is wider than the frame stays cropped to them in any mode, as
 * making a talking head vertical is reframing; so does a picture a camera
 * move or a framing frames. An edit can put every picture of another shape
 * on a blurred copy ('blur'), between black bars, or cropped ('crop'). An
 * edit made before there was a fill says none, and keeps the crop it had.
 */

export const FILL_MODES = ['auto', 'blur', 'black', 'crop'] as const
export const FillSchema = z.enum(FILL_MODES)
/** How pictures of another shape fill the frame. Absent on a cut is the crop every picture had before. */
export type FillMode = z.infer<typeof FillSchema>

/** How one picture sits in its box: cropped to cover it, or whole on a blurred copy or between black bars. */
export type Fit = 'cover' | 'blur' | 'black'

export interface Size {
  width: number
  height: number
}

/** The blurred copy is made this many pixels along its long side, whatever size the frame is. */
export const BACKDROP_LONG = 120
/** Its blur, in those pixels: a sixtieth of the frame's long side. */
export const BACKDROP_SIGMA = 2
/** How bright the copy is beside the picture: a little darker, so the picture reads as the subject. */
export const BACKDROP_LEVEL = 0.7

/**
 * A crop that would keep less than this share of a clip shows it whole
 * instead: a portrait clip in a wide frame keeps under a third of itself.
 */
const KEEPS_AT_LEAST = 0.5
/** A still is shown whole once a crop would take more than a fifth of it. */
const STILL_KEEPS_AT_LEAST = 0.8

/** Pictures with no timeline, by file name: the same list as shared/assets. */
const STILL = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

/**
 * A screen recording, by the name its recorder gives it: macOS ("Screen
 * Recording 2026-11-11 at 09.10.00.mov", and as it is named in German,
 * French and Spanish), iOS ("RPReplay_Final1699…"), Windows' Snipping Tool
 * ("Screen Recording 2026-11-11 091000.mp4") and Game Bar ("Visual Studio
 * Code 2026-11-11 09-10-00.mp4"). OBS names every recording by its date and
 * time alone, a camera's as much as a screen's, so it cannot be told.
 */
export function screenRecording(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? path
  return (
    /^(screen ?recording|screen ?cast|rpreplay|bildschirmaufnahme|enregistrement de l.(é|e)cran|grabaci(ó|o)n de pantalla)/i.test(name) ||
    // Game Bar: the window's title, then the date and time. A name that is the date alone is OBS's.
    (/^\S.*\S \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}\.\w+$/.test(name) && !/^replay /i.test(name))
  )
}

/** The small copy's size for a box of this shape: BACKDROP_LONG along its long side, even sizes. */
export function backdropSize(box: Size): Size {
  const long = Math.max(box.width, box.height)
  const short = Math.min(box.width, box.height)
  const side = long > 0 ? Math.max(8, Math.round((BACKDROP_LONG * short) / long / 2) * 2) : BACKDROP_LONG
  return box.width >= box.height ? { width: BACKDROP_LONG, height: side } : { width: side, height: BACKDROP_LONG }
}

export interface FitInput {
  mode: FillMode
  /** The picture's shape as shown, after any rotation; null or empty when unknown. */
  picture: Size | null
  /** The box it fills: the frame. */
  box: Size
  /** A still rather than footage. */
  still: boolean
  /** A screen recording, by its file's name. */
  screen: boolean
  /** Someone talking: a beat cut on words. */
  speaker: boolean
  /** Framed across by hand, or following the speaker: that framing decides the crop. */
  framed: boolean
  /** A camera move frames it. */
  moving: boolean
}

/**
 * How much wider than the box a picture is, as a ratio of their shapes:
 * above 1 a crop takes its sides, below 1 its top and bottom.
 */
export function shapeRatio(picture: Size, box: Size): number {
  return picture.width / picture.height / (box.width / box.height)
}

/** How one picture fits its box. */
export function fitFor(input: FitInput): Fit {
  if (input.mode === 'crop' || input.moving) return 'cover'
  const { picture, box } = input
  if (!picture || picture.width <= 0 || picture.height <= 0 || box.width <= 0 || box.height <= 0) return 'cover'
  const q = shapeRatio(picture, box)
  // Narrowing someone talking is reframing them, and a framing set by hand or following them decides where.
  // A screen recording has no one in it to reframe on.
  if (q > 1 && (input.framed || (input.speaker && !input.screen))) return 'cover'
  const keeps = Math.min(q, 1 / q)
  if (keeps >= (input.still ? STILL_KEEPS_AT_LEAST : KEEPS_AT_LEAST) - 1e-9) return 'cover'
  if (input.mode !== 'auto') return input.mode
  // By default only where a crop loses what matters: a picture taller than the frame, a still, a screen.
  return q < 1 || input.still || input.screen ? 'blur' : 'cover'
}

/**
 * The fill an edit asks for. A new edit asks for auto when it is made; one
 * saved before the fill existed says nothing, and is cropped as it was.
 */
export function fillMode(cut: Pick<Cut, 'fill'>): FillMode {
  return cut.fill ?? 'crop'
}

/**
 * How the speaker's picture of a beat fills the frame, when it fills the
 * whole frame: a cutaway or a split shows something else, and a camera beside
 * it or in a box keeps its own layout.
 */
export function pictureFit(
  cut: Pick<Cut, 'fill' | 'reframe'>,
  beat: Pick<Beat, 'from' | 'treatment'>,
  picture: (Size & { subject?: unknown; path?: string }) | null | undefined,
  frame: Size
): Fit {
  const t = beat.treatment
  if (t.frame !== 'speaker' || (t.angle && t.angle.layout !== 'full')) return 'cover'
  return fitFor({
    mode: fillMode(cut),
    picture: picture ?? null,
    box: frame,
    still: false,
    screen: !!picture?.path && screenRecording(picture.path),
    speaker: beat.from !== null,
    framed: typeof t.framing === 'number' || (!!cut.reframe && !!picture?.subject),
    moving: !!t.camera
  })
}

/** How a beat's cutaway fills the frame: a cutaway over the whole frame only, as a split and a card have their own. */
export function cutawayFit(
  cut: Pick<Cut, 'fill'>,
  beat: Pick<Beat, 'treatment'>,
  size: Size | null | undefined,
  frame: Size
): Fit {
  const t = beat.treatment
  if (t.frame !== 'broll' || !t.broll) return 'cover'
  return fitFor({
    mode: fillMode(cut),
    picture: size ?? null,
    box: frame,
    still: STILL.test(t.broll.path),
    screen: screenRecording(t.broll.path),
    speaker: false,
    framed: false,
    moving: !!t.broll.camera
  })
}

/** A picture shown whole: the beat it is on, what it is, and its shape against the frame's. */
export interface FilledPicture {
  beat: string
  /** The recording or file shown, so one shown on several beats counts once. */
  key: string
  /** Its file's name, for the reply. */
  name: string
  cutaway: boolean
  still: boolean
  /** Taller than the frame, so the sides are filled; otherwise above and below. */
  taller: boolean
  /** Upright itself: taller than it is wide. */
  upright: boolean
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/**
 * The pictures of a cut that sit whole on a blurred copy or between bars,
 * from the shapes the edit knows: its recordings', and its material's.
 */
export function filledPictures(
  cut: Pick<Cut, 'fill' | 'reframe' | 'beats'>,
  sources: (Size & { id: string; path: string; subject?: unknown })[],
  assets: { path: string; title?: string; width: number | null; height: number | null }[],
  frame: Size
): FilledPicture[] {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const byPath = new Map(assets.map((a) => [a.path, a]))
  const out: FilledPicture[] = []
  for (const beat of cut.beats) {
    const t = beat.treatment
    // A beat shown through another camera instead shows that camera's picture.
    const shown =
      t.angle?.layout === 'full' ? (byId.get(t.angle.source) ?? byId.get(beat.source)) : byId.get(beat.source)
    if (shown && pictureFit(cut, beat, shown, frame) !== 'cover') {
      out.push({
        beat: beat.id,
        key: shown.id,
        name: nameOf(shown.path),
        cutaway: false,
        still: false,
        taller: shapeRatio(shown, frame) < 1,
        upright: shown.height > shown.width
      })
    }
    if (t.broll) {
      const a = byPath.get(t.broll.path)
      const size = a && a.width && a.height ? { width: a.width, height: a.height } : null
      if (size && cutawayFit(cut, beat, size, frame) !== 'cover') {
        out.push({
          beat: beat.id,
          key: t.broll.path,
          name: a?.title || nameOf(t.broll.path),
          cutaway: true,
          still: STILL.test(t.broll.path),
          taller: shapeRatio(size, frame) < 1,
          upright: size.height > size.width
        })
      }
    }
  }
  return out
}

/**
 * The pictures of an edit shown whole, in the frame its export has: the
 * shape the aspect gives, or the shape of the recording it opens on.
 */
export function filledIn(
  doc: {
    sources: (Size & { id: string; path: string; subject?: unknown })[]
    assets: { path: string; title?: string; width: number | null; height: number | null }[]
    versions: { cut: Cut }[]
  },
  cut: Cut = doc.versions[doc.versions.length - 1].cut
): FilledPicture[] {
  const first = doc.sources.find((s) => s.id === cut.beats[0]?.source) ?? doc.sources[0]
  return filledPictures(cut, doc.sources, doc.assets, frameShape(cut.aspect, first))
}

/** The frame's shape for an aspect, as the export makes it: the recording's own when 'original'. */
export function frameShape(aspect: Cut['aspect'], first: Size | undefined): Size {
  if (aspect === 'vertical') return { width: 9, height: 16 }
  if (aspect === 'square') return { width: 1, height: 1 }
  if (aspect === 'wide' || !first || first.width <= 0 || first.height <= 0) return { width: 16, height: 9 }
  return { width: first.width, height: first.height }
}

const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const counted = (n: number, one: string, many: string): string => `${NUMBERS[n] ?? n} ${n === 1 ? one : many}`

/**
 * The sentence for the first version in which pictures sit whole on a
 * blurred copy: what is shown whole, why, what it replaces (a crop), and how
 * to have it cropped or between bars instead. Null when none are, or some
 * already were before.
 */
export function fillNotice(before: FilledPicture[], after: FilledPicture[], mode: FillMode): string | null {
  if (mode === 'black' || mode === 'crop' || after.length === 0 || before.length > 0) return null
  const pictures = [...new Map(after.map((p) => [p.key, p])).values()]
  const n = pictures.length
  const one = n === 1
  const stills = pictures.every((p) => p.still)
  const clips = pictures.every((p) => !p.still)
  const kind = stills ? ['still', 'stills'] : clips ? ['clip', 'clips'] : ['picture', 'pictures']
  const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
  // A name is never capitalised: one that starts in lower case is introduced instead ("The clip broll-wide").
  const named = one ? pictures[0].name : ''
  const subject = !one
    ? capital(counted(n, kind[0], kind[1]))
    : /^\p{Ll}/u.test(named)
      ? `The ${kind[0]} ${named}`
      : named
  const be = one ? 'is' : 'are'
  const them = one ? 'it' : 'them'
  const copy = one ? 'a blurred copy of itself' : 'blurred copies of themselves'
  const why = pictures.every((p) => p.taller)
    ? pictures.every((p) => p.upright)
      ? 'upright'
      : 'narrower than the frame'
    : pictures.every((p) => !p.taller)
      ? 'wider than the frame'
      : 'a different shape from the frame'
  return `${subject} ${be} ${why}, so I showed ${them} whole on ${copy} instead of cropping ${them}. Say “crop ${them} to fill” to have ${them} cropped, or “use black bars” for plain bars.`
}

/** The pictures a fill ask can name: “crop them to fill”, “put the clips between black bars”. */
const PICTURES = String.raw`(?:it|them|this|these|everything|all of them|the (?:pictures?|clips?|photos?|stills?|images?|footage|videos?|phone clips?|screen ?recordings?))`
/** What a sentence may open and close with and still be only a fill ask: “please”, “can you”, “instead”. */
const OPENERS = /^(?:(?:please|ok(?:ay)?|now|and|also|so|just|then|can you|could you|would you|can we|let's|lets)[, ]+)+/
const CLOSERS = /(?:[, ]+(?:please|instead|again|then|now|too|for (?:these|them|it|this edit|this video)))+$/
const WANT = String.raw`(?:i want|i'd like|i would like|give me|let's have|use|add|show|go with|switch to|try|put|have)`

/** Black bars wanted: “use black bars”, “put them between black bars”, “letterbox it”. */
const BLACK = new RegExp(
  String.raw`^(?:(?:${WANT}\s+)?(?:${PICTURES}\s+)?(?:(?:in|on|with|between|inside)\s+)?(?:plain\s+)?black bars?(?:\s+(?:on the sides|above and below|around (?:it|them)))?|(?:letter|pillar)-?box(?:ed)?(?:\s+${PICTURES})?)$`
)
/** Black bars not wanted: “remove the black bars”, “no black bars”, “I hate the black bars”. */
const NO_BLACK =
  /^(?:remove|get rid of|lose|drop|delete|ditch|kill|hide|take (?:away|out|off)|no(?: more)?|without|i (?:hate|don't like|do not like|don't want|do not want)|hate|don't use|do not use|stop using)(?: the| this| these| those| all the| any)? black bars?$/
/** The crop wanted: “crop them to fill”, “fill the frame”, “no bars”. */
const CROP = new RegExp(
  String.raw`^(?:(?:crop|zoom|scale|blow up)(?:\s+${PICTURES})?(?:\s+in)?\s+to (?:fill|fit)(?:\s+the (?:whole |entire )?(?:frame|screen))?|crop everything|(?:make\s+${PICTURES}\s+)?fill the (?:whole |entire )?(?:frame|screen)|(?:no|without|remove|get rid of|lose)(?: the| any)? bars)$`
)
/** The blurred fill wanted: “blur the sides”, “use a blurred background”, never “blur the background behind me”. */
const BLUR = new RegExp(
  String.raw`^(?:(?:${WANT}\s+)?(?:${PICTURES}\s+)?(?:(?:on|over|with|in front of)\s+)?(?:an?\s+)?(?:blur(?:red|ry)?\s+(?:fill|sides|bars|edges|copy|copies|backdrop|background fill)|blurred background)|blur (?:the )?(?:sides|bars|black bars|edges|empty space|space (?:around|beside) (?:it|them))|fill the (?:sides|bars|edges|space) with (?:an? )?(?:blur|blurred copy))$`
)

/**
 * What a sentence asks of the fill, when that is all it is about: “use black
 * bars”, “blur the sides”, “crop them to fill the frame”. “Remove the black
 * bars” goes back to what a new edit does, when this one has them. Null for
 * anything more, anything said with a no or a not that is not about the
 * bars, and anything that may be about something else (“blur the background
 * behind me”, “make the logo fill the frame”): the planner reads those.
 */
export function fillAsked(text: string, now: FillMode = 'auto'): FillMode | null {
  const t = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(OPENERS, '')
    .replace(CLOSERS, '')
    .trim()
  if (!t || t.split(' ').length > 10) return null
  if (NO_BLACK.test(t)) return now === 'black' ? 'auto' : null
  // Said with a no or a not, it says what is not wanted rather than what is: only “no bars” is plain.
  if (/\b(no|not|don't|do not|never|without|stop|hate)\b/.test(t) && !CROP.test(t)) return null
  if (BLACK.test(t)) return 'black'
  if (CROP.test(t)) return 'crop'
  if (BLUR.test(t)) return 'blur'
  return null
}

/** What a fill op did, in the app's voice. */
export function describeFill(mode: FillMode): string {
  if (mode === 'black') return 'pictures of another shape sit between black bars'
  if (mode === 'crop') return 'pictures of another shape are cropped to fill the frame'
  if (mode === 'blur') return 'every picture of another shape sits whole on a blurred copy of itself'
  return 'a phone clip in a wide video, a still or a screen recording sits whole on a blurred copy of itself, and other footage fills the frame'
}
