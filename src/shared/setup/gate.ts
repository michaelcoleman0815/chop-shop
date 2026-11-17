import { detectProvider, wrongKeyMessage } from '../keys'
import { KEY_GUIDES } from './guides'

/**
 * Cutalong does nothing until an Anthropic key works: no footage read, no
 * command run, no sorting or transcription, because Claude reads every
 * prompt. This is the one place that says whether the gate is open, what a
 * key's state means in plain words, and which setup step fixes it. The
 * desktop app and the phone app both decide with it.
 */

export type ClaudeKeyState =
  /** Being checked now. */
  | 'checking'
  | 'ok'
  /** No key is saved. */
  | 'none'
  /** A key from another company was pasted. */
  | 'wrong'
  /** Anthropic turned the key down: mistyped, deleted or revoked. */
  | 'refused'
  /** The account has no credit left. */
  | 'no-credit'
  /** The key cannot use the model Cutalong plans with. */
  | 'no-access'
  /** Anthropic is limiting how fast the key can be used. */
  | 'busy'
  /** Anthropic is overloaded or failing. */
  | 'down'
  /** Anthropic could not be reached. */
  | 'offline'
  /** The keychain could not open the saved key. */
  | 'unreadable'

export interface ClaudeKeyStatus {
  state: ClaudeKeyState
  /** The state in one or two plain sentences. */
  message: string
  /** Whether this same key was accepted before: Anthropic being busy or out of reach then says nothing about it. */
  confirmed: boolean
}

/** States that come and go without anything being wrong with the key. */
const PASSING: ReadonlySet<ClaudeKeyState> = new Set(['busy', 'down', 'offline'])

/**
 * Whether Cutalong may do anything. Only a working key opens it; a key that
 * worked before stays good while Anthropic is busy, overloaded or out of
 * reach, since that says nothing about the key, and the request that meets it
 * says so when it fails.
 */
export function gateOpen(status: Pick<ClaudeKeyStatus, 'state' | 'confirmed'> | null | undefined): boolean {
  if (!status) return false
  return status.state === 'ok' || (status.confirmed && PASSING.has(status.state))
}

/**
 * What a failed call to Anthropic says about the key: the HTTP status and the
 * error type the API returned (401 authentication_error, 402 billing_error,
 * 403 permission_error, 404 not_found_error, 429 rate_limit_error, 5xx and
 * 529 overloaded_error), or that the call never reached it. Older accounts
 * were told about an empty balance with a 400 naming the credit balance,
 * which counts as a 402. Null when the failure is about the request, not the
 * key, such as a 400 for a request Claude could not take.
 */
export function keyStateOf(failure: {
  status?: number | null
  type?: string | null
  message?: string | null
  /** The call never got an answer: no connection, or it timed out. */
  unreached?: boolean
}): ClaudeKeyState | null {
  if (failure.unreached) return 'offline'
  const status = failure.status ?? 0
  const type = failure.type ?? ''
  if (status === 401 || type === 'authentication_error') return 'refused'
  if (status === 402 || type === 'billing_error') return 'no-credit'
  if (status === 400 && /credit balance/i.test(failure.message ?? '')) return 'no-credit'
  if (status === 403 || status === 404 || type === 'permission_error' || type === 'not_found_error') return 'no-access'
  if (status === 429 || type === 'rate_limit_error') return 'busy'
  if (status >= 500 || type === 'overloaded_error' || type === 'api_error') return 'down'
  return null
}

/** What a key's state means, in the app's voice. `key` is the key that was pasted, when one was. */
export function keyMessage(state: ClaudeKeyState, key?: string | null): string {
  switch (state) {
    case 'checking':
      return 'Checking your key with Anthropic…'
    case 'ok':
      return 'Connected. Claude reads what you ask and plans each edit.'
    case 'none':
      return KEY_GUIDES.anthropic.why
    case 'wrong':
      return (
        wrongKeyMessage(detectProvider(key ?? null)) ??
        'That is not an Anthropic key. Cutalong needs one from Anthropic, which starts sk-ant-.'
      )
    case 'refused':
      return 'Anthropic did not accept that key. It may be mistyped, or it was deleted in the Console. Make a new one and paste it here.'
    case 'no-credit':
      return 'The key works, but the account has no credit left. Add credit under Billing, then check again.'
    case 'no-access':
      return 'That key cannot use the model Cutalong plans with. Make a new key in a workspace that can, and paste it here.'
    case 'busy':
      return 'Anthropic is limiting how fast this key can be used. Wait a minute and try again; adding credit raises the limit.'
    case 'down':
      return 'Anthropic is overloaded or having trouble right now. Try again in a minute.'
    case 'offline':
      return 'I could not reach Anthropic. Check the connection, then try again.'
    case 'unreadable':
      return 'I could not open the saved key from this computer’s keychain. Paste it again.'
  }
}

/** The setup step that fixes a state, counted from 0 in the Anthropic guide; null when no step does. */
export function fixingStep(state: ClaudeKeyState): number | null {
  if (state === 'refused' || state === 'wrong' || state === 'no-access') return 1
  if (state === 'no-credit' || state === 'busy') return 2
  // The keychain could not open the saved key: pasting it again is the fix.
  if (state === 'unreadable') return 3
  if (state === 'none') return 0
  return null
}

/** The status for a state, with its message. */
export function keyStatus(state: ClaudeKeyState, confirmed = false, key?: string | null): ClaudeKeyStatus {
  return { state, message: keyMessage(state, key), confirmed }
}

/** What someone was trying to do when the gate stopped them, for the sentence that says so. */
export type Blocked = 'footage' | 'words' | 'command' | 'notes' | 'export' | 'link' | 'edit' | 'learn'

const DOING: Record<Blocked, string> = {
  footage: 'read footage',
  words: 'work on what you ask',
  command: 'run a command',
  notes: 'carry out notes',
  export: 'export',
  link: 'open a link',
  edit: 'change the edit',
  learn: 'learn from your videos'
}

/**
 * One plain sentence for an action the gate stopped, pointing to the setup
 * steps: on Start, or, said on the setup screen itself, to the steps there
 * and to doing it again once they are done.
 */
export function blockedSentence(
  what: Blocked,
  status?: ClaudeKeyStatus | null,
  where: 'start' | 'here' = 'start'
): string {
  const why =
    !status || status.state === 'none' || status.state === 'checking'
      ? 'an Anthropic key'
      : status.state === 'no-credit'
        ? 'credit on your Anthropic account'
        : 'an Anthropic key that works'
  const next = where === 'here' ? 'Follow the steps here, then try again.' : 'Start shows the steps.'
  return `I need ${why} before I can ${DOING[what]}. ${next}`
}
