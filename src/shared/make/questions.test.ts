import { describe, expect, it } from 'vitest'
import { readAsk } from './brief'
import { answered, questionsFor, readAnswer, vagueTopic } from './questions'
import type { Brief } from './schema'

const ask = (text: string): Brief => readAsk(text) as Brief

describe('asking before writing', () => {
  it('asks how long and what style of a vague prompt, and what to say when the topic is only a word', () => {
    const qs = questionsFor(ask('make a video about my trip'))
    expect(qs.map((q) => q.ask)).toEqual(['What should it say about your trip?', 'What style?', 'How long?'])
    expect(qs.find((q) => q.id === 'length')?.options.map((o) => o.label)).toEqual(['About 1 min', '5 min', '10 min'])
    expect(qs.find((q) => q.id === 'style')?.options.map((o) => o.label)).toEqual(['Cinematic documentary', 'Animated explainer', 'Map documentary'])
    for (const q of qs) {
      expect(q.options.length).toBeGreaterThanOrEqual(2)
      expect(q.options.length).toBeLessThanOrEqual(4)
    }
    expect(vagueTopic('my trip')).toBe(true)
    expect(vagueTopic('the 1950s oil boom')).toBe(false)
  })

  it('asks only what a half-said prompt leaves out', () => {
    // The style is plain, the length is not.
    expect(questionsFor(ask('make a documentary about the gold rush')).map((q) => q.id)).toEqual(['length'])
    // The length is plain, and the topic says it is a story from the past, so the style is not a blind guess.
    expect(questionsFor(ask('make a 3 minute video about the fall of Rome')).map((q) => q.id)).toEqual([])
    // How something works says explainer; only the length is missing.
    expect(questionsFor(ask('make a video about how vaccines work')).map((q) => q.id)).toEqual(['length'])
  })

  it('asks nothing when the prompt says enough, or is a script or a recording', () => {
    expect(questionsFor(ask('make a 2 minute cinematic documentary about the 1950s oil boom'))).toEqual([])
    expect(questionsFor(readAsk('make a documentary about the oil boom', { recording: '/v/vo.wav' }) as Brief)).toEqual([])
    const script = `Here is my script: ${'In 1950 the wells came in and the towns grew. '.repeat(12)}`
    expect(questionsFor(ask(script))).toEqual([])
  })

  it('takes typed words as answers only when they read as answers', () => {
    const qs = questionsFor(ask('make a video about my trip'))
    // The options' own words, a style or a length said plainly, and what is left as what it should say.
    expect(readAnswer('the lakes up north, a map documentary, 5 minutes', qs)).toEqual({
      kind: 'answer',
      answers: ['the lakes up north', 'as a cinematic documentary with maps wherever they help', '5 minutes long']
    })
    expect(readAnswer('The best moments, explainer, about 1 min', qs)).toEqual({
      kind: 'answer',
      answers: ['about the best moments', 'as an animated explainer', '1 minute long']
    })
    // A no lets the questions go; so does an edit's ask or a command, which are not answers at all.
    for (const no of ['never mind', 'no', 'stop', 'forget it', 'cancel that']) expect(readAnswer(no, qs).kind).toBe('no')
    for (const other of ['cut the first 10 seconds', '/export', 'trim the intro', 'ok']) expect(readAnswer(other, qs).kind).toBe('other')
    // With an edit open, loose words may be meant for it: only a style or a length answers.
    expect(readAnswer('the music is too loud', qs, { editOpen: true }).kind).toBe('other')
    expect(readAnswer('10 minutes', qs, { editOpen: true })).toEqual({ kind: 'answer', answers: ['', '', '10 minutes long'] })
  })

  it('reads the answers back into the brief, so nothing is asked twice', () => {
    const text = answered('make a video about my trip', ['about the best moments', 'as a cinematic documentary with maps wherever they help', '5 minutes long'])
    const brief = ask(text)
    expect(brief.topic).toMatch(/^my trip/)
    expect(brief.format).toBe('documentary')
    expect(brief.seconds).toBe(300)
    expect(brief.maps).toBe('more')
    expect(questionsFor(brief).filter((q) => q.id !== 'topic')).toEqual([])
    // Typed words count as an answer as they are.
    expect(ask(answered('make a video about my trip', ['10 minutes long', 'as an animated explainer'])).format).toBe('explainer')
  })
})
