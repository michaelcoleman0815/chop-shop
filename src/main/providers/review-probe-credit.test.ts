import { describe, expect, it } from 'vitest'
import { retryable } from '../make/generate'
import { falImage } from './fal'
import { googleImage } from './google-make'
import { gateFor, json, scriptedFetch } from './testing'
import { elevenSpeech } from './voices'

/**
 * Review probe: what the person reads when a key works but its account is out
 * of credit. The services' own answers (status and body) are as each documents
 * them; the gate maps them by status alone.
 */

describe('fixed: out of credit, in plain words', () => {
  it('says "no credit left" for each, and never tries again', async () => {
    const cases: [string, () => Promise<unknown>][] = [
      [
        'ElevenLabs 401 quota_exceeded',
        () =>
          elevenSpeech(
            gateFor(scriptedFetch([() => json({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } }, 401)]).fetch, { keys: { elevenlabs: 'k' } }),
            'JBFqnCBsd6RMkjVDRZzb',
            'Hello.'
          )
      ],
      [
        'fal 403 exhausted balance',
        () =>
          falImage(
            gateFor(scriptedFetch([() => json({ detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' }, 403)]).fetch, { keys: { fal: 'k' } }),
            'p',
            [],
            { aspect: 'wide', size: '1k' }
          )
      ]
    ]
    const seen: { kind: string; message: string; retried: boolean }[] = []
    for (const [label, run] of cases) {
      const err = (await run().catch((e: unknown) => e)) as { kind: string; message: string }
      seen.push({ kind: err.kind, message: err.message, retried: retryable(err) })
      console.log(`${label}: kind=${err.kind} retried=${retryable(err)} says "${err.message}"`)
    }
    // Fixed at b732576: each is "no credit left", and none is sent again.
    expect(seen.every((s) => s.kind === 'no-credit' && !s.retried && /no credit left/.test(s.message))).toBe(true)
  })

  it('a paid Gemini key that is only rate-limited (as Google words a per-minute 429)', async () => {
    const body = {
      error: {
        code: 429,
        message:
          'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }
        ]
      }
    }
    const err = (await googleImage(gateFor(scriptedFetch([() => json(body, 429, { 'retry-after': '21' })]).fetch, { keys: { gemini: 'k' } }), 'p', [], {
      aspect: 'wide',
      size: '2K'
    }).catch((e: unknown) => e)) as { kind: string; message: string }
    console.log(`Gemini paid-tier 429: kind=${err.kind} retried=${retryable(err)} says "${err.message}"`)
    expect(err.kind).toBeTruthy()
  })
})
