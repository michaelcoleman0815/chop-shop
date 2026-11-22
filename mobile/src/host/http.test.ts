import type { HttpOptions, HttpResponse } from '@capacitor/core'
import { describe, expect, it } from 'vitest'
import { nativeFetch, toBase64 } from './http'

/** Capacitor's native HTTP as the adapter sees it: what it was asked, and its answer. */
function native(reply: Partial<HttpResponse> | (() => Promise<HttpResponse>)): {
  asked: HttpOptions[]
  request: (o: HttpOptions) => Promise<HttpResponse>
} {
  const asked: HttpOptions[] = []
  return {
    asked,
    request: (o) => {
      asked.push(o)
      if (typeof reply === 'function') return reply()
      return Promise.resolve({ data: '', status: 200, headers: {}, url: o.url, ...reply })
    }
  }
}

describe('requests to the other AI services, sent by the phone itself', () => {
  it('sends bytes as the same bytes, with the headers the native side looks up, and no redirects', async () => {
    const n = native({ data: { request_id: 'r1' }, headers: { 'Content-Type': 'application/json' } })
    const audio = new Uint8Array(70_000).map((_, i) => (i * 31) % 256)
    const res = await nativeFetch(n.request)('https://api.deepgram.com/v1/listen?model=nova-3', {
      method: 'POST',
      headers: new Headers({ 'content-type': 'audio/flac', authorization: 'Token abc' }),
      body: audio,
      redirect: 'error'
    })
    const [o] = n.asked
    expect(o.method).toBe('POST')
    expect(o.dataType).toBe('file')
    expect(o.headers).toEqual({ 'Content-Type': 'audio/flac', Authorization: 'Token abc' })
    expect(o.disableRedirects).toBe(true)
    expect(new Uint8Array(Buffer.from(o.data as string, 'base64'))).toEqual(audio)
    expect(o.data).toBe(Buffer.from(audio).toString('base64'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ request_id: 'r1' })
  })

  it('sends JSON as an object, and gives back text, statuses and empty replies as fetch would', async () => {
    const n = native({ data: 'too many requests', status: 429, headers: { 'retry-after': '3' } })
    const res = await nativeFetch(n.request)('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_url: 'https://cdn.assemblyai.com/upload/1', disfluencies: true })
    })
    expect(n.asked[0].data).toEqual({ audio_url: 'https://cdn.assemblyai.com/upload/1', disfluencies: true })
    expect(n.asked[0].dataType).toBeUndefined()
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('3')
    expect(await res.text()).toBe('too many requests')

    const gone = await nativeFetch(native({ status: 204, data: null }).request)(
      'https://api.assemblyai.com/v2/transcript/1',
      {
        method: 'DELETE'
      }
    )
    expect(gone.status).toBe(204)
    expect(await gone.text()).toBe('')
  })

  it('stops waiting when the request is called off, as the gate does when the switch goes off', async () => {
    const n = native(() => new Promise<HttpResponse>(() => undefined))
    const controller = new AbortController()
    const waiting = nativeFetch(n.request)('https://api.deepgram.com/v1/projects', { signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await expect(
      nativeFetch(n.request)('https://api.deepgram.com/v1/projects', { signal: controller.signal })
    ).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  it('writes base64 the way the platform reads it, for any length', () => {
    for (const length of [0, 1, 2, 3, 0x8000, 0x8001, 100_003]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 7 + 3) % 256)
      expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    }
  })
})
