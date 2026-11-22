// /api/account/*: Cutalong accounts. Sign in with an emailed code, and the app keeps its keys, settings, brands
// and presets here, so every copy (the Mac, Windows, the phone) has them without typing them in again.
//
//   POST /api/account/code     { email }            emails a six-digit code, good for ten minutes
//   POST /api/account/verify   { email, code }      a session token for the app, good for a year
//   GET  /api/account/vault    Bearer token         the account's vault, or null before the first sync
//   PUT  /api/account/vault    Bearer token         { vault, base }: saved when base is the time it was read at;
//                                                    otherwise 409 with the newer vault, to merge and send again
//   POST /api/account/signout  Bearer token         this session ends
//
// Cloudflare Pages runs this file as a Function, beside functions/api/signup.js. It needs, in the Pages project's
// settings (README.md, "Accounts"):
//   ACCOUNTS        a Workers KV namespace: codes, sessions and vaults
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
const MAX_BODY = 512 * 1024

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
  const kv = env.ACCOUNTS
  if (!kv || !env.VAULT_KEY) return fail('not-connected')

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
    const rateKey = `rate:${email}`
    const sent = Number((await kv.get(rateKey)) || 0)
    if (sent >= CODES_PER_HOUR) return fail('too-many')
    await kv.put(rateKey, String(sent + 1), { expirationTtl: 3600 })
    const code = sixDigits()
    const expires = Date.now() + CODE_SEC * 1000
    await kv.put(`code:${email}`, JSON.stringify({ hash: await sha256(`${email}:${code}`), tries: 0, expires }), {
      expirationTtl: CODE_SEC
    })
    const mailed = await sendCode(env, email, code)
    if (!mailed) return fail('not-sent')
    return reply(200, { ok: true })
  }

  if (path === 'verify') {
    if (request.method !== 'POST') return fail('method')
    const email = address(body.email)
    if (!email) return fail('invalid')
    const said = String(body.code ?? '').replace(/\D/g, '')
    const key = `code:${email}`
    const kept = await kv.get(key, 'json')
    if (!kept || kept.expires < Date.now()) return fail('expired')
    if (kept.tries >= MAX_TRIES) {
      await kv.delete(key)
      return fail('too-many-tries')
    }
    if ((await sha256(`${email}:${said}`)) !== kept.hash) {
      const left = Math.max(60, Math.ceil((kept.expires - Date.now()) / 1000))
      await kv.put(key, JSON.stringify({ ...kept, tries: kept.tries + 1 }), { expirationTtl: left })
      return fail('wrong')
    }
    await kv.delete(key)
    const token = randomToken()
    await kv.put(`session:${await sha256(token)}`, JSON.stringify({ email, created: new Date().toISOString() }), {
      expirationTtl: SESSION_SEC
    })
    return reply(200, { ok: true, token, email })
  }

  // Everything else is the signed-in account's.
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('Authorization') || '')
  const sessionKey = bearer ? `session:${await sha256(bearer[1])}` : null
  const session = sessionKey ? await kv.get(sessionKey, 'json') : null
  if (!session) return fail('signed-out')

  if (path === 'signout') {
    if (request.method !== 'POST') return fail('method')
    await kv.delete(sessionKey)
    return reply(200, { ok: true })
  }

  if (path === 'vault') {
    const vaultKey = `vault:${session.email}`
    const kept = await kv.get(vaultKey, 'json')
    if (request.method === 'GET') {
      if (!kept) return reply(200, { ok: true, email: session.email, vault: null, updatedAt: null })
      return reply(200, { ok: true, email: session.email, vault: await open(env, kept), updatedAt: kept.updatedAt })
    }
    if (request.method !== 'PUT') return fail('method')
    const base = body.base ?? null
    if ((kept?.updatedAt ?? null) !== base) {
      // Another copy saved since this one read: it merges the newer vault and sends again.
      return reply(409, {
        ok: false,
        reason: 'conflict',
        vault: kept ? await open(env, kept) : null,
        updatedAt: kept?.updatedAt ?? null
      })
    }
    if (!body.vault || typeof body.vault !== 'object') return fail('not-json')
    let updatedAt = new Date().toISOString()
    if (kept && updatedAt <= kept.updatedAt) updatedAt = new Date(Date.parse(kept.updatedAt) + 1).toISOString()
    await kv.put(vaultKey, JSON.stringify({ ...(await seal(env, body.vault)), updatedAt }))
    return reply(200, { ok: true, updatedAt })
  }

  return fail('not-found')
}

function address(given) {
  const email = String(given ?? '').trim().toLowerCase()
  return email.length <= 254 && ADDRESS.test(email) ? email : null
}

function sixDigits() {
  const n = new Uint32Array(1)
  crypto.getRandomValues(n)
  return String(n[0] % 1_000_000).padStart(6, '0')
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
  const text = `Your Cutalong code is ${code}.\n\nType it into Cutalong to sign in. It works for ten minutes.\n\nIf you didn’t ask for it, you can ignore this email.`
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
