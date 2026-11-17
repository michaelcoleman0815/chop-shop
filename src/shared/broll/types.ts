import type { Asset } from '../edit'

/**
 * B-roll from everywhere, as one model: every source answers a search with
 * candidates of the same shape, and turns the one the person picks into a
 * local file, normalized as a file brought in from disk is (main/assets
 * importFile), with where it came from and how it may be used kept on it.
 *
 * The person's own folder is a source like any other, and is asked first.
 */

/** What an asset is once it is in an edit, without its id. */
export type NewAsset = Omit<Asset, 'id'>

export const BROLL_KINDS = ['video', 'image', 'gif', 'logo', 'page', 'post', 'audio'] as const
/** What a candidate is: a clip, a still, a looping GIF, a brand mark, a captured page, a social post, a sound. */
export type BrollKind = (typeof BROLL_KINDS)[number]

export const SOURCE_IDS = [
  'library',
  'own-uploads',
  'youtube',
  'openverse',
  'wikimedia',
  'nasa',
  'archive',
  'steam',
  'bluesky',
  'logos',
  'pexels',
  'pixabay',
  'unsplash',
  'giphy',
  'freesound',
  'web',
  'generated'
] as const
export type SourceId = (typeof SOURCE_IDS)[number]

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === 'string' && (SOURCE_IDS as readonly string[]).includes(value)
}

/** What a source is called in a sentence. */
export const SOURCE_NAMES: Record<SourceId, string> = {
  library: 'your library',
  'own-uploads': 'your own videos',
  youtube: 'YouTube',
  openverse: 'Openverse',
  wikimedia: 'Wikimedia Commons',
  nasa: 'NASA',
  archive: 'the Internet Archive',
  steam: 'Steam',
  bluesky: 'Bluesky',
  logos: 'Simple Icons',
  pexels: 'Pexels',
  pixabay: 'Pixabay',
  unsplash: 'Unsplash',
  giphy: 'GIPHY',
  freesound: 'Freesound',
  web: 'a web search',
  generated: 'generation'
}

/**
 * Whether something may go in a video YouTube pays for: yes; no; or the
 * creator's own call, for other people's clips, pages and posts, which are
 * kept short and credited and used for what they show (fair use is decided
 * by the person, not by the app).
 */
export type Monetized = 'yes' | 'no' | 'your-call'

export type LicenseId =
  | 'own'
  | 'cc0'
  | 'pdm'
  | 'public-domain'
  | 'cc-by'
  | 'cc-by-sa'
  | 'cc-by-nd'
  | 'cc-by-nc'
  | 'cc-by-nc-sa'
  | 'cc-by-nc-nd'
  | 'pexels'
  | 'pixabay'
  | 'unsplash'
  | 'permissive'
  | 'copyleft'
  | 'trademark'
  | 'fair-use'
  | 'unknown'

export interface License {
  id: LicenseId
  /** As a credit line says it: "CC BY 4.0", "Pexels License", "Public domain". */
  name: string
  /** The licence's own text, when there is one to link to. */
  url: string | null
  /** Whether using it needs a credit line. */
  credit: boolean
  monetized: Monetized
  /** Whether it may be changed: cropped, graded, cut into. A no-derivatives licence may only be shown as it is. */
  modify: boolean
  /** One sentence the person should know: "Logos are trademarks, used only to name the brand." */
  note?: string
}

