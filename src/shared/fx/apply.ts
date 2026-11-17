import type { Cut } from '../edit/schema'
import { parseAnchor, parseLength } from '../motion/schema'
import { isGradient } from './gradients'
import {
  FX_EXTRAS,
  FX_INFO,
  FxCallSchema,
  FxChangeSchema,
  type FxCall,
  type FxChange,
  type FxItem
} from './schema'

/**
 * The effect ops, applied to a cut. Each is checked the way every op is: a
 * call that names a word that is not there, a style its kind does not have
 * or a colour that is not one is refused with a sentence that says why, and
 * the cut is left as it was.
 */

/** More effects than this in one cut is a mistake, not a style. */
export const MAX_EFFECTS = 60

export interface FxOpContext {
  hasWord(id: string): boolean
  hasBeat(id: string): boolean
}

export type FxResult = { ok: true; cut: Cut } | { ok: false; reason: string }

/** The effects in a cut: none in one made before there were any. */
export function effectsOf(cut: Pick<Cut, 'fx'>): FxItem[] {
  return cut.fx ?? []
}

/** x1, x2, ... after the highest number in use. */
export function nextFxId(cut: Pick<Cut, 'fx'>): string {
  let max = 0
  for (const e of effectsOf(cut)) {
    const n = /^x(\d+)$/.exec(e.id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  return `x${max + 1}`
}

function anchorProblem(ref: string, ctx: FxOpContext, role: string): string | null {
  const a = parseAnchor(ref)
  if (!a) return `${role} ${ref} is not a word, a beat, start or end.`
  if (a.on === 'cut') return null
  if (a.id && (ctx.hasWord(a.id) || ctx.hasBeat(a.id))) return null
  return `There is no word or beat ${a.id}.`
}

/** Why a call cannot go into the cut, or null when it can. */
export function checkFx(call: FxCall, ctx: FxOpContext): string | null {
  const info = FX_INFO[call.kind]
  const from = anchorProblem(call.from, ctx, 'Its start,')
  if (from) return from
  const to = call.to.trim()
  if (to && parseLength(to) === null) {
    const problem = anchorProblem(to, ctx, 'Its end,')
    if (problem) return problem
  }
  const style = call.style.trim().toLowerCase()
  if (style && !info.styles.includes(style))
    return `${info.title} is ${info.styles.join(', ')}; ${call.style} is not one of them.`
  const color = call.color.trim()
  if (color && !isGradient(color.toLowerCase()) && !/^#[0-9a-fA-F]{6}$/.test(color))
    return `${color} is not a colour I can use; name a gradient like gold or caribbean, or give #RRGGBB.`
  if (call.at.length === 1) return 'A point in the frame needs both its across and its down, like [0.5, 0.4].'
  if (call.strength > 0 && call.strength < 0.25) return 'An effect that faint would not show; 0.25 is the least.'
  const unknown = call.extra.find((e) => !(FX_EXTRAS as readonly string[]).includes(e.trim().toLowerCase()))
  if (unknown) return `${unknown} is not something an effect can add; it can take ${FX_EXTRAS.join(', ')}.`
  return null
}

/** A call as it is kept: style, colour and extras in lower case, so they read the same everywhere. */
function tidy<T extends { style: string; color: string; extra: string[] }>(call: T): T {
  const color = call.color.trim()
  return {
    ...call,
    style: call.style.trim().toLowerCase(),
    color: isGradient(color.toLowerCase()) ? color.toLowerCase() : color.toUpperCase(),
    extra: [...new Set(call.extra.map((e) => e.trim().toLowerCase()).filter(Boolean))]
  }
}

export function addFx(cut: Cut, raw: unknown, ctx: FxOpContext): FxResult {
  const parsed = FxCallSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, reason: `That effect is not shaped right: ${parsed.error.issues[0]?.message}` }
  const fx = effectsOf(cut)
  if (fx.length >= MAX_EFFECTS) return { ok: false, reason: `This cut already has ${MAX_EFFECTS} effects.` }
  const call = tidy(parsed.data)
  const problem = checkFx(call, ctx)
  if (problem) return { ok: false, reason: problem }
  const item: FxItem = { ...call, id: nextFxId(cut) }
  return { ok: true, cut: { ...cut, fx: [...fx, item] } }
}

export function updateFx(cut: Cut, id: string, raw: unknown, ctx: FxOpContext): FxResult {
  const fx = effectsOf(cut)
  const i = fx.findIndex((e) => e.id === id)
  if (i < 0) return { ok: false, reason: `There is no effect ${id}.` }
  const parsed = FxChangeSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, reason: `That change is not shaped right: ${parsed.error.issues[0]?.message}` }
  const change: FxChange = parsed.data
  const was = fx[i]
  const next: FxItem = tidy({
    ...was,
    ...(change.from?.trim() ? { from: change.from.trim() } : {}),
    ...(change.to !== undefined ? { to: change.to } : {}),
    ...(change.on !== undefined ? { on: change.on } : {}),
    ...(change.at !== undefined && change.at.length !== 1 ? { at: change.at } : {}),
    ...(change.style !== undefined ? { style: change.style } : {}),
    ...(change.color !== undefined ? { color: change.color } : {}),
    ...(change.strength !== undefined ? { strength: change.strength } : {}),
    ...(change.extra !== undefined ? { extra: change.extra } : {})
  })
  const problem = checkFx(next, ctx)
  if (problem) return { ok: false, reason: problem }
  return { ok: true, cut: { ...cut, fx: fx.map((e, k) => (k === i ? next : e)) } }
}

export function removeFx(cut: Cut, ids: string[]): FxResult {
  const fx = effectsOf(cut)
  const missing = ids.find((id) => !fx.some((e) => e.id === id))
  if (missing) return { ok: false, reason: `There is no effect ${missing}.` }
  return { ok: true, cut: { ...cut, fx: fx.filter((e) => !ids.includes(e.id)) } }
}
