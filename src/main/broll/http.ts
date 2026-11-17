import { createWriteStream, promises as fs } from 'fs'

/**
 * The one way B-roll sources reach the network. Every request:
 *
 * - names itself "Cutalong" and nothing else: no version, no machine, no person;
 * - gives up after a timeout, which keeps running while the body is read, so a
 *   server that sends a byte a minute cannot hold a search open;
 * - waits and tries again on 429 and on 5xx, as long as the server's own
 *   Retry-After asks for, or longer each time when it does not say;
 * - follows at most a few redirects, by hand, each to http or https on a public
 *   host, and drops any key it carried when a redirect leaves the first site;
 * - holds the answer to a size and a content type, so a page that answers a
 *   picture's link with an HTML error, or with a gigabyte, goes no further.
 *
 * Only official APIs and the files they point to are fetched through it.
 * Keys never appear in an error message: a link is shown with them hidden.
 */

export const USER_AGENT = 'Cutalong'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface RequestOptions {
  method?: 'GET' | 'HEAD' | 'POST'
  headers?: Record<string, string>
  body?: string
  /** For a whole exchange, or between chunks for a file. Default 15 seconds. */
  timeoutMs?: number
  /** Tries after the first, for 429, 5xx, timeouts and dropped connections. Default 2. */
  retries?: number
  /** The most the answer may be. Default 8 MB, which is plenty for any search. */
  maxBytes?: number
  /** Content types the answer may have, as prefixes: ['application/json'], ['image/']. */
  accept?: string[]
  /** Default 5. */
  maxRedirects?: number
  signal?: AbortSignal
  /** Hosts the request may reach, redirects included. */
  hosts?: (host: string) => boolean
  /** Statuses that are an answer rather than a failure (a 404 that means "nothing here"). */
  allow?: number[]
  /** The longest Retry-After worth waiting for, in seconds. A longer one fails at once and says when. Default 20. */
  maxWaitSec?: number
}

export type HttpErrorCode = 'status' | 'timeout' | 'too-large' | 'type' | 'redirects' | 'host' | 'network' | 'aborted'

export class HttpError extends Error {
  constructor(
    message: string,
    readonly code: HttpErrorCode,
    readonly status: number | null,
    /** The link, with any key in it hidden. */
    readonly url: string,
    /** How long the server asked to be left alone, when it said. */
    readonly retryAfterSec: number | null = null
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export interface Answer<T> {
  value: T
  status: number
  /** The content type, lower case, without parameters. */
  type: string
  /** Where it ended up, after redirects. */
  url: string
  headers: Headers
}

export interface Http {
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<Answer<T>>
  text(url: string, opts?: RequestOptions): Promise<Answer<string>>
  bytes(url: string, opts?: RequestOptions): Promise<Answer<Buffer>>
  /** Streams the answer into a file, written aside and moved into place only once it is whole. */
  toFile(url: string, path: string, opts?: RequestOptions & { onBytes?: (got: number, of: number | null) => void }): Promise<Answer<number>>
  /**
   * The answer's head and an open body, for passing a byte range on (main/broll/relay).
   * The caller reads or cancels the body; `done` ends the timeout.
   */
  open(url: string, opts?: RequestOptions): Promise<{ res: Response; url: string; done: () => void; bump: () => void }>
}

export interface HttpDeps {
  fetch?: FetchLike
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  /** Lets the tests talk to servers on this computer; nothing else should. */
  allowPrivate?: boolean
}

/** Query parameters that carry keys, hidden whenever a link is shown. */
const SECRET_PARAM = /^(key|api_key|apikey|token|access_token|client_id|client_secret|secret|sig|signature)$/i

export function redact(url: string): string {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) if (SECRET_PARAM.test(k)) u.searchParams.set(k, '…')
    u.username = ''
    u.password = ''
    return u.href
  } catch {
    return '(a link that could not be read)'
  }
}

/** Addresses on this computer or its network: never fetched for a search's sake. */
export function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:')
  return false
}

const SECRET_HEADERS = ['authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key', 'accept-version-key']

function typeOf(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
}

/** Retry-After as seconds, from either of its forms (a number, or an HTTP date). */
export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null
  const n = Number(value.trim())
  if (Number.isFinite(n)) return Math.max(0, n)
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null
}

function retryable(err: HttpError): boolean {
  if (err.code === 'network' || err.code === 'timeout') return true
  return err.code === 'status' && err.status !== null && (err.status === 429 || (err.status >= 500 && err.status !== 501))
}

/** A failure, as something a person can act on. */
function statusMessage(status: number, host: string): string {
  if (status === 401 || status === 403) return `${host} turned the request down (${status}). The key may be wrong or out of date.`
  if (status === 404 || status === 410) return `${host} has nothing at that link any more.`
  if (status === 429) return `${host} asked me to slow down. Try again in a little while.`
  if (status >= 500) return `${host} is having trouble (${status}). Try again in a little while.`
  return `${host} answered with an error (${status}).`
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new HttpError('Stopped.', 'aborted', null, ''))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', stop)
      resolve()
    }, ms)
    const stop = (): void => {
      clearTimeout(t)
      reject(new HttpError('Stopped.', 'aborted', null, ''))
    }
    signal?.addEventListener('abort', stop, { once: true })
  })

