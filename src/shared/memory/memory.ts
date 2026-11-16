import { z } from 'zod'
import type { Brand } from '../brand'
import { isNeverItem } from '../never'
import { distill, type Preference } from './distill'
import { SignalSchema, type Signal } from './signals'

/**
 * What Cutalong has learned about how someone edits, as it is kept on their
 * computer (memory.json in userData): the signals, which statements they
 * deleted or reworded, which became brand defaults, and whether learning is
 * paused. A version field, and defaults for every part, so older files and
 * files from newer versions still open.
 */

/** Signals kept: the most recent, so the file stays small. */
export const MAX_SIGNALS = 2000
/** Statements sent to the planner with each request: the strongest few. */
export const PLANNER_PREFERENCES = 6

export const MemorySchema = z.object({
  v: z.literal(1),
  paused: z.boolean().default(false),
  /** Read one by one, so a signal from a newer version is skipped rather than losing the rest. */
  signals: z
    .array(z.unknown())
    .default([])
    .transform((list) =>
      list.flatMap((s) => {
        const r = SignalSchema.safeParse(s)
        return r.success ? [r.data] : []
      })
    ),
  /** Statements the person deleted. They stay out. */
  deleted: z.array(z.string()).default([]),
  /** Statements the person reworded: id to their words. */
  edits: z.record(z.string(), z.string()).default({}),
  /** Statements already made into a brand default, and ones the person turned back. */
  applied: z.array(z.string()).default([]),
  declined: z.array(z.string()).default([])
})
export type Memory = z.infer<typeof MemorySchema>

export const EMPTY_MEMORY: Memory = {
  v: 1,
  paused: false,
  signals: [],
  deleted: [],
  edits: {},
  applied: [],
  declined: []
}

/** A file as read from disk: anything unreadable is a fresh memory rather than an error. */
export function parseMemory(raw: unknown): Memory {
  const r = MemorySchema.safeParse(raw)
  return r.success ? r.data : { ...EMPTY_MEMORY }
}

/**
 * Notes a signal, unless learning is paused or the signal is not one we know.
 * The voice notes count only as they now read, so a new reading replaces the
 * last one rather than piling up.
 *
 * A rule for the never list is a setting the person gave, not something
 * noticed: it is kept while learning is paused, replaces the last word on
 * the same thing for the same brand, and is never trimmed away.
 */
export function recordSignal(memory: Memory, signal: unknown): Memory {
  const parsed = SignalSchema.safeParse(signal)
  if (!parsed.success) return memory
  const next = parsed.data
  if (memory.paused && next.kind !== 'never') return memory
  const kept = memory.signals.filter((s) => {
    // A brand's voice notes count as they now read: its new reading replaces its last.
    if (next.kind === 'voice') return !(s.kind === 'voice' && s.brand === next.brand)
    if (next.kind === 'never') return !(s.kind === 'never' && s.brand === next.brand && s.item === next.item)
    return true
  })
  const all = [...kept, next]
  const rules = all.filter((s) => s.kind === 'never').length
  if (rules === 0) return { ...memory, signals: all.slice(-MAX_SIGNALS) }
  const rest = new Set(all.filter((s) => s.kind !== 'never').slice(-Math.max(0, MAX_SIGNALS - rules)))
  return { ...memory, signals: all.filter((s) => s.kind === 'never' || rest.has(s)) }
}

/** A thing on a brand's never list, and where it came from. */
export interface NeverEntry {
  brand: string
  item: string
  at: string
  /** The words it was said in, when it was said in a chat. */
  said: string | null
}

/**
 * A rule on a brand's never list, as never.json keeps it (main/never-store):
 * the latest word on a thing for a brand. Kept in a file of its own, which
 * builds from before never open, rather than in memory.json, which they
 * rewrite without what they cannot read.
 */
export const NeverRuleSchema = z.object({
  brand: z.string().min(1).max(80),
  item: z.string().min(1).max(60),
  on: z.boolean(),
  at: z.string(),
  /** What was said, when it was said in a chat. */
  text: z.string().max(400).optional()
})
export type NeverRule = z.infer<typeof NeverRuleSchema>

/** never.json as read: rule by rule, so one from a newer build is skipped rather than losing the rest. */
export function parseNeverRules(raw: unknown): NeverRule[] {
  const list = raw && typeof raw === 'object' ? (raw as { rules?: unknown }).rules : undefined
  if (!Array.isArray(list)) return []
  return list.flatMap((r) => {
    const p = NeverRuleSchema.safeParse(r)
    return p.success ? [p.data] : []
  })
}

