import { fontInfo, fontString, fontWeight } from './fonts'
import type { Span, TextLayer } from './types'

/**
 * Text layout with ctx.measureText: words and characters placed in lines,
 * wrapped to a width, aligned on the layer's origin. Every position is in the
 * layer's own pixels, so animators can move any word or character from where
 * it rests. Vertical positions come from the face's fixed metrics, never from
 * the canvas, so both canvases put lines in the same place.
 */

export interface CharBox {
  ch: string
  /** From the word's left edge. */
  x: number
  w: number
}

export interface WordBox {
  index: number
  span: number
  text: string
  x: number
  baseline: number
  w: number
  size: number
  font: string
  cap: number
  line: number
  chars: CharBox[]
  /** Index of the word's first character among all characters in the block. */
  charStart: number
}

export interface LineBox {
  index: number
  x: number
  w: number
  top: number
  height: number
  baseline: number
  size: number
  cap: number
  words: number[]
}

export interface TextBlock {
  words: WordBox[]
  lines: LineBox[]
  /** The block's box, in the layer's pixels. */
  left: number
  top: number
  w: number
  h: number
  chars: number
}

type Measure = (font: string, text: string) => number

/** measureText with a cache: layout asks for the same prefixes over and over. */
export function measurer(ctx: CanvasRenderingContext2D): Measure {
  const cache = new Map<string, number>()
  return (font, text) => {
    const key = `${font}\u0000${text}`
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    ctx.font = font
    const w = ctx.measureText(text).width
    cache.set(key, w)
    return w
  }
}

interface Token {
  text: string
  span: number
  /** A hard line break comes before this token. */
  breakBefore: boolean
}

function tokens(layer: TextLayer, text: string): Token[] {
  const spans: Span[] = layer.spans && layer.spans.length > 0 && layer.count === undefined ? layer.spans : [{ text }]
  const out: Token[] = []
  let pendingBreak = false
  spans.forEach((s, i) => {
    const t = (s.uppercase ?? layer.font.uppercase) ? s.text.toUpperCase() : s.text
    const lines = t.split('\n')
    lines.forEach((line, li) => {
      if (li > 0) pendingBreak = true
      for (const w of line.split(/[ \t]+/)) {
        if (!w) continue
        out.push({ text: w, span: i, breakBefore: pendingBreak })
        pendingBreak = false
      }
    })
  })
  return out
}

const DIGIT = /\d/

/** Lays a text layer out. `text` overrides the layer's own text (a counter's number for this frame). */
export function layoutText(measure: Measure, layer: TextLayer, text = layer.text): TextBlock {
  const font = layer.font
  const family = fontInfo(font.family).family
  const info = fontInfo(family)
  const tracking = font.tracking ?? 0
  const lineHeight = font.lineHeight ?? 1.15
  const spans = layer.spans ?? []

  const placed: Omit<WordBox, 'x' | 'baseline' | 'line' | 'index' | 'charStart'>[] = []
  const breaks: boolean[] = []
  for (const tok of tokens(layer, text)) {
    const span = spans[tok.span]
    const size = font.size * (span?.scale ?? 1)
    const face = span?.family ? fontInfo(span.family) : info
    const weight = fontWeight(face.family, span?.weight ?? font.weight)
    const css = fontString({ family: face.family, weight }, size)
    const chars: CharBox[] = []
    const glyphs = Array.from(tok.text)
    if (font.tabular) {
      const zero = measure(css, '0')
      let x = 0
      for (const ch of glyphs) {
        const w = DIGIT.test(ch) ? zero : measure(css, ch)
        chars.push({ ch, x, w })
        x += w + tracking
      }
    } else {
      let prefix = ''
      for (const ch of glyphs) {
        const before = measure(css, prefix)
        prefix += ch
        const after = measure(css, prefix)
        chars.push({ ch, x: before + tracking * chars.length, w: after - before })
      }
    }
    const last = chars[chars.length - 1]
    const w = last ? last.x + last.w : 0
    placed.push({ span: tok.span, text: tok.text, w, size, font: css, cap: face.cap * size, chars })
    breaks.push(tok.breakBefore)
  }

  // Greedy wrapping, with a space as wide as the face's own.
  const spaces = placed.map((word) => measure(word.font, ' ') + tracking + (font.wordSpacing ?? 0))
  const wrap = (max: number): { words: number[]; w: number }[] => {
    const out: { words: number[]; w: number }[] = []
    placed.forEach((word, i) => {
      const line = out[out.length - 1]
      const extra = line && line.words.length > 0 ? spaces[i] + word.w : word.w
      if (!line || breaks[i] || (line.words.length > 0 && line.w + extra > max)) {
        out.push({ words: [i], w: word.w })
      } else {
        line.words.push(i)
        line.w += extra
      }
    })
    return out
  }
  const max = layer.maxWidth ?? Infinity
  let lines = wrap(max)
  if (layer.balance && Number.isFinite(max) && lines.length > 1) {
    // The narrowest width that still takes no more lines evens them out.
    let lo = placed.reduce((m, w) => Math.max(m, w.w), 0)
    let hi = Math.max(lo, max)
    for (let i = 0; i < 14 && hi - lo > 0.5; i++) {
      const mid = (lo + hi) / 2
      if (wrap(mid).length > lines.length) lo = mid
      else hi = mid
    }
    lines = wrap(hi)
  }

  const align = layer.align ?? 'left'
  const blockW = lines.reduce((m, l) => Math.max(m, l.w), 0)
  const boxes: LineBox[] = []
  let top = 0
  lines.forEach((l, li) => {
    const size = l.words.reduce((m, i) => Math.max(m, placed[i].size), 0) || font.size
    const height = size * lineHeight
    // Caps sit in the middle of the line, which is what plates and centring want.
    const baseline = top + height / 2 + (info.cap * size) / 2
    const own = spans[placed[l.words[0]]?.span ?? -1]?.align ?? align
    const x = own === 'center' ? (blockW - l.w) / 2 : own === 'right' ? blockW - l.w : 0
    boxes.push({ index: li, x, w: l.w, top, height, baseline, size, cap: info.cap * size, words: l.words })
    top += height
  })
  const blockH = top

  const left = align === 'center' ? -blockW / 2 : align === 'right' ? -blockW : 0
  const valign = layer.valign ?? 'top'
  const firstBaseline = boxes[0]?.baseline ?? 0
  const blockTop =
    valign === 'middle' ? -blockH / 2 : valign === 'bottom' ? -blockH : valign === 'baseline' ? -firstBaseline : 0

  const words: WordBox[] = []
  let charStart = 0
  for (const line of boxes) {
    line.x += left
    line.top += blockTop
    line.baseline += blockTop
    let x = line.x
    for (const i of line.words) {
      const p = placed[i]
      const space = measure(p.font, ' ') + tracking + (font.wordSpacing ?? 0)
      words.push({ ...p, index: words.length, x, baseline: line.baseline, line: line.index, charStart })
      charStart += p.chars.length
      x += p.w + space
    }
    line.words = line.words.map((_, k) => words.length - line.words.length + k)
  }

  return { words, lines: boxes, left, top: blockTop, w: blockW, h: blockH, chars: charStart }
}
