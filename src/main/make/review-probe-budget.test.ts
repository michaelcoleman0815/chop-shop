import { describe, expect, it } from 'vitest'
import { Budget, makeOnce, type MadeCache, type MadeRequest } from './generate'
import type { MakeServices, Picture } from './services'

/**
 * Review probe: makeOnce commits a paid picture to the budget, then writes it
 * to the cache inside the same try. If the write fails (a full disk), the
 * catch releases the hold a second time, which takes it from the other
 * requests in flight; one more request then fits under a cap that is in fact
 * already full, and the run spends past it. The paid picture is also lost.
 */

const PNG: Picture = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), mime: 'image/png' }
const req = (prompt: string): MadeRequest => ({ kind: 'image', service: 'google', model: 'm', prompt, refs: [], aspect: 'wide', size: '2K' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('fixed: a cache write that fails after a paid request', () => {
  it('counts the paid picture once, and keeps the run inside the agreed total', async () => {
    const budget = new Budget(0.3)
    let puts = 0
    const cache = {
      get: async () => null,
      put: async (key: string) => {
        puts++
        if (puts === 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
        return `/made/${key}.png`
      }
    } as unknown as MadeCache
    const arrive: (() => void)[] = []
    let sent = 0
    const make = (): Promise<Picture> =>
      new Promise((resolve) => {
        sent++
        arrive.push(() => resolve(PNG))
      })
    const deps = { services: {} as MakeServices, cache, budget }
    // Four at a time, as makeShots runs them; the cap holds three.
    const a = makeOnce(req('a'), 0.1, deps, make)
    const b = makeOnce(req('b'), 0.1, deps, make)
    const c = makeOnce(req('c'), 0.1, deps, make)
    await tick()
    const d0 = makeOnce(req('d'), 0.1, deps, make).catch((e: Error) => e)
    await tick()
    const refusedBefore = (await Promise.race([d0, tick().then(() => 'pending')])) as Error | string
    // a's picture comes back (paid); writing it fails.
    arrive[0]()
    await expect(a).rejects.toThrow(/ENOSPC/)
    // Another shot starts now: it should not fit, since 0.1 is spent and 0.2 is still out.
    const e = makeOnce(req('e'), 0.1, deps, make).catch((err: Error) => err)
    await tick()
    const sentAfter = sent
    arrive.slice(1).forEach((go) => go())
    const [, , eOut] = await Promise.all([b, c, e])
    console.log(`d before the failed write: ${refusedBefore instanceof Error ? refusedBefore.message : refusedBefore}`)
    console.log(`e after it: ${eOut instanceof Error ? eOut.message : 'sent'}`)
    console.log(`requests sent: ${sentAfter}; spent $${budget.spent.toFixed(2)} against a cap of $${budget.cap.toFixed(2)}`)
    expect(refusedBefore).toBeInstanceOf(Error)
    expect(eOut).toBeInstanceOf(Error)
    expect(sentAfter).toBe(3)
    expect(budget.spent).toBeLessThanOrEqual(budget.cap + 1e-9)
  })
})
