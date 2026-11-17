import type { SourceId } from './types'

/**
 * How often each site may be asked, so a free key is never spent past what
 * it allows and an anonymous API is never hammered. Counted in fixed windows
 * (this minute, this hour, today, this month, in UTC); the counts can be
 * kept on disk, so a restart does not forget what today has used.
 */

export interface Limits {
  perMinute?: number
  perHour?: number
  perDay?: number
  perMonth?: number
}

/** What each source allows, from its own documentation, or what is polite where it says nothing. */
export const LIMITS: Partial<Record<SourceId, Limits>> = {
  // Anonymous Openverse: 20 a minute and 200 a day (its x-ratelimit headers).
  openverse: { perMinute: 20, perDay: 200 },
  // Wikimedia asks for no more than a request at a time; a few a minute is plenty.
  wikimedia: { perMinute: 30 },
  nasa: { perMinute: 30 },
  archive: { perMinute: 30 },
  // The store's appdetails is limited to about 200 requests every five minutes.
  steam: { perMinute: 30 },
  bluesky: { perMinute: 60 },
  pexels: { perHour: 200, perMonth: 20_000 },
  pixabay: { perMinute: 100 },
  unsplash: { perHour: 50 },
  giphy: { perHour: 100 },
  freesound: { perMinute: 60, perDay: 2_000 },
  // Each one costs the person money; the consent path decides, this only stops a loop.
  web: { perMinute: 6, perDay: 100 }
}

type Window = 'minute' | 'hour' | 'day' | 'month'

const SPAN: Record<Window, keyof Limits> = { minute: 'perMinute', hour: 'perHour', day: 'perDay', month: 'perMonth' }

/** Which window a moment falls in: minutes and hours since 1970, the UTC date, the UTC month. */
function windowOf(w: Window, now: number): string {
  const d = new Date(now)
  if (w === 'minute') return `m${Math.floor(now / 60_000)}`
  if (w === 'hour') return `h${Math.floor(now / 3_600_000)}`
  if (w === 'day') return `d${d.toISOString().slice(0, 10)}`
  return `M${d.toISOString().slice(0, 7)}`
}

/** When the window a moment falls in ends. */
function windowEnd(w: Window, now: number): number {
  const d = new Date(now)
  if (w === 'minute') return (Math.floor(now / 60_000) + 1) * 60_000
  if (w === 'hour') return (Math.floor(now / 3_600_000) + 1) * 3_600_000
  if (w === 'day') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

/** The counts kept: source, then window, then how many in it. */
export type QuotaCounts = Partial<Record<SourceId, Partial<Record<Window, [string, number]>>>>

export interface Quotas {
  /** Takes one request for a source, or says how long until one is free. */
  take(id: SourceId): { ok: true } | { ok: false; retryInSec: number; window: Window }
  /** What is left in the tightest window, or null when the source has no limit. */
  left(id: SourceId): number | null
  counts(): QuotaCounts
}

export function createQuotas(opts: {
  limits?: Partial<Record<SourceId, Limits>>
  now?: () => number
  counts?: QuotaCounts
  /** Called after every request taken, with the counts to keep. */
  save?: (counts: QuotaCounts) => void
}): Quotas {
  const limits = opts.limits ?? LIMITS
  const now = opts.now ?? (() => Date.now())
  const counts: QuotaCounts = JSON.parse(JSON.stringify(opts.counts ?? {})) as QuotaCounts

  const used = (id: SourceId, w: Window, t: number): number => {
    const c = counts[id]?.[w]
    return c && c[0] === windowOf(w, t) ? c[1] : 0
  }

  return {
    take(id) {
      const l = limits[id]
      if (!l) return { ok: true }
      const t = now()
      for (const w of ['minute', 'hour', 'day', 'month'] as Window[]) {
        const max = l[SPAN[w]]
        if (max !== undefined && used(id, w, t) >= max)
          return { ok: false, retryInSec: Math.ceil((windowEnd(w, t) - t) / 1000), window: w }
      }
      const mine = (counts[id] ??= {})
      for (const w of ['minute', 'hour', 'day', 'month'] as Window[]) {
        if (l[SPAN[w]] === undefined) continue
        mine[w] = [windowOf(w, t), used(id, w, t) + 1]
      }
      opts.save?.(counts)
      return { ok: true }
    },
    left(id) {
      const l = limits[id]
      if (!l) return null
      const t = now()
      let least: number | null = null
      for (const w of ['minute', 'hour', 'day', 'month'] as Window[]) {
        const max = l[SPAN[w]]
        if (max === undefined) continue
        const left = Math.max(0, max - used(id, w, t))
        least = least === null ? left : Math.min(least, left)
      }
      return least
    },
    counts: () => counts
  }
}

/** "in 40 seconds", "in 12 minutes", "tomorrow", for a sentence about a limit. */
export function inTime(sec: number): string {
  if (sec < 90) return `in ${Math.max(1, Math.round(sec))} seconds`
  if (sec < 5400) return `in ${Math.round(sec / 60)} minutes`
  if (sec < 36 * 3600) return `in ${Math.round(sec / 3600)} hours`
  return `in ${Math.round(sec / 86_400)} days`
}
