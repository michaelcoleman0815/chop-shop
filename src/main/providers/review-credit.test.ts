import { describe, expect, it } from 'vitest'
import { retryable } from '../make/generate'
import { falImage } from './fal'
import { gateFor, json, scriptedFetch } from './testing'
import { elevenSpeech, openaiSpeech } from './voices'

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
        'OpenAI 429 insufficient_quota',
        () =>
          openaiSpeech(
            gateFor(
              scriptedFetch([
                () =>
                  json(
                    {
                      error: {
                        message: 'You exceeded your current quota, please check your plan and billing details.',
                        type: 'insufficient_quota',
                        code: 'insufficient_quota'
                      }
                    },
                    429
                  )
              ]).fetch,
              { keys: { openai: 'k' } }
            ),
            'Hello.',
            'cedar',
            'Read calmly.'
          ),
        'OpenAI says the account has no credit left.'
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
    const busy = (await openaiSpeech(
      gateFor(
        scriptedFetch([
          () => json({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, 429)
        ]).fetch,
        {
          keys: { openai: 'k' }
        }
      ),
      'Hello.',
      'cedar',
      'Read calmly.'
    ).catch((e: unknown) => e)) as { kind: string }
    expect(busy.kind).toBe('busy')
    expect(retryable(busy)).toBe(true)
  })
})
