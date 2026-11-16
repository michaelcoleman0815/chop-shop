import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildPair, type LabelledPair } from '../shared/learn'
import { readPairs, removePair, savePair } from './learn-store'

/** The test set on disk: labels and metadata only, one small file per video. */

function pair(id: string): LabelledPair {
  const words = ['so', 'today', 'I', 'want'].map((text, i) => ({
    id: `s1w${i + 1}`,
    source: 's1',
    text,
    startSec: 0.5 + i * 0.4,
    endSec: 0.8 + i * 0.4
  }))
  return buildPair(
    {
      id,
      title: 'The $40 camera setup',
      createdAt: '2026-11-16T00:00:00.000Z',
      recordings: [{ id: 's1', path: '/Users/you/Movies/raw.mov', durationSec: 3, bytes: 812, modifiedAt: null }],
      finished: { path: '/Users/you/Movies/final.mp4', durationSec: 2, bytes: 400, modifiedAt: null }
    },
    [{ id: 's1', durationSec: 3, words, features: null }],
    {
      ok: true,
      pieces: [
        {
          source: 's1',
          rawStart: 0.45,
          rawEnd: 1.25,
          outStart: 0,
          outEnd: 0.8,
          match: 0.91,
          sureStart: true,
          sureEnd: true
        }
      ],
      issues: [],
      matched: 2,
      words: 2,
      unsure: []
    }
  )
}

describe('the test set on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutalong-learn-store-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps each learned video as labels and paths, and reads it back', async () => {
    await savePair(dir, pair('a1'))
    await savePair(dir, pair('b2'))
    const back = await readPairs(dir)
    expect(back.map((p) => p.id)).toEqual(['a1', 'b2'])
    expect(back[0]).toEqual(pair('a1'))
    // Nothing but the labels, the stretches and the paths to the footage.
    const stored = JSON.parse(readFileSync(join(dir, 'a1.json'), 'utf8'))
    expect(Object.keys(stored).sort()).toEqual(
      [
        'breaths',
        'createdAt',
        'cuts',
        'finished',
        'id',
        'issues',
        'matched',
        'pieces',
        'recordings',
        'title',
        'v',
        'words'
      ].sort()
    )
    expect(stored.words[0]).toEqual({
      id: 's1w1',
      source: 's1',
      text: 'so',
      startSec: 0.5,
      endSec: 0.8,
      label: 'kept',
      outStartSec: 0.05,
      outEndSec: 0.35
    })
  })

  it('skips a file it cannot read, and leaves it where it is', async () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ v: 9, id: 'old' }))
    expect((await readPairs(dir)).map((p) => p.id)).toEqual(['a1', 'b2'])
    expect(readdirSync(dir)).toContain('broken.json')
  })

  it('refuses an id that could name a file outside the folder', async () => {
    await expect(savePair(dir, { ...pair('x'), id: '../escape' })).rejects.toThrow()
    await removePair(dir, '../a1')
    expect((await readPairs(dir)).map((p) => p.id)).toContain('a1')
  })

  it('forgets a video', async () => {
    await removePair(dir, 'a1')
    expect((await readPairs(dir)).map((p) => p.id)).toEqual(['b2'])
  })

  it('reads an empty or missing folder as nothing learned', async () => {
    expect(await readPairs(join(dir, 'missing'))).toEqual([])
  })
})
