import { promises as fs } from 'fs'
import { z } from 'zod'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { currentCut, nextSourceId } from '../../shared/edit/doc'
import type { Asset, EditDoc, Op } from '../../shared/edit/schema'
import { cameraFor, type Carry } from '../../shared/make/assemble'
import { readMakeAsk, shotNumber, type MakeAsk } from '../../shared/make/edits'
import type { KeyService } from '../../shared/make/key-steps'
import { PRICES } from '../../shared/make/prices'
import { clipCost, DEFAULT_CAP, dollars, REWRITE_COST, stillCost, type Availability, type QuoteLine } from '../../shared/make/quote'
import { promptFor } from '../../shared/make/shots'
import { STILL_MOVES, type Brief, type ImageService, type Make, type MadeShot, type VoiceChoice } from '../../shared/make/schema'
import { defaultVoice, voicePhrase } from '../../shared/make/voices'
import { MODEL } from '../planner'
import { callCost, holdFor, inputOf, maybeBilled, settle, type ParseCall } from './claude'
import { Budget, MadeCache, makeOnce, OverBudget, type MadeRequest } from './generate'
import type { Change, Draft, Reply, ShotChange } from '../../shared/make/draft'
import { MakeFailed, quoteDraft, type DraftDeps } from './run'
import type { MakeServices, Picture } from './services'

/**
 * A made video asked to change: one shot made again ("make this shot a
 * close-up of his hands", "make shot 4 again"), a new narration ("use a
 * different voice"), a new style ("make it an explainer instead"), a new
 * length ("make it 8 minutes"), or a shot swapped for B-roll. Each is quoted
 * first, for what it makes again and nothing else, and each lands as a new
 * version, so Undo goes back.
 *
 * One shot is the treat op on its beat, so whatever else was done to the cut
 * stays. A new narration, style or length is a new cut made by the same run
 * as the first (run.ts), with what stays the same kept and not paid for; a
 * new length is quoted before its script is written, and written only once
 * that quote is confirmed. Every change is held to the cap with what the
 * video has spent already, and none goes ahead without its button: these are
 * read from what was typed, so "go ahead without asking" never applies.
 */

const IMAGE_NAME: Record<ImageService, string> = { google: 'Google', fal: 'fal.ai' }

/** What a shot is asked to show, with its article back: "a close-up of his hands", "the derrick", "oil rising". */
export function withArticle(want: string): string {
  const w = want.trim().replace(/^(A|An|The)\b/, (m) => m.toLowerCase())
  if (/^(a|an|the|his|her|their|its|my|our|your|this|that|some|two|three|four|five)\b/i.test(w) || /^\w+ing\b/i.test(w) || /^\w+s\b/.test(w)) return w
  return `${/^[aeiou]/i.test(w) ? 'an' : 'a'} ${w}`
}

const say = (text: string): { kind: 'say'; reply: Reply } => ({ kind: 'say', reply: { text, aside: null, chips: [], details: [] } })

/** The picture service a remake uses: the one the video was made with, else whichever is open. */
function serviceFor(make: Make, can: Availability): ImageService | null {
  if (can[make.images]) return make.images
  if (can.google) return 'google'
  if (can.fal) return 'fal'
  return null
}

