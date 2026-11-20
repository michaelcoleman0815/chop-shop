import { describe, expect, it, vi } from 'vitest'

/**
 * Round 9 (c6500bc on 107eb35): the eighth review's fixes, tried adversarially.
 *
 * The real useMake (React's hooks as plain functions), the real draftFor, revise, changeFor and keepInProject, and a
 * fake main that checks consent and runs one make at a time as index.ts does (a second make:go, make:shot,
 * make:revise or script is refused with busy() before anything is spent). useCutalong's chat changes are played in
 * their order at c6500bc:
 * - openProject: the chat already open returns at once; the working check; switchSeq, the switching flag and
 *   switchDone; the wait for a keep of that chat; the read (a snapshot of the file then); the flag cleared when this
 *   open is still the latest; overtaken opens give way; a second working check; the chat left saved; the swap.
 * - goStart: the working check; switchSeq + 1 and the flag cleared; the chat left saved; a new chat.
 * - keepInChat: keeps of one chat one after another, never into the chat open, read then written.
 *
 * Kept as a regression test from round 10 on, played in the order useCutalong and main have now: keepInChat is
 * main's keepInFile (one turn per file: read, merged, written; a new video never replaces an edit, and with no
 * file it goes in a new chat of its own); a chat gets its file before anything is spent (ensureChat); and a new
 * video asked for in a chat with an edit goes in a new chat (newChat), made and opened before anything is spent.
 * Where the decision differs from what the reviewer expected, the expectation says so.
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
import { withDoc } from '../../../shared/clipping/set'
import { readAsk, rewritesScript } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { isDeferral, questionsFor } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ChatMessage, Project } from '../../../shared/types'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, quoteDraft, revise, type DraftDeps } from '../../../main/make/run'
import { keepInProject, type Kept } from '../../../shared/make/kept'
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
const ownEdit = (id: string, versions = 0): EditDoc =>
  ({
    id,
    title: `${id}’s own edit`,
    sources: [{ id: 's1', path: `/${id}/talk.mp4` }],
    words: [],
    assets: [],
    versions: Array.from({ length: versions }, (_, i) => ({ n: i + 1, at: 'then', summary: `Version ${i + 1} of ${id}.`, ops: [], cut: { segments: [] } }))
  }) as unknown as EditDoc
const QUOTED = 'make a 1 minute cinematic documentary about the 1950s oil boom'
const READY = 'v1 is ready.'
const BUSY = 'A video is being made already. Wait for it, or stop it first.'

/** A call held where it is until released. */
function held(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((r) => (release = r))
  return { wait, release }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
/** Long enough for everything not held to have run. */
const pause = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Settings = DraftDeps['settings']
type Kind = 'read' | 'keepRead' | 'make' | 'start' | 'newChat'

function app(settings: Settings, opts: { open?: EditDoc | null } = {}) {
  const files = new Map<string, Project>()
  const file = (path: string, edit: EditDoc | null = null, chat: ChatMessage[] = []): Project =>
    ({ path, name: path, mode: 'cut', chat, edit, media: [], openedAt: 'then' }) as unknown as Project
  files.set('A', file('A', opts.open ?? null))
  files.set('B', file('B', ownEdit('b-edit'), [{ id: 'b1', role: 'user', text: 'cut the intro' }]))
  files.set('C', file('C', ownEdit('c-edit'), [{ id: 'c1', role: 'user', text: 'add captions' }]))
  let open: string | null = 'A'
  let key = 0
  let working = 0
  let switching = false
  let switchSeq = 0
  let switchDone: Promise<void> = Promise.resolve()
  const keeping = new Map<string, Promise<unknown>>()
  let chat = new Map<string, Partial<Msg>>()
  let n = 0
  const notices: string[] = []
  const calls = { claude: 0, start: [] as string[], revise: [] as string[], go: [] as string[], shot: [] as string[], cancel: 0, letGo: [] as string[], busy: [] as string[], keeps: [] as string[] }
  const holds: Record<Kind, ReturnType<typeof held> | null> = { read: null, keepRead: null, make: null, start: null, newChat: null }
  /** A new chat that cannot be made now (useCutalong's newChat answering null). */
  let refuseNew = false
  /** The hold for the next call of this kind, used once. */
  const take = (k: Kind): ReturnType<typeof held> | null => {
    const h = holds[k]
    holds[k] = null
    return h
  }
  const waitFor = async (h: ReturnType<typeof held> | null): Promise<void> => {
    if (h) await h.wait
  }
  const docRef = { current: (opts.open ?? null) as EditDoc | null }

  const parse: ParseCall = async () => {
    calls.claude++
    return { parsed_output: { title: 'A Video', sections: [{ heading: 'One', paragraphs: ['We drove north at dawn.', 'The lake was still.', 'The town woke slowly.'] }] }, stop_reason: 'end_turn', usage: { input_tokens: 4000, output_tokens: 3000 } }
  }
  const deps: DraftDeps = { parse, can, brand: {}, settings }
  const quoted = (d: Draft) => ({ ok: true, kind: 'quote', draft: d, reply: quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes }) })
  const made = (id: string, topic: string) => ({ doc: { ...madeOf(`made-${id}`, topic), title: `Made ${id}` }, mediaUrl: 'media://made', reply: { text: READY, aside: null, chips: [], details: [] }, spent: 1 })
  // Main's one make at a time (index.ts `running`): a second is refused with busy() before anything is spent.
  let mainRunning: string | null = null
  const claim = (what: string): boolean => {
    if (mainRunning) return false
    mainRunning = what
    return true
  }
  const free = (what: string): void => {
    if (mainRunning === what) mainRunning = null
  }
  fake.api.onCutProgress = () => () => undefined
  fake.api.makeCancel = async () => {
    calls.cancel++
    return true
  }
  fake.api.makeChange = async (req: { doc: EditDoc; text: string; onScreen?: string | null }) => ({ ok: true, change: await changeFor(req.doc, req.text, req.onScreen ?? null, deps) })
  fake.api.makeStart = async (req: { text: string; answered?: boolean; quoteFirst?: boolean; reading?: string; consent?: unknown }) => {
    const brief = readAsk(String(req.reading ?? req.text ?? ''), { niche: null, recording: null })
    if (!brief) return { ok: false, message: 'Tell me what the video is about.' }
    const questions = req.answered ? [] : questionsFor(brief)
    if (questions.length) return { ok: true, kind: 'ask', questions }
    if (req.consent !== 'tap' && req.consent !== 'command') return { ok: false, message: 'refused: no consent' }
    if (!claim('script')) {
      calls.busy.push(`make:start (${brief.topic})`)
      return { ok: false, message: BUSY }
    }
    try {
      calls.start.push(`${req.consent}: ${brief.topic}`)
      await waitFor(take('start'))
      const drafted = await draftFor(brief, `video-${calls.start.length}`, deps)
      if (!drafted.ok) return { ok: false, message: drafted.message }
      if (drafted.draft.quote.auto && !req.quoteFirst) {
        await waitFor(take('make'))
        return { ok: true, kind: 'made', auto: true, ...made(drafted.draft.id, brief.topic), into: null }
      }
      return quoted(drafted.draft)
    } finally {
      free('script')
    }
  }
  fake.api.makeRevise = async (req: { draft: Draft; steps: string[]; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    if (!claim('requote')) {
      calls.busy.push(`make:revise (${req.draft.brief.topic})`)
      return { ok: false, message: BUSY }
    }
    try {
      calls.revise.push(req.draft.brief.topic)
      await waitFor(take('make'))
      const draft = { ...req.draft, quote: quoteDraft(req.draft, deps) }
      const r = revise(draft, req.steps, deps)
      if (!r) return { ok: true, draft: null }
      if (rewritesScript(draft.brief, r.draft.brief, !!draft.into)) {
        const again = await draftFor(r.draft.brief, draft.id, { ...deps, spentBefore: draft.scriptCost })
        if (!again.ok) return { ok: false, message: again.message }
        return { ...quoted(again.draft), changed: r.changed }
      }
      return { ...quoted(r.draft), changed: r.changed }
    } finally {
      free('requote')
    }
  }
  fake.api.makeGo = async (req: { draft: Draft; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    if (!claim('make')) {
      calls.busy.push(`make:go (${req.draft.brief.topic})`)
      return { ok: false, message: BUSY }
    }
    try {
      calls.go.push(`${req.draft.brief.topic}, ${req.draft.brief.seconds} s`)
      await waitFor(take('make'))
      return { ok: true, ...made(req.draft.id, req.draft.brief.topic), into: req.draft.into ?? null }
    } finally {
      free('make')
    }
  }
  fake.api.makeShot = async (req: { doc: EditDoc; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    if (!claim('shot')) {
      calls.busy.push(`make:shot (${req.doc.id})`)
      return { ok: false, message: BUSY }
    }
    try {
      calls.shot.push(req.doc.id)
      await waitFor(take('make'))
      return {
        ok: true,
        ops: [],
        make: { ...req.doc.make, spent: 9 },
        asset: { kind: 'image', path: '/made/shot-3-again.png', name: 'shot-3-again.png', origin: 'made' },
        summary: 'Shot 3 is a close-up of a wrench now.',
        reply: { text: 'Shot 3 is a close-up of a wrench now.', aside: null, chips: [], details: [] },
        spent: 0.14
      }
    } finally {
      free('shot')
    }
  }

  /** persist(): the chat open saved into its file, what has settled, never work in progress. */
  const save = (): void => {
    if (!open) return
    const f = files.get(open)
    if (!f) return
    const messages = [...chat.entries()].filter(([, m]) => !m.progress).map(([id, m]) => ({ ...m, id }) as ChatMessage)
    files.set(open, withDoc({ ...f, chat: messages }, docRef.current))
  }
  /** A chat of its own, made in main for a kept result with nowhere else to go. */
  const madeChat = (name: string): string => {
    let path = name
    for (let i = 2; files.has(path); i++) path = `${name} ${i}`
    files.set(path, file(path))
    return path
  }
  /**
   * main's keepInFile (useCutalong's keepInChat): in that file's turn, read, merged, written; never into the chat
   * open; a new video never replaces an edit, and with no file it goes in a new chat of its own, said where.
   */
  const keepInChat = (where: { path: string; name: string } | null, name: string, kept: Kept): Promise<{ path: string; name: string } | null> => {
    const path = where && open !== where.path ? where.path : null
    const run = async (): Promise<{ path: string; name: string } | null> => {
      const h = take('keepRead')
      await waitFor(h)
      const f = path ? files.get(path) : undefined
      const next = f ? keepInProject(structuredClone(f), kept, `k${++n}`) : null
      if (path && f && next) {
        files.set(path, next)
        calls.keeps.push(`${path}: kept "${kept.message.text.slice(0, 40)}"`)
        return { path, name: path }
      }
      const made = madeChat(name)
      const fresh = keepInProject(files.get(made) as Project, kept, `k${++n}`)
      if (!fresh) return null
      files.set(made, fresh)
      if (path && f) files.set(path, { ...f, chat: [...(f.chat ?? []), { id: `moved-${n}`, role: 'assistant', text: `Your new video is in a new chat, “${made}”, so the edit here stays as it is.` }] })
      calls.keeps.push(`${made} (new): kept "${kept.message.text.slice(0, 40)}"`)
      return { path: made, name: made }
    }
    const key = path ?? '(new)'
    const before = keeping.get(key) ?? Promise.resolve(true)
    const turn = before
      .catch(() => false)
      .then(run)
      .catch(() => null)
    keeping.set(key, turn)
    void turn.then(() => {
      if (keeping.get(key) === turn) keeping.delete(key)
    })
    return turn
  }
  /** useCutalong's ensureChat: the open chat's file, made now if it has none (ensureProject). */
  const ensureChat = async (name: string): Promise<{ path: string; name: string } | null> => {
    if (!open) open = madeChat(name)
    return { path: open, name: open }
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
    ensureChat,
    keepFor: keepInChat,
    newChat: async (name, first, leaving) => newChat(name, first, leaving),
    goAhead: async () => typeof settings.autoUnder === 'number' && settings.autoUnder > 0,
    never: () => [],
    switching: () => switching,
    settled: () => switchDone,
    notify: (text) => notices.push(text)
  })
  /**
   * useCutalong's newChat: a chat of its own for a new video, as the chat it was asked in has an edit: made and
   * saved with what was asked in it, the chat left given its line, then opened, before anything is spent.
   */
  async function newChat(
    name: string,
    first: Omit<ChatMessage, 'id'>[],
    leaving: (name: string) => Omit<ChatMessage, 'id'>
  ): Promise<{ path: string; name: string } | null> {
    await waitFor(take('newChat'))
    if (working > 0 || refuseNew) return null
    const path = madeChat(name)
    files.set(path, { ...(files.get(path) as Project), chat: first.map((m, i) => ({ ...m, id: `f${++n}-${i}` }) as ChatMessage) })
    chat.set(`m${++n}`, { ...leaving(path) })
    save()
    open = path
    docRef.current = null
    key += 1
    chat = new Map(makes.restore(((files.get(path)?.chat ?? []) as Msg[]).map((m) => ({ ...m }))).map((m) => [m.id, m] as const))
    return { path, name: path }
  }
  const busyText = (to: 'open' | 'start'): string =>
    makes.running()
      ? `A video is being made in this chat. ${to === 'open' ? 'Open the other one' : 'Start a new one'} when it’s done, or stop it first.`
      : `I'm still working on ${open ?? 'this edit'}. ${to === 'open' ? 'Open another' : 'Start a new one'} once I'm done.`
  /** useCutalong's openProject, in its order: the chat already open, asked for again, takes over from another opening. */
  const openProject = async (path: string): Promise<string> => {
    if (path === open) {
      switchSeq += 1
      switching = false
      return 'already open'
    }
    if (working > 0) {
      notices.push(busyText('open'))
      return 'refused'
    }
    const seq = ++switchSeq
    switching = true
    let done = (): void => undefined
    switchDone = new Promise<void>((r) => (done = r))
    const h = take('read')
    let project: Project | null = null
    try {
      await keeping.get(path)
      await waitFor(h)
      const f = files.get(path)
      project = f ? structuredClone(f) : null
    } finally {
      if (switchSeq === seq) switching = false
      done()
    }
    if (switchSeq !== seq) return 'gave way'
    if (!project) return 'no file'
    if (working > 0) {
      notices.push(busyText('open'))
      return 'stayed'
    }
    save()
    open = path
    docRef.current = project.edit ?? null
    key += 1
    chat = new Map(makes.restore(((project.chat ?? []) as Msg[]).map((m) => ({ ...m }))).map((m) => [m.id, m] as const))
    return 'opened'
  }
  /** useCutalong's goStart at c6500bc. */
  const goStart = (): string => {
    if (working > 0) {
      notices.push(busyText('start'))
      return 'refused'
    }
    switchSeq += 1
    switching = false
    save()
    open = null
    key += 1
    const fresh = makes.restore([])
    docRef.current = null
    chat = new Map(fresh.map((m) => [m.id, m] as const))
    return 'started'
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
    goStart,
    hold: (k: Kind) => (holds[k] = held()),
    refuseNewChats: (v: boolean) => (refuseNew = v),
    chat: () => [...chat.values()],
    entries: () => [...chat.entries()],
    last: () => [...chat.values()].pop(),
    open: () => open,
    working: () => working,
    docRef
  }
}

describe('the Stop of a video being made, from every page', () => {
  it('a second paid ask, refused by main while the video is made, takes the running line and its Stop off every page', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const make = w.hold('make')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    const before = w.makes.running()
    // Nothing is waiting while it is made (go cleared the quote), so a new ask is the person's own go-ahead.
    await w.type('/make a 2 minute cinematic documentary about Lisbon')
    const after = w.makes.running()
    const said = w.last()?.text
    const stops = w.buttons('Stop').length
    const still = w.working()
    make.release()
    await tapped
    console.log(
      `while make:go ran: running() ${JSON.stringify(before)}; a fresh /make typed: main refused ${JSON.stringify(w.calls.busy)}, the chat says "${said}"; ` +
        `running() now ${JSON.stringify(after)} (App shows the line and its Stop on every page but the chat only while it is set; Header's MakeRunning); ` +
        `make:go still running: ${still === 1}; Stop buttons left in its own chat: ${stops}`
    )
    expect(after).not.toBeNull()
  })
})

