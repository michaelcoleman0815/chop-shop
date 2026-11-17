import { describe, expect, it } from 'vitest'
import { readAsk, reviseBrief, reviseSteps, rewritesScript } from './brief'
import { isAcceptance, mergeReads, questionsFor, quoteWords, readAnswer, readBack, readCard } from './questions'
import { dollars, scriptCost } from './quote'
import type { Brief } from './schema'

/**
 * Regression for the fifth money review: a typed reply is read here and read
 * back, and only the read-back's Yes, tapped, sends anything. What a reply
 * turns down ("not 10 min", "anything but a documentary", "nothing about the
 * food") is never picked; lengths said in other words ("1:30", "a few
 * minutes", "more like 5") are read; what names no answer is unread; and the
 * line read back is read from exactly what main will read.
 */

const ask = (text: string): Brief => readAsk(text) as Brief
const TRIP = 'make a video about my trip'
const qs = questionsFor(ask(TRIP))

/** A reply read, and its read-back. */
function backOf(reply: string): ReturnType<typeof readBack> {
  const r = readAnswer(reply, qs)
  if (r.kind !== 'read') throw new Error(`"${reply}" was not read: ${r.kind}`)
  return readBack(TRIP, qs, r)
}

describe('what a reply turns down is never picked', () => {
  it('reads a length, a style or an option turned down as never that, and what is said instead as the answer', () => {
    expect(qs.map((q) => q.id)).toEqual(['topic', 'style', 'length'])
    expect(readAnswer('not 10 min, more like 5', qs)).toEqual({ kind: 'read', answers: ['', '', '5 minutes long'], ruled: [] })
    expect(backOf('not 10 min, more like 5').line).toBe('Make it about “my trip”: a cinematic documentary, 5:00 long?')
    // Turned down and nothing said instead: nothing is read, and nothing is chosen.
    for (const r of ['not 10 min', 'anything but 10 min', 'definitely not 10 minutes']) expect(readAnswer(r, qs).kind, r).toBe('unread')
    // A style turned down: the style left, never the one turned down.
    expect(backOf('not a documentary').line).toBe('Make it about “my trip”: an animated explainer, 1:30 long?')
    expect(backOf('anything but an animated explainer').line).toBe('Make it about “my trip”: a cinematic documentary, 2:00 long?')
    expect(backOf('no map documentary please').line).toBe('Make it about “my trip”: a cinematic documentary with no maps, 2:00 long?')
    expect(backOf('documentary, no maps').line).toBe('Make it about “my trip”: a cinematic documentary with no maps, 2:00 long?')
    expect(readAnswer('not a documentary, not an explainer', qs)).toEqual({ kind: 'unread' })
  })

  it('keeps what it should not say, and sends it with what it should', () => {
    const food = backOf('the best moments, but nothing about the food')
    expect(food.line).toBe('Make it about “the best moments”, nothing about the food: a cinematic documentary, 2:00 long?')
    expect(food.prompt).toBe('make a video about my trip, about the best moments, nothing about the food.')
    expect(backOf('not the best moments').line).toBe('Make it about “my trip”, not the best moments: a cinematic documentary, 2:00 long?')
    expect(backOf('not about what I learned').line).toBe('Make it about “my trip”, not about what I learned: a cinematic documentary, 2:00 long?')
    expect(backOf('Lisbon, no music').line).toBe('Make it about “Lisbon”, no music: a cinematic documentary, 2:00 long?')
    // What it should not say is never read as its length: the brief is read without it.
    const drive = backOf('nothing about the 10 minute drive')
    expect(drive.line).toBe('Make it about “my trip”, nothing about the 10 minute drive: a cinematic documentary, 2:00 long?')
    expect(ask(drive.reading).seconds).toBe(120)
    expect(drive.prompt).toMatch(/nothing about the 10 minute drive/)
    const walk = backOf('the 10 minute walk to the lake, 5 minutes')
    expect(walk.line).toBe('Make it about “the 10 minute walk to the lake”: a cinematic documentary, 5:00 long?')
    expect(ask(walk.reading).seconds).toBe(300)
    // A "not" inside a phrase that names no choice is part of what was said.
    expect(readAnswer('why not knowing is fine', qs)).toEqual({ kind: 'read', answers: ['why not knowing is fine', '', ''], ruled: [] })
  })
})

