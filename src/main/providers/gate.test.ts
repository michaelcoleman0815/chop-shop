import { describe, expect, it, vi } from 'vitest'
import type { ServiceId } from '../../shared/services'
import { createGate, ServiceError, type Gate } from './gate'

const URLS: Record<ServiceId, string> = {
  deepgram: 'https://api.deepgram.com/v1/projects',
  assemblyai: 'https://api.assemblyai.com/v2/transcript?limit=1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest'
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>

function setup(opts: { on?: boolean; keys?: Partial<Record<ServiceId, string>>; fetch?: FetchFn } = {}): {
  gate: Gate
  fetch: ReturnType<typeof vi.fn<FetchFn>>
  setOn: (on: boolean) => void
} {
  let on = opts.on ?? true
  const fetch = vi.fn<FetchFn>(opts.fetch ?? (async () => new Response('{"ok":true}', { status: 200 })))
  const gate = createGate({ on: () => on, key: (id) => opts.keys?.[id] ?? null, fetch })
  return { gate, fetch, setOn: (next) => (on = next) }
}

async function failureOf(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError)
    return err as ServiceError
  }
  throw new Error('expected the request to be refused')
}

/** A fetch that only ends when its signal aborts, like a service that never answers. */
const hanging: FetchFn = (_url, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
  })

const ALL_KEYS = { deepgram: 'dg-secret-0001', assemblyai: 'aai-secret-0002', gemini: 'AIza-secret-0003' }

