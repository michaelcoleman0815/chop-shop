import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Making a video from one prompt, through the main process's own handlers,
 * with Electron faked and every service stood in for (stand-ins.ts):
 * pictures and clips made by ffmpeg, the voice by espeak-ng (or a tone),
 * Claude's answers written here and parsed by the real Anthropic SDK, and
 * whisper answering from where each phrase was read. Checked: nothing is
 * asked of a picture service before the quote is confirmed, a lower
 * confirmation is refused, "Go ahead without asking" makes it straight away,
 * the edit is valid, one shot is made again for its own price, and a new
 * voice makes no pictures again.
 */

const fake = vi.hoisted(() => ({
  root: '',
  handlers: {} as Record<string, (e: unknown, req: unknown) => Promise<unknown>>,
  progress: [] as string[]
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
        throw new Error('No network in this test.')
      }
    },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})

import { EditDocSchema, type EditDoc } from '../../shared/edit/schema'
import { asNewVersion } from '../../shared/make/assemble'
import type { Draft } from '../../shared/make/draft'
import { saveSettings } from '../store'
import { registerMakeIpc } from './index'

const SCRIPTS = {
  documentary: {
    title: 'Black Gold',
    sections: [
      {
        heading: 'The first gusher',
        paragraphs: [
          'In 1950, the West Texas sky was full of derricks. A wildcatter could lose everything on one dry hole, or strike it rich by morning.',
          'Oil was the new gold, and everyone wanted a claim.'
        ]
      },
      {
        heading: 'Boom towns',
        paragraphs: ['By 1955, towns like Midland had doubled in size. Roughnecks worked through the night under hard white lights.']
      },
      { heading: 'The cost', paragraphs: ['The boom changed the country forever, and the land kept the scars.'] }
    ]
  },
  explainer: {
    title: 'How Your Heart Pumps',
    sections: [
      { heading: 'Four rooms', paragraphs: ['Your heart is a pump with four rooms. Blood comes in on the right and leaves on the left.'] },
      { heading: 'The squeeze', paragraphs: ['When the walls squeeze, the valves snap shut behind the blood. That is the beat you hear.'] }
    ]
  }
}

const call = <T>(channel: string, req?: unknown): Promise<T> =>
  fake.handlers[channel]({ sender: {} }, req) as Promise<T>

let standins = ''
let manifest = ''
const requests = (): { service: string; kind?: string; prompt?: string; refs?: number[] }[] => {
  const log = join(standins, 'requests.jsonl')
  return existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : []
}
const pictures = (): number => requests().filter((r) => r.kind === 'image' || r.kind === 'clip').length

beforeAll(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'cutalong-make-'))
  standins = join(fake.root, 'standins')
  mkdirSync(standins, { recursive: true })
  mkdirSync(join(fake.root, 'music'), { recursive: true })
  writeFileSync(join(standins, 'scripts.json'), JSON.stringify(SCRIPTS))
  manifest = join(fake.root, 'heard.json')
  process.env.CUTALONG_MAKE_STANDINS = standins
  process.env.E2E_WHISPER_MANIFEST = manifest
  registerMakeIpc({
    send: (_s, _c, p) => fake.progress.push((p as { stage: string }).stage),
    mediaUrlFor: (p) => `media://${p}`,
    // What whisper's stand-in hears: the words written where each phrase was read.
    transcribe: async (path) => {
      const heard = JSON.parse(readFileSync(manifest, 'utf8')) as { recordings: { name: string; words: { text: string; startSec: number; endSec: number }[] }[] }
      const words = heard.recordings.find((r) => r.name === path)?.words ?? []
      return { words, text: words.map((w) => w.text).join(' '), language: 'en' } as never
    }
  })
})

afterAll(() => {
  delete process.env.CUTALONG_MAKE_STANDINS
  delete process.env.E2E_WHISPER_MANIFEST
  rmSync(fake.root, { recursive: true, force: true })
})

type Start = { ok: boolean; kind?: string; draft?: Draft; reply?: { text: string; details: { label: string; value: string }[] }; message?: string }
type Made = { ok: boolean; doc?: EditDoc; reply?: { text: string; aside: string | null }; spent?: number; message?: string; into?: Draft['into'] | null }

