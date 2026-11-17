import { PIXABAY } from '../../../shared/broll/license'
import type { BrollSource, Candidate } from '../../../shared/broll/types'
import { failure, needKey, num, savePicture, saveVideo, str, take, type SourceDeps } from './common'

/**
 * Pixabay (pixabay.com/api/docs): stock video and photos under the Pixabay
 * Content License, free to use in a monetized video without a credit. The
 * person's own free key, which the API takes as a query parameter (hidden
 * whenever a link is shown, main/broll/http redact). Free keys allow 100
 * requests a minute, and Pixabay asks for every search to be kept for 24
 * hours rather than asked again, which this does.
 *
 * Shapes follow the published documentation: GET /api/ for images,
 * GET /api/videos/ for videos.
 */

const API = 'https://pixabay.com/api'
const DAY = 24 * 3600 * 1000

export interface PixabayImage {
  id: number
  pageURL: string
  type: string
  tags: string
  previewURL: string
  webformatURL: string
  largeImageURL: string
  /** Only with full API access. */
  fullHDURL?: string
  imageURL?: string
  imageWidth: number
  imageHeight: number
  imageSize: number
  user_id: number
  user: string
  userImageURL?: string
}

export interface PixabayRendition {
  url: string
  width: number
  height: number
  size: number
  thumbnail?: string
}

export interface PixabayVideo {
  id: number
  pageURL: string
  type: string
  tags: string
  duration: number
  videos: { large?: PixabayRendition; medium?: PixabayRendition; small?: PixabayRendition; tiny?: PixabayRendition }
  user_id: number
  user: string
}

const tagsOf = (s: string): string[] =>
  s
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)

const titleOf = (tags: string[], kind: string): string => (tags.length ? tags.slice(0, 3).join(', ') : `Pixabay ${kind}`)

const userUrl = (user: string, id: number): string => `https://pixabay.com/users/${encodeURIComponent(user)}-${id}/`

export function imageCandidate(h: PixabayImage): Candidate {
  const tags = tagsOf(h.tags)
  // largeImageURL is held to 1280 pixels on its long side; the full sizes need full API access.
  const full = str(h.imageURL) ?? str(h.fullHDURL)
  const scale = full ? 1 : Math.min(1, 1280 / Math.max(1, h.imageWidth, h.imageHeight))
  return {
    id: `p${h.id}`,
    source: 'pixabay',
    kind: 'image',
    title: titleOf(tags, 'image'),
    author: str(h.user),
    authorUrl: userUrl(h.user, h.user_id),
    pageUrl: h.pageURL,
    mediaUrl: full ?? h.largeImageURL,
    previewUrl: str(h.previewURL),
    width: Math.round(h.imageWidth * scale),
    height: Math.round(h.imageHeight * scale),
    durationSec: null,
    bytes: full ? num(h.imageSize) : null,
    license: PIXABAY,
    tags,
    extra: {}
  }
}

/** The rendition to download: the biggest whose long side is no more than the output needs. Missing sizes have an empty url. */
export function pickRendition(v: PixabayVideo, longSide: number): PixabayRendition | null {
  const all = [v.videos.large, v.videos.medium, v.videos.small, v.videos.tiny].filter((r): r is PixabayRendition => !!r?.url)
  const long = (r: PixabayRendition): number => Math.max(r.width, r.height)
  const fits = all.filter((r) => long(r) <= longSide)
  return (fits.length ? fits.sort((a, b) => long(b) - long(a)) : all.sort((a, b) => long(a) - long(b)))[0] ?? null
}

export function videoCandidate(v: PixabayVideo, longSide: number): Candidate | null {
  const r = pickRendition(v, longSide)
  if (!r) return null
  const tags = tagsOf(v.tags)
  return {
    id: `v${v.id}`,
    source: 'pixabay',
    kind: 'video',
    title: titleOf(tags, 'video'),
    author: str(v.user),
    authorUrl: userUrl(v.user, v.user_id),
    pageUrl: v.pageURL,
    mediaUrl: r.url,
    previewUrl: str(r.thumbnail),
    width: r.width,
    height: r.height,
    durationSec: num(v.duration),
    bytes: num(r.size),
    license: PIXABAY,
    tags,
    extra: {}
  }
}

export function pixabaySource(deps: SourceDeps & { now?: () => number }): BrollSource {
  const now = deps.now ?? (() => Date.now())
  const kept = new Map<string, { at: number; value: unknown }>()
  /** A search, from the last day's answers when it was asked already. The key is not part of what is kept. */
  const ask = async <T>(path: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> => {
    const id = `${path}?${params}`
    const hit = kept.get(id)
    if (hit && now() - hit.at < DAY) return hit.value as T
    take(deps, 'pixabay', 'Pixabay')
    const withKey = new URLSearchParams(params)
    withKey.set('key', needKey(deps, 'Pixabay'))
    const r = await deps.http.json<T>(`${API}${path}?${withKey}`, { signal, hosts: (h) => h === 'pixabay.com' })
    kept.set(id, { at: now(), value: r.value })
    if (kept.size > 500) kept.delete(kept.keys().next().value as string)
    return r.value
  }
  return {
    id: 'pixabay',
    name: 'Pixabay',
    key: 'pixabay',
    kinds: ['video', 'image'],
    async search(query, opts = {}) {
      needKey(deps, 'Pixabay')
      const kinds = opts.kinds ?? ['video', 'image']
      const per = String(Math.max(3, Math.min(50, opts.count ?? 12)))
      const out: Candidate[] = []
      try {
        if (kinds.includes('video')) {
          const p = new URLSearchParams({ q: query.slice(0, 100), video_type: 'film', safesearch: 'true', per_page: per })
          const r = await ask<{ hits?: PixabayVideo[] }>('/videos/', p, opts.signal)
          for (const v of r.hits ?? []) {
            const c = videoCandidate(v, 1920)
            if (c) out.push(c)
          }
        }
        if (kinds.includes('image')) {
          const p = new URLSearchParams({ q: query.slice(0, 100), image_type: 'photo', safesearch: 'true', per_page: per })
          if (opts.orientation === 'landscape') p.set('orientation', 'horizontal')
          if (opts.orientation === 'portrait') p.set('orientation', 'vertical')
          const r = await ask<{ hits?: PixabayImage[] }>('/', p, opts.signal)
          for (const h of r.hits ?? []) out.push(imageCandidate(h))
        }
      } catch (err) {
        throw failure('Pixabay', err)
      }
      return out
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('Pixabay gave no file for that one.')
      return c.kind === 'video' ? saveVideo(deps, c, c.mediaUrl, dir, opts) : savePicture(deps, c, c.mediaUrl, dir, opts)
    }
  }
}
