import { describe, expect, it } from 'vitest'
import { findServer, kindOf, localAddress, localChat, localModels } from './local-llm'
import { visionModel } from './vlog-describe'

/**
 * Local AI beyond Ollama: a server that speaks the /v1 chat API (LM Studio,
 * llama.cpp's server, Jan) is found, listed and asked as Ollama is, while
 * Ollama itself is spoken to exactly as before.
 */

type Route = (url: string, init?: RequestInit) => Response | null

/** A fetch that answers the routes given and refuses the rest, as a closed port does. */
function server(routes: Record<string, Route>): typeof fetch & { calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = []
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    for (const [path, answer] of Object.entries(routes)) {
      if (url.endsWith(path)) {
        const res = answer(url, init)
        if (res) return res
      }
    }
    throw new TypeError('fetch failed')
  }) as typeof fetch & { calls: { url: string; body: unknown }[] }
  f.calls = calls
  return f
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })

describe('a local AI server', () => {
  it('reads an address as typed, with or without its scheme or /v1', () => {
    expect(localAddress('localhost:1234')).toBe('http://localhost:1234')
    expect(localAddress(' http://box.local:11434/v1/ ')).toBe('http://box.local:11434')
    expect(localAddress('https://gpu.example:8443')).toBe('https://gpu.example:8443')
    expect(localAddress('   ')).toBeNull()
  })

  it('finds Ollama first, then LM Studio, when no address is set', async () => {
    const lmStudio = server({
      '127.0.0.1:1234/v1/models': () => json({ data: [{ id: 'qwen2.5-7b-instruct' }] })
    })
    expect(await findServer(null, lmStudio)).toEqual({ host: 'http://127.0.0.1:1234', kind: 'v1' })
    expect(lmStudio.calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:11434/api/version',
      'http://127.0.0.1:11434/v1/models',
      'http://127.0.0.1:1234/api/version',
      'http://127.0.0.1:1234/v1/models'
    ])
    const ollama = server({ '11434/api/version': () => json({ version: '0.12.0' }) })
    expect(await findServer(undefined, ollama)).toEqual({ host: 'http://127.0.0.1:11434', kind: 'ollama' })
    expect(await findServer(null, server({}))).toBeNull()
  })

  it('looks only at the address set, when there is one', async () => {
    const box = server({ 'box:8080/v1/models': () => json({ data: [] }) })
    expect(await findServer('box:8080', box)).toEqual({ host: 'http://box:8080', kind: 'v1' })
    expect(box.calls.every((c) => c.url.startsWith('http://box:8080'))).toBe(true)
  })

  it('lists a /v1 server’s models without the ones that only embed', async () => {
    const host = 'http://v1-models:1234'
    await findServer(host, server({ '/v1/models': () => json({ data: [] }) }))
    expect(kindOf(host)).toBe('v1')
    const list = server({
      '/v1/models': () =>
        json({ data: [{ id: 'gemma-3-12b' }, { id: 'text-embedding-nomic-embed-text-v1.5' }, { id: 'qwen2.5-7b' }] })
    })
    expect(await localModels(host, list)).toEqual([
      { name: 'gemma-3-12b', sizeBytes: 0 },
      { name: 'qwen2.5-7b', sizeBytes: 0 }
    ])
    // A /v1 server says nothing of what a model sees: its name does.
    expect(await visionModel(host, list)).toBe('gemma-3-12b')
  })

  it('asks a /v1 server with the schema as its response format, and the pictures as image parts', async () => {
    const host = 'http://v1-chat:1234'
    await findServer(host, server({ '/v1/models': () => json({ data: [] }) }))
    const chat = server({
      '/v1/chat/completions': () =>
        json({ choices: [{ message: { role: 'assistant', content: '```json\n{"line":"a terrace","kind":"quiet"}\n```' } }] })
    })
    const schema = { type: 'object', properties: { line: { type: 'string' } }, required: ['line'] }
    const text = await localChat(
      host,
      'gemma-3-12b',
      { system: 'SYSTEM', user: 'USER', images: ['AAAA'] },
      schema,
      { numCtx: 8192, timeoutMs: 1000, fetchImpl: chat }
    )
    // The fence some models put round their JSON is not the answer.
    expect(JSON.parse(text)).toEqual({ line: 'a terrace', kind: 'quiet' })
    const body = chat.calls[0].body as Record<string, unknown>
    expect(chat.calls[0].url).toBe(`${host}/v1/chat/completions`)
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } })
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'USER' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
        ]
      }
    ])
  })

  it('says what went wrong on a /v1 server in its own words', async () => {
    const host = 'http://v1-errors:1234'
    await findServer(host, server({ '/v1/models': () => json({ data: [] }) }))
    const missing = server({ '/v1/chat/completions': () => json({ error: 'no model' }, 404) })
    await expect(
      localChat(host, 'nope', { system: 's', user: 'u' }, {}, { numCtx: 1, timeoutMs: 1000, fetchImpl: missing })
    ).rejects.toThrow('nope is not loaded on the local server.')
    const broken = server({ '/v1/chat/completions': () => json({}, 500) })
    await expect(
      localChat(host, 'm', { system: 's', user: 'u' }, {}, { numCtx: 1, timeoutMs: 1000, fetchImpl: broken })
    ).rejects.toThrow('The local server answered 500.')
  })
})
