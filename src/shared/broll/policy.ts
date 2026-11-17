import { defaultExcerpt, DEFAULT_EXCERPT_SEC, MAX_EXCERPT_SEC, type Range } from '../assets'
import { fromSource, readSources, type BrollSource as PastedSource, type FoundClip } from '../broll-sources'
import { covering, neverSaid, thingsIn, type NeverItem } from '../never'
import type { Candidate, SourceId } from './types'

/**
 * What may be offered. By default only what is safe in a video YouTube pays
 * for: the person's own material; CC0 and the public domain; CC BY with a
 * credit; the Pexels, Pixabay and Unsplash licences. Never anything
 * non-commercial; no-derivatives only shown exactly as it is; share-alike
 * only when the person allows it, because a video that uses it may have to
 * carry the same licence. Other people's clips, pages and posts are offered
 * as the excerpts always were: short, credited, and marked as the person's
 * own call.
 *
 * The brand's blocked sources and the never list come before all of it and
 * always win.
 */

export interface PolicyOptions {
  /** Only what may go in a video YouTube pays for. On unless the person says the video is not monetized. */
  monetized?: boolean
  /** Other people's clips, pages and posts, short and credited. On, as /broll always offered them. */
  fairUse?: boolean
  /** How it will be used: cut to, cropped and graded (adapted), or shown exactly as it is. */
  use?: 'adapted' | 'unchanged'
  /** Share-alike licences. Off unless the person turns them on. */
  shareAlike?: boolean
  /** The brand's B-roll sources, as pasted. */
  brand?: { prefer: string[]; block: string[] }
  /** What the channel never uses (shared/never). */
  never?: NeverItem[]
}

/** What kept a licence out, for counting: each reads as words in LICENCE_TROUBLE. */
export type LicenceTrouble = 'unclear' | 'copyleft' | 'non-commercial' | 'share-alike' | 'no-changes' | 'not-licensed'

export const LICENCE_TROUBLE: Record<LicenceTrouble, string> = {
  unclear: 'no licence I could read',
  copyleft: 'copyleft',
  'non-commercial': 'no commercial use',
  'share-alike': 'share-alike',
  'no-changes': 'no changes allowed',
  'not-licensed': 'someone else’s, not licensed'
}

export type Verdict =
  | { ok: true; preferred: boolean; note: string | null }
  | { ok: false; why: string; by: 'never' | 'blocked' }
  | { ok: false; why: string; by: 'license'; trouble: LicenceTrouble }

/** Sources whose material is the person's own, or made for them: not "B-roll from outside". */
const OWN_SOURCES: readonly SourceId[] = ['library', 'own-uploads', 'generated']

export function isOutside(source: SourceId): boolean {
  return !OWN_SOURCES.includes(source)
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, '')
  } catch {
    return null
  }
}

