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
 * One thing still goes out after that: cleanUp, which deletes what this app
 * left with a service in a job, such as the audio AssemblyAI holds for a
 * transcript. Deleting the person's own data is never a send.
 */

interface Route {
  hosts: readonly string[]
  /** The header that carries the key, as each service's API reference gives it. */
  auth: (key: string) => Record<string, string>
  /**
   * Where a service puts what it made for download, if not on its own hosts:
   * fetched with a plain GET and never with the key, only for a URL the
   * service itself handed back.
   */
  media?: (url: URL) => boolean
  /**
   * A request that leaves something of the person's with the service until
   * it is deleted, and where it is deleted: the gate notes each one it sees
   * succeed, so cleanUp can delete exactly those and nothing else.
   */
  leaves?: { method: 'POST'; path: string; deleteUrl: (reply: unknown) => string | null }
}

export const ROUTES: Record<ServiceId, Route> = {
  // https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
  deepgram: { hosts: ['api.deepgram.com'], auth: (key) => ({ Authorization: `Token ${key}` }) },
  // https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/files/upload
  assemblyai: {
    hosts: ['api.assemblyai.com'],
    auth: (key) => ({ Authorization: key }),
    // A transcript holds the uploaded audio until the transcript is deleted.
    // https://www.assemblyai.com/docs/pre-recorded-audio/api-reference/transcripts/delete
    leaves: {
      method: 'POST',
      path: '/v2/transcript',
      deleteUrl: (reply) => {
        const id = (reply as { id?: unknown } | null)?.id
        return typeof id === 'string' && /^[\w-]+$/.test(id) ? `https://api.assemblyai.com/v2/transcript/${id}` : null
      }
    }
  },
  // https://ai.google.dev/api/generate-content, and for made videos the Interactions API:
  // https://aistudio.google.com/docs/image-generation, https://aistudio.google.com/docs/omni
  gemini: { hosts: ['generativelanguage.googleapis.com'], auth: (key) => ({ 'x-goog-api-key': key }) },
  // https://docs.fal.ai/model-apis/model-endpoints/queue: "Authorization: Key $FAL_KEY"; results are
  // "publicly accessible" on fal's media hosts (v3.fal.media, v3b.fal.media, fal.media).
  fal: {
    hosts: ['queue.fal.run', 'fal.run', 'api.fal.ai'],
    auth: (key) => ({ Authorization: `Key ${key}` }),
    media: (url) =>
      url.hostname === 'fal.media' ||
      url.hostname.endsWith('.fal.media') ||
      (url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/falserverless/'))
  },
  // https://elevenlabs.io/docs/api-reference/authentication: "xi-api-key".
  elevenlabs: { hosts: ['api.elevenlabs.io'], auth: (key) => ({ 'xi-api-key': key }) },
  // https://developers.openai.com/api/docs/guides/text-to-speech: "Authorization: Bearer $OPENAI_API_KEY".
  openai: { hosts: ['api.openai.com'], auth: (key) => ({ Authorization: `Bearer ${key}` }) }
}

const CLEANUP_TIMEOUT_MS = 15_000

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
  | 'cancelled'
  | 'failed'
  /** The key works, and its account has run out of credit: never tried again. */
  | 'no-credit'

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
  /**
   * The service had taken the job on when this happened (a queued request,
   * or a request sent whose answer was lost), so it runs, and is billed,
   * whatever became of the answer. Such a job is counted as spent and never
   * sent again.
   */
  readonly accepted: boolean

  constructor(
    service: ServiceId,
    kind: FailureKind,
    message: string,
    extra: { status?: number | null; retryAfterSec?: number | null; detail?: string | null; accepted?: boolean } = {}
  ) {
    super(message)
    this.name = 'ServiceError'
    this.service = service
    this.kind = kind
    this.status = extra.status ?? null
    this.retryAfterSec = extra.retryAfterSec ?? null
    this.detail = extra.detail ?? null
    this.accepted = extra.accepted ?? false
  }
}

/** The same failure, marked as a job the service had already taken on. */
export function taken(err: unknown, service: ServiceId): ServiceError {
  if (err instanceof ServiceError)
    return err.accepted
      ? err
      : new ServiceError(err.service, err.kind, err.message, {
          status: err.status,
          retryAfterSec: err.retryAfterSec,
          detail: err.detail,
          accepted: true
        })
  return new ServiceError(service, 'failed', `${serviceName(service)} took the job, and then something went wrong.`, {
    detail: err instanceof Error ? err.message : String(err),
    accepted: true
  })
}

