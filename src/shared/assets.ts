import { assetsInCut, beatWords, currentCut, type EditDoc } from './edit'
import { mapCredits } from './maps/command'
import { clock } from './presets'

/**
 * Bringing material into an edit: footage, images, icons, and short excerpts
 * of other people's videos.
 *
 * Excerpts are kept short and are cut to for what they show, alongside the
 * creator's own commentary: transformative use, not a re-upload. Every outside
 * asset keeps where it came from, and exports list them as credits. Whether a
 * particular use is fair stays the editor's call; the app makes it easy to
 * use little and credit everything.
 */

/** The longest stretch taken from someone else's video. */
export const MAX_EXCERPT_SEC = 30
/** What a found clip contributes when nobody named a stretch. */
export const DEFAULT_EXCERPT_SEC = 8

export interface Range {
  startSec: number
  endSec: number
}

const TIME = String.raw`(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?\s?s)`

function toSec(t: string): number {
  const v = t.trim().replace(/\s?s$/, '')
  if (!v.includes(':')) return Number(v)
  return v.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
}

/** "0:12-0:20", "0:12 to 0:20", "from 1:02 until 1:10", "12s-20s". */
export function parseRange(text: string): Range | null {
  const m = new RegExp(`${TIME}\\s*(?:-|–|—|to|until|through)\\s*${TIME}`, 'i').exec(text)
  if (!m) return null
  const startSec = toSec(m[1])
  const endSec = toSec(m[2])
  return Number.isFinite(startSec) && Number.isFinite(endSec) && endSec > startSec ? { startSec, endSec } : null
}

/** Holds an excerpt to the limit and inside the video. */
export function clampExcerpt(range: Range, durationSec?: number | null): Range {
  const end = durationSec ? Math.min(range.endSec, durationSec) : range.endSec
  const start = Math.max(0, Math.min(range.startSec, end - 0.5))
  return { startSec: start, endSec: Math.min(end, start + MAX_EXCERPT_SEC) }
}

/** A short stretch a quarter of the way in, past most intros. */
export function defaultExcerpt(durationSec: number): Range {
  const length = Math.min(DEFAULT_EXCERPT_SEC, durationSec)
  const startSec = Math.max(0, Math.min(durationSec * 0.25, durationSec - length))
  return { startSec, endSec: startSec + length }
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i

export function isImagePath(path: string): boolean {
  return IMAGE.test(path)
}

export function isImageUrl(url: string): boolean {
  try {
    return IMAGE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/**
 * Icons whose name or tags match a query, best first: an exact name, then a
 * name containing the words, then tags. Icons come from Lucide (ISC).
 */
export function searchIcons(query: string, tags: Record<string, string[]>, limit = 6): string[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  if (words.length === 0) return []
  const scored: { name: string; score: number }[] = []
  for (const [name, list] of Object.entries(tags)) {
    let score = 0
    if (name === words.join('-')) score += 100
    for (const w of words) {
      if (name.split('-').includes(w)) score += 10
      else if (name.includes(w)) score += 4
      if (list.some((t) => t.toLowerCase() === w)) score += 6
      else if (list.some((t) => t.toLowerCase().includes(w))) score += 2
    }
    if (score > 0) scored.push({ name, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.length - b.name.length || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name)
}

export type IconNode = [string, Record<string, string | number>]

/** The only elements an icon may contain: Lucide draws with nothing else. */
const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse'])

/** An icon as a standalone SVG, stroked in one colour. */
export function iconSvg(nodes: IconNode[], opts: { color?: string; size?: number; strokeWidth?: number } = {}): string {
  const color = opts.color ?? '#15161A'
  const size = opts.size ?? 1024
  const escape = (v: string | number): string => String(v).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  const children = nodes
    .map(([tag, attrs]) => {
      if (!SHAPES.has(tag)) return ''
      const a = Object.entries(attrs)
        .filter(([k]) => /^[a-z-]+$/i.test(k) && k !== 'key' && !/^on/i.test(k))
        .map(([k, v]) => `${k}="${escape(v)}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="${escape(color)}" stroke-width="${opts.strokeWidth ?? 2}" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`
  )
}

const SKIP = new Set(
  'a an and are at be but by for from has have i in is it its of on or so that the this to was we with you your my me our not no just like'.split(
    ' '
  )
)

const stem = (w: string): string =>
  w
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 5)

/**
 * The beat an asset should land on: the one whose words share most with what
 * the asset was found for, the longest on a tie. The opening beat is left on
 * the speaker, because that is where the hook is.
 */
export function beatForAsset(doc: EditDoc, query: string): string | null {
  const cut = currentCut(doc)
  const wanted = new Set(
    query
      .split(/\s+/)
      .map(stem)
      .filter((w) => w.length >= 3 && !SKIP.has(w))
  )
  const candidates = cut.beats.filter(
    (b, i) => b.treatment.frame === 'speaker' && b.from !== null && (i > 0 || cut.beats.length === 1)
  )
  let best: { id: string; score: number; length: number } | null = null
  for (const beat of candidates) {
    const words = beatWords(doc, beat)
    const score = words.filter((w) => wanted.has(stem(w.text))).length
    const length = words.length ? words[words.length - 1].endSec - words[0].startSec : 0
    if (!best || score > best.score || (score === best.score && length > best.length))
      best = { id: beat.id, score, length }
  }
  return best?.id ?? null
}

/** Credits for everything from outside the editor's own files that the cut uses. Null when there is nothing to credit. */
export function creditsText(doc: EditDoc): string | null {
  const lines = assetsInCut(doc)
    .filter((a) => a.origin.type !== 'file')
    .map((a) => {
      const parts = [a.title]
      if (a.origin.author) parts.push(a.origin.author)
      if (a.origin.url) parts.push(a.origin.url)
      if (a.origin.range) parts.push(`${clock(a.origin.range.startSec)}-${clock(a.origin.range.endSec)}`)
      if (a.origin.license) parts.push(a.origin.license)
      return `- ${parts.join(' · ')}`
    })
  // The data the cut's maps draw on; the plate data's licence asks for its credit wherever it is used.
  lines.push(...mapCredits(currentCut(doc).motion ?? []).map((l) => `- ${l}`))
  return lines.length ? `Credits for ${doc.title}\n\n${lines.join('\n')}\n` : null
}
