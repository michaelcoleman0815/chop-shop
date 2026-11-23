import { checkExprs, MAX_REF_DEPTH, type ExprSite } from '../anim/expr'
import { exprOf, isKeyed, num } from '../motion/anim'
import type { Anim, Crop, ExprBinding, Layer, Size } from '../motion/types'
import type { Placed } from './resolve'
import type { KeyedProp, Track, TrackClip } from './schema'

/**
 * Compositing on the layer tracks: blend modes that work on the edit's own
 * picture, adjustment clips that grade what is under them, and expressions
 * on any keyed setting.
 *
 * The tracks are drawn as a see-through overlay wherever every clip is
 * plain, which is cheap: the export lays it over the picture and the preview
 * shows it over the decks. Where a clip blends (multiply, screen …) or
 * adjusts, it has to see the picture under it, so for that stretch the
 * picture is drawn into the compositor first, at the bottom (baseSpans):
 * decoded frames of the rendered picture in the export, the decks' frame in
 * the preview.
 */

export interface Span {
  start: number
  end: number
}

/** Whether a layer works on what is drawn under it, and so needs the edit's picture there. */
export function needsBase(layer: Layer): boolean {
  return !!layer.adjust || (!!layer.blend && layer.blend !== 'normal')
}

function merged(spans: Span[], gap: number): Span[] {
  const out: Span[] = []
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + gap) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** The stretches where a layer blends with or grades the picture under it, joined across short gaps, at most `max` of them. */
export function baseSpans(layers: Layer[], duration: number, max = 6): Span[] {
  const own = layers
    .filter(needsBase)
    .map((l) => ({ start: Math.max(0, l.start), end: Math.min(duration, l.end) }))
    .filter((s) => s.end > s.start)
  let gap = 0.25
  let spans = merged(own, gap)
  while (spans.length > max) {
    gap *= 2
    spans = merged(own, gap)
  }
  return spans
}

/** `spans` with every stretch of `out` taken out of them. */
export function withoutSpans(spans: Span[], out: Span[]): Span[] {
  let rest = spans.map((s) => ({ ...s }))
  for (const o of out) {
    rest = rest.flatMap((s) => {
      if (o.end <= s.start || o.start >= s.end) return [s]
      const parts: Span[] = []
      if (o.start > s.start) parts.push({ start: s.start, end: o.start })
      if (o.end < s.end) parts.push({ start: o.end, end: s.end })
      return parts
    })
  }
  return rest.filter((s) => s.end - s.start > 1e-6)
}

/** Whether a layer needing the picture is on screen at t. */
export function needsBaseAt(layers: Layer[], t: number): boolean {
  return layers.some((l) => t >= l.start && t < l.end && needsBase(l))
}

// ---------- Expressions ----------

/** A clip's keyed settings, by name, as they are now. */
export function clipAnims(clip: TrackClip): [KeyedProp, Anim<number> | undefined][] {
  return [
    ...(Object.entries(clip.transform ?? {}) as [KeyedProp, Anim<number> | undefined][]),
    ['opacity', clip.opacity],
    ...(Object.entries(clip.crop ?? {}).map(([k, v]) => [`crop.${k}`, v]) as [KeyedProp, Anim<number> | undefined][]),
    ['volume', clip.volume]
  ]
}

/** Whether any of a clip's settings carries an expression. */
export const hasExpr = (clip: TrackClip): boolean => clipAnims(clip).some(([, a]) => !!exprOf(a))

/** A setting with its expression set, or taken off with ''. A plain value becomes the key under it. */
export function withExpr(anim: Anim<number> | undefined, expr: string): Anim<number> | undefined {
  const text = expr.trim()
  if (!text) {
    if (!isKeyed(anim)) return anim
    const { expr: _gone, ...rest } = anim as { keys: never[]; expr?: string }
    return rest.keys.length > 0 ? rest : undefined
  }
  if (anim === undefined) return { keys: [], expr: text }
  if (!isKeyed(anim)) return { keys: [{ t: 0, v: anim }], expr: text }
  return { ...anim, expr: text }
}

/**
 * Why the tracks' expressions cannot stand together (one unreadable, a circle
 * of them), or null. With `before`, the tracks as they were, only the
 * expressions a change wrote are read closely; a circle is refused wherever
 * it is.
 */
