import { z } from 'zod'
import { dollars } from './make/quote'

/**
 * What each video has really cost: every paid call the app makes to Claude
 * is written down, against the chat it was made for, from the tokens the
 * API says it used (main/costs keeps the ledger, main/usage hands each call
 * to it). A video made from nothing keeps its own total already
 * (shared/make, `Make.spent`, pictures and voice included), so its calls are
 * not written here twice.
 *
 * Prices: Anthropic's published prices, in dollars per million tokens, read
 * on PRICES_READ from https://platform.claude.com/docs/en/about-claude/pricing.
 * A prompt-cache write is 1.25 times an input token and a read a tenth,
 * except where the page gives a read of its own. Web search is $10 a
 * thousand searches, as broll/sources/web prices it.
 */

export const PRICES_READ = '2026-11-23'

export interface ModelPrice {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

export const CLAUDE_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
  'claude-opus-5': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-sonnet-5-5': { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 }
}

/** Dollars a web search costs, on top of the tokens its results take. */
export const WEB_SEARCH_EACH = 0.01

/** The `usage` a Messages API answer carries, as far as cost goes. */
export interface ApiUsage {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  server_tool_use?: { web_search_requests?: number | null } | null
}

/** What a call was for, so a video's cost can say where it went. */
export const PURPOSES = ['plan', 'read', 'clips', 'key-words', 'story', 'describe', 'upload', 'roles', 'web-search'] as const
export type Purpose = (typeof PURPOSES)[number]

const TokensSchema = z.object({
  input: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  output: z.number().int().min(0)
})
export type Tokens = z.infer<typeof TokensSchema>

export const CostEntrySchema = z.object({
  at: z.string(),
  for: z.enum(PURPOSES),
  model: z.string().max(80),
  /** Dollars, from the tokens and Anthropic's prices; 0 when the model's price is not known here. */
  dollars: z.number().min(0),
  tokens: TokensSchema,
  searches: z.number().int().min(0).optional(),
  /** Set when the model had no price here, so its dollars could not be counted. */
  unpriced: z.literal(true).optional()
})
export type CostEntry = z.infer<typeof CostEntrySchema>

const ProjectCostsSchema = z.object({
  name: z.string().max(300),
  path: z.string().max(4096).nullable(),
  entries: z.array(CostEntrySchema)
})

export const CostLedgerSchema = z.object({
  v: z.literal(1),
  /** By project id. */
  projects: z.record(z.string(), ProjectCostsSchema),
  /** Calls made while no chat was open yet (reading a first message): claimed by the chat that opens next. */
  loose: z.array(CostEntrySchema)
})
export type CostLedger = z.infer<typeof CostLedgerSchema>

export function emptyLedger(): CostLedger {
  return { v: 1, projects: {}, loose: [] }
}

/** The ledger from its file, or an empty one when it is missing or cannot be read. */
export function readLedger(raw: unknown): CostLedger {
  const parsed = CostLedgerSchema.safeParse(raw)
  return parsed.success ? parsed.data : emptyLedger()
}

/** A model's prices: its own, or, for a dated or newer id of a family priced here, that family's. */
export function priceOf(model: string): ModelPrice | null {
  if (CLAUDE_PRICES[model]) return CLAUDE_PRICES[model]
  const own = Object.keys(CLAUDE_PRICES)
    .filter((id) => model.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0]
  return own ? CLAUDE_PRICES[own] : null
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)

/** One call written down: its tokens, and what they cost. */
export function entryFor(purpose: Purpose, model: string, usage: ApiUsage | null | undefined, at: Date): CostEntry {
  const tokens: Tokens = {
    input: n(usage?.input_tokens),
    cacheWrite: n(usage?.cache_creation_input_tokens),
    cacheRead: n(usage?.cache_read_input_tokens),
    output: n(usage?.output_tokens)
  }
  const searches = n(usage?.server_tool_use?.web_search_requests)
  const price = priceOf(model)
  const cost = price
    ? (tokens.input * price.input + tokens.cacheWrite * price.cacheWrite + tokens.cacheRead * price.cacheRead + tokens.output * price.output) / 1e6 +
      searches * WEB_SEARCH_EACH
    : searches * WEB_SEARCH_EACH
  return {
    at: at.toISOString(),
    for: purpose,
    model: model.slice(0, 80),
    dollars: Math.round(cost * 1e6) / 1e6,
    tokens,
    ...(searches > 0 ? { searches } : {}),
    ...(price ? {} : { unpriced: true as const })
  }
}

export interface ProjectRef {
  id: string
  name: string
  path: string | null
}

/** The ledger with a call written down against a chat, or as loose when none is open. */
export function record(ledger: CostLedger, to: ProjectRef | null, entry: CostEntry): CostLedger {
  if (!to) return { ...ledger, loose: [...ledger.loose, entry].slice(-200) }
  const had = ledger.projects[to.id]
  return {
    ...ledger,
    projects: { ...ledger.projects, [to.id]: { name: to.name, path: to.path, entries: [...(had?.entries ?? []), entry] } }
  }
}

/** How long a call made with no chat open waits for the chat it was for: reading a first message, then the chat it starts. */
export const LOOSE_WINDOW_MS = 15 * 60 * 1000

/**
 * A chat opened: the calls made with no chat open in the few minutes before
 * are its own (the first message is read before its chat has a file), and
 * its name and place are brought up to date. Older loose calls stay loose:
 * they count in what was spent, never in a video's.
 */
