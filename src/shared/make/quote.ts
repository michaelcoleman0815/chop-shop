import { clock } from '../presets/preset'
import { CLAUDE_HOLD, CLAUDE_TOKENS, PRICES, PRICES_CHECKED, ROOM_TO_ANSWER, SHOTS_PER_PART, voiceRate } from './prices'
import { countWords, wordsFor } from './script'
import type { Brief, ImageService, Shot, Visual, VoiceChoice, VoiceEngine } from './schema'
import { defaultVoice, voicePhrase, voiceShort } from './voices'
import type { KeyService } from './key-steps'

/**
 * The quote: before anything that costs money, what will be made, by which
 * service, what it costs, how long it takes, and what is sent where.
 *
 * Before the shot list exists the counts are estimated from the script (one
 * shot a phrase, a few clips for key moments, maps where places are named);
 * once Claude has planned the shots they are counted exactly, and the shots
 * are fitted to the confirmed total so nothing ever costs more than the
 * person agreed to.
 */

/** Which services may be used right now: the switch in Settings is on and each has its key. */
export interface Availability {
  google: boolean
  fal: boolean
  elevenlabs: boolean
  openai: boolean
  /** The person's Anthropic key, for the script and the shot list. */
  claude: boolean
  /** The voice on this Mac has been downloaded already. */
  localVoice: boolean
}

export const NOTHING_AVAILABLE: Availability = {
  google: false,
  fal: false,
  elevenlabs: false,
  openai: false,
  claude: false,
  localVoice: false
}

/** Dollars a video may cost when neither the prompt nor Settings says otherwise. */
export const DEFAULT_CAP = 10

export interface Counts {
  scenes: number
  /** Stills made by a service: the shots' own, and the first frame of every clip. */
  stills: number
  clips: number
  clipSeconds: number
  maps: number
  cards: number
  graphics: number
  broll: number
  /** Character reference sheets, made before the shots. */
  sheets: number
  /** Reference images sent with prompts: a sheet with each shot its character is in. */
  references: number
  titles: number
  callouts: number
  narrationSeconds: number
  narrationChars: number
}

export interface QuoteLine {
  /** What is made: "24 stills", "2 clips of 5 s". */
  what: string
  /** Who makes it: "Google Nano Banana 2.1", "this Mac". */
  by: string
  cost: number
}

export interface Quote {
  lines: QuoteLine[]
  /** Dollars, everything included. */
  total: number
  /** About how long making it takes, in seconds. */
  seconds: number
  counts: Counts
  images: ImageService | null
  clips: ImageService | null
  /** The image size asked for. */
  size: string
  voice: VoiceChoice
  /** The most this video may cost in all: Settings' limit, or the prompt's when it asks for less. */
  cap: number
  /** Spent on this video already (the script, a stopped run, the video a change is made from): counted against the cap. */
  spent: number
  within: boolean
  /** Settings says to go ahead without asking when a video costs less than this, and this one does. */
  auto: boolean
  /** What stops it being made, in sentences. */
  missing: string[]
  /** What was swapped for what was asked, in sentences: a voice whose key is missing, clips over the cap. */
  notes: string[]
  /** What is sent where, in sentences. */
  sends: string[]
  /** Keys that are missing for what was asked, first the one that would help most: their steps show with the quote. */
  keys: KeyService[]
  checked: string
}

const IMAGE_NAME: Record<ImageService, string> = { google: 'Google', fal: 'fal.ai' }

const round = (n: number): number => Math.round(n * 10000) / 10000

/** Dollars as a person reads them: $0.93, $12.40; under a cent reads as "less than a cent". */
export function dollars(n: number): string {
  if (n <= 0) return '$0.00'
  if (n < 0.005) return 'less than a cent'
  return `$${n.toFixed(2)}`
}

/** Places named in a script: capitalised names after in, to, from, across, near. */
export function placesIn(script: string): string[] {
  const found = new Set<string>()
  const re = /\b(?:in|to|from|across|near|outside|around|through|at)\s+((?:[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|de|del|la|of))*){1,4})/g
  for (const m of script.matchAll(re)) {
    const name = m[1].trim()
    if (/^(The|This|That|These|Those|It|He|She|They|We|I|A|An|And|But|Then|When|By|Every|One|Two|Three)$/.test(name)) continue
    if (/^(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(name)) continue
    found.add(name)
  }
  return [...found]
}