describe('lengths said in other words', () => {
  it('reads them, and reads back the length main will read', () => {
    const lengths: [string, string][] = [
      ['1:30', '1:30 long'],
      ['a few minutes', '3:00 long'],
      ['a couple of minutes', '2:00 long'],
      ['two and a half minutes', '2:30 long'],
      ['half a minute', '0:30 long'],
      ['5', '5:00 long'],
      ['more like 5', '5:00 long'],
      ['about 10 min', '10:00 long'],
      ['ninety seconds', '1:30 long']
    ]
    for (const [reply, said] of lengths) expect(backOf(reply).line, reply).toBe(`Make it about “my trip”: a cinematic documentary, ${said}?`)
    // A number in what it should say is not a length.
    expect(readAnswer('Lisbon 2019', qs)).toEqual({ kind: 'read', answers: ['Lisbon 2019', '', ''], ruled: [] })
  })

  it('leaves what names no length unread, with only "How long?" asked or with the topic asked too', () => {
    const gold = questionsFor(ask('make a documentary about the gold rush'))
    expect(gold.map((q) => q.id)).toEqual(['length'])
    for (const r of ['short', 'quick one', 'TikTok length', 'same as last time', 'the usual', 'a longer one']) {
      expect(readAnswer(r, gold).kind, r).toBe('unread')
      expect(readAnswer(r, qs).kind, `${r}, the topic asked too`).toBe('unread')
    }
    // Read where it can be: a length in other words, or what it should not be.
    expect(readAnswer('a few minutes', gold)).toEqual({ kind: 'read', answers: ['3 minutes long'], ruled: [] })
    expect(readAnswer('1:30', gold)).toEqual({ kind: 'read', answers: ['90 seconds long'], ruled: [] })
    expect(readBack('make a documentary about the gold rush', gold, { answers: [''], ruled: ['not too long'] }).line).toBe(
      'Make it about “the gold rush”, not too long: a cinematic documentary, 2:00 long?'
    )
  })
})

describe('the read-back', () => {
  it('names what Claude is given, the brief it is read into, and what writing it may cost', () => {
    const b = backOf('Lisbon, 5 minutes')
    expect(b.line).toBe('Make it about “Lisbon”: a cinematic documentary, 5:00 long?')
    expect(b.prompt).toBe('make a video about my trip, Lisbon, 5 minutes long.')
    expect(b.reading).toBe('make a video about my trip, 5 minutes long.')
    expect(b.aside).toBe(`Yes asks Claude to write the script, which may cost up to ${dollars(scriptCost(300))}. Nothing else is spent until you press its quote’s button.`)
    // Read from what main reads: the reading for the how, the prompt as what Claude reads.
    const brief = ask(b.reading)
    expect([brief.format, brief.seconds, brief.maps]).toEqual(['documentary', 300, 'auto'])
    expect(backOf('the lakes up north, a map documentary, 5 minutes').line).toBe(
      'Make it about “the lakes up north”: a cinematic documentary with maps, 5:00 long?'
    )
    // A tapped option is read back in its own words.
    expect(backOf('The best moments, explainer, about 1 min').line).toBe('Make it about “the best moments”: an animated explainer, 1:00 long?')
  })

  it('takes what is said next into the read-back waiting: what was said last wins, and nothing turned down is lost', () => {
    const lisbon = readAnswer('Lisbon', qs)
    const more = readAnswer('yes, 5 minutes', qs)
    if (lisbon.kind !== 'read' || more.kind !== 'read') throw new Error('not read')
    const both = mergeReads(lisbon, more)
    expect(both).toEqual({ answers: ['Lisbon', '', '5 minutes long'], ruled: [] })
    expect(readBack(TRIP, qs, both).line).toBe('Make it about “Lisbon”: a cinematic documentary, 5:00 long?')
    for (const [reply, said] of [
      ['yes please, 10 min', 'a cinematic documentary, 10:00 long'],
      ['sure, as a documentary', 'a cinematic documentary, 2:00 long'],
      ['yep, about 5 minutes long', 'a cinematic documentary, 5:00 long'],
      ['ok, an explainer', 'an animated explainer, 1:30 long']
    ]) {
      const r = readAnswer(reply, qs)
      if (r.kind !== 'read') throw new Error(`${reply}: ${r.kind}`)
      expect(readBack(TRIP, qs, mergeReads(lisbon, r)).line, reply).toBe(`Make it about “Lisbon”: ${said}?`)
    }
    const food = readAnswer('nothing about the food', qs)
    const porto = readAnswer('Porto instead', qs)
    if (food.kind !== 'read' || porto.kind !== 'read') throw new Error('not read')
    expect(readBack(TRIP, qs, mergeReads(mergeReads(lisbon, food), porto)).line).toBe(
      'Make it about “Porto”, nothing about the food: a cinematic documentary, 2:00 long?'
    )
  })

  it('reads words typed in the card’s own fields like a reply, and lets taps go straight on', () => {
    expect(readCard(['about the best moments', 'as a cinematic documentary', '1 minute long'], qs)).toBeNull()
    expect(readCard(['Lisbon', 'as an animated explainer', '1:30'], qs)).toEqual({
      kind: 'read',
      answers: ['Lisbon', 'as an animated explainer', '90 seconds long'],
      ruled: []
    })
    expect(readCard(['about the best moments', 'as an animated explainer', 'not 10 min'], qs)).toEqual({ kind: 'unread' })
    expect(readCard(['nothing about the food', 'not a documentary', '5 minutes long'], qs)).toEqual({
      kind: 'read',
      answers: ['', 'as an animated explainer', '5 minutes long'],
      ruled: ['nothing about the food']
    })
  })
})

