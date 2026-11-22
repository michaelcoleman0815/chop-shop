import { promises as fs } from 'fs'
import { join } from 'path'
import { LabelledPairSchema, type LabelledPair } from '../shared/learn/schema'

/**
 * The test set: one small JSON file per learned video, in a folder in
 * userData. Labels and metadata only; the footage stays where it is, named
 * by its path. A file that no longer reads is skipped rather than breaking
 * the list, and kept, so nothing is lost to a bad write.
 *
 * Takes the folder as an argument so the tests and the command-line check
 * can use it without Electron.
 */

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

export async function readPairs(dir: string): Promise<LabelledPair[]> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const pairs: LabelledPair[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    try {
      const parsed = LabelledPairSchema.safeParse(JSON.parse(await fs.readFile(join(dir, name), 'utf8')))
      if (parsed.success) pairs.push(parsed.data)
    } catch {
      // Unreadable: skipped, left in place.
    }
  }
  return pairs
}

export async function savePair(dir: string, pair: LabelledPair): Promise<void> {
  if (!SAFE_ID.test(pair.id)) throw new Error('That video has no id I can save under.')
  const parsed = LabelledPairSchema.parse(pair)
  await fs.mkdir(dir, { recursive: true })
  const file = join(dir, `${pair.id}.json`)
  // Written beside the real file and renamed over it, so a crash mid-write
  // leaves the old file rather than half of a new one.
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(parsed))
  await fs.rename(tmp, file)
}

export async function removePair(dir: string, id: string): Promise<void> {
  if (!SAFE_ID.test(id)) return
  await fs.rm(join(dir, `${id}.json`), { force: true })
}
