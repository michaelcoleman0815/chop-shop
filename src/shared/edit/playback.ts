import { sourceTimeAt, type Piece, type Resolved } from './resolve'
import type { TransitionKind } from './transitions'

/**
 * What the preview plays at a moment of the cut: one piece, or two inside a
 * transition, each with the source moment to show and how loud it is.
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
  /** 0 to 1. Equal power across a transition, the way the export crossfades. */
  volume: number
  /** Inside a transition: which side this is, and how far through it is, 0 to 1. */
  transition: { kind: TransitionKind; side: 'out' | 'in'; progress: number } | null
}

/** Where a piece's recording is at an output time. */
export function pieceTime(piece: Piece, outSec: number): number {
  return piece.srcStart + (outSec - piece.outStart)
}

/** The layers playing at an output time, outgoing first. */
export function layersAt(resolved: Resolved, outSec: number): Layer[] {
  const hit = sourceTimeAt(resolved, outSec)
  if (!hit) return []
  const { piece, index } = hit
  const t = Math.min(Math.max(0, outSec), resolved.durationSec)
  const prev = resolved.pieces[index - 1]
  if (piece.transition && prev && t < prev.outEnd) {
    const progress = Math.min(1, Math.max(0, (t - piece.outStart) / Math.max(1e-6, prev.outEnd - piece.outStart)))
    const kind = piece.transition.kind
    return [
      {
        piece: index - 1,
        srcSec: pieceTime(prev, t),
        volume: Math.cos((progress * Math.PI) / 2),
        transition: { kind, side: 'out', progress }
      },
      {
        piece: index,
        srcSec: pieceTime(piece, t),
        volume: Math.sin((progress * Math.PI) / 2),
        transition: { kind, side: 'in', progress }
      }
    ]
  }
  return [{ piece: index, srcSec: hit.srcSec, volume: 1, transition: null }]
}

/** The piece that starts next after an output time: what the idle deck should be ready with. */
export function nextPieceAfter(resolved: Resolved, outSec: number): number | null {
  const hit = sourceTimeAt(resolved, outSec)
  if (!hit) return null
  const next = hit.index + 1
  return next < resolved.pieces.length ? next : null
}

/**
 * Whether one piece carries straight on from another in the same recording,
 * so a deck already playing the first can simply keep going.
 */
export function continues(a: Piece, b: Piece, toleranceSec = 0.05): boolean {
  return a.source === b.source && !b.transition && Math.abs(b.srcStart - a.srcEnd) <= toleranceSec
}
