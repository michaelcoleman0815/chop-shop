import { describe, expect, it } from 'vitest'
import {
  addSources,
  applyOps,
  commit,
  createDoc,
  currentCut,
  currentVersion,
  mergeExtension,
  restore,
  undoTarget,
  wordsFromTranscript,
  type EditDoc
} from './index'

describe('undo', () => {
  const base = createDoc({
    id: 'u',
    title: 'U',
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

  it('keeps going back with each press, instead of bringing back what the last one undid', () => {
    let d = edit(base, [{ op: 'remove', beats: ['b1'] }], 'v2')
    d = edit(d, [{ op: 'remove', beats: ['b2'] }], 'v3')
    expect(undoTarget(d)).toBe(2)
    d = restore(d, 2)
    expect(currentVersion(d).restores).toBe(2)
    expect(undoTarget(d)).toBe(1)
    d = restore(d, 1)
    expect(undoTarget(d)).toBeNull()
  })

  it('goes back to what an edit was made on, after an undo', () => {
    let d = edit(base, [{ op: 'remove', beats: ['b1'] }], 'v2')
    d = edit(d, [{ op: 'remove', beats: ['b2'] }], 'v3')
    d = restore(d, 2) // v4 is v2 again
    d = edit(d, [{ op: 'remove', beats: ['b3'] }], 'v5') // made on v4, which is v2
    expect(undoTarget(d)).toBe(2)
    d = restore(d, 2)
    expect(undoTarget(d)).toBe(1)
  })

  it('reads restores saved before they were marked, from their summary', () => {
    let d = edit(base, [{ op: 'remove', beats: ['b1'] }], 'v2')
    d = edit(d, [{ op: 'remove', beats: ['b2'] }], 'v3')
    d = restore(d, 2)
    const old = { ...d, versions: d.versions.map(({ restores: _r, ...v }) => v) }
    expect(undoTarget(old)).toBe(1)
  })
})

describe('footage that comes in while the person keeps editing', () => {
  const source = (id: string, path: string) => ({ id, path, durationSec: 10, width: 1920, height: 1080, fps: 30 })
  const before = createDoc({
    id: 'm',
    title: 'M',
    source: source('s1', '/a.mov'),
    words: wordsFromTranscript([{ text: 'First.', startSec: 0.5, endSec: 0.9 }, { text: 'Second.', startSec: 3, endSec: 3.4 }], 's1')
  })
  const more = wordsFromTranscript([{ text: 'More.', startSec: 1, endSec: 1.4 }], 's2').map((w) => ({
    ...w,
    id: `s2${w.id}`
  }))
  const extended = addSources(before, [source('s2', '/b.mov')], more, 'b.mov is on the end.')

  it('keeps the versions made in the meantime and puts the footage on the end of the edit as it is now', () => {
    const r = applyOps(currentCut(before), [{ op: 'speed', beats: ['b1'], speed: 2 }], {
      words: before.words,
      sources: before.sources
    })
    const current = commit(before, r.applied, 'Beat 1 plays at double speed.').doc
    const merged = mergeExtension(current, before, extended)
    expect(merged.versions.map((v) => v.summary)).toEqual([
      before.versions[0].summary,
      'Beat 1 plays at double speed.',
      'b.mov is on the end.'
    ])
    const cut = currentCut(merged)
    expect(cut.beats.find((b) => b.id === 'b1')?.treatment.speed).toBe(2)
    expect(cut.beats.some((b) => b.source === 's2')).toBe(true)
    expect(merged.sources.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(merged.words.some((w) => w.id === 's2w1')).toBe(true)
  })

  it('is the new edit as it came when nothing changed in between', () => {
    expect(mergeExtension(before, before, extended)).toBe(extended)
  })
})
