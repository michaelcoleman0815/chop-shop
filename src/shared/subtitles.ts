import { presetById } from './caption-presets'
import { captionedWords, type Resolved } from './edit/resolve'
import type { CaptionSpec } from './edit/schema'
import { fontInfo, fontString, OPEN_SEC, type MotionScene } from './motion'
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
  // Clear of what Shorts, Reels and TikTok lay over the foot of the frame (the title, the channel, the
  // buttons), which covers the lowest fifth; the most-watched podcast clips set their captions' foot here.
  bottom: 0.78
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
    // The brand's colours; a plain look keeps every word in the text colour, rather than painting each
    // one in the accent as it is said.
    // A look that colours by voice keeps its colours: they say who is talking.
    ...(colors && !base.otherColor
      ? {
          textColor: colors.text,
          activeColor: base.plain || base.steady ? colors.text : colors.accent,
          // A look that marks the words leant on marks them in the brand's accent.
          ...(base.keyColor && !base.ownKey ? { keyColor: colors.accent } : {})
        }
      : {}),
    wordsPerGroup: spec.wordsPerScreen,
    uppercase: spec.uppercase || base.uppercase,
    positionFrac: base.positions?.[spec.position] ?? POSITION_FRAC[spec.position],
    fontSizePx: Math.max(8, Math.round(base.fontSizePx * scale)),
    // A look with no outline has none, rather than a pixel of black round thin letters; a plate keeps its padding.
    outlinePx: base.outlinePx > 0 || base.boxColor ? Math.max(1, Math.round(base.outlinePx * scale)) : 0,
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
  cut: { beats: { id: string; treatment: { captions?: boolean } }[]; captions?: CaptionSpec },
  resolved: Resolved,
  scene: {
    items: Pick<MotionScene['items'][number], 'start' | 'end' | 'covers' | 'band'>[]
    frame?: { width: number; height: number }
  }
): Resolved {
  // What covers the screen is the graphic's own say: a full-frame map holds the captions, a map inset does not.
  const cards = scene.items.filter((i) => i.covers === 'card')
  // A graphic across the picture where the subtitles sit (a keyword pop) holds them too, while it is up.
  const own = cut.captions && scene.frame ? subtitleBand(cut.captions, scene.frame) : null
  const across = own ? scene.items.filter((i) => i.band && i.band.top < own.bottom && i.band.bottom > own.top) : []
  const held = [...cards, ...across]
  // Beats whose captions are off are left out too.
  const words = captionedWords(cut, resolved).words.filter(
    (w) => !held.some((c) => w.outEnd > c.start && w.outStart < c.end)
  )
  return words.length === resolved.words.length ? resolved : { ...resolved, words }
}

/**
 * The stretch of the frame's height a caption look's lines take, in pixels: from two lines over its foot (a
 * landed line's bigger face, a second tier) to a little under it, for what keeps out of the subtitles' way.
 */
export function subtitleBand(spec: CaptionSpec, frame: { width: number; height: number }): { top: number; bottom: number } {
  const style = captionStyleFor(spec, frame.width)
  const foot = style.positionFrac * frame.height
  const second = style.second ? style.second.fontSizePx * 1.2 + style.second.gapPx : 0
  return { top: foot - style.fontSizePx * (style.keyScale ?? 1) * 2.4 - second, bottom: foot + style.fontSizePx * 0.3 }
}

/** The words a caption shows, in output time, with the ones the spec marks key (CaptionSpec.keys) marked. */
export function shownWords(
  words: { id: string; text: string; outStart: number; outEnd: number }[],
  spec: Pick<CaptionSpec, 'keys'>,
  /** Every word the edit plays, shown or not: a word followed by one not shown clears as it ends (until). */
  all: { id: string }[] = words,
  /** Where some words' captions sit instead of the look's own height, by id (captionSeams). */
  sits: Map<string, number> = new Map(),
  /** Who says each word, by id, where speakers are told apart (wordSpeakers): the rest are marked other. */
  speakers: Map<string, number> = new Map()
): TranscriptWord[] {
  const keys = new Set(spec.keys ?? [])
  const shown = new Set(words.map((w) => w.id))
  // The voice heard most among the words shown; the others are marked, for a look that sets them apart.
  const heard = new Map<number, number>()
  for (const w of words) {
    const s = speakers.get(w.id)
    if (s !== undefined) heard.set(s, (heard.get(s) ?? 0) + 1)
  }
  const main = heard.size > 1 ? [...heard.entries()].sort((a, b) => b[1] - a[1])[0][0] : null
  const at = new Map(all.map((w, i) => [w.id, i]))
  return words.map((w) => {
    const i = at.get(w.id)
    const next = i === undefined ? undefined : all[i + 1]
    return {
      text: w.text,
      startSec: w.outStart,
      endSec: w.outEnd,
      ...(keys.has(w.id) ? { key: true } : {}),
      // A card or a beat without captions may start before its first word does: the caption ends with its word.
      ...(next && !shown.has(next.id) ? { until: w.outEnd } : {}),
      ...(sits.has(w.id) ? { at: sits.get(w.id) } : {}),
      ...(main !== null && speakers.has(w.id) && speakers.get(w.id) !== main ? { other: true } : {})
    }
  })
}

