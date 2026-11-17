import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCRIPTION } from './brand'
import {
  checkWriting,
  fillDescription,
  isShort,
  readCues,
  srtText,
  TAGS_MAX,
  TAGS_MIN,
  titlesFile,
  uploadMessage,
  uploadSetMessage,
  vttText,
  withoutRepeats,
  writeLocally,
  type UploadKit
} from './upload'

const TALK =
  'This phone lasts two whole days on one charge. So the battery is the real story here. ' +
  'The Pixel 9 Pro battery held 41 percent after a full day of video. Okay, the camera is better too. ' +
  'The camera shoots cleaner video at night than last year. The screen is brighter outside. ' +
  'Battery life, camera and screen: the Pixel 9 Pro is worth it if the battery matters to you.'

const brand = { name: 'Field Notes', products: ['Pixel 9 Pro'] }

describe('caption files', () => {
  const cues = [
    { start: 0.49, end: 1.89, text: 'This phone lasts' },
    { start: 1.89, end: 3.7, text: 'two whole days.' },
    { start: 3661.005, end: 3662.5, text: 'An hour in' }
  ]

  it('writes SRT and WebVTT to the millisecond, and reads them back', () => {
    const srt = srtText(cues)
    expect(srt.split('\n').slice(0, 4)).toEqual(['1', '00:00:00,490 --> 00:00:01,890', 'This phone lasts', ''])
    expect(srt).toContain('01:01:01,005 --> 01:01:02,500')
    const vtt = vttText(cues)
    expect(vtt.startsWith('WEBVTT\n\n00:00:00.490 --> 00:00:01.890\nThis phone lasts\n')).toBe(true)
    for (const back of [readCues(srt), readCues(vtt)]) {
      expect(back.map((c) => c.text)).toEqual(cues.map((c) => c.text))
      back.forEach((c, i) => {
        expect(c.start).toBeCloseTo(cues[i].start, 3)
        expect(c.end).toBeCloseTo(cues[i].end, 3)
      })
    }
  })
})

describe('the description', () => {
  const parts = {
    opening: 'The Pixel 9 Pro lasts two days. Here is how.',
    chapters: ['0:00 Battery', '0:42 Camera', '1:30 Screen'],
    credits: ['- City at night, 4K · Nightfilm · https://www.youtube.com/watch?v=a1 · 0:30-0:38']
  }

  it('fills the default template', () => {
    expect(fillDescription(DEFAULT_DESCRIPTION, parts)).toBe(
      'The Pixel 9 Pro lasts two days. Here is how.\n\n0:00 Battery\n0:42 Camera\n1:30 Screen\n\nCredits\n- City at night, 4K · Nightfilm · https://www.youtube.com/watch?v=a1 · 0:30-0:38'
    )
  })

  it('keeps the brand’s own lines where the template puts them', () => {
    const template =
      '{opening}\n\nThis video is sponsored by Acme. 10% off at acme.example/fieldnotes\n\n{chapters}\n\nInstagram: @fieldnotes\nNewsletter: fieldnotes.example\n\n{credits}'
    const text = fillDescription(template, parts)
    expect(text.indexOf('sponsored by Acme')).toBeLessThan(text.indexOf('0:00 Battery'))
    expect(text.indexOf('Newsletter')).toBeLessThan(text.indexOf('Credits'))
  })

  it('puts in what a template leaves out, and takes empty parts with their lines', () => {
    const text = fillDescription('Follow me: @fieldnotes', parts)
    expect(text.startsWith('The Pixel 9 Pro lasts two days.')).toBe(true)
    expect(text).toContain('0:00 Battery')
    expect(text.endsWith('0:30-0:38')).toBe(true)
    expect(fillDescription(DEFAULT_DESCRIPTION, { opening: 'Just this.', chapters: [], credits: [] })).toBe('Just this.')
    expect(fillDescription('', { opening: 'Just this.', chapters: [], credits: [] })).toBe('Just this.')
  })

  it('stays within YouTube’s 5,000 characters', () => {
    const long = fillDescription(`{opening}\n\n${'Links. '.repeat(900)}\n\n{credits}`, parts)
    expect(long.length).toBeLessThanOrEqual(5000)
  })
})

