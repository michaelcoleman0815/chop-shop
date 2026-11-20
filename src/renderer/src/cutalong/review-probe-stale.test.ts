import { describe, expect, it, vi } from 'vitest'

/**
 * Review probe, renderer side: the real useMake hook (React's hooks replaced by
 * plain functions, so one call of the hook is one render) talking to the real
 * main-process changeFor through a fake api.
 *
 * 1. Every change of a made video is kept under one key, doc.id + ':into'. A
 *    second quote replaces the first one's draft without taking the first
 *    one's button away, so pressing the older button ("Make it for $0.xx")
 *    makes the newer draft at its own, higher price.
 * 2. "make shot 3 two seconds longer" is read as a new length (15 s): Claude
 *    writes a new script on the person's key before any quote, and with
 *    "go ahead without asking" on, the whole video is made again unasked.
 */

const fake = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))

vi.mock('react', () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useState: <T,>(v: T | (() => T)) => [typeof v === 'function' ? (v as () => T)() : v, () => undefined],
  useCallback: <T,>(f: T) => f,
  useMemo: <T,>(f: () => T) => f()
}))
vi.mock('./api', () => ({ api: fake.api }))

import type { EditDoc } from '../../../shared/edit/schema'
import { readAsk } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { questionsFor, readAnswer } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Msg } from './components/Message'

const phrases = Array.from(
  { length: 24 },
  (_, i) => `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`
)
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const make: Make = {
  v: 1,
  brief: {
    topic: 'the 1950s oil boom',
    format: 'documentary',
    seconds: 120,
    voice: local,
    from: 'topic',
    aspect: 'wide',
    look: 'archival',
    maps: 'auto',
    clips: 'auto',
    images: null,
    cap: null,
    inferred: [],
    ask: 'make a 2 minute documentary about the 1950s oil boom'
  },
  title: 'Black Gold',
  outline: ['The boom'],
  script: phrases.join(' '),
  phrases,
  sections: [0],
  bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: 'West Texas, 1950s', characters: [] },
  shots: phrases.map((_, i) => ({
    phrase: i,
    visual: { kind: 'still' as const, prompt: `A derrick at dusk, number ${i + 1}.`, move: 'push-in' as const, characters: [] },
    title: null,
    callouts: [],
    beat: `b${i}`,
    file: `/made/${i}.png`,
    maker: 'google' as const,
    model: 'gemini-nano-banana-2.1',
    cost: 0.0504,
    key: null,
    note: null
  })),
  sheets: [],
  narration: { path: '/made/narration.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  images: 'google',
  clips: 'google',
  spent: 1.4
}
const doc = { id: 'doc1', sources: [{ id: 's1', path: '/made/narration.wav' }], words: [], assets: [], make, versions: [] } as unknown as EditDoc

const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }

function harness(settings: DraftDeps['settings'], parse: ParseCall, opts: { open?: EditDoc | null } = {}) {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  const goes: { draft: Draft; confirmed: number }[] = []
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => ({
    ok: true,
    change: await changeFor(req.doc, req.text, req.onScreen ?? null, { parse, can, brand: {}, settings })
  })
  fake.api.makeGo = async (req: { draft: Draft; confirmed: number }) => {
    goes.push(req)
    return { ok: false, message: 'probe: stopped before anything is made' }
  }
  // make:start as src/main/make/index.ts runs it at 376360e: questions first unless answered, then
  // Claude writes the script (draftFor), then go() straight away when the quote is under Settings' amount.
  const starts: { text: string; answered: boolean; stop: boolean; quoteFirst: boolean }[] = []
  const madeUnasked: Draft[] = []
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean }) => {
    const shown = msgs.get(`m${n}`)
    starts.push({ text: req.text, answered: !!req.answered, stop: !!shown?.actions?.some((a) => (a.payload ?? '').includes('"stop"')), quoteFirst: !!req.quoteFirst })
    const brief = readAsk(String(req.text ?? ''), { niche: null, recording: req.recording ?? null })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    const drafted = await draftFor(brief, `new-${n}`, { parse, can, brand: {}, settings })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    // As index.ts at b3e9c1a: typed answers (quoteFirst) are quoted, whatever Settings says.
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      madeUnasked.push(drafted.draft)
      return { ok: false, message: 'probe: main makes it here, without asking' }
    }
    const d = drafted.draft
    return { ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  const docRef = { current: (opts.open === undefined ? doc : opts.open) as EditDoc | null }
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
  /** What a typed message does when an edit is open: useMake.handle first, then useCutalong's ask calls useMake.asked. */
  const say = async (text: string): Promise<void> => {
    if (await makes.handle(text, null, [])) return
    await makes.asked(text)
  }
  return { msgs, goes, makes, say, starts, madeUnasked }
}

