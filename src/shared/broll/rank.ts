import { listOf, overlap, stem, stems, words } from './text'
import { SOURCE_NAMES, type Candidate, type Moment, type Ranked, type SourceId } from './types'

/**
 * Which candidates to offer for a moment, best first, each with why in one
 * line. A candidate scores on how well its words match what was searched
 * for and said, whether it has the pixels the output needs, how much of it
 * survives being fitted to the output's shape, whether it runs as long as
 * the shot, its licence, and where it is from: the person's own library
 * first, then sources the brand prefers and makers' own channels.
 *
 * The same thing found twice (Openverse lists Wikimedia's files too) is
 * offered once.
 */

export interface Parts {
  text: number
  relevance: number
  resolution: number
  aspect: number
  duration: number
  license: number
  source: number
}

const WEIGHTS: Parts = { text: 0.3, relevance: 0.06, resolution: 0.14, aspect: 0.12, duration: 0.1, license: 0.14, source: 0.14 }

/** How near the top of its own source's answer a candidate with no word in common must be to be offered at all. */
const RELEVANT = 0.75

/** The words a moment wants, each with how much it counts: searched for twice what was said, the topic half. */
export function wanted(m: Pick<Moment, 'search' | 'said' | 'topic'>): { stem: string; weight: number }[] {
  const out = new Map<string, number>()
  const add = (text: string, weight: number): void => {
    for (const s of stems(text)) out.set(s, Math.max(out.get(s) ?? 0, weight))
  }
  add(m.topic, 0.5)
  add(m.said, 1)
  add(m.search, 2)
  return [...out].map(([s, weight]) => ({ stem: s, weight }))
}

/** What a candidate is filed under, as stems. */
function haveOf(c: Candidate): Set<string> {
  return new Set(stems(`${c.title} ${c.tags.join(' ')} ${typeof c.extra?.description === 'string' ? c.extra.description : ''}`))
}

const VISUAL = new Set(['video', 'image', 'gif'])

/** Each part of a candidate's score, from 0 to 1. `place` is where its own source ranked it, from 0. */
export function partsOf(
  c: Candidate,
  m: Moment,
  ctx: { order: SourceId[]; place?: number; of?: number; want?: { stem: string; weight: number }[] }
): Parts {
  const want = ctx.want ?? wanted(m)
  const text = overlap(want, haveOf(c))
  const relevance = ctx.of && ctx.of > 1 ? 1 - (ctx.place ?? 0) / ctx.of : 1

  let resolution = 0.8
  let aspect = 0.7
  if (VISUAL.has(c.kind) && c.width && c.height) {
    // Shown whole or cropped, it needs the output's pixels along the side that fits.
    const contain = Math.min(m.output.width / c.width, m.output.height / c.height)
    resolution = contain <= 1 ? 1 : Math.max(0.1, 1 / contain)
    const a = c.width / c.height
    const o = m.output.width / Math.max(1, m.output.height)
    aspect = Math.min(a, o) / Math.max(a, o)
  } else if (VISUAL.has(c.kind)) {
    resolution = 0.5
    aspect = 0.5
  } else if (c.kind === 'post') {
    // A post card is drawn at the output's own shape.
    aspect = 1
  }

  const need = m.seconds && m.seconds > 0 ? m.seconds : 4
  let duration = 1
  if (c.kind === 'video') duration = c.durationSec ? Math.min(1, c.durationSec / need) : 0.5
  else if (c.kind === 'image' || c.kind === 'page' || c.kind === 'post' || c.kind === 'logo') duration = 0.75
  else if (c.kind === 'gif') duration = 0.8

  const l = c.license
  const license =
    l.id === 'own' ? 1 : l.monetized === 'your-call' ? 0.45 : l.monetized === 'yes' ? (l.credit ? 0.85 : 0.95) : 0

  const at = ctx.order.indexOf(c.source)
  const source =
    c.source === 'library'
      ? 1
      : c.source === 'own-uploads'
        ? 0.95
        : c.preferred || c.official
          ? 0.9
          : Math.max(0.5, 0.78 - 0.03 * Math.max(0, at))

  return { text, relevance, resolution, aspect, duration, license, source }
}

export function total(p: Parts): number {
  return (Object.keys(WEIGHTS) as (keyof Parts)[]).reduce((sum, k) => sum + WEIGHTS[k] * p[k], 0)
}

/** "4K", "1080p", "720p", or the pixels when it is none of those. */
export function sizeLabel(width: number | null, height: number | null): string | null {
  if (!width || !height) return null
  const short = Math.min(width, height)
  if (short >= 2100) return '4K'
  if (short >= 1400) return '1440p'
  if (short >= 1060) return '1080p'
  if (short >= 700) return '720p'
  return `${width}×${height}`
}

function seconds(n: number): string {
  return n >= 90 ? `${Math.round(n / 60)} min` : `${Math.round(n)} s`
}

/** What a candidate is, from where: "Pexels video", "A clip from the maker’s own channel", "From your library". */
function what(c: Candidate): string {
  const kind =
    c.kind === 'video'
      ? 'video'
      : c.kind === 'image'
        ? 'photo'
        : c.kind === 'gif'
          ? 'GIF'
          : c.kind === 'logo'
            ? 'logo'
            : c.kind === 'page'
              ? 'page'
              : c.kind === 'post'
                ? 'post'
                : 'sound'
  switch (c.source) {
    case 'library':
      return `From your library, ${c.alpha ? 'an overlay with transparency' : `a ${kind}`}`
    case 'own-uploads':
      return 'From one of your own videos'
    case 'youtube':
      return c.official
        ? 'A clip from the maker’s own channel'
        : c.preferred
          ? 'A clip from a channel you prefer'
          : 'A YouTube clip'
    case 'steam':
      return c.kind === 'video' ? 'The game’s trailer from its Steam page' : 'A screenshot from the game’s Steam page'
    case 'bluesky':
      return `A Bluesky post${c.author ? ` by ${c.author}` : ''}, drawn as a post card`
    case 'logos':
      return `The ${c.title} logo`
    case 'web':
      return `The page itself${c.author ? `, on ${c.author}` : ''}, captured as you would see it`
    default:
      return `${SOURCE_NAMES[c.source].replace(/^the /, 'The ').replace(/^(\p{Ll})/u, (x) => x.toUpperCase())} ${kind}`
  }
}

