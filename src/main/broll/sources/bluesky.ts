import { readSources } from '../../../shared/broll-sources'
import { FAIR_USE } from '../../../shared/broll/license'
import { blueskyHandle } from '../../../shared/broll/policy'
import { overlap, stems } from '../../../shared/broll/text'
import type { BrollSource, Candidate, License } from '../../../shared/broll/types'
import { fileIn, normalized } from '../files'
import { HttpError } from '../http'
import { promises as fs } from 'fs'
import { drawPostCard } from '../post-card'
import { failure, IMAGE_TYPES, num, str, take, type SourceDeps } from './common'

/**
 * Public posts on Bluesky (public.api.bsky.app), shown as they read: drawn
 * as a post card here, or captured as the post's page when the app can
 * open one (main/page-capture). Needs no key.
 *
 * Searching posts without signing in is refused by Bluesky's public API at
 * the moment (403), so when it is, posts come from the accounts most likely
 * to have them: the brand's preferred Bluesky accounts, the maker's own,
 * then accounts that match the words. Posts labelled adult or graphic, and
 * accounts that ask not to be shown to people logged out, are left out.
 *
 * Shapes follow the AT Protocol lexicons (app.bsky.feed.searchPosts,
 * app.bsky.feed.getAuthorFeed, app.bsky.actor.searchActors), checked
 * against live answers.
 */

const API = 'https://public.api.bsky.app/xrpc'

const BLUESKY_LICENSE: License = {
  ...FAIR_USE,
  note: 'Someone else’s post: shown as it reads, credited, and whether this use is fair is your call.'
}

const UNSAFE_LABELS = new Set(['porn', 'sexual', 'nudity', 'graphic-media', 'gore', 'nsfl'])

interface Label {
  val: string
}

interface Author {
  did: string
  handle: string
  displayName?: string
  avatar?: string
  labels?: Label[]
  verification?: { verifiedStatus?: string }
}

interface PostView {
  uri: string
  author: Author
  record: { text?: string; createdAt?: string; langs?: string[] }
  embed?: {
    $type?: string
    images?: { thumb?: string; fullsize?: string; alt?: string; aspectRatio?: { width: number; height: number } }[]
    media?: { images?: { thumb?: string; fullsize?: string; alt?: string }[] }
    external?: { uri?: string; title?: string; thumb?: string }
  }
  likeCount?: number
  repostCount?: number
  labels?: Label[]
}

/** The post's address on bsky.app, from its at:// address. */
export function postUrl(uri: string, handle: string): string | null {
  const m = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([\w-]+)$/.exec(uri)
  return m ? `https://bsky.app/profile/${handle}/post/${m[1]}` : null
}

function shown(p: PostView): boolean {
  const labels = [...(p.labels ?? []), ...(p.author.labels ?? [])].map((l) => l.val)
  if (labels.includes('!no-unauthenticated')) return false
  return !labels.some((l) => UNSAFE_LABELS.has(l))
}

export function candidateOf(p: PostView, size: { width: number; height: number }): Candidate | null {
  const text = str(p.record.text)
  const url = postUrl(p.uri, p.author.handle)
  if (!text || !url || !shown(p)) return null
  const images = p.embed?.images ?? p.embed?.media?.images ?? []
  const image = images[0]
  const name = str(p.author.displayName) ?? p.author.handle
  return {
    id: p.uri,
    source: 'bluesky',
    kind: 'post',
    title: text.length > 90 ? `${text.slice(0, 89).trimEnd()}…` : text,
    author: `${name} (@${p.author.handle})`,
    authorUrl: `https://bsky.app/profile/${p.author.handle}`,
    pageUrl: url,
    mediaUrl: null,
    previewUrl: image?.thumb ?? p.author.avatar ?? null,
    width: size.width,
    height: size.height,
    durationSec: null,
    bytes: null,
    license: BLUESKY_LICENSE,
    tags: (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1)),
    extra: {
      handle: p.author.handle,
      did: p.author.did,
      displayName: name,
      text,
      avatar: p.author.avatar ?? null,
      image: image?.fullsize ?? null,
      imageAlt: image?.alt ?? null,
      createdAt: p.record.createdAt ?? null,
      likes: num(p.likeCount),
      reposts: num(p.repostCount),
      verified: p.author.verification?.verifiedStatus === 'valid'
    }
  }
}

export interface BlueskyDeps extends SourceDeps {
  /** The bundled fonts, for the card. */
  fontsDir: string | null
  /** The post's page as it shows logged out (main/page-capture), when the app can open one. */
  capture?: (url: string) => Promise<{ png: Buffer; width: number; height: number; title: string; url: string }>
  /** How the post becomes a picture. */
  render?: 'card' | 'page'
}

