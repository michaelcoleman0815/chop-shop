import { describe, expect, it } from 'vitest'
import { escapeAss } from './captions'

describe('caption text in ASS', () => {
  it('shows braces and backslashes as typed, never as codes', () => {
    expect(escapeAss('{\\b1}bold')).toBe('\\{\\\u2060b1\\}bold')
    // A word joiner follows every backslash, so libass never reads \N, \n or \h as a code.
    expect(escapeAss('C:\\Notes')).toBe('C:\\\u2060Notes')
    expect(escapeAss('plain words')).toBe('plain words')
  })
})
