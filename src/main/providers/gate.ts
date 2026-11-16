import { serviceName, type ServiceId } from '../../shared/services'

/**
 * The one way out to another AI service.
 *
 * Every request to Deepgram, AssemblyAI or Google Gemini is sent by `send`
 * here, whether it carries audio, video excerpts or only a key check. It
 * refuses before anything leaves the Mac when the switch in Settings is off
 * or the service has no key, and it only ever talks to that service's own
 * host, never following a redirect elsewhere. The key is attached here, so no
 * caller holds it, and it is scrubbed from anything that comes back. Nothing
 * here logs.
 *
 * Turning the switch off also stops requests already in flight (closeAll).
 */

interface Route {
  hosts: readonly string[]
  /** The header that carries the key, as each service's API reference gives it. */
  auth: (key: string) => Record<string, string>
}

export const ROUTES: Record<ServiceId, Route> = {
  // https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
  deepgram: { hosts: ['api.deepgram.com'], auth: (key) => ({ Authorization: `Token ${key}` }) },
  // https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/files/upload
  assemblyai: { hosts: ['api.assemblyai.com'], auth: (key) => ({ Authorization: key }) },
  // https://ai.google.dev/api/generate-content
  gemini: { hosts: ['generativelanguage.googleapis.com'], auth: (key) => ({ 'x-goog-api-key': key }) }
}

export type FailureKind =
  | 'off'
  | 'no-key'
  | 'refused'
  | 'busy'
  | 'timeout'
  | 'unreachable'
  | 'too-big'
  | 'unreadable'
  | 'declined'
  | 'failed'

/**
 * Why a service could not be used. The message is one plain sentence that
 * can stand alone in the interface; detail keeps what the service said, with
 * the key scrubbed out.
 */
export class ServiceError extends Error {
  readonly service: ServiceId
  readonly kind: FailureKind
  readonly status: number | null
  readonly retryAfterSec: number | null
  readonly detail: string | null

  constructor(
    service: ServiceId,
    kind: FailureKind,
    message: string,
    extra: { status?: number; retryAfterSec?: number | null; detail?: string } = {}
  ) {
    super(message)
    this.name = 'ServiceError'
    this.service = service
    this.kind = kind
    this.status = extra.status ?? null
    this.retryAfterSec = extra.retryAfterSec ?? null
    this.detail = extra.detail ?? null
  }
}

export interface Reply {
  status: number
  headers: Headers
  /** The whole body, already read, with the key scrubbed out. */
  text: string
  /** The body as JSON. A body that is not JSON is the service sending back something unreadable. */
  json(): unknown
}

export interface SendInit {
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: Uint8Array | string
  /** Give up after this long, body included. */
  timeoutMs: number
}

