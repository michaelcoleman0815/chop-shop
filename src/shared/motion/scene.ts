import type { Resolved } from '../edit/resolve'
import type { Cut, Word } from '../edit/schema'
import { captionLayers, facesNear, type CaptionCover, type FaceSample } from './captions'
import type { MotionItem, MotionKind } from './schema'
import { template } from './templates'
import { frameFor, type Frame, type MotionTheme } from './theme'
import { anchorTime, spanFor, timelineFor, type Timeline } from './timing'
import type { Layer, Size } from './types'

/**
 * The cut's graphics on the output clock. Every call is checked, placed and
 * built into layers with absolute times; what does not fit the cut (its
 * anchor's beat is gone, or it would start after the end) is left out and
 * says why, for the editor to show.
 */

export interface SceneItem {
  id: string
  kind: MotionKind
  /** The moment its anchor lands on. */
  at: number
  start: number
  end: number
  layers: Layer[]
}

export interface MotionScene {
  size: Size
  frame: Frame
  duration: number
  /** Everything to draw, bottom first. */
  layers: Layer[]
  items: SceneItem[]
  /** Graphics in the doc that are not drawn, with the reason. */
  hidden: { id: string; reason: string }[]
}

export interface SceneInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  /** The full-size output frame: design pixels. */
  size: Size
  theme: MotionTheme
  /** Faces through the cut, from face tracking, for drawn captions to keep off. */
  faces?: FaceSample[]
  /** How strongly each word is stressed, 0 to 1, by word id, for which caption words go big. */
  emphasis?: Record<string, number>
  /** The edit's pictures, for graphics that show one at its own shape. */
  assets?: { id: string; kind: string; width: number | null; height: number | null }[]
}

/** Builds every graphic in the cut. Never throws on a bad call: it is hidden instead. */
export function buildScene(input: SceneInput): MotionScene {
  const frame = frameFor(input.size)
  const tl = timelineFor(input.cut, input.resolved, input.words)
  const items: SceneItem[] = []
  const hidden: MotionScene['hidden'] = []
  for (const item of input.cut.motion ?? []) {
    const built = buildItem(item, tl, frame, input.theme, input.faces, input.assets ?? [])
    if ('reason' in built) hidden.push({ id: item.id, reason: built.reason })
    else items.push(built)
  }
  const covers: CaptionCover[] = items.flatMap((i) => {
    const kind = template(i.kind)?.covers
    return kind ? [{ start: i.start, end: i.end, kind }] : []
  })
  const captions = captionLayers({
    spec: input.cut.captions,
    resolved: input.resolved,
    frame,
    theme: input.theme,
    duration: tl.duration,
    faces: input.faces,
    emphasis: input.emphasis,
    covers
  })
  // Backdrops replace the picture, so they go under the captions; everything else goes over. Cards hold
  // the screen, so what stands beside one (a counter by a page) goes over it, whichever came first.
  const coverOf = (i: SceneItem): string | undefined => template(i.kind)?.covers
  return {
    size: input.size,
    frame,
    duration: tl.duration,
    layers: [
      ...items.filter((i) => coverOf(i) === 'backdrop').flatMap((i) => i.layers),
      ...captions,
      ...items.filter((i) => coverOf(i) === 'card').flatMap((i) => i.layers),
      ...items.filter((i) => !coverOf(i)).flatMap((i) => i.layers)
    ],
    items,
    hidden
  }
}

function buildItem(
  item: MotionItem,
  tl: Timeline,
  frame: Frame,
  theme: MotionTheme,
  faces: FaceSample[] | undefined,
  assets: NonNullable<SceneInput['assets']>
): SceneItem | { reason: string } {
  const tpl = template(item.kind)
  if (!tpl) return { reason: `There is no ${item.kind} graphic.` }
  const problem = tpl.check(item)
  if (problem) return { reason: problem }
  const span = spanFor(tl, item.from, item.to, tpl.length, tpl.lead)
  if (!span) return { reason: 'What it was on is no longer in the cut.' }
  let layers: Layer[]
  try {
    layers = tpl.build({
      item,
      frame,
      theme,
      span,
      tl,
      time: (ref) => anchorTime(tl, ref),
      faces: facesNear(faces, span.at),
      picture: (id) => {
        const a = assets.find((x) => x.id === id && x.kind === 'image')
        return a ? { width: a.width ?? 0, height: a.height ?? 0 } : null
      }
    })
  } catch (err) {
    return { reason: `It could not be drawn: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { id: item.id, kind: item.kind, at: span.at, start: span.start, end: span.end, layers }
}

/** Every stretch of output time when something is drawn, merged where gaps are short. */
export function activeSpans(layers: Layer[], duration: number, mergeGap = 0.25): { start: number; end: number }[] {
  const spans = layers
    .map((l) => ({ start: Math.max(0, l.start), end: Math.min(duration, l.end) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s.start <= last.end + mergeGap) last.end = Math.max(last.end, s.end)
    else out.push({ ...s })
  }
  return out
}

/** The graphics on screen at t, topmost last. */
export function itemsAt(scene: MotionScene, t: number): SceneItem[] {
  return scene.items.filter((i) => t >= i.start && t < i.end)
}
