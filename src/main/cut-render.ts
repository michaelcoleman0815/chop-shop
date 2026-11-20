import { basename, join } from 'path'
import {
  BACKDROP_LEVEL,
  BACKDROP_SIGMA,
  backdropSize,
  cameraClock,
  cameraPlan,
  changesColour,
  chaptersMetadata,
  cutawayFit,
  maxZoom,
  pictureFit,
  cutawayAt,
  cutawayClock,
  cutawaySteps,
  duckingKeys,
  grainStrength,
  insetFor,
  pieceFraming,
  lookMatrix,
  outToSrc,
  pictureSpan,
  gridPictures,
  pipBox,
  placeChapters,
  placeSfx,
  sfxGainDb,
  sliceSteps,
  srcLength,
  transitionInfo,
  vignetteAngle,
  viewThroughAngles,
  type FrameKey,
  type SpeedStep,
  type Aspect,
  type Camera,
  type LevelKey,
  type Cut,
  type Fade,
  type Look,
  type Music,
  type Resolved,
  type Asset,
  type Source,
  type Treatment,
  type TransitionKind
} from '../shared/edit'
import { LABEL_FADE } from '../shared/motion/grid-plate'
import type { MotionTheme } from '../shared/motion/theme'
import { prepareGrids } from './grid-render'
import { captionStyleFor } from '../shared/subtitles'
import type { TranscriptWord } from '../shared/types'
import type { ToolSaid } from '../shared/failure'
import { bt601Style, buildAss } from './captions'
import { probeMedia } from './inspiration/measure'
import { makeSfx } from './sfx'
import { heardFrom } from '../shared/vision/offset'
import { captionMatrix, colorConversion, hasZscale, liveChannel } from './intake'
import { bedVolume, limiter, voicePolish } from './render/audio'
import { cropMove, perspectiveFor } from './render/camera'
import { changesSpeed, reverseSlices, speedPts, speedSound } from './render/speed'
import { platform } from './platform'
import { encodeArgs, X264, type Encoder } from './render/encoder'
import { renderFilm } from './render/film'
import { weaveFilter } from '../shared/edit/film'
import { hasFilm } from '../shared/edit/look'
import { overlayChains, pictureFxChains, type FxOverlayFile, type FxPass } from '../shared/fx/ffmpeg'

/**
 * Renders a resolved cut: the renderer of record for an edit document.
 *
 * Every piece is its own input, seeked and bounded with -ss and -t, so beats
 * can play in any order without ffmpeg holding the whole source in memory to
 * reach back for an earlier moment. Treatments are filters on each piece:
 * black and white is hue=s=0, a punch-in is a centred crop scaled back up, a
 * cutaway swaps or stacks in the B-roll while the speaker's voice carries on.
 *
 * Picture and sound are assembled as two tracks. Each piece's picture is cut
 * to an exact number of frames, counted from where it lands on the output
 * clock, so a long cut never drifts away from its captions; its sound is cut
 * to the sample. Pieces joined by a hard cut are concatenated; a transition
 * joins them with xfade and a matching acrossfade over exactly the overlap the
 * resolver worked out. Every piece is conformed to one size, frame rate, pixel
 * format, timebase, sample rate and layout first, which is what lets footage
 * from different cameras and screen recorders join at all.
 *
 * One pass over many pieces holds the pictures of pieces it has not reached,
 * so a cut of more than one piece renders in chunks of a few inputs to an
 * intermediate file each, then a last pass reads them back as one input and
 * adds captions and sets loudness once over the whole. Chunks only ever break
 * at a hard cut, so no transition is split in two.
 *
 * No Electron imports: the binary and folders arrive as arguments, which is
 * what lets the tests render real files with the system ffmpeg.
 */

export interface RenderSource extends Source {
  hasAudio: boolean
  /**
   * False for a recording with no picture of its own: a podcast, a voice memo,
   * a sound file whose only picture is its cover art. It shows a plain frame.
   * Absent: a 0 x 0 size says the same.
   */
  hasVideo?: boolean
}

/** One input stretch and how it should look. */
export interface Segment {
  path: string
  /** Where the sound starts in the source. */
  startSec: number
  /** How long the segment plays on the output clock. */
  durationSec: number
  hasAudio: boolean
  /** Null plays the input as it is, already conformed (a chunk from an earlier pass). */
  treatment: Treatment | null
  /**
   * Cutaway footage for this stretch, when the beat shows one: the stretch of
   * it read from startSec, with its own speed if it has one, played backwards
   * from the far end of that stretch, or held on its frame at startSec.
   */
  broll: {
    path: string
    startSec: number
    steps?: SpeedStep[]
    reverse?: boolean
    hold?: boolean
    camera?: SegmentCamera
    /** A conversion that goes first on the cutaway's picture: HDR to ordinary video. */
    convert?: string | null
    /** Shown whole, on a blurred copy of itself or between black bars (edit/fill). Absent: cropped to fill. */
    fill?: 'blur' | 'black'
  } | null
  /**
   * Sound read apart from the picture: another recording of the same take, or
   * this one's own sound lined up with the mouth (vision/offset heardFrom).
   * startSec here is startSec + offsetSec there.
   */
  audio?: { path: string; offsetSec: number } | null
  /** A conversion that goes first on the recording's picture: HDR to ordinary video (main/intake). */
  convert?: string | null
  /** The recording has no picture of its own: a plain black frame shows for it. */
  noPicture?: boolean
  /**
   * The one channel that carries the sound, when the other is empty (a
   * lavalier on one input of the camera): heard in both ears.
   */
  soundChannel?: 0 | 1
  /** Where the segment starts on the output clock. Absent: straight after the one before, less any transition. */
  outStart?: number
  /** Comes in over the segment before: the two overlap by `sec`, picture and sound. */
  transition?: { kind: TransitionKind; sec: number }
  /**
   * The picture's own stretch, when a J or L cut has moved it off the
   * sound's: where it starts in the source, how long it plays, and where it
   * starts on the output clock. The fields above are then the sound's.
   */
  picture?: { startSec: number; durationSec: number; outStart: number; srcSec?: number; steps?: SpeedStep[] }
  /** Source seconds the sound reads, when speed makes it differ from durationSec. */
  srcSec?: number
  /** Speed, sound and picture, in playing order. Absent plays as recorded. */
  steps?: SpeedStep[]
  /** Played backwards. */
  reverse?: boolean
  /** A freeze frame: the frame at startSec held for durationSec, silent. */
  hold?: boolean
  /** A camera move over the speaker's picture. */
  camera?: SegmentCamera
  /**
   * Another camera of the same take, in a box over the picture or beside it
   * (edit/angles): its file, read from startSec as the picture is read.
   */
  inset?: {
    path: string
    startSec: number
    layout: 'pip' | 'side'
    size: { width: number; height: number }
    convert?: string | null
  }
  /**
   * Where the speaker's picture looks when it is cropped to the frame: its
   * centre across the picture, 0 to 1, through keys on the segment's own
   * picture clock (edit/reframe). Absent: the middle.
   */
  framing?: FrameKey[]
  /**
   * Two to four pictures at once in a grid, instead of the frame the
   * treatment gives (edit/grid, main/grid-render): each panel's file and
   * where it is read from (path null for this segment's own picture), the
   * box it covers in output pixels, then the ground over them all, with the
   * panels' boxes cut out of it, and the labels, PNGs the frame's size.
   * `since` is how far into the grid this segment starts: the labels fade in
   * only where the grid does.
   */
  grid?: {
    panels: {
      path: string | null
      startSec: number
      still: boolean
      rect: { x: number; y: number; w: number; h: number }
      convert?: string | null
    }[]
    ground: string
    labels: string | null
    since: number
  }
  /**
   * The speaker's picture shown whole in the frame, on a blurred copy of
   * itself or between black bars, when its shape is far from the frame's
   * (edit/fill). Absent: cropped to fill it.
   */
  fill?: 'blur' | 'black'
}

/**
 * A camera move as one piece plays it: the move, how far into the beat's
 * picture this piece's picture starts, how long that picture runs, when the
 * move's word starts in it, and the size of the recording it moves over.
 */
export interface SegmentCamera {
  move: Camera
  offset: number
  length: number
  wordAt: number | null
  size: { width: number; height: number }
}

export type Quality = 'preview' | 'final' | 'intermediate'

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** A logo kept in one corner for the whole video. */
export interface LogoMark {
  path: string
  corner: Corner
  opacity: number
}

/** Motion graphics drawn by motion-render.ts: a file with alpha, placed at an output time. */
export interface OverlaySpan {
  path: string
  startSec: number
  durationSec: number
}

export interface GraphOptions {
  width: number
  height: number
  fps: number
  /** Drawn over everything, captions included. */
  logo?: LogoMark | null
  /** Motion graphics, over the captions and under the logo. */
  overlays?: OverlaySpan[] | null
  /**
   * Scene effects (main/fx-render): their picture work on the joined picture
   * before the look, and what they draw over it after the look and under the
   * captions.
   */
  fx?: { passes: FxPass[]; overlays: FxOverlayFile[] } | null
  /** An ASS file to burn in over the joined picture. */
  assPath: string | null
  /**
   * Burn it in RGB, between conversions said outright, rather than straight
   * onto the picture: for a caption colour this ffmpeg cannot draw in BT.709
   * on YUV (renderCut). It costs four conversions of every frame.
   */
  captionsInRgb?: boolean
  fontsDir: string | null
  /** Integrated loudness target in LUFS, or null to leave levels alone. */
  loudness: number | null
  /** The whole video fading in and out, picture and sound. */
  fade?: Fade | null
  /** Voice clean-up, from 0 to 1, over the whole sound before any music goes under it. */
  voice?: number
  /** A music bed under everything. */
  music?: BedOptions | null
  /** A look over the whole picture, before captions and the logo. */
  look?: Look | null
  /** Whether the look's LUT is a 3D one (most are) or a 1D curve per channel. */
  lutKind?: LutKind
  /** Old film over the graded picture (render/film.ts): the weave, and one loop of each layer's file. */
  film?: { fine: string | null; soft: string | null; weave: number } | null
  /** An ffmpeg metadata file of chapters to write into the video, which players show. */
  chaptersPath?: string | null
  /** Sound effects over the finished sound, before any music goes under it. */
  sfx?: SfxOptions[]
  quality: Quality
  outputPath: string
  /** How the picture is encoded: x264 when absent, as on a computer. */
  encoder?: Encoder
  /**
   * False for an ffmpeg built without its GPL parts, as a phone's is: camera
   * moves are drawn without the perspective filter (render/camera cropMove).
   */
  perspective?: boolean
}

/**
 * A sound effect as one pass plays it: its file, where on the output clock
 * it starts, how far into the file it starts from, and its gain.
 */
export interface SfxOptions {
  path: string
  startSec: number
  trimSec: number
  gainDb: number
}

/**
 * A music bed as one pass plays it: the track and where in it to start, the
 * gain that sets it where it should sit, how its level moves under speech,
 * and its fades.
 */
