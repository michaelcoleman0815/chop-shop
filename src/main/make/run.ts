import { promises as fs } from 'fs'
import { clock } from '../../shared/presets/preset'
import type { Music } from '../../shared/edit/audio'
import type { EditDoc } from '../../shared/edit/schema'
import type { Draft, Kept, Reply } from '../../shared/make/draft'
import { readAsk, reviseBrief, cleanTopic } from '../../shared/make/brief'
import { assembleDoc, type Carry, type MadeFile } from '../../shared/make/assemble'
import type { MapShots } from '../../shared/make/map'
import { PRICES } from '../../shared/make/prices'
import {
  dollars,
  estimateCounts,
  listOf,
  quoteFor,
  shotListCost,
  stillCost,
  clipCost,
  voiceCost,
  type Availability,
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
import { Budget, inTurn, MadeCache, makeOnce, OverBudget, type MadeRequest } from './generate'
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
 * and graphics are made on this Mac. Nothing is asked of a service that would
 * take the spending past the quote. What could not be made is said plainly,
 * and the shot shows a plain card until it is asked for again.
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
}

/** The script for a brief: Claude's from the topic, or the one pasted, and its quote. */
export async function draftFor(
  brief: Brief,
  id: string,
  deps: DraftDeps
): Promise<{ ok: true; draft: Draft } | { ok: false; message: string }> {
  let title = cleanTopic(brief.topic)
  let script: string
  let scriptCost = 0
  if (brief.from === 'script') script = brief.ask.replace(/^(?:here(?:'s| is) (?:my|the) script|script|narration|voice ?over)\s*[:-]\s*/i, '')
  else if (brief.from === 'recording') script = ''
  else {
    const written = await writeScript(brief, deps.parse, { brandVoice: deps.brand.voice, brandName: deps.brand.name })
    scriptCost = written.cost
    if (!written.ok) return { ok: false, message: written.message }
    script = scriptText(written.value)
    if (written.value.title.trim()) title = written.value.title.trim()
  }
  const { phrases, sections, headings } = phrasesAndSections(script)
  if (brief.from !== 'recording' && phrases.length === 0) return { ok: false, message: 'The script has no words to read.' }
  const draft: Draft = { id, brief, title, outline: headings.filter(Boolean), script, phrases, sections, scriptCost, quote: null as unknown as Quote }
  draft.quote = quoteDraft(draft, deps)
  return { ok: true, draft }
}

/** The quote for a draft as it stands. */
export function quoteDraft(draft: Draft, deps: Pick<DraftDeps, 'can' | 'settings' | 'today'>): Quote {
  const counts = estimateCounts(draft.brief, draft.phrases.length ? draft.phrases : ['a'], draft.script)
  const quote = quoteFor(draft.brief, counts, deps.can, {
    today: deps.today,
    cap: deps.settings.cap,
    autoUnder: deps.settings.autoUnder,
    scriptWritten: true,
    reuse: { narration: !!draft.kept?.narration, shots: !!draft.kept?.shots }
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
}

/**
 * Makes every shot of a planned list: sheets first, then stills and clips,
 * maps and grounds, all inside the budget. `keep` holds shots that are
 * already made and stay as they are (a remake that changes one shot).
 */
export async function makeShots(
  plan: { brief: Brief; bible: Bible; shots: Shot[]; images: ImageService; clips: ImageService | null; size: string; lengths: number[] },
  budget: Budget,
  deps: Pick<MakeRunDeps, 'services' | 'maps' | 'dir' | 'progress' | 'signal' | 'probe'> & { ground: string; sheets?: Sheet[]; keep?: Map<number, MadeShot> },
  opts: { clipSeconds: number; maxSheets: number }
): Promise<ShotsMade> {
  const { brief, bible, images, size } = plan
  const cache = new MadeCache(deps.dir)
  const notes: string[] = []
  const files = new Map<string, MadeFile>()
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
      const made = await makeOnce(req, stillCost(images, size), { services: deps.services, cache, budget, signal: deps.signal }, () =>
        deps.services.image(images, prompt, [], { aspect: 'wide', size, signal: deps.signal })
      )
      sheets.push({ character: c.id, file: made.path, maker: images, cost: made.cost })
    } catch (err) {
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
      const finish = (s: MadeShot): MadeShot => {
        done++
        deps.progress(`Making ${total} shots with ${service}`, Math.round((done / total) * 100))
        return s
      }
      if (kept) {
        if (kept.file) await record(kept.file, kept.visual.kind === 'clip' || kept.visual.kind === 'broll')
        return finish(kept)
      }
      const v = shot.visual
      try {
        if (v.kind === 'map') {
          const map = await deps.maps.make({ place: v.place, seconds: beatLen, style: brief.format, aspect: brief.aspect })
          if (map.kind === 'still') {
            await record(map.path, false)
            return finish({ ...base, file: map.path, maker: 'local', model: 'Cutalong map' })
          }
          // A map graphic over the ground (the map kind, when it lands).
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
        const still = await makeOnce(req, stillCost(images, size, refs.length), { services: deps.services, cache, budget, signal: deps.signal }, () =>
          deps.services.image(images, prompt, refs, { aspect: brief.aspect, size, signal: deps.signal })
        )
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
            const clip = await makeOnce(clipReq, clipCost(plan.clips, seconds), { services: deps.services, cache, budget, signal: deps.signal }, () =>
              deps.services.clip(plan.clips as ImageService, motion, first, { aspect: brief.aspect, seconds, signal: deps.signal })
            )
            file = clip.path
            cost += clip.cost
            model = deps.services.models.clip[plan.clips]
          } catch (err) {
            note = err instanceof OverBudget ? 'The clip would have passed the agreed total, so this shot is its still.' : `The clip could not be made, so this shot is its still. ${errText(err)}`
          }
        }
        await record(file, /\.(mp4|mov|webm)$/i.test(file))
        return finish({ ...base, file, maker: images, model, cost, key: null, note })
      } catch (err) {
        // A plain card holds the beat until the shot is asked for again.
        await record(deps.ground, false)
        const why = err instanceof OverBudget ? 'it would have passed the agreed total' : errText(err).replace(/[.\s]+$/, '')
        return finish({ ...base, file: deps.ground, maker: 'local', note: `Shot ${i + 1} is a plain card for now: ${why}.` })
      }
    },
    deps.signal
  )
  for (const s of made) if (s?.note) notes.push(s.note)
  return { shots: made.filter(Boolean), sheets, notes, files }
}

/** The narration's words and file: read in the chosen voice, or the creator's own recording heard here. */
async function narration(
  draft: Draft,
  voice: VoiceChoice,
  budget: Budget,
  deps: MakeRunDeps,
  notes: string[]
): Promise<{ path: string; durationSec: number; words: TimedWord[]; timing: 'voice' | 'whisper'; voice: VoiceChoice; cost: number }> {
  if (voice.engine === 'own') {
    const facts = await deps.probe(voice.id)
    deps.progress('Listening to your recording', 0)
    const words = await deps.transcribe(voice.id, facts.durationSec, (stage, p) => deps.progress(stage, p))
    return { path: voice.id, durationSec: facts.durationSec, words, timing: 'whisper', voice, cost: 0 }
  }
  let reader = voice
  const price = voiceCost(voice, draft.script.length, (countWords(draft.script) / (draft.brief.format === 'documentary' ? 140 : 158)) * 60, new Date().toISOString().slice(0, 10))
  if (price > 0 && !budget.reserve(price)) {
    reader = defaultVoice(draft.brief.format)
    notes.push(`${voice.name} would have passed the agreed total, so ${reader.name} read it on this Mac.`)
  }
  let read
  try {
    read = await narrate(
      { phrases: draft.phrases, sections: draft.sections, voice: reader, format: draft.brief.format },
      {
        services: deps.services,
        local: deps.local,
        ffmpeg: deps.ffmpeg,
        dir: deps.dir,
        signal: deps.signal,
        onProgress: (f, stage) => deps.progress(stage, Math.round(f * 100))
      }
    )
  } catch (err) {
    if (reader !== voice) budget.release(0)
    else if (price > 0) budget.release(price)
    if (reader.engine === 'local') throw err
    // A service that could not read it: the voice on this Mac reads it instead.
    reader = defaultVoice(draft.brief.format)
    notes.push(`${voice.name} could not read it (${errText(err).replace(/[.\s]+$/, '')}), so ${reader.name} read it on this Mac.`)
    read = await narrate(
      { phrases: draft.phrases, sections: draft.sections, voice: reader, format: draft.brief.format },
      { services: deps.services, local: deps.local, ffmpeg: deps.ffmpeg, dir: deps.dir, signal: deps.signal, onProgress: (f, stage) => deps.progress(stage, Math.round(f * 100)) }
    )
  }
  const cost = reader === voice ? price : 0
  if (reader === voice && price > 0) budget.commit(price, price)
  if (read.words && read.words.length > 0)
    return { path: read.path, durationSec: read.durationSec, words: read.words, timing: 'voice', voice: reader, cost }
  deps.progress('Listening to the narration for its timing', 0)
  const words = await deps.transcribe(read.path, read.durationSec, (stage, p) => deps.progress(stage, p), {
    phrases: draft.phrases,
    spans: read.spans
  })
  return { path: read.path, durationSec: read.durationSec, words, timing: 'whisper', voice: reader, cost }
}

/** The finished video: the made edit, what it cost, and the reply that says so. */
export async function makeVideo(draft: Draft, deps: MakeRunDeps): Promise<{ doc: EditDoc; reply: Reply; spent: number }> {
  const { brief, quote } = draft
  if (!quote.images) throw new Error(quote.missing[0] ?? 'There is no service to make the pictures.')
  const budget = new Budget(servicesTotal(quote))
  const notes: string[] = []

  // The narration and the shot list at once: neither needs the other.
  const keptVoice = draft.kept?.narration
  const keptShots = draft.kept?.shots
  if (!keptVoice) deps.progress(brief.voice.engine === 'own' ? 'Listening to your recording' : 'Reading the script', null)
  const narrated = keptVoice
    ? Promise.resolve({
        path: keptVoice.path,
        durationSec: keptVoice.durationSec,
        words: keptVoice.words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec })),
        timing: keptVoice.timing,
        voice: keptVoice.voice,
        cost: 0
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
  }
  const maxClips = quote.clips ? quote.counts.clips : 0
  const planning = (async (): Promise<CheckedShots & { cost: number; note: string | null }> => {
    if (keptShots) return { bible: keptShots.bible, shots: keptShots.shots, mended: [], cost: 0, note: null }
    const r = await planShots(brief, draft.phrases, { sections: draft.sections, outline: draft.outline, maxClips }, deps.parse)
    if (r.ok) return { ...r.value, cost: r.cost, note: null }
    // Claude could not plan them: each shot shows what its line says, in the format's own style.
    return { ...localShotList(brief, draft.phrases), cost: r.cost, note: `Claude could not plan the shots (${r.message.replace(/[.\s]+$/, '')}), so each one shows what its line says.` }
  })()
  const [heard, planned] = await Promise.all([narrated, planning])
  if (planned.note) notes.push(planned.note)
  if (!keptShots) deps.progress('Planning the shots', 100)

  const lengths = phraseLengths(draft.phrases, heard.words)
  const size = quote.size
  // The shots fitted to what was agreed for them.
  const fit = fitShots(planned.shots, budget.cap - budget.spent, (s) =>
    shotCost(s.visual, quote.images, quote.clips, { size, clipSeconds: quote.counts.clipSeconds })
  )
  if (fit.downgraded > 0) notes.push(`${fit.downgraded === 1 ? 'One clip is' : `${fit.downgraded} clips are`} a still instead, to stay inside the quote.`)
  const ground = await groundFor(brief.format, brief.aspect, deps.dir)
  const made = keptShots
    ? await keptFiles(keptShots, deps.probe)
    : await makeShots(
        { brief, bible: planned.bible, shots: fit.shots, images: quote.images, clips: quote.clips, size, lengths },
        budget,
        { ...deps, ground },
        { clipSeconds: quote.counts.clipSeconds, maxSheets: Math.max(quote.counts.sheets, 0) }
      )
  notes.push(...made.notes)

  deps.progress('Finding music in your Music folder', null)
  const music = await deps.findMusic(brief.format).catch(() => null)
  deps.progress('Putting it together', null)

  const spentServices = budget.spent
  const claudeCost = draft.scriptCost + planned.cost
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
    images: quote.images,
    clips: quote.clips,
    spent: Math.round((spentServices + claudeCost) * 10000) / 10000
  }
  const { doc, unheard, rejected } = assembleDoc({
    id: draft.id,
    make,
    words: heard.words,
    ground,
    files: made.files,
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

  const reply = madeReply(doc, make, quote, notes)
  return { doc, reply, spent: make.spent }
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
  return { shots: kept.shots.map((s) => ({ ...s, cost: 0 })), sheets: kept.sheets, notes: [], files }
}

/** What was made, in Cutalong's voice: a sentence, three facts, and the rest behind Details. */
export function madeReply(doc: EditDoc, make: Make, quote: Quote, notes: string[]): Reply {
  const kind = make.brief.format === 'documentary' ? 'documentary' : 'explainer'
  const seconds = make.narration.durationSec
  const service = make.images === 'google' ? 'Google' : 'fal.ai'
  const madeBy = make.shots.filter((s) => s.maker === make.images).length
  const text = `v1 is ready: a ${clock(seconds)} ${kind} about ${make.brief.topic}, ${make.shots.length} shots. It cost ${dollars(make.spent)} of the ${dollars(quote.total)} quoted.`
  const disclose =
    make.brief.format === 'documentary'
      ? 'Its pictures are made, not archival: YouTube asks you to mark realistic made pictures as altered or synthetic when you upload.'
      : null
  const aside = [...notes, disclose].filter(Boolean).join(' ') || null
  return {
    text,
    aside,
    chips: [clock(seconds), `${make.shots.length} shots`, dollars(make.spent)],
    details: [
      { label: 'Narration', value: `${voicePhrase(make.narration.voice)}${make.narration.cost ? `: ${dollars(make.narration.cost)}` : ''}` },
      { label: 'Pictures', value: `${madeBy} made by ${service}` },
      { label: 'Spent', value: `${dollars(make.spent)}, of ${dollars(quote.total)} quoted` },
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
