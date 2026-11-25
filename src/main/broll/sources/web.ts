import { usageTicket } from '../../usage'
import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { promises as fs } from 'fs'
import { readSources } from '../../../shared/broll-sources'
import { FAIR_USE } from '../../../shared/broll/license'
import { blueskyHandle } from '../../../shared/broll/policy'
import { pageKey } from '../../../shared/broll/rank'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { fileIn, normalized } from '../files'
import { take, type SourceDeps } from './common'

/**
 * Articles, newsroom pictures and public posts, found by Claude's own web
 * search (server-side, through the person's Anthropic key) and captured as
 * the page shows to someone logged out (main/page-capture, the same capture
 * a pasted link gets). Nothing from the person's library or footage goes
 * into the search: only the moment's words.
 *
 * Every search costs the person money: Anthropic charges $10 for 1,000 web
 * searches, and the model's tokens on top. So it never runs by itself: the
 * caller must say the person approved a quote for it (`paid`), which the
 * app's consent and quote path decides. Only pages the search really
 * returned are offered, never an address the model wrote itself.
 *
 * The tool is web_search_20260209, the version with dynamic filtering for
 * Claude Opus 5.5 (the claude-api skill); it brings its own code execution,
 * so none is declared.
 */

/** The planner's model (main/planner MODEL). */
export const WEB_MODEL = 'claude-opus-5-5'
export const WEB_TOOL = 'web_search_20260209'
/** Searches one moment may make. */
export const MAX_USES = 3

/** Anthropic's list prices: per web search, and per million tokens in and out for Claude Opus 5.5. */
export const PRICES = { search: 0.01, input: 4 / 1_000_000, output: 20 / 1_000_000 }

/** What looking for B-roll on the web may cost, before it is done, in US dollars. */
export function quoteWebSearch(moments: number, maxUses = MAX_USES): { low: number; high: number; searches: number; said: string } {
  const searches = moments * maxUses
  // A moment reads one to three searches' results (about 4,000 to 15,000 tokens) and writes a short list.
  const low = moments * (1 * PRICES.search + 4_000 * PRICES.input + 400 * PRICES.output)
  const high = moments * (maxUses * PRICES.search + 15_000 * PRICES.input + 1_500 * PRICES.output)
  const cents = (d: number): string => (d < 1 ? `${Math.max(1, Math.round(d * 100))} cents` : `$${d.toFixed(2)}`)
  return {
    low: Number(low.toFixed(4)),
    high: Number(high.toFixed(4)),
    searches,
    said: `Looking on the web for ${moments === 1 ? 'this moment' : `${moments} moments`} costs about ${cents(low)} to ${cents(high)} on your Anthropic account, for at most ${searches} web searches.`
  }
}

/**
 * How many moments one paid web search may cover: what its price was quoted for. The window's one paid
 * button quotes a single moment (broll:quote with 1), so main turns down a paid search for more, whatever
 * arrives with it, and never spends past the price the person tapped.
 */
export const PAID_MOMENTS = 1

/** Whether a paid web search may run for this many moments. */
export function paidSearchCovers(moments: number): boolean {
  return Number.isInteger(moments) && moments >= 1 && moments <= PAID_MOMENTS
}

const WEB_LICENSE: License = {
  ...FAIR_USE,
  note: 'A page as it shows to anyone: credited, and whether showing it is fair use is your call.'
}

const SYSTEM =
  'You find web pages that would make good B-roll for one moment of a video: news articles about what is said, ' +
  "a company's own newsroom or press page with its official pictures, or a public social post. Prefer primary sources: " +
  'the company itself, or the outlet that broke the news. Never use image search results or pages behind a login. ' +
  'Search, then answer with only a JSON array of at most 6 objects, best first: ' +
  '{"url": string, "title": string, "publisher": string, "kind": "article" | "newsroom" | "post", "why": string}. ' +
  'Use only addresses your searches returned.'

interface Found {
  url: string
  title: string
  publisher: string | null
  kind: 'article' | 'newsroom' | 'post'
  why: string | null
  age: string | null
}

/** The pages the search itself returned, in order, each once. */
export function searchResults(content: BetaMessage['content']): { url: string; title: string; age: string | null }[] {
  const out: { url: string; title: string; age: string | null }[] = []
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const r of block.content) if (r.type === 'web_search_result' && !out.some((o) => o.url === r.url)) out.push({ url: r.url, title: r.title, age: r.page_age })
  }
  return out
}

