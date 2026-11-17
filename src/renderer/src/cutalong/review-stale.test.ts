import { describe, expect, it, vi } from 'vitest'

/**
 * Regression for the money review's second, third and fourth findings, on
 * the window's side: the real useMake hook (React's hooks replaced by plain
 * functions, so one call of the hook is one render) talking to the real
 * main-process changeFor and draftFor through a fake api.
 *
 * Each quote has its own button and only the newest keeps it; pressing it
 * sends the price it showed and its draft's fingerprint. Typed words answer
 * waiting questions only when they read as answers: "never mind" writes
 * nothing, and an edit of the open video is not taken for an answer.
 * Anything that may spend shows Stop. Nothing read from typed words of a
 * made video goes ahead without its button.
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
import { readAsk } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { draftFingerprint } from '../../../shared/make/fingerprint'
import { questionsFor } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Msg } from './components/Message'

const phrases = Array.from(
  { length: 24 },
  (_, i) =>
    `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`
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
    visual: {
      kind: 'still' as const,
      prompt: `A derrick at dusk, number ${i + 1}.`,
      move: 'push-in' as const,
      characters: []
    },
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
const doc = {
  id: 'doc1',
  sources: [{ id: 's1', path: '/made/narration.wav' }],
  words: [],
  assets: [],
  make,
  versions: []
} as unknown as EditDoc

const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }

function harness(settings: DraftDeps['settings'], parse: ParseCall, opts: { open?: EditDoc | null } = {}) {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  const goes: { draft: Draft; confirmed: number; fingerprint: string }[] = []
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => ({
    ok: true,
    change: await changeFor(req.doc, req.text, req.onScreen ?? null, { parse, can, brand: {}, settings })
  })
  fake.api.makeGo = async (req: { draft: Draft; confirmed: number; fingerprint: string }) => {
    goes.push(req)
    return { ok: false, message: 'review: stopped before anything is made' }
  }
  fake.api.makeCancel = async () => true
  // make:start as main runs it: questions first unless answered, then Claude writes the script. Typed answers
  // confirmed on their read-back have their brief read from `reading`, and Claude reads all of `text`.
  const starts: { text: string; reading: string | null; answered: boolean; quoteFirst: boolean; stop: boolean }[] = []
  const madeUnasked: Draft[] = []
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string }) => {
    const shown = msgs.get(`m${n}`)
    starts.push({
      text: req.text,
      reading: req.reading ?? null,
      answered: !!req.answered,
      quoteFirst: !!req.quoteFirst,
      stop: !!shown?.actions?.some((a) => (a.payload ?? '').includes('"stop"'))
    })
    const read = readAsk(String(req.reading ?? req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && req.reading ? { ...read, ask: req.text } : read
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    const drafted = await draftFor(brief, `new-${n}`, { parse, can, brand: {}, settings })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    // As main does: typed answers are quoted, whatever Settings says.
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      madeUnasked.push(drafted.draft)
      return { ok: false, message: 'review: main makes it here, without asking' }
    }
    const d = drafted.draft
    return {
      ok: true,
      kind: 'quote',
      draft: d,
      reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes })
    }
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
  const say = async (text: string): Promise<boolean> => {
    if (await makes.handle(text, null, [])) return true
    return makes.asked(text)
  }
  return { msgs, goes, makes, say, starts, madeUnasked }
}

const noClaude: ParseCall = async () => {
  throw new Error('Claude is not asked in this test')
}
const counting =
  (count: { n: number }): ParseCall =>
  async () => {
    count.n++
    return {
      parsed_output: {
        title: 'My Trip',
        sections: [{ heading: 'North', paragraphs: ['We drove north at dawn.', 'The lake was still.'] }]
      },
      stop_reason: 'end_turn',
      usage: { input_tokens: 4000, output_tokens: 3000 }
    }
  }

describe('a made video asked to change twice', () => {
  it('keeps one button, the newest quote’s, and it makes exactly what it showed', async () => {
    const h = harness({ cap: null, autoUnder: null }, noClaude)
    await h.say('read it with ElevenLabs')
    const first = [...h.msgs.entries()].find(([, m]) => m.actions?.some((a) => a.kind === 'make' && a.primary))!
    const firstButton = first[1].actions!.find((a) => a.primary)!
    await h.say('turn it into a cartoon')
    const withButtons = [...h.msgs.entries()].filter(([, m]) => m.actions?.some((a) => a.kind === 'make' && a.primary))
    // The first quote's button went when the second quote came.
    expect(withButtons).toHaveLength(1)
    expect(withButtons[0][0]).not.toBe(first[0])
    // Pressed anyway (a stale screen), it makes nothing and says why.
    await h.makes.onAction(firstButton)
    expect(h.goes).toHaveLength(0)
    expect([...h.msgs.values()].some((m) => /A newer quote replaced that one/.test(m.text ?? ''))).toBe(true)
    // The newest one makes its own draft, at its own price, with its fingerprint.
    const second = withButtons[0][1].actions!.find((a) => a.primary)!
    await h.makes.onAction(second)
    expect(h.goes).toHaveLength(1)
    const sent = h.goes[0]
    expect(sent.draft.kept?.narration).toBeTruthy()
    expect(sent.draft.kept?.shots).toBeUndefined()
    expect(second.label).toBe(`Make it for $${sent.confirmed.toFixed(2)}`)
    expect(sent.fingerprint).toBe(draftFingerprint(sent.draft))
    // What makes it shows Stop while it runs.
    const progress = [...h.msgs.values()].find((m) => m.actions?.some((a) => (a.payload ?? '').includes('"stop"')))
    expect(progress?.actions?.map((a) => a.label)).toEqual(['Stop'])
  })

  it('never goes ahead with a change read from typed words, whatever Settings says', async () => {
    const h = harness({ cap: null, autoUnder: 50 }, noClaude)
    await h.say('make shot 3 again')
    await h.say('read it with ElevenLabs')
    expect(h.goes).toHaveLength(0)
    expect([...h.msgs.values()].filter((m) => m.actions?.some((a) => a.kind === 'make' && a.primary))).toHaveLength(1)
  })
})

describe('"make shot 3 two seconds longer"', () => {
  it('is an ordinary edit: no script, no quote, nothing made', async () => {
    const count = { n: 0 }
    const h = harness({ cap: null, autoUnder: 2 }, counting(count))
    expect(await h.say('make shot 3 two seconds longer')).toBe(false)
    expect(count.n).toBe(0)
    expect(h.goes).toHaveLength(0)
    expect([...h.msgs.values()].some((m) => m.make)).toBe(false)
  })
})

describe('questions waiting before a script is written', () => {
  it('"never mind" writes nothing and spends nothing, and the questions go', async () => {
    const count = { n: 0 }
    const h = harness({ cap: null, autoUnder: 2 }, counting(count), { open: null })
    await h.say('make a video about my trip')
    const card = [...h.msgs.entries()].find(([, m]) => m.makeAsk)
    expect(card).toBeTruthy()
    expect(h.makes.questions(card![1].makeAsk!)).not.toBeNull()
    await h.say('never mind')
    expect(count.n).toBe(0)
    expect(h.starts).toHaveLength(1)
    expect(h.madeUnasked).toHaveLength(0)
    expect(h.makes.questions(card![1].makeAsk!)).toBeNull()
    expect(h.msgs.get(card![0])?.makeAsk).toBeUndefined()
    expect(
      [...h.msgs.values()].some((m) => /I won’t make it\. Nothing was written or spent\./.test(m.text ?? ''))
    ).toBe(true)
  })

  it('an edit asked of the open video is not taken for an answer', async () => {
    const count = { n: 0 }
    const h = harness({ cap: null, autoUnder: null }, counting(count))
    await h.makes.handle('/make a video about my trip', { command: 'make', rest: 'a video about my trip' }, [])
    const handled = await h.makes.handle('cut the first 10 seconds', null, [])
    expect(handled).toBe(false)
    expect(count.n).toBe(0)
    expect(h.starts).toHaveLength(1)
  })

  it('a real answer writes it, once its own words are confirmed, under a progress that can be stopped', async () => {
    const count = { n: 0 }
    const h = harness({ cap: null, autoUnder: null }, counting(count), { open: null })
    await h.say('make a video about my trip')
    await h.say('the lakes up north, a map documentary, 5 minutes')
    // Typed, it is read back first, with what will be asked for: nothing is written until Yes is tapped.
    const back = [...h.msgs.values()].find((m) => /^Make it about “/.test(m.text ?? ''))
    expect(back?.text).toBe('Make it about “the lakes up north”: a cinematic documentary with maps, 5:00 long?')
    expect(back?.actions?.map((a) => a.label)).toEqual(['Yes', 'Not now'])
    expect(h.starts).toHaveLength(1)
    expect(count.n).toBe(0)
    await h.makes.onAction(back!.actions!.find((a) => a.label === 'Yes')!)
    expect(h.starts).toHaveLength(2)
    expect(h.starts[1].answered).toBe(true)
    expect(h.starts[1].quoteFirst).toBe(true)
    expect(h.starts[1].stop).toBe(true)
    expect(h.starts[1].text).toBe('make a video about my trip, the lakes up north, as a cinematic documentary with maps wherever they help, 5 minutes long.')
    expect(h.starts[1].reading).toBe('make a video about my trip, as a cinematic documentary with maps wherever they help, 5 minutes long.')
    expect(count.n).toBe(1)
  })

  it('a no or a not yet in other words writes nothing: a no drops the questions, a not yet keeps them', async () => {
    const noes = ['I changed my mind', 'scratch that', 'forget about the video', 'actually, don’t', 'I’d rather not', 'not interested', 'please don’t', 'I’ll pass', 'skip', 'abort', 'I don’t want it anymore']
    const notYet = ['maybe another time', 'hmm let me see', 'I’m not sure yet', 'busy right now', 'gimme a sec', 'no idea', 'no clue', 'no rush, thinking']
    for (const p of [...noes, ...notYet]) {
      const count = { n: 0 }
      const h = harness({ cap: null, autoUnder: 2 }, counting(count), { open: null })
      await h.say('make a video about my trip')
      const card = [...h.msgs.entries()].find(([, m]) => m.makeAsk)!
      expect(await h.say(p), p).toBe(true)
      expect(count.n, p).toBe(0)
      expect(h.starts, p).toHaveLength(1)
      expect(h.madeUnasked, p).toHaveLength(0)
      const said = [...h.msgs.values()].pop()?.text ?? ''
      if (noes.includes(p)) {
        expect(said, p).toBe('All right, I won’t make it. Nothing was written or spent.')
        expect(h.makes.questions(card[1].makeAsk!), p).toBeNull()
      } else {
        expect(said, p).toMatch(/Nothing is written or spent until then\.$/)
        expect(h.makes.questions(card[1].makeAsk!), p).not.toBeNull()
      }
    }
  })

  it('Not now on a topic read back keeps the questions, writes nothing, and a tap still answers them after', async () => {
    const count = { n: 0 }
    const h = harness({ cap: null, autoUnder: null }, counting(count), { open: null })
    await h.say('make a video about my trip')
    const card = [...h.msgs.entries()].find(([, m]) => m.makeAsk)!
    await h.say('Lisbon')
    const back = [...h.msgs.entries()].find(([, m]) => m.text === 'Make it about “Lisbon”: a cinematic documentary, 2:00 long?')!
    await h.makes.onAction(back[1].actions!.find((a) => a.label === 'Not now')!)
    expect(h.msgs.get(back[0])?.actions ?? []).toHaveLength(0)
    expect(count.n).toBe(0)
    expect(h.starts).toHaveLength(1)
    expect(h.makes.questions(card[1].makeAsk!)).not.toBeNull()
    expect([...h.msgs.values()].pop()?.text).toMatch(/^Take your time\./)
    // The questions answered by taps after: written once.
    await h.makes.answer(card[1].makeAsk!, ['about the best moments', 'as a cinematic documentary', '1 minute long'])
    expect(count.n).toBe(1)
    expect(h.starts[1].quoteFirst).toBe(false)
  })

  it('a pause or a question back keeps them open and spends nothing; typed answers are then quoted, never made unasked', async () => {
    const count = { n: 0 }
    const h = harness({ cap: null, autoUnder: 2 }, counting(count), { open: null })
    await h.say('make a video about my trip')
    const card = [...h.msgs.entries()].find(([, m]) => m.makeAsk)!
    for (const p of ['hold on a sec', 'give me a minute', 'hang on', 'let me think about it', 'wait, what do you mean?', 'maybe later'])
      expect(await h.say(p), p).toBe(true)
    expect(count.n).toBe(0)
    expect(h.starts).toHaveLength(1)
    expect(h.madeUnasked).toHaveLength(0)
    expect(h.makes.questions(card[1].makeAsk!)).not.toBeNull()
    expect(h.msgs.get(card[0])?.makeAsk).toBe(card[1].makeAsk)
    expect([...h.msgs.values()].filter((m) => /Nothing is written or spent until then\./.test(m.text ?? ''))).toHaveLength(6)
    // Answered by typing at last and read back. A typed yes is pointed at the button: only a tap sends it.
    await h.say('the lakes up north, a documentary, 1 minute')
    expect(count.n).toBe(0)
    expect(await h.say('yes')).toBe(true)
    expect([...h.msgs.values()].pop()?.text).toBe('Tap Yes above if that’s right, or tell me what to change.')
    expect(count.n).toBe(0)
    const back = [...h.msgs.values()].filter((m) => /^Make it about/.test(m.text ?? '')).pop()!
    await h.makes.onAction(back.actions!.find((a) => a.label === 'Yes')!)
    // Written once, and quoted with its button, though Settings would go ahead under $2.
    expect(count.n).toBe(1)
    expect(h.starts[1].quoteFirst).toBe(true)
    expect(h.madeUnasked).toHaveLength(0)
    expect([...h.msgs.values()].some((m) => m.actions?.some((a) => a.primary && /^Make it for \$/.test(a.label)))).toBe(true)
  })
})
