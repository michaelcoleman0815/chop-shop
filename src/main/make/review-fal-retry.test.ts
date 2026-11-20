import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { clipCost, stillCost } from '../../shared/make/quote'
import { falClip, falImage, FAL_CLIP_MODEL, FAL_IMAGE_MODEL } from '../providers/fal'
import { googleImage, GOOGLE_IMAGE_MODEL } from '../providers/google-make'
import { gateFor, json, scriptedFetch, type Answer } from '../providers/testing'
import { Budget, MadeCache, makeOnce, type MadeRequest } from './generate'
import type { MakeServices } from './services'

/**
 * Regression for the money review's first finding: once a service has taken
 * a job (fal's queue answered with a request id, or Google was sent the
 * request and its answer was lost), a status check, the result or the file
 * that fails on the way back is asked for again, and the job is never sent
 * again. A job taken and then given up on still counts against the budget,
 * because it is billed.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32])
let n = 0
const submitted: Answer = () => {
  n++
  return json({
    request_id: `r${n}`,
    status_url: `https://queue.fal.run/m/requests/r${n}/status`,
    response_url: `https://queue.fal.run/m/requests/r${n}`,
    cancel_url: `https://queue.fal.run/m/requests/r${n}/cancel`
  })
}
const upstream503: Answer = () => json({ detail: 'Service Unavailable' }, 503)
const netDrop: Answer = () => {
  throw new TypeError('fetch failed: ECONNRESET')
}
const refused: Answer = () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
}
const tmp = (): string => mkdtempSync(join(tmpdir(), 'review-fal-'))
const services = {} as MakeServices
const posts = (sent: { method: string }[]): number => sent.filter((r) => r.method === 'POST').length
const puts = (sent: { method: string }[]): number => sent.filter((r) => r.method === 'PUT').length

describe('a job a service has taken is never sent again', () => {
  it('one 503 on a status check: the status is asked again, one job runs, and it is counted once', async () => {
    n = 0
    const f = scriptedFetch([
      submitted,
      upstream503,
      () => json({ status: 'COMPLETED' }),
      () => json({ images: [{ url: 'https://v3.fal.media/files/a.png', content_type: 'image/png' }] }),
      () => new Response(PNG, { status: 200 })
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = stillCost('fal', '1k')
    const budget = new Budget(10)
    const req: MadeRequest = {
      kind: 'image',
      service: 'fal',
      model: FAL_IMAGE_MODEL,
      prompt: 'p',
      refs: [],
      aspect: 'wide',
      size: '1k'
    }
    const made = await makeOnce(req, price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falImage(gate, 'p', [], { aspect: 'wide', size: '1k', pollMs: 5 })
    )
    expect(made.cached).toBe(false)
    expect(posts(f.sent)).toBe(1)
    expect(puts(f.sent)).toBe(0)
    expect(budget.spent).toBeCloseTo(price)
  })

  it('a clip whose status checks keep dropping: one Kling job, cancelled, and counted', async () => {
    n = 0
    const f = scriptedFetch([
      submitted,
      netDrop,
      netDrop,
      netDrop,
      netDrop,
      netDrop,
      netDrop,
      () => json({ status: 'CANCELLATION_REQUESTED' }, 202)
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = clipCost('fal', 5)
    const budget = new Budget(10)
    const req: MadeRequest = {
      kind: 'clip',
      service: 'fal',
      model: FAL_CLIP_MODEL,
      prompt: 'p',
      refs: [{ data: PNG, mime: 'image/png' }],
      aspect: 'wide',
      seconds: 5
    }
    await expect(
      makeOnce(req, price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
        falClip(gate, 'p', { data: PNG, mime: 'image/png' }, { seconds: 5, pollMs: 5 })
      )
    ).rejects.toMatchObject({ kind: 'unreachable', accepted: true })
    expect(posts(f.sent)).toBe(1)
    // Given up on, the request is cancelled in case it is still waiting, and its price stays spent.
    expect(puts(f.sent)).toBe(1)
    expect(budget.spent).toBeCloseTo(price)
  })

  it('the file fails to download after COMPLETED: the file is fetched again, never made again', async () => {
    n = 0
    const f = scriptedFetch([
      submitted,
      () => json({ status: 'COMPLETED' }),
      () => json({ video: { url: 'https://v3.fal.media/files/a.mp4', content_type: 'video/mp4' } }),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response(MP4, { status: 200 })
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = clipCost('fal', 5)
    const budget = new Budget(10)
    const req: MadeRequest = {
      kind: 'clip',
      service: 'fal',
      model: FAL_CLIP_MODEL,
      prompt: 'q',
      refs: [{ data: PNG, mime: 'image/png' }],
      aspect: 'wide',
      seconds: 5
    }
    await makeOnce(req, price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falClip(gate, 'q', { data: PNG, mime: 'image/png' }, { seconds: 5, pollMs: 5 })
    )
    expect(posts(f.sent)).toBe(1)
    expect(f.sent.filter((r) => r.url.includes('fal.media'))).toHaveLength(2)
    expect(budget.spent).toBeCloseTo(price)
  })

  it('a submit that never connected is sent again; one cut off after it went is counted and not sent again', async () => {
    n = 0
    const again = scriptedFetch([
      refused,
      submitted,
      () => json({ status: 'COMPLETED' }),
      () => json({ images: [{ url: 'https://v3.fal.media/files/a.png' }] }),
      () => new Response(PNG, { status: 200 })
    ])
    const budget = new Budget(10)
    const price = stillCost('fal', '1k')
    const req: MadeRequest = {
      kind: 'image',
      service: 'fal',
      model: FAL_IMAGE_MODEL,
      prompt: 'r',
      refs: [],
      aspect: 'wide',
      size: '1k'
    }
    await makeOnce(req, price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falImage(gateFor(again.fetch, { keys: { fal: 'k' } }), 'r', [], { aspect: 'wide', size: '1k', pollMs: 5 })
    )
    expect(posts(again.sent)).toBe(2)
    expect(budget.spent).toBeCloseTo(price)

    const cut = scriptedFetch([netDrop, submitted])
    const held = new Budget(10)
    await expect(
      makeOnce(
        { ...req, prompt: 's' },
        price,
        { services, cache: new MadeCache(tmp()), budget: held, backoffMs: 5 },
        () => falImage(gateFor(cut.fetch, { keys: { fal: 'k' } }), 's', [], { aspect: 'wide', size: '1k', pollMs: 5 })
      )
    ).rejects.toMatchObject({ accepted: true })
    expect(posts(cut.sent)).toBe(1)
    expect(held.spent).toBeCloseTo(price)
  })

  it('Google: an answer lost after the request went is counted and not sent again; a busy answer is tried again', async () => {
    const price = stillCost('google', '2K')
    const req: MadeRequest = {
      kind: 'image',
      service: 'google',
      model: GOOGLE_IMAGE_MODEL,
      prompt: 'g',
      refs: [],
      aspect: 'wide',
      size: '2K'
    }
    const lost = scriptedFetch([netDrop, netDrop])
    const budget = new Budget(10)
    await expect(
      makeOnce(req, price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
        googleImage(gateFor(lost.fetch, { keys: { gemini: 'g-key' } }), 'g', [], { aspect: 'wide', size: '2K' })
      )
    ).rejects.toMatchObject({ accepted: true })
    expect(posts(lost.sent)).toBe(1)
    expect(budget.spent).toBeCloseTo(price)

    const picture = { type: 'image', data: Buffer.from(PNG).toString('base64'), mime_type: 'image/png' }
    const busy = scriptedFetch([
      () => json({ error: { message: 'Resource has been exhausted (e.g. check quota).' } }, 429),
      () => json({ status: 'completed', steps: [{ type: 'model_output', content: [picture] }] })
    ])
    const after = new Budget(10)
    await makeOnce(
      { ...req, prompt: 'h' },
      price,
      { services, cache: new MadeCache(tmp()), budget: after, backoffMs: 5 },
      () => googleImage(gateFor(busy.fetch, { keys: { gemini: 'g-key' } }), 'h', [], { aspect: 'wide', size: '2K' })
    )
    expect(posts(busy.sent)).toBe(2)
    expect(after.spent).toBeCloseTo(price)
  })
})
