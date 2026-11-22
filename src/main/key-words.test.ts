import { describe, expect, it } from 'vitest'
import { cleanHook, keyWordsRequest, readKeyWords } from './key-words'

describe('the words a preacher leans on', () => {
  const clips = [
    'even if you were the one who let go God can restore it'.split(' '),
    'we are more than conquerors'.split(' ')
  ]

  it('numbers each clip’s words for Claude', () => {
    const asked = keyWordsRequest(clips)
    expect(asked).toContain('<clip n="0">\n0:even 1:if 2:you')
    expect(asked).toContain('<clip n="1">\n0:we 1:are 2:more 3:than 4:conquerors\n</clip>')
  })

  it('keeps real words only, in order, in four runs of at most four words', () => {
    const read = readKeyWords(
      {
        clips: [
          { clip: 0, words: [8, 0, 1, 1, 40, -1, 7, 11, 10], hook: '"God Can Restore What You Lost."', open: 2, mood: 'hopeful' },
          { clip: 1, words: [2, 3, 4], hook: 'We Are More Than Conquerors Through Him Who Loved Us', open: 3, mood: 'tense' }
        ]
      },
      clips
    )
    // In order, the stray numbers gone: runs 0-1, 7, 8 and 10-11 are four runs.
    expect(read.keys[0]).toEqual([0, 1, 7, 8, 10, 11])
    expect(read.keys[1]).toEqual([2, 3, 4])
    // A fifth run is left out, and a run stops at four words.
    const many = readKeyWords(
      { clips: [{ clip: 0, words: [0, 1, 2, 3, 4, 5, 7, 9, 11, 12], hook: '', open: 0, mood: 'curious' }] },
      [Array.from({ length: 14 }, (_, i) => `w${i}`)]
    )
    expect(many.keys[0]).toEqual([0, 1, 2, 3, 7, 9, 11, 12])
    // An opening within the first quarter is kept; one later is not (five words: the first word only).
    expect(read.opens).toEqual([2, 0])
    // Each clip's mood for its music, as Claude chose it.
    expect(read.moods).toEqual(['hopeful', 'tense'])
    // Hooks lose their quotes and full stop, and stop at eight words.
    expect(read.hooks).toEqual(['God Can Restore What You Lost', 'We Are More Than Conquerors Through Him Who'])
  })

  it('leaves a clip Claude said nothing of with none, and curious music', () => {
    expect(readKeyWords({ clips: [] }, clips)).toEqual({ keys: [[], []], hooks: ['', ''], opens: [0, 0], moods: ['curious', 'curious'] })
    expect(cleanHook('  Healed   in  a kitchen. ')).toBe('Healed in a kitchen')
  })
})
