import { UNSPLASH } from '../../../shared/broll/license'
import type { BrollSource, Candidate } from '../../../shared/broll/types'
import { failure, longSideFor, needKey, num, savePicture, str, take, type SourceDeps } from './common'

/**
 * Unsplash (unsplash.com/documentation): photos under the Unsplash License,
 * free to use in a monetized video. The person's own Access Key, sent as
 * "Authorization: Client-ID …" to api.unsplash.com and nowhere else. A demo
 * key allows 50 requests an hour.
 *
 * Its API guidelines ask two things of an app, and both are done: every
 * photo used is credited "Photo by … on Unsplash" with links back, and the
 * photo's download endpoint (links.download_location) is called whenever
 * one is used, so the photographer's download is counted. A photo is not
 * used when that call fails.
 *
 * Shapes follow the published documentation: GET /search/photos, and
 * GET /photos/:id/download for the download event.
 */

const API = 'https://api.unsplash.com'

export interface UnsplashPhoto {
  id: string
  width: number
  height: number
  color?: string
  description?: string | null
  alt_description?: string | null
  user: { id: string; username: string; name: string; links: { html: string } }
  urls: { raw: string; full: string; regular: string; small: string; thumb: string }
  links: { self: string; html: string; download: string; download_location: string }
  tags?: { title: string }[]
}

export function candidateOf(p: UnsplashPhoto): Candidate {
  return {
    id: p.id,
    source: 'unsplash',
    kind: 'image',
    title: str(p.description) ?? str(p.alt_description) ?? 'Unsplash photo',
    author: str(p.user?.name),
    authorUrl: str(p.user?.links?.html),
    pageUrl: p.links.html,
    mediaUrl: p.urls.raw,
    previewUrl: p.urls.small,
    width: num(p.width),
    height: num(p.height),
    durationSec: null,
    bytes: null,
    license: UNSPLASH,
    tags: (p.tags ?? []).map((t) => t.title).filter(Boolean),
    extra: { downloadLocation: p.links.download_location, description: p.alt_description ?? '' }
  }
}

export function unsplashSource(deps: SourceDeps): BrollSource {
  const headers = (): Record<string, string> => ({ authorization: `Client-ID ${needKey(deps, 'Unsplash')}`, 'accept-version': 'v1' })
  const hosts = (h: string): boolean => h === 'api.unsplash.com'
  return {
    id: 'unsplash',
    name: 'Unsplash',
    key: 'unsplash',
    kinds: ['image'],
    async search(query, opts = {}) {
      const h = headers()
      if (opts.kinds && !opts.kinds.includes('image')) return []
      try {
        take(deps, 'unsplash', 'Unsplash')
        const p = new URLSearchParams({ query, per_page: String(Math.min(30, opts.count ?? 12)), content_filter: 'high' })
        if (opts.orientation) p.set('orientation', opts.orientation === 'square' ? 'squarish' : opts.orientation)
        const r = await deps.http.json<{ results?: UnsplashPhoto[] }>(`${API}/search/photos?${p}`, { headers: h, hosts, signal: opts.signal })
        return (r.value.results ?? []).map(candidateOf)
      } catch (err) {
        throw failure('Unsplash', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      const where = typeof c.extra?.downloadLocation === 'string' ? c.extra.downloadLocation : null
      if (!where || !c.mediaUrl) throw new Error('Unsplash gave no download for that one.')
      // The download event first: Unsplash asks for it every time a photo is used.
      try {
        take(deps, 'unsplash', 'Unsplash')
        await deps.http.json<{ url?: string }>(where, { headers: headers(), hosts, signal: opts.signal })
      } catch (err) {
        throw new Error(`Unsplash did not record the download, so I did not use the photo. ${err instanceof Error ? err.message : ''}`.trim())
      }
      // The raw file is resized by Unsplash's image server to what the output needs.
      const long = longSideFor(opts.output)
      const url = `${c.mediaUrl}${c.mediaUrl.includes('?') ? '&' : '?'}fm=jpg&q=85&fit=max&w=${long}&h=${long}`
      return savePicture(deps, c, url, dir, opts)
    }
  }
}
