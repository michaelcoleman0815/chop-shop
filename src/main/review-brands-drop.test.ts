import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { readBrands, saveBrands } from './brand-store'
import { EMPTY_BRAND, type Brand } from '../shared/brand'

/**
 * The renderer saves the whole list (useCutalong saveBrands -> brands:save)
 * on every brand edit. One brand in it that BrandSchema refuses refuses the
 * whole save, saying which brand and which field, and nothing on disk moves.
 */

const root = mkdtempSync(join(tmpdir(), 'review-brands-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const A: Brand = { ...EMPTY_BRAND, id: 'brand-1', name: 'Field Notes', voice: 'Warm.' }
const B: Brand = { ...EMPTY_BRAND, id: 'brand-x', name: 'Tech Corner', voice: 'Fast and dry.', products: ['Pixel 9 Pro'] }

describe('saveBrands with one brand the schema refuses', () => {
  it.each([
    // Brand page, Product logos: the name field (LogoName) keeps an empty name on the page, and
    // addProductLogo clamps a long file name; a list that gets here regardless is refused.
    ['a logo name cleared while retyping it', { logos: [{ name: '', path: '/Users/you/logo.png' }] }, "Tech Corner’s product logo name is empty"],
    [
      'a logo named after a long file name',
      { logos: [{ name: 'Tech Corner Logo Final Version 2026 High Resolution Transparent', path: '/l.png' }] },
      "Tech Corner’s product logo name is longer than 60 characters"
    ],
    // B-roll sources: SourceList keeps a line to 300 characters.
    [
      'a pasted B-roll source line over 300 characters',
      { broll: { prefer: ['https://www.google.com/url?q=' + 'x'.repeat(300)], block: [] } },
      "Tech Corner’s B-roll source to look in first is longer than 300 characters"
    ]
  ])('%s: the save is refused, saying which field, and the brand stays', async (_what, patch, said) => {
    const dir = mkdtempSync(join(root, 'case-'))
    expect((await saveBrands({ v: 1, default: 'brand-x', brands: [A, B] }, dir)).ok).toBe(true)
    const listBefore = readFileSync(join(dir, 'brands.json'), 'utf8')
    const singleBefore = readFileSync(join(dir, 'brand.json'), 'utf8')
    const edited = { ...B, ...patch } as Brand
    const r = await saveBrands({ v: 1, default: 'brand-x', brands: [A, edited] }, dir)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.message).toBe(`${said}, so I didn't save the change.`)
    // Nothing on disk moved: Tech Corner, its voice notes and products, and the default, as they were.
    expect(readFileSync(join(dir, 'brands.json'), 'utf8')).toBe(listBefore)
    expect(readFileSync(join(dir, 'brand.json'), 'utf8')).toBe(singleBefore)
    const after = await readBrands(dir)
    expect(after.brands.map((b) => b.id)).toEqual(['brand-1', 'brand-x'])
    expect(after.default).toBe('brand-x')
    expect(after.brands[1].products).toEqual(['Pixel 9 Pro'])
    expect(JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8')).id).toBe('brand-x')
  })

  it('refuses a list that names a default it does not hold, or a brand twice', async () => {
    const dir = mkdtempSync(join(root, 'list-'))
    expect((await saveBrands({ v: 1, default: 'brand-x', brands: [A, B] }, dir)).ok).toBe(true)
    const missing = await saveBrands({ v: 1, default: 'brand-gone', brands: [A, B] }, dir)
    expect(missing).toEqual({ ok: false, message: "The default brand is not on the list, so I didn't save the change." })
    const twice = await saveBrands({ v: 1, default: 'brand-1', brands: [A, { ...B, id: 'brand-1' }] }, dir)
    expect(twice.ok).toBe(false)
    expect((await readBrands(dir)).brands.map((b) => b.id)).toEqual(['brand-1', 'brand-x'])
  })

  it('keeps a brand this build cannot read when it saves the rest', async () => {
    const dir = mkdtempSync(join(root, 'newer-'))
    // A brand from a newer build: a field this one holds to less than that build does.
    const newer = { ...B, id: 'brand-n', name: 'Night Shift', fonts: { display: 'x'.repeat(90) } }
    writeFileSync(join(dir, 'brands.json'), JSON.stringify({ v: 1, default: 'brand-1', brands: [A, newer] }))
    const read = await readBrands(dir)
    expect(read.brands.map((b) => b.id)).toEqual(['brand-1'])
    const r = await saveBrands({ ...read, brands: [{ ...read.brands[0], voice: 'Warmer.' }] }, dir)
    expect(r.ok).toBe(true)
    const onDisk = JSON.parse(readFileSync(join(dir, 'brands.json'), 'utf8'))
    expect(onDisk.brands.map((b: Brand) => b.id)).toEqual(['brand-1', 'brand-n'])
    expect(onDisk.brands[0].voice).toBe('Warmer.')
    expect(onDisk.brands[1]).toEqual(newer)
  })
})
