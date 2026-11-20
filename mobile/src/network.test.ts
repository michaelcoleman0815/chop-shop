import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../../src/main/providers/gate'
import { PHONE_SERVICES } from './host/services'

/**
 * Where the phone app may send anything. The page's content security policy
 * lets it reach only itself (the app, its files and, in a browser, the dev
 * bridge that serves it) and Anthropic, which it calls with the person's key
 * (api.test.ts shows the key goes with every request, and that nothing is
 * sent without one). The transcription model comes through the native file
 * transfer, from whisper.cpp's published models, only when it is needed.
 * The other AI services are reached by the phone itself, through the gate
 * the Mac uses, which lets a request out only while their switch is on and
 * only with their key (services.test.ts).
 */

const here = join(__dirname, '..')
const csp = (): Record<string, string[]> => {
  const html = readFileSync(join(here, 'index.html'), 'utf8')
  const content = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? ''
  return Object.fromEntries(
    content
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name, values])
  )
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.ts$|testing\.ts$/.test(name) ? [path] : []
  })
}

describe('what the phone app can reach', () => {
  it('reaches only itself and Anthropic from the page', () => {
    const policy = csp()
    expect(policy['default-src']).toEqual(["'self'"])
    expect(policy['connect-src']).toEqual(["'self'", 'https://api.anthropic.com'])
    expect(policy['script-src']).toEqual(["'self'"])
    // Media, pictures and fonts come from the app and its own files, never from elsewhere.
    for (const d of ['media-src', 'img-src', 'font-src'])
      expect(
        policy[d].filter((v) => /^https?:/.test(v)),
        d
      ).toEqual([])
  })

  it('names no other host in the phone host than whisper.cpp’s models', () => {
    const hosts = new Set<string>()
    for (const file of sources(join(here, 'src'))) {
      for (const m of readFileSync(file, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) hosts.add(m[1])
    }
    expect([...hosts]).toEqual([])
    // The model's address lives with the shared transcription, the same as the Mac's.
    const shared = readFileSync(join(here, '../src/main/transcribe.ts'), 'utf8')
    expect([...shared.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1])).toEqual(['huggingface.co'])
  })

  it('hands the phone’s own HTTP to the other AI services’ gate and nothing else', () => {
    // fetch is not switched to the native HTTP, so the page's own requests stay under its policy.
    expect(readFileSync(join(here, 'capacitor.config.ts'), 'utf8')).not.toMatch(/CapacitorHttp/)
    const users = sources(join(here, 'src')).filter((f) => /CapacitorHttp|nativeFetch\(/.test(readFileSync(f, 'utf8')))
    expect(users.map((f) => relative(here, f)).sort()).toEqual(['src/host/boot.ts', 'src/host/http.ts'])
    const boot = readFileSync(join(here, 'src/host/boot.ts'), 'utf8')
    expect(boot.match(/nativeFetch\(/g)).toHaveLength(1)
    expect(boot).toMatch(/phoneServices\(\{[^}]*nativeFetch\(/s)
    // The gate sends each service's requests to that service's own hosts, and to nothing else; a phone keeps
    // keys only for hearing the words and judging takes, so those hosts are all its gate can reach. The
    // services of a video made from nothing have routes in the gate, for the Mac, and never a key here.
    expect(PHONE_SERVICES.flatMap((id) => ROUTES[id].hosts).sort()).toEqual([
      'api.assemblyai.com',
      'api.deepgram.com',
      'generativelanguage.googleapis.com'
    ])
  })
})
