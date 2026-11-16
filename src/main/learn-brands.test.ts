import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * What is learned from a brand's own edits stays with that brand: each
 * brand's "Learn from my edits" holds only its own videos, and videos
 * learned before there could be more than one brand belong to the first.
 */

type Handler = (...args: unknown[]) => unknown
const fake = vi.hoisted(() => ({ root: '', handlers: new Map<string, Handler>() }))

vi.mock('electron', async () => {
  const path = await import('path')
  return {
    app: { getPath: (name: string) => path.join(fake.root, name) },
    ipcMain: { handle: (channel: string, fn: Handler) => fake.handlers.set(channel, fn) },
    dialog: {}
  }
})

import { registerLearnIpc } from './learn'
import { savePair } from './learn-store'
import { saveBrands } from './brand-store'
import { buildPair, type LabelledPair, type LearnState } from '../shared/learn'
import { addBrand, brandsFromLegacy, FIRST_BRAND_ID, setDefaultBrand } from '../shared/brands'
import { BrandSchema, EMPTY_BRAND } from '../shared/brand'

/** A video learned from, as the store keeps it; `brand` is absent on ones learned before brands had ids. */
function pair(id: string, title: string, brand?: string): LabelledPair {
  const words = ['so', 'today', 'I', 'want'].map((text, i) => ({
    id: `s1w${i + 1}`,
    source: 's1',
    text,
    startSec: 0.5 + i * 0.4,
    endSec: 0.8 + i * 0.4
  }))
  const built = buildPair(
    {
      id,
      title,
      createdAt: '2026-11-16T00:00:00.000Z',
      recordings: [{ id: 's1', path: `/Users/you/Movies/${id}.mov`, durationSec: 3, bytes: 812, modifiedAt: null }],
      finished: { path: `/Users/you/Movies/${id}-final.mp4`, durationSec: 2, bytes: 400, modifiedAt: null }
    },
    [{ id: 's1', durationSec: 3, words, features: null }],
    {
      ok: true,
      pieces: [
        { source: 's1', rawStart: 0.45, rawEnd: 1.25, outStart: 0, outEnd: 0.8, match: 0.91, sureStart: true, sureEnd: true }
      ],
      issues: [],
      matched: 2,
      words: 2,
      unsure: []
    }
  )
  return brand ? { ...built, brand } : built
}

describe('learning from a brand’s own edits', () => {
  const userData = (): string => join(fake.root, 'userData')
  const state = (brand: string | null): Promise<LearnState> =>
    fake.handlers.get('learn:state')!({}, brand) as Promise<LearnState>
  const titles = async (brand: string | null): Promise<string[]> => (await state(brand)).videos.map((v) => v.title)

  beforeAll(async () => {
    fake.root = mkdtempSync(join(tmpdir(), 'cutalong-learn-brands-'))
    const legacy = BrandSchema.parse({ ...EMPTY_BRAND, id: undefined, name: 'Field Notes' })
    await saveBrands(addBrand(brandsFromLegacy(legacy), 'Tech Corner', 'brand-tc')!.list, userData())
    await savePair(join(userData(), 'learn'), pair('before', 'Learned before brands'))
    await savePair(join(userData(), 'learn'), pair('tc1', 'A Tech Corner video', 'brand-tc'))
    registerLearnIpc({ send: () => undefined, transcribe: async () => ({ words: [] }) as never })
  })

  afterAll(() => {
    if (fake.root) rmSync(fake.root, { recursive: true, force: true })
  })

  it('keeps each brand’s videos to itself, and the ones from before with the first brand', async () => {
    expect(await titles(FIRST_BRAND_ID)).toEqual(['Learned before brands'])
    expect(await titles('brand-tc')).toEqual(['A Tech Corner video'])
    // No brand named, or one that is gone: the default's.
    expect(await titles(null)).toEqual(['Learned before brands'])
    expect(await titles('deleted')).toEqual(['Learned before brands'])
  })

  it('keeps the ones from before with the first brand when another becomes the default', async () => {
    const legacy = BrandSchema.parse({ ...EMPTY_BRAND, id: undefined, name: 'Field Notes' })
    const list = addBrand(brandsFromLegacy(legacy), 'Tech Corner', 'brand-tc')!.list
    await saveBrands(setDefaultBrand(list, 'brand-tc'), userData())
    expect(await titles(null)).toEqual(['A Tech Corner video'])
    expect(await titles(FIRST_BRAND_ID)).toEqual(['Learned before brands'])
  })
})
