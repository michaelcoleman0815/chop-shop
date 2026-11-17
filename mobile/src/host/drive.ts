import type { EnginePlugin, PickedFile } from 'cutalong-engine'
import { platform } from '../../../src/main/platform'
import { Engine } from './engine'

/**
 * The app's own flow, run by the app itself on an emulator or a simulator
 * in CI (mobile/ci). Built in only when CUTALONG_DRIVE=1 at build time
 * (vite.config.ts), and it runs only when the app finds drive.json in its
 * documents, which only the runner can put there (adb run-as on a debuggable
 * build, or the simulator's container).
 *
 * The flow: pick footage, sort and transcribe it, make v1, apply a command,
 * open the editor and export, watch the crew at the export from the thread,
 * then open the Crew page, Brand and Settings' Licences. Then the runner
 * turns the system dark, adds "tour": "dark" to the plan and starts the app
 * again, and the tour opens the same project: Start, the editor, the crew at
 * another export in the thread, the thread with it in, the Crew page and
 * Brand.
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
function type(field: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

const busy = (): boolean => !!document.querySelector('.cl-progress, .cl-composer.busy')
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
  let plan: Plan
  try {
    plan = JSON.parse(await files.readText(at('drive.json'))) as Plan
  } catch {
    return // No plan: the app as a person uses it.
  }
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
    // The drive's clicks are not a person's taps, so a button the app moves focus to shows the
    // keyboard's ring, which a tap never leaves; a field keeps its focus, as it would.
    const focused = document.activeElement
    if (focused instanceof HTMLButtonElement && focused.matches(':focus-visible')) focused.blur()
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

  const send = async (words: string): Promise<void> => {
    type(await until('the composer', () => document.querySelector<HTMLTextAreaElement>('#cl-ask'), 30), words)
    await sleep(300)
    ;(await until('Send', () => button('Send'), 10)).click()
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

    await until('the app', () => document.querySelector('#cl-ask'), 60)
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
    report.seconds = seconds()
    await files.writeText(at(tour ? 'tour-report.json' : 'drive-report.json'), JSON.stringify(report, null, 1))
    await files.writeText(at('drive-progress.txt'), `${steps.length + 1} done\n`)
    console.log(`[drive] done: ${report.ok ? 'ok' : `failed (${String(report.failed)})`}`)
  }

  async function flow(): Promise<void> {
    await step('start')
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
    if (!document.querySelector('.cl-start')) await go('New edit', '.cl-start')
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