export interface BedOptions {
  path: string
  inSec: number
  gainDb: number
  keys: LevelKey[]
  fadeInSec: number
  fadeOutSec: number
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Stills are looped rather than seeked. */
/**
 * Pictures with no timeline: looped for as long as they show. AVIF, which
 * assets take as an image, is read by the MP4 reader, which has no -loop: it
 * comes in as one frame, held for its beat like any picture that runs short.
 */
const STILL = /\.(png|jpe?g|webp|bmp)$/i
/** Every image an asset can be: shown from its start, whatever the beat's in point. */
const IMAGE_FILE = /\.(png|jpe?g|webp|bmp|gif|avif)$/i
/** A GIF, still or animated: its own reader has no -loop, so it is played round with -stream_loop. */
const GIF = /\.gif$/i

/** How much is read to find the one frame a freeze holds. */
const HOLD_READ_SEC = 0.5

/** The ground a card sits on: Cutalong's own, so cards read as part of the edit. */
const CARD_GROUND = 'F5F5F3'

/*
 * Colour. HD video with no colour tags plays as BT.709 in QuickTime and in
 * Chrome, and so in the editor's preview, and the export passes a
 * recording's YUV through untouched, so it plays the same. What does not
 * pass through untouched is anything made in RGB and laid over it, or graded
 * in RGB: graphics, the logo, captions, a card's ground, stills, and a look.
 * Left to itself ffmpeg converts those with BT.601 on 6.0 and 6.1 (and on
 * 7.0 in some filters), which moves a brand colour by ten or more levels.
 * So every step into or out of RGB says BT.709, limited range, outright; it
 * goes through planar RGB at the picture's own size, the one path every
 * version converts exactly (converting while resizing ignores the matrix on
 * 6.0 and 6.1); and the export is tagged BT.709, so a player never guesses.
 */
/** YUV as BT.709 into planar RGB. */
export const TO_RGB = 'scale=in_color_matrix=bt709:in_range=tv,format=gbrp'
/** The frames tagged as what they are: BT.709, limited range. */
export const AS_BT709 = 'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv'
/** RGB back to YUV as BT.709, tagged. */
export const TO_YUV = `format=gbrp,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p,${AS_BT709}`
/** An RGB picture with alpha, to lay over the video: into YUV with alpha as BT.709. */
export const TO_YUVA = `format=gbrap,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p,${AS_BT709}`
/** A still or a GIF, decoded as its format says (JPEG as BT.601, full range), into YUV as BT.709, alpha kept for a card. */
const STILL_TO_YUV = `format=gbrap,scale=out_color_matrix=bt709:out_range=tv,format=yuva444p,${AS_BT709}`
/** The scene effects go into RGB and back, and lay their overlays on, as everything else does (shared/fx/ffmpeg). */
const FX_COLOUR = { toRgb: TO_RGB, toYuv: TO_YUV, toYuva: TO_YUVA }
/** What the encoder writes in the file, so a player reads it as BT.709 too. */
const TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv']

/** Output frame size for an aspect, halved for previews. */
export function frameSize(
  aspect: Aspect,
  source: { width: number; height: number },
  preview = false
): { width: number; height: number } {
  let width: number
  let height: number
  if (aspect === 'vertical') [width, height] = [1080, 1920]
  else if (aspect === 'square') [width, height] = [1080, 1080]
  else if (aspect === 'wide') [width, height] = [1920, 1080]
  else if (source.width <= 0 || source.height <= 0) {
    // A recording with no picture has no shape of its own: the usual wide frame.
    ;[width, height] = [1920, 1080]
  } else {
    // The recording's own shape, with the long side held to 1920.
    const long = Math.max(source.width, source.height, 2)
    const k = Math.min(1, 1920 / long)
    width = source.width * k
    height = source.height * k
  }
  const k = preview ? 0.5 : 1
  return { width: even(width * k), height: even(height * k) }
}

/** Common frame rates only: 29.97 renders as 30, 59.94 as 60. */
export function frameRate(fps: number): number {
  const options = [24, 25, 30, 50, 60]
  return options.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), 30)
}

// The caption look is shared with the editor's preview, so both draw captions alike.
export { captionStyleFor }

/** A recording's size when nothing better is known: most cutaways are wide. */
const WIDE = { width: 1920, height: 1080 }

/** Whether a recording has a picture of its own to show. */
function pictured(source: RenderSource): boolean {
  return source.hasVideo !== false && source.width > 0 && source.height > 0
}

/**
 * The inputs for each resolved piece, with its beat's look. `sizes` gives the
 * size of cutaway footage, which a camera move over it needs; `zscale` says
 * whether this ffmpeg can convert HDR the better way (main/intake).
 */
export function segmentsFor(
  cut: Cut,
  resolved: Resolved,
  sources: RenderSource[],
  sizes: Map<string, { width: number; height: number }> = new Map(),
  zscale = true
): Segment[] {
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const bySource = new Map(sources.map((s) => [s.id, s]))
  /** A move as this piece's picture plays it, from when the picture starts. */
  const moving = (move: Camera, beat: string, from: number, size: { width: number; height: number }): SegmentCamera => {
    const clock = cameraClock(resolved, beat, from, move.word) ?? { t: 0, length: 1, wordAt: null }
    return { move, offset: clock.t, length: clock.length, wordAt: clock.wordAt, size }
  }
  return resolved.pieces.map((p) => {
    const beat = beats.get(p.beat)
    const source = bySource.get(p.source)
    if (!beat || !source) throw new Error(`Piece of ${p.beat} has no beat or recording behind it.`)
    const t = beat.treatment
    const showsCutaway = (t.frame === 'broll' || t.frame === 'split' || t.frame === 'card') && t.broll !== null
    const picture = pictureSpan(p)
    const srcSec = p.srcEnd - p.srcStart
    const segment: Segment = {
      path: source.path,
      startSec: p.srcStart,
      durationSec: p.outEnd - p.outStart,
      hasAudio: source.hasAudio,
      audio: source.audio || source.hasAudio ? heardFrom(source) : null,
      treatment: t,
      broll: null,
      convert: colorConversion(source.color, zscale),
      outStart: p.outStart
    }
    if (!pictured(source)) segment.noPicture = true
    if (Math.abs(srcSec - segment.durationSec) > 1e-9) segment.srcSec = srcSec
    if (p.steps) segment.steps = p.steps
    if (p.reverse) segment.reverse = true
    if (p.hold !== undefined) {
      segment.hold = true
      // The frame showing at that moment, as a player shows it: the last to
      // start at or before it. Seeking finds the first at or after, so the
      // seek starts just under a frame earlier. Never past the last frame.
      const frame = 1 / Math.max(1, source.fps)
      let at = Math.max(0, p.srcStart - frame + 0.001)
      if (source.durationSec > 0.2) at = Math.min(at, source.durationSec - 0.1)
      segment.startSec = at
    }
    if (p.transition) segment.transition = p.transition
    if (p.picture) {
      // The picture keeps its piece's clock past either end, at the end's speed.
      const steps = p.steps ?? [{ srcSec, speed: 1 }]
      segment.picture = {
        startSec: p.picture.srcStart,
        durationSec: p.picture.outEnd - p.picture.outStart,
        outStart: p.picture.outStart,
        srcSec: p.picture.srcEnd - p.picture.srcStart,
        steps: p.steps ? sliceSteps(steps, p.picture.srcStart - p.srcStart, p.picture.srcEnd - p.srcStart) : undefined
      }
    }
    if (showsCutaway && t.broll) {
      // A cutaway runs on its own clock from when its beat's picture starts,
      // at its own speed, held by a freeze like everything else on screen.
      const shows = picture.outEnd - picture.outStart
      const clock = cutawayClock(resolved, p.beat, picture.outStart) ?? { offset: 0, length: shows, held: false }
      const at = cutawayAt(t.broll, clock.length, clock.offset)
      const steps = cutawaySteps(t.broll, clock.length)
      if (p.hold !== undefined) {
        segment.broll = { path: t.broll.path, startSec: at.srcSec, hold: true }
      } else {
        const sliced = steps
          ? sliceSteps(steps, outToSrc(steps, clock.offset), outToSrc(steps, clock.offset + shows))
          : undefined
        const reads = sliced ? srcLength(sliced) : shows
        segment.broll = { path: t.broll.path, startSec: t.broll.reverse ? Math.max(0, at.srcSec - reads) : at.srcSec }
        if (sliced) segment.broll.steps = sliced
        if (t.broll.reverse) segment.broll.reverse = true
      }
      // A card stays still; anything else can move.
      if (t.broll.camera && t.frame !== 'card') {
        segment.broll.camera = moving(t.broll.camera, p.beat, picture.outStart, sizes.get(t.broll.path) ?? WIDE)
      }
    }
    if (t.camera) segment.camera = moving(t.camera, p.beat, picture.outStart, pictured(source) ? source : WIDE)
    return segment
  })
}

/**
 * The segments a cut plays, its other cameras included: a beat shown through
 * another camera reads that camera's file (edit/angle-view), and one with a
 * camera beside it or in a box over it carries that camera as an inset.
 * Given the frame, a picture of another shape is marked to be shown whole
 * (edit/fill), from the recordings' shapes and the cutaways' in `sizes`.
 */
export function cameraSegments(
  cut: Cut,
  resolved: Resolved,
  sources: RenderSource[],
  sizes: Map<string, { width: number; height: number }> = new Map(),
  zscale = true,
  frame: { width: number; height: number } | null = null
): Segment[] {
  const seen = viewThroughAngles(cut, resolved, sources)
  const segments = segmentsFor(cut, seen.resolved, seen.sources, sizes, zscale)
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const bySource = new Map(seen.sources.map((s) => [s.id, s]))
  seen.resolved.pieces.forEach((p, i) => {
    const inset = p.reverse ? null : insetFor(cut, p, seen.sources)
    if (inset) {
      segments[i].inset = { path: inset.path, startSec: inset.srcStart, layout: inset.layout, size: inset.size }
    }
    // Following the speaker, or framed by hand (edit/reframe).
    const beat = beats.get(p.beat)
    const source = bySource.get(p.source)
    const framing = beat ? pieceFraming(cut, beat.treatment, p, source?.subject) : null
    if (framing) segments[i].framing = framing
    if (frame && beat) {
      const fit = pictureFit(cut, beat, source && pictured(source) ? source : null, frame)
      if (fit !== 'cover' && !segments[i].noPicture) segments[i].fill = fit
      const b = segments[i].broll
      const cutaway = b ? cutawayFit(cut, beat, sizes.get(b.path) ?? null, frame) : 'cover'
      if (b && cutaway !== 'cover') b.fill = cutaway
    }
  })
  return segments
}

/**
 * A crop's left edge that keeps its window's centre on a path across the
 * picture: eased between keys as the preview eases, never past an edge. `t`
 * is the crop filter's own clock, the segment's picture from its start.
 */
