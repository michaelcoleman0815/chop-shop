import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync, promises as fs } from 'fs'
import { join } from 'path'

/**
 * Artlist's Enterprise API.
 *
 * Credentials are issued by an account manager rather than self-serve, so this
 * is dormant until a client id and secret are entered, and the music folder
 * stays the route that needs no account. Both are encrypted with the OS
 * keychain the same way the Anthropic key is: the renderer can ask whether
 * credentials exist, never what they are.
 *
 * Shapes here follow the published documentation for the token and search
 * endpoints. The signed-download endpoint is referenced by the docs index but
 * its own page 404s, so a bed is fetched from the `url` the search result
 * carries; swap that for the signed URL once its shape can be read.
 */

const TOKEN_URL = 'https://artlist-business-api-prod-cognito.artlist.io/oauth2/token'
const SEARCH_URL = 'https://business.artlist.io/search/v1/song'

const credsFile = (): string => join(app.getPath('userData'), 'artlist.creds')

export function hasArtlist(): boolean {
  return existsSync(credsFile())
}

export function setArtlist(clientId: string, clientSecret: string): void {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!id || !secret) {
    if (existsSync(credsFile())) unlinkSync(credsFile())
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The system keychain is unavailable, so the credentials cannot be stored safely.')
  }
  writeFileSync(credsFile(), safeStorage.encryptString(`${id}:${secret}`), { mode: 0o600 })
}

function readCreds(): string | null {
  if (!existsSync(credsFile())) return null
  try {
    return safeStorage.decryptString(readFileSync(credsFile()))
  } catch {
    return null
  }
}

let cached: { token: string; expires: number } | null = null

async function token(): Promise<string> {
  if (cached && cached.expires > Date.now() + 30_000) return cached.token
  const creds = readCreds()
  if (!creds) throw new Error('Add Artlist Enterprise credentials in Settings to browse the catalog.')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(creds).toString('base64')}`
    },
    body: 'grant_type=client_credentials'
  })
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? 'Artlist rejected those credentials.'
        : `Artlist token request failed (${res.status}).`
    )
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  // Tokens last an hour; keeping the expiry means one request per hour rather
  // than one per search.
  cached = { token: json.access_token, expires: Date.now() + json.expires_in * 1000 }
  return cached.token
}

export interface ArtlistSong {
  id: string
  name: string
  artist: string
  durationSec: number
  bpm: number | null
  url: string
}

export async function searchArtlist(
  query: string,
  opts: { page?: number; durationMin?: number; durationMax?: number } = {}
): Promise<ArtlistSong[]> {
  const params = new URLSearchParams({ page: String(opts.page ?? 1) })
  if (query.trim()) params.set('query', query.trim())
  if (opts.durationMin) params.set('durationMin', String(opts.durationMin))
  if (opts.durationMax) params.set('durationMax', String(opts.durationMax))

  const res = await fetch(`${SEARCH_URL}?${params}`, {
    headers: { Authorization: `Bearer ${await token()}` }
  })
  if (!res.ok) throw new Error(`Artlist search failed (${res.status}).`)
  const json = (await res.json()) as {
    songs?: {
      id: string
      name: string
      artist?: { name?: string }
      duration?: number
      bpmRate?: number
      url?: string
    }[]
  }
  return (json.songs ?? [])
    .filter((s) => !!s.url)
    .map((s) => ({
      id: s.id,
      name: s.name,
      artist: s.artist?.name ?? '',
      durationSec: s.duration ?? 0,
      bpm: s.bpmRate ?? null,
      url: s.url as string
    }))
}

/** Caches a track locally, because the renderer needs a file on disk to mix. */
export async function fetchArtlistSong(song: ArtlistSong): Promise<string> {
  const dir = join(app.getPath('userData'), 'music')
  await fs.mkdir(dir, { recursive: true })
  const safe = song.name.replace(/[^\w\- ]+/g, '').slice(0, 60).trim() || song.id
  const finalPath = join(dir, `${safe} [${song.id}].m4a`)
  if (existsSync(finalPath)) return finalPath

  const res = await fetch(song.url, { headers: { Authorization: `Bearer ${await token()}` } })
  if (!res.ok) throw new Error(`Could not fetch that track (${res.status}).`)
  // Written aside then renamed, so an interrupted fetch never leaves a
  // truncated file that later looks like a cache hit.
  const tmp = `${finalPath}.part`
  await fs.writeFile(tmp, Buffer.from(await res.arrayBuffer()))
  await fs.rename(tmp, finalPath)
  return finalPath
}
