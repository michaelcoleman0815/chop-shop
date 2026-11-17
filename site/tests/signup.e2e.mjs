// The email list end to end: the built site and the real Function under `wrangler pages dev`, in Chrome.
//
//   npm run test:e2e
//
// It builds dist/, starts Wrangler on a throwaway local KV store, and uses the form the way people do:
// from the hero's button, with nothing written, with an address only the Function refuses, with a right
// one, as a bot, from /download, and without script. Then it reads the store and checks that it holds
// exactly the addresses that should be there, each with its time and where it came from, and nothing else.
//
// Wrangler runs with npx at the version below, or from WRANGLER=/path/to/wrangler. Playwright is found
// the way npm run check finds it, and Chrome through CHROME_PATH.

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import config from '../site.config.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER_VERSION = '4.156.2'
const PORT = Number(process.env.PORT || 8799)
const BASE = `http://127.0.0.1:${PORT}`
// The throwaway store sits in .wrangler/, where Wrangler keeps local state (ignored by git), and goes when the test ends.
mkdirSync(join(ROOT, '.wrangler'), { recursive: true })
const STATE = mkdtempSync(join(ROOT, '.wrangler', 'e2e-'))
const ADDED = config.downloadReady
  ? 'You’re on the list. One email for each of these as it ships, and nothing else.'
  : 'You’re on the list. One email when Cutalong is ready, and nothing else.'

const wrangler = (args) =>
  process.env.WRANGLER ? [process.env.WRANGLER, args] : ['npx', ['--yes', `wrangler@${WRANGLER_VERSION}`, ...args]]

let pw
try {
  pw = await import('playwright')
} catch {
  const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
  pw = await import(pathToFileURL(createRequire(join(root, 'noop.js')).resolve('playwright')).href)
}
const { chromium } = pw.default ?? pw
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)

execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' })
const [command, args] = wrangler([
  'pages', 'dev', 'dist', '--kv', 'SIGNUPS', '--ip', '127.0.0.1', '--port', String(PORT), '--persist-to', STATE,
  '--compatibility-date', '2026-11-01', '--show-interactive-dev-session=false'
])
const server = spawn(command, args, { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (d) => (serverLog += d))
server.stderr.on('data', (d) => (serverLog += d))

let browser
let failed = false
const step = async (name, fn) => {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed = true
    console.log(`not ok - ${name}\n  ${String(error.message).split('\n').join('\n  ')}`)
  }
}

