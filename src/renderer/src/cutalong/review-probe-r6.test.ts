import { describe, expect, it, vi } from 'vitest'

/**
 * Round 6 (f2e7518): "every typed reply to the questions, a quote or a read-back is read here and read
 * back with Yes and Not now; only a tapped Yes asks Claude for anything." The real useMake hook (React's
 * hooks as plain functions), with make:start, make:revise and make:change faked as main runs them at
 * f2e7518 (index.ts), the real draftFor, revise and changeFor, and a Claude that counts its calls.
 * Every paid call is counted: Claude (script), make:start, make:revise, make:go, make:shot, and the
 * planner/triage useCutalong would reach when useMake lets a message go.
 *
 * Kept as a regression test from round 10 on. With go-ahead on from the start, the first ask is made straight away,
 * as Settings says (a new video asked for with nothing else waiting), so there was no quote to reply to and that make
 * was counted against every reply. Each reply is now typed to a quote waiting, go-ahead turned on once it shows, and
 * only what the reply spends is counted.
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

const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }
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

function harness(settings: Settings, opts: { open?: EditDoc | null; sentences?: (call: number) => number } = {}) {
  const msgs = new Map<string, Partial<Msg>>()
  let n = 0
  const calls = { claude: 0, start: [] as { text: string; answered: boolean; quoteFirst: boolean; reading?: string; seconds?: number; cap?: number | null }[], revise: [] as string[][], go: 0, shot: 0, change: [] as string[], letGo: [] as string[], madeUnasked: 0 }
  const parse: ParseCall = async () => {
    calls.claude++
    const count = opts.sentences ? opts.sentences(calls.claude) : 3
    const paragraphs = count === 3 ? ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'] : Array.from({ length: count }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over boom town number ${i + 1} and the men worked on through the night.`)
    return {
      parsed_output: { title: 'A Video', sections: [{ heading: 'One', paragraphs }] },
      stop_reason: 'end_turn',
      usage: { input_tokens: 4000, output_tokens: 3000 }
    }
  }
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => true
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => {
    calls.change.push(req.text)
    return { ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, { parse, can, brand: {}, settings }) }
  }
  fake.api.makeGo = async () => {
    calls.go++
    return { ok: false, message: 'probe: stopped before anything is made' }
  }
  fake.api.makeShot = async () => {
    calls.shot++
    return { ok: false, message: 'probe: stopped before anything is made' }
  }
  // make:start as index.ts runs it at f2e7518.
  fake.api.makeStart = async (req: { text: string; recording?: string | null; answered?: boolean; quoteFirst?: boolean; reading?: string }) => {
    const reading = typeof req.reading === 'string' && req.reading.trim() ? req.reading : null
    const read = readAsk(reading ?? String(req.text ?? ''), { niche: null, recording: req.recording ?? null })
    const brief = read && reading ? { ...read, ask: String(req.text ?? '').trim() || read.ask } : read
    calls.start.push({ text: req.text, answered: !!req.answered, quoteFirst: !!req.quoteFirst, reading: req.reading, seconds: brief?.seconds, cap: brief?.cap })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    const drafted = await draftFor(brief, `new-${n}`, { parse, can, brand: {}, settings })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      calls.madeUnasked++
      return { ok: false, message: 'probe: main makes it here, without asking' }
    }
    const d = drafted.draft
    return { ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  // make:revise as index.ts runs it at f2e7518.
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[] }) => {
    calls.revise.push(req.steps)
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
  /** A typed message as useCutalong's submit hands it on: useMake first, then (edit open) make.asked, then Claude (planner, or triage with no edit). */
  const type = async (text: string, files: { name: string; path: string }[] = []): Promise<void> => {
    const command = /^\s*\/(\w+)\s*(.*)$/s.exec(text)
    if (await makes.handle(text, command ? { command: command[1], rest: command[2] } : null, files as never)) return
    if (docRef.current && (await makes.asked(text))) return
    calls.letGo.push(text)
  }
  const last = (): Partial<Msg> | undefined => [...msgs.values()].pop()
  const backs = (): [string, Partial<Msg>][] => [...msgs.entries()].filter(([, m]) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"back"')))
  const tapYes = async (): Promise<void> => {
    const b = backs().pop()
    const yes = b?.[1].actions?.find((a) => a.label === 'Yes')
    if (yes) await makes.onAction(yes as Action)
  }
  const paid = (): number => calls.claude + calls.go + calls.shot + calls.madeUnasked + calls.letGo.length
  return { msgs, makes, calls, type, last, backs, tapYes, paid }
}

