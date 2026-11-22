import { describe, expect, it, vi } from 'vitest'

/**
 * Round 7 (088b79e): what waits (questions, read-backs, a quote) lives in useMake's refs, and the chat
 * that shows it lives in useCutalong's messages, saved with each project (persist: every message but
 * progress, buttons included) and restored by openProject. Neither openProject nor goStart tells useMake.
 *   1. Another chat opened, or a new one started, in the same session: the last chat's quote still waits.
 *   2. Cutalong reopened (a new hook) on a saved chat: its quote and buttons show, and nothing waits.
 * The real useMake hook (React's hooks as plain functions), with main faked as index.ts runs it at 088b79e.
 *
 * Kept as a regression test from round 10 on. The decision since round 7: useCutalong tells useMake which chat is
 * open (its chat key, counted up by openProject and goStart) and hands it each chat's messages through restore, so
 * this harness does the same: as first written, it never told useMake, and a quote could only wait on.
 */

const fake = vi.hoisted(() => ({ api: {} as Record<string, unknown> }))

vi.mock('react', () => ({
  useRef: <T,>(v: T) => ({ current: v }),
  useState: <T,>(v: T | (() => T)) => [typeof v === 'function' ? (v as () => T)() : v, () => undefined],
  useCallback: <T,>(f: T) => f,
  useMemo: <T,>(f: () => T) => f()
}))
vi.mock('./api', () => ({ api: fake.api }))

import { readAsk, rewritesScript } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { questionsFor } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { ParseCall } from '../../../main/make/claude'
import { draftFor, revise, type DraftDeps } from '../../../main/make/run'
import { useMake } from './useMake'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: true, claude: true, localVoice: true }

