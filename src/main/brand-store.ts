import { join } from 'path'
import { platform } from './platform'
import { BrandSchema, type Brand } from '../shared/brand'
import {
  brandById,
  brandOfCut,
  brandsFromLegacy,
  checkBrands,
  defaultBrand,
  parseBrands,
  replaceBrand,
  unreadBrands,
  type Brands
} from '../shared/brands'
import { currentCut, type EditDoc } from '../shared/edit'

/**
 * The person's brands, in brands.json in userData, on this computer: one per
 * channel, and which is the default (shared/brands).
 *
 * Before there could be more than one, the brand lived alone in brand.json.
 * That file is read as the first brand of the list, as it was, until the list
 * is first saved; after that the default brand is also written back to it,
 * so a build from before still opens with the brand it knows. A build from
 * before saves that file without the brand's id, which marks what it wrote:
 * changes made there since this build last wrote it come back into the
 * default brand, and what that build does not know (the fonts, the B-roll
 * sources, the description) stays as it was. A file that no longer validates
 * is set aside rather than overwritten, so nothing a person built is lost to
 * a bad write, and a brand this build cannot read is kept as it is.
 *
 * The files go through the platform (platform.ts), so a phone keeps its
 * brands the same way; the folder is an argument for the tests.
 */

const userData = (): string => platform().paths.userData()
const LIST = 'brands.json'
const SINGLE = 'brand.json'

async function readJson(path: string): Promise<{ found: false } | { found: true; value: unknown }> {
  let raw: string
  try {
    raw = await platform().files.readText(path)
  } catch {
    return { found: false }
  }
  try {
    return { found: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { found: true, value: undefined }
  }
}

const setAside = (path: string): Promise<void> =>
  platform()
    .files.rename(path, `${path}.unreadable-${Date.now()}`)
    .catch(() => undefined)

/** The one brand from before there could be more than one, or null when there is none to read. */
async function readSingle(dir: string): Promise<Brand | null> {
  const file = join(dir, SINGLE)
  const read = await readJson(file)
  if (!read.found) return null
  const parsed = BrandSchema.safeParse(read.value)
  if (parsed.success) return parsed.data
  await setAside(file)
  return null
}

/**
 * brand.json as a build from before brands last saved it, when it did so
 * after this build last wrote it there: a brand with no id, newer than the
 * default brand it was written from. With the fields that build wrote.
 */
async function savedByOlder(dir: string, list: Brands): Promise<{ brand: Brand; fields: string[] } | null> {
  const read = await readJson(join(dir, SINGLE))
  if (!read.found || !read.value || typeof read.value !== 'object') return null
  const raw = read.value as Record<string, unknown>
  if (typeof raw.id === 'string' && raw.id) return null
  const parsed = BrandSchema.safeParse(raw)
  if (!parsed.success) return null
  if (!(parsed.data.updatedAt > defaultBrand(list).updatedAt)) return null
  return { brand: parsed.data, fields: Object.keys(raw).filter((k) => k !== 'id' && k in parsed.data) }
}

/** The list on disk; `folded` when brand.json holds changes an older build made, now in the default brand. */
async function readList(dir: string): Promise<{ list: Brands; unread: unknown[]; folded: boolean }> {
  const file = join(dir, LIST)
  const read = await readJson(file)
  if (read.found) {
    const list = parseBrands(read.value)
    if (list) {
      const unread = unreadBrands(read.value, list)
      const older = await savedByOlder(dir, list)
      if (!older) return { list, unread, folded: false }
      const target = defaultBrand(list)
      const changed = Object.fromEntries(older.fields.map((k) => [k, older.brand[k as keyof Brand]])) as Partial<Brand>
      return { list: replaceBrand(list, { ...target, ...changed, id: target.id }), unread, folded: true }
    }
    await setAside(file)
  }
  return { list: brandsFromLegacy(await readSingle(dir)), unread: [], folded: false }
}

let queue: Promise<unknown> = Promise.resolve()

/** Work on the files, one at a time, in the order asked. */
function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

export async function readBrands(dir = userData()): Promise<Brands> {
  const first = await readList(dir)
  if (!first.folded) return first.list
  // An older build's changes come in once, from the files as they are by the time it is this one's turn.
  return queued(async () => {
    const now = await readList(dir)
    if (now.folded) await writeList(dir, now.list, now.unread)
    return now.list
  })
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await platform().files.writeText(tmp, JSON.stringify(value, null, 2))
  await platform().files.rename(tmp, path)
}

/** The list, with any brand this build cannot read put back as it was, and the default for older builds. */
async function writeList(dir: string, list: Brands, unread: unknown[]): Promise<void> {
  await platform().files.mkdir(dir)
  await writeAtomic(join(dir, LIST), { ...list, brands: [...list.brands, ...unread] })
  await writeAtomic(join(dir, SINGLE), defaultBrand(list)).catch(() => undefined)
}

/**
 * Saves the whole list, or nothing: a brand that does not hold refuses the
 * save, saying which field (shared/brands checkBrands). A brand that changed
 * is stamped with the time; the default is written to brand.json as well,
 * for builds from before.
 */
export function saveBrands(
  input: unknown,
  dir = userData()
): Promise<{ ok: true; brands: Brands } | { ok: false; message: string }> {
  return queued(async () => {
    const checked = checkBrands(input)
    if (!checked.ok) return { ok: false as const, message: checked.message }
    const list = checked.brands
    const before = await readList(dir)
    const now = new Date().toISOString()
    const same = (a: Brand, b: Brand | undefined): boolean =>
      !!b && JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' })
    const next: Brands = {
      ...list,
      brands: list.brands.map((b) =>
        same(
          b,
          before.list.brands.find((x) => x.id === b.id)
        )
          ? b
          : { ...b, updatedAt: now }
      )
    }
    await writeList(dir, next, before.unread)
    return { ok: true as const, brands: next }
  })
}

/** The default brand: what a new chat uses. */
export async function readBrand(dir = userData()): Promise<Brand> {
  return defaultBrand(await readBrands(dir))
}

/** A brand by id; the default when there is none by that id. */
export async function readBrandById(id: string | null | undefined, dir = userData()): Promise<Brand> {
  return brandById(await readBrands(dir), id)
}

/** The brand an edit's current version is made in. */
export async function brandOfDoc(doc: Pick<EditDoc, 'versions'>, dir = userData()): Promise<Brand> {
  return brandOfCut(await readBrands(dir), currentCut(doc as EditDoc))
}

/**
 * One brand saved into the list, by its id; a brand with no id is the
 * default. For callers that hold a single brand, as everything did before.
 */
export async function saveBrand(
  brand: unknown,
  dir = userData()
): Promise<{ ok: true; brand: Brand } | { ok: false; message: string }> {
  const parsed = BrandSchema.safeParse(brand)
  if (!parsed.success) return { ok: false, message: 'That brand is not in a shape I can save.' }
  const list = await readBrands(dir)
  const id = parsed.data.id || list.default
  const r = await saveBrands(
    { ...list, brands: list.brands.map((b) => (b.id === id ? { ...parsed.data, id } : b)) },
    dir
  )
  return r.ok ? { ok: true, brand: brandById(r.brands, id) } : r
}
