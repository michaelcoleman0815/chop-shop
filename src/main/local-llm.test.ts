import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectLocally } from './local-llm'

/**
 * The classic clip finder's local model, pinned before the edit planner
 * started sharing its request code: the same request to Ollama, the same
 * answers and the same sentences when something goes wrong.
 */

const HOST = 'http://127.0.0.1:11434'

function ollama(reply: () => Response): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async () => reply())
  vi.stubGlobal('fetch', fetch)
  return fetch
}
const chat = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ model: 'm', message: { role: 'assistant', content }, done: true }), { status })

afterEach(() => vi.unstubAllGlobals())

describe('the clip finder on a local model', () => {
  it('asks Ollama for clips held to its schema, in one turn with the whole transcript in reach', async () => {
    const clips = [
      { startSec: 1, endSec: 30, title: 'The point', hook: 'Here it is', reason: 'Stands alone', score: 80 }
    ]
    const fetch = ollama(() => chat(JSON.stringify({ clips })))
    expect(await selectLocally(HOST, 'local-8b', 'SYSTEM', 'USER')).toEqual(clips)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${HOST}/api/chat`)
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('local-8b')
    expect(body.stream).toBe(false)
    expect(body.options).toEqual({ num_ctx: 32768, temperature: 0 })
    expect(body.messages).toEqual([
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'USER' }
    ])
    expect(body.format.required).toEqual(['clips'])
  })

  it('says what went wrong in the words it always has', async () => {
    ollama(() => new Response('not found', { status: 404 }))
    await expect(selectLocally(HOST, 'local-8b', 's', 'u')).rejects.toThrow(
      'local-8b is not pulled. Run: ollama pull local-8b'
    )
    ollama(() => new Response('oops', { status: 500 }))
    await expect(selectLocally(HOST, 'm', 's', 'u')).rejects.toThrow('Ollama answered 500.')
    ollama(() => chat('   '))
    await expect(selectLocally(HOST, 'm', 's', 'u')).rejects.toThrow('The local model returned nothing.')
    ollama(() => chat('clips: none'))
    await expect(selectLocally(HOST, 'm', 's', 'u')).rejects.toThrow(
      'The local model returned something that was not JSON.'
    )
    ollama(() => chat('{"moments":[]}'))
    await expect(selectLocally(HOST, 'm', 's', 'u')).rejects.toThrow('The local model returned no clips.')
  })
})
