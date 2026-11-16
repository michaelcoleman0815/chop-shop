/**
 * Where a brand's B-roll comes from: YouTube channels and websites to look
 * in first, and ones never to use, pasted as links or handles ("@veritasium",
 * "youtube.com/channel/UC…", "pexels.com"). Blocked sources never come back
 * in a search; a preferred channel is searched before anything else, and
 * results from a preferred channel or site come first.
 */

/** Entries a list holds: about what anyone pastes. */
export const MAX_SOURCES = 30
/** How long one pasted line may be: any channel or site link, with room to spare. */
export const MAX_SOURCE_LENGTH = 300

export type BrollSource =
  | {
      kind: 'channel'
      /** As pasted. */
      said: string
      /** "@handle", lower case. */
      handle?: string
      /** "UC…", as YouTube writes it. */
      id?: string
      /** A /c/ or /user/ name, or a channel's name as written. */
      name?: string
    }
  | { kind: 'site'; said: string; host: string }

const YOUTUBE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/

/** One pasted line as a source, or why it is not one. */
export function readSource(entry: string): BrollSource | { problem: string } {
  const said = entry.trim().replace(/^[<"'(]+|[>"')]+$/g, '')
  if (!said) return { problem: 'empty' }
  if (/^@[\w.-]{2,}$/.test(said)) return { kind: 'channel', said, handle: said.toLowerCase() }
  if (/^UC[\w-]{22}$/.test(said)) return { kind: 'channel', said, id: said }
  const looksLikeLink = /^[a-z]+:\/\//i.test(said) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(said)
  if (!looksLikeLink) {
    // A channel's name as written, matched against the channel a result is from.
    return /^[\p{L}\p{N}][\p{L}\p{N} &'._-]{1,59}$/u.test(said)
      ? { kind: 'channel', said, name: said }
      : { problem: `I can't read “${said}” as a channel or a website.` }
  }
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(said) ? said : `https://${said}`)
  } catch {
    return { problem: `I can't read “${said}” as a link.` }
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, '')
  if (YOUTUBE.test(host)) {
    const path = url.pathname.split('/').filter(Boolean)
    if (path[0]?.startsWith('@')) return { kind: 'channel', said, handle: decodeURIComponent(path[0]).toLowerCase() }
    if (path[0] === 'channel' && path[1]) return { kind: 'channel', said, id: path[1] }
    if ((path[0] === 'c' || path[0] === 'user') && path[1]) {
      return { kind: 'channel', said, name: decodeURIComponent(path[1]) }
    }
    if (path.length === 0) return { kind: 'site', said, host: 'youtube.com' }
    return { problem: `“${said}” is a video, not a channel. Paste the channel’s link or its @handle.` }
  }
  return { kind: 'site', said, host }
}

/** The pasted lines a list holds, read: the ones that are sources, and what could not be read. */
export function readSources(lines: string[]): { sources: BrollSource[]; problems: string[] } {
  const sources: BrollSource[] = []
  const problems: string[] = []
  for (const line of lines.slice(0, MAX_SOURCES)) {
    const r = readSource(line)
    if ('problem' in r) {
      if (r.problem !== 'empty') problems.push(r.problem)
    } else if (!sources.some((s) => sameSource(s, r))) sources.push(r)
  }
  return { sources, problems }
}

function sameSource(a: BrollSource, b: BrollSource): boolean {
  if (a.kind === 'site' || b.kind === 'site') return a.kind === 'site' && b.kind === 'site' && a.host === b.host
  return (
    (!!a.handle && a.handle === b.handle) ||
    (!!a.id && a.id === b.id) ||
    (!!a.name && a.name.toLowerCase() === b.name?.toLowerCase())
  )
}

/** A search result, with the channel it is from as far as yt-dlp says. */
export interface FoundClip {
  url: string
  title: string
  author: string | null
  durationSec: number | null
  channelId?: string | null
  channelUrl?: string | null
  /** "@handle", when yt-dlp gives it. */
  handle?: string | null
}

const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m)\./, '')
  } catch {
    return null
  }
}

/** Whether a result comes from a source. */
export function fromSource(clip: FoundClip, source: BrollSource): boolean {
  if (source.kind === 'site') {
    const host = hostOf(clip.url)
    return !!host && (host === source.host || host.endsWith(`.${source.host}`))
  }
  const channelUrl = (clip.channelUrl ?? '').toLowerCase()
  if (source.handle) {
    return clip.handle?.toLowerCase() === source.handle || channelUrl.includes(`/${source.handle}`)
  }
  if (source.id) return clip.channelId === source.id || channelUrl.includes(`/channel/${source.id.toLowerCase()}`)
  if (source.name) {
    const name = source.name.toLowerCase()
    return (
      channelUrl.includes(`/c/${name}`) ||
      channelUrl.includes(`/user/${name}`) ||
      (!!clip.author && fold(clip.author) === fold(source.name))
    )
  }
  return false
}

/** Where to search inside a preferred channel; null for one that cannot be searched (a website, a name alone). */
export function channelSearchUrl(source: BrollSource, query: string): string | null {
  if (source.kind !== 'channel') return null
  const q = `search?query=${encodeURIComponent(query)}`
  if (source.handle) return `https://www.youtube.com/${source.handle}/${q}`
  if (source.id) return `https://www.youtube.com/channel/${source.id}/${q}`
  if (source.name && /^[\w.-]+$/.test(source.name)) return `https://www.youtube.com/c/${source.name}/${q}`
  return null
}

function videoKey(url: string): string {
  const m = /[?&]v=([\w-]{6,})/.exec(url) ?? /youtu\.be\/([\w-]{6,})/.exec(url) ?? /\/shorts\/([\w-]{6,})/.exec(url)
  return m ? m[1] : url
}

/**
 * The results to offer: what the preferred channels gave first, then the
 * general search; nothing from a blocked source; each video once; results
 * from a preferred channel or site ahead of the rest.
 */
export function orderFound(
  preferredRuns: FoundClip[][],
  general: FoundClip[],
  lists: { prefer: BrollSource[]; block: BrollSource[] }
): { results: (FoundClip & { preferred: boolean })[]; blocked: number } {
  const seen = new Set<string>()
  let blocked = 0
  const out: (FoundClip & { preferred: boolean })[] = []
  for (const clip of [...preferredRuns.flat(), ...general]) {
    const key = videoKey(clip.url)
    if (seen.has(key)) continue
    seen.add(key)
    if (lists.block.some((s) => fromSource(clip, s))) {
      blocked++
      continue
    }
    out.push({ ...clip, preferred: lists.prefer.some((s) => fromSource(clip, s)) })
  }
  // Stable: preferred first, each group in the order it came.
  return { results: [...out.filter((c) => c.preferred), ...out.filter((c) => !c.preferred)], blocked }
}

/** What the brand page says a list holds: "2 channels and 1 website". */
export function describeSources(sources: BrollSource[]): string {
  const channels = sources.filter((s) => s.kind === 'channel').length
  const sites = sources.length - channels
  const parts = [
    channels ? `${channels} channel${channels === 1 ? '' : 's'}` : '',
    sites ? `${sites} website${sites === 1 ? '' : 's'}` : ''
  ].filter(Boolean)
  return parts.join(' and ') || 'nothing yet'
}
