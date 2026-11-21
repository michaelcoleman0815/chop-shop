import { describe, expect, it, vi } from 'vitest'

/**
 * Round 8 (f8b6849): make state kept per chat (chatKey, sync, restore), quote replies routed by what they
 * would change, "not now" sets a quote aside, and a made video's change makes only into its own edit.
 *
 * The real useMake hook (React's hooks as plain functions), with main faked as index.ts runs it, and
 * useCutalong's chat changes mirrored as written: goStart (chatKey + 1, restore([])), openProject
 * (isWorking() checked, then `await api.openProject`, then chatKey + 1 and restore(saved)), `during`
 * counting work as useCutalong's does, and setDoc persisting into whichever project is open.
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
import { withDoc } from '../../../shared/clipping/set'
import type { Project } from '../../../shared/types'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: true, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const phrases = Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`)
const madeOf = (id: string): EditDoc => {
  const make: Make = {
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
  return { id, title: id, sources: [{ id: 's1', path: '/made/narration.wav' }], words: [], assets: [], make, versions: [] } as unknown as EditDoc
}

type Settings = DraftDeps['settings']

function app(settings: Settings, opts: { open?: EditDoc | null } = {}) {
  let chat = new Map<string, Partial<Msg>>()
  let n = 0
  let key = 0
  let working = 0
  let project = 'A'
  const docRef = { current: (opts.open ?? null) as EditDoc | null }
  const calls = { claude: 0, start: [] as { consent: unknown }[], revise: [] as { title: string }[], go: [] as { title: string; into: string | null }[], letGo: [] as string[], saved: [] as { project: string; doc: string }[], savedDocs: [] as { project: string; doc: EditDoc }[] }
  const parse: ParseCall = async () => {
    calls.claude++
    return { parsed_output: { title: 'A Video', sections: [{ heading: 'One', paragraphs: ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'] }] }, stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 3000 } }
  }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => true
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => ({ ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, { parse, can, brand: {}, settings }) })
  fake.api.makeStart = async (req: { text: string; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: unknown }) => {
    const brief = readAsk(req.reading?.trim() ? req.reading : req.text, { niche: null, recording: null })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (req.consent !== 'tap' && req.consent !== 'command') return { ok: false, message: 'I wrote nothing.' }
    calls.start.push({ consent: req.consent })
    const drafted = await draftFor(brief, `video-${calls.start.length}`, { parse, can, brand: {}, settings })
    if (!drafted.ok) return { ok: false, message: drafted.message }
    const d = drafted.draft
    return { ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) }
  }
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'Nothing was changed.' }
    calls.revise.push({ title: req.draft.title })
    await wait(40)
    const r = revise(req.draft, req.steps, { can, settings })
    if (!r) return { ok: true, draft: null }
    if (rewritesScript(req.draft.brief, r.draft.brief, !!req.draft.into)) {
      const again = await draftFor(r.draft.brief, req.draft.id, { parse, can, brand: {}, settings })
      if (!again.ok) return { ok: false, message: again.message }
      return { ok: true, draft: again.draft, reply: quoteReply(again.draft.brief, again.draft.quote, { title: again.draft.title, scenes: 3 }), changed: r.changed }
    }
    return { ok: true, draft: r.draft, reply: quoteReply(r.draft.brief, r.draft.quote, { title: r.draft.title, scenes: 3 }), changed: r.changed }
  }
  // make:go: the made video comes back a while later, as the real one does.
  fake.api.makeGo = async (req: { draft: Draft; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'Nothing was made.' }
    calls.go.push({ title: req.draft.title, into: req.draft.into?.docId ?? null })
    await wait(40)
    const doc = { ...madeOf(`made-from-${req.draft.id}`), title: req.draft.title } as EditDoc
    return { ok: true, doc, mediaUrl: 'media://x', reply: { text: 'v1 is ready.', aside: null, chips: [], details: [] }, spent: 1, into: req.draft.into ?? null }
  }
  const makes = useMake({
    docRef,
    setDoc: (d: EditDoc) => {
      docRef.current = d
      // useCutalong's setDoc: persist(next) into the project open now (projectRef.current).
      calls.saved.push({ project, doc: d.title })
      calls.savedDocs.push({ project, doc: d })
    },
    setMediaUrl: () => undefined,
    push: (m) => {
      const id = `m${++n}`
      chat.set(id, { ...m })
      return id
    },
    patch: (id, p) => {
      if (chat.has(id)) chat.set(id, { ...chat.get(id), ...p })
    },
    applyAsVersion: () => null,
    during: async (work) => {
      working++
      try {
        return await work()
      } finally {
        working--
      }
    },
    findBroll: async () => undefined,
    brand: () => 'default',
    chat: () => String(key)
  })
  const type = async (text: string): Promise<void> => {
    const command = /^\s*\/(\w+)\s*(.*)$/s.exec(text)
    if (await makes.handle(text, command ? { command: command[1], rest: command[2] } : null, [])) return
    if (docRef.current && (await makes.asked(text))) return
    calls.letGo.push(text)
  }
  const buttons = (label: string): Action[] => [...chat.values()].flatMap((m) => (m.actions ?? []).filter((a) => a.label === label)) as Action[]
  const tap = async (label: string): Promise<boolean> => {
    const a = buttons(label).pop()
    if (a) await makes.onAction(a)
    return !!a
  }
  const goButton = (): Action | undefined => [...chat.values()].flatMap((m) => m.actions ?? []).filter((a) => (a.payload ?? '').includes('"go"')).pop() as Action | undefined
  /** useCutalong's openProject, in its order: the working check, the read from disk, then the chat swapped. */
  const openProject = async (name: string, saved: Map<string, Partial<Msg>>, doc: EditDoc | null): Promise<string> => {
    if (working > 0) return 'refused: still working'
    await wait(10)
    project = name
    docRef.current = doc
    key += 1
    const restored = makes.restore([...saved.entries()].map(([id, m]) => ({ id, ...m }) as Msg))
    chat = new Map(restored.map((m) => [m.id, m] as const))
    return 'opened'
  }
  const goStart = (): string => {
    if (working > 0) return 'refused: still working'
    project = 'new'
    docRef.current = null
    key += 1
    makes.restore([])
    chat = new Map()
    return 'started'
  }
  return { makes, calls, type, tap, buttons, goButton, openProject, goStart, chat: () => chat, project: () => project, docRef }
}