export interface GateDeps {
  /** The switch in Settings, read again for every request. */
  on: () => boolean
  /** The service's key from the keychain, or null. */
  key: (service: ServiceId) => string | null
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

export interface Gate {
  /** Whether a request to this service would be let out right now: the switch is on and it has a key. */
  open(service: ServiceId): boolean
  /** Why a request to this service would be refused right now, or null when it would go. Sends nothing. */
  refusal(service: ServiceId): ServiceError | null
  /** Sends one request and reads the whole reply, or refuses. Every failure is a ServiceError. */
  send(service: ServiceId, url: string, init: SendInit): Promise<Reply>
  /** Stops every request in flight. Used when the switch is turned off. */
  closeAll(): void
}

export function createGate(deps: GateDeps): Gate {
  const inflight = new Set<AbortController>()

  const refusal = (service: ServiceId): ServiceError | null => {
    if (!deps.on()) return new ServiceError(service, 'off', 'Other AI services are off in Settings.')
    if (!deps.key(service)) {
      return new ServiceError(service, 'no-key', `There is no ${serviceName(service)} key in Settings.`)
    }
    return null
  }

  const open = (service: ServiceId): boolean => refusal(service) === null

  const send = async (service: ServiceId, url: string, init: SendInit): Promise<Reply> => {
    const name = serviceName(service)
    if (!deps.on()) throw new ServiceError(service, 'off', 'Other AI services are off in Settings.')
    const key = deps.key(service)
    if (!key) throw new ServiceError(service, 'no-key', `There is no ${name} key in Settings.`)

    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new ServiceError(service, 'failed', `I only send ${name} requests to ${name}.`)
    }
    if (target.protocol !== 'https:' || !ROUTES[service].hosts.includes(target.hostname) || target.port) {
      throw new ServiceError(service, 'failed', `I only send ${name} requests to ${name}.`)
    }

    const headers = new Headers(init.headers)
    for (const [header, value] of Object.entries(ROUTES[service].auth(key))) headers.set(header, value)

    const controller = new AbortController()
    const timeout = AbortSignal.timeout(init.timeoutMs)
    inflight.add(controller)
    try {
      let status: number
      let replyHeaders: Headers
      let text: string
      try {
        const res = await deps.fetch(target.toString(), {
          method: init.method ?? 'GET',
          headers,
          // Node's fetch takes bytes as they are; the cast is only for its narrower body type.
          body: init.body as RequestInit['body'],
          // None of these endpoints redirect, and a redirect could carry the key to another host.
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, timeout])
        })
        status = res.status
        replyHeaders = res.headers
        // Read here, inside the timeout and the switch, rather than by the caller.
        text = scrub(await res.text(), key)
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ServiceError(service, 'off', `Other AI services were turned off while I waited for ${name}.`)
        }
        if (timeout.aborted) throw new ServiceError(service, 'timeout', `${name} took too long to answer.`)
        throw new ServiceError(service, 'unreachable', `I could not reach ${name}.`, {
          detail: scrub(err instanceof Error ? err.message : String(err), key)
        })
      }
      if (status < 200 || status >= 300) throw failure(service, status, text, replyHeaders)
      return {
        status,
        headers: replyHeaders,
        text,
        json: () => {
          try {
            return JSON.parse(text) as unknown
          } catch {
            throw new ServiceError(service, 'unreadable', `${name} sent back something I could not read.`, {
              status,
              detail: text.slice(0, 300)
            })
          }
        }
      }
    } finally {
      inflight.delete(controller)
    }
  }

  const closeAll = (): void => {
    for (const controller of inflight) controller.abort()
    inflight.clear()
  }

  return { open, refusal, send, closeAll }
}

/** A key never travels back out of the gate, even if a service echoes it. */
function scrub(text: string, key: string): string {
  return key.length >= 4 ? text.split(key).join('[key]') : text
}

function failure(service: ServiceId, status: number, text: string, headers: Headers): ServiceError {
  const name = serviceName(service)
  const extra = { status, detail: text.slice(0, 300) }
  // Google answers a key it does not know with 400 and API_KEY_INVALID.
  if (status === 401 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(text))) {
    return new ServiceError(service, 'refused', `${name} did not accept the key.`, extra)
  }
  if (status === 403) return new ServiceError(service, 'refused', `${name} did not let this key do that.`, extra)
  if (status === 402) return new ServiceError(service, 'failed', `${name} says the account has no credit left.`, extra)
  if (status === 413) return new ServiceError(service, 'too-big', `${name} said the upload is too big.`, extra)
  if (status === 429) {
    const wait = Number(headers.get('retry-after'))
    return new ServiceError(service, 'busy', `${name} is busy right now.`, {
      ...extra,
      retryAfterSec: Number.isFinite(wait) && wait > 0 ? wait : null
    })
  }
  if (status === 408 || status === 504) {
    return new ServiceError(service, 'timeout', `${name} took too long to answer.`, extra)
  }
  if (status >= 500) return new ServiceError(service, 'failed', `${name} had a problem on its side (${status}).`, extra)
  return new ServiceError(service, 'failed', `${name} could not take the request (${status}).`, extra)
}
