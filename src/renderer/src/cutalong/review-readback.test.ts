import { describe, expect, it, vi } from 'vitest'

/**
 * Regression for the fifth money review, on the window's side: the real
 * useMake hook (React's hooks replaced by plain functions) talking to the
 * real draftFor and revise through a fake api that does what main does.
 *
 * A typed reply to the questions, to a quote or to a read-back never leads
 * to a call to Claude until Yes is tapped on a read-back, and the read-back
 * shows what will be sent. What a reply turns down is never picked; a yes
 * with more in it changes the read-back and shows it again; what cannot be
 * read is answered here, with the questions left open.
 */

const fake = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))

vi.mock('react', () => ({
  useRef: <T>(v: T) => ({ current: v }),
  useState: <T>(v: T | (() => T)) => [typeof v === 'function' ? (v as () => T)() : v, () => undefined],
  useCallback: <T>(f: T) => f,
  useMemo: <T>(f: () => T) => f()
}))
vi.mock('./api', () => ({ api: fake.api }))

import { readAsk, rewritesScript } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { questionsFor, TAP_YES, UNREAD } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Brief } from '../../../shared/make/schema'
import type { ParseCall } from '../../../main/make/claude'
import { draftFor, quoteDraft, revise, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }
function harness(settings: DraftDeps['settings'] = { cap: null, autoUnder: 2 }) {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  let claude = 0
  const parse: ParseCall = async () => {
    claude++
    return {
      parsed_output: { title: 'My Trip', sections: [{ heading: 'North', paragraphs: ['We drove north at dawn.', 'The lake was still.'] }] },
      stop_reason: 'end_turn',
      usage: { input_tokens: 4000, output_tokens: 3000 }
    }
  }
  const deps: DraftDeps = { parse, can, brand: {}, settings }
  const quoted = (d: Draft) => ({ ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) })
  // make:start as main runs it: questions unless answered; a read-back's brief read from `reading`; typed answers quoted first.
  const starts: { text: string; reading: string | null; quoteFirst: boolean; brief: Brief | null }[] = []
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => true
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string }) => {
    const read = readAsk(String(req.reading ?? req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && req.reading ? { ...read, ask: req.text } : read
    starts.push({ text: req.text, reading: req.reading ?? null, quoteFirst: !!req.quoteFirst, brief })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    const drafted = await draftFor(brief, `new-${n}`, deps)
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst) throw new Error('made without asking')
    return quoted(drafted.draft)
  }
  // make:revise as main runs it: the steps in turn, and Claude only when the script is written again.
  const revises: string[][] = []
  let holdRevise: Promise<void> | null = null
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[] }) => {
    revises.push(req.steps)
    if (holdRevise) await holdRevise
    const draft = { ...req.draft, quote: quoteDraft(req.draft, deps) }
    const r = revise(draft, req.steps, deps)
    if (!r) return { ok: true, draft: null }
    if (rewritesScript(draft.brief, r.draft.brief, !!draft.into)) {
      const again = await draftFor(r.draft.brief, draft.id, { ...deps, spentBefore: draft.scriptCost })
      if (!again.ok) return { ok: false, message: again.message }
      return { ...quoted(again.draft), changed: r.changed }
    }
    return { ...quoted(r.draft), changed: r.changed }
  }
  const goes: Draft[] = []
  fake.api.makeGo = async (req: { draft: Draft }) => {
    goes.push(req.draft)
    return { ok: false, message: 'test: stopped before anything is made' }
  }
  const makes = useMake({
    docRef: { current: null },
    setDoc: () => undefined,
    setMediaUrl: () => undefined,
    push: (m) => {
      const id = `m${++n}`
      msgs.set(id, { ...m })
      return id
    },
    patch: (id, p) => msgs.set(id, { ...msgs.get(id), ...p }),
    applyAsVersion: () => null,
    during: (work) => work(),
    findBroll: async () => undefined,
    brand: () => 'default'
  })
  const say = (text: string): Promise<boolean> => makes.handle(text, null, [])
  const texts = (): string[] => [...msgs.values()].map((m) => m.text ?? '')
  const lastText = (): string => texts().filter(Boolean).pop() ?? ''
  /** The read-back still waiting, if any: the newest message with a Yes. */
  const yes = (): Action | null => {
    const withYes = [...msgs.values()].filter((m) => m.actions?.some((a) => a.label === 'Yes'))
    return withYes.pop()?.actions?.find((a) => a.label === 'Yes') ?? null
  }
  const readBacks = (): string[] => texts().filter((t) => /^(?:Make it about|Change it to) /.test(t))
  const asking = (): boolean => {
    const id = [...msgs.values()].find((m) => m.makeAsk)?.makeAsk
    return id ? makes.questions(String(id)) !== null : false
  }
  const holdRevises = (): (() => void) => {
    let release = (): void => undefined
    holdRevise = new Promise<void>((r) => (release = r))
    return () => {
      holdRevise = null
      release()
    }
  }
  return { msgs, makes, say, starts, revises, goes, claude: () => claude, lastText, yes, readBacks, asking, holdRevises }
}

