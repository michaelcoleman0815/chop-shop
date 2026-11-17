import { createCanvas, Path2D } from '@napi-rs/canvas'
import { promises as fs } from 'fs'
import { logoLicense } from '../../../shared/broll/license'
import { titleToSlug, type LogoMark } from '../../../shared/motion'
import type { BrollSource, Candidate } from '../../../shared/broll/types'
import { fileIn, normalized } from '../files'
import type { SourceDeps } from './common'

/**
 * Brand marks from Simple Icons, the npm package the app already bundles for
 * logo pops (main/motion-icons): offline, no request leaves the computer.
 * A brand named in a moment ("the new phone from …") comes back as its mark,
 * drawn in its own colour on transparency, to sit on a card.
 *
 * Logos are trademarks: one is shown only to name the brand it belongs to,
 * as it is, and never to suggest the brand endorses the video. A few marks
 * carry a licence of their own for their drawing (shared/broll/license
 * logoLicense); a non-commercial or copyleft one is left out by the policy.
 */

/** One entry of simple-icons/icons.json, as much as this reads. */
export interface LogoData {
  title: string
  slug: string
  hex: string
  source?: string
  guidelines?: string
  license?: { type: string; url?: string }
  aliases?: { aka?: string[]; dup?: { title: string }[]; loc?: Record<string, string> }
}

export interface LogoDeps extends Pick<SourceDeps, 'ffmpeg'> {
  index: () => Promise<LogoData[]>
  marks: () => Promise<(slug: string) => LogoMark | undefined>
}

const names = (e: LogoData): string[] => [e.title, ...(e.aliases?.aka ?? []), ...(e.aliases?.dup ?? []).map((d) => d.title), ...Object.values(e.aliases?.loc ?? {})]

/** The index as the router reads makers from it (shared/broll/route makersIn): every name a brand goes by. */
export function makerEntries(index: LogoData[]): { title: string; aliases: string[] }[] {
  return index.map((e) => ({ title: e.title, aliases: names(e).slice(1) }))
}

/** Every name a brand goes by, as a slug, to its entry. */
function bySlug(index: LogoData[]): Map<string, LogoData> {
  const map = new Map<string, LogoData>()
  for (const e of index) map.set(e.slug, e)
  for (const e of index)
    for (const n of names(e)) {
      const s = titleToSlug(n)
      if (s.length >= 3 && !map.has(s)) map.set(s, e)
    }
  return map
}

/**
 * The brands some words name: one to three words at a time, longest first,
 * as Simple Icons spells their slugs. A word on its own counts only written
 * with a capital, as a name is, or right beside "logo"; one that is mostly
 * an ordinary word ("signal", "zoom") only beside "logo".
 */
export function brandsIn(text: string, lookup: Map<string, LogoData>): LogoData[] {
  const tokens = text.split(/[^\p{L}\p{N}+&.'-]+/u).filter(Boolean)
  const near = (i: number, n: number): boolean =>
    [tokens[i - 1], tokens[i + n]].some((t) => !!t && /^(logo|logos|brand|icon|wordmark)$/i.test(t))
  const out: LogoData[] = []
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 3; n >= 1; n--) {
      if (i + n > tokens.length) continue
      const phrase = tokens
        .slice(i, i + n)
        .join(' ')
        .replace(/['’]s$/, '')
      if (n === 1) {
        if (phrase.length < 2) continue
        const capital = /^\p{Lu}/u.test(phrase)
        if (COMMON.has(phrase.toLowerCase()) ? !near(i, 1) : !capital && !near(i, 1)) continue
      }
      const e = lookup.get(titleToSlug(phrase))
      if (e && !out.includes(e)) {
        out.push(e)
        i += n - 1
        break
      }
    }
  }
  return out
}

/** Words that are also some brand's slug but mostly mean something else in a sentence. */
const COMMON = new Set(
  (
    'line signal notion discord slack ring nest target shell delta visa mint ghost keep files photos music news maps ' +
    'mail meet zoom react express edge chrome safari opera brave spring next swift ruby rust go python java office ' +
    'windows apple amazon steam twitch medium square stripe box dash arch fedora ubuntu mastodon threads'
  ).split(' ')
)

export function candidateOf(e: LogoData): Candidate {
  return {
    id: e.slug,
    source: 'logos',
    kind: 'logo',
    title: e.title,
    author: null,
    authorUrl: null,
    pageUrl: e.guidelines ?? e.source ?? null,
    mediaUrl: null,
    previewUrl: null,
    width: 1024,
    height: 1024,
    durationSec: null,
    bytes: null,
    license: logoLicense(e.license?.type ?? null, e.guidelines ?? null),
    tags: names(e),
    extra: { slug: e.slug, hex: e.hex }
  }
}

/** A mark as a PNG: its path, filled in its colour (or near-black, when its colour is near-white), on transparency. */
export async function drawMark(mark: LogoMark, size = 1024): Promise<Buffer> {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const hex = /^[0-9a-f]{6}$/i.test(mark.hex) ? mark.hex : '111111'
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.86
  ctx.fillStyle = light ? '#111111' : `#${hex}`
  // The marks are drawn on a 24-unit grid; they fill four fifths of the picture.
  const scale = (size * 0.8) / 24
  ctx.translate(size * 0.1, size * 0.1)
  ctx.scale(scale, scale)
  ctx.fill(new Path2D(mark.path))
  return canvas.encode('png')
}

export function logosSource(deps: LogoDeps): BrollSource {
  let lookup: Map<string, LogoData> | null = null
  const load = async (): Promise<Map<string, LogoData>> => (lookup ??= bySlug(await deps.index()))
  return {
    id: 'logos',
    name: 'Simple Icons',
    kinds: ['logo'],
    async search(query, opts = {}) {
      const map = await load()
      const found = brandsIn(query, map)
      for (const m of opts.makers ?? []) {
        const e = map.get(titleToSlug(m))
        if (e && !found.includes(e)) found.push(e)
      }
      return found.slice(0, opts.count ?? 3).map(candidateOf)
    },
    async fetch(c, dir) {
      const slug = String(c.extra?.slug ?? c.id)
      const mark = (await deps.marks())(slug)
      if (!mark) throw new Error(`Simple Icons has no mark for ${c.title}.`)
      const path = await fileIn(dir, `${c.title} logo`, 'png')
      await fs.writeFile(path, await drawMark(mark))
      return normalized(path, c, null, deps.ffmpeg)
    }
  }
}
