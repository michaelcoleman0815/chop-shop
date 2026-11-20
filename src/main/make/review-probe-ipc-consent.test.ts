import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Re-review of b3e9c1a, through the main process's own handlers (Electron
 * faked as make-ipc.test.ts fakes it, Claude answered by the stand-in, no
 * network): is a script written again for a new length (make:revise) held to
 * the cap, and to a Stop? Settings says: "Nothing is asked of a service,
 * Claude included, that would take a video past $cap, with what it has cost
 * already."
 */

const fake = vi.hoisted(() => ({
  root: '',
  handlers: {} as Record<string, (e: unknown, req: unknown) => Promise<unknown>>
}))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)),
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => {
        fake.handlers[channel] = fn
      }
    },
    net: {
      fetch: async () => {
        throw new Error('No network in this probe.')
      }
    },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})

import type { Draft } from '../../shared/make/draft'
import { draftFingerprint } from '../../shared/make/fingerprint'
import { scriptCost } from '../../shared/make/quote'
import { saveSettings } from '../store'
import { registerMakeIpc } from './index'

// A script about as long as a real 10-minute one, so each one the stand-in writes costs what a real one would (about $0.09).
const LINE =
  'In 1950 the West Texas sky filled with derricks, and a wildcatter could lose everything on one dry hole or strike it rich by morning; the men who worked the rigs came from farms and small towns across the plains.'
const SCRIPTS = {
  documentary: {
    title: 'Black Gold',
    sections: Array.from({ length: 8 }, (_, s) => ({ heading: `Part ${s + 1}`, paragraphs: Array.from({ length: 9 }, () => LINE) }))
  },
  explainer: { title: 'How Your Heart Pumps', sections: [{ heading: 'Four rooms', paragraphs: ['Your heart is a pump with four rooms.'] }] }
}

const call = <T>(channel: string, req?: unknown): Promise<T> => fake.handlers[channel]({ sender: {} }, req) as Promise<T>
let standins = ''
const claude = (): number => {
  const log = join(standins, 'requests.jsonl')
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { service: string })
        .filter((q) => q.service === 'claude').length
    : 0
}

beforeAll(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'probe-ipc-'))
  standins = join(fake.root, 'standins')
  mkdirSync(standins, { recursive: true })
  mkdirSync(join(fake.root, 'music'), { recursive: true })
  writeFileSync(join(standins, 'scripts.json'), JSON.stringify(SCRIPTS))
  process.env.CUTALONG_MAKE_STANDINS = standins
  process.env.E2E_WHISPER_MANIFEST = join(fake.root, 'heard.json')
  registerMakeIpc({
    send: () => undefined,
    mediaUrlFor: (p) => `media://${p}`,
    transcribe: async () => ({ words: [], text: '', language: 'en' }) as never
  })
})

afterAll(() => {
  delete process.env.CUTALONG_MAKE_STANDINS
  delete process.env.E2E_WHISPER_MANIFEST
  rmSync(fake.root, { recursive: true, force: true })
})

type Start = { ok: boolean; kind?: string; draft?: Draft; message?: string }
type Revised = { ok: boolean; draft?: Draft | null; message?: string }

