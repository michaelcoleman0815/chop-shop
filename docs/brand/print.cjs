// Prints guidelines.html to docs/brand-guidelines.pdf with Playwright's
// Chromium: node docs/brand/print.cjs
//
// Without Playwright, open guidelines.html in Chrome and print it to PDF on
// Letter paper with margins set to none and background graphics on. The fonts
// load from node_modules, so run npm install first either way.
const { join } = require('path')
const { pathToFileURL } = require('url')

let chromium
try {
  ;({ chromium } = require('playwright'))
} catch {
  console.error('Playwright is not installed. Run npm i -g playwright, or print from Chrome as described above.')
  process.exit(1)
}

;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(pathToFileURL(join(__dirname, 'guidelines.html')).href, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  const out = join(__dirname, '..', 'brand-guidelines.pdf')
  await page.pdf({ path: out, format: 'Letter', printBackground: true, preferCSSPageSize: true })
  await browser.close()
  console.log(`Wrote ${out}`)
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
