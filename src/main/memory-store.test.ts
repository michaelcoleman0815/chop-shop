import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { plannerPreferences } from '../shared/memory'
import { MemoryStore } from './memory-store'

/** memory.json on disk: what is noted, what is not, and that nothing is lost. */

const dir = mkdtempSync(join(tmpdir(), 'cutalong-memory-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const request = (i: number, text: string) => ({
  kind: 'request' as const,
  at: new Date(Date.parse('2026-11-01T09:00:00.000Z') + i * 1000).toISOString(),
  doc: `d${i % 3}`,
  text,
  version: 2,
  tags: []
})

describe('the memory file', () => {
  it('keeps every signal when many arrive at once', async () => {
    const store = new MemoryStore(join(dir, 'busy.json'))
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.record(request(i, 'keep the laugh'))))
    const fresh = new MemoryStore(join(dir, 'busy.json'))
    expect((await fresh.read()).signals).toHaveLength(25)
  })

  it('notes nothing while paused, and writes nothing either', async () => {
    const file = join(dir, 'paused.json')
    const store = new MemoryStore(file)
    await store.record(request(1, 'too fast'))
    await store.change({ paused: true })
    const before = readFileSync(file, 'utf8')
    await store.record(request(2, 'too fast'))
    await store.record(request(3, 'too fast'))
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect((await store.read()).signals).toHaveLength(1)
    await store.change({ paused: false })
    await store.record(request(4, 'too fast'))
    expect((await new MemoryStore(file).read()).signals).toHaveLength(2)
  })

  it('reads what the planner gets fresh from the file, so a deletion holds', async () => {
    const file = join(dir, 'forget.json')
    const store = new MemoryStore(file)
    for (let i = 0; i < 3; i++) await store.record(request(i, 'keep the laughs'))
    expect(plannerPreferences(await new MemoryStore(file).read())).toEqual(['You keep your laughs (3 times)'])
    await store.change({ forget: 'laughs:keep' })
    expect(plannerPreferences(await new MemoryStore(file).read())).toEqual([])
  })

  it('leaves a file from a newer version as it is', async () => {
    const file = join(dir, 'newer.json')
    const newer = JSON.stringify({ v: 2, signals: [{ kind: 'something-new' }] })
    writeFileSync(file, newer)
    const store = new MemoryStore(file)
    await store.record(request(1, 'keep the laugh'))
    await store.change({ paused: true })
    expect(readFileSync(file, 'utf8')).toBe(newer)
  })

  it('starts fresh from a file it cannot read', async () => {
    const file = join(dir, 'broken.json')
    writeFileSync(file, '{ broken')
    const store = new MemoryStore(file)
    expect((await store.read()).signals).toEqual([])
    await store.record(request(1, 'keep the laugh'))
    expect(JSON.parse(readFileSync(file, 'utf8')).v).toBe(1)
  })
})
