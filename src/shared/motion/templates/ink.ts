import { DEFAULT_THEME, type Frame, type MotionTheme } from '../theme'
import type { Key, Layer } from '../types'
import { tail } from '../anim'
import { lineWidth } from './measure'

/**
 * What the graphics that sit round a speaker share: words with *some* of them picked out, lines broken by width,
 * the darkened or washed side of the picture they sit on, and marks drawn by hand.
 */

export interface Word {
  text: string
  /** Between asterisks: the words that matter. */
  star: boolean
}

/** A line as words, "*phrase*" marking the ones picked out. */
export function starWords(line: string): Word[] {
  return line.split('*').flatMap((part, i) =>
    part
      .split(/\s+/)
      .filter(Boolean)
      .map((text) => ({ text, star: i % 2 === 1 }))
  )
}

/** A line without its asterisks. */
export const plainLine = (line: string): string => line.replace(/\*/g, '').replace(/\s+/g, ' ').trim()

/** Words broken into lines no wider than `maxW`. */
export function wrapWords(words: Word[], family: string, size: number, maxW: number): Word[][] {
  const lines: Word[][] = []
  for (const w of words) {
    const last = lines[lines.length - 1]
    const would = last ? [...last, w].map((x) => x.text).join(' ') : ''
    if (last && lineWidth(would, family, size) <= maxW) last.push(w)
    else lines.push([w])
  }
  // No short word left alone on the last line.
  const end = lines[lines.length - 1]
  const before = lines[lines.length - 2]
  if (before && before.length > 2 && end.length === 1 && end[0].text.length <= 5) end.unshift(before.pop() as Word)
  return lines
}

/** The biggest size, at most `max`, that a line fits `width` at. */
export const fitLine = (line: string, family: string, width: number, max: number): number =>
  Math.min(max, (width / Math.max(1, lineWidth(line, family, 100))) * 100)

/** In over `sec`, and gone with the rest of the graphic: what a whole graphic's ground does (measured: 0.4 s in, 0.35 s out). */
export const ground = (sec = 0.45, out = 0.36): { keys: Key<number>[] } => ({
  keys: [{ t: 0, v: 0, ease: 'in-out-quad' }, { t: sec, v: 1 }, ...tail([out, 1, 'in-out-quad'], [0, 0])]
})

/**
 * How things arrive here, as Iman Gadzhi's do (measured frame by frame): up from a little below on a long settle that
 * is still just moving a second and a half later, faded in on the way; nothing pops, bounces or snaps. They all go
 * together, in a third of a second.
 */
export const GO: Key<number>[] = tail([0.34, 1, 'in-out-quad'], [0, 0])
export const rise = (t: number, to: number, by: number, sec = 1.7): { keys: Key<number>[] } => ({ keys: [{ t, v: to + by, ease: 'out-quint' }, { t: t + sec, v: to }] })
/** From further below, as a bar comes up over the foot of the picture. */
export const riseFar = (t: number, to: number, by: number, sec = 2.8): { keys: Key<number>[] } => ({ keys: [{ t, v: to + by, ease: 'out-quart' }, { t: t + sec, v: to }] })
export const soft = (t: number, sec = 0.4): { keys: Key<number>[] } => ({ keys: [{ t, v: 0, ease: 'in-out-quad' }, { t: t + sec, v: 1 }, ...GO] })
export const swell = (t: number, from = 0.92, sec = 1.4): { keys: Key<number>[] } => ({ keys: [{ t, v: from, ease: 'out-quint' }, { t: t + sec, v: 1 }] })

/**
 * The side of the picture words sit on, darkened (or washed light) from the frame's edge to nothing past the middle,
 * so they read on any picture and it still shows through.
 */
export function sideWash(frame: Frame, side: 'left' | 'right', start: number, end: number, light: boolean, strength: number): Layer {
  const W = frame.width
  const H = frame.height
  const w = W * 0.72
  const [r, g, b] = light ? [250, 251, 253] : [6, 7, 10]
  const at = (a: number): string => `rgba(${r}, ${g}, ${b}, ${(a * strength).toFixed(3)})`
  const stops: [number, string][] = [
    [0, at(1)],
    [0.42, at(light ? 0.9 : 0.8)],
    [0.72, at(0.36)],
    [1, at(0)]
  ]
  return {
    kind: 'shape',
    start,
    end,
    shape: { type: 'rect', w, h: H },
    fill: { gradient: 'linear', angle: 0, stops: side === 'left' ? stops : stops.map(([o, c]): [number, string] => [1 - o, c]).reverse() },
    transform: { x: side === 'left' ? w / 2 : W - w / 2, y: H / 2, opacity: ground(0.9, 0.5) }
  }
}

/** A pen's underline, `w` long: a shallow bow that thins away at neither end, as a person draws one. */
export const penLine = (w: number, bow: number): string =>
  `M 0 ${(bow * 0.55).toFixed(1)} C ${(w * 0.22).toFixed(1)} ${(-bow * 0.5).toFixed(1)} ${(w * 0.62).toFixed(1)} ${(-bow * 0.45).toFixed(1)} ${w.toFixed(1)} ${(bow * 0.2).toFixed(1)}`

/** A short second stroke back under a penLine. */
export const penBack = (w: number, bow: number): string =>
  `M ${(w * 0.86).toFixed(1)} ${(bow * 1.5).toFixed(1)} C ${(w * 0.6).toFixed(1)} ${(bow * 0.8).toFixed(1)} ${(w * 0.4).toFixed(1)} ${(bow * 0.9).toFixed(1)} ${(w * 0.2).toFixed(1)} ${(bow * 1.35).toFixed(1)}`

export interface Faces {
  /** The biggest words and the figures. */
  HEAVY: string
  /** Smaller words. */
  SEMI: string
  /** Words in a line as they are said. */
  BODY: string
  /** A word or two by hand. */
  HAND: string
}
/** The faces these graphics set in: the video's own, or the house's for this kind of graphic. */
export function facesOf(theme: MotionTheme): Faces {
  const display = theme.display === DEFAULT_THEME.display ? null : theme.display
  const body = theme.body === DEFAULT_THEME.body ? null : theme.body
  return { HEAVY: display ?? 'Inter ExtraBold', SEMI: body ?? 'Inter SemiBold', BODY: body ?? 'Figtree Bold', HAND: theme.script }
}
/** Whether what is beside the speaker is washed light: as the call says, else as the video does. */
export const onLight = (fx: readonly string[], theme: MotionTheme): boolean => fx.includes('light') || (theme.ground === 'light' && !fx.includes('dark'))
