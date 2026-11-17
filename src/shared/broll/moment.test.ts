import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, wordsFromTranscript } from '../edit'
import { momentsFor, outputOf } from './moment'

/** The planner's brollWanted, read into moments the router can look for. */

const doc = createDoc({
  id: 'd',
  title: 'A new laptop, reviewed',
  source: { id: 's1', path: '/a.mov', durationSec: 20, width: 1920, height: 1080, fps: 30 },
  words: wordsFromTranscript(
    [
      { text: 'Welcome back.', startSec: 0.2, endSec: 1.0 },
      { text: 'The keyboard on this new laptop feels great.', startSec: 2.0, endSec: 5.0 },
      { text: 'Battery life is the next question.', startSec: 6.0, endSec: 9.0 }
    ],
    's1'
  )
})

describe('moments from the planner’s brollWanted', () => {
  it('reads the words said on the beat, its length, the output and the format', () => {
    const beat = currentCut(doc).beats.find((b) => b.from && doc.words.find((w) => w.id === b.from)?.text.includes('keyboard'))
    expect(beat).toBeDefined()
    const [m] = momentsFor(doc, [{ beat: beat!.id, search: 'laptop keyboard close up' }], { niche: 'tech' })
    expect(m).toMatchObject({
      beat: beat!.id,
      said: 'The keyboard on this new laptop feels great.',
      search: 'laptop keyboard close up',
      topic: 'A new laptop, reviewed',
      format: 'long',
      niche: 'tech',
      output: { width: 1920, height: 1080 }
    })
    expect(m.seconds).toBeGreaterThan(2)
  })

  it('leaves out beats that are not there and searches that are empty', () => {
    expect(momentsFor(doc, [{ beat: 'missing', search: 'x' }, { beat: currentCut(doc).beats[0].id, search: '  ' }])).toEqual([])
  })

  it('knows a vertical cut under three minutes is a Short', () => {
    const vertical = commit(doc, [{ op: 'aspect', aspect: 'vertical' }], 'vertical').doc
    const [m] = momentsFor(vertical, [{ beat: currentCut(vertical).beats[0].id, search: 'laptop' }])
    expect(m).toMatchObject({ format: 'short', output: { width: 1080, height: 1920 } })
    expect(outputOf('original', { width: 3840, height: 2160 })).toEqual({ width: 1920, height: 1080 })
  })
})
