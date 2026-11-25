import type { Animator, Layer, Span, TextLayer } from '../types'
import { accentOf, centred, fitSize, spokenTimes, TIMING } from './kit'
import { register, type BuildContext } from './registry'
import { engravedTitle } from './engraved'
import { textWidth } from './measure'

/**
 * A kinetic title: a small lead-in line typed in a word at a time, then a big
 * keyword line that lands with real motion blur, each word on the moment it
 * is said when the title quotes the speaker. Styles are the text animators
 * people reach for in After Effects: slide in behind its own edge, rise out
 * of a slot, punch down from big, resolve out of a blur, close up from wide
 * tracking, type with a cursor, and wipe on.
 */

const STYLES = ['slide', 'rise', 'punch', 'blur', 'track', 'type', 'wipe', 'engraved', 'stair', 'behind'] as const
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

function keywordAnimators(style: Style, u: number, k: number, firstWidth: number, starts: number[]): Animator[] {
  const at = starts[0] ?? 0
  const later = starts.map((_, i) => i).slice(1)
  switch (style) {
    case 'rise':
      return [
        {
          by: 'word',
          timing: 'spoken',
          delay: -0.12,
          duration: 0.5,
          ease: 'out-cubic',
          from: { y: k * 1.3, opacity: 0 },
          clip: true
        }
      ]
    case 'punch':
      // Hard-hitting on purpose: down from nearly twice its size, blurred as it comes, over half a second.
      return [
        { by: 'line', delay: at - 0.1, duration: 0.5, ease: 'out-quart', from: { scale: 1.9, opacity: 0, blur: 10 * u } }
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
      // The line slides out from behind its own left edge, starting its first word's width back (the words after
      // it are hidden until said), so none of it shows before it moves and the first word is out at once; it
      // settles from a touch bigger on a long quart ease, as creators slide a card in, and the words after the
      // first rise into place as they are said.
      return [
        {
          by: 'line',
          delay: at - 0.18,
          duration: 0.8,
          ease: 'out-quart',
          // Room to spare: it starts a tenth bigger, and the width is estimated, not measured.
          from: { x: -(firstWidth * 1.3 + 40 * u), scale: 1.1 },
          clip: true
        },
        ...(later.length
          ? [
              {
                by: 'word' as const,
                timing: 'spoken' as const,
                delay: -0.1,
                duration: 0.45,
                ease: 'out-cubic' as const,
                from: { y: k * 1.3, opacity: 0 },
                clip: true,
                spans: later
              }
            ]
          : [])
      ]
  }
}

/**
 * The two-tier caption Deep End with Lecrae puts on its key lines (measured): a small white line, then the line
 * that matters in big bold words in red or gold, a few to a line, each line stepped further right like a
 * staircase. Every word comes in as it is said: the small ones fade up in a few frames, the big ones fade, rise
 * and settle from a touch bigger out of a blur over 14 frames. The block blurs away in four frames as it goes.
 */
function stairTitle(ctx: BuildContext, lead: string, keyword: string): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const vertical = frame.shape === 'vertical'
  const ink = item.color ? accentOf(item.color, theme) : '#D21213'
  // The big words in lines of about a dozen letters: "Jesus is / coming back.", "that have the / most churches."
  const words = keyword.split(/\s+/).filter(Boolean)
  const lines: string[][] = []
  for (const w of words) {
    const last = lines[lines.length - 1]
    if (last && [...last, w].join(' ').length <= 14) last.push(w)
    else lines.push([w])
  }
  // No little word left alone on the last line: "smarter / than me.", not "smarter than / me."
  const tail = lines[lines.length - 1]
  const above = lines[lines.length - 2]
  if (above && above.length > 1 && tail.length === 1 && tail[0].length <= 4) tail.unshift(above.pop() as string)
  // Deep End's are about 180 px in a 1080p frame; a lone short word lands bigger, "ISIS." a third of the width.
  let big = (vertical ? 140 : 180) * u
  const alone = lines.length === 1 && lines[0].join(' ').length <= 6
  if (alone) big *= Math.max(1, Math.min(2, (W * (vertical ? 0.5 : 0.4)) / textWidth(lines[0].join(' '), 'Inter ExtraBold', big)))
  // Its small line grows with it, as "and more like" over "ISIS." does.
  const small = (vertical ? 140 : 180) * u * 0.45 * (alone ? 1.4 : 1)
  const lineH = big * 0.98
  const widths = lines.map((l) => textWidth(l.join(' '), 'Inter ExtraBold', big))
  const leadW = lead ? textWidth(lead, 'Inter SemiBold', small) : 0
  // Each line steps right of the one above, an eighth of a wide frame ("happening / right now?"), never past the edge.
  const step = vertical ? 120 * u : W * 0.12
  const indents = widths.map((_, i) => i * step)
  const roomFor = (x0: number): number[] =>
    indents.map((d, i) => Math.max(i ? -0.04 * W : 0, Math.min(d, W - frame.safe.right - x0 - widths[i])))
  // On the speaker's open side when the call says which: left of a speaker sat right, right of one sat left.
  const centre = item.place === 'left' ? 0.36 : item.place === 'right' ? 0.64 : 0.51
  const spanOf = (ind: number[]): number => Math.max(leadW, ...widths.map((w, i) => w + ind[i]))
  const x0 = Math.max(frame.safe.left, Math.min(W * centre - spanOf(indents) / 2, W - frame.safe.right - Math.max(leadW, widths[0])))
  const shift = roomFor(x0)
  const top = H * (vertical ? 0.5 : alone ? 0.48 : 0.59) - (lines.length * lineH + (lead ? small * 1.2 : 0)) / 2
  const from = span.at
  const leadWords = lead.split(/\s+/).filter(Boolean)
  const leadIn = wordTimes(ctx, leadWords, from, Math.max(0, from - start), 0.13)
  const keyFrom = leadIn.quoted ? start + leadIn.times[leadIn.times.length - 1] + 0.02 : from
  const keyAt = wordTimes(ctx, words, keyFrom, (leadIn.times.at(-1) ?? 0) + 0.15, 0.14).times
  const leave: Animator = { by: 'line', out: true, duration: 0.17, ease: 'ease-in', from: { opacity: 0, blur: 14 * u } }
  const shade: TextLayer['effects'] = { shadow: { color: 'rgba(0, 0, 0, 0.5)', blur: 22 * u, y: 4 * u } }
  const layers: Layer[] = []
  if (leadWords.length)
    layers.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans: leadWords.map((w, i) => ({ text: i ? ` ${w}` : w, t: leadIn.times[i] })),
      font: { family: 'Inter SemiBold', size: small, weight: 500 },
      fill: '#FFFFFF',
      align: 'left',
      valign: 'top',
      effects: shade,
      animators: [{ by: 'word', timing: 'spoken', delay: -0.04, duration: 0.18, ease: 'out-quad', from: { opacity: 0 } }, leave],
      transform: { x: x0, y: top }
    })
  let k = 0
  lines.forEach((line, i) => {
    const spans: Span[] = line.map((w, j) => ({ text: j ? ` ${w}` : w, t: keyAt[k + j] }))
    k += line.length
    layers.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans,
      font: { family: 'Inter ExtraBold', size: big, lineHeight: 1 },
      fill: ink,
      align: 'left',
      valign: 'top',
      effects: shade,
      animators: [
        { by: 'word', timing: 'spoken', delay: -0.06, duration: 0.58, ease: 'out-cubic', from: { opacity: 0, y: 43 * u, scale: 1.06, blur: 10 * u } },
        leave
      ],
      transform: { x: x0 + shift[i], y: top + (lead ? small * 1.2 : 0) + i * lineH }
    })
  })
  return layers
}

