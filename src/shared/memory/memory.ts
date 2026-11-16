import { z } from 'zod'
import type { Brand } from '../brand'
import { distill, type Preference } from './distill'
import { SignalSchema } from './signals'

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
 */
export function recordSignal(memory: Memory, signal: unknown): Memory {
  if (memory.paused) return memory
  const parsed = SignalSchema.safeParse(signal)
  if (!parsed.success) return memory
  const kept = parsed.data.kind === 'voice' ? memory.signals.filter((s) => s.kind !== 'voice') : memory.signals
  return { ...memory, signals: [...kept, parsed.data].slice(-MAX_SIGNALS) }
}

export const MemoryChangeSchema = z.object({
  /** Delete a statement. */
  forget: z.string().max(200).optional(),
  /** Reword a statement; empty words delete it. */
  edit: z.object({ id: z.string().max(200), text: z.string().max(2000) }).optional(),
  paused: z.boolean().optional(),
  /** A statement was made into a brand default, or that was turned back. */
  applied: z.string().max(200).optional(),
  declined: z.string().max(200).optional()
})
export type MemoryChange = z.infer<typeof MemoryChangeSchema>

export function changeMemory(memory: Memory, change: MemoryChange): Memory {
  let next = { ...memory }
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
}

export function memoryView(memory: Memory): MemoryView {
  return {
    paused: memory.paused,
    learned: learned(memory),
    applied: memory.applied,
    declined: memory.declined,
    signals: memory.signals.length
  }
}

export const EMPTY_MEMORY_VIEW: MemoryView = { paused: false, learned: [], applied: [], declined: [], signals: 0 }

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
