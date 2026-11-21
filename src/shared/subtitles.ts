import { presetById } from './caption-presets'
import { captionedWords, type Resolved } from './edit/resolve'
import type { CaptionSpec } from './edit/schema'
import { fontInfo, fontString, type MotionScene } from './motion'
import type { CaptionStyle, TranscriptWord } from './types'
import { groupWords } from './words'

/**
 * Burned-in captions as the export draws them, for the export and the editor
 * alike. The export writes them into an ASS file that libass draws
 * (main/captions); the editor's preview draws the same cues on a canvas, laid
 * out here by libass's own rules at the export's size, so a caption is the
 * same size in the same place in both.
 *
 * libass's rules, as followed here:
 * - A style's font size is the face's cell, its Windows ascent plus descent
 *   (OS/2 usWinAscent and usWinDescent), not its em. A line is a cell tall.
 * - The foot of the last line sits MarginV above the foot of the frame, and
 *   a line is centred between the side margins on its advance.
 * - A line too wide for the margins breaks at the space before the word that
 *   reaches them, then the breaks even out with the top line the wider.
 * - The word being said is scaled from its pen on the baseline, which makes
 *   its line's cell taller too.
 * - A boxed style draws a box around each glyph's cell, the outline width
 *   out on every side; the boxes join into one along a line.
 * - The shadow is the text with its outline (or its box) moved down and
 *   right, in 61% black (in the box's colour for a boxed style).
 * - Pairs of letters are not kerned: the ffmpeg builds the app runs on
 *   (6.0, 6.1 and 7.0) all set a line with each glyph's own advance.
 * - Bold on a face of one weight is drawn a 64th of the em wider and taller,
 *   growing right and up, with the advance unchanged.
 */

/** Where each caption position puts the foot of its line, as a share of the frame's height. */
export const POSITION_FRAC: Record<CaptionSpec['position'], number> = {
  top: 0.22,
  middle: 0.52,
  chest: 0.66,
  bottom: 0.84
}

