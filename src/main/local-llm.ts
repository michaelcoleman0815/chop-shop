import type { RawClip } from './clip-shape'

/**
 * Clip selection on a model running on this machine.
 *
 * Transcription and rendering are already local; choosing the clips was the
 * last step that left. This closes it for anyone who would rather not hand a
 * transcript to anybody, or who has no API key.
 *
 * It is not presented as equal to Claude, because measured on this material it
 * is not: a 3B model given the same system prompt and a five line transcript
 * picked the bake-sale announcement over a healing testimony, which is the
 * exact failure the prompt spends a paragraph forbidding. Bigger local models
 * do better. The app says which one produced a set of clips rather than
 * leaving the difference to be discovered in the output.
 */

const SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSec: { type: 'number' },
          endSec: { type: 'number' },
          title: { type: 'string' },
          hook: { type: 'string' },
          reason: { type: 'string' },
          score: { type: 'number' }
        },
        required: ['startSec', 'endSec', 'title', 'hook', 'reason', 'score']
      }
    }
  },
  required: ['clips']
}

export interface LocalModel {
  name: string
  /** Its size on disk, where the server says; 0 where it does not (a /v1 server). */
  sizeBytes: number
}

/**
 * Where a local AI server is usually found when no address is set: Ollama's
 * own, then LM Studio's. Both are looked for, in that order.
 */
export const LOCAL_SERVERS = ['http://127.0.0.1:11434', 'http://127.0.0.1:1234'] as const

/**
 * How a server is spoken to: Ollama's own API, or the /v1 chat API that LM
 * Studio, llama.cpp's server, Jan and others share. A host not yet looked at
 * is taken for Ollama, as every host was before the others were supported.
 */
export type LocalKind = 'ollama' | 'v1'

const kinds = new Map<string, LocalKind>()

export function kindOf(host: string): LocalKind {
  return kinds.get(host) ?? 'ollama'
}

/** An address as typed ("localhost:1234", "http://box.local:11434/v1/") as a host to call, or null. */
export function localAddress(typed: string): string | null {
  let s = typed.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`
  try {
    const u = new URL(s)
    const path = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')
    return `${u.protocol}//${u.host}${path}`
  } catch {
    return null
  }
}

/** Which API a server answers, remembered for the calls that follow, or null when nothing answers there. */
export async function probeServer(host: string, fetchImpl: typeof fetch = fetch): Promise<LocalKind | null> {
  const get = async (path: string): Promise<Response | null> => {
    try {
      const res = await fetchImpl(`${host}${path}`, { signal: AbortSignal.timeout(2500) })
      return res.ok ? res : null
    } catch {
      return null
    }
  }
  if (await get('/api/version')) {
    kinds.set(host, 'ollama')
    return 'ollama'
  }
  const listed = await get('/v1/models')
  const json = listed ? ((await listed.json().catch(() => null)) as { data?: unknown } | null) : null
  if (json && Array.isArray(json.data)) {
    kinds.set(host, 'v1')
    return 'v1'
  }
  return null
}

/**
 * The local AI server to use: the one at the address set in Settings, or,
 * with none set, the first of Ollama and LM Studio that is running.
 */
export async function findServer(
  address: string | null | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<{ host: string; kind: LocalKind } | null> {
  const typed = address ? localAddress(address) : null
  for (const host of typed ? [typed] : LOCAL_SERVERS) {
    const kind = await probeServer(host, fetchImpl)
    if (kind) return { host, kind }
  }
  return null
}

/** Models a /v1 server lists that only turn text into numbers, and cannot answer. */
const EMBEDDING = /embed/i

export async function localModels(host: string, fetchImpl: typeof fetch = fetch): Promise<LocalModel[]> {
  if (kindOf(host) === 'v1') {
    const res = await fetchImpl(`${host}/v1/models`, { signal: AbortSignal.timeout(4000) })
    if (!res.ok) throw new Error(`The local server answered ${res.status}.`)
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).filter((m) => !EMBEDDING.test(m.id)).map((m) => ({ name: m.id, sizeBytes: 0 }))
  }
  const res = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`Ollama answered ${res.status}.`)
  const json = (await res.json()) as { models?: { name: string; size: number }[] }
  return (json.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size }))
}

export async function isLocalUp(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${host}${kindOf(host) === 'v1' ? '/v1/models' : '/api/version'}`, {
      signal: AbortSignal.timeout(2500)
    })
    return res.ok
  } catch {
    return false
  }
}

/** What one chat turn asks of a local model: its instructions, the ask, and any pictures (base64 JPEG). */
export interface LocalTurn {
  system: string
  user: string
  images?: string[]
}

/**
 * One chat turn on a local model, held to a JSON schema, and the text it
 * answers with. Ollama gets its own API, as it always has; any other server
 * gets the /v1 chat API with the schema as its response format.
 */
export async function localChat(
  host: string,
  model: string,
  turn: LocalTurn,
  format: object,
  opts: { numCtx: number; timeoutMs: number; fetchImpl?: typeof fetch }
): Promise<string> {
  const call = opts.fetchImpl ?? fetch
  const v1 = kindOf(host) === 'v1'
  const images = turn.images ?? []
  const body = v1
    ? {
        model,
        stream: false,
        temperature: 0,
        messages: [
          { role: 'system', content: turn.system },
          {
            role: 'user',
            content: images.length
              ? [
                  { type: 'text', text: turn.user },
                  ...images.map((b64) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
                ]
              : turn.user
          }
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: format } }
      }
    : {
        model,
        stream: false,
        // Ollama defaults to a 4k window sized from VRAM, which silently drops
        // the front of a long transcript. A sermon is far past that.
        options: { num_ctx: opts.numCtx, temperature: 0 },
        format,
        messages: [
          { role: 'system', content: turn.system },
          { role: 'user', content: turn.user, ...(images.length ? { images } : {}) }
        ]
      }
  const res = await call(`${host}${v1 ? '/v1/chat/completions' : '/api/chat'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs)
  })

  if (!res.ok) {
    if (v1)
      throw new Error(
        res.status === 404 ? `${model} is not loaded on the local server.` : `The local server answered ${res.status}.`
      )
    throw new Error(
      res.status === 404 ? `${model} is not pulled. Run: ollama pull ${model}` : `Ollama answered ${res.status}.`
    )
  }

  const json = (await res.json()) as {
    message?: { content?: string }
    choices?: { message?: { content?: string } }[]
  }
  const text = (v1 ? json.choices?.[0]?.message?.content : json.message?.content)?.trim() ?? ''
  // Some models fence their JSON however they are asked: the fence is not the answer.
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
}

/**
 * One chat turn on a model on this machine, held to a JSON schema, and the
 * JSON it answers with. Shared by the clip finder and the edit planner.
 */
export async function chatLocally(
  host: string,
  model: string,
  system: string,
  user: string,
  format: object
): Promise<unknown> {
  // A long transcript on a local model is minutes, not seconds.
  const text = await localChat(host, model, { system, user }, format, { numCtx: 32768, timeoutMs: 15 * 60 * 1000 })
  if (!text) throw new Error('The local model returned nothing.')

  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('The local model returned something that was not JSON.')
  }
}

export async function selectLocally(host: string, model: string, system: string, user: string): Promise<RawClip[]> {
  const parsed = (await chatLocally(host, model, system, user, SCHEMA)) as { clips?: RawClip[] } | null
  if (!Array.isArray(parsed?.clips)) throw new Error('The local model returned no clips.')
  return parsed.clips
}
