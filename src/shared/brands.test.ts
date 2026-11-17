import { describe, expect, it } from 'vitest'
import { BrandSchema, EMPTY_BRAND } from './brand'
import {
  addBrand,
  brandById,
  brandName,
  brandsFromLegacy,
  chatBrand,
  defaultBrand,
  FIRST_BRAND_ID,
  MAX_BRANDS,
  parseBrands,
  removeBrand,
  replaceBrand,
  setDefaultBrand,
  stampBrand,
  stampMade
} from './brands'
import { commit, createDoc, currentCut, restore, undoTarget, wordsFromTranscript } from './edit'

const legacy = BrandSchema.parse({ ...EMPTY_BRAND, id: undefined, name: 'Field Notes', voice: 'Warm.' })

describe('a brand per channel', () => {
  it('makes the brand from before the first, as it was', () => {
    const list = brandsFromLegacy(legacy)
    expect(list.default).toBe(FIRST_BRAND_ID)
    expect(list.brands).toEqual([{ ...legacy, id: FIRST_BRAND_ID }])
  })

  it('adds, renames, makes default and removes, keeping one', () => {
    let list = brandsFromLegacy(legacy)
    const made = addBrand(list, ' Tech Corner ', 'brand-tc')!
    list = made.list
    expect(made.brand).toMatchObject({ id: 'brand-tc', name: 'Tech Corner', autoApply: true, videos: [] })
    // Ids stay unique.
    expect(addBrand(list, 'Again', 'brand-tc')!.brand.id).toBe('brand-tc-2')
    list = setDefaultBrand(list, 'brand-tc')
    expect(defaultBrand(list).name).toBe('Tech Corner')
    list = replaceBrand(list, { ...made.brand, voice: 'Calm.' })
    expect(brandById(list, 'brand-tc').voice).toBe('Calm.')
    list = removeBrand(list, 'brand-tc')
    expect(list.default).toBe(FIRST_BRAND_ID)
    expect(removeBrand(list, FIRST_BRAND_ID)).toBe(list)
    let full = brandsFromLegacy(legacy)
    for (let i = 1; i < MAX_BRANDS; i++) full = addBrand(full, `B${i}`, `b${i}`)!.list
    expect(addBrand(full, 'One too many', 'x')).toBeNull()
  })

  it('reads a list with a missing default or a brand it cannot read', () => {
    const list = parseBrands({ v: 1, default: 'nope', brands: [{ ...legacy, id: 'a' }, { ...legacy, id: 'a' }, 'x'] })
    expect(list?.brands.map((b) => b.id)).toEqual(['a'])
    expect(list?.default).toBe('a')
    expect(parseBrands({ v: 1, default: 'a', brands: [] })).toBeNull()
    expect(parseBrands('nonsense')).toBeNull()
  })

  it('finds the brand a chat is in: its edit’s, the chat’s choice, or the default', () => {
    let list = addBrand(brandsFromLegacy(legacy), 'Tech Corner', 'brand-tc')!.list
    expect(chatBrand(list, null, null).id).toBe(FIRST_BRAND_ID)
    expect(chatBrand(list, null, 'brand-tc').id).toBe('brand-tc')
    expect(chatBrand(list, { brand: FIRST_BRAND_ID }, 'brand-tc').id).toBe(FIRST_BRAND_ID)
    expect(chatBrand(list, {}, 'gone').id).toBe(FIRST_BRAND_ID)
    list = setDefaultBrand(list, 'brand-tc')
    // An edit from before names no brand: it stays in the brand from then, whichever is the default now.
    expect(chatBrand(list, {}, null).id).toBe(FIRST_BRAND_ID)
    // With an edit, the chat is in the edit's brand, as an export of it is, whatever was chosen.
    expect(chatBrand(list, {}, 'brand-tc').id).toBe(FIRST_BRAND_ID)
    // A new chat is in the default.
    expect(chatBrand(list, null, null).id).toBe('brand-tc')
    expect(brandName({ name: '  ' })).toBe('Untitled brand')
  })

  it('makes a new edit in a brand, and leaves one under way alone', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/a.mov', durationSec: 3, width: 10, height: 10, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hi.', startSec: 0.1, endSec: 0.4 }], 's1')
    })
    const stamped = stampBrand(doc, 'brand-tc')
    expect(currentCut(stamped).brand).toBe('brand-tc')
    expect(stampBrand(stamped, 'other')).toBe(stamped)
    const later = commit(doc, [{ op: 'aspect', aspect: 'vertical' }], 'v2').doc
    expect(stampBrand(later, 'brand-tc')).toBe(later)
  })

  it('makes a vlog or a clip, made in one go, in a brand on every version it came with', () => {
    const made = commit(
      createDoc({
        id: 'd',
        title: 't',
        source: { id: 's1', path: '/a.mov', durationSec: 3, width: 10, height: 10, fps: 30 },
        words: wordsFromTranscript([{ text: 'Hi.', startSec: 0.1, endSec: 0.4 }], 's1')
      }),
      [{ op: 'aspect', aspect: 'vertical' }],
      'A finished short.'
    ).doc
    expect(stampBrand(made, 'brand-tc')).toBe(made)
    const stamped = stampMade(made, 'brand-tc')
    expect(stamped.versions.map((v) => v.cut.brand)).toEqual(['brand-tc', 'brand-tc'])
    expect(stampMade(stamped, 'other')).toBe(stamped)
  })

  it('switches an edit’s brand as a version, and undo brings the old one back', () => {
    const doc = stampBrand(
      createDoc({
        id: 'd',
        title: 't',
        source: { id: 's1', path: '/a.mov', durationSec: 3, width: 10, height: 10, fps: 30 },
        words: wordsFromTranscript([{ text: 'Hi.', startSec: 0.1, endSec: 0.4 }], 's1')
      }),
      FIRST_BRAND_ID
    )
    const switched = commit(doc, [{ op: 'brand', id: 'brand-tc' }], 'Tech Corner is on this edit now.').doc
    expect(currentCut(switched).brand).toBe('brand-tc')
    // The brand is on the cut; the op that set it is not kept, so an older build reads the edit.
    expect(switched.versions[1].ops).toEqual([])
    expect(switched.versions[0].cut.brand).toBe(FIRST_BRAND_ID)
    expect(currentCut(restore(switched, undoTarget(switched)!)).brand).toBe(FIRST_BRAND_ID)
  })
})
