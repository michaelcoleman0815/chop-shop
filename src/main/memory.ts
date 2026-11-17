import { app, ipcMain } from 'electron'
import { join } from 'path'
import {
  MemoryChangeSchema,
  memoryView,
  neverEntriesOf,
  neverFor,
  neverRulesIn,
  plannerPreferences,
  SignalSchema,
  type MemoryView
} from '../shared/memory'
import { legacyBrandId } from '../shared/brands'
import { readBrands } from './brand-store'
import { MemoryStore } from './memory-store'
import { NeverStore } from './never-store'

/**
 * Learning from how someone edits in Cutalong: small signals in, plain
 * statements out, all in memory.json on this computer, each brand learning
 * from its own chats. The only place any of it goes is the planner's request
 * to Claude, which already carries the requests and notes these statements
 * are drawn from. Each brand's never list is kept beside it, in never.json
 * (main/never-store).
 */

let store: MemoryStore | null = null
const memory = (): MemoryStore => (store ??= new MemoryStore(join(app.getPath('userData'), 'memory.json')))
let rules: NeverStore | null = null
const never = (): NeverStore =>
  (rules ??= new NeverStore(join(app.getPath('userData'), 'never.json'), async () =>
    neverRulesIn(await memory().current())
  ))

/** The brands a view is for, and which owns what was noted before brands. */
async function viewBrands(): Promise<{ ids: string[]; legacy: string }> {
  const list = await readBrands()
  return { ids: list.brands.map((b) => b.id), legacy: legacyBrandId(list) }
}

async function view(): Promise<MemoryView> {
  const [m, brands, kept] = await Promise.all([memory().current(), viewBrands(), never().current()])
  return { ...memoryView(m, brands), never: neverEntriesOf(kept) }
}

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:get', (): Promise<MemoryView> => view())
  ipcMain.handle('memory:record', async (_e, signal: unknown): Promise<void> => {
    const parsed = SignalSchema.safeParse(signal)
    // A rule for the never list is a setting given, kept with the others, learning paused or not.
    if (parsed.success && parsed.data.kind === 'never') {
      const { kind: _kind, at, ...rule } = parsed.data
      await never().change([rule], at)
      return
    }
    await memory().record(signal)
  })
  ipcMain.handle('memory:update', async (_e, change: unknown): Promise<MemoryView> => {
    const parsed = MemoryChangeSchema.safeParse(change)
    const { never: given, ...rest } = parsed.success ? parsed.data : {}
    if (given?.length) await never().change(given)
    await memory().change(rest)
    return view()
  })
}

/** The strongest statements of a brand, read fresh for each request, so a deleted one never goes. */
export async function preferencesForPlanner(brand?: string): Promise<string[]> {
  const brands = await viewBrands()
  return plannerPreferences(await memory().current(), undefined, brand ? { id: brand, legacy: brands.legacy } : undefined)
}

/** A brand's never list (shared/never), read fresh for each request and export. */
export async function neverForBrand(brand: string): Promise<string[]> {
  return neverFor(neverEntriesOf(await never().current()), brand)
}
