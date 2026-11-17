import { PEXELS } from '../../../shared/broll/license'
import type { BrollSource, Candidate } from '../../../shared/broll/types'
import { failure, longSideFor, needKey, num, savePicture, saveVideo, str, take, type SourceDeps } from './common'

/**
 * Pexels (www.pexels.com/api/documentation): stock video and photos under
 * the Pexels License, free to use in a monetized video without a credit
 * (one is added to the credits anyway, as Pexels asks when it can be). The
 * person's own free key, sent as the Authorization header and nowhere else.
 * Free keys allow 200 requests an hour and 20,000 a month.
 *
 * Shapes follow the published documentation: GET /v1/search for photos,
 * GET /videos/search for videos.
 */

const API = 'https://api.pexels.com'

export interface PexelsPhoto {
  id: number
  width: number
  height: number
  url: string
  photographer: string
  photographer_url: string
  photographer_id?: number
  avg_color?: string
  src: { original: string; large2x?: string; large?: string; medium?: string; small?: string; portrait?: string; landscape?: string; tiny?: string }
  alt?: string
}

export interface PexelsVideoFile {
  id: number
  quality: string | null
  file_type: string
  width: number | null
  height: number | null
  fps?: number | null
  link: string
}

export interface PexelsVideo {
  id: number
  width: number
  height: number
  url: string
  image: string
  duration: number
  user: { id: number; name: string; url: string }
  video_files: PexelsVideoFile[]
  video_pictures?: { id: number; picture: string; nr: number }[]
}

/** "https://www.pexels.com/video/hands-typing-on-a-laptop-855428/" says what it shows. */
export function titleFromUrl(url: string, fallback: string): string {
  const m = /\/(?:video|photo)\/([^/]+?)-\d+\/?$/.exec(url)
  if (!m) return fallback
  const t = m[1].replace(/-/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : fallback
}

/** The file to download: the tallest MP4 whose long side is no more than the output needs, else the smallest above. */
export function pickFile(files: PexelsVideoFile[], longSide: number): PexelsVideoFile | null {
  const mp4 = files.filter((f) => f.file_type === 'video/mp4' && f.width && f.height)
  if (mp4.length === 0) return null
  const long = (f: PexelsVideoFile): number => Math.max(f.width ?? 0, f.height ?? 0)
  const fits = mp4.filter((f) => long(f) <= longSide)
  if (fits.length) return [...fits].sort((a, b) => long(b) - long(a))[0]
  return [...mp4].sort((a, b) => long(a) - long(b))[0]
}

export function photoCandidate(p: PexelsPhoto): Candidate {
  return {
    id: `p${p.id}`,
    source: 'pexels',
    kind: 'image',
    title: str(p.alt) ?? titleFromUrl(p.url, 'Pexels photo'),
    author: str(p.photographer),
    authorUrl: str(p.photographer_url),
    pageUrl: p.url,
    mediaUrl: p.src.original,
    previewUrl: p.src.medium ?? p.src.small ?? null,
    width: num(p.width),
    height: num(p.height),
    durationSec: null,
    bytes: null,
    license: PEXELS,
    tags: [],
    extra: { description: p.alt ?? '' }
  }
}

export function videoCandidate(v: PexelsVideo, longSide: number): Candidate | null {
  const file = pickFile(v.video_files, longSide)
  if (!file) return null
  return {
    id: `v${v.id}`,
    source: 'pexels',
    kind: 'video',
    title: titleFromUrl(v.url, 'Pexels video'),
    author: str(v.user?.name),
    authorUrl: str(v.user?.url),
    pageUrl: v.url,
    mediaUrl: file.link,
    previewUrl: str(v.image),
    width: file.width,
    height: file.height,
    durationSec: num(v.duration),
    bytes: null,
    license: PEXELS,
    tags: [],
    extra: { fps: file.fps ?? null }
  }
}

export function pexelsSource(deps: SourceDeps): BrollSource {
  return {
    id: 'pexels',
    name: 'Pexels',
    key: 'pexels',
    kinds: ['video', 'image'],
    async search(query, opts = {}) {
      const key = needKey(deps, 'Pexels')
      const kinds = opts.kinds ?? ['video', 'image']
      const per = String(Math.min(40, opts.count ?? 12))
      const headers = { authorization: key }
      const hosts = (h: string): boolean => h === 'api.pexels.com'
      const out: Candidate[] = []
      try {
        if (kinds.includes('video')) {
          take(deps, 'pexels', 'Pexels')
          const p = new URLSearchParams({ query, per_page: per })
          if (opts.orientation) p.set('orientation', opts.orientation)
          const r = await deps.http.json<{ videos?: PexelsVideo[] }>(`${API}/videos/search?${p}`, { headers, hosts, signal: opts.signal })
          for (const v of r.value.videos ?? []) {
            const c = videoCandidate(v, 1920)
            if (c) out.push(c)
          }
        }
        if (kinds.includes('image')) {
          take(deps, 'pexels', 'Pexels')
          const p = new URLSearchParams({ query, per_page: per })
          if (opts.orientation) p.set('orientation', opts.orientation)
          const r = await deps.http.json<{ photos?: PexelsPhoto[] }>(`${API}/v1/search?${p}`, { headers, hosts, signal: opts.signal })
          for (const ph of r.value.photos ?? []) out.push(photoCandidate(ph))
        }
      } catch (err) {
        throw failure('Pexels', err)
      }
      return out
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('Pexels gave no file for that one.')
      if (c.kind === 'video') return saveVideo(deps, c, c.mediaUrl, dir, opts)
      // The original can be 50 megapixels; Pexels resizes on request, to what the output needs.
      const long = longSideFor(opts.output)
      const url = `${c.mediaUrl}${c.mediaUrl.includes('?') ? '&' : '?'}auto=compress&cs=tinysrgb&fit=max&w=${long}&h=${long}`
      return savePicture(deps, c, url, dir, opts)
    }
  }
}
