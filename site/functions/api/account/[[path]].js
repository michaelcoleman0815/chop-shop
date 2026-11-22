// /api/account/*: Cutalong accounts. Sign in with an emailed code, and the app keeps its keys, settings, brands
// and presets here, so every copy (the Mac, Windows, the phone) has them without typing them in again.
//
//   POST /api/account/code     { email }            emails an eight-digit code, good for ten minutes
//   POST /api/account/verify   { email, code }      a session token for the app, good for a year
//   GET  /api/account/vault    Bearer token         the account's vault, or null before the first sync
//   PUT  /api/account/vault    Bearer token         { vault, base }: saved when base is the time it was read at;
//                                                    otherwise 409 with the newer vault, to merge and send again
//   POST /api/account/signout  Bearer token         this session ends
//
// Cloudflare Pages runs this file as a Function, beside functions/api/signup.js. It needs, in the Pages project's
// settings (README.md, "Accounts"):
//   ACCOUNTS_DB     a D1 database: codes, sessions and vaults, in the tables SQL.schema makes on first use. A
//                   database, not KV: a try at a code is counted in the same statement that reads it, so no number
//                   of guesses sent at once gets past the limit, and a vault is saved only if no other copy saved
//                   since it was read
//   RESEND_API_KEY  a Resend key, for the emails with the codes, from a domain verified there
//   VAULT_KEY       32 random bytes, base64: vaults are kept encrypted with it (AES-GCM), so the stored copy
//                   reads as nothing without it
//   MAIL_FROM       optional, the sender: "Cutalong <sign-in@cutalong.io>" when absent
// Without them every call says the accounts are not connected yet, and nothing is kept.
//
// Codes and tokens are kept only as SHA-256 hashes. No reply is cached. The app's own requests carry no cookie, so
// a page elsewhere cannot act for anyone; the phone's web view (capacitor://localhost, https://localhost) is let
// read the replies.

import config from '../../../site.config.mjs'

const CODE_SEC = 600
const SESSION_SEC = 365 * 86400
const MAX_TRIES = 5
const CODES_PER_HOUR = 5
const CODES_PER_DAY = 20
const CODE_DIGITS = 8
const MAX_BODY = 512 * 1024

// Every statement the account runs, in one place: D1's SQLite. Times are milliseconds since 1970, but a vault's
// updated_at, which is an ISO time the app sends back as the base of its next save.
export const SQL = {
  schema: [
    'CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT NOT NULL, tries INTEGER NOT NULL, expires INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sent (email TEXT PRIMARY KEY, hour_count INTEGER NOT NULL, hour_from INTEGER NOT NULL, day_count INTEGER NOT NULL, day_from INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS vaults (email TEXT PRIMARY KEY, iv TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL)'
  ],
  // A code sent, counted this hour and this day in one statement: ?1 email, ?2 now, ?3 an hour ago, ?4 a day ago.
  countSent:
    'INSERT INTO sent (email, hour_count, hour_from, day_count, day_from) VALUES (?1, 1, ?2, 1, ?2) ' +
    'ON CONFLICT(email) DO UPDATE SET ' +
    'hour_count = CASE WHEN sent.hour_from < ?3 THEN 1 ELSE sent.hour_count + 1 END, ' +
    'hour_from = CASE WHEN sent.hour_from < ?3 THEN ?2 ELSE sent.hour_from END, ' +
    'day_count = CASE WHEN sent.day_from < ?4 THEN 1 ELSE sent.day_count + 1 END, ' +
    'day_from = CASE WHEN sent.day_from < ?4 THEN ?2 ELSE sent.day_from END ' +
    'RETURNING hour_count, day_count',
  putCode:
    'INSERT INTO codes (email, hash, tries, expires) VALUES (?1, ?2, 0, ?3) ' +
    'ON CONFLICT(email) DO UPDATE SET hash = ?2, tries = 0, expires = ?3',
  // One try used up, in the same statement that hands back the code to compare: ?1 email, ?2 the limit, ?3 now.
  useTry: 'UPDATE codes SET tries = tries + 1 WHERE email = ?1 AND tries < ?2 AND expires > ?3 RETURNING hash',
  codeState: 'SELECT tries, expires FROM codes WHERE email = ?1',
  // The code used once: only the request that deletes it signs in.
  takeCode: 'DELETE FROM codes WHERE email = ?1 AND hash = ?2',
  dropCode: 'DELETE FROM codes WHERE email = ?1',
  putSession: 'INSERT INTO sessions (hash, email, expires) VALUES (?1, ?2, ?3)',
  session: 'SELECT email FROM sessions WHERE hash = ?1 AND expires > ?2',
  dropSession: 'DELETE FROM sessions WHERE hash = ?1',
  vault: 'SELECT iv, data, updated_at FROM vaults WHERE email = ?1',
  // A first vault, only where there is none; then a save only over the one it was merged with.
  firstVault: 'INSERT INTO vaults (email, iv, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(email) DO NOTHING',
  nextVault: 'UPDATE vaults SET iv = ?2, data = ?3, updated_at = ?4 WHERE email = ?1 AND updated_at = ?5'
}

