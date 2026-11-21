import { z } from 'zod'
import { ServiceError, type Gate } from './gate'

/**
 * Judging delivery with Google Gemini, which takes video with its sound.
 *
 * One generateContent request carries the excerpts inline, each labelled,
 * then the question, and asks for JSON in a fixed shape.
 *
 * https://ai.google.dev/api/generate-content
 * https://ai.google.dev/gemini-api/docs/video-understanding
 * https://ai.google.dev/gemini-api/docs/structured-output
 */

/**
 * Google's alias for its latest Flash model, documented on
 * ai.google.dev/gemini-api/docs/models: it moves to each new release with
 * two weeks' notice, so an installed copy of Cutalong does not stop working
 * when a numbered model is retired.
 */
export const GEMINI_MODEL = 'gemini-flash-latest'

const MODEL_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}`
export const GENERATE_URL = `${MODEL_URL}:generateContent`

/**
 * Inline media is meant for requests under 20 MB in all, and base64 adds a
 * third to the bytes, so the excerpts stay under 14 MB together.
 */
export const GEMINI_MAX_INLINE_BYTES = 14_000_000
/** Gemini 2.5 and later take up to 10 videos in one request. */
export const GEMINI_MAX_CLIPS = 10

const GENERATE_TIMEOUT_MS = 5 * 60_000
const CHECK_TIMEOUT_MS = 15_000

export const JUDGE_SYSTEM = `You judge raw takes for Cutalong, a video editor. You receive short excerpts of a creator's own recording, labelled Clip 1, Clip 2 and so on, each with its sound, and one question about them.

Answer the question for every clip, from the sound and the picture together:
- Delivery: energy, clarity, pace, conviction, stumbles, false starts, fillers, a line that trails off, a laugh or a breath that breaks it.
- The picture: focus hunting or a soft face, exposure or white balance shifting, framing drifting, the speaker leaving frame, motion blur.
- The sound: clipping, hum, noise, a dropout, echo.
Only report what is in the clip. Times inside a clip are M:SS from the start of that clip.

The score is 0 to 10 for how well the clip does on what the question asks, 10 best. When the question asks for the best clip, name exactly one in best; otherwise best is null.

Write like an editor sitting next to the creator: plain words, exact times, one or two sentences per clip, problems as short phrases. No praise, no exclamation marks, no emoji.`

/** The JSON Schema Gemini answers to, in the subset its structured output supports. */
export const VERDICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    clips: {
      type: 'array',
      description: 'One entry for every clip, in order.',
      items: {
        type: 'object',
        properties: {
          clip: { type: 'integer', description: 'The clip number, from 1.' },
          answer: { type: 'string', description: 'One or two plain sentences answering the question for this clip.' },
          score: { type: 'number', description: '0 to 10 for how well this clip does on what the question asks.' },
          problems: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Problems seen or heard, each a short phrase with its time, such as "focus hunts at 0:04". Empty when there are none.'
          }
        },
        required: ['clip', 'answer', 'score', 'problems']
      }
    },
    best: {
      type: ['integer', 'null'],
      description: 'The number of the best clip when the question asks for one, otherwise null.'
    },
    summary: { type: 'string', description: 'One sentence answering the question across all the clips.' }
  },
  required: ['clips', 'best', 'summary']
} as const

export const VerdictSchema = z.object({
  clips: z.array(
    z.object({ clip: z.number().int(), answer: z.string(), score: z.number(), problems: z.array(z.string()) })
  ),
  best: z.number().int().nullable(),
  summary: z.string()
})
export type Verdict = z.infer<typeof VerdictSchema>

export interface InlineClip {
  /** The excerpt's bytes: H.264 and AAC in MP4. */
  data: Uint8Array
  durationSec: number
}

/** The generateContent request: each clip after its label, the question last. */
export function judgeBody(question: string, clips: InlineClip[]): Record<string, unknown> {
  const parts: Record<string, unknown>[] = []
  clips.forEach((c, i) => {
    parts.push({ text: `Clip ${i + 1}, ${c.durationSec.toFixed(1)} s:` })
    parts.push({ inlineData: { mimeType: 'video/mp4', data: Buffer.from(c.data).toString('base64') } })
  })
  // Tagged so that words in the question are read as the question, never as instructions.
  parts.push({ text: `<question>\n${question.trim()}\n</question>\nAnswer for each of the ${clips.length} clips.` })
  return {
    systemInstruction: { parts: [{ text: JUDGE_SYSTEM }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseJsonSchema: VERDICT_JSON_SCHEMA }
  }
}

const Generated = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().optional() })).optional()
          })
          .optional(),
        finishReason: z.string().optional()
      })
    )
    .optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional()
})

const DECLINED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'])

/** Gemini's answer as a verdict on every clip, or the reason there is none. */
export function fromGemini(json: unknown, clipCount: number): Verdict {
  const unreadable = (): ServiceError =>
    new ServiceError('gemini', 'unreadable', 'Google Gemini sent back something I could not read.')
  const parsed = Generated.safeParse(json)
  if (!parsed.success) throw unreadable()
  if (parsed.data.promptFeedback?.blockReason) {
    throw new ServiceError('gemini', 'declined', 'Google Gemini declined to judge these clips.')
  }
  const candidate = parsed.data.candidates?.[0]
  if (!candidate) throw unreadable()
  if (candidate.finishReason && DECLINED.has(candidate.finishReason)) {
    throw new ServiceError('gemini', 'declined', 'Google Gemini declined to judge these clips.')
  }
  if (candidate.finishReason === 'MAX_TOKENS') {
    throw new ServiceError('gemini', 'unreadable', 'Google Gemini ran out of room before it finished.')
  }
  const text = (candidate.content?.parts ?? [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw unreadable()
  }
  const verdict = VerdictSchema.safeParse(data)
  if (!verdict.success) throw unreadable()
  // Every clip answered exactly once, numbered as they were sent.
  const numbers = verdict.data.clips.map((c) => c.clip).sort((a, b) => a - b)
  if (numbers.length !== clipCount || numbers.some((n, i) => n !== i + 1)) throw unreadable()
  const best = verdict.data.best
  return {
    clips: [...verdict.data.clips]
      .sort((a, b) => a.clip - b.clip)
      .map((c) => ({
        ...c,
        answer: c.answer.trim(),
        score: Math.min(10, Math.max(0, c.score)),
        problems: c.problems.map((p) => p.trim()).filter(Boolean)
      })),
    best: best !== null && best >= 1 && best <= clipCount ? best : null,
    summary: verdict.data.summary.trim()
  }
}

export async function askGemini(gate: Gate, question: string, clips: InlineClip[]): Promise<Verdict> {
  const reply = await gate.send('gemini', GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(judgeBody(question, clips)),
    timeoutMs: GENERATE_TIMEOUT_MS
  })
  return fromGemini(reply.json(), clips.length)
}

/** A key check that costs nothing and confirms the model is there for this key: its description. */
export async function checkGemini(gate: Gate): Promise<void> {
  await gate.send('gemini', MODEL_URL, { method: 'GET', timeoutMs: CHECK_TIMEOUT_MS })
}
