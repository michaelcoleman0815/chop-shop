import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * A name in `dir` no other file has, taken by making the file empty there and
 * then: two exports started together, or two edits with the same title, each
 * get their own file instead of writing over one another.
 *
 * `beside` names the files that go next to it, by what follows the name
 * (" credits.txt", ".srt"). A name is only taken when none of those is there
 * either, so an export never writes over what an earlier one left beside it,
 * even when that earlier video has since been moved or deleted.
 */
export async function freePath(dir: string, name: string, ext: string, beside: string[] = []): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  for (let n = 1; ; n++) {
    const base = n === 1 ? name : `${name} (${n})`
    const taken = await Promise.all(
      beside.map((suffix) =>
        fs
          .access(join(dir, `${base}${suffix}`))
          .then(() => true)
          .catch(() => false)
      )
    )
    if (taken.some(Boolean)) continue
    const candidate = join(dir, `${base}${ext}`)
    try {
      await (await fs.open(candidate, 'wx')).close()
      return candidate
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
}

/** What goes beside an export: the path with its extension swapped for `suffix`. */
export function besidePath(outputPath: string, suffix: string): string {
  return outputPath.replace(/\.[^./\\]+$/, '') + suffix
}

/** Writes a file beside an export, never over one that is already there. False when one was. */
export async function writeBeside(path: string, text: string): Promise<boolean> {
  try {
    await fs.writeFile(path, text, { flag: 'wx' })
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}
