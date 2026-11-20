import { NASA, UNKNOWN } from '../../../shared/broll/license'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { HttpError } from '../http'
import { failure, MAX_IMAGE_BYTES, num, savePicture, saveVideo, str, take, type SourceDeps } from './common'

/**
 * The NASA Image and Video Library (images-api.nasa.gov): NASA's pictures
 * and films, not copyrighted in the United States, credited to NASA, and
 * never used to suggest NASA endorses the video. Needs no key.
 *
 * The library also holds work NASA did not make: a launch filmed by the
 * company that built the rocket, a picture from another agency. Those are
 * credited to someone else and may be theirs, so anything credited to
 * anyone but NASA is read as an unknown licence and left out.
 *
 * Shapes follow the API's documentation (images.nasa.gov/docs/images.nasa.gov_api_docs.pdf),
 * checked against its live answers.
 */

const API = 'https://images-api.nasa.gov'

interface NasaData {
  nasa_id: string
  title?: string
  description?: string
  keywords?: string[]
  media_type?: 'image' | 'video' | 'audio'
  date_created?: string
  center?: string
  photographer?: string
  secondary_creator?: string
}

interface NasaItem {
  href?: string
  data?: NasaData[]
  links?: { href: string; rel?: string; render?: string; width?: number; height?: number }[]
}

interface NasaSearch {
  collection?: { items?: NasaItem[]; metadata?: { total_hits?: number } }
}

interface NasaAssets {
  collection?: { items?: { href: string }[] }
}

/** Who a NASA item credits: its photographer, its other creator, or a "Credit:" in its description. */
export function creditOf(d: NasaData): string | null {
  const named = str(d.photographer) ?? str(d.secondary_creator)
  if (named) return named
  const m = /(?:image |video |photo )?credit[s]?\s*:\s*([^\n.;]{2,80})/i.exec(d.description ?? '')
  return m ? m[1].trim() : null
}

/** NASA's own work is public domain; anything credited to someone else, or marked copyrighted, is not known to be. */
export function nasaLicense(d: NasaData): License {
  const credit = creditOf(d)
  if (/©|\(c\)\s*\d{4}|copyright/i.test(`${d.description ?? ''} ${credit ?? ''}`)) return { ...UNKNOWN, note: 'It is marked as copyrighted.' }
  if (credit && !/\bnasa\b/i.test(credit))
    return { ...UNKNOWN, note: `NASA hosts it, but credits it to ${credit}, who may hold its copyright.` }
  return NASA
}

const https = (u: string): string => u.replace(/^http:\/\//, 'https://')

function candidateOf(it: NasaItem): Candidate | null {
  const d = it.data?.[0]
  if (!d?.nasa_id || (d.media_type !== 'image' && d.media_type !== 'video')) return null
  const preview = it.links?.find((l) => l.rel === 'preview')?.href ?? it.links?.[0]?.href ?? null
  const credit = creditOf(d)
  return {
    id: d.nasa_id,
    source: 'nasa',
    kind: d.media_type === 'video' ? 'video' : 'image',
    title: str(d.title) ?? d.nasa_id,
    author: credit ?? 'NASA',
    authorUrl: null,
    pageUrl: `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}`,
    mediaUrl: null,
    previewUrl: preview ? https(preview) : null,
    // The links are small stills, not the file; the real size is read at fetch time.
    width: null,
    height: null,
    durationSec: null,
    bytes: null,
    license: nasaLicense(d),
    tags: d.keywords ?? [],
    extra: { assets: it.href ? https(it.href) : null, description: (d.description ?? '').slice(0, 300), center: d.center ?? null }
  }
}

/** Seconds from exiftool's ways of writing a length: "0:01:35", "95.1 s". */
export function seconds(v: unknown): number | null {
  if (typeof v === 'number') return v
  // XMP writes a length as a count and the length of one: { Value: 35566080, Scale: 1.111e-05 }.
  if (v && typeof v === 'object') {
    const { Value, Scale } = v as { Value?: unknown; Scale?: unknown }
    return typeof Value === 'number' && typeof Scale === 'number' && Scale > 0 ? Math.round(Value * Scale * 1000) / 1000 : null
  }
  if (typeof v !== 'string') return null
  const clock = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v.trim())
  if (clock) return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
  const s = /^(\d+(?:\.\d+)?)\s*s/.exec(v.trim())
  return s ? Number(s[1]) : null
}