/** Phrases that open on or name a year: where a documentary sets a year big. */
export function yearsIn(phrases: string[]): number {
  return phrases.filter((p) => /\b(1[5-9]\d\d|20[0-4]\d)\b/.test(p)).length
}

/** Words a phrase holds, about, in a script not yet written. */
const WORDS_PER_PHRASE = 15

/**
 * The counts of a script not written yet (a made video asked to run a new
 * length): as many phrases as that length reads in, each a still, so what is
 * quoted is the most it can cost.
 */
export function estimateUnwritten(brief: Brief): Counts {
  const words = wordsFor(brief.seconds, brief.format)
  const phrases = Array.from({ length: Math.max(1, Math.ceil(words / WORDS_PER_PHRASE)) }, () => 'a phrase')
  const counts = estimateCounts(brief, phrases, '')
  return { ...counts, narrationSeconds: brief.seconds, narrationChars: words * 6 }
}

/** The counts a script will most likely need, before the shot list is planned. */
export function estimateCounts(brief: Brief, phrases: string[], script: string): Counts {
  const scenes = Math.max(1, phrases.length)
  const doc = brief.format === 'documentary'
  const clips =
    brief.clips === 'none'
      ? 0
      : brief.clips === 'more'
        ? Math.max(2, Math.round(scenes * 0.15))
        : Math.min(doc ? 6 : 4, Math.max(1, Math.round(scenes * 0.06)))
  const places = placesIn(script).length
  const maps =
    brief.maps === 'none'
      ? 0
      : brief.maps === 'more'
        ? Math.min(Math.max(1, places), Math.max(2, Math.round(scenes * 0.12)))
        : doc
          ? Math.min(places, Math.max(1, Math.round(scenes * 0.06)))
          : 0
  const titles = doc ? Math.min(yearsIn(phrases) + 1, Math.max(1, Math.round(scenes * 0.2))) : 1
  const graphics = doc ? 0 : Math.round(scenes * 0.1)
  const callouts = doc ? 0 : Math.round(scenes * 0.3)
  const cards = doc ? 1 : 0
  // Every shot is counted as a still until it is planned: maps, cards and graphics made here only bring it down,
  // so what is quoted is the most it can cost.
  const own = scenes - clips
  // One reference sheet, for the figure who recurs: an explainer's main character, a documentary's wildcatter.
  const sheets = 1
  const words = countWords(script)
  return {
    scenes,
    stills: scenes,
    clips,
    clipSeconds: 5,
    maps,
    cards,
    graphics,
    broll: 0,
    sheets,
    references: sheets > 0 ? Math.round((own + clips) * (doc ? 0.3 : 0.6)) : 0,
    titles,
    callouts,
    narrationSeconds: (words / (doc ? 140 : 158)) * 60,
    narrationChars: script.length
  }
}

/** What a visual needs made by a service: a still, a still and a clip, or nothing (made on this Mac). */
export function needs(visual: Visual): { stills: number; clips: number } {
  if (visual.kind === 'still') return { stills: 1, clips: 0 }
  if (visual.kind === 'clip') return { stills: 1, clips: 1 }
  return { stills: 0, clips: 0 }
}

/** The counts of a planned shot list, exactly. */
export function countShots(
  shots: Shot[],
  opts: { sheets: number; clipSeconds: number[]; narrationSeconds: number; narrationChars: number }
): Counts {
  const by = (k: Visual['kind']): number => shots.filter((s) => s.visual.kind === k).length
  const stillsAndClips = shots.reduce((n, s) => n + needs(s.visual).stills, 0)
  const references =
    opts.sheets > 0
      ? shots.filter(
          (s) => (s.visual.kind === 'still' || s.visual.kind === 'clip') && s.visual.characters.length > 0
        ).length
      : 0
  return {
    scenes: shots.length,
    stills: stillsAndClips,
    clips: by('clip'),
    clipSeconds: opts.clipSeconds.length ? opts.clipSeconds.reduce((a, b) => a + b, 0) / opts.clipSeconds.length : 5,
    maps: by('map'),
    cards: by('card'),
    graphics: by('graphic'),
    broll: by('broll'),
    sheets: opts.sheets,
    references,
    titles: shots.filter((s) => s.title).length,
    callouts: shots.reduce((n, s) => n + s.callouts.length, 0),
    narrationSeconds: opts.narrationSeconds,
    narrationChars: opts.narrationChars
  }
}

