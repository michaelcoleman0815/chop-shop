import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

/** The plain-code digest is Node's, byte for byte: a key's fingerprint is the same on a phone. */
describe('sha256Hex', () => {
  it('matches Node’s digest for the empty string, block edges, keys and words in other scripts', () => {
    const texts = [
      '',
      'abc',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(119),
      'a'.repeat(1000),
      'sk-ant-api03-test',
      'sk-ant-api03-' + 'x'.repeat(95),
      'Grüße, 東京, 🎬'
    ]
    for (const text of texts) expect(sha256Hex(text)).toBe(createHash('sha256').update(text).digest('hex'))
  })
})