/** Who says each word, by id, for the words whose speaker is known: for shownWords. */
export function wordSpeakers(words: { id: string; speaker?: number }[]): Map<string, number> {
  return new Map(words.filter((w) => w.speaker !== undefined).map((w) => [w.id, w.speaker as number]))
}

/**
 * A word's colour in a caption, outside its key colour: the active one picked out, else its voice's. A look
 * that colours by voice (otherColor) picks out no word: the colour says who is talking.
 */
export function voiceColor(w: Pick<TranscriptWord, 'other'>, active: boolean, style: CaptionStyle): string {
  if (active && style.activeColor !== style.textColor && !style.otherColor) return style.activeColor
  return w.other && style.otherColor ? style.otherColor : style.textColor
}

/**
 * Where a caption sits over a split (a cutaway above or below the speaker): on the seam, its foot just above
 * the line, as Impaulsive and The Diary of a CEO set theirs, rather than over the middle of either picture.
 */
export const SEAM_FRAC = 0.488

/** The words said over a split, by id, with where their captions sit (SEAM_FRAC): for shownWords. */
export function captionSeams(
  cut: { beats: { id: string; treatment: { frame: string; broll: unknown } }[] },
  words: { id: string; beat: string }[]
): Map<string, number> {
  const split = new Set(cut.beats.filter((b) => b.treatment.frame === 'split' && b.treatment.broll).map((b) => b.id))
  return new Map(words.filter((w) => split.has(w.beat)).map((w) => [w.id, SEAM_FRAC]))
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
/** Names that keep their capital wherever they fall: a plain caption still writes God, not god. */
const KEEPS_CAPITAL = /^(I|I'm|I'll|I've|I'd|God|God's|Jesus|Jesus'|Christ|Lord|Lord's|Holy|Spirit|Father|Bible|Amen)$/

/**
 * The words as a plain caption shows them, one at a time (the church's own clips): no punctuation hanging
 * off a word ("And," is "and"), and a capital only where the word has one, not where a sentence began.
 */
export function plainWords<T extends { text: string }>(words: T[]): T[] {
  return words.map((w, i) => {
    const bare = w.text.trim().replace(/^["'“”‘’(«\[]+/, '').replace(/[.,!?;:"“”’)»\]…—-]+$/, '')
    if (!bare) return w
    const after = i === 0 || /[.!?…]["'”’)]*$/.test(words[i - 1].text.trim())
    const text = after && /^[A-Z][a-z]/.test(bare) && !KEEPS_CAPITAL.test(bare) ? bare[0].toLowerCase() + bare.slice(1) : bare
    return { ...w, text }
  })
}

export function subtitleCues(words: TranscriptWord[], perGroup: number, plain = false, build = false): SubtitleCue[] {
  // A plain caption shows words, never a dash or a stray mark Whisper wrote at a turn.
  if (plain) words = words.filter((w) => SAYS.test(w.text))
  if (build) return buildCues(words, perGroup, plain)
  if (plain) words = plainWords(words)
  return cuesOf(groupWords(words, perGroup))
}

/** A pause between words this long or shorter keeps the caption up: the next one replaces it, with no blink. */
export const CAPTION_JOIN_SEC = 1.2

/** How long a caption stays after its last word when a longer pause follows, before the screen clears. */
export const CAPTION_HOLD_SEC = 0.6

/**
 * The cues of groups of words: one per word, each up from when it is said until the next word starts, so a
 * caption never blinks off between words, or between one group and the next. Only a real pause, longer than
 * CAPTION_JOIN_SEC, clears the screen, CAPTION_HOLD_SEC after the last word.
 */
function cuesOf(groups: TranscriptWord[][]): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  groups.forEach((group, g) => {
    const after = groups[g + 1]?.[0]
    for (let i = 0; i < group.length; i++) {
      const word = group[i]
      const next = i < group.length - 1 ? group[i + 1] : after
      const held = !next
        ? word.endSec + CAPTION_HOLD_SEC
        : next.startSec - word.endSec <= CAPTION_JOIN_SEC
          ? next.startSec
          : word.endSec + CAPTION_HOLD_SEC
      // Never on into a card or a beat without captions.
      const end = Math.min(held, Math.max(word.until ?? Infinity, word.endSec))
      cues.push({ start: word.startSec, end: Math.max(end, word.startSec + 0.05), words: group, active: i })
    }
  })
  return cues
}

