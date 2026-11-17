import type { EnginePlugin, PickedFile } from 'cutalong-engine'
import { platform } from '../../../src/main/platform'
import { Engine } from './engine'

/**
 * The app's own flow, run by the app itself on an emulator or a simulator
 * in CI (mobile/ci): pick footage, sort and transcribe it, make v1, apply a
 * command, open the editor and export, then open Settings' Licences. Built
 * in only when CUTALONG_DRIVE=1 at build time (vite.config.ts), and it runs
 * only when the app finds drive.json in its documents, which only the runner
 * can put there (adb run-as on a debuggable build, or the simulator's
 * container).
 *
 * drive.json: { "files": ["Talking.mp4"], "request": "…", "command": "/shorts" }.
 * The files are already in documents/Imported, where the engine's importer
 * copies what a person picks, and + hands them to the app as the picker
 * would: everything after the picker's own screens is the app's.
 *
 * At each step drive-progress.txt says "<n> <step>", and the app waits (up
 * to 30 s) for drive-ack.txt to say <n>: the runner takes its screenshot in
 * between. At the end, or when a step fails, drive-report.json says what
 * happened.
 */

interface Plan {
  files: string[]
  request: string
  command: string
  /** Seconds a step may take: transcribing on an emulator is slow. */
  stepSec?: number
}

