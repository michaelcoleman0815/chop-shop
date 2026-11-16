import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { BrandSchema, type Brand } from '../shared/brand'
import { brandById, brandOfCut, brandsFromLegacy, defaultBrand, parseBrands, type Brands } from '../shared/brands'
import { currentCut, type EditDoc } from '../shared/edit'

/**
 * The person's brands, in brands.json in userData, on this computer: one per
 * channel, and which is the default (shared/brands).
 *
 * Before there could be more than one, the brand lived alone in brand.json.
 * That file is read as the first brand of the list, as it was, until the list
 * is first saved; after that the default brand is also written back to it,
 * so a build from before still opens with the brand it knows. A file that no
 * longer validates is set aside rather than overwritten, so nothing a person
 * built is lost to a bad write.
 *
 * The folder is an argument so the tests can use these without Electron.
 */

const userData = (): string => app.getPath('userData')
const LIST = 'brands.json'
const SINGLE = 'brand.json'

async function readJson(path: string): Promise<{ found: false } | { found: true; value: unknown }> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
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
  fs.rename(path, `${path}.unreadable-${Date.now()}`).catch(() => undefined)

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

export async function readBrands(dir = userData()): Promise<Brands> {
  const file = join(dir, LIST)
  const read = await readJson(file)
  if (read.found) {
    const list = parseBrands(read.value)
    if (list) return list
    await setAside(file)
  }
  return brandsFromLegacy(await readSingle(dir))
}

let queue: Promise<unknown> = Promise.resolve()

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2))
  await fs.rename(tmp, path)
}

/**
 * Saves the whole list. A brand that changed is stamped with the time; the
 * default is written to brand.json as well, for builds from before.
 */
export function saveBrands(
  input: unknown,
  dir = userData()
): Promise<{ ok: true; brands: Brands } | { ok: false; message: string }> {
  const run = queue.then(async () => {
    const list = parseBrands(input)
    if (!list) return { ok: false as const, message: 'Those brands are not in a shape I can save.' }
    await fs.mkdir(dir, { recursive: true })
    const before = await readBrands(dir)
    const now = new Date().toISOString()
    const same = (a: Brand, b: Brand | undefined): boolean =>
      !!b && JSON.stringify({ ...a, updatedAt: '' }) === JSON.stringify({ ...b, updatedAt: '' })
    const next: Brands = {
      ...list,
      brands: list.brands.map((b) =>
        same(b, before.brands.find((x) => x.id === b.id)) ? b : { ...b, updatedAt: now }
      )
    }
    await writeAtomic(join(dir, LIST), next)
    await writeAtomic(join(dir, SINGLE), defaultBrand(next)).catch(() => undefined)
    return { ok: true as const, brands: next }
  })
  queue = run.catch(() => undefined)
  return run
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
