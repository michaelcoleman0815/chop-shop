import { describe, expect, it, vi } from 'vitest'

/**
 * Round 10 (0d1077a): the fixes for the ninth review, tried adversarially.
 *
 * The real useMake (React's hooks as plain functions), the real draftFor, revise, changeFor and keepInProject, a fake
 * main that checks consent and runs one make at a time as index.ts does, and useCutalong and main played as they are
 * at 0d1077a:
 * - newChat: the working check; switchSeq, the switching flag and switchDone; createProject and saveProject; the flag
 *   cleared when still the latest; overtaken, it gives way (null); the chat left given its line; enter().
 * - ensureChat: the open chat's file, made now if it has none (createProject).
 * - keepInChat: the path, unless that chat is open; main's keepInFile (keepInProject in that file's turn; a new video
 *   for a chat with an edit, or no file, goes in a new chat named as createProject names it; the moved line).
 * - openProject: the chat already open takes over; the working check; the switch; the read; a second check; enter().
 * - goAhead: Settings' amount as it is when asked.
 *
 * Kept as a regression test from round 11 on, played as useCutalong and main are now:
 * - newChat counts as work while it is made, and every chat click waits for it ("One moment…"), the chat open's too
 *   (round 12), so it is always made whole and nothing is ever taken away.
 * - createProject names each chat after its own file ("…", "… 2"), and keepInFile keeps a change made for an edit no
 *   longer in its chat as a whole video of its own, in a new chat.
 * - chatEdit and putChatEdit: the chat's own edit and its clips, by id, while another of them is open, where a paid
 *   result made for one goes all the same; and a clip opened in the editor is one of the chat's clips.
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
import { questionsFor, quoteReplyParts } from '../../../shared/make/questions'
import { quoteReply, type Availability } from '../../../shared/make/quote'
import type { Make } from '../../../shared/make/schema'
import type { ChatMessage, Project } from '../../../shared/types'
import type { ParseCall } from '../../../main/make/claude'
import { changeFor } from '../../../main/make/remake'
import { draftFor, quoteDraft, revise, type DraftDeps } from '../../../main/make/run'
import { editIn, freshVideo, keepInProject, type Kept } from '../../../shared/make/kept'
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

function held(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((r) => (release = r))
  return { wait, release }
}
const pause = (ms = 25): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Settings = DraftDeps['settings']
type Kind = 'read' | 'make' | 'newChat'

function app(settings: Settings, opts: { open?: EditDoc | null } = {}) {
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
  /** A new video's chat being made: every chat click waits for it. */
  let settingUp = false
  let chat = new Map<string, Partial<Msg>>()
  let n = 0
  const notices: string[] = []
  const calls = { claude: 0, start: [] as string[], revise: [] as string[], go: [] as string[], shot: [] as string[], letGo: [] as string[], busy: [] as string[], created: [] as string[], keeps: [] as string[] }
  const holds: Record<Kind, ReturnType<typeof held> | null> = { read: null, make: null, newChat: null }
  const hooks: { start?: () => void } = {}
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
  fake.api.makeCancel = async () => true
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
      // main reads Settings as it writes the script (the window read them a moment before).
      hooks.start?.()
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
      calls.go.push(`${req.draft.brief.topic}, ${req.draft.brief.seconds} s${req.draft.into ? `, into ${req.draft.into.docId}` : ''}`)
      await waitFor(take('make'))
      return { ok: true, ...made(req.draft.id, req.draft.brief.topic), into: req.draft.into ?? null }
    } finally {
      free('make')
    }
  }
  fake.api.makeShot = async (req: { doc: EditDoc; consent?: unknown }) => {
    if (req.consent !== 'tap') return { ok: false, message: 'refused: no consent' }
    if (!claim('shot')) return { ok: false, message: BUSY }
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

  /** persist(): the chat open saved into its file, what has settled. */
  const save = (): void => {
    if (!open) return
    const f = files.get(open)
    if (!f) return
    const messages = [...chat.entries()].filter(([, m]) => !m.progress).map(([id, m]) => ({ ...m, id }) as ChatMessage)
    files.set(open, withDoc({ ...f, chat: messages }, docRef.current))
  }
  /** main's createProject: the first free path for the name, claimed in one step, and a name to match its file. */
  const createProject = (name: string): Project => {
    let path = name
    for (let i = 2; files.has(path); i++) path = `${name} ${i}`
    const p = file(path)
    files.set(path, { ...p, name: path })
    calls.created.push(path)
    return files.get(path) as Project
  }
  /** main's keepInFile (projects.ts), with the real keepInProject. */
  const keepInFile = (path: string | null, name: string, kept: Kept): { path: string; name: string } | null => {
    let moved = false
    if (path) {
      const f = files.get(path)
      if (f) {
        const next = keepInProject(structuredClone(f), kept, `k${++n}`)
        if (next) {
          files.set(path, next)
          calls.keeps.push(`${path}: kept`)
          return { path, name: f.name }
        }
        moved = true
      }
    }
    if (moved && !freshVideo(kept) && !kept.into) return null
    const madeChat = createProject(name)
    const next = keepInProject(madeChat, kept.into ? { ...kept, into: null } : kept, `k${++n}`)
    if (!next) return null
    files.set(madeChat.path, next)
    calls.keeps.push(`${madeChat.path} (new): kept`)
    const was = path ? files.get(path) : undefined
    if (was) files.set(path as string, { ...was, chat: [...(was.chat ?? []), { id: `moved-${n}`, role: 'assistant', text: `${kept.doc ? 'Your new video' : 'What came back'} is in a new chat, “${madeChat.name}”, so the edit here stays as it is.` }] })
    return { path: madeChat.path, name: madeChat.name }
  }
  const enter = (project: Project): void => {
    save()
    open = project.path
    docRef.current = project.edit ?? null
    key += 1
    chat = new Map(makes.restore(((project.chat ?? []) as Msg[]).map((m) => ({ ...m }))).map((m) => [m.id, m] as const))
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
    project: () => (open ? { path: open, name: files.get(open)?.name ?? open } : null),
    ensureChat: async (name) => {
      if (!open) {
        const p = createProject(name)
        open = p.path
      }
      return { path: open, name: files.get(open)?.name ?? open }
    },
    keepFor: async (where, name, kept) => keepInFile(where && open !== where.path ? where.path : null, name, kept),
    newChat: async (name, first, leaving) => {
      if (working > 0) return { refused: 'busy' }
      // Work while it is made, and every chat click waits for it: it is always made whole.
      working++
      settingUp = true
      switchSeq += 1
      switching = true
      let done = (): void => undefined
      switchDone = new Promise<void>((r) => (done = r))
      let project: Project | null = null
      try {
        await waitFor(take('newChat'))
        const madeChat = createProject(name.trim() || 'New video')
        project = { ...madeChat, chat: first.map((m, i) => ({ ...m, id: `f${++n}-${i}` }) as ChatMessage) }
        files.set(project.path, project)
      } finally {
        working--
        settingUp = false
        switching = false
        done()
      }
      if (!project) return { refused: 'failed' }
      const line = leaving(project.name)
      chat.set(`m${++n}`, { role: line.role, text: line.text })
      enter(project)
      return { path: project.path, name: project.name }
    },
    goAhead: async () => typeof settings.autoUnder === 'number' && settings.autoUnder > 0,
    chatEdit: (id) => {
      const f = open ? files.get(open) : undefined
      return f ? editIn(f, id) : null
    },
    putChatEdit: (next) => {
      const f = open ? files.get(open) : undefined
      if (open && f && editIn(f, next.id)) files.set(open, withDoc(f, next))
    },
    never: () => [],
    switching: () => switching,
    settled: () => switchDone,
    notify: (text) => notices.push(text)
  })
  const openProject = async (path: string): Promise<string> => {
    // useCutalong at round 12: a new video's chat being made, every chat click waits, the chat open's too.
    if (settingUp) return 'one moment'
    if (path === open) {
      switchSeq += 1
      switching = false
      return 'already open'
    }
    if (working > 0) return 'refused'
    const seq = ++switchSeq
    switching = true
    let done = (): void => undefined
    switchDone = new Promise<void>((r) => (done = r))
    const h = take('read')
    let project: Project | null = null
    try {
      await waitFor(h)
      const f = files.get(path)
      project = f ? structuredClone(f) : null
    } finally {
      if (switchSeq === seq) switching = false
      done()
    }
    if (switchSeq !== seq) return 'gave way'
    if (!project) return 'no file'
    if (working > 0) return 'stayed'
    enter(project)
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
  const goButton = (): Action | undefined => buttons().filter((a) => (a.payload ?? '').includes('"go"') || (a.payload ?? '').includes('"shot"')).pop()
  return {
    makes,
    calls,
    files,
    notices,
    hooks,
    type,
    buttons,
    goButton,
    openProject,
    hold: (k: Kind) => (holds[k] = held()),
    chat: () => [...chat.values()],
    last: () => [...chat.values()].pop(),
    open: () => open,
    docRef,
    /** useClipping.open: one of the chat's clips opened in the editor, the chat's own edit left in its file. */
    openClip: (doc: EditDoc) => {
      const f = files.get(open as string) as Project
      const clip = { id: 'c1', run: 1, source: '/long.mp4', startSec: 0, endSec: 30, title: 'A clip', hook: '', reason: '', score: 1, kept: true, doc }
      files.set(open as string, { ...f, clipping: { v: 1, runs: [], clips: [clip] } } as Project)
      docRef.current = doc
    }
  }
}

