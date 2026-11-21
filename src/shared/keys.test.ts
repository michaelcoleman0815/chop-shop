import { describe, expect, it } from 'vitest'
import { anthropicKeyIn, detectProvider, wrongKeyMessage } from './keys'

describe('API keys', () => {
  it('tells keys apart by their prefix', () => {
    expect(detectProvider('sk-ant-api03-abc')).toBe('anthropic')
    expect(detectProvider('  sk-ant-api03-abc  ')).toBe('anthropic')
    expect(detectProvider('sk-proj-abc')).toBe('openai')
    expect(detectProvider('AIzaSyabc')).toBe('google')
    expect(detectProvider('something-else')).toBe('unknown')
    expect(detectProvider(null)).toBe('unknown')
  })

  it('only turns away keys that are plainly from another service', () => {
    expect(wrongKeyMessage('openai')).toBe(
      'That looks like an OpenAI key. Cutalong needs one from Anthropic, which starts sk-ant-.'
    )
    expect(wrongKeyMessage('google')).toMatch(/^That looks like a Google key\./)
    expect(wrongKeyMessage('anthropic')).toBeNull()
    expect(wrongKeyMessage('unknown')).toBeNull()
  })
})

describe('a key copied from the Console', () => {
  it('is taken only when the clipboard holds one Anthropic key and nothing else', () => {
    const key = `sk-ant-api03-${'a1B2_c3-'.repeat(12)}`
    expect(anthropicKeyIn(key)).toBe(key)
    expect(anthropicKeyIn(`  ${key}\n`)).toBe(key)
    // Anything else on the clipboard is never read back: a sentence with a key in it, another company's, nothing.
    expect(anthropicKeyIn(`my key is ${key}`)).toBeNull()
    expect(anthropicKeyIn(`${key} ${key}`)).toBeNull()
    expect(anthropicKeyIn('sk-proj-abcdefghijklmnopqrstuvwxyz')).toBeNull()
    expect(anthropicKeyIn('sk-ant-short')).toBeNull()
    expect(anthropicKeyIn('')).toBeNull()
    expect(anthropicKeyIn(null)).toBeNull()
  })
})
