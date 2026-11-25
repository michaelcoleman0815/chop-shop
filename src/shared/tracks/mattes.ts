import type { Cut } from '../edit/schema'
import type { CutoutKind, CutoutView } from '../fx/masks'
import type { Mask } from '../fx/pixels'
import { template } from '../motion/templates'
import { spanFor, type Timeline } from '../motion/timing'
import type { DrawResources, Layer } from '../motion/types'
import type { ClipMedia } from './media'
import { placeClips, tracksOf } from './resolve'

/**
 * Mattes from the cut-outs: the person, or the objects, as Vision cut them
 * out of the recording on screen (shared/fx/masks), placed in the frame as it
 * shows that recording, and drawn white where they are for the compositor
 * (DrawResources.mattes). The preview and the export both make them this way
 * from the same masks. And which stretches of the edit want them, so the
 * cut-outs are made where they are needed: the clips with a person or object
 * matte, and graphics drawn behind the person.
 */


type Make = NonNullable<DrawResources['createCanvas']>

/** A mask as a canvas, white, its alpha the mask. */
function maskCanvas(mask: Mask, make: Make): CanvasImageSource | null {
  const canvas = make(mask.width, mask.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.createImageData(mask.width, mask.height)
  const d = img.data
  for (let i = 0; i < mask.data.length; i++) {
    const o = i * 4
    d[o] = 255
    d[o + 1] = 255
    d[o + 2] = 255
    d[o + 3] = mask.data[i]
  }
  ctx.putImageData(img, 0, 0)
  return canvas as unknown as CanvasImageSource
}

/** Several masks as one: each pixel the most any of them covers it. */
function union(masks: Mask[]): Mask | null {
  if (masks.length === 0) return null
  const out = new Uint8Array(masks[0].data.length)
  for (const m of masks) for (let i = 0; i < out.length; i++) if (m.data[i] > out[i]) out[i] = m.data[i]
  return { data: out, width: masks[0].width, height: masks[0].height }
}

/** The mask a matte names at a moment, at w by h: the person, every object, or object:<n>. */
export function matteMask(view: CutoutView, from: string, t: number, w: number, h: number): Mask | null {
  if (from === 'person') return view.person(t, w, h)
  const objects = view.objects(t, w, h)
  if (!objects) return null
  if (from === 'objects') return union(objects.map((o) => o.mask))
  const id = Number(from.slice('object:'.length))
  return objects.find((o) => o.id === id)?.mask ?? null
}

/** The cut-outs as the compositor's mattes, kept for the frame being drawn. */
export function cutoutMattes(view: CutoutView, make: Make): NonNullable<DrawResources['mattes']> {
  const kept = new Map<string, CanvasImageSource | null>()
  return (from, t, width, height) => {
    // At the size asked, the frame's: placed by the same arithmetic everywhere, and never drawn up by the canvas.
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const key = `${from} ${t.toFixed(4)} ${w}x${h}`
    if (kept.has(key)) return kept.get(key) ?? null
    // A frame's worth: its layers all ask about the same moment.
    if (kept.size > 8) kept.clear()
    const mask = matteMask(view, from, t, w, h)
    const img = mask ? maskCanvas(mask, make) : null
    kept.set(key, img)
    return img
  }
}

/** A stretch of the edit that wants a kind of cut-out. */
export interface MatteWant {
  kind: CutoutKind
  start: number
  end: number
}

const kindOf = (from: string): CutoutKind | null => (from === 'person' ? 'person' : from === 'objects' || from.startsWith('object:') ? 'objects' : null)

function hasBehind(layers: { behind?: boolean; children?: unknown[] }[]): boolean {
  return layers.some((l) => l.behind === true || (Array.isArray(l.children) && hasBehind(l.children as { behind?: boolean }[])))
}

/** Whether any layer of a built scene is drawn behind the person. */
export function drawsBehind(layers: Layer[]): boolean {
  return hasBehind(layers as { behind?: boolean; children?: unknown[] }[])
}

/**
 * Where the edit wants cut-outs for its mattes: each picture clip with a
 * person or object matte over the stretch it plays, and each graphic with a
 * layer drawn behind the person over its own.
 */
export function matteWants(cut: Cut, tl: Timeline, media?: Map<string, ClipMedia>): MatteWant[] {
  const out: MatteWant[] = []
  for (const p of placeClips(tracksOf(cut), tl, 'picture', media)) {
    const kind = p.clip.matte ? kindOf(p.clip.matte.from) : null
    if (kind) out.push({ kind, start: p.start, end: p.end })
  }
  for (const item of cut.motion ?? []) {
    const tpl = template(item.kind)
    // Hand-built layers drawn behind, or a template that draws behind for this call (a title set behind the speaker).
    if (!hasBehind((item.layers ?? []) as { behind?: boolean }[]) && !tpl?.behind?.(item)) continue
    const span = tpl ? spanFor(tl, item.from, item.to, tpl.length, tpl.lead) : null
    if (span) out.push({ kind: 'person', start: span.start, end: span.end })
  }
  return out
}
