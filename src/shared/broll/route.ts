import { covering, type NeverItem } from '../never'
import { isOutside, sourceBlocked } from './policy'
import { stem, words } from './text'
import { SOURCE_NAMES, type BrollIntent, type BrollKind, type Moment, type SourceId } from './types'

/**
 * Which B-roll a moment wants and where to look for it, in order. The
 * person's own library is always asked first; what follows depends on what
 * the moment shows: a product from its maker's own channel, a game from its
 * store page, a headline as the page it was on, space from NASA, the past
 * from the Internet Archive, a reaction from GIPHY, the rest from the stock
 * sites. A data chart is drawn by the graphics code, so nothing is looked
 * for.
 *
 * Words decide it, so the same moment always routes the same way; the
 * planner can say what it wants instead, and that wins.
 */

const W = (s: string): string[] => s.split(' ').map(stem)

/** Words that point to each kind of shot. Stems, so "launches" and "launched" count as "launch". */
const SIGNS: Record<Exclude<BrollIntent, 'concept'>, string[]> = {
  product: W(
    'laptop notebook phone smartphone tablet keyboard mouse monitor display screen camera lens headphones earbuds headset ' +
      'speaker smartwatch watch chip processor cpu gpu console controller drone router charger battery gadget device ' +
      'unboxing specs spec review model edition prototype trailer teaser keynote product'
  ),
  news: W(
    'news announce announced announcement report reported headline article lawsuit sued court ruling regulator ban banned ' +
      'raise raises price prices pricing hike layoffs acquisition acquire acquires merger earnings stock shares ceo statement ' +
      'leak leaked outage breach hacked recall policy subscription subscribers increase cost costs fine fined'
  ),
  social: W('tweet tweeted post posted thread reply replied bluesky social viral comment comments followers feed'),
  game: W(
    'game games gaming gameplay gamer boss level levels quest speedrun esports multiplayer rpg shooter mmo dlc patch ' +
      'steam indie playthrough raid loot respawn'
  ),
  logo: W('logo logos brand branding wordmark trademark'),
  reaction: W(
    'reaction react reacts facepalm shrug eyeroll laugh laughing lol wow cringe applause clapping celebrate celebration ' +
      'dancing meme surprised shocked confused awkward gif blown'
  ),
  archival: W(
    'archival archive archives vintage history historical newsreel retro classic decade century ancient ' +
      '1920s 1930s 1940s 1950s 1960s 1970s 1980s 1990s twenties thirties forties fifties sixties seventies eighties nineties'
  ),
  space: W(
    'space nasa rocket orbit orbital satellite moon lunar mars planet planets galaxy star stars nebula astronaut iss ' +
      'telescope solar eclipse comet asteroid cosmos universe spacecraft'
  ),
  nature: W(
    'nature forest tree trees ocean sea beach wave waves mountain mountains river lake waterfall sunrise sunset sky ' +
      'clouds rain storm snow desert field flowers wildlife animal animals birds landscape hills valley garden'
  ),
  people: W(
    'people person crowd audience congregation team family friends kids children couple student students worker workers ' +
      'praying prayer choir community volunteers meeting worship singing hands'
  ),
  chart: W('chart charts graph graphs statistic statistics percentage percent data diagram')
}

/**
 * Which kind wins when two score the same: the more particular first. A
 * game's trailer is the game's; a film's trailer is its studio's product.
 */
const PRIORITY: BrollIntent[] = [
  'chart',
  'game',
  'logo',
  'social',
  'reaction',
  'news',
  'space',
  'archival',
  'product',
  'nature',
  'people',
  'concept'
]

/**
 * How much a sign counts. People turn up in most shots ("hands typing",
 * "a family at dinner in the fifties"), so their words count for less; a
 * decade said is a strong sign the past is wanted.
 */
const STRENGTH: Partial<Record<BrollIntent, number>> = { people: 0.7, archival: 1.25 }

/** What the brand's kind of channel tips the balance towards. */
const NICHE_LEAN: Record<string, Partial<Record<BrollIntent, number>>> = {
  gaming: { game: 1 },
  livestream: { game: 0.5, reaction: 0.5 },
  tech: { product: 0.5, news: 0.25 },
  church: { people: 0.5, nature: 0.5 },
  vlog: { nature: 0.25, people: 0.25 }
}