/** A word with something in it to say: a letter or a digit. */
const SAYS = /[\p{L}\p{N}]/u

/** How long a built sentence stays up after its last word before a pause clears it (CAPTION_HOLD_SEC). */
export const BUILD_HOLD_SEC = 0.6

/**
 * A built caption's groups (CaptionStyle.build): a sentence, or as much of one as fits, broken where the
 * speaker breaks it: at its end, at a pause, and at a comma once the lines have some words on them. Read
 * with the punctuation still on, then shown without it when the look is plain.
 */
export function buildGroups<T extends TranscriptWord>(words: T[], perGroup: number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  const most = Math.max(1, perGroup)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    current.push(w)
    const text = w.text.trim()
    const next = words[i + 1]
    const gap = next ? next.startSec - w.endSec : 0
    const ends = /[.!?…]["'”’)\]]*$/.test(text)
    const pause = /[,;:—–-]["'”’)\]]*$/.test(text) && current.length >= Math.ceil(most * 0.6)
    if (current.length >= most || ends || pause || gap > 0.6 || !next) {
      groups.push(current)
      current = []
    }
  }
  return groups
}

/** A built caption's cues: each word from when it is said, its group whole behind it, held at the end. */
function buildCues(words: TranscriptWord[], perGroup: number, plain: boolean): SubtitleCue[] {
  const shown = plain ? plainWords(words) : words
  const at = new Map(words.map((w, i) => [w, i]))
  return cuesOf(buildGroups(words, perGroup).map((g) => g.map((w) => shown[at.get(w) as number])))
}

/**
 * A landed line's groups (CaptionStyle.keyFont): a few words at a time, except that a run of key words
 * finishes the screen it starts on, so the line it lands is whole: "He still sits down." is one screen.
 */
export function landedGroups<T extends TranscriptWord>(words: T[], perGroup: number): T[][] {
  const groups: T[][] = []
  let current: T[] = []
  const most = Math.max(1, perGroup)
  const ends = (w: T): boolean => /[.!?…]["'”’)\]]*$/.test(w.text.trim())
  // A landed line starts at most two words before its key run, never across a sentence's end or a pause,
  // and the count never breaks it from there to the run's last word.
  const leads = new Set<number>()
  const landing = new Set<number>()
  for (let s = 0; s < words.length; s++) {
    if (!words[s].key || (s > 0 && words[s - 1].key)) continue
    let lead = s
    while (lead > s - 2 && lead > 0 && !ends(words[lead - 1]) && words[lead].startSec - words[lead - 1].endSec <= 0.6) lead--
    let last = s
    while (last + 1 < words.length && words[last + 1].key) last++
    leads.add(lead)
    for (let k = lead; k <= last; k++) landing.add(k)
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (leads.has(i) && current.length > 0) {
      groups.push(current)
      current = []
    }
    current.push(w)
    const next = words[i + 1]
    const gap = next ? next.startSec - w.endSec : 0
    const landed = !!w.key && !next?.key
    const full = current.length >= most && !landing.has(i)
    if (ends(w) || gap > 0.6 || landed || full || current.length >= most + 3 || !next) {
      groups.push(current)
      current = []
    }
  }
  return groups
}

/**
 * Groups as a bare look shows them: each group grouped by its punctuation first, then its last word's comma,
 * full stop, colon or semicolon taken off, and a comma inside it too. A question or exclamation mark stays.
 */
export function bareGroups(groups: TranscriptWord[][]): TranscriptWord[][] {
  const bare = (text: string, last: boolean): string => {
    const t = text.replace(last ? /[.,;:…]+(["'”’)]*)$/ : /,+(["'”’)]*)$/, '$1')
    return t || text
  }
  return groups.map((g) => g.map((w, i) => ({ ...w, text: bare(w.text, i === g.length - 1) })))
}

/** Whether a cue is set as a landed line: big, in the key face, its key words on their own line. */
export function landsLine(cue: SubtitleCue, style: Pick<CaptionStyle, 'keyFont'>): boolean {
  return !!style.keyFont && cue.words.some((w) => w.key)
}

/** The cues of a caption look, as the export burns them and the preview draws them. */
export function styleCues(
  words: TranscriptWord[],
  style: Pick<CaptionStyle, 'wordsPerGroup' | 'plain' | 'build' | 'keyFont' | 'lowercase' | 'bare'>
): SubtitleCue[] {
  // Words only: never a dash or a stray mark Whisper wrote at a turn, whatever the look.
  const spoken = words.filter((w) => SAYS.test(w.text))
  const said = style.lowercase ? spoken.map((w) => ({ ...w, text: w.text.toLowerCase() })) : spoken
  const cues =
    style.bare && !style.keyFont && !style.plain && !style.build
      ? cuesOf(bareGroups(groupWords(said, style.wordsPerGroup)))
      : !style.keyFont
        ? subtitleCues(said, style.wordsPerGroup, style.plain === true, style.build === true)
        : cuesOf(landedGroups(style.plain ? plainWords(said) : said, style.wordsPerGroup))
  // Up from the first frame when the first word is said that soon (OPEN_SEC).
  const first = cues[0]
  if (first && first.start > 0 && first.start <= OPEN_SEC) cues[0] = { ...first, start: 0 }
  return cues
}

/** The size a landed line is set at: the key face at its scale, smaller where its longest word would not fit. */
export function landedFontPx(words: string[], style: CaptionStyle, frameWidth: number): number {
  const big = Math.round(style.fontSizePx * (style.keyScale ?? 1.8))
  return fitFontPx(words, { ...style, fontSizePx: big, activeScale: 1 }, frameWidth)
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
  /** A word of a built caption not said yet: it keeps its place on the line and draws nothing. */
  hidden?: boolean
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
  italic: boolean
  box: string | null
}

interface Piece {
  text: string
  color: string
  scale: number
  /** Set in another face at its own size, as a key word in the editorial look (CaptionStyle.keyFace). */
  face?: { family: string; size: number }
  hidden?: boolean
  /** Starts a line of its own, as \N does in the export. */
  breakBefore?: boolean
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
  const marginX = captionMarginX(style, frame.width)
  // A word set to sit elsewhere (on a split's seam) moves its caption there, as the export moves it.
  const marginV = Math.round(frame.height * (1 - (cue.words[cue.active]?.at ?? style.positionFrac)))
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
            italic: false,
            box: null
          },
          { ...area, foot: frame.height - Math.max(0, marginV - tier.gapPx) },
          measure
        )
      )
    }
  } else if (landsLine(cue, style)) {
    // The line landed: the key face, big, the key words in the key colour from the first of them on a line of their own.
    const first = cue.words.findIndex((w) => w.key)
    blocks.push(
      block(
        cue.words.map((w, i) => ({
          text: upper(w.text, style.uppercase),
          color: w.key && style.keyColor ? style.keyColor : voiceColor(w, false, style),
          scale: 1,
          ...(i === first && i > 0 ? { breakBefore: true } : {})
        })),
        {
          ...lookOf(
            style,
            landedFontPx(
              cue.words.map((w) => w.text),
              style,
              frame.width
            )
          ),
          family: style.keyFont as string
        },
        area,
        measure
      )
    )
  } else {
    const size = fitFontPx(
      cue.words.map((w) => w.text),
      style,
      frame.width
    )
    blocks.push(
      block(
        cue.words.map((w, i) => ({
          text: upper(w.text, style.uppercase),
          color: w.key && style.keyColor ? style.keyColor : voiceColor(w, i === cue.active, style),
          scale: i === cue.active && !(w.key && style.keyFace) ? style.activeScale : 1,
          // A key word in the editorial look: its own face, bigger, where it is said (keyFace).
          ...(w.key && style.keyFace ? { face: { family: style.keyFace, size: keyFacePx(style, size) } } : {}),
          // A built caption shows the words said so far, the rest keeping their places.
          ...(style.build && i > cue.active ? { hidden: true } : {})
        })),
        lookOf(style, size),
        area,
        measure
      )
    )
  }
  return { blocks, bounds: boundsOf(blocks) }
}

