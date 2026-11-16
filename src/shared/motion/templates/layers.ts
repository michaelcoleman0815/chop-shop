import type { LayerInput } from '../schema'
import type { Layer } from '../types'
import { register, type BuildContext } from './registry'

/**
 * Hand-built layers: anything the model can describe that no template does.
 * A layer's start and end are seconds from the graphic's start, or anchors on
 * the edit; left out, it lasts as long as the graphic. Keyframes count from
 * each layer's own start, as everywhere else.
 */

function resolveTime(value: number | string | undefined, ctx: BuildContext, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value === 'number') return ctx.span.start + value
  return ctx.time(value) ?? fallback
}

function resolveLayer(input: LayerInput, ctx: BuildContext, start: number, end: number): Layer | null {
  const s = Math.max(start, resolveTime(input.start, ctx, start))
  const e = Math.min(end, resolveTime(input.end, ctx, end))
  if (e <= s) return null
  if (input.kind === 'group') {
    const children = input.children.map((c) => resolveLayer(c, ctx, s, e)).filter((c): c is Layer => c !== null)
    return { ...input, start: s, end: e, children }
  }
  return { ...input, start: s, end: e } as Layer
}

register({
  kind: 'layers',
  title: 'Custom graphic',
  about: 'Layers built by hand, for anything no other graphic does.',
  styles: [''],
  places: [],
  length: 3,
  lead: 0,
  fields: [],
  check: (call) => (call.layers.length === 0 ? 'A custom graphic needs at least one layer.' : null),
  build: (ctx) =>
    ctx.item.layers
      .map((l) => resolveLayer(l, ctx, ctx.span.start, ctx.span.end))
      .filter((l): l is Layer => l !== null),
  name: (call) => `a custom graphic of ${call.layers.length === 1 ? 'one layer' : `${call.layers.length} layers`}`
})
