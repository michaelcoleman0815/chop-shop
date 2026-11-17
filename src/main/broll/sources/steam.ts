import { createWriteStream, promises as fs } from 'fs'
import { isMaster, mpdFacts, parseMaster, parseMedia, pickVariant, segmentsFor } from '../../../shared/broll/hls'
import { FAIR_USE } from '../../../shared/broll/license'
import { stretchFor } from '../../../shared/broll/policy'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { fileIn, normalized, runFfmpeg } from '../files'
import { HttpError } from '../http'
import { failure, longSideFor, savePicture, take, VIDEO_TYPES, type SourceDeps } from './common'

/**
 * Game footage from the Steam store (store.steampowered.com/api): each
 * game's trailers and screenshots, as its publisher put them on its store
 * page. Needs no key. They are the publisher's promotional material, not
 * licensed for reuse, so they are offered as someone else's clips are:
 * short, credited, and the person's call.
 *
 * Trailers are served as HLS (shared/broll/hls), so only the segments a
 * stretch covers are downloaded, then joined into one MP4 on this computer.
 * The store API is not formally documented; its shapes here are the ones it
 * answers with, recorded in the tests.
 */

const STORE = 'https://store.steampowered.com'

const STEAM_LICENSE: License = {
  ...FAIR_USE,
  note: 'The publisher’s own promotional material: kept short and credited, and whether this use is fair is your call.'
}

interface SearchItem {
  type?: string
  name: string
  id: number
  tiny_image?: string
}

interface Movie {
  id: number
  name?: string
  thumbnail?: string
  hls_h264?: string
  dash_h264?: string
  highlight?: boolean
  /** Older answers named the files directly. */
  mp4?: { '480'?: string; max?: string }
}

interface AppData {
  type?: string
  name?: string
  steam_appid?: number
  short_description?: string
  developers?: string[]
  publishers?: string[]
  header_image?: string
  movies?: Movie[]
  screenshots?: { id: number; path_thumbnail?: string; path_full?: string }[]
  content_descriptors?: { ids?: number[] }
  genres?: { description: string }[]
}

/** Content Steam marks as sexual (3: adult only, 4: frequent nudity or sexual content) is never offered. */
const ADULT = [3, 4]

/**
 * Steam's store search matches titles, so words about the footage find
 * nothing: "<title> gameplay" has no results where "<title>" has ten.
 */
const FOOTAGE_WORDS = /\b(?:video ?games?|games?|gameplay|game ?play|trailers?|teasers?|footage|clips?|screenshots?|videos?|b-?roll|official|playthrough|walkthrough)\b/gi

/** The words to search the store with: the title without the footage words, then as said. */
export function storeTerms(query: string): string[] {
  const bare = query.replace(FOOTAGE_WORDS, ' ').replace(/\s+/g, ' ').trim()
  return [...new Set([bare, query.trim()])].filter((t) => t.length > 0)
}

/** Store entries that are not the game: its soundtrack, its art book. */
const NOT_THE_GAME = /\b(?:soundtrack|ost|artbook|art book)\b/i

/** The older CDN path for a store file, which serves the same file when the newer host cannot be reached. */
export function legacyAsset(url: string): string | null {
  const m = /\/store_item_assets\/steam\/apps\/(\d+)\/(?:[0-9a-f]{40}\/)?([^/?]+)/.exec(url)
  return m ? `https://cdn.akamai.steamstatic.com/steam/apps/${m[1]}/${m[2]}` : null
}

