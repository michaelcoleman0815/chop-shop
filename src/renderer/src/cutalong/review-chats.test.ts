import { describe, expect, it, vi } from 'vitest'

/**
 * Regression for the seventh money review: what a made video leaves waiting
 * belongs to the chat it was asked in. The real useMake hook (React's hooks
 * replaced by plain functions) talks to the real draftFor, revise and
 * changeFor through a fake api that checks consent as main does, and the
 * window is played as useCutalong plays it: a chat is a list of messages,
 * another chat (or a new one, or the same one after a restart) changes
 * `chat()` and goes through `restore`, which expires what was saved with it.
 *
 * Nothing typed in a chat spends without a tap in that chat; nothing of one
 * chat can be tapped or changed from another; a chat opened again with
 * something left waiting counts as waiting; and while a quote waits, a reply
 * that neither changes it nor is plainly an edit stays here, however it is
 * said.
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
import { questionsFor } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, quoteDraft, revise, withScript, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const lines = Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`)
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
const QUOTE_WAITS = 'Tap the button above to go ahead, or tell me what to change. Nothing is spent until you tap it; say “not now” to set it aside.'
const EXPIRED_WAITS = 'What was waiting above has expired, so nothing is written or made from it. Ask again for a fresh quote, or say “never mind”.'

type Spend = { what: string; consent: unknown; topic?: string; cap?: number | null; quoteFirst?: boolean; chat: string }

/**
 * The window: chats of messages, one open at a time, and one useMake, as useCutalong has them. `open` changes
 * chats as goStart and openProject do; `restart` is Cutalong opened again on a saved chat (a new hook).
 */
