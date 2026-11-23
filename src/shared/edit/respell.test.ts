import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from './index'

/** A transcript's mishearing set right: "Okay, a loss" was "obey the laws". */
describe('respelling a word', () => {
  const doc = createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/x.mp4', durationSec: 10, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(
      ['Okay,', 'a', 'loss,', 'pay', 'their', 'taxes.'].map((text, i) => ({ text, startSec: 1 + i * 0.3, endSec: 1.25 + i * 0.3 })),
      's1'
    )
  })
  const ids = doc.words.map((w) => w.id)

  it('shows the word as spelled wherever the edit plays it, and keeps what was heard', () => {
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'respell', word: ids[0], text: 'obey' },
        { op: 'respell', word: ids[1], text: 'the' },
        { op: 'respell', word: ids[2], text: 'laws,' }
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    const words = resolveCut(r.cut, doc.words, doc.sources).words.map((w) => w.text)
    expect(words).toEqual(['obey', 'the', 'laws,', 'pay', 'their', 'taxes.'])
    // The transcript itself is unchanged.
    expect(doc.words[0].text).toBe('Okay,')
    // Spelled back as heard, it is no correction at all.
    const back = applyOps(r.cut, [{ op: 'respell', word: ids[0], text: 'Okay,' }], doc).cut
    expect(back.spelled).toEqual({ [ids[1]]: 'the', [ids[2]]: 'laws,' })
  })

  it('says so when the word is not there', () => {
    const r = applyOps(currentCut(doc), [{ op: 'respell', word: 'w999', text: 'x' }], doc)
    expect(r.rejected[0].reason).toBe('There is no word w999.')
  })
})
