import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import type { ClipAsk } from '../shared/clipping'
import { keyMessage, type ClaudeKeyState } from '../shared/setup'
import type { PlanQuestion } from '../shared/plan/commands'
import { claude, describeError, keyDeps, MODEL } from './planner'
import { noteKeyFailure } from './claude-key'
import { chatLocally } from './local-llm'
import { renderCommands, type CommandLine } from './planner-prompt'

/**
 * What a message asks Cutalong to make, read by Claude before any footage is
 * read: one edit, a vlog of a day's clips, many clips from a long recording,
 * words to keep until the footage comes, or a question to answer; and what a
 * link sent with it is for. The planner reads the words again once there is
 * an edit, with its transcript, and carries them out; this only says which
 * road they take, so a three-hour stream is never cut as one video and a
 * day of clips is told as a story.
 */

export const TRIAGE_SYSTEM = `You read a message a video creator sent to Cutalong, a video editor people talk to, before any of their footage is read, and say what it asks Cutalong to make. The editor reads the words again once the footage is in and carries out everything they ask; you only choose the road.

Routes:
- edit: cut one video from footage of someone talking: a YouTube video, a Short, a review, a talk, a tutorial. Most messages with footage are this, however much else they ask for.
- vlog: tell a day's clips as a story: a vlog, a day in the life, a trip, from many short clips.
- clipping: cut many short clips, each its own video, from one or more long recordings: a stream, a church service, a sermon, a podcast, an interview, when the person asks for clips, reels, shorts, TikToks or highlights from it ("turn this into clips", "make reels out of this", "clip this sermon").
- grid: play two to four videos dropped in at once, side by side in a grid with a label on each, when the person asks for a grid, a 2x2 or the videos side by side.
- wait: there is no footage yet, no edit open and nothing made in this chat, and the words ask for something to be made: say in one sentence that you will do it when the footage comes ("Drop your footage and I'll make it a Short with captions.").
- answer: a question, or talk that asks for nothing to be made: reply as one side of a conversation, in at most three sentences. Read the message in the light of the <chat> block (what was just said) and the <made> block (what this chat already holds, such as clips from a sermon), and answer what the person actually asked, from what the <commands> block says Cutalong can do. When they mention something you have no record of, such as a setting they changed or something they connected, say plainly that you cannot see it from here and ask what they hope it will change. When you cannot tell what they mean, say what you think they mean and ask. Say what to drop only when nothing is made yet and they want something made; never tell them to drop footage when the chat already holds what they are talking about.

A link in the message is one of: study (a video whose style the person likes, to cut theirs like it), material (footage to use in their edit, such as B-roll or an excerpt), page (a web page to show on screen as a screenshot), cards (videos to show on screen as YouTube shows them, a card each with its thumbnail, title and views, read from their pages without downloading them), or none when there is no link.

For clipping, "clip" says how many clips (0 lets Cutalong choose), how long each is in seconds (minSec and maxSec, 0 when not said), whether they are the funny parts, and what they are about ("" when not said). For any other route, fill it with 0, false and "".

Ask only when the road itself is unclear and the wrong one would cost the person time, such as an hour of footage cut as one video when they may want clips: put one short question in "question" with two to four options, each a complete ask in the person's words, since an option is sent as their next message. Otherwise leave its text empty and its options empty.

Write as Cutalong: first person, plain words, exact numbers, no exclamation marks, no emoji, no praise.`

export const TriageSchema = z.object({
  route: z.enum(['edit', 'vlog', 'clipping', 'grid', 'wait', 'answer']),
  /** For wait and answer: what to say. Empty otherwise. */
  reply: z.string(),
  link: z.enum(['study', 'material', 'page', 'cards', 'none']),
  clip: z.object({
    count: z.number(),
    minSec: z.number(),
    maxSec: z.number(),
    funny: z.boolean(),
    topic: z.string()
  }),
  question: z.object({ text: z.string(), options: z.array(z.string()) })
})
export type Triage = z.infer<typeof TriageSchema>

/** A dropped file as Claude is told of it: its name, its length and what it holds, never what is in it. */
export interface TriageFile {
  name: string
  durationSec: number | null
  video: boolean
  audio: boolean
}

export interface TriageInput {
  request: string
  files: TriageFile[]
  link: string | null
  hasEdit: boolean
  commands?: CommandLine[]
  /** The last few turns of the chat, oldest first, so a message reads as part of the conversation. */
  chat?: { role: 'user' | 'assistant'; text: string }[]
  /** What this chat already holds, a line each: the clips made in it, the edit open. */
  made?: string[]
}

export type TriageResult =
  | {
      ok: true
      route: Triage['route']
      reply: string
      link: Triage['link']
      clip: ClipAsk
      question: PlanQuestion | null
    }
  | { ok: false; message: string; keyState?: ClaudeKeyState }

const clock = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

const kind = (f: TriageFile): string => (f.video ? 'video' : f.audio ? 'sound only' : 'not a recording')

/** What the chat already holds, for a message about it ("make the third one shorter", "will that help?"). */
function madeBlock(made: string[]): string {
  const lines = made.map((m) => m.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12)
  return lines.length ? `<made>\n${lines.join('\n')}\n</made>` : ''
}

/** The turns just before the message, the message itself left out: the conversation it belongs to. */
function chatBlock(chat: { role: 'user' | 'assistant'; text: string }[], request: string): string {
  const turns = chat
    .filter((t) => t.text.trim() && t.text.trim() !== request.trim())
    .slice(-8)
    .map((t) => `${t.role === 'user' ? 'Person' : 'Cutalong'}: ${t.text.replace(/\s+/g, ' ').trim().slice(0, 400)}`)
  return turns.length ? `<chat>\n${turns.join('\n')}\n</chat>` : ''
}

