import { describe, expect, it } from 'vitest'
import { readAsk } from './brief'
import { answered, isYes, questionsFor, readAnswer, vagueTopic, waitReply } from './questions'
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

  it('reads typed words for their answers, to be read back, and never answers on its own', () => {
    const qs = questionsFor(ask('make a video about my trip'))
    // The options' own words, a style or a length said plainly, and what is left as what it should say: all read back.
    expect(readAnswer('the lakes up north, a map documentary, 5 minutes', qs)).toEqual({
      kind: 'read',
      answers: ['the lakes up north', 'as a cinematic documentary with maps wherever they help', '5 minutes long'],
      ruled: []
    })
    expect(readAnswer('The best moments, explainer, about 1 min', qs)).toEqual({
      kind: 'read',
      answers: ['about the best moments', 'as an animated explainer', '1 minute long'],
      ruled: []
    })
    // A no lets the questions go.
    for (const no of ['never mind', 'no', 'stop', 'forget it', 'cancel that']) expect(readAnswer(no, qs).kind, no).toBe('no')
    // An edit's ask, with an edit open, is for the edit; with none open it is only read back, and costs nothing.
    for (const edit of ['cut the first 10 seconds', '/export', 'trim the intro', 'cut the first 10 seconds?'])
      expect(readAnswer(edit, qs, { editOpen: true }).kind, edit).toBe('edit')
    expect(readAnswer('trim the intro', qs).kind).toBe('read')
    expect(readAnswer('10 minutes', qs, { editOpen: true })).toEqual({ kind: 'read', answers: ['', '', '10 minutes long'], ruled: [] })
    expect(readAnswer('a minute', qs)).toEqual({ kind: 'read', answers: ['', '', '1 minute long'], ruled: [] })
    expect(readAnswer('Lisbon', qs)).toEqual({ kind: 'read', answers: ['Lisbon', '', ''], ruled: [] })
    expect(readAnswer('make it about the food we ate', qs)).toEqual({ kind: 'read', answers: ['the food we ate', '', ''], ruled: [] })
    // A second or two is a moment, not a length; with nothing else said, nothing is read.
    expect(readAnswer('5 seconds', qs).kind).toBe('unread')
    expect(readAnswer('gimme a sec', qs)).toEqual({ kind: 'wait', asked: false })
  })

  it('reads a no, or a not yet, only when it is the whole reply', () => {
    const qs = questionsFor(ask('make a video about my trip'))
    const noes = [
      'I changed my mind',
      'scratch that',
      'forget about the video',
      'actually, don’t',
      'I’d rather not',
      'not interested',
      'please don’t',
      'I’ll pass',
      'skip',
      'abort',
      'do not',
      "let's not",
      'I don’t want it anymore',
      'I really don’t want it anymore, honestly',
      'never mind',
      'nope, never mind'
    ]
    const notYet = ['maybe another time', 'hmm let me see', 'I’m not sure yet', 'busy right now', 'gimme a sec', 'one moment please', 'idk yet']
    // "no" then a hedge is a hedge, not a no: the questions stay.
    const hedges = ['no idea', 'no clue', 'no rush, thinking']
    for (const open of [false, true]) {
      for (const p of noes) expect(readAnswer(p, qs, { editOpen: open }).kind, `${p}${open ? ', an edit open' : ''}`).toBe('no')
      for (const p of [...notYet, ...hedges]) expect(readAnswer(p, qs, { editOpen: open }).kind, `${p}${open ? ', an edit open' : ''}`).toBe('wait')
    }
    // A topic that uses those words names something more: it is read back, never taken as a no or a wait.
    for (const topic of [
      'how I changed my mind about veganism',
      'a love story from another time',
      'my road trip, no rush, lots of stops',
      'the busy streets of Lisbon',
      'why not knowing is fine',
      'the day I said no',
      'the year I said never mind to my old job'
    ])
      expect(readAnswer(topic, qs), topic).toEqual({ kind: 'read', answers: [topic, '', ''], ruled: [] })
    // A yes alone answers nothing (a read-back is confirmed by its button); isYes tells it apart.
    for (const y of ['yes', 'yes please', 'sure', 'do it', 'go ahead', 'ok']) {
      expect(readAnswer(y, qs), y).toEqual({ kind: 'wait', asked: false })
      expect(isYes(y), y).toBe(true)
    }
    for (const other of ['yes, 5 minutes', 'Lisbon instead', 'what?', 'no']) expect(isYes(other), other).toBe(false)
  })

  it('keeps the questions open for a pause, a question back or a word that answers nothing, with or without an edit open', () => {
    const qs = questionsFor(ask('make a video about my trip'))
    const pauses = [
      'hold on a sec',
      'give me a minute',
      'hang on',
      'let me think about it',
      'wait, what do you mean?',
      'maybe later',
      'one sec',
      'just a moment',
      'in a minute',
      'not now',
      'not sure yet',
      'I don’t know',
      "i'll get back to you",
      'brb',
      'hmm',
      'ok',
      'up to you',
      'what are my options',
      'why do you need that?',
      'can you choose for me?',
      'what does that mean'
    ]
    for (const p of pauses) {
      expect(readAnswer(p, qs).kind, p).toBe('wait')
      expect(readAnswer(p, qs, { editOpen: true }).kind, `${p}, with an edit open`).toBe('wait')
    }
    // A question back is said as one, so the reply can say why it asks, naming only what is still asked.
    expect(readAnswer('wait, what do you mean?', qs)).toEqual({ kind: 'wait', asked: true })
    expect(readAnswer('hold on a sec', qs)).toEqual({ kind: 'wait', asked: false })
    expect(waitReply(qs, true)).toBe(
      'I ask these first so the script fits: what it should say, its style and how long it runs. Tap an answer above or type one. Nothing is written or spent until then.'
    )
    expect(waitReply(questionsFor(ask('make a documentary about the gold rush')), true)).toMatch(/^I ask this first so the script fits: how long it runs\./)
    expect(waitReply(qs, false)).toMatch(/^Take your time\..*Nothing is written or spent until then\.$/)
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
