import { promises as fs } from 'fs'
import { clock } from '../../shared/presets/preset'
import type { Music } from '../../shared/edit/audio'
import type { EditDoc } from '../../shared/edit/schema'
import { wordsFromTranscript } from '../../shared/edit/doc'
import type { Draft, Kept, Reply } from '../../shared/make/draft'
import { readAsk, reviseBrief, cleanTopic } from '../../shared/make/brief'
import { assembleDoc, type Carry, type MadeFile } from '../../shared/make/assemble'
import type { MapShots } from '../../shared/make/map'
import type { MotionCallInput } from '../../shared/motion/schema'
import { PRICES } from '../../shared/make/prices'
import {
  countShots,
  DEFAULT_CAP,
  dollars,
  estimateCounts,
  estimateUnwritten,
  listOf,
  quoteFor,
  scriptCost,
  shotListCost,
  stillCost,
  clipCost,
  videoCap,
  voiceCost,
  type Availability,
  type Counts,
  type Quote
} from '../../shared/make/quote'
import { countWords, phraseRanges, phrasesAndSections } from '../../shared/make/script'
import {
  fitShots,
  localShotList,
  promptFor,
  scriptText,
  sheetPrompt,
  shotCost,
  type CheckedShots
} from '../../shared/make/shots'
import type { Bible, Brief, ImageService, Make, MadeShot, Sheet, Shot, VoiceChoice } from '../../shared/make/schema'
import { defaultVoice, voicePhrase } from '../../shared/make/voices'
import { planShots, writeScript, type ParseCall } from './claude'
import { acceptedJob, Budget, inTurn, MadeCache, makeOnce, NotKept, OverBudget, type MadeRequest } from './generate'
import { ServiceError } from '../providers/gate'
import { groundFor } from './local-pictures'
import { narrate, type LocalVoice } from './narrate'
import type { MakeServices, Picture, TimedWord } from './services'

/**
 * Making a video from nothing, from the confirmed quote to a finished edit.
 *
 * The narration is read (or the creator's recording is listened to) while
 * Claude plans the shots; the shots are fitted to what was agreed; character
 * sheets are made first so every later shot can carry them; then the stills,
 * four at a time, and the few clips, each from its own still. Maps, cards
 * and graphics are made on this Mac. Nothing is asked of a service, Claude
 * included, that would take the spending past the quote. What could not be
 * made is said plainly, and the shot shows a plain card until it is asked
 * for again. Stopped, the shot list, the narration and the pictures made so
 * far are kept on a draft to go on from, so making the rest buys none of
 * them again.
 */


