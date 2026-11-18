import { describe, expect, it, vi } from 'vitest'

/**
 * Regression for the eighth money review: what is paid for belongs to the chat that paid for it, and a chat
 * switch is one step with make. The real useMake hook (React's hooks as plain functions) talks to the real
 * draftFor, revise and changeFor through a fake main that checks consent as index.ts does, and useCutalong's
 * chats are played as files: setDoc saves into the chat open, a chat left is saved as it stood, and a result
 * for a chat not open goes through keepFor into that chat's own file (the real keepInProject).
 *
 * `guarded` plays openProject in useCutalong's order now: the working check, the switch flag and the read, a
 * second working check, then the swap. Unguarded, it is the order the review found (the read, then the swap),
 * so what useMake does on its own can be seen: a result for a chat no longer open is kept in that chat, never
 * in the one open, and the running make's Stop shows wherever the person is.
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
import { withDoc } from '../../../shared/clipping/set'
import { readAsk, rewritesScript } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { questionsFor } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ChatMessage, Project } from '../../../shared/types'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, quoteDraft, revise, type DraftDeps } from '../../../main/make/run'
import { keepInProject } from './kept'
import { useMake } from './useMake'
import type { Action, Msg } from './components/Message'

const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const lines = Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks of West Texas rose over town number ${i + 1} and the men worked through the night.`)
const makeOf = (topic: string): Make => ({
  v: 1,
  brief: { topic, format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', look: 'archival', maps: 'auto', clips: 'auto', images: null, cap: null, inferred: [], ask: `make a 2 minute documentary about ${topic}` },
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
})
const madeOf = (id: string, topic = 'the 1950s oil boom'): EditDoc =>
  ({ id, title: id, sources: [{ id: 's1', path: '/made/narration.wav' }], words: [], assets: [], make: makeOf(topic), versions: [{ n: 1, at: 'then', summary: 'Made.', ops: [], cut: { segments: [] } }] }) as unknown as EditDoc
const ownEdit = (id: string): EditDoc => ({ id, title: `${id}’s own edit`, sources: [{ id: 's1', path: `/${id}/talk.mp4` }], words: [], assets: [], versions: [] }) as unknown as EditDoc
const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'
const READY = 'v1 is ready.'

/** A call held where it is until released. */
function held(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((r) => (release = r))
  return { wait, release }
}

