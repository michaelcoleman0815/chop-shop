import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { openExecutables } = createRequire(import.meta.url)('../../scripts/after-pack.cjs') as {
  openExecutables: (dir: string) => Promise<string[]>
}

/**
 * macOS's updater puts an update in place as root, so a program only its owner may run (ffprobe
 * ships as rwxr--r--) fails with EACCES after an update. The build makes every such program
 * runnable by everyone, and leaves files that are not programs alone.
 */
describe('the packed app’s programs', () => {
  let dir = ''
  afterEach(() => rm(dir, { recursive: true, force: true }))

  // Permission bits are the Mac's and Linux's: Windows keeps none, and the hook runs only for the Mac build.
  it.skipIf(process.platform === 'win32')('can be run by everyone, wherever they are, and nothing else changes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'after-pack-'))
    await mkdir(join(dir, 'node_modules', 'probe'), { recursive: true })
    const probe = join(dir, 'node_modules', 'probe', 'ffprobe')
    const open = join(dir, 'ffmpeg')
    const data = join(dir, 'package.json')
    await Promise.all([writeFile(probe, ''), writeFile(open, ''), writeFile(data, '{}')])
    await Promise.all([chmod(probe, 0o744), chmod(open, 0o755), chmod(data, 0o644)])

    expect(await openExecutables(dir)).toEqual([probe])
    expect((await stat(probe)).mode & 0o777).toBe(0o755)
    expect((await stat(open)).mode & 0o777).toBe(0o755)
    expect((await stat(data)).mode & 0o777).toBe(0o644)
  })

  it('finds nothing to do where there is no folder', async () => {
    dir = await mkdtemp(join(tmpdir(), 'after-pack-'))
    expect(await openExecutables(join(dir, 'missing'))).toEqual([])
  })
})