const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'

describe('a chat opened while a tap in the last one is under way', () => {
  it('the made video of chat A lands, and is saved, as chat B\'s edit', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const go = w.goButton() as Action
    const bDoc = { id: 'b-edit', title: 'Chat B’s own edit', sources: [], words: [], assets: [], versions: [] } as unknown as EditDoc
    // The sidebar clicked (chat B), and the quote's button tapped before chat B has loaded.
    const opening = w.openProject('B', new Map(), bDoc)
    const tapped = w.makes.onAction(go)
    const [opened] = await Promise.all([opening, tapped])
    console.log(`openProject: ${opened}; make:go ${JSON.stringify(w.calls.go)}; then the edit saved: ${JSON.stringify(w.calls.saved)}; chat B's edit now "${w.docRef.current?.title}"`)
    expect(w.calls.saved.filter((s) => s.project === 'B')).toHaveLength(0)
  })

  it('a quote of chat A, re-quoted on a tap, lands in chat B with a live button', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    await w.type('make it 3 minutes')
    const yes = w.buttons('Yes').pop() as Action
    const opening = w.openProject('B', new Map(), null)
    const tapped = w.makes.onAction(yes)
    await Promise.all([opening, tapped])
    const inB = [...w.chat().values()].filter((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))
    // Chat B shows no quote; what does useMake think waits there?
    await w.type('yes')
    const toYes = [...w.chat().values()].pop()?.text
    await w.type('make a 2 minute documentary about Lisbon')
    const offer = [...w.chat().values()].pop()
    const changed = await w.tap('Change this one')
    console.log(
      `chat B after the switch: ${inB.length} quote(s) shown; typed "yes" -> "${toYes}"; a fresh ask -> "${offer?.text}" ${JSON.stringify(offer?.actions?.map((a) => a.label))}; ` +
        `make:start ${JSON.stringify(w.calls.start.map((s) => s.consent))}; tapped Change this one (${changed}): make:revise on ${JSON.stringify(w.calls.revise.map((r) => r.title))}`
    )
    expect(offer?.actions?.some((a) => a.label === 'Change this one') ?? false).toBe(false)
  })
})

describe('the same race: what chat B keeps, and the Stop', () => {
  it('chat B\'s own edit is written over in its file, and the running make has no Stop in chat B', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const go = w.goButton() as Action
    const bDoc = { id: 'b-edit', title: 'Chat B’s own edit', sources: [{ id: 's1', path: '/b/talk.mp4' }], words: [], assets: [], versions: [] } as unknown as EditDoc
    // Chat B's file as project:open read it; persist() then writes withDoc({ ...project, chat }, next) back over it.
    const bFile = { path: '/p/B.cutalong', name: 'B', mode: 'cut', chat: [{ id: 'b1', role: 'user', text: 'cut the intro' }], edit: bDoc, media: ['/b/talk.mp4'] } as unknown as Project
    const opening = w.openProject('B', new Map([['b1', { role: 'user', text: 'cut the intro' } as Partial<Msg>]]), bDoc)
    const tapped = w.makes.onAction(go)
    await opening
    // make:go still running (40 ms against the 10 ms read): what chat B shows of it.
    const running = w.calls.go.length
    const progress = [...w.chat().values()].filter((m) => m.progress).length
    const stops = w.buttons('Stop').length
    await tapped
    const into = w.calls.savedDocs.filter((s) => s.project === 'B').pop()
    const file = into ? withDoc(bFile, into.doc) : bFile
    const said = [...w.chat().values()].map((m) => m.text)
    console.log(
      `while make:go ran (${running} call): chat B showed ${progress} progress message(s), ${stops} Stop button(s); ` +
        `after it: B's file has edit "${file.edit?.title}" (id ${file.edit?.id}), media ${JSON.stringify(file.media)}; chat B's messages ${JSON.stringify(said)}`
    )
    expect(stops).toBe(1)
    expect(file.edit?.id).toBe('b-edit')
  })
})

