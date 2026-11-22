// The account Function (functions/api/account/[[path]].js) against a real SQLite database standing in for D1
// (Node's own, node:sqlite: Node 22 or later), and a stand-in Resend.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { onRequest } from '../functions/api/account/[[path]].js'

/** D1's API over an SQLite database: prepare, bind, first, run, batch. */
function d1(db) {
  const prepare = (sql) => {
    const stmt = db.prepare(sql)
    let args = []
    const bound = {
      bind: (...a) => {
        args = a
        return bound
      },
      first: async () => stmt.get(...args) ?? null,
      run: async () => ({ success: true, meta: { changes: Number(stmt.run(...args).changes) } }),
      all: async () => ({ results: stmt.all(...args) })
    }
    return bound
  }
  return { db, prepare, batch: async (list) => Promise.all(list.map((s) => s.run())) }
}

const VAULT_KEY = Buffer.alloc(32, 7).toString('base64')
let env
let mails
const realFetch = globalThis.fetch

beforeEach(() => {
  env = { ACCOUNTS_DB: d1(new DatabaseSync(':memory:')), RESEND_API_KEY: 're_test', VAULT_KEY }
  mails = []
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.resend.com/emails')
    mails.push(JSON.parse(init.body))
    return new Response('{}', { status: 200 })
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
})

async function call(path, { method = 'POST', body, token, origin } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (origin) headers.Origin = origin
  const request = new Request(`https://cutalong.io/api/account/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const res = await onRequest({ request, env, params: { path: path.split('/') } })
  return { status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers }
}

const codeIn = (mail) => /\b(\d{8})\b/.exec(mail.subject)[1]
const everything = () =>
  ['codes', 'sessions', 'vaults']
    .flatMap((t) => env.ACCOUNTS_DB.db.prepare(`SELECT * FROM ${t}`).all())
    .map((row) => JSON.stringify(row))
    .join('\n')

async function signIn(email = 'Pastor@Example.com') {
  assert.equal((await call('code', { body: { email } })).status, 200)
  const r = await call('verify', { body: { email, code: codeIn(mails.at(-1)) } })
  assert.equal(r.status, 200)
  return r.body.token
}

describe('signing in', () => {
  it('emails an eight-digit code and trades it for a token, keeping only hashes', async () => {
    const token = await signIn()
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/)
    assert.deepEqual(mails[0].to, ['pastor@example.com'])
    const kept = everything()
    assert.ok(!kept.includes(token), 'the token is not kept')
    assert.ok(!kept.includes(codeIn(mails[0])), 'the code is not kept')
  })

  it('uses a code once', async () => {
    await call('code', { body: { email: 'a@b.co' } })
    const code = codeIn(mails[0])
    assert.equal((await call('verify', { body: { email: 'a@b.co', code } })).status, 200)
    assert.equal((await call('verify', { body: { email: 'a@b.co', code } })).body.reason, 'expired')
  })

  it('takes five tries at a code however many guesses come at once, then none', async () => {
    await call('code', { body: { email: 'a@b.co' } })
    const code = codeIn(mails[0])
    const wrong = code === '00000000' ? '11111111' : '00000000'
    const guesses = await Promise.all(Array.from({ length: 50 }, () => call('verify', { body: { email: 'a@b.co', code: wrong } })))
    assert.equal(guesses.filter((g) => g.body.reason === 'wrong').length, 5)
    assert.ok(guesses.every((g) => g.status !== 200))
    // The right code, after the five: turned away, and the code is gone.
    const late = await call('verify', { body: { email: 'a@b.co', code } })
    assert.notEqual(late.status, 200)
  })

  it('sends at most five codes an hour to one address, and none to a broken one', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('code', { body: { email: 'a@b.co' } })).status, 200)
    assert.equal((await call('code', { body: { email: 'a@b.co' } })).body.reason, 'too-many')
    assert.equal((await call('code', { body: { email: 'not an address' } })).body.reason, 'invalid')
    assert.equal(mails.length, 5)
  })

  it('says accounts are not switched on without their settings', async () => {
    env = { ACCOUNTS_DB: env.ACCOUNTS_DB }
    const r = await call('code', { body: { email: 'a@b.co' } })
    assert.equal(r.status, 503)
    assert.equal(r.body.reason, 'not-connected')
  })
})

describe('the vault', () => {
  it('is kept encrypted, and handed back to the same account on any copy', async () => {
    const token = await signIn()
    assert.deepEqual((await call('vault', { method: 'GET', token })).body.vault, null)
    const vault = { v: 1, entries: { 'key:anthropic': { value: 'sk-ant-api03-secret', at: '2026-11-22T00:00:00.000Z' } } }
    const put = await call('vault', { method: 'PUT', token, body: { vault, base: null } })
    assert.equal(put.status, 200)
    assert.ok(!everything().includes('sk-ant'), 'the stored vault does not show the key')
    const other = await signIn('pastor@example.com')
    const got = await call('vault', { method: 'GET', token: other })
    assert.deepEqual(got.body.vault, vault)
    assert.equal(got.body.updatedAt, put.body.updatedAt)
  })

  it('saves one of two copies saving at once, and hands the other the newer vault to merge', async () => {
    const token = await signIn()
    const [a, b] = await Promise.all([
      call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: { a: { value: 1, at: 't1' } } }, base: null } }),
      call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: { b: { value: 2, at: 't1' } } }, base: null } })
    ])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    const lost = a.status === 409 ? a : b
    const won = a.status === 200 ? a : b
    assert.equal(lost.body.updatedAt, won.body.updatedAt)
    const next = await call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: {} }, base: won.body.updatedAt } })
    assert.equal(next.status, 200)
    assert.ok(next.body.updatedAt > won.body.updatedAt)
    // A save against the older time is the stale one now.
    const stale = await call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: {} }, base: won.body.updatedAt } })
    assert.equal(stale.status, 409)
  })

  it('is closed to a token that signed out, or none', async () => {
    const token = await signIn()
    assert.equal((await call('signout', { token })).status, 200)
    assert.equal((await call('vault', { method: 'GET', token })).body.reason, 'signed-out')
    assert.equal((await call('vault', { method: 'GET' })).status, 401)
  })
})

describe('the phone', () => {
  it('lets the phone’s web view read the replies, and no other page', async () => {
    for (const origin of ['capacitor://localhost', 'https://localhost']) {
      const r = await call('code', { body: { email: 'a@b.co' }, origin })
      assert.equal(r.headers.get('Access-Control-Allow-Origin'), origin)
    }
    const other = await call('code', { body: { email: 'c@d.co' }, origin: 'https://evil.example' })
    assert.equal(other.headers.get('Access-Control-Allow-Origin'), null)
    const pre = await call('vault', { method: 'OPTIONS', origin: 'capacitor://localhost' })
    assert.equal(pre.status, 204)
    assert.match(pre.headers.get('Access-Control-Allow-Headers'), /Authorization/)
  })
})