export function blueskySource(deps: BlueskyDeps): BrollSource {
  const get = async <T>(method: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> => {
    take(deps, 'bluesky', 'Bluesky')
    const r = await deps.http.json<T>(`${API}/${method}?${new URLSearchParams(params)}`, { signal })
    return r.value
  }
  /** Accounts to read when posts cannot be searched: preferred ones, the makers', then any that match the words. */
  const accounts = async (query: string, opts: { makers?: string[]; prefer: string[]; signal?: AbortSignal }): Promise<string[]> => {
    const out: string[] = []
    for (const s of readSources(opts.prefer).sources) {
      const h = s.kind === 'site' ? blueskyHandle(s.said) : null
      if (h && !out.includes(h)) out.push(h)
    }
    const look = async (q: string, n: number): Promise<void> => {
      const r = await get<{ actors?: Author[] }>('app.bsky.actor.searchActors', { q, limit: '8' }, opts.signal)
      const ranked = [...(r.actors ?? [])].sort(
        (a, b) => Number(b.verification?.verifiedStatus === 'valid') - Number(a.verification?.verifiedStatus === 'valid')
      )
      for (const a of ranked.slice(0, n)) if (!out.includes(a.handle)) out.push(a.handle)
    }
    for (const m of opts.makers ?? []) await look(m, 1)
    if (out.length === 0) await look(query, 3)
    return out.slice(0, 4)
  }

  return {
    id: 'bluesky',
    name: 'Bluesky',
    kinds: ['post'],
    async search(query, opts = {}) {
      const size = opts.orientation === 'portrait' ? { width: 1080, height: 1920 } : opts.orientation === 'square' ? { width: 1080, height: 1080 } : { width: 1920, height: 1080 }
      const count = Math.min(25, opts.count ?? 10)
      try {
        let posts: PostView[] = []
        try {
          const r = await get<{ posts?: PostView[] }>('app.bsky.feed.searchPosts', { q: query, limit: String(count), sort: 'top' }, opts.signal)
          posts = r.posts ?? []
        } catch (err) {
          // Refused without signing in: read the likeliest accounts instead.
          if (!(err instanceof HttpError && (err.status === 401 || err.status === 403))) throw err
          const want = stems(query).map((s) => ({ stem: s, weight: 1 }))
          for (const handle of await accounts(query, { makers: opts.makers, prefer: opts.brand?.prefer ?? [], signal: opts.signal })) {
            const feed = await get<{ feed?: { post: PostView }[] }>(
              'app.bsky.feed.getAuthorFeed',
              { actor: handle, limit: '50', filter: 'posts_no_replies' },
              opts.signal
            )
            posts.push(...(feed.feed ?? []).map((f) => f.post).filter((p) => overlap(want, stems(p.record.text ?? '')) > 0))
          }
        }
        return posts.map((p) => candidateOf(p, size)).filter((c): c is Candidate => !!c).slice(0, count)
      } catch (err) {
        throw failure('Bluesky', err)
      }
    },
    async fetch(c, dir, opts = {}) {
      if (!c.pageUrl) throw new Error('That post has no address.')
      const size = opts.output ?? { width: c.width ?? 1920, height: c.height ?? 1080 }
      let png: Buffer
      if (deps.render === 'page' && deps.capture) png = (await deps.capture(c.pageUrl)).png
      else {
        const picture = async (url: unknown): Promise<Buffer | null> => {
          if (typeof url !== 'string') return null
          try {
            return (await deps.http.bytes(url, { accept: IMAGE_TYPES, maxBytes: 20 * 1024 * 1024, signal: opts.signal, hosts: (h) => h === 'cdn.bsky.app' })).value
          } catch {
            return null
          }
        }
        const [avatar, image] = await Promise.all([picture(c.extra?.avatar), picture(c.extra?.image)])
        png = await drawPostCard(
          {
            displayName: String(c.extra?.displayName ?? c.author ?? ''),
            handle: String(c.extra?.handle ?? ''),
            text: String(c.extra?.text ?? c.title),
            avatar,
            image,
            createdAt: typeof c.extra?.createdAt === 'string' ? c.extra.createdAt : null,
            likes: typeof c.extra?.likes === 'number' ? c.extra.likes : null,
            reposts: typeof c.extra?.reposts === 'number' ? c.extra.reposts : null
          },
          size,
          deps.fontsDir
        )
      }
      const path = await fileIn(dir, `post-${String(c.extra?.handle ?? 'bluesky')}`, 'png')
      await fs.writeFile(path, png)
      return normalized(path, c, null, deps.ffmpeg)
    }
  }
}
