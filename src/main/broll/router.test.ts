import { describe, expect, it } from 'vitest'
import { CC0, FAIR_USE, OWN, PEXELS, openverseLicense } from '../../shared/broll/license'
import { createQuotas } from '../../shared/broll/quota'
import type { BrollSource, Candidate, Moment, SearchOptions, SourceId } from '../../shared/broll/types'
import { fetchPick, findBroll } from './router'
import { QuotaError, take } from './sources/common'

/**
 * The router's fan-out against stand-in sources whose answers, delays and
 * failures each test sets: the library asked first and alone, the rest a few
 * at a time with a time limit each, the policy over everything, and the best
 * few ranked with a reason.
 */

const m = (over: Partial<Moment> = {}): Moment => ({
  said: 'the keyboard on this new laptop feels great',
  search: 'laptop keyboard close up',
  topic: 'laptop review',
  format: 'long',
  output: { width: 1920, height: 1080 },
  seconds: 4,
  niche: 'tech',
  ...over
})

const cand = (source: SourceId, id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  source,
  kind: 'video',
  title: 'Laptop keyboard close up',
  author: 'Example',
  authorUrl: null,
  pageUrl: `https://${source}.example/${id}`,
  mediaUrl: null,
  previewUrl: null,
  width: 1920,
  height: 1080,
  durationSec: 10,
  bytes: null,
  license: source === 'library' || source === 'own-uploads' ? OWN : source === 'youtube' ? FAIR_USE : PEXELS,
  tags: [],
  ...over
})

interface Log {
  calls: { id: SourceId; at: number; opts: SearchOptions }[]
  active: number
  most: number
}

function fake(id: SourceId, found: Candidate[] | (() => Promise<Candidate[]>), log: Log, opts: { delay?: number; paid?: boolean; kinds?: BrollSource['kinds'] } = {}): BrollSource {
  return {
    id,
    name: id,
    kinds: opts.kinds ?? ['video', 'image', 'page', 'post', 'logo', 'gif', 'audio'],
    paid: opts.paid,
    async search(_q, o = {}) {
      log.calls.push({ id, at: Date.now(), opts: o })
      log.active++
      log.most = Math.max(log.most, log.active)
      try {
        if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay))
        return typeof found === 'function' ? await found() : found
      } finally {
        log.active--
      }
    },
    async fetch(c) {
      return { asset: { kind: 'video', path: `/tmp/${c.id}.mp4`, title: c.title, durationSec: 4, width: 1920, height: 1080, origin: { type: 'link', url: c.pageUrl, author: c.author, license: null, range: null } }, credit: 'credit' }
    }
  }
}

const newLog = (): Log => ({ calls: [], active: 0, most: 0 })