describe('writing them from the words, on this computer', () => {
  const words = TALK.split(' ')

  it('gives three titles, an opening of a sentence or two, and 10 to 15 tags, from what is said', () => {
    const w = writeLocally({ words, chapters: ['Battery', 'Camera', 'Screen'], brand, kind: 'tech', short: false, durationSec: 92 })
    expect(w.titles).toHaveLength(3)
    expect(new Set(w.titles.map((t) => t.toLowerCase())).size).toBe(3)
    for (const t of w.titles) {
      expect(t.length).toBeGreaterThan(8)
      expect(t.length).toBeLessThanOrEqual(100)
    }
    // The hook line opens it, without its full stop.
    expect(w.titles[0]).toBe('This phone lasts two whole days on one charge')
    expect(w.opening).toBe('This phone lasts two whole days on one charge. It covers battery, camera and screen.')
    expect(w.tags.length).toBeGreaterThanOrEqual(TAGS_MIN)
    expect(w.tags.length).toBeLessThanOrEqual(TAGS_MAX)
    expect(w.tags[0]).toBe('Pixel 9 Pro')
    expect(w.tags.map((t) => t.toLowerCase())).toEqual(expect.arrayContaining(['battery', 'camera', 'tech']))
    for (const stop of ['the', 'is', 'so', 'okay']) expect(w.tags.map((t) => t.toLowerCase())).not.toContain(stop)
  })

  it('reads a line said twice in a row once, as the retake leaves it, and tags things, not how they were done', () => {
    const said = (
      'This phone lasts two whole days on one charge. The camera is the real The camera is the real upgrade this year. ' +
      'I tested it for a week, in daylight, at night, and in the rain. Here is what surprised me most about the zoom.'
    ).split(' ')
    expect(withoutRepeats(said).slice(9, 16).join(' ')).toBe('The camera is the real upgrade this')
    const w = writeLocally({ words: said, chapters: [], brand: { name: 'Tech Corner', products: [] }, kind: 'tech', short: false, durationSec: 21 })
    expect(w.titles).toEqual([
      'This phone lasts two whole days on one charge',
      'The camera is the real upgrade this year',
      'I tested it for a week, in daylight, at night, and in the rain'
    ])
    // Nothing is said twice once the retake reads once, so the opening is the hook alone.
    expect(w.opening).toBe('This phone lasts two whole days on one charge.')
    expect(w.tags).toEqual(expect.arrayContaining(['camera', 'phone', 'upgrade', 'charge']))
    // A capital that only opens a sentence is not a name, and a word that says how is not a tag.
    for (const not of ['Here', 'here', 'tested', 'surprised', 'real']) expect(w.tags).not.toContain(not)
  })

  it('makes the same for the same words', () => {
    const input = { words, chapters: [], brand, kind: null, short: true, durationSec: 40 }
    expect(writeLocally(input)).toEqual(writeLocally(input))
  })
})

describe('checking what Claude wrote', () => {
  const local = writeLocally({ words: TALK.split(' '), chapters: [], brand, kind: 'tech', short: false, durationSec: 92 })

  it('keeps titles within YouTube’s length, each once, tags without hashes, and fills a short list', () => {
    const r = checkWriting(
      {
        titles: ['Two days on one charge', 'two days on one charge', 'x'.repeat(120), '“The Pixel 9 Pro, honestly”'],
        opening: 'I lived with the Pixel 9 Pro for a week. The battery is the story. And here is a third sentence.',
        tags: ['#pixel 9 pro', 'battery life', 'Pixel 9 Pro', 'camera test', 'phone review', 'google', 'android']
      },
      local
    )
    expect(r.used).toBe(true)
    expect(r.writing.titles).toEqual(['Two days on one charge', 'The Pixel 9 Pro, honestly', local.titles[0]])
    expect(r.writing.opening).toBe('I lived with the Pixel 9 Pro for a week. The battery is the story.')
    expect(r.writing.tags.slice(0, 6)).toEqual(['pixel 9 pro', 'battery life', 'camera test', 'phone review', 'google', 'android'])
    expect(r.writing.tags.length).toBe(TAGS_MIN)
  })

  it('uses what was made here when the answer does not hold up', () => {
    expect(checkWriting({ titles: 'no', opening: 1 }, local)).toEqual({ writing: local, used: false })
    const thin = checkWriting({ titles: ['One'], opening: 'Go to https://spam.example now.', tags: [] }, local)
    expect(thin.used).toBe(false)
    expect(thin.writing.opening).toBe(local.opening)
  })
})

