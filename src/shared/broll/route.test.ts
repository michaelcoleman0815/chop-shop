import { describe, expect, it } from 'vitest'
import { TEN_MOMENTS } from './examples'
import { CC0, FAIR_USE, OWN, PEXELS } from './license'
import { dedupe, partsOf, rankFor, reasonFor, sizeLabel, total, type Scored } from './rank'
import { intentOf, makersIn, makerNames, orientationOf, planFor, wantsOfficial } from './route'
import type { Candidate, Moment, SourceId } from './types'

const moment = (search: string, said = '', over: Partial<Moment> = {}): Moment => ({
  said,
  search,
  topic: '',
  format: 'long',
  output: { width: 1920, height: 1080 },
  seconds: 4,
  ...over
})

const all = { why: (): string | null => null }

/** Ten generic moments from tech, gaming and church videos, and what each wants. */
const TEN = TEN_MOMENTS

describe('what a moment wants', () => {
  it.each(TEN.map((t) => [t.m.search, t.intent]))('reads “%s” as %s', (search, intent) => {
    const t = TEN.find((x) => x.m.search === search)
    expect(intentOf(t!.m).intent).toBe(intent)
  })

  it('leaves data charts to the graphics, only when the search asks for one', () => {
    expect(intentOf(moment('bar chart of subscriber growth', 'we grew 40 percent')).intent).toBe('chart')
    // A number said in passing is not a chart.
    expect(intentOf(moment('person typing at a desk', 'about 40 percent of people do this')).intent).not.toBe('chart')
    const plan = planFor(moment('bar chart of revenue'), { available: all })
    expect(plan.sources).toEqual([])
    expect(plan.notes[0]).toMatch(/drawn from the numbers by the graphics/)
  })

  it('lets the planner say what it wants', () => {
    expect(intentOf(moment('a desk', '', { intent: 'space' })).intent).toBe('space')
  })

  it('looks in the maker’s own channel for products, trailers and keynotes', () => {
    expect(wantsOfficial(moment('laptop keyboard'), 'product')).toBe(true)
    expect(wantsOfficial(moment('the keynote stage'), 'concept')).toBe(true)
    expect(wantsOfficial(moment('a forest at dawn'), 'nature')).toBe(false)
  })
})

describe('where to look, in order', () => {
  it('always asks the person’s own library first', () => {
    for (const t of TEN.filter((x) => x.intent !== 'chart')) expect(planFor(t.m, { available: all }).sources[0]).toBe('library')
  })

  it('routes each kind of shot to the sources that have it', () => {
    const plan = (i: number): SourceId[] => planFor(TEN[i].m, { available: all }).sources
    expect(plan(0).slice(0, 3)).toEqual(['library', 'own-uploads', 'youtube'])
    expect(plan(1).slice(0, 3)).toEqual(['library', 'web', 'bluesky'])
    expect(plan(3)).toEqual(['library', 'logos', 'web'])
    expect(plan(4)).toEqual(['library', 'own-uploads', 'steam', 'youtube'])
    expect(plan(5)).toEqual(['library', 'giphy', 'youtube'])
    expect(plan(6).slice(0, 2)).toEqual(['library', 'nasa'])
    expect(plan(9).slice(0, 2)).toEqual(['library', 'archive'])
  })

  it('asks only the person’s own material when B-roll from outside is on the never list', () => {
    const p = planFor(TEN[0].m, { available: all, never: ['broll'] })
    expect(p.sources).toEqual(['library', 'own-uploads'])
    expect(p.notes[0]).toMatch(/never uses B-roll from outside/)
    expect(p.skipped.map((s) => s.id)).toContain('youtube')
  })

  it('never asks a source whose whole site the brand blocks, or one without a key', () => {
    const p = planFor(TEN[8].m, {
      available: { why: (id) => (id === 'unsplash' ? 'it needs a free key, added in Settings' : null) },
      block: ['pexels.com']
    })
    expect(p.sources).not.toContain('pexels')
    expect(p.sources).not.toContain('unsplash')
    expect(p.skipped).toContainEqual({ id: 'pexels', why: 'the brand never uses Pexels' })
    expect(p.skipped).toContainEqual({ id: 'unsplash', why: 'it needs a free key, added in Settings' })
  })

  it('asks for the output’s shape', () => {
    expect(orientationOf({ width: 1080, height: 1920 })).toBe('portrait')
    expect(orientationOf({ width: 1920, height: 1080 })).toBe('landscape')
    expect(orientationOf({ width: 1080, height: 1080 })).toBe('square')
  })

  it('finds the makers a moment names, only as names are written', () => {
    const names = makerNames([{ title: 'Examplecorp', aliases: ['Example Corp'] }, { title: 'Signal' }, { title: 'Go' }])
    expect(makersIn('the new laptop from Examplecorp has a better keyboard', names)).toEqual(['Examplecorp'])
    expect(makersIn('Example Corp’s keynote', names)).toEqual(['Examplecorp'])
    // Lower case is a word, not a name; two letters is too short to trust.
    expect(makersIn('the signal was weak and we go home', names)).toEqual([])
  })
})