describe('a new video for a chat with an edit, and its new chat', () => {
  // Round 11's decision: setting up the new chat is work, so another chat asked for meanwhile is refused, and the
  // video is made in its new chat; nothing is left behind but that chat. (The reviewer expected B to open and
  // nothing to be made.) Round 12: the click waits with "One moment…", and nothing is ever taken away.
  it('another chat opened while the new chat is being made: refused, and the video is made in its new chat; nothing else is left behind', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: ownEdit('a-edit', 3) })
    w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
    await w.type(`/${QUOTED}`)
    const aside = w.chat().find((m) => (m.actions ?? []).some((a) => (a.payload ?? '').includes('"go"')))?.aside
    const ready = w.hold('newChat')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    const read = w.hold('read')
    const toB = w.openProject('B')
    ready.release()
    await tapped
    const said = w.last()?.text
    const button = w.goButton()?.label
    read.release()
    const b = await toB
    const left = [...w.files.keys()].filter((k) => k !== 'A' && k !== 'B')
    const orphan = left.map((k) => `${k}: ${JSON.stringify((w.files.get(k)?.chat ?? []).map((m) => m.text.slice(0, 50)))}, edit ${w.files.get(k)?.edit?.id ?? 'none'}`)
    console.log(
      `quote aside: "${aside}"; tapped Make it, then B clicked while its new chat was made: make:go ${w.calls.go.length}; A said "${said}", its button "${button}"; B ${b}; ` +
        `chats made: ${JSON.stringify(w.calls.created)}; left over: ${JSON.stringify(orphan)}`
    )
    expect(b).toBe('one moment')
    expect(w.calls.go).toHaveLength(1)
    expect(left).toEqual(['The 1950s oil boom'])
    expect(w.files.get('The 1950s oil boom')?.edit?.id).toBe('made-video-1')
    expect(w.files.get('A')?.edit?.id).toBe('a-edit')
  })

  // Round 12's decision: the chat open asked for again waits too ("One moment…"), so the new chat is made whole and
  // the video is made there; nothing is taken away. (Round 11 let it give way and took the new chat away.)
  it('the chat itself asked for again while its new chat is made: it waits, and the video is made in its new chat', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: ownEdit('a-edit', 3) })
    w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
    await w.type(`/${QUOTED}`)
    const ready = w.hold('newChat')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    const stay = await w.openProject('A')
    ready.release()
    await tapped
    const left = [...w.files.keys()].filter((k) => k !== 'A' && k !== 'B')
    console.log(`A asked for again: ${stay}; make:go ${w.calls.go.length}; open ${w.open()}; said "${w.last()?.text}"; chats made ${JSON.stringify(w.calls.created)}; left over ${JSON.stringify(left)}`)
    expect(stay).toBe('one moment')
    expect(w.calls.go).toHaveLength(1)
    expect(left).toEqual(['The 1950s oil boom'])
    expect(w.open()).toBe('The 1950s oil boom')
    expect(w.files.get('The 1950s oil boom')?.edit?.id).toBe('made-video-1')
    expect(w.files.get('A')?.chat?.at(-1)?.text).toBe('Your video about the 1950s oil boom goes in a new chat, “The 1950s oil boom”, so your edit here stays as it is.')
  })

  it('Settings turned on between the window asking and main writing the script: the video goes in a new chat', async () => {
    const settings: Settings = { cap: null, autoUnder: null }
    const w = app(settings, { open: ownEdit('a-edit', 3) })
    w.files.set('A', withDoc(w.files.get('A') as Project, ownEdit('a-edit', 3)))
    w.hooks.start = () => {
      settings.autoUnder = 25
    }
    await w.type(`/${QUOTED}`)
    const a = w.files.get('A')
    const others = [...w.files.keys()].filter((k) => k !== 'A' && k !== 'B')
    console.log(
      `make:start ${JSON.stringify(w.calls.start)}; open ${w.open()}; A's edit ${w.docRef.current?.id} (file: ${a?.edit?.id}, ${a?.edit?.versions.length} versions); ` +
        `A says "${w.last()?.text}"; new chats ${JSON.stringify(others.map((k) => `${k}: edit ${w.files.get(k)?.edit?.id}`))}`
    )
    expect(a?.edit?.id).toBe('a-edit')
    expect(others.some((k) => w.files.get(k)?.edit?.id === 'made-video-1')).toBe(true)
  })
})

