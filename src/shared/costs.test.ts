import { describe, expect, it } from 'vitest'
import {
  amount,
  averageLine,
  chatCost,
  claimLoose,
  emptyLedger,
  entryFor,
  kindOf,
  LOOSE_WINDOW_MS,
  priceOf,
  readLedger,
  record,
  summarise,
  videoCostLine
} from './costs'

const at = new Date('2026-11-23T12:00:00Z')
const a = { id: 'a', name: 'Sermon', path: '/p/a.cutalong' }

describe('what a call cost', () => {
  it('prices each kind of token at Opus 5.5’s rates', () => {
    const e = entryFor(
      'plan',
      'claude-opus-5-5',
      { input_tokens: 4000, cache_creation_input_tokens: 30000, cache_read_input_tokens: 0, output_tokens: 3000 },
      at
    )
    // 4,000 × $4 + 30,000 × $5 + 3,000 × $20, per million.
    expect(e.dollars).toBeCloseTo(0.016 + 0.15 + 0.06, 6)
    expect(e.tokens).toEqual({ input: 4000, cacheWrite: 30000, cacheRead: 0, output: 3000 })
    expect(e.unpriced).toBeUndefined()
  })

  it('reads the prompt cache at a twentieth of an input token, and counts web searches at a cent each', () => {
    const read = entryFor('plan', 'claude-opus-5-5', { input_tokens: 0, cache_read_input_tokens: 1_000_000 }, at)
    expect(read.dollars).toBeCloseTo(0.2, 6)
    const web = entryFor('web-search', 'claude-opus-5-5', { server_tool_use: { web_search_requests: 3 } }, at)
    expect(web.dollars).toBeCloseTo(0.03, 6)
    expect(web.searches).toBe(3)
  })

  it('prices Opus 5 at its own rates, and a dated id as its family', () => {
    expect(entryFor('clips', 'claude-opus-5', { output_tokens: 1_000_000 }, at).dollars).toBeCloseTo(25, 6)
    expect(priceOf('claude-opus-5-5-20261101')?.output).toBe(20)
    expect(priceOf('claude-opus-5-20260601')?.output).toBe(25)
  })

  it('keeps a call to a model it has no price for, marked, rather than guessing', () => {
    const e = entryFor('plan', 'claude-unknown-9', { input_tokens: 100, output_tokens: 100 }, at)
    expect(e.dollars).toBe(0)
    expect(e.unpriced).toBe(true)
  })

  it('takes missing or nonsense counts as none', () => {
    const e = entryFor('read', 'claude-opus-5-5', { input_tokens: null, output_tokens: -4 }, at)
    expect(e.tokens).toEqual({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })
    expect(e.dollars).toBe(0)
  })
})