function window(settings: DraftDeps['settings'], opts: { sentences?: (call: number) => number } = {}) {
  let key = 0
  let messages = new Map<string, Partial<Msg>>()
  let n = 0
  let claude = 0
  const spend: Spend[] = []
  const letGo: string[] = []
  const parse: ParseCall = async () => {
    claude++
    const count = opts.sentences?.(claude) ?? 3
    const paragraphs =
      count === 3
        ? ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.']
        : Array.from({ length: count }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over boom town number ${i + 1} and the men worked on through the night.`)
    return { parsed_output: { title: 'A Video', sections: [{ heading: 'One', paragraphs }] }, stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 3000 } }
  }
  const deps: DraftDeps = { parse, can, brand: {}, settings }
  const quoted = (d: Draft) => ({ ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) })
  const tapped = (c: unknown): boolean => c === 'tap'
  const asked = (c: unknown): boolean => c === 'tap' || c === 'command'
  let made = 0
  /** Each change of a made video priced (free, and never made without its button), with the recording sent with it. */
  const priced: { text: string; recording: string | null }[] = []
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => true
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null; recording?: string | null }) => {
    priced.push({ text: req.text, recording: req.recording ?? null })
    return { ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, deps, req.recording ?? null) }
  }
  fake.api.makeScript = async (req: { draft: Draft; script: string }) => {
    const d = withScript(req.draft, req.script, deps)
    return { ok: true, draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  // Main, consent and all, as index.ts runs it: questions need none; a script needs a tap or a fresh ask; a quote's
  // change, a make and a shot need a tap; under Settings' amount, made straight away only without quoteFirst.
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: unknown }) => {
    const read = readAsk(String(req.reading ?? req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && req.reading ? { ...read, ask: req.text } : read
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (!asked(req.consent)) return { ok: false, message: 'refused: no consent' }
    spend.push({ what: 'start', consent: req.consent, topic: brief.topic, cap: brief.cap, quoteFirst: !!req.quoteFirst, chat: String(key) })
    const drafted = await draftFor(brief, `video-${spend.length}`, deps)
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      made++
      return { ok: false, message: 'test: made straight away' }
    }
    return quoted(drafted.draft)
  }
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: unknown }) => {
    if (!tapped(req.consent)) return { ok: false, message: 'refused: no consent' }
    spend.push({ what: 'revise', consent: req.consent, topic: req.draft.brief.topic, chat: String(key) })
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
  fake.api.makeGo = async (req: { draft: Draft; consent?: unknown }) => {
    if (!tapped(req.consent)) return { ok: false, message: 'refused: no consent' }
    spend.push({ what: 'go', consent: req.consent, topic: req.draft.brief.topic, chat: String(key) })
    return { ok: false, message: 'test: stopped before anything is made' }
  }
  fake.api.makeShot = async (req: { consent?: unknown }) => {
    if (!tapped(req.consent)) return { ok: false, message: 'refused: no consent' }
    spend.push({ what: 'shot', consent: req.consent, chat: String(key) })
    return { ok: false, message: 'test: stopped' }
  }
  const docRef = { current: null as EditDoc | null }
  const hook = (): ReturnType<typeof useMake> =>
    useMake({
      docRef,
      setDoc: () => undefined,
      setMediaUrl: () => undefined,
      push: (m) => {
        const id = `m${++n}`
        messages.set(id, { ...m })
        return id
      },
      // As useCutalong's patch: only a message of the chat open.
      patch: (id, p) => {
        if (messages.has(id)) messages.set(id, { ...messages.get(id), ...p })
      },
      applyAsVersion: () => null,
      during: (work) => work(),
      findBroll: async () => undefined,
      brand: () => 'default',
      chat: () => String(key)
    })
  let makes = hook()
  /** Another chat open: a new one (no messages), or a saved one, as openProject restores it. */
  const open = (saved: Map<string, Partial<Msg>> = new Map(), doc: EditDoc | null = null): Map<string, Partial<Msg>> => {
    const was = messages
    key += 1
    docRef.current = doc
    messages = new Map([...makes.restore([...saved.entries()].map(([id, m]) => ({ id, ...m }) as Msg)).map((m) => [m.id, m] as const)])
    return was
  }
  /** Cutalong opened again on a saved chat: a new hook, and the chat restored. */
  const restart = (saved: Map<string, Partial<Msg>>, doc: EditDoc | null = null): void => {
    makes = hook()
    open(saved, doc)
  }
  const type = async (text: string, files: { name: string; path: string }[] = []): Promise<void> => {
    const command = /^\s*\/(\w+)\s*(.*)$/s.exec(text)
    if (await makes.handle(text, command ? { command: command[1], rest: command[2] } : null, files as never)) return
    if (docRef.current && (await makes.asked(text))) return
    letGo.push(text)
  }
  const buttons = (label?: string): Action[] =>
    [...messages.values()].flatMap((m) => (m.actions ?? []).filter((a) => a.kind === 'make' && (!label || a.label === label))) as Action[]
  const tap = async (a: Action | undefined): Promise<void> => {
    if (a) await makes.onAction(a)
  }
  const last = (): Partial<Msg> | undefined => [...messages.values()].pop()
  const quoteShown = (): boolean => buttons().some((a) => (a.payload ?? '').includes('"go"'))
  return {
    makes: () => makes,
    open,
    restart,
    type,
    buttons,
    tap,
    last,
    quoteShown,
    messages: () => messages,
    setDoc: (d: EditDoc | null) => (docRef.current = d),
    spend,
    letGo,
    priced,
    claude: () => claude,
    made: () => made
  }
}

/** What can be left waiting in a chat, each set up from nothing. */
const STATES: [string, (w: ReturnType<typeof window>) => Promise<void>][] = [
  ['questions', async (w) => void (await w.type('make a video about my trip'))],
  [
    'a read-back of an answer',
    async (w) => {
      await w.type('make a video about my trip')
      await w.type('Lisbon')
    }
  ],
  ['a quote', async (w) => void (await w.type('make a 1 minute cinematic documentary about the oil boom in Texas'))],
  [
    'a change of a quote read back',
    async (w) => {
      await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
      await w.type('make it 3 minutes')
    }
  ],
  [
    'a new ask read back over a quote',
    async (w) => {
      await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
      await w.type('make a 5 minute documentary about Lisbon')
    }
  ]
]

/** Asks typed in the chat opened. */
const TYPED = [
  'make it a 2 minute documentary about the oil boom in Texas',
  'make a 2 minute documentary about Lisbon',
  '/make a 2 minute documentary about whales',
  'make it 3 minutes',
  'yes',
  'ship it',
  'Lisbon',
  'cut the first 10 seconds'
]

describe('a chat opened again with something left waiting', () => {
  it('expires its make buttons and questions, and says so', async () => {
    for (const [state, setup] of STATES) {
      const w = window({ cap: null, autoUnder: null })
      await setup(w)
      const saved = w.messages()
      expect(w.buttons().length + [...saved.values()].filter((m) => m.makeAsk).length, state).toBeGreaterThan(0)
      w.restart(saved)
      expect(w.buttons(), state).toEqual([])
      expect([...w.messages().values()].some((m) => m.makeAsk), state).toBe(false)
      expect([...w.messages().values()].some((m) => /has expired|have expired/.test(m.aside ?? '')), state).toBe(true)
    }
  })

  it('counts as waiting: a new ask typed there is read back, and nothing typed there spends or goes on to Claude', async () => {
    const rows: string[] = []
    for (const [state, setup] of STATES)
      for (const how of ['reopened after a restart', 'opened from another chat'])
        for (const typed of TYPED) {
          // The quote set up first; then go-ahead under $2, so a new ask would come in under it.
          const settings: DraftDeps['settings'] = { cap: null, autoUnder: null }
          const w = window(settings)
          await setup(w)
          settings.autoUnder = 2
          const saved = w.messages()
          if (how === 'reopened after a restart') w.restart(saved)
          else {
            w.open()
            await w.type('make a video about the sea')
            w.open(saved)
          }
          const before = { spend: w.spend.length, claude: w.claude(), made: w.made() }
          await w.type(typed)
          const where = `${state}, ${how}: ${JSON.stringify(typed)}`
          rows.push(`${where} -> "${w.last()?.text}" ${JSON.stringify(w.buttons().map((a) => a.label))}`)
          expect(w.spend.length - before.spend, where).toBe(0)
          expect(w.claude() - before.claude, where).toBe(0)
          expect(w.made() - before.made, where).toBe(0)
          expect(w.letGo, where).toEqual([])
          if (/documentary about/.test(typed)) expect(w.last()?.text, where).toMatch(/^Start a new video about “.+” instead\?$/)
          if (['make it 3 minutes', 'yes', 'ship it', 'Lisbon'].includes(typed)) expect(w.last()?.text, where).toBe(EXPIRED_WAITS)
        }
    console.log(rows.slice(0, 16).join('\n'))
  })

  it('settles on a tap or a no: then a fresh ask is the ask itself again', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
    w.restart(w.messages())
    await w.type('make a 2 minute documentary about Lisbon')
    await w.tap(w.buttons('Start a new video').pop())
    expect(w.spend.map((s) => `${s.what}/${s.consent}`)).toEqual(['start/command', 'start/tap'])
    // A no settles it too.
    const v = window({ cap: null, autoUnder: null })
    await v.type('make a 1 minute cinematic documentary about the oil boom in Texas')
    v.restart(v.messages())
    await v.type('never mind')
    expect(v.last()?.text).toBe('All right. Nothing was written or spent.')
    await v.type('make a 2 minute documentary about Lisbon')
    expect(v.spend.map((s) => `${s.what}/${s.consent}`)).toEqual(['start/command', 'start/command'])
  })

  it('a chat whose quote was set aside before it was saved has nothing waiting: a fresh ask there is the ask itself', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
    await w.type('not now')
    expect(w.last()?.text).toBe('All right, I’ve set that quote aside. Nothing was spent.')
    w.restart(w.messages())
    expect([...w.messages().values()].some((m) => /expired/.test(m.aside ?? ''))).toBe(false)
    await w.type('make a 2 minute documentary about Lisbon')
    expect(w.spend.map((s) => `${s.what}/${s.consent}: ${s.topic}`)).toEqual(['start/command: the oil boom in Texas', 'start/command: Lisbon'])
  })
})

describe('a new chat, or another one opened', () => {
  it('nothing the last chat left waiting comes along: only a fresh ask of this chat’s own is written, and nothing else spends', async () => {
    // A chat saved with its quote set aside: nothing waits in it.
    const s = window({ cap: null, autoUnder: null })
    await s.type('make a 1 minute cinematic documentary about the moon landing')
    await s.type('not now')
    const settled = s.messages()
    for (const [state, setup] of STATES)
      for (const how of ['a new chat', 'another chat opened, with nothing waiting in it'])
        for (const autoUnder of [null, 2])
          for (const typed of TYPED) {
            const settings: DraftDeps['settings'] = { cap: null, autoUnder: null }
            const w = window(settings)
            await setup(w)
            settings.autoUnder = autoUnder
            const left = w.buttons()
            w.open(how === 'a new chat' ? new Map() : settled)
            const before = { spend: w.spend.length, claude: w.claude(), made: w.made() }
            const where = `${state}, then ${how}, go-ahead ${autoUnder ?? 'off'}: ${JSON.stringify(typed)}`
            await w.type(typed)
            // Nothing offered against the last chat's quote, nor any of its buttons here.
            expect(w.buttons('Change this one'), where).toEqual([])
            expect(w.buttons().filter((b) => left.some((l) => l.payload === b.payload)), where).toEqual([])
            const spent = w.spend.slice(before.spend)
            if (/documentary about/.test(typed)) {
              // A fresh ask with nothing waiting is the person's own go-ahead to write its script: this chat's, and only that.
              expect(spent.map((c) => `${c.what}/${c.consent}/${c.chat}`), where).toEqual([`start/command/${String(1)}`])
              expect(spent[0].topic, where).toBe(/about (.+)$/.exec(typed)?.[1])
              expect(w.claude() - before.claude, where).toBe(1)
            } else {
              // Anything else typed there spends nothing, asks nothing of Claude and makes nothing.
              expect(spent, where).toEqual([])
              expect(w.claude() - before.claude, where).toBe(0)
              expect(w.made() - before.made, where).toBe(0)
            }
          }
  })

  it('a tap in chat B never acts on chat A’s quote, a read-back of it or its questions', async () => {
    for (const [state, setup] of STATES) {
      const w = window({ cap: null, autoUnder: null })
      await setup(w)
      const a = w.buttons()
      const before = w.spend.length
      w.open()
      await w.type('make a 2 minute documentary about Lisbon')
      // Chat A's buttons, pressed from chat B (a click already on its way, or a payload kept): nothing of A moves.
      for (const b of a) await w.tap(b)
      const fromB = w.spend.slice(before)
      expect(fromB.filter((s) => /oil boom in Texas|my trip/.test(s.topic ?? '')), state).toEqual([])
      expect(fromB.filter((s) => s.what !== 'start'), state).toEqual([])
    }
  })

  it('the review’s case: a new chat’s ask offers nothing against the last chat’s quote, and its button makes nothing there', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
    const go = w.buttons().find((a) => (a.payload ?? '').includes('"go"'))
    w.open()
    await w.type('make a 2 minute documentary about Lisbon')
    expect(w.buttons('Change this one')).toEqual([])
    await w.tap(go)
    expect(w.spend.map((s) => `${s.what}/${s.consent}: ${s.topic}`)).toEqual(['start/command: the oil boom in Texas', 'start/command: Lisbon'])
  })
})

describe('work in flight when another chat opens', () => {
  /** The fake api's `name`, held once called (`started`) until `release` is called. */
  const hold = (name: string): { started: Promise<void>; release: () => void } => {
    const real = fake.api[name] as (req: unknown) => Promise<unknown>
    let release = (): void => undefined
    let begin = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    const started = new Promise<void>((r) => (begin = r))
    fake.api[name] = async (req: unknown) => {
      begin()
      await gate
      return real(req)
    }
    return { started, release: () => release() }
  }

  it('a change of the last chat’s video, priced meanwhile, lands nowhere, and what was typed goes nowhere else', async () => {
    const w = window({ cap: null, autoUnder: null })
    w.setDoc(madeDoc)
    const held = hold('makeChange')
    const typed = w.type('make it 3 minutes')
    await held.started
    w.open()
    held.release()
    await typed
    expect([...w.messages().values()]).toEqual([])
    expect(w.letGo).toEqual([])
    // Nothing of it waits in the new chat: a fresh ask there is its own.
    await w.type('make a 2 minute documentary about Lisbon')
    expect(w.buttons('Change this one')).toEqual([])
    expect(w.spend.map((s) => `${s.what}/${s.consent}: ${s.topic}`)).toEqual(['start/command: Lisbon'])
  })

  it('a script edited under the last chat’s quote, read again meanwhile, is quoted nowhere', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
    const key = JSON.parse(w.buttons().find((a) => (a.payload ?? '').includes('"go"'))?.payload ?? '{}').id as string
    const held = hold('makeScript')
    const edited = w.makes().editScript(key, 'We drove south at dusk. The sea was loud. The town slept.')
    await held.started
    w.open()
    held.release()
    await edited
    expect([...w.messages().values()]).toEqual([])
    await w.type('make a 2 minute documentary about Lisbon')
    expect(w.buttons('Change this one')).toEqual([])
    expect(w.spend.map((s) => `${s.what}/${s.consent}: ${s.topic}`)).toEqual(['start/command: the oil boom in Texas', 'start/command: Lisbon'])
  })

  it('the voice-over a made video waits for stays with its chat', async () => {
    const take = [{ name: 'take.m4a', path: '/tmp/take.m4a' }]
    // In its own chat, the recording sent is the voice-over it waited for, and only priced.
    const a = window({ cap: null, autoUnder: null })
    a.setDoc(madeDoc)
    await a.type('use my own voice')
    expect(a.last()?.text).toMatch(/^Drop your voice-over in/)
    await a.type('', take)
    expect(a.priced.filter((p) => p.recording)).toEqual([{ text: 'use my own recording', recording: '/tmp/take.m4a' }])
    // Another chat with a made video of its own: a recording sent there is not taken for the last chat's wait.
    const b = window({ cap: null, autoUnder: null })
    b.setDoc(madeDoc)
    await b.type('use my own voice')
    b.open(new Map(), { ...madeDoc, id: 'doc2' } as EditDoc)
    await b.type('', take)
    expect(b.priced.filter((p) => p.recording)).toEqual([])
    expect(b.spend).toEqual([])
  })
})

describe('a quote waiting, a made video open', () => {
  it('a reply that neither changes the quote nor is plainly an edit stays here, however it is said', async () => {
    const replies = ['yes', 'go ahead', 'do it', 'ok, make it', 'sounds good', 'yes make it', 'ship it', 'make it so', 'go on then', 'make it happen', "let's go", 'cool', 'approved', 'lgtm', '👍', 'yes, go for it please', 'yep do it now', 'that works', 'looks right to me', 'perfect, go', 'alright then', 'fine by me', 'what does it cost?', 'hmm', 'asdfgh']
    for (const r of replies) {
      const w = window({ cap: null, autoUnder: null })
      w.setDoc(madeDoc)
      await w.type('make it 3 minutes')
      expect(w.quoteShown(), r).toBe(true)
      await w.type(r)
      expect(w.letGo, r).toEqual([])
      expect(w.last()?.text, r).toBe(QUOTE_WAITS)
      expect(w.spend, r).toEqual([])
    }
  })

  it('a change of the quote is read back, an edit’s words go to the edit, and “not now” sets the quote aside', async () => {
    const w = window({ cap: null, autoUnder: null })
    w.setDoc(madeDoc)
    await w.type('make it 3 minutes')
    await w.type('make it 4 minutes')
    expect(w.last()?.text).toBe('Change it to 4:00 long?')
    // What an edit does, or a part only an edit has: the edit's, while the quote and its read-back wait.
    const edits = ['cut the first 10 seconds', 'make the captions bigger', 'the music is too loud at 1:20', 'shot 3 should hold longer', 'can you make the subtitles yellow']
    for (const e of edits) await w.type(e)
    expect(w.letGo).toEqual(edits)
    expect(w.quoteShown()).toBe(true)
    // A change of the quote said with an edit's verb is still the quote's, read back with what was said before it.
    await w.type('turn it into an explainer')
    expect(w.last()?.text).toMatch(/^Change it to .*an animated explainer.*4:00 long|^Change it to .*4:00 long.*an animated explainer/)
    expect(w.letGo).toEqual(edits)
    await w.type('not now')
    expect(w.last()?.text).toBe('The quote stands as it was. Press its button to make it, or tell me what to change: its length, its voice, its look.')
    await w.type('not now')
    expect(w.last()?.text).toBe('All right, I’ve set that quote aside. Nothing was spent.')
    expect(w.quoteShown()).toBe(false)
    // Set aside, the edit has the chat again, whatever is typed.
    await w.type('ship it')
    expect(w.letGo).toEqual([...edits, 'ship it'])
    expect(w.spend).toEqual([])
  })

  it('opened again with its quote expired: an edit’s words go to the edit, anything else stays here', async () => {
    const w = window({ cap: null, autoUnder: null })
    w.setDoc(madeDoc)
    await w.type('make it 3 minutes')
    w.restart(w.messages(), madeDoc)
    expect(w.quoteShown()).toBe(false)
    for (const r of ['ship it', 'yes', 'make it so']) {
      await w.type(r)
      expect(w.last()?.text, r).toBe(EXPIRED_WAITS)
    }
    await w.type('cut the first 10 seconds')
    await w.type('make the captions bigger')
    expect(w.letGo).toEqual(['cut the first 10 seconds', 'make the captions bigger'])
    // A change of the video asked afresh is priced afresh, and waits for its own button.
    await w.type('make it 4 minutes')
    expect(w.quoteShown()).toBe(true)
    expect(w.spend).toEqual([])
  })
})

/** The seventh review's own cases, in one chat. */
describe('round 7: in one chat', () => {
  const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'
  const NEW_ASKS = [
    'make a 5 minute documentary about Lisbon',
    'make it a 2 minute documentary about the 1950s oil boom',
    'a 3 minute explainer about how vaccines work',
    'I want a 2 minute video about the gold rush',
    '/make a 2 minute documentary about Lisbon',
    '/documentary about the moon landing, 1 minute'
  ]
  const WAITING: [string, (w: ReturnType<typeof window>) => Promise<void>][] = [
    ['questions', async (w) => void (await w.type('make a video about my trip'))],
    [
      'a read-back of an answer',
      async (w) => {
        await w.type('make a video about my trip')
        await w.type('Lisbon')
      }
    ],
    ['a quote', async (w) => void (await w.type(QUOTED))],
    [
      'a quote change read back',
      async (w) => {
        await w.type(QUOTED)
        await w.type('make it 3 minutes')
      }
    ],
    [
      'a new ask read back',
      async (w) => {
        await w.type(QUOTED)
        await w.type('make a 5 minute documentary about Lisbon')
      }
    ]
  ]

  it('a new ask typed while anything waits is never a command, and writes nothing, with a file or not', async () => {
    for (const [state, setup] of WAITING)
      for (const ask of NEW_ASKS)
        for (const files of [[], [{ name: 'lisbon.jpg', path: '/tmp/lisbon.jpg' }], [{ name: 'voice.m4a', path: '/tmp/voice.m4a' }]]) {
          // Go-ahead under $2: the first quote (a 90-line script) waits above it; a new ask (3 lines) would come in under it.
          const w = window({ cap: null, autoUnder: 2 }, { sentences: (call) => (call === 1 ? 90 : 3) })
          await setup(w)
          const before = { spend: w.spend.length, claude: w.claude(), made: w.made() }
          await w.type(ask, files)
          const where = `${state} + ${JSON.stringify(ask)}${files.length ? ` + ${files[0].name}` : ''}`
          expect(w.spend.slice(before.spend), where).toEqual([])
          expect(w.claude() - before.claude, where).toBe(0)
          expect(w.made() - before.made, where).toBe(0)
        }
  })

  it('a fresh ask with nothing waiting is a command; taps carry tap, and a read-back’s Yes is quoted first', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    await w.type('make it 3 minutes')
    await w.tap(w.buttons('Yes').pop())
    await w.type('make a 5 minute documentary about Lisbon')
    await w.tap(w.buttons('Start a new video').pop())
    expect(w.spend.map((c) => `${c.what}/${c.consent}${c.quoteFirst ? '/quoteFirst' : ''}`)).toEqual(['start/command', 'revise/tap', 'start/tap/quoteFirst'])
  })

  it('an old Yes, and taps made twice at once, send once at most', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a video about my trip')
    await w.type('Lisbon')
    const yes = w.buttons('Yes').pop()
    await w.type('Porto')
    await w.tap(yes)
    expect(w.spend).toEqual([])
    const newer = w.buttons('Yes').pop()
    await Promise.all([w.tap(newer), w.tap(newer)])
    const go = w.buttons().filter((a) => (a.payload ?? '').includes('"go"')).pop()
    await Promise.all([w.tap(go), w.tap(go)])
    expect(w.spend.map((c) => `${c.what}/${c.consent}`)).toEqual(['start/tap', 'go/tap'])
  })

  it('buttons saved with a chat send nothing once Cutalong is opened again, pressed or not', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    await w.type('make it 3 minutes')
    await w.type('make a 5 minute documentary about Lisbon')
    const saved = w.buttons()
    expect(saved.length).toBeGreaterThan(0)
    const before = w.spend.length
    w.restart(w.messages())
    // Pressed anyway (a click already on its way, a payload kept): a new window holds nothing behind them.
    for (const a of saved) await w.tap(a)
    expect(w.spend.slice(before)).toEqual([])
  })

  it('"Lisbon, under $1" reads the limit; "cut the first 10 seconds" with no edit open is answered here', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a video about my trip')
    await w.type('Lisbon, under $1')
    expect(w.last()?.text).toBe('Make it about “Lisbon”: a cinematic documentary, 2:00 long, no more than $1.00?')
    await w.tap(w.buttons('Yes').pop())
    expect(w.spend.map((c) => c.cap)).toEqual([1])
    const v = window({ cap: null, autoUnder: null })
    await v.type('make a video about my trip')
    await v.type('cut the first 10 seconds')
    expect(v.last()?.text).toBe('There’s no video open to edit yet. Tap an answer above, or say “never mind” to set these questions aside.')
    expect(v.spend).toEqual([])
    expect(v.letGo).toEqual([])
  })
})