const c = (over: Partial<Candidate>): Candidate => ({
  id: 'a',
  source: 'pexels',
  kind: 'video',
  title: 'Typing on a laptop keyboard',
  author: 'Example',
  authorUrl: null,
  pageUrl: 'https://www.pexels.com/video/typing-on-a-laptop-keyboard-1/',
  mediaUrl: null,
  previewUrl: null,
  width: 1920,
  height: 1080,
  durationSec: 12,
  bytes: null,
  license: PEXELS,
  tags: [],
  ...over
})

describe('ranking', () => {
  const m = TEN[0].m
  const order: SourceId[] = ['library', 'own-uploads', 'youtube', 'pexels', 'openverse']

  it('scores the words, the pixels, the shape, the length, the licence and the source', () => {
    const p = partsOf(c({}), m, { order })
    expect(p.text).toBeGreaterThan(0.4)
    expect(p.resolution).toBe(1)
    expect(p.aspect).toBe(1)
    expect(p.duration).toBe(1)
    expect(p.license).toBe(0.95)
    const small = partsOf(c({ width: 640, height: 360 }), m, { order })
    expect(small.resolution).toBeCloseTo(1 / 3)
    // A wide clip in a vertical Short keeps about a third of its width.
    const tall = partsOf(c({}), { ...m, output: { width: 1080, height: 1920 } }, { order })
    expect(tall.aspect).toBeCloseTo(0.316, 2)
    expect(partsOf(c({ durationSec: 2 }), m, { order }).duration).toBe(0.5)
    expect(partsOf(c({ source: 'youtube', license: FAIR_USE }), m, { order }).license).toBe(0.45)
  })

  it('puts the person’s own library first when it matches as well', () => {
    const ranked = rankFor(
      m,
      [
        { candidate: c({ id: 'p1' }), place: 0, of: 1 },
        { candidate: c({ id: 'lib', source: 'library', license: OWN, title: 'laptop keyboard closeup', pageUrl: null }), place: 0, of: 1 }
      ],
      { order }
    )
    expect(ranked[0].candidate.id).toBe('lib')
    expect(ranked[0].reason).toMatch(/^From your library/)
  })

  it('offers the same thing once, keeping the better-scored copy', () => {
    const a = c({ id: 'wm1', source: 'wikimedia', license: CC0, pageUrl: 'https://commons.wikimedia.org/wiki/File:Keyboard.jpg' })
    const b = c({ id: 'ov1', source: 'openverse', license: CC0, pageUrl: 'https://commons.wikimedia.org/wiki/File:Keyboard.jpg?utm_source=x' })
    const scored: Scored[] = [a, b].map((x, i) => {
      const parts = partsOf(x, m, { order: ['library', 'wikimedia', 'openverse'], place: i, of: 2 })
      return { candidate: x, parts, score: total(parts) }
    })
    expect(dedupe(scored)).toHaveLength(1)
  })

  it('keeps different files from one page, and one file found by two sources once', () => {
    const score = (x: Candidate, i: number): Scored => {
      const parts = partsOf(x, m, { order: ['library', 'steam', 'wikimedia', 'openverse'], place: i, of: 2 })
      return { candidate: x, parts, score: total(parts) }
    }
    const page = 'https://store.steampowered.com/app/9000001/'
    const trailer = c({ id: 's-m1', source: 'steam', license: FAIR_USE, pageUrl: page, mediaUrl: 'https://video.akamai.steamstatic.com/x/master.m3u8' })
    const shot = c({ id: 's-s1', source: 'steam', kind: 'image', license: FAIR_USE, pageUrl: page, mediaUrl: 'https://cdn.akamai.steamstatic.com/ss_1.jpg' })
    expect(dedupe([trailer, shot].map(score))).toHaveLength(2)
    const file = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Keyboard.jpg'
    const wm = c({ id: 'wm2', source: 'wikimedia', license: CC0, pageUrl: 'https://commons.wikimedia.org/wiki/File:Keyboard.jpg', mediaUrl: file })
    const ov = c({ id: 'ov2', source: 'openverse', license: CC0, pageUrl: 'https://wordpress.org/openverse/image/abc', mediaUrl: file })
    expect(dedupe([wm, ov].map(score))).toHaveLength(1)
  })

  it('offers a choice rather than three of one site', () => {
    const many = [0, 1, 2, 3].map((i) => ({ candidate: c({ id: `p${i}`, pageUrl: `https://www.pexels.com/video/p-${i}/` }), place: i, of: 4 }))
    const other = { candidate: c({ id: 'o', source: 'openverse', license: CC0, pageUrl: 'https://flickr.com/x' }), place: 0, of: 1 }
    const ranked = rankFor(m, [...many, other], { order, count: 3 })
    expect(ranked.map((r) => r.candidate.source)).toContain('openverse')
  })

  it('offers nothing that shares no word with the moment unless its source ranked it near the top', () => {
    const stray = c({ id: 'stray', source: 'openverse', license: CC0, title: 'A picture of something else', pageUrl: 'https://flickr.com/s' })
    expect(rankFor(m, [{ candidate: stray, place: 9, of: 12 }], { order })).toEqual([])
    expect(rankFor(m, [{ candidate: stray, place: 0, of: 12 }], { order })[0].reason).toMatch(/a top result for “laptop keyboard close up”/)
  })

  it('says only what it knows: no shape warning for a film whose size is not known yet', () => {
    const film = c({ source: 'archive', license: CC0, width: null, height: null, title: 'A 1950s family dinner film' })
    const moment1950 = { ...m, search: '1950s family dinner', said: 'families ate together' }
    const r = reasonFor(film, partsOf(film, moment1950, { order }), moment1950)
    expect(r).not.toMatch(/tall|wide|small/)
    expect(r).toMatch(/matches 1950s, family and dinner\.$/)
  })

  it('says why each is offered, in one line', () => {
    const p = partsOf(c({}), m, { order })
    expect(reasonFor(c({}), p, m)).toBe(
      'Pexels video, 1080p, 12 s, no credit needed (Pexels License); matches laptop and keyboard.'
    )
    const yt = c({ source: 'youtube', license: FAIR_USE, official: true, title: 'Example laptop film', durationSec: 95 })
    expect(reasonFor(yt, partsOf(yt, m, { order }), m)).toMatch(/^A clip from the maker’s own channel, 1080p, 2 min, credited; fair use is your call; matches laptop/)
    expect(sizeLabel(3840, 2160)).toBe('4K')
    expect(sizeLabel(1080, 1920)).toBe('1080p')
  })
})
