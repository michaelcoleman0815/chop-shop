import { describe, expect, it, vi } from 'vitest'

/**
 * Regression for the fifth and sixth money reviews, on the window's side:
 * the real useMake hook (React's hooks replaced by plain functions) talking
 * to the real draftFor, revise and changeFor through a fake api that does
 * what main does, consent included: main writes no script, changes no quote
 * and makes nothing without a tap, or a new ask typed with nothing waiting.
 *
 * A typed reply to the questions, to a quote or to a read-back never leads
 * to a call to Claude, a make or the planner until a button is tapped, and
 * the read-back shows what will be sent. What a reply turns down is never
 * picked; a yes with more in it changes the read-back and shows it again;
 * what cannot be read is answered here, with the questions left open; a new
 * ask typed while anything waits is read back with taps of its own; a
 * go-ahead typed is pointed at the button.
 */

const fake = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))

vi.mock('react', () => ({
  useRef: <T>(v: T) => ({ current: v }),
  useState: <T>(v: T | (() => T)) => [typeof v === 'function' ? (v as () => T)() : v, () => undefined],
  useCallback: <T>(f: T) => f,
  useMemo: <T>(f: () => T) => f()
}))
vi.mock('./api', () => ({ api: fake.api }))

import type { EditDoc } from '../../../shared/edit/schema'
import { readAsk, rewritesScript } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { NO_EDIT, questionsFor, TAP_TO_GO, UNREAD } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Brief, Make } from '../../../shared/make/schema'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, quoteDraft, revise, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const lines = Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`)
/** A made video, open in the editor. */
const made: Make = {
  v: 1,
  brief: { topic: 'the 1950s oil boom', format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', look: 'archival', maps: 'auto', clips: 'auto', images: null, cap: null, inferred: [], ask: 'make a 2 minute documentary about the 1950s oil boom' },
  title: 'Black Gold',
  outline: ['The boom'],
  script: lines.join(' '),
  phrases: lines,
  sections: [0],
  bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: 'West Texas, 1950s', characters: [] },
  shots: lines.map((_, i) => ({ phrase: i, visual: { kind: 'still' as const, prompt: `A derrick ${i + 1}.`, move: 'push-in' as const, characters: [] }, title: null, callouts: [], beat: `b${i}`, file: `/made/${i}.png`, maker: 'google' as const, model: 'm', cost: 0.05, key: null, note: null })),
  sheets: [],
  narration: { path: '/made/narration.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  images: 'google',
  clips: 'google',
  spent: 1.4
}
const madeDoc = { id: 'doc1', sources: [{ id: 's1', path: '/made/narration.wav' }], words: [], assets: [], make: made, versions: [] } as unknown as EditDoc
const PHOTO = [{ name: 'lisbon.jpg', path: '/tmp/lisbon.jpg' }]
/** What any reply to a waiting quote that neither changes it nor is plainly an edit is answered with. */
const QUOTE_WAITS = 'Tap the button above to go ahead, or tell me what to change. Nothing is spent until you tap it; say “never mind” to set it aside.'

function harness(settings: DraftDeps['settings'] = { cap: null, autoUnder: 2 }, opts: { open?: EditDoc | null; sentences?: (call: number) => number } = {}) {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  let claude = 0
  const parse: ParseCall = async () => {
    claude++
    const count = opts.sentences?.(claude) ?? 2
    const paragraphs =
      count === 2
        ? ['We drove north at dawn.', 'The lake was still.']
        : Array.from({ length: count }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over boom town number ${i + 1} and the men worked on through the night.`)
    return {
      parsed_output: { title: 'My Trip', sections: [{ heading: 'North', paragraphs }] },
      stop_reason: 'end_turn',
      usage: { input_tokens: 4000, output_tokens: 3000 }
    }
  }
  const deps: DraftDeps = { parse, can, brand: {}, settings }
  const quoted = (d: Draft) => ({ ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) })
  /** Calls main refused for want of consent, and makes it went ahead with under Settings' amount. */
  const refused: string[] = []
  const autoMade: string[] = []
  const tapped = (c: unknown): boolean => c === 'tap'
  // make:start as main runs it: questions first, unless answered; past them, a script only with consent; a read-back's
  // brief read from `reading`; under Settings' amount, made straight away only for a tap or a fresh ask, never quoteFirst.
  const starts: { text: string; reading: string | null; quoteFirst: boolean; consent: string | null; brief: Brief | null }[] = []
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => true
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: string }) => {
    const read = readAsk(String(req.reading ?? req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && req.reading ? { ...read, ask: req.text } : read
    starts.push({ text: req.text, reading: req.reading ?? null, quoteFirst: !!req.quoteFirst, consent: req.consent ?? null, brief })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (req.consent !== 'tap' && req.consent !== 'command') {
      refused.push(`make:start ${req.text}`)
      return { ok: false, message: 'refused: no consent' }
    }
    const drafted = await draftFor(brief, `new-${n}`, deps)
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      autoMade.push(`${req.consent}: ${req.text}`)
      return { ok: false, message: 'test: made straight away, under the amount in Settings' }
    }
    return quoted(drafted.draft)
  }
  // make:revise as main runs it: only for a tap; the steps in turn, and Claude only when the script is written again.
  const revises: string[][] = []
  let holdRevise: Promise<void> | null = null
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: string }) => {
    if (!tapped(req.consent)) {
      refused.push('make:revise')
      return { ok: false, message: 'refused: no consent' }
    }
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
  fake.api.makeGo = async (req: { draft: Draft; consent?: string }) => {
    if (!tapped(req.consent)) {
      refused.push('make:go')
      return { ok: false, message: 'refused: no consent' }
    }
    goes.push(req.draft)
    return { ok: false, message: 'test: stopped before anything is made' }
  }
  const shots: unknown[] = []
  fake.api.makeShot = async (req: { consent?: string }) => {
    if (!tapped(req.consent)) {
      refused.push('make:shot')
      return { ok: false, message: 'refused: no consent' }
    }
    shots.push(req)
    return { ok: false, message: 'test: stopped before anything is made' }
  }
  const changes: string[] = []
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => {
    changes.push(req.text)
    return { ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, deps) }
  }
  const docRef = { current: (opts.open ?? null) as EditDoc | null }
  const makes = useMake({
    docRef,
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
  /** What a typed message does, as useCutalong hands it on: useMake first, then (an edit open) make.asked, then the planner or triage. */
  const letGo: string[] = []
  const type = async (text: string, files: { name: string; path: string }[] = []): Promise<void> => {
    const command = /^\s*\/(\w+)\s*(.*)$/s.exec(text)
    if (await makes.handle(text, command ? { command: command[1], rest: command[2] } : null, files as never)) return
    if (docRef.current && (await makes.asked(text))) return
    letGo.push(text)
  }
  const say = async (text: string): Promise<boolean> => {
    const before = letGo.length
    await type(text)
    return letGo.length === before
  }
  const texts = (): string[] => [...msgs.values()].map((m) => m.text ?? '')
  const lastText = (): string => texts().filter(Boolean).pop() ?? ''
  /** A button of the read-back still waiting, if any: the newest message with one so labelled. */
  const button = (label: string): Action | null => {
    const withIt = [...msgs.values()].filter((m) => m.actions?.some((a) => a.label === label))
    return withIt.pop()?.actions?.find((a) => a.label === label) ?? null
  }
  const yes = (): Action | null => button('Yes')
  const readBacks = (): string[] => texts().filter((t) => /^(?:Make it about|Change it to|Change this one to|Start a new video) /.test(t))
  const asking = (): boolean => {
    const id = [...msgs.values()].find((m) => m.makeAsk)?.makeAsk
    return id ? makes.questions(String(id)) !== null : false
  }
  const waitingQuote = (): Partial<Msg> | undefined => [...msgs.values()].filter((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"'))).pop()
  const holdRevises = (): (() => void) => {
    let release = (): void => undefined
    holdRevise = new Promise<void>((r) => (release = r))
    return () => {
      holdRevise = null
      release()
    }
  }
  /** Everything that spends, or hands the message on to Claude: none of it may follow typed words alone. */
  const spent = (): number => claude + goes.length + shots.length + revises.length + autoMade.length + letGo.length
  return { msgs, makes, type, say, starts, revises, goes, shots, changes, refused, autoMade, letGo, claude: () => claude, spent, lastText, button, yes, readBacks, asking, waitingQuote, holdRevises }
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
    expect(h.starts[1].consent).toBe('tap')
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

  it('a go-ahead typed to a read-back is pointed at its button, and sends nothing', async () => {
    const h = harness()
    await h.say('make a video about my trip')
    await h.say('Lisbon')
    for (const y of ['yes', 'ok', 'sure, go ahead', 'do it', 'sure, write it', 'proceed', 'confirm', 'start', '👍']) {
      expect(await h.say(y), y).toBe(true)
      expect(h.lastText(), y).toBe(TAP_TO_GO)
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
    expect(h.starts[0].consent).toBe('command')
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
    expect(h.lastText()).toBe(TAP_TO_GO)
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
    expect(h.refused).toEqual([])
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
  'Lisbon, under $1',
  'an explainer about volcanoes, 3 minutes',
  'The best moments, explainer, about 1 min',
  'the lakes up north, a map documentary, 5 minutes',
  // Words that would ask for a video of their own, typed while the questions wait.
  'a 5 minute documentary about Lisbon',
  'make an explainer about volcanoes',
  '/make a 1 minute documentary about whales',
  // A go-ahead in other words, and an edit's words with no edit open.
  'sure, write it',
  'proceed',
  'confirm',
  'start',
  'write the script',
  '👍',
  'cut the first 10 seconds',
  'export it'
]

describe('no call to Claude without a tapped Yes', () => {
  it(`holds for ${REPLIES.length} replies to the questions, and each read-back's tap sends exactly one`, async () => {
    const rows: string[] = []
    for (const reply of REPLIES) {
      const h = harness({ cap: null, autoUnder: 25 })
      await h.say('make a video about my trip')
      const handled = await h.say(reply)
      rows.push(`${JSON.stringify(reply)}: ${h.readBacks()[0] ?? h.lastText()}`)
      expect(handled, reply).toBe(true)
      expect(h.spent(), reply).toBe(0)
      expect(h.starts, reply).toHaveLength(1)
      // Said again, and again with a yes, while they still wait: still nothing. (A no lets them go, and then nothing waits.)
      if (h.asking()) {
        await h.say(reply)
        await h.say('yes')
        expect(h.spent(), `${reply}, said twice and a yes`).toBe(0)
      }
      const tap = h.yes() ?? h.button('Start a new video')
      if (tap) {
        await h.makes.onAction(tap)
        expect(h.claude(), `${reply}, tapped`).toBe(1)
        expect(h.starts, reply).toHaveLength(2)
        expect([h.starts[1].consent, h.starts[1].quoteFirst], reply).toEqual(['tap', true])
        expect(h.autoMade, reply).toEqual([])
      }
      expect(h.refused, reply).toEqual([])
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
      'under $3',
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

describe('round 6: questions open', () => {
  // The review's own table (review-probe-r6), go-ahead on.
  const replies = [
    'yes', 'Yes!', 'yes please', 'go ahead', 'do it', 'ok go', 'sure, write it', 'write it', 'write the script', 'go', 'start', 'make it', 'just make it', 'proceed', 'confirm', '👍', 'y',
    'Lisbon', 'Lisbon, 5 minutes', 'the 10 minute walk to school', 'not 10 min, more like 5', 'not a documentary', 'nothing about the food',
    'a few minutes', '1:30', '5', 'short', 'TikTok length', 'same as last time', 'how I changed my mind about veganism', 'I changed my mind',
    'make a 5 minute documentary about Lisbon', 'a 2 minute explainer about how vaccines work', 'cut the first 10 seconds', 'export it', 'what do you mean?', '?', '...', 'asdfgh'
  ]

  it('the review’s typed replies: no make:start after the first, no Claude, nothing let go', async () => {
    for (const r of replies) {
      const h = harness({ cap: null, autoUnder: 25 })
      await h.type('make a video about my trip')
      await h.type(r)
      expect(h.starts, r).toHaveLength(1)
      expect(h.spent(), r).toBe(0)
      // A go-ahead in other words is a pause here, never a topic; an edit's words with no edit open are answered as such.
      if (['sure, write it', 'proceed', 'confirm', 'start', 'make it', 'write the script', '👍'].includes(r)) expect(h.readBacks(), r).toEqual([])
      if (['cut the first 10 seconds', 'export it'].includes(r)) expect(h.lastText(), r).toBe(NO_EDIT)
    }
  })

  it('a tapped Yes sends exactly once; "10 minute" in the topic is not its length; a cap typed with the topic is read and shown', async () => {
    for (const [r, line, seconds, cap] of [
      ['the 10 minute walk to school', 'Make it about “the 10 minute walk to school”: a cinematic documentary, 2:00 long?', 120, null],
      ['Lisbon, under $1', 'Make it about “Lisbon”: a cinematic documentary, 2:00 long, no more than $1.00?', 120, 1],
      ['Lisbon, 5 minutes', 'Make it about “Lisbon”: a cinematic documentary, 5:00 long?', 300, null]
    ] as const) {
      const h = harness({ cap: null, autoUnder: 25 })
      await h.type('make a video about my trip')
      await h.type(r)
      expect(h.readBacks(), r).toEqual([line])
      await h.type('yes')
      expect(h.lastText(), r).toBe(TAP_TO_GO)
      expect(h.starts, r).toHaveLength(1)
      await h.makes.onAction(h.yes()!)
      expect(h.claude(), r).toBe(1)
      expect(h.autoMade, r).toEqual([])
      const s = h.starts[1]
      expect([s.consent, s.quoteFirst, s.brief?.seconds, s.brief?.cap], r).toEqual(['tap', true, seconds, cap])
    }
  })

  it('words sent with a file while the questions wait: nothing is read from it, and nothing is sent', async () => {
    for (const r of ['make a documentary about my trip to Lisbon', 'make a 2 minute cinematic documentary about my trip to Lisbon', 'Lisbon']) {
      const h = harness({ cap: null, autoUnder: 25 })
      await h.type('make a video about my trip')
      await h.type(r, PHOTO)
      expect(h.lastText(), r).toBe('Answer the questions above first, or say “never mind” to set them aside. Then send that again.')
      expect(h.starts, r).toHaveLength(1)
      expect(h.spent(), r).toBe(0)
      expect(h.asking(), r).toBe(true)
    }
  })

  it('/make typed while they wait is read back, and starts only on its tap, quoted first', async () => {
    const h = harness({ cap: null, autoUnder: 25 })
    await h.type('make a video about my trip')
    await h.type('/make a 1 minute documentary about whales')
    expect(h.readBacks()).toEqual(['Start a new video about “whales” instead?'])
    expect([...h.msgs.values()].pop()?.actions?.map((a) => a.label)).toEqual(['Start a new video', 'Not now'])
    expect(h.spent()).toBe(0)
    await h.makes.onAction(h.button('Start a new video')!)
    expect(h.claude()).toBe(1)
    expect([h.starts[1].consent, h.starts[1].quoteFirst]).toEqual(['tap', true])
    expect(h.autoMade).toEqual([])
    expect(h.asking()).toBe(false)
  })
})

/** A quote waiting with go-ahead on: a script long enough that the quote passes the $2 Settings goes ahead under. */
const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'
const longScript = (call: number): number => (call === 1 ? 90 : 2)

describe('round 6: a quote waiting', () => {
  it('a change is read back and folded; only its tapped Yes asks Claude', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type(QUOTED)
    await h.type('make it 5 minutes')
    await h.type('and a British voice')
    expect(h.readBacks()[0]).toBe('Change it to 5:00 long?')
    expect(h.readBacks()[1]).toMatch(/^Change it to 5:00 long and .+\?$/)
    await h.type('yes')
    expect(h.claude()).toBe(1)
    await h.makes.onAction(h.yes()!)
    expect(h.claude()).toBe(2)
    expect(h.revises).toEqual([['make it 5 minutes', 'and a British voice']])
  })

  it('a new ask typed in reply is read back with two taps; neither runs until tapped, and neither is made unasked', async () => {
    for (const pick of ['Change this one', 'Start a new video']) {
      // The review's case: go-ahead under $2, a 10 minute quote of more than that waiting.
      const h = harness({ cap: null, autoUnder: 2 }, { sentences: longScript })
      await h.type('make a 10 minute cinematic documentary about the 1950s oil boom')
      expect(h.waitingQuote(), pick).toBeTruthy()
      expect(h.autoMade).toEqual([])
      await h.type('make it a 1 minute documentary about the 1950s oil boom')
      expect(h.readBacks(), pick).toEqual(['Change this one to 1:00 long, or start a new video about “the 1950s oil boom” instead?'])
      expect([...h.msgs.values()].pop()?.actions?.map((a) => a.label)).toEqual(['Change this one', 'Start a new video', 'Not now'])
      expect(h.claude()).toBe(1)
      expect(h.starts).toHaveLength(1)
      await h.makes.onAction(h.button(pick)!)
      expect(h.autoMade, pick).toEqual([])
      expect(h.refused, pick).toEqual([])
      expect(h.claude(), pick).toBe(2)
      if (pick === 'Change this one') expect(h.revises).toEqual([['make it a 1 minute documentary about the 1950s oil boom']])
      else expect([h.starts[1].consent, h.starts[1].quoteFirst]).toEqual(['tap', true])
    }
  })

  it('the review’s new asks typed in reply, with go-ahead on and off: nothing written, made or let go', async () => {
    for (const r of [
      'make it a 5 minute documentary about the 1950s oil boom',
      'a 5 minute documentary about the 1950s oil boom',
      'I want a 2 minute explainer about the oil boom instead',
      'can you make a 3 minute video about the oil boom with maps',
      'yes',
      'go ahead and make it',
      'make it now'
    ]) {
      for (const autoUnder of [null, 2]) {
        const h = harness({ cap: null, autoUnder }, { sentences: longScript })
        await h.type(QUOTED)
        expect(h.waitingQuote(), r).toBeTruthy()
        const before = h.spent()
        await h.type(r)
        expect(h.spent() - before, `${r}, go-ahead ${autoUnder}`).toBe(0)
        expect(h.starts, r).toHaveLength(1)
      }
    }
  })

  it('a go-ahead typed while a quote waits is pointed at its button, with an edit open or not, and never let go', async () => {
    for (const r of ['yes', 'go ahead', 'do it', 'ok, make it', 'sounds good', 'sure, write it', 'proceed', 'confirm', 'start']) {
      for (const open of [null, madeDoc]) {
        const h = harness({ cap: null, autoUnder: null }, { open })
        if (open) await h.type('make it 3 minutes')
        else await h.type(QUOTED)
        expect(h.waitingQuote(), r).toBeTruthy()
        const before = h.spent()
        await h.type(r)
        expect(h.lastText(), r).toBe(QUOTE_WAITS)
        expect(h.spent() - before, `${r}${open ? ', an edit open' : ''}`).toBe(0)
        expect(h.changes, r).toHaveLength(open ? 1 : 0)
      }
    }
  })

  it('an edit’s words while /make questions wait, an edit open: the edit takes them, and nothing is made', async () => {
    const h = harness({ cap: null, autoUnder: 25 }, { open: madeDoc })
    await h.type('/make a video about my trip')
    await h.type('cut the first 10 seconds')
    expect(h.letGo).toEqual(['cut the first 10 seconds'])
    expect(h.claude() + h.goes.length + h.autoMade.length).toBe(0)
  })
})

/** Replies typed while a quote waits, of every kind. */
const QUOTE_REPLIES: { said: string; kind: 'go' | 'change' | 'new' | 'other' }[] = [
  ...['yes', 'go ahead', 'do it', 'ok, make it', 'sounds good', 'sure, write it', 'proceed', 'confirm', 'start', 'make it now', '👍'].map((said) => ({ said, kind: 'go' as const })),
  ...['make it 2 minutes', 'not 10 minutes, make it 5', '1:30', 'no maps', 'under $1', 'black and white', 'vertical'].map((said) => ({ said, kind: 'change' as const })),
  ...['/make a 2 minute documentary about whales', 'make a 5 minute documentary about Lisbon', 'can you make a 3 minute video about the oil boom with maps', 'a 2 minute explainer about volcanoes'].map((said) => ({
    said,
    kind: 'new' as const
  })),
  ...['hmm', 'not now', 'no', 'never mind', 'wait', 'what does it cost?', 'short', 'asdfgh', 'cut the first 10 seconds', 'export it'].map((said) => ({ said, kind: 'other' as const }))
]

describe('round 6: the table, replies typed while a quote waits', () => {
  it(`holds for ${QUOTE_REPLIES.length} replies, with and without an edit open, with and without a file, with go-ahead on and off`, async () => {
    const rows: string[] = []
    for (const open of [null, madeDoc])
      for (const files of [[], PHOTO])
        for (const autoUnder of [null, 2])
          for (const { said, kind } of QUOTE_REPLIES) {
            const h = harness({ cap: null, autoUnder }, { open, sentences: longScript })
            // The quote waiting: a new video's (no edit), or a change of the made video open.
            if (open) await h.type('make it 3 minutes')
            else await h.type(QUOTED)
            const where = `${JSON.stringify(said)}${open ? ', edit open' : ''}${files.length ? ', a photo' : ''}, go-ahead ${autoUnder ?? 'off'}`
            expect(h.waitingQuote(), where).toBeTruthy()
            const before = { spent: h.spent() - h.letGo.length, starts: h.starts.length }
            await h.type(said, files)
            // Typed words alone never write, change, make or start anything.
            expect(h.spent() - h.letGo.length - before.spent, where).toBe(0)
            expect(h.starts.length - before.starts, where).toBe(0)
            expect(h.refused, where).toEqual([])
            // A go-ahead is pointed at the button; a new ask is read back with its own taps; neither goes on to the edit or Claude.
            if (kind === 'go') expect(h.lastText(), where).toBe(files.length ? 'The quote above is still waiting. Press its button, or tell me what to change. Then send that again.' : QUOTE_WAITS)
            if (kind === 'new' && (said.startsWith('/') || !open)) expect(h.button('Start a new video'), where).toBeTruthy()
            if (kind !== 'other') expect(h.letGo, where).toEqual([])
            // Let go only to an edit that is open.
            if (!open) expect(h.letGo, where).toEqual([])
            rows.push(`${where}: ${h.letGo.length ? 'to the edit' : h.lastText()}`)
            // And a tap on what was read back runs exactly one thing, never made unasked.
            const tap = h.yes() ?? h.button('Change this one') ?? h.button('Start a new video')
            if (tap) {
              const spentBefore = h.revises.length + h.starts.length
              await h.makes.onAction(tap)
              expect(h.revises.length + h.starts.length - spentBefore, where).toBe(1)
              expect(h.autoMade, where).toEqual([])
              expect(h.refused, where).toEqual([])
            }
          }
    console.log(rows.join('\n'))
  })
})