/** One shot made again, quoted before anything goes. */
export function quoteShot(
  make: Make,
  ask: Extract<MakeAsk, { kind: 'reshoot' }>,
  can: Availability,
  settings: { autoUnder?: number | null; cap?: number | null }
): ShotChange | { kind: 'say'; reply: Reply } {
  const shot = make.shots.find((s) => s.phrase === ask.phrase)
  if (!shot) return say('I could not tell which shot you mean. Say its number, like “make shot 4 a close-up of his hands”.')
  const n = shotNumber(make, shot.phrase)
  const v = shot.visual
  if (v.kind === 'card') return say(`Shot ${n} is a title card made here. Tell me the words you want on it and I'll set them.`)
  if (v.kind === 'graphic') return say(`Shot ${n} is a ${v.graphic} made here. Tell me what it should say or show and I'll change it.`)
  if (v.kind === 'map') return say(`Shot ${n} is a map made here. Tell me the place it should show and I'll draw it again.`)
  const images = serviceFor(make, can)
  const keys: KeyService[] = []
  const missing: string[] = []
  if (!images) {
    missing.push('To make it again I need a Google Gemini or fal.ai key in Settings, with other AI services on.')
    keys.push(make.images === 'fal' ? 'fal' : 'gemini')
  }
  const clips = v.kind === 'clip' && make.clips && can[make.clips] ? make.clips : null
  const service = images ?? make.images
  const size = PRICES.images[service].size
  const refs = (v.kind === 'still' || v.kind === 'clip' ? v.characters : []).filter((c) => make.sheets.some((s) => s.character === c)).length
  const seconds = clips ? Math.max(PRICES.clips[clips].minSec, Math.min(PRICES.clips[clips].maxSec, 5)) : 0
  const lines: QuoteLine[] = []
  if (ask.want) lines.push({ what: 'The new picture described', by: 'Claude, with your Anthropic key', cost: REWRITE_COST })
  lines.push({ what: 'One still', by: `${IMAGE_NAME[service]} ${PRICES.images[service].name}`, cost: stillCost(service, size, refs) })
  if (clips) lines.push({ what: `One clip of ${seconds} s from it`, by: `${IMAGE_NAME[clips]} ${PRICES.clips[clips].name}`, cost: clipCost(clips, seconds) })
  const total = Math.round(lines.reduce((t, l) => t + l.cost, 0) * 10000) / 10000
  // Held to the cap with what the video has spent already: a prompt's limit can only lower Settings'.
  const cap = Math.min(settings.cap ?? DEFAULT_CAP, make.brief.cap ?? Number.POSITIVE_INFINITY)
  if (images && make.spent + total > cap + 1e-9)
    missing.push(
      `That would take this video to ${dollars(make.spent + total)} in all, more than the ${dollars(cap)} a video may cost. Raise the limit in Settings to make it.`
    )
  // Read from what was typed, so it never goes ahead without its button, whatever Settings says.
  const auto = false
  const sends = [
    ask.want ? 'What you asked for, and the shot as it was described, go to Claude to describe the new picture, with your Anthropic key.' : '',
    `Only the text prompt goes to ${IMAGE_NAME[service]}${refs ? ', with the character sheet of each character in it' : ''}.`,
    clips ? `The new still goes back to ${IMAGE_NAME[clips]} as the clip's first frame.` : '',
    'Nothing of your own footage leaves this Mac.'
  ].filter(Boolean)
  const what = ask.want ? `as ${withArticle(ask.want)}` : 'as a new take of the same picture'
  const made = clips ? 'a still and a clip' : 'one still'
  const text = `I'll make shot ${n} again ${what}: ${made} from ${IMAGE_NAME[service]}, for ${dollars(total)}.`
  return {
    kind: 'shot',
    phrase: shot.phrase,
    beat: shot.beat,
    want: ask.want,
    take: ask.want ? 0 : Date.now(),
    images: service,
    clips,
    lines,
    total,
    auto,
    missing,
    keys,
    sends,
    reply: {
      text,
      aside: [v.kind === 'clip' && !clips ? 'The clip service is not open, so it comes back as a still with a camera move.' : '', ...missing]
        .filter(Boolean)
        .join(' ') || null,
      chips: [`Shot ${n}`, dollars(total)],
      details: [
        ...lines.map((l) => ({ label: l.what, value: `${l.by}: ${dollars(l.cost)}` })),
        { label: 'What goes where', value: sends.join(' ') }
      ]
    }
  }
}

export const ReshotSchema = z.object({
  /** The new picture, in one to three sentences, in the bible's style. */
  prompt: z.string(),
  move: z.enum(STILL_MOVES)
})

export const RESHOT_SYSTEM = `You rewrite one shot of a video Cutalong made from nothing, for what the person asked it to show instead. You receive the style bible, the narration line the shot covers, the shot as it was, and what was asked.

Write the new picture in one to three sentences: the subject and what it is doing, the setting, the framing (wide, medium, close-up, detail), the angle and the light, as the bible's style would show it. Keep whatever was asked; keep what was there that the ask does not change (the people, the place, the period). Name characters by their name from the bible. Never ask for text, signs, captions, logos or watermarks. Never a real, named person's likeness.

move is the camera over the still: push-in toward a face or a feeling, pan-left or pan-right across a scene, pan-up up something tall, ken-burns across a busy scene, pull-out to reveal, drift for a calm moment.`