describe('the Stop of a video being made, from every page (an ask main answers with questions)', () => {
  it('a new ask typed while the video is made, answered with free questions, takes the line and its Stop off too', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const make = w.hold('make')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    const before = w.makes.running()
    await w.type('make a video about Lisbon')
    const after = w.makes.running()
    const said = w.last()?.text
    make.release()
    await tapped
    console.log(`while make:go ran: running() ${JSON.stringify(before)}; "make a video about Lisbon" typed: "${said}", nothing spent (make:start ${JSON.stringify(w.calls.start)}); running() now ${JSON.stringify(after)}`)
    expect(after).not.toBeNull()
  })
})

describe('isDeferral at its edges, with a quote waiting', () => {
  it('a hold or a no said with a change, and a no said with a later', async () => {
    // Round 10's decision: hold and no words come out first and what is left is read for a change; with nothing
    // left, a deferral keeps the quote; only a bare no sets it aside; a change it cannot place ("make it shorter")
    // is said, the quote unchanged ('unplaced'), never let go.
    type Want = 'read back' | 'kept' | 'set aside' | 'unplaced'
    const rows: [string, Want][] = [
      ['make it 3 minutes', 'read back'],
      ['hold on, make it 3 minutes', 'read back'],
      ['not yet, make it 3 minutes', 'read back'],
      ['hold on, make it a 5 minute video', 'read back'],
      ['let me think, make it 2 minutes', 'read back'],
      ['wait, make it 3 minutes', 'read back'],
      ['hold on, make it 10 minutes', 'read back'],
      ['not now, make it 10 minutes', 'read back'],
      ['no, make it 3 minutes', 'read back'],
      ['make it shorter', 'unplaced'],
      ['not now, make it shorter', 'unplaced'],
      ['no, make it shorter', 'unplaced'],
      ['later, make it shorter', 'unplaced'],
      ['no, later', 'kept'],
      ['no, not now', 'kept'],
      ['no thanks, maybe later', 'kept'],
      ['not now', 'kept'],
      ['later', 'kept'],
      ['hold on', 'kept'],
      ['never mind', 'set aside'],
      ['cancel', 'set aside'],
      ['no', 'set aside']
    ]
    const out: string[] = []
    const wrong: string[] = []
    for (const [reply, want] of rows) {
      const w = app({ cap: null, autoUnder: null })
      await w.type(QUOTED)
      await w.type(reply)
      const last = w.last()
      const labels = (last?.actions ?? []).map((a) => a.label)
      const got: Want | string = labels.includes('Yes')
        ? 'read back'
        : /^The quote hasn’t changed/.test(last?.text ?? '')
          ? 'unplaced'
          : w.goButton()
            ? 'kept'
            : /set that quote aside/.test(last?.text ?? '')
              ? 'set aside'
              : 'other'
      out.push(`${JSON.stringify(reply)} (isDeferral ${isDeferral(reply)}) -> ${got}: "${last?.text?.slice(0, 60)}"`)
      if (got !== want) wrong.push(`${reply}: wanted ${want}, got ${got}`)
    }
    // What a change swallowed by "It's here when you're ready." leads to: the button makes the quote as it was.
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    await w.type('hold on, make it 3 minutes')
    const reply = w.last()?.text
    const button = w.goButton()?.label
    await w.makes.onAction(w.goButton() as Action)
    out.push(`"hold on, make it 3 minutes" -> "${reply}"; then its button "${button}" makes ${JSON.stringify(w.calls.go)}`)
    console.log(out.join('\n'))
    expect(wrong).toEqual([])
  })
})