describe('the ledger', () => {
  const plan = entryFor('plan', 'claude-opus-5-5', { output_tokens: 10_000 }, at)

  it('writes a call against the chat it was for, or as loose with none open', () => {
    let l = record(emptyLedger(), a, plan)
    l = record(l, null, plan)
    expect(l.projects.a.entries).toHaveLength(1)
    expect(l.projects.a.name).toBe('Sermon')
    expect(l.loose).toHaveLength(1)
  })

  it('gives the chat that opens next the loose calls of the last few minutes, and leaves older ones loose', () => {
    const old = entryFor('read', 'claude-opus-5-5', { output_tokens: 1000 }, new Date(at.getTime() - LOOSE_WINDOW_MS - 1000))
    const fresh = entryFor('read', 'claude-opus-5-5', { output_tokens: 1000 }, new Date(at.getTime() - 60_000))
    const l = claimLoose(record(record(emptyLedger(), null, old), null, fresh), a, at)
    expect(l.projects.a.entries.map((e) => e.at)).toEqual([fresh.at])
    expect(l.loose.map((e) => e.at)).toEqual([old.at])
  })

  it('changes nothing when a chat with no calls opens and there are none waiting', () => {
    const l = emptyLedger()
    expect(claimLoose(l, a, at)).toBe(l)
  })

  it('reads back what it wrote, and starts again from a file it cannot read', () => {
    const l = record(emptyLedger(), a, plan)
    expect(readLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
    expect(readLedger({ v: 2 })).toEqual(emptyLedger())
    expect(readLedger(null)).toEqual(emptyLedger())
  })
})

describe('what a chat makes', () => {
  const edit = (aspect: string) => ({ edit: { versions: [{ cut: { aspect: 'wide' } }, { cut: { aspect } }] } })

  it('counts each clip found in a long recording as a Short', () => {
    expect(kindOf({ clipping: { clips: [1, 2, 3, 4, 5] }, edit: null })).toEqual({ kind: 'short', videos: 5 })
  })

  it('goes by the newest version: vertical or square a Short, wide or as shot long-form', () => {
    expect(kindOf(edit('vertical'))).toEqual({ kind: 'short', videos: 1 })
    expect(kindOf(edit('square'))).toEqual({ kind: 'short', videos: 1 })
    expect(kindOf(edit('wide'))).toEqual({ kind: 'long', videos: 1 })
    expect(kindOf(edit('original'))).toEqual({ kind: 'long', videos: 1 })
  })

  it('says a chat with no edit and no clips made no video yet', () => {
    expect(kindOf({ edit: null, clipping: null })).toBeNull()
  })

  it('adds what a video made from nothing spent on its own to its calls', () => {
    const c = chatCost('m', [entryFor('plan', 'claude-opus-5-5', { output_tokens: 10_000 }, at)], {
      edit: { versions: [{ cut: { aspect: 'wide' } }], make: { spent: 2.4 } }
    })
    expect(c.dollars).toBeCloseTo(2.6, 6)
    expect(c.shape).toEqual({ kind: 'long', videos: 1 })
  })
})

describe('the averages', () => {
  it('averages Shorts and long-form apart, a clip at a time, and keeps what made no video aside', () => {
    const s = summarise(
      [
        { id: 'sermon', dollars: 0.6, shape: { kind: 'short', videos: 5 }, unpriced: 0 },
        { id: 'take', dollars: 0.3, shape: { kind: 'short', videos: 1 }, unpriced: 0 },
        { id: 'long', dollars: 1.2, shape: { kind: 'long', videos: 1 }, unpriced: 1 },
        { id: 'question', dollars: 0.05, shape: null, unpriced: 0 }
      ],
      [entryFor('read', 'claude-opus-5-5', { output_tokens: 1000 }, at)]
    )
    expect(s.shorts).toEqual({ videos: 6, chats: 2, dollars: 0.9, average: 0.15 })
    expect(s.long).toEqual({ videos: 1, chats: 1, dollars: 1.2, average: 1.2 })
    expect(s.elsewhere).toBeCloseTo(0.07, 6)
    expect(s.total).toBeCloseTo(2.17, 6)
    expect(s.unpriced).toBe(1)
    expect(s.kept).toBe(true)
  })

  it('says each in a sentence', () => {
    const s = summarise(
      [
        { id: 'sermon', dollars: 0.6, shape: { kind: 'short', videos: 5 }, unpriced: 0 },
        { id: 'take', dollars: 0.3, shape: { kind: 'short', videos: 1 }, unpriced: 0 },
        { id: 'long', dollars: 1.2, shape: { kind: 'long', videos: 1 }, unpriced: 0 }
      ],
      []
    )
    expect(averageLine(s.shorts, 'short')).toBe('15 cents a Short on average, over 6 Shorts from 2 chats.')
    expect(averageLine(s.long, 'long')).toBe('$1.20 a long-form video on average, over 1 long-form video.')
    expect(averageLine(summarise([], []).long, 'long')).toBe('No long-form videos yet.')
  })

  it('reads amounts as a person would', () => {
    expect(amount(0.42)).toBe('42 cents')
    expect(amount(0.001)).toBe('less than a cent')
    expect(amount(3.5)).toBe('$3.50')
    expect(videoCostLine(0.42)).toBe('This video has cost 42 cents so far.')
    expect(videoCostLine(0)).toBe('Nothing has been spent on this video yet.')
  })
})
