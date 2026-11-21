import { readSources, fromSource, type FoundClip } from '../../../shared/broll-sources'
import { FAIR_USE, OWN } from '../../../shared/broll/license'
import { stretchFor } from '../../../shared/broll/policy'
import { fold } from '../../../shared/broll/text'
import type { BrollSource, Candidate, Fetched } from '../../../shared/broll/types'
import { creditLine, originFor } from '../../../shared/broll/credit'
import { fetchExcerpt, searchVideos, type AssetTools } from '../../assets'

/**
 * YouTube, through yt-dlp as /broll always searched it (main/assets
 * searchVideos and fetchExcerpt, used as they are): the brand's preferred
 * channels first and its blocked ones never; for a product, a trailer or a
 * keynote, the maker's own channel before anyone else's. Someone else's
 * clip is fetched as an excerpt always was: only the stretch used, at most
 * 30 seconds, credited, and whether the use is fair is the person's call.
 *
 * The person's own earlier uploads are a source of their own (ownUploads):
 * that footage is theirs, so there is no fair-use question and no credit.
 */

export interface YouTubeDeps {
  /** yt-dlp, ffmpeg and where fetched clips go (main/assets AssetTools), for a folder. */
  tools: (dir: string) => AssetTools
  /** A folder searches can use for yt-dlp's scratch; nothing is downloaded by a search. */
  scratch: string
}

/** The video's id from any of its links. */
export function videoId(url: string): string {
  const m = /[?&]v=([\w-]{6,})/.exec(url) ?? /youtu\.be\/([\w-]{6,})/.exec(url) ?? /\/shorts\/([\w-]{6,})/.exec(url)
  return m ? m[1] : url
}

function candidateOf(r: FoundClip & { preferred: boolean }, opts: { makers: string[]; own: boolean }): Candidate {
  const id = videoId(r.url)
  const official = !opts.own && !!r.author && opts.makers.some((m) => fold(m) === fold(r.author ?? '') || `@${fold(m)}` === (r.handle ?? '').toLowerCase())
  return {
    id,
    source: opts.own ? 'own-uploads' : 'youtube',
    kind: 'video',
    title: r.title,
    author: r.author,
    authorUrl: r.channelUrl ?? null,
    pageUrl: r.url,
    mediaUrl: r.url,
    previewUrl: id !== r.url ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null,
    width: null,
    height: null,
    durationSec: r.durationSec,
    bytes: null,
    license: opts.own ? OWN : FAIR_USE,
    tags: [],
    ...(r.preferred && !official ? { preferred: true } : {}),
    ...(official ? { official: true } : {}),
    extra: { channelId: r.channelId ?? null, channelUrl: r.channelUrl ?? null, handle: r.handle ?? null }
  }
}

async function fetchClip(deps: YouTubeDeps, c: Candidate, dir: string, opts: { seconds?: number; signal?: AbortSignal; onProgress?: (p: number) => void }): Promise<Fetched> {
  if (!c.pageUrl) throw new Error('That clip has no link to fetch it from.')
  const range = stretchFor(c, opts.seconds)
  const tools = { ...deps.tools(dir), ...(opts.signal ? { signal: opts.signal } : {}) }
  const got = await fetchExcerpt(c.pageUrl, range, tools, opts.onProgress)
  const kept = got.origin.range
  return {
    asset: { ...got, title: got.title || c.title, origin: { ...originFor(c, kept), author: got.origin.author ?? c.author } },
    credit: creditLine({ ...c, author: got.origin.author ?? c.author }, kept)
  }
}

export function youtubeSource(deps: YouTubeDeps): BrollSource {
  return {
    id: 'youtube',
    name: 'YouTube',
    kinds: ['video'],
    async search(query, opts = {}) {
      const makers = opts.makers ?? []
      const brand = opts.brand ?? { prefer: [], block: [] }
      // The maker's own channel, by its name: looked in like a preferred channel, and its clips come first.
      const lists = { prefer: [...brand.prefer, ...makers], block: brand.block }
      const q = makers.length && !fold(query).includes(fold(makers[0])) ? `${makers[0]} ${query}` : query
      const found = await searchVideos(q, { ...deps.tools(deps.scratch), ...(opts.signal ? { signal: opts.signal } : {}) }, opts.count ?? 6, lists)
      return found.results.map((r) => candidateOf(r, { makers, own: false }))
    },
    fetch: (c, dir, opts = {}) => fetchClip(deps, c, dir, opts)
  }
}

/** The person's own channels' earlier videos: their footage, searched only in their channels. */
export function ownUploadsSource(deps: YouTubeDeps & { channels: () => string[] }): BrollSource {
  return {
    id: 'own-uploads',
    name: 'Your own videos',
    kinds: ['video'],
    async search(query, opts = {}) {
      const channels = deps.channels()
      if (channels.length === 0) return []
      const mine = readSources(channels).sources
      const found = await searchVideos(query, { ...deps.tools(deps.scratch), ...(opts.signal ? { signal: opts.signal } : {}) }, opts.count ?? 6, {
        prefer: channels,
        block: []
      })
      // The general search runs too; only what is from the person's own channels is theirs.
      return found.results.filter((r) => mine.some((s) => fromSource(r, s))).map((r) => candidateOf(r, { makers: [], own: true }))
    },
    fetch: (c, dir, opts = {}) => fetchClip(deps, c, dir, opts)
  }
}