export function nasaSource(deps: SourceDeps): BrollSource {
  const assetsOf = async (c: Candidate, signal?: AbortSignal): Promise<string[]> => {
    take(deps, 'nasa', 'NASA')
    const url = typeof c.extra?.assets === 'string' ? c.extra.assets : `${API}/asset/${encodeURIComponent(c.id)}`
    const r = await deps.http.json<NasaAssets | string[]>(url, { signal })
    // The search's own link answers with a plain list; the asset endpoint with a collection.
    const list = Array.isArray(r.value) ? r.value : (r.value.collection?.items ?? []).map((i) => i.href)
    return list.map(https)
  }
  return {
    id: 'nasa',
    name: 'NASA',
    kinds: ['image', 'video'],
    async search(query, opts = {}) {
      const kinds = opts.kinds ?? ['image', 'video']
      const media = [kinds.includes('image') ? 'image' : null, kinds.includes('video') ? 'video' : null].filter(Boolean).join(',')
      if (!media) return []
      try {
        take(deps, 'nasa', 'NASA')
        const p = new URLSearchParams({ q: query, media_type: media, page_size: String(Math.min(50, opts.count ?? 12)) })
        const r = await deps.http.json<NasaSearch>(`${API}/search?${p}`, { signal: opts.signal })
        return (r.value.collection?.items ?? []).map(candidateOf).filter((c): c is Candidate => !!c)
      } catch (err) {
        throw failure('NASA', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      const files = await assetsOf(c, opts.signal)
      const pick = (suffix: RegExp): string | undefined => files.find((f) => suffix.test(f))
      if (c.kind === 'video') {
        const url = pick(/~large\.mp4$/i) ?? pick(/~orig\.mp4$/i) ?? pick(/~medium\.mp4$/i) ?? pick(/\.mp4$/i)
        if (!url) throw new Error('NASA has no MP4 of that video.')
        // Its length is in the metadata, so only the stretch used is read.
        let durationSec = c.durationSec
        try {
          take(deps, 'nasa', 'NASA')
          const where = await deps.http.json<{ location?: string }>(`${API}/metadata/${encodeURIComponent(c.id)}`, { signal: opts.signal })
          if (where.value.location) {
            const m = await deps.http.json<Record<string, unknown>>(https(where.value.location), { signal: opts.signal })
            // Several tags carry a length (XMP:Duration, QuickTime:Duration); the first that reads as one, over 0, is it.
            const lengths = Object.keys(m.value)
              .filter((k) => /(^|:)Duration$/.test(k))
              .map((k) => seconds(m.value[k]))
              .filter((s): s is number => s !== null && s > 0)
            durationSec = lengths[0] ?? durationSec
          }
        } catch {
          // Without its length, a stretch from the start is taken.
        }
        const known = durationSec ? { ...c, durationSec } : { ...c, range: { startSec: 0, endSec: Math.max(1, opts.seconds ?? 8) } }
        return saveVideo(deps, known, url, dir, { ...opts, wholeUpTo: 0 })
      }
      const order = [pick(/~orig\.(jpe?g|png)$/i), pick(/~large\.(jpe?g|png)$/i), pick(/~medium\.(jpe?g|png)$/i)].filter(
        (u): u is string => !!u
      )
      let last: unknown = null
      for (const url of order) {
        try {
          return await savePicture(deps, c, url, dir, opts)
        } catch (err) {
          // An original over the limit falls back to the large rendition.
          if (!(err instanceof HttpError && err.code === 'too-large')) throw err
          last = err
        }
      }
      throw last ?? new Error(`NASA has no picture file for that one (over ${MAX_IMAGE_BYTES / 1024 / 1024} MB at most).`)
    }
  }
}
