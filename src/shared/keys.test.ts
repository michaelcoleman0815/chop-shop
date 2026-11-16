import { describe, expect, it } from 'vitest'
import { detectProvider, wrongKeyMessage } from './keys'

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