interface Step {
  n: number
  name: string
  atSec: number
  acknowledged: boolean
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
function button(label: string): HTMLButtonElement | null {
  const all = [...document.querySelectorAll<HTMLButtonElement>('button')]
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

  const t0 = Date.now()
  const steps: Step[] = []
  const errors: string[] = []
  const progress: { atSec: number; stage: string }[] = []
  const report: Record<string, unknown> = {
    ok: false,
    platform: info.platform,
    ffmpeg: info.ffmpegVersion,
    whisper: info.whisperVersion,
    encoders: info.encoders,
    plan,
    steps,
    progress,
    errors
  }
  // Long enough for an emulator with no GPU to transcribe and export; a step that takes longer has stopped.
  const stepSec = plan.stepSec ?? 1200
  const seconds = (): number => Math.round((Date.now() - t0) / 100) / 10
  const keep = (line: string): void => void (errors.length < 60 && errors.push(`${seconds()} s: ${line}`))
  const error = console.error.bind(console)
  const said = (a: unknown): string => {
    if (a instanceof Error) return a.message
    if (typeof a !== 'object' || a === null) return String(a)
    try {
      return JSON.stringify(a)
    } catch {
      return String(a)
    }
  }
  console.error = (...args: unknown[]) => {
    keep(args.map(said).join(' ').slice(0, 400))
    error(...args)
  }
  addEventListener('error', (e) => keep(`error: ${e.message}`))
  addEventListener('unhandledrejection', (e) => keep(`unhandled: ${String((e as PromiseRejectionEvent).reason)}`))

  // Each step, said and screenshotted once the screen has settled.
  const step = async (name: string): Promise<void> => {
    await sleep(1200)
    const s: Step = { n: steps.length + 1, name, atSec: seconds(), acknowledged: false }
    steps.push(s)
    console.log(`[drive] ${s.n} ${name} at ${s.atSec} s`)
    await files.writeText(at('drive-progress.txt'), `${s.n} ${name}\n`)
    for (const end = Date.now() + 30_000; Date.now() < end; await sleep(300)) {
      const ack = await files.readText(at('drive-ack.txt')).catch(() => '')
      if (ack.trim() === String(s.n)) {
        s.acknowledged = true
        return
      }
    }
  }

  // Until the work in hand is done: no progress row and the composer free, for a second.
  // Work that is over before it shows a row (a command can be) is waited for only briefly.
  const settle = async (what: string): Promise<void> => {
    await until(`${what} to start`, () => busy(), 5).catch(() => undefined)
    let quiet = 0
    let last = ''
    await until(
      `${what} to finish`,
      () => {
        const stage = text(document.querySelector('.cl-progress-stage'))
        if (stage && stage !== last) {
          last = stage
          progress.push({ atSec: seconds(), stage })
        }
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

  try {
    planned = []
    for (const name of plan.files) {
      const path = at(`Imported/${name}`)
      const facts = await files.stat(path)
      if (!facts) throw new Error(`${name} is not in Imported.`)
      planned.push({ path, name, bytes: facts.size })
    }

    await until('the app', () => document.querySelector('#cl-ask'), 60)
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
    // Transcribing, on screen while it runs.
    let firstCut = false
    const working = until(
      'transcribing',
      () => firstCut || /Transcrib/.test(text(document.querySelector('.cl-progress-stage'))),
      stepSec
    ).then(() => (firstCut ? keep('transcribing never showed') : step('transcribing')))
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
    const after = await until(
      `a version from ${plan.command}`,
      async () => {
        const now = await versions()
        return now.length > before.length && now
      },
      30
    )
    report.versionsAfterCommand = after
    await step('command')
    ;(await until('Open the editor', () => button('Open the editor'), 30)).click()
    await until('the editor', () => document.querySelector('.cl-editor'), 30)
    report.previewReady = await until(
      'the preview',
      () => ((document.querySelector('.cl-editor .cl-frame video') as HTMLVideoElement | null)?.readyState ?? 0) >= 2,
      60
    ).catch(() => false)
    await step('editor')
    ;(await until('Export', () => button('Export'), 10)).click()
    const exporting = Date.now()
    await until(
      'the export to get going',
      () => /[1-9]\d*%/.test(text(document.querySelector('.cl-toast'))),
      600
    ).catch(() => keep('the export showed no progress'))
    await step('exporting')
    const toast = await until(
      'the export',
      () => {
        const said = (document.querySelector('.cl-toast') as HTMLElement | null)?.innerText.replace(/\n+/g, ' | ') ?? ''
        return /Exported|couldn.t export/i.test(said) && said
      },
      stepSec
    )
    report.toast = toast
    report.secondsToExport = Math.round((Date.now() - exporting) / 100) / 10
    await step('exported')
    if (!/Exported/.test(toast)) throw new Error(toast)
    ;(await until('Watch in chat', () => button('Watch in chat'), 10)).click()
    report.exportPlays = await until(
      'the export in the chat',
      () => ((document.querySelector('.cl-export video') as HTMLVideoElement | null)?.readyState ?? 0) >= 1,
      30
    ).catch(() => false)
    // The export, in view: the reply about the upload under it scrolls the chat past it.
    await sleep(1500)
    document.querySelector('.cl-export')?.scrollIntoView({ block: 'start' })
    report.exportReply = replies().filter((r) => /exported/i.test(r))
    await step('export-in-chat')
    report.exports = (await files.list(platform().paths.exports())).filter((e) => e.file).map((e) => e.name)

    // Settings' Licences: what the app is built with, with FFmpeg's licence open.
    ;(await until('the menu', () => button('Menu'), 10)).click()
    const settings = (): HTMLButtonElement | undefined =>
      [...document.querySelectorAll<HTMLButtonElement>('.cl-rail.open button')].find((b) => text(b) === 'Settings')
    ;(await until('Settings in the menu', settings, 10)).click()
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
    report.ok = true
  } catch (err) {
    report.failed = err instanceof Error ? err.message : String(err)
    report.replies = replies()
    console.log(`[drive] failed: ${String(report.failed)}`)
    await step('failed').catch(() => undefined)
  } finally {
    planned = null
    report.seconds = seconds()
    await files.writeText(at('drive-report.json'), JSON.stringify(report, null, 1))
    await files.writeText(at('drive-progress.txt'), `${steps.length + 1} done\n`)
    console.log(`[drive] done: ${report.ok ? 'ok' : `failed (${String(report.failed)})`}`)
  }
}