describe('edit adjectives and a made video', () => {
  const adjectives = [
    'make it louder',
    'make it darker',
    'make it warmer',
    'make it faster',
    'make it slower',
    'make it brighter',
    'make the narration warmer',
    'make the voice deeper',
    'use a warmer voice',
    'make the pictures darker',
    'make shot 3 darker',
    'make it black and white',
    'make it sepia',
    'make it shorter',
    'make it longer',
    'make it 2 minutes and punchier',
    'make it bigger',
    'quieter please',
    'make it moodier'
  ]
  const paid = (w: ReturnType<typeof app>): number => w.calls.claude + w.calls.start.length + w.calls.revise.length + w.calls.go.length + w.calls.shot.length

  it('with a change quote waiting: where each goes, and that none spends', async () => {
    const rows: string[] = []
    const spent: string[] = []
    for (const r of adjectives) {
      const w = app({ cap: null, autoUnder: 25 }, { open: madeOf('doc-a') })
      await w.type('make it 3 minutes')
      const before = { paid: paid(w), letGo: w.calls.letGo.length }
      await w.type(r)
      const last = w.last()
      const route = w.calls.letGo.length > before.letGo ? 'the edit' : `"${last?.text?.slice(0, 60)}" ${JSON.stringify((last?.actions ?? []).map((a) => a.label))}`
      rows.push(`${JSON.stringify(r)} -> ${route}`)
      if (paid(w) > before.paid) spent.push(`${r}: ${JSON.stringify(w.calls)}`)
    }
    console.log(rows.join('\n'))
    expect(spent).toEqual([])
  })

  it('with nothing waiting: where each goes, and that none spends', async () => {
    const rows: string[] = []
    const spent: string[] = []
    for (const r of adjectives) {
      const w = app({ cap: null, autoUnder: 25 }, { open: madeOf('doc-a') })
      const before = { paid: paid(w), letGo: w.calls.letGo.length }
      await w.type(r)
      const last = w.last()
      const route = w.calls.letGo.length > before.letGo ? 'the edit' : `"${last?.text?.slice(0, 60)}" ${JSON.stringify((last?.actions ?? []).map((a) => a.label))}`
      rows.push(`${JSON.stringify(r)} -> ${route}`)
      if (paid(w) > before.paid) spent.push(`${r}: ${JSON.stringify(w.calls)}`)
    }
    console.log(rows.join('\n'))
    expect(spent).toEqual([])
  })
})

