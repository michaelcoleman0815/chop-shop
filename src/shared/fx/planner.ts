import { z } from 'zod'
import type { Cut } from '../edit/schema'
import type { Resolved } from '../edit/resolve'
import type { Word } from '../edit/schema'
import { spanFor, timelineFor } from '../motion/timing'
import { effectsOf } from './apply'
import { FX_EXTRAS, FX_INFO, FX_KINDS, FX_TARGETS, type FxChange } from './schema'

/**
 * Scene effects as the planner reads and writes them: the ops with every
 * slot required (the structured output spends nothing on optional ones), how
 * they become the edit's own ops, the guide in its system prompt, and the
 * lines that tell it which effects a cut has. Plain words reach the effects
 * through here, and so does every command, which the planner may also be
 * asked to carry out.
 */

// Made fresh for each op: shared schema objects come out as $refs in the JSON schema.
const slots = () => ({
  from: z.string(),
  to: z.string(),
  at: z.array(z.number()),
  style: z.string(),
  color: z.string(),
  strength: z.number(),
  extra: z.array(z.string())
})

export const FX_PLANNER_OPS = [
  z.object({ op: z.literal('fx-add'), kind: z.enum(FX_KINDS), on: z.enum(FX_TARGETS), ...slots() }),
  z.object({ op: z.literal('fx-update'), id: z.string(), on: z.enum(['', ...FX_TARGETS]), ...slots() }),
  z.object({ op: z.literal('fx-remove'), ids: z.array(z.string()) })
] as const

type PlannerFx = z.infer<(typeof FX_PLANNER_OPS)[number]>

/** Extras the effects know; anything else the planner writes is dropped rather than refused. */
const known = (extra: string[]): string[] => extra.filter((e) => (FX_EXTRAS as readonly string[]).includes(e))

/** An effect op as the planner writes it, as the edit takes it: '', [] and 0 are the usual, or no change. */
export function fromFxPlannerOp(op: PlannerFx): unknown {
  switch (op.op) {
    case 'fx-add':
      return {
        op: op.op,
        kind: op.kind,
        from: op.from,
        ...(op.to ? { to: op.to } : {}),
        on: op.on,
        ...(op.at.length === 2 ? { at: op.at } : {}),
        style: op.style,
        color: op.color,
        ...(op.strength > 0 ? { strength: op.strength } : {}),
        extra: known(op.extra)
      }
    case 'fx-update': {
      const change: FxChange = {
        ...(op.from ? { from: op.from } : {}),
        ...(op.to ? { to: op.to } : {}),
        ...(op.on ? { on: op.on } : {}),
        ...(op.at.length === 2 ? { at: op.at } : {}),
        ...(op.style ? { style: op.style } : {}),
        ...(op.color ? { color: op.color } : {}),
        ...(op.strength > 0 ? { strength: op.strength } : {}),
        ...(op.extra.includes('none') ? { extra: [] } : op.extra.length ? { extra: known(op.extra) } : {})
      }
      return { op: op.op, id: op.id, ...change }
    }
    case 'fx-remove':
      return op
  }
}

const example = (kind: (typeof FX_KINDS)[number], from: string, fill: Record<string, unknown> = {}): string =>
  JSON.stringify({
    op: 'fx-add',
    kind,
    from,
    to: '',
    on: 'auto',
    at: [],
    style: '',
    color: '',
    strength: 0,
    extra: [],
    ...fill
  })

/** The effects' part of the planner's system prompt. */
export function fxGuide(): string {
  return `## Scene effects
Effects on the picture itself, under the captions and graphics, for fast gaming and commentary edits. Each starts on a word ("from") and runs its own length unless "to" ends it. Add them only when asked, or when the request names the moment ("when he lands"); never one on every beat.
- ${example('scan', 'w12')}: ${FX_INFO.scan.about}
- ${example('impact', 'w40', { extra: ['second-ring'] })}: ${FX_INFO.impact.about}
- ${example('speedlines', 'w38')}: ${FX_INFO.speedlines.about}
- ${example('bgblur', 'w30', { to: 'w36' })}: ${FX_INFO.bgblur.about}
- {"op":"fx-update","id":"x1","from":"","to":"","on":"","at":[],"style":"down","color":"","strength":0,"extra":[]}: changes an effect, by its id in <effects>; "", [] and 0 leave a setting as it is; "extra":["none"] takes its extras away.
- {"op":"fx-remove","ids":["x1"]}: takes effects away.
"on" is what an effect works on: objects (each thing in the frame, cut out and brought in one by one), subject (the person, cut out), frame (the whole picture), or auto, its own choice. Cut-outs are made on a Mac; without them an effect on the objects or the person does its version on the whole frame or a region, and the reply says so in one sentence.
"strength" goes from 0.25 to 2; 0 is the usual. "at" is a point as fractions of the frame, [x, y], or [] for the usual place.
"extra": second-ring, streaks, flash and no-shake for an impact; from-black, flash-objects, fine and chunky for a scan; dense and sparse for speed lines.
Plain words: "pixel scan", "pixelate in", "make the items pop in", "scan them in one by one" is a scan on objects; "scan me in" a scan on the subject; "speed lines", "anime lines" are speed lines; "shockwave", "impact", "when he lands", "on the hit" an impact on that word, and a landing is style ground; "blur the background behind me", "blur behind me while I fly in" a background blur on the subject over that stretch. "3D chrome text", "a chrome counter", "chrome 1,000,000 that counts up" is a keyword graphic with style chrome (or gold), not an effect.`
}

/** The effects a cut has, one line each, for the request. */
export function fxLines(cut: Cut, resolved: Resolved, words: Word[]): string[] {
  const items = effectsOf(cut)
  if (items.length === 0) return []
  const tl = timelineFor(cut, resolved, words)
  const clock = (sec: number): string => {
    const s = Math.max(0, Math.round(sec))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  return items.map((x) => {
    const info = FX_INFO[x.kind]
    const span = spanFor(tl, x.from, x.to, info.length, info.lead)
    const when = span ? `${clock(span.start)}-${clock(span.end)}` : 'not in the cut'
    const slots = [
      x.on !== 'auto' ? `on ${x.on}` : null,
      x.at.length === 2 ? `at ${x.at.map((v) => v.toFixed(2)).join(' ')}` : null,
      x.style ? `style ${x.style}` : null,
      x.color ? `color ${x.color}` : null,
      x.strength > 0 ? `strength ${x.strength}` : null,
      x.extra.length ? `extra ${x.extra.join(' ')}` : null
    ].filter(Boolean)
    return `${x.id} ${x.kind} [${when}] from ${x.from}${x.to ? ` to ${x.to}` : ''}${slots.length ? ` | ${slots.join(' | ')}` : ''}`
  })
}