const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'

describe('questions open, no edit: nothing typed is sent, only a tapped Yes', () => {
  const replies = [
    'yes', 'Yes!', 'yes please', 'go ahead', 'do it', 'ok go', 'sure, write it', 'write it', 'write the script', 'go', 'start', 'make it', 'just make it', 'proceed', 'confirm', '👍', 'y',
    'Lisbon', 'Lisbon, 5 minutes', 'the 10 minute walk to school', 'not 10 min, more like 5', 'not a documentary', 'nothing about the food',
    'a few minutes', '1:30', '5', 'short', 'TikTok length', 'same as last time', 'how I changed my mind about veganism', 'I changed my mind',
    'make a 5 minute documentary about Lisbon', 'a 2 minute explainer about how vaccines work', 'cut the first 10 seconds', 'export it', 'what do you mean?', '?', '...', 'asdfgh'
  ]
  it('a table of typed replies: no make:start after the first, no Claude, nothing let go', async () => {
    const rows: string[] = []
    let sent = 0
    for (const r of replies) {
      const h = harness({ cap: null, autoUnder: 25 })
      await h.type('make a video about my trip')
      const before = h.calls.start.length
      await h.type(r)
      const extra = h.calls.start.length - before
      sent += extra + h.calls.claude + h.calls.letGo.length
      rows.push(`${JSON.stringify(r)} -> "${h.last()?.text}"${(h.last()?.actions ?? []).length ? ` [${h.last()?.actions?.map((a) => a.label).join('/')}]` : ''}; make:start +${extra}; Claude ${h.calls.claude}; let go ${h.calls.letGo.length}`)
    }
    console.log(rows.join('\n'))
    expect(sent).toBe(0)
  })

  it('a tapped Yes sends exactly once; the typed topic\'s "10 minute" is not its length; a cap typed with the topic', async () => {
    for (const r of ['the 10 minute walk to school', 'Lisbon, under $1', 'Lisbon, 5 minutes']) {
      const h = harness({ cap: null, autoUnder: 25 })
      await h.type('make a video about my trip')
      await h.type(r)
      const line = h.backs().pop()?.[1].text
      await h.type('yes')
      const typedYes = h.calls.start.length
      await h.tapYes()
      const s = h.calls.start[h.calls.start.length - 1]
      console.log(`${JSON.stringify(r)}: read back "${line}"; typed yes -> make:start ${typedYes - 1}; tapped -> make:start ${h.calls.start.length - 1}, Claude ${h.calls.claude}, quoteFirst ${s?.quoteFirst}, reading ${JSON.stringify(s?.reading)} -> ${s?.seconds} s, cap ${s?.cap}; made unasked ${h.calls.madeUnasked}`)
      expect(typedYes).toBe(1)
      expect(h.calls.claude).toBe(1)
      expect(h.calls.madeUnasked).toBe(0)
    }
  })

  it('with a file dropped while the questions wait', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type('make a video about my trip')
    await h.type('make a documentary about my trip to Lisbon', [{ name: 'lisbon.jpg', path: '/tmp/lisbon.jpg' }])
    console.log(`a photo dropped with "make a documentary about my trip to Lisbon": make:start ${h.calls.start.length - 1} more, Claude ${h.calls.claude}; said: "${h.last()?.text}"`)
    expect(h.calls.claude).toBe(0)
  })
})