describe('switch ordering', () => {
  it('the chat already open, clicked while another is read, does not take over: the other opens anyway', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const read = w.hold('read')
    const toB = w.openProject('B')
    const back = await w.openProject('A')
    read.release()
    const b = await toB
    console.log(`clicked B, then A (open) while B was read: A -> ${back}; B -> ${b}; open now ${w.open()}`)
    expect(w.open()).toBe('A')
  })

  it('a later open takes over, whichever read finishes first; a new chat takes over too; old buttons do nothing', async () => {
    const out: string[] = []
    for (const first of ['B', 'C'] as const) {
      const w = app({ cap: null, autoUnder: null })
      await w.type(QUOTED)
      const rb = w.hold('read')
      const toB = w.openProject('B')
      const rc = w.hold('read')
      const toC = w.openProject('C')
      const tap = await w.makes.onAction(w.goButton() as Action).then(() => w.notices.slice(-1)[0])
      if (first === 'B') {
        rb.release()
        await settle()
        rc.release()
      } else {
        rc.release()
        await settle()
        rb.release()
      }
      const r = [await toB, await toC]
      out.push(`B and C opened, ${first}'s read first: B ${r[0]}, C ${r[1]}; open ${w.open()}; a tap meanwhile: "${tap}"; make:go ${w.calls.go.length}`)
      expect(w.open()).toBe('C')
      expect(w.calls.go).toEqual([])
    }
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const old = w.goButton() as Action
    const read = w.hold('read')
    const toB = w.openProject('B')
    const started = w.goStart()
    read.release()
    const b = await toB
    await w.makes.onAction(old)
    out.push(`B opened, then a new chat: ${started}; B ${b}; open ${w.open()}; the old quote's button in the new chat: make:go ${w.calls.go.length}, said "${w.last()?.text?.slice(0, 50)}"`)
    console.log(out.join('\n'))
    expect(w.open()).toBeNull()
    expect(w.calls.go).toEqual([])
  })
})