describe('the gate to other AI services', () => {
  it('switch on, no keys: makes zero requests', async () => {
    const { gate, fetch } = setup({ on: true, keys: {} })
    for (const id of ['deepgram', 'assemblyai', 'gemini'] as ServiceId[]) {
      expect(gate.open(id)).toBe(false)
      const err = await failureOf(gate.send(id, URLS[id], { timeoutMs: 1000 }))
      expect(err.kind).toBe('no-key')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('switch off, with keys: makes zero requests', async () => {
    const { gate, fetch } = setup({ on: false, keys: ALL_KEYS })
    for (const id of ['deepgram', 'assemblyai', 'gemini'] as ServiceId[]) {
      expect(gate.open(id)).toBe(false)
      const err = await failureOf(gate.send(id, URLS[id], { method: 'POST', body: 'audio', timeoutMs: 1000 }))
      expect(err.kind).toBe('off')
      expect(err.message).toBe('Other AI services are off in Settings.')
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('switch on with one key: requests go only to that service', async () => {
    const { gate, fetch } = setup({ on: true, keys: { deepgram: 'dg-secret-0001' } })
    expect(gate.open('deepgram')).toBe(true)
    expect(gate.open('assemblyai')).toBe(false)
    expect(gate.open('gemini')).toBe(false)
    await gate.send('deepgram', URLS.deepgram, { timeoutMs: 1000 })
    expect((await failureOf(gate.send('assemblyai', URLS.assemblyai, { timeoutMs: 1000 }))).kind).toBe('no-key')
    expect((await failureOf(gate.send('gemini', URLS.gemini, { timeoutMs: 1000 }))).kind).toBe('no-key')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(new URL(fetch.mock.calls[0][0]).hostname).toBe('api.deepgram.com')
    // A redirect could carry the key to another host, so none is followed.
    expect(fetch.mock.calls[0][1].redirect).toBe('error')
  })

  it('reads the switch again for every request', async () => {
    const { gate, fetch, setOn } = setup({ keys: ALL_KEYS })
    await gate.send('gemini', URLS.gemini, { timeoutMs: 1000 })
    setOn(false)
    expect((await failureOf(gate.send('gemini', URLS.gemini, { timeoutMs: 1000 }))).kind).toBe('off')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('only ever talks to the service’s own host, over https', async () => {
    const { gate, fetch } = setup({ keys: ALL_KEYS })
    const refused = [
      gate.send('deepgram', 'https://example.com/v1/listen', { timeoutMs: 1000 }),
      gate.send('deepgram', 'http://api.deepgram.com/v1/listen', { timeoutMs: 1000 }),
      gate.send('deepgram', 'https://api.deepgram.com:8443/v1/listen', { timeoutMs: 1000 }),
      gate.send('deepgram', 'https://api.deepgram.com.example.com/v1/listen', { timeoutMs: 1000 }),
      // A Gemini key is never sent to Deepgram, nor the other way round.
      gate.send('gemini', URLS.deepgram, { timeoutMs: 1000 }),
      gate.send('assemblyai', 'not a url', { timeoutMs: 1000 })
    ]
    for (const p of refused) expect((await failureOf(p)).kind).toBe('failed')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('attaches each key the way its service documents, and a caller cannot replace it', async () => {
    const { gate, fetch } = setup({ keys: ALL_KEYS })
    await gate.send('deepgram', URLS.deepgram, { headers: { authorization: 'Token other' }, timeoutMs: 1000 })
    await gate.send('assemblyai', URLS.assemblyai, { timeoutMs: 1000 })
    await gate.send('gemini', URLS.gemini, { timeoutMs: 1000 })
    const headers = fetch.mock.calls.map(([, init]) => new Headers(init.headers))
    expect(headers[0].get('authorization')).toBe('Token dg-secret-0001')
    expect(headers[1].get('authorization')).toBe('aai-secret-0002')
    expect(headers[2].get('x-goog-api-key')).toBe('AIza-secret-0003')
    expect(headers[2].get('authorization')).toBeNull()
  })

  it('names each failure in a sentence', async () => {
    const answer = (status: number, body = '{}', headers: Record<string, string> = {}): FetchFn => {
      return async () => new Response(body, { status, headers })
    }
    const kindOf = async (fetch: FetchFn, id: ServiceId = 'deepgram'): Promise<ServiceError> =>
      failureOf(setup({ keys: ALL_KEYS, fetch }).gate.send(id, URLS[id], { timeoutMs: 1000 }))

    const unauthorised = await kindOf(
      answer(401, '{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials.","request_id":"uuid"}')
    )
    expect([unauthorised.kind, unauthorised.message, unauthorised.status]).toEqual([
      'refused',
      'Deepgram did not accept the key.',
      401
    ])
    const badGoogleKey = await kindOf(
      answer(
        400,
        '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'
      ),
      'gemini'
    )
    expect([badGoogleKey.kind, badGoogleKey.message]).toEqual(['refused', 'Google Gemini did not accept the key.'])
    expect((await kindOf(answer(403))).kind).toBe('refused')
    const busy = await kindOf(answer(429, '{"error":"Too Many Requests"}', { 'Retry-After': '7' }), 'assemblyai')
    expect([busy.kind, busy.message, busy.retryAfterSec]).toEqual(['busy', 'AssemblyAI is busy right now.', 7])
    expect((await kindOf(answer(413))).kind).toBe('too-big')
    expect((await kindOf(answer(504))).kind).toBe('timeout')
    const down = await kindOf(answer(503))
    expect([down.kind, down.message]).toEqual(['failed', 'Deepgram had a problem on its side (503).'])
    expect((await kindOf(answer(402))).message).toBe('Deepgram says the account has no credit left.')
    const offline = await kindOf(async () => {
      throw new TypeError('fetch failed')
    })
    expect([offline.kind, offline.message]).toEqual(['unreachable', 'I could not reach Deepgram.'])
  })

  it('gives up on a service that does not answer in time', async () => {
    const { gate } = setup({ keys: ALL_KEYS, fetch: hanging })
    const err = await failureOf(gate.send('assemblyai', URLS.assemblyai, { timeoutMs: 40 }))
    expect([err.kind, err.message]).toEqual(['timeout', 'AssemblyAI took too long to answer.'])
  })

  it('stops a request in flight when the switch is turned off', async () => {
    const { gate } = setup({ keys: ALL_KEYS, fetch: hanging })
    const pending = failureOf(gate.send('deepgram', URLS.deepgram, { method: 'POST', body: 'x', timeoutMs: 60_000 }))
    await new Promise((r) => setTimeout(r, 10))
    gate.closeAll()
    const err = await pending
    expect([err.kind, err.message]).toEqual(['off', 'Other AI services were turned off while I waited for Deepgram.'])
  })

  it('says so when a reply is not JSON', async () => {
    const { gate } = setup({ keys: ALL_KEYS, fetch: async () => new Response('<html>gateway</html>', { status: 200 }) })
    const reply = await gate.send('gemini', URLS.gemini, { timeoutMs: 1000 })
    let err: unknown
    try {
      reply.json()
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ServiceError)
    expect((err as ServiceError).message).toBe('Google Gemini sent back something I could not read.')
  })

  it('never hands a key back, even when a service echoes it', async () => {
    const echo: FetchFn = async (_url, init) => {
      const key = new Headers(init.headers).get('authorization') ?? ''
      return new Response(`{"error":"bad key ${key}"}`, { status: 400 })
    }
    const { gate } = setup({ keys: ALL_KEYS, fetch: echo })
    const err = await failureOf(gate.send('assemblyai', URLS.assemblyai, { timeoutMs: 1000 }))
    expect(err.message).not.toContain('aai-secret-0002')
    expect(err.detail).not.toContain('aai-secret-0002')
    expect(err.detail).toContain('[key]')

    const ok = setup({
      keys: ALL_KEYS,
      fetch: async () => new Response('{"note":"dg-secret-0001"}', { status: 200 })
    })
    expect((await ok.gate.send('deepgram', URLS.deepgram, { timeoutMs: 1000 })).text).toBe('{"note":"[key]"}')
  })
})
