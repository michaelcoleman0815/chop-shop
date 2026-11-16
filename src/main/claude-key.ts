import Anthropic from '@anthropic-ai/sdk'
import { createHash } from 'crypto'
import { detectProvider } from '../shared/keys'
import { keyStateOf, keyStatus, type ClaudeKeyState, type ClaudeKeyStatus } from '../shared/setup'

/**
 * Whether the Anthropic key works, said as one of the states the setup
 * screen and the gate know (shared/setup/gate.ts), and remembered: a key
 * Anthropic accepted once keeps the gate open while Anthropic is busy or out
 * of reach, and a key it turns down closes it until a new one is saved.
 *
 * What is remembered is a fingerprint of the key, never the key.
 */

export interface KeyDeps {
  /** The saved key, or null when there is none or the keychain cannot open it. */
  read(): string | null
  /** Whether a key is saved at all. */
  saved(): boolean
  /** The cheapest call that needs a working key; throws as the SDK does. */
  ask(key: string): Promise<void>
  /** The fingerprint of the key last accepted, or null. */
  remembered(): string | null
  remember(fingerprint: string | null): void
}

/** A short one-way fingerprint of a key, so the key itself is never kept in the settings. */
export function fingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)
}

/** What a failed call to Anthropic says about the key, or null when it is about the request instead. */
export function stateOfError(err: unknown): ClaudeKeyState | null {
  // A connection error is an APIError in this SDK, so it is asked about first.
  if (err instanceof Anthropic.APIConnectionError) return 'offline'
  if (err instanceof Anthropic.APIError) {
    return keyStateOf({ status: err.status ?? null, type: err.type, message: err.message })
  }
  return null
}

/** States that say the key itself does not work, which forget that it once did. */
const BROKEN: ReadonlySet<ClaudeKeyState> = new Set(['refused', 'no-credit', 'no-access', 'wrong'])

/**
 * Checks the saved key with Anthropic and says what it found. `quick`, for
 * launch, trusts a key Anthropic accepted before without asking again: the
 * first request made with it says so if that has changed since.
 */
export async function claudeKeyStatus(deps: KeyDeps, opts: { quick?: boolean } = {}): Promise<ClaudeKeyStatus> {
  const key = deps.read()
  if (!key) {
    if (deps.saved()) return keyStatus('unreadable')
    deps.remember(null)
    return keyStatus('none')
  }
  const from = detectProvider(key)
  if (from === 'openai' || from === 'google') {
    deps.remember(null)
    return keyStatus('wrong', false, key)
  }
  const print = fingerprint(key)
  const confirmed = deps.remembered() === print
  if (opts.quick && confirmed) return keyStatus('ok', true)
  try {
    await deps.ask(key)
    deps.remember(print)
    return keyStatus('ok', true)
  } catch (err) {
    // Reading the model's details only fails on the key or on Anthropic; anything else is Anthropic failing.
    const state = stateOfError(err) ?? 'down'
    if (BROKEN.has(state)) deps.remember(null)
    return keyStatus(state, BROKEN.has(state) ? false : confirmed)
  }
}

/**
 * Notes what a failed request said about the key, so the next look at the
 * gate sees it: a key turned down, out of credit or without access stops
 * opening it. Returns the state, for the reply to the request.
 */
export function noteKeyFailure(err: unknown, deps: Pick<KeyDeps, 'remember'>): ClaudeKeyState | null {
  const state = stateOfError(err)
  if (state && BROKEN.has(state)) deps.remember(null)
  return state
}
