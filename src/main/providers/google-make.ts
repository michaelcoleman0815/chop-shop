import { z } from 'zod'
import { PRICES } from '../../shared/make/prices'
import { notTaken, ServiceError, taken, type Gate } from './gate'

/**
 * Making pictures, clips and narration with Google, on the Gemini key the
 * person already added in Settings.
 *
 * Imagen and Veo are shut down on the Gemini API (Imagen on June 30, 2026,
 * Veo 3.1 Preview on October 22, 2026), so pictures come from Nano Banana 2.1
 * and clips from Gemini Omni Flash, both through the Interactions API, which
 * Google now documents as the default; the narration comes from Gemini TTS
 * through generateContent.
 *
 * https://aistudio.google.com/docs/image-generation  (Nano Banana, up to 14 reference images)
 * https://aistudio.google.com/docs/omni               (Omni Flash: 3 to 15 s, up to 6 reference images)
 * https://aistudio.google.com/docs/speech-generation  (Gemini 3.8 Flash TTS)
 * https://aistudio.google.com/docs/models             (Imagen and Veo shutdown dates)
 *
 * A picture or clip is one request that makes it and answers with it. Once
 * the request has gone, a lost answer (a timeout, a dropped connection, a
 * Stop) or an answer without the picture may still be a picture made and
 * billed, so from then on a failure is marked as a job taken (gate.ts
 * taken): the budget counts it, and it is not sent again.
 */

export const GOOGLE_IMAGE_MODEL = PRICES.images.google.model
export const GOOGLE_CLIP_MODEL = PRICES.clips.google.model
export const GOOGLE_TTS_MODEL = PRICES.voices.gemini.model

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
export const INTERACTIONS_URL = `${BASE}/interactions`
export const TTS_URL = `${BASE}/models/${GOOGLE_TTS_MODEL}:generateContent`

const IMAGE_TIMEOUT_MS = 3 * 60_000
const CLIP_TIMEOUT_MS = 8 * 60_000
const TTS_TIMEOUT_MS = 4 * 60_000

export interface Picture {
  data: Uint8Array
  mime: string
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64')

/**
 * The request for one still: the reference images first (character sheets),
 * then the prompt, asking for an image only, at the frame's shape and size.
 * Nothing is stored with Google beyond the request: store is false.
 */
export function imageBody(
  prompt: string,
  refs: Picture[],
  opts: { aspect: 'wide' | 'vertical'; size: string }
): Record<string, unknown> {
  const input =
    refs.length === 0
      ? prompt
      : [
          ...refs.map((r) => ({ type: 'image', data: b64(r.data), mime_type: r.mime })),
          { type: 'text', text: prompt }
        ]
  return {
    model: GOOGLE_IMAGE_MODEL,
    input,
    store: false,
    response_format: {
      type: 'image',
      mime_type: 'image/png',
      aspect_ratio: opts.aspect === 'vertical' ? '9:16' : '16:9',
      image_size: opts.size
    }
  }
}

/**
 * The request for one clip from its first frame: the still Google made,
 * then the picture and what moves in it, with no sound (the narration is
 * the soundtrack), at the frame's shape, 720p, for as long as asked.
 */
export function clipBody(
  prompt: string,
  first: Picture,
  opts: { aspect: 'wide' | 'vertical'; seconds: number }
): Record<string, unknown> {
  const seconds = Math.min(PRICES.clips.google.maxSec, Math.max(PRICES.clips.google.minSec, Math.round(opts.seconds)))
  return {
    model: GOOGLE_CLIP_MODEL,
    input: [
      { type: 'image', data: b64(first.data), mime_type: first.mime },
      {
        type: 'text',
        text: `${prompt} Start exactly on this frame and keep its look. No dialogue, no music, no text on screen.`
      }
    ],
    store: false,
    response_format: {
      type: 'video',
      aspect_ratio: opts.aspect === 'vertical' ? '9:16' : '16:9',
      resolution: '720p',
      duration: `${seconds}s`
    }
  }
}

const Block = z.object({
  type: z.string(),
  data: z.string().optional(),
  mime_type: z.string().optional(),
  text: z.string().optional()
})
const Interaction = z.object({
  status: z.string().optional(),
  steps: z
    .array(z.object({ type: z.string(), content: z.array(Block).optional() }))
    .optional(),
  error: z.object({ message: z.string().optional() }).optional()
})

/** The first image or video a finished interaction made, from its model output (never a thought's draft). */
export function fromInteraction(json: unknown, want: 'image' | 'video'): Picture {
  const unreadable = (): ServiceError =>
    new ServiceError('gemini', 'unreadable', 'Google Gemini sent back something I could not read.')
  const parsed = Interaction.safeParse(json)
  if (!parsed.success) throw unreadable()
  const { status, steps, error } = parsed.data
  if (status && status !== 'completed') {
    if (/block|safety|declin/i.test(`${status} ${error?.message ?? ''}`))
      throw new ServiceError('gemini', 'declined', `Google Gemini declined to make this ${want === 'image' ? 'picture' : 'clip'}.`)
    throw new ServiceError('gemini', 'failed', `Google Gemini could not make this ${want === 'image' ? 'picture' : 'clip'}.`, {
      detail: error?.message ?? status
    })
  }
  const outputs = (steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? [])
  const made = outputs.find((b) => b.type === want && b.data)
  if (!made?.data) {
    // Text instead of a picture is the model saying why not.
    if (outputs.some((b) => b.type === 'text'))
      throw new ServiceError('gemini', 'declined', `Google Gemini declined to make this ${want === 'image' ? 'picture' : 'clip'}.`, {
        detail: outputs.find((b) => b.type === 'text')?.text?.slice(0, 300)
      })
    throw unreadable()
  }
  return { data: new Uint8Array(Buffer.from(made.data, 'base64')), mime: made.mime_type ?? (want === 'image' ? 'image/png' : 'video/mp4') }
}

/** Google answers a key with no billing behind it with a quota of zero: that says what to do. */
function paidOnly(err: unknown): unknown {
  if (err instanceof ServiceError && err.kind === 'busy' && /free_tier|limit: 0|billing/i.test(err.detail ?? '')) {
    return new ServiceError(
      'gemini',
      'refused',
      'Google makes pictures and clips only on a key with billing set up. Set up billing for its project in AI Studio.',
      { status: err.status ?? undefined, detail: err.detail ?? undefined }
    )
  }
  return err
}

/** One request that makes a picture or a clip: refused or answered with an error, it is not a job; anything after it went, is. */
async function makeOne(gate: Gate, body: Record<string, unknown>, want: 'image' | 'video', timeoutMs: number, signal?: AbortSignal): Promise<Picture> {
  let reply
  try {
    reply = await gate.send('gemini', INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
      signal
    })
  } catch (err) {
    const said = paidOnly(err)
    throw notTaken(err) ? said : taken(said, 'gemini')
  }
  try {
    return fromInteraction(reply.json(), want)
  } catch (err) {
    throw taken(err, 'gemini')
  }
}

