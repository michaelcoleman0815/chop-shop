import { describe, expect, it, vi } from 'vitest'

/**
 * Round 7 (088b79e): make:start, make:revise, make:go and make:shot take a `consent` from the window,
 * 'tap' or 'command' ('command' only for a new video asked for with nothing waiting), and main refuses
 * the rest. Here, the real useMake hook (React's hooks as plain functions) with main faked as index.ts
 * runs it at 088b79e, consent checks included, the real draftFor, revise and changeFor, and a Claude
 * that counts its calls. Every spending call is recorded with the consent it carried.
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
import { readAsk, rewritesScript } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { questionsFor } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, revise, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: true, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const phrases = Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`)
const made: Make = {
  v: 1,
  brief: { topic: 'the 1950s oil boom', format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', look: 'archival', maps: 'auto', clips: 'auto', images: null, cap: null, inferred: [], ask: 'make a 2 minute documentary about the 1950s oil boom' },
  title: 'Black Gold',
  outline: ['The boom'],
  script: phrases.join(' '),
  phrases,
  sections: [0],
  bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: 'West Texas, 1950s', characters: [] },
  shots: phrases.map((_, i) => ({ phrase: i, visual: { kind: 'still' as const, prompt: `A derrick ${i + 1}.`, move: 'push-in' as const, characters: [] }, title: null, callouts: [], beat: `b${i}`, file: `/made/${i}.png`, maker: 'google' as const, model: 'gemini-nano-banana-2.1', cost: 0.0504, key: null, note: null })),
  sheets: [],
  narration: { path: '/made/narration.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  images: 'google',
  clips: 'google',
  spent: 1.4
}
const madeDoc = { id: 'doc1', sources: [{ id: 's1', path: '/made/narration.wav' }], words: [], assets: [], make: made, versions: [] } as unknown as EditDoc

type Settings = DraftDeps['settings']
type Call = { what: string; consent: unknown; text?: string; quoteFirst?: boolean; seconds?: number; cap?: number | null }

function harness(settings: Settings, opts: { open?: EditDoc | null; sentences?: (call: number) => number } = {}) {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  const calls = { claude: 0, spend: [] as Call[], refused: [] as Call[], letGo: [] as string[], madeUnasked: 0 }
  const parse: ParseCall = async () => {
    calls.claude++
    const count = opts.sentences ? opts.sentences(calls.claude) : 3
    const paragraphs = count === 3 ? ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'] : Array.from({ length: count }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over boom town number ${i + 1} and the men worked on through the night.`)
    return { parsed_output: { title: 'A Video', sections: [{ heading: 'One', paragraphs }] }, stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 3000 } }
  }
  const tapped = (c: unknown): boolean => c === 'tap'
  const asked = (c: unknown): boolean => c === 'tap' || c === 'command'
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => true
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => ({ ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, { parse, can, brand: {}, settings }) })
  fake.api.makeGo = async (req: { consent?: unknown }) => {
    const c = { what: 'go', consent: req.consent }
    if (!tapped(req.consent)) {
      calls.refused.push(c)
      return { ok: false, message: 'Nothing was made: a video is made only when you press its quote’s button.' }
    }
    calls.spend.push(c)
    return { ok: false, message: 'probe: stopped before anything is made' }
  }
  fake.api.makeShot = async (req: { consent?: unknown }) => {
    const c = { what: 'shot', consent: req.consent }
    if (!tapped(req.consent)) {
      calls.refused.push(c)
      return { ok: false, message: 'Nothing was made.' }
    }
    calls.spend.push(c)
    return { ok: false, message: 'probe: stopped before anything is made' }
  }
  // make:start as index.ts runs it at 088b79e.
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: unknown }) => {
    const reading = typeof req.reading === 'string' && req.reading.trim() ? req.reading : null
    const read = readAsk(reading ?? String(req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && reading ? { ...read, ask: String(req.text ?? '').trim() || read.ask } : read
    const c: Call = { what: 'start', consent: req.consent, text: req.text, quoteFirst: !!req.quoteFirst, seconds: brief?.seconds, cap: brief?.cap }
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (!asked(req.consent)) {
      calls.refused.push(c)
      return { ok: false, message: 'I wrote nothing: a script is written only when you tap its button, or ask for a new video with nothing else waiting.' }
    }
    calls.spend.push(c)
    const drafted = await draftFor(brief, `new-${n}`, { parse, can, brand: {}, settings })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst && asked(req.consent)) {
      calls.madeUnasked++
      return { ok: false, message: 'probe: main makes it here, without asking' }
    }
    const d = drafted.draft
    return { ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: unknown }) => {
    const c = { what: 'revise', consent: req.consent, text: JSON.stringify(req.steps) }
    if (!tapped(req.consent)) {
      calls.refused.push(c)
      return { ok: false, message: 'Nothing was changed.' }
    }
    calls.spend.push(c)
    const d0 = req.draft
    const r = revise(d0, req.steps, { can, settings })
    if (!r) return { ok: true, draft: null }
    if (rewritesScript(d0.brief, r.draft.brief, !!d0.into)) {
      const again = await draftFor(r.draft.brief, d0.id, { parse, can, brand: {}, settings, spentBefore: (d0.spentBefore ?? 0) + d0.scriptCost })
      if (!again.ok) return { ok: false, message: again.message }
      const d = again.draft
      return { ok: true, draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }), changed: r.changed }
    }
    const d = r.draft
    return { ok: true, draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }), changed: r.changed }
  }
  const docRef = { current: (opts.open === undefined ? null : opts.open) as EditDoc | null }
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
  /** A typed message, as useCutalong's submit hands it on. */
  const type = async (text: string, files: { name: string; path: string }[] = []): Promise<void> => {
    const command = /^\s*\/(\w+)\s*(.*)$/s.exec(text)
    if (await makes.handle(text, command ? { command: command[1], rest: command[2] } : null, files as never)) return
    if (docRef.current && (await makes.asked(text))) return
    calls.letGo.push(text)
  }
  const last = (): Partial<Msg> | undefined => [...msgs.values()].pop()
  const buttons = (label: string): Action[] => [...msgs.values()].flatMap((m) => (m.actions ?? []).filter((a) => a.label === label)) as Action[]
  const tap = async (label: string): Promise<boolean> => {
    const a = buttons(label).pop()
    if (a) await makes.onAction(a)
    return !!a
  }
  return { msgs, makes, calls, type, last, buttons, tap }
}