/** Waits until every promise already settling has settled. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

type Settings = DraftDeps['settings']

function app(settings: Settings, opts: { guarded: boolean; open?: EditDoc | null }) {
  const files = new Map<string, Project>()
  const file = (path: string, edit: EditDoc | null = null, chat: ChatMessage[] = []): Project =>
    ({ path, name: path, mode: 'cut', chat, edit, media: [], openedAt: 'then' }) as unknown as Project
  files.set('A', file('A', opts.open ?? null))
  files.set('B', file('B', ownEdit('b-edit'), [{ id: 'b1', role: 'user', text: 'cut the intro' }]))
  let open: string | null = 'A'
  let key = 0
  let working = 0
  let switching = false
  let switchSeq = 0
  let switchDone: Promise<void> = Promise.resolve()
  let chat = new Map<string, Partial<Msg>>()
  let n = 0
  const notices: string[] = []
  const calls = { claude: 0, start: [] as string[], revise: [] as string[], go: [] as string[], shot: [] as string[], cancel: 0, letGo: [] as string[] }
  const holds: { read: ReturnType<typeof held> | null; make: ReturnType<typeof held> | null } = { read: null, make: null }
  let progress: ((p: { stage: string; percent: number | null }) => void) | null = null
  const docRef = { current: (opts.open ?? null) as EditDoc | null }

  const parse: ParseCall = async () => {
    calls.claude++
    return { parsed_output: { title: 'A Video', sections: [{ heading: 'One', paragraphs: ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'] }] }, stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 3000 } }
  }
  const deps: DraftDeps = { parse, can, brand: {}, settings }
  const quoted = (d: Draft) => ({ ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) })
  const made = (id: string, topic: string) => ({ doc: { ...madeOf(`made-${id}`, topic), title: `Made ${id}` }, mediaUrl: 'media://made', reply: { text: READY, aside: null, chips: [], details: [] }, spent: 1 })
  const waitFor = async (h: ReturnType<typeof held> | null): Promise<void> => {
    if (h) await h.wait
  }
  fake.api.onCutProgress = (fn: (p: { stage: string; percent: number | null }) => void) => {
    progress = fn
    return () => {
      if (progress === fn) progress = null
    }
  }
  fake.api.makeCancel = async () => {
    calls.cancel++
    return true
  }
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => ({ ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, deps) })
  // Main, consent and all, as index.ts runs it; a video made straight away under Settings' amount comes back made.
  fake.api.makeStart = async (req: { text: string; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: unknown }) => {
    const brief = readAsk(String(req.reading ?? req.text ?? ''), { niche: null, recording: null })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (req.consent !== 'tap' && req.consent !== 'command') return { ok: false, message: 'refused: no consent' }
    calls.start.push(`${req.consent}: ${brief.topic}`)
    const drafted = await draftFor(brief, `video-${calls.start.length}`, deps)
    if (!drafted.ok) return { ok: false, message: drafted.message }
    if (drafted.draft.quote.auto && !req.quoteFirst) {
      await waitFor(holds.make)
      return { ok: true, kind: 'made', auto: true, ...made(drafted.draft.id, brief.topic), into: null }
    }
    return quoted(drafted.draft)
  }
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    calls.revise.push(req.draft.brief.topic)
    await waitFor(holds.make)
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
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    calls.go.push(req.draft.brief.topic)
    await waitFor(holds.make)
    return { ok: true, ...made(req.draft.id, req.draft.brief.topic), into: req.draft.into ?? null }
  }
  fake.api.makeShot = async (req: { doc: EditDoc; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    calls.shot.push(req.doc.id)
    await waitFor(holds.make)
    return {
      ok: true,
      ops: [],
      make: { ...req.doc.make, spent: 9 },
      asset: { kind: 'image', path: '/made/shot-3-again.png', name: 'shot-3-again.png', origin: 'made' },
      summary: 'Shot 3 is a close-up of a wrench now.',
      reply: { text: 'Shot 3 is a close-up of a wrench now.', aside: null, chips: [], details: [] },
      spent: 0.14
    }
  }

  /** The chat open, saved into its file as persist() saves it: what has settled, never work in progress. */
  const save = (): void => {
    if (!open) return
    const f = files.get(open)
    if (!f) return
    const messages = [...chat.entries()]
      .filter(([, m]) => !m.progress)
      .map(([id, m]) => ({ ...m, id }) as ChatMessage)
    files.set(open, withDoc({ ...f, chat: messages }, docRef.current))
  }
  const makes = useMake({
    docRef,
    setDoc: (d) => {
      docRef.current = d
      save()
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
    chat: () => String(key),
    project: () => (open ? { path: open, name: open } : null),
    // useCutalong's keepInChat: the chat's own file, through the real keepInProject, never the chat open.
    keepFor: async (where, kept) => {
      if (open === where.path) return false
      const f = files.get(where.path)
      if (!f) return false
      files.set(where.path, keepInProject(f, kept, { id: `k${++n}`, brand: 'default', never: [] }))
      return true
    },
    ...(opts.guarded ? { switching: () => switching, settled: () => switchDone } : {}),
    notify: (text) => notices.push(text)
  })
  const busyText = (): string =>
    makes.running() ? 'A video is being made in this chat. Open the other one when it’s done, or stop it first.' : 'I’m still working on this edit. Open another once I’m done.'
  /**
   * useCutalong's openProject, guarded (as it is now) or not (as the review found it). `force` passes its working
   * checks, to see what useMake does were a chat opened while work ran (useCutalong never lets that happen).
   */
  const openProject = async (path: string, force = false): Promise<string> => {
    if (path === open) return 'already open'
    if (working > 0 && !force) {
      notices.push(busyText())
      return 'refused'
    }
    if (opts.guarded) {
      const seq = ++switchSeq
      switching = true
      let done = (): void => undefined
      switchDone = new Promise<void>((r) => (done = r))
      try {
        await waitFor(holds.read)
      } finally {
        if (switchSeq === seq) switching = false
        done()
      }
      if (switchSeq !== seq) return 'gave way'
      if (working > 0 && !force) {
        notices.push(busyText())
        return 'stayed'
      }
    } else await waitFor(holds.read)
    save()
    open = path
    const f = files.get(path)
    docRef.current = f?.edit ?? null
    key += 1
    chat = new Map(makes.restore(((f?.chat ?? []) as Msg[]).map((m) => ({ ...m }))).map((m) => [m.id, m] as const))
    return 'opened'
  }
  const type = async (text: string): Promise<void> => {
    const command = /^\s*\/(\w+)\s*(.*)$/s.exec(text)
    if (await makes.handle(text, command ? { command: command[1], rest: command[2] } : null, [])) return
    if (docRef.current && (await makes.asked(text))) return
    calls.letGo.push(text)
  }
  const buttons = (label?: string): Action[] =>
    [...chat.values()].flatMap((m) => (m.actions ?? []).filter((a) => a.kind === 'make' && (!label || a.label === label))) as Action[]
  const goButton = (): Action | undefined => buttons().filter((a) => (a.payload ?? '').includes('"go"')).pop()
  return {
    makes,
    calls,
    files,
    notices,
    type,
    buttons,
    goButton,
    openProject,
    hold: (what: 'read' | 'make') => (holds[what] = held()),
    progress: (stage: string) => progress?.({ stage, percent: null }),
    chat: () => [...chat.values()],
    last: () => [...chat.values()].pop(),
    open: () => open,
    working: () => working,
    docRef
  }
}

