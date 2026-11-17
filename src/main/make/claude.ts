import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { clock } from '../../shared/presets/preset'
import { CLAUDE_HOLD, CLAUDE_TOKENS, PRICES, SHOTS_PER_PART } from '../../shared/make/prices'
import { scriptCost, shotListParts } from '../../shared/make/quote'
import { WORDS_PER_MINUTE, wordsFor } from '../../shared/make/script'
import {
  checkShotList,
  ScriptAnswerSchema,
  ShotListAnswerSchema,
  type CheckedShots,
  type ScriptAnswer,
  type ShotListAnswer
} from '../../shared/make/shots'
import type { Bible, Brief } from '../../shared/make/schema'
import { describeError, MODEL } from '../planner'
import type { Budget } from './generate'

/**
 * Claude's two jobs in a made video, with the person's own Anthropic key:
 * writing the narration from the topic, in the brand's voice when there is
 * one, and planning a shot for every phrase of it in one style bible.
 *
 * Both ask for structured output on the planner's model, so the answer is
 * the shape asked for or nothing; the shot list is checked phrase by phrase
 * afterwards (shared/make/shots.ts) and never trusted as it comes. A long
 * video's shots are planned in parts, the first part writing the bible and
 * every later part keeping to it.
 *
 * While a confirmed video is made, every call to Claude is held to its own
 * line of the quote, from a budget of Claude's own (the pictures' money is
 * never in it): the quote prices each call at the most it may cost (shared
 * claudeHold), the answer is capped to what that pays for, and what it
 * really cost is spent when it comes back. A Stop cuts the call short, and
 * no later part is asked for.
 */

/** One structured-output call to Claude, as the SDK makes it; tests and stand-ins hand in their own. */
export type ParseCall = (params: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<{
  parsed_output: unknown
  stop_reason: string | null
  usage?: Usage | null
}>

/** The tokens a call used, as the Messages API counts them: prompt-cache writes and reads are billed apart. */
export interface Usage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
}

export function parseWith(client: Anthropic): ParseCall {
  return async (params, opts) => {
    // Streamed: a long shot list may take longer than the SDK lets one request wait, and the final
    // message is parsed against the same schema as a single answer would be. A Stop aborts it.
    const r = await client.beta.messages.stream(params as never, { signal: opts?.signal }).finalMessage()
    return { parsed_output: (r as { parsed_output?: unknown }).parsed_output ?? null, stop_reason: r.stop_reason, usage: r.usage }
  }
}

/** A Messages API answer as the server streams it: one text block, then the stop and the usage. For stand-ins and tests. */
export function streamedAnswer(text: string, opts: { model?: string; input?: number; output?: number; stop?: string } = {}): Response {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { id: 'msg_local', type: 'message', role: 'assistant', model: opts.model ?? '', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: opts.input ?? 1, output_tokens: 1 } }
      }
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: opts.stop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: opts.output ?? 1 } }],
    ['message_stop', { type: 'message_stop' }]
  ]
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

export { CLAUDE_HOLD }

/** What one call to Claude is held to: the budget's hold, and the longest answer that hold pays for. */
export interface ClaudeHold {
  held: number
  maxTokens: number
}

/** The least answer worth asking for: a hold that pays for less is not sent. */
const LEAST_ANSWER = 1000

/**
 * A hold on Claude's budget for one call, of at most `amount` dollars (its
 * line of the quote, or its share of it), with about `input` tokens in, and
 * the longest answer that pays for, up to `ceiling` tokens; null when what is
 * left would not pay for even a short answer. With no budget (the script
 * written before any quote), the call is only capped at `ceiling`.
 */
export function holdFor(budget: Budget | undefined, amount: number, input: number, ceiling: number): ClaudeHold | null {
  if (!budget) return { held: 0, maxTokens: ceiling }
  const inCost = (input / 1e6) * PRICES.claude.inputPerMillion
  const want = Math.min(budget.room, amount)
  const maxTokens = Math.min(ceiling, Math.floor(((want - inCost) / PRICES.claude.outputPerMillion) * 1e6))
  if (maxTokens < Math.min(ceiling, LEAST_ANSWER) || !budget.reserve(want)) return null
  return { held: want, maxTokens }
}

