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
 *
 * Kept as a regression test from round 10 on. These calls carry no consent,
 * as every call did before b054211; since then main asks no one for anything
 * without it, so each is now held to that: refused, said why, and nothing
 * asked of Claude or of any other service. The same probes with their consent
 * (review-probe-ipc-consent) hold the cap and the Stop.
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

const WROTE_NOTHING = 'I wrote nothing: a script is written only when you tap its button, or ask for a new video with nothing else waiting.'
const MADE_NOTHING = 'Nothing was made: a video is made only when you press its quote’s button.'
const CHANGED_NOTHING = 'Nothing was changed: a quote is changed only when you tap Yes on what I read back.'

/** Every request any stand-in service was asked, Claude's included. */
const all = (): number => {
  const log = join(standins, 'requests.jsonl')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0
}

/** A quote to press or change, written for a new video asked for with nothing else waiting. */
async function quoted(): Promise<Draft> {
  const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom', consent: 'command' })
  expect(start.kind).toBe('quote')
  return start.draft as Draft
}

describe('a script written again for a new length (make:revise)', () => {
  it('round 4 finding 4 (e11324f claim 4): with no consent, no length change asks Claude for anything, whatever the cap', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: 0.3 })
    const unasked = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    expect(unasked).toMatchObject({ ok: false, message: WROTE_NOTHING })
    const draft = await quoted()
    const before = claude()
    for (const m of [2, 3, 4, 5, 6]) {
      const r = await call<Revised>('make:revise', { draft, text: `make it ${m} minutes` })
      expect(r).toMatchObject({ ok: false, message: CHANGED_NOTHING })
    }
    saveSettings({ makeCap: null })
    expect(claude() - before).toBe(0)
  })

  it('round 4 finding 3 (e11324f claim 3): a Stop pressed as soon as it is asked means Claude is not asked', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const draft = await quoted()
    const before = claude()
    const revising = call<Revised>('make:revise', { draft, text: 'make it 3 minutes' })
    const cancelled = await call<boolean>('make:cancel')
    const r = await revising
    console.log(`make:cancel answered ${cancelled}; Claude asked after: ${claude() - before}; make:revise answered ok=${r.ok} "${r.message}"`)
    expect(r.ok).toBe(false)
    expect(claude() - before).toBe(0)
  })

  it('claim 4: make:go and make:start with no consent ask nothing of anyone, go-ahead on or off', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const draft = await quoted()
    const before = all()
    const g = await call<{ ok: boolean; message?: string }>('make:go', { draft, confirmed: draft.quote.total, fingerprint: draftFingerprint(draft) })
    saveSettings({ makeAutoUnder: 25 })
    const s = await call<{ ok: boolean; message?: string; kind?: string }>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    saveSettings({ makeAutoUnder: null })
    console.log(`make:go with no consent: ok=${g.ok} "${g.message}"; make:start (go-ahead on) with no consent: ok=${s.ok} "${s.message}"; requests to any service after: ${all() - before}`)
    expect(g).toMatchObject({ ok: false, message: MADE_NOTHING })
    expect(s).toMatchObject({ ok: false, message: WROTE_NOTHING })
    expect(all() - before).toBe(0)
  })

  it('e11324f claim 3: while a script is written again with its consent, the old quote pressed with none makes nothing', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const draft = await quoted()
    process.env.CUTALONG_STANDIN_CLAUDE_DELAY_MS = '400'
    const before = claude()
    const revising = call<Revised & { reply?: { text: string } }>('make:revise', { draft, text: 'make it 3 minutes', consent: 'tap' })
    while (claude() === before) await new Promise((r) => setTimeout(r, 10))
    const asked = all()
    const pressed = await call<{ ok: boolean; message?: string }>('make:go', { draft, confirmed: draft.quote.total, fingerprint: draftFingerprint(draft) })
    await call('make:cancel')
    const r = await revising
    process.env.CUTALONG_STANDIN_CLAUDE_DELAY_MS = '0'
    console.log(`old quote's button pressed meanwhile, no consent: ok=${pressed.ok} "${pressed.message}"; Stop mid-write: ok=${r.ok}; script kept: ${r.draft?.script === draft.script}`)
    expect(pressed).toMatchObject({ ok: false, message: MADE_NOTHING })
    expect(all()).toBe(asked)
    expect(r.ok).toBe(false)
    expect(r.draft?.script).toBe(draft.script)
    expect(r.draft?.quote.spent ?? 0).toBeCloseTo(draft.quote.spent + scriptCost(180), 4)
  })

  it('e11324f extra: typed answers with go-ahead on and no consent write nothing, and say why', async () => {
    saveSettings({ makeAutoUnder: 25, makeCap: null })
    const before = all()
    const r = await call<Start & { reply?: { text: string; aside: string | null } }>('make:start', {
      text: 'make a 1 minute cinematic documentary about the 1950s oil boom',
      answered: true,
      quoteFirst: true
    })
    saveSettings({ makeAutoUnder: null })
    expect(r).toMatchObject({ ok: false, message: WROTE_NOTHING })
    expect(all() - before).toBe(0)
  })

  it('round 4 finding 4 (e11324f claim 4): the first script is held to a cap the prompt names', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const before = claude()
    const r = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom under $0.05' })
    console.log(
      `prompt cap $0.05; the script's hold $${scriptCost(60).toFixed(4)}; Claude asked ${claude() - before}; the script cost $${r.draft?.scriptCost.toFixed(4)}; the quote says: ${r.draft?.quote.missing.join(' ') ?? r.message}`
    )
    expect(claude() - before).toBe(0)
  })
})
