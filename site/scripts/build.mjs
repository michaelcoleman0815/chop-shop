// Builds the site into dist/ (or --out), with no dependencies.
//
//   node scripts/build.mjs                 the deployable site: clean links (/privacy), _headers, _redirects
//   node scripts/build.mjs --preview       a self-contained copy: relative .html links, no host files
//   node scripts/build.mjs --out <dir>     somewhere other than dist/
//
// Templates in src/ use a few tags: {{> partial}}, {{name}} (escaped), {{{name}}} (raw),
// {{asset path}} (a hashed file under assets/), {{page name}} (a link to another page) and
// {{url name}} (that page's absolute address on the primary domain).

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const args = process.argv.slice(2)
const preview = args.includes('--preview')
const outArg = args.indexOf('--out')
const OUT = resolve(ROOT, outArg >= 0 ? args[outArg + 1] : 'dist')

const config = (await import(pathToFileURL(join(ROOT, 'site.config.mjs')).href)).default
check(/^[a-z0-9.-]+\.[a-z]{2,}$/.test(config.domain), `domain "${config.domain}" should look like cutalong.io`)
check(/^https:\/\//.test(config.downloadUrl), 'downloadUrl should be an https:// address')
check(!config.signupAction || /^https:\/\//.test(config.signupAction), 'signupAction should be empty or https://')
check(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(config.contactEmail), 'contactEmail should be an address')

const ORIGIN = `https://${config.domain}`
const PAGES = [
  { name: 'index', file: 'index.html', path: '/', sitemap: true },
  { name: 'privacy', file: 'privacy.html', path: '/privacy', sitemap: true },
  { name: 'terms', file: 'terms.html', path: '/terms', sitemap: true },
  { name: '404', file: '404.html', path: '/404', sitemap: false }
]

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'assets'), { recursive: true })

// ---- Assets: every file a page or the stylesheet names is copied once, under a content hash.

const hashed = new Map()
function asset(srcPath) {
  const abs = resolve(srcPath)
  if (hashed.has(abs)) return hashed.get(abs)
  check(existsSync(abs), `missing asset ${relative(ROOT, abs)}`)
  const body = readFileSync(abs)
  const name = `${basename(abs, extname(abs))}.${hash(body)}${extname(abs)}`
  writeFileSync(join(OUT, 'assets', name), body)
  hashed.set(abs, name)
  return name
}

// The stylesheet: @imports inlined in order, url()s hashed, comments dropped after the Hallmark stamp.
function inlineCss(file) {
  const imports = []
  const own = readFileSync(file, 'utf8')
    .replace(/@import url\("(.+?)"\);/g, (_, p) => `@@import${imports.push(p) - 1}@@`)
    .replace(/url\("(?!data:|https?:)(.+?)"\)/g, (_, p) => `url("${asset(resolve(dirname(file), p))}")`)
  return own.replace(/@@import(\d+)@@/g, (_, i) => inlineCss(resolve(dirname(file), imports[Number(i)])))
}
const rawCss = inlineCss(join(SRC, 'css', 'site.css'))
const stampEnd = leadingCommentsEnd(rawCss)
const css = rawCss.slice(0, stampEnd) + rawCss.slice(stampEnd).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n+/g, '\n')
const cssName = `site.${hash(css)}.css`
writeFileSync(join(OUT, 'assets', cssName), css)

const js = readFileSync(join(SRC, 'js', 'site.js'), 'utf8')
const jsName = `site.${hash(js)}.js`
writeFileSync(join(OUT, 'assets', jsName), js)

// ---- Pages

const partials = Object.fromEntries(
  readdirSync(join(SRC, 'partials')).map((f) => [basename(f, '.html'), readFileSync(join(SRC, 'partials', f), 'utf8')])
)
const inlineScripts = new Set()