describe('in the chat', () => {
  const kit: UploadKit = {
    titles: ['Two days on one charge', 'The Pixel 9 Pro, honestly', 'Battery, camera and screen'],
    description: 'Opening.\n\n0:00 Battery',
    tags: Array.from({ length: 14 }, (_, i) => `tag ${i + 1}`),
    by: 'claude',
    why: null,
    captions: { pages: 18, burned: true },
    chapters: 3,
    short: false,
    credits: 1,
    files: {
      srt: '/x/Talk v3.srt',
      vtt: '/x/Talk v3.vtt',
      description: '/x/Talk v3 description.txt',
      titles: '/x/Talk v3 titles and tags.txt'
    }
  }

  it('says what is ready in a sentence, with three facts and the rest behind Details', () => {
    const m = uploadMessage(kit)
    expect(m.text).toBe(
      "Ready to upload. Claude wrote three titles, the description's opening and 14 tags from what you say, and the captions match the ones in the picture."
    )
    expect(m.chips).toEqual(['3 titles', '14 tags', '3 chapters'])
    expect(m.details.map((d) => d.label)).toEqual(['Title 1', 'Title 2', 'Title 3', 'Description', 'Tags', 'Files'])
    expect(m.details.find((d) => d.label === 'Files')?.value).toBe(
      'Talk v3.srt\nTalk v3.vtt\nTalk v3 description.txt\nTalk v3 titles and tags.txt'
    )
    expect(m.aside).toBeNull()
  })

  it('says when they were made without Claude, and why', () => {
    expect(uploadMessage({ ...kit, by: 'local', why: 'no-key' }).aside).toBe(
      'I made these on this Mac without Claude. With your Anthropic key in Settings, Claude writes them.'
    )
    expect(uploadMessage({ ...kit, by: 'local', why: 'off' }).aside).toBe(
      'I made these on this Mac without Claude, as Settings asks.'
    )
    const short = uploadMessage({ ...kit, by: 'local', why: 'failed', short: true, chapters: 0 })
    expect(short.text.startsWith('Ready to upload. I wrote three titles')).toBe(true)
    expect(short.aside).toBe(
      "Claude couldn't write them this time, so I made them from your words on this Mac. It's a Short, so the description has no chapters."
    )
    for (const m of [uploadMessage(kit), short]) expect(`${m.text} ${m.aside}`).not.toMatch(/!/)
  })

  it('names the phone it was made on, on a phone', () => {
    expect(uploadMessage({ ...kit, by: 'local', why: 'no-key' }, 'this phone').aside).toBe(
      'I made these on this phone without Claude. With your Anthropic key in Settings, Claude writes them.'
    )
    const off = { ...kit, by: 'local' as const, why: 'off' as const }
    expect(uploadSetMessage([{ name: 'A', kit: off }, { name: 'B', kit: off }], 'this phone').aside).toBe(
      'I made these on this phone without Claude, as Settings asks.'
    )
  })

  it('says what every clip of an Export all needs in one reply, each clip’s titles behind Details', () => {
    const clip = (name: string, over: Partial<UploadKit> = {}): { name: string; kit: UploadKit } => ({
      name,
      kit: { ...kit, short: true, chapters: 0, titles: [`${name}, one`, `${name}, two`, `${name}, three`], ...over }
    })
    const six = ['Why we stay', 'The first Sunday', 'A hard year', 'What the choir sang', 'Coffee after', 'Next week'].map(
      (name) => clip(name)
    )
    const m = uploadSetMessage(six)
    expect(m.text).toBe('The 6 clips are ready to upload: captions, a description, titles and tags beside each.')
    expect(m.details).toHaveLength(6)
    expect(m.details[0]).toEqual({ label: 'Why we stay', value: 'Why we stay, one\nWhy we stay, two\nWhy we stay, three' })
    expect(m.aside).toBe('Claude wrote the titles, the openings and the tags from what you say.')
    // A clip with nothing said has no captions; one Claude could not write was made here.
    const quiet = { ...kit.files, srt: null, vtt: null }
    const mixed = uploadSetMessage([
      clip('A', { files: quiet }),
      clip('B', { by: 'local', why: 'failed' }),
      clip('C')
    ])
    expect(mixed.text).toBe(
      'The 3 clips are ready to upload: a description, titles and tags beside each, and captions beside the 2 with words.'
    )
    expect(mixed.aside).toBe("Claude couldn't write one of them, so I made that one from your words on this Mac.")
    const local = uploadSetMessage([clip('A', { by: 'local', why: 'no-key' }), clip('B', { by: 'local', why: 'no-key' })])
    expect(local.aside).toBe(
      'I made these on this Mac without Claude. With your Anthropic key in Settings, Claude writes them.'
    )
    for (const r of [m, mixed, local]) expect(`${r.text} ${r.aside}`).not.toMatch(/!/)
  })

  it('writes the titles and tags file', () => {
    expect(titlesFile(kit)).toBe(
      `Titles\n- Two days on one charge\n- The Pixel 9 Pro, honestly\n- Battery, camera and screen\n\nTags\n${kit.tags.join(', ')}\n`
    )
  })

  it('knows a Short by its shape and length', () => {
    expect(isShort(1080, 1920, 59)).toBe(true)
    expect(isShort(1080, 1080, 170)).toBe(true)
    expect(isShort(1080, 1920, 240)).toBe(false)
    expect(isShort(1920, 1080, 30)).toBe(false)
  })
})