/** What a moment wants shown, and the words that said so. */
export function intentOf(m: Pick<Moment, 'said' | 'search' | 'topic' | 'niche' | 'intent'>): {
  intent: BrollIntent
  because: string[]
} {
  if (m.intent) return { intent: m.intent, because: ['the planner said so'] }
  const score = new Map<BrollIntent, number>()
  const because = new Map<BrollIntent, string[]>()
  const add = (text: string, weight: number): void => {
    for (const w of words(text)) {
      const s = stem(w)
      for (const [intent, signs] of Object.entries(SIGNS) as [BrollIntent, string[]][]) {
        if (!signs.includes(s)) continue
        score.set(intent, (score.get(intent) ?? 0) + weight * (STRENGTH[intent] ?? 1))
        const list = because.get(intent) ?? []
        if (!list.includes(w)) list.push(w)
        because.set(intent, list)
      }
    }
  }
  add(m.search, 2)
  add(m.said, 1)
  add(m.topic, 0.5)
  // A data chart only when the search itself asks for one: a number said in passing is not a chart.
  if (!words(m.search).some((w) => SIGNS.chart.includes(stem(w)))) score.delete('chart')
  for (const [intent, lean] of Object.entries(NICHE_LEAN[m.niche ?? ''] ?? {}) as [BrollIntent, number][])
    if ((score.get(intent) ?? 0) > 0) score.set(intent, (score.get(intent) ?? 0) + lean)
  let best: BrollIntent = 'concept'
  let top = 0
  for (const intent of PRIORITY) {
    const s = score.get(intent) ?? 0
    if (s > top) {
      top = s
      best = intent
    }
  }
  return { intent: best, because: because.get(best) ?? [] }
}

/** Where to look for each kind of shot, after the person's own library. */
export const INTENT_SOURCES: Record<BrollIntent, SourceId[]> = {
  product: ['own-uploads', 'youtube', 'web', 'pexels', 'pixabay', 'unsplash', 'openverse', 'wikimedia'],
  concept: ['own-uploads', 'pexels', 'pixabay', 'unsplash', 'openverse', 'wikimedia', 'youtube'],
  news: ['web', 'bluesky', 'youtube', 'wikimedia', 'openverse'],
  social: ['bluesky', 'web'],
  game: ['own-uploads', 'steam', 'youtube'],
  logo: ['logos', 'web'],
  reaction: ['giphy', 'youtube'],
  archival: ['archive', 'wikimedia', 'openverse', 'nasa', 'youtube'],
  space: ['nasa', 'wikimedia', 'openverse', 'archive', 'youtube'],
  nature: ['own-uploads', 'pexels', 'pixabay', 'unsplash', 'openverse', 'wikimedia'],
  people: ['own-uploads', 'pexels', 'pixabay', 'unsplash', 'openverse'],
  chart: []
}

/** The kinds of candidate each shot is asked for in. */
export const INTENT_KINDS: Record<BrollIntent, BrollKind[]> = {
  product: ['video', 'image', 'page'],
  concept: ['video', 'image'],
  news: ['page', 'post', 'video', 'image'],
  social: ['post', 'page'],
  game: ['video', 'image'],
  logo: ['logo', 'image'],
  reaction: ['gif', 'video'],
  archival: ['video', 'image'],
  space: ['video', 'image'],
  nature: ['video', 'image'],
  people: ['video', 'image'],
  chart: []
}

/** Words that mean the maker's own film is wanted: a trailer, a keynote, a launch. */
const OFFICIAL = W('trailer teaser keynote launch unveil unveiled reveal revealed announcement event premiere')

/** Whether to look in the maker's own channel first: for product shots, trailers and keynotes. */
export function wantsOfficial(m: Pick<Moment, 'said' | 'search'>, intent: BrollIntent): boolean {
  if (intent === 'product' || intent === 'game') return true
  return words(`${m.search} ${m.said}`).some((w) => OFFICIAL.includes(stem(w)))
}