/** Dollars a narration costs with a voice, from its length in characters and seconds. */
export function voiceCost(voice: VoiceChoice, chars: number, seconds: number, today: string): number {
  if (voice.engine === 'own' || voice.engine === 'local') return 0
  const rate = voiceRate(PRICES.voices[voice.engine], today)
  return round((chars / 1000) * rate.perThousandChars + seconds * rate.perSecond)
}

/** Dollars a still costs at a service, with its reference images. */
export function stillCost(service: ImageService, size: string, references = 0): number {
  const p = PRICES.images[service]
  const per = (p.perImage as Record<string, number>)[size] ?? Object.values(p.perImage)[0]
  return round(per + references * p.perReference)
}

/** Dollars a clip of so many seconds costs at a service. */
export function clipCost(service: ImageService, seconds: number): number {
  const p = PRICES.clips[service]
  return round(Math.min(p.maxSec, Math.max(p.minSec, seconds)) * p.perSecond)
}

/** Dollars so many tokens cost with Claude, in and out. */
const claudeDollars = (input: number, output: number): number =>
  (input / 1e6) * PRICES.claude.inputPerMillion + (output / 1e6) * PRICES.claude.outputPerMillion

/**
 * The most one call to Claude, of about `input` tokens in and `output` out,
 * may cost: CLAUDE_HOLD times its estimate, and room for a short answer at
 * least, up to the call's own ceiling on its answer. It is quoted at this,
 * and held to it, so it never takes a quoted picture's money.
 */
export function claudeHold(input: number, output: number, ceiling: number): number {
  return round(Math.max(claudeDollars(input, output) * CLAUDE_HOLD, claudeDollars(input, Math.min(ceiling, ROOM_TO_ANSWER))))
}

/**
 * Dollars Claude's shot list may cost, from how many shots and how long the
 * narration is: each part of SHOTS_PER_PART shots one call, at its hold.
 */
export function shotListCost(scenes: number, narrationSeconds: number): number {
  let total = 0
  for (let from = 0; from < scenes; from += SHOTS_PER_PART) {
    const n = Math.min(SHOTS_PER_PART, scenes - from)
    const input = CLAUDE_TOKENS.promptBase + (narrationSeconds * CLAUDE_TOKENS.scriptPerSecond * n) / Math.max(1, scenes) + (from > 0 ? 600 : 0)
    total += claudeHold(input, n * CLAUDE_TOKENS.perShot * (1 + CLAUDE_TOKENS.thinking), 32000)
  }
  return round(total)
}

/** Dollars Claude's script may cost, for a narration this long, at its hold. */
export function scriptCost(seconds: number): number {
  return claudeHold(CLAUDE_TOKENS.promptBase, seconds * CLAUDE_TOKENS.scriptPerSecond * (1 + CLAUDE_TOKENS.thinking) + 600, 16000)
}

/** Dollars Claude's description of one shot made again may cost, at its hold. */
export const REWRITE_COST = claudeHold(2500, 1500, 4000)

/** The voice that will read it: the one asked for when its service can be reached, else the one on this Mac. */
export function voiceFor(brief: Brief, can: Availability): { voice: VoiceChoice; note: string | null } {
  const v = brief.voice
  const engine = v.engine as VoiceEngine
  const reachable = engine === 'local' || engine === 'own' || (engine === 'gemini' ? can.google : can[engine as 'elevenlabs' | 'openai'])
  if (reachable) return { voice: v, note: null }
  const local = defaultVoice(brief.format)
  const names: Record<string, string> = { elevenlabs: 'ElevenLabs', openai: 'OpenAI', gemini: 'Google Gemini' }
  return {
    voice: local,
    note: `There is no ${names[engine]} key in Settings, or other AI services are off, so ${local.name} reads it on this Mac instead.`
  }
}