/** A Bluesky account pasted as a site ("bsky.app/profile/name.bsky.social"): the handle, or null. */
export function blueskyHandle(said: string): string | null {
  const m = /bsky\.app\/profile\/([^/?#\s]+)/i.exec(said)
  return m ? decodeURIComponent(m[1]).toLowerCase().replace(/^@/, '') : null
}

/** The candidate as the YouTube matching in shared/broll-sources reads a result. */
function asFound(c: Candidate): FoundClip {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  return {
    url: c.pageUrl ?? c.mediaUrl ?? '',
    title: c.title,
    author: c.author,
    durationSec: c.durationSec,
    channelId: str(c.extra?.channelId),
    channelUrl: str(c.extra?.channelUrl) ?? c.authorUrl,
    handle: str(c.extra?.handle)
  }
}

/** Whether a candidate comes from one of the sources pasted on the brand page. */
export function fromPasted(c: Candidate, s: PastedSource): boolean {
  if (s.kind === 'site') {
    const handle = s.host === 'bsky.app' ? blueskyHandle(s.said) : null
    if (handle) return c.source === 'bluesky' && String(c.extra?.handle ?? '').toLowerCase() === handle
    return [c.pageUrl, c.mediaUrl, c.authorUrl].some((u) => {
      const host = hostOf(u)
      return !!host && (host === s.host || host.endsWith(`.${s.host}`))
    })
  }
  // Channels are YouTube's; only clips from YouTube can be from one.
  if (c.source !== 'youtube' && c.source !== 'own-uploads') return false
  return fromSource(asFound(c), s)
}

/** The hosts a whole source lives on, so a brand that blocks one is never asked at all. */
export const SOURCE_HOSTS: Partial<Record<SourceId, string[]>> = {
  youtube: ['youtube.com'],
  openverse: ['openverse.org'],
  wikimedia: ['wikimedia.org', 'commons.wikimedia.org'],
  nasa: ['nasa.gov', 'images.nasa.gov'],
  archive: ['archive.org'],
  steam: ['steampowered.com', 'store.steampowered.com'],
  bluesky: ['bsky.app'],
  logos: ['simpleicons.org'],
  pexels: ['pexels.com'],
  pixabay: ['pixabay.com'],
  unsplash: ['unsplash.com'],
  giphy: ['giphy.com'],
  freesound: ['freesound.org']
}

/** Whether the brand blocks a whole source: its site is on the blocked list as a site (not one account on it). */
export function sourceBlocked(id: SourceId, block: string[]): boolean {
  const hosts = SOURCE_HOSTS[id] ?? []
  return readSources(block).sources.some(
    (s) => s.kind === 'site' && !blueskyHandle(s.said) && hosts.some((h) => h === s.host || h.endsWith(`.${s.host}`))
  )
}

/** What the never list rules out of this candidate, or null. */
function neverRules(c: Candidate, never: NeverItem[]): NeverItem | null {
  if (never.length === 0) return null
  if (isOutside(c.source)) {
    const hit = covering(never, 'broll')
    if (hit) return hit
  }
  if (c.kind === 'audio') {
    const role = c.extra?.audio
    if (role === 'music') return covering(never, 'music')
    // A sound named for its kind ("whoosh-03.wav") is that kind on the list: "never use whooshes" rules it out.
    const named = thingsIn(`${c.title} ${c.tags.join(' ')}`).filter((t) => t.startsWith('sfx:'))
    return covering(never, 'sfx') ?? named.map((t) => covering(never, t)).find((t) => t !== null) ?? null
  }
  if (c.kind === 'logo') return covering(never, 'motion:logo')
  return null
}

/** Whether the candidate may be offered, and why not when it may not. */
export function judge(c: Candidate, opts: PolicyOptions = {}): Verdict {
  const ruled = neverRules(c, opts.never ?? [])
  if (ruled) return { ok: false, by: 'never', why: `The channel never uses ${neverSaid(ruled)}.` }

  const block = readSources(opts.brand?.block ?? []).sources
  const blocked = block.find((s) => fromPasted(c, s))
  if (blocked) return { ok: false, by: 'blocked', why: `It is from ${blocked.said}, which the brand never uses.` }

  const l = c.license
  if (l.id === 'unknown') return { ok: false, by: 'license', trouble: 'unclear', why: l.note ?? 'Its licence could not be read.' }
  if (l.id === 'copyleft') return { ok: false, by: 'license', trouble: 'copyleft', why: l.note ?? 'Its licence is copyleft.' }
  if (l.monetized === 'no' && opts.monetized !== false)
    return { ok: false, by: 'license', trouble: 'non-commercial', why: l.note ?? 'Its licence does not allow a video YouTube pays for.' }
  if (l.id.includes('-sa') && !opts.shareAlike)
    return {
      ok: false,
      by: 'license',
      trouble: 'share-alike',
      why: 'It is share-alike, so a video that uses it may have to carry the same licence.'
    }
  // A logo is always shown as it is; anything else no-derivatives only when the use is unchanged.
  const unchanged = opts.use === 'unchanged' || c.kind === 'logo'
  if (!l.modify && !unchanged)
    return { ok: false, by: 'license', trouble: 'no-changes', why: 'It may only be shown exactly as it is, and B-roll is cropped and cut.' }
  if (l.monetized === 'your-call' && opts.fairUse === false)
    return { ok: false, by: 'license', trouble: 'not-licensed', why: 'It is someone else’s work, and this channel uses only licensed material.' }

  const prefer = readSources(opts.brand?.prefer ?? []).sources
  const preferred = c.preferred === true || prefer.some((s) => fromPasted(c, s))
  return { ok: true, preferred, note: l.monetized === 'your-call' ? 'fair use is your call' : (l.note ?? null) }
}

/** Seconds of a licensed long video worth fetching for one shot: the shot, with room to choose. */
export const LICENSED_EXCERPT_SEC = 60

/**
 * The stretch of a video to fetch: all of a short one; of a long one, the
 * shot's length (8 seconds when nobody said) from a quarter of the way in,
 * past most intros. Someone else's clip is held to 30 seconds, as excerpts
 * always were; licensed material to a minute, which is plenty for one shot.
 */
export function stretchFor(c: Candidate, seconds?: number | null): Range | null {
  const duration = c.durationSec
  const fair = c.license.monetized === 'your-call'
  const cap = fair ? MAX_EXCERPT_SEC : LICENSED_EXCERPT_SEC
  if (c.range) return within(c.range, duration, cap)
  if (!duration || duration <= 0) return null
  // A short licensed clip is used whole; a fair-use one is still only a stretch of it.
  if (!fair && duration <= cap) return null
  const want = Math.min(cap, Math.max(1, seconds && seconds > 0 ? seconds : DEFAULT_EXCERPT_SEC))
  if (duration <= want) return fair ? { startSec: 0, endSec: duration } : null
  const base = defaultExcerpt(duration)
  const startSec = Math.max(0, Math.min(base.startSec, duration - want))
  return { startSec, endSec: startSec + want }
}

/** A stretch held inside the video and to at most `cap` seconds. */
function within(r: Range, duration: number | null, cap: number): Range {
  const end = duration ? Math.min(r.endSec, duration) : r.endSec
  const startSec = Math.max(0, Math.min(r.startSec, end - 0.5))
  return { startSec, endSec: Math.min(end, startSec + cap) }
}