export interface MakeRunDeps {
  services: MakeServices
  local: LocalVoice
  parse: ParseCall
  ffmpeg: string
  probe: (path: string) => Promise<{ durationSec: number; width: number; height: number }>
  /**
   * The words of a recording, heard on this Mac (never by another service).
   * For a narration read here, `read` says which phrases sit where; whisper
   * does not need it, and the end-to-end stand-in for whisper does.
   */
  transcribe: (
    path: string,
    durationSec: number,
    progress: (stage: string, percent: number) => void,
    read?: { phrases: string[]; spans: { phrases: number[]; startSec: number; endSec: number }[] }
  ) => Promise<TimedWord[]>
  maps: MapShots
  /** The edit's own folder for what is made: Assets/<edit>/made. */
  dir: string
  /** A bed from the person's own music for a format, analysed, or null. */
  findMusic: (format: Brief['format']) => Promise<Music | null>
  progress: (stage: string, percent: number | null) => void
  signal?: AbortSignal
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// ---------- The draft: the brief, the script and the quote ----------

export interface DraftDeps {
  parse: ParseCall
  can: Availability
  brand: { voice?: string | null; name?: string | null; niche?: string | null }
  settings: { cap?: number | null; autoUnder?: number | null; voice?: VoiceChoice | null }
  today?: string
  /**
   * A recording's words and length, heard on this Mac (never by another
   * service): a video made over the person's own voice-over is quoted for
   * the lines it really has.
   */
  hear?: (path: string) => Promise<{ durationSec: number; words: TimedWord[] }>
  /** Stops the script being written. */
  signal?: AbortSignal
  /** What the video has cost already (a script it replaces): the cap counts it, so the script is held to what is left. */
  spentBefore?: number
}

/**
 * Why Claude may not write a script now, in a sentence, or null when it
 * may: the most the script may cost (its line of a quote), with what the
 * video has cost already, would take it past the most it may cost (Settings'
 * limit, or less when the prompt asks for less).
 */
export function scriptRefused(brief: Brief, spentBefore: number, settings: { cap?: number | null }): string | null {
  if (brief.from !== 'topic') return null
  const cap = videoCap(brief, settings.cap)
  const most = scriptCost(brief.seconds)
  if (spentBefore + most <= cap + 1e-9) return null
  // The prompt's own amount, when it asked for less than Settings allows; Settings' limit otherwise.
  const asked = brief.cap !== null && brief.cap < (settings.cap ?? DEFAULT_CAP)
  const limit = asked ? `the ${dollars(cap)} you asked this video to cost` : `the ${dollars(cap)} a video may cost`
  if (spentBefore > 0)
    return `Writing the script again may cost up to ${dollars(most)}. With the ${dollars(spentBefore)} this video has cost already, that would take it past ${limit}, so I kept the script it has.${asked ? '' : ' Raise the limit in Settings to write it again.'}`
  return `Writing the script alone may cost up to ${dollars(most)}, more than ${limit}, so I didn't start it.${asked ? ' Ask for a higher amount to make it.' : ' Raise the limit in Settings to make it.'}`
}

/** The script for a brief: Claude's from the topic, the one pasted, or the person's recording heard here; and its quote. */
export async function draftFor(
  brief: Brief,
  id: string,
  deps: DraftDeps
): Promise<{ ok: true; draft: Draft } | { ok: false; message: string; cost: number }> {
  let title = cleanTopic(brief.topic)
  let script: string
  let scriptCost = 0
  let kept: Kept | undefined
  if (brief.from === 'script') script = brief.ask.replace(/^(?:here(?:'s| is) (?:my|the) script|script|narration|voice ?over)\s*[:-]\s*/i, '')
  else if (brief.from === 'recording') {
    // Heard first, here, so the quote counts the lines it really has; the run then uses these words as they are.
    if (!deps.hear) return { ok: false, message: 'I could not listen to your recording.', cost: 0 }
    let heard: { durationSec: number; words: TimedWord[] }
    try {
      heard = await deps.hear(brief.voice.id)
    } catch (err) {
      return { ok: false, message: `I could not listen to your recording. ${errText(err)}`, cost: 0 }
    }
    if (heard.words.length === 0) return { ok: false, message: 'I heard no words in your recording.', cost: 0 }
    script = heard.words.map((w) => w.text).join(' ')
    brief = { ...brief, seconds: Math.max(15, Math.round(heard.durationSec)), inferred: brief.inferred.filter((i) => !/ long$/.test(i)) }
    kept = {
      narration: {
        path: brief.voice.id,
        durationSec: heard.durationSec,
        sourceId: 's1',
        words: wordsFromTranscript(heard.words, 's1', 'w'),
        voice: brief.voice,
        timing: 'whisper'
      }
    }
  } else {
    // Held to the cap with what the video has cost already: refused before Claude is asked when it would pass
    // it, and given only what is left of it.
    const spentBefore = deps.spentBefore ?? 0
    const refused = scriptRefused(brief, spentBefore, deps.settings)
    if (refused) return { ok: false, message: refused, cost: 0 }
    const written = await writeScript(brief, deps.parse, {
      brandVoice: deps.brand.voice,
      brandName: deps.brand.name,
      signal: deps.signal,
      budget: new Budget(Math.max(0, videoCap(brief, deps.settings.cap) - spentBefore))
    })
    scriptCost = written.cost
    if (!written.ok) return { ok: false, message: written.message, cost: written.cost }
    script = scriptText(written.value)
    if (written.value.title.trim()) title = written.value.title.trim()
  }
  const { phrases, sections, headings } = phrasesAndSections(script)
  if (phrases.length === 0) return { ok: false, message: 'The script has no words to read.', cost: scriptCost }
  const draft: Draft = {
    id,
    brief,
    title,
    outline: headings.filter(Boolean),
    script,
    phrases,
    sections,
    scriptCost,
    ...(kept ? { kept } : {}),
    quote: null as unknown as Quote
  }
  draft.quote = quoteDraft(draft, deps)
  return { ok: true, draft }
}

/** The counts of the shots a stopped run has still to make, exactly, from the shot list it kept. */
function countsLeft(draft: Draft, plan: NonNullable<Draft['plan']>): Counts {
  const made = new Set(plan.made.filter((s) => s.file).map((s) => s.phrase))
  const left = plan.shots.filter((s) => !made.has(s.phrase))
  const characters = new Set(left.flatMap((s) => (s.visual.kind === 'still' || s.visual.kind === 'clip' ? s.visual.characters : [])))
  const sheets = Math.min(plan.sheetsLeft ?? 0, [...characters].filter((c) => !plan.sheets.some((h) => h.character === c)).length)
  const counts = countShots(left, {
    sheets: sheets + plan.sheets.length,
    clipSeconds: [],
    narrationSeconds: draft.kept?.narration?.durationSec ?? draft.brief.seconds,
    narrationChars: draft.script.length
  })
  return { ...counts, sheets }
}

/** The quote for a draft as it stands. */
export function quoteDraft(draft: Draft, deps: Pick<DraftDeps, 'can' | 'settings' | 'today'>): Quote {
  const counts = draft.unwritten
    ? estimateUnwritten(draft.brief)
    : draft.plan
      ? countsLeft(draft, draft.plan)
      : estimateCounts(draft.brief, draft.phrases.length ? draft.phrases : ['a'], draft.script)
  const quote = quoteFor(draft.brief, counts, deps.can, {
    today: deps.today,
    cap: deps.settings.cap,
    // Going ahead without asking is for a new video asked for in so many words: never a change of a
    // made one, read from what was typed, and never the rest of one that was stopped.
    autoUnder: draft.into || draft.plan || draft.spentBefore ? null : deps.settings.autoUnder,
    scriptWritten: !draft.unwritten,
    reuse: { narration: !!draft.kept?.narration, shots: !!draft.kept?.shots, plan: !!draft.plan },
    spent: draft.scriptCost + (draft.spentBefore ?? 0)
  })
  // A kept narration is read by the voice it was read by, whatever is available now.
  return draft.kept?.narration ? { ...quote, voice: draft.kept.narration.voice } : quote
}

/** A draft with an edited script: new phrases and a new quote. */
export function withScript(draft: Draft, script: string, deps: Pick<DraftDeps, 'can' | 'settings' | 'today'>): Draft {
  const { phrases, sections, headings } = phrasesAndSections(script)
  const next = { ...draft, script, phrases, sections, outline: headings.filter(Boolean) }
  const words = countWords(script)
  // An edited script runs as long as it takes to read.
  const brief = { ...next.brief, seconds: Math.max(15, Math.round((words / (next.brief.format === 'documentary' ? 140 : 158)) * 60)) }
  const out = { ...next, brief }
  return { ...out, quote: quoteDraft(out, deps) }
}

// ---------- Making it ----------

/** Dollars of the quote that go to the services making things: everything but Claude. */
export function servicesTotal(quote: Quote): number {
  return Math.round(quote.lines.filter((l) => !l.by.startsWith('Claude')).reduce((n, l) => n + l.cost, 0) * 10000) / 10000
}

async function readPicture(path: string): Promise<Picture> {
  const data = new Uint8Array(await fs.readFile(path))
  return { data, mime: /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.webp$/i.test(path) ? 'image/webp' : 'image/png' }
}

/** How long each phrase is on screen, in seconds, from the narration's words. */
function phraseLengths(phrases: string[], words: TimedWord[]): number[] {
  const ranges = phraseRanges(
    phrases,
    words.map((w) => w.text)
  )
  return ranges.map(([a, b], i) => {
    if (b < a) return 0
    const next = ranges[i + 1]?.[0]
    const end = next !== undefined && words[next] ? words[next].startSec : words[b].endSec + 0.6
    return Math.max(0.5, end - words[a].startSec)
  })
}

interface ShotsMade {
  shots: MadeShot[]
  sheets: Sheet[]
  notes: string[]
  files: Map<string, MadeFile>
  /** Map shots the map kind answered as a graphic over the ground, by phrase. */
  mapGraphics: Map<number, Omit<MotionCallInput, 'from'>>
  /** What stopped the shots partway: the picture service out of credit, or the key refused. */
  halted: ServiceError | null
}

/** A failure every later picture would meet as well: no credit left, a refused key, no key, the switch off. */
const allWouldFail = (err: unknown): err is ServiceError =>
  err instanceof ServiceError && (err.kind === 'no-credit' || err.kind === 'refused' || err.kind === 'no-key' || err.kind === 'off')

/**
 * Makes every shot of a planned list: sheets first, then stills and clips,
 * maps and grounds, all inside the budget. `keep` holds shots that are
 * already made and stay as they are (a remake that changes one shot).
 */
export async function makeShots(
  plan: { brief: Brief; bible: Bible; shots: Shot[]; images: ImageService; clips: ImageService | null; size: string; lengths: number[] },
  budget: Budget,
  deps: Pick<MakeRunDeps, 'services' | 'maps' | 'dir' | 'progress' | 'signal' | 'probe'> & {
    ground: string
    sheets?: Sheet[]
    keep?: Map<number, MadeShot>
    /** Counts every picture and clip made or found in the cache, for what a stop keeps. */
    tally?: { made: number }
    /** The shots and sheets made by a service so far, as they are made, for what a Stop keeps. */
    log?: { made: MadeShot[]; sheets: Sheet[] }
  },
  opts: { clipSeconds: number; maxSheets: number }
): Promise<ShotsMade> {
  const { brief, bible, images, size } = plan
  const cache = new MadeCache(deps.dir)
  // The first answer every later picture would get too (no credit left, a refused key) stops the shots
  // there, with one plain sentence, rather than shot by shot.
  let halted: ServiceError | null = null
  const halting = new AbortController()
  const signal = deps.signal ? AbortSignal.any([deps.signal, halting.signal]) : halting.signal
  const haltOn = (err: unknown): void => {
    if (halted || !allWouldFail(err)) return
    halted = err
    halting.abort()
  }
  const notes: string[] = []
  const files = new Map<string, MadeFile>()
  const mapGraphics = new Map<number, Omit<MotionCallInput, 'from'>>()
  const service = images === 'google' ? 'Google' : 'fal.ai'
  const record = async (path: string, video: boolean): Promise<void> => {
    if (files.has(path)) return
    const p = await deps.probe(path).catch(() => ({ durationSec: 0, width: 0, height: 0 }))
    files.set(path, { width: p.width, height: p.height, durationSec: video ? p.durationSec : null })
  }

  // Character sheets, for the characters most shots show, as many as were agreed.
  const sheets: Sheet[] = [...(deps.sheets ?? [])]
  const uses = new Map<string, number>()
  for (const s of plan.shots)
    if (s.visual.kind === 'still' || s.visual.kind === 'clip') for (const c of s.visual.characters) uses.set(c, (uses.get(c) ?? 0) + 1)
  const wanted = bible.characters
    .filter((c) => (uses.get(c.id) ?? 0) > 0 && !sheets.some((s) => s.character === c.id))
    .sort((a, b) => (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0))
    .slice(0, Math.max(0, opts.maxSheets - sheets.length))
  for (const c of wanted) {
    deps.progress(`Drawing ${c.name}'s character sheet`, null)
    const prompt = sheetPrompt(c, bible)
    const req: MadeRequest = { kind: 'image', service: images, model: deps.services.models.image[images], prompt, refs: [], aspect: 'wide', size }
    try {
      const made = await makeOnce(req, stillCost(images, size), { services: deps.services, cache, budget, signal }, () =>
        deps.services.image(images, prompt, [], { aspect: 'wide', size, signal })
      )
      if (deps.tally) deps.tally.made++
      const sheet: Sheet = { character: c.id, file: made.path, maker: images, cost: made.cost }
      sheets.push(sheet)
      deps.log?.sheets.push(sheet)
    } catch (err) {
      haltOn(err)
      if (halted) break
      notes.push(`I couldn't draw ${c.name}'s character sheet, so their shots are made from the description alone. ${errText(err)}`)
    }
  }
  const sheetOf = new Map(sheets.map((s) => [s.character, s.file]))

  // The shots, four at a time.
  const total = plan.shots.length
  let done = 0
  const made = await inTurn(
    plan.shots,
    4,
    async (shot, i): Promise<MadeShot> => {
      const kept = deps.keep?.get(shot.phrase)
      const beatLen = plan.lengths[shot.phrase] ?? 4
      const base: MadeShot = { ...shot, beat: '', file: null, maker: null, model: null, cost: 0, key: null, note: null }
      const finish = (s: MadeShot, fresh = true): MadeShot => {
        done++
        if (fresh && (s.maker === 'google' || s.maker === 'fal') && s.file) deps.log?.made.push(s)
        deps.progress(`Making the shots with ${service}: ${done} of ${total}`, Math.round((done / total) * 100))
        return s
      }
      if (kept) {
        if (kept.file) await record(kept.file, kept.visual.kind === 'clip' || kept.visual.kind === 'broll')
        return finish(kept, false)
      }
      const v = shot.visual
      try {
        if (v.kind === 'map') {
          const map = await deps.maps.make({ place: v.place, seconds: beatLen, style: brief.format, aspect: brief.aspect })
          if (map.kind === 'still') {
            await record(map.path, false)
            return finish({ ...base, file: map.path, maker: 'local', model: 'Cutalong map' })
          }
          // A map graphic over the ground (the map kind, when it lands): assembly puts it on the beat.
          mapGraphics.set(shot.phrase, map.call)
          await record(deps.ground, false)
          return finish({ ...base, file: deps.ground, maker: 'local', model: 'map' })
        }
        if (v.kind === 'card' || v.kind === 'graphic') {
          await record(deps.ground, false)
          return finish({ ...base, file: deps.ground, maker: 'local', model: null })
        }
        const visual = v.kind === 'broll' ? { kind: 'still' as const, prompt: v.search, move: 'push-in' as const, characters: [] } : v
        const prompt = promptFor(visual, bible, brief.format, brief.aspect)
        const refs = await Promise.all(
          visual.characters
            .map((c) => sheetOf.get(c))
            .filter((p): p is string => !!p)
            .map(readPicture)
        )
        const req: MadeRequest = { kind: 'image', service: images, model: deps.services.models.image[images], prompt, refs, aspect: brief.aspect, size }
        const still = await makeOnce(req, stillCost(images, size, refs.length), { services: deps.services, cache, budget, signal }, () =>
          deps.services.image(images, prompt, refs, { aspect: brief.aspect, size, signal })
        )
        if (deps.tally) deps.tally.made++
        let file = still.path
        let cost = still.cost
        let model = deps.services.models.image[images]
        let note: string | null = null
        if (visual.kind === 'clip' && plan.clips) {
          // Only as long as the beat needs, up to what was quoted; the cut slows a short clip to fill its beat.
          const seconds = Math.min(opts.clipSeconds, Math.max(PRICES.clips[plan.clips].minSec, Math.ceil(beatLen)))
          const first = await readPicture(still.path)
          const motion = `${visual.prompt} ${visual.motion}`.trim()
          const clipReq: MadeRequest = { kind: 'clip', service: plan.clips, model: deps.services.models.clip[plan.clips], prompt: motion, refs: [first], aspect: brief.aspect, seconds }
          try {
            const clip = await makeOnce(clipReq, clipCost(plan.clips, seconds), { services: deps.services, cache, budget, signal }, () =>
              deps.services.clip(plan.clips as ImageService, motion, first, { aspect: brief.aspect, seconds, signal })
            )
            if (deps.tally) deps.tally.made++
            file = clip.path
            cost += clip.cost
            model = deps.services.models.clip[plan.clips]
          } catch (err) {
            haltOn(err)
            note = err instanceof OverBudget ? 'The clip would have passed the agreed total, so this shot is its still.' : `The clip could not be made, so this shot is its still. ${errText(err)}`
          }
        }
        await record(file, /\.(mp4|mov|webm)$/i.test(file))
        return finish({ ...base, file, maker: images, model, cost, key: null, note })
      } catch (err) {
        haltOn(err)
        // A plain card holds the beat until the shot is asked for again.
        await record(deps.ground, false)
        const why =
          err instanceof OverBudget
            ? 'it would have passed the agreed total'
            : err instanceof NotKept || acceptedJob(err)
              ? `${errText(err).replace(/[.\s]+$/, '')}, and it is counted in what was spent`
              : errText(err).replace(/[.\s]+$/, '')
        return finish({ ...base, file: deps.ground, maker: 'local', note: `Shot ${i + 1} is a plain card for now: ${why}.` })
      }
    },
    signal
  )
  for (const s of made) if (s?.note) notes.push(s.note)
  return { shots: made.filter(Boolean), sheets, notes, files, mapGraphics, halted }
}

/** The narration's words and file: read in the chosen voice, or the creator's own recording heard here. */
async function narration(
  draft: Draft,
  voice: VoiceChoice,
  budget: Budget,
  deps: MakeRunDeps,
  notes: string[]
): Promise<Heard> {
  if (voice.engine === 'own') {
    const facts = await deps.probe(voice.id)
    deps.progress('Listening to your recording', 0)
    const words = await deps.transcribe(voice.id, facts.durationSec, (_stage, p) => deps.progress('Listening to your recording', p))
    return { path: voice.id, durationSec: facts.durationSec, words, timing: 'whisper', voice, cost: 0 }
  }
  const today = new Date().toISOString().slice(0, 10)
  let reader = voice
  const price = voiceCost(voice, draft.script.length, (countWords(draft.script) / (draft.brief.format === 'documentary' ? 140 : 158)) * 60, today)
  if (price > 0 && !budget.reserve(price)) {
    reader = defaultVoice(draft.brief.format)
    notes.push(`${voice.name} would have passed the agreed total, so ${reader.name} read it on this Mac.`)
  }
  // A service's reading is spent section by section, as each arrives: one that stops partway is paid for what it read.
  let held = reader === voice ? price : 0
  let paid = 0
  const onRead = (chars: number, seconds: number): void => {
    const cost = voiceCost(reader, chars, seconds, today)
    const off = Math.min(held, cost)
    held -= off
    budget.commit(off, cost)
    paid += cost
  }
  const onProgress = (f: number, stage: string): void => deps.progress(stage, Math.round(f * 100))
  const input = (v: VoiceChoice): Parameters<typeof narrate>[0] => ({ phrases: draft.phrases, sections: draft.sections, voice: v, format: draft.brief.format })
  const base = { services: deps.services, local: deps.local, ffmpeg: deps.ffmpeg, dir: deps.dir, signal: deps.signal, onProgress }
  let read
  try {
    read = await narrate(input(reader), { ...base, onRead: reader.engine === 'local' ? undefined : onRead })
  } catch (err) {
    budget.release(held)
    held = 0
    if (reader.engine === 'local' || deps.signal?.aborted) throw err
    // A service that could not read it: the voice on this Mac reads it instead, and what it read is said.
    const first = reader
    reader = defaultVoice(draft.brief.format)
    const before = paid > 0 ? ` What ${first.name} read before that cost ${dollars(paid)}, and is counted in what was spent.` : ''
    notes.push(`${first.name} could not read it (${errText(err).replace(/[.\s]+$/, '')}), so ${reader.name} read it on this Mac.${before}`)
    read = await narrate(input(reader), base)
  }
  // What the quote held over what the reading came to.
  budget.release(held)
  const cost = reader === voice ? Math.round(paid * 10000) / 10000 : 0
  if (read.words && read.words.length > 0)
    return { path: read.path, durationSec: read.durationSec, words: read.words, timing: 'voice', voice: reader, cost }
  deps.progress('Narrating the script: timing every word', 0)
  // Whisper's own stages ("Done") would read as the whole video being done; this is one step of it.
  const words = await deps.transcribe(read.path, read.durationSec, (_stage, p) => deps.progress('Narrating the script: timing every word', p), {
    phrases: draft.phrases,
    spans: read.spans
  })
  return { path: read.path, durationSec: read.durationSec, words, timing: 'whisper', voice: reader, cost }
}

/** The narration as the run has it: its file, its words, who read it and what it cost. */
interface Heard {
  path: string
  durationSec: number
  words: TimedWord[]
  timing: 'voice' | 'whisper'
  voice: VoiceChoice
  cost: number
}

/** What a stopped run keeps: the shot list, the narration and the pictures made so far. */
export interface KeptSoFar {
  plan: boolean
  narration: boolean
  pictures: number
}

/**
 * A video stopped while it was being made: what was spent, Claude included,
 * what is kept, and the draft to go on from, which buys none of it again.
 */
export class Stopped extends Error {
  constructor(
    readonly spent: number,
    readonly quoted: number,
    readonly kept: KeptSoFar,
    readonly resume: Draft,
    /** Why, when a service stopped it rather than the person: "Google Gemini says the account has no credit left." */
    readonly reason: string | null = null
  ) {
    super(stoppedSentence(spent, quoted, kept, reason))
    this.name = 'Stopped'
  }
}

/** The shots stopped by a service's answer every later picture would get too. */
class Halted extends Error {
  constructor(readonly cause: ServiceError) {
    super(cause.message)
    this.name = 'Halted'
  }
}

/** The one sentence a stop is answered with. */
export function stoppedSentence(spent: number, quoted: number, kept: KeptSoFar, reason: string | null = null): string {
  const parts = [
    kept.plan ? 'the shot list' : '',
    kept.narration ? 'the narration' : '',
    kept.pictures > 0 ? `the ${kept.pictures} ${kept.pictures === 1 ? 'picture' : 'pictures'} already made` : ''
  ].filter(Boolean)
  const one = parts.length === 1 && !(kept.pictures > 1 && !kept.plan && !kept.narration)
  const said = listOf(parts)
  const keeps = parts.length ? ` ${said.charAt(0).toUpperCase()}${said.slice(1)} ${one ? 'is' : 'are'} kept, so making the rest reuses ${one ? 'it' : 'them'}.` : ''
  const lead = reason ? `${reason.replace(/[.\s]+$/, '')}, so I stopped there` : 'Stopped'
  if (spent <= 0)
    return parts.length
      ? `${lead} before anything was paid for.${keeps}`
      : `${lead} before anything was made, so nothing of the ${dollars(quoted)} quoted was spent.`
  return `${lead}: ${dollars(spent)} of the ${dollars(quoted)} quoted was spent.${keeps || ' Nothing was made yet.'}`
}

/** A video that could not be made: why, and what it had spent by then, Claude included. */
export class MakeFailed extends Error {
  constructor(
    reason: string,
    readonly spent: number,
    readonly quoted: number
  ) {
    super(
      `${reason.replace(/[.\s]+$/, '')}. ${spent > 0 ? `${dollars(spent)} of the ${dollars(quoted)} quoted was spent before it stopped.` : 'Nothing of the quote was spent.'}`
    )
    this.name = 'MakeFailed'
  }
}

/** Where a run has got to, kept as it goes, so a Stop knows what it keeps. */
interface RunState {
  /** The draft as it now is: with its script, once one written after the quote is in. */
  draft: Draft
  plan: { bible: Bible; shots: Shot[] } | null
  heard: Heard | null
  log: { made: MadeShot[]; sheets: Sheet[] }
  /** The character sheets the quote allowed for. */
  sheets: number
  tally: { made: number }
}

/** The draft a stopped run goes on from: what it kept, and what it had spent. */
function resumeOf(state: RunState, spent: number): Draft {
  const d = state.draft
  const before = Math.round(((d.spentBefore ?? 0) + spent) * 10000) / 10000
  // Stopped before the script was written: the same quote again, with what was spent counted.
  if (d.unwritten) return { ...d, spentBefore: before }
  const kept: Kept = { ...d.kept }
  const heard = state.heard
  if (heard && !kept.narration) {
    const sid = d.into?.sourceId ?? 's1'
    kept.narration = {
      path: heard.path,
      durationSec: heard.durationSec,
      sourceId: sid,
      words: wordsFromTranscript(heard.words, sid, sid === 's1' ? 'w' : `${sid}w`),
      voice: heard.voice,
      timing: heard.timing,
      cost: heard.cost
    }
  }
  const made = [...(d.plan?.made ?? []), ...state.log.made]
  const sheets = [...(d.plan?.sheets ?? []), ...state.log.sheets.filter((h) => !(d.plan?.sheets ?? []).some((k) => k.character === h.character))]
  const plan = state.plan
    ? { bible: state.plan.bible, shots: state.plan.shots, sheets, made, sheetsLeft: Math.max(0, state.sheets - sheets.length) }
    : d.plan
  return {
    ...d,
    ...(kept.narration || kept.shots ? { kept } : {}),
    ...(plan ? { plan } : {}),
    spentBefore: before
  }
}

/** The finished video: the made edit, what it cost, and the reply that says so. Stopped, it says what was spent and kept. */
export async function makeVideo(draft: Draft, deps: MakeRunDeps): Promise<{ doc: EditDoc; reply: Reply; spent: number }> {
  if (!draft.quote.images && !draft.kept?.shots) throw new Error(draft.quote.missing[0] ?? 'There is no service to make the pictures.')
  // Everything this run spends is held to the quote confirmed: Claude to its own lines, from a budget of
  // its own, and the narration, pictures and clips to theirs, so Claude never takes a quoted picture's money.
  const claudeTotal = Math.round(draft.quote.lines.filter((l) => l.by.startsWith('Claude')).reduce((n, l) => n + l.cost, 0) * 10000) / 10000
  const claude = new Budget(claudeTotal)
  const budget = new Budget(Math.round((draft.quote.total - claudeTotal) * 10000) / 10000)
  const spent = (): number => Math.round((budget.spent + claude.spent) * 10000) / 10000
  const state: RunState = {
    draft,
    plan: draft.plan ? { bible: draft.plan.bible, shots: draft.plan.shots } : null,
    heard: null,
    log: { made: [], sheets: [] },
    sheets: draft.plan ? (draft.plan.sheetsLeft ?? 0) + draft.plan.sheets.length : draft.quote.counts.sheets,
    tally: { made: (draft.plan?.made.length ?? 0) + (draft.plan?.sheets.length ?? 0) }
  }
  try {
    return await makeVideoWith(draft, deps, budget, claude, state)
  } catch (err) {
    // Stopped by the person, or by a picture service every later picture would hear from too: what was
    // spent, what is kept, and a draft to go on from once the person has seen to it.
    if (deps.signal?.aborted || err instanceof Halted) {
      const resume = resumeOf(state, spent())
      const kept = {
        plan: !!resume.plan,
        narration: !!resume.kept?.narration && resume.kept.narration.voice.engine !== 'own',
        pictures: state.tally.made
      }
      throw new Stopped(spent(), draft.quote.total, kept, resume, err instanceof Halted && !deps.signal?.aborted ? err.cause.message : null)
    }
    throw new MakeFailed(errText(err), spent(), draft.quote.total)
  }
}

async function makeVideoWith(
  draft: Draft,
  deps: MakeRunDeps,
  budget: Budget,
  claude: Budget,
  state: RunState
): Promise<{ doc: EditDoc; reply: Reply; spent: number }> {
  const notes: string[] = []
  // A script asked for at a new length is written now its quote is confirmed, held to the quote like the rest.
  if (draft.unwritten) {
    deps.progress('Writing the script again', null)
    const written = await writeScript(draft.brief, deps.parse, {
      brandVoice: draft.unwritten.voice,
      brandName: draft.unwritten.name,
      signal: deps.signal,
      budget: claude,
      hold: draft.quote.lines.find((l) => l.what === 'The script')?.cost
    })
    if (!written.ok) throw new Error(written.message)
    const script = scriptText(written.value)
    const parts = phrasesAndSections(script)
    if (parts.phrases.length === 0) throw new Error('The script came back with no words to read.')
    const title = written.value.title.trim() || draft.title
    const { unwritten: _written, ...rest } = draft
    draft = { ...rest, title, script, phrases: parts.phrases, sections: parts.sections, outline: parts.headings.filter(Boolean) }
    state.draft = draft
  }
  const { brief, quote } = draft
  const images = quote.images
  if (!images && !draft.kept?.shots) throw new Error('There is no service to make the pictures.')

  // The narration and the shot list at once: neither needs the other.
  const keptVoice = draft.kept?.narration
  const keptShots = draft.kept?.shots
  const resumed = draft.plan
  if (!keptVoice) deps.progress(brief.voice.engine === 'own' ? 'Listening to your recording' : 'Narrating the script', null)
  else if (!keptShots && !resumed) deps.progress('Planning the shots', null)
  const narrated: Promise<Heard> = keptVoice
    ? Promise.resolve({
        path: keptVoice.path,
        durationSec: keptVoice.durationSec,
        words: keptVoice.words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec })),
        timing: keptVoice.timing,
        voice: keptVoice.voice,
        cost: keptVoice.cost ?? 0
      })
    : narration(draft, quote.voice, budget, deps, notes)
  let ownScript: { phrases: string[]; sections: number[] } | null = null
  if (!keptVoice && brief.voice.engine === 'own' && draft.phrases.length === 0) {
    // The recording's own words are the script.
    const heard = await narrated
    const text = heard.words.map((w) => w.text).join(' ')
    const parts = phrasesAndSections(text)
    ownScript = { phrases: parts.phrases, sections: [0] }
    draft = { ...draft, script: text, phrases: parts.phrases, sections: [0] }
    state.draft = draft
  }
  const maxClips = quote.clips ? quote.counts.clips : 0
  const planning = (async (): Promise<CheckedShots & { cost: number; note: string | null }> => {
    if (keptShots) return { bible: keptShots.bible, shots: keptShots.shots, mended: [], cost: 0, note: null }
    if (resumed) return { bible: resumed.bible, shots: resumed.shots, mended: [], cost: 0, note: null }
    const r = await planShots(
      brief,
      draft.phrases,
      { sections: draft.sections, outline: draft.outline, maxClips, signal: deps.signal, budget: claude, narrationSeconds: quote.counts.narrationSeconds },
      deps.parse
    )
    if (r.ok) return { ...r.value, cost: r.cost, note: null }
    if (deps.signal?.aborted) throw new Error('Stopped.')
    // Claude could not plan them: each shot shows what its line says, in the format's own style.
    return { ...localShotList(brief, draft.phrases), cost: r.cost, note: `Claude could not plan the shots (${r.message.replace(/[.\s]+$/, '')}), so each one shows what its line says.` }
  })()
  // Its failure is read where it is awaited, after the narration.
  planning.catch(() => undefined)
  let heard: Heard
  try {
    heard = await narrated
  } catch (err) {
    // The shot list settles first, so whatever Claude cost is in what is said was spent.
    await planning.catch(() => undefined)
    throw err
  }
  state.heard = keptVoice ? null : heard
  // The narration is in; the plan may still be coming.
  if (!keptShots && !resumed) deps.progress('Planning the shots', null)
  const planned = await planning
  if (planned.note) notes.push(planned.note)

  const lengths = phraseLengths(draft.phrases, heard.words)
  const size = quote.size
  // The shots fitted to what is left of what was agreed (shots already made before a Stop cost nothing now).
  const madeBefore = new Map((resumed?.made ?? []).map((s) => [s.phrase, s]))
  const fit = keptShots
    ? { shots: planned.shots, downgraded: 0 }
    : fitShots(planned.shots, budget.room, (s) =>
        madeBefore.has(s.phrase) ? 0 : shotCost(s.visual, images as ImageService, quote.clips, { size, clipSeconds: quote.counts.clipSeconds })
      )
  if (!keptShots) state.plan = { bible: planned.bible, shots: fit.shots }
  if (fit.downgraded > 0) notes.push(`${fit.downgraded === 1 ? 'One clip is' : `${fit.downgraded} clips are`} a still instead, to stay inside the quote.`)
  const ground = await groundFor(brief.format, brief.aspect, deps.dir)
  const made = keptShots
    ? await keptFiles(keptShots, deps.probe)
    : await makeShots(
        { brief, bible: planned.bible, shots: fit.shots, images: images as ImageService, clips: quote.clips, size, lengths },
        budget,
        {
          ...deps,
          ground,
          tally: state.tally,
          log: state.log,
          ...(resumed ? { keep: madeBefore, sheets: resumed.sheets } : {})
        },
        { clipSeconds: quote.counts.clipSeconds, maxSheets: Math.max(state.sheets, 0) }
      )
  notes.push(...made.notes)
  // Stopped while the shots were made, or a service stopped them: nothing is put together.
  if (deps.signal?.aborted) throw new Error('Stopped.')
  if (made.halted) throw new Halted(made.halted)
  // Kept shots keep their maps: the map graphics are drawn again for each beat's new length (free, on this Mac).
  if (keptShots)
    for (const s of made.shots) {
      if (s.visual.kind !== 'map' || s.model !== 'map') continue
      const map = await deps.maps
        .make({ place: s.visual.place, seconds: Math.max(1.5, lengths[s.phrase] ?? 4), style: brief.format, aspect: brief.aspect })
        .catch(() => null)
      if (map?.kind === 'motion') made.mapGraphics.set(s.phrase, map.call)
    }

  deps.progress('Looking for music in your Music folder', null)
  const music = await deps.findMusic(brief.format).catch(() => null)
  deps.progress('Putting the story together', null)

  // What this run spent, Claude included, against its quote; and what the video has cost in all.
  const runSpent = Math.round((budget.spent + claude.spent) * 10000) / 10000
  const make: Make = {
    v: 1,
    brief: ownScript ? { ...brief, from: 'recording' } : brief,
    title: draft.title,
    outline: draft.outline,
    script: draft.script,
    phrases: draft.phrases,
    sections: draft.sections,
    bible: planned.bible,
    shots: made.shots,
    sheets: made.sheets,
    narration: { path: heard.path, voice: heard.voice, timing: heard.timing, durationSec: heard.durationSec, cost: heard.cost },
    images: images ?? ((draft.kept?.shots?.shots.find((s) => s.maker === 'google' || s.maker === 'fal')?.maker ?? 'google') as ImageService),
    clips: quote.clips,
    spent: Math.round((draft.scriptCost + (draft.spentBefore ?? 0) + runSpent) * 10000) / 10000
  }
  const { doc, unheard, rejected } = assembleDoc({
    id: draft.id,
    make,
    words: heard.words,
    ground,
    files: made.files,
    mapGraphics: made.mapGraphics,
    music,
    sourceId: keptVoice?.sourceId ?? draft.into?.sourceId ?? 's1',
    ...(keptVoice ? { docWords: keptVoice.words } : {})
  })
  if (rejected.length) console.warn('[make] left out of the edit:', rejected)
  // Each shot knows the beat it covers.
  const beatOf = new Map(doc.versions[0].cut.beats.map((b, i) => [i, b.id]))
  let k = 0
  const phraseBeat = new Map<number, string>()
  draft.phrases.forEach((_, i) => {
    if (unheard.includes(i)) return
    phraseBeat.set(i, beatOf.get(k++) ?? '')
  })
  if (doc.make) doc.make = { ...doc.make, shots: doc.make.shots.map((s) => ({ ...s, beat: phraseBeat.get(s.phrase) ?? '' })) }
  if (!music) notes.push('I found no music for it in your Music folder. Drop a track in and I’ll put it under the narration.')
  if (unheard.length) notes.push(`${unheard.length === 1 ? 'One line was' : `${unheard.length} lines were`} not heard in the narration, so ${unheard.length === 1 ? 'it has' : 'they have'} no shot.`)

  const reply = madeReply(doc, make, quote, notes, runSpent)
  return { doc, reply, spent: runSpent }
}

/** Shots kept as they were: their files measured again for the edit, nothing made. */
async function keptFiles(kept: NonNullable<Kept['shots']>, probe: MakeRunDeps['probe']): Promise<ShotsMade> {
  const files = new Map<string, MadeFile>()
  for (const s of kept.shots) {
    if (!s.file || files.has(s.file)) continue
    const p = await probe(s.file).catch(() => ({ durationSec: 0, width: 0, height: 0 }))
    const video = s.visual.kind === 'clip' || s.visual.kind === 'broll'
    files.set(s.file, { width: p.width, height: p.height, durationSec: video ? p.durationSec : null })
  }
  return { shots: kept.shots.map((s) => ({ ...s, cost: 0 })), sheets: kept.sheets, notes: [], files, mapGraphics: new Map(), halted: null }
}

/** What was made, in Cutalong's voice: a sentence, three facts, and the rest behind Details. `spent` is this run's, against its quote. */
export function madeReply(doc: EditDoc, make: Make, quote: Quote, notes: string[], spent = make.spent): Reply {
  const kind = make.brief.format === 'documentary' ? 'documentary' : 'explainer'
  const seconds = make.narration.durationSec
  const service = make.images === 'google' ? 'Google' : 'fal.ai'
  const madeBy = make.shots.filter((s) => s.maker === make.images).length
  const text = `v1 is ready: a ${clock(seconds)} ${kind} about ${make.brief.topic}, ${make.shots.length} shots. It cost ${dollars(spent)} of the ${dollars(quote.total)} quoted.`
  const before = Math.round((make.spent - spent) * 10000) / 10000
  const disclose =
    make.brief.format === 'documentary'
      ? 'Its pictures are made, not archival: YouTube asks you to mark realistic made pictures as altered or synthetic when you upload.'
      : null
  const aside = [...notes, disclose].filter(Boolean).join(' ') || null
  return {
    text,
    aside,
    chips: [clock(seconds), `${make.shots.length} shots`, dollars(spent)],
    details: [
      { label: 'Narration', value: `${voicePhrase(make.narration.voice)}${make.narration.cost ? `: ${dollars(make.narration.cost)}` : ''}` },
      { label: 'Pictures', value: `${madeBy} made by ${service}` },
      {
        label: 'Spent',
        value: `${dollars(spent)}, of ${dollars(quote.total)} quoted${before > 0 ? `, and ${dollars(before)} on this video before that` : ''}`
      },
      { label: 'What went where', value: quote.sends.join(' ') }
    ]
  }
}

// ---------- Asked again: the brief before it is made ----------

/** A pending brief changed by what was said next, re-quoted; null when the words change nothing. */
export function revise(draft: Draft, text: string, deps: Pick<DraftDeps, 'can' | 'settings' | 'today'>): { draft: Draft; changed: string[] } | null {
  const r = reviseBrief(draft.brief, text)
  if (!r) return null
  const next = { ...draft, brief: r.brief }
  return { draft: { ...next, quote: quoteDraft(next, deps) }, changed: r.changed }
}

export { readAsk, listOf, shotListCost }