/** Whether a failure is worth trying again: the service was busy, slow, unreachable or broken on its side. */
export function transient(err: unknown): boolean {
  if (!(err instanceof ServiceError)) return false
  if (err.kind === 'busy' || err.kind === 'timeout' || err.kind === 'unreachable') return true
  return err.kind === 'failed' && (err.status === null || err.status >= 500)
}

/**
 * Whether a failed request surely left the service with no job to run: it
 * was refused before it went, answered with an error, or never connected.
 * A request cut off after it went (a timeout, a dropped connection, a Stop,
 * the switch turned off in flight) may have been taken on, and billed.
 */
export function notTaken(err: unknown): boolean {
  if (!(err instanceof ServiceError) || err.accepted) return false
  if (err.kind === 'timeout' || err.kind === 'cancelled') return false
  if (err.kind === 'off') return !/in flight/i.test(err.detail ?? '')
  if (err.kind === 'unreachable') return /ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/.test(err.detail ?? '')
  return true
}

export interface Reply {
  status: number
  headers: Headers
  /** The whole body, already read, with the key scrubbed out. Empty when the body was read as bytes. */
  text: string
  /** The body as bytes, when it was asked for that way (sound, pictures). */
  bytes: Uint8Array | null
  /** The body as JSON. A body that is not JSON is the service sending back something unreadable. */
  json(): unknown
}

export interface SendInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  headers?: Record<string, string>
  body?: Uint8Array | string
  /** Give up after this long, body included. */
  timeoutMs: number
  /** Read the body as bytes rather than text: a sound file, a picture. */
  bytes?: boolean
  /** Stops the request, as Cancel does. */
  signal?: AbortSignal
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
  /**
   * Fetches something a service made from where the service put it: a plain
   * GET, never with the key, only from that service's own media hosts, with
   * the same switch and key rules as send.
   */
  download(service: ServiceId, url: string, init: { timeoutMs: number; signal?: AbortSignal }): Promise<Uint8Array>
  /** Stops every request in flight. Used when the switch is turned off. */
  closeAll(): void
  /**
   * Deletes something of the person's this app left with a service in a job,
   * such as an AssemblyAI transcript and the audio uploaded for it: only a
   * DELETE, only to a URL the gate saw that service create, only once. It
   * goes even when the switch has been turned off since, and closeAll does
   * not stop it. Resolves to whether the service confirmed the deletion.
   */
  cleanUp(service: ServiceId, url: string): Promise<boolean>
}

