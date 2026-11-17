import { randomUUID } from 'crypto'
import { constants as fsConstants, promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'

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

const exists = (path: string): Promise<boolean> =>
  fs
    .access(path)
    .then(() => true)
    .catch(() => false)

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
 * before. From another disk, or onto one without hard links, it is copied in
 * whole first, under a hidden name, and then put in place. Anything that
 * stops the work before this, a render killed partway or the app quitting,
 * leaves nothing in `dir`. Returns where the file went.
 */
export async function placeFile(
  file: string,
  dir: string,
  name: string,
  ext: string,
  beside: string[] = []
): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await sweepPartials(dir)
  /** The file at the first free name, or null when it has to be copied in first. */
  const place = async (from: string): Promise<string | null> => {
    for (let n = 1; ; n++) {
      const base = n === 1 ? name : `${name} (${n})`
      if ((await Promise.all(beside.map((suffix) => exists(join(dir, `${base}${suffix}`))))).some(Boolean)) continue
      const candidate = join(dir, `${base}${ext}`)
      try {
        await fs.link(from, candidate)
        return candidate
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? ''
        if (code === 'EEXIST') continue
        if (!NO_LINK.has(code)) throw err
      }
      if (resolve(dirname(from)) !== resolve(dir)) return null
      // A disk without hard links: the whole copy is renamed into the name while it is still free.
      if (await exists(candidate)) continue
      await fs.rename(from, candidate)
      return candidate
    }
  }
  const linked = await place(file)
  if (linked) return linked
  const copy = join(dir, `${PARTIAL}${randomUUID()}${ext}`)
  try {
    await fs.copyFile(file, copy, fsConstants.COPYFILE_EXCL)
    return (await place(copy)) as string
  } finally {
    await fs.rm(copy, { force: true }).catch(() => undefined)
  }
}

/** Copies placeFile left half-made when the app quit during one, an hour on. */
async function sweepPartials(dir: string): Promise<void> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(
    names
      .filter((n) => n.startsWith(PARTIAL))
      .map(async (n) => {
        const path = join(dir, n)
        const stat = await fs.stat(path).catch(() => null)
        if (stat && Date.now() - stat.mtimeMs > STALE_MS) await fs.rm(path, { force: true }).catch(() => undefined)
      })
  )
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