describe('the gap left on purpose: a paid change of a made video, back after its edit was replaced', () => {
  it('a clip of the chat opened in the editor while the change is made (useClipping.open swaps the edit open)', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: madeOf('doc-a') })
    w.files.set('A', withDoc(w.files.get('A') as Project, madeOf('doc-a')))
    await w.type('make it 3 minutes')
    const quote = w.goButton()?.label
    const make = w.hold('make')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    // useClipping.open(id): docRef becomes the clip's edit, in the same chat. Round 11 refuses that while a make runs
    // (useCutalong's busy for useClipping); here it is opened all the same, for the backstop.
    w.openClip(ownEdit('clip-1'))
    make.release()
    await tapped
    const said = w.last()?.text
    const fileEdit = w.files.get('A')?.edit
    console.log(`quote "${quote}" tapped: make:go ${JSON.stringify(w.calls.go)}; a clip opened meanwhile; the chat says "${said}"; A's own edit ${fileEdit?.id} has ${fileEdit?.versions.length} version(s)`)
    expect(said ?? '').not.toMatch(/Another edit is open now/)
    // Round 11: into X all the same, as its next version, and said where.
    expect(fileEdit?.id).toBe('doc-a')
    expect(fileEdit?.versions).toHaveLength(2)
    expect(said ?? '').toMatch(/^v2 is ready\..* It went into “doc-a”, the edit it was made for, not the one open now\. Go back to the chat to see it\.$/)
    expect(w.docRef.current?.id).toBe('clip-1')
  })

  it('the same for a shot made again', async () => {
    const w = app({ cap: null, autoUnder: null }, { open: madeOf('doc-a') })
    w.files.set('A', withDoc(w.files.get('A') as Project, madeOf('doc-a')))
    await w.type('make shot 3 a close-up of a wrench')
    const quote = w.goButton()?.label
    const make = w.hold('make')
    const tapped = w.makes.onAction(w.goButton() as Action)
    await pause()
    w.openClip(ownEdit('clip-1'))
    make.release()
    await tapped
    const said = w.last()?.text
    const fileEdit = w.files.get('A')?.edit
    console.log(`shot quote "${quote}" tapped: make:shot ${JSON.stringify(w.calls.shot)}; a clip opened meanwhile; the chat says "${said}"; A's own edit ${fileEdit?.id}: ${fileEdit?.assets.length} asset(s), spent ${fileEdit?.make?.spent}`)
    expect(said ?? '').not.toMatch(/Another edit is open now/)
    // Round 11: into X all the same, and said where.
    expect(fileEdit?.id).toBe('doc-a')
    expect(fileEdit?.assets.some((a) => a.path === '/made/shot-3-again.png')).toBe(true)
    expect(fileEdit?.make?.spent).toBe(9)
    expect(said ?? '').toMatch(/It went into “doc-a”, the edit it was made for, not the one open now\./)
  })
})

