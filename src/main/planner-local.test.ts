import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/nowhere' }, safeStorage: {} }))

import { createDoc, wordsFromTranscript, type Note } from '../shared/edit'
import { offerPlan } from './planner'
import { PLAN_JSON_SCHEMA, planEditLocally } from './planner-local'
import { PLANNER_SYSTEM, renderTranscript, type Plan } from './planner-prompt'

const HOST = 'http://127.0.0.1:11434'
const LOCAL = { host: HOST, model: 'local-8b' }

const doc = createDoc({
  id: 'd1',
  title: 'take',
  source: { id: 's1', path: '/Users/you/Movies/take.mov', durationSec: 4, width: 1920, height: 1080, fps: 30 },
  words: wordsFromTranscript(
    [
      { text: 'So', startSec: 0.2, endSec: 0.4 },
      { text: 'um,', startSec: 0.6, endSec: 1.0 },
      { text: 'this', startSec: 1.2, endSec: 1.4 },
      { text: 'is', startSec: 1.4, endSec: 1.6 },
      { text: 'the', startSec: 1.6, endSec: 1.75 },
      { text: 'point.', startSec: 1.75, endSec: 2.2 }
    ],
    's1'
  )
})
const notes: Note[] = [{ id: 'n1', text: 'Cut the um.', beat: 'b1', status: 'open', version: 1 }]

const PLAN: Plan = {
  ops: [
    { op: 'strike', from: 'w2', to: 'w2' },
    // A beat that does not exist: the dry run turns it away, as it would Claude's.
    { op: 'remove', beats: ['b9'], why: 'It says the opening again.' }
  ],
  summary: 'The um is gone. ',
  reply: 'I cut the um.',
  notesHandled: ['n1', 'n7'],
  needs: ['  '],
  question: { text: '', options: [] }
}

type Call = { url: string; init?: RequestInit }

function ollama(chat: () => Response, up = true): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/api/version')) {
      if (!up) throw new TypeError('fetch failed')
      return new Response('{"version":"0.12.0"}', { status: 200 })
    }
    return chat()
  })
  return calls
}
const answer = (content: unknown): Response =>
  new Response(
    JSON.stringify({ model: 'local-8b', message: { role: 'assistant', content: JSON.stringify(content) }, done: true }),
    { status: 200 }
  )

afterEach(() => vi.unstubAllGlobals())

describe('planning edits on a model on this Mac', () => {
  it('asks Ollama on this computer with Claude’s instructions, the transcript and the request, held to the plan schema', async () => {
    const calls = ollama(() => answer(PLAN))
    await planEditLocally({ doc, request: 'Cut the um.', notes: [] }, LOCAL)
    expect(calls.map((c) => c.url)).toEqual([`${HOST}/api/version`, `${HOST}/api/chat`])
    const body = JSON.parse(calls[1].init?.body as string)
    expect(body.model).toBe('local-8b')
    expect(body.stream).toBe(false)
    expect(body.format).toEqual(PLAN_JSON_SCHEMA)
    expect(body.messages[0]).toEqual({ role: 'system', content: PLANNER_SYSTEM })
    expect(body.messages[1].role).toBe('user')
    expect(body.messages[1].content).toContain(renderTranscript(doc))
    expect(body.messages[1].content).toContain('<request>\nCut the um.\n</request>')
  })

  it('offers only what survives the same checks as Claude’s plans', async () => {
    ollama(() => answer(PLAN))
    const r = await planEditLocally({ doc, request: '', notes }, LOCAL)
    expect(r).toEqual(offerPlan(doc, PLAN, notes))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.ops).toEqual([{ op: 'strike', from: 'w2', to: 'w2' }])
    expect(r.rejected).toHaveLength(1)
    expect(r.summary).toBe('The um is gone.')
    expect(r.notesHandled).toEqual(['n1'])
    expect(r.needs).toEqual([])
  })

  it('says so when the answer is not a plan', async () => {
    ollama(() =>
      answer({ ops: [{ op: 'teleport', beat: 'b1' }], summary: 'x', reply: 'y', notesHandled: [], needs: [] })
    )
    expect(await planEditLocally({ doc, request: 'x', notes: [] }, LOCAL)).toEqual({
      ok: false,
      message: 'local-8b sent back a plan in a shape I could not read. Try again, or plan with Claude.'
    })
    ollama(() => new Response(JSON.stringify({ message: { content: 'Sure! Here is a plan' } }), { status: 200 }))
    expect(await planEditLocally({ doc, request: 'x', notes: [] }, LOCAL)).toEqual({
      ok: false,
      message: 'The local model returned something that was not JSON.'
    })
  })

  it('says what to do when Ollama is not running or the model is not pulled', async () => {
    const calls = ollama(() => answer(PLAN), false)
    expect(await planEditLocally({ doc, request: 'x', notes: [] }, LOCAL)).toEqual({
      ok: false,
      message:
        'Ollama is not running on this Mac, so local-8b cannot plan this. Start Ollama, or plan with Claude in Settings.'
    })
    expect(calls.map((c) => c.url)).toEqual([`${HOST}/api/version`])
    ollama(() => new Response('model not found', { status: 404 }))
    expect(await planEditLocally({ doc, request: 'x', notes: [] }, LOCAL)).toEqual({
      ok: false,
      message: 'local-8b is not pulled. Run: ollama pull local-8b'
    })
  })

  it('turns away an edit it cannot read before asking anything', async () => {
    const calls = ollama(() => answer(PLAN))
    expect(await planEditLocally({ doc: { nope: true }, request: 'x', notes: [] }, LOCAL)).toEqual({
      ok: false,
      message: 'The edit could not be read.'
    })
    expect(calls).toHaveLength(0)
  })
})