try {
  await waitForServer()
  browser = await chromium.launch(chrome ? { executablePath: chrome } : {})
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // Chrome logs every 4xx as "Failed to load resource"; the refused address above is meant to get one.
  page.on('console', (m) => m.type() === 'error' && !/status of 400/.test(m.text()) && errors.push(m.text()))
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })

  await step('no download is offered before there is a release', async () => {
    assert.equal(await page.getByText('Download for Mac').count(), 0)
    assert.equal(await page.locator('a[href*="github.com"]').count(), 0)
    assert.equal(await page.getByRole('link', { name: 'Get notified when it’s ready' }).count(), 1)
  })

  await step('the hero’s button leads to the email field and notes where it came from', async () => {
    await page.getByRole('link', { name: 'Get notified when it’s ready' }).first().click()
    await page.waitForFunction(() => document.activeElement?.id === 'signup')
    assert.equal(await source(page), 'hero')
    // The jump scrolls smoothly; it lands with the heading and the label in view above the field, below the header.
    await page.waitForFunction(() => {
      const field = document.querySelector('#signup').getBoundingClientRect()
      const heading = document.querySelector('#signup-title').getBoundingClientRect()
      const header = document.querySelector('.slab').getBoundingClientRect()
      return heading.top >= header.bottom && field.bottom <= innerHeight
    }, null, { timeout: 5000 })
  })

  await step('nothing written is caught before anything is sent', async () => {
    let sent = false
    page.on('request', (r) => r.url().endsWith('/api/signup') && (sent = true))
    await page.press('#signup', 'Enter')
    assert.equal(await help(page), 'Write your email address first.')
    assert.equal(sent, false)
  })

  await step('an address the browser lets through is refused by the Function, in plain words', async () => {
    const r = await submit(page, 'reader@site')
    assert.equal(r.status, 400)
    assert.equal(r.help, 'That address looks incomplete. Write it as name@example.com.')
    assert.equal(await page.getAttribute('#signup', 'aria-invalid'), 'true')
  })

  await step('a right address is kept, and the field empties', async () => {
    const r = await submit(page, 'Reader.One@Example.com')
    assert.equal(r.status, 200)
    assert.equal(r.help, ADDED)
    assert.equal(await page.inputValue('#signup'), '')
    assert.equal(await page.getAttribute('#signup', 'aria-invalid'), null)
  })

  await step('a bot that fills in the hidden field gets the same reply', async () => {
    await page.evaluate(() => (document.querySelector('input[name="website"]').value = 'https://spam.example'))
    const r = await submit(page, 'bot@example.com')
    assert.equal(r.status, 200)
    assert.equal(r.help, ADDED)
    await page.evaluate(() => (document.querySelector('input[name="website"]').value = ''))
  })

  await step('/download goes to the email field, and the list notes the link', async () => {
    const r = await page.request.get(BASE + '/download', { maxRedirects: 0 })
    assert.equal(r.status(), 302)
    assert.equal(r.headers().location, '/#signup')
    await page.goto(BASE + '/download', { waitUntil: 'networkidle' })
    assert.equal(new URL(page.url()).hash, '#signup')
    assert.equal(await source(page), 'link')
    assert.equal((await submit(page, 'linked@example.com')).status, 200)
  })

  await step('without script, the form posts itself and the Function answers with a page', async () => {
    const plain = await browser.newContext({ javaScriptEnabled: false })
    const p = await plain.newPage()
    await p.goto(BASE + '/')
    await p.fill('#signup', 'nojs@example.com')
    // Enter, not a click: with page script off, Playwright cannot run its check that a button has stopped moving.
    await Promise.all([p.waitForURL('**/api/signup'), p.press('#signup', 'Enter')])
    const text = await p.textContent('main')
    assert.ok(text.includes(ADDED), text)
    assert.ok(!text.includes('nojs@example.com'))
    assert.equal(await p.getAttribute('main a', 'href'), '/#signup')
    await plain.close()
  })

  await step('no reply can be cached or carries the address', async () => {
    for (const email of ['again@example.com', 'again@example']) {
      const r = await page.request.post(BASE + '/api/signup', {
        headers: { Accept: 'application/json', Origin: BASE },
        form: { email, source: 'soon' }
      })
      assert.equal(r.headers()['cache-control'], 'no-store')
      assert.ok(!(await r.text()).includes(email))
    }
  })

  await step('the page logged no errors', async () => assert.deepEqual(errors, []))

  await step('the store holds the four addresses left, each with its time and where it came from, and not the bot’s or the refused ones', async () => {
    const list = readStore(['kv', 'key', 'list'])
    const kept = Object.fromEntries(list.map((k) => [k.name, k.metadata]))
    assert.deepEqual(Object.keys(kept).sort(), ['again@example.com', 'linked@example.com', 'nojs@example.com', 'reader.one@example.com'])
    assert.equal(kept['reader.one@example.com'].source, 'hero')
    assert.equal(kept['linked@example.com'].source, 'link')
    assert.equal(kept['nojs@example.com'].source, 'soon')
    for (const [name, metadata] of Object.entries(kept)) {
      assert.deepEqual(Object.keys(metadata).sort(), ['at', 'source'], name)
      assert.ok(Date.now() - Date.parse(metadata.at) < 10 * 60 * 1000, `${name} has a time from this run`)
    }
    const record = JSON.parse(readStore(['kv', 'key', 'get', 'reader.one@example.com', '--text'], false))
    assert.deepEqual(Object.keys(record).sort(), ['at', 'email', 'source'])
  })
} finally {
  await browser?.close()
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {}
  rmSync(STATE, { recursive: true, force: true })
}

if (failed) {
  console.log('\nThe server said:\n' + serverLog.split('\n').filter((l) => !/Request\.cf|^\s+at |Request was cancelled/.test(l)).slice(-30).join('\n'))
  process.exit(1)
}
console.log('the email list works end to end')

async function waitForServer() {
  const until = Date.now() + 90_000
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`wrangler stopped:\n${serverLog}`)
    try {
      if ((await fetch(BASE + '/')).ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`wrangler did not answer on ${BASE}:\n${serverLog}`)
}

async function submit(page, value) {
  await page.fill('#signup', value)
  const reply = page.waitForResponse((r) => r.url().endsWith('/api/signup'))
  await page.press('#signup', 'Enter')
  const response = await reply
  assert.equal(response.headers()['cache-control'], 'no-store')
  await page.waitForFunction(() => !document.querySelector('form[data-signup]').hasAttribute('aria-busy'))
  return { status: response.status(), help: await help(page) }
}

function help(page) {
  return page.evaluate(() => document.querySelector('[data-signup-help]').textContent.trim())
}

function source(page) {
  return page.evaluate(() => document.querySelector('[data-signup-source]').value)
}

function readStore(kvArgs, json = true) {
  const [cmd, cmdArgs] = wrangler([...kvArgs, '--namespace-id', 'SIGNUPS', '--local', '--persist-to', STATE])
  const out = execFileSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return json ? JSON.parse(out.slice(out.indexOf('['))) : out.slice(out.indexOf('{'))
}
