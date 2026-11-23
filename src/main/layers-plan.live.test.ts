import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LAYER_ASKS, applyPlan, talk } from './layers-plan.cases'
import { platform, setPlatform, type Platform } from './platform'
import { planEdit } from './planner'

/**
 * Claude itself using the layer tracks: a few asks a person would make,
 * planned by the real planner against Anthropic, each checked for ops that
 * apply and for what they should leave on the edit (layers-plan.cases.ts).
 * Never part of the default run: only with CUTALONG_LIVE=1 and
 * ANTHROPIC_API_KEY set, and it spends a little credit (four plans on a short
 * edit). What each plan said and did is written to CUTALONG_LIVE_DIR when it
 * is set, in the shape layers-plan.recorded.json keeps for the default run.
 *
 *   CUTALONG_LIVE=1 ANTHROPIC_API_KEY=… npx vitest run src/main/layers-plan.live.test.ts
 */

const LIVE = process.env.CUTALONG_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY
const OUT = process.env.CUTALONG_LIVE_DIR ?? ''

describe.skipIf(!LIVE)('Claude with the layer tracks, live', () => {
  let before: Platform
  const record: unknown[] = []

  beforeAll(() => {
    before = platform()
    const key = process.env.ANTHROPIC_API_KEY as string
    setPlatform({ ...before, secrets: { ...before.secrets, get: async (name) => (name === 'anthropic' ? key : before.secrets.get(name)) } })
  })

  afterAll(() => {
    setPlatform(before)
    if (OUT) {
      mkdirSync(OUT, { recursive: true })
      writeFileSync(join(OUT, 'layers-plan.json'), JSON.stringify(record, null, 2))
    }
  })

  for (const ask of LAYER_ASKS) {
    it(ask.name, async () => {
      const doc = talk()
      const r = await planEdit({ doc, request: ask.request, notes: [] })
      if (!r.ok) throw new Error(r.message)
      const applied = applyPlan(doc, r.ops)
      record.push({ request: ask.request, ops: r.ops, rejected: [...r.rejected, ...applied.rejected], summary: r.summary, reply: r.reply })
      expect(applied.rejected, ask.request).toEqual([])
      ask.check(applied)
    }, 180_000)
  }
})
