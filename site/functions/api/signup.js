// POST /api/signup: the email list behind every "Get notified" button.
//
// Cloudflare Pages runs this file as a Function: functions/ sits at the project root (site/), beside dist/,
// and Pages builds it on every deploy. It keeps one record per address in the Workers KV namespace bound
// as SIGNUPS: the address, when it was left, and which part of the page it came from. Nothing else is
// kept, no reply contains the address, and no reply may be cached. Pages does not apply _headers to a
// Function's responses, so this file sets its own.
//
// The form posts here when site.config.mjs has signupAction: '/api/signup'. README.md has the owner's
// steps: create the namespace, bind it as SIGNUPS, redeploy, export the list.

import config from '../../site.config.mjs'

// Where on the page an address came from: the button that led to the field, the field itself ("soon"),
// or a link straight to it ("link", which is where /download goes before there is a release).
const SOURCES = ['hero', 'header', 'close', 'soon', 'link']

// The honeypot: a field people never see, so only a bot fills it in.
const TRAP = 'website'

// The form sends well under 1 KB.
const MAX_BODY = 4096

// The browser's own rule for type="email", plus a dot in the domain and the lengths mail allows.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const ADDRESS = new RegExp(
  `^[a-z0-9.!#$%&'*+/=?^_\`{|}~-]{1,64}@(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`
)

const site = config.domain
const contact = config.contactEmail
const REPLIES = {
  added: [
    200,
    config.downloadReady
      ? 'You’re on the list. One email for each of these as it ships, and nothing else.'
      : 'You’re on the list. One email when Cutalong is ready, and nothing else.'
  ],
  missing: [400, 'Write your email address first.'],
  invalid: [400, 'That address looks incomplete. Write it as name@example.com.'],
  'too-large': [413, 'That was more than an email address, so nothing was saved.'],
  'not-a-form': [415, `Send your address with the form on ${site}.`],
  'cross-site': [403, `Send your address with the form on ${site}.`],
  method: [405, `Send your address with the form on ${site}.`],
  'not-connected': [503, `The list isn’t connected yet, so nothing was saved. Write to ${contact} instead.`],
  'not-saved': [503, `The list couldn’t save that just now. Try again in a minute, or write to ${contact}.`]
}

export async function onRequest({ request, env = {} }) {
  const accept = request.headers.get('Accept') || ''
  // A browser without script posts the form itself and is answered with a page; the page's script asks for JSON.
  const asPage = accept.includes('text/html') && !accept.includes('application/json')
  const reply = (code) => respond(code, asPage)

  if (request.method !== 'POST') return reply('method')
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) return reply('cross-site')

  const type = request.headers.get('Content-Type') || ''
  const multipart = /^multipart\/form-data\b/i.test(type)
  if (!multipart && !/^application\/x-www-form-urlencoded\b/i.test(type)) return reply('not-a-form')
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return reply('too-large')

  let fields
  try {
    const body = await request.text()
    if (body.length > MAX_BODY) return reply('too-large')
    fields = multipart ? await new Response(body, { headers: { 'Content-Type': type } }).formData() : new URLSearchParams(body)
  } catch {
    return reply('not-a-form')
  }

  // A bot that filled in the hidden field gets the same reply as everyone, and nothing is kept.
  if (text(fields.get(TRAP))) return reply('added')

  const given = text(fields.get(config.signupField))
  if (!given) return reply('missing')
  const email = given.toLowerCase()
  if (email.length > 254 || !ADDRESS.test(email)) return reply('invalid')
  const from = text(fields.get('source'))
  const source = SOURCES.includes(from) ? from : 'unknown'

  if (!env.SIGNUPS) return reply('not-connected')
  try {
    // An address already on the list keeps its first record and gets the same reply, so no reply says who is on it.
    if ((await env.SIGNUPS.get(email)) === null) {
      const at = new Date().toISOString()
      await env.SIGNUPS.put(email, JSON.stringify({ email, at, source }), { metadata: { at, source } })
    }
  } catch (error) {
    console.error(`signup: the list could not be read or written (${redact(error)})`)
    return reply('not-saved')
  }
  return reply('added')
}

function respond(code, asPage) {
  const [status, message] = REPLIES[code]
  const ok = status === 200
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' })
  if (code === 'method') headers.set('Allow', 'POST')
  if (asPage) {
    headers.set('Content-Type', 'text/html; charset=utf-8')
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    return new Response(page(message), { status, headers })
  }
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(ok ? { ok, message } : { ok, error: code, message }), { status, headers })
}

// What a browser without script shows after posting the form: the reply, and the way back.
function page(message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cutalong</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 20vh 16px; background: #f5f5f3; color: #15161a; font: 1.125rem/1.5 system-ui, sans-serif; }
  main { display: grid; gap: 1rem; max-width: 32rem; margin: 0 auto; }
  p { margin: 0; }
  a { color: inherit; text-underline-offset: 0.18em; }
  @media (prefers-color-scheme: dark) { body { background: #11110f; color: #eff0f3; } }
</style>
</head>
<body>
<main>
  <p>${escapeHtml(message)}</p>
  <p><a href="/#signup">Back to Cutalong</a></p>
</main>
</body>
</html>
`
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function redact(error) {
  return String(error?.message || error).replace(/\S+@\S+/g, '[an address]')
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
