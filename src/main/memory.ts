import { app, ipcMain } from 'electron'
import { join } from 'path'
import {
  MemoryChangeSchema,
  memoryView,
  neverEntries,
  neverFor,
  plannerPreferences,
  type MemoryView
} from '../shared/memory'
import { MemoryStore } from './memory-store'

/**
 * Learning from how someone edits in Cutalong: small signals in, plain
 * statements out, all in memory.json on this computer. The only place any of
 * it goes is the planner's request to Claude, which already carries the
 * requests and notes these statements are drawn from.
 */

let store: MemoryStore | null = null
const memory = (): MemoryStore => (store ??= new MemoryStore(join(app.getPath('userData'), 'memory.json')))

export function registerMemoryIpc(): void {
  ipcMain.handle('memory:get', async (): Promise<MemoryView> => memoryView(await memory().current()))
  ipcMain.handle('memory:record', async (_e, signal: unknown): Promise<void> => {
    await memory().record(signal)
  })
  ipcMain.handle('memory:update', async (_e, change: unknown): Promise<MemoryView> => {
    const parsed = MemoryChangeSchema.safeParse(change)
    return memoryView(await memory().change(parsed.success ? parsed.data : {}))
  })
}

/** The strongest statements, read fresh for each request, so a deleted one never goes. */
export async function preferencesForPlanner(): Promise<string[]> {
  return plannerPreferences(await memory().current())
}

/** A brand's never list (shared/never), read fresh for each request and export. */
export async function neverForBrand(brand: string): Promise<string[]> {
  return neverFor(neverEntries(await memory().current()), brand)
}
