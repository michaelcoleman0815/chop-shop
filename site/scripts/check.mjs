// Looks at the built site the way a visitor would: full-page screenshots at 1440, 1024, 768 and 390, light and dark,
// and checks that fail loudly: sideways scroll, console errors, focus you cannot see, and the switcher and questions by keyboard.
//
//   npm run serve   (in another terminal), then
//   npm run check [-- --url http://localhost:4321 --out .checks]

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const BASE = opt('--url', 'http://localhost:4321')
const OUT = resolve(ROOT, opt('--out', '.checks'))
const WIDTHS = [1440, 1024, 768, 390]
const PAGES = ['/', '/privacy', '/terms', '/missing-page']
mkdirSync(OUT, { recursive: true })

let pw
try {
  pw = await import('playwright')
} catch {
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
  pw = await import(pathToFileURL(createRequire(join(root, 'noop.js')).resolve('playwright')).href)
}
const { chromium } = pw.default ?? pw
const chrome = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync)
const browser = await chromium.launch(chrome ? { executablePath: chrome } : {})
const problems = []

for (const scheme of ['light', 'dark']) {
  for (const width of WIDTHS) {
    // Screenshots show the page at rest: the hero's loop holds its last frame under reduced motion.
    const page = await browser.newPage({ viewport: { width, height: width < 600 ? 844 : 900 }, colorScheme: scheme, reducedMotion: 'reduce' })
    page.on('pageerror', (e) => problems.push(`${scheme} ${width}: ${e.message}`))
    page.on('console', (m) => m.type() === 'error' && !/favicon|404 \(Not Found\)/.test(m.text()) && problems.push(`${scheme} ${width}: ${m.text()}`))
    for (const path of PAGES) {
      await page.goto(BASE + path, { waitUntil: 'networkidle' })
      await page.evaluate(() => document.fonts.ready)
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      if (wide > 0) problems.push(`${scheme} ${width} ${path}: scrolls sideways by ${wide}px`)
      if (path === '/' || width === 390) {
        const name = `${path === '/' ? 'home' : path.slice(1)}-${width}-${scheme}.png`
        await page.screenshot({ path: join(OUT, name), fullPage: true })
      }
    }
    await page.close()
  }
}

// Keyboard: every stop shows a focus ring, the switcher moves with the arrows, a question opens with Enter.
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(BASE + '/', { waitUntil: 'networkidle' })
const stops = []
for (let i = 0; i < 40; i++) {
  await page.keyboard.press('Tab')
  const stop = await page.evaluate(() => {
    const el = document.activeElement
    if (!el || el === document.body) return null
    const s = getComputedStyle(el)
    const label = el.getAttribute('for') ? document.querySelector(`label[for="${el.id}"]`) : null
    const ring = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0
    const labelRing = el.type === 'radio' && el.labels?.[0] && getComputedStyle(el.labels[0]).outlineStyle !== 'none'
    return { name: (el.getAttribute('aria-label') || el.textContent || el.id || el.tagName).trim().slice(0, 40), ring: ring || labelRing || !!label }
  })
  if (!stop) break
  stops.push(stop)
  if (!stop.ring) problems.push(`keyboard: no visible focus on "${stop.name}"`)
}
await page.focus('#job-raw')
await page.keyboard.press('ArrowRight')
const job = await page.evaluate(() => [...document.querySelectorAll('.job')].find((j) => getComputedStyle(j).display !== 'none')?.className)
if (!/job-clips/.test(job || '')) problems.push(`keyboard: the arrow key did not move the switcher (showing ${job})`)
await page.focus('.qa summary')
await page.keyboard.press('Enter')
if (!(await page.evaluate(() => document.querySelector('.qa details').open))) problems.push('keyboard: Enter did not open the first question')
await browser.close()

console.log(`checked ${PAGES.length} pages at ${WIDTHS.join(', ')}, light and dark; ${stops.length} keyboard stops; screenshots in ${OUT}`)
if (problems.length) {
  console.log(problems.map((p) => `  problem: ${p}`).join('\n'))
  process.exit(1)
}
console.log('no problems found')
