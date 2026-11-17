import { describe, expect, it } from 'vitest'
import { DEFAULT_DESCRIPTION } from './brand'
import { DESCRIPTION_MAX, fillDescription } from './upload'

/**
 * fillDescription puts each part in as written: "$$", "$&", "$`" and "$'"
 * in the opening, a chapter title or a credit line are text, not patterns.
 * Past YouTube's limit, the brand's own lines give way, never the credits.
 */

describe('fillDescription and dollar signs', () => {
  it('keeps what a credit, a chapter or the opening says', () => {
    const credits = [
      '- How I Made $$$ With One Camera · Some Channel · https://www.youtube.com/watch?v=abc',
      '- Q$&A night · Other',
      "- The $` and $' signs · Third"
    ]
    const text = fillDescription(DEFAULT_DESCRIPTION, {
      opening: 'Is the $$ camera worth it?',
      chapters: ['0:00 Intro', '1:10 Saving $$$ on lenses'],
      credits
    })
    expect(text).toBe(
      ['Is the $$ camera worth it?', '0:00 Intro\n1:10 Saving $$$ on lenses', `Credits\n${credits.join('\n')}`].join('\n\n')
    )
    expect(text).not.toContain('{credits}')
  })

  it('keeps a dollar sign in a template that leaves a part out', () => {
    const text = fillDescription('Gear I use: $$ links below.\n\n{credits}', {
      opening: 'A $5 trick.',
      chapters: ['0:00 Intro', '0:40 The $5 trick'],
      credits: []
    })
    expect(text).toBe('A $5 trick.\n\n0:00 Intro\n0:40 The $5 trick\n\nGear I use: $$ links below.')
  })
})

describe('fillDescription past 5,000 characters', () => {
  const credits = ['- Night city timelapse · Nightfilm · https://www.youtube.com/watch?v=nf1 · CC BY 4.0']
  const chapters = ['0:00 Intro', '1:00 Camera', '2:00 Battery']

  it('lets the brand’s own lines give way, and keeps the chapters and the credits', () => {
    const template = `{opening}\n\n{chapters}\n\n${'Links and the sponsor line. '.repeat(176).trim()}\n\n{credits}`
    expect(template.length).toBeLessThanOrEqual(5000) // a template the Brand page takes
    const text = fillDescription(template, { opening: 'A week with the phone.', chapters, credits })
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
    expect(text).toContain('Nightfilm')
    expect(text).toContain('Credits\n- Night city timelapse')
    expect(text).toContain(chapters.join('\n'))
    expect(text.startsWith('A week with the phone.')).toBe(true)
  })

  it('drops the brand’s lines from the last, whole, until it fits', () => {
    const line = (n: number): string => `Line ${n}: ${'x'.repeat(480)}`
    const lines = Array.from({ length: 11 }, (_, i) => line(i + 1))
    const template = ['{opening}', ...lines, '{chapters}', '{credits}'].join('\n')
    expect(template.length).toBeGreaterThan(DESCRIPTION_MAX)
    const text = fillDescription(template, { opening: 'A week with the phone.', chapters, credits })
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
    expect(text).toContain('Line 1:')
    expect(text).toContain('Line 9:')
    expect(text).not.toContain('Line 10:')
    expect(text).not.toContain('Line 11:')
    // No line is cut part way.
    for (const l of text.split('\n').filter((x) => x.startsWith('Line '))) expect(lines).toContain(l)
    expect(text).toContain('Nightfilm')
  })

  it('shortens the opening, at a word, only when the brand’s lines are gone', () => {
    const many = Array.from({ length: 60 }, (_, i) => `- Clip ${i + 1} from a channel with a long name · https://www.youtube.com/watch?v=c${i}`)
    const opening = 'This one runs long. '.repeat(40).trim()
    const text = fillDescription('{opening}\n\nFollow me everywhere.\n\n{chapters}\n\n{credits}', {
      opening,
      chapters,
      credits: many
    })
    expect(text.length).toBeLessThanOrEqual(DESCRIPTION_MAX)
    expect(text).toContain(many[59])
    expect(text).not.toContain('Follow me everywhere.')
    const first = text.split('\n')[0]
    expect(opening.startsWith(first)).toBe(true)
    expect(first.endsWith('long.') || first.endsWith('one') || first.endsWith('runs') || first.endsWith('This')).toBe(true)
  })
})
