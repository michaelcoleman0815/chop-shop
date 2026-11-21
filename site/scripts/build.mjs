// Builds the site into dist/ (or --out), with no dependencies.
//
//   node scripts/build.mjs                 the deployable site: clean links (/privacy), _headers, _redirects
//   node scripts/build.mjs --preview       a self-contained copy: relative .html links, no host files
//   node scripts/build.mjs --out <dir>     somewhere other than dist/
//
// Templates in src/ use a few tags: {{> partial}}, {{name}} (escaped), {{{name}}} (raw),
// {{asset path}} (a hashed file under assets/), {{page name}} (a link to another page),
// {{url name}} (that page's absolute address on the primary domain), and two kinds of section:
// {{#name}}...{{/name}} is kept when the config value is true, {{^name}}...{{/name}} when it is false.
//
// Each page's <!--page --> block names its title, its description, its link-preview card (card, and twitterCard
// where X gets its own 1200 x 600) and the card's alt text; socialTitle, when set, is the title a shared link
// shows. The build adds the structured data (one linked schema.org graph per page, with the FAQ read from the
// page's own Questions), and writes llms.txt for AI search beside the sitemap.

import { execFileSync } from 'node:child_process'
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
check(typeof config.downloadReady === 'boolean', 'downloadReady should be true or false')
check(/^https:\/\//.test(config.downloadUrl), 'downloadUrl should be an https:// address')
check(!config.signupAction || /^(https:\/\/|\/[a-z])/.test(config.signupAction), 'signupAction should be empty, a path like /api/signup, or https://')
check(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(config.contactEmail), 'contactEmail should be an address')
check(['echo', 'snip', 'quill', 'scout', 'tint', 'reel'].every((id) => config.crew?.[id]?.name && config.crew[id].line), 'crew needs echo, snip, quill, scout, tint and reel, each with a name and a line')
check(Array.isArray(config.features) && config.features.length > 0 && config.features.every((f) => typeof f === 'string' && f), 'features should be a list of what the app does')

const ORIGIN = `https://${config.domain}`
// The app's version, from the repository's package.json beside the site, for the structured data.
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
})()
// A path such as /api/signup is a Pages Function, which a preview copy does not have: there the form stays unwired.
const signupAction = preview && config.signupAction.startsWith('/') ? '' : config.signupAction
const PAGES = [
  { name: 'index', file: 'index.html', path: '/', sitemap: true },
  // One page for each job people search for, linked from the landing page and every footer.
  { name: 'cut-retakes', file: 'cut-retakes.html', path: '/cut-retakes', sitemap: true, job: true },
  { name: 'remove-pauses', file: 'remove-pauses.html', path: '/remove-pauses', sitemap: true, job: true },
  { name: 'youtube-shorts', file: 'youtube-shorts.html', path: '/youtube-shorts', sitemap: true, job: true },
  { name: 'clip-long-videos', file: 'clip-long-videos.html', path: '/clip-long-videos', sitemap: true, job: true },
  { name: 'vlog-editor', file: 'vlog-editor.html', path: '/vlog-editor', sitemap: true, job: true },
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
  const indexable = page.name !== '404'
  check(meta.card && meta.cardAlt, `${page.file} needs a card and its cardAlt in its <!--page --> block`)
  if (indexable) {
    // What a search result shows of each: Google cuts a title at about 60 characters and a description at about 160.
    check(meta.title.length <= 65, `${page.file}: the title is ${meta.title.length} characters; keep it to 65`)
    check(meta.description.length >= 50 && meta.description.length <= 160, `${page.file}: the description is ${meta.description.length} characters; keep it between 50 and 160`)
  }
  const ctx = {
    ...config,
    ...meta,
    indexable,
    // A job page ends on the other jobs, so its footer leaves them out.
    job: Boolean(page.job),
    socialTitle: meta.socialTitle ?? meta.title,
    ogImage: `${ORIGIN}/assets/${asset(join(SRC, meta.card))}`,
    twitterImage: `${ORIGIN}/assets/${asset(join(SRC, meta.twitterCard ?? meta.card))}`,
    origin: ORIGIN,
    root: rootAbsolute ? '/' : '',
    year: String(new Date().getUTCFullYear()),
    canonical: page.name === '404' ? ORIGIN + '/' : ORIGIN + page.path.replace(/^\/$/, '/'),
    css: assetUrl(cssName, rootAbsolute),
    js: assetUrl(jsName, rootAbsolute),
    // An indexed page lets search show its large preview image and as much of it as fits in a snippet.
    robots: preview || !indexable ? 'noindex' : 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    signupAction,
    signupDisabled: signupAction ? '' : 'disabled',
    signupState: signupAction ? 'ready' : 'unwired',
    // The crew's names and lines as {{echoName}}, {{echoLine}} and so on, from the one place they live.
    ...Object.fromEntries(Object.entries(config.crew).flatMap(([id, c]) => [[`${id}Name`, c.name], [`${id}Line`, c.line]]))
  }
  let html = render(template.replace(/^<!--page[\s\S]*?-->\s*/, ''), ctx, rootAbsolute)
  check(!/\{\{/.test(html), `${page.file} has a tag the build did not fill`)
  // A link to the page it is on says so, for a screen reader and for the lists that leave it out (.jobs).
  const self = pageLink(page.name, rootAbsolute)
  html = html.replaceAll(`href="${self}"`, `href="${self}" aria-current="page"`)
  // When the page last changed for a reader: its own file, the partials it is made of, or the config's facts.
  page.modified = lastChanged([join(SRC, page.file), join(SRC, 'partials'), join(ROOT, 'site.config.mjs')])
  page.meta = meta
  page.faq = faqOf(html)
  const graph = indexable ? structuredData(page, ctx) : null
  html = html.replace(/<!--structured-data-->\n?/, graph ? `<script type="application/ld+json">${graph}</script>\n` : '')
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) inlineScripts.add(m[1])
  writeFileSync(join(OUT, page.file), html)
}

// ---- What the host reads: sitemap, robots, manifest, and for Cloudflare Pages _headers and _redirects.

// Each page's lastmod is when it last changed (git), not the day of the build: a date that moves on every
// deploy tells a search engine nothing, so it learns to ignore it.
writeFileSync(
  join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    PAGES.filter((p) => p.sitemap)
      .map((p) => `  <url><loc>${ORIGIN}${p.path}</loc><lastmod>${p.modified.slice(0, 10)}</lastmod></url>`)
      .join('\n') +
    '\n</urlset>\n'
)
// Every crawler is welcome, search engines and AI search alike; the list's Function is not a page.
writeFileSync(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`)
writeFileSync(join(OUT, 'llms.txt'), llmsTxt())

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
      background_color: '#F7F4F0',
      theme_color: '#F7F4F0',
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
  const formAction = ["'self'", /^https:/.test(config.signupAction) ? new URL(config.signupAction).origin : ''].filter(Boolean).join(' ')
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
      config.downloadReady ? '# /download goes to the latest release.' : '# downloadReady is false, so /download goes to the email field until there is a release.',
      `/download ${config.downloadReady ? config.downloadUrl : '/#signup'} 302`,
      ''
    ].join('\n')
  )
}

console.log(`built ${relative(ROOT, OUT) || '.'}${preview ? ' (preview)' : ''}: ${PAGES.length} pages, ${hashed.size + 2} assets, ${ORIGIN}`)

// ---- Search: structured data, llms.txt, and when a page last changed

// One linked schema.org graph per page: the site, its publisher, the app, and the page itself, which is also an FAQ
// wherever the page has Questions (as it shows them). The landing page and the job pages are about the app; every page
// but the landing page has a breadcrumb back to it.
function structuredData(page, ctx) {
  const url = ORIGIN + page.path
  const site = { '@id': `${ORIGIN}/#website` }
  const owner = { '@id': `${ORIGIN}/#owner` }
  const app = { '@id': `${ORIGIN}/#app` }
  const image = { '@type': 'ImageObject', url: ctx.ogImage, width: 1200, height: 630 }
  const home = pageOf('index').meta
  const nodes = [
    { '@type': 'WebSite', ...site, url: `${ORIGIN}/`, name: 'Cutalong', description: home.description, inLanguage: 'en', publisher: owner },
    { '@type': 'Person', ...owner, name: config.owner, email: `mailto:${config.contactEmail}` },
    {
      '@type': 'SoftwareApplication',
      ...app,
      name: 'Cutalong',
      url: `${ORIGIN}/`,
      description: home.description,
      applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Video editor',
      operatingSystem: (config.requires.match(/macOS \d+[^,]*/) ?? ['macOS'])[0],
      processorRequirements: /Apple silicon/.test(config.requires) ? 'Apple silicon' : undefined,
      softwareRequirements: config.requires,
      softwareVersion: APP_VERSION,
      featureList: config.features,
      image: `${ORIGIN}/assets/${asset(join(SRC, home.card))}`,
      inLanguage: 'en',
      downloadUrl: config.downloadReady ? config.downloadUrl : undefined,
      author: owner,
      publisher: owner
    }
  ]
  const webPage = {
    '@type': page.faq.length ? ['WebPage', 'FAQPage'] : 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name: page.meta.title,
    description: page.meta.description,
    isPartOf: site,
    inLanguage: 'en',
    primaryImageOfPage: image,
    dateModified: page.modified
  }
  if (page.name === 'index' || page.job) webPage.about = app
  if (page.faq.length) {
    webPage.mainEntity = page.faq.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } }))
  }
  if (page.name !== 'index') {
    webPage.breadcrumb = {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Cutalong', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: page.meta.crumb ?? page.meta.title.split(',')[0], item: url }
      ]
    }
  }
  nodes.push(webPage)
  // As JSON in a <script>: nothing in it may close the element.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': nodes }).replace(/</g, '\\u003c')
}