describe('the router', () => {
  it('asks the library first and alone, and nothing else when it already has enough that fits', async () => {
    const log = newLog()
    const lib = [1, 2, 3].map((i) => cand('library', `l${i}`, { title: `new laptop keyboard close up ${i}`, pageUrl: null }))
    const [r] = await findBroll([m()], {
      sources: { library: fake('library', lib, log), youtube: fake('youtube', [cand('youtube', 'y1')], log), pexels: fake('pexels', [cand('pexels', 'p1')], log) }
    })
    expect(log.calls.map((c) => c.id)).toEqual(['library'])
    expect(r.results.map((x) => x.candidate.source)).toEqual(['library', 'library', 'library'])
    expect(r.notes).toContain('Your library had enough that fits, so I did not look anywhere else.')
    expect(r.results[0].reason).toMatch(/^From your library/)
  })

  it('looks further when the library has too little, a few sources at a time', async () => {
    const log = newLog()
    const slow = (id: SourceId, n: number) => fake(id, [cand(id, `${id}${n}`, { pageUrl: `https://${id}.example/${n}` })], log, { delay: 60 })
    const [r] = await findBroll(
      [m()],
      { sources: { library: fake('library', [], log), 'own-uploads': slow('own-uploads', 1), youtube: slow('youtube', 1), pexels: slow('pexels', 1), pixabay: slow('pixabay', 1), unsplash: slow('unsplash', 1), openverse: slow('openverse', 1), wikimedia: slow('wikimedia', 1) } },
      { concurrency: 2 }
    )
    expect(log.calls[0].id).toBe('library')
    expect(log.most).toBeLessThanOrEqual(2)
    expect(r.results).toHaveLength(3)
    // Their own earlier footage first, then the maker's channel before the stock sites.
    expect(r.results[0].candidate.source).toBe('own-uploads')
  })

  it('gives each source a time limit and leaves out the ones that miss it, saying so', async () => {
    const log = newLog()
    const [r] = await findBroll(
      [m()],
      {
        sources: {
          library: fake('library', [], log),
          pexels: fake('pexels', [cand('pexels', 'p1')], log),
          youtube: fake('youtube', [cand('youtube', 'y1')], log, { delay: 2000 })
        }
      },
      { timeoutMs: { youtube: 1000 } }
    )
    expect(r.asked.find((a) => a.id === 'youtube')?.error).toMatch(/did not answer in time/)
    expect(r.results.map((x) => x.candidate.id)).toEqual(['p1'])
    expect(r.notes.join(' ')).toMatch(/YouTube did not answer, so it was left out\./)
  })

  it('passes a quota or a missing key on in the person’s words', async () => {
    const log = newLog()
    const quotas = createQuotas({ limits: { pexels: { perHour: 0 } } })
    const limited: BrollSource = {
      ...fake('pexels', [], log),
      async search() {
        take({ quotas }, 'pexels', 'Pexels')
        return []
      }
    }
    const [r] = await findBroll([m()], { sources: { library: fake('library', [], log), pexels: limited } })
    expect(r.notes.join(' ')).toMatch(/Pexels has had all the searches it allows for now\. It frees up in \d+ (seconds|minutes)\./)
    expect(() => take({ quotas }, 'pexels', 'Pexels')).toThrow(QuotaError)
  })

  it('lets the never list and the brand’s blocked sources win over everything found', async () => {
    const log = newLog()
    const sources = {
      library: fake('library', [cand('library', 'mine', { title: 'keyboard', pageUrl: null })], log),
      'own-uploads': fake('own-uploads', [], log),
      youtube: fake('youtube', [cand('youtube', 'y1', { pageUrl: 'https://www.youtube.com/watch?v=abcdefghijk', extra: { handle: '@reuploads' } })], log),
      pexels: fake('pexels', [cand('pexels', 'p1', { pageUrl: 'https://www.pexels.com/video/p-1/' })], log)
    }
    const [never] = await findBroll([m()], { sources }, { never: ['broll'] })
    expect(never.plan.sources).toEqual(['library', 'own-uploads'])
    expect(never.results.map((x) => x.candidate.id)).toEqual(['mine'])
    const [blocked] = await findBroll([m()], { sources }, { brand: { prefer: [], block: ['@reuploads', 'pexels.com'] } })
    expect(blocked.results.map((x) => x.candidate.id)).toEqual(['mine'])
    expect(blocked.plan.skipped).toContainEqual({ id: 'pexels', why: 'the brand never uses Pexels' })
    expect(blocked.notes.join(' ')).toMatch(/One result was from a source the brand never uses/)
  })

  it('leaves out licences this video cannot use, and says how many and why', async () => {
    const log = newLog()
    const [r] = await findBroll([m({ search: 'mountain lake sunrise', said: 'a calm morning', niche: 'church' })], {
      sources: {
        library: fake('library', [], log),
        openverse: fake('openverse', [cand('openverse', 'nc', { license: openverseLicense('by-nc', '4.0') }), cand('openverse', 'ok', { license: CC0, title: 'mountain lake sunrise' })], log)
      }
    })
    expect(r.results.map((x) => x.candidate.id)).toEqual(['ok'])
    expect(r.notes).toContain('One result had a licence this video cannot use (no commercial use), so I left it out.')
    const [two] = await findBroll([m({ search: 'mountain lake sunrise', said: 'a calm morning', niche: 'church' })], {
      sources: {
        library: fake('library', [], log),
        openverse: fake('openverse', [
          cand('openverse', 'nc', { license: openverseLicense('by-nc', '4.0') }),
          cand('openverse', 'sa', { license: openverseLicense('by-sa', '4.0') })
        ], log)
      }
    })
    expect(two.notes).toContain('2 results had licences this video cannot use (no commercial use and share-alike), so I left them out.')
  })

  it('says so when nothing fits, and when a logo moment names no brand it knows', async () => {
    const log = newLog()
    const [none] = await findBroll([m({ search: 'mountain lake sunrise', said: 'a calm morning', niche: 'church' })], {
      sources: { library: fake('library', [], log), pexels: fake('pexels', [], log) }
    })
    expect(none.results).toEqual([])
    expect(none.notes).toContain('Nothing I found fits this moment closely enough.')
    const [logo] = await findBroll([m({ search: 'company logo', said: 'and here is the logo' })], {
      sources: { library: fake('library', [], log), logos: fake('logos', [], log) }
    })
    expect(logo.plan.intent).toBe('logo')
    expect(logo.notes).toContain('It names no brand whose logo I have, so there is no logo to show.')
  })

  it('asks the maker’s channel for a product, and marks what the brand prefers', async () => {
    const log = newLog()
    await findBroll(
      [m({ said: 'the new laptop from Examplecorp has a great keyboard' })],
      { sources: { library: fake('library', [], log), youtube: fake('youtube', [], log) }, makers: () => new Map([['Examplecorp', 'Examplecorp']]) },
      { brand: { prefer: ['@examplechannel'], block: [] } }
    )
    const yt = log.calls.find((c) => c.id === 'youtube')
    expect(yt?.opts.makers).toEqual(['Examplecorp'])
    expect(yt?.opts.brand?.prefer).toEqual(['@examplechannel'])
    expect(yt?.opts.orientation).toBe('landscape')
  })

  it('never asks a paid source without the person’s yes to its price', async () => {
    const log = newLog()
    const web = fake('web', [cand('web', 'w1', { kind: 'page', license: FAIR_USE })], log, { paid: true })
    const moment = m({ search: 'streaming service price increase', said: 'a streaming service raises its prices' })
    const [no] = await findBroll([moment], { sources: { library: fake('library', [], log), web } })
    expect(log.calls.map((c) => c.id)).not.toContain('web')
    expect(no.plan.skipped).toContainEqual({ id: 'web', why: 'it costs money and waits for your yes' })
    await findBroll([moment], { sources: { library: fake('library', [], log), web } }, { paid: true })
    expect(log.calls.find((c) => c.id === 'web')?.opts.paid).toBe(true)
  })

  it('checks the never list again before fetching, as it may have changed since the search', async () => {
    const log = newLog()
    const sources = { pexels: fake('pexels', [], log) }
    await expect(fetchPick(cand('pexels', 'p1'), '/tmp', { sources }, { never: ['broll'] })).rejects.toThrow('The channel never uses B-roll from outside.')
    await expect(fetchPick(cand('pexels', 'p1'), '/tmp', { sources })).resolves.toMatchObject({ credit: 'credit' })
  })

  it('answers every moment, each with its own plan', async () => {
    const log = newLog()
    const results = await findBroll(
      [m(), m({ search: 'bar chart of revenue', said: 'revenue doubled' }), m({ search: 'rocket launch', said: 'it went up like a rocket' })],
      { sources: { library: fake('library', [], log), nasa: fake('nasa', [cand('nasa', 'n1', { license: CC0, title: 'rocket launch' })], log) } }
    )
    expect(results.map((r) => r.plan.intent)).toEqual(['product', 'chart', 'space'])
    expect(results[1].results).toEqual([])
    expect(results[2].results[0].candidate.id).toBe('n1')
  })
})
