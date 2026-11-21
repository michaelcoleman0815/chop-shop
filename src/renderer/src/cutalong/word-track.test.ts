import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, wordsFromTranscript, type EditDoc } from '../../../shared/edit'
import { toggleLabel, toggleOps, trackWords } from './word-track'

const base = createDoc({
  id: 'w',
  title: 'W',
  source: { id: 's1', path: '/a.mov', durationSec: 10, width: 1080, height: 1920, fps: 30 },
  words: wordsFromTranscript(
    [
      { text: 'Um,', startSec: 0.2, endSec: 0.4 },
      { text: 'grace', startSec: 0.5, endSec: 0.8 },
      { text: 'looks', startSec: 0.8, endSec: 1.1 },
      { text: 'like', startSec: 1.1, endSec: 1.3 },
      { text: 'a', startSec: 1.3, endSec: 1.4 },
      { text: 'table.', startSec: 1.4, endSec: 1.9 }
    ],
    's1'
  )
})
const edit = (d: EditDoc, ops: unknown[]): EditDoc =>
  commit(d, applyOps(currentCut(d), ops, { words: d.words, sources: d.sources }).applied, 'edit').doc
const id = (d: EditDoc, text: string): string => d.words.find((w) => w.text === text)!.id

describe('the word track', () => {
  it('lists every word the cut covers, in order, struck ones included', () => {
    const d = edit(base, [{ op: 'strike', from: id(base, 'Um,'), to: id(base, 'Um,') }])
    const words = trackWords(d)
    expect(words.map((w) => w.text)).toEqual(['Um,', 'grace', 'looks', 'like', 'a', 'table.'])
    expect(words.filter((w) => w.struck).map((w) => w.text)).toEqual(['Um,'])
    expect(new Set(words.map((w) => w.beat)).size).toBeGreaterThan(0)
  })

  it('cuts a run of neighbouring words as one strike', () => {
    const ops = toggleOps(base, [id(base, 'a'), id(base, 'like')])
    expect(ops).toEqual([{ op: 'strike', from: id(base, 'like'), to: id(base, 'a') }])
    expect(toggleLabel(base, [id(base, 'a'), id(base, 'like')])).toBe('Cut 2 words')
  })

  it('brings struck words back, and keeps runs apart where they are not neighbours', () => {
    const d = edit(base, [{ op: 'strike', from: id(base, 'Um,'), to: id(base, 'Um,') }])
    const ops = toggleOps(d, [id(d, 'Um,'), id(d, 'table.')])
    expect(ops).toEqual([
      { op: 'unstrike', from: id(d, 'Um,'), to: id(d, 'Um,') },
      { op: 'strike', from: id(d, 'table.'), to: id(d, 'table.') }
    ])
    expect(toggleLabel(d, [id(d, 'Um,')])).toBe('Bring back 1 word')
    expect(toggleLabel(d, [id(d, 'Um,'), id(d, 'table.')])).toBe('Cut 1 and bring back 1 words')
  })
})
