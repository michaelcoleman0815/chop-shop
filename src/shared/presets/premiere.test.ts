import { describe, expect, it } from 'vitest'
import { premiereReply, type PremiereFacts } from './premiere'

const facts: PremiereFacts = {
  cuts: 14,
  recordings: 2,
  cutaways: 3,
  music: true,
  sounds: 2,
  markers: 5,
  leftOut: ['the look', '2 camera moves', '1 transition']
}

describe('the reply to /premiere', () => {
  it('says where the project opened, what it has, and what stayed in Cutalong', () => {
    const r = premiereReply({
      xmlPath: '/Users/you/Movies/Cutalong/Plan v4.xml',
      srtPath: '/Users/you/Movies/Cutalong/Plan v4 captions.srt',
      opened: 'Adobe Premiere Pro 2026',
      facts
    })
    expect(r.text).toBe(
      'I opened Plan v4.xml in Premiere: 14 cuts from 2 recordings, 3 cutaways, the music and 2 sound effects, on your own files. The captions are in Plan v4 captions.srt.'
    )
    expect(r.aside).toBe('The look, 2 camera moves and 1 transition stay in Cutalong; markers in Premiere show where.')
  })

  it('says where the project is when there is no Premiere to open it in, and keeps to what there is', () => {
    const r = premiereReply({
      xmlPath: 'C:\\Users\\you\\Videos\\Talk v2.xml',
      srtPath: null,
      opened: null,
      facts: { cuts: 1, recordings: 1, cutaways: 0, music: false, sounds: 0, markers: 0, leftOut: [] }
    })
    expect(r.text).toBe(
      'Talk v2.xml is ready for Premiere: 1 cut from your recording, on your own files. I didn’t find Premiere on this computer, so it is beside your exports.'
    )
    expect(r.aside).toBeNull()
  })

  it('agrees with what stayed behind, one thing or several', () => {
    const one = (leftOut: string[], markers = 1): string | null =>
      premiereReply({ xmlPath: '/a.xml', srtPath: null, opened: 'Premiere', facts: { ...facts, leftOut, markers } })
        .aside
    expect(one(['the look'])).toBe('The look stays in Cutalong; markers in Premiere show where.')
    expect(one(['1 speed change'])).toBe('1 speed change stays in Cutalong; markers in Premiere show where.')
    expect(one(['12 graphics'])).toBe('12 graphics stay in Cutalong; markers in Premiere show where.')
    expect(one(['the voice polish'], 0)).toBe('The voice polish stays in Cutalong.')
  })
})
