import type { Animator, Layer, Span, TextLayer } from '../types'
import { accentOf, fitSize, spokenTimes } from './kit'
import { register, type BuildContext } from './registry'
import { engravedTitle } from './engraved'

/**
 * A kinetic title: a small lead-in line typed in a word at a time, then a big
 * keyword line that lands with real motion blur, each word on the moment it
 * is said when the title quotes the speaker. Styles are the text animators
 * people reach for in After Effects: slide in behind its own edge, rise out
 * of a slot, punch down from big, resolve out of a blur, close up from wide
 * tracking, type with a cursor, and wipe on.
 */

const STYLES = ['slide', 'rise', 'punch', 'blur', 'track', 'type', 'wipe', 'engraved'] as const
type Style = (typeof STYLES)[number]

const shadow = (u: number): TextLayer['effects'] => ({
  shadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 22 * u, y: 4 * u }
})

/** The two lines a call gives: "lead-in | keyword", or the keyword alone. */
export function titleLines(text: string[]): { lead: string; keyword: string } {
  const lines = text.map((t) => t.trim()).filter(Boolean)
  if (lines.length >= 2) return { lead: lines[0], keyword: lines[1] }
  return { lead: '', keyword: lines[0] ?? '' }
}

/**
 * Each word's moment, in seconds from the layer's start: when it is said, if
 * the title quotes the speech that follows `from` (a word not found follows
 * the one before), else one after another from `first`, `gap` apart.
 */
function wordTimes(
  ctx: BuildContext,
  words: string[],
  from: number,
  first: number,
  gap: number
): { times: number[]; quoted: boolean } {
  const { start, end } = ctx.span
  const said = spokenTimes(ctx.tl, words, from).map((t) => (t !== null && t < end - 0.6 ? t - start : null))
  // Not quoted: one after another, and all in at least half a second before it goes.
  const latest = Math.max(0, end - start - 0.5)
  if (said.length === 0 || said[0] === null)
    return { times: words.map((_, i) => Math.min(latest, first + i * gap)), quoted: false }
  const times: number[] = []
  said.forEach((t, i) => {
    const before = i > 0 ? times[i - 1] : 0
    times.push(t !== null ? Math.max(t, before) : before + gap)
  })
  return { times: times.map((t) => Math.max(0, t)), quoted: true }
}

function keywordAnimators(style: Style, u: number, k: number, width: number, starts: number[]): Animator[] {
  const at = starts[0] ?? 0
  const later = starts.map((_, i) => i).slice(1)
  switch (style) {
    case 'rise':
      return [
        {
          by: 'word',
          timing: 'spoken',
          delay: -0.1,
          duration: 0.42,
          ease: 'snap',
          from: { y: k * 1.3, opacity: 0 },
          clip: true
        }
      ]
    case 'punch':
      return [
        { by: 'line', delay: at - 0.08, duration: 0.4, ease: 'snap', from: { scale: 1.9, opacity: 0, blur: 10 * u } }
      ]
    case 'blur':
      return [
        {
          by: 'word',
          timing: 'spoken',
          delay: -0.08,
          duration: 0.5,
          ease: 'ease-out',
          from: { opacity: 0, blur: 24 * u, scale: 1.08 }
        }
      ]
    case 'track':
      return [{ by: 'line', delay: at - 0.1, duration: 0.8, ease: 'smooth', from: { tracking: k * 0.22, opacity: 0 } }]
    case 'type':
      return [{ by: 'char', delay: at - 0.05, stagger: 0.035, duration: 0, ease: 'hold', from: { opacity: 0 } }]
    case 'wipe':
      return [{ by: 'line', delay: at - 0.1, stagger: 0.12, duration: 0.45, ease: 'smooth', from: { wipe: 0 } }]
    default:
      // The line slides out from behind its own left edge and settles from a touch bigger;
      // the words after the first rise into place as they are said.
      return [
        {
          by: 'line',
          delay: at - 0.12,
          duration: 0.5,
          ease: 'snap',
          from: { x: -width * 0.5, scale: 1.12 },
          clip: true
        },
        ...(later.length
          ? [
              {
                by: 'word' as const,
                timing: 'spoken' as const,
                delay: -0.08,
                duration: 0.38,
                ease: 'snap' as const,
                from: { y: k * 1.3, opacity: 0 },
                clip: true,
                spans: later
              }
            ]
          : [])
      ]
  }
}

