import { describe, expect, it } from 'vitest'
import { CC0 } from '../../../shared/broll/license'
import { planFor, type MomentResult } from '../../../shared/broll/route'
import type { Candidate, Moment } from '../../../shared/broll/types'
import { offerReply, type BrollPick, type BrollWebAsk } from './broll'

/**
 * B-roll found for one edit goes into that edit only: every choice, and the web's priced button, carries the edit it
 * was found for, so a pick or a paid search tapped with another chat or clip open is refused (useCutalong's takeBroll
 * and its broll-web action).
 */

const moment: Moment = {
  beat: 'b2',
  said: 'the oil boom made the papers',
  search: 'a news report about the oil boom',
  topic: 'The oil boom',
  format: 'long',
  output: { width: 1920, height: 1080 },
  seconds: 4
}

const found: Candidate = {
  id: 'page',
  source: 'wikimedia',
  kind: 'image',
  title: 'An oil derrick',
  author: 'Example',
  authorUrl: null,
  pageUrl: 'https://commons.wikimedia.org/wiki/File:Derrick.jpg',
  mediaUrl: 'https://upload.wikimedia.org/derrick.jpg',
  previewUrl: null,
  width: 2560,
  height: 1440,
  durationSec: null,
  bytes: null,
  license: CC0,
  tags: []
}

function result(): MomentResult {
  const plan = planFor(moment, { available: { why: (id) => (id === 'web' ? 'it costs money and waits for your yes' : null) } })
  return { moment, plan, results: [{ candidate: found, score: 0.8, reason: 'a reason' }], asked: [], notes: [] }
}

const quote = { low: 0.034, high: 0.12, searches: 3, said: 'Looking on the web for this moment costs about 3 cents to 12 cents.' }

describe('B-roll bound to the edit it was found for', () => {
  it('every choice, and the priced web button, carry that edit', () => {
    const reply = offerReply(result(), { moment: null, where: 'thread', webQuote: quote, docId: 'doc-a' })
    const picks = reply.actions.filter((a) => a.kind === 'add-broll').map((a) => JSON.parse(a.payload ?? '') as BrollPick)
    expect(picks.length).toBeGreaterThan(0)
    expect(picks.every((p) => p.docId === 'doc-a')).toBe(true)
    const web = reply.actions.find((a) => a.kind === 'broll-web')
    expect((JSON.parse(web?.payload ?? '') as BrollWebAsk).docId).toBe('doc-a')
  })

  it('with no edit named, a choice names none, as one made before this did', () => {
    const reply = offerReply(result(), { moment: null, where: 'panel' })
    const pick = JSON.parse(reply.actions[0].payload ?? '') as BrollPick
    expect(pick.docId).toBeUndefined()
  })
})
