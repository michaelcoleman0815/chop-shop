import { promises as fs, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeFile } from './export-paths'

/**
 * A finished export put into the export folder: under the first name free of
 * it and of what goes beside it, whole, and never as an empty or half-copied
 * file under that name, from this disk, from another, or onto one that has
 * no hard links.
 */

let root = ''
let work = ''
let out = ''
const made = (name: string, text: string): string => {
  const path = join(work, name)
  writeFileSync(path, text)
  return path
}
const fsError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cutalong-place-'))
  work = join(root, 'work')
  out = join(root, 'Exports')
  return fs.mkdir(work, { recursive: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

describe('placing a finished export', () => {
  it('takes the first name free of it and of what goes beside it', async () => {
    const a = await placeFile(made('a.mp4', 'first'), out, 'My talk v1', '.mp4', [' credits.txt'])
    const b = await placeFile(made('b.mp4', 'second'), out, 'My talk v1', '.mp4', [' credits.txt'])
    // A name an earlier export left something beside is not free either.
    writeFileSync(join(out, 'My talk v1 (3) credits.txt'), 'credits')
    const c = await placeFile(made('c.mp4', 'third'), out, 'My talk v1', '.mp4', [' credits.txt'])
    expect([a, b, c].map((p) => p.split('/').pop())).toEqual(['My talk v1.mp4', 'My talk v1 (2).mp4', 'My talk v1 (4).mp4'])
    expect(readFileSync(c, 'utf8')).toBe('third')
  })

  it('copies a file from another disk in whole first, and leaves no copy behind', async () => {
    // The first link is from the work folder, on another disk; the copy beside the exports links in.
    vi.spyOn(fs, 'link').mockImplementationOnce(async () => {
      throw fsError('EXDEV')
    })
    const placed = await placeFile(made('export.mp4', 'the whole video'), out, 'Clip', '.mp4')
    expect(placed).toBe(join(out, 'Clip.mp4'))
    expect(readFileSync(placed, 'utf8')).toBe('the whole video')
    expect(readdirSync(out)).toEqual(['Clip.mp4'])
  })

  it('moves the whole copy into its name on a disk with no hard links', async () => {
    vi.spyOn(fs, 'link').mockImplementation(async () => {
      throw fsError('EPERM')
    })
    await fs.mkdir(out, { recursive: true })
    writeFileSync(join(out, 'Clip.mp4'), 'an earlier one')
    const placed = await placeFile(made('export.mp4', 'the whole video'), out, 'Clip', '.mp4')
    expect(placed).toBe(join(out, 'Clip (2).mp4'))
    expect(readFileSync(placed, 'utf8')).toBe('the whole video')
    expect(readFileSync(join(out, 'Clip.mp4'), 'utf8')).toBe('an earlier one')
    expect(readdirSync(out).sort()).toEqual(['Clip (2).mp4', 'Clip.mp4'])
  })

  it('clears a half-made copy an app that quit left an hour ago, and not one being made now', async () => {
    await fs.mkdir(out, { recursive: true })
    const old = join(out, '.cutalong-partial-left.mp4')
    const now = join(out, '.cutalong-partial-copying.mp4')
    writeFileSync(old, 'half')
    writeFileSync(now, 'half')
    const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000
    utimesSync(old, twoHoursAgo, twoHoursAgo)
    await placeFile(made('export.mp4', 'video'), out, 'Clip', '.mp4')
    expect(readdirSync(out).sort()).toEqual(['.cutalong-partial-copying.mp4', 'Clip.mp4'])
  })
})