describe('keepFor and the same chat opened again', () => {
  it('a quote kept in chat A while B is open; A opened again while it is still being written waits for it', async () => {
    const w = app({ cap: null, autoUnder: null })
    // An ask typed and sent in A while B is read, its script written before the read is done.
    const read = w.hold('read')
    const toB = w.openProject('B')
    const asked = w.type('make a 1 minute cinematic documentary about Lisbon')
    await pause()
    const keepRead = w.hold('keepRead')
    read.release()
    const b = await toB
    await pause()
    const inB = w.chat().map((m) => m.text)
    const reopening = w.openProject('A')
    await pause()
    keepRead.release()
    const a = await reopening
    await asked
    const bFile = (w.files.get('B')?.chat ?? []).map((m) => m.text)
    const inA = w.chat().filter((m) => /Lisbon|came back/i.test(`${m.text} ${m.aside ?? ''}`))
    console.log(
      `B ${b} with the script written meanwhile: make:start ${JSON.stringify(w.calls.start)}; B shows ${JSON.stringify(inB)}; keeps ${JSON.stringify(w.calls.keeps)}; ` +
        `A opened again while the keep was written: ${a}; A shows ${inA.length} kept quote(s), aside "${inA[0]?.aside}", script kept ${!!inA[0]?.script}; live buttons in A ${w.buttons().length}; B's edit ${w.files.get('B')?.edit?.id}; B's file says ${JSON.stringify(bFile)}`
    )
    expect(inA).toHaveLength(1)
    expect(w.files.get('B')?.edit?.id).toBe('b-edit')
  })

  it('the same, for a new chat with no file yet: what came back has nowhere to go', async () => {
    const w = app({ cap: null, autoUnder: null })
    w.goStart()
    const read = w.hold('read')
    const toB = w.openProject('B')
    const asked = w.type('make a 1 minute cinematic documentary about Lisbon')
    await pause()
    read.release()
    const b = await toB
    await asked
    await pause()
    console.log(`a new chat, B opened, a script written meanwhile (make:start ${JSON.stringify(w.calls.start)}, Claude ${w.calls.claude}): B ${b}; B says "${w.last()?.text}"; keeps ${JSON.stringify(w.calls.keeps)}`)
    expect(w.last()?.text ?? '').not.toMatch(/couldn’t keep it/)
  })
})

