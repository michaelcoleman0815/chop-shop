import { judge, LICENCE_TROUBLE, type LicenceTrouble, type PolicyOptions } from '../../shared/broll/policy'
import { partsOf, rankFor } from '../../shared/broll/rank'
import { makersIn, orientationOf, planFor, type Asked, type MomentResult } from '../../shared/broll/route'
import { listOf } from '../../shared/broll/text'
import {
  SOURCE_NAMES,
  type BrollSource,
  type Candidate,
  type Fetched,
  type FetchOptions,
  type Moment,
  type SourceId
} from '../../shared/broll/types'
import { QuotaError } from './sources/common'

/**
 * B-roll for the moments of an edit, from everywhere, the person's own
 * library first. For each moment the plan (shared/broll/route) says what it
 * wants and which sources to ask in what order; the library is asked first
 * and alone, and when it already has enough good matches nothing outside is
 * asked at all. Otherwise the planned sources are asked a few at a time,
 * each given a time limit and kept to its quota, and whatever has come back
 * by the moment's deadline is judged by the policy (shared/broll/policy:
 * the never list and the brand's blocked sources first, then the licence),
 * offered once each, and ranked, the best few with a reason each.
 *
 * Progress is reported in the words the crew's Scout answers to
 * ("Looking through your library", "Searching Pexels").
 */

export interface RouterDeps {
  sources: Partial<Record<SourceId, BrollSource>>
  /** Why a source cannot be asked now (no key, turned off), or null when it can. */
  why?: (id: SourceId) => string | null
  /** Brand names, as written, for spotting the makers a moment names (Simple Icons' titles in the app). */
  makers?: () => Promise<Map<string, string>> | Map<string, string>
}

export interface FindOptions {
  brand?: { prefer: string[]; block: string[] }
  never?: string[]
  policy?: Omit<PolicyOptions, 'brand' | 'never'>
  /** How many to offer for each moment. Default 3. */
  perMoment?: number
  /** Searches running at once, across every moment. Default 3. */
  concurrency?: number
  /** How long one source is given, by source; otherwise 12 seconds. */
  timeoutMs?: Partial<Record<SourceId, number>>
  /** How long a moment may take in all. Default 45 seconds. */
  deadlineMs?: number
  /** The person said yes to the price of the paid sources for this search. */
  paid?: boolean
  /** Ask only these sources: the web alone, once its price has been agreed to for a moment already looked for. */
  only?: SourceId[]
  signal?: AbortSignal
  onProgress?: (p: { stage: string; percent: number | null; moment: number }) => void
}

export type { Asked, MomentResult }

/** yt-dlp asks YouTube one channel at a time; the web search reads several pages; Openverse is slow to answer. */
const TIMEOUTS: Partial<Record<SourceId, number>> = {
  youtube: 45_000,
  'own-uploads': 45_000,
  web: 90_000,
  openverse: 30_000,
  steam: 20_000,
  bluesky: 20_000
}

/** Searches running at once: a queue the moments share. */
function limiter(n: number): <T>(job: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: (() => void)[] = []
  return async (job) => {
    while (active >= n) await new Promise<void>((r) => waiting.push(r))
    active++
    try {
      return await job()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** A promise held to a time limit, and stopped early when the person stops. */
function within<T>(ms: number, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController()
  const stop = (): void => ctrl.abort()
  signal?.addEventListener('abort', stop, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort()
      reject(new Error('it did not answer in time'))
    }, ms)
  })
  return Promise.race([run(ctrl.signal), late]).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  })
}

/** The words each source is asked with. */
function queryFor(id: SourceId, m: Moment): string {
  if (id === 'logos') return `${m.search} ${m.said}`
  if (id === 'web') return `${m.search}. What is said there: “${m.said}”. The video is about ${m.topic}.`
  return m.search
}

/** A note begins with a capital, whatever source it names first ("the Internet Archive", "a web search"). */
const sentence = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const stageFor = (id: SourceId): string => (id === 'library' ? 'Looking through your library' : `Searching ${SOURCE_NAMES[id]}`)

/** Library matches good enough that nothing outside needs asking: the words match well and the policy allows them. */
const STRONG = 0.6

