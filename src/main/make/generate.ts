import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import type { ImageService } from '../../shared/make/schema'
import { ServiceError } from '../providers/gate'
import type { MakeServices, Picture } from './services'

/**
 * Making each picture and clip: once, at a price agreed beforehand, kept
 * where the edit keeps its files.
 *
 * The cache is keyed by everything that decides what comes back (service,
 * model, prompt, references, shape, size, length), so asking again for the
 * same shot costs nothing and a changed prompt makes a new one. The budget
 * holds every request to the total the person confirmed: a request that
 * would pass it is never sent. Busy, slow or failing services are tried
 * again a few times; a refusal or a declined prompt is not. Cancel stops
 * whatever is in flight.
 */

/** What decides what a service makes, as the cache keys it. */
export interface MadeRequest {
  kind: 'image' | 'clip'
  service: ImageService
  model: string
  prompt: string
  /** The references and first frames sent with it, by their bytes. */
  refs: Picture[]
  aspect: 'wide' | 'vertical'
  size?: string
  seconds?: number
}

export function cacheKey(req: MadeRequest): string {
  const h = createHash('sha256')
  h.update(
    JSON.stringify({
      kind: req.kind,
      service: req.service,
      model: req.model,
      prompt: req.prompt,
      refs: req.refs.map((r) => createHash('sha256').update(r.data).digest('hex')),
      aspect: req.aspect,
      size: req.size ?? null,
      seconds: req.seconds ?? null
    })
  )
  return h.digest('hex').slice(0, 32)
}

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm'
}

/** The extension a made file is kept under, from its type or, failing that, its first bytes. */
export function extensionOf(p: Picture): string {
  const known = EXT[p.mime.split(';')[0].trim().toLowerCase()]
  if (known) return known
  const head = Buffer.from(p.data.slice(0, 12))
  if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'jpg'
  if (head.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4'
  if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') return 'webp'
  return p.mime.startsWith('video/') ? 'mp4' : 'png'
}

interface CacheEntry {
  file: string
  cost: number
  at: string
}

/** Made files, in the edit's own folder (Assets/<edit>/made), indexed by cache key. */
export class MadeCache {
  readonly dir: string
  private index: Record<string, CacheEntry> | null = null

  constructor(dir: string) {
    this.dir = dir
  }

  private async load(): Promise<Record<string, CacheEntry>> {
    if (this.index) return this.index
    try {
      this.index = JSON.parse(await fs.readFile(join(this.dir, 'index.json'), 'utf8')) as Record<string, CacheEntry>
    } catch {
      this.index = {}
    }
    return this.index
  }

  /** The file made under this key, if it is still there. */
  async get(key: string): Promise<string | null> {
    const index = await this.load()
    const hit = index[key]
    return hit && existsSync(join(this.dir, hit.file)) ? join(this.dir, hit.file) : null
  }

  async put(key: string, made: Picture, cost: number): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true })
    const file = `${key.slice(0, 16)}.${extensionOf(made)}`
    await fs.writeFile(join(this.dir, file), made.data)
    const index = await this.load()
    index[key] = { file, cost, at: new Date().toISOString() }
    await fs.writeFile(join(this.dir, 'index.json'), JSON.stringify(index, null, 2))
    return join(this.dir, file)
  }
}

/** The most a video may spend, and what it has spent and has on order. */
export class Budget {
  private spentSoFar: number
  private held = 0
  readonly cap: number

  constructor(cap: number, spent = 0) {
    this.cap = cap
    this.spentSoFar = spent
  }

  get spent(): number {
    return Math.round(this.spentSoFar * 10000) / 10000
  }

  /** Holds an amount for a request about to go; false when it would pass the cap, and then it must not go. */
  reserve(amount: number): boolean {
    if (this.spentSoFar + this.held + amount > this.cap + 1e-9) return false
    this.held += amount
    return true
  }

  /** The request was made: what it cost is spent, and what was held for it is let go. */
  commit(held: number, cost: number): void {
    this.held = Math.max(0, this.held - held)
    this.spentSoFar += cost
  }

  release(held: number): void {
    this.held = Math.max(0, this.held - held)
  }
}

/** Over budget: the request was never sent. */
export class OverBudget extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OverBudget'
  }
}

/** Whether a failure is worth trying again: the service was busy, slow, unreachable or broken on its side. */
export function retryable(err: unknown): boolean {
  if (!(err instanceof ServiceError)) return false
  if (err.kind === 'busy' || err.kind === 'timeout' || err.kind === 'unreachable') return true
  return err.kind === 'failed' && (err.status === null || err.status >= 500)
}

const wait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })

export interface MakeDeps {
  services: MakeServices
  cache: MadeCache
  budget: Budget
  signal?: AbortSignal
  /** Attempts in all, the first included. */
  attempts?: number
  /** The wait before the second attempt, doubled each time after. */
  backoffMs?: number
}

export interface Made {
  path: string
  /** What it cost now: 0 when it came from the cache. */
  cost: number
  cached: boolean
}

/**
 * Makes one picture or clip, or finds it made already. `price` is what it
 * costs; it is held against the budget before anything goes, and spent only
 * when the service hands back what it made.
 */
export async function makeOnce(req: MadeRequest, price: number, deps: MakeDeps, make: () => Promise<Picture>): Promise<Made> {
  const key = cacheKey(req)
  const hit = await deps.cache.get(key)
  if (hit) return { path: hit, cost: 0, cached: true }
  if (deps.signal?.aborted) throw new ServiceError(req.service === 'google' ? 'gemini' : 'fal', 'cancelled', 'Stopped.')
  if (!deps.budget.reserve(price))
    throw new OverBudget(`That would take it past the $${deps.budget.cap.toFixed(2)} agreed, so I did not ask for it.`)
  const attempts = deps.attempts ?? 3
  let backoff = deps.backoffMs ?? 1500
  let last: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const made = await make()
      deps.budget.commit(price, price)
      const path = await deps.cache.put(key, made, price)
      return { path, cost: price, cached: false }
    } catch (err) {
      last = err
      if (deps.signal?.aborted || !retryable(err) || i === attempts - 1) break
      const after = err instanceof ServiceError && err.retryAfterSec ? err.retryAfterSec * 1000 : backoff
      await wait(Math.min(30_000, after), deps.signal)
      backoff *= 2
    }
  }
  deps.budget.release(price)
  throw last
}

/** Runs jobs a few at a time, in order of starting, stopping new ones once cancelled. */
export async function inTurn<T, R>(items: T[], width: number, run: (item: T, i: number) => Promise<R>, signal?: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length && !signal?.aborted) {
      const i = next++
      out[i] = await run(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
  return out
}
