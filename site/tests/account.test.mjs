// The account Function (functions/api/account/[[path]].js) against a stand-in KV and a stand-in Resend.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { onRequest } from '../functions/api/account/[[path]].js'

function memoryKv() {
  const map = new Map()
  return {
    map,
    async get(key, type) {
      const v = map.get(key)
      if (v === undefined) return null
      return type === 'json' ? JSON.parse(v) : v
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      map.delete(key)
    }
  }
}

const VAULT_KEY = Buffer.alloc(32, 7).toString('base64')
let env
let mails
const realFetch = globalThis.fetch

beforeEach(() => {
  env = { ACCOUNTS: memoryKv(), RESEND_API_KEY: 're_test', VAULT_KEY }
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

async function signIn(email = 'Pastor@Example.com') {
  assert.equal((await call('code', { body: { email } })).status, 200)
  const code = /\b(\d{6})\b/.exec(mails.at(-1).subject)[1]
  const r = await call('verify', { body: { email, code } })
  assert.equal(r.status, 200)
  return r.body.token
}

describe('signing in', () => {
  it('emails a six-digit code and trades it for a token, keeping only hashes', async () => {
    const token = await signIn()
    assert.match(token, /^[A-Za-z0-9_-]{40,}$/)
    assert.deepEqual(mails[0].to, ['pastor@example.com'])
    const kept = [...env.ACCOUNTS.map.entries()].map(([k, v]) => `${k} ${v}`).join('\n')
    assert.ok(!kept.includes(token), 'the token is not kept')
    assert.ok(!kept.includes(/\b(\d{6})\b/.exec(mails[0].subject)[1]), 'the code is not kept')
  })

  it('turns away a wrong code, then every code after five wrong ones', async () => {
    await call('code', { body: { email: 'a@b.co' } })
    for (let i = 0; i < 5; i++) assert.equal((await call('verify', { body: { email: 'a@b.co', code: '000000' } })).body.reason, 'wrong')
    const code = /\b(\d{6})\b/.exec(mails[0].subject)[1]
    assert.equal((await call('verify', { body: { email: 'a@b.co', code } })).body.reason, 'too-many-tries')
  })

  it('sends at most five codes an hour to one address, and none to a broken one', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await call('code', { body: { email: 'a@b.co' } })).status, 200)
    assert.equal((await call('code', { body: { email: 'a@b.co' } })).body.reason, 'too-many')
    assert.equal((await call('code', { body: { email: 'not an address' } })).body.reason, 'invalid')
    assert.equal(mails.length, 5)
  })

  it('says accounts are not switched on without their settings, and keeps nothing', async () => {
    env = { ACCOUNTS: memoryKv() }
    const r = await call('code', { body: { email: 'a@b.co' } })
    assert.equal(r.status, 503)
    assert.equal(r.body.reason, 'not-connected')
    assert.equal(env.ACCOUNTS.map.size, 0)
  })
})

describe('the vault', () => {
  it('is kept encrypted, and handed back to the same account on any copy', async () => {
    const token = await signIn()
    assert.deepEqual((await call('vault', { method: 'GET', token })).body.vault, null)
    const vault = { v: 1, entries: { 'key:anthropic': { value: 'sk-ant-api03-secret', at: '2026-11-22T00:00:00.000Z' } } }
    const put = await call('vault', { method: 'PUT', token, body: { vault, base: null } })
    assert.equal(put.status, 200)
    const raw = env.ACCOUNTS.map.get('vault:pastor@example.com')
    assert.ok(!raw.includes('sk-ant'), 'the stored vault does not show the key')
    const other = await signIn('pastor@example.com')
    const got = await call('vault', { method: 'GET', token: other })
    assert.deepEqual(got.body.vault, vault)
    assert.equal(got.body.updatedAt, put.body.updatedAt)
  })

  it('refuses a save made against an older copy, and hands over the newer one to merge', async () => {
    const token = await signIn()
    const first = await call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: { a: { value: 1, at: 't1' } } }, base: null } })
    const stale = await call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: {} }, base: null } })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.updatedAt, first.body.updatedAt)
    assert.deepEqual(stale.body.vault.entries.a, { value: 1, at: 't1' })
    const next = await call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: {} }, base: first.body.updatedAt } })
    assert.equal(next.status, 200)
    assert.ok(next.body.updatedAt > first.body.updatedAt)
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
