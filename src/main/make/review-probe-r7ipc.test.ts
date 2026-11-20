import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Round 7 (088b79e), through main's own make handlers (Electron faked, Claude and the picture
 * services stood in for, no network): every handler that can spend checks `consent` at the boundary.
 * make:start may ask its questions without it; past them it needs 'tap' or 'command'. make:revise,
 * make:go and make:shot need 'tap'. Anything else is refused with nothing asked of any service.
 */

const fake = vi.hoisted(() => ({
  root: '',
  handlers: {} as Record<string, (e: unknown, req: unknown) => Promise<unknown>>
}))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: { getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)), isPackaged: false, getAppPath: () => process.cwd() },
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
import { saveSettings } from '../store'
import { registerMakeIpc } from './index'

const SCRIPTS = {
  documentary: { title: 'Black Gold', sections: [{ heading: 'One', paragraphs: ['In 1950 the West Texas sky was full of derricks.', 'Oil was the new gold, and everyone wanted a claim.'] }] },
  explainer: { title: 'How Your Heart Pumps', sections: [{ heading: 'Four rooms', paragraphs: ['Your heart is a pump with four rooms.'] }] }
}
const call = <T>(channel: string, req?: unknown): Promise<T> => fake.handlers[channel]({ sender: {} }, req) as Promise<T>
let standins = ''
const requests = (): { service: string; kind?: string }[] => {
  const log = join(standins, 'requests.jsonl')
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

beforeAll(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'probe-r7ipc-'))
  standins = join(fake.root, 'standins')
  mkdirSync(standins, { recursive: true })
  mkdirSync(join(fake.root, 'music'), { recursive: true })
  writeFileSync(join(standins, 'scripts.json'), JSON.stringify(SCRIPTS))
  process.env.CUTALONG_MAKE_STANDINS = standins
  process.env.E2E_WHISPER_MANIFEST = join(fake.root, 'heard.json')
  registerMakeIpc({ send: () => undefined, mediaUrlFor: (p) => `media://${p}`, transcribe: async () => ({ words: [], text: '', language: 'en' }) as never })
})
afterAll(() => {
  delete process.env.CUTALONG_MAKE_STANDINS
  delete process.env.E2E_WHISPER_MANIFEST
  rmSync(fake.root, { recursive: true, force: true })
})

type Start = { ok: boolean; kind?: string; draft?: Draft; message?: string; questions?: unknown[] }
const COMPLETE = 'make a 1 minute cinematic documentary about the 1950s oil boom'

describe('consent at the boundary', () => {
  it('make:start: questions need no consent; a script needs tap or command, nothing else', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const asks = await call<Start>('make:start', { text: 'make a video about my trip' })
    const rows: string[] = [`no consent, vague prompt: kind=${asks.kind}, ${asks.questions?.length} questions`]
    for (const consent of [undefined, null, '', 'TAP', ' tap', 'taps', true, 1, {}, ['tap'], 'typed', 'yes'] as unknown[]) {
      const before = requests().length
      const r = await call<Start>('make:start', { text: COMPLETE, consent })
      rows.push(`consent ${JSON.stringify(consent)}: ok=${r.ok} kind=${r.kind ?? '-'} "${r.message ?? ''}"; requests +${requests().length - before}`)
      expect(requests().length - before).toBe(0)
    }
    for (const consent of ['tap', 'command']) {
      const before = requests().length
      const r = await call<Start>('make:start', { text: COMPLETE, consent })
      rows.push(`consent ${JSON.stringify(consent)}: ok=${r.ok} kind=${r.kind}; requests +${requests().length - before} (${requests().slice(before).map((q) => q.service).join(', ')})`)
    }
    // Answered (no questions asked) is no consent of its own.
    const answered = await call<Start>('make:start', { text: 'make a video about my trip, Lisbon', answered: true })
    rows.push(`answered with no consent: ok=${answered.ok} "${answered.message}"`)
    console.log(rows.join('\n'))
    expect(asks.kind).toBe('ask')
    expect(answered.ok).toBe(false)
  })

  it('make:go, make:revise and make:shot take only tap', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const start = await call<Start>('make:start', { text: COMPLETE, consent: 'command' })
    const draft = start.draft as Draft
    const rows: string[] = []
    for (const consent of [undefined, 'command', 'TAP', true, {}] as unknown[]) {
      const before = requests().length
      const go = await call<{ ok: boolean; message?: string }>('make:go', { draft, confirmed: draft.quote.total, fingerprint: draftFingerprint(draft), consent })
      const rv = await call<{ ok: boolean; message?: string }>('make:revise', { draft, steps: ['make it 3 minutes'], consent })
      const sh = await call<{ ok: boolean; message?: string }>('make:shot', { doc: {}, change: {}, confirmed: 1, consent })
      rows.push(`consent ${JSON.stringify(consent)}: go "${go.message}"; revise "${rv.message}"; shot "${sh.message}"; requests +${requests().length - before}`)
      expect(go.ok || rv.ok || sh.ok).toBe(false)
      expect(requests().length - before).toBe(0)
    }
    const before = requests().length
    const rv = await call<{ ok: boolean; draft?: Draft }>('make:revise', { draft, steps: ['make it 3 minutes'], consent: 'tap' })
    rows.push(`revise with tap: ok=${rv.ok}, ${rv.draft?.brief.seconds} s; requests +${requests().length - before} (${requests().slice(before).map((q) => q.service).join(', ')})`)
    console.log(rows.join('\n'))
    expect(rv.ok).toBe(true)
  })

  it('go-ahead: a fresh ask (command) and a tap may make straight away; a tap with quoteFirst never does', async () => {
    saveSettings({ makeAutoUnder: 25, makeCap: null })
    const yes = await call<Start & { reply?: { aside: string | null } }>('make:start', { text: COMPLETE, answered: true, quoteFirst: true, consent: 'tap' })
    saveSettings({ makeAutoUnder: null })
    console.log(`a read-back's Yes (tap, quoteFirst) under the go-ahead: kind=${yes.kind}; aside: ${yes.reply?.aside?.slice(0, 120)}`)
    expect(yes.kind).toBe('quote')
  })
})
