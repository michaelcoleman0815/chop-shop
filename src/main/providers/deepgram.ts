import { readFile } from 'fs/promises'
import { z } from 'zod'
import type { Transcript, TranscriptWord } from '../../shared/types'
import { ServiceError, type Gate } from './gate'
import type { SpeechAudio } from './media'

/**
 * Transcription with Deepgram's pre-recorded API, keeping the fillers.
 *
 * One request: the audio goes up as the body and the words come back with
 * their times. Deepgram keeps nothing afterwards.
 *
 * https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
 * https://developers.deepgram.com/docs/filler-words
 */

const LISTEN = 'https://api.deepgram.com/v1/listen'

/**
 * Filler words only exist on Deepgram's Nova models, and leaving the model
 * out falls back to its older base model, so it is named. Fillers are off by
 * default ("uh" and "um" are stripped), so they are turned on. Punctuation
 * is on so sentences end where they were spoken; smart formatting stays off,
 * because it joins spoken numbers into one token and loses their timing.
 */
export const LISTEN_PARAMS = { model: 'nova-3', filler_words: 'true', punctuate: 'true' } as const

/** "File size: Maximum 2 GB." */
export const DEEPGRAM_MAX_BYTES = 2_000_000_000

/** Deepgram stops processing a request after 10 minutes; the upload comes on top of that. */
const LISTEN_TIMEOUT_MS = 20 * 60_000
const CHECK_TIMEOUT_MS = 15_000

export function listenUrl(): string {
  return `${LISTEN}?${new URLSearchParams(LISTEN_PARAMS)}`
}

const Word = z.object({
  word: z.string(),
  punctuated_word: z.string().optional(),
  start: z.number(),
  end: z.number()
})
const Listen = z.object({
  results: z.object({
    channels: z
      .array(
        z.object({
          alternatives: z.array(z.object({ words: z.array(Word) })).min(1),
          detected_language: z.string().optional()
        })
      )
      .min(1)
  })
})

/** Deepgram's answer as the Transcript the local path produces: seconds from the start, punctuation kept. */
export function fromDeepgram(json: unknown): Transcript {
  const parsed = Listen.safeParse(json)
  if (!parsed.success) {
    throw new ServiceError('deepgram', 'unreadable', 'Deepgram sent back something I could not read.')
  }
  const channel = parsed.data.results.channels[0]
  const words: TranscriptWord[] = channel.alternatives[0].words
    .map((w) => ({
      text: (w.punctuated_word ?? w.word).trim(),
      startSec: Math.max(0, w.start),
      endSec: Math.max(w.start, w.end)
    }))
    .filter((w) => w.text.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec))
    .sort((a, b) => a.startSec - b.startSec)
  return { words, text: words.map((w) => w.text).join(' '), language: channel.detected_language ?? 'en' }
}

export async function transcribeDeepgram(gate: Gate, audio: SpeechAudio): Promise<Transcript> {
  if (audio.bytes > DEEPGRAM_MAX_BYTES) {
    throw new ServiceError(
      'deepgram',
      'too-big',
      `The audio is ${(audio.bytes / 1e9).toFixed(1)} GB, more than the 2 GB Deepgram takes.`
    )
  }
  const reply = await gate.send('deepgram', listenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': audio.contentType },
    body: await readFile(audio.path),
    timeoutMs: LISTEN_TIMEOUT_MS
  })
  return fromDeepgram(reply.json())
}

/** A key check that costs nothing: the projects the key belongs to. */
export async function checkDeepgram(gate: Gate): Promise<void> {
  await gate.send('deepgram', 'https://api.deepgram.com/v1/projects', { method: 'GET', timeoutMs: CHECK_TIMEOUT_MS })
}
