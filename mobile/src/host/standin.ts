/**
 * Anthropic, stood in for while CI drives the app (drive.ts, built in only
 * with CUTALONG_DRIVE=1). The requests the shared work makes to
 * api.anthropic.com are answered here as the API answers them, so the drive
 * goes through the key gate without a key and with one, and nothing leaves
 * the emulator or the simulator:
 *
 *   GET  /v1/models/:id   the key check (Start's steps, Settings, launch): a
 *                         key starting sk-ant- works; one ending -refused,
 *                         -no-credit or -busy is answered so
 *   POST /v1/messages     told apart by the system prompt: reading a message
 *                         before its footage (main/triage.ts) gets a route
 *                         from the words and the files, as Claude would choose
 *                         it; planning (main/planner.ts) gets an empty plan;
 *                         anything else a 400, a request Claude cannot take,
 *                         so the app falls back the way it does then
 *
 * `down` answers every message with 529, overloaded, as Anthropic does when
 * it is: a key it accepted before keeps the gate open meanwhile.
 */

export interface StandInRequest {
  kind: 'key check' | 'triage' | 'plan' | 'other'
  /** The start of the key for a key check, the words asked for a message. */
  said: string
  status: number
  /** The road a triage took. */
  route?: string
}

export interface StandIn {
  /** Every request answered, in order, for the drive's report. */
  requests: StandInRequest[]
  answer(url: string, init?: RequestInit): Promise<Response>
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_standin' }
  })

const failure = (status: number, type: string, message: string): Response =>
  json(status, { type: 'error', error: { type, message }, request_id: 'req_standin' })

const message = (model: string, text: string): Response =>
  json(200, {
    id: `msg_standin_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 }
  })

interface Asked {
  all: string
  request: string
  files: string
  edit: string
}

/** The words and lists a request carries, as the app writes them. */
function readRequest(body: { messages?: { content?: string | { text?: string }[] }[] }): Asked {
  const blocks = body.messages?.[0]?.content ?? []
  const all = typeof blocks === 'string' ? blocks : blocks.map((b) => b.text ?? '').join('\n\n')
  const between = (tag: string): string | null => {
    const m = new RegExp(`<${tag}[^>]*>\\n?([\\s\\S]*?)\\n?</${tag}>`).exec(all)
    return m ? m[1] : null
  }
  return { all, request: between('request') ?? '', files: between('files') ?? '', edit: between('edit') ?? '' }
}

/** The road a message takes, as Claude would read it. */
export function triageAnswer({ request, files, edit }: Pick<Asked, 'request' | 'files' | 'edit'>): Record<string, unknown> {
  const t = request.toLowerCase()
  const lengths = [...files.matchAll(/: (?:(\d+):)?(\d+):(\d+),/g)].map(
    (m) => Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3])
  )
  const longest = Math.max(0, ...lengths)
  const route =
    files.trim() === 'none' && !/open in this chat/.test(edit)
      ? /\?$/.test(request.trim())
        ? 'answer'
        : 'wait'
      : /\bv-?log|day in the life/.test(t)
        ? 'vlog'
        : /\bclips?\b|highlights|shorts from/.test(t) && longest > 600
          ? 'clipping'
          : 'edit'
  const count = Number(/\b(\d+)\s+(?:funny\s+)?clips\b/.exec(t)?.[1] ?? 0)
  return {
    route,
    reply:
      route === 'wait'
        ? "Drop your footage and I'll start on it."
        : route === 'answer'
          ? 'Cutalong cuts what you drop by what you say.'
          : '',
    link: 'none',
    clip: { count, minSec: 0, maxSec: 0, funny: /funn/.test(t), topic: '' },
    question: { text: '', options: [] }
  }
}

const EMPTY_PLAN = {
  ops: [],
  summary: '',
  reply: 'I left the edit as it was.',
  notesHandled: [],
  needs: [],
  question: { text: '', options: [] }
}

export function anthropicStandIn(options: { down?: boolean } = {}): StandIn {
  const requests: StandInRequest[] = []
  const note = (r: StandInRequest): void => void (requests.length < 80 && requests.push(r))
  return {
    requests,
    answer: async (url, init) => {
      const { pathname } = new URL(url)
      const method = (init?.method ?? 'GET').toUpperCase()
      const key = new Headers(init?.headers).get('x-api-key') ?? ''
      const model = /^\/v1\/models\/([^/?]+)/.exec(pathname)?.[1]
      if (method === 'GET' && model) {
        const said = `${key.slice(0, 12)}…${key.slice(-9)}`
        const answer = (status: number, response: Response): Response => {
          note({ kind: 'key check', said, status })
          return response
        }
        if (!key.startsWith('sk-ant-')) return answer(401, failure(401, 'authentication_error', 'invalid x-api-key'))
        if (key.endsWith('-refused')) return answer(401, failure(401, 'authentication_error', 'invalid x-api-key'))
        if (key.endsWith('-no-credit'))
          return answer(
            400,
            failure(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')
          )
        if (key.endsWith('-busy'))
          return answer(429, failure(429, 'rate_limit_error', 'Number of requests has exceeded your rate limit.'))
        return answer(
          200,
          json(200, {
            type: 'model',
            id: decodeURIComponent(model),
            display_name: 'Stand-in',
            created_at: '2026-10-01T00:00:00Z'
          })
        )
      }
      if (method === 'POST' && pathname.startsWith('/v1/messages')) {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          model?: string
          system?: string | { text?: string }[]
          messages?: { content?: string | { text?: string }[] }[]
        }
        // The system prompt is a list of blocks, or a string.
        const system = typeof body.system === 'string' ? body.system : (body.system ?? []).map((s) => s.text ?? '').join('\n')
        const asked = readRequest(body)
        const kind: StandInRequest['kind'] = system.startsWith('You read a message a video creator sent to Cutalong')
          ? 'triage'
          : system.startsWith('You are the editor inside Cutalong')
            ? 'plan'
            : 'other'
        const said = (asked.request || system).slice(0, 80)
        if (options.down) {
          note({ kind, said, status: 529 })
          return failure(529, 'overloaded_error', 'Overloaded')
        }
        if (kind === 'triage') {
          const answer = triageAnswer(asked)
          note({ kind, said, status: 200, route: String(answer.route) })
          return message(body.model ?? '', JSON.stringify(answer))
        }
        if (kind === 'plan') {
          note({ kind, said, status: 200 })
          return message(body.model ?? '', JSON.stringify(EMPTY_PLAN))
        }
        note({ kind, said, status: 400 })
        return failure(400, 'invalid_request_error', 'The stand-in does not answer this request.')
      }
      return failure(404, 'not_found_error', `Nothing at ${pathname}`)
    }
  }
}
