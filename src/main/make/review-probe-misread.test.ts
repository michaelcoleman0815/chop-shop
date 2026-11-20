import { describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import { readMakeAsk } from '../../shared/make/edits'
import type { Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import type { ParseCall } from './claude'
import { changeFor } from './remake'

/**
 * Re-review at b732576, flipped: timing and grade asks of a made video are
 * ordinary edits (null here, so they go to the planner for nothing); a new
 * length is read only from whole-video words, and quoting it asks Claude for
 * nothing and never goes ahead unasked.
 */

const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const prompts = ['A wildcatter beside the derrick at dusk.', 'Roughnecks on the rig floor at night.', 'A boom town main street in 1955.', 'The derrick against a red sky.']
const make = {
  brief: { topic: 'the oil boom', format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', look: 'archival', maps: 'auto', clips: 'auto', images: null, cap: null, inferred: [], ask: 'make a documentary about the oil boom' },
  title: 'Black Gold',
  outline: [],
  script: prompts.join(' '),
  phrases: prompts,
  sections: [0],
  bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: '1950s', characters: [] },
  sheets: [],
  narration: { path: '/m/n.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  shots: prompts.map((p, i) => ({
    phrase: i,
    visual: { kind: 'still', prompt: p, move: 'push-in', characters: [] },
    title: null,
    callouts: [],
    beat: `b${i}`,
    file: `/m/${i}.png`,
    maker: 'google',
    model: 'm',
    cost: 0.05,
    key: null,
    note: null
  })),
  images: 'google',
  clips: null,
  spent: 1
} as unknown as Make
const doc = { id: 'doc1', sources: [{ id: 's1', path: '/m/n.wav' }], words: [], assets: [], make, versions: [] } as unknown as EditDoc
const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }

describe('fixed: ordinary edits are not paid remakes', () => {
  it('reads timing and grade asks as nothing to make again', () => {
    const asks = [
      'make shot 3 two seconds longer',
      'the opening drags, make it 30 seconds tighter',
      'make shot 3 brighter',
      'make the second shot black and white',
      'show the derrick shot longer',
      'make it 30 seconds shorter'
    ]
    const read = asks.map((t) => ({ t, ask: readMakeAsk(make, t) }))
    for (const { t, ask } of read) console.log(`"${t}" -> ${JSON.stringify(ask)}`)
    expect(read.every((r) => r.ask === null)).toBe(true)
  })

  it('still reads a whole new length and a new picture, and quoting a length asks Claude for nothing', async () => {
    expect(readMakeAsk(make, 'make it 8 minutes')).toEqual({ kind: 'length', seconds: 480 })
    expect(readMakeAsk(make, 'make shot 2 a close-up of his hands')).toMatchObject({ kind: 'reshoot', phrase: 1 })
    let claude = 0
    const parse: ParseCall = async () => {
      claude++
      throw new Error('not expected')
    }
    const c = await changeFor(doc, 'make it 8 minutes', null, { parse, can, brand: {}, settings: { cap: null, autoUnder: 25 } })
    if (!c || c.kind !== 'draft') throw new Error(`expected a draft, got ${c?.kind}`)
    console.log(`"make it 8 minutes": Claude calls ${claude}; ${c.reply.text}; auto=${c.draft.quote.auto}; lines: ${c.draft.quote.lines.map((l) => l.what).join('; ')}`)
    expect(claude).toBe(0)
    expect(c.draft.quote.auto).toBe(false)
    expect(c.draft.quote.lines.some((l) => l.what === 'The script')).toBe(true)
  })
})
