import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Clears working directories left by a previous run.
 *
 * Every temp directory is removed in a `finally`, which a killed process never
 * reaches. Each abandoned one holds the extracted audio of a whole recording,
 * so a few interrupted analyses can cost gigabytes that nothing will ever
 * reclaim. Anything older than the current launch belongs to a dead process.
 */
export async function sweepTemp(): Promise<void> {
  const temp = app.getPath('temp')
  let names: string[]
  try {
    names = await fs.readdir(temp)
  } catch {
    return
  }

  let freed = 0
  for (const name of names) {
    if (!name.startsWith('chopshop-')) continue
    const dir = join(temp, name)
    try {
      for (const file of await fs.readdir(dir)) {
        freed += (await fs.stat(join(dir, file))).size
      }
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      // A directory still held by a running copy of the app stays put.
    }
  }
  if (freed > 0) console.log('[temp] reclaimed', Math.round(freed / 1e6), 'MB')
}
