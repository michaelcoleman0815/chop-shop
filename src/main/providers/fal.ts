import { z } from 'zod'
import { PRICES } from '../../shared/make/prices'
import { notTaken, ServiceError, taken, transient, type Gate } from './gate'
import type { Picture } from './google-make'

/**
 * Making pictures and clips with fal.ai, on its own key.
 *
 * Every request goes through fal's queue: submit, poll the status URL it
 * hands back until the request is COMPLETED, read the result from its
 * response URL, then fetch the file from fal's media storage (a plain GET,
 * never with the key). A cancel sends the queue's own cancel request, so a
 * request still waiting is never run or billed.
 *
 * Once the queue has taken a request it runs, and fal bills it, whatever
 * happens to the answers after: so a status check, the result or the file
 * that fails on the way back is asked for again, the request is never sent
 * again, and any failure from then on is marked as a job taken (gate.ts
 * taken), which the budget counts as spent.
 *
 * https://docs.fal.ai/model-apis/model-endpoints/queue
 * https://fal.ai/models/blackforestlabs/flux-3/text-to-image/llms.txt  (FLUX 3, prompt + aspect_ratio + resolution)
 * https://fal.ai/models/blackforestlabs/flux-3/edit-image/llms.txt     (the same with image_urls: up to 10 references)
 * https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/llms.txt (Kling 3.0 Pro from a start frame)
 */

export const FAL_IMAGE_MODEL = PRICES.images.fal.model
export const FAL_EDIT_MODEL = 'blackforestlabs/flux-3/edit-image'
export const FAL_CLIP_MODEL = PRICES.clips.fal.model
export const FAL_QUEUE = 'https://queue.fal.run'

const SUBMIT_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 3 * 60_000
/** Status checks in a row that may fail on the way back before the request is given up (and cancelled). */
const POLL_MISSES = 6
/** Tries in all at reading the result, and at fetching the file. */
const FETCH_TRIES = 4

const dataUri = (p: Picture): string => `data:${p.mime};base64,${Buffer.from(p.data).toString('base64')}`

/** The input for one still: the prompt, the frame's shape and size, and any references as data URIs, in order. */
export function falImageInput(
  prompt: string,
  refs: Picture[],
  opts: { aspect: 'wide' | 'vertical'; size: string }
): { endpoint: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = {
    prompt,
    aspect_ratio: opts.aspect === 'vertical' ? '9:16' : '16:9',
    resolution: opts.size,
    output_format: 'png',
    safety_tolerance: 2
  }
  if (refs.length === 0) return { endpoint: FAL_IMAGE_MODEL, input }
  return { endpoint: FAL_EDIT_MODEL, input: { ...input, image_urls: refs.slice(0, 10).map(dataUri) } }
}

/** The input for one clip from its first frame, silent: the narration is the soundtrack. */
export function falClipInput(prompt: string, first: Picture, seconds: number): Record<string, unknown> {
  const s = Math.min(PRICES.clips.fal.maxSec, Math.max(PRICES.clips.fal.minSec, Math.round(seconds)))
  return {
    prompt: `${prompt} No dialogue, no text on screen.`,
    start_image_url: dataUri(first),
    duration: String(s),
    generate_audio: false,
    negative_prompt: 'blur, distort, low quality, text, captions, watermark',
    cfg_scale: 0.5
  }
}

const Submitted = z.object({
  request_id: z.string(),
  status_url: z.string(),
  response_url: z.string(),
  cancel_url: z.string().optional()
})
const Status = z.object({ status: z.string(), error: z.string().nullable().optional(), error_type: z.string().nullable().optional() })
const ImageResult = z.object({ images: z.array(z.object({ url: z.string(), content_type: z.string().optional() })).min(1) })
const VideoResult = z.object({ video: z.object({ url: z.string(), content_type: z.string().optional() }) })

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ServiceError('fal', 'cancelled', 'Stopped before fal.ai answered.'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new ServiceError('fal', 'cancelled', 'Stopped before fal.ai answered.'))
      },
      { once: true }
    )
  })

export interface QueueOptions {
  signal?: AbortSignal
  /** How long to wait between status checks, and in all, in milliseconds. */
  pollMs?: number
  maxMs?: number
  /** Told the queue's state: IN_QUEUE, IN_PROGRESS, COMPLETED. */
  onStatus?: (status: string) => void
}

/** One GET of a job fal has taken, asked again when it fails on the way back: never the request itself. */
async function again<T>(get: () => Promise<T>, tries: number, waitMs: number, signal?: AbortSignal): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await get()
    } catch (err) {
      if (signal?.aborted || !transient(err) || i >= tries) throw err
      await sleep(Math.min(30_000, waitMs * 2 ** (i - 1)), signal)
    }
  }
}

/** A reply's JSON, or null when it is not JSON: the schema then says it could not be read. */
function parsedOrNull(reply: { json(): unknown }): unknown {
  try {
    return reply.json()
  } catch {
    return null
  }
}

