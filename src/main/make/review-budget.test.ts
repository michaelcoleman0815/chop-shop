import { describe, expect, it } from 'vitest'
import { Budget, makeOnce, NotKept, type MadeCache, type MadeRequest } from './generate'
import type { MakeServices, Picture } from './services'

/**
 * Regression for the money review's tenth finding: a picture that comes back
 * paid for and then cannot be written to the cache (a full disk) stays spent
 * once. Its hold is not let go a second time, so the requests still in
 * flight keep theirs, and nothing more is asked for than the cap allows.
 */

const PNG: Picture = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), mime: 'image/png' }
const req = (prompt: string): MadeRequest => ({
  kind: 'image',
  service: 'google',
  model: 'm',
  prompt,
  refs: [],
  aspect: 'wide',
  size: '2K'
})
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('a cache write that fails after a paid request', () => {
  it('keeps the run inside the agreed total', async () => {
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
    await expect(makeOnce(req('d'), 0.1, deps, make)).rejects.toThrow(/past the \$0\.30 agreed/)
    // a's picture comes back (paid); writing it fails, and says it was paid for.
    arrive[0]()
    await expect(a).rejects.toBeInstanceOf(NotKept)
    await expect(a).rejects.toThrow(/made and paid for, but I could not save it/)
    expect(budget.spent).toBeCloseTo(0.1)
    // Another shot now does not fit: 0.1 is spent and 0.2 is still out.
    await expect(makeOnce(req('e'), 0.1, deps, make)).rejects.toThrow(/past the \$0\.30 agreed/)
    expect(sent).toBe(3)
    arrive.slice(1).forEach((go) => go())
    await Promise.all([b, c])
    expect(budget.spent).toBeCloseTo(0.3)
    expect(budget.spent).toBeLessThanOrEqual(budget.cap + 1e-9)
  })
})
