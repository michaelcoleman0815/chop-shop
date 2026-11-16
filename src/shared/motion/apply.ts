import type { Cut } from '../edit/schema'
import {
  MotionCallSchema,
  parseAnchor,
  parseLength,
  type MotionCall,
  type MotionChange,
  type MotionItem
} from './schema'
import { template } from './templates'

/**
 * The motion ops, applied to a cut. Each one is checked the way every op is:
 * a call that names a word that does not exist, or that its template cannot
 * draw, is refused with a sentence that says why, and the cut is untouched.
 */

/** More than this many graphics in one cut is a mistake, not a style. */
export const MAX_GRAPHICS = 120

export interface MotionOpContext {
  hasWord(id: string): boolean
  hasBeat(id: string): boolean
}

export type MotionResult = { ok: true; cut: Cut } | { ok: false; reason: string }

/** m1, m2, ... continuing after the highest number in use. */
export function nextMotionId(cut: Cut): string {
  let max = 0
  for (const m of cut.motion ?? []) {
    const n = /^m(\d+)$/.exec(m.id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `m${max + 1}`
}

function anchorProblem(ref: string, ctx: MotionOpContext, role: string): string | null {
  const a = parseAnchor(ref)
  if (!a) return `${role} ${ref} is not a word, a beat, start or end.`
  if (a.on === 'cut') return null
  if (a.id && (ctx.hasWord(a.id) || ctx.hasBeat(a.id))) return null
  return `There is no word or beat ${a.id}.`
}

/** Why a call cannot go into the cut, or null when it can. */
export function checkCall(call: MotionCall, ctx: MotionOpContext): string | null {
  const tpl = template(call.kind)
  if (!tpl) return `There is no ${call.kind} graphic yet.`
  const from = anchorProblem(call.from, ctx, 'Its start,')
  if (from) return from
  const to = call.to.trim()
  if (to && parseLength(to) === null) {
    const problem = anchorProblem(to, ctx, 'Its end,')
    if (problem) return problem
  }
  for (const row of call.items) {
    if (!row.at.trim()) continue
    const problem = anchorProblem(row.at.trim(), ctx, 'A row’s time,')
    if (problem) return problem
  }
  if (call.color.trim() && !/^#[0-9a-fA-F]{6}$/.test(call.color.trim())) {
    return `${call.color} is not a colour I can use; give it as #RRGGBB.`
  }
  return tpl.check(call)
}

export function addMotion(cut: Cut, raw: unknown, ctx: MotionOpContext): MotionResult {
  const parsed = MotionCallSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, reason: `That graphic is not shaped right: ${parsed.error.issues[0]?.message}` }
  const call = parsed.data
  const motion = cut.motion ?? []
  if (motion.length >= MAX_GRAPHICS) return { ok: false, reason: `This cut already has ${MAX_GRAPHICS} graphics.` }
  const problem = checkCall(call, ctx)
  if (problem) return { ok: false, reason: problem }
  const item: MotionItem = { ...call, id: nextMotionId(cut) }
  return { ok: true, cut: { ...cut, motion: [...motion, item] } }
}

const keepString = (next: string | undefined, current: string): string =>
  next === undefined || next.trim() === '' ? current : next.trim() === 'none' ? '' : next

function keepList<T>(next: T[] | undefined, current: T[]): T[] {
  return next === undefined || next.length === 0 ? current : next
}

/**
 * Changes a graphic. Empty strings and empty lists keep what is there, so a
 * change names only what moves; "none" clears an icon, a style, a place, a
 * colour or an end.
 */
export function updateMotion(cut: Cut, id: string, change: MotionChange, ctx: MotionOpContext): MotionResult {
  const motion = cut.motion ?? []
  const at = motion.findIndex((m) => m.id === id)
  if (at < 0) return { ok: false, reason: `There is no graphic ${id}.` }
  const cur = motion[at]
  const merged = {
    ...cur,
    from: change.from && change.from.trim() ? change.from : cur.from,
    to: keepString(change.to, cur.to),
    text: keepList(change.text, cur.text),
    items: keepList(change.items, cur.items),
    values: keepList(change.values, cur.values),
    box: keepList(change.box, cur.box),
    icon: keepString(change.icon, cur.icon),
    style: keepString(change.style, cur.style),
    place: keepString(change.place, cur.place),
    color: keepString(change.color, cur.color),
    fx:
      change.fx === undefined
        ? cur.fx
        : change.fx.length === 1 && change.fx[0] === 'none'
          ? []
          : keepList(change.fx, cur.fx),
    layers: keepList(change.layers, cur.layers)
  }
  const parsed = MotionCallSchema.safeParse(merged)
  if (!parsed.success) return { ok: false, reason: `That change does not fit: ${parsed.error.issues[0]?.message}` }
  const problem = checkCall(parsed.data, ctx)
  if (problem) return { ok: false, reason: problem }
  const next = [...motion]
  next[at] = { ...parsed.data, id }
  return { ok: true, cut: { ...cut, motion: next } }
}

export function removeMotion(cut: Cut, ids: string[]): MotionResult {
  const motion = cut.motion ?? []
  for (const id of ids) if (!motion.some((m) => m.id === id)) return { ok: false, reason: `There is no graphic ${id}.` }
  const drop = new Set(ids)
  return { ok: true, cut: { ...cut, motion: motion.filter((m) => !drop.has(m.id)) } }
}