describe('a script written again for a new length (make:revise)', () => {
  it('round 4 finding 4 (e11324f claim 4): each length change is held to the cap before Claude is asked', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: 0.3 })
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom', consent: 'command' })
    expect(start.kind).toBe('quote')
    let draft = start.draft as Draft
    const rows = [`Settings cap $0.30. make:start: Claude asked ${claude()}; the script cost $${draft.scriptCost.toFixed(4)}; quote.spent $${draft.quote.spent.toFixed(4)}`]
    for (const m of [2, 3, 4, 5, 6]) {
      const before = claude()
      const had = draft.quote.spent
      const r = await call<Revised>('make:revise', { draft, text: `make it ${m} minutes`, consent: 'tap' })
      rows.push(
        `"make it ${m} minutes": spent already $${had.toFixed(4)}, this script held at $${scriptCost(m * 60).toFixed(4)}; Claude asked ${claude() - before}; ` +
          (r.ok && r.draft ? `quote.spent now $${r.draft.quote.spent.toFixed(4)}; the quote says: ${r.draft.quote.missing.join(' ')}` : `answered: ${r.message}`)
      )
      if (r.ok && r.draft) draft = r.draft
    }
    console.log(rows.join('\n'))
    saveSettings({ makeCap: null })
    expect(draft.quote.spent).toBeLessThanOrEqual(0.3 + 1e-9)
  })

  it('round 4 finding 3 (e11324f claim 3): a Stop pressed as soon as it is asked means Claude is not asked', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom', consent: 'command' })
    const before = claude()
    const revising = call<Revised>('make:revise', { draft: start.draft, text: 'make it 3 minutes', consent: 'tap' })
    const cancelled = await call<boolean>('make:cancel')
    const r = await revising
    console.log(
      `make:cancel answered ${cancelled} before Claude was asked; Claude asked after the Stop: ${claude() - before}; make:revise answered ok=${r.ok}, a new quote: ${!!r.draft}, its script $${r.draft?.scriptCost?.toFixed(4)}, quote.spent $${r.draft?.quote.spent.toFixed(4)}`
    )
    expect(claude() - before).toBe(0)
  })

  it('claim 4: a Stop pressed the moment make:go or make:start is asked is kept, and nothing is asked of anyone', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom', consent: 'command' })
    const draft = start.draft as Draft
    const all = (): number => {
      const log = join(standins, 'requests.jsonl')
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0
    }
    const before = all()
    const going = call<{ ok: boolean; message?: string }>('make:go', { draft, confirmed: draft.quote.total, fingerprint: draftFingerprint(draft), consent: 'tap' })
    await call('make:cancel')
    const g = await going
    saveSettings({ makeAutoUnder: 25 })
    const starting = call<{ ok: boolean; message?: string; kind?: string }>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom', consent: 'command' })
    await call('make:cancel')
    const s = await starting
    saveSettings({ makeAutoUnder: null })
    console.log(`make:go stopped at once: ok=${g.ok} "${g.message}"; make:start (auto on) stopped at once: ok=${s.ok} "${s.message}"; requests to any service after: ${all() - before}`)
    expect(g.ok).toBe(false)
    expect(s.ok).toBe(false)
    expect(all() - before).toBe(0)
  })

  it('e11324f claim 3: a Stop while Claude writes it again keeps the old script and counts the cut-off hold', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom', consent: 'command' })
    const draft = start.draft as Draft
    process.env.CUTALONG_STANDIN_CLAUDE_DELAY_MS = '400'
    const before = claude()
    const revising = call<Revised & { reply?: { text: string } }>('make:revise', { draft, text: 'make it 3 minutes', consent: 'tap' })
    while (claude() === before) await new Promise((r) => setTimeout(r, 10))
    // The old quote's button pressed while it is written again.
    const pressed = await call<{ ok: boolean; message?: string }>('make:go', { draft, confirmed: draft.quote.total, fingerprint: draftFingerprint(draft), consent: 'tap' })
    await call('make:cancel')
    const r = await revising
    process.env.CUTALONG_STANDIN_CLAUDE_DELAY_MS = '0'
    console.log(
      `old quote's button pressed meanwhile: ok=${pressed.ok} "${pressed.message}"\n` +
        `Stop mid-write: ok=${r.ok} "${r.message}"; script kept: ${r.draft?.script === draft.script}; seconds ${r.draft?.brief.seconds}; ` +
        `spent before $${draft.quote.spent.toFixed(4)} -> $${r.draft?.quote.spent.toFixed(4)} (the 3-minute script's hold $${scriptCost(180).toFixed(4)})`
    )
    expect(r.ok).toBe(false)
    expect(r.draft?.script).toBe(draft.script)
    expect(r.draft?.quote.spent ?? 0).toBeCloseTo(draft.quote.spent + scriptCost(180), 4)
  })

  it('e11324f extra: typed answers with go-ahead on wait, and say why', async () => {
    saveSettings({ makeAutoUnder: 25, makeCap: null })
    const r = await call<Start & { reply?: { text: string; aside: string | null } }>('make:start', {
      text: 'make a 1 minute cinematic documentary about the 1950s oil boom',
      answered: true,
      quoteFirst: true, consent: 'tap'
    })
    saveSettings({ makeAutoUnder: null })
    console.log(`typed answers, go-ahead under $25: kind=${r.kind}; total $${r.draft?.quote.total.toFixed(2)}; auto=${r.draft?.quote.auto}; aside: ${r.reply?.aside}`)
    expect(r.kind).toBe('quote')
  })

  it('round 4 finding 4 (e11324f claim 4): the first script is held to a cap the prompt names', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const before = claude()
    const r = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom under $0.05', consent: 'command' })
    console.log(
      `prompt cap $0.05; the script's hold $${scriptCost(60).toFixed(4)}; Claude asked ${claude() - before}; the script cost $${r.draft?.scriptCost.toFixed(4)}; the quote says: ${r.draft?.quote.missing.join(' ') ?? r.message}`
    )
    expect(claude() - before).toBe(0)
  })
})
