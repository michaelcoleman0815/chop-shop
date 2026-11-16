import { pictureSpan, sourceTimeAt, srcTimeAt, type Piece, type Resolved } from './resolve'
import type { Broll } from './schema'
import { outToSrc, speedAt, srcLength, stepsForOutput, type SpeedStep } from './timing'
import type { TransitionKind } from './transitions'

/**
 * What the preview plays at a moment of the cut: one piece, or two inside a
 * transition or a J or L cut, each with the source moment to show and how
 * loud it is.
 *
 * Pure, so the player and its tests agree on every frame. The player owns two
 * video elements and gives each layer one; the export is the renderer's job
 * and this is only ever its live approximation.
 */

export interface Layer {
  /** Index into resolved.pieces. */
  piece: number
  /** The moment of the piece's recording that plays now. */
  srcSec: number
  /** 0 to 1. Equal power across a transition, the way the export crossfades; 0 outside the piece's sound. */
  volume: number
  /** Whether its picture shows. A J or L cut plays one piece's sound under another's picture. */
  visible: boolean
  /** Inside a transition: which side this is, and how far through it is, 0 to 1. */
  transition: { kind: TransitionKind; side: 'out' | 'in'; progress: number } | null
  /** How fast the recording runs here: 2 is twice as fast, 0 a freeze frame. */
  rate?: number
  /** Running backwards, which a video element cannot play, so the preview steps it. */
  reverse?: boolean
}

/** Where a piece's recording is at an output time. */
export function pieceTime(piece: Piece, outSec: number): number {
  return srcTimeAt(piece, outSec)
}

/** How fast a piece's recording runs at an output time. */
export function pieceRate(piece: Piece, outSec: number): number {
  if (piece.hold !== undefined) return 0
  return piece.steps ? speedAt(piece.steps, outSec - piece.outStart) : 1
}

const inside = (t: number, span: { outStart: number; outEnd: number }): boolean => t >= span.outStart && t < span.outEnd

/** The layers playing at an output time, outgoing first. */
export function layersAt(resolved: Resolved, outSec: number): Layer[] {
  const hit = sourceTimeAt(resolved, outSec)
  if (!hit) return []
  const t = Math.min(Math.max(0, outSec), resolved.durationSec)
  const { pieces } = resolved
  const last = t >= resolved.durationSec
  // Only neighbours can share a moment: the piece whose sound plays and the
  // ones either side of it.
  const layers: Layer[] = []
  for (let i = Math.max(0, hit.index - 1); i <= Math.min(pieces.length - 1, hit.index + 1); i++) {
    const piece = pieces[i]
    const heard = inside(t, piece) || (last && i === pieces.length - 1)
    const seen = inside(t, pictureSpan(piece)) || (last && i === pieces.length - 1)
    if (!heard && !seen) continue
    const layer: Layer = {
      piece: i,
      srcSec: pieceTime(piece, t),
      // A freeze is silent: the sound waits while the picture holds.
      volume: heard && piece.hold === undefined ? 1 : 0,
      visible: seen,
      transition: null
    }
    const rate = pieceRate(piece, t)
    if (rate !== 1) layer.rate = rate
    if (piece.reverse) layer.reverse = true
    layers.push(layer)
  }

  // Inside a transition both sides play, crossfading at equal power.
  const coming = pieces[hit.index]
  const going = pieces[hit.index - 1]
  if (coming.transition && going && t < going.outEnd) {
    const progress = Math.min(1, Math.max(0, (t - coming.outStart) / Math.max(1e-6, going.outEnd - coming.outStart)))
    const kind = coming.transition.kind
    for (const l of layers) {
      const silent = pieces[l.piece].hold !== undefined
      if (l.piece === hit.index - 1) {
        l.volume = silent ? 0 : Math.cos((progress * Math.PI) / 2)
        l.transition = { kind, side: 'out', progress }
      } else if (l.piece === hit.index) {
        l.volume = silent ? 0 : Math.sin((progress * Math.PI) / 2)
        l.transition = { kind, side: 'in', progress }
      }
    }
  }
  return layers
}