describe('a reply to a quote', () => {
  const oil = ask('make a 1 minute cinematic documentary about the oil boom')

  it('never picks what it turns down, and reads lengths said in other words', () => {
    expect(quoteWords('not 10 minutes, make it 5')).toBe('make it 5 minutes')
    expect(reviseBrief(oil, quoteWords('not 10 minutes, make it 5'))?.changed).toEqual(['5:00 long'])
    expect(reviseBrief(oil, quoteWords('1:30'))?.changed).toEqual(['1:30 long'])
    expect(reviseBrief(oil, quoteWords('anything but 3 minutes'))).toBeNull()
    expect(reviseBrief(oil, quoteWords('not as an explainer'))).toBeNull()
    expect(reviseBrief(oil, quoteWords('not black and white'))?.changed ?? []).not.toContain('the black and white look')
    // What reviseBrief reads as turned down itself stays.
    expect(reviseBrief(oil, quoteWords('no maps'))?.changed).toEqual(['no maps'])
  })

  it('folds changes said in turn into one, the last winning, and says back what they make', () => {
    expect(reviseSteps(oil, ['make it 3 minutes', 'make it 5 minutes'])).toMatchObject({ brief: { seconds: 300 }, changed: ['5:00 long'] })
    // Put back as it was quoted: no change at all.
    expect(reviseSteps(oil, ['make it 3 minutes', 'make it 1 minute'])).toBeNull()
    // A new format brings its look: one that was asked for before it is said to be gone.
    expect(reviseSteps(oil, ['sepia', 'make it an explainer'])?.changed).toEqual(['an animated explainer', 'the bright look'])
    // One change reads as reviseBrief reads it.
    for (const t of ['make it 3 minutes', 'make it an explainer instead', 'black and white, no maps', 'vertical, under $4'])
      expect(reviseSteps(oil, [t])?.changed, t).toEqual(reviseBrief(oil, t)?.changed)
  })

  it('knows when a change means Claude writes the script again', () => {
    const three = reviseBrief(oil, 'make it 3 minutes')!.brief
    const sepia = reviseBrief(oil, 'sepia')!.brief
    expect(rewritesScript(oil, three, false)).toBe(true)
    expect(rewritesScript(oil, three, true)).toBe(false)
    expect(rewritesScript(oil, sepia, false)).toBe(false)
    expect(rewritesScript({ ...oil, from: 'script' }, three, false)).toBe(false)
  })
})

describe('round 6: a go-ahead, an edit’s words and a limit, typed', () => {
  it('reads a go-ahead in other words as one, never as a topic', () => {
    const goAheads = ['yes', 'Yes!', 'yes please', 'go ahead', 'do it', 'ok go', 'sure, write it', 'write it', 'write the script', 'go', 'start', 'make it', 'just make it']
    for (const y of [...goAheads, 'proceed', 'confirm', '👍', 'y', 'ok, make it', 'sounds good', 'go ahead and make it', 'make it now']) {
      expect(isAcceptance(y), y).toBe(true)
      expect(readAnswer(y, qs), y).toEqual({ kind: 'wait', asked: false })
    }
    for (const n of ['make it 3 minutes', 'make it shorter', 'Lisbon', 'no', 'not now', 'make a video about whales', 'start over with whales', 'do it again tomorrow', 'that’s it'])
      expect(isAcceptance(n), n).toBe(false)
  })

  it('answers an edit’s words with no edit open, and leaves them to the edit when one is', () => {
    for (const r of ['cut the first 10 seconds', 'export it', 'trim the intro', 'mute the music']) {
      expect(readAnswer(r, qs).kind, r).toBe('noEdit')
      expect(readAnswer(r, qs, { editOpen: true }).kind, r).toBe('edit')
    }
    // A topic that starts like an edit's word but is not one stays a topic.
    expect(readAnswer('playing in the snow', qs)).toEqual({ kind: 'read', answers: ['playing in the snow', '', ''], ruled: [] })
  })

  it('reads a limit typed with the topic into the brief, and says it in the read-back', () => {
    expect(readAnswer('Lisbon, under $1', qs)).toEqual({ kind: 'read', answers: ['Lisbon', '', ''], ruled: [], cap: 'under $1' })
    expect(readAnswer('Lisbon under $1', qs)).toEqual({ kind: 'read', answers: ['Lisbon', '', ''], ruled: [], cap: 'under $1' })
    const b = backOf('Lisbon, under $1')
    expect(b.line).toBe('Make it about “Lisbon”: a cinematic documentary, 2:00 long, no more than $1.00?')
    expect(ask(b.reading).cap).toBe(1)
    expect(b.prompt).toBe('make a video about my trip, Lisbon, under $1.')
    // A limit alone is read too, and kept when more is said after it.
    const alone = readAnswer('no more than $5', qs)
    if (alone.kind !== 'read') throw new Error('not read')
    expect(alone.cap).toBe('no more than $5')
    const more = readAnswer('the food we ate, 5 minutes', qs)
    if (more.kind !== 'read') throw new Error('not read')
    expect(readBack(TRIP, qs, mergeReads(alone, more)).line).toBe('Make it about “the food we ate”: a cinematic documentary, 5:00 long, no more than $5.00?')
  })
})
