import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => null, hasApiKey: () => false }))

import { keyMessage } from '../shared/setup'
import { MODEL } from './planner'
import { plainTriage, readTriage, triage, TRIAGE_SYSTEM, triageRequest, type Triage, type TriageInput } from './triage'

/**
 * Claude reads a message before any footage is (main/triage.ts): which road
 * it takes and what a link with it is for. Through the real SDK, with the
 * network stood in for: what is sent, what comes back, and every way the
 * key can fail on the way.
 */

const INPUT: TriageInput = {
  request: 'Clip the funny bits out of last night’s stream, about 30 seconds each, maybe 8 of them.',
  files: [{ name: 'stream-2026-11-15.mp4', durationSec: 3 * 3600 + 12 * 60 + 5, video: true, audio: true }],
  link: null,
  hasEdit: false,
  commands: [{ command: 'clipping', summary: 'Many short clips from one long recording: /clipping' }]
}

const READ: Triage = {
  route: 'clipping',
  reply: '',
  link: 'none',
  clip: { count: 8, minSec: 0, maxSec: 30, funny: true, topic: '' },
  question: { text: '', options: [] }
}

const message = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Anthropic as the SDK talks to it: keeps what is sent, and answers as told. */
function standIn(answer: () => Response | Promise<Response>): { fetch: typeof fetch; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const spy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return answer()
  })
  return { fetch: spy as unknown as typeof fetch, sent }
}

const answered = (t: Triage) => () =>
  message({
    id: 'msg_triage',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: JSON.stringify(t) }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  })

const failed = (status: number, type: string, text: string) => () =>
  message({ type: 'error', error: { type, message: text }, request_id: 'req_test' }, status)