describe('the review’s replies to the questions', () => {
  it('"not 10 min, more like 5": read back as 5 minutes, and Claude writes 5 minutes only after Yes', async () => {
    const h = harness()
    await h.say('make a video about my trip')
    expect(await h.say('not 10 min, more like 5')).toBe(true)
    expect(h.readBacks()).toEqual(['Make it about “my trip”: a cinematic documentary, 5:00 long?'])
    expect(h.claude()).toBe(0)
    await h.makes.onAction(h.yes()!)
    expect(h.claude()).toBe(1)
    expect(h.starts[1].brief?.seconds).toBe(300)
    expect(h.starts[1].quoteFirst).toBe(true)
  })

  it('"not a documentary", "anything but 10 min", "not the best moments": never the one turned down', async () => {
    const cases: [string, string | null][] = [
      ['not a documentary', 'Make it about “my trip”: an animated explainer, 1:30 long?'],
      ['anything but an animated explainer', 'Make it about “my trip”: a cinematic documentary, 2:00 long?'],
      ['not the best moments', 'Make it about “my trip”, not the best moments: a cinematic documentary, 2:00 long?'],
      ['the best moments, but nothing about the food', 'Make it about “the best moments”, nothing about the food: a cinematic documentary, 2:00 long?'],
      ['anything but 10 min', null],
      ['definitely not 10 minutes', null]
    ]
    for (const [reply, line] of cases) {
      const h = harness()
      await h.say('make a video about my trip')
      expect(await h.say(reply), reply).toBe(true)
      expect(h.claude(), reply).toBe(0)
      if (line) expect(h.readBacks(), reply).toEqual([line])
      else expect(h.lastText(), reply).toBe(UNREAD)
    }
  })

  it('"yes, 5 minutes" to a read-back changes it and shows it again, keeping the topic', async () => {
    const cases: [string, string, number, string][] = [
      ['yes, 5 minutes', 'a cinematic documentary, 5:00 long', 300, 'documentary'],
      ['yes please, 10 min', 'a cinematic documentary, 10:00 long', 600, 'documentary'],
      ['sure, as a documentary', 'a cinematic documentary, 2:00 long', 120, 'documentary'],
      ['yep, about 5 minutes long', 'a cinematic documentary, 5:00 long', 300, 'documentary'],
      ['ok, an explainer', 'an animated explainer, 1:30 long', 90, 'explainer']
    ]
    for (const [reply, said, seconds, format] of cases) {
      const h = harness()
      await h.say('make a video about my trip')
      await h.say('Lisbon')
      const first = h.yes()!
      await h.say(reply)
      expect(h.readBacks(), reply).toEqual(['Make it about “Lisbon”: a cinematic documentary, 2:00 long?', `Make it about “Lisbon”: ${said}?`])
      expect(h.claude(), reply).toBe(0)
      // The first read-back's Yes went with it: only the newest one sends anything.
      await h.makes.onAction(first)
      expect(h.claude(), reply).toBe(0)
      await h.makes.onAction(h.yes()!)
      expect(h.claude(), reply).toBe(1)
      expect(h.starts[1].text, reply).toMatch(/Lisbon/)
      expect([h.starts[1].brief?.seconds, h.starts[1].brief?.format], reply).toEqual([seconds, format])
    }
  })

  it('a reply it cannot read is answered here, and the questions stay open: nothing goes to Claude, triage included', async () => {
    for (const reply of ['short', 'quick one', 'TikTok length', 'same as last time', 'a longer one']) {
      const h = harness()
      await h.say('make a documentary about the gold rush')
      expect(await h.say(reply), reply).toBe(true)
      expect(h.lastText(), reply).toBe(UNREAD)
      expect(h.asking(), reply).toBe(true)
      expect(h.claude(), reply).toBe(0)
    }
    // What it can read is read back, still with nothing sent.
    for (const [reply, line] of [
      ['a few minutes', 'Make it about “the gold rush”: a cinematic documentary, 3:00 long?'],
      ['1:30', 'Make it about “the gold rush”: a cinematic documentary, 1:30 long?'],
      ['not too long', 'Make it about “the gold rush”, not too long: a cinematic documentary, 2:00 long?']
    ]) {
      const h = harness()
      await h.say('make a documentary about the gold rush')
      expect(await h.say(reply), reply).toBe(true)
      expect(h.readBacks(), reply).toEqual([line])
      expect(h.asking(), reply).toBe(true)
      expect(h.claude(), reply).toBe(0)
    }
  })

  it('a topic with a no or a hold word in it is read back as the topic', async () => {
    for (const topic of ['how I changed my mind about veganism', 'a love story from another time', 'my road trip, no rush, lots of stops']) {
      const h = harness()
      await h.say('make a video about my trip')
      expect(await h.say(topic), topic).toBe(true)
      expect(h.readBacks(), topic).toEqual([`Make it about “${topic}”: a cinematic documentary, 2:00 long?`])
      expect(h.asking(), topic).toBe(true)
      expect(h.claude(), topic).toBe(0)
    }
  })

  it('a yes typed to a read-back is pointed at its button, and sends nothing', async () => {
    const h = harness()
    await h.say('make a video about my trip')
    await h.say('Lisbon')
    for (const y of ['yes', 'ok', 'sure, go ahead', 'do it']) {
      expect(await h.say(y), y).toBe(true)
      expect(h.lastText(), y).toBe(TAP_YES)
    }
    expect(h.claude()).toBe(0)
    expect(h.starts).toHaveLength(1)
  })
})