const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'
const NEW_ASKS = [
  'make a 5 minute documentary about Lisbon',
  'make it a 2 minute documentary about the 1950s oil boom',
  'a 3 minute explainer about how vaccines work',
  'I want a 2 minute video about the gold rush',
  '/make a 2 minute documentary about Lisbon',
  '/documentary about the moon landing, 1 minute'
]

describe('"nothing waiting" for a command', () => {
  it('a new ask typed while questions, a read-back, a quote or a quote change waits is never a command, and writes nothing', async () => {
    const states: [string, (h: ReturnType<typeof harness>) => Promise<void>][] = [
      ['questions', async (h) => void (await h.type('make a video about my trip'))],
      ['a read-back of an answer', async (h) => {
        await h.type('make a video about my trip')
        await h.type('Lisbon')
      }],
      ['a quote', async (h) => void (await h.type(QUOTED))],
      ['a quote change read back', async (h) => {
        await h.type(QUOTED)
        await h.type('make it 3 minutes')
      }],
      ['a new ask read back', async (h) => {
        await h.type(QUOTED)
        await h.type('make a 5 minute documentary about Lisbon')
      }]
    ]
    const rows: string[] = []
    let bad = 0
    for (const [state, setup] of states)
      for (const ask of NEW_ASKS)
        for (const files of [[], [{ name: 'lisbon.jpg', path: '/tmp/lisbon.jpg' }], [{ name: 'voice.m4a', path: '/tmp/voice.m4a' }]]) {
          // Go-ahead under $2: the first quote (a 90-line script) waits above it; a new ask (3 lines) would come in under it.
          const h = harness({ cap: null, autoUnder: 2 }, { sentences: (call) => (call === 1 ? 90 : 3) })
          await setup(h)
          const before = { spend: h.calls.spend.length, claude: h.calls.claude, made: h.calls.madeUnasked }
          await h.type(ask, files)
          const spent = h.calls.spend.slice(before.spend)
          const claude = h.calls.claude - before.claude
          const madeNow = h.calls.madeUnasked - before.made
          if (spent.length || claude || madeNow) bad++
          if (spent.length || claude || madeNow || files.length === 0)
            rows.push(`${state} + ${JSON.stringify(ask)}${files.length ? ` + ${files[0].name}` : ''}: spending calls ${JSON.stringify(spent.map((c) => `${c.what}/${c.consent}`))}, Claude +${claude}, made +${madeNow}; said "${h.last()?.text?.slice(0, 90)}" ${JSON.stringify(h.last()?.actions?.map((a) => a.label) ?? [])}`)
        }
    console.log(rows.join('\n'))
    expect(bad).toBe(0)
  })

  it('a fresh ask with nothing waiting is a command; taps carry tap, and a read-back\'s Yes is quoted first', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type(QUOTED)
    await h.type('make it 3 minutes')
    await h.tap('Yes')
    await h.type('make a 5 minute documentary about Lisbon')
    await h.tap('Start a new video')
    const h2 = harness({ cap: null, autoUnder: null })
    await h2.type(QUOTED)
    await h2.type('make it a 3 minute documentary about the 1950s oil boom')
    const change = await h2.tap('Change this one')
    console.log(`spending calls: ${JSON.stringify(h.calls.spend.map((c) => `${c.what}/${c.consent}${c.quoteFirst ? '/quoteFirst' : ''}`))}; "Change this one" shown ${change}: ${JSON.stringify(h2.calls.spend.map((c) => `${c.what}/${c.consent}`))}`)
    expect(h.calls.spend.map((c) => c.consent)).toEqual(['command', 'tap', 'tap'])
  })
})

