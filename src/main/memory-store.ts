import { promises as fs } from 'fs'
import { dirname } from 'path'
import { changeMemory, EMPTY_MEMORY, parseMemory, recordSignal, type Memory, type MemoryChange } from '../shared/memory'

/**
 * What has been learned about how someone edits, in one small JSON file on
 * their computer. Changes go through one queue, so signals that arrive close
 * together are never lost to two writes racing. Takes the file as an
 * argument so the tests can use it without Electron.
 */

export class MemoryStore {
  private memory: Memory | null = null
  /** A file written by a newer Cutalong: read as empty here, and never written over. */
  private newer = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async read(): Promise<Memory> {
    if (this.memory) return this.memory
    try {
      const raw: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      const v = raw && typeof raw === 'object' ? (raw as { v?: unknown }).v : undefined
      this.newer = typeof v === 'number' && v > 1
      this.memory = parseMemory(raw)
    } catch {
      this.memory = { ...EMPTY_MEMORY }
    }
    return this.memory
  }

  /** The memory once every change already asked for is written: what the planner and the page should see. */
  current(): Promise<Memory> {
    return this.queue.then(() => this.read())
  }

  /** Notes a signal; nothing is kept while learning is paused. */
  record(signal: unknown): Promise<Memory> {
    return this.update((m) => recordSignal(m, signal))
  }

  change(change: MemoryChange): Promise<Memory> {
    return this.update((m) => changeMemory(m, change))
  }

  private update(fn: (m: Memory) => Memory): Promise<Memory> {
    const run = this.queue.then(async () => {
      const before = await this.read()
      const after = fn(before)
      if (after === before || this.newer) return before
      this.memory = after
      await fs.mkdir(dirname(this.file), { recursive: true })
      // Written beside the real file and renamed over it, so a crash mid-write leaves the old one.
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(after))
      await fs.rename(tmp, this.file)
      return after
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
