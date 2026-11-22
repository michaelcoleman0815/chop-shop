// The email list's Function, without Cloudflare: its handler against a fake KV namespace.
//
//   npm test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import config from '../site.config.mjs'
import { onRequest } from '../functions/api/signup.js'

const ENDPOINT = `https://${config.domain}/api/signup`
const ORIGIN = `https://${config.domain}`
const ADDED = config.downloadReady
  ? 'You’re on the list. One email for each of these as it ships, and nothing else.'
  : 'You’re on the list. One email when Cutalong is ready, and nothing else.'

// The parts of a KV namespace the Function uses. `fail` makes reads or writes throw the way KV does.
function fakeKV({ fail } = {}) {
  const store = new Map()
  return {
    store,
    async get(key) {
      if (fail === 'get') throw new Error('KV GET failed: 500 Internal Server Error')
      return store.has(key) ? store.get(key).value : null
    },
    async put(key, value, options = {}) {
      if (fail === 'put') throw new Error(`KV PUT failed: 429 Too Many Requests (${key})`)
      store.set(key, { value, metadata: options.metadata })
    }
  }
}

function post(fields, headers = {}) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Origin: ORIGIN, ...headers },
    body: new URLSearchParams(fields)
  })
}

// Every reply: never cached, never containing an address that was sent.
async function call(request, env, sent = []) {
  const response = await onRequest({ request, env })
  const body = await response.text()
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  for (const address of sent) assert.ok(!body.toLowerCase().includes(address.toLowerCase()), `the reply repeats ${address}`)
  const json = /^application\/json/.test(response.headers.get('Content-Type')) ? JSON.parse(body) : null
  return { status: response.status, headers: response.headers, body, json }
}

test('a valid address is kept with the time and where it came from, and nothing else', async () => {
  const kv = fakeKV()
  const before = Date.now()
  const r = await call(post({ email: '  Reader.One@Example.com ', source: 'hero' }), { SIGNUPS: kv }, ['Reader.One@Example.com'])
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, message: ADDED })
  assert.deepEqual([...kv.store.keys()], ['reader.one@example.com'])
  const { value, metadata } = kv.store.get('reader.one@example.com')
  const record = JSON.parse(value)
  assert.deepEqual(Object.keys(record).sort(), ['at', 'email', 'source'])
  assert.equal(record.email, 'reader.one@example.com')
  assert.equal(record.source, 'hero')
  assert.ok(Date.parse(record.at) >= before - 1000 && Date.parse(record.at) <= Date.now(), 'the time is now')
  assert.deepEqual(metadata, { at: record.at, source: 'hero' })
})

test('an address already on the list keeps its first record and gets the same reply', async () => {
  const kv = fakeKV()
  await call(post({ email: 'twice@example.com', source: 'hero' }), { SIGNUPS: kv })
  const first = kv.store.get('twice@example.com').value
  const r = await call(post({ email: 'TWICE@example.com', source: 'close' }), { SIGNUPS: kv }, ['twice@example.com'])
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, message: ADDED })
  assert.equal(kv.store.size, 1)
  assert.equal(kv.store.get('twice@example.com').value, first)
})

test('only the known parts of the page are kept as where it came from', async () => {
  const kv = fakeKV()
  for (const source of ['hero', 'header', 'close', 'soon', 'link', 'iphone', 'windows', 'android']) {
    await call(post({ email: `${source}@example.com`, source }), { SIGNUPS: kv })
    assert.equal(JSON.parse(kv.store.get(`${source}@example.com`).value).source, source)
  }
  await call(post({ email: 'odd@example.com', source: '<script>alert(1)</script>' }), { SIGNUPS: kv })
  await call(post({ email: 'none@example.com' }), { SIGNUPS: kv })
  assert.equal(JSON.parse(kv.store.get('odd@example.com').value).source, 'unknown')
  assert.equal(JSON.parse(kv.store.get('none@example.com').value).source, 'unknown')
})

test('an invalid address is refused in plain words, and nothing is kept', async () => {
  const kv = fakeKV()
  // None of these appear in the reply's own example, so the check that the reply never repeats them means something.
  const invalid = [
    'reader',
    'reader@',
    '@site.org',
    'reader@site',
    'reader@site.o',
    'reader@.site.org',
    'reader@-site.org',
    'reader@site..org',
    're ader@site.org',
    'reader@si te.org',
    'reader@site.org>',
    '"reader"@site.org',
    'reader@sïte.org',
    `${'r'.repeat(65)}@site.org`,
    `reader@${'s'.repeat(250)}.org`
  ]
  for (const email of invalid) {
    const r = await call(post({ email }), { SIGNUPS: kv }, [email])
    assert.equal(r.status, 400, email)
    assert.deepEqual(r.json, { ok: false, error: 'invalid', message: 'That address looks incomplete. Write it as name@example.com.' }, email)
  }
  assert.equal(kv.store.size, 0)
})

