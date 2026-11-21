// What search engines, AI search and link previews read from the built site: each page's tags, its card, the
// structured data, the sitemap, robots.txt and llms.txt. Builds into a temporary folder; nothing else is touched.
//
//   npm test

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import config from '../site.config.mjs'

const ROOT = new URL('..', import.meta.url).pathname
const ORIGIN = `https://${config.domain}`
const JOBS = {
  'cut-retakes.html': '/cut-retakes',
  'remove-pauses.html': '/remove-pauses',
  'youtube-shorts.html': '/youtube-shorts',
  'clip-long-videos.html': '/clip-long-videos',
  'vlog-editor.html': '/vlog-editor'
}
const PAGES = { 'index.html': '/', ...JOBS, 'privacy.html': '/privacy', 'terms.html': '/terms' }
let out

before(() => {
  out = mkdtempSync(join(tmpdir(), 'cutalong-seo-'))
  execFileSync(process.execPath, ['scripts/build.mjs', '--out', out], { cwd: ROOT, stdio: 'pipe' })
})
after(() => rmSync(out, { recursive: true, force: true }))

const read = (file) => readFileSync(join(out, file), 'utf8')
const meta = (html, attr, name) => html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`))?.[1]
const graphOf = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph']
// A PNG's size, from its header.
const sizeOf = (file) => {
  const png = readFileSync(join(out, file))
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

test('every indexed page names itself for search and for a shared link', () => {
  for (const [file, path] of Object.entries(PAGES)) {
    const html = read(file)
    const title = html.match(/<title>([^<]*)<\/title>/)[1]
    assert.ok(title.length > 0 && title.length <= 65, `${file}: title "${title}"`)
    const description = meta(html, 'name', 'description')
    assert.ok(description.length >= 50 && description.length <= 160, `${file}: description is ${description.length} characters`)
    assert.match(meta(html, 'name', 'robots'), /^index, follow, max-image-preview:large/)
    assert.equal(html.match(/<link rel="canonical" href="([^"]*)">/)[1], ORIGIN + path)
    assert.equal(meta(html, 'property', 'og:url'), ORIGIN + path)
    assert.equal(meta(html, 'property', 'og:description'), description)
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image')
    for (const [attr, name] of [['property', 'og:title'], ['property', 'og:image:alt'], ['name', 'twitter:title'], ['name', 'twitter:image:alt']]) {
      assert.ok(meta(html, attr, name), `${file}: ${name}`)
    }
  }
})

test('each page points at its own card, at the size each network asks for', () => {
  const cards = {}
  for (const file of Object.keys(PAGES)) {
    const html = read(file)
    const og = meta(html, 'property', 'og:image')
    const tw = meta(html, 'name', 'twitter:image')
    for (const url of [og, tw]) assert.ok(url.startsWith(`${ORIGIN}/assets/`), `${file}: ${url} is absolute and hashed`)
    assert.deepEqual(sizeOf(og.slice(ORIGIN.length + 1)), [1200, 630], `${file}: the Open Graph card`)
    assert.equal(meta(html, 'property', 'og:image:width'), '1200')
    assert.equal(meta(html, 'property', 'og:image:height'), '630')
    cards[file] = og
  }
  assert.equal(new Set(Object.values(cards)).size, Object.keys(PAGES).length, 'every page has a card of its own')
  const tw = meta(read('index.html'), 'name', 'twitter:image')
  assert.deepEqual(sizeOf(tw.slice(ORIGIN.length + 1)), [1200, 600], 'X gets its 2:1 card')
})

test('the 404 is kept out of search, with no canonical and no structured data', () => {
  const html = read('404.html')
  assert.equal(meta(html, 'name', 'robots'), 'noindex')
  assert.doesNotMatch(html, /rel="canonical"/)
  assert.doesNotMatch(html, /application\/ld\+json/)
})

test('the structured data is one linked graph, and the app in it is the one the config describes', () => {
  const graph = graphOf(read('index.html'))
  const byType = (t) => graph.find((n) => [].concat(n['@type']).includes(t))
  const app = byType('SoftwareApplication')
  assert.equal(app.name, 'Cutalong')
  assert.equal(app.softwareRequirements, config.requires)
  assert.deepEqual(app.featureList, config.features)
  assert.equal(app.downloadUrl, config.downloadReady ? config.downloadUrl : undefined)
  assert.equal(byType('WebSite').publisher['@id'], byType('Person')['@id'])
  const page = byType('WebPage')
  assert.equal(page.about['@id'], app['@id'])
  assert.equal(page.isPartOf['@id'], byType('WebSite')['@id'])
  assert.match(page.dateModified, /^\d{4}-\d{2}-\d{2}T/)
  for (const file of ['privacy.html', 'terms.html']) {
    const crumbs = graphOf(read(file)).find((n) => n['@type'] === 'WebPage').breadcrumb.itemListElement
    assert.deepEqual(crumbs.map((c) => c.item), [`${ORIGIN}/`, ORIGIN + PAGES[file]])
  }
})

test('each page’s FAQ is its own Questions, less any answer the owner has still to fill in', () => {
  for (const file of ['index.html', ...Object.keys(JOBS)]) {
    const html = read(file)
    const shown = [...html.matchAll(/<details>\s*<summary>([^<]*)<span/g)].map((m) => m[1].trim())
    const blank = [...html.matchAll(/<details>\s*<summary>([^<]*)<span[\s\S]*?<\/details>/g)].filter((m) => /class="fill"/.test(m[0])).map((m) => m[1].trim())
    assert.ok(shown.length >= 3, `${file} has its own Questions`)
    const faq = graphOf(html).find((n) => [].concat(n['@type']).includes('FAQPage')).mainEntity
    assert.deepEqual(
      faq.map((q) => q.name),
      shown.filter((q) => !blank.includes(q)),
      file
    )
    for (const q of faq) assert.ok(q.acceptedAnswer.text.length > 20 && !/[<>]|&nbsp;/.test(q.acceptedAnswer.text), `${file}: ${q.name}`)
  }
})

test('each job page is about the app, one H1, with a way back and on to the others', () => {
  const home = read('index.html')
  for (const [file, path] of Object.entries(JOBS)) {
    const html = read(file)
    assert.equal(html.match(/<h1\b/g)?.length, 1, `${file}: one H1`)
    const page = graphOf(html).find((n) => [].concat(n['@type']).includes('WebPage'))
    assert.equal(page.about['@id'], `${ORIGIN}/#app`, file)
    assert.deepEqual(page.breadcrumb.itemListElement.map((c) => c.item), [`${ORIGIN}/`, ORIGIN + path], file)
    // Reachable: the landing page links to it, and every page's footer does.
    const slug = path.slice(1)
    assert.match(home, new RegExp(`href="${slug}"`), `the landing page links to ${slug}`)
    for (const other of Object.keys(PAGES).filter((f) => !(f in JOBS))) assert.match(read(other), new RegExp(`class="footer-jobs"[\\s\\S]*href="${slug}"`), `${other}'s footer links to ${slug}`)
    // And it links on to every other job.
    for (const otherSlug of Object.values(JOBS).map((p) => p.slice(1)).filter((s) => s !== slug)) {
      assert.match(html, new RegExp(`class="jobs[ "][\\s\\S]*href="${otherSlug}"`), `${file} links on to ${otherSlug}`)
    }
  }
})

test('the sitemap, robots.txt and llms.txt say what the pages say', () => {
  const sitemap = read('sitemap.xml')
  for (const path of Object.values(PAGES)) assert.match(sitemap, new RegExp(`<loc>${ORIGIN}${path}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`))
  assert.doesNotMatch(sitemap, /404/)
  const robots = read('robots.txt')
  assert.match(robots, /^User-agent: \*\nAllow: \/\nDisallow: \/api\/\n/)
  assert.match(robots, new RegExp(`Sitemap: ${ORIGIN}/sitemap.xml`))
  const llms = read('llms.txt')
  assert.match(llms, /^# Cutalong\n\n> /)
  assert.ok(llms.includes(meta(read('index.html'), 'name', 'description')))
  for (const f of config.features) assert.ok(llms.includes(f), f)
  for (const path of Object.values(PAGES)) assert.ok(llms.includes(`](${ORIGIN}${path})`), path)
})