export async function findBroll(moments: Moment[], deps: RouterDeps, opts: FindOptions = {}): Promise<MomentResult[]> {
  const perMoment = opts.perMoment ?? 3
  const run = limiter(Math.max(1, opts.concurrency ?? 3))
  const policy: PolicyOptions = { ...opts.policy, brand: opts.brand, never: opts.never }
  const names = deps.makers ? await deps.makers() : null

  const one = async (m: Moment, at: number): Promise<MomentResult> => {
    const plan = planFor(m, {
      available: {
        why: (id) => {
          const source = deps.sources[id]
          if (!source) return id === 'generated' ? 'no generation service is set up' : `${SOURCE_NAMES[id]} is not set up`
          if (source.paid && !opts.paid) return 'it costs money and waits for your yes'
          return deps.why?.(id) ?? null
        }
      },
      never: opts.never,
      block: opts.brand?.block
    })
    if (opts.only) plan.sources = plan.sources.filter((id) => opts.only?.includes(id))
    const notes = [...plan.notes]
    const asked: Asked[] = []
    const found: { candidate: Candidate; place: number; of: number }[] = []
    if (plan.sources.length === 0) return { moment: m, plan, results: [], asked, notes }
    const makers = plan.official ? (m.makers ?? (names ? makersIn(`${m.said} ${m.search}`, names) : [])) : []
    const deadline = Date.now() + (opts.deadlineMs ?? 45_000)
    let blocked = 0
    let unlicensed = 0
    const troubles = new Set<LicenceTrouble>()

    const ask = async (id: SourceId): Promise<void> => {
      const source = deps.sources[id] as BrollSource
      const kinds = plan.kinds.filter((k) => source.kinds.includes(k))
      if (kinds.length === 0) return
      const started = Date.now()
      opts.onProgress?.({ stage: stageFor(id), percent: null, moment: at })
      const limit = Math.max(1000, Math.min(opts.timeoutMs?.[id] ?? TIMEOUTS[id] ?? 12_000, deadline - Date.now()))
      try {
        const got = await run(() =>
          within(limit, opts.signal, (signal) =>
            source.search(queryFor(id, m), {
              kinds,
              count: 12,
              orientation: orientationOf(m.output),
              makers,
              brand: opts.brand,
              paid: opts.paid === true,
              signal
            })
          )
        )
        let kept = 0
        for (const [place, c] of got.entries()) {
          const v = judge(c, policy)
          if (!v.ok) {
            if (v.by === 'blocked') blocked++
            if (v.by === 'license') {
              unlicensed++
              troubles.add(v.trouble)
            }
            continue
          }
          kept++
          found.push({ candidate: v.preferred ? { ...c, preferred: true } : c, place, of: got.length })
        }
        asked.push({ id, found: got.length, kept, ms: Date.now() - started })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        asked.push({ id, found: 0, kept: 0, ms: Date.now() - started, error: message })
        if (err instanceof QuotaError || /key in Settings/.test(message)) notes.push(message)
      }
    }

    // The library first, on its own: it is the person's, it is on this computer, and it may be enough.
    if (plan.sources[0] === 'library') {
      await ask('library')
      const strong = found.filter((f) => partsOf(f.candidate, m, { order: plan.sources }).text >= STRONG)
      if (strong.length >= perMoment) {
        notes.push('Your library had enough that fits, so I did not look anywhere else.')
        return { moment: m, plan, results: rankFor(m, found, { order: plan.sources, count: perMoment }), asked, notes }
      }
    }
    await Promise.all(plan.sources.filter((id) => id !== 'library').map(ask))

    const failed = asked.filter((a) => a.error && !/key in Settings|all the searches it allows/.test(a.error)).map((a) => SOURCE_NAMES[a.id])
    if (failed.length) notes.push(sentence(`${listOf(failed)} did not answer, so ${failed.length === 1 ? 'it was' : 'they were'} left out.`))
    if (blocked) notes.push(`${blocked === 1 ? 'One result was' : `${blocked} results were`} from a source the brand never uses, so I left ${blocked === 1 ? 'it' : 'them'} out.`)
    if (unlicensed) {
      const why = listOf([...troubles].map((t) => LICENCE_TROUBLE[t]))
      notes.push(`${unlicensed === 1 ? 'One result had a licence' : `${unlicensed} results had licences`} this video cannot use (${why}), so I left ${unlicensed === 1 ? 'it' : 'them'} out.`)
    }
    const results = rankFor(m, found, { order: plan.sources, count: perMoment })
    if (results.length === 0) {
      // The skipped sources' reasons (a key to add, a source to turn on) are in the plan for the reply to offer.
      const noBrand = plan.intent === 'logo' && asked.some((a) => a.id === 'logos' && !a.error && a.found === 0)
      notes.push(noBrand ? 'It names no brand whose logo I have, so there is no logo to show.' : 'Nothing I found fits this moment closely enough.')
    }
    return { moment: m, plan, results, asked, notes }
  }

  return Promise.all(moments.map((m, i) => one(m, i)))
}

/**
 * The picked candidate as a file in the edit's folder, normalized and
 * credited. The never list and the brand's blocked sources are checked
 * again first: either can have changed since the search.
 */
export async function fetchPick(
  candidate: Candidate,
  dir: string,
  deps: RouterDeps,
  opts: FetchOptions & { brand?: { prefer: string[]; block: string[] }; never?: string[]; policy?: FindOptions['policy'] } = {}
): Promise<Fetched> {
  const v = judge(candidate, { ...opts.policy, brand: opts.brand, never: opts.never })
  if (!v.ok) throw new Error(v.why)
  const source = deps.sources[candidate.source]
  if (!source) throw new Error(`${SOURCE_NAMES[candidate.source]} is not set up.`)
  opts.onProgress?.(0)
  return source.fetch(candidate, dir, opts)
}