export interface QuoteOptions {
  today?: string
  /** Settings: the most a video may cost. */
  cap?: number | null
  /** Settings: go ahead without asking when a video costs less than this; null is off. */
  autoUnder?: number | null
  /** The script is already written (its cost is spent), or still to be written. */
  scriptWritten?: boolean
  /** Made again from a made video: what is kept as it is, and so costs nothing and goes nowhere; or the shot list planned already. */
  reuse?: { narration?: boolean; shots?: boolean; plan?: boolean }
  /** Spent on this video already: counted against the cap, and against the amount to go ahead under. */
  spent?: number
}

/**
 * The quote for making a brief from these counts with what is available:
 * services chosen, lines priced, the time it takes, and what goes where.
 * Clips come off first, then the pictures drop to the smaller size, when
 * the total would pass the cap.
 */
export function quoteFor(brief: Brief, counts: Counts, can: Availability, opts: QuoteOptions = {}): Quote {
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  // A prompt can ask for less than Settings allows, never more.
  const cap = Math.min(opts.cap ?? DEFAULT_CAP, brief.cap ?? Number.POSITIVE_INFINITY)
  const spent = Math.max(0, opts.spent ?? 0)
  const room = cap - spent
  const keepVoice = !!opts.reuse?.narration
  const keepShots = !!opts.reuse?.shots
  const keepPlan = !!opts.reuse?.plan
  if (keepShots) counts = { ...counts, stills: 0, clips: 0, sheets: 0, references: 0 }
  const missing: string[] = []
  const notes: string[] = []
  const keys: KeyService[] = []

  const pick = (want: ImageService | null): ImageService | null => {
    if (want && can[want]) return want
    if (can.google) return 'google'
    if (can.fal) return 'fal'
    return null
  }
  const images = pick(brief.images)
  if (brief.images && images !== brief.images)
    notes.push(`There is no ${IMAGE_NAME[brief.images]} key in Settings, so ${images ? IMAGE_NAME[images] : 'nothing'} makes the pictures.`)
  if (!images && !keepShots && counts.stills + counts.sheets > 0) {
    missing.push('To make the pictures I need a Google Gemini or fal.ai key in Settings, with other AI services on.')
    keys.push(...(brief.images === 'fal' ? (['fal', 'gemini'] as const) : (['gemini', 'fal'] as const)))
  } else if (brief.images && images !== brief.images) keys.push(brief.images === 'google' ? 'gemini' : 'fal')
  let clipsBy: ImageService | null = counts.clips > 0 ? images : null
  const { voice, note } = voiceFor(brief, can)
  if (note && !keepVoice) {
    notes.push(note)
    const asked = brief.voice.engine === 'gemini' ? 'gemini' : brief.voice.engine
    if (asked === 'gemini' || asked === 'elevenlabs' || asked === 'openai') if (!keys.includes(asked)) keys.push(asked)
  }
  if (!keepVoice && voice.engine === 'own' && voice.id === 'pending') missing.push('Drop your voice-over in and I will make the video to it.')

  let c: Counts = { ...counts }
  let size = images ? PRICES.images[images].size : '2K'
  const build = (): { lines: QuoteLine[]; total: number } => {
    const lines: QuoteLine[] = []
    if (brief.from === 'topic' && !opts.scriptWritten)
      lines.push({ what: 'The script', by: 'Claude, with your Anthropic key', cost: scriptCost(brief.seconds) })
    if (!keepShots && !keepPlan && (brief.from !== 'recording' || c.scenes > 0))
      lines.push({ what: `The shot list, ${c.scenes} shots`, by: 'Claude, with your Anthropic key', cost: shotListCost(c.scenes, c.narrationSeconds) })
    if (voice.engine !== 'own' && !keepVoice) {
      const p = voice.engine === 'local' ? PRICES.voices.local : PRICES.voices[voice.engine]
      lines.push({
        what: `The narration, about ${clock(c.narrationSeconds)}`,
        by: voice.engine === 'local' ? `${voice.name} on this Mac` : `${p.name}, ${voice.name}`,
        cost: voiceCost(voice, c.narrationChars, c.narrationSeconds, today)
      })
    }
    if (images && c.sheets > 0)
      lines.push({
        what: c.sheets === 1 ? 'A character sheet' : `${c.sheets} character sheets`,
        by: `${IMAGE_NAME[images]} ${PRICES.images[images].name}`,
        cost: round(c.sheets * stillCost(images, size))
      })
    if (images && c.stills > 0)
      lines.push({
        what: `Up to ${c.stills} ${c.stills === 1 ? 'still' : 'stills'}${c.clips > 0 && clipsBy ? `, ${c.clips} of them the first frame of a clip` : ''}`,
        by: `${IMAGE_NAME[images]} ${PRICES.images[images].name}`,
        cost: round(c.stills * stillCost(images, size) + c.references * PRICES.images[images].perReference)
      })
    if (clipsBy && c.clips > 0)
      lines.push({
        what: `${c.clips} ${c.clips === 1 ? 'clip' : 'clips'} of ${Math.round(c.clipSeconds)} s`,
        by: `${IMAGE_NAME[clipsBy]} ${PRICES.clips[clipsBy].name}`,
        cost: round(c.clips * clipCost(clipsBy, c.clipSeconds))
      })
    const free = [
      c.maps ? `${c.maps} ${c.maps === 1 ? 'map' : 'maps'}` : '',
      c.cards ? `${c.cards} title ${c.cards === 1 ? 'card' : 'cards'}` : '',
      c.titles ? `${c.titles} ${c.titles === 1 ? 'title' : 'titles'}` : '',
      c.callouts ? `${c.callouts} ${c.callouts === 1 ? 'label' : 'labels'}` : '',
      c.graphics ? `${c.graphics} ${c.graphics === 1 ? 'graphic' : 'graphics'}` : '',
      'the look, the cut and the music'
    ].filter(Boolean)
    lines.push({ what: free.join(', '), by: 'this Mac', cost: 0 })
    return { lines, total: round(lines.reduce((n, l) => n + l.cost, 0)) }
  }
  let built = build()
  // Over the cap: clips become stills, then the pictures drop a size.
  if (built.total > room && c.clips > 0 && clipsBy) {
    notes.push(`Clips would take it past ${dollars(cap)}, so every shot is a still with a camera move.`)
    c = { ...c, clips: 0 }
    clipsBy = null
    built = build()
  }
  if (built.total > room && images) {
    const smaller = Object.keys(PRICES.images[images].perImage)[0]
    if (smaller !== size) {
      size = smaller
      notes.push(`To stay under ${dollars(cap)} the pictures are made at the smaller size.`)
      built = build()
    }
  }
  const within = built.total <= room + 1e-9
  if (!within)
    missing.push(
      spent > 0
        ? `That would take this video to ${dollars(spent + built.total)} in all, more than the ${dollars(cap)} a video may cost. Raise the limit in Settings to make it.`
        : `That comes to ${dollars(built.total)}, more than the ${dollars(cap)} a video may cost. Ask for a shorter video, or raise the limit in Settings.`
    )

  // Time: the shot list and the narration at once, then the pictures four at a time, the clips two at a time.
  const narrate = keepVoice
    ? 0
    : voice.engine === 'own'
      ? c.narrationSeconds * 0.2
      : voice.engine === 'local'
        ? c.narrationSeconds * 0.5 + (can.localVoice ? 0 : 60)
        : c.narrationSeconds * 0.15
  const plan = keepShots || keepPlan ? 0 : brief.from === 'topic' && !opts.scriptWritten ? 60 : 40
  const imageSec = images ? Math.ceil((c.stills + c.sheets) / 4) * (images === 'google' ? 18 : 12) : 0
  const clipSec = clipsBy ? Math.ceil(c.clips / 2) * (clipsBy === 'google' ? 100 : 200) : 0
  const seconds = Math.round(Math.max(plan, narrate) + imageSec + clipSec + 20)

  const sends: string[] = []
  if (brief.from === 'topic') sends.push('The topic goes to Claude to write the script, with your Anthropic key.')
  if (!keepShots && !keepPlan) sends.push('The script goes to Claude to plan the shots, with your Anthropic key.')
  if (keepVoice && voice.engine === 'own') sends.push('Your recording stays on this Mac. I listened to it here for the words.')
  else if (keepVoice) sends.push('The narration stays as it is.')
  else if (voice.engine === 'local') sends.push(`${voice.name} reads the script on this Mac, so the words go nowhere else.`)
  else if (voice.engine === 'own') sends.push('Your recording stays on this Mac. I listen to it here for the words.')
  else {
    const where = { elevenlabs: 'ElevenLabs', openai: 'OpenAI', gemini: 'Google' }[voice.engine]
    sends.push(`The script goes to ${where} to be read aloud, with your ${where === 'Google' ? 'Gemini' : where} key.`)
  }
  if (keepShots) sends.push('The pictures stay as they are, so nothing goes to make them.')
  else if (images) {
    sends.push(
      `Only the text prompts for the pictures go to ${IMAGE_NAME[images]}${c.sheets > 0 ? ', with the character sheet it made for each shot the character is in' : ''}.`
    )
    if (clipsBy && c.clips > 0) sends.push(`For each clip, the still ${IMAGE_NAME[clipsBy]} made goes back to it as the first frame.`)
  }
  sends.push('Nothing of your own footage leaves this Mac.')

  // The amount to go ahead under is for the whole video: what is spent already (the script) and this
  // quote, which holds Claude's lines at the most each call may cost.
  const auto =
    opts.autoUnder !== null &&
    opts.autoUnder !== undefined &&
    opts.autoUnder > 0 &&
    spent + built.total < opts.autoUnder &&
    within &&
    missing.length === 0
  return {
    lines: built.lines,
    total: built.total,
    seconds,
    counts: c,
    images,
    clips: clipsBy,
    size,
    voice,
    cap,
    spent,
    within,
    auto,
    missing,
    notes,
    sends,
    keys,
    checked: PRICES_CHECKED
  }
}