const noClaude: ParseCall = async () => {
  throw new Error('Claude is not asked in this test')
}

describe('fixed: a made video asked to change twice', () => {
  it('the newer quote takes the older one\'s button away, and the older payload makes nothing', async () => {
    const h = harness({ cap: null, autoUnder: null }, noClaude)
    await h.say('read it with ElevenLabs')
    const m1 = [...h.msgs.entries()].find(([, m]) => m.actions?.some((a) => a.kind === 'make' && a.primary))!
    const oldButton = m1[1].actions!.find((a) => a.primary)!
    await h.say('turn it into a cartoon')
    const live = [...h.msgs.entries()].filter(([, m]) => m.actions?.some((a) => a.kind === 'make' && a.primary))
    console.log(`after two quotes: buttons on ${live.map(([id, m]) => `${id} "${m.actions?.find((a) => a.primary)?.label}"`).join(', ')}; ${m1[0]} now has ${h.msgs.get(m1[0])?.actions?.length ?? 0} actions`)
    // The person presses the first quote's button anyway (a click already on its way).
    await h.makes.onAction(oldButton)
    const said = [...h.msgs.values()].map((m) => m.text).filter((t) => /newer quote/.test(t ?? ''))
    console.log(`pressed "${oldButton.label}": makeGo calls ${h.goes.length}; said: ${said[0]}`)
    // The newest button sends its own price and fingerprint.
    const newest = live[0][1].actions!.find((a) => a.primary)!
    await h.makes.onAction(newest)
    const sent = h.goes[0] as { draft: Draft; confirmed: number; fingerprint?: string }
    console.log(`pressed "${newest.label}": confirmed $${sent.confirmed.toFixed(4)}, fingerprint ${sent.fingerprint}, a ${sent.draft.kept?.narration ? 'restyle' : 'new voice'}`)
    expect(live).toHaveLength(1)
    expect(h.msgs.get(m1[0])?.actions ?? []).toHaveLength(0)
    expect(said).toHaveLength(1)
    expect(h.goes).toHaveLength(1)
    expect(newest.label).toBe(`Make it for $${sent.confirmed.toFixed(2)}`)
    expect(sent.fingerprint).toBeTruthy()
  })
})

describe('fixed: "make shot 3 two seconds longer"', () => {
  it('is an ordinary edit: no Claude, no quote, nothing made', async () => {
    let claude = 0
    const parse: ParseCall = async () => {
      claude++
      return {
        parsed_output: { title: 'Black Gold', sections: [{ heading: 'Boom', paragraphs: ['In 1950 the derricks rose.', 'The men worked on.'] }] },
        stop_reason: 'end_turn',
        usage: { input_tokens: 4000, output_tokens: 3000 }
      }
    }
    const h = harness({ cap: null, autoUnder: 2 }, parse)
    const handled = await h.makes.handle('make shot 3 two seconds longer', null, [])
    const asked = handled ? true : await h.makes.asked('make shot 3 two seconds longer')
    const quoted = [...h.msgs.values()].find((m) => m.make)
    console.log(`taken by useMake: ${asked}; Claude calls ${claude}; quote shown: ${quoted ? quoted.text : 'none'}; makeGo calls ${h.goes.length}`)
    expect(asked).toBe(false)
    expect(claude).toBe(0)
    expect(h.goes).toHaveLength(0)
  })
})