/** Claude's list, read leniently: the first JSON array in its words. */
export function pickedList(content: BetaMessage['content']): Partial<Found>[] {
  const text = content
    .filter((b): b is Extract<BetaMessage['content'][number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const list = JSON.parse(text.slice(start, end + 1)) as unknown
    return Array.isArray(list) ? (list.filter((x) => x && typeof x === 'object') as Partial<Found>[]) : []
  } catch {
    return []
  }
}

/** What Claude picked, kept only where the search returned it; then the rest of what it returned. */
export function foundPages(content: BetaMessage['content']): Found[] {
  const results = searchResults(content)
  const byKey = new Map(results.map((r) => [pageKey(r.url), r]))
  const out: Found[] = []
  for (const p of pickedList(content)) {
    if (typeof p.url !== 'string') continue
    const r = byKey.get(pageKey(p.url))
    if (!r || out.some((o) => o.url === r.url)) continue
    out.push({
      url: r.url,
      title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : r.title,
      publisher: typeof p.publisher === 'string' ? p.publisher : null,
      kind: p.kind === 'post' || p.kind === 'newsroom' ? p.kind : 'article',
      why: typeof p.why === 'string' ? p.why : null,
      age: r.age
    })
  }
  for (const r of results)
    if (!out.some((o) => o.url === r.url)) out.push({ url: r.url, title: r.title, publisher: null, kind: 'article', why: null, age: r.age })
  return out
}

export interface WebDeps extends Pick<SourceDeps, 'ffmpeg' | 'quotas'> {
  apiKey: () => string | null
  /** The page as it shows logged out (main/page-capture). */
  capture?: (url: string) => Promise<{ png: Buffer; width: number; height: number; title: string; url: string }>
  /** One Messages API call; the SDK's by default, recorded answers in tests. */
  create?: (params: MessageCreateParamsNonStreaming) => Promise<BetaMessage>
}

export function webSource(deps: WebDeps): BrollSource {
  const create =
    deps.create ??
    (async (params: MessageCreateParamsNonStreaming): Promise<BetaMessage> => {
      const key = deps.apiKey()
      if (!key) throw new Error('Add your Anthropic API key in Settings to look on the web.')
      const client = new Anthropic({ apiKey: key, timeout: 90_000, maxRetries: 1 })
      const bill = usageTicket('web-search')
      const answer = await client.beta.messages.create(params)
      bill(answer.model, answer.usage)
      return answer
    })
  return {
    id: 'web',
    name: 'a web search',
    paid: true,
    kinds: ['page', 'post'],
    async search(query, opts = {}) {
      if (!opts.paid) throw new Error('Looking on the web costs money, so it waits for you to say yes to its price.')
      if (!deps.apiKey() && !deps.create) throw new Error('Add your Anthropic API key in Settings to look on the web.')
      take(deps, 'web', 'The web search')
      const blocked = readSources(opts.brand?.block ?? [])
        .sources.filter((s) => s.kind === 'site' && !blueskyHandle(s.said))
        .map((s) => (s.kind === 'site' ? s.host : ''))
        .filter(Boolean)
        .slice(0, 20)
      const tool = { type: WEB_TOOL, name: 'web_search', max_uses: MAX_USES, ...(blocked.length ? { blocked_domains: blocked } : {}) }
      const messages: MessageCreateParamsNonStreaming['messages'] = [
        { role: 'user', content: `The moment: ${query}${opts.makers?.length ? `\nIt is about: ${opts.makers.join(', ')}` : ''}` }
      ]
      let answer: BetaMessage | null = null
      const content: BetaMessage['content'] = []
      // A long search can pause; the API carries on from where it stopped when asked again.
      for (let turn = 0; turn < 3; turn++) {
        answer = await create({
          model: WEB_MODEL,
          max_tokens: 4096,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'low' },
          system: SYSTEM,
          tools: [tool as unknown as NonNullable<MessageCreateParamsNonStreaming['tools']>[number]],
          messages
        } as MessageCreateParamsNonStreaming)
        content.push(...answer.content)
        if (answer.stop_reason !== 'pause_turn') break
        messages.push({ role: 'assistant', content: answer.content as unknown as MessageCreateParamsNonStreaming['messages'][number]['content'] })
      }
      if (answer?.stop_reason === 'refusal') throw new Error('Claude declined to look for this one.')
      return foundPages(content)
        .slice(0, opts.count ?? 6)
        .map(
          (f): Candidate => ({
            id: pageKey(f.url) ?? f.url,
            source: 'web',
            kind: f.kind === 'post' ? 'post' : 'page',
            title: f.title,
            author: f.publisher ?? (new URL(f.url).hostname.replace(/^www\./, '') || null),
            authorUrl: null,
            pageUrl: f.url,
            mediaUrl: null,
            previewUrl: null,
            width: null,
            height: null,
            durationSec: null,
            bytes: null,
            license: WEB_LICENSE,
            tags: [],
            extra: { why: f.why, published: f.age, found: f.kind }
          })
        )
    },
    async fetch(c, dir) {
      if (!c.pageUrl) throw new Error('That page has no address.')
      if (!deps.capture) throw new Error('Pages are captured by the app; this run cannot open one.')
      const shot = await deps.capture(c.pageUrl)
      const path = await fileIn(dir, c.title || 'page', 'png')
      await fs.writeFile(path, shot.png)
      return normalized(path, { ...c, title: shot.title || c.title }, null, deps.ffmpeg)
    }
  }
}
