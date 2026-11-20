import { describe, expect, it } from 'vitest'
import { readAsk } from './brief'
import { readMakeAsk } from './edits'
import { quoteWords, unplacedChange, withoutTurnedDown } from './questions'
import type { Make } from './schema'

/**
 * What words turn down is never what they ask for: "don't make it 3 minutes", "I don't want it 3 minutes" and "don't use
 * a British voice" are read the way "not 3 minutes" is, in a reply to a quote and in a change of a made video, while a
 * change said beside them ("not 10 minutes, make it 2") and a shot's own description ("again without the people") keep
 * their words.
 */

const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const make = {
  v: 1,
  brief: { ...readAsk('make a 2 minute documentary about the 1950s oil boom')!, voice: local, from: 'topic', seconds: 120 },
  title: 'Black Gold',
  outline: ['The boom'],
  script: 'In 1950 the derricks rose.',
  phrases: ['In 1950 the derricks rose.', 'The men worked through the night.', 'The town woke slowly.'],
  sections: [0],
  bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: 'West Texas, 1950s', characters: [] },
  shots: [0, 1, 2].map((i) => ({ phrase: i, visual: { kind: 'still', prompt: `A derrick ${i + 1}.`, move: 'push-in', characters: [] }, title: null, callouts: [], beat: `b${i}`, file: `/made/${i}.png`, maker: 'google', model: 'm', cost: 0.05, key: null, note: null })),
  sheets: [],
  narration: { path: '/made/narration.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  images: 'google',
  clips: 'google',
  spent: 1.4
} as unknown as Make

describe('negations in a reply to a quote', () => {
  it('takes out what is turned down, with "don’t", "do not", "never", "no" and "without" alike', () => {
    for (const said of ["don't make it 3 minutes", 'do not make it 3 minutes', "I don't want it 3 minutes", "don't use a British voice", 'never make it 3 minutes', 'without a British voice'])
      expect(quoteWords(said), said).not.toMatch(/3 minutes|British|voice/)
    expect(withoutTurnedDown('don’t use a British voice')).toBe('')
    expect(withoutTurnedDown('do not make it 3 minutes')).toBe('')
  })

  it('keeps a change said beside one, and what "why don’t you" asks for', () => {
    expect(quoteWords('not 10 minutes, make it 2')).toMatch(/make it 2/)
    expect(quoteWords("don't make it 10 minutes, make it 2 minutes")).toBe(', make it 2 minutes'.replace(/^[\s,;]+/, ''))
    expect(quoteWords("why don't you make it 3 minutes")).toMatch(/make it 3 minutes/)
  })

  it('says why a quote did not change when what it was told turns something down', () => {
    expect(unplacedChange("don't make it longer than 3 minutes")).toBe(
      'The quote hasn’t changed: “don\'t make it longer than 3 minutes” says what it shouldn’t be, not what to change it to, so it stays as it was. Say what you want instead, like “make it 2 minutes”, or press its button to make it as it is.'
    )
    expect(unplacedChange('make it shorter')).toMatch(/doesn’t say how long/)
  })
})

describe('negations in a change of a made video', () => {
  it('never asks for the voice, the style or the length it turns down', () => {
    expect(readMakeAsk(make, "don't use a British voice")).toBeNull()
    expect(readMakeAsk(make, "don't make it an explainer")).toBeNull()
    expect(readMakeAsk(make, "don't make it 3 minutes")).toBeNull()
  })

  it('still reads one said beside it', () => {
    const voice = readMakeAsk(make, 'not Michael, use a British voice')
    expect(voice).toMatchObject({ kind: 'voice' })
    expect(voice?.kind === 'voice' ? voice.voice?.id : null).not.toBe('am_michael')
    expect(readMakeAsk(make, 'make it 3 minutes')).toEqual({ kind: 'length', seconds: 180 })
  })

  it('keeps every word of a shot’s own description', () => {
    const ask = readMakeAsk(make, 'make shot 2 again without the people')
    expect(ask).toMatchObject({ kind: 'reshoot', phrase: 1 })
  })
})
