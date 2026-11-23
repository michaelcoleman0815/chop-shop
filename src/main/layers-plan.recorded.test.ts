import { describe, expect, it } from 'vitest'
import { OpSchema, type Op } from '../shared/edit'
import { LAYER_ASKS, applyPlan, talk } from './layers-plan.cases'
import recorded from './layers-plan.recorded.json'

/**
 * Plans Claude really made for the layer asks (the live test, run against
 * Anthropic on the day in the file), replayed with no network: each still
 * parses as ops, applies with nothing refused, and leaves what the ask wants.
 * A change to the ops that would break what Claude sends shows here first.
 * To refresh it, run the live test with CUTALONG_LIVE_DIR set and copy its
 * plans in.
 */

describe('Claude’s recorded plans for the layer tracks', () => {
  it('has a plan for every ask', () => {
    expect(recorded.plans.map((p) => p.request)).toEqual(LAYER_ASKS.map((a) => a.request))
  })

  for (const ask of LAYER_ASKS) {
    it(ask.name, () => {
      const plan = recorded.plans.find((p) => p.request === ask.request)
      expect(plan, ask.request).toBeTruthy()
      const ops = (plan?.ops ?? []).map((op) => OpSchema.parse(op) as Op)
      const applied = applyPlan(talk(), ops)
      expect(applied.rejected, ask.request).toEqual([])
      ask.check(applied)
    })
  }
})