export function createHttp(deps: HttpDeps = {}): Http {
  const doFetch: FetchLike = deps.fetch ?? ((u, i) => fetch(u, i))
  const sleep = deps.sleep ?? defaultSleep
  const random = deps.random ?? Math.random

  const checkUrl = (u: URL, opts: RequestOptions): void => {
    const shown = redact(u.href)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError('Only web links can be fetched.', 'host', null, shown)
    if (u.username || u.password) throw new HttpError('Links with a name or password in them are not fetched.', 'host', null, shown)
    if (!deps.allowPrivate && privateHost(u.hostname))
      throw new HttpError('Links to this computer or its network are not fetched.', 'host', null, shown)
    if (opts.hosts && !opts.hosts(u.hostname.toLowerCase()))
      throw new HttpError(`${u.hostname} is not where this source keeps its files.`, 'host', null, shown)
  }

  /**
   * One exchange: the request, its redirects, the checks, and reading the
   * answer, all under one timer that `bump` restarts while a body streams.
   */
  async function attempt<T>(
    url: string,
    opts: RequestOptions,
    read: (res: Response, bump: () => void, signal: AbortSignal) => Promise<T>,
    keepOpen = false
  ): Promise<{ value: T; res: Response; url: string; done: () => void; bump: () => void }> {
    const timeoutMs = opts.timeoutMs ?? 15_000
    const ctrl = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const bump = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
      }, timeoutMs)
    }
    const outer = (): void => ctrl.abort()
    const done = (): void => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', outer)
    }
    if (opts.signal?.aborted) throw new HttpError('Stopped.', 'aborted', null, redact(url))
    opts.signal?.addEventListener('abort', outer, { once: true })
    bump()

    let current = new URL(url)
    const firstOrigin = current.origin
    let method = opts.method ?? 'GET'
    let body = opts.body
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v
    headers['user-agent'] = USER_AGENT
    const maxRedirects = opts.maxRedirects ?? 5
    try {
      for (let hop = 0; ; hop++) {
        checkUrl(current, opts)
        let res: Response
        try {
          res = await doFetch(current.href, { method, headers, body, redirect: 'manual', signal: ctrl.signal })
        } catch (err) {
          if (opts.signal?.aborted) throw new HttpError('Stopped.', 'aborted', null, redact(current.href))
          if (timedOut) throw new HttpError(`${current.hostname} did not answer in time.`, 'timeout', null, redact(current.href))
          throw new HttpError(
            `I could not reach ${current.hostname}.${err instanceof Error && err.message ? ` (${err.message})` : ''}`,
            'network',
            null,
            redact(current.href)
          )
        }
        if (res.status >= 300 && res.status < 400 && res.status !== 304) {
          const location = res.headers.get('location')
          await res.body?.cancel().catch(() => undefined)
          if (!location) throw new HttpError(`${current.hostname} sent me on without saying where.`, 'redirects', res.status, redact(current.href))
          if (hop >= maxRedirects)
            throw new HttpError(`${current.hostname} sent me on too many times.`, 'redirects', res.status, redact(current.href))
          const next = new URL(location, current)
          if (next.origin !== firstOrigin) for (const h of SECRET_HEADERS) delete headers[h]
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
            method = 'GET'
            body = undefined
            delete headers['content-type']
          }
          current = next
          continue
        }
        if (res.status === 0 || res.type === 'opaqueredirect')
          throw new HttpError('The answer could not be read here.', 'redirects', null, redact(current.href))
        const ok = (res.status >= 200 && res.status < 300) || (opts.allow ?? []).includes(res.status)
        if (!ok) {
          await res.body?.cancel().catch(() => undefined)
          throw new HttpError(
            statusMessage(res.status, current.hostname),
            'status',
            res.status,
            redact(current.href),
            retryAfter(res.headers.get('retry-after'))
          )
        }
        if (opts.accept && method !== 'HEAD' && res.status !== 204) {
          const type = typeOf(res)
          if (!opts.accept.some((a) => type.startsWith(a) || (a.startsWith('+') && type.endsWith(a)))) {
            await res.body?.cancel().catch(() => undefined)
            throw new HttpError(
              `${current.hostname} answered with ${type || 'something unnamed'}, not what was asked for.`,
              'type',
              res.status,
              redact(current.href)
            )
          }
        }
        const declared = Number(res.headers.get('content-length') ?? Number.NaN)
        const max = opts.maxBytes ?? 8 * 1024 * 1024
        if (Number.isFinite(declared) && declared > max) {
          await res.body?.cancel().catch(() => undefined)
          throw new HttpError(`That file is over ${Math.round(max / 1024 / 1024)} MB.`, 'too-large', res.status, redact(current.href))
        }
        try {
          const value = await read(res, bump, ctrl.signal)
          return { value, res, url: current.href, done, bump }
        } catch (err) {
          if (err instanceof HttpError) throw err
          if (opts.signal?.aborted) throw new HttpError('Stopped.', 'aborted', null, redact(current.href))
          if (timedOut) throw new HttpError(`${current.hostname} stopped sending.`, 'timeout', null, redact(current.href))
          throw new HttpError(`The answer from ${current.hostname} broke off.`, 'network', res.status, redact(current.href))
        }
      }
    } catch (err) {
      // A failed exchange is over, kept open or not: its timer and its listener go with it.
      done()
      throw err
    } finally {
      if (!keepOpen) done()
    }
  }

  async function withRetries<T>(
    url: string,
    opts: RequestOptions,
    read: (res: Response, bump: () => void, signal: AbortSignal) => Promise<T>,
    keepOpen = false
  ): Promise<{ value: T; res: Response; url: string; done: () => void; bump: () => void }> {
    const retries = opts.retries ?? 2
    const maxWait = opts.maxWaitSec ?? 20
    for (let i = 0; ; i++) {
      try {
        return await attempt(url, opts, read, keepOpen)
      } catch (err) {
        if (!(err instanceof HttpError) || !retryable(err) || i >= retries || opts.signal?.aborted) throw err
        if (err.retryAfterSec !== null && err.retryAfterSec > maxWait) throw err
        const wait = err.retryAfterSec !== null ? err.retryAfterSec * 1000 : Math.min(8000, 500 * 2 ** i) * (0.75 + random() / 2)
        await sleep(wait, opts.signal)
      }
    }
  }

  const readAll = async (res: Response, bump: () => void, max: number, url: string): Promise<Buffer> => {
    if (!res.body) return Buffer.alloc(0)
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      if (got > max) {
        await reader.cancel().catch(() => undefined)
        throw new HttpError(`That file is over ${Math.round(max / 1024 / 1024)} MB.`, 'too-large', res.status, redact(url))
      }
      chunks.push(value)
      bump()
    }
    return Buffer.concat(chunks)
  }

  const answer = <T>(r: { value: T; res: Response; url: string }): Answer<T> => ({
    value: r.value,
    status: r.res.status,
    type: typeOf(r.res),
    url: r.url,
    headers: r.res.headers
  })

  return {
    async bytes(url, opts = {}) {
      const max = opts.maxBytes ?? 8 * 1024 * 1024
      return answer(await withRetries(url, opts, (res, bump) => readAll(res, bump, max, url)))
    },
    async text(url, opts = {}) {
      const max = opts.maxBytes ?? 8 * 1024 * 1024
      const r = await withRetries(url, opts, async (res, bump) => (await readAll(res, bump, max, url)).toString('utf8'))
      return answer(r)
    },
    async json<T>(url: string, opts: RequestOptions = {}) {
      const max = opts.maxBytes ?? 8 * 1024 * 1024
      const accept = opts.accept ?? ['application/json', '+json', 'text/json', 'text/javascript', 'text/plain']
      const r = await withRetries(url, { ...opts, accept, headers: { accept: 'application/json', ...opts.headers } }, async (res, bump) => {
        const text = (await readAll(res, bump, max, url)).toString('utf8')
        try {
          return JSON.parse(text) as T
        } catch {
          throw new HttpError(`${new URL(url).hostname} answered with something that is not JSON.`, 'type', res.status, redact(url))
        }
      })
      return answer(r)
    },
    async toFile(url, path, opts = {}) {
      const max = opts.maxBytes ?? 200 * 1024 * 1024
      const part = `${path}.part`
      try {
        const r = await withRetries(url, { timeoutMs: 30_000, ...opts, maxBytes: max }, async (res, bump) => {
          const declared = Number(res.headers.get('content-length') ?? Number.NaN)
          const of = Number.isFinite(declared) ? declared : null
          const out = createWriteStream(part, { mode: 0o644 })
          const closed = new Promise<void>((resolve, reject) => {
            out.on('finish', resolve)
            out.on('error', reject)
          })
          let got = 0
          try {
            if (res.body) {
              const reader = res.body.getReader()
              for (;;) {
                const { done, value } = await reader.read()
                if (done) break
                got += value.byteLength
                if (got > max) {
                  await reader.cancel().catch(() => undefined)
                  throw new HttpError(`That file is over ${Math.round(max / 1024 / 1024)} MB.`, 'too-large', res.status, redact(url))
                }
                if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
                bump()
                opts.onBytes?.(got, of)
              }
            }
          } finally {
            out.end()
            await closed
          }
          return got
        })
        await fs.rename(part, path)
        return answer(r)
      } catch (err) {
        await fs.rm(part, { force: true }).catch(() => undefined)
        throw err
      }
    },
    async open(url, opts = {}) {
      // The body is read by the caller; the size cap is the caller's too (the relay counts what it passes on).
      const r = await withRetries(url, { ...opts, maxBytes: Number.MAX_SAFE_INTEGER }, async () => undefined, true)
      return { res: r.res, url: r.url, done: r.done, bump: r.bump }
    }
  }
}

/** A failure from the helper, or any other, as a sentence. */
export function said(err: unknown): string {
  if (err instanceof HttpError) return err.message
  return err instanceof Error ? err.message : String(err)
}
