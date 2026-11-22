import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nowhere' }, safeStorage: {} }))

import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MODEL } from './planner'
import {
  describeRequest,
  describeWithClaude,
  describeWithOllama,
  FRAMES_PER_STRIP,
  LOCAL_LINE_SCHEMA,
  visionModel,
  type ParseCall
} from './vlog-describe'
import { STORY_SYSTEM, type DescribeAnswer, type StoryAnswer } from './vlog-prompt'
import { storyFromAnswer, storyLocally, storyRequest, storyWithClaude, type StoryCall } from './vlog-story'
import type { EditDoc } from '../shared/edit'
import { passOptions } from './vlog-story'
import { pretendVlog } from '../shared/vlog/pretend'
import type { Moment, Vlog } from '../shared/vlog/schema'

/**
 * Claude and a model on this Mac, as a vlog uses them, with recorded answers
 * in place of the calls: what is sent (the model, the stills, the shot list,
 * the shape asked for), and what is done with what comes back (lines kept
 * only for moments sent, beats checked, ids never shown to the person).
 */

const shoot = pretendVlog(Array.from({ length: 15 }, (_, i) => `/shoot/IMG_${2000 + i}.MOV`))
const doc: EditDoc = shoot.doc
const vlog = doc.vlog as Vlog

/** A JPEG-shaped file per moment, standing in for its strip of stills. */
const dir = mkdtempSync(join(tmpdir(), 'vlog-model-'))
const strips = async (m: Moment): Promise<string> => {
  const file = join(dir, `${m.id}.jpg`)
  writeFileSync(file, Buffer.from(`jpeg of ${m.id}`))
  return file
}

afterEach(() => vi.unstubAllGlobals())

describe('describing moments with Claude', () => {
  it('sends each moment as a label and its strip of stills, to the model the planner uses', async () => {
    const { params, sent } = await describeRequest(vlog.moments.slice(0, 3), vlog, strips)
    expect(sent.map((m) => m.id)).toEqual(vlog.moments.slice(0, 3).map((m) => m.id))
    expect(params.model).toBe(MODEL)
    expect(params.output_config).toMatchObject({ effort: 'low' })
    const content = (params.messages as { content: Record<string, unknown>[] }[])[0].content
    const images = content.filter((c) => c.type === 'image')
    expect(images).toHaveLength(3)
    expect(images[0].source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: Buffer.from(`jpeg of ${vlog.moments[0].id}`).toString('base64')
    })
    expect(String(content[0].text)).toMatch(new RegExp(`^${vlog.moments[0].id}: IMG_\\d+\\.MOV, `))
  })

  it('keeps a plain line for each moment sent, and nothing for one it was not sent', async () => {
    const calls: Record<string, unknown>[] = []
    const parse: ParseCall = async (params) => {
      calls.push(params)
      const asked = ((params.messages as { content: { type: string; text?: string }[] }[])[0].content ?? [])
        .filter((c) => c.type === 'text' && /^m\d+:/.test(c.text ?? ''))
        .map((c) => (c.text as string).split(':')[0])
      const answer: DescribeAnswer = {
        moments: [
          ...asked.map((id) => ({
            id,
            line: `Walking past the market stalls, moment ${id}!`,
            kind: 'action' as const
          })),
          { id: 'm999', line: 'A moment nobody sent', kind: 'quiet' as const },
          { id: asked[0], line: 'x'.repeat(200), kind: 'quiet' as const }
        ]
      }
      return { parsed_output: answer, stop_reason: 'end_turn' }
    }
    const moments = vlog.moments.slice(0, 11)
    const progress: number[] = []
    const got = await describeWithClaude(moments, vlog, strips, parse, (done) => progress.push(done))
    // Eight to a request.
    expect(calls).toHaveLength(2)
    expect(got.stills).toBe(moments.length * FRAMES_PER_STRIP)
    expect(got.lines.size).toBe(moments.length)
    expect(got.lines.get(moments[1].id)).toBe(`walking past the market stalls, moment ${moments[1].id}`)
    expect(got.lines.has('m999')).toBe(false)
    expect(got.note).toBeNull()
    expect(progress.at(-1)).toBe(moments.length)
  })

  it('stops at a key Claude does not accept, and says the measurements describe the rest', async () => {
    let calls = 0
    const parse: ParseCall = async () => {
      calls++
      throw new Anthropic.AuthenticationError(401, { type: 'error' }, 'invalid x-api-key', new Headers())
    }
    const got = await describeWithClaude(vlog.moments.slice(0, 20), vlog, strips, parse)
    expect(calls).toBeLessThanOrEqual(2)
    expect(got.lines.size).toBe(0)
    expect(got.note).toBe('Claude did not accept the key, so 20 moments are described from the measurements.')
  })

  it('says how many it could not describe when Claude declines some', async () => {
    const parse: ParseCall = async () => ({ parsed_output: null, stop_reason: 'refusal' })
    const got = await describeWithClaude(vlog.moments.slice(0, 3), vlog, strips, parse)
    expect(got.note).toBe('Claude could not describe 3 moments, so the measurements describe them.')
  })
})

