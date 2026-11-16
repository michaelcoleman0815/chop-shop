import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import {
  cameraClock,
  cameraPlan,
  maxZoom,
  cutawayAt,
  cutawayClock,
  cutawaySteps,
  duckingKeys,
  outToSrc,
  pictureSpan,
  sliceSteps,
  srcLength,
  transitionInfo,
  type SpeedStep,
  type Aspect,
  type Camera,
  type CaptionSpec,
  type LevelKey,
  type Cut,
  type Fade,
  type Music,
  type Resolved,
  type Source,
  type Treatment,
  type TransitionKind
} from '../shared/edit'
import { presetById } from '../shared/caption-presets'
import type { CaptionStyle, TranscriptWord } from '../shared/types'
import { buildAss } from './captions'
import { probeMedia } from './inspiration/measure'
import { bedVolume, voicePolish } from './render/audio'
import { perspectiveFor } from './render/camera'
import { changesSpeed, reverseSlices, speedPts, speedSound } from './render/speed'

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
 * Opening a decoder per input costs memory, so a long cut renders in chunks
 * of at most maxInputs pieces to an intermediate file each, then joins them
 * in a last pass that adds captions and sets loudness once over the whole.
 * Chunks only ever break at a hard cut, so no transition is split in two.
 *
 * No Electron imports: the binary and folders arrive as arguments, which is
 * what lets the tests render real files with the system ffmpeg.
 */

export interface RenderSource extends Source {
  hasAudio: boolean
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
  } | null
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

export interface GraphOptions {
  width: number
  height: number
  fps: number
  /** Drawn over everything, captions included. */
  logo?: LogoMark | null
  /** An ASS file to burn in over the joined picture. */
  assPath: string | null
  fontsDir: string | null
  /** Integrated loudness target in LUFS, or null to leave levels alone. */
  loudness: number | null
  /** The whole video fading in and out, picture and sound. */
  fade?: Fade | null
  /** Voice clean-up, from 0 to 1, over the whole sound before any music goes under it. */
  voice?: number
  /** A music bed under everything. */
  music?: BedOptions | null
  quality: Quality
  outputPath: string
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
const STILL = /\.(png|jpe?g|webp|gif|bmp)$/i

/** How much is read to find the one frame a freeze holds. */
const HOLD_READ_SEC = 0.5

/** The ground a card sits on: Cutalong's own, so cards read as part of the edit. */
const CARD_GROUND = 'F5F5F3'

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
  else {
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

const POSITION_FRAC: Record<CaptionSpec['position'], number> = { top: 0.22, middle: 0.52, chest: 0.66, bottom: 0.84 }

/** The caption look for a spec, sized for the frame being rendered, in the brand's colours when there is one. */
export function captionStyleFor(
  spec: CaptionSpec,
  width: number,
  colors: { text: string; accent: string } | null = null
): CaptionStyle {
  const base = presetById(spec.preset).style
  const scale = width / 1080
  return {
    ...base,
    ...(colors ? { textColor: colors.text, activeColor: colors.accent } : {}),
    wordsPerGroup: spec.wordsPerScreen,
    uppercase: spec.uppercase || base.uppercase,
    positionFrac: POSITION_FRAC[spec.position],
    fontSizePx: Math.max(8, Math.round(base.fontSizePx * scale)),
    outlinePx: Math.max(1, Math.round(base.outlinePx * scale)),
    shadowPx: Math.round(base.shadowPx * scale),
    second: base.second
      ? {
          ...base.second,
          fontSizePx: Math.max(8, Math.round(base.second.fontSizePx * scale)),
          gapPx: Math.round(base.second.gapPx * scale)
        }
      : base.second
  }
}

/** A recording's size when nothing better is known: most cutaways are wide. */
const WIDE = { width: 1920, height: 1080 }

/**
 * The inputs for each resolved piece, with its beat's look. `sizes` gives the
 * size of cutaway footage, which a camera move over it needs.
 */
export function segmentsFor(
  cut: Cut,
  resolved: Resolved,
  sources: RenderSource[],
  sizes: Map<string, { width: number; height: number }> = new Map()
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
      treatment: t,
      broll: null,
      outStart: p.outStart
    }
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
    if (t.camera) segment.camera = moving(t.camera, p.beat, picture.outStart, source)
    return segment
  })
}

