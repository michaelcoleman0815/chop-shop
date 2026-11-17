import type { CaptionStyle, TranscriptWord } from '../shared/types'
import { CAPTION_PRESETS } from '../shared/caption-presets'
import { subtitleCues } from '../shared/subtitles'

export const DEFAULT_CAPTION_STYLE: CaptionStyle = CAPTION_PRESETS[0].style

/** ASS colours are &HBBGGRR, the reverse of CSS hex. */
export function assColor(hex: string): string {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

/**
 * The colour to give ffmpeg 6.0 and 6.1's subtitle filter for a caption to
 * come out as `hex` on a BT.709 picture. Those builds turn a caption's colour
 * into YUV with BT.601 whatever the picture is (7.0 follows the picture), so
 * this is the colour whose BT.601 values are `hex`'s BT.709 ones. Greys are
 * the same in both. Null when no colour has them, as for pure red: BT.709's
 * red is redder than any colour BT.601 can name.
 */
export function bt601Equivalent(hex: string): string | null {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
  // BT.709's luma and colour differences for the colour...
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const pb = (b - y) / 1.8556
  const pr = (r - y) / 1.5748
  // ...read back as BT.601's.
  const r601 = y + 1.402 * pr
  const b601 = y + 1.772 * pb
  const g601 = (y - 0.299 * r601 - 0.114 * b601) / 0.587
  const out = [r601, g601, b601].map((v) => v * 255)
  // A level and a half over the edge rounds into it; further is another colour.
  if (out.some((v) => v < -1.5 || v > 256.5)) return null
  const byte = (v: number): string => `0${Math.round(Math.min(255, Math.max(0, v))).toString(16)}`.slice(-2)
  return `#${out.map(byte).join('')}`
}

/** A caption look with every colour moved for BT.601's subtitle filter (bt601Equivalent), or null when one cannot be. */
export function bt601Style(style: CaptionStyle): CaptionStyle | null {
  const text = bt601Equivalent(style.textColor)
  const active = bt601Equivalent(style.activeColor)
  const outline = bt601Equivalent(style.outlineColor)
  const box = style.boxColor ? bt601Equivalent(style.boxColor) : null
  const tier = style.second
  const tierText = tier ? bt601Equivalent(tier.textColor) : null
  const tierOutline = tier ? bt601Equivalent(tier.outlineColor) : null
  if (!text || !active || !outline) return null
  if (style.boxColor && !box) return null
  if (tier && (!tierText || !tierOutline)) return null
  return {
    ...style,
    textColor: text,
    activeColor: active,
    outlineColor: outline,
    boxColor: style.boxColor ? box : style.boxColor,
    second: tier && tierText && tierOutline ? { ...tier, textColor: tierText, outlineColor: tierOutline } : tier
  }
}

/** ASS timestamps are H:MM:SS.cc with exactly two decimal places. */
export function assTime(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = s % 60
  const whole = Math.floor(rest)
  const cs = Math.round((rest - whole) * 100)
  // Rounding can carry past 99 centiseconds; let the seconds absorb it.
  const carry = cs === 100 ? 1 : 0
  const cc = cs === 100 ? 0 : cs
  return `${h}:${String(m).padStart(2, '0')}:${String(whole + carry).padStart(2, '0')}.${String(cc).padStart(2, '0')}`
}

/**
 * Text as ASS shows it, never as its codes. Braces are escaped. A backslash
 * has no escape in ASS: libass reads the character after it as a code, so a
 * caption word "\N" broke the line even with its backslash doubled. A word
 * joiner after each backslash draws nothing and keeps "\N" two characters.
 */
export function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\u2060').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}

/**
 * Builds a burnable ASS subtitle track with word-level highlighting.
 *
 * Rather than karaoke (\k) tags, which can only swap two preset colours, each
 * word gets its own dialogue event showing the whole group with that word
 * emphasised. That costs a few more lines and buys full control over colour and
 * scale per word.
 */
export function buildAss(
  words: TranscriptWord[],
  width: number,
  height: number,
  style: CaptionStyle = DEFAULT_CAPTION_STYLE
): string {
  const marginV = Math.round(height * (1 - style.positionFrac))

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Chop',
      style.fontFamily,
      style.fontSizePx,
      assColor(style.textColor),
      assColor(style.activeColor),
      // With BorderStyle 3 libass fills the plate from the OUTLINE colour, not
      // the back colour, so a boxed style has to put its fill here or it draws
      // a black box whatever colour was asked for.
      assColor(style.boxColor ?? style.outlineColor),
      style.boxColor ? assColor(style.boxColor) : '&H64000000',
      style.bold ? '-1' : '0',
      '0',
      '0',
      '0',
      '100',
      '100',
      '0',
      '0',
      style.boxColor ? '3' : '1',
      style.outlinePx,
      style.shadowPx,
      '2',
      Math.round(width * 0.08),
      Math.round(width * 0.08),
      marginV,
      '1'
    ].join(','),
    ...(style.second
      ? [
          [
            'Style: Chop2',
            style.second.fontFamily,
            style.second.fontSizePx,
            assColor(style.second.textColor),
            assColor(style.second.textColor),
            assColor(style.second.outlineColor),
            '&H64000000',
            style.second.bold ? '-1' : '0',
            '0',
            '0',
            '0',
            '100',
            '100',
            '0',
            '0',
            '1',
            style.second.outlinePx,
            style.second.shadowPx,
            '2',
            Math.round(width * 0.08),
            Math.round(width * 0.08),
            Math.max(0, marginV - style.second.gapPx),
            '1'
          ].join(',')
        ]
      : []),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const active = assColor(style.activeColor)
  const scalePct = Math.round(style.activeScale * 100)
  const events: string[] = []

  // One event per word (shared/subtitles, which the editor's preview draws from too).
  for (const cue of subtitleCues(words, style.wordsPerGroup)) {
    const word = cue.words[cue.active]
    const from = assTime(cue.start)
    const until = assTime(cue.end)

    if (style.second) {
      const big = escapeAss(style.uppercase ? word.text.toUpperCase() : word.text)
      const restWords = cue.words.filter((_, j) => j !== cue.active).map((w) => w.text)
      const rest = escapeAss(style.second.uppercase ? restWords.join(' ').toUpperCase() : restWords.join(' '))
      events.push(`Dialogue: 0,${from},${until},Chop,,0,0,0,,${big}`)
      if (rest) events.push(`Dialogue: 0,${from},${until},Chop2,,0,0,0,,${rest}`)
      continue
    }

    const line = cue.words
      .map((w, j) => {
        const text = escapeAss(style.uppercase ? w.text.toUpperCase() : w.text)
        if (j !== cue.active) return text
        const scale = style.activeScale === 1 ? '' : `\\fscx${scalePct}\\fscy${scalePct}`
        return `{\\c${active}${scale}}${text}{\\r}`
      })
      .join(' ')

    events.push(`Dialogue: 0,${from},${until},Chop,,0,0,0,,${line}`)
  }

  return [...header, ...events].join('\n') + '\n'
}
