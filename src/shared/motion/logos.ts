import type { LogoMark } from './types'

/**
 * Brand marks from Simple Icons (the npm package simple-icons, CC0): a brand
 * named the way people say it becomes the package's slug. The marks belong to
 * their brands; a logo pop shows one when a creator names that brand.
 */

/** One entry of the package's index (simple-icons/icons.json): no paths, just names. */
export interface LogoEntry {
  title: string
  slug: string
  hex: string
  aliases?: { aka?: string[]; dup?: { title: string }[]; loc?: Record<string, string> }
}

const REPLACE: Record<string, string> = {
  '+': 'plus',
  '.': 'dot',
  '&': 'and',
  đ: 'd',
  ħ: 'h',
  ı: 'i',
  ĸ: 'k',
  ŀ: 'l',
  ł: 'l',
  ß: 'ss',
  ŧ: 't',
  ø: 'o'
}

/** The package's own rule from a title to its slug: "Node.js" to "nodedotjs". */
export function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[+.&đħıĸŀłßŧø]/g, (c) => REPLACE[c] ?? '')
    .normalize('NFD')
    .replace(/[^a-z\d]/g, '')
}

/** Every name a brand goes by in the index: its title, older names and other spellings. */
function names(e: LogoEntry): string[] {
  return [
    e.title,
    ...(e.aliases?.aka ?? []),
    ...(e.aliases?.dup ?? []).map((d) => d.title),
    ...Object.values(e.aliases?.loc ?? {})
  ]
}

/**
 * The slug for a brand as someone names it: its slug or title, then a name
 * it used to go by ("Twitter" is X). Null when the index has no such brand.
 */
export function findLogo(name: string, index: LogoEntry[]): LogoEntry | null {
  const want = titleToSlug(name.trim())
  if (!want) return null
  return (
    index.find((e) => e.slug === want) ??
    index.find((e) => titleToSlug(e.title) === want) ??
    index.find((e) => names(e).some((n) => titleToSlug(n) === want)) ??
    null
  )
}

/** The letters that stand in for a logo that is not there: the first of the first two words. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0]?.[0] ?? '?').toUpperCase()
}

/**
 * A lookup from any name a brand goes by, as a slug, to its mark: what a
 * logo layer names ("bitcoin", or "twitter" for X) to what is drawn.
 */
export function logoLookup(index: LogoEntry[], marks: Map<string, LogoMark>): (slug: string) => LogoMark | undefined {
  const also = new Map<string, string>()
  for (const e of index)
    for (const n of names(e)) {
      const key = titleToSlug(n)
      if (key && !marks.has(key) && !also.has(key)) also.set(key, e.slug)
    }
  return (slug) => marks.get(slug) ?? marks.get(also.get(slug) ?? '')
}

/** The marks in the package's module: every export with a slug, a colour and a path. */
export function marksFrom(module: Record<string, unknown>): Map<string, LogoMark> {
  const out = new Map<string, LogoMark>()
  for (const v of Object.values(module)) {
    const m = v as { slug?: unknown; title?: unknown; hex?: unknown; path?: unknown }
    if (typeof m?.slug === 'string' && typeof m.path === 'string' && typeof m.hex === 'string')
      out.set(m.slug, { title: String(m.title ?? m.slug), hex: m.hex, path: m.path })
  }
  return out
}
