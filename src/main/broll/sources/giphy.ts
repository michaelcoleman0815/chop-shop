import { FAIR_USE } from '../../../shared/broll/license'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { encodeMp4, fileIn, normalized } from '../files'
import { failure, needKey, num, saveVideo, str, take, type SourceDeps } from './common'

/**
 * Reaction GIFs from GIPHY (developers.giphy.com/docs/api): fetched as the
 * MP4 GIPHY makes of each, which is smaller than the GIF and plays as a
 * clip, looped to cover the shot. Every one is credited "Powered by GIPHY",
 * as GIPHY requires. Most GIFs are clips of someone else's film or show,
 * which GIPHY does not license for use in a video, so each is the person's
 * call, like any excerpt. The person's own free key, which the API takes as
 * a query parameter; a new key allows 100 requests an hour.
 *
 * Shapes follow the published documentation for GET /v1/gifs/search and
 * its Images Object.
 */

const API = 'https://api.giphy.com/v1/gifs'

const GIPHY_LICENSE: License = {
  ...FAIR_USE,
  name: 'GIPHY, fair use is your call',
  note: 'Powered by GIPHY. Most GIFs are clips of someone else’s work, so whether this use is fair is your call.'
}

interface Rendition {
  url?: string
  width?: string
  height?: string
  size?: string
  mp4?: string
  mp4_size?: string
  webp?: string
  frames?: string
}

export interface GiphyGif {
  type: 'gif'
  id: string
  url: string
  slug?: string
  username?: string
  source?: string
  title?: string
  rating?: string
  alt_text?: string
  user?: { username?: string; display_name?: string; profile_url?: string }
  images: { original?: Rendition; original_mp4?: Rendition; fixed_height?: Rendition; fixed_height_still?: Rendition; downsized_still?: Rendition; preview_gif?: Rendition }
}

export function candidateOf(g: GiphyGif): Candidate | null {
  const mp4 = str(g.images.original?.mp4) ?? str(g.images.original_mp4?.mp4)
  if (!mp4) return null
  const by = str(g.user?.display_name) ?? str(g.username)
  return {
    id: g.id,
    source: 'giphy',
    kind: 'gif',
    title: str(g.title)?.replace(/\s+GIF(\s+by\s+.+)?$/i, '') || str(g.slug)?.replace(/-[^-]+$/, '').replace(/-/g, ' ') || 'GIF',
    author: by,
    authorUrl: str(g.user?.profile_url),
    pageUrl: g.url,
    mediaUrl: mp4,
    previewUrl: str(g.images.fixed_height_still?.url) ?? str(g.images.downsized_still?.url) ?? str(g.images.preview_gif?.url),
    width: num(g.images.original?.width),
    height: num(g.images.original?.height),
    durationSec: null,
    bytes: num(g.images.original?.mp4_size),
    license: GIPHY_LICENSE,
    tags: str(g.alt_text) ? [g.alt_text as string] : [],
    extra: { rating: g.rating ?? null }
  }
}

export function giphySource(deps: SourceDeps): BrollSource {
  return {
    id: 'giphy',
    name: 'GIPHY',
    key: 'giphy',
    kinds: ['gif'],
    async search(query, opts = {}) {
      const key = needKey(deps, 'GIPHY')
      try {
        take(deps, 'giphy', 'GIPHY')
        const p = new URLSearchParams({ api_key: key, q: query.slice(0, 50), limit: String(Math.min(25, opts.count ?? 12)), rating: 'pg', lang: 'en' })
        const r = await deps.http.json<{ data?: GiphyGif[] }>(`${API}/search?${p}`, { signal: opts.signal, hosts: (h) => h === 'api.giphy.com' })
        return (r.value.data ?? []).map(candidateOf).filter((c): c is Candidate => !!c)
      } catch (err) {
        throw failure('GIPHY', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('GIPHY gave no file for that one.')
      const got = await saveVideo(deps, { ...c, kind: 'video' }, c.mediaUrl, dir, { ...opts, wholeUpTo: 30 * 1024 * 1024 })
      const length = got.asset.durationSec ?? 0
      const want = opts.seconds ?? 0
      if (!(length > 0 && want > length + 0.05)) return got
      // A reaction is shorter than its shot: it plays again until the shot ends.
      const looped = await fileIn(dir, `${c.title}-loop`, 'mp4')
      await encodeMp4(deps.ffmpeg, got.asset.path, looped, { loops: Math.min(20, Math.ceil(want / length) - 1), signal: opts.signal })
      return normalized(looped, c, null, deps.ffmpeg)
    }
  }
}
