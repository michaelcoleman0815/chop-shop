import { Keyboard } from '@capacitor/keyboard'
import type { EnginePlugin, PickedFile } from 'cutalong-engine'
import { platform } from '../../../src/main/platform'
import { Engine } from './engine'
import { anthropicStandIn, type StandIn } from './standin'

/**
 * The app's own flow, run by the app itself on an emulator or a simulator
 * in CI (mobile/ci). Built in only when CUTALONG_DRIVE=1 at build time
 * (vite.config.ts), and it runs only when the app finds drive.json in its
 * documents, which only the runner can put there (adb run-as on a debuggable
 * build, or the simulator's container).
 *
 * The flow: Start without a key is the steps to get one, so the drive pastes
 * a key Anthropic turns down and then one it takes; then it picks footage,
 * sorts and transcribes it, makes v1, applies a command, opens the editor
 * and exports, watches the crew at the export from the thread, then opens
 * the Crew page, Brand and Settings' Licences. Then the runner turns the
 * system dark, adds "tour": "dark" to the plan and starts the app again,
 * and the tour, with the key saved and Anthropic down, asks for a change in
 * the thread (the gate stays open for a key accepted before), then opens the
 * same project from Start's card: the editor, the crew at another export in
 * the thread, the thread with it in, the Crew page and Brand.
 *
 * On Start, in the thread and in the editor's note box the drive types with
 * the keyboard up, as the box is at rest and grown past six lines, and in the
 * editor it goes Back with the keyboard still up.
 *
 * Anthropic is stood in for while a drive runs (standin.ts): the shared
 * work's requests to it go through the page's fetch, which withStandIn
 * answers, and nothing leaves the emulator or the simulator.
 *
 * drive.json: { "files": ["Talking.mp4"], "request": "…", "command": "/shorts", "tour"?: "dark" }.
 * The files are already in documents/Imported, where the engine's importer
 * copies what a person picks, and + hands them to the app as the picker
 * would: everything after the picker's own screens is the app's.
 *
 * At each step drive-progress.txt says "<n> <step>", and the app waits (up
 * to 30 s) for drive-ack.txt to say <n>: the runner takes its screenshot in
 * between. At the end, or when a step fails, drive-report.json (the tour:
 * tour-report.json) says what happened.
 */

interface Plan {
  files: string[]
  request: string
  command: string
  /** Seconds a step may take: transcribing on an emulator is slow. */
  stepSec?: number
  /** Set by the runner for the second pass, after the system has turned dark. */
  tour?: 'dark'
}

interface Step {
  n: number
  name: string
  atSec: number
  acknowledged: boolean
  /** What the screen said when its screenshot was taken: the column, then a toast. */
  screen: string
}

/** The files the plan names, as the picker hands them over; null until a plan is read. */
let planned: PickedFile[] | null = null

/** The plan in the app's documents, read once: null when there is none, and the app runs as a person uses it. */
let planRead: Promise<Plan | null> | null = null
function readPlan(): Promise<Plan | null> {
  planRead ??= (async () => {
    try {
      const info = await Engine.info()
      return JSON.parse(await platform().files.readText(`${info.documents}/drive.json`)) as Plan
    } catch {
      return null
    }
  })()
  return planRead
}

/** Anthropic as the drive stands in for it, once a plan is read: down for the dark tour. */
let standIn: StandIn | null = null

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The page's fetch, with Anthropic answered by the stand-in while a drive runs. */
export function withStandIn(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (hostOf(url) !== 'api.anthropic.com') return base(input, init)
    const plan = await readPlan()
    if (!plan) return base(input, init)
    standIn ??= anthropicStandIn({ down: plan.tour === 'dark' })
    return standIn.answer(url, init)
  }
}

