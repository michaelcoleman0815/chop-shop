import { z } from 'zod'
import { BrandSchema, EMPTY_BRAND, type Brand } from './brand'
import type { Cut } from './edit/schema'

/**
 * A brand per channel. Someone with more than one channel keeps one brand
 * each: its name, logo, caption look, voice notes, graphics colours and
 * fonts, never list and B-roll sources. One is the default, which a new chat
 * uses until it is switched. An edit names the brand it is made in on each
 * version (Cut.brand), so switching is a version like any other and undo
 * brings the old brand back.
 *
 * Kept in brands.json beside the single brand.json that came before. The
 * brand saved there becomes the first of the list, as it was, with the id
 * FIRST_BRAND_ID. An edit saved before has no brand on its versions: it was
 * made in that brand, and stays in it whatever becomes the default, for as
 * long as the brand is on the list (brandOfCut). The renderer and the main
 * process both read an edit's brand this one way.
 */

/** The id the brand from before there could be more than one gets. */
export const FIRST_BRAND_ID = 'brand-1'
/** More than anyone runs channels. */
export const MAX_BRANDS = 12

export interface Brands {
  v: 1
  /** The brand a new chat uses. */
  default: string
  brands: Brand[]
}

/**
 * The file as written. Brands are read one by one, so one that no longer
 * reads is left out rather than losing the rest.
 */
const BrandsFileSchema = z.object({
  v: z.literal(1),
  default: z.string(),
  brands: z.array(z.unknown())
})

/** brands.json as this version reads it; null when it is not a list of brands at all. */
export function parseBrands(raw: unknown): Brands | null {
  const file = BrandsFileSchema.safeParse(raw)
  if (!file.success) return null
  const seen = new Set<string>()
  const brands: Brand[] = []
  for (const entry of file.data.brands) {
    const r = BrandSchema.safeParse(entry)
    if (!r.success || !r.data.id || seen.has(r.data.id)) continue
    seen.add(r.data.id)
    brands.push(r.data)
  }
  if (brands.length === 0) return null
  const fallback = brands[0].id
  return { v: 1, default: seen.has(file.data.default) ? file.data.default : fallback, brands: brands.slice(0, MAX_BRANDS) }
}

/**
 * The entries of brands.json this version cannot read (from a newer build,
 * or damaged), as they are, so a save puts them back rather than losing them.
 */
export function unreadBrands(raw: unknown, readable: Brands): unknown[] {
  const file = BrandsFileSchema.safeParse(raw)
  if (!file.success) return []
  const ids = new Set(readable.brands.map((b) => b.id))
  return file.data.brands.filter((entry) => {
    const r = BrandSchema.safeParse(entry)
    if (r.success) return false
    const id = (entry as { id?: unknown } | null)?.id
    return typeof id === 'string' && id !== '' && !ids.has(id)
  })
}

/** A brand's fields as the Brand page names them, for saying which one could not be saved. */
const FIELDS: [RegExp, string][] = [
  [/^name$/, 'name'],
  [/^logos\.\d+\.name$/, 'product logo name'],
  [/^logos\.\d+\.path$/, 'product logo file'],
  [/^logos$/, 'list of product logos'],
  [/^broll\.prefer\.\d+$/, 'B-roll source to look in first'],
  [/^broll\.block\.\d+$/, 'B-roll source never to use'],
  [/^broll\.prefer$/, 'list of B-roll sources to look in first'],
  [/^broll\.block$/, 'list of B-roll sources never to use'],
  [/^description$/, 'description'],
  [/^fonts\.display$/, 'display font'],
  [/^fonts\.body$/, 'body font'],
  [/^colors\./, 'colours'],
  [/^logo\b/, 'logo'],
  [/^captions\./, 'caption settings'],
  [/^voice$/, 'voice notes'],
  [/^products/, 'names to listen for'],
  [/^habits/, 'habits'],
  [/^id$/, 'id']
]

/** What is wrong with a field, from the schema's issue. */
function problem(issue: z.core.$ZodIssue): string {
  if (issue.code === 'too_big') {
    const max = Number(issue.maximum)
    return issue.origin === 'string' ? `is longer than ${max} characters` : `has more than ${max}`
  }
  if (issue.code === 'too_small') return issue.origin === 'string' ? 'is empty' : 'has too few'
  return "isn't something I can save"
}

export type BrandsCheck = { ok: true; brands: Brands } | { ok: false; message: string; field: string }

/**
 * A list of brands to save, held to the schema as a whole: one brand that does
 * not hold refuses the save, saying which brand and which field, and nothing
 * on the list is ever left out to make it fit.
 */
export function checkBrands(raw: unknown): BrandsCheck {
  const refuse = (field: string, message: string): BrandsCheck => ({
    ok: false,
    field,
    message: `${message}, so I didn't save the change.`
  })
  const file = BrandsFileSchema.safeParse(raw)
  if (!file.success) return refuse('brands', 'Those brands are not in a shape I can save')
  if (file.data.brands.length === 0) return refuse('brands', 'There are no brands to save')
  if (file.data.brands.length > MAX_BRANDS) return refuse('brands', `That is more than the ${MAX_BRANDS} brands Cutalong keeps`)
  const brands: Brand[] = []
  for (const entry of file.data.brands) {
    const named = (entry as { name?: unknown } | null)?.name
    const owner = typeof named === 'string' && named.trim() ? `${named.trim()}’s` : 'An untitled brand’s'
    const r = BrandSchema.safeParse(entry)
    if (!r.success) {
      const issue = r.error.issues[0]
      const path = issue.path.map(String).join('.')
      const field = FIELDS.find(([re]) => re.test(path))?.[1] ?? (path || 'brand')
      return refuse(`${brands.length}.${path}`, `${owner} ${field} ${problem(issue)}`)
    }
    if (!r.data.id) return refuse(`${brands.length}.id`, `${owner} id is empty`)
    if (brands.some((b) => b.id === r.data.id)) return refuse(`${brands.length}.id`, `Two brands have the same id`)
    brands.push(r.data)
  }
  if (!brands.some((b) => b.id === file.data.default)) return refuse('default', 'The default brand is not on the list')
  return { ok: true, brands: { v: 1, default: file.data.default, brands } }
}

