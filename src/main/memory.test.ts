import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { app, ipcMain } from 'electron'
import type { MemoryView } from '../shared/memory'
import { preferencesForPlanner, registerMemoryIpc } from './memory'

/**
 * The memory as the app runs it: signals in through IPC, statements out to
 * the planner, the file in userData. Electron itself is stood in for.
 */

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { handle: vi.fn() } }))

const dir = mkdtempSync(join(tmpdir(), 'cutalong-memory-ipc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
vi.mocked(app.getPath).mockReturnValue(dir)
registerMemoryIpc()

type Handler = (e: unknown, arg?: unknown) => Promise<unknown>
const handler = (channel: string): Handler => {
  const found = vi.mocked(ipcMain.handle).mock.calls.find(([c]) => c === channel)
  if (!found) throw new Error(`No handler for ${channel}`)
  return found[1] as Handler
}
const record = (signal: unknown): Promise<unknown> => handler('memory:record')({}, signal)
const update = (change: unknown): Promise<MemoryView> => handler('memory:update')({}, change) as Promise<MemoryView>
const view = (): Promise<MemoryView> => handler('memory:get')({}) as Promise<MemoryView>

let second = 0
const ask = (doc: string, text: string): unknown => ({
  kind: 'request',
  at: new Date(Date.parse('2026-11-02T10:00:00.000Z') + ++second * 1000).toISOString(),
  doc,
  text,
  version: 2,
  tags: []
})

describe('the memory in the app', () => {
  it('learns from requests, and stops sending a statement the moment it is deleted', async () => {
    await record(ask('a', 'too fast'))
    await record(ask('b', 'too fast, slow it down'))
    expect(await preferencesForPlanner()).toEqual(['You like a slower pace (2 times)'])
    // Deleted and planned at once, without waiting for the page: the planner still never sees it.
    const deleting = update({ forget: 'pace:slower' })
    expect(await preferencesForPlanner()).toEqual([])
    expect((await deleting).learned).toEqual([])
    // And it is not learned back.
    await record(ask('c', 'too fast'))
    await record(ask('d', 'too fast'))
    expect(await preferencesForPlanner()).toEqual([])
  })

  it('notes nothing while paused', async () => {
    const before = (await view()).signals
    expect((await update({ paused: true })).paused).toBe(true)
    await record(ask('e', 'keep the laugh'))
    await record(ask('f', 'keep the laugh'))
    expect((await view()).signals).toBe(before)
    expect(await preferencesForPlanner()).toEqual([])
    await update({ paused: false })
    await record(ask('g', 'keep the laugh'))
    expect((await view()).signals).toBe(before + 1)
  })

  it('ignores what it cannot read, and keeps one small file in userData', async () => {
    const before = await view()
    await record({ kind: 'request', text: 'no time or doc' })
    await record('not a signal')
    expect(await update({ edit: { id: 'x', text: 42 } })).toEqual(before)
    expect((await view()).signals).toBe(before.signals)
    expect(readdirSync(dir)).toEqual(['memory.json'])
    const file = JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8'))
    expect(file.v).toBe(1)
    expect(file.deleted).toEqual(['pace:slower'])
  })
})

describe('what leaves this computer', () => {
  it('nothing in the memory code reaches the network; only the planner request carries the statements', () => {
    const root = join(__dirname, '..')
    const files = [
      ...readdirSync(join(root, 'shared/memory'))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => join(root, 'shared/memory', f)),
      join(root, 'main/memory.ts'),
      join(root, 'main/memory-store.ts'),
      join(root, 'renderer/src/cutalong/memory.ts')
    ]
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
      expect(code, file).not.toMatch(
        /\bfetch\(|XMLHttpRequest|WebSocket|from ['"](node:)?(https?|net|tls|dgram)['"]|anthropic/i
      )
    }
    // The statements are read in one place in the main process: the planner's request.
    const cutalong = readFileSync(join(root, 'main/cutalong.ts'), 'utf8')
    expect(cutalong.match(/preferencesForPlanner\(\)/g)).toHaveLength(1)
    expect(cutalong).toMatch(/'cut:plan'[\s\S]{0,200}preferencesForPlanner\(\)/)
  })
})