/**
 * A title set behind the speaker, as Ali Abdaal opens a video (measured frame by frame): a line in a soft white
 * serif over a huge keyword line, both centred in the upper half and drawn under the person, so they pass behind
 * the speaker's head, with a thin white outline of the keyword line drawn over the speaker where it crosses them. Each word
 * fades up over six frames while it slides about 3% of the frame's width in from the right on a long out-quart,
 * landing just before it is said. Gone on the cut.
 */
function behindTitle(ctx: BuildContext, lead: string, keyword: string): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const vertical = frame.shape === 'vertical'
  const ink = item.color ? accentOf(item.color, ctx.theme) : '#FFFFFF'
  const fit = (text: string, most: number): number => Math.min(most, (W * 0.9) / Math.max(1, textWidth(text, 'Fraunces', 1)))
  // His, measured: the keyword line's capitals 279 px tall (397 px type) and the line over it 171 px type.
  const leadSize = lead ? fit(lead, W * (vertical ? 0.1 : 0.089)) : 0
  const keySize = fit(keyword, W * (vertical ? 0.19 : 0.207))
  // Centred on the frame, or on a point the call gives (box [x]).
  const cx = item.box.length >= 1 && item.box[0] > 0 && item.box[0] < 1 ? item.box[0] * W : W / 2
  const from = span.at
  const leadWords = lead.split(/\s+/).filter(Boolean)
  const keyWords = keyword.split(/\s+/).filter(Boolean)
  const leadIn = wordTimes(ctx, leadWords, from, Math.max(0, from - start) + TIMING.lead, 0.3)
  const keyFrom = leadIn.quoted ? start + (leadIn.times.at(-1) ?? 0) + 0.02 : from
  const keyAt = wordTimes(ctx, keyWords, keyFrom, (leadIn.times.at(-1) ?? Math.max(0, from - start)) + 0.5, 0.5).times
  const enter: Animator[] = [
    { by: 'word', timing: 'spoken', delay: -TIMING.lead, duration: 0.24, ease: 'out-quad', from: { opacity: 0 } },
    { by: 'word', timing: 'spoken', delay: -TIMING.lead, duration: 0.6, ease: 'out-quart', from: { x: W * 0.032 } },
    { by: 'line', out: true, duration: 2 / 30, ease: 'ease-in', from: { opacity: 0 } }
  ]
  // Only the keyword line is outlined over the speaker; the line over it simply passes behind their head.
  const lines: { words: string[]; times: number[]; size: number; baseline: number; outline: boolean }[] = [
    ...(leadWords.length ? [{ words: leadWords, times: leadIn.times, size: leadSize, baseline: H * (vertical ? 0.3 : 0.282), outline: false }] : []),
    { words: keyWords, times: keyAt, size: keySize, baseline: H * (vertical ? 0.42 : 0.602), outline: true }
  ]
  return lines.flatMap(({ words, times, size, baseline, outline }): Layer[] => {
    const spans: Span[] = words.map((w, j) => ({ text: j ? ` ${w}` : w, t: times[j] }))
    const base = {
      kind: 'text' as const,
      start,
      end,
      text: '',
      spans,
      font: { family: 'Fraunces', size, lineHeight: 1 },
      align: 'center' as const,
      valign: 'baseline' as const,
      animators: enter,
      transform: { x: cx, y: baseline }
    }
    return [
      { ...base, fill: ink, behind: true },
      // Its outline over the speaker, where the words pass behind them.
      ...(outline ? [{ ...base, fill: 'rgba(255, 255, 255, 0)', stroke: { color: ink, width: 3 * u, join: 'round' as const } }] : [])
    ]
  })
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
  if (style === 'stair') return stairTitle(ctx, lead, keyword)
  if (style === 'behind') return behindTitle(ctx, lead, keyword)
  const vertical = frame.shape === 'vertical'
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  const place = (['top', 'bottom', 'left', 'right'] as const).find((p) => p === item.place) ?? 'middle'
  // Beside the speaker, as Elevation and The Diary of a CEO set theirs: in the outer part of a wide frame, set
  // from its edge. Elsewhere, centred.
  const side = place === 'left' || place === 'right'
  // Centred ones on the frame's middle, where the captions centre, as wide as clears the safe area both sides.
  const middle = centred(frame)
  const column = side ? safeWidth * (vertical ? 0.9 : 0.44) : Math.min(safeWidth, middle.width)
  const cx = place === 'left' ? frame.safe.left : place === 'right' ? frame.width - frame.safe.right : middle.cx
  const align = place === 'left' ? ('left' as const) : place === 'right' ? ('right' as const) : ('center' as const)
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
  const k = fitSize(column * 0.94, longest, preferred * (side && !vertical ? 0.8 : 1), style === 'punch' ? 0.74 : 0.62)
  // Room between the lines: the lead-in's descenders clear the keyword line's capitals.
  const gap = Math.max(6 * u, k * 0.08)
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
      align,
      valign: 'bottom',
      maxWidth: column * 0.9,
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
      transform: { x: cx, y: seam - gap }
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
    align,
    valign: 'top',
    maxWidth: column * 0.94,
    balance: true,
    effects: shadow(u),
    animators: [...keywordAnimators(style, u, k, textWidth(keyWords[0] ?? keyword, theme.body, k * 1.06), keyAt), leave],
    cursor:
      style === 'type' ? { color: item.color ? accentOf(item.color, theme) : theme.accent, width: 6 * u } : undefined,
    // The punch smashes in from twice its size and streaks as it does, across a whole frame's shutter, drawn from
    // as many moments as it moves. Slides and rises stay crisp, as creators' text does (Jordan Welch's and Ali
    // Abdaal's measured: no blur on words that move); only a move faster than the export's limit is blurred.
    motionBlur: style === 'punch' ? { shutter: 1 / 30 } : undefined,
    transform: { x: cx, y: seam + gap * 0.5 }
  })
  return layers
}