/** Runs one request through fal's queue and returns its result as JSON. */
export async function falQueue(gate: Gate, endpoint: string, input: Record<string, unknown>, opts: QueueOptions = {}): Promise<unknown> {
  let submit
  try {
    submit = await gate.send('fal', `${FAL_QUEUE}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      timeoutMs: SUBMIT_TIMEOUT_MS,
      signal: opts.signal
    })
  } catch (err) {
    // Cut off after it went, the request may be on the queue already: it counts, and is not sent again.
    throw notTaken(err) ? err : taken(err, 'fal')
  }
  const job = Submitted.safeParse(parsedOrNull(submit))
  if (!job.success) throw taken(new ServiceError('fal', 'unreadable', 'fal.ai sent back something I could not read.'), 'fal')
  const { status_url, response_url, cancel_url } = job.data
  const started = Date.now()
  const pollMs = opts.pollMs ?? 2000
  const cancel = (): void => {
    if (!cancel_url) return
    // The queue's own cancel: a request still waiting is never run. Its answer does not matter here.
    void gate.send('fal', cancel_url, { method: 'PUT', timeoutMs: 15_000 }).catch(() => undefined)
  }
  let done = false
  try {
    let misses = 0
    for (;;) {
      let state
      try {
        state = await gate.send('fal', status_url, { timeoutMs: POLL_TIMEOUT_MS, signal: opts.signal })
        misses = 0
      } catch (err) {
        // A status check lost on the way back is only asked again; the job runs on regardless.
        if (opts.signal?.aborted || !transient(err) || ++misses >= POLL_MISSES) throw err
        await sleep(Math.min(30_000, pollMs * 2 ** (misses - 1)), opts.signal)
        continue
      }
      const s = Status.safeParse(parsedOrNull(state))
      if (!s.success) throw new ServiceError('fal', 'unreadable', 'fal.ai sent back something I could not read.')
      opts.onStatus?.(s.data.status)
      if (s.data.status === 'COMPLETED') {
        done = true
        if (s.data.error) {
          const declined = /content|safety|nsfw|policy/i.test(`${s.data.error_type ?? ''} ${s.data.error}`)
          throw new ServiceError('fal', declined ? 'declined' : 'failed', declined ? 'fal.ai declined to make this.' : 'fal.ai could not make this.', {
            detail: s.data.error.slice(0, 300)
          })
        }
        break
      }
      if (Date.now() - started > (opts.maxMs ?? 10 * 60_000)) throw new ServiceError('fal', 'timeout', 'fal.ai took too long to answer.')
      await sleep(pollMs, opts.signal)
    }
    const result = await again(
      () => gate.send('fal', response_url, { timeoutMs: POLL_TIMEOUT_MS, signal: opts.signal }),
      FETCH_TRIES,
      pollMs,
      opts.signal
    )
    return result.json()
  } catch (err) {
    // Given up on, or stopped, before it was done: a request still waiting is cancelled. The job counts either way.
    if (!done) cancel()
    throw taken(err, 'fal')
  }
}

async function fetchMade(gate: Gate, url: string, mime: string | undefined, signal?: AbortSignal, waitMs = 1500): Promise<Picture> {
  // A result can come back inline, as a data URI, when the model chose to.
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url)
    if (!m) throw new ServiceError('fal', 'unreadable', 'fal.ai sent back something I could not read.')
    const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
    return { data: new Uint8Array(bytes), mime: m[1] ?? mime ?? 'application/octet-stream' }
  }
  // The job is done and billed: the file is fetched again if it fails on the way, and never made again.
  try {
    const data = await again(() => gate.download('fal', url, { timeoutMs: DOWNLOAD_TIMEOUT_MS, signal }), FETCH_TRIES, waitMs, signal)
    return { data, mime: mime ?? 'application/octet-stream' }
  } catch (err) {
    throw taken(err, 'fal')
  }
}

export async function falImage(
  gate: Gate,
  prompt: string,
  refs: Picture[],
  opts: { aspect: 'wide' | 'vertical'; size: string } & QueueOptions
): Promise<Picture> {
  const { endpoint, input } = falImageInput(prompt, refs, opts)
  const json = await falQueue(gate, endpoint, input, { ...opts, pollMs: opts.pollMs ?? 1500 })
  const parsed = ImageResult.safeParse(json)
  if (!parsed.success) throw taken(new ServiceError('fal', 'unreadable', 'fal.ai sent back no picture.'), 'fal')
  const first = parsed.data.images[0]
  return fetchMade(gate, first.url, first.content_type ?? 'image/png', opts.signal, opts.pollMs)
}

export async function falClip(
  gate: Gate,
  prompt: string,
  first: Picture,
  opts: { seconds: number } & QueueOptions
): Promise<Picture> {
  const json = await falQueue(gate, FAL_CLIP_MODEL, falClipInput(prompt, first, opts.seconds), {
    ...opts,
    pollMs: opts.pollMs ?? 5000,
    maxMs: opts.maxMs ?? 15 * 60_000
  })
  const parsed = VideoResult.safeParse(json)
  if (!parsed.success) throw taken(new ServiceError('fal', 'unreadable', 'fal.ai sent back no clip.'), 'fal')
  return fetchMade(gate, parsed.data.video.url, parsed.data.video.content_type ?? 'video/mp4', opts.signal, opts.pollMs)
}

/**
 * A key check that makes nothing: the price of the still model, from fal's
 * Platform API (https://api.fal.ai/v1/models/pricing).
 */
export async function checkFal(gate: Gate): Promise<void> {
  await gate.send('fal', `https://api.fal.ai/v1/models/pricing?endpoint_id=${encodeURIComponent(FAL_IMAGE_MODEL)}`, {
    timeoutMs: 15_000
  })
}
