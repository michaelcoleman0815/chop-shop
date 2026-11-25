import { mixColor } from './anim'
import type { MotionTheme } from './theme'
import type { Layer, TextLayer } from './types'

/**
 * The effects any graphic takes by its call's fx (the planner's guide promises them for every template): each
 * worked on the graphic's words, unless its template reads that word itself (Template.ownFx, as a callout's
 * plate is its own pill). A title asked for fx plate had drawn none.
 */
export const GENERIC_FX = ['shadow', 'glow', 'outline', 'gradient', 'plate', 'blur', 'push'] as const

/**
 * push: the whole graphic comes up from below the frame, a full-frame push on an expo ease-out over 0.74 s, as Ali
 * Abdaal moves from one section to a board (measured: 16 frames, a quarter of the move in its fastest frame). It
 * moves fast enough that the export blurs it as a camera would.
 */
export function pushed(layers: Layer[], fx: string[], height: number): Layer[] {
  if (!fx.some((f) => f.toLowerCase() === 'push') || layers.length === 0) return layers
  const start = Math.min(...layers.map((l) => l.start))
  const end = Math.max(...layers.map((l) => l.end))
  return [
    {
      kind: 'group',
      start,
      end,
      transform: { y: { keys: [{ t: 0, v: height, ease: 'out-expo' }, { t: 0.74, v: 0 }] } },
      children: layers
    }
  ]
}

/** The graphic's layers with the generic fx asked for put on its words, groups and all. */
export function withFx(layers: Layer[], fx: string[], theme: MotionTheme, u: number, own: readonly string[] = []): Layer[] {
  const asked = new Set(
    fx.map((f) => f.toLowerCase()).filter((f) => (GENERIC_FX as readonly string[]).includes(f) && !own.includes(f))
  )
  if (asked.size === 0) return layers
  const text = (l: TextLayer): TextLayer => {
    // Chrome lettering has its own light and edge.
    if (l.chrome) return l
    const size = l.font.size
    const out: TextLayer = { ...l, effects: { ...l.effects } }
    if (asked.has('shadow')) out.effects!.shadow = { color: 'rgba(0, 0, 0, 0.7)', blur: 26 * u, y: 9 * u }
    if (asked.has('glow')) out.effects!.glow = { color: theme.accent, blur: 30 * u, strength: 0.9 }
    if (asked.has('outline') && !l.stroke) out.stroke = { color: '#0B0B0D', width: Math.max(2 * u, size * 0.045), join: 'round' }
    if (asked.has('gradient') && typeof l.fill === 'string')
      out.fill = { gradient: 'linear', angle: 90, stops: [[0, mixColor(l.fill, '#FFFFFF', 0.45)], [1, l.fill]] }
    if (asked.has('plate') && !l.plate)
      out.plate = { color: theme.ink, radius: size * 0.16, padX: size * 0.28, padY: size * 0.14, perLine: true, hug: true }
    if (asked.has('blur'))
      out.animators = [
        ...(l.animators ?? []),
        { by: 'word', timing: 'stagger', stagger: 0.04, duration: 0.3, ease: 'ease-out', from: { blur: 14 * u, opacity: 0 } }
      ]
    return out
  }
  const walk = (l: Layer): Layer => {
    if (l.kind === 'text') return text(l)
    if (l.kind === 'group') return { ...l, children: l.children.map(walk) }
    return l
  }
  return layers.map(walk)
}