/** About how long, in words: "about 4 minutes", "about 40 seconds". */
export function aboutHowLong(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`
  const min = Math.round(seconds / 60)
  return `about ${min} minute${min === 1 ? '' : 's'}`
}

/**
 * The reply that carries a quote: what was understood in a sentence, what
 * was chosen for what the prompt did not say, at most three facts as chips,
 * and the cost lines, what goes where and the prices' date behind Details.
 */
export function quoteReply(
  brief: Brief,
  quote: Quote,
  opts: { title: string; scenes: number }
): { text: string; aside: string | null; chips: string[]; details: { label: string; value: string }[] } {
  const kind = brief.format === 'documentary' ? 'cinematic documentary' : 'animated explainer'
  const reads = quote.voice.engine === 'own' ? 'over your own voice-over' : `read by ${voiceShort(quote.voice)}`
  const shape = brief.aspect === 'vertical' ? ' vertical' : ''
  const text = `I'll make a ${clock(brief.seconds)}${shape} ${kind} about ${brief.topic}, ${reads}. It comes to ${dollars(quote.total)} and takes ${aboutHowLong(quote.seconds)}.`
  const chose = brief.inferred.length ? `You didn't say, so I chose ${listOf(brief.inferred)}.` : ''
  const aside = [chose, ...quote.notes, ...quote.missing].filter(Boolean).join(' ') || null
  const chips = [clock(brief.seconds), `${opts.scenes} shots`, dollars(quote.total)]
  const details = [
    ...quote.lines.map((l) => ({ label: l.what, value: `${l.by}: ${dollars(l.cost)}` })),
    { label: 'In all', value: dollars(quote.total) },
    { label: 'What goes where', value: quote.sends.join(' ') },
    { label: 'Prices', value: `From each service's published prices, read on ${quote.checked}.` }
  ]
  return { text, aside, chips, details }
}

/** "a, b and c". */
export function listOf(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}