/** What a call held to the budget cost, spent; a call cut off mid-answer spends its hold, since it may be billed for it. */
export function settle(budget: Budget | undefined, hold: ClaudeHold, cost: number | null): void {
  if (!budget) return
  budget.commit(hold.held, cost ?? hold.held)
}

/**
 * Whether a failed call may still be billed: anything but an answer the API
 * gave with an error status before it began (a refused key, a bad request,
 * an overloaded service), or a request that never left this computer (no
 * address for the API, no connection made). A stream that broke after it
 * was sent, or a Stop, may have been billed for what it said by then.
 */
export function maybeBilled(err: unknown): boolean {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') return false
  return !neverSent(err)
}

/** The system's codes for a request that failed before it was sent: no address, or no connection made. */
const NEVER_SENT =
  /^(?:ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|CERT_\w+|ERR_TLS_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/

/** Whether a failure, or what caused it (the SDK wraps fetch's error, which wraps the system's), says the request never went. */
function neverSent(err: unknown): boolean {
  const code = (e: unknown): string | null => {
    const c = (e as { code?: unknown } | null)?.code
    return typeof c === 'string' ? c : null
  }
  let e: unknown = err
  for (let depth = 0; depth < 6 && e && typeof e === 'object'; depth++) {
    if (NEVER_SENT.test(code(e) ?? '')) return true
    // Every address tried and refused (Node reports them together).
    const tried = (e as { errors?: unknown }).errors
    if (Array.isArray(tried) && tried.length > 0 && tried.every((t) => NEVER_SENT.test(code(t) ?? ''))) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

/** Dollars a call cost, from the tokens it used, prompt-cache writes and reads included. */
export function callCost(usage: Usage | null | undefined): number {
  const c = PRICES.claude
  const input =
    (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) * c.cacheWrite + (usage?.cache_read_input_tokens ?? 0) * c.cacheRead
  const output = usage?.output_tokens ?? 0
  return Math.round(((input / 1e6) * c.inputPerMillion + (output / 1e6) * c.outputPerMillion) * 10000) / 10000
}

/**
 * Tokens a request sends, counted generously (three characters a token, the
 * instructions, the ask and the answer's schema, and a thousand more for
 * what the API adds), so a hold is never short of what it is billed. The
 * instructions marked for the prompt cache count at what a cache write costs.
 */
export const inputOf = (request: Record<string, unknown>): number => {
  const chars = (v: unknown): number => JSON.stringify(v ?? null).length
  const cached = (Array.isArray(request.system) ? request.system : []).filter(
    (b: unknown) => typeof b === 'object' && b !== null && 'cache_control' in b
  )
  const surcharge = chars(cached) * (PRICES.claude.cacheWrite - 1)
  return Math.ceil((chars([request.system, request.messages, request.output_config]) + surcharge) / 3) + 1000
}

export const SCRIPT_SYSTEM = `You write narration scripts for Cutalong, a video editor. A narrator reads your script aloud over pictures made for it: photoreal archival stills and a few short clips for a cinematic documentary, bright cartoon scenes for an animated explainer.

## What to write
- Spoken English for the ear: short, concrete sentences, one idea each, with the rhythm of a good narrator. Vary sentence length. No lists, bullets, stage directions, sound cues, emoji or headings inside paragraphs.
- Write to the length asked, in words; it is read at the speed given. Never pad and never run long.
- Sections: three to eight for a few minutes, more for a long video, each with a heading of two to five words. The first section opens on an image or a moment, not on a greeting. Never "welcome back", never ask anyone to like or subscribe.
- A documentary names its years and places in the narration ("In 1954, in San Bernardino, ..."), so they can be set on screen, and moves through time in order. An explainer builds from what the viewer already knows, one step at a time, and names the parts it explains, so they can be labelled.
- Facts: only what is well established. When unsure, say less rather than invent a number, a quote or a name. Never put words in a real person's mouth.
- In the creator's voice when one is given; otherwise the calm, warm voice of a good narrator.

The title is the video's title, short enough for YouTube.`

export const SHOTS_SYSTEM = `You plan the shots of a video Cutalong makes from nothing. You receive the narration as numbered phrases. Every phrase becomes one beat of the edit, covered by exactly one visual, full frame. You also write the style bible every picture is made in, so every shot looks like the same film.

## The style bible
- style: one paragraph every picture prompt carries. For a cinematic documentary: photoreal archival photography of the period: the film stock, the camera and lens (a 35 mm camera, a 50 mm lens), the light, how people dress and stand, nothing modern. For an animated explainer: the drawing style (flat 2D, or soft 3D like a toy), outlines, shading, backgrounds, how characters are drawn.
- palette: the few colours the film keeps to.
- era: the place and period for a documentary; empty for an explainer.
- characters: anyone who recurs, drawn the same every time: an explainer's main character (a friendly cartoon heart with big eyes and small gloved hands) or a documentary's recurring figure (the wildcatter: a tall man in a grey felt hat and work shirt). id is lower case with hyphens. Never a real, named person's likeness: show unnamed people of the period, their places, tools and papers.

## Each shot
- phrase: the phrase number it covers. Exactly one shot for every phrase, in order.
- kind: still for most shots: a picture the camera moves over. clip only for the few key moments that need real motion (smoke rising, a crowd surging, a heart beating), at most the number allowed. map where a place matters and maps are allowed: place is the place as precisely as you can name it ("Signal Hill, Long Beach, California"). card for the opening title and a chapter's year or place on its own ground: titleBig is the big line, titleSmall the small one. graphic (explainers): a counter, chart, list, steps, versus, progress or keyword for numbers and comparisons, with text, values and items filled in. broll is never used unless asked.
- prompt: for a still or a clip, one clear picture in one to three sentences: the subject and what it is doing, the setting, the framing (wide, medium, close-up, detail), the angle and the light. Vary the framing the way an editor cuts: a wide to set a scene, closer for people, a detail for an object. Name characters by their name from the bible and list their ids in characters. Never ask for text, signs, captions, logos or watermarks in a picture. Empty for other kinds.
- move: the camera over a still: push-in toward a face or a feeling, pan-left or pan-right across a landscape or a crowd, pan-up up a tower, ken-burns across a busy scene, pull-out to reveal, drift for a calm moment. Vary them.
- motion: for a clip, what moves, in a sentence. Empty otherwise.
- titleBig and titleSmall: for a documentary, a year or a place set big over the shot when the phrase first names it ("1954"; "San Bernardino" over "California"). A handful in a video, never two in a row. Empty for none.
- callouts: for an explainer, labels pointing at parts of the picture ("Coronary arteries", "Left ventricle"), with x and y, from 0 to 1, where that part sits in the picture; write the prompt so the part is there and in the open. At most three. Empty for a documentary.
- graphic, text, values, items: only for a graphic. Empty otherwise.`

/** The script asked for: what to write, how long, in whose voice. */
export function scriptRequest(brief: Brief, opts: { brandVoice?: string | null; brandName?: string | null } = {}): Record<string, unknown> {
  const words = wordsFor(brief.seconds, brief.format)
  const kind = brief.format === 'documentary' ? 'a cinematic documentary' : 'an animated explainer'
  const voice = opts.brandVoice?.trim()
  const ask = [
    `Write the narration for ${kind} about ${brief.topic}.`,
    `It runs ${clock(brief.seconds)}, read at ${WORDS_PER_MINUTE[brief.format]} words a minute: about ${words} words in all.`,
    brief.aspect === 'vertical' ? 'It is a vertical Short: open strong in the first line.' : '',
    voice ? `<creator_voice>\n${voice}\n</creator_voice>\nWrite in that voice.` : '',
    opts.brandName ? `The channel is ${opts.brandName}.` : '',
    `<ask>\n${brief.ask.slice(0, 2000)}\n</ask>`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SCRIPT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: ask }],
    output_config: { effort: 'medium', format: betaZodOutputFormat(ScriptAnswerSchema) }
  }
}

export type ClaudeResult<T> = { ok: true; value: T; cost: number } | { ok: false; message: string; cost: number }

/** What went wrong with a call, in the words the planner uses for every other call to Claude. */
function describe(err: unknown): string {
  if (err instanceof Anthropic.APIUserAbortError) return 'Stopped.'
  return describeError(err)
}

/** Whether a failed call was a Stop, which may have been billed for what it said so far. */
const stopped = (err: unknown, signal?: AbortSignal): boolean => !!signal?.aborted || err instanceof Anthropic.APIUserAbortError

export async function writeScript(
  brief: Brief,
  parse: ParseCall,
  opts: { brandVoice?: string | null; brandName?: string | null; signal?: AbortSignal; budget?: Budget; hold?: number } = {}
): Promise<ClaudeResult<ScriptAnswer>> {
  const request = scriptRequest(brief, opts)
  // Held to its line of the quote: the most the script was quoted at.
  const hold = holdFor(opts.budget, opts.hold ?? scriptCost(brief.seconds), inputOf(request), 16000)
  if (!hold) return { ok: false, message: 'There is not enough left of the quote for Claude to write the script.', cost: 0 }
  if (opts.signal?.aborted) {
    settle(opts.budget, hold, 0)
    return { ok: false, message: 'Stopped.', cost: 0 }
  }
  try {
    const r = await parse({ ...request, max_tokens: hold.maxTokens }, { signal: opts.signal })
    const cost = callCost(r.usage)
    settle(opts.budget, hold, cost)
    if (r.stop_reason === 'refusal') return { ok: false, message: 'Claude declined to write this one. Try another topic or say it another way.', cost }
    const parsed = ScriptAnswerSchema.safeParse(r.parsed_output)
    if (!parsed.success || parsed.data.sections.every((s) => s.paragraphs.join('').trim() === ''))
      return { ok: false, message: 'The script came back in a shape I could not read. Try again.', cost }
    return { ok: true, value: parsed.data, cost }
  } catch (err) {
    const cut = stopped(err, opts.signal)
    // Cut short or broken partway, it may have been billed for what it wrote: the hold is spent. Refused, it was not.
    const billed = cut || maybeBilled(err)
    settle(opts.budget, hold, billed ? null : 0)
    return { ok: false, message: cut ? 'Stopped.' : describe(err), cost: billed ? hold.held : 0 }
  }
}

/** Phrases a shot-list request covers at most; longer videos are planned in parts. */
export const SHOTS_PER_CALL = SHOTS_PER_PART

/** The shot list asked for, for phrases `from` to `to` of the narration. */
export function shotsRequest(
  brief: Brief,
  phrases: string[],
  opts: { from: number; to: number; sections: number[]; outline: string[]; maxClips: number; bible: Bible | null }
): Record<string, unknown> {
  const kind = brief.format === 'documentary' ? 'a cinematic documentary' : 'an animated explainer'
  const look: Record<Brief['look'], string> = {
    archival: 'a warm sepia archival grade, grain and gate weave go on top, so make the pictures as period photographs',
    sepia: 'a strong sepia grade goes on top, so make the pictures as period photographs',
    'black-and-white': 'the film is graded black and white, so make the pictures as black-and-white period photographs',
    'color-film': 'the film is graded as period colour film, so make the pictures as period colour photographs',
    clean: 'a clean, cinematic grade goes on top',
    bright: 'a clean, bright treatment: keep the pictures bright and flat-lit'
  }
  const sectionAt = new Map(opts.sections.map((p, k) => [p, opts.outline[k] ?? '']))
  const lines: string[] = []
  for (let i = opts.from; i < opts.to; i++) {
    if (sectionAt.has(i)) lines.push(`## ${sectionAt.get(i) || 'Section'}`)
    lines.push(`${i}: ${phrases[i]}`)
  }
  const mapsRule =
    brief.maps === 'none'
      ? 'No maps.'
      : brief.maps === 'more'
        ? 'Use a map wherever a place helps the story.'
        : brief.format === 'documentary'
          ? 'Use a map only where a place matters.'
          : 'Maps only if a place truly matters.'
  const ask = [
    `Plan the shots for ${kind} about ${brief.topic}, ${brief.aspect === 'vertical' ? 'vertical 9:16' : 'wide 16:9'}. ${look[brief.look]}.`,
    `At most ${opts.maxClips} clips in these phrases. ${mapsRule}`,
    opts.bible
      ? `Keep to this style bible exactly, and return it unchanged:\n<bible>\n${JSON.stringify(opts.bible)}\n</bible>`
      : 'Write the style bible first.',
    opts.from > 0 ? `These are phrases ${opts.from} to ${opts.to - 1}, continuing the video; no opening title card.` : '',
    `<narration>\n${lines.join('\n')}\n</narration>`
  ]
    .filter(Boolean)
    .join('\n\n')
  return {
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: SHOTS_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: ask }],
    output_config: { effort: 'medium', format: betaZodOutputFormat(ShotListAnswerSchema) }
  }
}

