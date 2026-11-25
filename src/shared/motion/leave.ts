import { tail } from './anim'
import type { MotionCall } from './schema'
import type { Frame } from './theme'
import type { Anim, Key, Layer } from './types'

/**
 * How graphics leave: by moving, as deliberately as they came in. A fade on its own is not an exit (the owner,
 * 2026-11-24: "all graphics fade out rather than animating out … or sliding"). What stands beside the speaker slides
 * off to its own side as the shot glides back; what lies along the foot sinks out of it; what was drawn undraws; a
 * full-frame card is pushed through; small things drop or lift away. Piece by piece, where a graphic is made of
 * pieces, and the ground under them last. Built once, over every template, so a new one leaves as well as the rest.
 *
 * What is meant to end on a cut does: paper boards and what is set on them, a title behind the speaker, an end card.
 */

export type Leave =
  /** Off the frame to one side, or up or down out of it. */
  | { way: 'left' | 'right' | 'down' | 'up'; pieces?: boolean }
  /** A short way, going: small things, and cards that would cross the whole frame. */
  | { way: 'drop' | 'lift' }
  /** Pushed through, as a full-frame card is. */
  | { way: 'through' }

/** The fastest anything goes, in shares of the frame's width a frame at 30 fps: the creators' own (motion/smoothness). */
const FASTEST = 0.08
/** How long a graphic must be up to be seen to leave, over the leaving itself. */
const SETTLED = 0.5
/** Between one piece setting off and the next. */
const STEP = 0.045

/** How a call leaves; null as its template ends it. */
export function leaveOf(call: Pick<MotionCall, 'kind' | 'style' | 'place'>): Leave | null {
  const side = call.place === 'left' || call.place === 'right' ? call.place : null
  switch (call.kind) {
    case 'aside':
      return { way: call.place === 'right' ? 'right' : 'left', pieces: true }
    case 'band':
      return { way: 'down', pieces: true }
    case 'lower-third':
      return { way: call.place === 'right' || call.place === 'bottom-right' ? 'right' : 'left' }
    case 'layers':
      return side ? { way: side } : call.place === 'foot' ? { way: 'down' } : call.place === 'full' ? { way: 'through' } : { way: 'drop' }
    case 'map':
      return { way: 'through' }
    case 'headline':
    case 'clock':
    case 'dial':
    case 'market':
    case 'video-cards':
      return { way: 'up' }
    case 'screenshot':
      // One that slid in slides back a little of the way it came, by itself.
      return call.style === 'slide' ? null : { way: 'up' }
    case 'title':
      // Ali Abdaal's and the podcast's own, measured: gone on the cut, and out of a blur.
      return call.style === 'behind' || call.style === 'stair' || call.style === 'engraved' ? null : { way: 'lift' }
    case 'banner':
      return { way: call.place.startsWith('top') || call.place === 'upper' ? 'lift' : 'drop' }
    case 'counter':
    case 'keyword':
    case 'callout':
    case 'chips':
    case 'steps':
      return { way: call.place.startsWith('top') || call.place === 'upper' ? 'lift' : 'drop' }
    default:
      return null
  }
}

/** A value without what it does at the end, so its leaving is the one made here. */
function kept<V>(v: Anim<V> | undefined): Anim<V> | undefined {
  const keys = (v as { keys?: Key<V>[] } | undefined)?.keys
  if (!keys) return v
  const own = keys.filter((k) => k.from !== 'end')
  // Nothing but an end to it: at rest, it is what it was before it went.
  return own.length ? { ...(v as object), keys: own } as Anim<V> : keys[0] ? (keys[0].v as Anim<V>) : v
}

/** A layer without its own fade at the end, its children's with it. */
function staying(layer: Layer, end: number): Layer {
  if (Math.abs(layer.end - end) > 0.08) return layer
  const l = { ...layer } as Layer & { animators?: { out?: boolean }[]; children?: Layer[] }
  if (l.transform?.opacity !== undefined) l.transform = { ...l.transform, opacity: kept(l.transform.opacity) }
  if (l.animators?.some((a) => a.out)) l.animators = l.animators.filter((a) => !a.out)
  if (l.kind === 'group' && l.children) l.children = l.children.map((c) => staying(c, end))
  // What was drawn on undraws from where it began, instead of going pale.
  if (l.kind === 'shape' && l.trim?.end !== undefined && l.trim.start === undefined && typeof l.trim.end === 'object' && l.end - l.start > 1.2)
    l.trim = { ...l.trim, start: { keys: [{ t: 0, v: 0 }, ...tail([0.5, 0, 'in-out-cubic'], [0.02, 1])] } }
  return l as Layer
}