export interface Availability {
  /** Why a source cannot be asked right now ("Pexels needs a key"), or null when it can. */
  why(id: SourceId): string | null
}

export interface Plan {
  intent: BrollIntent
  because: string[]
  kinds: BrollKind[]
  /** The sources to ask, in order, the library first. */
  sources: SourceId[]
  /** Sources that would have been asked, and why they were not. */
  skipped: { id: SourceId; why: string }[]
  /** Whether the maker's own channel is looked in first. */
  official: boolean
  /** One sentence each, for the reply: "This channel never uses B-roll from outside, so I only looked in your own." */
  notes: string[]
}

/** Which sources to ask for a moment, in order, and which are left out and why. */
export function planFor(
  m: Moment,
  ctx: { available: Availability; never?: NeverItem[]; block?: string[] }
): Plan {
  const { intent, because } = intentOf(m)
  const notes: string[] = []
  if (intent === 'chart') {
    return {
      intent,
      because,
      kinds: [],
      sources: [],
      skipped: [],
      official: false,
      notes: ['A data chart is drawn from the numbers by the graphics, so I did not look for footage.']
    }
  }
  const never = ctx.never ?? []
  const outsideRuled = covering(never, 'broll')
  if (outsideRuled) notes.push('This channel never uses B-roll from outside, so I looked only in your own material.')
  const logoRuled = intent === 'logo' ? covering(never, 'motion:logo') : null
  if (logoRuled) notes.push('This channel never uses logo pops, so I did not look for a logo.')

  const wanted: SourceId[] = ['library', ...INTENT_SOURCES[intent]]
  const sources: SourceId[] = []
  const skipped: Plan['skipped'] = []
  for (const id of wanted) {
    if (sources.includes(id)) continue
    if (outsideRuled && isOutside(id)) {
      skipped.push({ id, why: 'B-roll from outside is on the never list' })
      continue
    }
    if (logoRuled && id === 'logos') {
      skipped.push({ id, why: 'logo pops are on the never list' })
      continue
    }
    if (ctx.block && sourceBlocked(id, ctx.block)) {
      skipped.push({ id, why: `the brand never uses ${SOURCE_NAMES[id]}` })
      continue
    }
    const why = ctx.available.why(id)
    if (why) {
      skipped.push({ id, why })
      continue
    }
    sources.push(id)
  }
  return { intent, because, kinds: INTENT_KINDS[intent], sources, skipped, official: wantsOfficial(m, intent), notes }
}

/** The orientation stock sites are asked for, from the output's shape. */
export function orientationOf(output: { width: number; height: number }): 'landscape' | 'portrait' | 'square' {
  const r = output.width / Math.max(1, output.height)
  return r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square'
}

/** One brand the index knows, by every name it goes by. */
export interface MakerEntry {
  title: string
  aliases?: string[]
}

/**
 * The makers a moment names, from an index of brands (Simple Icons' titles,
 * in the app): a name counts only written as the index writes it, capital
 * and all, so "apple pie" is no brand while a maker's name in a transcript
 * is. One, two or three words.
 */
export function makersIn(text: string, index: MakerEntry[] | Map<string, string>): string[] {
  const names = index instanceof Map ? index : makerNames(index)
  const tokens = text.split(/[^\p{L}\p{N}+&.'-]+/u).filter(Boolean)
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (!/^\p{Lu}|^\p{N}/u.test(tokens[i])) continue
    for (let n = 3; n >= 1; n--) {
      if (i + n > tokens.length) continue
      const phrase = tokens
        .slice(i, i + n)
        .join(' ')
        .replace(/['’]s$/, '')
        .replace(/[.'’]+$/, '')
      const title = names.get(phrase)
      if (title && !out.includes(title)) {
        out.push(title)
        i += n - 1
        break
      }
    }
  }
  return out
}

/** Every name in the index, as written, to the brand's title. Built once and kept. */
export function makerNames(index: MakerEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const e of index)
    for (const n of [e.title, ...(e.aliases ?? [])]) {
      // Names of one or two letters are too easily something else.
      if (n.length >= 3 && !map.has(n)) map.set(n, e.title)
    }
  return map
}
