import { wikimediaLicense } from '../../../shared/broll/license'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { failure, MAX_IMAGE_BYTES, num, savePicture, saveVideo, str, stripHtml, take, type SourceDeps } from './common'

/**
 * Wikimedia Commons (commons.wikimedia.org): pictures and videos, each with
 * the licence its page states, read from the file's own metadata
 * (extmetadata). Needs no key. A long video is read only for the stretch
 * used (main/broll/relay); a picture too big to fetch whole comes as a
 * large rendition instead.
 *
 * Shapes follow the MediaWiki Action API's documentation for
 * generator=search with prop=imageinfo and prop=videoinfo, checked against
 * its live answers.
 */

const API = 'https://commons.wikimedia.org/w/api.php'

const META = 'ObjectName|ImageDescription|Artist|Credit|LicenseShortName|License|LicenseUrl|AttributionRequired|Restrictions|Categories'

interface Meta {
  value?: string | number
}

interface Info {
  url?: string
  descriptionurl?: string
  thumburl?: string
  width?: number
  height?: number
  size?: number
  duration?: number
  mime?: string
  mediatype?: string
  extmetadata?: Record<string, Meta>
  derivatives?: { src: string; type: string; transcodekey?: string; width?: number; height?: number }[]
}

interface Page {
  pageid: number
  title: string
  index?: number
  imageinfo?: Info[]
  videoinfo?: Info[]
}

interface Answer {
  query?: { pages?: Page[] }
}

const meta = (i: Info, key: string): string | null => {
  const v = i.extmetadata?.[key]?.value
  return v === undefined || v === null ? null : String(v)
}

/** "trademarked", "personality": what Commons says limits a file beyond its licence. */
function withRestrictions(l: License, restrictions: string | null): License {
  const r = (restrictions ?? '').split('|').filter(Boolean)
  if (r.length === 0) return l
  const said: string[] = []
  if (r.includes('personality')) said.push('people in it have rights over how their likeness is used')
  if (r.includes('trademarked')) said.push('it shows a trademark')
  if (r.includes('insignia')) said.push('it shows an official insignia')
  if (said.length === 0) return l
  return { ...l, note: `${l.note ? `${l.note} ` : ''}Commons notes that ${said.join(' and ')}.` }
}

function candidateOf(p: Page, kind: 'image' | 'video'): Candidate | null {
  const i = (kind === 'video' ? p.videoinfo : p.imageinfo)?.[0]
  if (!i?.url) return null
  const name = p.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '')
  const tags = (meta(i, 'Categories') ?? '').split('|').filter(Boolean).slice(0, 12)
  const best =
    kind === 'video'
      ? [...(i.derivatives ?? [])]
          .filter((d) => (d.height ?? 0) <= 1080 && /webm|mp4|quicktime/.test(d.type))
          .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0]
      : undefined
  return {
    id: String(p.pageid),
    source: 'wikimedia',
    kind: kind === 'video' ? 'video' : i.mime === 'image/gif' ? 'gif' : 'image',
    title: stripHtml(meta(i, 'ObjectName')) || name,
    author: stripHtml(meta(i, 'Artist')) || null,
    authorUrl: null,
    pageUrl: str(i.descriptionurl) ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
    mediaUrl: i.url,
    previewUrl: str(i.thumburl),
    width: num(i.width),
    height: num(i.height),
    durationSec: kind === 'video' ? num(i.duration) : null,
    bytes: num(i.size),
    license: withRestrictions(wikimediaLicense(meta(i, 'LicenseShortName'), meta(i, 'License')), meta(i, 'Restrictions')),
    tags,
    extra: {
      mime: i.mime ?? null,
      description: stripHtml(meta(i, 'ImageDescription')).slice(0, 300),
      // A smaller rendition, for a picture too big to fetch whole or a video whose original is huge.
      rendition: kind === 'video' ? (best?.src ?? null) : str(i.thumburl)?.replace(/\/(\d+)px-/, '/1920px-') ?? null
    }
  }
}

export function wikimediaSource(deps: SourceDeps): BrollSource {
  const search = async (query: string, kind: 'image' | 'video', count: number, signal?: AbortSignal): Promise<Candidate[]> => {
    take(deps, 'wikimedia', 'Wikimedia Commons')
    const prop = kind === 'video' ? 'videoinfo' : 'imageinfo'
    const pre = kind === 'video' ? 'vi' : 'ii'
    const p = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      generator: 'search',
      gsrsearch: `${query} filetype:${kind === 'video' ? 'video' : 'bitmap'}`,
      gsrnamespace: '6',
      gsrlimit: String(count),
      prop,
      [`${pre}prop`]: `url|size|mime|mediatype|extmetadata${kind === 'video' ? '|derivatives' : ''}`,
      [`${pre}urlwidth`]: '640',
      [`${pre}extmetadatafilter`]: META
    })
    const r = await deps.http.json<Answer>(`${API}?${p}`, { signal })
    const pages = [...(r.value.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return pages.map((pg) => candidateOf(pg, kind)).filter((c): c is Candidate => !!c)
  }
  return {
    id: 'wikimedia',
    name: 'Wikimedia Commons',
    kinds: ['image', 'gif', 'video'],
    async search(query, opts = {}) {
      const kinds = opts.kinds ?? ['image', 'video']
      const count = Math.min(20, opts.count ?? 10)
      try {
        const out: Candidate[] = []
        if (kinds.includes('video')) out.push(...(await search(query, 'video', count, opts.signal)))
        if (kinds.includes('image') || kinds.includes('gif')) out.push(...(await search(query, 'image', count, opts.signal)))
        return out
      } catch (err) {
        throw failure('Wikimedia Commons', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('Commons gave no file for that one.')
      const rendition = typeof c.extra?.rendition === 'string' ? c.extra.rendition : null
      if (c.kind === 'video') {
        // A huge original is read through the relay either way; a rendition is smaller to seek through.
        const url = (c.bytes ?? 0) > 1024 * 1024 * 1024 && rendition ? rendition : c.mediaUrl
        return saveVideo(deps, c, url, dir, opts)
      }
      const tooBig = (c.bytes ?? 0) > MAX_IMAGE_BYTES || !/^image\/(jpeg|png|webp|gif)$/.test(String(c.extra?.mime ?? 'image/jpeg'))
      return savePicture(deps, c, tooBig && rendition ? rendition : c.mediaUrl, dir, opts)
    }
  }
}
