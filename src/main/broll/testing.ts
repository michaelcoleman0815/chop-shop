import { readFileSync } from 'fs'
import type { FetchLike } from './http'

/**
 * For tests only: a fetch that answers from recorded fixtures by address,
 * and notes every request it gets (address, method, headers), so a test can
 * check what was asked, with what key, under what name.
 */

export interface Seen {
  url: string
  method: string
  headers: Record<string, string>
}

export type Route = [RegExp | string, (url: string, init: RequestInit) => Response | Promise<Response>]

export function json(value: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers }
  })
}

export function text(value: string, type = 'text/plain', status = 200): Response {
  return new Response(value, { status, headers: { 'content-type': type } })
}

export function file(path: string, type: string): Response {
  const bytes = readFileSync(path)
  return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length) } })
}

export function fakeFetch(routes: Route[]): FetchLike & { seen: Seen[] } {
  const seen: Seen[] = []
  const fn = (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v
    seen.push({ url, method: init.method ?? 'GET', headers })
    for (const [match, answer] of routes) {
      if (typeof match === 'string' ? url.startsWith(match) : match.test(url)) return answer(url, init)
    }
    return text(`No fixture for ${url}`, 'text/plain', 404)
  }) as FetchLike & { seen: Seen[] }
  fn.seen = seen
  return fn
}
