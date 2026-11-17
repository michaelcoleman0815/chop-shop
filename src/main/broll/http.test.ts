import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHttp, HttpError, privateHost, redact, retryAfter } from './http'

/**
 * The HTTP helper against a real server on this computer, which answers each
 * path the way a misbehaving site might: slowly, too much, the wrong type,
 * round in circles, or "too many requests".
 */

let server: Server
let base = ''
let other = ''
const hits = new Map<string, number>()
const seen: { path: string; headers: IncomingMessage['headers'] }[] = []
const dir = mkdtempSync(join(tmpdir(), 'cutalong-http-'))

function handle(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0]
  hits.set(path, (hits.get(path) ?? 0) + 1)
  seen.push({ path, headers: req.headers })
  const n = hits.get(path) ?? 0
  if (path === '/json') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  if (path === '/busy') {
    if (n === 1) return void res.writeHead(429, { 'retry-after': '1' }).end()
    return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"after":"waiting"}')
  }
  if (path === '/busy-long') return void res.writeHead(429, { 'retry-after': '3600' }).end()
  if (path === '/flaky') {
    if (n < 3) return void res.writeHead(503).end()
    return void res.writeHead(200, { 'content-type': 'text/plain' }).end('third time')
  }
  if (path === '/missing') return void res.writeHead(404).end()
  if (path === '/html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>blocked</html>')
  if (path === '/big-declared') return void res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(50 * 1024 * 1024) }).end()
  if (path === '/big-streamed') {
    res.writeHead(200, { 'content-type': 'image/jpeg' })
    const chunk = Buffer.alloc(64 * 1024, 1)
    let sent = 0
    const pump = (): void => {
      while (sent < 4 * 1024 * 1024) {
        sent += chunk.length
        if (!res.write(chunk)) return void res.once('drain', pump)
      }
      res.end()
    }
    return pump()
  }
  if (path === '/slow-body') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write('{"slow":')
    return // Never finishes.
  }
  if (path === '/loop') return void res.writeHead(302, { location: '/loop' }).end()
  if (path === '/hop') return void res.writeHead(301, { location: '/json' }).end()
  if (path === '/away') return void res.writeHead(302, { location: `${other}/json` }).end()
  if (path === '/file') return void res.writeHead(200, { 'content-type': 'image/png', 'content-length': '5' }).end('hello')
  res.writeHead(500).end()
}

