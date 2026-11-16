import { describe, expect, it } from 'vitest'
import { contextBudget, estimateTokens, namesIn, VERBATIM_STYLE, vocabulary, whisperPrompt } from './prompt'

describe('what Whisper reads first', () => {
  it('finds the names in a title', () => {
    expect(namesIn('Testing the Pixel 9 Pro against the M4 MacBook Air')).toEqual(['Pixel 9 Pro', 'M4 MacBook Air'])
    expect(namesIn('RTX 5090 review: the fastest card, and the iPhone 16 Pro')).toEqual(['RTX 5090', 'iPhone 16 Pro'])
    expect(namesIn('why I stopped using my camera')).toEqual([])
  })

  it('puts the creator list first, skips camera file names and stays short', () => {
    expect(
      vocabulary({
        title: 'Pixel 9 Pro review raw',
        voice: 'Calm. Mention Nothing Phone when it fits.',
        products: ['ZV-E10']
      })
    ).toEqual(['ZV-E10', 'Pixel 9 Pro', 'Nothing Phone'])
    expect(vocabulary({ title: 'IMG_4031' })).toEqual([])
    expect(vocabulary({ title: 'C0042' })).toEqual([])
    const long = vocabulary({ products: Array.from({ length: 40 }, (_, i) => `Product Name ${i}`) })
    expect(long.join(', ').length).toBeLessThanOrEqual(160)
  })

  it('ends the prompt on the names', () => {
    expect(whisperPrompt([])).toBe(VERBATIM_STYLE)
    expect(whisperPrompt(['RTX 5090'])).toBe(`${VERBATIM_STYLE} RTX 5090.`)
  })

  // Token counts from Whisper's own tokenizer (the lab model's tokenizer.json).
  const COUNTED: [string, number][] = [
    [VERBATIM_STYLE, 53],
    [`${VERBATIM_STYLE} Pixel 9 Pro, M4 MacBook Air, RTX 5090, Sony ZV-E10.`, 73],
    [
      `${VERBATIM_STYLE} iPhone 16 Pro Max, Galaxy S25 Ultra, Snapdragon 8 Elite, OnePlus 13, Nothing Phone (3), Apple Watch Ultra 2, AirPods Pro 2, DJI Osmo Pocket 3.`,
      91
    ],
    [`${VERBATIM_STYLE} Framework Laptop 13, Ryzen AI 9 HX 370, Lunar Lake, Thunderbolt 5, LPDDR5X.`, 83],
    ["Hey everyone, welcome back to the channel. Today I'm reviewing the Pixel 9 Pro and the M4 MacBook Air.", 24],
    ['The RTX 5090 is the fastest graphics card you can buy right now, and it costs $1,999.', 23]
  ]

  it('counts tokens close to the real tokenizer', () => {
    for (const [text, real] of COUNTED) {
      const est = estimateTokens(text)
      expect(Math.abs(est / real - 1), text).toBeLessThan(0.1)
    }
  })

  it('sets a budget the carried prompt fills, so no text carries between windows', () => {
    for (const [text, real] of COUNTED) {
      // whisper.cpp carries min(prompt, budget - 1) tokens and fills the rest of
      // the budget with the window before: nothing, once the prompt reaches it.
      const budget = contextBudget(text)
      expect(budget - 1, text).toBeLessThanOrEqual(real)
      expect(budget, text).toBeGreaterThanOrEqual(Math.min(real, 8))
    }
  })
})
