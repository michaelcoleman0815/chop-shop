import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: vi.fn(() => null), hasApiKey: () => false }))

import { commit, createDoc, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { callMost, MAX_OUTPUT, planPrice, PLANNER_PRICE, quoteLines, typicalTokens } from '../shared/setup'
import { forgetSent, isChange, keptNow, noteSent, planQuote, planSize } from './plan-quote'

/**
 * What an edit will cost, said before it starts. The reckoning is held to what real runs came to, so a quote is
 * neither a surprise nor a scare, and the most it names is the most the planner can spend.
 */

function talk(words = 250, seconds = 75): EditDoc {
  const list = Array.from({ length: words }, (_, i) => ({ text: `word${i % 7}`, startSec: (i * seconds) / words, endSec: ((i + 0.8) * seconds) / words }))
  return createDoc({
    id: 'd',
    title: 'Talk',
    source: { id: 's1', path: '/talk.mov', durationSec: seconds, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(list, 's1')
  })
}
const ask = { request: 'make it pop', notes: [] }

describe('what an edit will cost', () => {
  beforeEach(() => forgetSent())

  it('reckons the tokens of a real run to within a tenth', () => {
    // A 65-second explainer on 2026-11-24: 52,386 tokens read and kept, 4,806 more with the ask.
    const doc = talk(247, 74)
    const size = planSize({ commands: '', transcript: 'x'.repeat(3155), request: '' }, Array.from({ length: 19 }, () => ({ width: 768, height: 384 })))
    expect(size.instructions + size.footage).toBeGreaterThan(52386 * 0.9)
    expect(size.instructions + size.footage).toBeLessThan(52386 * 1.1)
    expect(doc.words).toHaveLength(247)
  })

  it('prices a first edit at each quality, more for more, and never more than the most', () => {
    const quick = planQuote({ doc: talk(), ...ask }, { planQuality: 'quick' })!
    const careful = planQuote({ doc: talk(), ...ask }, { planQuality: 'careful' })!
    const best = planQuote({ doc: talk(), ...ask }, { planQuality: 'best' })!
    expect(quick.about).toBeGreaterThan(0.25)
    expect(quick.about).toBeLessThan(0.6)
    expect(careful.about).toBeGreaterThan(quick.about)
    expect(best.about).toBeGreaterThan(careful.about)
    for (const q of [quick, careful, best]) expect(q.most).toBeGreaterThan(q.about)
    // Best has room for one thing redone with every call as long as it may be.
    expect(best.most).toBeGreaterThan(0.9)
    expect(best.most).toBeLessThan(1.6)
    // Less is on offer beside it, where more was asked for.
    expect(quick.quick).toBeNull()
    expect(best.quick?.about).toBeCloseTo(quick.about, 5)
    // The parts are the whole.
    expect(best.plan + best.checks + best.design).toBeCloseTo(best.about, 6)
    expect(quick.checks).toBe(0)
    expect(careful.design).toBe(0)
  })

  it('costs a few cents to change soon after, and more once Anthropic has let go of what it read', () => {
    const doc = talk()
    const now = 1_000_000
    const first = planQuote({ doc, ...ask }, {}, now)!
    noteSent(doc, now)
    expect(keptNow(doc, now + 60_000)).toEqual({ instructions: true, footage: true })
    const made = commit(doc, [{ op: 'motion-add', kind: 'keyword', from: 'w3', to: '', text: ['Here'], items: [], values: [], box: [], icon: '', style: 'plate', place: '', color: '', fx: [], layers: [] } as never], 'x').doc
    expect(isChange(doc)).toBe(false)
    expect(isChange(made)).toBe(true)
    const soon = planQuote({ doc: made, ...ask }, {}, now + 60_000)!
    const later = planQuote({ doc: made, ...ask }, {}, now + 600_000)!
    expect(soon.change).toBe(true)
    expect(soon.about).toBeLessThan(0.1)
    expect(later.about).toBeGreaterThan(soon.about * 3)
    expect(later.about).toBeLessThan(first.about)
    // Another edit's words are not kept, only the instructions are.
    expect(keptNow({ id: 'other', words: doc.words }, now + 60_000)).toEqual({ instructions: true, footage: false })
  })

  it('waits for a yes over what Settings says, and not for a few cents', () => {
    const doc = talk()
    expect(planQuote({ doc, ...ask }, {})!.ask).toBe(true)
    expect(planQuote({ doc, ...ask }, { planAskOver: null })!.ask).toBe(false)
    expect(planQuote({ doc, ...ask }, { planAskOver: 5 })!.ask).toBe(false)
    noteSent(doc)
    const made = { ...doc }
    expect(planQuote({ doc: made, ...ask }, { planAskOver: 0 })!.ask).toBe(true)
  })

  it('plans once where Claude does not see the frames, whatever the quality', () => {
    const q = planQuote({ doc: talk(), ...ask }, { planQuality: 'best', claudeSeesFrames: false })!
    expect(q.quality).toBe('quick')
    expect(q.checks + q.design).toBe(0)
  })

  it('says it plainly, with what it is made of', () => {
    const q = planQuote({ doc: talk(), ...ask }, { planQuality: 'best' })!
    const { text, aside } = quoteLines(q)
    expect(text).toMatch(/^This edit will cost about \$?[\d.]+( cents)?, and never more than \$[\d.]+\.$/)
    expect(aside).toMatch(/to plan it, .* to design a graphic for it and .* to check it and redo what is not good enough\./)
    expect(aside).toContain('I stop before going over.')
    expect(quoteLines({ ...q, change: true }).text).toMatch(/^This change/)
    const plain = planQuote({ doc: talk(), ...ask }, {})!
    expect(quoteLines(plain).aside).toMatch(/^It goes on your Anthropic account/)
  })

  it('leaves room in the most for what the planner may begin', () => {
    const t = typicalTokens()
    for (const quality of ['careful', 'best'] as const) {
      const p = planPrice(t, { quality })
      const spent = p.plan + 0.08
      expect(spent + callMost('redo', t.instructions + t.footage) + callMost('critic')).toBeLessThanOrEqual(p.most + 0.02)
    }
    // Planned once, the most is an answer as long as the API lets it be.
    const once = planPrice(t, { quality: 'quick' })
    expect(once.most).toBeGreaterThanOrEqual((MAX_OUTPUT.plan * PLANNER_PRICE.output) / 1e6)
  })

  it('says nothing of an edit it cannot read', () => {
    expect(planQuote({ doc: { nope: true }, ...ask }, {})).toBeNull()
  })
})