// The Questions on a page, as its readers see them: each <details> with no class (the method note under the proof
// has one), its summary and its answer. A question whose answer still holds a blank for the owner is left out,
// so the structured data never states what the page has not.
function faqOf(html) {
  return [...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .filter(([, , answer]) => !/class="fill"/.test(answer))
    .map(([, q, a]) => ({ q: textOf(q), a: textOf(a) }))
}

function textOf(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

// llms.txt (llmstxt.org): the site in plain Markdown for AI assistants and AI search, from the same facts as the pages.
function llmsTxt() {
  const home = pageOf('index')
  const lines = [
    '# Cutalong',
    '',
    `> ${home.meta.description}`,
    '',
    `- Site: ${ORIGIN}/`,
    config.downloadReady ? `- Download: ${config.downloadUrl}` : `- Download: not released yet; leave an address at ${ORIGIN}/#signup for one email when it is`,
    `- Requires: ${config.requires}`,
    `- Made by: ${config.owner} (${config.contactEmail})`,
    '',
    '## What it does',
    '',
    ...config.features.map((f) => `- ${f}`),
    '',
    '## Questions',
    '',
    ...home.faq.flatMap(({ q, a }) => [`### ${q}`, '', a, '']),
    // Each job, as its own page says it: what it does, then its Questions.
    ...PAGES.filter((p) => p.job).flatMap((p) => [
      `## ${p.meta.crumb ?? p.meta.title.split(',')[0]}`,
      '',
      `${p.meta.description} More: ${ORIGIN}${p.path}`,
      '',
      ...p.faq.flatMap(({ q, a }) => [`### ${q}`, '', a, ''])
    ]),
    '## Pages',
    '',
    ...PAGES.filter((p) => p.sitemap).map((p) => `- [${p.meta.socialTitle ?? p.meta.title}](${ORIGIN}${p.path}): ${p.meta.description}`),
    ''
  ]
  return lines.join('\n')
}

// The last commit that touched any of these, as an ISO date; the build time where git has no answer.
function lastChanged(paths) {
  try {
    const at = execFileSync('git', ['log', '-1', '--format=%cI', '--', ...paths], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    if (at) return at
  } catch {
    // No git where this builds: the build's own time stands in.
  }
  return new Date().toISOString()
}

// ---- Helpers

function render(template, ctx, rootAbsolute, depth = 0) {
  check(depth < 5, 'partials nest too deep')
  return template
    .replace(/\{\{([#^])(\w+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (_, kind, key, body) => {
      check(typeof ctx[key] === 'boolean', `the section {{${kind}${key}}} needs a true or false value`)
      return ctx[key] === (kind === '#') ? body : ''
    })
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