describe('a tap during a chat switch (the eighth review, finding 1)', () => {
  it('guarded: a tap while another chat opens does nothing, and the switch goes ahead', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: true })
    await w.type(QUOTED)
    const go = w.goButton()
    const read = w.hold('read')
    const opening = w.openProject('B')
    await w.makes.onAction(go as Action)
    expect(w.notices).toEqual(['One moment… another chat is opening, so that tap did nothing and nothing was spent.'])
    expect(w.calls.go).toEqual([])
    read.release()
    expect(await opening).toBe('opened')
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
    expect(w.files.get('A')?.edit ?? null).toBeNull()
  })

  it('guarded: work started while the other chat was read keeps this chat open, and lands in it (start’s auto-make)', async () => {
    const settings: Settings = { cap: null, autoUnder: 25 }
    const w = app(settings, { guarded: true })
    const read = w.hold('read')
    const make = w.hold('make')
    const opening = w.openProject('B')
    // An ask typed and sent while B is read: under Settings' amount it is made straight away.
    const asked = w.type('make a 1 minute cinematic documentary about Lisbon')
    await settle()
    expect(w.working()).toBe(1)
    read.release()
    expect(await opening).toBe('stayed')
    expect(w.notices).toEqual(['A video is being made in this chat. Open the other one when it’s done, or stop it first.'])
    make.release()
    await asked
    expect(w.open()).toBe('A')
    expect(w.files.get('A')?.edit?.id).toBe('made-video-1')
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
    expect(w.last()?.text).toBe(READY)
  })

  it('the review’s case, unguarded: the made video of chat A goes into A’s file; B’s file and edit are untouched', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: false })
    await w.type(QUOTED)
    const go = w.goButton() as Action
    const read = w.hold('read')
    const make = w.hold('make')
    const opening = w.openProject('B')
    const tapped = w.makes.onAction(go)
    await settle()
    read.release()
    expect(await opening).toBe('opened')
    // While A's video is made, B shows a line saying so, with a Stop that stops it.
    const line = w.chat().find((m) => (m.actions ?? []).some((a) => a.label === 'Stop'))
    expect(line?.text).toBe('I’m working on your video about the 1950s oil boom in its chat, “A”. Stop it here if you like.')
    await w.makes.onAction((line?.actions ?? [])[0] as Action)
    expect(w.calls.cancel).toBe(1)
    make.release()
    await tapped
    expect(w.calls.go).toEqual(['the 1950s oil boom'])
    expect(w.docRef.current?.id).toBe('b-edit')
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
    expect(w.files.get('A')?.edit?.id).toBe('made-video-1')
    expect(w.files.get('A')?.chat?.at(-1)).toMatchObject({ role: 'assistant', text: READY, actions: [{ kind: 'open-editor' }] })
    expect(w.last()?.text).toBe('Your video about the 1950s oil boom is ready in its chat, “A”.')
    expect(w.chat().some((m) => (m.actions ?? []).some((a) => a.label === 'Stop'))).toBe(false)
  })

  it('unguarded: start’s auto-make, begun while B was read, goes into its own chat’s file, never B’s', async () => {
    const w = app({ cap: null, autoUnder: 25 }, { guarded: false })
    const read = w.hold('read')
    const make = w.hold('make')
    const opening = w.openProject('B')
    // An ask typed and sent in A while B is read: under Settings' amount it is made straight away.
    const asked = w.type('make a 1 minute cinematic documentary about Lisbon')
    await settle()
    read.release()
    expect(await opening).toBe('opened')
    make.release()
    await asked
    expect(w.calls.start).toEqual(['command: Lisbon'])
    expect(w.files.get('A')?.edit?.id).toBe('made-video-1')
    expect(w.files.get('A')?.chat?.at(-1)).toMatchObject({ text: READY })
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
    expect(w.docRef.current?.id).toBe('b-edit')
    expect(w.last()?.text).toBe('Your video about Lisbon is ready in its chat, “A”.')
  })

  it('work running refuses a switch outright, guarded or not, and says a video is being made', async () => {
    for (const guarded of [true, false]) {
      const w = app({ cap: null, autoUnder: null }, { guarded })
      await w.type(QUOTED)
      const make = w.hold('make')
      const tapped = w.makes.onAction(w.goButton() as Action)
      await settle()
      expect(await w.openProject('B')).toBe('refused')
      expect(w.notices).toEqual(['A video is being made in this chat. Open the other one when it’s done, or stop it first.'])
      make.release()
      await tapped
      expect(w.docRef.current?.id).toBe('made-video-1')
      expect(w.files.get('B')?.edit?.id).toBe('b-edit')
    }
  })

  it('unguarded: a re-quote of chat A, tapped as B opens, is kept in A with its script; B has nothing waiting', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: false })
    await w.type(QUOTED)
    await w.type('make it 3 minutes')
    const yes = w.buttons('Yes').pop() as Action
    const read = w.hold('read')
    const make = w.hold('make')
    const opening = w.openProject('B')
    const tapped = w.makes.onAction(yes)
    await settle()
    read.release()
    await opening
    make.release()
    await tapped
    const kept = w.files.get('A')?.chat?.at(-1)
    expect(kept?.text).toMatch(/^I'll make a 3:00 cinematic documentary about the 1950s oil boom/)
    expect(kept?.script?.phrases.length).toBeGreaterThan(0)
    expect(kept?.actions ?? []).toEqual([])
    expect(w.last()?.text).toBe('The quote for your video about the 1950s oil boom is in its chat, “A”.')
    // Nothing of A's waits in B: "yes" goes to B's edit, and a fresh ask is its own, with no "Change this one".
    await w.type('yes')
    expect(w.calls.letGo).toEqual(['yes'])
    await w.type('/make a 2 minute documentary about Lisbon')
    expect(w.buttons('Change this one')).toEqual([])
    expect(w.calls.start).toEqual(['command: the 1950s oil boom', 'command: Lisbon'])
    expect(w.calls.revise).toEqual(['the 1950s oil boom'])
  })

  it('unguarded: a shot of chat A’s video, made as B opens, goes into A’s edit; B’s is untouched', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: false, open: madeOf('a-edit') })
    await w.type('make shot 3 a close-up of a wrench')
    const again = w.buttons().find((a) => (a.payload ?? '').includes('"shot"')) as Action
    expect(again).toBeTruthy()
    const read = w.hold('read')
    const make = w.hold('make')
    const opening = w.openProject('B')
    const tapped = w.makes.onAction(again)
    await settle()
    read.release()
    await opening
    make.release()
    await tapped
    expect(w.calls.shot).toEqual(['a-edit'])
    const a = w.files.get('A')?.edit
    expect(a?.id).toBe('a-edit')
    expect(a?.assets.map((x) => x.path)).toEqual(['/made/shot-3-again.png'])
    expect(a?.make?.spent).toBe(9)
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
    expect(w.docRef.current?.assets ?? []).toEqual([])
  })

  it('its own chat opened again while it is made: its progress and Stop show there, and it lands there', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: false })
    await w.type(QUOTED)
    const go = w.goButton() as Action
    const read = w.hold('read')
    const make = w.hold('make')
    const opening = w.openProject('B')
    const tapped = w.makes.onAction(go)
    await settle()
    read.release()
    await opening
    // Back to A past the working check, which useCutalong would not allow: what useMake does were it to happen.
    w.hold('read').release()
    expect(await w.openProject('A', true)).toBe('opened')
    const line = w.chat().find((m) => m.progress)
    expect(line?.actions?.map((a) => a.label)).toEqual(['Stop'])
    make.release()
    await tapped
    expect(w.docRef.current?.id).toBe('made-video-1')
    expect(w.files.get('A')?.edit?.id).toBe('made-video-1')
    expect(w.last()).toMatchObject({ text: READY, progress: null })
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
  })
})