describe('a reply to a quote', () => {
  it('is read back as a change, and quoted again only on Yes; the old quote’s button waits meanwhile', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.say('make a 1 minute cinematic documentary about the 1950s oil boom')
    expect(h.claude()).toBe(1)
    const button = [...h.msgs.values()].find((m) => m.make)!.actions!.find((a) => a.primary)!
    expect(await h.say('not 10 minutes, make it 2')).toBe(true)
    expect(h.readBacks()).toEqual(['Change it to 2:00 long?'])
    expect([...h.msgs.values()].find((m) => m.text === 'Change it to 2:00 long?')?.aside).toMatch(
      /^Yes asks Claude to write the script again, which may cost up to \$0\.\d\d, and quotes it again\./
    )
    // Said again: one change, the last winning.
    await h.say('actually make it 3 minutes')
    expect(h.readBacks()).toEqual(['Change it to 2:00 long?', 'Change it to 3:00 long?'])
    await h.say('yes')
    expect(h.lastText()).toBe(TAP_YES)
    expect(h.revises).toHaveLength(0)
    expect(h.claude()).toBe(1)
    // Tapped: quoted again, and the old quote's button, pressed while that runs, makes nothing.
    const release = h.holdRevises()
    const requoting = h.makes.onAction(h.yes()!)
    await h.makes.onAction(button)
    expect(h.lastText()).toBe('That quote is being worked out again. Press the new quote’s button when it shows, or stop it first.')
    expect(h.goes).toHaveLength(0)
    release()
    await requoting
    expect(h.revises).toEqual([['make it 2 minutes', 'actually make it 3 minutes']])
    expect(h.claude()).toBe(2)
    const newest = [...h.msgs.values()].filter((m) => m.make).pop()!
    expect(newest.actions?.find((a) => a.primary)?.label).toMatch(/^Make it for \$/)
  })
})