/** How bright a colour is to the eye (WCAG relative luminance), from #rgb or #rrggbb. */
function lightness(hex: string): number {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6)
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** The contrast of two colours, 1 to 21. */
export function contrastOf(a: string, b: string): number {
  const [hi, lo] = [lightness(a), lightness(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * The brand's colours for a look's words, or none. A look on a plate keeps its own when the brand's text
 * would not stand out on the plate (white on a yellow highlighter): the words have to be read.
 */
function brandColorsFor(base: CaptionStyle, colors: { text: string; accent: string } | null): Partial<CaptionStyle> {
  if (!colors) return {}
  if (base.boxColor && contrastOf(colors.text, base.boxColor) < 3) return {}
  return { textColor: colors.text, activeColor: colors.accent }
}

/** The caption look for a spec, sized for the frame being rendered, in the brand's colours when there is one. */
export function captionStyleFor(
  spec: CaptionSpec,
  width: number,
  colors: { text: string; accent: string } | null = null
): CaptionStyle {
  const base = presetById(spec.preset).style
  const scale = width / 1080
  return {
    ...base,
    ...brandColorsFor(base, colors),
    wordsPerGroup: spec.wordsPerScreen,
    uppercase: spec.uppercase || base.uppercase,
    positionFrac: POSITION_FRAC[spec.position],
    fontSizePx: Math.max(8, Math.round(base.fontSizePx * scale)),
    outlinePx: Math.max(1, Math.round(base.outlinePx * scale)),
    shadowPx: Math.round(base.shadowPx * scale),
    second: base.second
      ? {
          ...base.second,
          fontSizePx: Math.max(8, Math.round(base.second.fontSizePx * scale)),
          gapPx: Math.round(base.second.gapPx * scale)
        }
      : base.second
  }
}

/**
 * The words the subtitles show: every captioned word but those said while a
 * card holds the screen (an end card, a title quoting the speech), as drawn
 * captions wait for them too. The same object when nothing is left out.
 */
export function subtitleWords(
  cut: { beats: { id: string; treatment: { captions?: boolean } }[] },
  resolved: Resolved,
  scene: Pick<MotionScene, 'items'>
): Resolved {
  // What covers the screen is the graphic's own say: a full-frame map holds the captions, a map inset does not.
  const cards = scene.items.filter((i) => i.covers === 'card')
  // Beats whose captions are off are left out too.
  const words = captionedWords(cut, resolved).words.filter(
    (w) => !cards.some((c) => w.outEnd > c.start && w.outStart < c.end)
  )
  return words.length === resolved.words.length ? resolved : { ...resolved, words }
}

/** One subtitle event: a group of words on screen while one of them is said. */
export interface SubtitleCue {
  /** Output seconds. */
  start: number
  end: number
  words: TranscriptWord[]
  /** The word being said, by its place in the group. */
  active: number
}

/**
 * The events the subtitles are made of: one per word, showing its whole
 * group with that word picked out, and held until the next word starts so the
 * line never flickers off between words.
 */
export function subtitleCues(words: TranscriptWord[], perGroup: number): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  for (const group of groupWords(words, perGroup)) {
    for (let i = 0; i < group.length; i++) {
      const word = group[i]
      const end = i === group.length - 1 ? word.endSec : group[i + 1].startSec
      cues.push({ start: word.startSec, end: Math.max(end, word.startSec + 0.05), words: group, active: i })
    }
  }
  return cues
}

/** A time as the ASS file holds it: whole hundredths of a second. */
function hundredths(sec: number): number {
  return Math.round(Math.max(0, sec) * 100)
}

/** The cue on screen at a moment of output time, as libass picks it from the file: from its start, up to its end. */
export function subtitleAt(cues: SubtitleCue[], t: number): SubtitleCue | null {
  const at = t * 100
  return cues.find((c) => at >= hundredths(c.start) && at < hundredths(c.end)) ?? null
}

/** What laying out text needs from a canvas: its font, and the advance and ink of a string in it. */
export interface TextMeasurer {
  font: string
  /** Set to 'none' where the canvas has it, as libass does not kern. */
  fontKerning?: string
  measureText(text: string): {
    width: number
    actualBoundingBoxLeft: number
    actualBoundingBoxRight: number
    actualBoundingBoxAscent: number
    actualBoundingBoxDescent: number
  }
}

/** A word, or the space after one, in one look. Frame pixels. */
export interface SubtitleRun {
  text: string
  /** Where its pen starts on the line's baseline. */
  x: number
  /** Its advance. */
  width: number
  font: string
  color: string
  /** Its cell above and below the baseline, as libass measures a line. */
  ascent: number
  descent: number
  /** How far its ink reaches from the pen: left, right, up and down. */
  ink: { left: number; right: number; up: number; down: number }
}

export interface SubtitleLine {
  baseline: number
  runs: SubtitleRun[]
}

/** The lines of one style: the caption, or the small line under a big word. */
export interface SubtitleBlock {
  lines: SubtitleLine[]
  outlineColor: string
  outlinePx: number
  shadowPx: number
  /** The plate's colour, for a boxed style. */
  box: string | null
  /** libass's bold for a face of one weight: each glyph this much wider, in pixels. */
  embolden: number
}

export interface SubtitleLayout {
  blocks: SubtitleBlock[]
  /** Everything drawn, outline, box and shadow included, in frame pixels. */
  bounds: { x: number; y: number; w: number; h: number }
}

/** The shadow's colour without a box: ASS's &H64000000, black at 155/255. */
export const SHADOW_ALPHA = 155 / 255

interface Look {
  family: string
  /** The cell, in pixels: what the style calls its font size. */
  size: number
  outlineColor: string
  outlinePx: number
  shadowPx: number
  bold: boolean
  box: string | null
}

interface Piece {
  text: string
  color: string
  scale: number
}

/**
 * Lays a cue out at the frame's size, as libass draws it from buildAss's file.
 * `measure` is any canvas context with the bundled faces loaded.
 */
export function layoutSubtitle(
  cue: SubtitleCue,
  style: CaptionStyle,
  frame: { width: number; height: number },
  measure: TextMeasurer
): SubtitleLayout {
  const marginX = Math.round(frame.width * 0.08)
  const marginV = Math.round(frame.height * (1 - style.positionFrac))
  const area = { left: marginX, width: frame.width - 2 * marginX, foot: frame.height - marginV }
  const upper = (text: string, on: boolean): string => (on ? text.toUpperCase() : text)
  const blocks: SubtitleBlock[] = []
  if (style.second) {
    // The word being said alone and big, and the rest of its group small beneath it.
    const big = cue.words[cue.active]
    blocks.push(
      block(
        [{ text: upper(big.text, style.uppercase), color: style.textColor, scale: 1 }],
        lookOf(style),
        area,
        measure
      )
    )
    const rest = cue.words.filter((_, i) => i !== cue.active).map((w) => w.text)
    if (rest.length > 0) {
      const tier = style.second
      const text = upper(rest.join(' '), tier.uppercase)
      blocks.push(
        block(
          text.split(' ').map((t) => ({ text: t, color: tier.textColor, scale: 1 })),
          {
            family: tier.fontFamily,
            size: tier.fontSizePx,
            outlineColor: tier.outlineColor,
            outlinePx: tier.outlinePx,
            shadowPx: tier.shadowPx,
            bold: tier.bold === true,
            box: null
          },
          { ...area, foot: frame.height - Math.max(0, marginV - tier.gapPx) },
          measure
        )
      )
    }
  } else {
    blocks.push(
      block(
        cue.words.map((w, i) => ({
          text: upper(w.text, style.uppercase),
          color: i === cue.active ? style.activeColor : style.textColor,
          scale: i === cue.active ? style.activeScale : 1
        })),
        lookOf(style),
        area,
        measure
      )
    )
  }
  return { blocks, bounds: boundsOf(blocks) }
}

function lookOf(style: CaptionStyle): Look {
  return {
    family: style.fontFamily,
    size: style.fontSizePx,
    outlineColor: style.boxColor ?? style.outlineColor,
    outlinePx: style.outlinePx,
    shadowPx: style.shadowPx,
    bold: style.bold === true,
    box: style.boxColor ?? null
  }
}

/** One style's words, wrapped between the margins and stacked up from the foot. */
function block(
  pieces: Piece[],
  look: Look,
  area: { left: number; width: number; foot: number },
  measure: TextMeasurer
): SubtitleBlock {
  const face = fontInfo(look.family)
  const em = look.size / (face.winAscent + face.winDescent)
  const measured = (text: string, scale: number): { width: number; ink: SubtitleRun['ink']; font: string } => {
    const font = fontString({ family: face.family, weight: 400 }, em * scale)
    measure.font = font
    if ('fontKerning' in measure) measure.fontKerning = 'none'
    const m = measure.measureText(text)
    return {
      width: m.width,
      font,
      ink: {
        left: m.actualBoundingBoxLeft,
        right: m.actualBoundingBoxRight,
        up: m.actualBoundingBoxAscent,
        down: m.actualBoundingBoxDescent
      }
    }
  }
  const space = measured(' ', 1)
  const words = pieces.map((p) => ({ ...p, ...measured(p.text, p.scale) }))
  // Where each word starts with the event on one line, which is where libass measures its breaks.
  const at: number[] = []
  let pen = 0
  for (const w of words) {
    at.push(pen)
    pen += w.width + space.width
  }
  /** From the ink of word a to the ink of word b, on one line. */
  const reach = (a: number, b: number): number => at[b] + words[b].ink.right - (at[a] - words[a].ink.left)

  // Break at the space before the word whose ink reaches the margin; a word alone on its line stays whole.
  const lines: number[][] = []
  for (let i = 0; i < words.length; i++) {
    const line = lines[lines.length - 1]
    if (line && reach(line[0], i) < area.width) line.push(i)
    else lines.push([i])
  }
  // Then even them out: the last word of a line moves down while that brings the two lines closer.
  for (let moved = true; moved; ) {
    moved = false
    for (let k = 1; k < lines.length; k++) {
      const a = lines[k - 1]
      const b = lines[k]
      if (a.length < 2) continue
      const last = a[a.length - 1]
      const before = Math.abs(reach(a[0], last) - reach(b[0], b[b.length - 1]))
      const after = Math.abs(reach(a[0], a[a.length - 2]) - reach(last, b[b.length - 1]))
      if (after < before) {
        b.unshift(a.pop() as number)
        moved = true
      }
    }
  }

  const laid = lines.map((line) => {
    const runs: SubtitleRun[] = []
    let x = 0
    line.forEach((i, j) => {
      const w = words[i]
      if (j > 0) {
        runs.push({
          text: ' ',
          x,
          width: space.width,
          font: space.font,
          color: w.color,
          ascent: em * face.winAscent,
          descent: em * face.winDescent,
          ink: space.ink
        })
        x += space.width
      }
      runs.push({
        text: w.text,
        x,
        width: w.width,
        font: w.font,
        color: w.color,
        ascent: em * face.winAscent * w.scale,
        descent: em * face.winDescent * w.scale,
        ink: w.ink
      })
      x += w.width
    })
    const shift = area.left + (area.width - x) / 2
    for (const r of runs) r.x += shift
    return {
      runs,
      ascent: Math.max(...runs.map((r) => r.ascent)),
      descent: Math.max(...runs.map((r) => r.descent))
    }
  })
  let y = area.foot - laid.reduce((h, l) => h + l.ascent + l.descent, 0)
  const out: SubtitleLine[] = laid.map((l) => {
    const baseline = y + l.ascent
    y += l.ascent + l.descent
    return { baseline, runs: l.runs }
  })
  return {
    lines: out,
    outlineColor: look.outlineColor,
    outlinePx: look.outlinePx,
    shadowPx: look.shadowPx,
    box: look.box,
    // Faces here have one weight (Sora's file opens at its regular), so bold is libass's own.
    embolden: look.bold ? em / 64 : 0
  }
}

/** A run's box as a boxed style draws it: its cell, the outline width out on every side. */
function plateOf(r: SubtitleRun, baseline: number, pad: number): { x0: number; y0: number; x1: number; y1: number } {
  return { x0: r.x - pad, y0: baseline - r.ascent - pad, x1: r.x + r.width + pad, y1: baseline + r.descent + pad }
}

/** A run's ink with its outline, grown right and up by libass's bold. */
function inkOf(r: SubtitleRun, baseline: number, b: SubtitleBlock): { x0: number; y0: number; x1: number; y1: number } {
  const o = b.outlinePx
  return {
    x0: r.x - r.ink.left - o,
    y0: baseline - r.ink.up - b.embolden - o,
    x1: r.x + r.ink.right + b.embolden + o,
    y1: baseline + r.ink.down + o
  }
}

function boundsOf(blocks: SubtitleBlock[]): SubtitleLayout['bounds'] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of blocks) {
    for (const line of b.lines) {
      for (const r of line.runs) {
        if (!b.box && !r.text.trim()) continue
        const e = b.box ? plateOf(r, line.baseline, b.outlinePx) : inkOf(r, line.baseline, b)
        x0 = Math.min(x0, e.x0)
        y0 = Math.min(y0, e.y0)
        x1 = Math.max(x1, e.x1 + b.shadowPx)
        y1 = Math.max(y1, e.y1 + b.shadowPx)
      }
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 }
}

type Ctx = CanvasRenderingContext2D
/** Makes an offscreen canvas, for drawing the shadow in one piece. */
export type MakeCanvas = (width: number, height: number) => { getContext(kind: '2d'): Ctx | null }

/**
 * Draws a laid-out cue, scaled from frame pixels to the canvas by `scale`,
 * in libass's order: every shadow, then every outline or box, then the text.
 * The shadow is drawn whole on its own canvas first and laid down once, so
 * where the text and its outline overlap it is no darker than elsewhere.
 */
export function drawSubtitle(ctx: Ctx, layout: SubtitleLayout, scale: number, makeCanvas?: MakeCanvas): void {
  ctx.save()
  prepare(ctx)
  for (const b of layout.blocks) {
    if (b.shadowPx > 0) drawShadow(ctx, b, scale, makeCanvas)
    ctx.setTransform(scale, 0, 0, scale, 0, 0)
    if (b.box) {
      ctx.fillStyle = b.box
      for (const line of b.lines) for (const r of line.runs) fillPlate(ctx, plateOf(r, line.baseline, b.outlinePx))
    } else if (b.outlinePx > 0) {
      ctx.strokeStyle = b.outlineColor
      ctx.lineWidth = 2 * b.outlinePx + b.embolden
      eachGlyphRun(b, (r, x, y) => {
        ctx.font = r.font
        ctx.strokeText(r.text, x, y)
      })
    }
    eachGlyphRun(b, (r, x, y) => {
      ctx.font = r.font
      ctx.fillStyle = r.color
      ctx.fillText(r.text, x, y)
      if (b.embolden > 0) {
        ctx.strokeStyle = r.color
        ctx.lineWidth = b.embolden
        ctx.strokeText(r.text, x, y)
      }
    })
  }
  ctx.restore()
}

/** Text drawn as libass sets it: from the pen on the baseline, with no kerning and round joins. */
function prepare(ctx: Ctx): void {
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if ('fontKerning' in ctx) ctx.fontKerning = 'none'
}

/**
 * Each run with letters in it, and where to draw it: libass's bold grows a
 * glyph right and up from its own outline, which a stroke half that width
 * either side does once the glyph is moved by half of it.
 */
function eachGlyphRun(b: SubtitleBlock, draw: (r: SubtitleRun, x: number, y: number) => void): void {
  for (const line of b.lines) {
    for (const r of line.runs) {
      if (r.text.trim()) draw(r, r.x + b.embolden / 2, line.baseline - b.embolden / 2)
    }
  }
}

function fillPlate(ctx: Ctx, p: { x0: number; y0: number; x1: number; y1: number }): void {
  ctx.fillRect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0)
}

