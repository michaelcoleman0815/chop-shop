import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { request } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findFfmpeg } from '../../../src/main/test-media'

/**
 * The engine bridge (mobile/dev/engine-bridge.mjs) runs this computer's ffmpeg
 * with the arguments it is sent. Any website open in the same browser can reach
 * 127.0.0.1, so the bridge answers only the app's own page and tools run here.
 */

const FFMPEG = findFfmpeg()
const BRIDGE = join(__dirname, '..', '..', 'dev', 'engine-bridge.mjs')
const PORT = 20000 + Math.floor(Math.random() * 20000)

let bridge: ChildProcess
let root: string

/** A request as a browser or a tool would send it, with the headers given (Host included). */
function call(
  path: string,
  headers: Record<string, string>,
  body = '{}'
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { host: `127.0.0.1:${PORT}`, ...headers } },
      (res) => {
        let text = ''
        res.on('data', (d) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

/** What a page would send to have ffmpeg write a file: here, a tenth of a second of silence. */
const writes = (out: string): string =>
  JSON.stringify({ id: 'x', tool: 'ffmpeg', args: ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=8000', '-t', '0.1', out] })

describe('the engine bridge', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'cutalong-bridge-'))
    bridge = spawn(process.execPath, [BRIDGE, '--port', String(PORT), '--root', root, '--ffmpeg', FFMPEG ?? 'ffmpeg'])
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The bridge did not start.')), 20_000)
      bridge.stdout?.on('data', (d: Buffer) => {
        if (d.toString().includes('phone app at')) {
          clearTimeout(timer)
          resolve()
        }
      })
      bridge.on('exit', (code) => reject(new Error(`The bridge stopped (${code}).`)))
    })
  }, 30_000)

  afterAll(() => {
    bridge?.kill()
    rmSync(root, { recursive: true, force: true })
  })

  it('answers the app’s own page and tools run on this computer', async () => {
    // A tool: no Origin, as Node, curl and Playwright's request API send.
    expect((await call('/engine/info', { 'content-type': 'application/json' })).status).toBe(200)
    // The page it serves, by either of its names.
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`]) {
      const own = await call('/engine/info', {
        host,
        origin: `http://${host}`,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json'
      })
      expect(own.status, host).toBe(200)
      expect(JSON.parse(own.text).platform).toBe('ios')
    }
  })

  it('refuses another site, even with a request a browser sends without asking', async () => {
    const out = join(root, 'Documents', 'from-a-website.wav')
    // fetch(…, { mode: 'no-cors', body: text }) from any page: no preflight, so only the bridge can say no.
    const r = await call('/engine/run', {
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
      'content-type': 'text/plain;charset=UTF-8'
    }, writes(out))
    expect(r.status).toBe(403)
    expect(existsSync(out)).toBe(false)
    // An origin alone, as an older browser sends it, and a site that only says where it is from.
    expect((await call('/engine/info', { origin: 'http://localhost.evil.example' })).status).toBe(403)
    expect((await call('/engine/info', { origin: 'null' })).status).toBe(403)
    expect((await call('/engine/info', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await call('/engine/pick-next', { origin: 'https://evil.example' }, '{"paths":["/etc/hosts"]}')).status).toBe(403)
  })

  it('refuses another name for this computer, as a page that rebinds its own name to it sends', async () => {
    const r = await call('/engine/info', { host: `evil.example:${PORT}`, origin: `http://evil.example:${PORT}` })
    expect(r.status).toBe(403)
    expect((await call('/engine/info', { host: `evil.example:${PORT}` })).status).toBe(403)
  })

  it.skipIf(!FFMPEG)('still runs ffmpeg for the app’s own page', async () => {
    const out = join(root, 'Documents', 'from-the-app.wav')
    const r = await call('/engine/run', { origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' }, writes(out))
    expect(r.status).toBe(200)
    expect(existsSync(out)).toBe(true)
  })
})