/**
 * The shot list for a whole narration, in parts of SHOTS_PER_CALL phrases:
 * the first writes the bible, the rest keep to it. Clips are shared out
 * across the parts in proportion to their phrases.
 */
export async function planShots(
  brief: Brief,
  phrases: string[],
  opts: {
    sections: number[]
    outline: string[]
    maxClips: number
    signal?: AbortSignal
    budget?: Budget
    /** How long the narration runs, as the quote counted it; the brief's length when not given. */
    narrationSeconds?: number
    /** Each part's line as the quote priced it (shotListParts of the shots it counted): no part is held to more. */
    quotedParts?: number[]
  },
  parse: ParseCall
): Promise<ClaudeResult<CheckedShots>> {
  // Each part is held to its own hold, as the quote priced it (shotListParts), and never to money a later
  // part needs: when less is left than the quote allowed, the first part is the one asked to do with less.
  const own = shotListParts(phrases.length, opts.narrationSeconds ?? brief.seconds)
  const quoted = opts.quotedParts
  // More parts than the quote priced: none of it is asked for, since a part with no line of its own would take another's.
  if (quoted && own.length > quoted.length)
    return { ok: false, message: 'The script has more lines than the quote counted, so the shot list was not asked for.', cost: 0 }
  const holds = quoted ? own.map((h, i) => Math.min(h, quoted[i] ?? 0)) : own
  const share = (part: number): number => {
    if (!opts.budget) return Number.POSITIVE_INFINITY
    const later = holds.slice(part + 1).reduce((t, h) => t + h, 0)
    return Math.min(holds[part] ?? 0, opts.budget.room - later)
  }
  let bible: Bible | null = null
  const shots: ShotListAnswer['shots'] = []
  let answerBible: ShotListAnswer | null = null
  let cost = 0
  let clipsLeft = opts.maxClips
  for (let from = 0; from < phrases.length; from += SHOTS_PER_CALL) {
    const to = Math.min(phrases.length, from + SHOTS_PER_CALL)
    const clips = Math.min(clipsLeft, Math.ceil((opts.maxClips * (to - from)) / Math.max(1, phrases.length)))
    // Stopped: no later part is asked for.
    if (opts.signal?.aborted) return { ok: false, message: 'Stopped.', cost }
    const request = shotsRequest(brief, phrases, { from, to, sections: opts.sections, outline: opts.outline, maxClips: clips, bible })
    const hold = holdFor(opts.budget, share(from / SHOTS_PER_CALL), inputOf(request), 32000)
    if (!hold) return { ok: false, message: 'There was not enough left of the quote for Claude to plan the shots.', cost }
    try {
      const r = await parse({ ...request, max_tokens: hold.maxTokens }, { signal: opts.signal })
      const spent = callCost(r.usage)
      settle(opts.budget, hold, spent)
      cost += spent
      if (r.stop_reason === 'refusal') return { ok: false, message: 'Claude declined to plan these shots.', cost }
      if (r.stop_reason === 'max_tokens') return { ok: false, message: 'The shot list ran too long to plan in one go.', cost }
      const parsed = ShotListAnswerSchema.safeParse(r.parsed_output)
      if (!parsed.success) return { ok: false, message: 'The shot list came back in a shape I could not read.', cost }
      if (!answerBible) answerBible = parsed.data
      // Later parts keep the first part's bible, whatever they return.
      const checked = checkShotList({ ...answerBible, shots: parsed.data.shots }, phrases, {
        format: brief.format,
        maxClips: clips,
        maps: brief.maps !== 'none'
      })
      bible ??= checked.bible
      shots.push(...parsed.data.shots.filter((s) => s.phrase >= from && s.phrase < to))
      clipsLeft -= parsed.data.shots.filter((s) => s.kind === 'clip' && s.phrase >= from && s.phrase < to).length
    } catch (err) {
      const cut = stopped(err, opts.signal)
      const billed = cut || maybeBilled(err)
      settle(opts.budget, hold, billed ? null : 0)
      return { ok: false, message: cut ? 'Stopped.' : describe(err), cost: cost + (billed ? hold.held : 0) }
    }
  }
  const all = checkShotList({ ...(answerBible as ShotListAnswer), shots }, phrases, {
    format: brief.format,
    maxClips: opts.maxClips,
    maps: brief.maps !== 'none'
  })
  return { ok: true, value: all, cost }
}