function sizeFromUrl(url: string): { width: number; height: number } | null {
  const m = /\.(\d{3,4})x(\d{3,4})\.(?:jpg|png)/.exec(url)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

export function candidatesOf(app: AppData, want: { video: boolean; image: boolean }): Candidate[] {
  if (!app.name || !app.steam_appid) return []
  if ((app.content_descriptors?.ids ?? []).some((id) => ADULT.includes(id))) return []
  const publisher = app.publishers?.find(Boolean) ?? app.developers?.find(Boolean) ?? null
  const page = `${STORE}/app/${app.steam_appid}/`
  const tags = [app.name, ...(app.genres ?? []).map((g) => g.description)]
  const makers = [...new Set([...(app.publishers ?? []), ...(app.developers ?? [])])].join('|')
  const out: Candidate[] = []
  if (want.video) {
    const movies = [...(app.movies ?? [])].sort((a, b) => Number(b.highlight === true) - Number(a.highlight === true)).slice(0, 3)
    for (const m of movies) {
      const media = m.hls_h264 ?? m.mp4?.max ?? m.mp4?.['480']
      if (!media) continue
      out.push({
        id: `${app.steam_appid}-m${m.id}`,
        source: 'steam',
        kind: 'video',
        title: m.name && !m.name.toLowerCase().includes(app.name.toLowerCase()) ? `${app.name}: ${m.name}` : (m.name ?? app.name),
        author: publisher,
        authorUrl: null,
        pageUrl: page,
        mediaUrl: media,
        previewUrl: m.thumbnail ?? null,
        width: null,
        height: null,
        durationSec: null,
        bytes: null,
        license: STEAM_LICENSE,
        tags,
        official: true,
        extra: { appid: app.steam_appid, makers, description: app.short_description ?? '', dash: m.dash_h264 ?? null }
      })
    }
  }
  if (want.image) {
    for (const s of (app.screenshots ?? []).slice(0, 4)) {
      if (!s.path_full) continue
      const size = sizeFromUrl(s.path_full)
      out.push({
        id: `${app.steam_appid}-s${s.id}`,
        source: 'steam',
        kind: 'image',
        title: `${app.name}, screenshot ${s.id + 1}`,
        author: publisher,
        authorUrl: null,
        pageUrl: page,
        mediaUrl: s.path_full,
        previewUrl: s.path_thumbnail ?? null,
        width: size?.width ?? null,
        height: size?.height ?? null,
        durationSec: null,
        bytes: null,
        license: STEAM_LICENSE,
        tags,
        official: true,
        extra: { appid: app.steam_appid, makers, description: app.short_description ?? '' }
      })
    }
  }
  return out
}

export function steamSource(deps: SourceDeps): BrollSource {
  /**
   * A trailer's size and length from the DASH manifest Steam lists beside its
   * HLS (a few kilobytes), so it is ranked on what it is rather than as
   * unknown. A manifest that cannot be read leaves the trailer as it was.
   */
  const withFacts = async (c: Candidate, signal?: AbortSignal): Promise<Candidate> => {
    const dash = typeof c.extra?.dash === 'string' ? c.extra.dash : null
    if (c.kind !== 'video' || !dash) return c
    try {
      const r = await deps.http.text(dash, {
        signal,
        accept: ['application/dash+xml', 'application/xml', 'text/xml', 'text/plain', 'application/octet-stream'],
        maxBytes: 256 * 1024,
        timeoutMs: 8_000,
        retries: 0
      })
      const f = mpdFacts(r.value)
      return { ...c, width: f.width ?? c.width, height: f.height ?? c.height, durationSec: f.durationSec ?? c.durationSec }
    } catch {
      return c
    }
  }

  /** A trailer's stretch from its HLS playlists, joined into one MP4. */
  const trailer = async (c: Candidate, dir: string, opts: { seconds?: number; signal?: AbortSignal; output?: { width: number; height: number }; onProgress?: (p: number) => void }) => {
    const masterUrl = c.mediaUrl as string
    const master = await deps.http.text(masterUrl, { signal: opts.signal, accept: ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'text/', 'application/octet-stream'] })
    let mediaUrl = master.url
    let text = master.value
    let width: number | null = null
    let height: number | null = null
    if (isMaster(text)) {
      const variant = pickVariant(parseMaster(text, master.url).variants, Math.min(1080, longSideFor(opts.output)))
      if (!variant) throw new Error('That trailer has no picture to take.')
      width = variant.width
      height = variant.height
      const media = await deps.http.text(variant.uri, { signal: opts.signal })
      mediaUrl = media.url
      text = media.value
    }
    const playlist = parseMedia(text, mediaUrl)
    if (playlist.encrypted) throw new Error('That trailer is encrypted, so it cannot be used.')
    const range = stretchFor({ ...c, durationSec: playlist.totalSec }, opts.seconds) ?? { startSec: 0, endSec: playlist.totalSec }
    const { segments, startSec, endSec } = segmentsFor(playlist, range)
    if (segments.length === 0) throw new Error('That trailer has nothing in that stretch.')
    const joined = await fileIn(dir, `${c.title}-${Math.round(startSec)}s`, 'm4s')
    const out = createWriteStream(joined)
    try {
      const parts = [...(playlist.init ? [playlist.init] : []), ...segments.map((s) => s.uri)]
      for (const [i, uri] of parts.entries()) {
        const seg = await deps.http.bytes(uri, { signal: opts.signal, accept: VIDEO_TYPES, maxBytes: 40 * 1024 * 1024 })
        await new Promise<void>((resolve, reject) => out.write(seg.value, (err) => (err ? reject(err) : resolve())))
        opts.onProgress?.(Math.round(((i + 1) / parts.length) * 85))
      }
    } finally {
      await new Promise<void>((resolve) => out.end(() => resolve()))
    }
    // The segments are one fragmented MP4 already; a plain MP4 that seeks well is made from them without re-encoding.
    const clip = await fileIn(dir, `${c.title}-${Math.round(startSec)}s`, 'mp4')
    try {
      await runFfmpeg(deps.ffmpeg, ['-loglevel', 'error', '-y', '-i', joined, '-map', '0:v:0', '-an', '-c', 'copy', '-movflags', '+faststart', clip], opts.signal)
    } finally {
      await fs.rm(joined, { force: true }).catch(() => undefined)
    }
    return normalized(clip, { ...c, width, height, durationSec: playlist.totalSec }, { startSec, endSec }, deps.ffmpeg)
  }

  return {
    id: 'steam',
    name: 'Steam',
    kinds: ['video', 'image'],
    async search(query, opts = {}) {
      const kinds = opts.kinds ?? ['video', 'image']
      const want = { video: kinds.includes('video'), image: kinds.includes('image') }
      try {
        let apps: SearchItem[] = []
        for (const term of storeTerms(query)) {
          take(deps, 'steam', 'Steam')
          const p = new URLSearchParams({ term, l: 'english', cc: 'US' })
          const found = await deps.http.json<{ total?: number; items?: SearchItem[] }>(`${STORE}/api/storesearch/?${p}`, { signal: opts.signal })
          apps = (found.value.items ?? []).filter((i) => (i.type ?? 'app') === 'app' && !NOT_THE_GAME.test(i.name)).slice(0, 2)
          if (apps.length) break
        }
        const out: Candidate[] = []
        for (const a of apps) {
          take(deps, 'steam', 'Steam')
          const d = await deps.http.json<Record<string, { success: boolean; data?: AppData }>>(
            `${STORE}/api/appdetails?appids=${a.id}&l=english&cc=US`,
            { signal: opts.signal }
          )
          const entry = d.value[String(a.id)]
          if (entry?.success && entry.data) out.push(...candidatesOf(entry.data, want))
        }
        return await Promise.all(out.map((c) => withFacts(c, opts.signal)))
      } catch (err) {
        throw failure('Steam', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      if (!c.mediaUrl) throw new Error('Steam gave no file for that one.')
      if (c.kind === 'video') {
        if (/\.m3u8(\?|$)/.test(c.mediaUrl)) return trailer(c, dir, opts)
        throw new Error('That trailer is in a form I cannot take a stretch of.')
      }
      try {
        return await savePicture(deps, c, c.mediaUrl, dir, opts)
      } catch (err) {
        // The store's newer image host can be out of reach where its older one is not.
        const older = legacyAsset(c.mediaUrl)
        if (!older || !(err instanceof HttpError) || !['network', 'host', 'status'].includes(err.code)) throw err
        return savePicture(deps, c, older, dir, opts)
      }
    }
  }
}