/** What Claude is sent: the files as measured, the link, whether an edit is open, the commands, what the chat holds, the conversation, and the words. */
export function triageRequest(input: TriageInput): string {
  const files = input.files.length
    ? input.files
        .map((f, i) => {
          const length = f.durationSec !== null ? clock(f.durationSec) : 'length unknown'
          return `${i + 1}. ${f.name.replace(/[<>]/g, '')}: ${length}, ${kind(f)}`
        })
        .join('\n')
    : 'none'
  return [
    `<files>\n${files}\n</files>`,
    `<link>${input.link ?? 'none'}</link>`,
    `<edit>${input.hasEdit ? 'an edit is open in this chat' : 'no edit yet'}</edit>`,
    renderCommands(input.commands ?? []),
    madeBlock(input.made ?? []),
    chatBlock(input.chat ?? [], input.request),
    `<request>\n${input.request.trim()}\n</request>`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Claude's reading as the editor takes it: the clip ask filled in, a question only when there is one. */
export function readTriage(t: Triage, said: string): Extract<TriageResult, { ok: true }> {
  const options = t.question.options
    .map((o) => o.trim())
    .filter(Boolean)
    .slice(0, 4)
  const text = t.question.text.trim()
  const { count, minSec, maxSec, funny, topic } = t.clip
  return {
    ok: true,
    route: t.route,
    reply: t.reply.trim(),
    link: t.link,
    clip: {
      said,
      count: count > 0 ? Math.round(count) : null,
      // "under 30 seconds" names only the longest: the shortest is half of it, and never under 5.
      length: maxSec > 0 ? { minSec: minSec > 0 ? Math.min(minSec, maxSec) : Math.max(5, maxSec / 2), maxSec } : null,
      funny,
      topic: topic.trim() || null,
      single: false,
      profile: null
    },
    question: text && options.length ? { text, options } : null
  }
}

/**
 * A message read with no Claude to read it: an edit, with a link as one to
 * learn from. What a local model reads is taken when it answers in shape;
 * this is what is left when it does not.
 */
export function plainTriage(input: TriageInput): Extract<TriageResult, { ok: true }> {
  // Many short videos asked for in so many words, of footage long enough to give them: the clips, not one edit.
  const clipping = MANY_CLIPS.test(input.request) && (input.hasEdit || input.files.some(longEnough))
  return readTriage(
    {
      route: clipping ? 'clipping' : 'edit',
      reply: '',
      link: input.link ? 'study' : 'none',
      clip: { count: 0, minSec: 0, maxSec: 0, funny: false, topic: '' },
      question: { text: '', options: [] }
    },
    input.request.trim()
  )
}

/** Many short videos, asked for by name: clips, reels, shorts, TikToks, highlights; "clip this sermon". */
const MANY_CLIPS = /\b(clips|reels|shorts|tik ?toks|highlights|snippets)\b|\bclip (?:this|it|these|them|the)\b/i

/** A recording long enough to cut clips from (shared/clipping MIN_RECORDING_SEC), or one not yet measured. */
const longEnough = (f: TriageFile): boolean => (f.video || f.audio) && (f.durationSec === null || f.durationSec >= 120)

/** A model on this computer reads which road a message takes, held to the same shape as Claude's answer. */
export async function triageLocally(
  input: TriageInput,
  local: { host: string; model: string }
): Promise<Extract<TriageResult, { ok: true }>> {
  try {
    const raw = await chatLocally(local.host, local.model, TRIAGE_SYSTEM, triageRequest(input), z.toJSONSchema(TriageSchema))
    const t = TriageSchema.safeParse(raw)
    return t.success ? readTriage(t.data, input.request.trim()) : plainTriage(input)
  } catch {
    // Not running, or not in shape: the message is still an edit to plan, and the planner says what is wrong.
    return plainTriage(input)
  }
}

/** Asks Claude which road a message takes, or the model on this computer chosen in Claude's place. */
export async function triage(
  input: TriageInput,
  deps: {
    key: () => string | null | Promise<string | null>
    fetch?: typeof fetch
    /** The local model chosen to edit with, and where it runs; null for Claude. */
    local?: () => Promise<{ host: string; model: string } | null>
  } = { key: () => keyDeps().read() }
): Promise<TriageResult> {
  const apiKey = await deps.key()
  if (!apiKey) {
    const local = deps.local ? await deps.local() : null
    if (local) return triageLocally(input, local)
    return { ok: false, message: keyMessage('none'), keyState: 'none' }
  }
  // Over the platform's network, or a fetch a test stands in.
  const client = claude(apiKey, deps.fetch ? { fetch: deps.fetch } : {})
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: TRIAGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: triageRequest(input) }],
      output_config: { effort: 'low', format: betaZodOutputFormat(TriageSchema) }
    })
    if (response.stop_reason === 'refusal') {
      return { ok: false, message: 'Claude declined this one. Try saying it another way.' }
    }
    const t = response.parsed_output
    if (!t) return { ok: false, message: 'Claude answered in a shape I could not read. Try again.' }
    return readTriage(t, input.request.trim())
  } catch (err) {
    const keyState = noteKeyFailure(err, keyDeps())
    return { ok: false, message: describeError(err), ...(keyState ? { keyState } : {}) }
  }
}
