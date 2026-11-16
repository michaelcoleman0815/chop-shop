import { pictureSpan, sourceTimeAt, type Piece, type Resolved } from './resolve'
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
}

/** Where a piece's recording is at an output time. */
export function pieceTime(piece: Piece, outSec: number): number {
  return piece.srcStart + (outSec - piece.outStart)
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
    layers.push({ piece: i, srcSec: pieceTime(piece, t), volume: heard ? 1 : 0, visible: seen, transition: null })
  }

  // Inside a transition both sides play, crossfading at equal power.
  const coming = pieces[hit.index]
  const going = pieces[hit.index - 1]
  if (coming.transition && going && t < going.outEnd) {
    const progress = Math.min(1, Math.max(0, (t - coming.outStart) / Math.max(1e-6, going.outEnd - coming.outStart)))
    const kind = coming.transition.kind
    for (const l of layers) {
      if (l.piece === hit.index - 1) {
        l.volume = Math.cos((progress * Math.PI) / 2)
        l.transition = { kind, side: 'out', progress }
      } else if (l.piece === hit.index) {
        l.volume = Math.sin((progress * Math.PI) / 2)
        l.transition = { kind, side: 'in', progress }
      }
    }
  }
  return layers
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
    Math.abs(b.srcStart - a.srcEnd) <= toleranceSec
  )
}
