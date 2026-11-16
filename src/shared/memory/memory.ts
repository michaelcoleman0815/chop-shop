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
    if (next.kind === 'voice') return s.kind !== 'voice'
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

/** Every brand's never list: the latest word on each thing, where that word was never. */
export function neverEntries(memory: Memory): NeverEntry[] {
  return memory.signals
    .filter((s): s is Extract<Signal, { kind: 'never' }> => s.kind === 'never' && s.on && isNeverItem(s.item))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((s) => ({ brand: s.brand, item: s.item, at: s.at, said: s.text ?? null }))
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

export function learned(memory: Memory): Learned[] {
  const deleted = new Set(memory.deleted)
  return distill(memory.signals)
    .filter((p) => !deleted.has(p.id))
    .map((p) => {
      const words = memory.edits[p.id]
      return words ? { ...p, text: words, edited: true } : { ...p, edited: false }
    })
}

/**
 * The strongest statements, for the planner. Deleted ones never get here;
 * reworded ones go in the person's words.
 */
export function plannerPreferences(memory: Memory, max = PLANNER_PREFERENCES): string[] {
  return learned(memory)
    .slice(0, max)
    .map((p) => p.text)
}

export interface MemoryView {
  paused: boolean
  learned: Learned[]
  applied: string[]
  declined: string[]
  /** Signals noted so far, so the page can tell nothing learned from nothing seen. */
  signals: number
  /** Every brand's never list. Views from before there was one have none. */
  never?: NeverEntry[]
}

export function memoryView(memory: Memory): MemoryView {
  return {
    paused: memory.paused,
    learned: learned(memory),
    applied: memory.applied,
    declined: memory.declined,
    signals: memory.signals.filter((s) => s.kind !== 'never').length,
    never: neverEntries(memory)
  }
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
  for (const p of view.learned) {
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

/** Several defaults set at once, in one sentence. */
export function defaultsSentence(due: BrandDefault[]): string {
  return due.length > 1
    ? `From how you edit, your brand's captions now ${due.map((d) => d.clause).join(' and ')}.`
    : (due[0]?.text ?? '')
}

const POSITION_WORDS: Record<string, string> = {
  top: 'at the top',
  middle: 'in the middle',
  chest: 'at chest height',
  bottom: 'low in frame'
}
