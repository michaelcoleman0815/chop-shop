import Anthropic from '@anthropic-ai/sdk'
import { app, ipcMain, net, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { z } from 'zod'
import { readApiKey } from '../apikey'
import { FFMPEG_PATH, probe } from '../ffmpeg'
import { analyzeTrack, findTracks } from '../music'
import { FONTS_DIR, VOICES_DIR } from '../resources'
import { getSettings } from '../store'
import { readBrand, readBrandById } from '../brand-store'
import { makeServices } from '../providers'
import { EditDocSchema, type EditDoc } from '../../shared/edit/schema'
import { DEFAULT_MUSIC, type Music } from '../../shared/edit/audio'
import { readAsk } from '../../shared/make/brief'
import { quoteReply, type Availability } from '../../shared/make/quote'
import {
  BriefSchema,
  MadeShotSchema,
  SheetSchema,
  BibleSchema,
  VoiceChoiceSchema,
  type Brief
} from '../../shared/make/schema'
import { defaultVoice } from '../../shared/make/voices'
import type { Transcript } from '../../shared/types'
import { parseWith, type ParseCall } from './claude'
import { kokoroVoice } from './kokoro'
import { madeMaps } from './maps'
import type { LocalVoice } from './narrate'
import type { Draft, Reply, ShotChange } from '../../shared/make/draft'
import { changeFor, quoteShot, remakeShot } from './remake'
import { draftFor, makeVideo, quoteDraft, revise, Stopped, withScript, type DraftDeps } from './run'
import type { MakeServices } from './services'
import { standInClaude, standInServices, standInVoice, writeHeard } from './stand-ins'

/**
 * Videos made from nothing, in the main process: the prompt read and
 * quoted, the quote confirmed, the video made, and asks of it made again.
 * The decisions live in shared/make and in run.ts and remake.ts; this is
 * the wiring to Electron, the person's settings and the services.
 *
 * Nothing is spent here without a confirmed quote: `make:go` and
 * `make:shot` quote again with what is open now and refuse when that is
 * more than the person confirmed. With "Go ahead without asking" on in
 * Settings, a video under that amount goes straight through, and its reply
 * still says what it cost.
 */

type Send = (sender: WebContents, channel: string, payload: unknown) => void

export interface MakeIpcDeps {
  send: Send
  mediaUrlFor: (path: string) => string
  /** A recording's words, heard on this Mac, never by another service (cutalong.ts transcriptFor). */
  transcribe: (
    path: string,
    durationSec: number,
    progress: (stage: string, percent: number) => void
  ) => Promise<Transcript>
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The services, Claude and the voice on this Mac, or their stand-ins for the end-to-end run of an unpackaged app. */
interface Tools {
  services: MakeServices
  parse: () => ParseCall | null
  local: LocalVoice
  standIn: { log: string; manifest: string | null } | null
}

function tools(): Tools {
  const dir = !app.isPackaged ? process.env.CUTALONG_MAKE_STANDINS : undefined
  if (dir) {
    const log = join(dir, 'requests.jsonl')
    return {
      services: standInServices(FFMPEG_PATH, log),
      parse: () => standInClaude(join(dir, 'scripts.json'), log),
      local: standInVoice(),
      standIn: { log, manifest: process.env.E2E_WHISPER_MANIFEST?.split(':')[0] ?? null }
    }
  }
  return {
    services: makeServices(),
    parse: () => {
      const key = readApiKey()
      return key ? parseWith(new Anthropic({ apiKey: key })) : null
    },
    local: kokoroVoice(join(app.getPath('userData'), 'voices'), {
      fetch: (url, init) => net.fetch(url, init),
      lexicons: VOICES_DIR()
    }),
    standIn: null
  }
}

/** Where an edit's made files are kept, beside the material it brings in. */
const madeDir = (docId: string): string =>
  join(app.getPath('videos'), 'Cutalong', 'Assets', docId.replace(/[^\w-]/g, '') || 'loose', 'made')

/** Words to look for a bed by, in the person's own music. */
const MUSIC_WORDS: Record<Brief['format'], string[]> = {
  documentary: ['documentary', 'cinematic', 'score', 'ambient', 'piano', 'strings'],
  explainer: ['upbeat', 'ukulele', 'acoustic', 'happy', 'corporate', 'fun']
}

async function findMusic(format: Brief['format']): Promise<Music | null> {
  const roots = [app.getPath('music'), getSettings().musicDir].filter((r): r is string => !!r)
  for (const word of MUSIC_WORDS[format]) {
    const found = (await findTracks(word, roots, 1))[0]
    if (!found) continue
    const f = await analyzeTrack(FFMPEG_PATH, found.path)
    return {
      path: found.path,
      ...DEFAULT_MUSIC,
      levelDb: format === 'documentary' ? -14 : -12,
      durationSec: f.durationSec,
      ...(f.lufs !== null ? { lufs: f.lufs } : {}),
      ...(f.bpm !== null ? { bpm: f.bpm } : {}),
      beats: f.beats
    }
  }
  return null
}

const DraftSchema = z.object({
  id: z.string().min(1).max(80),
  brief: BriefSchema,
  title: z.string().max(200),
  outline: z.array(z.string()).max(64),
  script: z.string().max(60_000),
  phrases: z.array(z.string()).max(2000),
  sections: z.array(z.number().int().min(0)).max(64),
  scriptCost: z.number().min(0),
  kept: z
    .object({
      narration: z
        .object({
          path: z.string().min(1),
          durationSec: z.number().min(0),
          sourceId: z.string().min(1),
          words: z.array(
            z
              .object({
                id: z.string(),
                source: z.string(),
                text: z.string(),
                startSec: z.number(),
                endSec: z.number()
              })
              .passthrough()
          ),
          voice: VoiceChoiceSchema,
          timing: z.enum(['voice', 'whisper'])
        })
        .optional(),
      shots: z.object({ bible: BibleSchema, shots: z.array(MadeShotSchema), sheets: z.array(SheetSchema) }).optional()
    })
    .optional(),
  into: z
    .object({
      docId: z.string(),
      sourceId: z.string(),
      summary: z.string(),
      carry: z.object({ captions: z.boolean(), look: z.boolean(), music: z.boolean() })
    })
    .optional()
})

let running: AbortController | null = null

export function registerMakeIpc(deps: MakeIpcDeps): void {
  const t = tools()

  /** What may be used right now: each service's key and the switch, Claude's key, the voice downloaded. */
  const can = async (): Promise<Availability> => {
    const open = t.services.open()
    let localVoice = false
    try {
      localVoice = await t.local.ready(defaultVoice('documentary').id)
    } catch {
      localVoice = false
    }
    return { ...open, claude: t.parse() !== null, localVoice }
  }

  /** What a draft is written and quoted with: Claude, what is open, the chat's brand (by id) and Settings. */
  const draftDeps = async (brandId?: string | null): Promise<DraftDeps> => {
    const parse = t.parse()
    const brand = brandId ? await readBrandById(brandId) : await readBrand()
    const s = getSettings()
    return {
      parse: parse ?? (async () => Promise.reject(new Error('There is no Anthropic key in Settings.'))),
      can: await can(),
      brand: { voice: brand.voice ?? null, name: brand.name ?? null, niche: brand.niche ?? null },
      settings: { cap: s.makeCap ?? null, autoUnder: s.makeAutoUnder ?? null }
    }
  }

  const quoteOf = (draft: Draft): Reply =>
    quoteReply(draft.brief, draft.quote, { title: draft.title, scenes: draft.quote.counts.scenes })

  /** Makes a draft whose quote was confirmed at `confirmed` dollars, or refuses when the price is now higher. */
  const go = async (
    sender: WebContents,
    draft: Draft,
    confirmed: number
  ): Promise<
    | { ok: true; doc: EditDoc; mediaUrl: string; reply: Reply; spent: number; into: Draft['into'] | null }
    | { ok: false; message: string; draft?: Draft; reply?: Reply }
  > => {
    const d = await draftDeps()
    const fresh: Draft = { ...draft, quote: quoteDraft(draft, d) }
    if (fresh.quote.missing.length)
      return { ok: false, message: fresh.quote.missing.join(' '), draft: fresh, reply: quoteOf(fresh) }
    if (fresh.quote.total > confirmed + 0.005)
      return {
        ok: false,
        message: `The price has changed since the quote: it is ${'$'}${fresh.quote.total.toFixed(2)} now. Confirm the new quote and I'll make it.`,
        draft: fresh,
        reply: quoteOf(fresh)
      }
    if (running) return { ok: false, message: 'A video is being made already. Wait for it, or stop it first.' }
    const controller = new AbortController()
    running = controller
    const progress = (stage: string, percent: number | null): void =>
      deps.send(sender, 'cut:progress', { stage, percent })
    const docId = draft.into?.docId ?? draft.id
    const parse = t.parse()
    if (!parse) return { ok: false, message: 'There is no Anthropic key in Settings.' }
    try {
      const made = await makeVideo(fresh, {
        services: t.services,
        local: t.local,
        parse,
        ffmpeg: FFMPEG_PATH,
        probe: async (path) => {
          const p = await probe(path)
          return { durationSec: p.durationSec, width: p.width ?? 0, height: p.height ?? 0 }
        },
        transcribe: async (path, durationSec, prog, read) => {
          if (t.standIn?.manifest && read) writeHeard(t.standIn.manifest, path, durationSec, read)
          const heard = await deps.transcribe(path, durationSec, prog)
          return heard.words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec }))
        },
        maps: madeMaps(madeDir(docId), FONTS_DIR()),
        dir: madeDir(docId),
        findMusic: (format) => findMusic(format),
        progress,
        signal: controller.signal
      })
      progress('Ready', 100)
      return {
        ok: true,
        doc: made.doc,
        mediaUrl: deps.mediaUrlFor(made.doc.sources[0].path),
        reply: made.reply,
        spent: made.spent,
        into: draft.into ?? null
      }
    } catch (err) {
      progress('Failed', 0)
      return {
        ok: false,
        message: err instanceof Stopped ? err.message : controller.signal.aborted ? 'Stopped. Nothing more is made or spent.' : message(err)
      }
    } finally {
      running = null
    }
  }

  // A prompt read and quoted; with "Go ahead without asking" on and the video under it, made straight away.
  ipcMain.handle('make:start', async (e, req: { text: string; recording?: string | null; brand?: string | null }) => {
    try {
      const brand = req.brand ? await readBrandById(req.brand) : await readBrand()
      const brief = readAsk(String(req.text ?? ''), { niche: brand.niche ?? null, recording: req.recording ?? null })
      if (!brief)
        return {
          ok: false as const,
          message: 'Tell me what the video is about, like “make a 2 minute documentary about the 1950s oil boom”.'
        }
      const d = await draftDeps(req.brand)
      if (!d.can.claude)
        return {
          ok: false as const,
          message: 'Add your Anthropic key in Settings, and I’ll write it and plan its shots.'
        }
      deps.send(e.sender, 'cut:progress', {
        stage: brief.from === 'topic' ? 'Writing the script' : 'Reading the script',
        percent: null
      })
      const drafted = await draftFor(brief, randomUUID(), d)
      if (!drafted.ok) return { ok: false as const, message: drafted.message }
      const draft = drafted.draft
      if (draft.quote.auto) {
        const made = await go(e.sender, draft, draft.quote.total)
        if (!made.ok) return made
        // Why it did not wait, said every time, after the sentence that says what it cost.
        const why = `Settings says to go ahead without asking under $${getSettings().makeAutoUnder ?? 0}, so I did not wait for you.`
        const aside = [why, made.reply.aside].filter(Boolean).join(' ')
        return { ...made, reply: { ...made.reply, aside }, kind: 'made' as const, auto: true }
      }
      return { ok: true as const, kind: 'quote' as const, draft, reply: quoteOf(draft) }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  // The quote confirmed: made, if the price is still what was confirmed.
  ipcMain.handle('make:go', async (e, req: { draft: unknown; confirmed: number }) => {
    const parsed = DraftSchema.safeParse(req.draft)
    if (!parsed.success)
      return { ok: false as const, message: 'That quote could not be read. Ask again and I’ll quote it fresh.' }
    return go(e.sender, parsed.data as Draft, Number(req.confirmed) || 0)
  })

  // What was said next about a quote not yet made: the brief changed and quoted again.
  ipcMain.handle('make:revise', async (_e, req: { draft: unknown; text: string }) => {
    const parsed = DraftSchema.safeParse(req.draft)
    if (!parsed.success) return { ok: false as const, message: 'That quote could not be read.' }
    const d = await draftDeps()
    const draft = { ...(parsed.data as Draft), quote: quoteDraft(parsed.data as Draft, d) }
    const r = revise(draft, String(req.text ?? ''), d)
    if (!r) return { ok: true as const, draft: null }
    // A new length or format for a written script means a new script, and a new quote.
    if (
      draft.brief.from === 'topic' &&
      !draft.into &&
      (r.draft.brief.seconds !== draft.brief.seconds || r.draft.brief.format !== draft.brief.format)
    ) {
      const again = await draftFor(r.draft.brief, draft.id, d)
      if (!again.ok) return { ok: false as const, message: again.message }
      return { ok: true as const, draft: again.draft, reply: quoteOf(again.draft), changed: r.changed }
    }
    return { ok: true as const, draft: r.draft, reply: quoteOf(r.draft), changed: r.changed }
  })

  // The script edited before anything is made: read again and quoted again.
  ipcMain.handle('make:script', async (_e, req: { draft: unknown; script: string }) => {
    const parsed = DraftSchema.safeParse(req.draft)
    if (!parsed.success) return { ok: false as const, message: 'That quote could not be read.' }
    const d = await draftDeps()
    const next = withScript(parsed.data as Draft, String(req.script ?? ''), d)
    if (next.phrases.length === 0) return { ok: false as const, message: 'The script has no words to read.' }
    return { ok: true as const, draft: next, reply: quoteOf(next) }
  })

  // An ask of a made video: what changing it costs, before anything is made.
  ipcMain.handle(
    'make:change',
    async (
      e,
      req: { doc: unknown; text: string; onScreen?: string | null; recording?: string | null; brand?: string | null }
    ) => {
      const parsed = EditDocSchema.safeParse(req.doc)
      if (!parsed.success || !parsed.data.make) return { ok: true as const, change: null }
      try {
        const d = await draftDeps(req.brand)
        if (/\b(?:longer|shorter|minutes?|seconds?)\b/i.test(req.text))
          deps.send(e.sender, 'cut:progress', { stage: 'Writing the script again', percent: null })
        return {
          ok: true as const,
          change: await changeFor(parsed.data, String(req.text ?? ''), req.onScreen ?? null, d, req.recording ?? null)
        }
      } catch (err) {
        return { ok: false as const, message: message(err) }
      }
    }
  )

  // One shot made again for its confirmed quote.
  ipcMain.handle('make:shot', async (e, req: { doc: unknown; change: ShotChange; confirmed: number }) => {
    const parsed = EditDocSchema.safeParse(req.doc)
    if (!parsed.success || !parsed.data.make)
      return { ok: false as const, message: 'This edit was not made from nothing.' }
    const d = await draftDeps()
    // Quoted again with what is open now: a price above the one confirmed is never spent.
    const fresh = quoteShot(
      parsed.data.make,
      { kind: 'reshoot', phrase: req.change.phrase, want: req.change.want },
      d.can,
      d.settings
    )
    if (fresh.kind !== 'shot' || fresh.missing.length)
      return { ok: false as const, message: fresh.kind === 'shot' ? fresh.missing.join(' ') : fresh.reply.text }
    const total = fresh.total
    if (total > (Number(req.confirmed) || 0) + 0.005)
      return {
        ok: false as const,
        message: `The price has changed since the quote: it is $${total.toFixed(2)} now. Ask again and I'll quote it fresh.`
      }
    if (running)
      return { ok: false as const, message: 'Something is being made already. Wait for it, or stop it first.' }
    const parse = t.parse()
    if (!parse) return { ok: false as const, message: 'There is no Anthropic key in Settings.' }
    const controller = new AbortController()
    running = controller
    try {
      const r = await remakeShot(parsed.data, req.change, {
        services: t.services,
        parse,
        dir: madeDir(parsed.data.id),
        probe: async (path) => {
          const p = await probe(path)
          return { durationSec: p.durationSec, width: p.width ?? 0, height: p.height ?? 0 }
        },
        progress: (stage, percent) => deps.send(e.sender, 'cut:progress', { stage, percent }),
        signal: controller.signal
      })
      return { ok: true as const, ...r }
    } catch (err) {
      return {
        ok: false as const,
        message: controller.signal.aborted ? 'Stopped. Nothing more is made or spent.' : message(err)
      }
    } finally {
      running = null
    }
  })

  // Stop whatever is being made: nothing more is asked for or spent.
  ipcMain.handle('make:cancel', () => {
    running?.abort()
    return true
  })
}