export function reshotRequest(make: Make, shot: MadeShot, want: string): Record<string, unknown> {
  const v = shot.visual
  const was = v.kind === 'still' || v.kind === 'clip' ? v.prompt : ''
  const ask = [
    `<bible>\n${JSON.stringify(make.bible)}\n</bible>`,
    `<line>\n${make.phrases[shot.phrase] ?? ''}\n</line>`,
    `<shot>\n${was}\n</shot>`,
    `<asked>\n${want.slice(0, 600)}\n</asked>`
  ].join('\n\n')
  return {
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: RESHOT_SYSTEM }],
    messages: [{ role: 'user', content: ask }],
    output_config: { effort: 'low', format: betaZodOutputFormat(ReshotSchema) }
  }
}

/** The shot's new prompt and camera, by Claude; what was asked, as it was said, when Claude cannot. */
export async function rewriteShot(
  make: Make,
  shot: MadeShot,
  want: string,
  parse: ParseCall,
  opts: { signal?: AbortSignal; budget?: Budget; hold?: number } = {}
): Promise<{ prompt: string; move: (typeof STILL_MOVES)[number]; cost: number; note: string | null }> {
  const v = shot.visual
  const move = v.kind === 'still' ? v.move : 'push-in'
  const plain = `${want.charAt(0).toUpperCase()}${want.slice(1)}.`
  const request = reshotRequest(make, shot, want)
  // Held to its line of the quote, from Claude's own budget: the still's money is never in it.
  const hold = holdFor(opts.budget, opts.hold ?? REWRITE_COST, inputOf(request), 4000)
  if (!hold) return { prompt: plain, move, cost: 0, note: 'There was not enough left of the quote for Claude, so the picture was asked for in your words.' }
  try {
    const r = await parse({ ...request, max_tokens: hold.maxTokens }, { signal: opts.signal })
    const cost = callCost(r.usage)
    settle(opts.budget, hold, cost)
    const parsed = ReshotSchema.safeParse(r.parsed_output)
    if (r.stop_reason === 'refusal' || !parsed.success || !parsed.data.prompt.trim())
      return { prompt: plain, move, cost, note: 'Claude could not describe it, so the picture was asked for in your words.' }
    return { prompt: parsed.data.prompt.trim().slice(0, 1200), move: parsed.data.move, cost, note: null }
  } catch (err) {
    // Stopped, it may have been billed for what it wrote: the hold is spent, and the shot is not made.
    if (opts.signal?.aborted) {
      settle(opts.budget, hold, null)
      throw new Error('Stopped.')
    }
    // Broken partway, it may have been billed all the same; refused with an error, it was not.
    const billed = maybeBilled(err)
    settle(opts.budget, hold, billed ? null : 0)
    return { prompt: plain, move, cost: billed ? hold.held : 0, note: 'Claude could not be reached, so the picture was asked for in your words.' }
  }
}

export interface RemakeShotDeps {
  services: MakeServices
  parse: ParseCall
  dir: string
  probe: (path: string) => Promise<{ durationSec: number; width: number; height: number }>
  progress: (stage: string, percent: number | null) => void
  signal?: AbortSignal
}

