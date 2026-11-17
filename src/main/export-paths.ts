import { join } from 'path'
import { platform } from './platform'

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
  const files = platform().files
  await files.mkdir(dir)
  for (let n = 1; ; n++) {
    const base = n === 1 ? name : `${name} (${n})`
    const taken = await Promise.all(
      beside.map(async (suffix) => (await files.stat(join(dir, `${base}${suffix}`))) !== null)
    )
    if (taken.some(Boolean)) continue
    const candidate = join(dir, `${base}${ext}`)
    if (await files.claim(candidate)) return candidate
  }
}

/** What goes beside an export: the path with its extension swapped for `suffix`. */
export function besidePath(outputPath: string, suffix: string): string {
  return outputPath.replace(/\.[^./\\]+$/, '') + suffix
}

/** Writes a file beside an export, never over one that is already there. False when one was. */
export async function writeBeside(path: string, text: string): Promise<boolean> {
  const files = platform().files
  if (!(await files.claim(path))) return false
  await files.writeText(path, text)
  return true
}