describe('a quote put off, or turned down (finding 2)', () => {
  for (const later of ['later', 'maybe later', 'not yet', 'another time', 'not today', 'not now', 'let me think', 'hold on']) {
    it(`"${later}" keeps the quote, both buttons and all`, async () => {
      const w = app({ cap: null, autoUnder: null }, { guarded: true })
      await w.type(QUOTED)
      await w.type(later)
      expect(w.last()?.text).toBe('It’s here when you’re ready.')
      expect(w.goButton()).toBeTruthy()
      expect(w.buttons('Read the script')).toHaveLength(1)
      // Still live: its button makes it, and no second script is written.
      await w.makes.onAction(w.goButton() as Action)
      expect(w.calls.go).toEqual(['the 1950s oil boom'])
      expect(w.calls.claude).toBe(1)
    })
  }
  for (const no of ['no', 'never mind', 'cancel']) {
    it(`"${no}" sets it aside, and its script, paid for, stays to read`, async () => {
      const w = app({ cap: null, autoUnder: null }, { guarded: true })
      await w.type(QUOTED)
      await w.type(no)
      expect(w.last()?.text).toBe('All right, I’ve set that quote aside. Its script stays above to read, and nothing more is spent.')
      expect(w.goButton()).toBeUndefined()
      const quote = w.chat().find((m) => m.script)
      expect(quote?.script?.phrases).toEqual(['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'])
      // No live quote behind it (the chat renders its script from the reply), and nothing more was written.
      expect(quote?.make).toBeUndefined()
      expect(w.calls.claude).toBe(1)
    })
  }
  it('a quote replaced by a newer one keeps its script too, and a chat opened again still shows it', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: true })
    await w.type(QUOTED)
    await w.type('make it 3 minutes')
    await w.makes.onAction(w.buttons('Yes').pop() as Action)
    const quotes = w.chat().filter((m) => m.script)
    expect(quotes).toHaveLength(2)
    expect(quotes[0].make).toBeUndefined()
    expect(w.goButton()).toBeTruthy()
    w.hold('read').release()
    await w.openProject('B')
    w.hold('read').release()
    await w.openProject('A')
    expect(w.chat().filter((m) => m.script)).toHaveLength(2)
    expect(w.chat().every((m) => !m.make)).toBe(true)
  })
})

