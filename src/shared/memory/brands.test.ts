import { describe, expect, it } from 'vitest'
import { EMPTY_BRAND, type Brand } from '../brand'
import { SignalSchema as SignalSchema0213 } from './signals-0213.review'
import {
  changeMemory,
  defaultsToApply,
  EMPTY_MEMORY,
  learned,
  learnedFor,
  memoryView,
  plannerPreferences,
  recordSignal,
  seenFor,
  type Memory
} from './memory'

/**
 * Each brand learns from its own chats: a signal names the brand of the edit
 * it came from, and one noted before there could be more than one brand
 * belongs to the brand from then (brand-1 here). What one brand's chats teach
 * never reaches another's page, defaults or planner.
 */

const at = (n: number): string => new Date(Date.parse('2026-11-05T10:00:00.000Z') + n * 60_000).toISOString()

function noted(signals: unknown[]): Memory {
  return signals.reduce<Memory>((m, s) => recordSignal(m, s), { ...EMPTY_MEMORY })
}

/** Captions moved to the top on two edits, and kept: "Captions at the top (every edit)". */
const top = (brand: string | undefined, doc: string, n: number): unknown[] => [
  { kind: 'command', at: at(n), doc, command: 'captions', version: 2, tags: ['captions-position:top'], ...(brand ? { brand } : {}) },
  {
    kind: 'keep',
    at: at(n + 1),
    doc,
    version: 2,
    captions: { on: true, position: 'top', wordsPerScreen: 3 },
    aspect: 'vertical',
    ...(brand ? { brand } : {})
  }
]

const slower = (brand: string | undefined, doc: string, n: number): unknown => ({
  kind: 'request',
  at: at(n),
  doc,
  text: 'too fast, slow it down',
  version: 2,
  tags: [],
  ...(brand ? { brand } : {})
})

const brands = { ids: ['brand-1', 'brand-x'], legacy: 'brand-1' }
const X = { id: 'brand-x', legacy: 'brand-1' }
const ONE = { id: 'brand-1', legacy: 'brand-1' }

describe('what each brand learns', () => {
  const memory = noted([...top('brand-x', 'a', 0), ...top('brand-x', 'b', 2), slower(undefined, 'c', 4), slower(undefined, 'd', 5)])

  it('is learned from its own chats; what was noted before brands is the first brand’s', () => {
    expect(learned(memory, X).map((p) => p.text)).toEqual(['Captions at the top (every edit)'])
    expect(learned(memory, ONE).map((p) => p.text)).toEqual(['You like a slower pace (2 times)'])
    const view = memoryView(memory, brands)
    expect(learnedFor(view, 'brand-x').map((p) => p.id)).toEqual(['brand-x/captions-position:top'])
    expect(learnedFor(view, 'brand-1').map((p) => p.id)).toEqual(['pace:slower'])
    expect(seenFor(view, 'brand-x')).toBe(4)
    expect(seenFor(view, 'brand-1')).toBe(2)
    // A view from before brands, as tests and older callers read it: every chat.
    expect(memoryView(memory).learned.map((p) => p.id).sort()).toEqual(['captions-position:top', 'pace:slower'])
  })

  it('becomes a default of that brand only', () => {
    const view = memoryView(memory, brands)
    const tc: Brand = { ...EMPTY_BRAND, id: 'brand-x', name: 'Tech Corner' }
    const fn: Brand = { ...EMPTY_BRAND, id: 'brand-1', name: 'Field Notes' }
    expect(defaultsToApply(view, tc).map((d) => d.captions)).toEqual([{ position: 'top' }])
    expect(defaultsToApply(view, fn)).toEqual([])
    // Made a default on Tech Corner, it is not made one again; the first brand's own would still be.
    const applied = memoryView(changeMemory(memory, { applied: 'brand-x/captions-position:top' }), brands)
    expect(defaultsToApply(applied, tc)).toEqual([])
  })

  it('goes to the planner for that brand, and is deleted for it alone', () => {
    expect(plannerPreferences(memory, undefined, X)).toEqual(['Captions at the top (every edit)'])
    expect(plannerPreferences(memory, undefined, ONE)).toEqual(['You like a slower pace (2 times)'])
    const both = noted([...top('brand-x', 'a', 0), ...top('brand-x', 'b', 2), ...top(undefined, 'c', 4), ...top(undefined, 'd', 6)])
    const forgotten = changeMemory(both, { forget: 'brand-x/captions-position:top' })
    expect(learned(forgotten, X)).toEqual([])
    expect(learned(forgotten, ONE).map((p) => p.id)).toEqual(['captions-position:top'])
  })

  it('keeps each brand’s voice notes as that brand’s', () => {
    const m = noted([
      { kind: 'voice', at: at(0), brand: 'brand-1', text: 'No zoom punch-ins, ever.' },
      { kind: 'voice', at: at(1), brand: 'brand-x', text: 'Fast cuts, and no music.' }
    ])
    expect(m.signals.filter((s) => s.kind === 'voice')).toHaveLength(2)
    expect(learned(m, ONE).map((p) => p.text)).toEqual(['No zoom punch-ins (in your voice notes)'])
    expect(learned(m, X).map((p) => p.text)).not.toContain('No zoom punch-ins (in your voice notes)')
    // A new reading of one brand's notes replaces only its last.
    const again = recordSignal(m, { kind: 'voice', at: at(2), brand: 'brand-x', text: 'Fast cuts.' })
    expect(again.signals.filter((s) => s.kind === 'voice').map((s) => (s.kind === 'voice' ? s.text : ''))).toEqual([
      'No zoom punch-ins, ever.',
      'Fast cuts.'
    ])
  })

  it('reads in 0.2.13 as signals without a brand, which come back as the first brand’s', () => {
    const tagged = top('brand-x', 'a', 0)[0]
    const old = SignalSchema0213.safeParse(tagged)
    expect(old.success).toBe(true)
    if (!old.success) return
    expect('brand' in old.data).toBe(false)
  })
})