describe('typed acceptance of a waiting quote, a made video open', () => {
  it('is pointed at the button, and goes to neither the planner nor triage', async () => {
    const replies = ['yes', 'go ahead', 'do it', 'ok, make it', 'sounds good', 'yes make it', 'ship it', 'make it so', 'go on then', 'make it happen', "let's go", 'cool', 'approved', 'lgtm', '👍', 'yes, go for it please', 'yep do it now', 'that works', 'looks right to me', 'perfect, go', 'alright then', 'fine by me']
    const rows: string[] = []
    let leaked = 0
    for (const r of replies) {
      const h = harness({ cap: null, autoUnder: null }, { open: madeDoc })
      await h.type('make it 3 minutes')
      await h.type(r)
      if (h.calls.letGo.length) leaked++
      rows.push(`${JSON.stringify(r)} -> ${h.calls.letGo.length ? 'LET GO to the planner (Claude)' : `"${h.last()?.text?.slice(0, 70)}"`}`)
    }
    console.log(rows.join('\n'))
    expect(leaked).toBe(0)
  })
})

describe('taps, races and old projects', () => {
  it('double taps and old buttons send once at most', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type('make a video about my trip')
    await h.type('Lisbon')
    const yes = h.buttons('Yes').pop() as Action
    await h.type('Porto')
    await h.makes.onAction(yes)
    const afterOld = h.calls.spend.length
    const newYes = h.buttons('Yes').pop() as Action
    await Promise.all([h.makes.onAction(newYes), h.makes.onAction(newYes)])
    const quote = [...h.msgs.values()].flatMap((m) => m.actions ?? []).filter((a) => (a.payload ?? '').includes('"go"')).pop() as Action
    await Promise.all([h.makes.onAction(quote), h.makes.onAction(quote)])
    console.log(`old Yes after a newer reply: ${afterOld} calls; Yes tapped twice at once: ${JSON.stringify(h.calls.spend.map((c) => `${c.what}/${c.consent}`))}`)
    expect(afterOld).toBe(0)
    expect(h.calls.spend.filter((c) => c.what === 'start')).toHaveLength(1)
    expect(h.calls.spend.filter((c) => c.what === 'go')).toHaveLength(1)
  })

  it('a project reopened: buttons saved with its chat send nothing', async () => {
    const before = harness({ cap: null, autoUnder: null })
    await before.type(QUOTED)
    await before.type('make it 3 minutes')
    await before.type('make a 5 minute documentary about Lisbon')
    const saved = [...before.msgs.values()].flatMap((m) => m.actions ?? []).filter((a) => a.kind === 'make') as Action[]
    // The window restarted: a new hook, the same messages' buttons.
    const after = harness({ cap: null, autoUnder: null })
    for (const a of saved) await after.makes.onAction(a)
    console.log(`saved buttons ${JSON.stringify(saved.map((a) => a.label))}: after reopening, spending calls ${after.calls.spend.length}, refused ${after.calls.refused.length}; said ${JSON.stringify([...after.msgs.values()].map((m) => m.text))}`)
    expect(after.calls.spend).toHaveLength(0)
  })

  it('"Lisbon, under $1" reads the cap; "cut the first 10 seconds" with no edit is answered here', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type('make a video about my trip')
    await h.type('Lisbon, under $1')
    const line = h.last()?.text
    await h.tap('Yes')
    const s = h.calls.spend.find((c) => c.what === 'start')
    const h2 = harness({ cap: null, autoUnder: null })
    await h2.type('make a video about my trip')
    await h2.type('cut the first 10 seconds')
    console.log(`"Lisbon, under $1": "${line}" -> cap ${s?.cap}; "cut the first 10 seconds": "${h2.last()?.text}", spending ${h2.calls.spend.length}`)
    expect(s?.cap).toBe(1)
  })
})
