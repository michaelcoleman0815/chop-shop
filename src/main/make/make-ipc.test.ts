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
 * confirmation is refused, and so is a draft its button did not show,
 * "Go ahead without asking" makes it straight away, the edit is valid, one
 * shot is made again for its own price, a new voice makes no pictures
 * again, and a Stop says what was spent and makes only the rest after.
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
import { draftFingerprint } from '../../shared/make/fingerprint'
import { scriptCost } from '../../shared/make/quote'
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

/** make:go as a quote's button sends it: the draft, the price it showed, and its fingerprint. */
const goWith = <T>(draft: Draft, confirmed = draft.quote.total): Promise<T> =>
  call<T>('make:go', { draft, confirmed, fingerprint: draftFingerprint(draft) })

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

  it('asks first what a vague prompt leaves out, spending nothing, even with Go ahead without asking on', async () => {
    saveSettings({ makeAutoUnder: 25 })
    const before = requests().length
    const r = await call<{ ok: boolean; kind: string; questions: { id: string; options: unknown[] }[] }>('make:start', {
      text: 'make a video about my trip'
    })
    expect(r.kind).toBe('ask')
    expect(r.questions.map((q) => q.id)).toEqual(['topic', 'style', 'length'])
    // Nothing went to Claude or anywhere else: the questions are read from the prompt here.
    expect(requests().length).toBe(before)
    // A half-said prompt is asked only what it leaves out.
    const half = await call<{ kind: string; questions: { id: string }[] }>('make:start', { text: 'make a documentary about the gold rush' })
    expect(half.questions.map((q) => q.id)).toEqual(['length'])
    saveSettings({ makeAutoUnder: null })
    // Answered, it is written and quoted.
    const answeredStart = await call<Start>('make:start', {
      text: 'make a documentary about the gold rush, 1 minute long.',
      answered: true
    })
    expect(answeredStart.kind).toBe('quote')
    expect(answeredStart.draft?.brief.seconds).toBe(60)
  })

  it('refuses a confirmation for less than the quote, or for a draft its button did not show, and spends nothing', async () => {
    const r = await goWith<Made>(draft, draft.quote.total - 0.5)
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/price has changed/)
    const other = await call<Made>('make:go', { draft: { ...draft, script: `${draft.script} One more line.` }, confirmed: draft.quote.total, fingerprint: draftFingerprint(draft) })
    expect(other.ok).toBe(false)
    expect(other.message).toMatch(/quote that has changed since/)
    const none = await call<Made>('make:go', { draft, confirmed: draft.quote.total })
    expect(none.ok).toBe(false)
    // A quote confirmed for fal.ai (made when only fal.ai was open) is never made by Google instead: it is quoted again.
    const onFal: Draft = { ...draft, quote: { ...draft.quote, images: 'fal' } }
    const moved = await goWith<Made & { draft?: Draft }>(onFal)
    expect(moved.ok).toBe(false)
    expect(moved.message).toBe("The pictures would be made by Google now, not fal.ai as quoted. Confirm the new quote and I'll make it.")
    expect(moved.draft?.quote.images).toBe('google')
    expect(pictures()).toBe(0)
  })

  it('counts a script written again for a new length against the cap, with the one it replaces', async () => {
    const claude = requests().filter((q) => q.service === 'claude').length
    const r = await call<{ ok: boolean; draft: Draft; changed: string[] }>('make:revise', { draft, text: 'make it 2 minutes' })
    expect(r.ok).toBe(true)
    expect(r.draft.brief.seconds).toBe(120)
    // Claude wrote it again, and the first script was paid for too: both count.
    expect(requests().filter((q) => q.service === 'claude').length).toBe(claude + 1)
    expect(r.draft.scriptCost).toBeGreaterThan(0)
    expect(r.draft.spentBefore).toBeCloseTo(draft.scriptCost, 4)
    expect(r.draft.quote.spent).toBeCloseTo(draft.scriptCost + r.draft.scriptCost, 4)
    expect(pictures()).toBe(0)
  })

  it('holds a script written again to the cap, with what the video has cost already: past it, Claude is not asked', async () => {
    const claude = (): number => requests().filter((q) => q.service === 'claude').length
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    let d = start.draft as Draft
    // A limit with room for one script more, at the most it may cost, and not two.
    const limit = Math.round((d.scriptCost + scriptCost(180) + 0.001) * 10000) / 10000
    saveSettings({ makeCap: limit })
    const before = claude()
    const once = await call<{ ok: boolean; draft: Draft }>('make:revise', { draft: d, text: 'make it 2 minutes' })
    expect(once.ok).toBe(true)
    expect(claude()).toBe(before + 1)
    d = once.draft
    const twice = await call<{ ok: boolean; message?: string; draft?: Draft }>('make:revise', { draft: d, text: 'make it 3 minutes' })
    saveSettings({ makeCap: null })
    expect(twice.ok).toBe(false)
    expect(twice.message).toMatch(
      /^Writing the script again may cost up to \$0\.\d\d\. With the \$0\.\d\d this video has cost already, that would take it past the \$0\.\d\d a video may cost, so I kept the script it has\. Raise the limit in Settings to write it again\.$/
    )
    expect(twice.draft).toBeUndefined()
    expect(claude()).toBe(before + 1)
    expect(d.quote.spent).toBeLessThanOrEqual(limit + 1e-9)
  })

  it('writes no first script past the limit the prompt names, or Settings', async () => {
    const claude = (): number => requests().filter((q) => q.service === 'claude').length
    const before = claude()
    const asked = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom under $0.05' })
    expect(asked.ok).toBe(false)
    expect(asked.message).toBe(
      `Writing the script alone may cost up to $${scriptCost(60).toFixed(2)}, more than the $0.05 you asked this video to cost, so I didn't start it. Ask for a higher amount to make it.`
    )
    saveSettings({ makeCap: 0.1 })
    const set = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    saveSettings({ makeCap: null })
    expect(set.message).toBe(
      `Writing the script alone may cost up to $${scriptCost(60).toFixed(2)}, more than the $0.10 a video may cost, so I didn't start it. Raise the limit in Settings to make it.`
    )
    expect(claude()).toBe(before)
  })

  it('keeps a Stop pressed the moment a script is to be written again: Claude is not asked, and the quote stands', async () => {
    const claude = (): number => requests().filter((q) => q.service === 'claude').length
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    const before = claude()
    const revising = call<{ ok: boolean; message?: string; draft?: Draft | null }>('make:revise', { draft: start.draft, text: 'make it 3 minutes' })
    expect(await call('make:cancel')).toBe(true)
    const r = await revising
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Stopped before anything was written, so nothing was spent. The quote stands as it was.')
    expect(r.draft).toBeUndefined()
    expect(claude()).toBe(before)
  })

  it('stopped while Claude writes it again, keeps the script and counts what that may have cost in its quote', async () => {
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    const d = start.draft as Draft
    process.env.CUTALONG_STANDIN_CLAUDE_DELAY_MS = '400'
    const revising = call<{ ok: boolean; message?: string; draft?: Draft; reply?: unknown }>('make:revise', { draft: d, text: 'make it 3 minutes' })
    await new Promise((r) => setTimeout(r, 150))
    expect(await call('make:cancel')).toBe(true)
    const r = await revising
    process.env.CUTALONG_STANDIN_CLAUDE_DELAY_MS = '0'
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/^Stopped while Claude wrote it again\. That may have cost up to \$0\.\d\d, which counts in the quote; the script stays as it was\.$/)
    // The same script and length, quoted with the cut-off script counted against the cap.
    expect(r.draft?.script).toBe(d.script)
    expect(r.draft?.brief.seconds).toBe(60)
    expect(r.draft?.spentBefore).toBeCloseTo(scriptCost(180), 4)
    expect(r.draft?.quote.spent).toBeCloseTo(d.scriptCost + scriptCost(180), 4)
    expect(r.reply).toBeTruthy()
  })

  it('says why a video whose questions were answered by typing waits, when Settings would have gone ahead', async () => {
    saveSettings({ makeAutoUnder: 25 })
    const r = await call<Start & { reply?: { aside: string | null } }>('make:start', {
      text: 'make a 30 second animated explainer about how the heart pumps blood',
      answered: true,
      quoteFirst: true
    })
    saveSettings({ makeAutoUnder: null })
    expect(r.kind).toBe('quote')
    expect(r.reply?.aside).toMatch(/^It comes in under the \$25\.00 Settings goes ahead at, but you typed your answers, so it waits for you to check I read them right\./)
  })

  it('keeps a Stop pressed the moment a video is asked for: nothing is written or made', async () => {
    const claude = (): number => requests().filter((q) => q.service === 'claude').length
    const before = claude()
    // The quote confirmed, and stopped at once, while its price is checked again.
    const going = goWith<Made>(draft)
    expect(await call('make:cancel')).toBe(true)
    const r = await going
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Stopped before anything was made, so nothing of the quote was spent.')
    // Asked with "Go ahead without asking" on, and stopped at once, while Settings is read.
    saveSettings({ makeAutoUnder: 25 })
    const starting = call<Made>('make:start', { text: 'make a 30 second animated explainer about how the heart pumps blood' })
    expect(await call('make:cancel')).toBe(true)
    const s = await starting
    saveSettings({ makeAutoUnder: null })
    expect(s.ok).toBe(false)
    expect(s.message).toBe('Stopped before anything was written, so nothing was spent.')
    expect(claude()).toBe(before)
    expect(pictures()).toBe(0)
  })

  it('makes the confirmed quote into a valid edit, within the quote', async () => {
    const r = await goWith<Made>(draft)
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

  it('keeps a Stop pressed the moment a shot is asked for again', async () => {
    const before = requests().length
    const c = await call<{ ok: boolean; change: { kind: string; total: number } }>('make:change', {
      doc,
      text: 'make shot 2 a wide shot of the derricks at dusk'
    })
    expect(c.change.kind).toBe('shot')
    const going = call<{ ok: boolean; message?: string }>('make:shot', { doc, change: c.change, confirmed: c.change.total })
    expect(await call('make:cancel')).toBe(true)
    const r = await going
    expect(r.ok).toBe(false)
    expect(r.message).toBe('Stopped before anything was made, so nothing was spent, and the shot stays as it was.')
    // Neither Claude nor the picture service was asked for anything.
    expect(requests().length).toBe(before)
  })

  it('reads it again in another voice for nothing, keeping every picture', async () => {
    const before = pictures()
    const c = await call<{ ok: boolean; change: { kind: string; draft: Draft } }>('make:change', { doc, text: 'use a British voice instead' })
    expect(c.change.kind).toBe('draft')
    expect(c.change.draft.quote.total).toBe(0)
    expect(c.change.draft.brief.voice.id).toMatch(/^b[mf]_/)
    const r = await goWith<Made>(c.change.draft, 0)
    expect(r.ok).toBe(true)
    expect(r.into?.docId).toBe(doc.id)
    const next = EditDocSchema.parse(asNewVersion(doc, r.doc as EditDoc, r.into?.summary ?? '', r.into?.carry ?? { captions: true, look: true, music: true }))
    expect(next.versions.length).toBe(doc.versions.length + 1)
    expect(next.sources.length).toBe(doc.sources.length + 1)
    expect(next.versions[next.versions.length - 1].cut.beats[0].source).toBe('s2')
    // The map shot is the map documentaries' own graphic, and the remade cut keeps it.
    const maps = (cut: EditDoc['versions'][number]['cut']): number => cut.motion.filter((m) => m.kind === 'map').length
    expect(maps(doc.versions[0].cut)).toBe(1)
    expect(maps(next.versions[next.versions.length - 1].cut)).toBe(1)
    expect(pictures()).toBe(before)
  }, 120_000)

  it('stops when asked, says what was spent and what was kept, and makes only the rest after', async () => {
    const start = await call<Start>('make:start', { text: 'make a 1 minute cinematic documentary about the 1950s oil boom' })
    const d = start.draft as Draft
    const before = pictures()
    const claudeBefore = requests().filter((q) => q.service === 'claude').length
    process.env.CUTALONG_STANDIN_DELAY_MS = '250'
    const going = goWith<Made & { draft?: Draft }>(d)
    while (pictures() - before < 2) await new Promise((r) => setTimeout(r, 25))
    expect(await call('make:cancel')).toBe(true)
    const stopped = await going
    process.env.CUTALONG_STANDIN_DELAY_MS = '0'
    expect(stopped.ok).toBe(false)
    expect(stopped.message).toMatch(
      /^Stopped: \$\d+\.\d\d of the \$\d+\.\d\d quoted was spent\. The shot list, the narration and the \d+ pictures? already made are kept, so making the rest reuses them\.$/
    )
    const kept = Number(/the (\d+) picture/.exec(stopped.message ?? '')?.[1])
    const made = pictures() - before
    expect(kept).toBe(made)
    await new Promise((r) => setTimeout(r, 600))
    expect(pictures() - before).toBe(made)
    // The answer is a quote for the rest: the shot list and the pictures made are not paid for again.
    const rest = stopped.draft as Draft
    expect(rest.plan?.made.length).toBeGreaterThan(0)
    expect(rest.quote.total).toBeLessThan(d.quote.total)
    expect(rest.quote.lines.some((l) => /shot list/i.test(l.what))).toBe(false)
    const again = await goWith<Made>(rest)
    expect(again.message).toBeUndefined()
    expect(again.ok).toBe(true)
    // Claude planned once, in the run that was stopped; the rest asked it for nothing.
    expect(requests().filter((q) => q.service === 'claude').length - claudeBefore).toBe(1)
    // Every picture the video needs was asked for exactly once across the two runs: a sheet or a still
    // once, a clip's still and the clip once each.
    const shots = (again.doc as EditDoc).make?.shots ?? []
    const sheets = (again.doc as EditDoc).make?.sheets.length ?? 0
    const needed = sheets + shots.filter((s) => s.maker === 'google').reduce((n, s) => n + (s.visual.kind === 'clip' && /\.mp4$/.test(s.file ?? '') ? 2 : 1), 0)
    expect(pictures() - before).toBe(needed)
  }, 240_000)

  it('goes straight through under the amount in Settings, and says what it cost', async () => {
    saveSettings({ makeAutoUnder: 25 })
    const r = await call<Made & { kind?: string; auto?: boolean }>('make:start', { text: 'make a 30 second animated explainer about how the heart pumps blood' })
    expect(r.ok).toBe(true)
    expect(r.kind).toBe('made')
    expect(r.auto).toBe(true)
    expect(EditDocSchema.parse(r.doc).make?.brief.format).toBe('explainer')
    expect(r.reply?.text).toMatch(/It cost \$\d+\.\d\d of the \$\d+\.\d\d quoted\./)
    expect(r.reply?.aside).toMatch(/^Settings says to go ahead without asking under \$25, so I did not wait for you\./)
    saveSettings({ makeAutoUnder: null })
  }, 240_000)
})
