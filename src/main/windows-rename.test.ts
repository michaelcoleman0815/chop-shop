import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { patchRenames, retryWhileBusy, retryWhileBusySync } from './windows-rename'

/**
 * A rename over a file something holds, which Windows refuses with EPERM,
 * EACCES or EBUSY until it is let go: tried again, a little later each time,
 * for up to ten seconds, and anything else fails as it would have.
 */

const held = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

describe('a rename while something holds the file', () => {
  it('is tried again, a little later each time, until the file is let go', async () => {
    const waits: number[] = []
    let tries = 0
    await retryWhileBusy(
      async () => {
        tries++
        if (tries === 1) throw held('EPERM')
        if (tries === 2) throw held('EBUSY')
        if (tries === 3) throw held('EACCES')
      },
      async (ms) => void waits.push(ms)
    )
    expect(tries).toBe(4)
    expect(waits).toEqual([10, 20, 30])
  })

  it('fails at once for anything else, and as it would have once ten seconds of waiting are up', async () => {
    let tries = 0
    const missing = Object.assign(new Error('ENOENT: no such file or directory, rename'), { code: 'ENOENT' })
    await expect(
      retryWhileBusy(
        async () => {
          tries++
          throw missing
        },
        async () => undefined
      )
    ).rejects.toBe(missing)
    expect(tries).toBe(1)

    const waits: number[] = []
    const busy = held('EPERM')
    await expect(
      retryWhileBusy(
        async () => {
          throw busy
        },
        async (ms) => void waits.push(ms)
      )
    ).rejects.toBe(busy)
    expect(waits.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000)
    expect(Math.max(...waits)).toBe(100)
  })

  it('waits the same way where it cannot use the event loop', () => {
    const waits: number[] = []
    let tries = 0
    retryWhileBusySync(
      () => {
        tries++
        if (tries < 3) throw held('EBUSY')
      },
      (ms) => void waits.push(ms)
    )
    expect(waits).toEqual([10, 20])
  })
})

describe('every rename in the process, on Windows', () => {
  const fs = createRequire(import.meta.url)('fs') as typeof import('fs') & { renamesWaitOutBusyFiles?: boolean }
  const dir = mkdtempSync(join(tmpdir(), 'cutalong-rename-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('is left alone elsewhere', () => {
    // The Windows-style run (CUTALONG_STAND_INS=node) has them changed already, as Windows does.
    if (fs.renamesWaitOutBusyFiles) return
    const before = [fs.rename, fs.renameSync, fs.promises.rename]
    patchRenames('darwin')
    patchRenames('linux')
    expect([fs.rename, fs.renameSync, fs.promises.rename]).toEqual(before)
  })

  it('still renames, over a file already there, and still fails at once for a file that is not', async () => {
    patchRenames('win32')
    expect(fs.renamesWaitOutBusyFiles).toBe(true)
    const to = join(dir, 'project.cutalong')
    writeFileSync(to, 'old')
    for (const [i, rename] of [
      (from: string) => fs.promises.rename(from, to),
      (from: string) => new Promise<void>((resolve, reject) => fs.rename(from, to, (err) => (err ? reject(err) : resolve()))),
      async (from: string) => fs.renameSync(from, to)
    ].entries()) {
      const from = join(dir, `project.cutalong.saving-${i}`)
      writeFileSync(from, `new ${i}`)
      await rename(from)
      expect(readFileSync(to, 'utf8')).toBe(`new ${i}`)
    }
    const started = Date.now()
    await expect(fs.promises.rename(join(dir, 'gone'), to)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(() => fs.renameSync(join(dir, 'gone'), to)).toThrow(/ENOENT/)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