/** One thing a source found. Plain values only, so a candidate can cross IPC and be kept in a chat. */
export interface Candidate {
  /** Unique within its source, and stable: the same thing found twice has the same id. */
  id: string
  source: SourceId
  kind: BrollKind
  title: string
  /** Who made it, as the credit names them. */
  author: string | null
  authorUrl: string | null
  /** The page that shows it at its source, for the credit and for the person to look at. */
  pageUrl: string | null
  /** The file itself, when the search says where it is; some sources only say at fetch time. */
  mediaUrl: string | null
  /** A small picture of it to choose from. */
  previewUrl: string | null
  width: number | null
  height: number | null
  durationSec: number | null
  bytes: number | null
  license: License
  /** Words it is filed under, from its source or from its folder and file name. */
  tags: string[]
  /** For a long video: the stretch to take, which fetch keeps to. */
  range?: { startSec: number; endSec: number } | null
  /** A picture with transparency, laid over the footage rather than cut to. */
  alpha?: boolean
  /** From a channel or site the brand prefers. */
  preferred?: boolean
  /** From the maker's or brand's own channel: a trailer from its studio, a product film from its maker. */
  official?: boolean
  /** What fetch needs that the fields above do not carry: a NASA id, a trailer's playlist, a post's address. */
  extra?: Record<string, string | number | boolean | null>
}

/** What a fetch leaves: the asset, ready to add to an edit, and the line that credits it (null for the person's own). */
export interface Fetched {
  asset: NewAsset
  credit: string | null
}

export interface SearchOptions {
  /** The kinds wanted; a source that has others leaves them out. */
  kinds?: readonly BrollKind[]
  /** How many to come back with, at most. */
  count?: number
  /** The output's shape, for sources that can ask for one. */
  orientation?: 'landscape' | 'portrait' | 'square'
  /** Makers whose own channel is looked in first: the studio for a trailer, the maker for a product film. */
  makers?: string[]
  /** The brand's B-roll sources, as pasted (shared/broll-sources). */
  brand?: { prefer: string[]; block: string[] }
  /**
   * The person said yes to what this search costs (the app's consent and
   * quote path). A source that costs money searches only with it.
   */
  paid?: boolean
  signal?: AbortSignal
}

export interface FetchOptions {
  signal?: AbortSignal
  onProgress?: (percent: number) => void
  /** The output's size, so a source with several sizes picks one that is enough. */
  output?: { width: number; height: number }
  /** How long the shot runs in the edit, for the stretch of a long video to take. */
  seconds?: number
}

/**
 * A source of B-roll. Every one answers the same two questions: what is
 * there for these words, and the file for this one, saved in this folder.
 */
export interface BrollSource {
  id: SourceId
  /** As the person sees it. */
  name: string
  kinds: readonly BrollKind[]
  /** The key it needs, when it needs one (shared/broll/keys). */
  key?: string
  /** Whether each search costs the person money. */
  paid?: boolean
  search(query: string, opts?: SearchOptions): Promise<Candidate[]>
  fetch(candidate: Candidate, dir: string, opts?: FetchOptions): Promise<Fetched>
}

/** What a moment wants shown, as the router reads it. Data charts are drawn by the graphics code, not found. */
export const INTENTS = [
  'product',
  'concept',
  'news',
  'social',
  'game',
  'logo',
  'reaction',
  'archival',
  'space',
  'nature',
  'people',
  'chart'
] as const
export type BrollIntent = (typeof INTENTS)[number]

/** One moment of an edit that wants B-roll. */
export interface Moment {
  /** The beat it is for, when it is for one. */
  beat?: string
  /** The words said there. */
  said: string
  /** The planner's search phrase: "hands typing on a laptop at night". */
  search: string
  /** What the video is about, in a few words: its title, or what the brand covers. */
  topic: string
  format: 'short' | 'long'
  /** The brand's kind of channel, from shared/raw/profiles: "tech", "gaming", "church". */
  niche?: string
  /** The output's size in pixels. */
  output: { width: number; height: number }
  /** How long the shot runs, in seconds. */
  seconds?: number
  /** What the planner says it wants, when it says. */
  intent?: BrollIntent
  /** Makers the moment names, whose own channels are looked in first. */
  makers?: string[]
}

/** A candidate offered for a moment, with why, in one line. */
export interface Ranked {
  candidate: Candidate
  score: number
  reason: string
}
