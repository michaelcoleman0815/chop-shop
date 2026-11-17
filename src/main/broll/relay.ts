import { randomBytes } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { Range } from '../../shared/assets'
import { encodeMp4 } from './files'
import { HttpError, type Http } from './http'

/**
 * A stretch of a long video at a link, without downloading the rest.
 *
 * ffmpeg finds its way around an MP4 or a WebM by asking for byte ranges:
 * the index first, then only the part the stretch is in. Rather than let it
 * reach the internet itself, it asks a small server on this computer
 * (127.0.0.1, behind a token made for this one job), which passes each
 * range on through the HTTP helper, so the request names itself the same
 * way, keeps to the same timeouts and redirects, and stops at a byte budget
 * for the whole job. Eight seconds of a half-hour film costs a few
 * megabytes, not the film.
 */

export interface RelayStats {
  requests: number
  bytes: number
}

export async function withRelay<T>(
  http: Http,
  url: string,
  opts: { maxBytes: number; headers?: Record<string, string>; signal?: AbortSignal; hosts?: (h: string) => boolean },
  run: (local: string) => Promise<T>
): Promise<{ value: T; stats: RelayStats }> {
  const token = randomBytes(16).toString('hex')
  const stats: RelayStats = { requests: 0, bytes: 0 }
  let over = false
  // ffmpeg only says "Server returned 4XX"; the helper's own words say which site and why.
  let refused: HttpError | null = null
  const pass = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.url !== `/${token}` || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end()
      return
    }
    stats.requests++
    const headers: Record<string, string> = { ...opts.headers }
    if (typeof req.headers.range === 'string') headers.range = req.headers.range
    let upstream: Awaited<ReturnType<Http['open']>>
    try {
      upstream = await http.open(url, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        allow: [206, 416],
        signal: opts.signal,
        hosts: opts.hosts,
        timeoutMs: 30_000
      })
    } catch (err) {
      if (err instanceof HttpError) refused ??= err
      res.writeHead(err instanceof HttpError && err.status ? err.status : 502).end()
      return
    }
    const out: Record<string, string> = {}
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'])
      if (upstream.res.headers.get(h)) out[h] = upstream.res.headers.get(h) as string
    res.writeHead(upstream.res.status, out)
    if (req.method === 'HEAD' || !upstream.res.body) {
      upstream.done()
      await upstream.res.body?.cancel().catch(() => undefined)
      res.end()
      return
    }
    const reader = upstream.res.body.getReader()
    const stop = (): void => void reader.cancel().catch(() => undefined)
    req.on('close', stop)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        stats.bytes += value.byteLength
        if (stats.bytes > opts.maxBytes) {
          over = true
          stop()
          break
        }
        upstream.bump()
        if (!res.write(value)) await new Promise<void>((r) => res.once('drain', () => r()))
      }
    } catch {
      // ffmpeg closing a range it no longer needs ends the read; that is not a failure.
    } finally {
      upstream.done()
      req.off('close', stop)
      res.end()
    }
  }
  const server = createServer((req, res) => void pass(req, res))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  try {
    const value = await run(`http://127.0.0.1:${port}/${token}`)
    if (over) throw new HttpError(`Taking that stretch would download more than ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`, 'too-large', null, '')
    return { value, stats }
  } catch (err) {
    if (over) throw new HttpError(`Taking that stretch would download more than ${Math.round(opts.maxBytes / 1024 / 1024)} MB.`, 'too-large', null, '')
    throw refused ?? err
  } finally {
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

/** A stretch of a remote video as an H.264 MP4, reading only the ranges it is in. */
export async function excerptRemote(
  http: Http,
  ffmpeg: string,
  url: string,
  range: Range,
  output: string,
  opts: { maxBytes?: number; signal?: AbortSignal; hosts?: (h: string) => boolean; maxLong?: number } = {}
): Promise<RelayStats> {
  const { stats } = await withRelay(
    http,
    url,
    { maxBytes: opts.maxBytes ?? 300 * 1024 * 1024, signal: opts.signal, hosts: opts.hosts },
    (local) => encodeMp4(ffmpeg, local, output, { range, signal: opts.signal, maxLong: opts.maxLong })
  )
  return stats
}