function kinetic(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const style: Style = (STYLES as readonly string[]).includes(item.style) ? (item.style as Style) : 'slide'
  // A documentary's year or place, in engraved capitals (templates/engraved.ts).
  if (style === 'engraved') return engravedTitle(ctx)
  const { lead, keyword } = titleLines(item.text)
  if (!keyword) return []
  const vertical = frame.shape === 'vertical'
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  const cx = frame.safe.left + safeWidth / 2
  const place = item.place === 'top' || item.place === 'bottom' ? item.place : 'middle'
  // The seam between the two lines: the lead-in hangs above it, the keyword line below.
  const seam =
    place === 'top'
      ? frame.safe.top + frame.height * 0.14
      : place === 'bottom'
        ? frame.height - frame.safe.bottom - frame.height * 0.16
        : frame.height * (vertical ? 0.36 : 0.42)
  const preferred = (style === 'punch' ? (vertical ? 108 : 150) : vertical ? 100 : 140) * u
  // Small enough that the longest word fits the line: a word cannot wrap.
  const longest = keyword.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0)
  const k = fitSize(safeWidth * 0.94, longest, preferred, style === 'punch' ? 0.74 : 0.62)
  const from = span.at
  const leadWords = lead.split(/\s+/).filter(Boolean)
  const keyWords = keyword.split(/\s+/).filter(Boolean)
  const leadIn = wordTimes(ctx, leadWords, from, Math.max(0, from - start), 0.13)
  const leadAt = leadIn.times
  const leadDone = leadAt.length ? leadAt[leadAt.length - 1] + 0.15 : Math.max(0, from - start)
  // The keyword line is looked for in the speech after the lead-in's last word, when the lead-in was said.
  const keyFrom = leadIn.quoted ? start + leadAt[leadAt.length - 1] + 0.02 : from
  const keyAt = wordTimes(ctx, keyWords, keyFrom, leadDone + 0.05, style === 'punch' ? 0 : 0.12).times
  const leave: Animator = { by: 'line', out: true, duration: 0.2, ease: 'ease-in', from: { opacity: 0, blur: 10 * u } }
  const layers: Layer[] = []

  if (leadWords.length) {
    layers.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans: leadWords.map((w, i) => ({ text: w, t: leadAt[i] })),
      font: { family: theme.body, size: k * 0.38, weight: 500, lineHeight: 1.1, tracking: -0.01 * k * 0.38 },
      fill: theme.text,
      align: 'center',
      valign: 'bottom',
      maxWidth: safeWidth * 0.9,
      balance: true,
      effects: shadow(u),
      animators: [
        {
          by: 'word',
          timing: 'spoken',
          delay: -0.04,
          duration: 0.14,
          ease: 'ease-out',
          from: { opacity: 0, y: 8 * u }
        },
        leave
      ],
      transform: { x: cx, y: seam - 6 * u }
    })
  }

  const spans: Span[] = keyWords.map((w, i) => ({ text: w, t: keyAt[i] }))
  const punch = style === 'punch'
  layers.push({
    kind: 'text',
    start,
    end,
    text: '',
    spans,
    font: {
      family: punch ? theme.display : theme.body,
      size: k,
      weight: punch ? undefined : 700,
      lineHeight: 1.02,
      tracking: punch ? 0 : -0.025 * k,
      uppercase: punch
    },
    fill: item.color ? accentOf(item.color, theme) : theme.text,
    align: 'center',
    valign: 'top',
    maxWidth: safeWidth * 0.94,
    balance: true,
    effects: shadow(u),
    animators: [...keywordAnimators(style, u, k, frame.width, keyAt), leave],
    cursor:
      style === 'type' ? { color: item.color ? accentOf(item.color, theme) : theme.accent, width: 6 * u } : undefined,
    // Moves fast enough to streak: a 1/30 s shutter, ten samples a frame.
    motionBlur:
      style === 'slide' || style === 'rise' || style === 'punch' ? { shutter: 1 / 30, samples: 10 } : undefined,
    transform: { x: cx, y: seam + 6 * u }
  })
  return layers
}

register({
  kind: 'title',
  title: 'Kinetic title',
  about:
    'A title over the picture: text is a small lead-in line then the big keyword line, like ["So what is the", "FOMO & partnership?"], or the keyword line alone. The lead-in types in a word at a time and the keyword line lands with motion blur; when the words are the ones said, each lands as it is said. slide comes in behind its own edge, rise lifts each word out of a slot, punch drops in from big, blur resolves out of a blur, track closes up from wide letter spacing, type types with a cursor, wipe wipes on, engraved sets a documentary year or place in big Roman capitals that settle into the frame (text is an optional small line then the big one, like ["San Bernardino, California", "1954"]). color sets the keyword line.',
  styles: STYLES,
  places: ['middle', 'top', 'bottom'],
  length: 3.5,
  lead: 0.12,
  // Its words are the speech's: captions wait while it is up.
  covers: 'card',
  fields: [
    { slot: 'text', index: 0, label: 'Lead-in' },
    { slot: 'text', index: 1, label: 'Keyword line' }
  ],
  example: {
    call: { from: 'w3', text: ['So what is the', 'FOMO & partnership?'] },
    says: 'the question types in, then its keyword line slides in on the words'
  },
  check: (call) => {
    if (!titleLines(call.text).keyword)
      return 'A title needs its words, like /title So what is the | FOMO & partnership?'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `A title is ${STYLES.join(', ')}; ${call.style} is not one of them.`
    return null
  },
  build: kinetic,
  name: (call) => `a title saying “${titleLines(call.text).keyword}”`
})