/** Whether a layer is the ground of a graphic: a wash or a fill over much of the frame; and whether it is all of it. */
function groundOf(l: Layer, frame: Frame): 'wash' | 'all' | null {
  if (l.kind !== 'shape') return null
  const s = l.shape as { type: string; w?: number; h?: number }
  if (s.type !== 'rect' || s.w === undefined || s.h === undefined) return null
  if (s.w >= frame.width * 0.98 && s.h >= frame.height * 0.98) return 'all'
  return s.w * s.h > frame.width * frame.height * 0.22 ? 'wash' : null
}

/** A full-frame ground going as what stood on it has nearly gone. */
const wrapFade = (l: Layer, sec: number): Layer =>
  ({ kind: 'group', start: l.start, end: l.end, transform: { opacity: { keys: [{ t: 0, v: 1 }, ...tail([sec * 0.6, 1, 'in-out-quad'], [0, 0])] } }, children: [l] }) as Layer

const hidden = (l: Layer): boolean => !!l.behind || (l.kind === 'group' && l.children.some(hidden))

/** A graphic's layers, leaving the way its call says. */
export function leaving(layers: Layer[], leave: Leave, frame: Frame, span: { start: number; end: number }): Layer[] {
  const { width: W, height: H } = frame
  // Drawn behind the speaker, it ends with the cut-out it needs.
  if (layers.some(hidden)) return layers
  const far = leave.way === 'left' || leave.way === 'right' ? W * 0.56 : leave.way === 'down' ? H * 0.5 : leave.way === 'up' ? Math.min(H * 0.8, W * 0.62) : H * 0.075
  // In on a cube, so it sets off unseen and is gone at its fastest, never faster than the creators move things.
  const off = leave.way === 'left' || leave.way === 'right' || leave.way === 'down' || leave.way === 'up'
  const sec = Math.max(off ? 0.55 : 0.42, (3 * far) / (W * FASTEST * 30))
  if (span.end - span.start < sec + SETTLED + 0.3) return layers
  const pieces = layers.filter((l) => !groundOf(l, frame) && Math.abs(l.end - span.end) <= 0.08)
  const each = 'pieces' in leave && leave.pieces ? Math.min(STEP, 0.2 / Math.max(1, pieces.length)) : 0
  const order = new Map(pieces.map((l, i) => [l, i]))
  const last = Math.max(0, pieces.length - 1) * each

  return layers.map((layer): Layer => {
    // One that goes before the rest does (a step of it, replaced) goes as it did.
    if (Math.abs(layer.end - span.end) > 0.08 || layer.end - layer.start < sec + 0.2) return layer
    const ground = groundOf(layer, frame)
    const l = staying(layer, span.end)
    // The frame's own tint only lifts; a wash goes with what stood on it, as the last piece does.
    if (ground === 'all' && leave.way !== 'through') return leave.way === 'up' ? wrapFade(l, sec) : layer
    const late = ground ? 0 : last - (order.get(layer) ?? 0) * each
    const move = (to: number): Anim<number> => ({ keys: [{ t: 0, v: 0 }, ...tail([sec + late, 0, 'in-cubic'], [late, to])] })
    const fade = (over: number): Anim<number> => ({ keys: [{ t: 0, v: 1 }, ...tail([late + over, 1, 'in-quad'], [late, 0])] })
    const wrap = (transform: Layer['transform']): Layer => ({ kind: 'group', start: l.start, end: l.end, transform, children: [l] }) as Layer
    switch (leave.way) {
      case 'left':
        return wrap({ x: move(-far), opacity: fade(ground ? 0.34 : 0.16) })
      case 'right':
        return wrap({ x: move(far), opacity: fade(ground ? 0.34 : 0.16) })
      case 'down':
        return wrap({ y: move(far), opacity: fade(ground ? 0.3 : 0.14) })
      case 'up':
        return wrap({ y: move(-far), opacity: fade(0.16) })
      case 'drop':
        return wrap({ y: move(far), opacity: fade(0.2) })
      case 'lift':
        return wrap({ y: move(-far), opacity: fade(0.2) })
      case 'through':
        return wrap({
          x: W / 2,
          y: H / 2,
          anchorX: W / 2,
          anchorY: H / 2,
          scale: { keys: [{ t: 0, v: 1 }, ...tail([sec, 1, 'in-cubic'], [0, 1.16])] },
          opacity: fade(0.3)
        })
    }
  })
}