/**
 * The size a cue's words are set at: the style's, or smaller when its longest word would run past the
 * margins (8% each side). Estimated from the face's average letter width (letterEm), the same way here
 * and in the export (main/captions), so the preview and the file agree.
 */
export function fitFontPx(words: string[], style: CaptionStyle, frameWidth: number): number {
  if (!style.letterEm) return style.fontSizePx
  const longest = words.reduce((m, w) => Math.max(m, [...(style.uppercase ? w.toUpperCase() : w)].length), 0)
  const room = frameWidth - 2 * captionMarginX(style, frameWidth)
  const wide = longest * style.letterEm * style.fontSizePx * Math.max(1, style.activeScale) * (style.uppercase ? 1.2 : 1)
  return wide > room ? Math.max(8, Math.floor((style.fontSizePx * room) / wide)) : style.fontSizePx
}

/** The margin each side of a caption's lines, in pixels: 8% of the frame, or what its column leaves (wrapFrac). */
export function captionMarginX(style: Pick<CaptionStyle, 'wrapFrac'>, frameWidth: number): number {
  return Math.round(frameWidth * (style.wrapFrac ? (1 - style.wrapFrac) / 2 : 0.08))
}

/** The size a key word is set at in its own face (keyFace), from the size the rest of its line is set at. */
export function keyFacePx(style: Pick<CaptionStyle, 'keyScale'>, size: number): number {
  return Math.round(size * (style.keyScale ?? 1.5))
}

