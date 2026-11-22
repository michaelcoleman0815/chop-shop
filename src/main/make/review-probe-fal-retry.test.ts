import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { clipCost, stillCost } from '../../shared/make/quote'
import { falClip, falImage, FAL_CLIP_MODEL, FAL_IMAGE_MODEL } from '../providers/fal'
import { googleImage, GOOGLE_IMAGE_MODEL } from '../providers/google-make'
import { gateFor, json, scriptedFetch, type Answer } from '../providers/testing'
import { Budget, MadeCache, makeOnce, type MadeRequest } from './generate'
import type { MakeServices } from './services'

/** Folders this file makes for what it writes, taken away once it is done. */
const scratchDirs: string[] = []
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Re-review at b732576, flipped: a job fal has accepted is never submitted
 * again; a lost answer is asked for again, or counted as spent. Google's
 * one-request generation is resent only when its answer proves it was not taken.
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
const completed: Answer = () => json({ status: 'COMPLETED' })
const tmp = (): string => scratch('probe-fal-')
const services = {} as MakeServices
const posts = (sent: { method: string }[]): number => sent.filter((r) => r.method === 'POST').length
const puts = (sent: { method: string }[]): number => sent.filter((r) => r.method === 'PUT').length
const clipReq = (prompt: string): MadeRequest => ({
  kind: 'clip',
  service: 'fal',
  model: FAL_CLIP_MODEL,
  prompt,
  refs: [{ data: PNG, mime: 'image/png' }],
  aspect: 'wide',
  seconds: 5
})

describe('fixed: a job fal took is never sent twice', () => {
  it('one 503 on a status poll: the poll is asked again, one job, one price', async () => {
    n = 0
    const f = scriptedFetch([
      submitted,
      upstream503,
      completed,
      () => json({ images: [{ url: 'https://v3.fal.media/files/a.png', content_type: 'image/png' }] }),
      () => new Response(PNG, { status: 200 })
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = stillCost('fal', '1k')
    const budget = new Budget(10)
    const req: MadeRequest = { kind: 'image', service: 'fal', model: FAL_IMAGE_MODEL, prompt: 'p', refs: [], aspect: 'wide', size: '1k' }
    const made = await makeOnce(req, price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falImage(gate, 'p', [], { aspect: 'wide', size: '1k', pollMs: 1 })
    )
    console.log(`still, 503 on a poll: ${posts(f.sent)} submit(s), budget $${budget.spent.toFixed(4)}, made=${!!made.path}`)
    expect(posts(f.sent)).toBe(1)
    expect(budget.spent).toBeCloseTo(price)
  })

  it('a clip whose polls drop three times, then completes: one Kling job', async () => {
    n = 0
    const f = scriptedFetch([
      submitted,
      netDrop,
      netDrop,
      netDrop,
      completed,
      () => json({ video: { url: 'https://v3.fal.media/files/a.mp4', content_type: 'video/mp4' } }),
      () => new Response(MP4, { status: 200 })
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = clipCost('fal', 5)
    const budget = new Budget(10)
    await makeOnce(clipReq('p'), price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falClip(gate, 'p', { data: PNG, mime: 'image/png' }, { seconds: 5, pollMs: 1 })
    )
    console.log(`clip, three dropped polls: ${posts(f.sent)} submit(s), budget $${budget.spent.toFixed(4)}`)
    expect(posts(f.sent)).toBe(1)
    expect(budget.spent).toBeCloseTo(price)
  })

  it('a clip whose polls never come back: given up, cancelled, counted as spent, never resubmitted', async () => {
    n = 0
    const f = scriptedFetch([submitted, netDrop, netDrop, netDrop, netDrop, netDrop, netDrop, () => json({})])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = clipCost('fal', 5)
    const budget = new Budget(10)
    const err = await makeOnce(clipReq('q'), price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falClip(gate, 'q', { data: PNG, mime: 'image/png' }, { seconds: 5, pollMs: 1 })
    ).catch((e: unknown) => e as { accepted?: boolean; message: string })
    await new Promise((r) => setTimeout(r, 20))
    console.log(`clip, polls lost: ${posts(f.sent)} submit(s), ${puts(f.sent)} cancel(s), budget $${budget.spent.toFixed(4)}, accepted=${(err as { accepted?: boolean }).accepted}`)
    expect(posts(f.sent)).toBe(1)
    expect(puts(f.sent)).toBe(1)
    expect(budget.spent).toBeCloseTo(price)
  })

  it('the media download fails after COMPLETED: the file is fetched again, the job is not', async () => {
    n = 0
    const f = scriptedFetch([
      submitted,
      completed,
      () => json({ video: { url: 'https://v3.fal.media/files/a.mp4', content_type: 'video/mp4' } }),
      () => new Response('bad gateway', { status: 502 }),
      () => new Response(MP4, { status: 200 })
    ])
    const gate = gateFor(f.fetch, { keys: { fal: 'fal-key' } })
    const price = clipCost('fal', 5)
    const budget = new Budget(10)
    await makeOnce(clipReq('r'), price, { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      falClip(gate, 'r', { data: PNG, mime: 'image/png' }, { seconds: 5, pollMs: 1 })
    )
    console.log(`clip, media 502 after COMPLETED: ${posts(f.sent)} submit(s), ${f.sent.length - 1} gets, budget $${budget.spent.toFixed(4)}`)
    expect(posts(f.sent)).toBe(1)
    expect(budget.spent).toBeCloseTo(price)
  })
})

describe('fixed: Google is resent only when its answer proves nothing was made', () => {
  const madeImage = json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', data: Buffer.from(PNG).toString('base64'), mime_type: 'image/png' }] }] })
  const req: MadeRequest = { kind: 'image', service: 'google', model: GOOGLE_IMAGE_MODEL, prompt: 'g', refs: [], aspect: 'wide', size: '2K' }

  it('a 504 (the request may have run): counted, not resent', async () => {
    const f = scriptedFetch([() => json({ error: { message: 'Deadline exceeded' } }, 504), () => madeImage])
    const gate = gateFor(f.fetch, { keys: { gemini: 'g-key' } })
    const budget = new Budget(10)
    const err = await makeOnce(req, stillCost('google', '2K'), { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      googleImage(gate, 'g', [], { aspect: 'wide', size: '2K' })
    ).catch((e: unknown) => e as { accepted?: boolean })
    console.log(`Google 504: ${f.sent.length} request(s), budget $${budget.spent.toFixed(4)}, accepted=${err && (err as { accepted?: boolean }).accepted}`)
    expect(f.sent).toHaveLength(1)
    expect(budget.spent).toBeCloseTo(stillCost('google', '2K'))
  })

  it('a 503 (answered with an error, so nothing was made): resent once, one price', async () => {
    const f = scriptedFetch([() => json({ error: { message: 'unavailable' } }, 503), () => madeImage])
    const gate = gateFor(f.fetch, { keys: { gemini: 'g-key' } })
    const budget = new Budget(10)
    await makeOnce({ ...req, prompt: 'h' }, stillCost('google', '2K'), { services, cache: new MadeCache(tmp()), budget, backoffMs: 5 }, () =>
      googleImage(gate, 'h', [], { aspect: 'wide', size: '2K' })
    )
    console.log(`Google 503 then made: ${f.sent.length} request(s), budget $${budget.spent.toFixed(4)}`)
    expect(f.sent).toHaveLength(2)
    expect(budget.spent).toBeCloseTo(stillCost('google', '2K'))
  })
})