/** Text and outline as one solid shape, for the shadow. */
function silhouette(ctx: Ctx, b: SubtitleBlock, color: string): void {
  ctx.fillStyle = color
  ctx.strokeStyle = color
  if (b.box) {
    for (const line of b.lines) for (const r of line.runs) fillPlate(ctx, plateOf(r, line.baseline, b.outlinePx))
    return
  }
  const width = 2 * b.outlinePx + b.embolden
  eachGlyphRun(b, (r, x, y) => {
    ctx.font = r.font
    ctx.fillText(r.text, x, y)
    if (width > 0) {
      ctx.lineWidth = width
      ctx.strokeText(r.text, x, y)
    }
  })
}

function drawShadow(ctx: Ctx, b: SubtitleBlock, scale: number, makeCanvas?: MakeCanvas): void {
  // A boxed style's shadow is its box again, in the box's own colour and solid.
  if (b.box) {
    ctx.setTransform(scale, 0, 0, scale, b.shadowPx * scale, b.shadowPx * scale)
    silhouette(ctx, b, b.box)
    return
  }
  const area = boundsOf([{ ...b, shadowPx: 0 }])
  const x = Math.floor(area.x * scale) - 1
  const y = Math.floor(area.y * scale) - 1
  const w = Math.ceil(area.w * scale) + 3
  const h = Math.ceil(area.h * scale) + 3
  const made = w > 0 && h > 0 ? makeCanvas?.(w, h) : undefined
  const off = made?.getContext('2d')
  if (!made || !off) {
    // Without a canvas to spare, overlaps come out a little darker.
    ctx.globalAlpha = SHADOW_ALPHA
    ctx.setTransform(scale, 0, 0, scale, b.shadowPx * scale, b.shadowPx * scale)
    silhouette(ctx, b, '#000000')
    ctx.globalAlpha = 1
    return
  }
  prepare(off)
  off.setTransform(scale, 0, 0, scale, -x, -y)
  silhouette(off, b, '#000000')
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = SHADOW_ALPHA
  ctx.drawImage(made as unknown as CanvasImageSource, x + b.shadowPx * scale, y + b.shadowPx * scale)
  ctx.globalAlpha = 1
}
