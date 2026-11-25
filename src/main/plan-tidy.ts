import { currentCut, type EditDoc, type Note } from '../shared/edit'
import type { LayerInput } from '../shared/motion/schema'
import { lineWidth } from '../shared/motion/templates/measure'
import type { PlannerOp } from './planner-prompt'

/**
 * What a plan is put right in without asking Claude again: captions nobody asked for, and a designed graphic that
 * runs off the frame or over the speaker.
 */

/** Words that ask for captions, in any of the ways people say it. */
const CAPTIONS = /\b(caption|subtitle|subs\b|cc\b|closed.caption|transcri|lyric|karaoke|word.by.word|words? (up )?on (the )?screen|text (up )?on (the )?screen|hierarchy)/i

/** Whether a plan turns an edit upright, where captions are usual. */
const upright = (aspect: string | undefined): boolean => aspect === 'vertical' || aspect === '9:16' || aspect === 'portrait' || aspect === 'square'

/**
 * A plan without captions nobody asked for: a wide video starts without them, and "punchy" is not asking. Captions
 * already on may be changed, and an upright video may have them.
 */
export function withoutUninvitedCaptions(doc: EditDoc, request: string, notes: Pick<Note, 'text'>[], ops: PlannerOp[]): PlannerOp[] {
  const cut = currentCut(doc)
  const source = doc.sources.find((s) => s.width > 0)
  const wide = !upright(cut.aspect) && !(source && cut.aspect === 'original' && source.height >= source.width)
  if (!wide || cut.captions.on || CAPTIONS.test([request, ...notes.map((n) => n.text)].join('\n'))) return ops
  if (ops.some((o) => (o as { op: string; aspect?: string }).op === 'aspect' && upright((o as { aspect?: string }).aspect))) return ops
  return ops.filter((o) => {
    const op = o as { op: string; set?: { on?: boolean; captions?: boolean } }
    if (op.op === 'captions') return op.set?.on === false
    return true
  })
}

// ---------- A designed graphic, kept in its room ----------

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}
const join = (a: Box | null, b: Box | null): Box | null => (!a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) })

/** Where a value comes to rest: itself, or the last of its keys before it goes. */
function rest(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v
  const keys = (v as { keys?: { v: unknown; from?: string }[] } | undefined)?.keys?.filter((k) => k.from !== 'end')
  const last = keys?.[keys.length - 1]?.v
  return typeof last === 'number' ? last : fallback
}

/** The size of a layer's own drawing about its origin, at rest. */
function ownBox(l: LayerInput): Box | null {
  if (l.kind === 'text') {
    const spans = (l.spans ?? []).map((s) => s.text).join('')
    const lines = (l.text || spans).split('\n')
    const size = l.font.size
    let w = Math.max(...lines.map((t) => lineWidth(t, l.font.family, size, typeof l.font.tracking === 'number' ? l.font.tracking : 0, !!l.font.uppercase)))
    const wraps = l.maxWidth ? Math.max(1, Math.ceil(w / l.maxWidth)) : 1
    if (l.maxWidth) w = Math.min(w, l.maxWidth)
    const h = size * 1.12 * lines.length * wraps
    const x0 = l.align === 'left' ? 0 : l.align === 'right' ? -w : -w / 2
    const y0 = l.valign === 'top' ? 0 : l.valign === 'bottom' ? -h : l.valign === 'baseline' ? -size * 0.8 : -h / 2
    return { x0, y0, x1: x0 + w, y1: y0 + h }
  }
  if (l.kind === 'image') return { x0: -l.w / 2, y0: -l.h / 2, x1: l.w / 2, y1: l.h / 2 }
  if (l.kind === 'shape') {
    const s = l.shape as { type: string; w?: number; h?: number; x?: number; y?: number; points?: unknown; d?: string }
    const pad = l.stroke ? rest(l.stroke.width, 4) / 2 : 0
    if (s.w !== undefined && s.h !== undefined) {
      const x = s.x ?? 0
      const y = s.y ?? 0
      return { x0: x - s.w / 2 - pad, y0: y - s.h / 2 - pad, x1: x + s.w / 2 + pad, y1: y + s.h / 2 + pad }
    }
    const pts = Array.isArray(s.points)
      ? (s.points as [number, number][])
      : s.d
        ? (s.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).reduce<[number, number][]>((out, n, i, all) => (i % 2 ? out : [...out, [n, all[i + 1] ?? 0]]), [])
        : []
    if (pts.length === 0) return null
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return { x0: Math.min(...xs) - pad, y0: Math.min(...ys) - pad, x1: Math.max(...xs) + pad, y1: Math.max(...ys) + pad }
  }
  if (l.kind === 'group') return l.children.reduce<Box | null>((b, c) => join(b, boxOf(c)), null)
  return null
}