describe('reading a message before its footage', () => {
  it('takes clips, reels and shorts of a long recording to /clipping even without Claude, and one short to an edit', () => {
    const service = { name: 'Sunday Experience.mp4', durationSec: 4149, video: true, audio: true }
    const ask = (request: string, files = [service]): string =>
      plainTriage({ request, files, link: null, hasEdit: false }).route
    expect(ask('turn this into clips')).toBe('clipping')
    expect(ask('make reels out of this')).toBe('clipping')
    expect(ask('Make TikToks from the sermon')).toBe('clipping')
    expect(ask('clip this sermon')).toBe('clipping')
    // One short, or a short recording, is an edit as it always was.
    expect(ask('make this a short')).toBe('edit')
    expect(ask('make reels out of this', [{ ...service, durationSec: 40 }])).toBe('edit')
    expect(ask('tighten it up')).toBe('edit')
  })


  it('sends each file as its name, length and kind, never what is in it, with the commands and the words', () => {
    const sent = triageRequest({
      ...INPUT,
      files: [...INPUT.files, { name: 'voice <memo>.m4a', durationSec: 42, video: false, audio: true }, { name: 'notes.pdf', durationSec: null, video: false, audio: false }],
      link: 'https://www.youtube.com/watch?v=abc',
      hasEdit: true
    })
    expect(sent).toBe(
      [
        '<files>\n1. stream-2026-11-15.mp4: 3:12:05, video\n2. voice memo.m4a: 0:42, sound only\n3. notes.pdf: length unknown, not a recording\n</files>',
        '<link>https://www.youtube.com/watch?v=abc</link>',
        '<edit>an edit is open in this chat</edit>',
        '<commands>\nclipping: Many short clips from one long recording: /clipping\n</commands>',
        `<request>\n${INPUT.request}\n</request>`
      ].join('\n\n')
    )
    expect(triageRequest({ ...INPUT, files: [], commands: [] })).toMatch(/^<files>\nnone\n<\/files>\n\n<link>none<\/link>\n\n<edit>no edit yet<\/edit>\n\n<request>/)
  })

  it('takes Claude’s reading as /clipping takes its words: no count is any, no shortest is half the longest', () => {
    expect(readTriage(READ, INPUT.request)).toEqual({
      ok: true,
      route: 'clipping',
      reply: '',
      link: 'none',
      clip: { said: INPUT.request, count: 8, length: { minSec: 15, maxSec: 30 }, funny: true, topic: null, single: false, profile: null },
      question: null
    })
    const asked = readTriage(
      {
        ...READ,
        route: 'edit',
        clip: { count: 0, minSec: 0, maxSec: 0, funny: false, topic: '' },
        question: { text: ' One video, or clips? ', options: [' One video ', '', 'Clips', 'Both', 'Neither', 'Five'] }
      },
      'x'
    )
    expect(asked.clip).toMatchObject({ count: null, length: null, topic: null })
    expect(asked.question).toEqual({ text: 'One video, or clips?', options: ['One video', 'Clips', 'Both', 'Neither'] })
    // Long recordings asked for in seconds under five still get five.
    expect(readTriage({ ...READ, clip: { ...READ.clip, maxSec: 8 } }, 'x').clip.length).toEqual({ minSec: 5, maxSec: 8 })
  })

  it('asks Claude through the SDK, briefly, and reads the road it chose', async () => {
    const claude = standIn(answered(READ))
    const r = await triage(INPUT, { key: () => 'sk-ant-api03-test', fetch: claude.fetch })
    expect(r).toMatchObject({ ok: true, route: 'clipping', clip: { count: 8, funny: true } })
    expect(claude.sent).toHaveLength(1)
    const body = claude.sent[0] as {
      model: string
      system: { text: string; cache_control: unknown }[]
      messages: { content: string }[]
      output_config: { effort: string; format: { type: string } }
      thinking: { type: string }
    }
    expect(body.model).toBe(MODEL)
    expect(body.system[0]).toEqual({ type: 'text', text: TRIAGE_SYSTEM, cache_control: { type: 'ephemeral' } })
    expect(body.messages[0].content).toBe(triageRequest(INPUT))
    expect(body.output_config.effort).toBe('low')
    expect(body.output_config.format.type).toBe('json_schema')
    expect(body.thinking).toEqual({ type: 'adaptive' })
  })

  it('sends nothing without a key, and says why', async () => {
    const claude = standIn(answered(READ))
    expect(await triage(INPUT, { key: () => null, fetch: claude.fetch })).toEqual({
      ok: false,
      message: keyMessage('none'),
      keyState: 'none'
    })
    expect(claude.sent).toHaveLength(0)
  })

  it('says what a failure says about the key', async () => {
    const refused = await triage(INPUT, {
      key: () => 'sk-ant-api03-test',
      fetch: standIn(failed(401, 'authentication_error', 'invalid x-api-key')).fetch
    })
    expect(refused).toEqual({ ok: false, message: keyMessage('refused'), keyState: 'refused' })
    const broke = await triage(INPUT, {
      key: () => 'sk-ant-api03-test',
      fetch: standIn(failed(402, 'billing_error', 'Your credit balance is too low.')).fetch
    })
    expect(broke).toEqual({ ok: false, message: keyMessage('no-credit'), keyState: 'no-credit' })
    // A request Claude could not take is said as that, and says nothing about the key.
    const odd = await triage(INPUT, {
      key: () => 'sk-ant-api03-test',
      fetch: standIn(failed(400, 'invalid_request_error', 'messages: text too long')).fetch
    })
    expect(odd.ok).toBe(false)
    expect(!odd.ok && odd.keyState).toBeUndefined()
    // In plain words: the message Claude gave, not the status code and the JSON around it.
    expect(!odd.ok && odd.message).toBe('Claude could not take that request: messages: text too long.')
  })

  it('says when Claude declined', async () => {
    const declined = standIn(() =>
      message({
        id: 'msg_triage',
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: 'refusal',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    )
    expect(await triage(INPUT, { key: () => 'sk-ant-api03-test', fetch: declined.fetch })).toEqual({
      ok: false,
      message: 'Claude declined this one. Try saying it another way.'
    })
  })
})