/** Escapes a path for use inside a filter argument. */
function filterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

const fixed = (n: number): string => n.toFixed(3)
/** Times that must land on a frame or a sample: microseconds, which ffmpeg reads exactly. */
const exact = (n: number): string => n.toFixed(6)

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
 * it: the one place per-recording conversions belong, so every piece and
 * cutaway gets them.
 */
function sourcePicture(input: number): string {
  return `[${input}:v]`
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
    if (STILL.test(path)) inputs.push('-loop', '1', '-t', fixed(duration), '-i', path)
    else inputs.push('-ss', fixed(Math.max(0, start)), '-t', fixed(duration), '-i', path)
    return next++
  }

  /** Scale to cover w x h, crop the overflow, then apply the look. */
  const look = (w: number, h: number, t: Treatment | null, zoom: boolean): string => {
    let f = `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
    const z = t?.zoom ?? 1
    if (zoom && z > 1.001) f += `,crop=trunc(iw/${z.toFixed(4)}/2)*2:trunc(ih/${z.toFixed(4)}/2)*2,scale=${w}:${h}`
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
    name: string
  ): { inputs: number[]; slices: { start: number; len: number }[]; picture: () => string } => {
    const slices = reverseSlices(start, len)
    const inputs = slices.map((sl) => input(path, sl.start, sl.len))
    let built = false
    const picture = (): string => {
      if (!built) {
        built = true
        inputs.forEach((n, i) =>
          chains.push(
            `${sourcePicture(n)}setpts=PTS-STARTPTS,fps=${fps},scale=${W}:${H}:force_original_aspect_ratio=increase,reverse[${name}r${i}]`
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

  segments.forEach((s, k) => {
    const v = `v${k}`
    const a = `a${k}`
    const t = s.treatment
    const frames = exactly(framesOf(k), s.hold ? s.durationSec + 1 : 1)
    // Source each side reads: as long as it plays, unless speed changes that.
    const soundSrc = s.srcSec ?? s.durationSec
    const pic = s.picture
      ? { startSec: s.picture.startSec, srcSec: s.picture.srcSec ?? s.picture.durationSec, steps: s.picture.steps }
      : { startSec: s.startSec, srcSec: soundSrc, steps: s.steps }
    const showFor = s.picture ? s.picture.durationSec : s.durationSec

    // The speaker: its picture ready for a look, built only if something
    // shows it, and its sound cut from the same input, ready to be timed.
    let speaker: () => string
    let sound: string | null = null
    if (s.hold) {
      // A freeze: one frame, held. The sound waits, silent.
      speaker = () => `${sourcePicture(input(s.path, s.startSec, HOLD_READ_SEC))}trim=end_frame=1,setpts=PTS-STARTPTS,`
    } else if (s.reverse) {
      const back = backwards(s.path, s.startSec, soundSrc, `${v}s`)
      speaker = () => `${back.picture()}${retime(s.steps)}`
      if (s.hasAudio) {
        back.inputs.forEach((n, i) =>
          chains.push(
            `[${n}:a]asetpts=PTS-STARTPTS,apad,atrim=duration=${exact(back.slices[i].len)},areverse[${a}r${i}]`
          )
        )
        chains.push(`${latestFirst(back.inputs.length, `${a}r`)}concat=n=${back.inputs.length}:v=0:a=1[${a}j]`)
        sound = `[${a}j]`
      }
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
      speaker = () => `${sourcePicture(main)}${cutPicture}${retime(pic.steps)}`
      if (s.hasAudio) {
        const cutSound = differs(s.startSec, soundSrc)
          ? `atrim=start=${exact(s.startSec - inStart)}:duration=${exact(soundSrc)},asetpts=PTS-STARTPTS,`
          : ''
        sound = `[${main}:a]${cutSound}`
      }
    }

    // The cutaway ready for a look: its stretch of footage, backwards or held
    // as asked, through its own speed. A still simply shows for as long.
    const cutaway = (): string => {
      const b = s.broll as NonNullable<Segment['broll']>
      if (STILL.test(b.path)) return sourcePicture(input(b.path, 0, showFor))
      if (b.hold)
        return `${sourcePicture(input(b.path, b.startSec, HOLD_READ_SEC))}trim=end_frame=1,setpts=PTS-STARTPTS,`
      const reads = b.steps ? srcLength(b.steps) : showFor
      if (b.reverse) return `${backwards(b.path, b.startSec, reads, `${v}c`).picture()}${retime(b.steps)}`
      return `${sourcePicture(input(b.path, b.startSec, reads))}${retime(b.steps)}`
    }

    if (t === null) {
      chains.push(`${speaker()}fps=${fps},setsar=1,format=yuv420p,${frames}[${v}]`)
    } else if (s.broll && t.frame === 'split') {
      const half = even(H / 2)
      chains.push(`${cutaway()}${moveOver(s.broll.camera, W, half)}${look(W, half, t, false)}[${v}t]`)
      chains.push(`${speaker()}${moveOver(s.camera, W, H - half)}${look(W, H - half, t, true)}[${v}b]`)
      chains.push(`[${v}t][${v}b]vstack,format=yuv420p,${frames}[${v}]`)
    } else if (s.broll && t.frame === 'card') {
      // A card: the picture centred on Cutalong's ground, at most 60% of the
      // frame, with the speaker's voice carrying on underneath.
      const box = even(Math.min(W, H) * 0.6)
      chains.push(`color=c=0x${CARD_GROUND}:s=${W}x${H}:r=${fps}:d=${fixed(showFor)}[${v}g]`)
      chains.push(
        `${cutaway()}fps=${fps},scale=${box}:${box}:force_original_aspect_ratio=decrease,setsar=1${t.bw ? ',hue=s=0' : ''}[${v}i]`
      )
      chains.push(`[${v}g][${v}i]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p,${frames}[${v}]`)
    } else if (s.broll) {
      // The cutaway fills the frame; the speaker's input is only heard.
      chains.push(`${cutaway()}${moveOver(s.broll.camera, W, H)}${look(W, H, t, false)},format=yuv420p,${frames}[${v}]`)
    } else {
      chains.push(`${speaker()}${moveOver(s.camera, W, H)}${look(W, H, t, true)},format=yuv420p,${frames}[${v}]`)
    }

    // Every segment's audio is exactly as long as its piece: through its
    // speed, which atempo changes without changing the pitch, then padded
    // with silence and trimmed, so the join never drifts out of sync.
    const shape = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${exact(s.durationSec)},asetpts=PTS-STARTPTS`
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
  const joinRun = (run: number[], name: { v: string; a: string }): void => {
    if (run.length === 1) {
      chains.push(`[v${run[0]}]null[${name.v}]`, `[a${run[0]}]anull[${name.a}]`)
      return
    }
    chains.push(`${run.map((k) => `[v${k}]`).join('')}concat=n=${run.length}:v=1:a=0,settb=1/${fps}[${name.v}]`)
    chains.push(`${run.map((k) => `[a${k}]`).join('')}concat=n=${run.length}:v=0:a=1[${name.a}]`)
  }

  if (runs.length === 1) {
    joinRun(runs[0], { v: 'vcat', a: 'acat' })
  } else {
    let vAcc = ''
    let aAcc = ''
    runs.forEach((run, r) => {
      const last = r === runs.length - 1
      joinRun(run, { v: `vr${r}`, a: `ar${r}` })
      if (r === 0) {
        vAcc = `vr${r}`
        aAcc = `ar${r}`
        return
      }
      const k = run[0]
      const kind = (segments[k].transition as { kind: TransitionKind }).kind
      const info = transitionInfo(kind)
      const offset = frameAt(spans[k].outStart) / fps
      const duration = overlapFrames(k) / fps
      const vOut = last ? 'vcat' : `vx${r}`
      if (overlapFrames(k) < 1) {
        // Shorter than a frame once both ends land on frames: the pictures
        // simply cut, while the sound still crossfades below.
        chains.push(`[${vAcc}][vr${r}]concat=n=2:v=1:a=0,settb=1/${fps}[${vOut}]`)
      } else if (info.preview === 'dip') {
        // A dip: the old picture is all the way to the colour by the middle,
        // the new one comes up from it after, and a dissolve joins the two.
        const half = exact(duration / 2)
        const color = info.color ?? 'black'
        chains.push(`[${vAcc}]fade=t=out:st=${exact(offset)}:d=${half}:color=${color}[vd${r}a]`)
        chains.push(`[vr${r}]fade=t=in:st=${half}:d=${half}:color=${color}[vd${r}b]`)
        chains.push(
          `[vd${r}a][vd${r}b]xfade=transition=fade:duration=${exact(duration)}:offset=${exact(offset)}[${vOut}]`
        )
      } else if (info.preview === 'whip') {
        // A whip pan is a fast push with motion blur across its middle.
        chains.push(
          `[${vAcc}][vr${r}]xfade=transition=${info.xfade}:duration=${exact(duration)}:offset=${exact(offset)}[vw${r}]`
        )
        const sigma = Math.max(4, Math.round(W / 40))
        chains.push(
          `[vw${r}]gblur=sigma=${sigma}:sigmaV=0:enable='between(t,${exact(offset + duration * 0.15)},${exact(offset + duration * 0.85)})'[${vOut}]`
        )
      } else {
        chains.push(
          `[${vAcc}][vr${r}]xfade=transition=${info.xfade}:duration=${exact(duration)}:offset=${exact(offset)}[${vOut}]`
        )
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
  if (opts.assPath) {
    const fonts = opts.fontsDir ? `:fontsdir='${filterPath(opts.fontsDir)}'` : ''
    chains.push(`[vcat]subtitles='${filterPath(opts.assPath)}'${fonts}[vsub]`)
    vOut = 'vsub'
  }
  if (opts.logo) {
    // The logo is an image looped for the whole video, a seventh of the frame
    // wide, set in from its corner by about a twentieth.
    const l = input(opts.logo.path, 0, totalSec)
    const w = even(W * 0.14)
    const m = Math.round(W * 0.045)
    const x = opts.logo.corner.endsWith('right') ? `main_w-overlay_w-${m}` : String(m)
    const y = opts.logo.corner.startsWith('bottom') ? `main_h-overlay_h-${m}` : String(m)
    const alpha = Math.min(1, Math.max(0.1, opts.logo.opacity)).toFixed(2)
    chains.push(`[${l}:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${alpha}[logo]`)
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

  let aOut = 'acat'
  if (opts.voice && opts.voice > 0) {
    // Polishing takes the delay it adds back off the front; padding keeps the length exact.
    chains.push(`[acat]${voicePolish(opts.voice)},apad,atrim=duration=${exact(totalSec)}[avoice]`)
    aOut = 'avoice'
  }
  if (opts.loudness !== null) {
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
      `[${aOut}][abed]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.84:level=false:latency=1[amixed]`
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

  const encode =
    opts.quality === 'intermediate'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le']
      : opts.quality === 'preview'
        ? [
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '26',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart'
          ]
        : [
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '18',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-movflags',
            '+faststart'
          ]

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
    '-r',
    String(fps),
    ...encode,
    opts.outputPath
  ]
}

/** Runs ffmpeg, reporting 0 to 1 against the expected output length. */
export function runRender(
  ffmpeg: string,
  args: string[],
  durationSec: number,
  onProgress: (fraction: number) => void = () => undefined,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostats', '-progress', 'pipe:1', ...args], { signal })
    let stderr = ''
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line)
        if (m && durationSec > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / durationSec))
      }
    })
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-8000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(1)
        resolve()
      } else reject(new Error(stderr.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with ${code}`))
    })
  })
}

export interface RenderCutOptions {
  ffmpeg: string
  outputPath: string
  /** Somewhere to keep the captions file and any chunks while rendering. */
  workDir: string
  quality?: 'preview' | 'final'
  fontsDir?: string | null
  /** Pieces per pass before a cut is rendered in chunks. */
  maxInputs?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** The person's brand: caption colours and a logo in a corner. */
  brand?: { colors: { text: string; accent: string }; logo: LogoMark | null } | null
}

/** How many inputs a segment opens: one per slice of anything played backwards, one for a cutaway. */
export function inputsFor(s: Segment): number {
  const speaker = s.reverse ? reverseSlices(s.startSec, s.srcSec ?? s.durationSec).length : 1
  if (!s.broll) return speaker
  const reads = s.broll.steps ? srcLength(s.broll.steps) : (s.picture?.durationSec ?? s.durationSec)
  return speaker + (s.broll.reverse ? reverseSlices(s.broll.startSec, reads).length : 1)
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

/** Every file a render reads must be there; a missing one is named in a sentence before ffmpeg starts. */
async function checkInputs(segments: Segment[], logo: LogoMark | null, music: string | null): Promise<void> {
  const paths = new Set<string>()
  for (const s of segments) {
    paths.add(s.path)
    if (s.broll) paths.add(s.broll.path)
  }
  if (logo) paths.add(logo.path)
  if (music) paths.add(music)
  for (const path of paths) {
    try {
      await fs.access(path)
    } catch {
      throw new Error(`I can't find ${basename(path)}. It was at ${path}.`)
    }
  }
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
  // A camera move over a cutaway needs the cutaway's shape.
  const sizes = new Map<string, { width: number; height: number }>()
  for (const beat of cut.beats) {
    const broll = beat.treatment.broll
    if (!broll?.camera || sizes.has(broll.path)) continue
    try {
      const info = await probeMedia(opts.ffmpeg, broll.path, opts.signal)
      sizes.set(broll.path, { width: info.width, height: info.height })
    } catch {
      // Missing: checkInputs says so in a sentence.
    }
  }
  const segments = segmentsFor(cut, resolved, sources, sizes)
  await checkInputs(segments, opts.brand?.logo ?? null, cut.music?.path ?? null)
  const total = resolved.durationSec
  const progress = opts.onProgress ?? (() => undefined)
  await fs.mkdir(opts.workDir, { recursive: true })

  let assPath: string | null = null
  if (cut.captions.on && resolved.words.length > 0) {
    const words: TranscriptWord[] = resolved.words.map((w) => ({
      text: w.text,
      startSec: w.outStart,
      endSec: w.outEnd
    }))
    assPath = join(opts.workDir, 'captions.ass')
    await fs.writeFile(
      assPath,
      buildAss(words, width, height, captionStyleFor(cut.captions, width, opts.brand?.colors ?? null))
    )
  }

  const base = { width, height, fps, fontsDir: opts.fontsDir ?? null }
  const finishing = {
    assPath,
    loudness: cut.loudness,
    fade: cut.fade ?? null,
    voice: cut.voice?.polish ?? 0,
    music: cut.music ? bedFor(cut.music, resolved, cut.loudness) : null,
    quality,
    outputPath: opts.outputPath,
    logo: opts.brand?.logo ?? null
  }
  const maxInputs = opts.maxInputs ?? 24
  const inputsNeeded = segments.reduce((n, s) => n + inputsFor(s), 0)

  if (inputsNeeded <= maxInputs) {
    await runRender(opts.ffmpeg, buildRenderArgs(segments, { ...base, ...finishing }), total, progress, opts.signal)
    return opts.outputPath
  }

  // Chunks first, each at most maxInputs inputs, then one join that adds the
  // captions and loudness across the whole thing. The chunks take most of the
  // time, so they get most of the progress bar.
  const chunks = chunkSegments(segments, maxInputs)
  const spans = segmentSpans(segments)
  const joined: Segment[] = []
  let done = 0
  let at = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const from = spans[at]
    const to = spans[at + chunk.length - 1]
    at += chunk.length
    const length = to.outEnd - from.outStart
    const path = join(opts.workDir, `chunk-${String(i).padStart(3, '0')}.mkv`)
    const args = buildRenderArgs(chunk, {
      ...base,
      assPath: null,
      loudness: null,
      quality: 'intermediate',
      outputPath: path
    })
    await runRender(opts.ffmpeg, args, length, (f) => progress(((done + f * length) / total) * 0.8), opts.signal)
    done += length
    joined.push({
      path,
      startSec: 0,
      durationSec: length,
      hasAudio: true,
      treatment: null,
      broll: null,
      outStart: from.outStart
    })
  }
  const args = buildRenderArgs(joined, { ...base, ...finishing })
  await runRender(opts.ffmpeg, args, total, (f) => progress(0.8 + f * 0.2), opts.signal)
  return opts.outputPath
}
