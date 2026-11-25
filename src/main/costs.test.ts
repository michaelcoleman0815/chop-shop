import { mkdtempSync, writeFileSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The ledger as main keeps it: calls written against the chat open when they
 * went, a first message's reading claimed by the chat it starts, the
 * averages read from the chats' own files, and all of it still there after
 * the app is closed and opened again.
 */

const fake = vi.hoisted(() => ({ dir: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(channel, fn) }
}))

const call = <T>(channel: string, ...args: unknown[]): Promise<T> => Promise.resolve(fake.handlers.get(channel)!({}, ...args) as T)
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

async function boot(recent: { id: string; path: string }[] = []) {
  vi.resetModules()
  fake.handlers.clear()
  const costs = await import('./costs')
  const usage = await import('./usage')
  costs.registerCosts(async () => recent)
  return usage
}

const chatFile = (name: string, body: unknown): string => {
  const p = join(fake.dir, `${name}.cutalong`)
  writeFileSync(p, JSON.stringify(body))
  return p
}

beforeEach(() => {
  fake.dir = mkdtempSync(join(tmpdir(), 'cutalong-costs-'))
})
afterEach(async () => {
  ;(await import('./usage')).setUsageSink(null)
})

describe('the ledger main keeps', () => {
  it('writes each call against the chat open when it went, even if another opens before the answer', async () => {
    const usage = await boot()
    await call('costs:open', { id: 'a', name: 'Sermon', path: null })
    const ticket = usage.usageTicket('plan')
    await call('costs:open', { id: 'b', name: 'Desk', path: null })
    ticket('claude-opus-5-5', { output_tokens: 10_000 })
    usage.usageTicket('read')('claude-opus-5-5', { output_tokens: 5_000 })
    await settle()
    expect(await call<number>('costs:chat', { id: 'a', path: null })).toBeCloseTo(0.2, 6)
    expect(await call<number>('costs:chat', { id: 'b', path: null })).toBeCloseTo(0.1, 6)
  })

  it('gives the reading of a first message, made on Start, to the chat it starts', async () => {
    const usage = await boot()
    await call('costs:open', null)
    usage.usageTicket('read')('claude-opus-5-5', { output_tokens: 1_000 })
    await settle()
    await call('costs:open', { id: 'new', name: 'New video', path: null })
    await settle()
    expect(await call<number>('costs:chat', { id: 'new', path: null })).toBeCloseTo(0.02, 6)
  })

  it('keeps what was written after the app is closed and opened again', async () => {
    let usage = await boot()
    await call('costs:open', { id: 'a', name: 'Sermon', path: null })
    usage.usageTicket('clips')('claude-opus-5-5', { input_tokens: 20_000, output_tokens: 6_000 })
    await settle()
    const file = JSON.parse(await fs.readFile(join(fake.dir, 'costs.json'), 'utf8'))
    expect(file.projects.a.entries[0]).toMatchObject({ for: 'clips', model: 'claude-opus-5-5' })

    usage = await boot()
    expect(await call<number>('costs:chat', { id: 'a', path: null })).toBeCloseTo(0.08 + 0.12, 6)
  })

  it('averages Shorts and long-form from what each chat’s file says it made', async () => {
    const sermon = chatFile('sermon', { id: 's', clipping: { clips: [{}, {}, {}, {}, {}] }, edit: null })
    const short = chatFile('short', { id: 'v', edit: { versions: [{ cut: { aspect: 'vertical' } }] } })
    const long = chatFile('long', { id: 'w', edit: { versions: [{ cut: { aspect: 'wide' } }] } })
    // Made from nothing before the ledger kept anything: its own total still counts.
    const made = chatFile('made', { id: 'm', edit: { versions: [{ cut: { aspect: 'vertical' } }], make: { spent: 1.5 } } })
    // From before the ledger, with nothing written down: left out, never counted as free.
    const before = chatFile('before', { id: 'x', edit: { versions: [{ cut: { aspect: 'wide' } }] } })
    const usage = await boot([
      { id: 'm', path: made },
      { id: 'x', path: before }
    ])
    const spend = async (id: string, path: string, out: number) => {
      await call('costs:open', { id, name: id, path })
      usage.usageTicket('plan')('claude-opus-5-5', { output_tokens: out })
      await settle()
    }
    await spend('s', sermon, 25_000) // 50 cents over 5 Shorts
    await spend('v', short, 5_000) // 10 cents
    await spend('w', long, 40_000) // 80 cents
    const s = await call<import('../shared/costs').CostSummary>('costs:summary')
    expect(s.shorts.videos).toBe(7)
    expect(s.shorts.chats).toBe(3)
    expect(s.shorts.dollars).toBeCloseTo(0.5 + 0.1 + 1.5, 6)
    expect(s.shorts.average).toBeCloseTo(2.1 / 7, 6)
    expect(s.long).toMatchObject({ videos: 1, chats: 1 })
    expect(s.long.average).toBeCloseTo(0.8, 6)
  })

  it('never lets the record stop a call: with nothing taking tickets, a ticket does nothing', async () => {
    const usage = await import('./usage')
    usage.setUsageSink(null)
    expect(() => usage.usageTicket('plan')('claude-opus-5-5', { output_tokens: 1 })).not.toThrow()
    usage.setUsageSink(() => {
      throw new Error('broken ledger')
    })
    expect(() => usage.usageTicket('plan')('claude-opus-5-5', { output_tokens: 1 })).not.toThrow()
  })
})
