import { z } from 'zod'
import { PRICES } from '../../shared/make/prices'
import { ServiceError, type Gate } from './gate'

/**
 * Reading a narration aloud with ElevenLabs, on its own key. Only the script
 * is sent. (Gemini's voices are in google-make.ts.)
 *
 * ElevenLabs answers with the time of every character it spoke, which gives
 * the edit its word timings straight from the voice.
 *
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 * https://elevenlabs.io/docs/api-reference/voices/search
 */

export const ELEVENLABS_MODEL = PRICES.voices.elevenlabs.model

const TTS_TIMEOUT_MS = 4 * 60_000

/** A word and when it was said, in seconds from the start of the stretch it is in. */
export interface TimedWord {
  text: string
  startSec: number
  endSec: number
}

// ---------- ElevenLabs ----------

export function elevenBody(
  text: string,
  around: { previous?: string; next?: string } = {}
): Record<string, unknown> {
  return {
    text,
    model_id: ELEVENLABS_MODEL,
    ...(around.previous ? { previous_text: around.previous.slice(-1000) } : {}),
    ...(around.next ? { next_text: around.next.slice(0, 1000) } : {})
  }
}

export function elevenUrl(voiceId: string): string {
  return `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/with-timestamps?output_format=mp3_44100_128`
}

const Alignment = z.object({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number())
})
const Timestamped = z.object({ audio_base64: z.string(), alignment: Alignment.nullable().optional() })

/** Characters and their times as words: a word starts with its first letter and ends with its last. */
export function wordsFromCharacters(alignment: z.infer<typeof Alignment>): TimedWord[] {
  const { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends } = alignment
  const words: TimedWord[] = []
  let text = ''
  let start = 0
  let end = 0
  const close = (): void => {
    if (text.trim()) words.push({ text: text.trim(), startSec: start, endSec: Math.max(start, end) })
    text = ''
  }
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (/\s/.test(c)) {
      close()
      continue
    }
    if (!text) start = starts[i] ?? end
    text += c
    end = ends[i] ?? end
  }
  close()
  return words
}

export async function elevenSpeech(
  gate: Gate,
  voiceId: string,
  text: string,
  around: { previous?: string; next?: string } = {},
  signal?: AbortSignal
): Promise<{ audio: Uint8Array; words: TimedWord[] }> {
  const reply = await gate.send('elevenlabs', elevenUrl(voiceId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(elevenBody(text, around)),
    timeoutMs: TTS_TIMEOUT_MS,
    signal
  })
  const parsed = Timestamped.safeParse(reply.json())
  if (!parsed.success) throw new ServiceError('elevenlabs', 'unreadable', 'ElevenLabs sent back something I could not read.')
  return {
    audio: new Uint8Array(Buffer.from(parsed.data.audio_base64, 'base64')),
    words: parsed.data.alignment ? wordsFromCharacters(parsed.data.alignment) : []
  }
}

const Voices = z.object({ voices: z.array(z.object({ voice_id: z.string(), name: z.string() })) })

/** A voice's id by its name in the account's voice list, or null when it has none of that name. */
export async function elevenVoiceNamed(gate: Gate, name: string, signal?: AbortSignal): Promise<string | null> {
  const reply = await gate.send('elevenlabs', 'https://api.elevenlabs.io/v1/voices', { timeoutMs: 20_000, signal })
  const parsed = Voices.safeParse(reply.json())
  if (!parsed.success) return null
  const want = name.trim().toLowerCase()
  const hit =
    parsed.data.voices.find((v) => v.name.toLowerCase() === want) ??
    parsed.data.voices.find((v) => v.name.toLowerCase().split(/[\s-]+/)[0] === want)
  return hit?.voice_id ?? null
}

/** A key check that reads nothing aloud: the account's voice list. */
export async function checkElevenLabs(gate: Gate): Promise<void> {
  await gate.send('elevenlabs', 'https://api.elevenlabs.io/v1/voices', { timeoutMs: 15_000 })
}