const made = new WeakMap()
/** The tables, made once for each database the Function is handed. */
function tables(db) {
  if (!made.has(db)) {
    made.set(
      db,
      db.batch(SQL.schema.map((q) => db.prepare(q))).catch((err) => {
        made.delete(db)
        throw err
      })
    )
  }
  return made.get(db)
}

const APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost', `https://${config.domain}`]

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const ADDRESS = new RegExp(
  `^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]{1,64}@(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`
)

const SAY = {
  'not-connected': [503, `Accounts aren’t switched on yet. Write to ${config.contactEmail} if you need one now.`],
  'not-sent': [502, 'The email with your code didn’t go out. Try again in a minute.'],
  invalid: [400, 'That address looks incomplete. Write it as name@example.com.'],
  'too-many': [429, 'That’s a lot of codes for one address. Try again in an hour.'],
  expired: [400, 'That code has run out. Ask for a new one.'],
  wrong: [400, 'That code isn’t the one I sent. Check the email and try again.'],
  'too-many-tries': [429, 'Too many wrong codes. Ask for a new one.'],
  'signed-out': [401, 'You’re signed out. Sign in again.'],
  'too-large': [413, 'That’s more than an account keeps.'],
  'not-json': [415, 'Send JSON.'],
  method: [405, 'That isn’t something the account does.'],
  'not-found': [404, 'That isn’t something the account does.']
}

