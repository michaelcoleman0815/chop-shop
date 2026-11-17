import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: vi.fn(() => 'sk-ant-api03-test'), hasApiKey: () => true }))

import { createDoc, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { keyMessage } from '../shared/setup'
import { readApiKey } from './apikey'
import { MODEL, planEdit } from './planner'

/**
 * planEdit through the real SDK with the network stood in for: the plan's
 * schema carries Cutalong's commands beside the edit ops, a plan that breaks
 * the schema is not taken, and every failure says what it says about the key.
 * Whole prompts carried out are in renderer/src/cutalong/long-prompts.test.ts.
 */

function talk(): EditDoc {
  const words = 'So here is the thing. Most people never open the settings.'
    .split(' ')
    .map((text, i) => ({ text, startSec: 0.5 + i * 0.4, endSec: 0.8 + i * 0.4 }))
  return createDoc({
    id: 'd',
    title: 'Talk',
    source: { id: 's1', path: '/talk.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(words, 's1')
  })
}

const respond = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function standIn(answer: () => Response): { fetch: typeof fetch; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const spy = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return answer()
  })
  return { fetch: spy as unknown as typeof fetch, sent }
}

const text = (t: string) => () =>
  respond({
    id: 'msg_plan',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'text', text: t }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  })

const PLAN = {
  ops: [
    { op: 'run', command: 'tighten', rest: '', note: '' },
    { op: 'length', targetSec: 4, minSec: 0, maxSec: 0, under: false, intro: false, keepAll: false },
    { op: 'aspect', aspect: 'vertical' }
  ],
  summary: 'Tighter, about 4 seconds, and vertical.',
  reply: 'I tightened it, cut it to about 4 seconds and made it vertical.',
  notesHandled: [],
  needs: [],
  question: { text: '', options: [] }
}

describe('planning through the SDK', () => {
  it('sends the commands with the cut, and takes a plan of edit ops and commands as steps in order', async () => {
    const claude = standIn(text(JSON.stringify(PLAN)))
    const r = await planEdit(
      { doc: talk(), request: 'tighten it, 4 seconds, vertical', notes: [], commands: [{ command: 'tighten', summary: 'Cut the pauses' }] },
      { fetch: claude.fetch }
    )
    expect(r.ok && r.steps).toEqual([
      { command: { op: 'run', command: 'tighten', rest: '', note: '' } },
      { command: { op: 'length', targetSec: 4, minSec: 0, maxSec: 0, under: false, intro: false, keepAll: false } },
      { ops: [{ op: 'aspect', aspect: 'vertical' }] }
    ])
    const body = claude.sent[0] as { messages: { content: { text: string; cache_control?: unknown }[] }[]; output_config: { effort: string } }
    const blocks = body.messages[0].content
    expect(blocks[0]).toEqual({ type: 'text', text: '<commands>\ntighten: Cut the pauses\n</commands>', cache_control: { type: 'ephemeral' } })
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[2].text).toMatch(/<request>\ntighten it, 4 seconds, vertical\n<\/request>$/)
    expect(body.output_config.effort).toBe('medium')
  })

  it('does not take a plan that breaks the schema, such as a command with a slot missing', async () => {
    const broken = { ...PLAN, ops: [{ op: 'take', line: 'g1' }] }
    const r = await planEdit({ doc: talk(), request: 'x', notes: [] }, { fetch: standIn(text(JSON.stringify(broken))).fetch })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/structured output/i)
    expect(!r.ok && r.keyState).toBeUndefined()
  })

  it('sends nothing without a key, and says each failure as the gate reads it', async () => {
    vi.mocked(readApiKey).mockReturnValueOnce(null)
    const none = standIn(text('{}'))
    expect(await planEdit({ doc: talk(), request: 'x', notes: [] }, { fetch: none.fetch })).toEqual({
      ok: false,
      message: keyMessage('none'),
      needsKey: true,
      keyState: 'none'
    })
    expect(none.sent).toHaveLength(0)
    const error = (status: number, type: string, message: string) => () =>
      respond({ type: 'error', error: { type, message }, request_id: 'req_test' }, status)
    const refused = await planEdit(
      { doc: talk(), request: 'x', notes: [] },
      { fetch: standIn(error(401, 'authentication_error', 'invalid x-api-key')).fetch }
    )
    expect(refused).toEqual({ ok: false, message: keyMessage('refused'), needsKey: true, keyState: 'refused' })
    const broke = await planEdit(
      { doc: talk(), request: 'x', notes: [] },
      { fetch: standIn(error(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')).fetch }
    )
    expect(broke).toEqual({ ok: false, message: keyMessage('no-credit'), needsKey: false, keyState: 'no-credit' })
    const access = await planEdit(
      { doc: talk(), request: 'x', notes: [] },
      { fetch: standIn(error(403, 'permission_error', 'not allowed')).fetch }
    )
    expect(access).toMatchObject({ ok: false, keyState: 'no-access', message: keyMessage('no-access') })
  })
})