/** The list a person had before there could be more than one brand: theirs, as it was, or an empty one. */
export function brandsFromLegacy(brand: Brand | null): Brands {
  const first: Brand = { ...(brand ?? EMPTY_BRAND), id: FIRST_BRAND_ID }
  return { v: 1, default: FIRST_BRAND_ID, brands: [first] }
}

export const EMPTY_BRANDS: Brands = brandsFromLegacy(null)

export function defaultBrand(list: Brands): Brand {
  return list.brands.find((b) => b.id === list.default) ?? list.brands[0] ?? { ...EMPTY_BRAND, id: FIRST_BRAND_ID }
}

/** A brand by id, or the default when there is no such brand (it was deleted, or none was named). */
export function brandById(list: Brands, id: string | null | undefined): Brand {
  return (id ? list.brands.find((b) => b.id === id) : undefined) ?? defaultBrand(list)
}

/**
 * The brand an edit from before there could be more than one is made in:
 * the first brand, while it is on the list, else the default.
 */
export function legacyBrandId(list: Brands): string {
  return list.brands.some((b) => b.id === FIRST_BRAND_ID) ? FIRST_BRAND_ID : defaultBrand(list).id
}

/**
 * The brand a version is made in: the one it names; for a version that names
 * none (saved before there could be more than one brand), the brand from
 * then (legacyBrandId); and the default for a brand that has gone.
 */
export function brandOfCut(list: Brands, cut: Pick<Cut, 'brand'>): Brand {
  return brandById(list, cut.brand ?? legacyBrandId(list))
}

/**
 * The brand a chat is in: its edit's, as brandOfCut reads it, the same as an
 * export or a plan of that edit; with no edit yet, the one chosen for the
 * chat, else the default.
 */
export function chatBrand(list: Brands, cut: Pick<Cut, 'brand'> | null, chosen: string | null | undefined): Brand {
  return cut ? brandOfCut(list, cut) : brandById(list, chosen ?? null)
}

/** What a brand is called on screen. */
export function brandName(brand: Pick<Brand, 'name'>): string {
  return brand.name.trim() || 'Untitled brand'
}

/** A brand's name in a sentence: "Field Notes", or "this brand" when it has none. */
export function brandInSentence(brand: Pick<Brand, 'name'>): string {
  return brand.name.trim() || 'this brand'
}

/**
 * A new, empty brand on the list, under an id no other brand has. It starts
 * as a fresh brand does: on by default for new edits, with nothing learned.
 */
export function addBrand(list: Brands, name: string, id: string): { list: Brands; brand: Brand } | null {
  if (list.brands.length >= MAX_BRANDS) return null
  let unique = id
  for (let n = 2; list.brands.some((b) => b.id === unique); n++) unique = `${id}-${n}`
  const brand: Brand = { ...EMPTY_BRAND, id: unique, name: name.trim().slice(0, 80) }
  return { list: { ...list, brands: [...list.brands, brand] }, brand }
}

/** A brand changed in place, by its id. */
export function replaceBrand(list: Brands, brand: Brand): Brands {
  if (!list.brands.some((b) => b.id === brand.id)) return list
  return { ...list, brands: list.brands.map((b) => (b.id === brand.id ? brand : b)) }
}

/** The list without a brand. The last one stays; the default moves to the first left when it goes. */
export function removeBrand(list: Brands, id: string): Brands {
  if (list.brands.length <= 1 || !list.brands.some((b) => b.id === id)) return list
  const brands = list.brands.filter((b) => b.id !== id)
  return { ...list, brands, default: list.default === id ? brands[0].id : list.default }
}

export function setDefaultBrand(list: Brands, id: string): Brands {
  return list.brands.some((b) => b.id === id) ? { ...list, default: id } : list
}

/**
 * A new edit made in a brand: its first version names it, so the edit stays
 * in that brand whatever becomes the default later. An edit with more than
 * one version, or one that names a brand already, is left as it is.
 */
export function stampBrand<T extends { versions: { cut: Pick<Cut, 'brand'> }[] }>(doc: T, id: string): T {
  if (doc.versions.length !== 1 || doc.versions[0].cut.brand) return doc
  const [first] = doc.versions
  return { ...doc, versions: [{ ...first, cut: { ...first.cut, brand: id } }] }
}

/**
 * An edit made in one go, with the versions it came with (a vlog, a
 * /clipping clip), made in a brand: every one of them names it. Only for an
 * edit just made; one that names a brand already is left as it is.
 */
export function stampMade<T extends { versions: { cut: Pick<Cut, 'brand'> }[] }>(doc: T, id: string): T {
  if (doc.versions.some((v) => v.cut.brand)) return doc
  return { ...doc, versions: doc.versions.map((v) => ({ ...v, cut: { ...v.cut, brand: id } })) }
}
