import { readdirSync, readFileSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * The shape of the code, checked: other AI services are reached through the
 * gate and nothing else, their keys are read in one place, and nothing in
 * providers/ logs. A new request that went round the gate would fail here
 * before it could ship.
 */

const MAIN = join(__dirname, '..')
const PROVIDERS = __dirname

function sources(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ file: relative(MAIN, join(dir, f)), text: readFileSync(join(dir, f), 'utf8') }))
}

const HOSTS = ['api.deepgram.com', 'api.assemblyai.com', 'generativelanguage.googleapis.com']

describe('one way out', () => {
  const provider = sources(PROVIDERS).filter((s) => s.file !== join('providers', 'testing.ts'))

  it('sends every request to another AI service from the gate alone', () => {
    const fetching = provider.filter((s) => /\bfetch\s*\(|https?\.request|\bnet\.request/.test(s.text))
    expect(fetching.map((s) => s.file).sort()).toEqual([join('providers', 'gate.ts'), join('providers', 'index.ts')])
    // gate.ts calls the fetch it was given; index.ts only hands it Electron's.
    expect(provider.find((s) => s.file.endsWith('gate.ts'))?.text).toMatch(/deps\.fetch\(/)
    const wiring = provider.find((s) => s.file.endsWith('index.ts'))?.text ?? ''
    expect(wiring.match(/\bfetch\s*\(/g)).toHaveLength(1)
    expect(wiring).toMatch(/fetch: \(url, init\) => net\.fetch\(url, init\)/)
  })

  it('names the services’ hosts nowhere outside providers/', () => {
    const outside = sources(MAIN).filter((s) => !s.file.startsWith('providers'))
    for (const { file, text } of outside)
      for (const host of HOSTS) expect(`${file}: ${text.includes(host)}`).toBe(`${file}: false`)
  })

  it('reads service keys in one place, for the gate', () => {
    const reads = provider.filter((s) => /keys\.read\(/.test(s.text))
    expect(reads.map((s) => s.file)).toEqual([join('providers', 'index.ts')])
    expect(reads[0].text.match(/keys\.read\(/g)).toHaveLength(1)
    expect(reads[0].text).toMatch(/key: \(id\) => keys\.read\(id\)/)
  })

  it('logs nothing, so no key can end up in a log', () => {
    for (const { file, text } of provider) expect(`${file}: ${/console\./.test(text)}`).toBe(`${file}: false`)
  })
})
