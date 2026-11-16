import { z } from 'zod'
import { platform } from '../platform'
import type { Transcript, TranscriptWord } from '../../shared/types'
import { ServiceError, type Gate, type Reply } from './gate'
import type { SpeechAudio } from './media'

/**
 * Transcription with AssemblyAI, keeping the fillers.
 *
 * Three steps: upload the audio, ask for a transcript of it with
 * disfluencies on, and poll until the words are ready. The transcript and
 * the uploaded audio are then deleted from AssemblyAI straight away.
 *
 * https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/files/upload
 * https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/submit
 * https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/get
 * https://www.assemblyai.com/docs/pre-recorded-audio/include-filler-words
 * https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/delete
 */

const BASE = 'https://api.assemblyai.com'

/** "local files uploaded via /v2/upload up to 2.2 GB" */
export const ASSEMBLYAI_MAX_BYTES = 2_200_000_000
/** "Duration: 160 ms to 10 hours per file." */
export const ASSEMBLYAI_MAX_SEC = 10 * 3600

/** The documented examples poll every 3 seconds; the limit is 60 polls a minute per transcript. */
const POLL_MS = 3000
const UPLOAD_TIMEOUT_MS = 20 * 60_000
const REQUEST_TIMEOUT_MS = 60_000
const CHECK_TIMEOUT_MS = 15_000

/**
 * The speech model is left to AssemblyAI's default, which keeps fillers when
 * asked: disfluencies is off by default on its current models, so it is set.
 */
export function transcriptRequest(audioUrl: string): { audio_url: string; disfluencies: true } {
  return { audio_url: audioUrl, disfluencies: true }
}

const Uploaded = z.object({ upload_url: z.string().min(1) })
const Created = z.object({ id: z.string().min(1) })
const Polled = z.object({
  id: z.string(),
  status: z.enum(['queued', 'processing', 'completed', 'error']),
  error: z.string().nullish(),
  language_code: z.string().nullish(),
  words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).nullish()
})

function read<T>(schema: z.ZodType<T>, reply: Reply): T {
  const parsed = schema.safeParse(reply.json())
  if (!parsed.success) {
    throw new ServiceError('assemblyai', 'unreadable', 'AssemblyAI sent back something I could not read.')
  }
  return parsed.data
}

/** A completed AssemblyAI transcript as the Transcript the local path produces: milliseconds become seconds. */
export function fromAssemblyAI(json: unknown): Transcript {
  const parsed = Polled.safeParse(json)
  if (!parsed.success || parsed.data.status !== 'completed' || !parsed.data.words) {
    throw new ServiceError('assemblyai', 'unreadable', 'AssemblyAI sent back something I could not read.')
  }
  const words: TranscriptWord[] = parsed.data.words
    .map((w) => ({
      text: w.text.trim(),
      startSec: Math.max(0, w.start / 1000),
      endSec: Math.max(w.start, w.end) / 1000
    }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec))
    .sort((a, b) => a.startSec - b.startSec)
  // AssemblyAI says en_us where the local path says en.
  const language = (parsed.data.language_code ?? 'en').split(/[_-]/)[0] || 'en'
  return { words, text: words.map((w) => w.text).join(' '), language }
}

export interface AssemblyOptions {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  pollMs?: number
  /** How long to wait for the words before giving up. */
  deadlineMs?: number
  onStatus?: (status: 'queued' | 'processing') => void
}

export async function transcribeAssemblyAI(
  gate: Gate,
  audio: SpeechAudio,
  opts: AssemblyOptions = {}
): Promise<Transcript> {
  if (audio.bytes > ASSEMBLYAI_MAX_BYTES) {
    throw new ServiceError(
      'assemblyai',
      'too-big',
      `The audio is ${(audio.bytes / 1e9).toFixed(1)} GB, more than the 2.2 GB AssemblyAI takes.`
    )
  }
  if (audio.durationSec > ASSEMBLYAI_MAX_SEC) {
    throw new ServiceError('assemblyai', 'too-big', 'The recording runs over 10 hours, longer than AssemblyAI takes.')
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? POLL_MS
  // Turnaround is usually a fraction of the running time; this allows half of it, and at least 15 minutes.
  const deadline = now() + (opts.deadlineMs ?? Math.max(15 * 60_000, audio.durationSec * 500))

  const uploaded = read(
    Uploaded,
    await gate.send('assemblyai', `${BASE}/v2/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: await platform().files.readBytes(audio.path),
      timeoutMs: UPLOAD_TIMEOUT_MS
    })
  )
  const created = read(
    Created,
    await gate.send('assemblyai', `${BASE}/v2/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(transcriptRequest(uploaded.upload_url)),
      timeoutMs: REQUEST_TIMEOUT_MS
    })
  )

  const url = `${BASE}/v2/transcript/${encodeURIComponent(created.id)}`
  try {
    for (;;) {
      await sleep(pollMs)
      let reply: Reply
      try {
        reply = await gate.send('assemblyai', url, { method: 'GET', timeoutMs: REQUEST_TIMEOUT_MS })
      } catch (err) {
        // Polling too fast is worth waiting out; the job itself is still running.
        if (err instanceof ServiceError && err.kind === 'busy' && now() < deadline) {
          await sleep((err.retryAfterSec ?? 10) * 1000)
          continue
        }
        throw err
      }
      const polled = read(Polled, reply)
      if (polled.status === 'completed') return fromAssemblyAI(polled)
      if (polled.status === 'error') {
        const why = (polled.error ?? 'it gave no reason').replace(/[.\s]+$/, '')
        throw new ServiceError('assemblyai', 'failed', `AssemblyAI could not transcribe it: ${why}.`)
      }
      if (now() >= deadline) throw new ServiceError('assemblyai', 'timeout', 'AssemblyAI took too long to answer.')
      opts.onStatus?.(polled.status)
    }
  } finally {
    // Deleting the transcript deletes the uploaded audio with it. It goes even
    // if the switch was turned off meanwhile: deleting the person's own data
    // is never a send, and the gate only lets this one DELETE through.
    await gate.cleanUp('assemblyai', url)
  }
}

/** A key check that costs nothing: the newest transcript, if any. */
export async function checkAssemblyAI(gate: Gate): Promise<void> {
  await gate.send('assemblyai', `${BASE}/v2/transcript?limit=1`, { method: 'GET', timeoutMs: CHECK_TIMEOUT_MS })
}