export function framingX(keys: FrameKey[], w: number): string {
  const n = (v: number): string => v.toFixed(4)
  let centre = n(keys[keys.length - 1].x)
  for (let i = keys.length - 1; i >= 1; i--) {
    const a = keys[i - 1]
    const b = keys[i]
    if (b.t - a.t <= 1e-6) continue
    const k = `((t-${n(a.t)})/${n(b.t - a.t)})`
    centre = `if(lt(t,${n(b.t)}),${n(a.x)}+${n(b.x - a.x)}*${k}*${k}*(3-2*${k}),${centre})`
  }
  return `clip((if(lt(t,${n(keys[0].t)}),${n(keys[0].x)},${centre}))*iw-${w}/2,0,iw-${w})`
}

/**
 * A path as a filter argument, quotes and all. ffmpeg reads a filter graph in
 * two passes, the graph and then the filter's own options: each character
 * special to the options is escaped for the second pass, and the whole is
 * quoted for the first. A quote can't be escaped inside quotes, so it closes
 * them, comes escaped, and opens them again. (A LUT in "Mike's LUTs" failed
 * the export.)
 */
export function filterPath(path: string): string {
  const inner = path.replace(/\\/g, '/').replace(/[':]/g, '\\$&')
  return `'${inner.replace(/'/g, "'\\''")}'`
}

const fixed = (n: number): string => n.toFixed(3)
/** Times that must land on a frame or a sample: microseconds, which ffmpeg reads exactly. */
const exact = (n: number): string => n.toFixed(6)

/**
 * Where a slide's new picture sits, `q` (an expression from 0 to 1) of the way
 * through, as overlay positions: it comes in from `from` over the old picture
 * and ends covering it, as xfade's coverleft, coverright, coverup and
 * coverdown move it (measured: coverleft comes in from the right).
 */
export function coverAt(from: 'left' | 'right' | 'top' | 'bottom' | undefined, q: string): { x: string; y: string } {
  if (from === 'right') return { x: `W*(1-${q})`, y: '0' }
  if (from === 'left') return { x: `-W*(1-${q})`, y: '0' }
  if (from === 'bottom') return { x: '0', y: `H*(1-${q})` }
  return { x: '0', y: `-H*(1-${q})` }
}

/** Where each segment's sound sits on the output clock. */
export function segmentSpans(segments: Segment[]): { outStart: number; outEnd: number }[] {
  const spans: { outStart: number; outEnd: number }[] = []
  for (const s of segments) {
    const prev = spans[spans.length - 1]
    const outStart = s.outStart ?? (prev ? prev.outEnd - (s.transition?.sec ?? 0) : 0)
    spans.push({ outStart, outEnd: outStart + s.durationSec })
  }
  return spans
}

/** Where each segment's picture sits on the output clock: with its sound, unless a J or L cut moved it. */
export function pictureSpans(
  segments: Segment[],
  spans = segmentSpans(segments)
): { outStart: number; outEnd: number }[] {
  return segments.map((s, k) =>
    s.picture ? { outStart: s.picture.outStart, outEnd: s.picture.outStart + s.picture.durationSec } : spans[k]
  )
}

/**
 * An input's picture as it enters the graph, before anything else is done to
 * it: the one place per-recording conversions belong (HDR to ordinary video,
 * from main/intake), so every stretch of a recording gets them.
 */
function sourcePicture(input: number, convert?: string | null): string {
  return `[${input}:v]${convert ? `${convert},` : ''}`
}

/** The ffmpeg arguments for one pass over a list of segments. */
export function buildRenderArgs(segments: Segment[], opts: GraphOptions): string[] {
  if (segments.length === 0) throw new Error('There is nothing in the cut to render.')
  const { width: W, height: H, fps } = opts
  const inputs: string[] = []
  const chains: string[] = []
  let next = 0
  const input = (path: string, start: number, duration: number): number => {
    // A still has no timeline to seek: it is looped for as long as it shows.
    if (GIF.test(path)) inputs.push('-stream_loop', '-1', '-t', fixed(duration), '-i', path)
    else if (STILL.test(path)) inputs.push('-loop', '1', '-t', fixed(duration), '-i', path)
    else inputs.push('-ss', fixed(Math.max(0, start)), '-t', fixed(duration), '-i', path)
    return next++
  }

  /**
   * A picture whole in a w x h box (edit/fill): scaled to fit it, between
   * black bars, or over a blurred, darker copy of itself. The copy is cut from
   * the same frames by split, so it opens no input of its own; it is cropped
   * to cover the box at a small size, blurred and darkened there, and scaled
   * back up, as the preview draws it. It stays YUV, every plane at full size
   * while it is small, and is darkened toward video black (16, 128, 128),
   * which is the picture's red, green and blue each times BACKDROP_LEVEL
   * whatever matrix it was made with; a trip through RGB would need that
   * matrix, and an HDR clip converted to BT.709 came back the wrong colour.
   * The picture sits on even pixels, so its colour stays on the chroma grid.
   * `name` keeps the labels apart.
   */
  const whole = (w: number, h: number, fit: 'blur' | 'black', name: string): string => {
    const fitted = `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
    if (fit === 'black') return `${fitted},pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
    const small = backdropSize({ width: w, height: h })
    const k = BACKDROP_LEVEL.toFixed(3)
    return [
      `split=2[${name}w][${name}c]`,
      `[${name}c]scale=${small.width}:${small.height}:force_original_aspect_ratio=increase:flags=area,` +
        `crop=${small.width}:${small.height},setsar=1,format=yuv444p,gblur=sigma=${BACKDROP_SIGMA}:steps=2,` +
        `lutyuv=y=16+(val-16)*${k}:u=128+(val-128)*${k}:v=128+(val-128)*${k},` +
        `scale=${w}:${h}:flags=bilinear,format=yuv420p,setsar=1[${name}g]`,
      `[${name}w]${fitted},format=yuv420p[${name}p]`,
      `[${name}g][${name}p]overlay=x='trunc((W-w)/4)*2':y='trunc((H-h)/4)*2',setsar=1`
    ].join(';')
  }

  /**
   * Scale to cover w x h, crop the overflow, then apply the look; or, with a
   * fill, show the picture whole and fill the rest of the box (`whole`).
   */
  const look = (
    w: number,
    h: number,
    t: Treatment | null,
    zoom: boolean,
    framing?: FrameKey[],
    fill?: { fit: 'blur' | 'black'; name: string }
  ): string => {
    // Cropped to the frame's shape: in the middle, or where the speaker is.
    const crop = framing?.length ? `crop=${w}:${h}:x='${framingX(framing, w)}':y=(ih-${h})/2` : `crop=${w}:${h}`
    let f = fill
      ? `fps=${fps},${whole(w, h, fill.fit, fill.name)}`
      : `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,${crop},setsar=1`
    const z = t?.zoom ?? 1
    // A punch-in rarely crops to exactly the frame's shape (1080/1.12 is 964.3), so
    // scaling it back up stretches the pixels a hair; square them again, or the
    // join refuses pieces whose pixel shapes differ and the export fails.
    if (zoom && z > 1.001)
      f += `,crop=trunc(iw/${z.toFixed(4)}/2)*2:trunc(ih/${z.toFixed(4)}/2)*2,scale=${w}:${h},setsar=1`
    if (t?.bw) f += ',hue=s=0'
    return f
  }

  /**
   * A camera move over a picture that ends up `w` x `h`: the recording read at
   * enough detail for the closest the move gets (never more than it has), its
   * frame carried to the corners by perspective, then brought to size. The
   * look that follows then has nothing left to scale or crop.
   */
  const moveOver = (cam: SegmentCamera | undefined, w: number, h: number): string => {
    if (!cam) return ''
    const plan = cameraPlan(cam.move, cam.length, cam.wordAt, cam.size.width / Math.max(1, cam.size.height), w / h)
    const read = even(Math.min(cam.size.width, Math.ceil((w * maxZoom(plan)) / plan.fw)))
    if (opts.perspective === false) {
      // An ffmpeg without its GPL parts, as a phone's: the same window, scaled and cropped.
      const picture = { width: read, height: even((read * cam.size.height) / Math.max(1, cam.size.width)) }
      const move = cropMove(plan, cam.offset, fps, picture, { width: w, height: h })
      return `fps=${fps},scale=${picture.width}:${picture.height},${move},setsar=1,`
    }
    return `fps=${fps},scale=${read}:-2,${perspectiveFor(plan, cam.offset, fps, w / h)},scale=${w}:${h},setsar=1,`
  }

  // Frames are counted on the clock the segments share, then made relative to
  // the first, so a chunk rounds exactly as the same stretch of the whole cut.
  // Sound runs on its spans; picture on its own, which a J or L cut moves.
  const spans = segmentSpans(segments)
  const pics = pictureSpans(segments, spans)
  const base = Math.round(spans[0].outStart * fps)
  const frameAt = (sec: number): number => Math.round(sec * fps) - base
  const framesOf = (k: number): number => Math.max(1, frameAt(pics[k].outEnd) - frameAt(pics[k].outStart))
  /**
   * How far to move a read that serves a segment's picture alone, so its
   * first frame is the one the editor's player shows where the segment's
   * first output frame falls: the segment starts on the output's frame grid
   * rather than exactly where its piece does, and a seek keeps the first
   * frame at or after its time where a player shows the one under it, so the
   * nearest is taken. Another camera of a recording (edit/angles), and each
   * panel of a grid, then show the frame the editor does.
   */
  const onGrid = (k: number): number => Math.round(pics[k].outStart * fps) / fps - pics[k].outStart - 0.5 / fps
  /**
   * A picture made exactly `frames` long: held on its last frame if it runs
   * short, cut if it runs long. A freeze is one frame held for `padSec`.
   */
  const exactly = (frames: number, padSec = 1): string =>
    `tpad=stop_mode=clone:stop_duration=${fixed(padSec)},trim=end_frame=${frames},setpts=PTS-STARTPTS,settb=1/${fps}`

  /** Retimes a picture through its speed steps, on a clock that starts at zero. */
  const retime = (steps: SpeedStep[] | undefined): string =>
    changesSpeed(steps) ? `setpts=PTS-STARTPTS,${speedPts(steps)},` : ''

  /** Labels n..1 down to 0: slices played backwards join latest first. */
  const latestFirst = (n: number, prefix: string): string =>
    Array.from({ length: n }, (_, i) => `[${prefix}${n - 1 - i}]`).join('')

  /**
   * A stretch of a recording played backwards. Its inputs open now, as the
   * sound may need them; its picture is built only when something shows it,
   * since a filter whose output goes nowhere stops the graph. Each slice is
   * brought to the frame rate and frame size before the reverse filter holds
   * it, which keeps what it holds small.
   */
  const backwards = (
    path: string,
    start: number,
    len: number,
    name: string,
    convert?: string | null
  ): { inputs: number[]; slices: { start: number; len: number }[]; picture: () => string } => {
    const slices = reverseSlices(start, len)
    const inputs = slices.map((sl) => input(path, sl.start, sl.len))
    let built = false
    const picture = (): string => {
      if (!built) {
        built = true
        inputs.forEach((n, i) =>
          chains.push(
            `${sourcePicture(n, convert)}setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,reverse[${name}r${i}]`
          )
        )
        chains.push(
          `${latestFirst(inputs.length, `${name}r`)}concat=n=${inputs.length}:v=1:a=0,setpts=PTS-STARTPTS[${name}]`
        )
      }
      return `[${name}]`
    }
    return { inputs, slices, picture }
  }

  /**
   * The better sound for `len` seconds of a recording from `start`, read from
   * the other recording it is lined up with, where that moment is offsetSec
   * later, and played backwards if asked. Where the other recording starts
   * after the stretch does, the gap is silence rather than a shifted voice:
   * at the front, or at the end when it plays backwards, where the padding
   * that sizes every segment's sound puts it. Null when it has none of it.
   */
  const linedSound = (
    lined: { path: string; offsetSec: number },
    start: number,
    len: number,
    reverse: boolean,
    name: string
  ): string | null => {
    const from = start + lined.offsetSec
    const lead = Math.max(0, -from)
    const length = len - lead
    if (length <= 0.01) return null
    if (!reverse) {
      const ext = input(lined.path, Math.max(0, from), length)
      // adelay leaves the timestamps where they were; counting samples puts them right.
      return lead > 0 ? `[${ext}:a]adelay=${Math.round(lead * 1000)}:all=1,asetpts=N/SR/TB,` : `[${ext}:a]`
    }
    const slices = reverseSlices(Math.max(0, from), length)
    const ins = slices.map((sl) => input(lined.path, sl.start, sl.len))
    ins.forEach((n, i) =>
      chains.push(`[${n}:a]asetpts=PTS-STARTPTS,apad,atrim=duration=${exact(slices[i].len)},areverse[${name}e${i}]`)
    )
    chains.push(`${latestFirst(ins.length, `${name}e`)}concat=n=${ins.length}:v=0:a=1[${name}x]`)
    return `[${name}x]`
  }

  segments.forEach((s, k) => {
    const v = `v${k}`
    const a = `a${k}`
    const t = s.treatment
    // Held on its last frame for as long as the beat needs: a cutaway shorter
    // than its beat, or a recording whose picture stops before its sound, would
    // otherwise come up short and pull every later picture ahead of its sound.
    const frames = exactly(framesOf(k), (s.hold ? s.durationSec : (s.picture?.durationSec ?? s.durationSec)) + 1)
    // Source each side reads: as long as it plays, unless speed changes that.
    const soundSrc = s.srcSec ?? s.durationSec
    const pic = s.picture
      ? { startSec: s.picture.startSec, srcSec: s.picture.srcSec ?? s.picture.durationSec, steps: s.picture.steps }
      : { startSec: s.startSec, srcSec: soundSrc, steps: s.steps }
    const showFor = s.picture ? s.picture.durationSec : s.durationSec
    // Where the speaker's picture looks when cropped; a camera move frames it itself.
    const aim = s.camera ? undefined : s.framing

    // The speaker: its picture ready for a look, built only if something
    // shows it, and its sound cut from the same input, ready to be timed; or,
    // when the better sound is another recording's, from that one.
    let speaker: () => string
    let sound: string | null = null
    if (s.hold) {
      // A freeze: one frame, held. The sound waits, silent.
      speaker = () =>
        `${sourcePicture(input(s.path, s.startSec, HOLD_READ_SEC), s.convert)}trim=end_frame=1,setpts=PTS-STARTPTS,`
    } else if (s.reverse) {
      const back = backwards(s.path, s.startSec, soundSrc, `${v}s`, s.convert)
      speaker = () => `${back.picture()}${retime(s.steps)}`
      if (s.audio) sound = linedSound(s.audio, s.startSec, soundSrc, true, a)
      else if (s.hasAudio) {
        back.inputs.forEach((n, i) =>
          chains.push(
            `[${n}:a]asetpts=PTS-STARTPTS,apad,atrim=duration=${exact(back.slices[i].len)},areverse[${a}r${i}]`
          )
        )
        chains.push(`${latestFirst(back.inputs.length, `${a}r`)}concat=n=${back.inputs.length}:v=0:a=1[${a}j]`)
        sound = `[${a}j]`
      }
    } else if (s.audio) {
      // The picture alone from this input, the sound from the recording it is lined up with: read
      // from the frame the editor shows where this segment's first output frame falls (onGrid).
      const main = input(s.path, pic.startSec + onGrid(k), pic.srcSec)
      speaker = () => `${sourcePicture(main, s.convert)}${retime(pic.steps)}`
      sound = linedSound(s.audio, s.startSec, soundSrc, false, a)
    } else {
      // One input covers both the sound and the picture; each is cut from it.
      const inStart = Math.min(s.startSec, pic.startSec)
      const inEnd = Math.max(s.startSec + soundSrc, pic.startSec + pic.srcSec)
      const main = input(s.path, inStart, inEnd - inStart)
      const differs = (from: number, len: number): boolean =>
        Math.abs(from - inStart) > 1e-9 || Math.abs(from + len - inEnd) > 1e-9
      const cutPicture = differs(pic.startSec, pic.srcSec)
        ? `trim=start=${exact(pic.startSec - inStart)}:duration=${exact(pic.srcSec)},setpts=PTS-STARTPTS,`
        : ''
      speaker = () => `${sourcePicture(main, s.convert)}${cutPicture}${retime(pic.steps)}`
      if (s.hasAudio) {
        const cutSound = differs(s.startSec, soundSrc)
          ? `atrim=start=${exact(s.startSec - inStart)}:duration=${exact(soundSrc)},asetpts=PTS-STARTPTS,`
          : ''
        sound = `[${main}:a]${cutSound}`
      }
    }

    // A recording with no picture (a podcast, a voice memo) shows a plain
    // black frame for as long as it plays; cutaways and captions go over it.
    if (s.noPicture) speaker = () => `color=c=black:s=${W}x${H}:r=${fps}:d=${fixed(showFor + 1)},`

    // The cutaway ready for a look: its stretch of footage, backwards or held
    // as asked, through its own speed. A still simply shows for as long.
    const cutaway = (): string => {
      const b = s.broll as NonNullable<Segment['broll']>
      if (IMAGE_FILE.test(b.path)) return `${sourcePicture(input(b.path, 0, showFor))}${STILL_TO_YUV},`
      if (b.hold)
        return `${sourcePicture(input(b.path, b.startSec, HOLD_READ_SEC), b.convert)}trim=end_frame=1,setpts=PTS-STARTPTS,`
      const reads = b.steps ? srcLength(b.steps) : showFor
      if (b.reverse) return `${backwards(b.path, b.startSec, reads, `${v}c`, b.convert).picture()}${retime(b.steps)}`
      return `${sourcePicture(input(b.path, b.startSec, reads), b.convert)}${retime(b.steps)}`
    }

    if (t === null) {
      chains.push(`${speaker()}fps=${fps},setsar=1,format=yuv420p,${AS_BT709},${frames}[${v}]`)
    } else if (s.grid) {
      // A grid (main/grid-render): each panel scaled to cover its box on a
      // plain frame, held on its last frame if it runs out, then the ground
      // over them with their boxes cut out, then the labels, fading in where
      // the grid starts. Footage keeps its YUV; a still, the ground and the
      // labels, made in RGB, go into YUV as BT.709 at their own size first,
      // as a cutaway's still and the graphics do.
      const g = s.grid
      chains.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${fixed(showFor + 1)}[${v}g0]`)
      let under = `${v}g0`
      let ownUsed = false
      g.panels.forEach((p, i) => {
        const own = p.path === null && !ownUsed
        if (p.path === null && !own) return
        if (own) ownUsed = true
        const source = own
          ? speaker()
          : p.still
            ? `${sourcePicture(input(p.path as string, 0, showFor))}${STILL_TO_YUV},`
            : sourcePicture(input(p.path as string, p.startSec + onGrid(k), showFor), p.convert)
        const { x, y, w, h } = p.rect
        chains.push(
          `${source}fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1${t.bw ? ',hue=s=0' : ''}[${v}p${i}]`
        )
        chains.push(`[${under}][${v}p${i}]overlay=x=${x}:y=${y}:eof_action=repeat[${v}g${i + 1}]`)
        under = `${v}g${i + 1}`
      })
      const ground = input(g.ground, 0, showFor)
      chains.push(`[${ground}:v]${TO_YUVA}[${v}gy]`)
      chains.push(`[${under}][${v}gy]overlay=0:0:shortest=1[${v}gg]`)
      under = `${v}gg`
      if (g.labels) {
        const words = input(g.labels, 0, showFor)
        const fade = g.since < 0.01 ? `,fade=t=in:st=0:d=${exact(LABEL_FADE)}:alpha=1` : ''
        chains.push(`[${words}:v]format=rgba${fade},${TO_YUVA}[${v}gw]`)
        chains.push(`[${under}][${v}gw]overlay=0:0:shortest=1[${v}gl]`)
        under = `${v}gl`
      }
      chains.push(`[${under}]format=yuv420p,${AS_BT709},${frames}[${v}]`)
    } else if (s.broll && t.frame === 'split') {
      const half = even(H / 2)
      chains.push(`${cutaway()}${moveOver(s.broll.camera, W, half)}${look(W, half, t, false)}[${v}t]`)
      chains.push(`${speaker()}${moveOver(s.camera, W, H - half)}${look(W, H - half, t, true, aim)}[${v}b]`)
      chains.push(`[${v}t][${v}b]vstack,format=yuv420p,${AS_BT709},${frames}[${v}]`)
    } else if (s.broll && t.frame === 'card') {
      // A card: the picture centred on Cutalong's ground, at most 60% of the
      // frame, with the speaker's voice carrying on underneath.
      const box = even(Math.min(W, H) * 0.6)
      chains.push(`color=c=0x${CARD_GROUND}:s=${W}x${H}:r=${fps}:d=${fixed(showFor)},${TO_YUV}[${v}g]`)
      chains.push(
        `${cutaway()}fps=${fps},scale=${box}:${box}:force_original_aspect_ratio=decrease,setsar=1${t.bw ? ',hue=s=0' : ''}[${v}i]`
      )
      chains.push(`[${v}g][${v}i]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p,${AS_BT709},${frames}[${v}]`)
    } else if (s.broll) {
      // The cutaway fills the frame, or shows whole in it; the speaker's input is only heard.
      const fill = s.broll.fill ? { fit: s.broll.fill, name: `${v}fb` } : undefined
      chains.push(
        `${cutaway()}${moveOver(s.broll.camera, W, H)}${look(W, H, t, false, undefined, fill)},format=yuv420p,${AS_BT709},${frames}[${v}]`
      )
    } else if (s.inset) {
      // Another camera of the same moment, read as the picture is: held with
      // a freeze, through the same speed.
      const inset = s.inset
      const other = (): string =>
        s.hold
          ? `${sourcePicture(input(inset.path, inset.startSec, HOLD_READ_SEC), inset.convert)}trim=end_frame=1,setpts=PTS-STARTPTS,`
          : `${sourcePicture(input(inset.path, inset.startSec, pic.srcSec), inset.convert)}${retime(pic.steps)}`
      if (inset.layout === 'side') {
        // Side by side across a wide frame, one above the other in a tall one; the recording first.
        const across = W > H
        const [aw, ah] = across ? [even(W / 2), H] : [W, even(H / 2)]
        const [bw, bh] = across ? [W - aw, H] : [W, H - ah]
        chains.push(`${speaker()}${moveOver(s.camera, aw, ah)}${look(aw, ah, t, true, aim)}[${v}a]`)
        chains.push(`${other()}${look(bw, bh, t, false)}[${v}b]`)
        chains.push(`[${v}a][${v}b]${across ? 'hstack' : 'vstack'},format=yuv420p,${AS_BT709},${frames}[${v}]`)
      } else {
        const box = pipBox({ width: W, height: H }, inset.size)
        chains.push(`${speaker()}${moveOver(s.camera, W, H)}${look(W, H, t, true, aim)}[${v}m]`)
        chains.push(`${other()}${look(box.width, box.height, t, false)}[${v}p]`)
        chains.push(`[${v}m][${v}p]overlay=x=${box.x}:y=${box.y},format=yuv420p,${AS_BT709},${frames}[${v}]`)
      }
    } else {
      const fill = s.fill ? { fit: s.fill, name: `${v}fs` } : undefined
      chains.push(
        `${speaker()}${moveOver(s.camera, W, H)}${look(W, H, t, true, aim, fill)},format=yuv420p,${AS_BT709},${frames}[${v}]`
      )
    }

    // Every segment's audio is exactly as long as its piece: through its
    // speed, which atempo changes without changing the pitch, then padded
    // with silence and trimmed, so the join never drifts out of sync.
    const both = s.soundChannel === undefined ? '' : `pan=stereo|c0=c${s.soundChannel}|c1=c${s.soundChannel},`
    const shape = `${both}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${exact(s.durationSec)},asetpts=PTS-STARTPTS`
    if (sound !== null && changesSpeed(s.steps)) {
      chains.push(`${sound}anull[${a}c]`)
      chains.push(speedSound(s.steps, `${a}c`, `${a}t`, a))
      sound = `[${a}t]`
    }
    if (sound !== null) chains.push(`${sound}${shape}[${a}]`)
    else chains.push(`anullsrc=r=48000:cl=stereo,${shape}[${a}]`)
  })

  // Runs of segments joined by hard cuts, and the transitions between runs.
  const overlapFrames = (k: number): number => frameAt(pics[k - 1].outEnd) - frameAt(pics[k].outStart)
  const runs: number[][] = []
  segments.forEach((s, k) => {
    if (runs.length === 0 || s.transition) runs.push([k])
    else runs[runs.length - 1].push(k)
  })

  // concat hands its output a microsecond timebase, and xfade refuses two
  // pictures on different timebases, so every run is put back on frames.
  // xfade also wants to be told the pictures are at a steady rate: ffmpeg 7
  // forgets the rate after setpts and concat, and refuses the transition
  // outright. fps on pictures already on the frame grid changes no frame and
  // says the rate again; on ffmpeg 6.0 it also adds a frame or two at the
  // end, so the picture is then cut back to exactly its frames.
  const steady = (frames: number): string => `settb=1/${fps},fps=${fps},trim=end_frame=${frames}`
  const runFrames = (run: number[]): number => run.reduce((sum, k) => sum + framesOf(k), 0)
  const joinRun = (run: number[], name: { v: string; a: string }, toTransition: boolean): void => {
    if (run.length === 1) {
      chains.push(
        `[v${run[0]}]${toTransition ? steady(framesOf(run[0])) : 'null'}[${name.v}]`,
        `[a${run[0]}]anull[${name.a}]`
      )
      return
    }
    chains.push(
      `${run.map((k) => `[v${k}]`).join('')}concat=n=${run.length}:v=1:a=0,${toTransition ? steady(runFrames(run)) : `settb=1/${fps}`}[${name.v}]`
    )
    chains.push(`${run.map((k) => `[a${k}]`).join('')}concat=n=${run.length}:v=0:a=1[${name.a}]`)
  }

  if (runs.length === 1) {
    joinRun(runs[0], { v: 'vcat', a: 'acat' }, false)
  } else {
    let vAcc = ''
    let aAcc = ''
    /** How many frames the picture so far runs. */
    let accFrames = 0
    runs.forEach((run, r) => {
      const last = r === runs.length - 1
      joinRun(run, { v: `vr${r}`, a: `ar${r}` }, true)
      if (r === 0) {
        vAcc = `vr${r}`
        aAcc = `ar${r}`
        accFrames = runFrames(run)
        return
      }
      const k = run[0]
      const kind = (segments[k].transition as { kind: TransitionKind }).kind
      const info = transitionInfo(kind)
      const duration = overlapFrames(k) / fps
      const vOut = last ? 'vcat' : `vx${r}`
      // The old picture plays up to the transition (o frames), the two meet
      // for d frames, and the new one plays on to its end.
      const o = frameAt(spans[k].outStart)
      const d = overlapFrames(k)
      const total = o + runFrames(run)
      if (d < 1) {
        // Shorter than a frame once both ends land on frames: the pictures
        // simply cut, while the sound still crossfades below.
        chains.push(`[${vAcc}][vr${r}]concat=n=2:v=1:a=0,${steady(accFrames + runFrames(run))}[${vOut}]`)
        accFrames += runFrames(run)
      } else {
        // Made in three pieces cut by frame and joined: the old picture up to
        // the transition, the transition itself from two pictures exactly as
        // long as it, and the new picture after it. xfade over the whole of
        // both pictures repeats a frame on ffmpeg 6.0, the one the Mac app
        // ships, and leaves the rest of the new picture a frame late; over
        // pictures exactly its length it is exact on every version.
        const c = `vc${r}`
        const half = exact(duration / 2)
        chains.push(`[${vAcc}]split=2[${c}a0][${c}a1]`, `[vr${r}]split=2[${c}b0][${c}b1]`)
        chains.push(`[${c}a0]trim=end_frame=${o},setpts=PTS-STARTPTS[${c}before]`)
        chains.push(`[${c}a1]trim=start_frame=${o}:end_frame=${o + d},setpts=PTS-STARTPTS,${steady(d)}[${c}under]`)
        chains.push(`[${c}b0]trim=end_frame=${d},setpts=PTS-STARTPTS,${steady(d)}[${c}over]`)
        chains.push(`[${c}b1]trim=start_frame=${d},setpts=PTS-STARTPTS[${c}after]`)
        const xfade = (transition: string): string =>
          `xfade=transition=${transition}:duration=${exact(duration)}:offset=0`
        if (info.preview === 'cover') {
          // A slide: the new picture moves in over the old one, which holds
          // still. xfade's cover transitions arrived in ffmpeg 6.1, so the new
          // picture is laid over the old with overlay, which every version
          // has, and moved as xfade's cover moves it.
          const at = coverAt(info.from, `clip(t/${exact(duration)},0,1)`)
          chains.push(`[${c}under][${c}over]overlay=x='${at.x}':y='${at.y}',format=yuv420p[${c}meet]`)
        } else if (info.preview === 'dip') {
          // A dip: the old picture is all the way to the colour by the middle,
          // the new one comes up from it after, and a dissolve joins the two.
          const color = info.color ?? 'black'
          chains.push(`[${c}under]fade=t=out:st=0:d=${half}:color=${color}[${c}ua]`)
          chains.push(`[${c}over]fade=t=in:st=${half}:d=${half}:color=${color}[${c}ob]`)
          chains.push(`[${c}ua][${c}ob]${xfade('fade')},format=yuv420p[${c}meet]`)
        } else if (info.preview === 'whip') {
          // A whip pan is a fast push with motion blur across its middle.
          const sigma = Math.max(4, Math.round(W / 40))
          chains.push(
            `[${c}under][${c}over]${xfade(info.xfade)},gblur=sigma=${sigma}:sigmaV=0:enable='between(t,${exact(duration * 0.15)},${exact(duration * 0.85)})',format=yuv420p[${c}meet]`
          )
        } else {
          chains.push(`[${c}under][${c}over]${xfade(info.xfade)},format=yuv420p[${c}meet]`)
        }
        // The transition's frames are stamped again by their count: ffmpeg 6.0's
        // xfade leaves timestamps that the join reads a frame long.
        chains.push(`[${c}meet]setpts=N/(${fps}*TB)[${c}meets]`)
        chains.push(`[${c}before][${c}meets][${c}after]concat=n=3:v=1:a=0,${steady(total)}[${vOut}]`)
        accFrames = total
      }
      // The sound crossfades over the same overlap, equal power so the room
      // tone neither dips nor swells.
      const aOut = last ? 'acat' : `ax${r}`
      const overlap = spans[k - 1].outEnd - spans[k].outStart
      chains.push(`[${aAcc}][ar${r}]acrossfade=d=${exact(overlap)}:c1=qsin:c2=qsin[${aOut}]`)
      vAcc = vOut
      aAcc = aOut
    })
  }

  const totalFrames = frameAt(pics[pics.length - 1].outEnd)
  const totalSec = spans[spans.length - 1].outEnd - spans[0].outStart

  let vOut = 'vcat'
  const addInput = (path: string): number => {
    inputs.push('-i', path)
    return next++
  }
  // ---- Scene effects on the picture (shared/fx): before the look, as the preview draws them under it ----
  if (opts.fx?.passes.length) {
    const fx = pictureFxChains(opts.fx.passes, vOut, addInput, fps, totalFrames, FX_COLOUR)
    chains.push(...fx.chains)
    vOut = fx.out
  }
  // The look goes over the whole picture, cutaways and cards included, and
  // under the captions and the logo, which keep their own colours. Its LUT,
  // colour and vignette work in RGB as BT.709, the RGB the preview grades.
  const grade = opts.look
  const lutOn = !!grade?.lut && grade.lut.strength > 0.005
  const inRgb = grade ? lookRgbFilters(grade) : []
  if (lutOn || inRgb.length > 0) {
    // From the picture as it is so far: with scene effects on it, theirs.
    chains.push(`[${vOut}]${TO_RGB}[vrgb]`)
    let rgb = 'vrgb'
    if (grade?.lut && lutOn) {
      // A LUT at less than full strength is mixed back with the picture it came from.
      const lut =
        opts.lutKind === '1d'
          ? `lut1d=file=${filterPath(grade.lut.path)}:interp=linear`
          : `lut3d=file=${filterPath(grade.lut.path)}:interp=tetrahedral`
      const k = grade.lut.strength.toFixed(3)
      if (grade.lut.strength >= 0.999) chains.push(`[vrgb]${lut}[vlut]`)
      else {
        chains.push(`[vrgb]split=2[vla][vlb]`, `[vlb]${lut}[vlc]`)
        chains.push(`[vla][vlc]blend=all_expr='A*(1-${k})+B*${k}'[vlut]`)
      }
      rgb = 'vlut'
    }
    chains.push(`[${rgb}]${[...inRgb, TO_YUV].join(',')}[vgraded]`)
    vOut = 'vgraded'
  }
  const inYuv = grade ? lookYuvFilters(grade) : []
  if (inYuv.length > 0) {
    chains.push(`[${vOut}]${inYuv.join(',')}[vlook]`)
    vOut = 'vlook'
  }
  // Old film: the graded picture weaves in the gate, then the leaks and the dust loop over it.
  if (opts.film) {
    const weave = weaveFilter(opts.film.weave, W, H, fps)
    if (weave) {
      chains.push(`[${vOut}]${weave}[vweave]`)
      vOut = 'vweave'
    }
    for (const [i, file] of [opts.film.soft, opts.film.fine].entries()) {
      if (!file) continue
      inputs.push('-stream_loop', '-1', '-i', file)
      const k = next++
      // Laid on in YUV with its alpha, the soft glow scaled up the cheap way: a quarter of the time RGBA took.
      chains.push(`[${k}:v]${i === 0 ? `scale=${W}:${H}:flags=fast_bilinear,` : ''}format=yuva420p[film${i}]`)
      chains.push(`[${vOut}][film${i}]overlay=0:0:shortest=1:format=yuv420[vfilm${i}]`)
      vOut = `vfilm${i}`
    }
  }
  // What the effects draw (rings, speed lines, a scan's glow): over the look and its film, under the captions.
  if (opts.fx?.overlays.length) {
    const drawn = overlayChains(opts.fx.overlays, vOut, addInput, fps, FX_COLOUR)
    chains.push(...drawn.chains)
    vOut = drawn.out
  }
  if (opts.assPath) {
    // Straight onto the picture, tagged BT.709: 7.0 colours captions by the tag, and on 6.0 and 6.1, which
    // colour them with BT.601, the file's colours were moved to land on BT.709 (main/captions). A colour no
    // move can reach is burned in RGB instead.
    const fonts = opts.fontsDir ? `:fontsdir=${filterPath(opts.fontsDir)}` : ''
    const subtitles = `subtitles=${filterPath(opts.assPath)}${fonts}`
    chains.push(
      opts.captionsInRgb
        ? `[${vOut}]${TO_RGB},format=rgb24,${subtitles},${TO_YUV}[vsub]`
        : `[${vOut}]${AS_BT709},${subtitles}[vsub]`
    )
    vOut = 'vsub'
  }
  // ---- Motion graphics (src/main/motion-render.ts) ----
  // Each overlay is a short file with alpha covering one stretch of output
  // time, one frame for each frame of the output from its first. Its frames
  // are put on the output's frames by count, so frame k lands on the frame
  // the preview draws that moment on. Placed by its start in seconds instead,
  // rounded to the millisecond and divided by the file's own time base, it
  // landed a frame early wherever the file counts time in frames and the
  // start rounded down. Outside its stretch the picture passes through.
  for (const [i, o] of (opts.overlays ?? []).entries()) {
    inputs.push('-i', o.path)
    const k = next++
    const first = Math.round(o.startSec * fps)
    // Drawn in RGB; into YUV as BT.709 before it meets the picture, so a brand colour stays itself.
    chains.push(`[${k}:v]${TO_YUVA},settb=1/${fps},setpts=N+${first}[mo${i}]`)
    chains.push(`[${vOut}][mo${i}]overlay=0:0:eof_action=pass[vmo${i}]`)
    vOut = `vmo${i}`
  }
  // ---- end of motion graphics ----
  if (opts.logo) {
    // The logo is an image looped for the whole video, a seventh of the frame
    // wide, set in from its corner by about a twentieth.
    // Read a second past the end, so the picture always ends first: a looped
    // GIF's frames rarely end exactly where the video does.
    const l = input(opts.logo.path, 0, totalSec + 1)
    const w = even(W * 0.14)
    const m = Math.round(W * 0.045)
    const x = opts.logo.corner.endsWith('right') ? `main_w-overlay_w-${m}` : String(m)
    const y = opts.logo.corner.startsWith('bottom') ? `main_h-overlay_h-${m}` : String(m)
    const alpha = Math.min(1, Math.max(0.1, opts.logo.opacity)).toFixed(2)
    chains.push(`[${l}:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${alpha},${TO_YUVA}[logo]`)
    // The picture decides how long it runs: overlay otherwise carries on for as
    // long as the logo does, which ffmpeg 6.0 did by three frames.
    chains.push(`[${vOut}][logo]overlay=x=${x}:y=${y}:shortest=1[vlogo]`)
    vOut = 'vlogo'
  }
  const fade = opts.fade
  if (fade && (fade.inSec > 0 || fade.outSec > 0)) {
    // Last of all, so captions and the logo fade with the picture.
    const parts: string[] = []
    const videoSec = totalFrames / fps
    if (fade.inSec > 0) parts.push(`fade=t=in:st=0:d=${exact(Math.min(fade.inSec, videoSec))}:color=${fade.color}`)
    if (fade.outSec > 0) {
      const d = Math.min(fade.outSec, videoSec)
      parts.push(`fade=t=out:st=${exact(videoSec - d)}:d=${exact(d)}:color=${fade.color}`)
    }
    chains.push(`[${vOut}]${parts.join(',')}[vfade]`)
    vOut = 'vfade'
  }
  // What the picture is, said on its last frames as on the file (TAGS).
  chains.push(`[${vOut}]${AS_BT709}[vout]`)
  vOut = 'vout'

  // Loudness and polish are only set when there is sound to set them on:
  // loudnorm over pure silence asks for infinite gain, and the encoder then
  // fails the export. A bed still plays over a silent cut.
  const sounds = segments.some((s) => !!s.audio || s.hasAudio)
  let aOut = 'acat'
  if (sounds && opts.voice && opts.voice > 0) {
    // Polishing takes the delay it adds back off the front; padding keeps the length exact.
    chains.push(`[acat]${voicePolish(opts.voice)},apad,atrim=duration=${exact(totalSec)}[avoice]`)
    aOut = 'avoice'
  }
  if (sounds && opts.loudness !== null) {
    // loudnorm works in 100 ms frames and looks 3 s ahead; at the end of sound
    // that is not a whole number of frames it puts those last seconds late by
    // the shortfall. Given more silence than it looks ahead, it never meets
    // that end, and the silence is cut off after. Silence does not change the
    // loudness it measures.
    chains.push(
      `[${aOut}]apad=pad_dur=3.2,loudnorm=I=${opts.loudness}:TP=-1.5:LRA=11,aresample=48000,atrim=duration=${exact(totalSec)}[aloud]`
    )
    aOut = 'aloud'
  }
  const effects = opts.sfx ?? []
  if (effects.length > 0) {
    // Sound effects go over the finished voice, each to the sample where it
    // lands, after loudness is set so they never change the voice's level.
    // A file used more than once is read once and split.
    const byPath = new Map<string, number[]>()
    effects.forEach((e, i) => byPath.set(e.path, [...(byPath.get(e.path) ?? []), i]))
    const labels: string[] = []
    for (const [path, uses] of byPath) {
      inputs.push('-i', path)
      const k = next++
      const copies = uses.map((i) => `[fx${i}s]`)
      chains.push(
        `[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo${uses.length > 1 ? `,asplit=${uses.length}` : ''}${copies.join('')}`
      )
      for (const i of uses) {
        const e = effects[i]
        chains.push(
          `[fx${i}s]atrim=start=${exact(e.trimSec)},asetpts=PTS-STARTPTS,volume=${e.gainDb.toFixed(2)}dB,` +
            `adelay=delays=${Math.round(e.startSec * 48000)}S:all=1,asetpts=N/SR/TB,apad,atrim=duration=${exact(totalSec)}[fx${i}]`
        )
        labels.push(`[fx${i}]`)
      }
    }
    // Effects are mixed after the loudness is set, so their peaks are caught
    // where the voice's are (-1.5 dBFS) and the export stays under the -1 dB
    // true peak that streaming sites ask for.
    chains.push(
      `[${aOut}]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:normalize=0,${limiter(0.84)},apad,atrim=duration=${exact(totalSec)}[asfx]`
    )
    aOut = 'asfx'
  }
  const bed = opts.music
  if (bed) {
    // The track loops for as long as the video runs, sits at its gain, dips
    // along its keys, and fades; then the two are mixed without either being
    // turned down, and peaks the bed adds are caught.
    inputs.push('-stream_loop', '-1', '-ss', fixed(bed.inSec), '-t', fixed(totalSec + 1), '-i', bed.path)
    const m = next++
    const fades = [
      bed.fadeInSec > 0 ? `afade=t=in:st=0:d=${exact(Math.min(bed.fadeInSec, totalSec))}` : null,
      bed.fadeOutSec > 0
        ? `afade=t=out:st=${exact(Math.max(0, totalSec - bed.fadeOutSec))}:d=${exact(Math.min(bed.fadeOutSec, totalSec))}`
        : null
    ].filter(Boolean)
    chains.push(
      `[${m}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,atrim=duration=${exact(totalSec)},asetpts=PTS-STARTPTS,` +
        `asetnsamples=n=480,${bedVolume(bed.gainDb, bed.keys)}${fades.length ? `,${fades.join(',')}` : ''}[abed]`
    )
    chains.push(
      `[${aOut}][abed]amix=inputs=2:duration=first:normalize=0,${limiter(0.84)},apad,atrim=duration=${exact(totalSec)}[amixed]`
    )
    aOut = 'amixed'
  }
  if (fade && (fade.inSec > 0 || fade.outSec > 0)) {
    const parts: string[] = []
    if (fade.inSec > 0) parts.push(`afade=t=in:st=0:d=${exact(Math.min(fade.inSec, totalSec))}`)
    if (fade.outSec > 0) {
      const d = Math.min(fade.outSec, totalSec)
      parts.push(`afade=t=out:st=${exact(totalSec - d)}:d=${exact(d)}`)
    }
    chains.push(`[${aOut}]${parts.join(',')}[afade]`)
    aOut = 'afade'
  }
  // The output is always stereo at 48 kHz. Pinning it here, at the end of the
  // chain, lets ffmpeg rebuild the graph mid-stream when a decoder reports a
  // different layout: the macOS ffmpeg-static build re-initialises on that and
  // otherwise fails with "Cannot select channel layout". The sample format is
  // left free, because intermediate passes write 16-bit PCM and finals AAC.
  chains.push(`[${aOut}]aformat=channel_layouts=stereo:sample_rates=48000[aout]`)
  aOut = 'aout'

  const encode = encodeArgs(opts.encoder ?? X264, opts.quality, { width: W, height: H }, fps)

  // Chapters come from a metadata file, the last input, so no other input's number moves.
  const chapters: string[] = []
  if (opts.chaptersPath) {
    inputs.push('-f', 'ffmetadata', '-i', opts.chaptersPath)
    chapters.push('-map_chapters', String(next++))
  }

  return [
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    '-map',
    `[${vOut}]`,
    '-map',
    `[${aOut}]`,
    ...chapters,
    '-r',
    String(fps),
    ...encode,
    ...TAGS,
    opts.outputPath
  ]
}

/** Runs ffmpeg, reporting 0 to 1 against the expected output length. */
export async function runRender(
  ffmpeg: string,
  args: string[],
  durationSec: number,
  onProgress: (fraction: number) => void = () => undefined,
  signal?: AbortSignal
): Promise<void> {
  let stderr = ''
  const r = await platform().run(ffmpeg, ['-nostats', '-progress', 'pipe:1', ...args], {
    signal,
    onStdout: (text) => {
      for (const line of text.split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line)
        if (m && durationSec > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / durationSec))
      }
    },
    onStderr: (text) => (stderr = (stderr + text).slice(-8000))
  })
  if (r.code !== 0) {
    // Its last lines, and how it stopped when a signal stopped it: that leaves no line of its own.
    const said = stderr.trim().split('\n').slice(-6)
    said.push(r.signal ? `ffmpeg was stopped by ${r.signal}.` : `ffmpeg exited with code ${r.code}.`)
    throw new RenderStopped(said.filter((l) => l.trim()).join('\n'), r.signal ?? null)
  }
  onProgress(1)
}

/**
 * ffmpeg stopped before the file was whole: with an error of its own, or
 * killed by a signal. The message is the sentence the person reads; what
 * ffmpeg printed, and how it stopped, wait in `said` for Details
 * (shared/failure). SIGKILL is what the system sends when it runs short of
 * memory, and ffmpeg prints nothing about it, so that is said as a maybe.
 */
export class RenderStopped extends Error implements ToolSaid {
  readonly tool = 'ffmpeg'
  constructor(
    readonly said: string,
    readonly signal: string | null = null
  ) {
    super(
      signal === 'SIGKILL'
        ? 'The renderer was stopped before it finished, perhaps because the Mac ran short of memory, so nothing was saved.'
        : 'The renderer stopped partway, so nothing was saved.'
    )
    this.name = 'RenderStopped'
  }
}

export interface RenderCutOptions {
  ffmpeg: string
  outputPath: string
  /** Somewhere to keep the captions file and any chunks while rendering. */
  workDir: string
  quality?: 'preview' | 'final'
  fontsDir?: string | null
  /**
   * Inputs per pass, and a cut renders in passes only when it needs more than
   * this. Absent: a cut of more than one piece renders in passes of PASS_INPUTS.
   */
  maxInputs?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** The person's brand: caption colours and a logo in a corner. */
  brand?: { colors: { text: string; accent: string }; logo: LogoMark | null } | null
  /** Motion graphics from renderCutMotion, laid over the joined picture in the last pass. */
  overlays?: OverlaySpan[] | null
  /** Scene effects from renderCutFx (main/fx-render), worked into the joined picture in the last pass. */
  fx?: GraphOptions['fx']
  /** Where the built-in sound effects are kept once made; the work folder when absent. */
  sfxDir?: string
  /**
   * The words the subtitles show, when graphics hold some back (subtitlePass);
   * every word when absent. The music still dips and sounds still land on all of them.
   */
  captionWords?: Resolved['words']
  /** How the picture is encoded: x264 when absent, as on a computer. */
  encoder?: Encoder
  /** False for an ffmpeg without the perspective filter, as a phone's is. */
  perspective?: boolean
  /** The edit's material, which a grid's panels can show (edit/grid). */
  assets?: Asset[]
  /** The look graphics wear, for a grid's ground and labels; the default look when absent. */
  theme?: MotionTheme | null
}

/**
 * How many inputs a segment opens: one per slice of anything played
 * backwards, one for a cutaway, and its sound's own when that is read apart
 * from the picture (another recording, or its own lined up with the mouth).
 */
export function inputsFor(s: Segment): number {
  const speaker = s.reverse ? reverseSlices(s.startSec, s.srcSec ?? s.durationSec).length : 1
  // Sound read apart opens its file again, in as many slices as the picture at most.
  const sound = s.audio && !s.hold ? speaker : 0
  // A grid opens each panel's file but its own, the ground, and the labels when it has them.
  if (s.grid) {
    const panels = s.grid.panels.filter((p) => p.path !== null).length
    return speaker + sound + panels + 1 + (s.grid.labels ? 1 : 0)
  }
  // Another camera beside or over the picture opens its own file.
  const inset = s.inset && !s.broll ? 1 : 0
  if (!s.broll) return speaker + sound + inset
  const reads = s.broll.steps ? srcLength(s.broll.steps) : (s.picture?.durationSec ?? s.durationSec)
  return speaker + sound + (s.broll.reverse ? reverseSlices(s.broll.startSec, reads).length : 1)
}

/**
 * Splits segments into passes of at most maxInputs inputs. A pass only ever
 * ends before a hard cut: a transition needs both its sides in the same pass.
 */
export function chunkSegments(segments: Segment[], maxInputs: number): Segment[][] {
  const spans = segmentSpans(segments)
  const pics = pictureSpans(segments, spans)
  // A pass may end only where picture and sound cut at the same moment.
  const clean = (k: number): boolean =>
    !segments[k].transition &&
    Math.abs(pics[k].outStart - spans[k].outStart) < 1e-6 &&
    Math.abs(pics[k - 1].outEnd - spans[k - 1].outEnd) < 1e-6
  const chunks: Segment[][] = []
  let current: Segment[] = []
  let used = 0
  for (const [k, s] of segments.entries()) {
    const cost = inputsFor(s)
    if (used + cost > maxInputs && current.length > 0 && clean(k)) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(s)
    used += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * A look's filters in RGB, after any LUT, on a picture already in RGB as
 * BT.709: the colour matrix, on RGB with an alpha channel whose column carries
 * the offsets; the vignette, darkening red, green and blue alike as the
 * preview's overlay does. The matrix runs on planar RGB with alpha: the same
 * pixels as packed RGBA on 6.0, 6.1 and 7.0, without packing and unpacking
 * every frame on the way.
 */
export function lookRgbFilters(look: Look): string[] {
  const parts: string[] = []
  if (changesColour(look)) {
    const m = lookMatrix(look)
    const names = ['rr', 'rg', 'rb', 'ra', 'gr', 'gg', 'gb', 'ga', 'br', 'bg', 'bb', 'ba']
    parts.push('format=gbrap', `colorchannelmixer=${names.map((k, i) => `${k}=${m[i].toFixed(5)}`).join(':')}`)
  }
  const vignette = look.vignette ?? 0
  if (vignette > 0) parts.push('format=rgb24', `vignette=angle=${vignetteAngle(vignette).toFixed(4)}`)
  return parts
}

/** A look's filters in YUV, after its colour: sharpening the luma, and grain in the luma only, so it does not speckle the colour. */
export function lookYuvFilters(look: Look): string[] {
  const parts: string[] = []
  const sharpen = look.sharpen ?? 0
  const grain = look.grain ?? 0
  if (sharpen > 0) parts.push(`unsharp=5:5:${(1.2 * sharpen).toFixed(2)}:5:5:0`)
  if (grain > 0) parts.push(`noise=c0s=${grainStrength(grain)}:c0f=t+u`)
  return parts
}

/** A look's filters, in order, as the export runs them on a YUV picture: into RGB and back as BT.709 around its colour. */
export function lookFilters(look: Look): string[] {
  const rgb = lookRgbFilters(look)
  return [...(rgb.length ? [TO_RGB, ...rgb, TO_YUV] : []), ...lookYuvFilters(look)]
}

/** A track mastered at an unknown loudness is taken to be as loud as most are. */
const TYPICAL_TRACK_LUFS = -14

/**
 * How a bed plays in this cut: at its level against the voice's loudness
 * target, whatever loudness the track was mastered at, dipping under the
 * words where they fall.
 */
export function bedFor(music: Music, resolved: Resolved, loudness: number | null): BedOptions {
  const voice = loudness ?? -14
  return {
    path: music.path,
    inSec: music.inSec,
    gainDb: voice + music.levelDb - (music.lufs ?? TYPICAL_TRACK_LUFS),
    keys: duckingKeys(resolved.words, music.duckDb, resolved.durationSec),
    fadeInSec: music.fadeInSec,
    fadeOutSec: music.fadeOutSec
  }
}

/**
 * The cut's chapters as an ffmpeg metadata file in the work folder, when it
 * has chapters YouTube would show; null otherwise. The same chapters go in the
 * description, so the file and the text never disagree.
 */
async function writeChapters(cut: Cut, resolved: Resolved, workDir: string): Promise<string | null> {
  if (!cut.chapters?.length) return null
  const placed = placeChapters(
    cut.chapters,
    new Map(resolved.beats.map((b) => [b.id, b.outStart])),
    resolved.durationSec
  )
  if (placed.problem) return null
  await platform().files.mkdir(workDir)
  const path = join(workDir, 'chapters.ffmeta')
  await platform().files.writeText(path, chaptersMetadata(placed.chapters, resolved.durationSec))
  return path
}

/** Every sound effect in the cut, placed, with the built-in ones made as needed. */
async function sfxFor(cut: Cut, resolved: Resolved, ffmpeg: string, dir: string): Promise<SfxOptions[]> {
  const placed = placeSfx(cut.beats, resolved)
  const out: SfxOptions[] = []
  for (const p of placed) {
    const path = p.sfx.kind ? await makeSfx(ffmpeg, p.sfx.kind, dir) : (p.sfx.path as string)
    out.push({ path, startSec: p.startSec, trimSec: p.trimSec, gainDb: sfxGainDb(p.sfx) })
  }
  return out
}

export type LutKind = '1d' | '3d'

/**
 * Whether a .cube file is a 3D LUT or a 1D one, from its size line, so the
 * render picks lut3d or lut1d. Anything else is named in a sentence rather
 * than left for ffmpeg to fail on.
 */
export async function lutKindOf(path: string): Promise<LutKind> {
  const head = (
    await platform()
      .files.readText(path)
      .catch(() => '')
  ).slice(0, 4096)
  if (/^\s*LUT_3D_SIZE\s+\d+/m.test(head)) return '3d'
  if (/^\s*LUT_1D_SIZE\s+\d+/m.test(head)) return '1d'
  throw new Error(
    `I can't read ${basename(path)} as a LUT. A .cube file starts with a LUT_3D_SIZE or LUT_1D_SIZE line.`
  )
}

/**
 * Which channel carries a file's sound when the other is empty, remembered
 * while the app runs for as long as the file is unchanged: measuring reads
 * up to ten minutes of sound.
 */
const channelMemo = new Map<string, Promise<0 | 1 | null>>()
async function soundChannelOf(ffmpeg: string, path: string): Promise<0 | 1 | null> {
  const stat = await platform().files.stat(path)
  if (!stat) return null
  const key = `${path}\u0000${stat.size}\u0000${stat.mtimeMs}`
  let found = channelMemo.get(key)
  if (!found) {
    found = liveChannel(ffmpeg, path)
    channelMemo.set(key, found)
  }
  return found
}

/** Every file a render reads must be there; a missing one is named in a sentence before ffmpeg starts. */
async function checkInputs(
  segments: Segment[],
  logo: LogoMark | null,
  more: (string | undefined)[],
  cut: Cut
): Promise<void> {
  const paths = new Set<string>()
  for (const s of segments) {
    paths.add(s.path)
    if (s.broll) paths.add(s.broll.path)
    if (s.audio) paths.add(s.audio.path)
    if (s.inset) paths.add(s.inset.path)
    for (const p of s.grid?.panels ?? []) if (p.path) paths.add(p.path)
  }
  if (logo) paths.add(logo.path)
  for (const path of more) if (path) paths.add(path)
  for (const b of cut.beats) for (const e of b.sfx ?? []) if (e.path) paths.add(e.path)
  for (const path of paths) {
    if (!(await platform().files.stat(path))) throw new Error(`I can't find ${basename(path)}. It was at ${path}.`)
  }
}

/**
 * Inputs a pass reads when a cut renders in passes. Each input a pass joins
 * adds the first pictures it decodes, waiting at the join at full size: 50 to
 * 140 MB each for a vertical frame from a wide recording, on ffmpeg 6.0 to
 * 7.0 on four cores. At two, every pass holds less than the last one does.
 */
const PASS_INPUTS = 2

/**
 * A concat demuxer list of the chunks, each given the length the next one
 * starts after (lengths[i]): ffmpeg moves every chunk's timestamps by the sum
 * of the lengths before it. Names are relative, so the list is read beside
 * the chunks.
 */
function chunkList(names: string[], lengths: number[]): string {
  return ['ffconcat version 1.0', ...names.flatMap((n, i) => [`file '${n}'`, `duration ${exact(lengths[i])}`]), ''].join(
    '\n'
  )
}

/** Renders a cut to a file and returns its path. */
export async function renderCut(
  cut: Cut,
  resolved: Resolved,
  sources: RenderSource[],
  opts: RenderCutOptions
): Promise<string> {
  const quality = opts.quality ?? 'final'
  const first = sources.find((s) => s.id === resolved.pieces[0]?.source) ?? sources[0]
  if (!first) throw new Error('The edit has no recording to render.')
  const { width, height } = frameSize(cut.aspect, first, quality === 'preview')
  const fps = frameRate(first.fps)
  // Each cutaway's shape, which a camera move over it needs, and how its
  // picture is encoded: an iPhone's HDR clip is converted as a recording is.
  const sizes = new Map<string, { width: number; height: number }>()
  const hdr = new Map<string, 'hlg' | 'pq'>()
  // What grids show is probed as cutaways are: an iPhone clip in a panel is converted the same way.
  const panels = cut.beats.flatMap((b) =>
    b.treatment.grid
      ? gridPictures(b.treatment.grid, { id: b.source }, { sources, assets: opts.assets ?? [] }).flatMap((p) =>
          p && !p.still ? [p.path] : []
        )
      : []
  )
  const cutaways = [
    ...new Set([...cut.beats.flatMap((b) => (b.treatment.broll ? [b.treatment.broll.path] : [])), ...panels])
  ]
  await Promise.all(
    cutaways.map(async (path) => {
      try {
        const info = await probeMedia(opts.ffmpeg, path, opts.signal)
        sizes.set(path, { width: info.width, height: info.height })
        if (info.color !== 'sdr') hdr.set(path, info.color)
      } catch {
        // Missing: checkInputs says so in a sentence.
      }
    })
  )
  const zscale = await hasZscale(opts.ffmpeg)
  const segments = cameraSegments(cut, resolved, sources, sizes, zscale, { width, height })
  // Beats shown as a grid (edit/grid): every panel, the ground and the labels, before the sound is read.
  if (cut.beats.some((b) => b.treatment.grid)) {
    await prepareGrids(segments, {
      cut,
      resolved,
      sources,
      assets: opts.assets ?? [],
      width,
      height,
      design: frameSize(cut.aspect, first),
      theme: opts.theme ?? null,
      fontsDir: opts.fontsDir ?? null,
      workDir: opts.workDir
    })
  }
  const colorOf = new Map<string, Source['color']>(sources.map((s) => [s.path, s.color]))
  // A lavalier on one input of the camera is heard in both ears.
  const heard = (s: Segment): string | null => s.audio?.path ?? (s.hasAudio ? s.path : null)
  const channels = new Map<string, 0 | 1 | null>()
  await Promise.all(
    [...new Set(segments.map(heard).filter((p): p is string => p !== null))].map(async (path) =>
      channels.set(path, await soundChannelOf(opts.ffmpeg, path))
    )
  )
  for (const s of segments) {
    if (s.broll) {
      const convert = colorConversion(hdr.get(s.broll.path), zscale)
      if (convert) s.broll.convert = convert
    }
    if (s.inset) {
      const convert = colorConversion(colorOf.get(s.inset.path), zscale)
      if (convert) s.inset.convert = convert
    }
    for (const p of s.grid?.panels ?? []) {
      const convert = p.path ? colorConversion(colorOf.get(p.path) ?? hdr.get(p.path), zscale) : null
      if (convert) p.convert = convert
    }
    const path = heard(s)
    const live = path ? channels.get(path) : null
    if (live !== null && live !== undefined) s.soundChannel = live
  }
  await checkInputs(segments, opts.brand?.logo ?? null, [cut.music?.path, cut.look?.lut?.path], cut)
  const total = resolved.durationSec
  const progress = opts.onProgress ?? (() => undefined)
  await platform().files.mkdir(opts.workDir)

  let assPath: string | null = null
  let captionsInRgb = false
  const shown = opts.captionWords ?? resolved.words
  if (cut.captions.on && shown.length > 0) {
    const words: TranscriptWord[] = shown.map((w) => ({
      text: w.text,
      startSec: w.outStart,
      endSec: w.outEnd
    }))
    const style = captionStyleFor(cut.captions, width, opts.brand?.colors ?? null)
    // libass colours captions in YUV, with BT.709 on 7.0 and BT.601 on 6.0 and 6.1, where the colours are
    // moved to the ones BT.601 turns into BT.709's values. Going through RGB instead is exact everywhere
    // but four times the work, so it is kept for a colour that cannot be moved, or an ffmpeg that says neither.
    const matrix = await captionMatrix(opts.ffmpeg)
    const moved = matrix === 'bt601' ? bt601Style(style) : matrix === 'bt709' ? style : null
    captionsInRgb = moved === null
    assPath = join(opts.workDir, 'captions.ass')
    await platform().files.writeText(assPath, buildAss(words, width, height, moved ?? style))
  }

  const base = {
    width,
    height,
    fps,
    fontsDir: opts.fontsDir ?? null,
    encoder: opts.encoder,
    perspective: opts.perspective
  }
  const finishing = {
    assPath,
    captionsInRgb,
    loudness: cut.loudness,
    fade: cut.fade ?? null,
    voice: cut.voice?.polish ?? 0,
    music: cut.music ? bedFor(cut.music, resolved, cut.loudness) : null,
    look: cut.look ?? null,
    lutKind: cut.look?.lut ? await lutKindOf(cut.look.lut.path) : undefined,
    film:
      cut.look && hasFilm(cut.look)
        ? {
            ...(await renderFilm(cut.look, width, height, fps, opts.ffmpeg, join(opts.workDir, 'film'), opts.signal)),
            weave: cut.look.weave ?? 0
          }
        : null,
    chaptersPath: await writeChapters(cut, resolved, opts.workDir),
    sfx: await sfxFor(cut, resolved, opts.ffmpeg, opts.sfxDir ?? join(opts.workDir, 'sfx')),
    quality,
    outputPath: opts.outputPath,
    logo: opts.brand?.logo ?? null,
    overlays: opts.overlays ?? null,
    fx: opts.fx ?? null
  }
  // One pass over several pieces holds pictures it has not reached yet: the
  // loudness filter looks 3 s ahead, the sound opens the next pieces' inputs
  // for it, and their pictures, scaled for the frame, wait at the join. Nine
  // pieces of one service, a /clipping clip, took more than 7 GB in one pass;
  // 18 clips of a vlog more than 12 GB. So a cut of more than one piece renders
  // in passes of a few inputs (PASS_INPUTS), with nothing over the whole, to
  // intermediate files, and a last pass reads them back as one input and sets
  // the captions, loudness and the rest over the whole. However many pieces
  // a cut has, no pass then holds much more than a one-piece export does.
  // maxInputs, given, renders in passes of it only past that many inputs.
  const inputsNeeded = segments.reduce((n, s) => n + inputsFor(s), 0)
  const inPasses = opts.maxInputs !== undefined ? inputsNeeded > opts.maxInputs : segments.length > 1

  if (!inPasses) {
    await runRender(opts.ffmpeg, buildRenderArgs(segments, { ...base, ...finishing }), total, progress, opts.signal)
    return opts.outputPath
  }

  // Chunks first, each of at most PASS_INPUTS inputs (or maxInputs), then one
  // join that adds the captions and loudness across the whole thing. The
  // chunks take most of the time, so they get most of the progress bar.
  const chunks = chunkSegments(segments, opts.maxInputs ?? PASS_INPUTS)
  const spans = segmentSpans(segments)
  // A chunk file always carries an audio track, silent or not; the join only
  // sets loudness when some piece of the cut had sound.
  const anySound = segments.some((s) => !!s.audio || s.hasAudio)
  const names: string[] = []
  const pictureLengths: number[] = []
  const soundLengths: number[] = []
  let done = 0
  let at = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const from = spans[at]
    const to = spans[at + chunk.length - 1]
    at += chunk.length
    const length = to.outEnd - from.outStart
    const name = `chunk-${String(i).padStart(3, '0')}.mkv`
    const args = buildRenderArgs(chunk, {
      ...base,
      assPath: null,
      loudness: null,
      quality: 'intermediate',
      outputPath: join(opts.workDir, name)
    })
    await runRender(opts.ffmpeg, args, length, (f) => progress(((done + f * length) / total) * 0.8), opts.signal)
    done += length
    names.push(name)
    // A chunk's picture is its frames on the cut's clock; its sound is cut to the sample.
    pictureLengths.push((Math.round(to.outEnd * fps) - Math.round(from.outStart * fps)) / fps)
    soundLengths.push(length)
  }
  // The chunks, read as one input through the concat demuxer, which moves a
  // chunk's picture and sound by the same amount: the sum of the lengths in
  // its list before it. So the picture is read through a list of whole frames
  // and the sound, read apart as another recording's would be, through a list
  // of the chunks' exact lengths. One list for both put a chunk that starts
  // within a hair of half a frame a frame late. One input per list, however
  // many chunks: an input per chunk held pictures waiting again.
  const pictureList = join(opts.workDir, 'chunks-picture.ffconcat')
  const soundList = join(opts.workDir, 'chunks-sound.ffconcat')
  await platform().files.writeText(pictureList, chunkList(names, pictureLengths))
  await platform().files.writeText(soundList, chunkList(names, soundLengths))
  const whole: Segment = {
    path: pictureList,
    startSec: 0,
    durationSec: spans[spans.length - 1].outEnd - spans[0].outStart,
    hasAudio: anySound,
    audio: anySound ? { path: soundList, offsetSec: 0 } : null,
    treatment: null,
    broll: null,
    outStart: spans[0].outStart
  }
  const args = buildRenderArgs([whole], { ...base, ...finishing })
  await runRender(opts.ffmpeg, args, total, (f) => progress(0.8 + f * 0.2), opts.signal)
  return opts.outputPath
}
