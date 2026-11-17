import { describe, expect, it } from 'vitest'
import { captionKind, captionWords } from './caption-words'

/** Caption files in each shape a link can bring, with made-up words. */

const texts = (w: { text: string }[]): string => w.map((x) => x.text).join(' ')

describe('captions as timed words', () => {
  it('reads YouTube’s automatic json3, a time for each word', () => {
    const json3 = JSON.stringify({
      wireMagic: 'pb3',
      events: [
        { tStartMs: 0, dDurationMs: 6000, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
        {
          tStartMs: 400,
          dDurationMs: 3000,
          wWinId: 1,
          segs: [{ utf8: 'this' }, { utf8: ' lamp', tOffsetMs: 300 }, { utf8: ' runs', tOffsetMs: 640 }]
        },
        { tStartMs: 1600, dDurationMs: 1800, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
        { tStartMs: 1600, dDurationMs: 2000, wWinId: 1, segs: [{ utf8: 'hot' }, { utf8: ' [Music]', tOffsetMs: 500 }] }
      ]
    })
    const words = captionWords(json3, 'json3')
    expect(texts(words)).toBe('this lamp runs hot [Music]')
    expect(words.map((w) => w.startSec)).toEqual([0.4, 0.7, 1.04, 1.6, 2.1])
    // A word lasts until the next one begins.
    expect(words[0].endSec).toBeCloseTo(0.7)
    expect(words[4].endSec).toBeLessThanOrEqual(3.6)
  })

  it('shares a written line’s time out among its words', () => {
    const json3 = JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 2000, segs: [{ utf8: 'This lamp runs hot.' }] },
        { tStartMs: 3000, dDurationMs: 1000, segs: [{ utf8: 'Very &amp; hot.' }] }
      ]
    })
    const words = captionWords(json3, 'json3')
    expect(texts(words)).toBe('This lamp runs hot. Very & hot.')
    expect(words[1]).toEqual({ text: 'lamp', startSec: 1.5, endSec: 2 })
    expect(words[4].startSec).toBe(3)
  })

  it('reads YouTube’s automatic WebVTT once, though every line comes twice', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      '00:00:00.400 --> 00:00:01.600 align:start position:0%',
      ' ',
      'this<00:00:00.700><c> lamp</c><00:00:01.040><c> runs</c>',
      '',
      '00:00:01.600 --> 00:00:01.610 align:start position:0%',
      'this lamp runs',
      ' ',
      '',
      '00:00:01.610 --> 00:00:03.000 align:start position:0%',
      'this lamp runs',
      'hot<00:00:02.100><c> today</c>',
      ''
    ].join('\n')
    const words = captionWords(vtt, 'vtt')
    expect(texts(words)).toBe('this lamp runs hot today')
    expect(words.map((w) => w.startSec)).toEqual([0.4, 0.7, 1.04, 1.61, 2.1])
  })

  it('reads written WebVTT and SubRip, a line said again only once', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nThis lamp\n\n00:00:02.000 --> 00:00:03.000\nThis lamp runs hot.\n'
    expect(texts(captionWords(vtt, 'vtt'))).toBe('This lamp runs hot.')
    const srt = '1\n00:00:01,000 --> 00:00:03,000\n<i>This lamp</i> runs hot.\n\n2\n00:00:03,500 --> 00:00:04,500\nVery hot.\n'
    const words = captionWords(srt, 'srt')
    expect(texts(words)).toBe('This lamp runs hot. Very hot.')
    expect(words[0]).toEqual({ text: 'This', startSec: 1, endSec: 1.5 })
    expect(words[4].startSec).toBe(3.5)
  })

  it('knows a caption file by its name, and gives nothing for a broken one', () => {
    expect(captionKind('link.en.json3')).toBe('json3')
    expect(captionKind('link.en-orig.vtt')).toBe('vtt')
    expect(captionKind('link.en.srt')).toBe('srt')
    expect(captionKind('link.info.json')).toBeNull()
    expect(captionWords('{not json', 'json3')).toEqual([])
    expect(captionWords('', 'vtt')).toEqual([])
  })
})
