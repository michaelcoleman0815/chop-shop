import type { BetaMessage, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { createQuotas } from '../../shared/broll/quota'
import { ffmpegRun, findFfmpeg } from '../test-media'
import { claudeWebAnswer } from './fixtures/api'
import { foundPages, quoteWebSearch, webSource, WEB_MODEL, WEB_TOOL } from './sources/web'
import { readFileSync } from 'fs'

/**
 * Pages, newsroom pictures and posts found by Claude's server-side web
 * search, against a recorded answer in the tool's documented block shapes.
 * Nothing is sent: `create` stands in for the SDK call.
 */

const FFMPEG = findFfmpeg()
const dir = mkdtempSync(join(tmpdir(), 'cutalong-broll-web-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function recorder(answers: Record<string, unknown>[]): { create: (p: MessageCreateParamsNonStreaming) => Promise<BetaMessage>; sent: MessageCreateParamsNonStreaming[] } {
  const sent: MessageCreateParamsNonStreaming[] = []
  let i = 0
  return {
    sent,
    create: async (p) => {
      sent.push(JSON.parse(JSON.stringify(p)) as MessageCreateParamsNonStreaming)
      return answers[Math.min(i++, answers.length - 1)] as unknown as BetaMessage
    }
  }
}

describe('looking on the web through Claude', () => {
  it('never searches without the person’s yes to its price', async () => {
    const r = recorder([claudeWebAnswer()])
    const src = webSource({ ffmpeg: 'ffmpeg', apiKey: () => 'sk-ant-test', create: r.create })
    await expect(src.search('streaming service price increase')).rejects.toThrow(/costs money/)
    expect(r.sent).toHaveLength(0)
  })

  it('asks with the current web search tool, keeps the brand’s blocked sites out, and offers only pages the search returned', async () => {
    const r = recorder([claudeWebAnswer()])
    const src = webSource({ ffmpeg: 'ffmpeg', apiKey: () => 'sk-ant-test', create: r.create, quotas: createQuotas({}) })
    const found = await src.search('streaming service price increase', { paid: true, brand: { prefer: [], block: ['tabloid.example.com', '@somechannel'] } })
    const p = r.sent[0] as unknown as Record<string, unknown> & { tools: Record<string, unknown>[]; output_config: Record<string, unknown> }
    expect(p.model).toBe(WEB_MODEL)
    expect(p.tools[0]).toEqual({ type: WEB_TOOL, name: 'web_search', max_uses: 3, blocked_domains: ['tabloid.example.com'] })
    expect(p.output_config).toEqual({ effort: 'low' })
    expect(p.fallbacks).toBe('default')
    // Claude's list first, the invented address dropped, then the rest of what the search returned.
    expect(found.map((c) => c.pageUrl)).toEqual([
      'https://about.example-stream.com/newsroom/pricing',
      'https://news.example.com/2026/10/streaming-prices',
      'https://blog.example.org/opinion'
    ])
    expect(found[0]).toMatchObject({ source: 'web', kind: 'page', author: 'Example Stream', license: { monetized: 'your-call' }, extra: { found: 'newsroom' } })
    expect(found[2].author).toBe('blog.example.org')
  })

  it('carries on when a long search pauses, without adding words of its own', async () => {
    const r = recorder([claudeWebAnswer('pause_turn'), claudeWebAnswer()])
    const src = webSource({ ffmpeg: 'ffmpeg', apiKey: () => 'sk-ant-test', create: r.create })
    const found = await src.search('streaming service price increase', { paid: true })
    expect(r.sent).toHaveLength(2)
    const second = r.sent[1].messages
    expect(second.map((x) => x.role)).toEqual(['user', 'assistant'])
    expect(found).toHaveLength(3)
  })

  it('reads the search’s own results even when Claude’s list cannot be read', () => {
    const answer = claudeWebAnswer() as unknown as BetaMessage
    const noList = answer.content.filter((b) => b.type !== 'text')
    expect(foundPages(noList).map((f) => f.url)).toEqual([
      'https://news.example.com/2026/10/streaming-prices',
      'https://about.example-stream.com/newsroom/pricing',
      'https://blog.example.org/opinion'
    ])
  })

  it('says what it may cost before anything is spent', () => {
    const q = quoteWebSearch(1)
    expect(q.searches).toBe(3)
    expect(q.low).toBeCloseTo(0.034, 3)
    expect(q.high).toBeCloseTo(0.12, 3)
    expect(q.said).toBe('Looking on the web for this moment costs about 3 cents to 12 cents on your Anthropic account, for at most 3 web searches.')
    expect(quoteWebSearch(3).said).toMatch(/^Looking on the web for 3 moments costs about 10 cents to 36 cents/)
  })

  it('captures the picked page as it shows logged out, and credits it', async () => {
    if (!FFMPEG) return
    const png = join(dir, 'page.png')
    ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'color=c=white:s=860x1600', '-frames:v', '1', png])
    const r = recorder([claudeWebAnswer()])
    const captured: string[] = []
    const src = webSource({
      ffmpeg: FFMPEG,
      apiKey: () => 'sk-ant-test',
      create: r.create,
      capture: async (url) => {
        captured.push(url)
        return { png: readFileSync(png), width: 860, height: 1600, title: 'Our new plans', url }
      }
    })
    const [page] = await src.search('streaming prices', { paid: true })
    const got = await src.fetch(page, join(dir, 'assets'))
    expect(captured).toEqual(['https://about.example-stream.com/newsroom/pricing'])
    expect(got.asset).toMatchObject({ kind: 'image', width: 860, height: 1600, origin: { type: 'link', license: null } })
    expect(got.credit).toBe('“Our new plans”, Example Stream https://about.example-stream.com/newsroom/pricing')
  })
})
