import { z } from 'zod'
import type { Beat, Cut } from './schema'

/**
 * A picture of another shape than the frame: a phone clip held upright in a
 * wide video, a wide clip or a cutaway in a vertical one, a still.
 *
 * Cropping it to fill the frame keeps less than half of it, so it is shown
 * whole instead, and the space either side is filled with a blurred, darker
 * copy of the same picture rather than left as black bars. The copy is made
 * small, blurred there and scaled back up, which is cheap and soft; the
 * preview draws it the same way from the frame on screen, and the export
 * makes it with ffmpeg from the same numbers, so the two look alike.
 *
 * Someone talking is the exception when their recording is wider than the
 * frame: making a wide talking head vertical is reframing, and it stays
 * cropped to them (centred, following them, or framed by hand). So does a
 * picture a camera move frames. Each edit can have black bars instead, or
 * have every picture cropped to fill the frame as it used to be.
 */

export const FILL_MODES = ['blur', 'black', 'crop'] as const
export const FillSchema = z.enum(FILL_MODES)
/** How pictures of another shape fill the frame. Absent on a cut is blur. */
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
  if (q > 1 && (input.speaker || input.framed)) return 'cover'
  const keeps = Math.min(q, 1 / q)
  return keeps < (input.still ? STILL_KEEPS_AT_LEAST : KEEPS_AT_LEAST) - 1e-9 ? input.mode : 'cover'
}

/** The fill an edit asks for. */
export function fillMode(cut: Pick<Cut, 'fill'>): FillMode {
  return cut.fill ?? 'blur'
}

/**
 * How the speaker's picture of a beat fills the frame, when it fills the
 * whole frame: a cutaway or a split shows something else, and a camera beside
 * it or in a box keeps its own layout.
 */
export function pictureFit(
  cut: Pick<Cut, 'fill' | 'reframe'>,
  beat: Pick<Beat, 'from' | 'treatment'>,
  picture: (Size & { subject?: unknown }) | null | undefined,
  frame: Size
): Fit {
  const t = beat.treatment
  if (t.frame !== 'speaker' || (t.angle && t.angle.layout !== 'full')) return 'cover'
  return fitFor({
    mode: fillMode(cut),
    picture: picture ?? null,
    box: frame,
    still: false,
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
 * blurred copy: what is filled, why, and how to have bars instead. Null when
 * none do, or some already did before.
 */
export function fillNotice(before: FilledPicture[], after: FilledPicture[], mode: FillMode): string | null {
  if (mode !== 'blur' || after.length === 0 || before.length > 0) return null
  const pictures = [...new Map(after.map((p) => [p.key, p])).values()]
  const n = pictures.length
  const one = n === 1
  const stills = pictures.every((p) => p.still)
  const clips = pictures.every((p) => !p.still)
  const kind = stills ? ['still', 'stills'] : clips ? ['clip', 'clips'] : ['picture', 'pictures']
  const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
  const subject = one ? pictures[0].name : capital(counted(n, kind[0], kind[1]))
  const be = one ? 'is' : 'are'
  const its = one ? 'its' : 'their'
  const each = one ? 'it' : 'each'
  let said: string
  if (pictures.every((p) => p.taller))
    said = `${subject} ${be} ${pictures.every((p) => p.upright) ? 'upright' : 'narrower than the frame'}, so I filled ${its} sides with a blurred copy of ${each}`
  else if (pictures.every((p) => !p.taller))
    said = `${subject} ${be} wider than the frame, so I filled above and below ${one ? 'it' : 'them'} with a blurred copy of ${each}`
  else said = `${subject} ${be} a different shape from the frame, so I filled around each with a blurred copy of it`
  return `${said} instead of black bars. Say “use black bars” to have plain bars.`
}

/**
 * What a sentence asks of the fill, when that is all it is about: “use black
 * bars”, “blur the sides”, “crop them to fill the frame”. Null otherwise.
 */
export function fillAsked(text: string): FillMode | null {
  const t = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/, '')
    .trim()
  if (!t || t.split(/\s+/).length > 10) return null
  if (
    /\b(black bars?|letter-?box(ed|ing)?|pillar-?box(ed|ing)?|no blur(red)?( background| sides| fill)?|don'?t blur|without (the )?blur)\b/.test(
      t
    )
  )
    return 'black'
  if (/\b(crop (it|them|everything|the pictures?|the clips?)? ?to fill|zoom (it |them )?to fill|fill the (whole )?frame|no bars)\b/.test(t))
    return 'crop'
  if (/\b(blur(red|ry)? (the )?(background|sides|bars|fill|edges)|blur (the )?bars|fill the sides|blurred fill)\b/.test(t))
    return 'blur'
  return null
}

/** What a fill op did, in the app's voice. */
export function describeFill(mode: FillMode): string {
  if (mode === 'black') return 'pictures of another shape sit between black bars'
  if (mode === 'crop') return 'pictures of another shape are cropped to fill the frame'
  return 'pictures of another shape sit on a blurred copy of themselves'
}