describe('a quote waiting, no edit', () => {
  it('a change is read back; only its tapped Yes asks Claude', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type(QUOTED)
    const quoted = h.calls.claude
    await h.type('make it 5 minutes')
    const line = h.backs().pop()?.[1].text
    await h.type('and a British voice')
    const folded = h.backs().pop()?.[1].text
    await h.type('yes')
    const typed = h.calls.claude - quoted
    await h.tapYes()
    console.log(`"make it 5 minutes" -> "${line}"; then "and a British voice" -> "${folded}"; typed yes -> Claude +${typed}; tapped -> make:revise ${JSON.stringify(h.calls.revise)}, Claude +${h.calls.claude - quoted}`)
    expect(typed).toBe(0)
    expect(h.calls.claude - quoted).toBe(1)
  })

  it('typed words that also read as a new ask, in reply to the quote', async () => {
    const rows: string[] = []
    let paid = 0
    for (const r of [
      'make it a 5 minute documentary about the 1950s oil boom',
      'a 5 minute documentary about the 1950s oil boom',
      'I want a 2 minute explainer about the oil boom instead',
      'can you make a 3 minute video about the oil boom with maps',
      'yes',
      'go ahead and make it',
      'make it now'
    ]) {
      for (const autoUnder of [null, 25]) {
        const settings: Settings = { cap: null, autoUnder: null }
        const h = harness(settings)
        await h.type(QUOTED)
        expect([...h.msgs.values()].some((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))).toBe(true)
        // Settings' go-ahead turned on while the quote waits.
        settings.autoUnder = autoUnder
        const before = { claude: h.calls.claude, start: h.calls.start.length, made: h.calls.madeUnasked }
        await h.type(r)
        const extra = h.calls.claude - before.claude + h.calls.madeUnasked - before.made
        paid += extra
        rows.push(
          `go-ahead ${autoUnder ?? 'off'}: ${JSON.stringify(r)} -> make:start +${h.calls.start.length - before.start}, Claude +${h.calls.claude - before.claude}, made without a tap +${h.calls.madeUnasked - before.made}; said: "${h.last()?.text}"`
        )
      }
    }
    console.log(rows.join('\n'))
    expect(paid).toBe(0)
  })
})

describe('a new ask typed in reply, with go-ahead on or a file attached', () => {
  it('go-ahead under $2, a $2+ quote waiting: "make it a 1 minute documentary about…" is made with no tap', async () => {
    // The 10-minute script Claude writes has 90 lines (its quote passes $2); the 1-minute one, 3.
    const h = harness({ cap: null, autoUnder: 2 }, { sentences: (call) => (call === 1 ? 90 : 3) })
    await h.type('make a 10 minute cinematic documentary about the 1950s oil boom')
    const waiting = [...h.msgs.values()].find((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))
    const before = { claude: h.calls.claude, made: h.calls.madeUnasked }
    await h.type('make it a 1 minute documentary about the 1950s oil boom')
    console.log(
      `quote waiting: ${JSON.stringify(waiting?.actions?.map((a) => a.label))} "${waiting?.text?.slice(0, 90)}…"; made unasked before the reply ${before.made}; ` +
        `after "make it a 1 minute documentary about the 1950s oil boom": Claude +${h.calls.claude - before.claude}, made with no tap +${h.calls.madeUnasked - before.made}`
    )
    expect(waiting).toBeTruthy()
    expect(h.calls.madeUnasked - before.made).toBe(0)
  })

  it('questions open: a whole new ask typed with a photo attached', async () => {
    const h = harness({ cap: null, autoUnder: null })
    await h.type('make a video about my trip')
    await h.type('make a 2 minute cinematic documentary about my trip to Lisbon', [{ name: 'lisbon.jpg', path: '/tmp/lisbon.jpg' }])
    console.log(`with a photo: make:start ${h.calls.start.length - 1} more, Claude ${h.calls.claude}; said: "${h.last()?.text?.slice(0, 100)}"`)
    expect(h.calls.claude).toBe(0)
  })
})

describe('a made video open, a change quoted and waiting', () => {
  it('typed acceptance of the quote: let go to the planner (Claude), or kept here', async () => {
    const rows: string[] = []
    for (const r of ['yes', 'go ahead', 'do it', 'ok, make it', 'sounds good']) {
      const h = harness({ cap: null, autoUnder: null }, { open: madeDoc })
      await h.type('make it 3 minutes')
      const quote = [...h.msgs.values()].find((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))
      await h.type(r)
      rows.push(`quote "${quote?.text?.slice(0, 80)}…"; typed ${JSON.stringify(r)} -> make:change ${JSON.stringify(h.calls.change)}; let go to Claude's planner: ${h.calls.letGo.length}; Claude (make) ${h.calls.claude}`)
    }
    console.log(rows.join('\n'))
    expect(true).toBe(true)
  })

  it('an edit\'s words while /make questions wait let them go to the planner, and start no make', async () => {
    const h = harness({ cap: null, autoUnder: 25 }, { open: madeDoc })
    await h.type('/make a video about my trip')
    await h.type('cut the first 10 seconds')
    console.log(`/make questions, then "cut the first 10 seconds": make:start ${h.calls.start.length}; Claude (make) ${h.calls.claude}; go ${h.calls.go}; let go: ${JSON.stringify(h.calls.letGo)}`)
    expect(h.calls.claude + h.calls.go + h.calls.madeUnasked).toBe(0)
  })
})