function lookOf(style: CaptionStyle, size = style.fontSizePx): Look {
  return {
    family: style.fontFamily,
    size,
    outlineColor: style.boxColor ?? style.outlineColor,
    outlinePx: style.outlinePx,
    shadowPx: style.shadowPx,
    bold: style.bold === true,
    italic: style.italic === true,
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
  /** A piece's face and em: the block's, or its own (a key word in the editorial look). */
  const faceOf = (p?: Piece['face']): { face: typeof face; em: number } => {
    if (!p) return { face, em }
    const own = fontInfo(p.family)
    return { face: own, em: p.size / (own.winAscent + own.winDescent) }
  }
  const measured = (
    text: string,
    scale: number,
    own?: Piece['face']
  ): { width: number; ink: SubtitleRun['ink']; font: string } => {
    const set = faceOf(own)
    // Slanted as libass slants it: the face's own italic where it has one, else drawn from it.
    const font = `${look.italic ? 'italic ' : ''}${fontString({ family: set.face.family, weight: 400 }, set.em * scale)}`
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
  const words = pieces.map((p) => ({ ...p, ...measured(p.text, p.scale, p.face) }))
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
    if (line && !words[i].breakBefore && reach(line[0], i) < area.width) line.push(i)
    else lines.push([i])
  }
  // Then even them out: the last word of a line moves down while that brings the two lines closer. A line
  // a hard break began keeps its first word, as libass evens only the breaks it made itself.
  for (let moved = true; moved; ) {
    moved = false
    for (let k = 1; k < lines.length; k++) {
      const a = lines[k - 1]
      const b = lines[k]
      if (a.length < 2 || words[b[0]].breakBefore) continue
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
          ink: space.ink,
          ...(w.hidden ? { hidden: true } : {})
        })
        x += space.width
      }
      const set = faceOf(w.face)
      runs.push({
        text: w.text,
        x,
        width: w.width,
        font: w.font,
        color: w.color,
        ascent: set.em * set.face.winAscent * w.scale,
        descent: set.em * set.face.winDescent * w.scale,
        ink: w.ink,
        ...(w.hidden ? { hidden: true } : {})
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
        if (r.hidden || (!b.box && !r.text.trim())) continue
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
      for (const line of b.lines) for (const r of line.runs) if (!r.hidden) fillPlate(ctx, plateOf(r, line.baseline, b.outlinePx))
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
      if (r.text.trim() && !r.hidden) draw(r, r.x + b.embolden / 2, line.baseline - b.embolden / 2)
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
    for (const line of b.lines) for (const r of line.runs) if (!r.hidden) fillPlate(ctx, plateOf(r, line.baseline, b.outlinePx))
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