describe('a quote replaced by "Start a new video"', () => {
  it('keeps its script to read, as a quote set aside or replaced otherwise does', async () => {
    const w = app({ cap: null, autoUnder: null })
    await w.type(QUOTED)
    const [firstId, first] = w.entries().find(([, m]) => !!m.make) ?? ['', {} as Partial<Msg>]
    const oldKey = first.make as string
    await w.type('make a 2 minute cinematic documentary about Lisbon')
    const offered = (w.last()?.actions ?? []).map((a) => a.label)
    await w.makes.onAction(w.buttons('Start a new video').pop() as Action)
    const old = new Map(w.entries()).get(firstId) ?? {}
    // Thread.tsx: m.make ? <MakeBrief id={m.make}> : m.script ? <KeptScript> : null. MakeBrief shows the script only while
    // scriptOpen(id), which only its "Read the script" action opens.
    const shows = old.make ? `MakeBrief (draft there: ${!!w.makes.draft(old.make)}, script open: ${w.makes.scriptOpen(old.make)})` : old.script ? 'KeptScript' : 'nothing'
    const toggle = (old.actions ?? []).some((a) => a.label === 'Read the script')
    console.log(
      `read back ${JSON.stringify(offered)}; tapped Start a new video: make:start ${JSON.stringify(w.calls.start)}; the first quote now: make ${old.make === oldKey ? 'still set' : String(old.make)}, script kept ${!!old.script}, ` +
        `"Read the script" action ${toggle}; it shows ${shows}`
    )
    // The same quote turned down with "no" shows KeptScript.
    const v = app({ cap: null, autoUnder: null })
    await v.type(QUOTED)
    await v.type('no')
    const aside = v.chat().find((m) => !!m.script)
    console.log(`the same quote turned down with "no": make ${String(aside?.make)}, so it shows ${aside?.make ? 'MakeBrief' : aside?.script ? 'KeptScript' : 'nothing'}`)
    expect(old.make).toBeUndefined()
  })
})

