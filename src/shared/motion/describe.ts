import type { Resolved } from '../edit/resolve'
import type { Cut, Word } from '../edit/schema'
import { MotionCallSchema, type MotionCall, type MotionItem } from './schema'
import { template, templates } from './templates'
import { spanFor, timelineFor } from './timing'

/**
 * Graphics in words: what a version added, changed or took away, what one
 * graphic is, and the planner's instructions for making them, written from
 * the templates themselves so there is one description of each.
 */

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number, one: string, many: string): string => `${NUMBER_WORDS[n] ?? n} ${n === 1 ? one : many}`

/** "a lower third for Sam Lee". */
export function graphicName(call: MotionCall | MotionItem): string {
  return template(call.kind)?.name(call) ?? 'a graphic'
}

/** The same, starting with a capital: "A lower third for Sam Lee". */
export function graphicTitle(call: MotionCall | MotionItem): string {
  const name = graphicName(call)
  return name.charAt(0).toUpperCase() + name.slice(1)
}

interface OpLike {
  op: string
}

/** Clauses for describePlan: "a lower third for Sam Lee comes in", "one graphic is gone". */
export function motionPhrases(ops: OpLike[]): string[] {
  const said: string[] = []
  const added = ops.filter((o) => o.op === 'motion-add')
  if (added.length > 0 && added.length <= 3) {
    for (const o of added) {
      const call = MotionCallSchema.safeParse(withoutOp(o))
      said.push(`${call.success ? graphicName(call.data) : 'a graphic'} comes in`)
    }
  } else if (added.length > 3) said.push(`${count(added.length, 'graphic', 'graphics')} come in`)
  const changed = ops.filter((o) => o.op === 'motion-update').length
  if (changed > 0) said.push(`${count(changed, 'graphic', 'graphics')} ${changed === 1 ? 'changes' : 'change'}`)
  const removed = ops.reduce(
    (n, o) => n + (o.op === 'motion-remove' ? ((o as { ids?: string[] }).ids?.length ?? 0) : 0),
    0
  )
  if (removed > 0) said.push(`${count(removed, 'graphic', 'graphics')} ${removed === 1 ? 'is' : 'are'} gone`)
  return said
}

function withoutOp(o: OpLike): Record<string, unknown> {
  const { op: _op, ...rest } = o as OpLike & Record<string, unknown>
  return rest
}

// ---------- For the planner ----------

const LISTS = new Set(['text', 'items', 'values', 'box', 'fx'])
const SLOTS = ['from', 'to', 'text', 'items', 'values', 'box', 'icon', 'style', 'place', 'color', 'fx'] as const

/** A call with every slot written out: the shape the planner answers in. */
export function fullCall(call: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const slot of SLOTS) out[slot] = call[slot] !== undefined ? call[slot] : LISTS.has(slot) ? [] : ''
  return out
}

/**
 * A busy edit, in the pattern of fast tech and finance shorts: a graphic every
 * few seconds, each landing on the word it is about, the full-frame ones
 * taking turns with the speaker, and drawn captions carrying the rest. The
 * planner's instructions show it, and a test applies it to this script.
 */
export const BUSY_EXAMPLE = {
  said:
    'Most apps make buying crypto feel like filing taxes. This one does it in one tap. ' +
    'Pick Bitcoin, Ethereum or Solana and it lands in under a second. No hidden fees and no waiting. ' +
    'Here is my profile after one week. On the phone it looks like this. Hold it as long as you want.',
  /** The profile, captured from a link, is the edit's first picture. */
  ops: [
    { op: 'captions', set: { on: true, preset: 'hierarchy' } },
    {
      op: 'motion-add',
      kind: 'title',
      from: 'w1',
      to: 'w9.end+0.5',
      text: ['Most apps make it feel like', 'filing taxes']
    },
    {
      op: 'motion-add',
      kind: 'logo',
      from: 'w18',
      style: 'coin',
      items: [
        { label: 'Bitcoin', at: 'w18' },
        { label: 'Ethereum', at: 'w19' },
        { label: 'Solana', at: 'w21' }
      ]
    },
    { op: 'motion-add', kind: 'market', from: 'w24', to: '2.6s', style: 'up', text: ['in under a second'] },
    { op: 'motion-add', kind: 'screenshot', from: 'w35', to: 'w39.end', text: ['a1'], style: 'rise' },
    {
      op: 'motion-add',
      kind: 'device',
      from: 'w44',
      to: '3s',
      text: ['a1'],
      items: [{ label: 'Bitcoin' }, { label: 'Ethereum' }, { label: 'Solana' }]
    }
  ] as Record<string, unknown>[]
}