/** When a beat's picture starts and ends on the output clock, J and L cuts included. */
export function beatPicture(resolved: Resolved, beat: string): { start: number; end: number } | null {
  const pieces = resolved.pieces.filter((p) => p.beat === beat)
  if (pieces.length === 0) return null
  return { start: pictureSpan(pieces[0]).outStart, end: pictureSpan(pieces[pieces.length - 1]).outEnd }
}

/**
 * The steps a cutaway plays at across its beat's picture, or null when it
 * plays as recorded. The voice under it keeps its own pace; only the cutaway
 * eases into its speed.
 */
export function cutawaySteps(broll: Broll, pictureSec: number): SpeedStep[] | null {
  const speed = broll.speed ?? 1
  const ramped = !!broll.ramp && (broll.ramp.inSec > 0 || broll.ramp.outSec > 0)
  if (Math.abs(speed - 1) < 1e-6 && !ramped) return null
  return stepsForOutput(pictureSec, speed, broll.ramp)
}

/**
 * How long a beat's cutaway runs, and how far it has run at an output time:
 * the beat's picture, less any freeze frame, which holds the cutaway too.
 */
export function cutawayClock(
  resolved: Resolved,
  beat: string,
  outSec: number
): { offset: number; length: number; held: boolean } | null {
  const pieces = resolved.pieces.filter((p) => p.beat === beat)
  if (pieces.length === 0) return null
  const start = pictureSpan(pieces[0]).outStart
  const end = pictureSpan(pieces[pieces.length - 1]).outEnd
  const t = Math.min(Math.max(outSec, start), end)
  let held = 0
  let heldBefore = 0
  let inHold = false
  for (const p of pieces) {
    if (p.hold === undefined) continue
    const len = p.outEnd - p.outStart
    held += len
    heldBefore += Math.min(len, Math.max(0, t - p.outStart))
    if (t >= p.outStart && t < p.outEnd) inHold = true
  }
  return { offset: t - start - heldBefore, length: Math.max(0, end - start - held), held: inHold }
}

/**
 * Where a cutaway is in its own footage, and how fast it runs, `offset` into
 * the `length` it runs for. Played backwards, it covers the same stretch of
 * footage from the far end.
 */
export function cutawayAt(broll: Broll, length: number, offset: number): { srcSec: number; rate: number } {
  const steps = cutawaySteps(broll, length)
  const along = steps ? outToSrc(steps, offset) : offset
  const rate = steps ? speedAt(steps, offset) : 1
  if (!broll.reverse) return { srcSec: broll.inSec + along, rate }
  return { srcSec: broll.inSec + Math.max(0, (steps ? srcLength(steps) : length) - along), rate }
}

/** The piece that starts next after an output time: what the idle deck should be ready with. */
export function nextPieceAfter(resolved: Resolved, outSec: number): number | null {
  const hit = sourceTimeAt(resolved, outSec)
  if (!hit) return null
  // A piece whose picture already shows (an L cut) has started.
  let next = hit.index + 1
  while (next < resolved.pieces.length && pictureSpan(resolved.pieces[next]).outStart <= outSec) next++
  return next < resolved.pieces.length ? next : null
}

/**
 * Whether one piece carries straight on from another in the same recording,
 * so a deck already playing the first can simply keep going.
 */
export function continues(a: Piece, b: Piece, toleranceSec = 0.05): boolean {
  return (
    a.source === b.source &&
    !b.transition &&
    !a.picture &&
    !b.picture &&
    !a.reverse &&
    !b.reverse &&
    a.hold === undefined &&
    b.hold === undefined &&
    Math.abs(b.srcStart - a.srcEnd) <= toleranceSec
  )
}