describe('with a made video open and a quote waiting, how it should look or sound is the edit’s (finding 3)', () => {
  it('goes to the edit', async () => {
    for (const r of ['make it louder', 'make it darker', 'quieter please', 'make it brighter', 'warmer', 'a bit cooler', 'sharper', 'make it faster']) {
      const w = app({ cap: null, autoUnder: null }, { guarded: true, open: madeOf('a-edit') })
      await w.type('make it 3 minutes')
      expect(w.goButton(), r).toBeTruthy()
      await w.type(r)
      expect(w.calls.letGo, r).toEqual([r])
      expect(w.goButton(), r).toBeTruthy()
    }
  })
})

describe('the Stop of a video being made, from wherever the person is', () => {
  it('another chat shows a line with its Stop, and every page a line with its stage', async () => {
    const w = app({ cap: null, autoUnder: null }, { guarded: false })
    await w.type(QUOTED)
    const go = w.goButton() as Action
    const make = w.hold('make')
    const tapped = w.makes.onAction(go)
    await settle()
    // Every page but the chat shows this, with Stop (App's MakeRunning): what is being made, and its stage.
    expect(w.makes.running()).toEqual({ what: 'your video about the 1950s oil boom', stage: null })
    w.progress('Tint is making the shots with Google: 5 of 14')
    expect(w.makes.running()).toEqual({ what: 'your video about the 1950s oil boom', stage: 'Tint is making the shots with Google: 5 of 14' })
    await w.makes.stop()
    expect(w.calls.cancel).toBe(1)
    make.release()
    await tapped
    expect(w.makes.running()).toBeNull()
  })
})
