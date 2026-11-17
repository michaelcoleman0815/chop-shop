import { freesoundLicense } from '../../../shared/broll/license'
import type { BrollSource, Candidate } from '../../../shared/broll/types'
import { failure, needKey, num, saveSound, str, take, type SourceDeps } from './common'

/**
 * Sound effects from Freesound (freesound.org/docs/api): each sound keeps the
 * licence its maker chose: CC0, CC BY with a credit, or CC BY-NC, which the
 * policy leaves out. The person's own free key, sent as
 * "Authorization: Token …" to freesound.org; a standard key allows 60
 * requests a minute and 2,000 a day.
 *
 * A key on its own reaches each sound's high-quality preview (an MP3 of
 * about 128 kbps), which is what is fetched; the original file needs a
 * signed-in person (OAuth2), which this does not ask for.
 *
 * Shapes follow the published documentation for GET /apiv2/search/text/.
 */

const API = 'https://freesound.org/apiv2'

export interface FreesoundSound {
  id: number
  name: string
  tags?: string[]
  username: string
  license: string
  duration?: number
  url: string
  description?: string
  previews?: { 'preview-hq-mp3'?: string; 'preview-hq-ogg'?: string; 'preview-lq-mp3'?: string; 'preview-lq-ogg'?: string }
  avg_rating?: number
  num_downloads?: number
}

export function candidateOf(s: FreesoundSound): Candidate | null {
  const preview = str(s.previews?.['preview-hq-mp3']) ?? str(s.previews?.['preview-hq-ogg'])
  if (!preview) return null
  const d = num(s.duration)
  return {
    id: String(s.id),
    source: 'freesound',
    kind: 'audio',
    title: s.name.replace(/\.(wav|mp3|aiff?|flac|ogg)$/i, ''),
    author: str(s.username),
    authorUrl: `https://freesound.org/people/${encodeURIComponent(s.username)}/`,
    pageUrl: s.url,
    mediaUrl: preview,
    previewUrl: null,
    width: null,
    height: null,
    durationSec: d,
    bytes: null,
    license: freesoundLicense(s.license),
    tags: s.tags ?? [],
    extra: { audio: d !== null && d > 30 ? 'music' : 'sfx', description: (s.description ?? '').slice(0, 300), rating: num(s.avg_rating) }
  }
}

export function freesoundSource(deps: SourceDeps): BrollSource {
  return {
    id: 'freesound',
    name: 'Freesound',
    key: 'freesound',
    kinds: ['audio'],
    async search(query, opts = {}) {
      const key = needKey(deps, 'Freesound')
      try {
        take(deps, 'freesound', 'Freesound')
        const p = new URLSearchParams({
          query,
          // Short sounds under a licence a monetized video can use; the policy checks each licence again.
          filter: 'duration:[0 TO 30] license:("Creative Commons 0" OR "Attribution")',
          fields: 'id,name,tags,username,license,duration,previews,url,description,avg_rating,num_downloads',
          page_size: String(Math.min(50, opts.count ?? 12)),
          sort: 'score'
        })
        const r = await deps.http.json<{ count?: number; results?: FreesoundSound[] }>(`${API}/search/text/?${p}`, {
          headers: { authorization: `Token ${key}` },
          hosts: (h) => h === 'freesound.org',
          signal: opts.signal
        })
        return (r.value.results ?? []).map(candidateOf).filter((c): c is Candidate => !!c)
      } catch (err) {
        throw failure('Freesound', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('Freesound gave no preview for that sound.')
      // Previews are public files on Freesound's CDN; the key is not sent there.
      return saveSound(deps, c, c.mediaUrl, dir, opts)
    }
  }
}