/** A rule given: it replaces the last word on the same thing for the same brand. */
export function withRule(rules: NeverRule[], rule: NeverRule): NeverRule[] {
  return [...rules.filter((r) => !(r.brand === rule.brand && r.item === rule.item)), rule]
}

/** The rules memory.json held, from before they had a file of their own. */
export function neverRulesIn(memory: Memory): NeverRule[] {
  let rules: NeverRule[] = []
  for (const s of [...memory.signals].sort((a, b) => a.at.localeCompare(b.at))) {
    if (s.kind !== 'never') continue
    rules = withRule(rules, { brand: s.brand, item: s.item, on: s.on, at: s.at, ...(s.text ? { text: s.text } : {}) })
  }
  return rules
}

/** Every brand's never list from its rules: the latest word on each thing, where that word was never. */
export function neverEntriesOf(rules: NeverRule[]): NeverEntry[] {
  return rules
    .filter((r) => r.on && isNeverItem(r.item))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((r) => ({ brand: r.brand, item: r.item, at: r.at, said: r.text ?? null }))
}

/** Every brand's never list as memory.json held it. */
export function neverEntries(memory: Memory): NeverEntry[] {
  return neverEntriesOf(neverRulesIn(memory))
}

/** One brand's never list, as entries the rest of the app reads (shared/never). */
export function neverFor(entries: NeverEntry[], brand: string): string[] {
  return entries.filter((e) => e.brand === brand).map((e) => e.item)
}

export const MemoryChangeSchema = z.object({
  /** Delete a statement. */
  forget: z.string().max(200).optional(),
  /** Reword a statement; empty words delete it. */
  edit: z.object({ id: z.string().max(200), text: z.string().max(2000) }).optional(),
  paused: z.boolean().optional(),
  /** A statement was made into a brand default, or that was turned back. */
  applied: z.string().max(200).optional(),
  declined: z.string().max(200).optional(),
  /** Things put on a brand's never list, or taken off it, on the Brand page or in a chat. */
  never: z
    .array(
      z.object({
        brand: z.string().min(1).max(80),
        item: z.string().min(1).max(60),
        on: z.boolean(),
        text: z.string().max(400).optional()
      })
    )
    .max(40)
    .optional()
})
export type MemoryChange = z.infer<typeof MemoryChangeSchema>

export function changeMemory(memory: Memory, change: MemoryChange, at = new Date().toISOString()): Memory {
  let next = { ...memory }
  for (const rule of change.never ?? []) next = recordSignal(next, { kind: 'never', at, ...rule })
  const once = (list: string[], id: string): string[] => (list.includes(id) ? list : [...list, id])
  if (change.forget) {
    const edits = { ...next.edits }
    delete edits[change.forget]
    next = { ...next, deleted: once(next.deleted, change.forget), edits }
  }
  if (change.edit) {
    const words = change.edit.text.trim().slice(0, 300)
    if (words) next = { ...next, edits: { ...next.edits, [change.edit.id]: words } }
    else return changeMemory(next, { forget: change.edit.id })
  }
  if (change.paused !== undefined) next = { ...next, paused: change.paused }
  if (change.applied) next = { ...next, applied: once(next.applied, change.applied) }
  if (change.declined) next = { ...next, declined: once(next.declined, change.declined) }
  return next
}

/** A statement as the person sees it: deleted ones gone, reworded ones in their words. */
export interface Learned extends Preference {
  edited: boolean
}

/**
 * The brand a list of statements is for, and the brand that owns what was
 * noted before brands (shared/brands legacyBrandId): each brand learns from
 * its own chats.
 */
export interface MemoryBrand {
  id: string
  legacy: string
}

/** The signals a brand learns from: its own, and for the brand from before brands, those that name none. */
export function signalsOf(signals: Signal[], brand: MemoryBrand): Signal[] {
  return signals.filter((s) => s.kind !== 'never' && (s.brand ?? brand.legacy) === brand.id)
}

/**
 * A statement's id for a brand. The brand from before brands keeps the ids
 * statements had then, so what was deleted, reworded or made a default then
 * still holds; another brand's are its own ("brand-x/zoom:less").
 */
export function statementId(id: string, brand?: MemoryBrand): string {
  return !brand || brand.id === brand.legacy ? id : `${brand.id}/${id}`
}

