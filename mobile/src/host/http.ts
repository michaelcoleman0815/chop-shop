import type { HttpOptions, HttpResponse } from '@capacitor/core'

/**
 * Requests to the other AI services, sent by the phone itself through
 * Capacitor's native HTTP rather than by the page: they then never depend on
 * what each service lets a web page do, and the page's own policy
 * (index.html) still keeps the page to itself and Anthropic. Only the gate
 * (src/main/providers/gate.ts) is given this, so a request can only go to a
 * service whose switch is on and that has a key.
 *
 * Bytes travel as base64 with dataType 'file', which iOS and Android turn back
 * into the same bytes; JSON travels as an object, the way both send it.
 */

export type NativeRequest = (options: HttpOptions) => Promise<HttpResponse>

export function nativeFetch(request: NativeRequest): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, name) => (headers[canonical(name)] = value))
    const options: HttpOptions = {
      url,
      method: init.method ?? 'GET',
      headers,
      responseType: 'text',
      // A redirect comes back as it is, to be refused: a key never follows one to another host.
      disableRedirects: init.redirect === 'error' || init.redirect === 'manual'
    }
    const body = init.body
    if (body instanceof Uint8Array) {
      options.data = toBase64(body)
      options.dataType = 'file'
    } else if (typeof body === 'string') {
      options.data = /application\/json/i.test(headers['Content-Type'] ?? '') ? (JSON.parse(body) as unknown) : body
    } else if (body !== undefined && body !== null) {
      throw new TypeError('A service is only sent text or bytes from the phone.')
    }
    const reply = await abortable(request(options), init.signal)
    const text = reply.data == null ? '' : typeof reply.data === 'string' ? reply.data : JSON.stringify(reply.data)
    const replyHeaders = new Headers()
    for (const [name, value] of Object.entries(reply.headers ?? {})) {
      try {
        replyHeaders.set(name, String(value))
      } catch {
        // A line the platform reports that is not a header, such as the status line.
      }
    }
    const empty = reply.status === 204 || reply.status === 304
    return new Response(empty ? null : text, { status: reply.status, headers: replyHeaders })
  }
}

/** Content-Type, Authorization, X-Goog-Api-Key: the spelling the native side looks a header up by. */
function canonical(name: string): string {
  return name.toLowerCase().replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase())
}

export function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

/** The native request cannot be stopped; when the signal fires, its answer is no longer waited for. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | null | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(reason(signal))
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(reason(signal))
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

function reason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}
