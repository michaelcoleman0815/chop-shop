import { join } from 'path'
import { platform } from './platform'
import { BrandSchema, EMPTY_BRAND, type Brand } from '../shared/brand'

/**
 * The brand lives in one JSON file in userData, on this computer. A file that
 * no longer validates is set aside rather than overwritten, so nothing a
 * person built is lost to a bad write.
 */

const file = (): string => join(platform().paths.userData(), 'brand.json')

export async function readBrand(): Promise<Brand> {
  let raw: string
  try {
    raw = await platform().files.readText(file())
  } catch {
    return EMPTY_BRAND
  }
  const parsed = BrandSchema.safeParse(JSON.parse(raw))
  if (parsed.success) return parsed.data
  await platform()
    .files.rename(file(), `${file()}.unreadable-${Date.now()}`)
    .catch(() => undefined)
  return EMPTY_BRAND
}

export async function saveBrand(brand: unknown): Promise<{ ok: true; brand: Brand } | { ok: false; message: string }> {
  const parsed = BrandSchema.safeParse(brand)
  if (!parsed.success) return { ok: false, message: 'That brand is not in a shape I can save.' }
  const next: Brand = { ...parsed.data, updatedAt: new Date().toISOString() }
  const tmp = `${file()}.tmp`
  await platform().files.writeText(tmp, JSON.stringify(next, null, 2))
  await platform().files.rename(tmp, file())
  return { ok: true, brand: next }
}
