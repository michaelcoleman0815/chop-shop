import { describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import { readMakeAsk } from '../../shared/make/edits'
import type { Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import type { ParseCall } from './claude'
import { changeFor } from './remake'

/**
 * Regression for the money review's fourth finding: ordinary edits of a
 * made video stay ordinary edits. Timing and grade asks are never a new
 * picture, a length is read only of the whole video, a new length is quoted
 * before Claude writes a word of it, and nothing read from typed words goes
 * ahead without its button.
 */

const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const prompts = [
  'A wildcatter beside the derrick at dusk.',
  'Roughnecks on the rig floor at night.',
  'A boom town main street in 1955.',
  'The derrick against a red sky.'
]
const make = {
  brief: {
    topic: 'the oil boom',
    format: 'documentary',
    seconds: 120,
    voice: local,
    from: 'topic',
    aspect: 'wide',
    cap: null,
    look: 'archival',
    maps: 'auto',
    clips: 'auto',
    images: null,
    inferred: [],
    ask: ''
  },
  title: 'Black Gold',
  outline: ['The boom'],
  script: prompts.join(' '),
  phrases: prompts,
  sections: [0],
  bible: { style: 's', palette: 'p', era: 'e', characters: [] },
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
const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }

describe('asks of a made video', () => {
  it('reads timing and grade asks as ordinary edits, at no cost', () => {
    for (const t of [
      'make shot 3 two seconds longer',
      'the opening drags, make it 30 seconds tighter',
      'make shot 3 brighter',
      'make the second shot black and white',
      'show the derrick shot longer',
      'make it 30 seconds shorter',
      'make this shot warmer and a bit slower'
    ])
      expect(readMakeAsk(make, t), t).toBeNull()
  })

  it('still reads what really makes something again', () => {
    expect(readMakeAsk(make, 'make shot 3 a close-up of his hands')).toEqual({
      kind: 'reshoot',
      phrase: 2,
      want: 'close-up of his hands'
    })
    expect(readMakeAsk(make, 'make shot 2 again')).toEqual({ kind: 'reshoot', phrase: 1, want: '' })
    expect(readMakeAsk(make, 'make it 8 minutes')).toEqual({ kind: 'length', seconds: 480 })
    expect(readMakeAsk(make, 'cut it down to 90 seconds')).toEqual({ kind: 'length', seconds: 90 })
    expect(readMakeAsk(make, 'make it a 5 minute video')).toEqual({ kind: 'length', seconds: 300 })
    expect(readMakeAsk(make, 'make it an explainer instead')).toEqual({ kind: 'restyle', format: 'explainer' })
    expect(readMakeAsk(make, 'use a different voice')?.kind).toBe('voice')
  })

  it('quotes a new length before Claude writes a word, and never goes ahead with it unasked', async () => {
    let claude = 0
    const parse: ParseCall = async () => {
      claude++
      throw new Error('Claude is not asked before the quote')
    }
    const doc = {
      id: 'doc1',
      sources: [{ id: 's1', path: '/m/n.wav' }],
      words: [],
      make,
      versions: []
    } as unknown as EditDoc
    const change = await changeFor(doc, 'make it 5 minutes', null, {
      parse,
      can,
      brand: { voice: 'dry and warm', name: 'Oil Country' },
      settings: { cap: null, autoUnder: 50 }
    })
    expect(claude).toBe(0)
    if (change?.kind !== 'draft') throw new Error('not a draft')
    expect(change.draft.unwritten).toEqual({ voice: 'dry and warm', name: 'Oil Country' })
    expect(change.draft.brief.seconds).toBe(300)
    expect(change.draft.quote.lines.some((l) => l.what === 'The script')).toBe(true)
    expect(change.draft.quote.auto).toBe(false)
    expect(change.reply.text).toMatch(
      /^I'll write it again at 5 minutes and make it new: about \d+ shots, for up to \$\d+\.\d\d\.$/
    )
    expect(change.reply.aside).toMatch(/Nothing is written until you press its button\./)
    // Ordinary edits are not changes of a made video at all: the planner has them, for nothing.
    expect(
      await changeFor(doc, 'make shot 3 two seconds longer', null, {
        parse,
        can,
        brand: {},
        settings: { cap: null, autoUnder: 50 }
      })
    ).toBeNull()
  })
})
