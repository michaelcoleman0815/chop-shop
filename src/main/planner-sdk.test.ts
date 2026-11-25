import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: vi.fn(() => 'sk-ant-api03-test'), hasApiKey: () => true }))

import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { commit, createDoc, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { FFMPEG_PATH } from './ffmpeg'
import { keyMessage } from '../shared/setup'
import { readApiKey } from './apikey'
import { forgetSent } from './plan-quote'
import { setUsageSink } from './usage'
import { CLAUDE_PRICES } from '../shared/costs'
import { PLANNER_PRICE } from '../shared/setup'
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

/** Claude calling the plan tool with the plan. */
const called = (plan: unknown, tool = 'plan') => () =>
  respond({
    id: 'msg_plan',
    type: 'message',
    role: 'assistant',
    model: MODEL,
    content: [{ type: 'tool_use', id: `toolu_${tool}`, name: tool, input: plan }],
    stop_reason: 'tool_use',
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
  beforeEach(() => forgetSent())
  /** A real little recording, so there are frames to see and stills to draw. */
  const filmed = (): EditDoc => {
    const path = join(mkdtempSync(join(tmpdir(), 'cutalong-look-')), 'talk.mp4')
    execFileSync(FFMPEG_PATH, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6', '-pix_fmt', 'yuv420p', path])
    return { ...talk(), sources: [{ ...talk().sources[0], path, width: 640, height: 360 }] }
  }
  const pop = (text: string, from = 'w6') => ({
    op: 'motion-add', kind: 'keyword', from, to: '', text: [text], items: [], values: [], box: [], icon: '', style: 'plate', place: '', color: '', fx: [], pin: ''
  })
  const judged = (scores: Record<number, number>, missing = '') =>
    called({ pieces: Object.entries(scores).map(([piece, score]) => ({ piece: Number(piece), score, problem: score < 8 ? 'Too small to read.' : '', fix: score < 8 ? 'Twice the size.' : '' })), missing }, 'verdict')
  type Sent = { system: { text: string }[]; tools: { name: string }[]; messages: { role: string; content: { type: string; text?: string; content?: string; tool_use_id?: string }[] }[] }
  const inTurn = (answers: (() => Response)[]): { fetch: typeof fetch; sent: Sent[] } => {
    const sent: Sent[] = []
    const fake = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)))
      const next = answers.shift()
      return next ? next() : respond({ error: { type: 'api_error', message: 'nothing left' } }, 500)
    })
    return { fetch: fake as unknown as typeof fetch, sent }
  }

  it('looks at the footage before planning, and has a critic who has not seen the plan score what it made', async () => {
    const claude = inTurn([called({ ...PLAN, ops: [pop('Settings')] }), judged({ 1: 9 })])
    const steps: string[] = []
    const r = await planEdit({ doc: filmed(), request: 'make it pop', notes: [] }, { fetch: claude.fetch, progress: (s) => steps.push(s), prefs: { planQuality: 'best' } })
    // The first ask carries a frame of the footage every few seconds, each labelled.
    const first = claude.sent[0].messages[0].content
    expect(first.filter((b) => b.type === 'image').length).toBeGreaterThanOrEqual(4)
    expect(first.some((b) => b.type === 'text' && /^s1 at 0:0\d\.\d/.test(b.text ?? ''))).toBe(true)
    // The critic is asked afresh: its own instructions, the request and the stills, and none of the planner's turns.
    expect(claude.sent).toHaveLength(2)
    const critic = claude.sent[1]
    expect(critic.tools.map((t) => t.name)).toEqual(['verdict'])
    expect(critic.messages).toHaveLength(1)
    expect(critic.messages[0].content.some((b) => b.type === 'image')).toBe(true)
    expect(critic.messages[0].content[0].text).toContain('make it pop')
    expect(JSON.stringify(critic)).not.toContain('motion-add')
    // Nothing failed: the plan is offered as it was, with what it scored.
    expect(r.ok && (r.ops[0] as { text: string[] }).text).toEqual(['Settings'])
    expect(r.ok && r.judged).toMatchObject([[{ n: 1, score: 9 }]])
    expect(steps).toEqual(['Checking how it looks'])
  }, 60000)

  it('redoes only what fails, locks what passes, and has someone new judge what came back', async () => {
    const claude = inTurn([
      called({ ...PLAN, ops: [pop('Here', 'w2'), pop('Settings')] }),
      judged({ 1: 9, 2: 5 }),
      // Handed back with the failed one bigger, and the locked one meddled with.
      called({ ...PLAN, ops: [pop('There', 'w2'), pop('Open the settings')], summary: 'Fixed.' }),
      judged({ 2: 8 })
    ])
    const steps: string[] = []
    const r = await planEdit({ doc: filmed(), request: 'make it pop', notes: [] }, { fetch: claude.fetch, progress: (s) => steps.push(s), prefs: { planQuality: 'best' } })
    expect(claude.sent.map((s) => s.tools[0].name)).toEqual(['plan', 'verdict', 'plan', 'verdict'])
    // The planner hears the score and the problem, in answer to its own call, with a still of what failed.
    const back = claude.sent[2].messages[2].content
    expect(back[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_plan' })
    expect(back[0].content).toContain('5/10. Too small to read. Twice the size.')
    expect(back.filter((b) => b.type === 'image').length).toBeGreaterThan(0)
    // The second critic sees the new piece alone.
    expect(claude.sent[3].messages[0].content[0].text).toContain('The pieces to score: 2.')
    expect(r.ok && r.ops.map((o) => (o as { text: string[] }).text[0])).toEqual(['Here', 'Open the settings'])
    expect(r.ok && r.summary).toBe('Fixed.')
    expect(r.ok && r.judged?.map((round) => round.map((j) => j.score))).toEqual([[9, 5], [8]])
    expect(steps).toEqual(['Checking how it looks', 'Redoing one thing', 'Checking again'])
  }, 60000)

  it('keeps the first try when the redo is worse, and stops after two', async () => {
    const worse = inTurn([called({ ...PLAN, ops: [pop('Settings')] }), judged({ 1: 6 }), called({ ...PLAN, ops: [pop('Nope')] }), judged({ 1: 3 })])
    const kept = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: worse.fetch, prefs: { planQuality: 'best' } })
    expect(kept.ok && (kept.ops[0] as { text: string[] }).text).toEqual(['Settings'])
    const never = inTurn([
      called({ ...PLAN, ops: [pop('A')] }), judged({ 1: 5 }),
      called({ ...PLAN, ops: [pop('B')] }), judged({ 1: 6 }),
      called({ ...PLAN, ops: [pop('C')] }), judged({ 1: 7 }),
      called({ ...PLAN, ops: [pop('D')] }), judged({ 1: 7 })
    ])
    const last = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: never.fetch, prefs: { planQuality: 'best' } })
    expect(never.sent).toHaveLength(6)
    expect(last.ok && (last.ops[0] as { text: string[] }).text).toEqual(['C'])
  }, 90000)

  it('judges only where the quality is turned up, redoes as often as it says, and sends no frames where they are off', async () => {
    const quick = inTurn([called({ ...PLAN, ops: [pop('Settings')] })])
    const r = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: quick.fetch, prefs: {} })
    expect(quick.sent).toHaveLength(1)
    expect(quick.sent[0].messages[0].content.some((b) => b.type === 'image')).toBe(true)
    expect(r.ok && r.judged).toBeUndefined()
    const careful = inTurn([called({ ...PLAN, ops: [pop('A')] }), judged({ 1: 5 }), called({ ...PLAN, ops: [pop('B')] }), judged({ 1: 6 }), called({ ...PLAN, ops: [pop('C')] })])
    const once = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: careful.fetch, prefs: { planQuality: 'careful' } })
    expect(careful.sent).toHaveLength(4)
    expect(once.ok && (once.ops[0] as { text: string[] }).text).toEqual(['B'])
    const unseen = inTurn([called({ ...PLAN, ops: [pop('Settings')] })])
    await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: unseen.fetch, prefs: { planQuality: 'best', claudeSeesFrames: false } })
    expect(unseen.sent).toHaveLength(1)
    expect(unseen.sent[0].messages[0].content.some((b) => b.type === 'image')).toBe(false)
  }, 60000)

  it('begins no redo and no design that would take the plan past what its quality may cost', async () => {
    // A reply that took this many tokens, as the API counts them.
    const took = (answer: () => Response, output_tokens: number) => () => {
      const held = answer()
      return new Response(
        new ReadableStream({
          async start(c) {
            const body = (await held.json()) as Record<string, unknown>
            c.enqueue(new TextEncoder().encode(JSON.stringify({ ...body, usage: { input_tokens: 1, output_tokens } })))
            c.close()
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    // 55,000 tokens of answer is $1.10: the check is still made, and the redo it asks for is not begun.
    const dear = inTurn([took(called({ ...PLAN, ops: [pop('A')] }), 55000), judged({ 1: 5 }), called({ ...PLAN, ops: [pop('B')] }), judged({ 1: 9 })])
    const r = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: dear.fetch, prefs: { planQuality: 'best' } })
    expect(dear.sent.map((s) => s.tools[0].name)).toEqual(['plan', 'verdict'])
    expect(r.ok && (r.ops[0] as { text: string[] }).text).toEqual(['A'])
    // With that much spent, a design asked for is left out rather than drawn.
    forgetSent()
    const design = { op: 'design', from: 'w1', to: 'w5.end', room: 'left', brief: 'A door opening.' }
    const spent = inTurn([took(called({ ...PLAN, ops: [pop('A'), design] }), 55000), judged({ 1: 9 })])
    const left = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: spent.fetch, prefs: { planQuality: 'best' } })
    expect(spent.sent.map((s) => s.tools[0].name)).toEqual(['plan', 'verdict'])
    expect(left.ok && left.ops).toHaveLength(1)
  }, 60000)

  it('checks a change to an edit that has its graphics, redoes it once at most, and designs nothing for it', async () => {
    const made = commit(filmed(), [{ ...pop('Here', 'w2'), op: 'motion-add', layers: [] } as never], 'Planned').doc
    const claude = inTurn([
      called({ ...PLAN, ops: [pop('A')] }), judged({ 1: 5 }),
      called({ ...PLAN, ops: [pop('B')] }), judged({ 1: 6 }),
      called({ ...PLAN, ops: [pop('C')] }), judged({ 1: 7 })
    ])
    const r = await planEdit({ doc: made, request: 'say it bigger', notes: [] }, { fetch: claude.fetch, prefs: { planQuality: 'best' } })
    expect(claude.sent.map((s) => s.tools[0].name)).toEqual(['plan', 'verdict', 'plan', 'verdict'])
    expect(r.ok && (r.ops[0] as { text: string[] }).text).toEqual(['B'])
    const asked = claude.sent[0].messages[0].content.map((b) => b.text ?? '').join('\n')
    expect(asked).not.toContain('<designs>')
    // A first edit may have one designed.
    const first = inTurn([called({ ...PLAN, ops: [] })])
    await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: first.fetch, prefs: { planQuality: 'best' } })
    expect(first.sent[0].messages[0].content.map((b) => b.text ?? '').join('\n')).toContain('<designs>\nOne graphic may be designed')
  }, 60000)

  it('writes the planner’s call and its critic’s in the ledger, at the prices the quote was made from', async () => {
    const billed: string[] = []
    setUsageSink((purpose) => (model) => void billed.push(`${purpose} ${model}`))
    try {
      const claude = inTurn([called({ ...PLAN, ops: [pop('A')] }), judged({ 1: 9 })])
      await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: claude.fetch, prefs: { planQuality: 'best' } })
    } finally {
      setUsageSink(null)
    }
    expect(billed).toEqual([`plan ${MODEL}`, `critic ${MODEL}`])
    expect(PLANNER_PRICE).toMatchObject(CLAUDE_PRICES[MODEL])
  }, 60000)

  it('offers the plan as it was when nobody can judge it', async () => {
    const down = inTurn([called({ ...PLAN, ops: [pop('Settings')] }), text('I would rather not say.')])
    const r = await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: down.fetch, prefs: { planQuality: 'best' } })
    expect(r.ok && (r.ops[0] as { text: string[] }).text).toEqual(['Settings'])
    // A plan with nothing to look at asks no one.
    const plain = inTurn([called({ ...PLAN, ops: [] })])
    await planEdit({ doc: filmed(), request: 'x', notes: [] }, { fetch: plain.fetch })
    expect(plain.sent).toHaveLength(1)
  }, 60000)

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

  it('hands the plan over as an ordinary tool, since its schema is past what the API compiles into a grammar', async () => {
    const claude = standIn(called(PLAN))
    const r = await planEdit({ doc: talk(), request: 'tighten it', notes: [] }, { fetch: claude.fetch })
    expect(r.ok && r.steps).toHaveLength(3)
    const body = claude.sent[0] as {
      tools: { name: string; strict?: boolean; input_schema: unknown }[]
      tool_choice: unknown
      output_config: Record<string, unknown>
      system: { text: string }[]
    }
    expect(body.tools.map((t) => t.name)).toEqual(['plan'])
    expect(body.tools[0].strict).toBeUndefined()
    expect(JSON.stringify(body.tools[0].input_schema)).toContain('bring-back')
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(body.output_config).toEqual({ effort: 'medium' })
    expect(body.system[body.system.length - 1].text).toMatch(/calling the plan tool once/)
  })

  it('leaves out an op it cannot read and says so, and puts back the empty slots an op left out', async () => {
    const plan = {
      ...PLAN,
      ops: [
        { op: 'teleport', to: 'the moon' },
        // The command's empty slots left out: they are put back, as a grammar would have made them write them.
        { op: 'run', command: 'tighten' },
        { op: 'aspect', aspect: 'vertical' }
      ]
    }
    const r = await planEdit({ doc: talk(), request: 'x', notes: [] }, { fetch: standIn(called(plan)).fetch })
    expect(r.ok && r.steps).toEqual([
      { command: { op: 'run', command: 'tighten', rest: '', note: '' } },
      { ops: [{ op: 'aspect', aspect: 'vertical' }] }
    ])
    expect(r.ok && r.needs).toContain('One change I planned came back in a shape I couldn’t use. Ask again and I’ll redo it.')
  })

  it('takes a plan written out as JSON when the tool was not called, and nothing when there is no plan', async () => {
    expect((await planEdit({ doc: talk(), request: 'x', notes: [] }, { fetch: standIn(text(JSON.stringify(PLAN))).fetch })).ok).toBe(true)
    const none = await planEdit({ doc: talk(), request: 'x', notes: [] }, { fetch: standIn(text('I could not do that.')).fetch })
    expect(none).toMatchObject({ ok: false, message: 'The plan came back in a shape I could not read. Try again.' })
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