describe('describing moments on this Mac', () => {
  it('finds a model that can see pictures, by what Ollama says of it or by its name', async () => {
    const fake = (capabilities: Record<string, string[] | undefined>) =>
      (async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/tags'))
          return new Response(JSON.stringify({ models: Object.keys(capabilities).map((name) => ({ name })) }))
        const name = JSON.parse(String(init?.body)).model as string
        return new Response(JSON.stringify(capabilities[name] ? { capabilities: capabilities[name] } : {}))
      }) as typeof fetch
    expect(
      await visionModel('http://h', fake({ 'llama3.1:8b': ['completion'], 'qwen2.5vl:7b': ['completion', 'vision'] }))
    ).toBe('qwen2.5vl:7b')
    expect(await visionModel('http://h', fake({ 'llama3.1:8b': undefined, 'llava:13b': undefined }))).toBe('llava:13b')
    expect(await visionModel('http://h', fake({ 'llama3.1:8b': ['completion'] }))).toBeNull()
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    expect(await visionModel('http://h', down)).toBeNull()
  })

  it('sends one moment at a time with its stills, held to the shape of a line', async () => {
    const bodies: Record<string, unknown>[] = []
    const fake = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const content =
        bodies.length === 2
          ? 'not json'
          : JSON.stringify({ line: 'Dinner on a terrace at dusk!', kind: 'establishing' })
      return new Response(JSON.stringify({ message: { role: 'assistant', content } }))
    }) as typeof fetch
    const moments = vlog.moments.slice(0, 3)
    const got = await describeWithOllama(
      moments,
      vlog,
      strips,
      { host: 'http://h', model: 'qwen2.5vl:7b' },
      () => {},
      fake
    )
    expect(bodies).toHaveLength(3)
    expect(bodies[0].format).toEqual(LOCAL_LINE_SCHEMA)
    const message = (bodies[0].messages as { images?: string[] }[])[1]
    expect(message.images).toEqual([Buffer.from(`jpeg of ${moments[0].id}`).toString('base64')])
    expect(got.lines.get(moments[0].id)).toBe('dinner on a terrace at dusk')
    expect(got.kinds.get(moments[0].id)).toBe('establishing')
    expect(got.lines.has(moments[1].id)).toBe(false)
    expect(got.note).toBe('qwen2.5vl:7b could not describe one moment, so the measurements describe it.')
  })
})

