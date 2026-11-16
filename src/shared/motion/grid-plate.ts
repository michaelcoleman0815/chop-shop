import type { GridLayout } from '../edit/grid'
import { mixColor } from './anim'
import type { MotionTheme } from './theme'
import type { Geometry, Layer, Size } from './types'

/**
 * What a grid of videos sits in, drawn by the same code in the editor and in
 * the export (edit/grid): the ground, a soft gradient of the brand's accent
 * with each panel's rounded box cut out of it and a soft shadow round each,
 * and the labels, a small white pill in each panel's top-left corner. The
 * videos play underneath, so the ground's cut-outs are what round their
 * corners. The ground holds still; the labels fade in as the grid comes in.
 */

/** Long enough for any edit: the ground and labels last as long as the grid does. */
const ALWAYS = 1e6

/** How long the labels take to come in: the time the export's fade takes too. */
export const LABEL_FADE = 0.24

const panelShape = (layout: GridLayout, i: number): Geometry => {
  const r = layout.panels[i]
  return { type: 'rect', w: r.w, h: r.h, radius: layout.radius, x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/** The ground: opaque everywhere but the panels, which it leaves clear, with each panel's shadow on it. */
export function gridGround(layout: GridLayout, size: Size, theme: MotionTheme): Layer[] {
  const short = Math.min(size.width, size.height)
  const u = short / 1080
  let layers: Layer[] = [
    {
      kind: 'shape',
      start: 0,
      end: ALWAYS,
      shape: { type: 'rect', w: size.width, h: size.height, x: size.width / 2, y: size.height / 2 },
      fill: {
        gradient: 'linear',
        angle: 45,
        stops: [
          [0, mixColor(theme.paper, theme.accent, 0.34)],
          [1, mixColor(theme.paper, theme.accent, 0.1)]
        ]
      }
    },
    // Each panel's box casts its shadow on the ground. The box is a little inside the cut-out,
    // so it is cut away whole and its soft edge never shows as a line round the panel.
    ...layout.panels.map((r): Layer => {
      const inset = 4 * u
      return {
        kind: 'shape',
        start: 0,
        end: ALWAYS,
        shape: {
          type: 'rect',
          w: r.w - inset * 2,
          h: r.h - inset * 2,
          radius: Math.max(0, layout.radius - inset),
          x: r.x + r.w / 2,
          y: r.y + r.h / 2
        },
        fill: '#000000',
        effects: { shadow: { color: 'rgba(0, 0, 0, 0.26)', blur: 44 * u, y: 16 * u } }
      }
    })
  ]
  // One cut-out a group, so the ground keeps out of every panel.
  layout.panels.forEach((_, i) => {
    layers = [{ kind: 'group', start: 0, end: ALWAYS, mask: { shape: panelShape(layout, i), invert: true }, children: layers }]
  })
  return layers
}

/**
 * The labels, one pill a panel that has one, coming in over LABEL_FADE from
 * `from` on the output clock: a plain fade, as the export's is.
 */
export function gridLabels(layout: GridLayout, labels: string[], theme: MotionTheme, from = 0): Layer[] {
  const u = Math.min(...layout.panels.map((p) => Math.min(p.w, p.h))) / 500
  return layout.labels.flatMap((l, i): Layer[] => {
    const text = (labels[i] ?? '').trim()
    if (!text) return []
    const padX = l.size * 0.62
    const padY = l.size * 0.38
    return [
      {
        kind: 'text',
        start: from,
        end: from + ALWAYS,
        text,
        font: { family: theme.body, size: l.size, weight: 600, lineHeight: 1 },
        fill: theme.ink,
        align: 'left',
        valign: 'middle',
        plate: { color: '#FFFFFF', radius: l.size * 2, padX, padY },
        effects: { shadow: { color: 'rgba(0, 0, 0, 0.22)', blur: 12 * u, y: 3 * u } },
        transform: {
          x: l.x + padX,
          y: l.y,
          opacity: { keys: [{ t: 0, v: 0 }, { t: LABEL_FADE, v: 1 }] }
        }
      }
    ]
  })
}