/** Where a layer lies in what holds it, at rest. */
function boxOf(l: LayerInput): Box | null {
  const own = ownBox(l)
  if (!own) return null
  const t = (l.transform ?? {}) as Record<string, unknown>
  const s = rest(t.scale, 1)
  const sx = s * rest(t.scaleX, 1)
  const sy = s * rest(t.scaleY, 1)
  const x = rest(t.x, 0)
  const y = rest(t.y, 0)
  const ax = rest(t.anchorX, 0)
  const ay = rest(t.anchorY, 0)
  return { x0: x + (own.x0 - ax) * sx, y0: y + (own.y0 - ay) * sy, x1: x + (own.x1 - ax) * sx, y1: y + (own.y1 - ay) * sy }
}

/** Whether a layer is a ground: a wash or a fill over much of the frame, which belongs where it is. */
const isGround = (l: LayerInput, W: number, H: number): boolean => {
  const b = l.kind === 'shape' ? boxOf(l) : null
  return !!b && (b.x1 - b.x0) * (b.y1 - b.y0) > W * H * 0.22
}

/**
 * A designed graphic kept in its room: drawn smaller and moved over, as a whole, when it runs past the part of the
 * frame it was given, so none of it is cut off or lies over the speaker. One that fits is left exactly as it was.
 */
export function inItsRoom(layers: LayerInput[], room: 'left' | 'right' | 'foot' | 'full' | 'over', W: number, H: number): LayerInput[] {
  const free: Box = {
    left: { x0: W * 0.04, y0: H * 0.06, x1: W * 0.485, y1: H * 0.94 },
    right: { x0: W * 0.515, y0: H * 0.06, x1: W * 0.96, y1: H * 0.94 },
    foot: { x0: W * 0.05, y0: H * 0.58, x1: W * 0.95, y1: H * 0.96 },
    full: { x0: W * 0.04, y0: H * 0.05, x1: W * 0.96, y1: H * 0.95 },
    over: { x0: W * 0.03, y0: H * 0.04, x1: W * 0.97, y1: H * 0.96 }
  }[room]
  const drawn = layers.filter((l) => !isGround(l, W, H))
  const box = drawn.reduce<Box | null>((b, l) => join(b, boxOf(l)), null)
  if (!box || drawn.length === 0) return layers
  const slack = W * 0.004
  if (box.x0 >= free.x0 - slack && box.x1 <= free.x1 + slack && box.y0 >= free.y0 - slack && box.y1 <= free.y1 + slack) return layers
  const w = Math.max(1, box.x1 - box.x0)
  const h = Math.max(1, box.y1 - box.y0)
  const scale = Math.min(1, (free.x1 - free.x0) / w, (free.y1 - free.y0) / h)
  const cx = (box.x0 + box.x1) / 2
  const cy = (box.y0 + box.y1) / 2
  const clampTo = (c: number, half: number, lo: number, hi: number): number => Math.min(hi - half, Math.max(lo + half, c))
  const x = clampTo(cx, (w * scale) / 2, free.x0, free.x1)
  const y = clampTo(cy, (h * scale) / 2, free.y0, free.y1)
  const round = (n: number): number => Math.round(n * 1000) / 1000
  const held = { kind: 'group', transform: { x: round(x), y: round(y), anchorX: round(cx), anchorY: round(cy), scale: round(scale) }, children: drawn } as unknown as LayerInput
  // The grounds under it stay as they are; what was drawn goes on them together.
  return [...layers.filter((l) => isGround(l, W, H)), held]
}
