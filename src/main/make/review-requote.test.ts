import { describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import { shotListCost, shotListParts, type Availability } from '../../shared/make/quote'
import { phrasesAndSections } from '../../shared/make/script'
import type { Make } from '../../shared/make/schema'
import { planShots, type ParseCall } from './claude'
import { Budget } from './generate'
import { changeFor } from './remake'
import { MakeFailed, makeVideo, quoteDraft, Stopped, type MakeRunDeps } from './run'

/**
 * Regression for the fifth money review's fourth finding: a script written
 * at make time (a made video asked for at a new length) is counted the way
 * the shot list counts it, once it is written; with more lines than its
 * quote assumed, the run stops before any part of the shot list is asked
 * for, keeps the script, and quotes the rest at its real length. No part of
 * a shot list is held to more than its own line of the quote.
 */

const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const prompts = ['A wildcatter beside the derrick at dusk.', 'Roughnecks on the rig floor at night.', 'A boom town main street in 1955.', 'The derrick against a red sky.']
const make = {
  brief: { topic: 'the oil boom', format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', cap: null, look: 'archival', maps: 'auto', clips: 'auto', images: null, inferred: [], ask: 'make a documentary about the oil boom' },
  title: 'Black Gold',
  outline: ['The boom'],
  script: prompts.join(' '),
  phrases: prompts,
  sections: [0],
  bible: { style: 's', palette: 'p', era: 'e', characters: [] },
  sheets: [],
  narration: { path: '/m/n.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  shots: prompts.map((p, i) => ({ phrase: i, visual: { kind: 'still', prompt: p, move: 'push-in', characters: [] }, title: null, callouts: [], beat: `b${i}`, file: `/m/${i}.png`, maker: 'google', model: 'm', cost: 0.05, key: null, note: null })),
  images: 'google',
  clips: null,
  spent: 1
} as unknown as Make
const doc = { id: 'doc1', sources: [{ id: 's1', path: '/m/n.wav' }], words: [], make, versions: [] } as unknown as EditDoc
const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const deps = { parse: (async () => Promise.reject(new Error('not asked'))) as ParseCall, can, brand: {}, settings: { cap: null, autoUnder: null } }

/** A script of `lines` sentences of about twelve words, as Claude would return it. */
const scriptOf = (lines: number) => ({
  title: 'Black Gold',
  sections: [
    {
      heading: 'The boom',
      paragraphs: Array.from({ length: lines }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked on.`)
    }
  ]
})

/** The draft for "make it 8 minutes": its script unwritten, quoted from the length. */
async function eightMinutes(): Promise<Draft> {
  const c = await changeFor(doc, 'make it 8 minutes', null, deps)
  if (c?.kind !== 'draft' || !c.draft.unwritten) throw new Error('expected a draft with its script unwritten')
  return c.draft
}

/** A run whose Claude writes `lines` lines for the script; everything after the shot list's first ask is left unset. */
function run(lines: number): { deps: MakeRunDeps; calls: string[] } {
  const calls: string[] = []
  const parse: ParseCall = async (params) => {
    const asked = JSON.stringify(params.messages)
    calls.push(/shot/i.test(asked) && !/<ask>/.test(asked.slice(0, 200)) ? 'shots' : 'script')
    if (calls.length === 1) return { parsed_output: scriptOf(lines), stop_reason: 'end_turn', usage: { input_tokens: 3500, output_tokens: 4000 } }
    return { parsed_output: null, stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 100 } }
  }
  return { deps: { parse, progress: () => undefined } as unknown as MakeRunDeps, calls }
}

describe('a script written at make time, longer than its quote', () => {
  it('stops before the shot list, keeps the script, and quotes the rest at its real length', async () => {
    const draft = await eightMinutes()
    const quoted = draft.quote.counts.scenes
    const lines = quoted + 18
    expect(phrasesAndSections(scriptOf(lines).sections[0].paragraphs.join(' ')).phrases).toHaveLength(lines)
    const r = run(lines)
    const err = await makeVideo(draft, r.deps).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Stopped)
    const stopped = err as Stopped
    // Only the script was asked for: no part of the shot list.
    expect(r.calls).toHaveLength(1)
    expect(stopped.message).toMatch(
      new RegExp(
        `^Claude wrote the script with ${lines} lines, more than the ${quoted} the quote counted, so the shots would cost more than quoted\\. I stopped before planning them: only the script was paid for \\(\\$0\\.\\d\\d of the \\$\\d+\\.\\d\\d quoted\\), and it is kept\\. This quote is for the rest, at its real length\\.$`
      )
    )
    // The script is kept, and paid for once: the quote for the rest counts its real lines, and never goes ahead unasked.
    const rest = stopped.resume
    expect(rest.unwritten).toBeUndefined()
    expect(rest.phrases).toHaveLength(lines)
    expect(rest.spentBefore).toBeCloseTo(make.spent + stopped.spent, 4)
    expect(stopped.spent).toBeGreaterThan(0)
    const again = quoteDraft(rest, { ...deps, settings: { cap: null, autoUnder: 50 } })
    expect(again.counts.scenes).toBe(lines)
    expect(again.auto).toBe(false)
    expect(again.lines.some((l) => l.what === 'The script')).toBe(false)
    expect(again.lines.find((l) => l.by.startsWith('Claude'))?.cost).toBeCloseTo(shotListCost(lines, again.counts.narrationSeconds), 4)
  })

  it('goes on to the shot list when the script fits its quote', async () => {
    const draft = await eightMinutes()
    const r = run(draft.quote.counts.scenes)
    const err = await makeVideo(draft, r.deps).catch((e: unknown) => e)
    // Past the check: the shot list was asked for (the run then stops on what this test leaves unset).
    expect(err).toBeInstanceOf(MakeFailed)
    expect(r.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('the shot list held to its quote, part by part', () => {
  const brief = { ...readAsk('make an 8 minute documentary about the 1950s oil boom, stills only')!, seconds: 480 }
  const phrases = (n: number): string[] => Array.from({ length: n }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1}.`)

  it('asks for none of it when it has more parts than the quote priced', async () => {
    let calls = 0
    const parse: ParseCall = async () => {
      calls++
      throw new Error('not asked')
    }
    const budget = new Budget(10)
    const r = await planShots(brief, phrases(81), { sections: [0], outline: [], maxClips: 0, budget, narrationSeconds: 480, quotedParts: shotListParts(80, 480) }, parse)
    expect(r).toEqual({ ok: false, message: 'The script has more lines than the quote counted, so the shot list was not asked for.', cost: 0 })
    expect(calls).toBe(0)
    expect(budget.spent).toBe(0)
  })

  it('holds no part to more than its own line, even with money left over', async () => {
    const quotedParts = shotListParts(75, 480)
    const held: number[] = []
    class Watched extends Budget {
      reserve(amount: number): boolean {
        held.push(amount)
        return super.reserve(amount)
      }
    }
    // Each part answered in full: the phrases it was asked for, each a still.
    const parse: ParseCall = async (params) => {
      const asked = [...JSON.stringify(params.messages).matchAll(/(?:^|\\n)(\d+): /g)].map((m) => Number(m[1]))
      const shot = (i: number) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] })
      return {
        parsed_output: { style: 'Photoreal archival photograph.', palette: 'sepia', era: '1950s', characters: [], shots: asked.map(shot) },
        stop_reason: 'end_turn',
        usage: { input_tokens: 3000, output_tokens: 4000 }
      }
    }
    // 78 lines against a quote for 75: two parts each, the second held to the quote's second part, not its own.
    const own = shotListParts(78, 480)
    expect(own[1]).toBeGreaterThan(quotedParts[1])
    const r = await planShots(brief, phrases(78), { sections: [0], outline: [], maxClips: 0, budget: new Watched(10), narrationSeconds: 480, quotedParts }, parse)
    expect(r.ok).toBe(true)
    expect(held).toHaveLength(2)
    expect(held[0]).toBeLessThanOrEqual(quotedParts[0] + 1e-9)
    expect(held[1]).toBeCloseTo(quotedParts[1], 6)
    expect(held[1]).toBeLessThan(own[1])
  })
})