async function readPicture(path: string): Promise<Picture> {
  return { data: new Uint8Array(await fs.readFile(path)), mime: /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png' }
}

/** One shot made again for its quote: the op that shows it, the record as it is now, and the asset it adds. */
export async function remakeShot(
  doc: EditDoc,
  change: ShotChange,
  deps: RemakeShotDeps
): Promise<{ ops: Op[]; make: Make; asset: Omit<Asset, 'id'>; summary: string; reply: Reply; spent: number }> {
  // Held to what was quoted: Claude's few words to their own line, the still and the clip to theirs, so
  // Claude never takes the picture's money. A Stop or a failure says what it spent.
  const claudeLine = change.lines.filter((l) => l.by.startsWith('Claude')).reduce((t, l) => t + l.cost, 0)
  const claude = new Budget(claudeLine)
  const budget = new Budget(Math.round((change.total - claudeLine) * 10000) / 10000)
  const spentSoFar = (): number => Math.round((budget.spent + claude.spent) * 10000) / 10000
  try {
    return await remakeShotWith(doc, change, deps, budget, claude)
  } catch (err) {
    if (deps.signal?.aborted)
      throw new Error(
        spentSoFar() > 0
          ? `Stopped: ${dollars(spentSoFar())} of the ${dollars(change.total)} quoted was spent, and the shot stays as it was.`
          : 'Stopped before anything was made, so nothing was spent, and the shot stays as it was.'
      )
    throw new MakeFailed(err instanceof Error ? err.message : String(err), spentSoFar(), change.total)
  }
}

async function remakeShotWith(
  doc: EditDoc,
  change: ShotChange,
  deps: RemakeShotDeps,
  budget: Budget,
  claude: Budget
): Promise<{ ops: Op[]; make: Make; asset: Omit<Asset, 'id'>; summary: string; reply: Reply; spent: number }> {
  const make = doc.make
  if (!make) throw new Error('This edit was not made from nothing, so there is no shot to make again.')
  const shot = make.shots.find((s) => s.phrase === change.phrase)
  if (!shot || (shot.visual.kind !== 'still' && shot.visual.kind !== 'clip')) throw new Error('That shot is not a picture I made.')
  const beat = currentCut(doc).beats.some((b) => b.id === change.beat) ? change.beat : shot.beat
  if (!currentCut(doc).beats.some((b) => b.id === beat)) throw new Error('That shot is no longer in the cut.')
  const n = shotNumber(make, shot.phrase)
  const notes: string[] = []
  let visual = shot.visual
  if (change.want) {
    deps.progress(`Describing shot ${n} again`, null)
    const r = await rewriteShot(make, shot, change.want, deps.parse, { signal: deps.signal, budget: claude, hold: claude.cap })
    if (r.note) notes.push(r.note)
    visual = visual.kind === 'still' ? { ...visual, prompt: r.prompt, move: r.move } : { ...visual, prompt: r.prompt }
  }
  const cache = new MadeCache(deps.dir)
  const brief = make.brief
  const size = PRICES.images[change.images].size
  const prompt = promptFor(visual, make.bible, brief.format, brief.aspect)
  const refs = await Promise.all(
    visual.characters
      .map((c) => make.sheets.find((s) => s.character === c)?.file)
      .filter((p): p is string => !!p)
      .map(readPicture)
  )
  deps.progress(`Making shot ${n} with ${IMAGE_NAME[change.images]}`, null)
  const model = deps.services.models.image[change.images]
  const req: MadeRequest = { kind: 'image', service: change.images, model, prompt, refs, aspect: brief.aspect, size, take: change.take || undefined }
  const still = await makeOnce(req, stillCost(change.images, size, refs.length), { services: deps.services, cache, budget, signal: deps.signal }, () =>
    deps.services.image(change.images, prompt, refs, { aspect: brief.aspect, size, signal: deps.signal })
  )
  let file = still.path
  let byModel = model
  let video = false
  if (visual.kind === 'clip' && change.clips) {
    const clips = change.clips
    const seconds = Math.max(PRICES.clips[clips].minSec, Math.min(PRICES.clips[clips].maxSec, 5))
    const first = await readPicture(still.path)
    const motion = `${visual.prompt} ${visual.motion}`.trim()
    try {
      deps.progress(`Making shot ${n}'s clip with ${IMAGE_NAME[clips]}`, null)
      const clip = await makeOnce(
        { kind: 'clip', service: clips, model: deps.services.models.clip[clips], prompt: motion, refs: [first], aspect: brief.aspect, seconds, take: change.take || undefined },
        clipCost(clips, seconds),
        { services: deps.services, cache, budget, signal: deps.signal },
        () => deps.services.clip(clips, motion, first, { aspect: brief.aspect, seconds, signal: deps.signal })
      )
      file = clip.path
      byModel = deps.services.models.clip[clips]
      video = true
    } catch (err) {
      notes.push(err instanceof OverBudget ? 'The clip would have passed the quote, so it is the still.' : 'The clip could not be made, so it is the still with a camera move.')
    }
  }
  const spent = Math.round((budget.spent + claude.spent) * 10000) / 10000
  const facts = await deps.probe(file).catch(() => ({ durationSec: 0, width: 0, height: 0 }))
  const move = visual.kind === 'still' ? visual.move : 'push-in'
  const broll = video ? { path: file, inSec: 0, muted: true } : { path: file, inSec: 0, muted: true, camera: cameraFor(move, shot.phrase) }
  const ops: Op[] = [{ op: 'treat', beats: [beat], set: { frame: 'broll', broll } } as Op]
  const remade: MadeShot = {
    ...shot,
    visual,
    beat,
    file,
    maker: change.images,
    model: byModel,
    cost: spent,
    key: null,
    note: null
  }
  const next: Make = {
    ...make,
    shots: make.shots.map((s) => (s.phrase === shot.phrase ? remade : s)),
    spent: Math.round((make.spent + spent) * 10000) / 10000
  }
  const summary = change.want ? `Shot ${n} shows ${withArticle(change.want)}.` : `Shot ${n} is a new take.`
  const asset: Omit<Asset, 'id'> = {
    kind: video ? 'video' : 'image',
    path: file,
    title: visual.prompt.slice(0, 70),
    durationSec: video ? facts.durationSec : null,
    width: facts.width || null,
    height: facts.height || null,
    origin: { type: 'file', url: null, author: IMAGE_NAME[change.images], license: `Made with ${byModel}`, range: null }
  }
  return {
    ops,
    make: next,
    asset,
    summary,
    spent,
    reply: {
      text: `${summary} It cost ${dollars(spent)} of the ${dollars(change.total)} quoted.`,
      aside: notes.join(' ') || null,
      chips: [`Shot ${n}`, dollars(spent)],
      details: [{ label: 'Made by', value: `${IMAGE_NAME[change.images]}, ${byModel}` }]
    }
  }
}

/** Another voice than this one, for "a different voice": the next of the same kind. */
function anotherVoice(current: VoiceChoice, format: Brief['format']): VoiceChoice {
  const local = defaultVoice(format)
  return current.id === local.id ? defaultVoice(format === 'documentary' ? 'explainer' : 'documentary') : local
}

/** What changing a made video costs, before anything is made: a shot, or a draft of the whole of it. */
export async function changeFor(
  doc: EditDoc,
  text: string,
  onScreen: string | null,
  deps: DraftDeps,
  recording: string | null = null
): Promise<Change | null> {
  const make = doc.make
  if (!make) return null
  const ask = readMakeAsk(make, text, onScreen)
  if (!ask) return null
  if (ask.kind === 'reshoot') return quoteShot(make, ask, deps.can, deps.settings)
  if (ask.kind === 'broll') {
    const shot = make.shots.find((s) => s.phrase === ask.phrase)
    if (!shot?.beat) return say('That shot is not in the cut any more.')
    return { kind: 'broll', phrase: ask.phrase, beat: shot.beat, search: ask.search }
  }
  const narrationSource = doc.sources.find((s) => s.path === make.narration.path)?.id ?? 's1'
  const kept = {
    narration: {
      path: make.narration.path,
      durationSec: make.narration.durationSec,
      sourceId: narrationSource,
      words: doc.words.filter((w) => w.source === narrationSource),
      voice: make.narration.voice,
      timing: make.narration.timing
    },
    shots: { bible: make.bible, shots: make.shots, sheets: make.sheets }
  }
  const base: Omit<Draft, 'quote' | 'into' | 'kept' | 'brief'> = {
    id: doc.id,
    title: make.title,
    outline: make.outline,
    script: make.script,
    phrases: make.phrases,
    sections: make.sections,
    scriptCost: 0,
    // What the video has cost so far counts against the cap with what the change costs.
    spentBefore: make.spent
  }
  const into = (summary: string, carry: Carry): Draft['into'] => ({ docId: doc.id, sourceId: nextSourceId(doc), summary, carry })
  if (ask.kind === 'voice') {
    if (ask.own && recording) {
      // The same shots cut to the person's own reading of the script, heard on this Mac.
      const voice: VoiceChoice = { engine: 'own', id: recording, name: 'You' }
      const draft: Draft = { ...base, brief: { ...make.brief, voice, inferred: [] }, kept: { shots: kept.shots }, into: into('Your own voice-over.', { captions: true, look: true, music: true }), quote: null as never }
      draft.quote = quoteDraft(draft, deps)
      return {
        kind: 'draft',
        draft,
        reply: {
          text: `I'll cut the same ${make.shots.length} shots to your recording. That costs ${dollars(draft.quote.total)}.`,
          aside: 'It stays on this Mac: I listen to it here for the words.',
          chips: [`${make.shots.length} shots`, dollars(draft.quote.total)],
          details: [{ label: 'What goes where', value: draft.quote.sends.join(' ') }]
        }
      }
    }
    if (ask.own)
      return {
        kind: 'record',
        reply: {
          text: "Drop your voice-over in, reading the script, and I'll cut the same shots to it. That costs nothing.",
          aside: 'It stays on this Mac: I listen to it here for the words.',
          chips: [],
          details: []
        }
      }
    const voice = ask.voice ?? anotherVoice(make.narration.voice, make.brief.format)
    const brief: Brief = { ...make.brief, voice, inferred: [] }
    const draft: Draft = { ...base, brief, kept: { shots: kept.shots }, into: into(`Read by ${voice.name}.`, { captions: true, look: true, music: true }), quote: null as never }
    draft.quote = quoteDraft(draft, deps)
    const q = draft.quote
    return {
      kind: 'draft',
      draft,
      reply: {
        text: `I'll read it again with ${voicePhrase(q.voice)} and cut the same shots to it, for ${dollars(q.total)}.`,
        aside: [...q.notes, ...q.missing].join(' ') || null,
        chips: [q.voice.name, dollars(q.total)],
        details: [...q.lines.map((l) => ({ label: l.what, value: `${l.by}: ${dollars(l.cost)}` })), { label: 'What goes where', value: q.sends.join(' ') }]
      }
    }
  }
  if (ask.kind === 'restyle') {
    const brief: Brief = { ...make.brief, format: ask.format, look: ask.format === 'documentary' ? 'archival' : 'bright', inferred: [] }
    const draft: Draft = {
      ...base,
      brief,
      kept: { narration: kept.narration },
      into: into(`Made again as ${ask.format === 'documentary' ? 'a cinematic documentary' : 'an animated explainer'}.`, { captions: true, look: false, music: false }),
      quote: null as never
    }
    draft.quote = quoteDraft(draft, deps)
    const q = draft.quote
    const kind = ask.format === 'documentary' ? 'a cinematic documentary' : 'an animated explainer'
    return {
      kind: 'draft',
      draft,
      reply: {
        text: `I'll make every picture again as ${kind}, over the same narration: ${q.counts.scenes} shots, for ${dollars(q.total)}.`,
        aside: [...q.notes, ...q.missing].join(' ') || null,
        chips: [`${q.counts.scenes} shots`, dollars(q.total)],
        details: [...q.lines.map((l) => ({ label: l.what, value: `${l.by}: ${dollars(l.cost)}` })), { label: 'What goes where', value: q.sends.join(' ') }]
      }
    }
  }
  // A new length: a new script, so a new narration and new shots. Quoted first, from the length;
  // Claude writes it only once that quote is confirmed, held to it like the rest.
  // The script is written to what was first asked, and to what was asked of it since, which wins.
  const brief: Brief = {
    ...make.brief,
    seconds: ask.seconds,
    from: 'topic',
    inferred: [],
    ask: `${make.brief.ask}\n\nAsked of it since: ${text.trim()}`.slice(0, 40_000)
  }
  const draft: Draft = {
    ...base,
    brief,
    script: '',
    phrases: [],
    sections: [],
    outline: [],
    unwritten: { voice: deps.brand.voice ?? null, name: deps.brand.name ?? null },
    into: into(`Made again at ${Math.round(ask.seconds / 60) || 1} minutes.`, { captions: true, look: true, music: true }),
    quote: null as never
  }
  draft.quote = quoteDraft(draft, deps)
  const q = draft.quote
  return {
    kind: 'draft',
    draft,
    reply: {
      text: `I'll write it again at ${Math.round(ask.seconds / 60) || 1} minutes and make it new: about ${q.counts.scenes} shots, for up to ${dollars(q.total)}.`,
      aside: [...q.notes, ...q.missing, 'Nothing is written until you press its button.'].filter(Boolean).join(' ') || null,
      chips: [`About ${q.counts.scenes} shots`, dollars(q.total)],
      details: [...q.lines.map((l) => ({ label: l.what, value: `${l.by}: ${dollars(l.cost)}` })), { label: 'What goes where', value: q.sends.join(' ') }]
    }
  }
}