register({
  kind: 'title',
  title: 'Kinetic title',
  about:
    'A title over the picture: text is a small lead-in line then the big keyword line, like ["So what is the", "FOMO & partnership?"], or the keyword line alone. The lead-in types in a word at a time and the keyword line lands; when the words are the ones said, each lands as it is said. slide comes in behind its own edge, rise lifts each word out of a slot, punch drops in from big, blur resolves out of a blur, track closes up from wide letter spacing, type types with a cursor, wipe wipes on, engraved sets a documentary year or place in big Roman capitals that settle into the frame (text is an optional small line then the big one, like ["San Bernardino, California", "1954"]); stair is the podcast cold open’s two-tier caption on a key line, a small white line over the words that matter in big red or gold steps, each word rising out of a blur as it is said, like ["I called somebody", "smarter than me."] with color #F0C116; with place left or right it sits on the speaker’s open side, and a lone short word ("ISIS.") lands twice as big. behind sets both lines in a soft white serif behind the speaker, the keyword line huge across the upper half and outlined where it passes behind them, each word sliding in from the right as it is said, as Ali Abdaal opens a video, like ["Single copy-pastable", "AI Prompt"]; box [x] moves its centre across. color sets the keyword line. place left or right sets it beside the speaker, from that edge, as sermon and podcast intros set theirs.',
  styles: STYLES,
  places: ['middle', 'top', 'bottom', 'left', 'right'],
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
  behind: (call) => call.style === 'behind',
  build: kinetic,
  name: (call) => `a title saying “${titleLines(call.text).keyword}”`
})
