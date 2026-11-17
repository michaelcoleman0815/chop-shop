import { openverseLicense } from '../../../shared/broll/license'
import type { BrollSource, Candidate } from '../../../shared/broll/types'
import { failure, num, saveSound, savePicture, str, take, type SourceDeps } from './common'

/**
 * Openverse (api.openverse.org): openly licensed pictures and sounds from
 * hundreds of collections, Flickr and Wikimedia Commons and Freesound among
 * them, with each item's licence. Needs no key; anonymously it allows 20
 * requests a minute and 200 a day. Commercial use is asked for at the
 * source, and the policy checks every licence again.
 *
 * Shapes follow the API's documentation (api.openverse.org/v1/), checked
 * against its live answers.
 */

const API = 'https://api.openverse.org/v1'
/** Measured from the build machine: nine to twenty seconds a search. */
const SEARCH_TIMEOUT_MS = 30_000

interface OvTag {
  name: string
}

interface OvResult {
  id: string
  title?: string | null
  foreign_landing_url?: string | null
  url?: string | null
  creator?: string | null
  creator_url?: string | null
  license: string
  license_version?: string | null
  provider?: string | null
  source?: string | null
  filesize?: number | null
  filetype?: string | null
  tags?: OvTag[] | null
  mature?: boolean
  width?: number | null
  height?: number | null
  thumbnail?: string | null
  /** Audio only: milliseconds. */
  duration?: number | null
  category?: string | null
}

interface OvPage {
  result_count: number
  page_count: number
  page_size: number
  page: number
  results: OvResult[]
}

function candidateOf(r: OvResult, kind: 'image' | 'audio'): Candidate | null {
  if (!r.url || r.mature) return null
  const gif = kind === 'image' && (r.filetype === 'gif' || /\.gif(\?|$)/i.test(r.url))
  return {
    id: r.id,
    source: 'openverse',
    kind: kind === 'audio' ? 'audio' : gif ? 'gif' : 'image',
    title: str(r.title) ?? 'Untitled',
    author: str(r.creator),
    authorUrl: str(r.creator_url),
    pageUrl: str(r.foreign_landing_url),
    mediaUrl: r.url,
    previewUrl: str(r.thumbnail),
    width: num(r.width),
    height: num(r.height),
    durationSec: kind === 'audio' && num(r.duration) !== null ? (num(r.duration) as number) / 1000 : null,
    bytes: num(r.filesize),
    license: openverseLicense(r.license, r.license_version),
    tags: (r.tags ?? []).map((t) => t.name).filter(Boolean),
    extra: {
      provider: r.provider ?? null,
      ...(kind === 'audio' ? { audio: r.category === 'music' ? 'music' : 'sfx' } : {})
    }
  }
}

export function openverseSource(deps: SourceDeps): BrollSource {
  return {
    id: 'openverse',
    name: 'Openverse',
    kinds: ['image', 'gif', 'audio'],
    async search(query, opts = {}) {
      const kinds = opts.kinds ?? ['image']
      const count = Math.min(20, opts.count ?? 12)
      const out: Candidate[] = []
      try {
        if (kinds.includes('image') || kinds.includes('gif')) {
          take(deps, 'openverse', 'Openverse')
          const p = new URLSearchParams({ q: query, page_size: String(count), license_type: 'commercial', mature: 'false' })
          if (opts.orientation) p.set('aspect_ratio', opts.orientation === 'landscape' ? 'wide' : opts.orientation === 'portrait' ? 'tall' : 'square')
          const r = await deps.http.json<OvPage>(`${API}/images/?${p}`, { signal: opts.signal, timeoutMs: SEARCH_TIMEOUT_MS })
          for (const x of r.value.results ?? []) {
            const c = candidateOf(x, 'image')
            if (c) out.push(c)
          }
        }
        if (kinds.includes('audio')) {
          take(deps, 'openverse', 'Openverse')
          const p = new URLSearchParams({ q: query, page_size: String(count), license_type: 'commercial', mature: 'false' })
          const r = await deps.http.json<OvPage>(`${API}/audio/?${p}`, { signal: opts.signal, timeoutMs: SEARCH_TIMEOUT_MS })
          for (const x of r.value.results ?? []) {
            const c = candidateOf(x, 'audio')
            if (c) out.push(c)
          }
        }
      } catch (err) {
        throw failure('Openverse', err)
      }
      return out
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('Openverse gave no file for that one.')
      if (c.kind === 'audio') return saveSound(deps, c, c.mediaUrl, dir, opts)
      return savePicture(deps, c, c.mediaUrl, dir, opts)
    }
  }
}