/** The engine, with + handing over the plan's files while a drive runs. */
export function withPlannedPicks(engine: EnginePlugin): EnginePlugin {
  return {
    run: (options) => engine.run(options),
    cancel: (options) => engine.cancel(options),
    pick: async (options) => (planned ? { files: planned } : engine.pick(options)),
    saveToPhotos: (options) => engine.saveToPhotos(options),
    info: () => engine.info(),
    addListener: (name, listener) => engine.addListener(name, listener)
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const text = (node: Node | null | undefined): string => (node?.textContent ?? '').replace(/\s+/g, ' ').trim()
const shown = (selector: string): string =>
  ((document.querySelector(selector) as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim()

type Maybe<T> = T | null | undefined | false

async function until<T>(what: string, check: () => Maybe<T> | Promise<Maybe<T>>, seconds: number): Promise<T> {
  const end = Date.now() + seconds * 1000
  for (;;) {
    const got = await check()
    if (got) return got
    if (Date.now() > end) throw new Error(`Waited ${seconds} s for ${what}.`)
    await sleep(250)
  }
}

/** The last enabled button that says exactly this. */
function button(label: string, within: ParentNode = document): HTMLButtonElement | null {
  const all = [...within.querySelectorAll<HTMLButtonElement>('button')]
  return all.filter((b) => !b.disabled && (text(b) === label || b.getAttribute('aria-label') === label)).pop() ?? null
}

/** Types into a field React controls: its value, then the input event React listens for. */
function type(field: HTMLTextAreaElement | HTMLInputElement, value: string): void {
  const kind = field instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement
  Object.getOwnPropertyDescriptor(kind.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

const busy = (): boolean => !!document.querySelector('.cl-progress, .cl-composer.busy')

/** Words that take seven lines, one more than the box grows to before it scrolls. */
const SEVEN_LINES = [
  'Open on the laugh',
  'then the line about the bridge',
  'keep the second take',
  'cut the long pause',
  'bigger captions',
  'end on the wave',
  'and a seventh line'
].join('\n')

/** How wide a field's hint is, in its own font, so it can be said whether the hint fits on its one line. */
function hintWidth(field: HTMLTextAreaElement): number {
  const style = getComputedStyle(field)
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return 0
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return ctx.measureText(field.placeholder).width
}

const replies = (): string[] =>
  [...document.querySelectorAll('.cl-msg-assistant')].map((m) => (m as HTMLElement).innerText.replace(/\n+/g, ' | '))

/**
 * Animations running on what moves while work goes on: the living mark and the crew at work.
 * Asked of those elements and what is in them, never of the whole document: on the iOS
 * simulator WebKit's web process crashed sorting the whole document's animations
 * (Document::getAnimations) just after the screen changed from the editor to the chat.
 */
function moving(): { living: number; crew: number; properties: string[] } {
  const on = (selector: string): Animation[] =>
    [...document.querySelectorAll(selector)].flatMap((el) => el.getAnimations({ subtree: true }))
  const living = on('.cl-living')
  const crew = on('.cl-crew-row')
  const properties = new Set<string>()
  for (const a of [...living, ...crew]) {
    for (const k of (a.effect as KeyframeEffect).getKeyframes()) {
      for (const p of Object.keys(k))
        if (!['offset', 'easing', 'composite', 'computedOffset'].includes(p)) properties.add(p)
    }
  }
  return { living: living.length, crew: crew.length, properties: [...properties].sort() }
}

/** How the page looks and moves here: the scheme, reduced motion and what the engine has of view transitions. */
function looks(): Record<string, unknown> {
  return {
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    travel: getComputedStyle(document.documentElement).getPropertyValue('--cl-travel').trim(),
    viewTransitions: typeof document.startViewTransition === 'function',
    viewTransitionTypes: typeof ViewTransition !== 'undefined' && 'types' in ViewTransition.prototype,
    userAgent: navigator.userAgent
  }
}

export async function drive(): Promise<void> {
  const info = await Engine.info()
  const files = platform().files
  const at = (name: string): string => `${info.documents}/${name}`
  const read = await readPlan()
  if (!read) return // No plan: the app as a person uses it.
  const plan: Plan = read
  const tour = plan.tour === 'dark'
  // The runner clears the progress before each pass, so progress from before means the page started
  // again partway through, as it does when its web view is restarted: the pass ends there, saying so.
  const earlier = (await files.readText(at('drive-progress.txt')).catch(() => '')).trim()

  const t0 = Date.now()
  const steps: Step[] = []
  const errors: string[] = []
  const progress: { atSec: number; stage: string }[] = []
  const transitions: { atSec: number; form: string; threw?: string; finished?: string }[] = []
  const report: Record<string, unknown> = {
    ok: false,
    platform: info.platform,
    ffmpeg: info.ffmpegVersion,
    whisper: info.whisperVersion,
    encoders: info.encoders,
    plan,
    viewport: { width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio },
    steps,
    progress,
    transitions,
    errors
  }
  // Long enough for an emulator with no GPU to transcribe and export; a step that takes longer has stopped.
  const stepSec = plan.stepSec ?? 1200
  const seconds = (): number => Math.round((Date.now() - t0) / 100) / 10
  const keep = (line: string): void => void (errors.length < 60 && errors.push(`${seconds()} s: ${line}`))
  const said = (a: unknown): string => {
    if (a instanceof Error) return a.message
    if (typeof a !== 'object' || a === null) return String(a)
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  const error = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    keep(args.map(said).join(' ').slice(0, 400))
    error(...args)
  }
  addEventListener('error', (e) => keep(`error: ${e.message}`))
  addEventListener('unhandledrejection', (e) => keep(`unhandled: ${String((e as PromiseRejectionEvent).reason)}`))

  // Each view transition the app starts, how it was asked for, and how it ended: a web view
  // without one, or without its types, must still change the screen.
  if (typeof document.startViewTransition === 'function') {
    const start = document.startViewTransition.bind(document) as (arg?: unknown) => ViewTransition
    ;(document as { startViewTransition: unknown }).startViewTransition = (arg?: unknown) => {
      const rec: (typeof transitions)[number] = {
        atSec: seconds(),
        form:
          typeof arg === 'function'
            ? 'callback'
            : `options ${JSON.stringify((arg as { types?: string[] })?.types ?? [])}`
      }
      if (transitions.length < 40) transitions.push(rec)
      try {
        const t = start(arg)
        t.finished.then(
          () => (rec.finished = 'finished'),
          (e: unknown) => (rec.finished = said(e))
        )
        return t
      } catch (err) {
        rec.threw = said(err)
        throw err
      }
    }
  }

  // Each step, said and screenshotted once the screen has settled.
  const step = async (name: string): Promise<void> => {
    await sleep(1200)
    // The drive's clicks are not a person's taps, so a button or a link the app moves focus to shows
    // the keyboard's ring, which a tap never leaves; a field keeps its focus, as it would.
    const focused = document.activeElement
    if ((focused instanceof HTMLButtonElement || focused instanceof HTMLAnchorElement) && focused.matches(':focus-visible'))
      focused.blur()
    const screen = [shown('.cl-main'), shown('.cl-toast')].filter(Boolean).join(' || ').slice(0, 700)
    const s: Step = { n: steps.length + 1, name, atSec: seconds(), acknowledged: false, screen }
    steps.push(s)
    console.log(`[drive] ${s.n} ${name} at ${s.atSec} s, ${new Date().toISOString()}`)
    await files.writeText(at('drive-progress.txt'), `${s.n} ${name}\n`)
    for (const end = Date.now() + 30_000; Date.now() < end; await sleep(300)) {
      const ack = await files.readText(at('drive-ack.txt')).catch(() => '')
      if (ack.trim() === String(s.n)) {
        s.acknowledged = true
        return
      }
    }
  }

  // What the work in hand says, as it says it: the crew's lines, or the stage when no one has it.
  const stageNow = (): string => shown('.cl-progress')
  const record = (): void => {
    const stage = stageNow()
    if (stage && stage !== progress[progress.length - 1]?.stage) progress.push({ atSec: seconds(), stage })
  }

  // Until the work in hand is done: no progress row and the composer free, for a second.
  // Work that is over before it shows a row (a command can be) is waited for only briefly.
  const settle = async (what: string): Promise<void> => {
    await until(`${what} to start`, () => busy(), 5).catch(() => undefined)
    let quiet = 0
    await until(
      `${what} to finish`,
      () => {
        record()
        quiet = busy() ? 0 : quiet + 1
        return quiet >= 4
      },
      stepSec
    )
  }

  // The keyboard as the phone says it: its height while it is up, 0 when it is down.
  let keyboard = 0
  void Keyboard.addListener('keyboardDidShow', (info) => (keyboard = info.keyboardHeight)).catch(() => undefined)
  void Keyboard.addListener('keyboardDidHide', () => (keyboard = 0)).catch(() => undefined)

  /** Where a text box and its buttons are, against the room above the keyboard. */
  const measure = (field: HTMLTextAreaElement): Record<string, unknown> => {
    const box = field.closest<HTMLElement>('.cl-composer, .cl-note-input') ?? field
    const r = box.getBoundingClientRect()
    const buttons = [...box.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
    const room = visualViewport ? visualViewport.offsetTop + visualViewport.height : innerHeight
    const lowest = Math.max(r.bottom, ...buttons.map((b) => b.bottom))
    return {
      keyboard,
      room: Math.round(room),
      boxHeight: Math.round(r.height),
      boxBottom: Math.round(r.bottom),
      fieldHeight: field.clientHeight,
      scrolls: field.scrollHeight > field.clientHeight + 1,
      hintFits: !field.value && hintWidth(field) <= field.clientWidth,
      above: lowest <= room + 1 && r.top >= 0
    }
  }

  /**
   * Types into a text box with the keyboard up: the box at rest, one thin line, then with seven
   * lines of words, which it grows to six of and scrolls. A screenshot of each. Leaves the box
   * holding the words, focused, with the keyboard up.
   */
  const typeInto = async (
    selector: string,
    name: string
  ): Promise<{ field: HTMLTextAreaElement; seen: Record<string, unknown> }> => {
    const field = await until(name, () => document.querySelector<HTMLTextAreaElement>(selector), 20)
    field.scrollIntoView({ block: 'nearest' })
    field.focus()
    // An iPhone raises the keyboard for the page's focus; Android, for a tap or when asked.
    await Keyboard.show().catch(() => undefined)
    await until(`the keyboard for ${name}`, () => keyboard > 0, 10).catch(() =>
      keep(`the keyboard did not come up for ${name}`)
    )
    await sleep(800)
    const empty = measure(field)
    await step(`${name}-typing`)
    type(field, SEVEN_LINES)
    await sleep(600)
    field.scrollTop = field.scrollHeight
    const grown = measure(field)
    await step(`${name}-typing-grown`)
    return { field, seen: { empty, grown } }
  }

  /** The words gone again and the keyboard down, as before the box was tried. */
  const putAway = async (field: HTMLTextAreaElement): Promise<void> => {
    type(field, '')
    field.blur()
    await Keyboard.hide().catch(() => undefined)
    await until('the keyboard to go down', () => keyboard === 0, 10).catch(() => undefined)
    await sleep(500)
  }

  const send = async (words: string): Promise<void> => {
    type(await until('the composer', () => document.querySelector<HTMLTextAreaElement>('#cl-ask'), 30), words)
    await sleep(300)
    ;(await until('Send', () => button('Send'), 10)).click()
  }

  // A key typed into the setup's field, and its check started.
  const paste = async (key: string): Promise<void> => {
    type(await until('the key field', () => document.querySelector<HTMLInputElement>('#cl-key'), 10), key)
    await sleep(300)
    ;(await until('Check and save', () => button('Check and save'), 10)).click()
  }

  const versions = async (): Promise<string[]> => {
    try {
      const index = JSON.parse(await files.readText(`${platform().paths.userData()}/projects.json`)) as {
        path: string
      }[]
      const project = JSON.parse(await files.readText(index[0].path)) as {
        edit?: { versions?: { n: number; summary: string }[] }
      }
      return (project.edit?.versions ?? []).map((v) => `v${v.n}: ${v.summary}`)
    } catch (err) {
      return [`could not read the project: ${err instanceof Error ? err.message : String(err)}`]
    }
  }

  // A place from the menu: the phone's rail opens over the screen.
  const go = async (place: string, ready: string): Promise<HTMLElement> => {
    ;(await until('the menu', () => button('Menu'), 10)).click()
    const item = (): HTMLButtonElement | undefined =>
      [...document.querySelectorAll<HTMLButtonElement>('.cl-rail.open button')].find((b) => text(b) === place)
    ;(await until(`${place} in the menu`, item, 10)).click()
    return until(place, () => document.querySelector<HTMLElement>(ready), 30)
  }

  // The editor with its preview ready to play, as a person sees it before they export.
  const editor = async (): Promise<void> => {
    await until('the editor', () => document.querySelector('.cl-editor'), 30)
    const preview = (): HTMLVideoElement | null => document.querySelector('.cl-editor .cl-frame video')
    report.previewReady = await until('the preview', () => (preview()?.readyState ?? 0) >= 2, 60).catch(() => false)
    if (!report.previewReady) {
      const v = preview()
      keep(
        v
          ? `the preview had no picture in 60 s: readyState ${v.readyState}, networkState ${v.networkState}, error ${v.error?.code ?? 'none'}, ${v.currentSrc ? 'with' : 'without'} a source`
          : 'the editor had no preview'
      )
      // Every picture in the frame as it stands, for what kept the first one dark.
      report.previewDecks = [...document.querySelectorAll<HTMLVideoElement>('.cl-editor .cl-frame video')].map((e) => ({
        readyState: e.readyState,
        networkState: e.networkState,
        currentTime: e.currentTime,
        paused: e.paused,
        seeking: e.seeking,
        source: e.currentSrc ? e.currentSrc.split('/').pop() : null
      }))
    }
  }

  // An export's toast stays until it is closed: the screens after it are shown without it.
  const closeToast = (): void => {
    const toast = document.querySelector('.cl-toast')
    if (toast) button('Close', toast)?.click()
  }

  // From the editor, export, then watch the crew at it from the thread, and wait for the file.
  const exportFromEditor = async (): Promise<string> => {
    ;(await until('Export', () => button('Export'), 10)).click()
    await until('the export to start', () => /Exporting/.test(shown('.cl-toast')), 60).catch(() =>
      keep('the export showed no progress')
    )
    await step('exporting')
    // Back to the chat, where the export's reply shows the crew at work.
    const back = await until('Back', () => button('Back'), 10)
    console.log(`[drive] back to the chat at ${seconds()} s, ${new Date().toISOString()}`)
    back.click()
    await until('the crew at the export', () => document.querySelector('.cl-progress'), 60)
    await sleep(2500)
    record()
    report.crewAtWork = {
      rows: [...document.querySelectorAll('.cl-crew-row')].map((r) => text(r)),
      moving: moving()
    }
    await step('thread-exporting')
    const exporting = Date.now()
    const toast = await until(
      'the export',
      () => {
        record()
        const now = shown('.cl-toast')
        return /Exported|couldn.t export/i.test(now) && now
      },
      stepSec
    )
    report.secondsToExport = Math.round((Date.now() - exporting) / 100) / 10
    if (!/Exported/.test(toast)) throw new Error(toast)
    return toast
  }

  try {
    planned = []
    for (const name of plan.files) {
      const path = at(`Imported/${name}`)
      const facts = await files.stat(path)
      if (!facts) throw new Error(`${name} is not in Imported.`)
      planned.push({ path, name, bytes: facts.size })
    }

    // Start, or without a key the steps to get one there.
    await until('the app', () => document.querySelector('#cl-ask, .cl-setup'), 60)
    report.looks = looks()
    if (earlier && !/ done$/.test(earlier)) {
      report.restartedAfter = earlier
      throw new Error(`The app's page started again after step "${earlier}": its web view was restarted.`)
    }
    if (tour) {
      await darkTour()
    } else {
      await flow()
    }
    report.ok = true
  } catch (err) {
    report.failed = err instanceof Error ? err.message : String(err)
    report.replies = replies()
    console.log(`[drive] failed: ${String(report.failed)}`)
    await step('failed').catch(() => undefined)
  } finally {
    planned = null
    report.anthropic = standIn?.requests ?? []
    report.seconds = seconds()
    await files.writeText(at(tour ? 'tour-report.json' : 'drive-report.json'), JSON.stringify(report, null, 1))
    await files.writeText(at('drive-progress.txt'), `${steps.length + 1} done\n`)
    console.log(`[drive] done: ${report.ok ? 'ok' : `failed (${String(report.failed)})`}`)
  }

  // Without a key, Start is the steps to get one and the cost: a key Anthropic turns down marks the
  // step that fixes it, and one it takes opens Start.
  async function keySetup(): Promise<void> {
    const setup = await until('the key steps on Start', () => document.querySelector<HTMLElement>('.cl-setup'), 30)
    report.keySetup = {
      steps: [...setup.querySelectorAll('.cl-steps > li h3')].map((h) => text(h)),
      pages: [...setup.querySelectorAll<HTMLAnchorElement>('.cl-steps a')].map((a) => a.href),
      cost: shown('.cl-setup-cost')
    }
    await step('key')
    await paste('sk-ant-drive-standin-refused')
    report.keyRefused = await until(
      'Anthropic turning the key down',
      () =>
        /did not accept/.test(shown('.cl-keycheck')) && {
          said: shown('.cl-keycheck'),
          marked: text(document.querySelector('.cl-steps > li.now h3')),
          kept: shown('.cl-key-kept')
        },
      60
    )
    await step('key-refused')
    await paste('sk-ant-drive-standin')
    await until('Start, once Anthropic takes the key', () => document.querySelector('#cl-ask'), 60)
    report.keyAccepted = shown('.cl-toast')
  }

  async function flow(): Promise<void> {
    await keySetup()
    await step('start')
    const start = await typeInto('#cl-ask', 'start')
    await putAway(start.field)
    report.typingStart = start.seen
    ;(await until('+', () => button('Add footage, audio or images'), 10)).click()
    await until('the picked files', () => document.querySelectorAll('.cl-attachment').length === planned?.length, 30)
    type(document.querySelector<HTMLTextAreaElement>('#cl-ask')!, plan.request)
    // The posters, made by ffmpeg from each file.
    await until('the posters', () => document.querySelectorAll('.cl-attachment .cl-poster.ready').length > 0, 60).catch(
      () => keep('no poster showed in the composer')
    )
    await step('composer')
    ;(await until('Send', () => button('Send'), 10)).click()
    const sent = Date.now()
    // Transcribing, with the crew at it, on screen while it runs.
    let firstCut = false
    const working = until('transcribing', () => firstCut || /transcrib/i.test(stageNow()), stepSec).then(async () => {
      if (firstCut) return keep('transcribing never showed')
      report.crewTranscribing = {
        rows: [...document.querySelectorAll('.cl-crew-row')].map((r) => text(r)),
        moving: moving()
      }
      await step('transcribing')
    })
    await settle('the first cut')
    firstCut = true
    await working
    report.secondsToV1 = Math.round((Date.now() - sent) / 100) / 10
    report.repliesAfterFootage = replies()
    const before = await versions()
    report.versionsAfterFootage = before
    await until('Open the editor', () => button('Open the editor'), 30)
    await step('v1')
    const thread = await typeInto('#cl-ask', 'thread')
    await putAway(thread.field)
    report.typingThread = thread.seen

    await send(plan.command)
    await settle(plan.command)
    report.replyToCommand = replies().slice(-1)[0]
    // Saved in turn, so the newest version may take a moment to be on disk.
    report.versionsAfterCommand = await until(
      `a version from ${plan.command}`,
      async () => {
        const now = await versions()
        return now.length > before.length && now
      },
      30
    )
    await step('command')
    ;(await until('Open the editor', () => button('Open the editor'), 30)).click()
    await editor()
    await step('editor')

    // The note box, then Back while it holds words and the keyboard is up: the chat, with the keyboard down.
    const note = await typeInto('#cl-note', 'note')
    ;(await until('Back', () => button('Back'), 10)).click()
    await until('the chat, back from the editor', () => document.querySelector('.cl-thread-scroll'), 20)
    await until('the keyboard to go down', () => keyboard === 0, 10).catch(() => undefined)
    await sleep(800)
    const focused = document.activeElement
    report.typingNote = {
      ...note.seen,
      back: {
        thread: !!document.querySelector('.cl-thread-scroll'),
        keyboard,
        focus: focused ? `${focused.tagName.toLowerCase()}${focused.id ? `#${focused.id}` : ''}` : null
      }
    }
    await step('back-from-note')
    ;(await until('Open the editor', () => button('Open the editor'), 30)).click()
    await editor()

    report.toast = await exportFromEditor()
    // The export in the chat, in view: the reply about the upload under it scrolls the chat past it.
    report.exportPlays = await until(
      'the export in the chat',
      () => ((document.querySelector('.cl-export video') as HTMLVideoElement | null)?.readyState ?? 0) >= 1,
      30
    ).catch(() => false)
    await sleep(1500)
    document.querySelector('.cl-export')?.scrollIntoView({ block: 'start' })
    report.exportReply = replies().filter((r) => /exported/i.test(r))
    await step('export-in-chat')
    report.exports = (await files.list(platform().paths.exports())).filter((e) => e.file).map((e) => e.name)

    closeToast()
    await go('Crew', '.cl-callsheet')
    await step('crew')
    await go('Brand', '.cl-brand-hero')
    await step('brand')

    // Settings' Licences: what the app is built with, with FFmpeg's licence open.
    await go('Settings', '#set-licences')
    const licences = await until('the licences', () => document.querySelector('#set-licences')?.closest('section'), 30)
    ;(await until('FFmpeg in the licences', () => button('Read the licence of FFmpeg'), 30)).click()
    await until(
      "FFmpeg's licence",
      () => /LESSER GENERAL PUBLIC LICENSE/i.test(text(licences.querySelector('.cl-licence'))),
      30
    )
    licences.scrollIntoView({ block: 'start' })
    report.licences = {
      listed: [...licences.querySelectorAll('.cl-list > li .cl-list-main')].map((e) => text(e.firstChild)),
      sourceOffer: text(licences.querySelector('.cl-aside'))
    }
    await step('licences')
  }

  // The same project after dark: what a person sees at night. The app opens where it was left, on
  // the project's thread; Start is in the menu, and the project's card there opens the editor.
  async function darkTour(): Promise<void> {
    // A web view that does not pass the system's dark on is a finding; the pages are still shown dark.
    const followsSystem = matchMedia('(prefers-color-scheme: dark)').matches
    report.followsSystemDark = followsSystem
    if (!followsSystem) document.documentElement.dataset.theme = 'dark'
    // Start shows first, then the chat the app was left in opens over it.
    await until(
      'the chat the app was left in',
      () => document.querySelector('.cl-thread-scroll, .cl-editor'),
      20
    ).catch(() => keep('the app did not open the chat it was left in'))
    // Anthropic is down for the tour (standin.ts): the key was accepted before, so the gate stays
    // open, and a change asked for meanwhile is answered with what happened.
    if (document.querySelector('.cl-editor')) (await until('Back', () => button('Back'), 10)).click()
    await until('the chat', () => document.querySelector('.cl-thread-scroll'), 20)
    const before = replies().length
    await send('Make the captions bigger.')
    const answered = await until(
      'the answer while Anthropic is down',
      () => {
        const now = replies()
        return now.length > before && !busy() && now[now.length - 1]
      },
      180
    )
    const gateOpen = !document.querySelector('.cl-setup')
    await step('thread-down')
    if (!document.querySelector('.cl-start')) await go('New edit', '.cl-start')
    report.whileDown = { reply: answered, gateOpen, startOpen: !document.querySelector('.cl-setup') }
    const card = await until('the project on Start', () => document.querySelector<HTMLButtonElement>('.cl-project'), 30)
    await step('start')
    card.click()
    await editor()
    await step('editor')
    report.toast = await exportFromEditor()
    // The thread with the new export in it, and the crew credited under it.
    closeToast()
    await sleep(1500)
    const exports = document.querySelectorAll('.cl-export')
    exports[exports.length - 1]?.scrollIntoView({ block: 'start' })
    await step('thread')
    await go('Crew', '.cl-callsheet')
    await step('crew')
    await go('Brand', '.cl-brand-hero')
    await step('brand')
  }
}
