import { currentCut, EditDocSchema, type EditDoc } from '../shared/edit'
import { planQualityOf, type PlanQuality } from '../shared/plan-quality'
import { ASK_OVER, KEPT_SEC, pictureTokens, planPrice, tokensIn, type PlanQuote, type PlanSize } from '../shared/setup'
import type { Settings } from '../shared/types'
import { footageMoments, frameSize } from './plan-look'
import {
  PLAN_TOOL_DESCRIPTION,
  PLAN_TOOL_INSTRUCTION,
  PLAN_TOOL_SCHEMA,
  PLANNER_SYSTEM,
  renderCommands,
  renderRequest,
  renderTranscript,
  type CommandLine
} from './planner-prompt'

/**
 * What an edit will cost, worked out from everything it would send, before any of it is sent: nothing is asked of
 * Claude to price it. The person sees it before the edit starts, and the planner keeps to it (main/planner).
 */

const INSTRUCTIONS = PLANNER_SYSTEM.length + PLAN_TOOL_INSTRUCTION.length + PLAN_TOOL_DESCRIPTION.length + JSON.stringify(PLAN_TOOL_SCHEMA).length

/** The texts of a request, and the frames sent with them, as tokens. */
export function planSize(texts: { commands: string; transcript: string; request: string }, frames: { width: number; height: number }[]): PlanSize {
  return {
    instructions: tokensIn(INSTRUCTIONS, 'instructions') + tokensIn(texts.commands.length, 'commands'),
    footage: tokensIn(texts.transcript.length, 'transcript') + frames.reduce((n, f) => n + pictureTokens(f), 0),
    request: tokensIn(texts.request.length, 'request')
  }
}

/** When each thing Anthropic keeps was last sent: the instructions, and an edit's words and frames. */
const sent = { instructions: -Infinity, footage: new Map<string, { at: number; words: number }>() }

/** Notes that a plan was sent: what it read is kept for a few minutes (KEPT_SEC). */
export function noteSent(doc: Pick<EditDoc, 'id' | 'words'>, now = Date.now()): void {
  sent.instructions = now
  sent.footage.set(doc.id, { at: now, words: doc.words.length })
  if (sent.footage.size > 40) sent.footage.delete(sent.footage.keys().next().value as string)
}

/** What Anthropic still keeps of an edit's request. */
export function keptNow(doc: Pick<EditDoc, 'id' | 'words'>, now = Date.now()): { instructions: boolean; footage: boolean } {
  const within = (at: number): boolean => now - at < KEPT_SEC * 1000
  const was = sent.footage.get(doc.id)
  return { instructions: within(sent.instructions), footage: !!was && within(was.at) && was.words === doc.words.length }
}

/** Nothing is kept: for tests. */
export function forgetSent(): void {
  sent.instructions = -Infinity
  sent.footage.clear()
}

/** Whether an edit has its graphics already, so what is asked for next is a change to it. */
export const isChange = (doc: EditDoc): boolean => (currentCut(doc).motion ?? []).length > 0

/** The quality an edit is planned at: as it was agreed or as set, and once where Claude does not see the frames. */
export const qualityFor = (prefs: Pick<Settings, 'planQuality' | 'claudeSeesFrames'>, agreed?: PlanQuality): PlanQuality =>
  prefs.claudeSeesFrames === false ? 'quick' : (agreed ?? planQualityOf(prefs.planQuality))

/** What is priced: an edit and what is asked of it, at the quality set or the one given. */
export interface QuoteInput {
  doc: unknown
  request: string
  notes: Parameters<typeof renderRequest>[2]
  commands?: CommandLine[]
  chat?: { role: 'user' | 'assistant'; text: string }[]
  /** Planned at this quality rather than the one set: what was agreed, priced again. */
  quality?: PlanQuality
  /** What else goes with the ask (sounds, brand, habits), in characters. */
  more?: number
}

/** What a plan of this edit would cost; null when the edit cannot be read. */
export function planQuote(input: QuoteInput, prefs: Pick<Settings, 'planQuality' | 'claudeSeesFrames' | 'planAskOver'>, now = Date.now()): PlanQuote | null {
  const parsed = EditDocSchema.safeParse(input.doc)
  if (!parsed.success) return null
  const doc = parsed.data
  const quality = qualityFor(prefs, input.quality)
  const change = isChange(doc)
  const request = renderRequest(doc, input.request, input.notes, undefined, [], undefined, undefined, { chat: input.chat })
  const size = planSize(
    { commands: renderCommands(input.commands ?? []), transcript: renderTranscript(doc), request },
    prefs.claudeSeesFrames === false ? [] : footageMoments(doc).map((m) => frameSize(doc, m.source))
  )
  // The person's sounds, brand and habits go with the ask too: what they come to, by the characters given.
  size.request += tokensIn(input.more ?? 0, 'request')
  const terms = { change, kept: keptNow(doc, now) }
  const price = planPrice(size, { ...terms, quality })
  const once = planPrice(size, { ...terms, quality: 'quick' })
  const over = prefs.planAskOver === undefined ? ASK_OVER : prefs.planAskOver
  return { ...price, quality, change, ask: over !== null && price.about > over, quick: quality === 'quick' ? null : { about: once.about, most: once.most } }
}
