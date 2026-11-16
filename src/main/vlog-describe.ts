import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { promises as fs } from 'fs'
import { z } from 'zod'
import { MODEL } from './planner'
import { DescribeAnswerSchema, DESCRIBE_SYSTEM, momentLabel, type DescribeAnswer } from './vlog-prompt'
import type { Moment, MomentKind, Vlog } from '../shared/vlog/schema'

/**
 * Saying what is in each moment of a vlog, from a strip of its stills: by
 * Claude when the person has a key and lets Claude see frames from their
 * footage (Settings), else by a vision model running on this Mac through
 * Ollama, else not at all, and the measurements speak for it. Only the small
 * stills go anywhere, and only to the one that describes.
 */

export interface Described {
  lines: Map<string, string>
  kinds: Map<string, MomentKind>
  /** Frames sent, three to a moment. */
  stills: number
  /** Why some moments were not described, in a sentence, when some were not. */
  note: string | null
}

/** The stills of each moment, as one JPEG strip each, three frames to a strip. */
export type StripsOf = (m: Moment) => Promise<string | null>

/** One Claude call, as the SDK makes it: replaced in tests by recorded answers. */
export type ParseCall = (params: Record<string, unknown>) => Promise<{
  parsed_output: DescribeAnswer | null
  stop_reason: string | null
}>

/** Moments sent to Claude in one request. */
const BATCH = 8
/** Requests to Claude at once. */
const AT_ONCE = 2
/** Frames in a moment's strip. */
export const FRAMES_PER_STRIP = 3

export function claudeParse(apiKey: string): ParseCall {
  const client = new Anthropic({ apiKey })
  return async (params) => {
    const response = await client.beta.messages.parse(params as never)
    return {
      parsed_output: (response.parsed_output ?? null) as DescribeAnswer | null,
      stop_reason: response.stop_reason
    }
  }
}

/** The request for one batch of moments: a label and a strip each, then the ask. */
export async function describeRequest(
  batch: Moment[],
  vlog: Pick<Vlog, 'clips'>,
  strips: StripsOf
): Promise<{ params: Record<string, unknown>; sent: Moment[] }> {
  const content: Record<string, unknown>[] = []
  const sent: Moment[] = []
  for (const m of batch) {
    const file = await strips(m).catch(() => null)
    if (!file) continue
    const data = (await fs.readFile(file)).toString('base64')
    content.push({ type: 'text', text: momentLabel(m, vlog) })
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })
    sent.push(m)
  }
  content.push({ type: 'text', text: 'Describe each moment above, by its id.' })
  return {
    sent,
    params: {
      model: MODEL,
      max_tokens: 4000,
      // If this model declines, the API retries the request on a fallback model inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: DESCRIBE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: betaZodOutputFormat(DescribeAnswerSchema) }
    }
  }
}

/** Keeps a line Claude wrote only when it is a plain line about a moment that was sent. */
function keep(answer: DescribeAnswer | null, sent: Moment[], into: Described): void {
  const ids = new Set(sent.map((m) => m.id))
  for (const a of answer?.moments ?? []) {
    const line = a.line.replace(/\s+/g, ' ').replace(/!+/g, '.').trim()
    if (!ids.has(a.id) || !line || line.length > 160) continue
    into.lines.set(a.id, line.charAt(0).toLowerCase() + line.slice(1).replace(/\.$/, ''))
    into.kinds.set(a.id, a.kind)
  }
}

