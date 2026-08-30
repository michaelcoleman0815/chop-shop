import type { CaptionStyle, TranscriptWord } from '../shared/types'

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  wordsPerGroup: 4,
  fontFamily: 'Archivo Black',
  fontSizePx: 84,
  positionFrac: 0.72,
  textColor: '#F2F1EE',
  activeColor: '#FF6076',
  outlineColor: '#16151A',
  outlinePx: 8,
  shadowPx: 0,
  uppercase: true,
  activeScale: 1.08
}

/** ASS colours are &HBBGGRR, the reverse of CSS hex. */
function assColor(hex: string): string {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  return `&H00${b}${g}${r}`.toUpperCase()
}

/** ASS timestamps are H:MM:SS.cc with exactly two decimal places. */
function assTime(sec: number): string {
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

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
}

/**
 * Splits words into caption groups, breaking on sentence punctuation so a group
 * never straddles two sentences, and on long gaps so captions do not hang around
 * during silence.
 */
export function groupWords(words: TranscriptWord[], perGroup: number): TranscriptWord[][] {
  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = []

  for (let i = 0; i < words.length; i++) {
    current.push(words[i])
    const endsSentence = /[.!?]$/.test(words[i].text)
    const gapNext = words[i + 1] ? words[i + 1].startSec - words[i].endSec : 0
    if (current.length >= perGroup || endsSentence || gapNext > 0.6) {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
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
      assColor(style.outlineColor),
      '&H64000000',
      '0',
      '0',
      '0',
      '0',
      '100',
      '100',
      '0',
      '0',
      '1',
      style.outlinePx,
      style.shadowPx,
      '2',
      Math.round(width * 0.08),
      Math.round(width * 0.08),
      marginV,
      '1'
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  const active = assColor(style.activeColor)
  const scalePct = Math.round(style.activeScale * 100)
  const events: string[] = []

  for (const group of groupWords(words, style.wordsPerGroup)) {
    for (let i = 0; i < group.length; i++) {
      const word = group[i]
      // Hold the last word of a group until the next group starts so captions
      // do not flicker off between words.
      const end = i === group.length - 1 ? word.endSec : group[i + 1].startSec

      const line = group
        .map((w, j) => {
          const text = escape(style.uppercase ? w.text.toUpperCase() : w.text)
          if (j !== i) return text
          const scale =
            style.activeScale === 1 ? '' : `\\fscx${scalePct}\\fscy${scalePct}`
          return `{\\c${active}${scale}}${text}{\\r}`
        })
        .join(' ')

      events.push(
        `Dialogue: 0,${assTime(word.startSec)},${assTime(Math.max(end, word.startSec + 0.05))},Chop,,0,0,0,,${line}`
      )
    }
  }

  return [...header, ...events].join('\n') + '\n'
}
