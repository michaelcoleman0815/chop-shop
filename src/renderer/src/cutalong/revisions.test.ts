import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, restore, wordsFromTranscript, type EditDoc } from '../../../shared/edit'
import { changedBeats, revisionOf } from './revisions'

describe('revision pages', () => {
  it('colours versions as film scripts do, and starts the colours again after salmon', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => revisionOf(n).name)).toEqual([
      'white',
      'blue',
      'pink',
      'yellow',
      'green',
      'goldenrod',
      'salmon'
    ])
    expect(revisionOf(8)).toEqual({ name: 'white', colour: 'var(--rev-1)', block: 'var(--card)' })
    expect(revisionOf(3).colour).toBe('var(--rev-3)')
    expect(revisionOf(6).block).toBe('var(--block-gold)')
  })

  const base = createDoc({
    id: 'r',
    title: 'R',
    source: { id: 's1', path: '/a.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(
      [
        { text: 'One.', startSec: 0.5, endSec: 0.9 },
        { text: 'Two.', startSec: 2, endSec: 2.4 },
        { text: 'Three.', startSec: 4, endSec: 4.4 }
      ],
      's1'
    )
  })
  const edit = (d: EditDoc, ops: unknown[], summary: string): EditDoc => {
    const r = applyOps(currentCut(d), ops, { words: d.words, sources: d.sources })
    return commit(d, r.applied, summary).doc
  }

  it('marks nothing on the first version', () => {
    expect(changedBeats(base).size).toBe(0)
  })

  it('marks the lines whose words a revision struck, and only those', () => {
    const first = currentCut(base).beats[0]
    const word = base.words.find((w) => w.id === first.from)!
    const d = edit(base, [{ op: 'strike', from: word.id, to: word.id }], 'Struck the first word.')
    expect([...changedBeats(d)]).toEqual([first.id])
  })

  it('compares a restored version with the one before it', () => {
    const first = currentCut(base).beats[0]
    const word = base.words.find((w) => w.id === first.from)!
    let d = edit(base, [{ op: 'strike', from: word.id, to: word.id }], 'v2')
    d = restore(d, 1)
    expect([...changedBeats(d)]).toEqual([first.id])
  })
})