/** Claude describes the moments, a batch at a time, a couple of batches at once. */
export async function describeWithClaude(
  moments: Moment[],
  vlog: Pick<Vlog, 'clips'>,
  strips: StripsOf,
  parse: ParseCall,
  onProgress: (done: number, total: number) => void = () => undefined
): Promise<Described> {
  const out: Described = { lines: new Map(), kinds: new Map(), stills: 0, note: null }
  const batches: Moment[][] = []
  for (let i = 0; i < moments.length; i += BATCH) batches.push(moments.slice(i, i + BATCH))
  let done = 0
  let failed = 0
  let stop: string | null = null
  const queue = [...batches]
  const worker = async (): Promise<void> => {
    for (let batch = queue.shift(); batch && !stop; batch = queue.shift()) {
      try {
        const { params, sent } = await describeRequest(batch, vlog, strips)
        if (sent.length > 0) {
          out.stills += sent.length * FRAMES_PER_STRIP
          const r = await parse(params)
          if (r.stop_reason === 'refusal') failed += sent.length
          else keep(r.parsed_output, sent, out)
        }
      } catch (err) {
        failed += batch.length
        // A key that stopped working, or no connection, stops the rest: the measurements speak for them.
        if (err instanceof Anthropic.AuthenticationError) stop = 'Claude did not accept the key'
        else if (err instanceof Anthropic.APIConnectionError) stop = 'I could not reach Claude'
      }
      done += batch.length
      onProgress(Math.min(done, moments.length), moments.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, batches.length) }, worker))
  const missing = moments.length - out.lines.size
  if (stop)
    out.note = `${stop}, so ${missing === 1 ? 'one moment is' : `${missing} moments are`} described from the measurements.`
  else if (missing > 0 && failed > 0)
    out.note = `Claude could not describe ${missing === 1 ? 'one moment' : `${missing} moments`}, so the measurements describe ${missing === 1 ? 'it' : 'them'}.`
  return out
}

// ---------- On this Mac, through Ollama ----------

/** Names of models that see pictures, for an Ollama too old to say so itself. */
const VISION_NAME =
  /llava|vision|-vl\b|vl:|qwen2\.5vl|qwen2-vl|moondream|minicpm-v|gemma3|bakllava|granite3\.2-vision|mistral-small3\.[12]|llama4/i

/** A model Ollama has that can see pictures, or null. */
export async function visionModel(host: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const tags = await fetchImpl(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!tags.ok) return null
    const names = (((await tags.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name)
    for (const name of names.slice(0, 12)) {
      const show = await fetchImpl(`${host}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: name }),
        signal: AbortSignal.timeout(3000)
      }).catch(() => null)
      const info = show?.ok ? ((await show.json()) as { capabilities?: string[] }) : null
      if (info?.capabilities?.includes('vision')) return name
      if (!info?.capabilities && VISION_NAME.test(name)) return name
    }
  } catch {
    // Ollama is not running.
  }
  return null
}

const LocalLineSchema = z.object({
  line: z.string(),
  kind: z.enum(['establishing', 'action', 'talk', 'reaction', 'quiet'])
})

/** The JSON shape Ollama holds the model's answer to. */
export const LOCAL_LINE_SCHEMA = z.toJSONSchema(LocalLineSchema)

/** A model on this Mac describes the moments, one at a time. */
export async function describeWithOllama(
  moments: Moment[],
  vlog: Pick<Vlog, 'clips'>,
  strips: StripsOf,
  local: { host: string; model: string },
  onProgress: (done: number, total: number) => void = () => undefined,
  fetchImpl: typeof fetch = fetch
): Promise<Described> {
  const out: Described = { lines: new Map(), kinds: new Map(), stills: 0, note: null }
  let done = 0
  let failed = 0
  for (const m of moments) {
    try {
      const file = await strips(m)
      if (file) {
        out.stills += FRAMES_PER_STRIP
        const image = (await fs.readFile(file)).toString('base64')
        const res = await fetchImpl(`${local.host}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: local.model,
            stream: false,
            format: LOCAL_LINE_SCHEMA,
            options: { temperature: 0, num_ctx: 8192 },
            messages: [
              { role: 'system', content: DESCRIBE_SYSTEM },
              {
                role: 'user',
                content: `${momentLabel(m, vlog)}\nOne line for this moment, and its kind, as JSON: ${JSON.stringify(LOCAL_LINE_SCHEMA)}`,
                images: [image]
              }
            ]
          }),
          signal: AbortSignal.timeout(3 * 60 * 1000)
        })
        if (!res.ok) throw new Error(`Ollama answered ${res.status}`)
        const json = (await res.json()) as { message?: { content?: string } }
        const parsed = LocalLineSchema.safeParse(JSON.parse(json.message?.content ?? 'null'))
        if (parsed.success) keep({ moments: [{ id: m.id, ...parsed.data }] }, [m], out)
        else failed++
      }
    } catch {
      failed++
    }
    done++
    onProgress(done, moments.length)
  }
  const missing = moments.length - out.lines.size
  if (missing > 0 && failed > 0)
    out.note = `${local.model} could not describe ${missing === 1 ? 'one moment' : `${missing} moments`}, so the measurements describe ${missing === 1 ? 'it' : 'them'}.`
  return out
}
