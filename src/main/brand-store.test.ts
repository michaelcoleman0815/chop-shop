import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Brands on this computer: one per channel in brands.json, and the single
 * brand.json from before as the first of them, untouched.
 */

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { brandOfDoc, readBrand, readBrandById, readBrands, saveBrand, saveBrands } from './brand-store'
import { BrandSchema } from '../shared/brand'
import { addBrand, FIRST_BRAND_ID, setDefaultBrand } from '../shared/brands'
import { commit, createDoc, wordsFromTranscript } from '../shared/edit'

/** brand.json as 0.2.13 wrote it: every field it knew, nothing newer. */
const BRAND_0_2_13 = {
  v: 1,
  name: 'Field Notes',
  colors: { text: '#FFFFFF', accent: '#FFD84D' },
  logo: { path: '/Users/you/Pictures/logo.png', corner: 'top-right', opacity: 0.9 },
  captions: { position: 'chest', wordsPerScreen: 2 },
  logos: [{ name: 'Pixel', path: '/Users/you/Pictures/pixel.png' }],
  voice: 'Warm and quick, no swearing.',
  niche: 'tech',
  products: ['Pixel 9 Pro'],
  videos: [],
  style: { pace: { secondsPerShot: 2.4 } },
  autoApply: true,
  updatedAt: '2026-11-10T10:00:00.000Z',
  habits: null
}

const root = mkdtempSync(join(tmpdir(), 'cutalong-brands-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let dir = ''
let n = 0
beforeEach(() => {
  dir = join(root, `case-${n++}`)
  mkdirSync(dir, { recursive: true })
})

describe('brands', () => {
  it('reads the brand from before as the first brand, every value as it was, and leaves its file alone', async () => {
    const file = join(dir, 'brand.json')
    writeFileSync(file, JSON.stringify(BRAND_0_2_13, null, 2))
    const before = readFileSync(file, 'utf8')
    const list = await readBrands(dir)
    expect(list.default).toBe(FIRST_BRAND_ID)
    expect(list.brands).toHaveLength(1)
    const first = list.brands[0]
    // Every field it had, exactly; only the fields added since are new, with their defaults.
    for (const [k, v] of Object.entries(BRAND_0_2_13)) expect(first[k as keyof typeof first]).toEqual(v)
    expect(first.id).toBe(FIRST_BRAND_ID)
    expect(first.broll).toEqual({ prefer: [], block: [] })
    expect(first.fonts).toEqual({})
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'brands.json'))).toBe(false)
    // The default brand is that same brand.
    expect(await readBrand(dir)).toEqual(first)
  })

  it('starts with one empty brand when there is none', async () => {
    const list = await readBrands(dir)
    expect(list.brands.map((b) => [b.id, b.name])).toEqual([[FIRST_BRAND_ID, '']])
  })

  it('saves a second brand and the default, and writes the default to brand.json for builds from before', async () => {
    writeFileSync(join(dir, 'brand.json'), JSON.stringify(BRAND_0_2_13))
    const list = await readBrands(dir)
    const made = addBrand(list, 'Tech Corner', 'brand-tc')
    expect(made).not.toBeNull()
    const r = await saveBrands(setDefaultBrand(made!.list, 'brand-tc'), dir)
    expect(r.ok).toBe(true)
    const again = await readBrands(dir)
    expect(again.brands.map((b) => b.name)).toEqual(['Field Notes', 'Tech Corner'])
    expect(again.default).toBe('brand-tc')
    // An older build reads brand.json as its one brand: now the default.
    const single = BrandSchema.parse(JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8')))
    expect(single.name).toBe('Tech Corner')
    // The first brand is untouched by saving the list: same values, same time stamp.
    expect(again.brands[0].updatedAt).toBe(BRAND_0_2_13.updatedAt)
    expect(again.brands[0].voice).toBe(BRAND_0_2_13.voice)
  })

  it('saves one brand by its id, and a brand without one as the default', async () => {
    const list = await readBrands(dir)
    await saveBrands(addBrand(list, 'Tech Corner', 'brand-tc')!.list, dir)
    await saveBrand({ ...(await readBrandById('brand-tc', dir)), voice: 'Calm.' }, dir)
    await saveBrand({ ...BrandSchema.parse(BRAND_0_2_13), id: '' }, dir)
    const again = await readBrands(dir)
    expect(again.brands.find((b) => b.id === 'brand-tc')?.voice).toBe('Calm.')
    expect(again.brands.find((b) => b.id === FIRST_BRAND_ID)?.name).toBe('Field Notes')
  })

  it('sets an unreadable list aside and falls back to brand.json, losing nothing', async () => {
    writeFileSync(join(dir, 'brand.json'), JSON.stringify(BRAND_0_2_13))
    writeFileSync(join(dir, 'brands.json'), '{"v":1,"brands":"not a list"')
    const list = await readBrands(dir)
    expect(list.brands[0].name).toBe('Field Notes')
    expect(readdirSync(dir).some((f) => f.startsWith('brands.json.unreadable-'))).toBe(true)
  })

  it('keeps the readable brands of a list where one does not read', async () => {
    writeFileSync(
      join(dir, 'brands.json'),
      JSON.stringify({ v: 1, default: 'b2', brands: [{ ...BRAND_0_2_13, id: 'b1' }, { id: 'b2', v: 7 }] })
    )
    const list = await readBrands(dir)
    expect(list.brands.map((b) => b.id)).toEqual(['b1'])
    expect(list.default).toBe('b1')
  })

  it('finds the brand an edit is made in, and the default for an edit from before', async () => {
    const list = await readBrands(dir)
    await saveBrands(addBrand(list, 'Tech Corner', 'brand-tc')!.list, dir)
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/a.mov', durationSec: 3, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hello.', startSec: 0.2, endSec: 0.6 }], 's1')
    })
    expect((await brandOfDoc(doc, dir)).id).toBe(FIRST_BRAND_ID)
    const switched = commit(doc, [{ op: 'brand', id: 'brand-tc' }], 'Tech Corner is on this edit now.').doc
    expect((await brandOfDoc(switched, dir)).name).toBe('Tech Corner')
    // A brand since deleted: the default.
    const gone = commit(doc, [{ op: 'brand', id: 'brand-gone' }], 'x').doc
    expect((await brandOfDoc(gone, dir)).id).toBe(FIRST_BRAND_ID)
  })
})
