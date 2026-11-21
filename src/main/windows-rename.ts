import type { PathLike } from 'fs'

/**
 * Windows will not rename a file over one that anything has open, nor rename
 * a file a scanner is still reading after it was written. A save that writes
 * a file whole beside the old one and renames it over (projects, presets,
 * brands, caches, downloads) fails there with EPERM, EACCES or EBUSY while a
 * reader, the search indexer, an antivirus scan or a sync client holds
 * either file. Such holds last milliseconds, so on Windows a rename is tried
 * again, a little later each time, for up to ten seconds (graceful-fs, which
 * npm uses, retries for the same reason). Elsewhere nothing changes.
 *
 * patchRenames() does it for every rename in the process: the main process
 * calls it first thing (index.ts), and the tests on Windows (test-setup.ts).
 */

/** What Windows says while something holds a file. */
const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** How long a rename waits out a busy file before it fails as it would have. */
export const BUSY_LIMIT_MS = 10_000

const isBusy = (err: unknown): boolean => BUSY.has((err as NodeJS.ErrnoException | null)?.code ?? '')
/** The next wait: 10 ms, then 10 ms longer each time, to at most 100 ms. */
const next = (wait: number): number => Math.min(100, wait + 10)

/** Runs a rename, and again while the file is busy. */
export async function retryWhileBusy(
  rename: () => Promise<void>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  limitMs = BUSY_LIMIT_MS
): Promise<void> {
  for (let waited = 0, wait = 10; ; wait = next(wait)) {
    try {
      return await rename()
    } catch (err) {
      if (!isBusy(err) || waited >= limitMs) throw err
      await sleep(wait)
      waited += wait
    }
  }
}

/** The same, for a rename that cannot wait for the event loop. */
export function retryWhileBusySync(
  rename: () => void,
  sleep: (ms: number) => void = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  limitMs = BUSY_LIMIT_MS
): void {
  for (let waited = 0, wait = 10; ; wait = next(wait)) {
    try {
      return rename()
    } catch (err) {
      if (!isBusy(err) || waited >= limitMs) throw err
      sleep(wait)
      waited += wait
    }
  }
}

type Done = (err: NodeJS.ErrnoException | null) => void

/** The renames of the fs module, as this file replaces them. */
interface Renames {
  rename: (from: PathLike, to: PathLike, done: Done) => void
  renameSync: (from: PathLike, to: PathLike) => void
  promises: { rename: (from: PathLike, to: PathLike) => Promise<void> }
  renamesWaitOutBusyFiles?: boolean
}

/** Makes every rename in this process wait out a busy file, on Windows only. */
export function patchRenames(platform: string = process.platform): void {
  if (platform !== 'win32') return
  // The module itself, which every import of fs shares, rather than a copy of its exports.
  const fs = require('fs') as Renames
  if (fs.renamesWaitOutBusyFiles) return
  const promised = fs.promises.rename
  fs.promises.rename = (from, to) => retryWhileBusy(() => promised(from, to))
  const callback = fs.rename
  fs.rename = (from, to, done) => {
    const once = (): Promise<void> =>
      new Promise((resolve, reject) => callback(from, to, (err) => (err ? reject(err) : resolve())))
    retryWhileBusy(once).then(
      () => done(null),
      (err: NodeJS.ErrnoException) => done(err)
    )
  }
  const sync = fs.renameSync
  fs.renameSync = (from, to) => retryWhileBusySync(() => sync(from, to))
  fs.renamesWaitOutBusyFiles = true
  // Modules that imported a rename by name see the same functions.
  ;(require('module') as { syncBuiltinESMExports: () => void }).syncBuiltinESMExports()
}