export function trackExprProblem(tracks: Track[], before?: Track[]): string | null {
  const clips = tracks.flatMap((t) => t.clips)
  const sites: ExprSite[] = []
  for (const c of clips)
    for (const [path, a] of clipAnims(c)) {
      const source = exprOf(a)
      if (source) sites.push({ clip: c.id, ...(c.name ? { name: c.name } : {}), path, source })
    }
  if (sites.length === 0) return null
  // The expressions as they were, by clip and setting: one the change did not write is not read closely again.
  const was = before
    ? new Map<string, string | undefined>(before.flatMap((t) => t.clips).flatMap((c) => clipAnims(c).map(([path, a]) => [`${c.id}.${path}`, exprOf(a)] as [string, string | undefined])))
    : null
  return checkExprs(
    sites,
    clips.map((c) => ({ id: c.id, ...(c.name ? { name: c.name } : {}) })),
    was ? (site) => was.get(`${site.clip}.${site.path}`) !== site.source : undefined
  )
}

/** What a setting is when nothing sets it, as a layer reads it. */
function restOf(path: string, design: Size): number {
  if (path === 'x') return design.width / 2
  if (path === 'y') return design.height / 2
  if (path === 'scale' || path === 'scaleX' || path === 'scaleY' || path === 'opacity') return 1
  return 0
}

function boundCrop(crop: Crop | undefined, bind: ExprBinding): Crop | undefined {
  if (!crop) return crop
  const out: Crop = {}
  for (const [k, a] of Object.entries(crop) as [keyof Crop, Anim<number> | undefined][]) out[k] = exprOf(a) ? ({ ...(a as object), bind } as Anim<number>) : a
  return out
}

/**
 * Ties each clip's expressions to where it plays: its place (`index`), and
 * the other clips its expressions read, at the same moment of the edit. The
 * layers' settings that carry an expression are replaced by copies that know
 * this; nothing in the cut is changed. A chain of readings is cut short where
 * it would come back on itself, or run deeper than MAX_REF_DEPTH.
 */
export function bindExprs(pairs: { p: Placed; layer: Layer | null }[], design: Size): void {
  if (!pairs.some(({ p }) => hasExpr(p.clip))) return
  const byId = new Map(pairs.map((x) => [x.p.clip.id, x]))
  const byName = new Map<string, (typeof pairs)[number]>()
  for (const x of pairs) if (x.p.clip.name && !byName.has(x.p.clip.name)) byName.set(x.p.clip.name, x)
  const reading: string[] = []

  const read = (name: string, path: string, at: number): number | null => {
    const target = byId.get(name) ?? byName.get(name)
    if (!target) return null
    const key = `${target.p.clip.id}.${path}`
    if (reading.includes(key) || reading.length >= MAX_REF_DEPTH) return null
    reading.push(key)
    try {
      const local = at - target.p.start
      const length = target.p.end - target.p.start
      const { clip } = target.p
      const layer = target.layer
      let anim: Anim<number> | undefined
      if (path === 'volume') anim = clip.volume
      else if (path.startsWith('crop.')) {
        const side = path.slice(5) as keyof Crop
        const crop = layer?.adjust?.crop ?? (layer && 'crop' in layer ? (layer.crop as Crop | undefined) : undefined) ?? clip.crop
        anim = crop?.[side]
      } else anim = (layer?.transform as Record<string, Anim<number> | undefined> | undefined)?.[path] ?? (clip.transform as Record<string, Anim<number> | undefined> | undefined)?.[path]
      return num(anim, local, length, restOf(path, design))
    } finally {
      reading.pop()
    }
  }

  pairs.forEach(({ p, layer }, index) => {
    if (!layer || !hasExpr(p.clip)) return
    const bind: ExprBinding = { index, clip: (name, path, local) => read(name, path, p.start + local) }
    const tf = { ...(layer.transform ?? {}) } as Record<string, Anim<number> | undefined>
    for (const [k, a] of Object.entries(tf)) if (exprOf(a)) tf[k] = { ...(a as object), bind } as Anim<number>
    layer.transform = tf
    if (layer.adjust) layer.adjust = { ...layer.adjust, crop: boundCrop(layer.adjust.crop, bind) }
    if (layer.kind === 'video' || layer.kind === 'image') layer.crop = boundCrop(layer.crop, bind)
  })
}
