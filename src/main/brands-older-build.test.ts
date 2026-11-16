import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { readBrands, saveBrands } from './brand-store'
import { NeverStore } from './never-store'
import { MemoryStore } from './memory-store'
import { EMPTY_BRAND, type Brand } from '../shared/brand'
import { BrandSchema as BrandSchema0213 } from '../shared/brand-0213.review'
import { SignalSchema as SignalSchema0213 } from '../shared/memory/signals-0213.review'
import { neverEntriesOf, neverFor, neverRulesIn } from '../shared/memory'

/**
 * Going back to 0.2.13 for a while, and coming back. 0.2.13 knows one brand,
 * in brand.json, and saves it whole (main/brand-store at 391798b): what it
 * reads with its schema, which has no id, fonts, B-roll sources or
 * description, stamped with the time. And it rewrites memory.json with the
 * signals its schema reads, which has no never rules. Neither may lose what
 * was set here.
 */

const root = mkdtempSync(join(tmpdir(), 'older-build-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const A: Brand = { ...EMPTY_BRAND, id: 'brand-1', name: 'Field Notes', voice: 'Warm.' }
const B: Brand = {
  ...EMPTY_BRAND,
  id: 'brand-x',
  name: 'Tech Corner',
  voice: 'Fast and dry.',
  fonts: { display: 'Anton' },
  broll: { prefer: ['@nasa'], block: ['@reuploadcentral'] },
  description: '{opening}\n\nGear: example.com/gear\n\n{chapters}\n\n{credits}'
}

/** 0.2.13's brand page saving a change to its one brand: read, changed, written whole. */
function savedBy0213(dir: string, change: (b: Brand) => Brand, at: string): void {
  const file = join(dir, 'brand.json')
  const read = BrandSchema0213.parse(JSON.parse(readFileSync(file, 'utf8')))
  writeFileSync(file, JSON.stringify({ ...change(read as Brand), updatedAt: at }, null, 2))
}

describe('brand.json changed by 0.2.13', () => {
  it('comes back into the default brand, keeping what 0.2.13 does not know', async () => {
    const dir = mkdtempSync(join(root, 'fold-'))
    const saved = await saveBrands({ v: 1, default: 'brand-x', brands: [A, B] }, dir)
    if (!saved.ok) throw new Error(saved.message)
    // 0.2.13 reads the default brand from brand.json, as it knows it.
    const mirror = JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8'))
    expect(BrandSchema0213.safeParse(mirror).success).toBe(true)
    expect(mirror.name).toBe('Tech Corner')
    savedBy0213(
      dir,
      (b) => ({ ...b, voice: 'Fast, dry, no music.', captions: { ...b.captions, position: 'top' } }),
      '2099-01-01T00:00:00.000Z'
    )
    expect(JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8')).id).toBeUndefined()

    const back = await readBrands(dir)
    const tc = back.brands.find((b) => b.id === 'brand-x')!
    expect(tc.voice).toBe('Fast, dry, no music.')
    expect(tc.captions.position).toBe('top')
    // What 0.2.13 has no field for stays as it was set here.
    expect(tc.fonts).toEqual({ display: 'Anton' })
    expect(tc.broll).toEqual({ prefer: ['@nasa'], block: ['@reuploadcentral'] })
    expect(tc.description).toBe(B.description)
    // The other brand is untouched.
    expect(back.brands.find((b) => b.id === 'brand-1')).toEqual(saved.brands.brands[0])
    // Written back once: both files as this build keeps them, and read again, the same.
    expect(JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8')).id).toBe('brand-x')
    expect(JSON.parse(readFileSync(join(dir, 'brands.json'), 'utf8')).brands[1].voice).toBe('Fast, dry, no music.')
    expect(await readBrands(dir)).toEqual(back)
  })

  it('leaves a brand.json from before the list alone once the list is newer', async () => {
    const dir = mkdtempSync(join(root, 'old-'))
    // As brand.json was before there could be more than one brand.
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ ...A, id: undefined, updatedAt: '2025-01-01T00:00:00.000Z' }))
    writeFileSync(
      join(dir, 'brands.json'),
      JSON.stringify({ v: 1, default: 'brand-1', brands: [{ ...A, voice: 'Warmer now.', updatedAt: '2026-06-01T00:00:00.000Z' }] })
    )
    const read = await readBrands(dir)
    expect(read.brands[0].voice).toBe('Warmer now.')
  })
})

describe('never rules and 0.2.13', () => {
  it('come over from memory.json once, and stay when 0.2.13 rewrites memory.json', async () => {
    const dir = mkdtempSync(join(root, 'never-'))
    const memoryFile = join(dir, 'memory.json')
    const neverFile = join(dir, 'never.json')
    // As builds that kept the rules in memory.json left it: two rules and a request.
    writeFileSync(
      memoryFile,
      JSON.stringify({
        v: 1,
        signals: [
          { kind: 'never', at: '2026-11-01T10:00:00.000Z', brand: 'brand-x', item: 'sfx:whoosh', on: true, text: 'never use whooshes' },
          { kind: 'never', at: '2026-11-01T10:01:00.000Z', brand: 'brand-1', item: 'music', on: true },
          { kind: 'request', at: '2026-11-01T10:02:00.000Z', doc: 'd', text: 'slower', version: 2, tags: [] }
        ]
      })
    )
    const memory = new MemoryStore(memoryFile)
    const store = new NeverStore(neverFile, async () => neverRulesIn(await memory.current()))
    expect(neverFor(neverEntriesOf(await store.current()), 'brand-x')).toEqual(['sfx:whoosh'])
    expect(existsSync(neverFile)).toBe(true)

    // 0.2.13 notes a request: memory.json as its schema reads it, never rules gone.
    const raw = JSON.parse(readFileSync(memoryFile, 'utf8'))
    const kept = raw.signals.flatMap((s: unknown) => {
      const r = SignalSchema0213.safeParse(s)
      return r.success ? [r.data] : []
    })
    writeFileSync(memoryFile, JSON.stringify({ ...raw, signals: [...kept, { kind: 'request', at: '2026-11-02T09:00:00.000Z', doc: 'e', text: 'faster', version: 3, tags: [] }] }))
    expect(readFileSync(memoryFile, 'utf8')).not.toContain('never')

    // Back here: the rules are still there, from never.json.
    const again = new NeverStore(neverFile, async () => neverRulesIn(await new MemoryStore(memoryFile).current()))
    const entries = neverEntriesOf(await again.current())
    expect(neverFor(entries, 'brand-x')).toEqual(['sfx:whoosh'])
    expect(neverFor(entries, 'brand-1')).toEqual(['music'])
    expect(entries.find((e) => e.item === 'sfx:whoosh')?.said).toBe('never use whooshes')
  })

  it('keep the latest word on a thing, and are kept whatever memory.json says later', async () => {
    const dir = mkdtempSync(join(root, 'latest-'))
    const store = new NeverStore(join(dir, 'never.json'), async () => [])
    await store.change([{ brand: 'brand-x', item: 'bw', on: true }], '2026-11-03T10:00:00.000Z')
    await store.change([{ brand: 'brand-x', item: 'bw', on: false }], '2026-11-03T11:00:00.000Z')
    await store.change([{ brand: 'brand-x', item: 'camera', on: true, text: 'no camera moves' }], '2026-11-03T12:00:00.000Z')
    const file = JSON.parse(readFileSync(join(dir, 'never.json'), 'utf8'))
    expect(file.v).toBe(1)
    expect(file.rules).toHaveLength(2)
    expect(neverFor(neverEntriesOf(await store.current()), 'brand-x')).toEqual(['camera'])
  })
})