describe('a made video asked for in a chat with its own edit', () => {
  // Round 10's decision: a new video never replaces an edit. It goes in a new chat, made and opened before anything
  // is spent (on the tap, or before the script with Settings' go-ahead on), and the chat left says where.
  it('its own edit, versions and all, stays in its file; the video is made in a new chat', async () => {
    const out: string[] = []
    for (const autoUnder of [25, null]) {
      const w = app({ cap: null, autoUnder }, { open: ownEdit('a-edit', 3) })
      w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
      await w.type('/make a 1 minute cinematic documentary about Lisbon')
      const quoted = w.goButton()
      if (quoted) await w.makes.onAction(quoted)
      const f = w.files.get('A')
      out.push(
        `go-ahead ${autoUnder ?? 'off'}: ${quoted ? `quote "${quoted.label}" tapped` : 'made straight away, no tap'}; make:start ${JSON.stringify(w.calls.start)}, make:go ${JSON.stringify(w.calls.go)}; ` +
          `A's file edit now ${f?.edit?.id} (${f?.edit?.versions.length} version(s)); "a-edit" anywhere in A's file: ${JSON.stringify(f).includes('a-edit’s own edit') || JSON.stringify(f).includes('"a-edit"')}; the chat said "${w.last()?.text}"`
      )
    }
    console.log(out.join('\n'))
    expect(out.every((o) => o.includes('anywhere in A\'s file: true'))).toBe(true)
    for (const autoUnder of [25, null]) {
      const w = app({ cap: null, autoUnder }, { open: ownEdit('a-edit', 3) })
      w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
      await w.type('/make a 1 minute cinematic documentary about Lisbon')
      const quote = w.chat().find((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))
      if (autoUnder === null) expect(quote?.aside ?? '').toMatch(/It goes in a new chat, so your edit here stays as it is\.$/)
      const go = w.goButton()
      if (go) await w.makes.onAction(go)
      const a = w.files.get('A')
      expect(a?.edit?.id, `go-ahead ${autoUnder}`).toBe('a-edit')
      expect(a?.edit?.versions, `go-ahead ${autoUnder}`).toHaveLength(3)
      expect((a?.chat ?? []).at(-1)?.text, `go-ahead ${autoUnder}`).toBe('Your video about Lisbon goes in a new chat, “Lisbon”, so your edit here stays as it is.')
      expect(w.open()).toBe('Lisbon')
      expect(w.files.get('Lisbon')?.edit?.id).toBe('made-video-1')
      expect(w.files.get('Lisbon')?.chat?.[0]).toMatchObject({ role: 'user' })
      expect(w.last()?.text).toBe(READY)
    }
  })
})

