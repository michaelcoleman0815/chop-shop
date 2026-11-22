import { dirname, join, resolve } from 'path'
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

const exists = async (path: string): Promise<boolean> => (await platform().files.stat(path)) !== null

/** What a copy into the export folder is called until it is whole: hidden, and never a name an export takes. */
const PARTIAL = '.cutalong-partial-'
/** A copy older than this was left by an app that quit partway through it. */
const STALE_MS = 60 * 60 * 1000
/** Why linking a file in fails when the folder is fine: another disk, or a disk without hard links (exFAT). */
const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'])

/**
 * Puts a finished file into `dir` under the first name freePath would give
 * it, without an empty or half-made file ever being there: the file is
 * linked in whole, so the name appears when the file is complete and not
 * before. From another disk, or onto one without hard links (a phone's
 * storage has none to offer), it is copied in whole first, under a hidden
 * name, and then put in place. Anything that stops the work before this, a
 * render killed partway or the app quitting, leaves nothing in `dir`.
 * Returns where the file went.
 */
export async function placeFile(
  file: string,
  dir: string,
  name: string,
  ext: string,
  beside: string[] = []
): Promise<string> {
  const files = platform().files
  await files.mkdir(dir)
  await sweepPartials(dir)
  /** The file at the first free name, or null when it has to be copied in first. */
  const place = async (from: string): Promise<string | null> => {
    for (let n = 1; ; n++) {
      const base = n === 1 ? name : `${name} (${n})`
      if ((await Promise.all(beside.map((suffix) => exists(join(dir, `${base}${suffix}`))))).some(Boolean)) continue
      const candidate = join(dir, `${base}${ext}`)
      try {
        await files.link(from, candidate)
        return candidate
      } catch (err) {
        const code = (err as { code?: string }).code ?? ''
        if (code === 'EEXIST') continue
        if (!NO_LINK.has(code)) throw err
      }
      if (resolve(dirname(from)) !== resolve(dir)) return null
      // A disk without hard links: the whole copy is renamed into the name while it is still free.
      if (await exists(candidate)) continue
      await files.rename(from, candidate)
      return candidate
    }
  }
  const linked = await place(file)
  if (linked) return linked
  const copy = join(dir, `${PARTIAL}${crypto.randomUUID()}${ext}`)
  try {
    await files.copy(file, copy)
    return (await place(copy)) as string
  } finally {
    await files.remove(copy).catch(() => undefined)
  }
}

/** Copies placeFile left half-made when the app quit during one, an hour on. */
async function sweepPartials(dir: string): Promise<void> {
  const files = platform().files
  const entries = await files.list(dir).catch(() => [])
  await Promise.all(
    entries
      .filter((e) => e.name.startsWith(PARTIAL))
      .map(async (e) => {
        const path = join(dir, e.name)
        const stat = await files.stat(path).catch(() => null)
        if (stat && Date.now() - stat.mtimeMs > STALE_MS) await files.remove(path).catch(() => undefined)
      })
  )
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