describe('a reply to a waiting quote, read in parts', () => {
  it('negations, a no or a hold with a change, and replies that are only a no or a hold', async () => {
    type Got = { text: string; labels: string[]; kept: boolean }
    const rows: [string, (g: Got) => boolean, string][] = [
      ['not 3 minutes', (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ['no, not 3 minutes', (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ["don't make it 3 minutes", (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ['no 3 minutes is too long', (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ['do not make it 3 minutes', (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ["don't make it longer than 3 minutes", (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ["I don't want it 3 minutes", (g) => !/Change it to 3:00 long\?/.test(g.text), 'never read back as 3:00'],
      ["don't use a British voice", (g) => !(g.labels.includes('Yes') && /George|British/.test(g.text)), 'never read back as a British voice'],
      ['no British voice', (g) => !(g.labels.includes('Yes') && /George|British/.test(g.text)), 'never read back as a British voice'],
      ['no thanks, but make it 5 minutes', (g) => /Change it to 5:00 long\?/.test(g.text), 'read back as 5:00'],
      ['cancel, make it 2 minutes', (g) => /Change it to 2:00 long\?/.test(g.text), 'read back as 2:00'],
      ['wait — make it 3 minutes', (g) => /Change it to 3:00 long\?/.test(g.text), 'read back as 3:00'],
      ['not now, but maybe a 5 minute version', (g) => /Change it to 5:00 long\?/.test(g.text), 'read back as 5:00'],
      ['3 minutes, later', (g) => /Change it to 3:00 long\?/.test(g.text), 'read back as 3:00'],
      ['no, later', (g) => g.kept && /ready/.test(g.text), 'kept'],
      ['no rush', (g) => g.kept, 'kept'],
      ['no music', (g) => g.kept, 'kept, not set aside'],
      ['not that long', (g) => g.kept, 'kept, not set aside'],
      ['nope, never mind', (g) => !g.kept, 'set aside'],
      ['no!', (g) => !g.kept, 'set aside']
    ]
    const out: string[] = []
    const wrong: string[] = []
    for (const [reply, ok, want] of rows) {
      const w = app({ cap: null, autoUnder: null })
      await w.type(QUOTED)
      await w.type(reply)
      const last = w.last()
      const g: Got = { text: last?.text ?? '', labels: (last?.actions ?? []).map((a) => a.label), kept: !!w.goButton() }
      const parts = quoteReplyParts(reply)
      out.push(`${JSON.stringify(reply)} (parts: later ${parts.later}, no ${parts.no}, rest "${parts.rest}") -> "${g.text.slice(0, 70)}" ${JSON.stringify(g.labels)}; quote kept ${g.kept}; make:revise ${w.calls.revise.length}`)
      if (!ok(g)) wrong.push(`${reply}: wanted ${want}`)
    }
    console.log(out.join('\n'))
    expect(wrong).toEqual([])
  })
})