describe('the story by a model', () => {
  const talk = vlog.clips.find(
    (c) => c.talking && !c.left && doc.words.some((w) => w.source === c.id)
  ) as Vlog['clips'][0]
  const said = doc.words.filter((w) => w.source === talk.id)
  const shot = vlog.clips.find((c) => !c.talking && !c.left && c.usable.length > 0) as Vlog['clips'][0]
  const [a, z] = shot.usable[0]
  const scene = vlog.scenes[0]
  const answer: StoryAnswer = {
    beats: [
      { clip: shot.id, role: 'establishing', inSec: a, outSec: Math.min(z, a + 3), from: '', to: '' },
      { clip: talk.id, role: 'talk', inSec: 0, outSec: 0, from: said[0].id, to: said[said.length - 1].id },
      // Neither holds: a clip there is no such thing as, and a word that clip never said.
      { clip: 's99', role: 'action', inSec: 0, outSec: 2, from: '', to: '' },
      { clip: talk.id, role: 'talk', inSec: 0, outSec: 0, from: said[0].id, to: 's1w999' }
    ],
    scenes: [
      { id: scene.id, name: 'the arrival!' },
      { id: 'sc99', name: 'Nowhere' }
    ],
    reply: `It opens on ${shot.id} in ${scene.id}, and ends on ${talk.id}!`,
    summary: `The day, from ${scene.id}.`
  }

  it('sends the shot list and the ask, the instructions and shot list cached, to the model the planner uses', () => {
    const params = storyRequest(doc, vlog, 'make it 40 seconds', 40, true)
    expect(params.model).toBe(MODEL)
    expect(params.system).toEqual([{ type: 'text', text: STORY_SYSTEM, cache_control: { type: 'ephemeral' } }])
    const content = (params.messages as { content: { text: string; cache_control?: unknown }[] }[])[0].content
    expect(content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(content[0].text).toContain(`<scene id="${scene.id}"`)
    expect(content[0].text).toContain(`${said[0].id} ${said[0].text}`)
    expect(content[1].text).toContain('Length: 0:40, as the creator asked.')
    expect(content[1].text).toContain('make it 40 seconds')
    expect(params.output_config).toMatchObject({ effort: 'medium' })
  })

  it('keeps the beats that hold, fitted to the length, and never shows the person an id', () => {
    const options = { ...passOptions(doc, vlog, null), targetSec: 20, lengthAsked: true }
    const told = storyFromAnswer(doc, vlog, answer, options, 'claude')
    expect(told?.story.beats.map((b) => [b.clip, b.role])).toEqual([
      [shot.id, 'establishing'],
      [talk.id, 'talk']
    ])
    expect(told?.rejected).toHaveLength(2)
    expect(told?.story.by).toBe('claude')
    expect(told?.names.get(scene.id)).toBe('The arrival')
    expect(told?.names.has('sc99')).toBe(false)
    expect(told?.reply).not.toMatch(/\b(s\d+|sc\d+|m\d+|s\d+w\d+)\b|!/)
    expect(told?.reply).toContain(shot.name)
    expect(told?.summary).not.toMatch(/\bsc\d+\b/)
  })

  it('tells the story through Claude, and leaves it to the rules when Claude declines', async () => {
    const seen: Record<string, unknown>[] = []
    const call: StoryCall = async (params) => {
      seen.push(params)
      return { parsed_output: answer, stop_reason: 'end_turn' }
    }
    const told = await storyWithClaude(doc, vlog, 'make it shorter', null, call)
    expect(seen).toHaveLength(1)
    expect(told?.story.beats.length).toBe(2)
    const declined: StoryCall = async () => ({ parsed_output: null, stop_reason: 'refusal' })
    expect(await storyWithClaude(doc, vlog, '', null, declined)).toBeNull()
    const nothing: StoryCall = async () => ({
      parsed_output: { ...answer, beats: answer.beats.slice(2) },
      stop_reason: 'end_turn'
    })
    expect(await storyWithClaude(doc, vlog, '', null, nothing)).toBeNull()
  })

  it('tells it with the model on this Mac, held to the same shape', async () => {
    const asked: { system: string; user: string; format: object }[] = []
    const chat = async (_host: string, _model: string, system: string, user: string, format: object) => {
      asked.push({ system, user, format })
      return asked.length === 1 ? answer : { beats: 'not a list' }
    }
    const told = await storyLocally(
      doc,
      vlog,
      'more of the market',
      null,
      { host: 'http://h', model: 'local-8b' },
      chat
    )
    expect(asked[0].system).toBe(STORY_SYSTEM)
    expect(asked[0].user).toContain('more of the market')
    expect(told?.story.by).toBe('local')
    expect(await storyLocally(doc, vlog, '', null, { host: 'http://h', model: 'local-8b' }, chat)).toBeNull()
  })
})