test('a missing address is asked for', async () => {
  const kv = fakeKV()
  for (const fields of [{}, { email: '' }, { email: '   ' }]) {
    const r = await call(post(fields), { SIGNUPS: kv })
    assert.equal(r.status, 400)
    assert.deepEqual(r.json, { ok: false, error: 'missing', message: 'Write your email address first.' })
  }
  assert.equal(kv.store.size, 0)
})

test('the honeypot gets the ordinary reply, and nothing is kept', async () => {
  const kv = fakeKV()
  const r = await call(post({ email: 'bot@example.com', website: 'https://spam.example', source: 'hero' }), { SIGNUPS: kv }, ['bot@example.com'])
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, message: ADDED })
  assert.equal(kv.store.size, 0)
})

test('a KV failure says so plainly, keeps nothing, and logs no address', async (t) => {
  const logged = t.mock.method(console, 'error', () => {})
  for (const fail of ['put', 'get']) {
    const kv = fakeKV({ fail })
    const r = await call(post({ email: 'unlucky@example.com' }), { SIGNUPS: kv }, ['unlucky@example.com'])
    assert.equal(r.status, 503, fail)
    assert.equal(r.json.error, 'not-saved')
    assert.equal(r.json.message, `The list couldn’t save that just now. Try again in a minute, or write to ${config.contactEmail}.`)
    assert.equal(kv.store.size, 0)
  }
  assert.equal(logged.mock.callCount(), 2)
  for (const entry of logged.mock.calls) assert.ok(!entry.arguments.join(' ').includes('unlucky@example.com'), 'the log names the address')
})

test('without the SIGNUPS binding it says the list is not connected', async () => {
  const r = await call(post({ email: 'early@example.com' }), {}, ['early@example.com'])
  assert.equal(r.status, 503)
  assert.equal(r.json.error, 'not-connected')
  assert.equal(r.json.message, `The list isn’t connected yet, so nothing was saved. Write to ${config.contactEmail} instead.`)
})

test('it takes only a form, posted from this site', async () => {
  const kv = fakeKV()
  const get = await call(new Request(ENDPOINT, { headers: { Accept: 'application/json' } }), { SIGNUPS: kv })
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('Allow'), 'POST')
  assert.equal(get.json.error, 'method')

  const elsewhere = await call(post({ email: 'x@example.com' }, { Origin: 'https://elsewhere.example' }), { SIGNUPS: kv })
  assert.equal(elsewhere.status, 403)
  assert.equal(elsewhere.json.error, 'cross-site')

  const json = await call(
    new Request(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: '{"email":"x@example.com"}' }),
    { SIGNUPS: kv }
  )
  assert.equal(json.status, 415)
  assert.equal(json.json.error, 'not-a-form')

  const large = await call(post({ email: 'x@example.com', padding: 'x'.repeat(5000) }), { SIGNUPS: kv })
  assert.equal(large.status, 413)
  assert.equal(large.json.error, 'too-large')
  assert.equal(kv.store.size, 0)
})

test('a multipart form works too, and a request with no Origin is taken', async () => {
  const kv = fakeKV()
  const form = new FormData()
  form.set('email', 'multi@example.com')
  form.set('source', 'soon')
  const r = await call(new Request(ENDPOINT, { method: 'POST', headers: { Accept: 'application/json' }, body: form }), { SIGNUPS: kv }, ['multi@example.com'])
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(kv.store.get('multi@example.com').value).source, 'soon')
})

test('a browser without script is answered with a page, with no address in it', async () => {
  const kv = fakeKV()
  const html = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
  const added = await call(post({ email: 'nojs@example.com', source: 'soon' }, html), { SIGNUPS: kv }, ['nojs@example.com'])
  assert.equal(added.status, 200)
  assert.match(added.headers.get('Content-Type'), /^text\/html/)
  assert.match(added.headers.get('Content-Security-Policy'), /default-src 'none'/)
  assert.ok(added.body.includes(ADDED))
  assert.ok(added.body.includes('href="/#signup"'))
  assert.equal(kv.store.size, 1)

  const invalid = await call(post({ email: 'nojs@example' }, html), { SIGNUPS: kv }, ['nojs@example'])
  assert.equal(invalid.status, 400)
  assert.ok(invalid.body.includes('That address looks incomplete.'))
})
