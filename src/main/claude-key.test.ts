import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => null, hasApiKey: () => false }))

import Anthropic from '@anthropic-ai/sdk'
import { claudeKeyStatus, fingerprint, noteKeyFailure, stateOfError, type KeyDeps } from './claude-key'
import { MODEL } from './planner'
import { gateOpen, keyMessage } from '../shared/setup'

/**
 * The Anthropic key's check, through the real SDK with a stand-in for the
 * network: every way Anthropic answers, and what the setup screen and the
 * gate then say. Nothing leaves this computer.
 */

/** An API error body as Anthropic sends one. */
const error = (status: number, type: string, message: string): Response =>
  new Response(JSON.stringify({ type: 'error', error: { type, message }, request_id: 'req_test' }), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/** Deps whose check goes through the SDK to a fetch that answers as asked, remembering in memory. */
function setup(opts: { key?: string | null; saved?: boolean; answer: () => Response | Promise<Response>; remembered?: string | null }) {
  const spy = vi.fn(async (url: string | URL | Request) => {
    void url
    return opts.answer()
  })
  let remembered = opts.remembered ?? null
  const deps: KeyDeps = {
    read: () => (opts.key === undefined ? 'sk-ant-api03-test' : opts.key),
    saved: () => opts.saved ?? opts.key !== null,
    ask: async (apiKey) => {
      await new Anthropic({ apiKey, fetch: spy as unknown as typeof fetch, maxRetries: 0 }).models.retrieve(MODEL)
    },
    remembered: () => remembered,
    remember: (print) => {
      remembered = print
    }
  }
  return { deps, spy, remembered: () => remembered }
}

const model = (): Response =>
  new Response(
    JSON.stringify({ type: 'model', id: MODEL, display_name: 'The model Cutalong plans with', created_at: '2026-10-01T00:00:00Z' }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  )

describe('checking the Anthropic key', () => {
  it('opens the gate for a key Anthropic accepts, and remembers it by a fingerprint', async () => {
    const s = setup({ answer: model })
    const status = await claudeKeyStatus(s.deps)
    expect(status).toEqual({ state: 'ok', message: keyMessage('ok'), confirmed: true })
    expect(gateOpen(status)).toBe(true)
    expect(s.spy).toHaveBeenCalledTimes(1)
    expect(String(s.spy.mock.calls[0][0])).toBe(`https://api.anthropic.com/v1/models/${MODEL}`)
    expect(s.remembered()).toBe(fingerprint('sk-ant-api03-test'))
    expect(s.remembered()).not.toContain('sk-ant')
  })

  it('sends nothing when there is no key, and says why Cutalong needs one', async () => {
    const s = setup({ key: null, saved: false, answer: model })
    const status = await claudeKeyStatus(s.deps)
    expect(status.state).toBe('none')
    expect(status.message).toBe(
      'Claude reads everything you ask and plans each edit, so nothing in Cutalong runs until an Anthropic key works.'
    )
    expect(gateOpen(status)).toBe(false)
    expect(s.spy).not.toHaveBeenCalled()
  })

  it('at launch, takes a key Anthropic accepted before as working without asking, and asks about any other', async () => {
    const known = setup({ answer: model, remembered: fingerprint('sk-ant-api03-test') })
    expect(await claudeKeyStatus(known.deps, { quick: true })).toEqual({
      state: 'ok',
      message: keyMessage('ok'),
      confirmed: true
    })
    expect(known.spy).not.toHaveBeenCalled()
    // A key never accepted, or another one since, is checked even at launch.
    const fresh = setup({ answer: () => error(401, 'authentication_error', 'invalid x-api-key') })
    const status = await claudeKeyStatus(fresh.deps, { quick: true })
    expect(status.state).toBe('refused')
    expect(fresh.spy).toHaveBeenCalledTimes(1)
    const other = setup({ answer: model, remembered: fingerprint('sk-ant-api03-another') })
    await claudeKeyStatus(other.deps, { quick: true })
    expect(other.spy).toHaveBeenCalledTimes(1)
    // Without quick, a remembered key is asked about too.
    const again = setup({ answer: model, remembered: fingerprint('sk-ant-api03-test') })
    await claudeKeyStatus(again.deps)
    expect(again.spy).toHaveBeenCalledTimes(1)
  })

  it('says when the keychain cannot open a key that is saved', async () => {
    const s = setup({ key: null, saved: true, answer: model })
    const status = await claudeKeyStatus(s.deps)
    expect(status).toMatchObject({ state: 'unreadable', confirmed: false })
    expect(status.message).toBe('I could not open the saved key from this computer’s keychain. Paste it again.')
    expect(s.spy).not.toHaveBeenCalled()
  })

  it('turns away a key from another company before sending it anywhere', async () => {
    const openai = setup({ key: 'sk-proj-abc123', answer: model })
    const status = await claudeKeyStatus(openai.deps)
    expect(status.state).toBe('wrong')
    expect(status.message).toBe('That looks like an OpenAI key. Cutalong needs one from Anthropic, which starts sk-ant-.')
    expect(openai.spy).not.toHaveBeenCalled()
    const google = await claudeKeyStatus(setup({ key: 'AIzaSy-abc', answer: model }).deps)
    expect(google.message).toBe('That looks like a Google key. Cutalong needs one from Anthropic, which starts sk-ant-.')
  })

  const failures: [string, () => Response, string, string][] = [
    [
      'a key Anthropic does not accept (mistyped, deleted or revoked)',
      () => error(401, 'authentication_error', 'invalid x-api-key'),
      'refused',
      'Anthropic did not accept that key. It may be mistyped, or it was deleted in the Console. Make a new one and paste it here.'
    ],
    [
      'an account with no credit left',
      () => error(402, 'billing_error', 'Your credit balance is too low to access the Anthropic API.'),
      'no-credit',
      'The key works, but the account has no credit left. Add credit under Billing, then check again.'
    ],
    [
      'an empty balance told the older way, as a 400',
      () =>
        error(
          400,
          'invalid_request_error',
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'
        ),
      'no-credit',
      'The key works, but the account has no credit left. Add credit under Billing, then check again.'
    ],
    [
      'a key that may not use the model',
      () => error(403, 'permission_error', 'Your API key does not have permission to use the specified resource.'),
      'no-access',
      'That key cannot use the model Cutalong plans with. Make a new key in a workspace that can, and paste it here.'
    ],
    [
      'a model the account cannot see',
      () => error(404, 'not_found_error', `model: ${MODEL}`),
      'no-access',
      'That key cannot use the model Cutalong plans with. Make a new key in a workspace that can, and paste it here.'
    ],
    [
      'a key that is being rate-limited',
      () => error(429, 'rate_limit_error', 'Number of requests has exceeded your per-minute rate limit'),
      'busy',
      'Anthropic is limiting how fast this key can be used. Wait a minute and try again; adding credit raises the limit.'
    ],
    [
      'Anthropic overloaded',
      () => error(529, 'overloaded_error', 'Overloaded'),
      'down',
      'Anthropic is overloaded or having trouble right now. Try again in a minute.'
    ],
    [
      'Anthropic failing',
      () => error(500, 'api_error', 'Internal server error'),
      'down',
      'Anthropic is overloaded or having trouble right now. Try again in a minute.'
    ]
  ]

  for (const [what, answer, state, message] of failures) {
    it(`says plainly when it meets ${what}`, async () => {
      const s = setup({ answer })
      const status = await claudeKeyStatus(s.deps)
      expect(status.state).toBe(state)
      expect(status.message).toBe(message)
      expect(gateOpen(status)).toBe(false)
    })
  }

  it('says when Anthropic cannot be reached', async () => {
    const s = setup({
      answer: () => {
        throw new TypeError('fetch failed')
      }
    })
    const status = await claudeKeyStatus(s.deps)
    expect(status).toMatchObject({ state: 'offline', confirmed: false })
    expect(status.message).toBe('I could not reach Anthropic. Check the connection, then try again.')
    expect(gateOpen(status)).toBe(false)
  })

  it('keeps the gate open for a key that worked, while Anthropic is busy, overloaded or out of reach', async () => {
    const print = fingerprint('sk-ant-api03-test')
    for (const answer of [
      () => error(429, 'rate_limit_error', 'slow down'),
      () => error(529, 'overloaded_error', 'Overloaded'),
      (): Response => {
        throw new TypeError('fetch failed')
      }
    ]) {
      const s = setup({ answer, remembered: print })
      const status = await claudeKeyStatus(s.deps)
      expect(status.confirmed).toBe(true)
      expect(gateOpen(status)).toBe(true)
      expect(s.remembered()).toBe(print)
    }
    // A different key is not the one that worked.
    const other = setup({ key: 'sk-ant-api03-other', answer: () => error(429, 'rate_limit_error', 'slow'), remembered: print })
    expect(gateOpen(await claudeKeyStatus(other.deps))).toBe(false)
  })

  it('forgets a key that worked once it is turned down or runs out of credit', async () => {
    const print = fingerprint('sk-ant-api03-test')
    for (const answer of [
      () => error(401, 'authentication_error', 'invalid x-api-key'),
      () => error(402, 'billing_error', 'no credit')
    ]) {
      const s = setup({ answer, remembered: print })
      const status = await claudeKeyStatus(s.deps)
      expect(status.confirmed).toBe(false)
      expect(gateOpen(status)).toBe(false)
      expect(s.remembered()).toBeNull()
    }
  })

  it('reads what a failed plan says about the key, and nothing from a request Claude could not take', () => {
    let remembered: string | null = 'abc'
    const remember = (p: string | null): void => {
      remembered = p
    }
    const headers = new Headers()
    expect(noteKeyFailure(new Anthropic.RateLimitError(429, { type: 'error' }, 'slow', headers), { remember })).toBe(
      'busy'
    )
    expect(remembered).toBe('abc')
    expect(
      noteKeyFailure(
        Anthropic.APIError.generate(402, { error: { type: 'billing_error', message: 'no credit' } }, 'no credit', headers),
        { remember }
      )
    ).toBe('no-credit')
    expect(remembered).toBeNull()
    expect(stateOfError(Anthropic.APIError.generate(400, { error: { type: 'invalid_request_error', message: 'schema too complex' } }, 'x', headers))).toBeNull()
    expect(stateOfError(new Error('something else'))).toBeNull()
  })
})
