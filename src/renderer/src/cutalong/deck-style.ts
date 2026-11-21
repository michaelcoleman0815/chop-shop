import type { CSSProperties } from 'react'
import { transitionInfo, type Layer } from '../../../shared/edit'

/**
 * How a deck looks in the preview at one moment of a transition: an honest
 * approximation of the export, drawn with CSS. A dissolve is opacity, a dip
 * fades through its colour, wipes and irises clip, pushes and slides move,
 * blurs blur. The wrapper moves and clips; the picture inside fades.
 */
export interface DeckStyle {
  wrapper: CSSProperties
  picture: CSSProperties
  /** Inside a dip, the colour the outgoing picture fades through (drawn by cutalong.css). */
  dip?: 'black' | 'white'
}

const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`

export function deckStyle(layer: Layer | null): DeckStyle {
  // An idle deck, or one whose sound plays under another's picture (a J or L cut).
  if (!layer || !layer.visible) return { wrapper: { visibility: 'hidden' }, picture: {} }
  const t = layer.transition
  if (!t) return { wrapper: { zIndex: 1 }, picture: {} }
  const info = transitionInfo(t.kind)
  const p = t.progress
  const coming = t.side === 'in'
  // The picture coming in sits on top, as in the export.
  const wrapper: CSSProperties = { zIndex: coming ? 2 : 1 }
  const picture: CSSProperties = {}
  let dip: DeckStyle['dip']
  const from = info.from ?? 'right'
  const axis = from === 'left' || from === 'right' ? 'X' : 'Y'
  // Which way the new picture travels, as a sign: from the right it moves left.
  const sign = from === 'right' || from === 'bottom' ? 1 : -1

  switch (info.preview) {
    case 'fade':
      if (coming) picture.opacity = p
      break
    case 'dip':
      if (coming) picture.opacity = Math.max(0, 2 * p - 1)
      else {
        dip = info.color === 'white' ? 'white' : 'black'
        picture.opacity = Math.max(0, 1 - 2 * p)
      }
      break
    case 'wipe':
      if (coming) {
        const hidden = pct(1 - p)
        wrapper.clipPath =
          from === 'right'
            ? `inset(0 0 0 ${hidden})`
            : from === 'left'
              ? `inset(0 ${hidden} 0 0)`
              : from === 'bottom'
                ? `inset(${hidden} 0 0 0)`
                : `inset(0 0 ${hidden} 0)`
      }
      break
    case 'slide':
    case 'whip':
      wrapper.transform = coming ? `translate${axis}(${pct(sign * (1 - p))})` : `translate${axis}(${pct(-sign * p)})`
      if (info.preview === 'whip') wrapper.filter = `blur(${Math.round(Math.sin(p * Math.PI) * 12)}px)`
      break
    case 'cover':
      if (coming) wrapper.transform = `translate${axis}(${pct(sign * (1 - p))})`
      break
    case 'iris':
      if (coming) wrapper.clipPath = `circle(${pct(p * 0.75)} at 50% 50%)`
      break
    case 'zoom':
      if (coming) picture.opacity = p
      else wrapper.transform = `scale(${(1 + p * 0.6).toFixed(3)})`
      break
    case 'blur':
      wrapper.filter = `blur(${Math.round((coming ? 1 - p : p) * 14)}px)`
      if (coming) picture.opacity = p
      break
  }
  return dip ? { wrapper, picture, dip } : { wrapper, picture }
}