export function claimLoose(ledger: CostLedger, project: ProjectRef, now: Date): CostLedger {
  const since = now.getTime() - LOOSE_WINDOW_MS
  const mine = ledger.loose.filter((e) => Date.parse(e.at) >= since)
  const had = ledger.projects[project.id]
  if (mine.length === 0 && !had) return ledger
  return {
    ...ledger,
    loose: ledger.loose.filter((e) => Date.parse(e.at) < since),
    projects: {
      ...ledger.projects,
      [project.id]: { name: project.name, path: project.path, entries: [...(had?.entries ?? []), ...mine] }
    }
  }
}

export function totalOf(entries: CostEntry[]): number {
  return Math.round(entries.reduce((sum, e) => sum + e.dollars, 0) * 1e6) / 1e6
}

/** What a chat makes, for the averages: Shorts (vertical, square, or clips from a long recording) or a long-form video. */
export type VideoKind = 'short' | 'long'

/** The parts of a saved chat that say what it makes. */
export interface ChatShape {
  edit?: {
    versions?: { cut?: { aspect?: string } }[]
    make?: { spent?: number } | null
  } | null
  clipping?: { clips?: unknown[] } | null
}

/**
 * What a chat made, and how many videos: each clip found in a long
 * recording is a Short of its own; otherwise the edit's newest version says,
 * vertical or square a Short and anything else long-form. A chat with
 * neither made no video yet.
 */
export function kindOf(chat: ChatShape): { kind: VideoKind; videos: number } | null {
  const clips = chat.clipping?.clips?.length ?? 0
  if (clips > 0) return { kind: 'short', videos: clips }
  const versions = chat.edit?.versions ?? []
  const aspect = versions[versions.length - 1]?.cut?.aspect
  if (!aspect) return null
  return { kind: aspect === 'vertical' || aspect === 'square' ? 'short' : 'long', videos: 1 }
}

/** What a video made from nothing has spent, pictures and voice included (its own total, never in the ledger). */
export function madeSpent(chat: ChatShape): number {
  const spent = chat.edit?.make?.spent
  return typeof spent === 'number' && Number.isFinite(spent) && spent > 0 ? spent : 0
}

export interface KindAverage {
  /** Videos counted. */
  videos: number
  /** Chats they came from. */
  chats: number
  dollars: number
  /** Dollars a video, or null with none. */
  average: number | null
}

export interface CostSummary {
  shorts: KindAverage
  long: KindAverage
  /** Spent in chats that have made no video yet, and in calls no chat claimed. */
  elsewhere: number
  /** Everything written down, made videos' own spend included. */
  total: number
  /** Calls whose model had no price here, so are not in the dollars. */
  unpriced: number
  pricesRead: string
  /** False where nothing is written down (the phone, for now), so there is nothing to average. */
  kept: boolean
}

export interface ChatCost {
  id: string
  dollars: number
  shape: { kind: VideoKind; videos: number } | null
  unpriced: number
}

/** A chat's cost: what the ledger holds for it and, for a made video, what it spent on its own. */
export function chatCost(id: string, entries: CostEntry[], chat: ChatShape | null): ChatCost {
  return {
    id,
    dollars: Math.round((totalOf(entries) + (chat ? madeSpent(chat) : 0)) * 1e6) / 1e6,
    shape: chat ? kindOf(chat) : null,
    unpriced: entries.filter((e) => e.unpriced).length
  }
}

/** The average a video costs, Shorts and long-form apart, from every chat's cost. */
export function summarise(chats: ChatCost[], loose: CostEntry[]): CostSummary {
  const blank = (): KindAverage => ({ videos: 0, chats: 0, dollars: 0, average: null })
  const by = { short: blank(), long: blank() }
  let elsewhere = totalOf(loose)
  for (const c of chats) {
    if (!c.shape) {
      elsewhere += c.dollars
      continue
    }
    const k = by[c.shape.kind]
    k.videos += c.shape.videos
    k.chats += 1
    k.dollars += c.dollars
  }
  const settle = (k: KindAverage): KindAverage => ({
    ...k,
    dollars: Math.round(k.dollars * 1e6) / 1e6,
    average: k.videos > 0 ? Math.round((k.dollars / k.videos) * 1e6) / 1e6 : null
  })
  const shorts = settle(by.short)
  const long = settle(by.long)
  return {
    shorts,
    long,
    elsewhere: Math.round(elsewhere * 1e6) / 1e6,
    total: Math.round((shorts.dollars + long.dollars + elsewhere) * 1e6) / 1e6,
    unpriced: chats.reduce((sum, c) => sum + c.unpriced, 0) + loose.filter((e) => e.unpriced).length,
    pricesRead: PRICES_READ,
    kept: true
  }
}

/** "18 cents", "$1.40", "less than a cent": what a reader takes in at a glance. */
export function amount(d: number): string {
  if (d > 0 && d < 1 && d >= 0.005) return `${Math.round(d * 100)} cents`
  return dollars(d)
}

/** One kind's line: "18 cents a Short on average, over 7 Shorts from 3 chats." */
export function averageLine(k: KindAverage, kind: VideoKind): string {
  const one = kind === 'short' ? 'Short' : 'long-form video'
  const many = kind === 'short' ? 'Shorts' : 'long-form videos'
  if (k.videos === 0 || k.average === null) return `No ${many} yet.`
  const over = k.videos === 1 ? `over 1 ${one}` : `over ${k.videos} ${many}`
  const from = k.chats === k.videos ? '' : ` from ${k.chats} ${k.chats === 1 ? 'chat' : 'chats'}`
  return `${amount(k.average)} a ${one} on average, ${over}${from}.`
}

/** What one video has cost so far, in a sentence. */
export function videoCostLine(d: number): string {
  if (d <= 0) return 'Nothing has been spent on this video yet.'
  return `This video has cost ${amount(d)} so far.`
}