describe('fixed: questions waiting before a script is written', () => {
  it('"never mind" drops them: nothing written, nothing made; and the first make\'s progress carries Stop', async () => {
    let claude = 0
    const parse: ParseCall = async () => {
      claude++
      return {
        parsed_output: { title: 'My Trip', sections: [{ heading: 'North', paragraphs: ['We drove north at dawn.', 'The lake was still.'] }] },
        stop_reason: 'end_turn',
        usage: { input_tokens: 4000, output_tokens: 3000 }
      }
    }
    const h = harness({ cap: null, autoUnder: 2 }, parse, { open: null })
    await h.say('make a video about my trip')
    const card = [...h.msgs.values()].find((m) => m.makeAsk)
    console.log(`asked: "${card?.text}"; Claude calls so far: ${claude}`)
    // The person decides against it.
    await h.say('never mind')
    const reply = [...h.msgs.values()].map((m) => m.text).filter(Boolean).pop()
    console.log(`after "never mind": Claude calls ${claude}; make:start calls ${h.starts.length}; made without asking: ${h.madeUnasked.length}; said: ${reply}`)
    console.log(`Stop on the first make's progress: ${h.starts[0]?.stop}`)
    expect(card).toBeTruthy()
    expect(claude).toBe(0)
    expect(h.starts).toHaveLength(1)
    expect(h.madeUnasked).toHaveLength(0)
    expect(h.starts[0].stop).toBe(true)
  })

  it('an edit asked of the open video lets the questions go and is not taken as their answer', async () => {
    let claude = 0
    const parse: ParseCall = async () => {
      claude++
      return {
        parsed_output: { title: 'My Trip', sections: [{ heading: 'North', paragraphs: ['We drove north at dawn.', 'The lake was still.'] }] },
        stop_reason: 'end_turn',
        usage: { input_tokens: 4000, output_tokens: 3000 }
      }
    }
    // An edit is open; /make is asked from it, and its questions are left unanswered.
    const h = harness({ cap: null, autoUnder: null }, parse)
    await h.makes.handle('/make a video about my trip', { command: 'make', rest: 'a video about my trip' }, [])
    const handled = await h.makes.handle('cut the first 10 seconds', null, [])
    console.log(`"cut the first 10 seconds" taken by the questions: ${handled}; make:start calls ${h.starts.length}; Claude calls ${claude}`)
    expect(handled).toBe(false)
    expect(h.starts).toHaveLength(1)
    expect(claude).toBe(0)
  })

  const writes = (): { parse: ParseCall; calls: () => number } => {
    let claude = 0
    const parse: ParseCall = async () => {
      claude++
      return {
        parsed_output: { title: 'My Trip', sections: [{ heading: 'North', paragraphs: ['We drove north at dawn.', 'The lake was still.'] }] },
        stop_reason: 'end_turn',
        usage: { input_tokens: 4000, output_tokens: 3000 }
      }
    }
    return { parse, calls: () => claude }
  }

  it('fixed at b3e9c1a: the pauses the builder listed wait, spending nothing, and the questions stay', async () => {
    const listed = ['hold on a sec', 'give me a minute', 'hang on', 'let me think about it', 'wait, what do you mean?', 'maybe later', 'ok', 'up to you']
    const qs = questionsFor(readAsk('make a video about my trip')!)
    for (const p of listed) console.log(`listed: readAnswer("${p}") -> ${JSON.stringify(readAnswer(p, qs))}`)
    const w = writes()
    const h = harness({ cap: null, autoUnder: 2 }, w.parse, { open: null })
    await h.say('make a video about my trip')
    await h.say('hold on a sec')
    const stillAsking = [...h.msgs.values()].some((m) => m.makeAsk)
    console.log(`after "hold on a sec": Claude calls ${w.calls()}; make:start calls ${h.starts.length}; questions still open: ${stillAsking}`)
    expect(listed.every((p) => readAnswer(p, qs).kind === 'wait')).toBe(true)
    expect(w.calls()).toBe(0)
    expect(stillAsking).toBe(true)
  })

  it('fixed at e11324f: a refusal or a pause in other words is a no or a wait, and Claude writes nothing for it', async () => {
    const qs = questionsFor(readAsk('make a video about my trip')!)
    const other = [
      'I changed my mind',
      'scratch that',
      'forget about the video',
      'actually, don’t',
      'I don’t want it anymore',
      'hmm let me see',
      'I’m not sure yet',
      'gimme a sec',
      'busy right now',
      'no idea',
      'no clue',
      'no rush, thinking',
      'skip',
      "I'll pass",
      'do not',
      "let's not",
      "I'd rather not",
      'not interested',
      'maybe another time',
      'please don’t',
      'abort'
    ]
    const read = other.map((p) => ({ p, r: readAnswer(p, qs) }))
    for (const { p, r } of read) console.log(`round 4 list: readAnswer("${p}") -> ${JSON.stringify(r)}`)
    const w = writes()
    const h = harness({ cap: null, autoUnder: 2 }, w.parse, { open: null })
    await h.say('make a video about my trip')
    await h.say('I changed my mind')
    console.log(`after "I changed my mind": Claude calls ${w.calls()}; make:start calls ${h.starts.length}; said: ${[...h.msgs.values()].map((m) => m.text).filter(Boolean).pop()}`)
    expect(read.filter(({ r }) => r.kind !== 'no' && r.kind !== 'wait').map(({ p }) => p)).toEqual([])
    expect(w.calls()).toBe(0)
    expect(h.starts).toHaveLength(1)
  })

  it('e11324f: a topic in the person\'s own words is read back, and Claude is asked only after a yes', async () => {
    const w = writes()
    const h = harness({ cap: null, autoUnder: 2 }, w.parse, { open: null })
    await h.say('make a video about my trip')
    await h.say('Lisbon, 5 minutes')
    const back = [...h.msgs.entries()].find(([, m]) => /^Make it about/.test(m.text ?? ''))
    console.log(`"Lisbon, 5 minutes" -> "${back?.[1].text}" with ${JSON.stringify(back?.[1].actions?.map((a) => a.label))}; Claude calls ${w.calls()}; make:start calls ${h.starts.length}`)
    // Not now, by its button: nothing written, the questions stay.
    const not = back?.[1].actions?.find((a) => a.label === 'Not now')
    if (not) await h.makes.onAction(not as never)
    console.log(`after Not now: Claude calls ${w.calls()}; make:start calls ${h.starts.length}; said: ${[...h.msgs.values()].map((m) => m.text).filter(Boolean).pop()}`)
    expect(w.calls()).toBe(0)
    // Said again, then another topic: the first read-back loses its buttons, and only the newest one can be confirmed.
    await h.say('Lisbon')
    const first = [...h.msgs.entries()].filter(([, m]) => /^Make it about/.test(m.text ?? '')).pop()
    await h.say('Porto instead')
    const second = [...h.msgs.entries()].filter(([, m]) => /^Make it about/.test(m.text ?? '')).pop()
    console.log(`read back "${first?.[1].text}" then "${second?.[1].text}"; first still has buttons: ${(h.msgs.get(first?.[0] ?? '')?.actions ?? []).length > 0}`)
    // f2e7518: a typed yes sends nothing ("Tap Yes above…"); the read-back's Yes, tapped, writes it once.
    await h.say('yes')
    const typedYes = w.calls()
    const newest = [...h.msgs.values()].filter((m) => (m.actions ?? []).some((a) => a.label === 'Yes')).pop()
    const yes = newest?.actions?.find((a) => a.label === 'Yes')
    if (yes) await h.makes.onAction(yes as never)
    console.log(`typed "yes": Claude calls ${typedYes}; said "${[...h.msgs.values()].map((m) => m.text).filter(Boolean)[[...h.msgs.values()].map((m) => m.text).filter(Boolean).length - 2]}"; tapped Yes: Claude calls ${w.calls()}`)
    expect(typedYes).toBe(0)
    const quoted = [...h.msgs.values()].find((m) => m.make)
    console.log(
      `after "yes": Claude calls ${w.calls()}; make:start sent ${JSON.stringify(h.starts[h.starts.length - 1]?.text)} quoteFirst=${h.starts[h.starts.length - 1]?.quoteFirst}; made without asking: ${h.madeUnasked.length}; quote: ${quoted?.text}`
    )
    expect(back).toBeTruthy()
    expect((h.msgs.get(first?.[0] ?? '')?.actions ?? []).length).toBe(0)
    expect(w.calls()).toBe(1)
    expect(h.madeUnasked).toHaveLength(0)
  })

  it('e11324f: replies the questions do not read are let go, to whatever reads them next (Claude\'s triage with no edit open)', async () => {
    // Only "How long?" is asked of this prompt; these are answers to it, in words the reader does not know.
    const qs = questionsFor(readAsk('make a documentary about the gold rush')!)
    const replies = ['a few minutes', 'a couple of minutes', 'short', 'quick one', 'not too long', '1:30', 'TikTok length', 'same as last time']
    const rows: string[] = []
    let dropped = 0
    for (const r of replies) {
      const w = writes()
      const h = harness({ cap: null, autoUnder: null }, w.parse, { open: null })
      await h.say('make a documentary about the gold rush')
      const handled = await h.makes.handle(r, null, [])
      const askId = [...h.msgs.values()].find((m) => m.makeAsk)?.makeAsk
      const asking = askId ? h.makes.questions(String(askId)) !== null : false
      const card = [...h.msgs.values()].find((m) => m.aside === 'Left unanswered, so nothing was written.')
      if (!handled) dropped++
      rows.push(`"${r}": readAnswer ${JSON.stringify(readAnswer(r, qs))}; handled by useMake: ${handled}; questions still open: ${asking}; dropped: ${!!card}; Claude (make) calls ${w.calls()}`)
    }
    console.log(`questions asked: ${JSON.stringify(qs.map((q) => q.id))}\n${rows.join('\n')}`)
    // useCutalong.ts:3713-3719 at e11324f: what make.handle does not take goes to readAsk, Claude's triage, when no edit is open.
    expect(dropped).toBe(0)
  })

  it('e11324f: topics that use a hold or a no word on their own', async () => {
    const qs = questionsFor(readAsk('make a video about my trip')!)
    const topics = ['how I changed my mind about veganism', 'a love story from another time', 'the busy streets of Lisbon', 'why not knowing is fine', 'the day I said no', 'my road trip, no rush, lots of stops']
    for (const t of topics) console.log(`topic "${t}" -> ${JSON.stringify(readAnswer(t, qs))}`)
    expect(qs.map((q) => q.id)).toEqual(['topic', 'style', 'length'])
  })
})