function window(settings: DraftDeps['settings']) {
  let chat = new Map<string, Partial<Msg>>()
  let n = 0
  // The chat open, counted up on each change, as useCutalong's chatKey.
  let key = 0
  const calls = { claude: 0, start: [] as { consent: unknown; text: string; topic?: string }[], revise: [] as { consent: unknown; title: string; topic: string }[], go: [] as { title: string; topic: string }[], letGo: [] as string[], madeUnasked: 0 }
  const parse: ParseCall = async (params) => {
    calls.claude++
    const topic = /about ([^.\n<]+)/.exec(JSON.stringify(params.messages))?.[1] ?? '?'
    return {
      parsed_output: { title: `About ${topic.slice(0, 30)}`, sections: [{ heading: 'One', paragraphs: ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'] }] },
      stop_reason: 'end_turn',
      usage: { input_tokens: 4000, output_tokens: 3000 }
    }
  }
  const asked = (c: unknown): boolean => c === 'tap' || c === 'command'
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeStart = async (req: { text: string; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: unknown }) => {
    const brief = readAsk(req.reading?.trim() ? req.reading : req.text, { niche: null, recording: null })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (!asked(req.consent)) return { ok: false, message: 'I wrote nothing.' }
    calls.start.push({ consent: req.consent, text: req.text, topic: brief.topic })
    const drafted = await draftFor(brief, `video-${calls.start.length}`, { parse, can, brand: {}, settings })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      calls.madeUnasked++
      return { ok: false, message: 'probe: main makes it here, without asking' }
    }
    const d = drafted.draft
    return { ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'Nothing was changed.' }
    calls.revise.push({ consent: req.consent, title: req.draft.title, topic: req.draft.brief.topic })
    const r = revise(req.draft, req.steps, { can, settings })
    if (!r) return { ok: true, draft: null }
    if (rewritesScript(req.draft.brief, r.draft.brief, !!req.draft.into)) {
      const again = await draftFor(r.draft.brief, req.draft.id, { parse, can, brand: {}, settings })
      if (!again.ok) return { ok: false, message: again.message }
      return { ok: true, draft: again.draft, reply: quoteReply(again.draft.brief, again.draft.quote, { title: again.draft.title, scenes: 3 }), changed: r.changed }
    }
    return { ok: true, draft: r.draft, reply: quoteReply(r.draft.brief, r.draft.quote, { title: r.draft.title, scenes: 3 }), changed: r.changed }
  }
  fake.api.makeGo = async (req: { draft: Draft; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'Nothing was made.' }
    calls.go.push({ title: req.draft.title, topic: req.draft.brief.topic })
    return { ok: false, message: 'probe: stopped before anything is made' }
  }
  const docRef = { current: null }
  const makes = useMake({
    docRef,
    setDoc: () => undefined,
    setMediaUrl: () => undefined,
    push: (m) => {
      const id = `m${++n}`
      chat.set(id, { ...m })
      return id
    },
    patch: (id, p) => chat.set(id, { ...chat.get(id), ...p }),
    applyAsVersion: () => null,
    during: (work) => work(),
    findBroll: async () => undefined,
    brand: () => 'default',
    chat: () => String(key)
  })
  const type = async (text: string): Promise<void> => {
    if (await makes.handle(text, null, [])) return
    calls.letGo.push(text)
  }
  const tap = async (label: string): Promise<boolean> => {
    const a = [...chat.values()].flatMap((m) => (m.actions ?? []).filter((x) => x.label === label)).pop() as Action | undefined
    if (a) await makes.onAction(a)
    return !!a
  }
  /** useCutalong's goStart or openProject: the chat's messages replaced, its key counted up, and its messages restored. */
  const openChat = (messages: Map<string, Partial<Msg>> = new Map()): Map<string, Partial<Msg>> => {
    const was = chat
    key += 1
    chat = new Map(makes.restore([...messages.entries()].map(([id, m]) => ({ id, ...m }) as Msg)).map((m) => [m.id, m] as const))
    return was
  }
  return { makes, calls, type, tap, openChat, chat: () => chat }
}

describe('what waits, across chats', () => {
  it('a new chat started (or another opened) in the same session still has the last chat\'s quote waiting', async () => {
    const w = window({ cap: null, autoUnder: null })
    await w.type('make a 1 minute cinematic documentary about the oil boom in Texas')
    w.openChat()
    // In the new chat: a fresh ask, then the change it offers.
    await w.type('make a 2 minute documentary about Lisbon')
    const offer = [...w.chat().values()].pop()
    const changed = await w.tap('Change this one')
    const quote = [...w.chat().values()].find((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))
    if (quote) await w.tap(quote.actions!.find((a) => (a.payload ?? '').includes('"go"'))!.label)
    console.log(
      `new chat, "make a 2 minute documentary about Lisbon": "${offer?.text}" ${JSON.stringify(offer?.actions?.map((a) => a.label))}; ` +
        `tapped Change this one (${changed}): make:revise on ${JSON.stringify(w.calls.revise)}; then its quote's button made ${JSON.stringify(w.calls.go)}`
    )
    expect(w.calls.revise.every((r) => !/oil boom/.test(r.topic))).toBe(true)
  })

  it('Cutalong reopened on a saved chat with a quote waiting: a plain-word ask under it is a command, and replies to it go on to Claude', async () => {
    const before = window({ cap: null, autoUnder: null })
    await before.type('make a 10 minute cinematic documentary about the oil boom in Texas')
    const saved = before.chat()
    const rows: string[] = []
    for (const [reply, autoUnder] of [
      ['make it a 2 minute documentary about the oil boom in Texas', 2],
      ['make it 3 minutes', null],
      ['yes', null]
    ] as const) {
      const after = window({ cap: null, autoUnder })
      after.openChat(saved)
      const shown = [...after.chat().values()].find((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))
      await after.type(reply)
      rows.push(
        `reopened, quote shown "${shown?.text?.slice(0, 60)}…" ${JSON.stringify(shown?.actions?.map((a) => a.label))}; typed ${JSON.stringify(reply)}: ` +
          `make:start ${JSON.stringify(after.calls.start.map((s) => s.consent))}, Claude ${after.calls.claude}, made with no tap ${after.calls.madeUnasked}, let go to triage ${after.calls.letGo.length}`
      )
    }
    console.log(rows.join('\n'))
    expect(true).toBe(true)
  })
})
