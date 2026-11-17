import { licenseFromUrl, PUBLIC_DOMAIN } from '../../../shared/broll/license'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { failure, num, saveVideo, take, type SourceDeps } from './common'

/**
 * Public-domain film from the Internet Archive (archive.org): the Prelinger
 * Archives' industrial, educational and home films, and FedFlix, films the
 * US government made. Needs no key.
 *
 * Only those curated collections are searched. Anyone can upload to the
 * Archive and say a file is public domain, and the uploads that say so
 * include recordings of games and cartoons that plainly are not; a licence
 * nobody checked is no licence at all.
 *
 * Shapes follow the Archive's documented advanced search
 * (archive.org/advancedsearch.php, output=json) and metadata API
 * (archive.org/metadata/{identifier}), checked against live answers.
 */

const SEARCH = 'https://archive.org/advancedsearch.php'
const COLLECTIONS: Record<string, { name: string; note: string }> = {
  prelinger: { name: 'Prelinger Archives', note: 'From the Prelinger Archives, released into the public domain.' },
  fedflix: { name: 'FedFlix', note: 'Made by the US government, so not copyrighted in the United States.' }
}

interface Doc {
  identifier: string
  title?: string | string[]
  description?: string | string[]
  creator?: string | string[]
  year?: string | number
  licenseurl?: string
  collection?: string | string[]
  subject?: string | string[]
}

interface SearchAnswer {
  response?: { numFound?: number; docs?: Doc[] }
}

interface FileEntry {
  name: string
  format?: string
  size?: string
  length?: string
  width?: string
  height?: string
}

interface Metadata {
  files?: FileEntry[]
  metadata?: Record<string, unknown>
}

const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))
const all = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? [v] : [])

/** The collection that vouches for an item, or null when none of those searched does. */
function vouching(d: Doc): string | null {
  const cols = all(d.collection).map((c) => c.toLowerCase())
  return Object.keys(COLLECTIONS).find((c) => cols.includes(c)) ?? null
}

export function archiveLicense(d: Doc): License {
  const col = vouching(d)
  if (!col) return licenseFromUrl(null)
  const stated = d.licenseurl ? licenseFromUrl(d.licenseurl) : null
  // A licence the item states counts when it reads; otherwise the collection's word that it is public domain.
  if (stated && stated.id !== 'unknown') return { ...stated, note: COLLECTIONS[col].note }
  return { ...PUBLIC_DOMAIN, credit: true, note: COLLECTIONS[col].note }
}

/** Words only: the Archive's search reads quotes, brackets and colons as its own syntax. */
const plain = (q: string): string[] => q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1).slice(0, 8)

function candidateOf(d: Doc): Candidate {
  const col = vouching(d)
  const year = d.year ? String(d.year) : null
  return {
    id: d.identifier,
    source: 'archive',
    kind: 'video',
    title: `${first(d.title) ?? d.identifier}${year ? ` (${year})` : ''}`,
    author: first(d.creator) ?? (col ? COLLECTIONS[col].name : null),
    authorUrl: null,
    pageUrl: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
    mediaUrl: null,
    previewUrl: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
    // Most of these films are 4:3 standard definition; the real size is read at fetch time.
    width: null,
    height: null,
    durationSec: null,
    bytes: null,
    license: archiveLicense(d),
    tags: all(d.subject).flatMap((s) => s.split(/[;,]/)).map((s) => s.trim()).filter(Boolean).slice(0, 12),
    extra: { collection: col, description: (first(d.description) ?? '').replace(/<[^>]*>/g, ' ').slice(0, 300) }
  }
}

/** The file to take a stretch from: an H.264 MP4 no taller than 1080, the tallest such. */
export function pickFile(files: FileEntry[]): FileEntry | null {
  const mp4 = files.filter((f) => /\.mp4$/i.test(f.name) && /h\.264|mpeg4/i.test(f.format ?? 'mpeg4'))
  const fits = mp4.filter((f) => Number(f.height ?? 0) <= 1080)
  return [...(fits.length ? fits : mp4)].sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0) || Number(b.size ?? 0) - Number(a.size ?? 0))[0] ?? null
}

export function archiveSource(deps: SourceDeps): BrollSource {
  const ask = async (words: string[], join: 'AND' | 'OR', rows: number, signal?: AbortSignal): Promise<Doc[]> => {
    take(deps, 'archive', 'the Internet Archive')
    const q = `(${words.join(` ${join} `)}) AND mediatype:movies AND collection:(${Object.keys(COLLECTIONS).join(' OR ')})`
    const p = new URLSearchParams({ q, rows: String(rows), output: 'json' })
    for (const f of ['identifier', 'title', 'description', 'creator', 'year', 'licenseurl', 'collection', 'subject']) p.append('fl[]', f)
    const r = await deps.http.json<SearchAnswer>(`${SEARCH}?${p}`, { signal })
    return r.value.response?.docs ?? []
  }
  return {
    id: 'archive',
    name: 'the Internet Archive',
    kinds: ['video'],
    async search(query, opts = {}) {
      const words = plain(query)
      if (words.length === 0) return []
      const rows = Math.min(30, opts.count ?? 10)
      try {
        let docs = await ask(words, 'AND', rows, opts.signal)
        // Every word at once can be too much to ask of old film titles; any of them will do then.
        if (docs.length === 0 && words.length > 1) docs = await ask(words, 'OR', rows, opts.signal)
        return docs.filter((d) => vouching(d)).map(candidateOf)
      } catch (err) {
        throw failure('The Internet Archive', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      take(deps, 'archive', 'the Internet Archive')
      const meta = await deps.http.json<Metadata>(`https://archive.org/metadata/${encodeURIComponent(c.id)}`, { signal: opts.signal, maxBytes: 16 * 1024 * 1024 })
      const file = pickFile(meta.value.files ?? [])
      if (!file) throw new Error('The Archive has no MP4 of that film.')
      const url = `https://archive.org/download/${encodeURIComponent(c.id)}/${file.name.split('/').map(encodeURIComponent).join('/')}`
      const known: Candidate = {
        ...c,
        width: num(file.width) ?? c.width,
        height: num(file.height) ?? c.height,
        durationSec: num(file.length) ?? c.durationSec,
        bytes: num(file.size) ?? c.bytes,
        mediaUrl: url
      }
      return saveVideo(deps, known, url, dir, { ...opts, wholeUpTo: 0 })
    }
  }
}

