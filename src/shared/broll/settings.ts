import { isSourceId, type SourceId } from './types'

/**
 * B-roll's own settings, as the main process keeps them (main/broll/settings,
 * broll/settings.json in userData) and Settings shows them: the person's
 * asset folders, their own channels, which sources are off, and whether
 * looking on the web (which costs money) is on. Shared, so both read and
 * check them the same way.
 */

export interface BrollSettings {
  /** The person's own asset folders, searched before anything else. */
  folders: string[]
  /** The person's own YouTube channels, for their earlier uploads. */
  channels: string[]
  /** Sources turned off. */
  off: SourceId[]
  /** Claude's web search, which costs money: off until the person turns it on. */
  webSearch: boolean
  /** Share-alike licences: off, because a video using one may have to carry the same licence. */
  shareAlike: boolean
  /** Other people's clips, pages and posts, short and credited: on, as /broll always offered them. */
  fairUse: boolean
}

export const DEFAULT_BROLL: BrollSettings = { folders: [], channels: [], off: [], webSearch: false, shareAlike: false, fairUse: true }

const strings = (v: unknown, max: number, len = 1000): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= len).map((x) => x.trim()))].slice(0, max)
    : []

/** Whatever was saved, read safely: anything unreadable is the default. */
export function readBrollSettings(raw: unknown): BrollSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    folders: strings(o.folders, 20),
    channels: strings(o.channels, 10, 300),
    off: strings(o.off, 30).filter(isSourceId),
    webSearch: o.webSearch === true,
    shareAlike: o.shareAlike === true,
    fairUse: o.fairUse !== false
  }
}

/** One of the person's asset folders, as Settings shows it: a sentence of what it holds, and what it cannot use and why. */
export interface LibraryFolder {
  path: string
  said: string
  unsupported: { what: string; count: number; why: string }[]
}

/** What looking on the web may cost before anything is spent, in US dollars (main/broll/sources/web quoteWebSearch). */
export interface WebQuote {
  low: number
  high: number
  searches: number
  /** "Looking on the web for this moment costs about 3 cents to 12 cents on your Anthropic account, for at most 3 web searches." */
  said: string
}
