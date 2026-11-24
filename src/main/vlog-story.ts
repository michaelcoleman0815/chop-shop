import { usageTicket } from './usage'
import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import { chatLocally } from './local-llm'
import { MODEL } from './planner'
import { renderShotList, renderStoryRequest, StoryAnswerSchema, STORY_SYSTEM, type StoryAnswer } from './vlog-prompt'
import { currentCut, plainIds, type EditDoc } from '../shared/edit'
import { checkStory, fitStory } from '../shared/vlog/check'
import { musicBeatsOf, optionsFor, unitsOf } from '../shared/vlog/plan'
import { sceneInSentence } from '../shared/vlog/reply'
import type { VlogAsk } from '../shared/vlog/request'
import type { Scene, Story, Vlog } from '../shared/vlog/schema'
import { resolveCut } from '../shared/edit/resolve'

/**
 * The story pass by a model: Claude by default, or the model the person
 * picked to plan edits on this Mac. It reads the shot list (what each moment
 * shows, the words said, the measurements) and answers with the story as
 * ordered beats, which are checked the way the planner's plans are, fitted
 * to the length and landed on the music's beats. When it cannot, the rules
 * tell the story instead, and the reply never depends on it.
 */

export interface ModelStory {
  story: Story
  /** Better names for the scenes, by id. */
  names: Map<string, string>
  reply: string
  summary: string
  /** Beats it proposed that did not hold, in sentences for the log. */
  rejected: string[]
}

/** One structured call, as the SDK makes it: replaced in tests by recorded answers. */
export type StoryCall = (params: Record<string, unknown>) => Promise<{
  parsed_output: StoryAnswer | null
  stop_reason: string | null
}>

export function claudeStoryCall(apiKey: string): StoryCall {
  const client = new Anthropic({ apiKey })
  return async (params) => {
    const bill = usageTicket('story')
    const response = await client.beta.messages.parse(params as never)
    bill(response.model, response.usage)
    return { parsed_output: (response.parsed_output ?? null) as StoryAnswer | null, stop_reason: response.stop_reason }
  }
}

/** The request for the story pass: instructions and shot list cached, the ask after them. */
export function storyRequest(
  doc: EditDoc,
  vlog: Vlog,
  request: string,
  targetSec: number,
  lengthAsked: boolean
): Record<string, unknown> {
  const units = unitsOf(doc, vlog)
  return {
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: STORY_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: renderShotList(doc, vlog, units), cache_control: { type: 'ephemeral' } },
          {
            type: 'text',
            text: renderStoryRequest(vlog, request, targetSec, lengthAsked, !!currentCut(doc).music?.beats?.length)
          }
        ]
      }
    ],
    output_config: { effort: 'medium', format: betaZodOutputFormat(StoryAnswerSchema) }
  }
}

/** A model's answer made into a story: checked, fitted, named. Null when nothing in it holds. */
export function storyFromAnswer(
  doc: EditDoc,
  vlog: Vlog,
  answer: StoryAnswer,
  options: { targetSec: number; lengthAsked: boolean; hook: string; weights: Record<string, number> },
  by: Story['by']
): ModelStory | null {
  const checked = checkStory(answer.beats, doc, vlog)
  if (checked.beats.length === 0) return null
  const fitted = fitStory(checked.beats, options.targetSec, doc, vlog, musicBeatsOf(currentCut(doc)))
  const names = new Map<string, string>()
  const ids = new Set(vlog.scenes.map((s) => s.id))
  for (const s of answer.scenes) {
    const name = s.name
      .replace(/[!"<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (ids.has(s.id) && name && name.length <= 40) names.set(s.id, name.charAt(0).toUpperCase() + name.slice(1))
  }
  // Ids mean nothing to the person: a scene's becomes its name, a moment's what it shows.
  const sceneName = (id: string): string => names.get(id) ?? vlog.scenes.find((x) => x.id === id)?.name ?? id
  const plain = (text: string): string =>
    plainIds(doc, text.replace(/!/g, '.').trim())
      .replace(/\bsc\d+\b/g, (id) => sceneInSentence(sceneName(id)))
      .replace(/\bm\d+\b/g, (id) => vlog.moments.find((m) => m.id === id)?.description || 'that moment')
  return {
    story: {
      targetSec: Math.round(options.targetSec),
      lengthAsked: options.lengthAsked,
      hook: options.hook,
      weights: options.weights,
      by,
      beats: fitted.beats
    },
    names,
    reply: plain(answer.reply),
    summary: plain(answer.summary),
    rejected: checked.rejected
  }
}

/** The settings a story pass works to: the length, the opening and the scenes' weights, as the rules read the ask. */
export function passOptions(doc: EditDoc, vlog: Vlog, ask: VlogAsk | null) {
  const units = unitsOf(doc, vlog)
  const now = resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
  const o = optionsFor(doc, vlog, ask, now, units)
  return {
    targetSec: o.options.targetSec,
    lengthAsked: o.lengthAsked,
    hook: o.options.hook,
    weights: o.options.weights
  }
}

/** Claude tells the story. Null when it declined or nothing it proposed holds. */
export async function storyWithClaude(
  doc: EditDoc,
  vlog: Vlog,
  request: string,
  ask: VlogAsk | null,
  call: StoryCall
): Promise<ModelStory | null> {
  const options = passOptions(doc, vlog, ask)
  const r = await call(storyRequest(doc, vlog, request, options.targetSec, options.lengthAsked))
  if (r.stop_reason === 'refusal' || !r.parsed_output) return null
  const made = storyFromAnswer(doc, vlog, r.parsed_output, options, 'claude')
  if (made?.rejected.length) console.warn('[vlog] story beats left out:', made.rejected)
  return made
}

/** The model on this Mac tells the story, held to the same shape. Null when it could not. */
export async function storyLocally(
  doc: EditDoc,
  vlog: Vlog,
  request: string,
  ask: VlogAsk | null,
  local: { host: string; model: string },
  chat: typeof chatLocally = chatLocally
): Promise<ModelStory | null> {
  const options = passOptions(doc, vlog, ask)
  const schema = z.toJSONSchema(StoryAnswerSchema)
  const units = unitsOf(doc, vlog)
  const answer = await chat(
    local.host,
    local.model,
    STORY_SYSTEM,
    [
      renderShotList(doc, vlog, units),
      renderStoryRequest(vlog, request, options.targetSec, options.lengthAsked, !!currentCut(doc).music?.beats?.length),
      `Answer with JSON in this shape:\n${JSON.stringify(schema)}`
    ].join('\n\n'),
    schema
  )
  const parsed = StoryAnswerSchema.safeParse(answer)
  if (!parsed.success) return null
  return storyFromAnswer(doc, vlog, parsed.data, options, 'local')
}

/** Scene names a model gave, put on the shoot's scenes. */
export function renamed(scenes: Scene[], names: Map<string, string>): Scene[] {
  return scenes.map((s) => (names.has(s.id) ? { ...s, name: names.get(s.id) as string } : s))
}
