import { describe, expect, it } from 'vitest'
import {
  ageText,
  cardLine,
  compactNumber,
  digitsValue,
  sameFigure,
  spokenFigures,
  uploadedOn,
  viewsText
} from './figures'

const said = (text: string) =>
  text.split(' ').map((t, i) => ({ id: `w${i + 1}`, text: t, outStart: i * 0.4, outEnd: i * 0.4 + 0.3 }))

describe('numbers as they are said', () => {
  it('reads digits as a transcript writes them', () => {
    expect(digitsValue('683,594')).toBe(683594)
    expect(digitsValue('1,000,000.')).toBe(1000000)
    expect(digitsValue('$999')).toBe(999)
    expect(digitsValue('1.2')).toBe(1.2)
    expect(digitsValue('10K')).toBe(10000)
    expect(digitsValue('2.5M')).toBe(2500000)
    expect(digitsValue('50%')).toBe(50)
    expect(digitsValue('views')).toBeNull()
    expect(digitsValue('1-3')).toBeNull()
  })

  it('finds each figure in speech with the words it spans', () => {
    const f = spokenFigures(said('This one got 683,594 views and today it hit a million views.'))
    expect(f.map((x) => x.value)).toEqual([1, 683594, 1000000])
    const million = f[2]
    expect(million.text).toBe('a million')
    expect([million.from, million.to]).toEqual(['w10', 'w11'])
    expect(million.at).toBeCloseTo(9 * 0.4)
  })

  it('reads digits with a scale word, and numbers in words as people say them', () => {
    const values = (s: string): number[] => spokenFigures(said(s)).map((f) => f.value)
    expect(values('it hit 1.2 million subscribers')).toEqual([1200000])
    expect(values('about 10 thousand people')).toEqual([10000])
    expect(values('twenty-five thousand views')).toEqual([25000])
    expect(values('two hundred and five dollars')).toEqual([205])
    expect(values('a hundred thousand')).toEqual([100000])
    expect(values('day one, day two, day three.')).toEqual([1, 2, 3])
    // A sentence's end closes a figure: three, then a new sentence.
    expect(values('I posted 3. Thousands watched')).toEqual([3])
    // "a" alone is no figure.
    expect(values('a video about it')).toEqual([])
  })

  it('takes a figure rounded the way speech rounds it as the same', () => {
    expect(sameFigure(1000000, 1000000)).toBe(true)
    expect(sameFigure(1200000, 1199000)).toBe(true)
    // "six hundred and eighty-three thousand" is how 683,594 is said; 693,594 is another figure.
    expect(sameFigure(683000, 683594)).toBe(true)
    expect(sameFigure(693594, 683594)).toBe(false)
    expect(sameFigure(0, 0)).toBe(true)
  })
})

describe('numbers as cards show them', () => {
  it('writes view counts the way YouTube does, rounded down', () => {
    expect(compactNumber(999)).toBe('999')
    expect(compactNumber(1000)).toBe('1K')
    expect(compactNumber(1560)).toBe('1.5K')
    expect(compactNumber(12400)).toBe('12K')
    expect(compactNumber(492310)).toBe('492K')
    expect(compactNumber(999999)).toBe('999K')
    expect(compactNumber(1000000)).toBe('1M')
    expect(compactNumber(1560000)).toBe('1.5M')
    expect(compactNumber(23400000)).toBe('23M')
    expect(compactNumber(2100000000)).toBe('2.1B')
    expect(viewsText(492310)).toBe('492K views')
    expect(viewsText(1)).toBe('1 view')
    expect(viewsText(null)).toBe('')
  })

  it('says how long ago in the short form', () => {
    const now = new Date('2026-11-16T12:00:00Z')
    const ago = (sec: number): string => ageText(new Date(now.getTime() - sec * 1000), now)
    expect(ago(30)).toBe('just now')
    expect(ago(5 * 60)).toBe('5 min ago')
    expect(ago(3 * 3600)).toBe('3 hr ago')
    expect(ago(86400)).toBe('1 day ago')
    expect(ago(3 * 86400)).toBe('3 days ago')
    expect(ago(15 * 86400)).toBe('2 wk ago')
    expect(ago(40 * 86400)).toBe('1 mo ago')
    expect(ago(200 * 86400)).toBe('6 mo ago')
    expect(ago(364 * 86400)).toBe('11 mo ago')
    expect(ago(800 * 86400)).toBe('2 yr ago')
  })

  it('puts views and age on one line, or whichever is known', () => {
    const now = new Date('2026-11-16T12:00:00Z')
    expect(cardLine(492310, new Date('2026-10-10T00:00:00Z'), now)).toBe('492K views · 1 mo ago')
    expect(cardLine(492310, null, now)).toBe('492K views')
    expect(cardLine(null, new Date('2026-11-13T00:00:00Z'), now)).toBe('3 days ago')
  })

  it('reads the dates yt-dlp gives', () => {
    expect(uploadedOn('20261016')?.toISOString()).toBe('2026-10-16T00:00:00.000Z')
    expect(uploadedOn('20261016', 1790000000)?.getTime()).toBe(1790000000 * 1000)
    expect(uploadedOn('soon')).toBeNull()
    expect(uploadedOn(undefined)).toBeNull()
  })
})
