// Serves dist/ the way Cloudflare Pages does, closely enough to test against: clean URLs (/privacy serves
// privacy.html, /privacy.html redirects to /privacy), the rules in _headers and _redirects, 404.html, and
// the email list's Function at /api/signup, with a KV store that lives in memory until the server stops.
// For the real runtime and a store that persists, use `npx wrangler pages dev dist --kv SIGNUPS` (README.md).
//
//   node scripts/serve.mjs [--port 4321] [--dir dist]

import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onRequest as signup } from '../functions/api/signup.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const DIR = resolve(ROOT, opt('--dir', 'dist'))
const PORT = Number(opt('--port', process.env.PORT || 4321))

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.webp': 'image/webp', '.jpg': 'image/jpeg'
}

function rules(file) {
  if (!existsSync(file)) return []
  const out = []
  let current = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (/^\s/.test(line) && current) {
      const at = line.indexOf(':')
      current.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()])
    } else {
      current = { pattern: line.trim(), headers: [] }
      out.push(current)
    }
  }
  return out
}

const matches = (pattern, path) =>
  !/^https?:/.test(pattern) && new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(path)

const memory = new Map()
const SIGNUPS = {
  get: async (key) => memory.get(key)?.value ?? null,
  put: async (key, value, options = {}) => void memory.set(key, { value, metadata: options.metadata })
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = decodeURIComponent(url.pathname)
  if (path === '/api/signup' || path === '/api/signup/') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const headers = Object.fromEntries(['accept', 'content-type', 'origin'].filter((h) => req.headers[h]).map((h) => [h, req.headers[h]]))
    const hasBody = !['GET', 'HEAD'].includes(req.method)
    const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined })
    const response = await signup({ request, env: { SIGNUPS } })
    res.writeHead(response.status, Object.fromEntries(response.headers))
    return res.end(Buffer.from(await response.arrayBuffer()))
  }
  for (const line of existsSync(join(DIR, '_redirects')) ? readFileSync(join(DIR, '_redirects'), 'utf8').split('\n') : []) {
    const [from, to, code] = line.trim().split(/\s+/)
    if (from && !from.startsWith('#') && from === path) {
      res.writeHead(Number(code) || 302, { Location: to })
      return res.end()
    }
  }
  if (path.endsWith('.html')) {
    res.writeHead(308, { Location: path === '/index.html' ? '/' : path.slice(0, -5) })
    return res.end()
  }
  let file = join(DIR, path)
  if (!file.startsWith(DIR)) return res.writeHead(400).end()
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  else if (!existsSync(file) && existsSync(file + '.html')) file += '.html'
  let status = 200
  if (!existsSync(file) || path.startsWith('/_')) {
    file = join(DIR, '404.html')
    status = 404
  }
  const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=0, must-revalidate' }
  for (const rule of rules(join(DIR, '_headers'))) if (matches(rule.pattern, path)) for (const [k, v] of rule.headers) headers[k] = v
  res.writeHead(status, headers)
  res.end(readFileSync(file))
}).listen(PORT, () => console.log(`serving ${DIR} at http://localhost:${PORT}`))