export async function onRequest({ request, env = {}, params = {} }) {
  const origin = request.headers.get('Origin')
  const cors = APP_ORIGINS.includes(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {}
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, PUT, POST',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    })
  }
  const reply = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
    })
  const fail = (reason, extra = {}) => reply(SAY[reason][0], { ok: false, reason, message: SAY[reason][1], ...extra })

  const path = (Array.isArray(params.path) ? params.path : [params.path].filter(Boolean)).join('/')
  const db = env.ACCOUNTS_DB
  if (!db || !env.VAULT_KEY) return fail('not-connected')
  await tables(db)
  const now = Date.now()
  const q = (sql, ...args) => db.prepare(sql).bind(...args)

  let body = null
  if (request.method === 'POST' || request.method === 'PUT') {
    if (!/^application\/json\b/i.test(request.headers.get('Content-Type') || '')) return fail('not-json')
    const text = await request.text()
    if (text.length > MAX_BODY) return fail('too-large')
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      return fail('not-json')
    }
  }

  if (path === 'code') {
    if (request.method !== 'POST') return fail('method')
    if (!env.RESEND_API_KEY) return fail('not-connected')
    const email = address(body.email)
    if (!email) return fail('invalid')
    const sent = await q(SQL.countSent, email, now, now - 3600_000, now - 86_400_000).first()
    if (sent.hour_count > CODES_PER_HOUR || sent.day_count > CODES_PER_DAY) return fail('too-many')
    const code = digits(CODE_DIGITS)
    await q(SQL.putCode, email, await sha256(`${email}:${code}`), now + CODE_SEC * 1000).run()
    const mailed = await sendCode(env, email, code)
    if (!mailed) return fail('not-sent')
    return reply(200, { ok: true })
  }

  if (path === 'verify') {
    if (request.method !== 'POST') return fail('method')
    const email = address(body.email)
    if (!email) return fail('invalid')
    const said = String(body.code ?? '').replace(/\D/g, '')
    // The try is used up before the code is compared, in one statement: guesses sent all at once each take one.
    const kept = await q(SQL.useTry, email, MAX_TRIES, now).first()
    if (!kept) {
      const state = await q(SQL.codeState, email).first()
      if (!state || state.expires <= now) return fail('expired')
      await q(SQL.dropCode, email).run()
      return fail('too-many-tries')
    }
    if ((await sha256(`${email}:${said}`)) !== kept.hash) return fail('wrong')
    const taken = await q(SQL.takeCode, email, kept.hash).run()
    if (!taken.meta || taken.meta.changes !== 1) return fail('expired')
    const token = randomToken()
    await q(SQL.putSession, await sha256(token), email, now + SESSION_SEC * 1000).run()
    return reply(200, { ok: true, token, email })
  }

  // Everything else is the signed-in account's.
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '')
  const sessionHash = bearer ? await sha256(bearer[1]) : null
  const session = sessionHash ? await q(SQL.session, sessionHash, now).first() : null
  if (!session) return fail('signed-out')

  if (path === 'signout') {
    if (request.method !== 'POST') return fail('method')
    await q(SQL.dropSession, sessionHash).run()
    return reply(200, { ok: true })
  }

  if (path === 'vault') {
    const read = async () => {
      const kept = await q(SQL.vault, session.email).first()
      return kept ? { vault: await open(env, kept), updatedAt: kept.updated_at } : { vault: null, updatedAt: null }
    }
    if (request.method === 'GET') return reply(200, { ok: true, email: session.email, ...(await read()) })
    if (request.method !== 'PUT') return fail('method')
    if (!body.vault || typeof body.vault !== 'object') return fail('not-json')
    const base = typeof body.base === 'string' ? body.base : null
    // Later than the base it was merged with, so every save reads as newer than the one before.
    let updatedAt = new Date(now).toISOString()
    if (base && updatedAt <= base) updatedAt = new Date(Date.parse(base) + 1).toISOString()
    const sealed = await seal(env, body.vault)
    const saved = base
      ? await q(SQL.nextVault, session.email, sealed.iv, sealed.data, updatedAt, base).run()
      : await q(SQL.firstVault, session.email, sealed.iv, sealed.data, updatedAt).run()
    if (saved.meta && saved.meta.changes === 1) return reply(200, { ok: true, updatedAt })
    // Another copy saved since this one read: it merges the newer vault and sends again.
    return reply(409, { ok: false, reason: 'conflict', ...(await read()) })
  }

  return fail('not-found')
}

function address(given) {
  const email = String(given ?? '').trim().toLowerCase()
  return email.length <= 254 && ADDRESS.test(email) ? email : null
}

/** A code of n digits, from the system's random numbers, each digit as likely as any other. */
function digits(n) {
  let out = ''
  const byte = new Uint8Array(1)
  while (out.length < n) {
    crypto.getRandomValues(byte)
    // 250 and up would make 0 to 5 likelier than 6 to 9.
    if (byte[0] < 250) out += String(byte[0] % 10)
  }
  return out
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return base64url(new Uint8Array(digest))
}

function base64url(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64(text) {
  const s = atob(text)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function toBase64(bytes) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

async function vaultKey(env) {
  return crypto.subtle.importKey('raw', fromBase64(env.VAULT_KEY), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

async function seal(env, value) {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await vaultKey(env),
    new TextEncoder().encode(JSON.stringify(value))
  )
  return { iv: toBase64(iv), data: toBase64(new Uint8Array(data)) }
}

async function open(env, kept) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(kept.iv) },
    await vaultKey(env),
    fromBase64(kept.data)
  )
  return JSON.parse(new TextDecoder().decode(plain))
}

async function sendCode(env, email, code) {
  const from = env.MAIL_FROM || `Cutalong <sign-in@${config.domain}>`
  const text = `Your Cutalong code is ${code}.\n\nType it into Cutalong to sign in. It works for ten minutes.\n\nIf you didn’t ask for it, you can ignore this email: nobody can sign in without it.`
  const html = `<p>Your Cutalong code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>Type it into Cutalong to sign in. It works for ten minutes.</p><p style="color:#777">If you didn’t ask for it, you can ignore this email.</p>`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [email], subject: `Your Cutalong code: ${code}`, text, html })
    })
    return res.ok
  } catch {
    return false
  }
}