describe('round 10: a new video for a chat with an edit, got ready from the tap on', () => {
  it('no new chat could be made: nothing is made or spent, the quote keeps its button, and pressing it again makes it there', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: ownEdit('a-edit', 3) })
    w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
    await w.type(`/${QUOTED}`)
    w.refuseNewChats(true)
    await w.makes.onAction(w.goButton() as Action)
    expect(w.calls.go).toEqual([])
    expect(w.open()).toBe('A')
    expect(w.last()?.text).toBe('I couldn’t make a new chat for it, so nothing was made or spent, and your edit here stays as it is. Press its button to try again.')
    const again = w.goButton()
    expect(again?.label).toMatch(/^Make it/)
    w.refuseNewChats(false)
    await w.makes.onAction(again as Action)
    expect(w.calls.go).toHaveLength(1)
    expect(w.open()).toBe('The 1950s oil boom')
    expect(w.files.get('A')?.edit?.id).toBe('a-edit')
    expect(w.files.get('The 1950s oil boom')?.edit?.id).toBe('made-video-1')
  })

  it('while its new chat is made, every other make is refused here, main is not asked, and the video is then made there', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: ownEdit('a-edit', 3) })
    w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
    await w.type(`/${QUOTED}`)
    const ready = w.hold('newChat')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    const starts = w.calls.start.length
    await w.type('/make a 2 minute cinematic documentary about Lisbon')
    const said = w.last()?.text
    ready.release()
    await tapped
    expect(said).toBe('I’m still making your video about the 1950s oil boom in “A”. Stop it, or wait until it’s done.')
    expect(w.calls.start.length).toBe(starts)
    expect(w.calls.busy).toEqual([])
    expect(w.calls.go).toHaveLength(1)
    expect(w.open()).toBe('The 1950s oil boom')
    expect(w.makes.running()).toBeNull()
  })
})