describe('a video made from one prompt', () => {
  let doc: EditDoc
  let draft: Draft

  it('quotes before anything is made, and asks no picture service for anything', async () => {
    saveSettings({ makeAutoUnder: null, makeCap: null })
    const r = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom, with maps where it helps' })
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('quote')
    draft = r.draft as Draft
    expect(draft.brief.format).toBe('documentary')
    expect(draft.brief.seconds).toBe(60)
    expect(draft.phrases.length).toBeGreaterThan(4)
    expect(draft.quote.total).toBeGreaterThan(0)
    expect(draft.quote.total).toBeLessThanOrEqual(draft.quote.cap)
    expect(r.reply?.text).toMatch(/^I'll make a 1:00 cinematic documentary about the 1950s oil boom/)
    expect(draft.quote.sends.join(' ')).toMatch(/Only the text prompts for the pictures go to Google/)
    expect(draft.quote.sends.join(' ')).toMatch(/Nothing of your own footage leaves this Mac/)
    // Only Claude, writing the script: no picture, clip or voice service yet.
    expect(requests().map((q) => q.service)).toEqual(['claude'])
  })

  it('refuses a confirmation for less than the quote, and spends nothing', async () => {
    const r = await call<Made>('make:go', { draft, confirmed: draft.quote.total - 0.5 })
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/price has changed/)
    expect(pictures()).toBe(0)
  })

  it('makes the confirmed quote into a valid edit, within the quote', async () => {
    const r = await call<Made>('make:go', { draft, confirmed: draft.quote.total })
    expect(r.message).toBeUndefined()
    expect(r.ok).toBe(true)
    doc = EditDocSchema.parse(r.doc)
    const cut = doc.versions[0].cut
    expect(doc.make?.shots.length).toBe(draft.phrases.length)
    expect(cut.beats.length).toBe(draft.phrases.length)
    for (const b of cut.beats) {
      expect(b.treatment.frame).toBe('broll')
      expect(existsSync(b.treatment.broll?.path ?? '')).toBe(true)
    }
    expect(cut.look?.sepia).toBeGreaterThan(0)
    expect(cut.look?.dust).toBeGreaterThan(0)
    expect(cut.motion.some((m) => m.kind === 'title' && m.style === 'engraved')).toBe(true)
    expect(r.spent).toBeLessThanOrEqual(draft.quote.total + 1e-9)
    expect(r.reply?.text).toMatch(/^v1 is ready: a 0:\d\d documentary about the 1950s oil boom, \d+ shots\. It cost \$\d+\.\d\d of the \$\d+\.\d\d quoted\.$/)
    expect(r.reply?.aside).toMatch(/YouTube asks you to mark realistic made pictures/)
    // Claude planned the shots (the stand-in's bible), not the plan made here when it cannot.
    expect(r.reply?.aside ?? '').not.toMatch(/Claude could not plan/)
    expect(doc.make?.bible.style).toMatch(/^Photoreal 1950s archival photography/)
    expect(doc.make?.shots[0].visual.kind).toBe('card')
    // What went to the picture service was text, and the sheet it made for the character: never a path.
    const sent = requests().filter((q) => q.kind === 'image')
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.length).toBeLessThanOrEqual(draft.quote.counts.stills + draft.quote.counts.sheets)
    for (const q of sent) expect(q.prompt).not.toMatch(new RegExp(fake.root.replace(/[/\\]/g, '.')))
  }, 240_000)

  it('makes one shot again for its own price, as a treat of its beat', async () => {
    const before = pictures()
    const c = await call<{ ok: boolean; change: { kind: string; total: number; phrase: number; beat: string } }>('make:change', {
      doc,
      text: 'make shot 3 a close-up of a roughneck’s hands on a wrench'
    })
    expect(c.ok).toBe(true)
    expect(c.change.kind).toBe('shot')
    expect(c.change.total).toBeGreaterThan(0)
    const r = await call<{ ok: boolean; ops: { op: string; beats: string[] }[]; make: EditDoc['make']; spent: number }>('make:shot', {
      doc,
      change: c.change,
      confirmed: c.change.total
    })
    expect(r.ok).toBe(true)
    expect(r.ops).toEqual([expect.objectContaining({ op: 'treat', beats: [c.change.beat] })])
    expect(r.spent).toBeLessThanOrEqual(c.change.total + 1e-9)
    expect(pictures()).toBe(before + 1)
    const shot = r.make?.shots.find((s) => s.phrase === c.change.phrase)
    expect(shot?.visual.kind === 'still' && shot.visual.prompt).toMatch(/close-up of a roughneck/i)
  }, 120_000)

  it('reads it again in another voice for nothing, keeping every picture', async () => {
    const before = pictures()
    const c = await call<{ ok: boolean; change: { kind: string; draft: Draft } }>('make:change', { doc, text: 'use a British voice instead' })
    expect(c.change.kind).toBe('draft')
    expect(c.change.draft.quote.total).toBe(0)
    expect(c.change.draft.brief.voice.id).toMatch(/^b[mf]_/)
    const r = await call<Made>('make:go', { draft: c.change.draft, confirmed: 0 })
    expect(r.ok).toBe(true)
    expect(r.into?.docId).toBe(doc.id)
    const next = EditDocSchema.parse(asNewVersion(doc, r.doc as EditDoc, r.into?.summary ?? '', r.into?.carry ?? { captions: true, look: true, music: true }))
    expect(next.versions.length).toBe(doc.versions.length + 1)
    expect(next.sources.length).toBe(doc.sources.length + 1)
    expect(next.versions[next.versions.length - 1].cut.beats[0].source).toBe('s2')
    expect(pictures()).toBe(before)
  }, 120_000)

  it('goes straight through under the amount in Settings, and says what it cost', async () => {
    saveSettings({ makeAutoUnder: 25 })
    const r = await call<Made & { kind?: string; auto?: boolean }>('make:start', { text: 'make a 30 second animated explainer about how the heart pumps blood' })
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('made')
    expect(r.auto).toBe(true)
    expect(EditDocSchema.parse(r.doc).make?.brief.format).toBe('explainer')
    expect(r.reply?.text).toMatch(/It cost \$\d+\.\d\d of the \$\d+\.\d\d quoted\./)
    saveSettings({ makeAutoUnder: null })
  }, 240_000)
})