/** The busy example as the planner reads it: the words each graphic lands on, and its call. */
function busyGuide(): string[] {
  const words = BUSY_EXAMPLE.said.split(/\s+/)
  const said = (ref: string): string => {
    const n = /^w(\d+)$/.exec(ref)
    return n ? `"${words[Number(n[1]) - 1]?.replace(/[.,]$/, '')}"` : ref
  }
  return [
    '## Busy edits',
    'When the request asks for a busy, graphic-heavy edit (a fast tech or finance short, "lots of motion graphics"), place a graphic every 2 to 5 seconds, each starting on the word it is about. The full-frame ones (title, market, screenshot, device) take turns with the speaker: never two at once, and at least a second of the speaker between them. Drawn captions carry the words in between, and logo pops land on each brand as it is named. Keep each short: 2 to 4 seconds.',
    `For example, a clip that says "${BUSY_EXAMPLE.said}", with the profile captured as a1, becomes these ops (every slot written out as usual):`,
    ...BUSY_EXAMPLE.ops.map((o) => {
      const from = typeof o.from === 'string' ? ` (on ${said(o.from)})` : ''
      return `- ${JSON.stringify(o)}${from}`
    })
  ]
}

/** The planner's instructions for graphics. Empty while no template is built. */
export function graphicsGuide(): string {
  const list = templates().filter((t) => t.kind !== 'layers')
  if (list.length === 0) return ''
  const op = (head: Record<string, unknown>, call: Record<string, unknown>): string =>
    JSON.stringify({ ...head, ...fullCall(call) })
  return [
    '## Graphics',
    'Graphics are drawn over the picture, in the brand’s colours and fonts. Each one is a call to a template. Write every slot; an empty slot takes the template’s own default.',
    ...list.map((t) => `- ${op({ op: 'motion-add', kind: t.kind }, t.example.call)}: ${t.example.says}.`),
    `- ${op({ op: 'motion-update', id: 'm1' }, { place: 'right' })}: move graphic m1. Empty slots and lists keep what is there; "none" clears an icon, a style, a place, a colour or an end.`,
    '- {"op":"motion-remove","ids":["m1"]}: take graphics out.',
    'from and to put a graphic on the edit: a word id (w12) is the moment the word is said, "w12.end" when it finishes; a beat id (b3) is when that beat starts, "b3.end" when it ends; "start" and "end" are the cut’s first and last frame. Any of them can take an offset in seconds, like "w12-0.5" or "end-2". to can also be a length like "4s", or empty for the template’s own length.',
    'The slots: text is the template’s lines; items are rows {"label","value","note","mark","at"}, where at is an anchor for when the row shows, or empty; values are numbers; box is a region of the frame as fractions [x, y, width, height], or a point [x, y]; icon is a Lucide icon name; style and place pick the template’s variants; color is #RRGGBB, empty for the brand’s accent; fx adds effects: shadow, glow, outline, gradient, plate, blur.',
    'The templates:',
    ...list.map((t) => {
      const styles = t.styles.filter(Boolean)
      const places = t.places.filter(Boolean)
      return `- ${t.kind}: ${t.about} Styles: ${styles.join(', ')}, the first by default.${places.length ? ` Places: ${places.join(', ')}.` : ''}`
    }),
    'Put a graphic on the word it is about, so it lands as the word is said. Keep its text short, about six words a line. Leave color empty unless the request names one. You cannot see the picture, so never guess where something is in the frame: leave box empty, and say in the reply that the person can drag it into place.',
    ...(template('market') && template('screenshot') && template('device') ? busyGuide() : [])
  ].join('\n')
}

/** The cut's graphics, one line each, for the planner's view of the cut. */
export function graphicsLines(cut: Cut, resolved: Resolved, words: Word[]): string[] {
  const tl = timelineFor(cut, resolved, words)
  const clock = (sec: number): string => {
    const s = Math.max(0, Math.round(sec))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  return (cut.motion ?? []).map((m) => {
    const tpl = template(m.kind)
    const span = tpl ? spanFor(tl, m.from, m.to, tpl.length, tpl.lead) : null
    const when = span ? `${clock(span.start)}-${clock(span.end)}` : 'not in the cut'
    const rows = m.items.map((r) => [r.label, r.value, r.note, r.mark].filter(Boolean).join(' / '))
    const slots = [
      m.text.length ? `text ${m.text.map((t) => JSON.stringify(t)).join(' ')}` : null,
      rows.length ? `items ${rows.map((r) => JSON.stringify(r)).join(' ')}` : null,
      m.values.length ? `values ${m.values.join(' ')}` : null,
      m.box.length ? `box ${m.box.join(' ')}` : null,
      m.icon ? `icon ${m.icon}` : null,
      m.style ? `style ${m.style}` : null,
      m.place ? `place ${m.place}` : null,
      m.color ? `color ${m.color}` : null,
      m.fx.length ? `fx ${m.fx.join(' ')}` : null
    ].filter(Boolean)
    return `${m.id} ${m.kind} [${when}] from ${m.from}${m.to ? ` to ${m.to}` : ''}${slots.length ? ` | ${slots.join(' | ')}` : ''}`
  })
}
