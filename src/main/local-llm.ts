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
  sizeBytes: number
}

export async function localModels(host: string): Promise<LocalModel[]> {
  const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(4000) })
  if (!res.ok) throw new Error(`Ollama answered ${res.status}.`)
  const json = (await res.json()) as { models?: { name: string; size: number }[] }
  return (json.models ?? []).map((m) => ({ name: m.name, sizeBytes: m.size }))
}

export async function isLocalUp(host: string): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(2500) })
    return res.ok
  } catch {
    return false
  }
}

export async function selectLocally(
  host: string,
  model: string,
  system: string,
  user: string
): Promise<RawClip[]> {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      // Ollama defaults to a 4k window sized from VRAM, which silently drops
      // the front of a long transcript. A sermon is far past that.
      options: { num_ctx: 32768, temperature: 0 },
      format: SCHEMA,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    // A long transcript on a local model is minutes, not seconds.
    signal: AbortSignal.timeout(15 * 60 * 1000)
  })

  if (!res.ok) {
    throw new Error(
      res.status === 404
        ? `${model} is not pulled. Run: ollama pull ${model}`
        : `Ollama answered ${res.status}.`
    )
  }

  const json = (await res.json()) as { message?: { content?: string } }
  const text = json.message?.content?.trim()
  if (!text) throw new Error('The local model returned nothing.')

  let parsed: { clips?: RawClip[] }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('The local model returned something that was not JSON.')
  }
  if (!Array.isArray(parsed.clips)) throw new Error('The local model returned no clips.')
  return parsed.clips
}
