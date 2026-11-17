import { promises as fs } from 'fs'
import { dirname } from 'path'
import { parseNeverRules, withRule, type NeverRule } from '../shared/memory'

/**
 * Every brand's never list (shared/never), in never.json beside memory.json:
 * one rule per brand and thing, the latest word on it. It has a file of its
 * own because a build from before brands rewrites memory.json without the
 * signals it cannot read, rules included; that build never opens this one.
 * The first time there is no file, the rules memory.json holds come over.
 *
 * A file that does not read is set aside rather than written over, and one
 * from a newer build is read as far as it can be and never written over.
 * Changes go through one queue. The file is an argument for the tests.
 */
export class NeverStore {
  private rules: NeverRule[] | null = null
  private newer = false
  private queue: Promise<unknown> = Promise.resolve()

  /** `before` gives the rules kept before there was this file: those in memory.json. */
  constructor(
    private readonly file: string,
    private readonly before: () => Promise<NeverRule[]>
  ) {}

  private async read(): Promise<NeverRule[]> {
    if (this.rules) return this.rules
    let text: string | null = null
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch {
      // No file yet: the rules come over from memory.json, and are written here from now on.
      const moved = await this.before().catch(() => [] as NeverRule[])
      this.rules = moved
      if (moved.length) await this.write(moved).catch(() => undefined)
      return moved
    }
    try {
      const raw: unknown = JSON.parse(text)
      const v = raw && typeof raw === 'object' ? (raw as { v?: unknown }).v : undefined
      this.newer = typeof v === 'number' && v > 1
      this.rules = parseNeverRules(raw)
    } catch {
      await fs.rename(this.file, `${this.file}.unreadable-${Date.now()}`).catch(() => undefined)
      this.rules = await this.before().catch(() => [] as NeverRule[])
    }
    return this.rules
  }

  private async write(rules: NeverRule[]): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    // Written beside the real file and renamed over it, so a crash mid-write leaves the old one.
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ v: 1, rules }, null, 2))
    await fs.rename(tmp, this.file)
  }

  /** The rules once every change already asked for is written. */
  current(): Promise<NeverRule[]> {
    return this.queue.then(() => this.read())
  }

  /** Things put on brands' lists or taken off them, each the latest word on it. */
  change(given: Omit<NeverRule, 'at'>[], at = new Date().toISOString()): Promise<NeverRule[]> {
    const run = this.queue.then(async () => {
      const before = await this.read()
      if (given.length === 0) return before
      let next = before
      for (const rule of given) next = withRule(next, { ...rule, at })
      if (this.newer) return before
      await this.write(next)
      this.rules = next
      return next
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}