export function createGate(deps: GateDeps): Gate {
  const inflight = new Set<AbortController>()
  /** What this app left with each service and has not deleted yet, as "service url". */
  const left = new Set<string>()

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
      let bytes: Uint8Array | null = null
      try {
        const res = await deps.fetch(target.toString(), {
          method: init.method ?? 'GET',
          headers,
          // Node's fetch takes bytes as they are; the cast is only for its narrower body type.
          body: init.body as RequestInit['body'],
          // None of these endpoints redirect, and a redirect could carry the key to another host.
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, timeout, ...(init.signal ? [init.signal] : [])])
        })
        status = res.status
        replyHeaders = res.headers
        // Read here, inside the timeout and the switch, rather than by the caller.
        if (init.bytes && res.status >= 200 && res.status < 300) {
          bytes = new Uint8Array(await res.arrayBuffer())
          text = ''
        } else text = scrub(await res.text(), key)
      } catch (err) {
        if (controller.signal.aborted) {
          throw new ServiceError(service, 'off', `Other AI services were turned off while I waited for ${name}.`, {
            detail: 'Stopped in flight.'
          })
        }
        if (init.signal?.aborted) throw new ServiceError(service, 'cancelled', `Stopped before ${name} answered.`)
        if (timeout.aborted) throw new ServiceError(service, 'timeout', `${name} took too long to answer.`)
        throw new ServiceError(service, 'unreachable', `I could not reach ${name}.`, {
          detail: scrub(described(err), key)
        })
      }
      if (status < 200 || status >= 300) throw failure(service, status, text, replyHeaders)
      const leaves = ROUTES[service].leaves
      if (leaves && (init.method ?? 'GET') === leaves.method && target.pathname === leaves.path) {
        const url = leaves.deleteUrl(parsed(text))
        if (url) left.add(`${service} ${url}`)
      }
      return {
        status,
        headers: replyHeaders,
        text,
        bytes,
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

  const download = async (
    service: ServiceId,
    url: string,
    init: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<Uint8Array> => {
    const name = serviceName(service)
    if (!deps.on()) throw new ServiceError(service, 'off', 'Other AI services are off in Settings.')
    if (!deps.key(service)) throw new ServiceError(service, 'no-key', `There is no ${name} key in Settings.`)
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new ServiceError(service, 'failed', `${name} gave me an address I can't read.`)
    }
    const media = ROUTES[service].media
    if (target.protocol !== 'https:' || target.port || !media || !media(target)) {
      throw new ServiceError(service, 'failed', `I only fetch what ${name} made from ${name}'s own storage.`)
    }
    const controller = new AbortController()
    const timeout = AbortSignal.timeout(init.timeoutMs)
    inflight.add(controller)
    try {
      let res: Response
      try {
        // No key and no headers of the person's: the address alone fetches it.
        res = await deps.fetch(target.toString(), {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, timeout, ...(init.signal ? [init.signal] : [])])
        })
      } catch (err) {
        if (controller.signal.aborted)
          throw new ServiceError(service, 'off', `Other AI services were turned off while I waited for ${name}.`)
        if (init.signal?.aborted) throw new ServiceError(service, 'cancelled', `Stopped before ${name} answered.`)
        if (timeout.aborted) throw new ServiceError(service, 'timeout', `${name} took too long to answer.`)
        throw new ServiceError(service, 'unreachable', `I could not reach ${name}.`, {
          detail: described(err)
        })
      }
      if (!res.ok) {
        await res.text().catch(() => '')
        throw new ServiceError(service, 'failed', `${name} did not hand over what it made (${res.status}).`, {
          status: res.status
        })
      }
      return new Uint8Array(await res.arrayBuffer())
    } finally {
      inflight.delete(controller)
    }
  }

  const closeAll = (): void => {
    for (const controller of inflight) controller.abort()
    inflight.clear()
  }

  const cleanUp = async (service: ServiceId, url: string): Promise<boolean> => {
    const entry = `${service} ${url}`
    if (!left.has(entry)) return false
    left.delete(entry)
    const key = deps.key(service)
    if (!key) return false
    try {
      const res = await deps.fetch(url, {
        method: 'DELETE',
        headers: new Headers(ROUTES[service].auth(key)),
        redirect: 'error',
        // Its own timeout and not in flight for closeAll: turning the switch off must not stop it.
        signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS)
      })
      await res.text().catch(() => '')
      return res.ok
    } catch {
      return false
    }
  }

  return { open, refusal, send, download, closeAll, cleanUp }
}

/** A fetch failure in words, with the system's code for it when there is one ("fetch failed (ECONNREFUSED)"). */
function described(err: unknown): string {
  const said = err instanceof Error ? err.message : String(err)
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause
  const code = typeof cause?.code === 'string' ? cause.code : null
  return code && !said.includes(code) ? `${said} (${code})` : said
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** A key never travels back out of the gate, even if a service echoes it. */
function scrub(text: string, key: string): string {
  return key.length >= 4 ? text.split(key).join('[key]') : text
}

function failure(service: ServiceId, status: number, text: string, headers: Headers): ServiceError {
  const name = serviceName(service)
  const extra = { status, detail: text.slice(0, 300) }
  // A key that works on an account with nothing left: 402, ElevenLabs' 401 quota_exceeded, OpenAI's 429
  // insufficient_quota, fal's 403 "Exhausted balance", Google's prepaid credits run out. Said plainly, never retried.
  if (
    status === 402 ||
    (status === 401 && /quota_exceeded/i.test(text)) ||
    (status === 429 && /insufficient_quota|credits? (?:are |is )?(?:depleted|exhausted)|prepa(?:id|yment) credit/i.test(text)) ||
    (status === 403 && /exhausted balance|insufficient (?:balance|credits?|funds)|top up your balance|out of credits?/i.test(text))
  )
    return new ServiceError(service, 'no-credit', `${name} says the account has no credit left.`, extra)
  // Google answers a key it does not know with 400 and API_KEY_INVALID.
  if (status === 401 || (status === 400 && /API_KEY_INVALID|API key not valid/i.test(text))) {
    return new ServiceError(service, 'refused', `${name} did not accept the key.`, extra)
  }
  if (status === 403) return new ServiceError(service, 'refused', `${name} did not let this key do that.`, extra)
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