/** How it may be used, in a few words. */
function licensePhrase(c: Candidate): string {
  const l = c.license
  if (l.id === 'own') return 'yours'
  if (l.monetized === 'your-call') return 'credited; fair use is your call'
  if (l.id === 'trademark') return 'shown as it is, only to name the brand'
  if (!l.credit) return `no credit needed (${l.name})`
  return `${l.name}, credited`
}

/** Why a candidate is offered, in one line. */
export function reasonFor(c: Candidate, p: Parts, m: Moment): string {
  const bits: string[] = []
  const size = VISUAL.has(c.kind) ? sizeLabel(c.width, c.height) : null
  if (size) bits.push(size)
  if (c.kind === 'video' && c.durationSec) bits.push(seconds(c.durationSec))
  bits.push(licensePhrase(c))
  const have = haveOf(c)
  const matched: string[] = []
  const stemsSeen = new Set<string>()
  for (const w of words(`${m.search} ${m.said}`)) {
    const s = stem(w)
    if (have.has(s) && !stemsSeen.has(s) && matched.length < 3) matched.push(w)
    stemsSeen.add(s)
  }
  const match = matched.length ? `matches ${listOf(matched)}` : p.relevance >= 0.8 ? `a top result for “${m.search}”` : null
  // Only what is known is said: a candidate whose size is not known yet is not called small or the wrong shape.
  const sized = VISUAL.has(c.kind) && !!c.width && !!c.height
  const fit =
    sized && p.aspect < 0.6
      ? m.output.height > m.output.width
        ? 'wide, so it is cropped or shown on a blurred fill'
        : 'tall, so it is cropped or shown on a blurred fill'
      : sized && p.resolution < 0.6
        ? 'small for this output'
        : null
  return `${what(c)}${bits.length ? `, ${bits.join(', ')}` : ''}${match ? `; ${match}` : ''}${fit ? `; ${fit}` : ''}.`
}

/** An address reduced to what identifies the page: no scheme, no www, no tracking, no trailing slash. */
export function pageKey(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ixid|ixlib|fm$|q$|w$|auto$|fit$|crop$|t$)/.test(k)) u.searchParams.delete(k)
    const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '')
    return `${host}${decodeURIComponent(u.pathname).replace(/\/+$/, '')}${u.search}`
  } catch {
    return url
  }
}

/**
 * The keys a candidate is known by: its id, and its file, or its page when
 * it has no file. A page can hold several things (a game's trailers and
 * screenshots), while the same file found by two sources is one thing.
 */
function keysOf(c: Candidate): string[] {
  const thing = c.mediaUrl ? `file:${pageKey(c.mediaUrl)}` : c.pageUrl ? `page:${pageKey(c.pageUrl)}` : null
  return [`${c.source}:${c.id}`, thing].filter((k): k is string => !!k)
}

export interface Scored {
  candidate: Candidate
  parts: Parts
  score: number
}

/** Each thing once: of two the same, the better-scored is kept. */
export function dedupe(list: Scored[]): Scored[] {
  const best = new Map<string, Scored>()
  const order: Scored[] = []
  for (const s of [...list].sort((a, b) => b.score - a.score)) {
    const keys = keysOf(s.candidate)
    if (keys.some((k) => best.has(k))) continue
    for (const k of keys) best.set(k, s)
    order.push(s)
  }
  return order
}

/**
 * The best few for a moment, each with its reason. A second pick from the
 * same source is worth a little less than the first, so the few offered are
 * a choice rather than three of one site.
 */
export function rankFor(
  m: Moment,
  found: { candidate: Candidate; place: number; of: number }[],
  opts: { order: SourceId[]; count?: number }
): Ranked[] {
  const want = wanted(m)
  const scored = dedupe(
    found.map((f) => {
      const parts = partsOf(f.candidate, m, { order: opts.order, place: f.place, of: f.of, want })
      return { candidate: f.candidate, parts, score: total(parts) }
    })
  ).filter(
    // Nothing that shares no word with the moment and that its own source did not rank near the top.
    (s) => s.parts.text > 0 || s.parts.relevance >= RELEVANT
  )
  const count = opts.count ?? 3
  const out: Ranked[] = []
  const used = new Map<SourceId, number>()
  const pool = [...scored]
  while (out.length < count && pool.length) {
    let bestAt = 0
    let bestScore = -Infinity
    for (const [i, s] of pool.entries()) {
      const adjusted = s.score - 0.06 * (used.get(s.candidate.source) ?? 0)
      if (adjusted > bestScore) {
        bestScore = adjusted
        bestAt = i
      }
    }
    const [pick] = pool.splice(bestAt, 1)
    used.set(pick.candidate.source, (used.get(pick.candidate.source) ?? 0) + 1)
    out.push({ candidate: pick.candidate, score: Number(pick.score.toFixed(4)), reason: reasonFor(pick.candidate, pick.parts, m) })
  }
  return out
}