export async function googleImage(
  gate: Gate,
  prompt: string,
  refs: Picture[],
  opts: { aspect: 'wide' | 'vertical'; size: string; signal?: AbortSignal }
): Promise<Picture> {
  return makeOne(gate, imageBody(prompt, refs, opts), 'image', IMAGE_TIMEOUT_MS, opts.signal)
}

export async function googleClip(
  gate: Gate,
  prompt: string,
  first: Picture,
  opts: { aspect: 'wide' | 'vertical'; seconds: number; signal?: AbortSignal }
): Promise<Picture> {
  return makeOne(gate, clipBody(prompt, first, opts), 'video', CLIP_TIMEOUT_MS, opts.signal)
}

// ---------- Narration ----------

/** The request for one stretch of narration, read verbatim in a voice, with how to read it said apart from the words. */
export function ttsBody(text: string, voice: string, style: string): Record<string, unknown> {
  return {
    contents: [{ role: 'user', parts: [{ text, speech_metadata: { style } }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice } } }
  }
}

const Spoken = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ inlineData: z.object({ mimeType: z.string().optional(), data: z.string() }).optional() })) })
          .optional(),
        finishReason: z.string().optional()
      })
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional()
})

/** A WAV header for 16-bit mono PCM at a rate, so raw L16 audio plays and decodes. */
export function wavOf(pcm: Uint8Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]))
}

/** Gemini's spoken answer as a WAV file: as sent when it is one, or raw L16 at its stated rate wrapped in a header. */
export function fromTts(json: unknown): Uint8Array {
  const parsed = Spoken.safeParse(json)
  if (!parsed.success) throw new ServiceError('gemini', 'unreadable', 'Google Gemini sent back something I could not read.')
  if (parsed.data.promptFeedback?.blockReason)
    throw new ServiceError('gemini', 'declined', 'Google Gemini declined to read this script.')
  const part = parsed.data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part?.inlineData) throw new ServiceError('gemini', 'unreadable', 'Google Gemini sent back no sound.')
  const bytes = new Uint8Array(Buffer.from(part.inlineData.data, 'base64'))
  const mime = (part.inlineData.mimeType ?? '').toLowerCase()
  if (Buffer.from(bytes.slice(0, 4)).toString('ascii') === 'RIFF' || mime.includes('wav')) return bytes
  const rate = Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000)
  return wavOf(bytes, rate)
}

export async function googleSpeech(
  gate: Gate,
  text: string,
  voice: string,
  style: string,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const reply = await gate.send('gemini', TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ttsBody(text, voice, style)),
    timeoutMs: TTS_TIMEOUT_MS,
    signal
  })
  return fromTts(reply.json())
}
