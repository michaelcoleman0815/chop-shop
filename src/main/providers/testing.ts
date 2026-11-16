import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import ffmpegStatic from 'ffmpeg-static'
import { vi } from 'vitest'
import type { ServiceId } from '../../shared/services'
import { createGate, type Gate } from './gate'

/**
 * Test helpers: a fetch that answers from a script and remembers exactly
 * what it was sent, so tests can check each request against the service's
 * documentation. Only imported by tests.
 */

export interface SentRequest {
  method: string
  url: string
  headers: Headers
  /** The body as text, when it was text. */
  text: string | null
  /** The body as bytes, when it was bytes. */
  bytes: Uint8Array | null
}

export type Answer = (req: SentRequest) => Response | Promise<Response>

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

/** A fetch that hands out the answers in order and records every request it is sent. */
export function scriptedFetch(answers: Answer[]): {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sent: SentRequest[]
  spy: ReturnType<typeof vi.fn>
} {
  const sent: SentRequest[] = []
  const queue = [...answers]
  const spy = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const body = init.body
    const req: SentRequest = {
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      text: typeof body === 'string' ? body : null,
      bytes: body instanceof Uint8Array ? body : null
    }
    sent.push(req)
    const answer = queue.shift()
    if (!answer) throw new Error(`No answer scripted for ${req.method} ${url}`)
    return answer(req)
  })
  return { fetch: (url, init) => spy(url, init), sent, spy }
}

export function gateFor(
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  opts: { on?: boolean; keys?: Partial<Record<ServiceId, string>> } = {}
): Gate {
  return createGate({ on: () => opts.on ?? true, key: (id) => opts.keys?.[id] ?? null, fetch })
}

/**
 * ffmpeg found the way cut-render.test.ts finds it: FFMPEG_PATH, then
 * ffmpeg-static, then the PATH. Null when there is none, so tests that need
 * it skip and say why.
 */
export function findFfmpeg(): string | null {
  for (const bin of [process.env.FFMPEG_PATH, ffmpegStatic as unknown as string | null, 'ffmpeg']) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

export function hasEncoder(ffmpeg: string | null, encoder: string): boolean {
  if (!ffmpeg) return false
  return new RegExp(`\\b${encoder}\\b`).test(spawnSync(ffmpeg, ['-hide_banner', '-encoders']).stdout.toString())
}

/** Said in a suite's name when it is skipped for want of ffmpeg. */
export const NO_FFMPEG = 'skipped: no ffmpeg in FFMPEG_PATH, ffmpeg-static or on the PATH'