for (const page of PAGES) {
  const template = readFileSync(join(SRC, page.file), 'utf8')
  const meta = frontMatter(template)
  const rootAbsolute = page.name === '404' && !preview
  const ctx = {
    ...config,
    ...meta,
    origin: ORIGIN,
    root: rootAbsolute ? '/' : '',
    year: String(new Date().getUTCFullYear()),
    canonical: page.name === '404' ? ORIGIN + '/' : ORIGIN + page.path.replace(/^\/$/, '/'),
    css: assetUrl(cssName, rootAbsolute),
    js: assetUrl(jsName, rootAbsolute),
    robots: preview || page.name === '404' ? 'noindex' : 'index, follow',
    signupDisabled: config.signupAction ? '' : 'disabled',
    signupState: config.signupAction ? 'ready' : 'unwired'
  }
  let html = render(template.replace(/^<!--page[\s\S]*?-->\s*/, ''), ctx, rootAbsolute)
  check(!/\{\{/.test(html), `${page.file} has a tag the build did not fill`)
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) inlineScripts.add(m[1])
  writeFileSync(join(OUT, page.file), html)
}

// ---- What the host reads: sitemap, robots, manifest, and for Cloudflare Pages _headers and _redirects.

const today = new Date().toISOString().slice(0, 10)
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    PAGES.filter((p) => p.sitemap)
      .map((p) => `  <url><loc>${ORIGIN}${p.path}</loc><lastmod>${today}</lastmod></url>`)
      .join('\n') +
    '\n</urlset>\n'
)
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`)

cpSync(join(SRC, 'public'), OUT, { recursive: true })
writeFileSync(
  join(OUT, 'site.webmanifest'),
  JSON.stringify(
    {
      name: 'Cutalong',
      short_name: 'Cutalong',
      description: 'A video editor you talk to, for YouTube creators.',
      start_url: '/',
      display: 'browser',
      background_color: '#F5F5F3',
      theme_color: '#F5F5F3',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
      ]
    },
    null,
    2
  ) + '\n'
)

if (!preview) {
  const scriptHashes = [...inlineScripts].map((s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`)
  const formAction = ["'self'", config.signupAction ? new URL(config.signupAction).origin : ''].filter(Boolean).join(' ')
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests'
  ].join('; ')
  writeFileSync(
    join(OUT, '_headers'),
    [
      '# Written by scripts/build.mjs from site.config.mjs. Cloudflare Pages applies these to every response.',
      '/*',
      `  Content-Security-Policy: ${csp}`,
      '  X-Frame-Options: DENY',
      '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      '  Cross-Origin-Opener-Policy: same-origin',
      '  Strict-Transport-Security: max-age=31536000',
      '',
      '# Every file in assets/ has its content hash in its name, so it never changes in place.',
      '/assets/*',
      '  Cache-Control: public, max-age=31536000, immutable',
      '',
      '# Keep the pages.dev copies of the site out of search results; the custom domain is the one to index.',
      'https://:project.pages.dev/*',
      '  X-Robots-Tag: noindex',
      'https://:version.:project.pages.dev/*',
      '  X-Robots-Tag: noindex',
      ''
    ].join('\n')
  )
  writeFileSync(
    join(OUT, '_redirects'),
    [
      '# Written by scripts/build.mjs from site.config.mjs. Path redirects only: cutalong.net and cutalong.org',
      '# reach cutalong.io through Cloudflare redirect rules on their own zones (README.md).',
      `/download ${config.downloadUrl} 302`,
      ''
    ].join('\n')
  )
}

console.log(`built ${relative(ROOT, OUT) || '.'}${preview ? ' (preview)' : ''}: ${PAGES.length} pages, ${hashed.size + 2} assets, ${ORIGIN}`)

// ---- Helpers

function render(template, ctx, rootAbsolute, depth = 0) {
  check(depth < 5, 'partials nest too deep')
  return template
    .replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
      check(name in partials, `no partial named ${name}`)
      return render(partials[name], ctx, rootAbsolute, depth + 1)
    })
    .replace(/\{\{asset\s+([^}\s]+)\s*\}\}/g, (_, p) => assetUrl(asset(join(SRC, p)), rootAbsolute))
    .replace(/\{\{absasset\s+([^}\s]+)\s*\}\}/g, (_, p) => `${ORIGIN}/assets/${asset(join(SRC, p))}`)
    .replace(/\{\{page\s+([\w-]+)\s*\}\}/g, (_, name) => pageLink(name, rootAbsolute))
    .replace(/\{\{url\s+([\w-]+)\s*\}\}/g, (_, name) => ORIGIN + pageOf(name).path)
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, key) => value(ctx, key))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => escapeHtml(value(ctx, key)))
}

function pageOf(name) {
  const p = PAGES.find((x) => x.name === name)
  check(p, `no page named ${name}`)
  return p
}

function pageLink(name, rootAbsolute) {
  const p = pageOf(name)
  if (preview) return p.file
  if (rootAbsolute) return p.path
  return name === 'index' ? './' : p.path.slice(1)
}

function assetUrl(name, rootAbsolute) {
  return rootAbsolute ? `/assets/${name}` : `assets/${name}`
}

function value(ctx, key) {
  check(key in ctx, `the template asks for {{${key}}}, which the build does not know`)
  return String(ctx[key])
}

function frontMatter(template) {
  const m = template.match(/^<!--page\n([\s\S]*?)-->/)
  check(m, 'every page starts with a <!--page ... --> block')
  return Object.fromEntries(
    m[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])
  )
}

function leadingCommentsEnd(text) {
  let i = 0
  for (;;) {
    const rest = text.slice(i)
    const lead = rest.match(/^\s*\/\*[\s\S]*?\*\//)
    if (!lead) return i
    i += lead[0].length
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function hash(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 10)
}

function check(ok, message) {
  if (!ok) {
    console.error(`build: ${message}`)
    process.exit(1)
  }
}