/** Replies of every kind, to the questions of "make a video about my trip". */
const REPLIES = [
  // Topics, some with a no or a hold word in them.
  'Lisbon',
  'the lakes up north',
  'Lisbon?',
  'Porto instead',
  'make it about the food we ate',
  'how I changed my mind about veganism',
  'a love story from another time',
  'the busy streets of Lisbon',
  'why not knowing is fine',
  'the day I said no',
  'my road trip, no rush, lots of stops',
  'the 10 minute walk to the lake',
  'cut the boring parts',
  // What it turns down.
  'not 10 min, more like 5',
  'not 10 min',
  'anything but 10 min',
  'definitely not 10 minutes',
  'not a documentary',
  'anything but an animated explainer',
  'no map documentary please',
  'not the best moments',
  'the best moments, but nothing about the food',
  'not about what I learned',
  'documentary, no maps',
  'without maps',
  'no music',
  'nothing about the 10 minute drive',
  // Pauses, hedges, a yes, a no.
  'hold on a sec',
  'give me a minute',
  'let me think about it',
  'wait, what do you mean?',
  'maybe later',
  'ok',
  'up to you',
  'yes',
  'no idea',
  'no rush, thinking',
  'I’m not sure yet',
  'never mind',
  'I changed my mind',
  // Lengths, in many forms.
  '5',
  'more like 5',
  '1:30',
  'a few minutes',
  'a couple of minutes',
  'two and a half minutes',
  'half a minute',
  'ninety seconds',
  'about 10 min',
  '5 minutes',
  'short',
  'TikTok length',
  'same as last time',
  'quick one',
  // Several at once.
  'yes, 5 minutes',
  'Lisbon, 5 minutes',
  'an explainer about volcanoes, 3 minutes',
  'The best moments, explainer, about 1 min',
  'the lakes up north, a map documentary, 5 minutes',
  // Words that would ask for a video of their own, typed while the questions wait.
  'a 5 minute documentary about Lisbon',
  'make an explainer about volcanoes'
]

describe('no call to Claude without a tapped Yes', () => {
  it(`holds for ${REPLIES.length} replies to the questions, and each read-back's Yes sends exactly one`, async () => {
    const rows: string[] = []
    for (const reply of REPLIES) {
      const h = harness()
      await h.say('make a video about my trip')
      const handled = await h.say(reply)
      rows.push(`${JSON.stringify(reply)}: ${h.readBacks()[0] ?? h.lastText()}`)
      expect(handled, reply).toBe(true)
      expect(h.claude(), reply).toBe(0)
      expect(h.starts, reply).toHaveLength(1)
      // Said again, and again with a yes: still nothing.
      await h.say(reply)
      await h.say('yes')
      expect(h.claude(), `${reply}, said twice and a yes`).toBe(0)
      const yes = h.yes()
      if (yes) {
        await h.makes.onAction(yes)
        expect(h.claude(), `${reply}, Yes tapped`).toBe(1)
        expect(h.starts, reply).toHaveLength(2)
        expect(h.starts[1].quoteFirst, reply).toBe(true)
      }
    }
    console.log(rows.join('\n'))
  })

  it('holds for replies to a quote: only a tapped Yes quotes it again, and Claude writes again only for a new length or style', async () => {
    const replies = [
      'make it 2 minutes',
      'not 10 minutes, make it 5',
      '1:30',
      'make it an explainer',
      'no maps',
      'use a British voice',
      'black and white',
      'vertical',
      'yes',
      'ok',
      'no',
      'hmm',
      'short',
      'make it shorter',
      'what does it cost?'
    ]
    for (const reply of replies) {
      const h = harness({ cap: null, autoUnder: null })
      await h.say('make a 1 minute cinematic documentary about the 1950s oil boom')
      expect(h.claude(), reply).toBe(1)
      expect(await h.say(reply), reply).toBe(true)
      expect(h.claude(), reply).toBe(1)
      expect(h.revises, reply).toHaveLength(0)
      const yes = h.yes()
      if (!yes) continue
      await h.makes.onAction(yes)
      expect(h.revises, reply).toHaveLength(1)
      const again = /2 minutes|make it 5|1:30|explainer/.test(reply)
      expect(h.claude(), reply).toBe(again ? 2 : 1)
    }
  })
})