beforeAll(async () => {
  server = createServer(handle)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port
  base = `http://127.0.0.1:${port}`
  // The same server by another name: another origin, for redirects that leave the first site.
  other = `http://localhost:${port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(dir, { recursive: true, force: true })
})

const waits: number[] = []
const http = createHttp({
  allowPrivate: true,
  sleep: async (ms) => {
    waits.push(ms)
  },
  random: () => 0.5
})

describe('the HTTP helper', () => {
  it('names itself Cutalong and nothing else', async () => {
    const r = await http.json<{ ok: boolean }>(`${base}/json`)
    expect(r.value.ok).toBe(true)
    expect(seen.find((s) => s.path === '/json')?.headers['user-agent']).toBe('Cutalong')
  })

  it('waits as long as Retry-After says on 429, then tries again', async () => {
    waits.length = 0
    const r = await http.json<{ after: string }>(`${base}/busy`)
    expect(r.value.after).toBe('waiting')
    expect(waits).toEqual([1000])
  })

  it('fails at once, saying when, when Retry-After asks for longer than is worth waiting', async () => {
    const err = await http.json(`${base}/busy-long`).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HttpError)
    expect(err).toMatchObject({ status: 429, retryAfterSec: 3600 })
    expect((err as Error).message).toMatch(/asked me to slow down/)
  })

  it('backs off on 5xx, longer each time', async () => {
    waits.length = 0
    const r = await http.text(`${base}/flaky`)
    expect(r.value).toBe('third time')
    expect(waits).toEqual([500, 1000])
  })

  it('does not retry a 404, and says it plainly', async () => {
    const before = hits.get('/missing') ?? 0
    await expect(http.json(`${base}/missing`)).rejects.toThrow(/has nothing at that link/)
    expect((hits.get('/missing') ?? 0) - before).toBe(1)
  })

  it('holds the answer to a content type', async () => {
    await expect(http.json(`${base}/html`)).rejects.toMatchObject({ code: 'type' })
    await expect(http.bytes(`${base}/json`, { accept: ['image/'] })).rejects.toMatchObject({ code: 'type' })
  })

  it('holds the answer to a size, declared or streamed', async () => {
    await expect(http.bytes(`${base}/big-declared`, { maxBytes: 1024 * 1024 })).rejects.toMatchObject({ code: 'too-large' })
    await expect(http.bytes(`${base}/big-streamed`, { maxBytes: 1024 * 1024, retries: 0 })).rejects.toMatchObject({ code: 'too-large' })
  })

  it('times out while the body is still coming', async () => {
    await expect(http.json(`${base}/slow-body`, { timeoutMs: 300, retries: 0 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('follows a few redirects and no more', async () => {
    expect((await http.json<{ ok: boolean }>(`${base}/hop`)).value.ok).toBe(true)
    await expect(http.json(`${base}/loop`)).rejects.toMatchObject({ code: 'redirects' })
    expect(hits.get('/loop')).toBe(6)
  })

  it('drops a key when a redirect leaves the first site', async () => {
    seen.length = 0
    await http.json(`${base}/away`, { headers: { Authorization: 'Client-ID secret-key' } })
    expect(seen[0].headers.authorization).toBe('Client-ID secret-key')
    expect(seen[1].headers.authorization).toBeUndefined()
  })

  it('keeps to the hosts a source allows, redirects included', async () => {
    await expect(http.json(`${base}/away`, { hosts: (h) => h === '127.0.0.1' })).rejects.toMatchObject({ code: 'host' })
  })

  it('writes a file aside and moves it into place only when whole', async () => {
    const path = join(dir, 'a.png')
    const r = await http.toFile(`${base}/file`, path, { accept: ['image/'] })
    expect(r.value).toBe(5)
    expect(readFileSync(path, 'utf8')).toBe('hello')
    const failed = join(dir, 'b.png')
    await expect(http.toFile(`${base}/big-streamed`, failed, { maxBytes: 1024 * 1024, retries: 0 })).rejects.toMatchObject({ code: 'too-large' })
    expect(existsSync(failed) || existsSync(`${failed}.part`)).toBe(false)
  })

  it('never reaches this computer or its network unless told it may', async () => {
    const strict = createHttp()
    await expect(strict.json(`${base}/json`)).rejects.toMatchObject({ code: 'host' })
    await expect(strict.json('file:///etc/passwd')).rejects.toMatchObject({ code: 'host' })
    await expect(strict.json('https://user:pass@example.com/')).rejects.toMatchObject({ code: 'host' })
    expect(privateHost('192.168.1.20')).toBe(true)
    expect(privateHost('10.0.0.1')).toBe(true)
    expect(privateHost('[::1]')).toBe(true)
    expect(privateHost('api.openverse.org')).toBe(false)
  })

  it('never shows a key in a link it reports', async () => {
    expect(redact('https://pixabay.com/api/?key=12345-abcdef&q=sky')).toBe('https://pixabay.com/api/?key=%E2%80%A6&q=sky')
    expect(redact('https://api.giphy.com/v1/gifs/search?api_key=SECRET&q=shrug')).not.toContain('SECRET')
    const err = (await http.json(`${base}/missing?key=SECRET`).catch((e: unknown) => e)) as HttpError
    expect(err.url).not.toContain('SECRET')
    expect(err.message).not.toContain('SECRET')
  })

  it('reads both forms of Retry-After', () => {
    expect(retryAfter('120')).toBe(120)
    expect(retryAfter(new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toUTCString(), Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(60)
    expect(retryAfter(null)).toBeNull()
  })
})