/** What has been learned: for one brand from its own chats, or from every chat when no brand is named. */
export function learned(memory: Memory, brand?: MemoryBrand): Learned[] {
  const deleted = new Set(memory.deleted)
  return distill(brand ? signalsOf(memory.signals, brand) : memory.signals)
    .map((p) => ({ ...p, id: statementId(p.id, brand) }))
    .filter((p) => !deleted.has(p.id))
    .map((p) => {
      const words = memory.edits[p.id]
      return words ? { ...p, text: words, edited: true } : { ...p, edited: false }
    })
}

/**
 * The strongest statements, for the planner: the brand's, when one is named.
 * Deleted ones never get here; reworded ones go in the person's words.
 */
export function plannerPreferences(memory: Memory, max = PLANNER_PREFERENCES, brand?: MemoryBrand): string[] {
  return learned(memory, brand)
    .slice(0, max)
    .map((p) => p.text)
}

export interface MemoryView {
  paused: boolean
  /** What was learned: the brand from before brands', when the view is by brand; else from every chat. */
  learned: Learned[]
  /** What each brand has learned from its own chats, by brand id. Views from before brands have none. */
  byBrand?: Record<string, Learned[]>
  applied: string[]
  declined: string[]
  /** Signals noted so far, so the page can tell nothing learned from nothing seen. */
  signals: number
  /** The same, by brand. */
  seen?: Record<string, number>
  /** Every brand's never list. Views from before there was one have none. */
  never?: NeverEntry[]
}

/** The brands a view is for: their ids, and the one that owns what was noted before brands. */
export interface ViewBrands {
  ids: string[]
  legacy: string
}

export function memoryView(memory: Memory, brands?: ViewBrands): MemoryView {
  const notNever = memory.signals.filter((s) => s.kind !== 'never')
  const by = brands ? brands.ids.map((id) => ({ id, legacy: brands.legacy })) : []
  return {
    paused: memory.paused,
    learned: learned(memory, brands ? { id: brands.legacy, legacy: brands.legacy } : undefined),
    ...(brands
      ? {
          byBrand: Object.fromEntries(by.map((b) => [b.id, learned(memory, b)])),
          seen: Object.fromEntries(by.map((b) => [b.id, signalsOf(notNever, b).length]))
        }
      : {}),
    applied: memory.applied,
    declined: memory.declined,
    signals: notNever.length,
    never: neverEntries(memory)
  }
}

/** What a brand has learned, from a view. */
export function learnedFor(view: MemoryView, brand: string): Learned[] {
  return view.byBrand ? (view.byBrand[brand] ?? []) : view.learned
}

/** How many signals a brand has noted, from a view. */
export function seenFor(view: MemoryView, brand: string): number {
  return view.seen ? (view.seen[brand] ?? 0) : view.signals
}

export const EMPTY_MEMORY_VIEW: MemoryView = {
  paused: false,
  learned: [],
  applied: [],
  declined: [],
  signals: 0,
  never: []
}

/**
 * Statements that set a brand default the brand does not have yet: each is
 * applied once, and never again if the person turned it back or set the
 * value themselves since.
 */
export interface BrandDefault {
  id: string
  captions: Partial<Brand['captions']>
  /** What changes, as a sentence of its own. */
  text: string
  /** The same as a clause, to say several changes in one sentence. */
  clause: string
}

export function defaultsToApply(view: MemoryView, brand: Brand): BrandDefault[] {
  const out: BrandDefault[] = []
  for (const p of learnedFor(view, brand.id)) {
    if (!p.setting || view.applied.includes(p.id) || view.declined.includes(p.id)) continue
    const want = p.setting.captions
    const differs =
      (want.position !== undefined && brand.captions.position !== want.position) ||
      (want.wordsPerScreen !== undefined && brand.captions.wordsPerScreen !== want.wordsPerScreen)
    if (!differs) continue
    const said =
      want.position !== undefined
        ? `sit ${POSITION_WORDS[want.position]}`
        : `show ${want.wordsPerScreen === 1 ? 'one word' : `${want.wordsPerScreen} words`} at a time`
    out.push({ id: p.id, captions: want, clause: said, text: `From how you edit, your brand's captions now ${said}.` })
  }
  return out
}

/** Several defaults set at once, in one sentence; `brand` names the brand when there is more than one. */
export function defaultsSentence(due: BrandDefault[], brand?: string): string {
  if (due.length === 0) return ''
  if (!brand && due.length === 1) return due[0].text
  const whose = brand ? `${brand}’s` : "your brand's"
  return `From how you edit, ${whose} captions now ${due.map((d) => d.clause).join(' and ')}.`
}

const POSITION_WORDS: Record<string, string> = {
  top: 'at the top',
  middle: 'in the middle',
  chest: 'at chest height',
  bottom: 'low in frame'
}