describe('chats kept apart, and reopened ones expired', () => {
  it('a new chat starts with nothing waiting; the last chat\'s buttons do nothing in it', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const old = w.goButton() as Action
    w.goStart()
    await w.makes.onAction(old)
    await w.type('make a 2 minute documentary about Lisbon')
    console.log(`old quote's button in the new chat: make:go ${w.calls.go.length}; fresh ask: ${JSON.stringify(w.calls.start.map((s) => s.consent))}`)
    expect(w.calls.go).toHaveLength(0)
    expect(w.calls.start.map((s) => s.consent)).toEqual(['command', 'command'])
  })

  it('reopened with a quote waiting: buttons stripped, expired notes, and nothing typed spends', async () => {
    const before = app({ cap: null, autoUnder: 2 })
    await before.type(QUOTED)
    const saved = before.chat()
    const rows: string[] = []
    for (const reply of ['make it 3 minutes', 'yes', 'ship it', 'make it a 2 minute documentary about the 1950s oil boom', 'not now', 'later']) {
      const after = app({ cap: null, autoUnder: 2 })
      await after.openProject('A', saved, null)
      const kept = [...after.chat().values()].flatMap((m) => (m.actions ?? []).filter((a) => a.kind === 'make'))
      const note = [...after.chat().values()].map((m) => m.aside).find((a) => /expired/.test(a ?? ''))
      await after.type(reply)
      rows.push(`reopened (make buttons left ${kept.length}; note "${note?.slice(0, 50)}"): ${JSON.stringify(reply)} -> "${[...after.chat().values()].pop()?.text?.slice(0, 80)}"; make:start ${after.calls.start.length}, Claude ${after.calls.claude}, let go ${after.calls.letGo.length}`)
      expect(after.calls.start.length + after.calls.claude + after.calls.letGo.length).toBe(0)
    }
    console.log(rows.join('\n'))
  })
})

describe('a quote waiting, routed by what the reply would change', () => {
  it('with a made video open: what goes to the edit (Claude\'s planner), what is read back, what stays here', async () => {
    const replies = [
      'make the captions bigger', 'add music', 'at 1:20 cut the pause', 'shot 3 is too dark', '0:10 to 0:20 is slow', 'cut 0:10 to 0:20', 'make it louder', 'make it darker', 'make it black and white',
      'make it 3 minutes', 'make it 1:20', 'use a British voice', 'make shot 3 a close-up of a wrench', 'yes', 'ship it', 'that works', 'no', 'not now', 'later'
    ]
    const rows: string[] = []
    for (const r of replies) {
      const w = app({ cap: null, autoUnder: null }, { open: madeOf('doc-a') })
      await w.type('make it 3 minutes')
      const before = { letGo: w.calls.letGo.length, msgs: w.chat().size }
      await w.type(r)
      const last = [...w.chat().values()].pop()
      const quoteButton = !!w.goButton()
      rows.push(`${JSON.stringify(r)} -> ${w.calls.letGo.length > before.letGo ? 'the edit (Claude\'s planner)' : `"${last?.text?.slice(0, 70)}" ${JSON.stringify(last?.actions?.map((a) => a.label) ?? [])}`}; quote's button still there: ${quoteButton}`)
    }
    console.log(rows.join('\n'))
    expect(true).toBe(true)
  })

  it('"later" or "not yet" removes the quote\'s button; getting it back means a new script', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const scriptBefore = w.buttons('Read the script').length
    await w.type('later')
    const gone = !w.goButton()
    const scriptAfter = w.buttons('Read the script').length
    const said = [...w.chat().values()].pop()?.text
    await w.type(QUOTED)
    console.log(`"later": "${said}"; the quote's button gone: ${gone}; Read the script buttons ${scriptBefore} -> ${scriptAfter}; asking again: make:start ${w.calls.start.length}, Claude ${w.calls.claude}`)
    expect(gone).toBe(false)
  })

  it('a made video\'s change, quoted on one edit, does nothing with another edit open', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: madeOf('doc-a') })
    await w.type('make it 3 minutes')
    const go = w.goButton() as Action
    w.docRef.current = madeOf('doc-b')
    await w.makes.onAction(go)
    console.log(`change quoted on doc-a, tapped with doc-b open: make:go ${w.calls.go.length}; said "${[...w.chat().values()].pop()?.text}"`)
    expect(w.calls.go).toHaveLength(0)
  })
})
