import { describe, expect, it } from 'vitest'
import { retryable } from '../make/generate'
import { falImage } from './fal'
import { googleImage } from './google-make'
import { gateFor, json, scriptedFetch } from './testing'
import { elevenSpeech } from './voices'

/**
 * Regression for the money review's eighth finding, the gate's half: a key
 * that works on an account with nothing left is said to be out of credit, in
 * plain words, and never tried again. Each service's answer (status and
 * body) is as it documents it.
 */

describe('out of credit, in plain words', () => {
  it('says the account has no credit left, and does not try again', async () => {
    const cases: [string, () => Promise<unknown>, string][] = [
      [
        'ElevenLabs 401 quota_exceeded',
        () =>
          elevenSpeech(
            gateFor(
              scriptedFetch([
                () =>
                  json(
                    { detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000.' } },
                    401
                  )
              ]).fetch,
              {
                keys: { elevenlabs: 'k' }
              }
            ),
            'JBFqnCBsd6RMkjVDRZzb',
            'Hello.'
          ),
        'ElevenLabs says the account has no credit left.'
      ],
      [
        'fal 403 exhausted balance',
        () =>
          falImage(
            gateFor(
              scriptedFetch([
                () =>
                  json(
                    {
                      detail:
                        'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.'
                    },
                    403
                  )
              ]).fetch,
              {
                keys: { fal: 'k' }
              }
            ),
            'p',
            [],
            { aspect: 'wide', size: '1k' }
          ),
        'fal.ai says the account has no credit left.'
      ]
    ]
    for (const [, run, said] of cases) {
      const err = (await run().catch((e: unknown) => e)) as { kind: string; message: string; accepted: boolean }
      expect(err.kind).toBe('no-credit')
      expect(err.message).toBe(said)
      expect(retryable(err)).toBe(false)
      // Refused before any job was taken: nothing is counted for it.
      expect(err.accepted).toBe(false)
    }
  })

  it('still tells a refused key and a busy service apart from an empty account', async () => {
    const refused = (await elevenSpeech(
      gateFor(
        scriptedFetch([() => json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401)]).fetch,
        { keys: { elevenlabs: 'k' } }
      ),
      'JBFqnCBsd6RMkjVDRZzb',
      'Hello.'
    ).catch((e: unknown) => e)) as { kind: string }
    expect(refused.kind).toBe('refused')
    const busy = (await elevenSpeech(
      gateFor(
        scriptedFetch([
          () =>
            json(
              { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests for your plan.' } },
              429
            )
        ]).fetch,
        {
          keys: { elevenlabs: 'k' }
        }
      ),
      'JBFqnCBsd6RMkjVDRZzb',
      'Hello.'
    ).catch((e: unknown) => e)) as { kind: string }
    expect(busy.kind).toBe('busy')
    expect(retryable(busy)).toBe(true)
  })

  it('reads a paid Gemini key’s per-minute 429 as busy, to try again, and only a free tier’s quota of zero as needing billing', async () => {
    const said = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/usage?tab=rate-limit.'
    const paid = {
      error: {
        code: 429,
        message: said,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }]
          },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }
        ]
      }
    }
    const free = {
      error: {
        code: 429,
        message: `${said}\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-nano-banana-2.1`,
        status: 'RESOURCE_EXHAUSTED'
      }
    }
    const opts = { aspect: 'wide' as const, size: '2K' }
    const busy = (await googleImage(gateFor(scriptedFetch([() => json(paid, 429)]).fetch, { keys: { gemini: 'k' } }), 'p', [], opts).catch((e: unknown) => e)) as {
      kind: string
      message: string
      retryAfterSec: number | null
      accepted: boolean
    }
    expect(busy.kind).toBe('busy')
    expect(busy.message).toBe('Google Gemini is busy right now.')
    expect(retryable(busy)).toBe(true)
    // Google says how long to wait in the body, not in a header.
    expect(busy.retryAfterSec).toBe(21)
    expect(busy.accepted).toBe(false)
    const billing = (await googleImage(gateFor(scriptedFetch([() => json(free, 429)]).fetch, { keys: { gemini: 'k' } }), 'p', [], opts).catch((e: unknown) => e)) as {
      kind: string
      message: string
    }
    expect(billing.kind).toBe('refused')
    expect(billing.message).toMatch(/only on a key with billing set up/)
    expect(retryable(billing)).toBe(false)
  })
})
