// Renders the favicons, the app icons and the social cards from the Cutalong mark, in Chrome.
// Run it after changing the mark or the headline; the files it writes are committed, so a deploy needs no browser.
//
//   npm run images            (needs Playwright: npm i --no-save playwright, or a global install)
//
// The mark is drawn from the app's own geometry (src/renderer/src/cutalong/components/ui.tsx): a 64 x 52 grid,
// the take a 44 x 18 bar at (2, 4), the cut line a 42 x 16 outline at (18, 30), 5 thick, dashed 7 on and 6 off.
// Under 32 px the dashes close into a solid bar, as the design system says, so the icon still reads.

import { execSync } from 'node:child_process'
import { crc32 } from 'node:zlib'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import config from '../site.config.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'src', 'public')
const IMG = join(ROOT, 'src', 'img')
const font = (file) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'src', 'fonts', file)).toString('base64')}`
const svg = (file) => `data:image/svg+xml;base64,${readFileSync(join(ROOT, 'src', 'img', file)).toString('base64')}`
// A crew member as the page draws it (src/partials/crew-*.html), coloured here because the card has no stylesheet.
const crew = (id) => readFileSync(join(ROOT, 'src', 'partials', `crew-${id}.html`), 'utf8').trim()

// Lined Script, as hex (site/src/css/tokens.css has the OKLCH): paper, its glow, a sheet, ink, and the blue revision.
const CORAL = '#FF5A36'
const WHITE = '#FFFFFF'
const INK = '#1F2129'
const GROUND = '#F7F4F0'
const GLOW = '#FFFDF4'
const PAPER = '#FEFEFB'
const CARD = '#FEFEFB'
const BLUE = '#D9EEFD'
// The crew's colours, the same in both looks: Echo blue, Snip coral (tokens.css, --crew-*).
const CREW = { echo: 'oklch(83% 0.08 240)', snip: CORAL }

const pw = await loadPlaywright()
const { chromium } = pw.default ?? pw
const browser = await launch()

const tile = (size, { solid = size <= 32, rounded = true } = {}) => {
  const cut = solid
    ? `<rect x="15.5" y="27.5" width="47" height="21" rx="10.5" fill="${WHITE}"/>`
    : `<rect x="18" y="30" width="42" height="16" rx="8" fill="none" stroke="${WHITE}" stroke-width="5" stroke-dasharray="7 6"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <rect width="100" height="100" rx="${rounded ? 22.5 : 0}" fill="${CORAL}"/>
    <g transform="translate(16.95 23.1) scale(1.0248)"><rect x="2" y="4" width="44" height="18" rx="9" fill="${WHITE}"/>${cut}</g></svg>`
}

const icons = {}
for (const [name, size, opts] of [
  ['icon-16', 16, {}],
  ['icon-32', 32, {}],
  ['icon-48', 48, {}],
  ['apple-touch-icon', 180, { rounded: false }],
  ['icon-192', 192, {}],
  ['icon-512', 512, {}]
]) {
  icons[name] = await shoot(`<body style="margin:0;background:transparent">${tile(size, opts)}</body>`, size, size, true)
  if (!name.startsWith('icon-') || size > 48) writeFileSync(join(PUBLIC, `${name}.png`), withOrigin(icons[name]))
}
writeFileSync(join(PUBLIC, 'favicon.ico'), ico([[16, icons['icon-16']], [32, icons['icon-32']], [48, icons['icon-48']]]))

for (const [name, w, h] of [['og', 1200, 630], ['twitter', 1200, 600]]) {
  writeFileSync(join(IMG, `${name}.png`), withOrigin(await shoot(card(w, h), w, h, false), ', the crew\'s code-drawn shapes (site/scripts/shapes.mjs)'))
}

await browser.close()
console.log('wrote favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, og.png and twitter.png')

// ---- The social card, in Lined Script: the headline in the serif, beside the real run the page shows.

function card(w, h) {
  const mark = (size) => `<svg width="${size}" height="${(size * 52) / 64}" viewBox="0 0 64 52"><rect x="2" y="4" width="44" height="18" rx="9" fill="${INK}"/><rect x="18" y="30" width="42" height="16" rx="8" fill="none" stroke="${CORAL}" stroke-width="5" stroke-dasharray="7 6"/></svg>`
  // The v2 strip from the page: the twelve lines the 60-second cut kept, at their share of 0:59.
  const kept = [2.88, 6.16, 3.96, 3.96, 4.33, 5.8, 3.6, 5.42, 5.07, 3.96, 6.91, 4.7]
  let x = 0
  const beats = kept.map((bw) => { const i = `<i style="left:${x}%;width:${bw}%"></i>`; x += bw + 0.45; return i }).join('')
  return `<!doctype html><html><head><style>
    @font-face { font-family: Figtree; src: url("${font('figtree.woff2')}") format("woff2"); font-weight: 300 900; }
    @font-face { font-family: "Serif Accent"; src: url("${font('source-serif-4-display-italic.woff2')}") format("woff2"); font-style: italic; }
    @font-face { font-family: "Serif Text"; src: url("${font('source-serif-4-text.woff2')}") format("woff2"); }
    @font-face { font-family: "JetBrains Mono"; src: url("${font('jetbrains-mono.woff2')}") format("woff2"); }
    * { box-sizing: border-box; margin: 0; }
    body { width: ${w}px; height: ${h}px; color: ${INK}; font-family: Figtree; padding: 68px 80px; display: flex; flex-direction: column; justify-content: space-between; -webkit-font-smoothing: antialiased;
      background: radial-gradient(70% 70% at 30% 0%, ${GLOW}, transparent 100%), ${GROUND}; }
    .lockup { display: flex; align-items: center; gap: 14px; font-size: 32px; font-weight: 800; letter-spacing: -0.045em; }
    .row { display: flex; align-items: flex-end; justify-content: space-between; gap: 48px; }
    h1 { font-weight: 800; font-size: ${h > 610 ? 92 : 88}px; line-height: 0.98; letter-spacing: -0.045em; max-width: 8ch; }
    h1 em { font-family: "Serif Accent"; font-style: italic; font-weight: 400; font-size: 1.08em; letter-spacing: -0.012em; }
    .living { position: absolute; right: 80px; top: 52px; width: 120px; height: 120px; background: url("${svg('living-a.svg')}") center / contain no-repeat; }
    .page { width: 500px; padding: 26px 28px; border-radius: 18px; background: ${BLUE}; box-shadow: 0 1px 2px rgba(31,33,41,.06), 0 24px 48px -24px rgba(31,33,41,.3); display: flex; flex-direction: column; gap: 14px; }
    .bubble { align-self: flex-end; background: ${INK}; color: ${PAPER}; border-radius: 20px 20px 6px 20px; padding: 10px 18px; font-size: 20px; letter-spacing: -0.005em; }
    .reply { display: flex; gap: 12px; align-items: flex-start; font-family: "Serif Text"; font-size: 21px; line-height: 1.42; }
    .tile { flex: 0 0 34px; height: 34px; border-radius: 9px; background: ${CARD}; box-shadow: inset 0 0 0 1px rgba(31,33,41,.1); display: grid; place-items: center; }
    .strip { position: relative; height: 28px; margin-top: 4px; }
    .strip i { position: absolute; top: 0; bottom: 0; border-radius: 5px; background: ${CARD}; box-shadow: inset 0 0 0 1px rgba(31,33,41,.08); }
    .strip b { position: absolute; top: -6px; bottom: -6px; left: 23%; width: 3px; border-radius: 2px; background: ${CORAL}; }
    .credit { display: flex; align-items: center; gap: 6px; margin-left: 46px; font-size: 16px; color: #4A4D59; }
    .credit svg { width: 22px; height: 22px; }
    .crew-echo .crew-body { fill: ${CREW.echo}; } .crew-snip .crew-body { fill: ${CREW.snip}; } .crew-snip .crew-crisp { stroke: ${CREW.snip}; stroke-width: 6; stroke-linejoin: round; } .crew-eyes { fill: ${INK}; }
    .foot { display: flex; justify-content: space-between; font-size: 16px; color: #5B5E6B; }
    .foot span:last-child { font-family: "JetBrains Mono"; }
  </style></head><body>
    <div class="lockup">${mark(42)}cutalong</div>
    <div class="living"></div>
    <div class="row">
      <h1>The video editor you <em>talk to</em></h1>
      <div class="page">
        <p class="bubble">Cut it to 60 seconds</p>
        <div class="reply"><span class="tile">${mark(20)}</span><p>v2 is ready. It runs 0:59 now, down from 1:39.</p></div>
        <p class="credit">${crew('echo')}${config.crew.echo.name} found the pauses, and ${crew('snip')}${config.crew.snip.name} cut the rest.</p>
        <div class="strip">${beats}<b></b></div>
        <p class="foot"><span>v2, on blue pages</span><span>0:59</span></p>
      </div>
    </div>
  </body></html>`
}

// ---- Helpers

async function shoot(html, w, h, transparent) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  const png = await page.screenshot({ type: 'png', omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } })
  await page.close()
  return png
}

// Every raster says where it came from (a tEXt chunk under Impeccable's key), so its provenance survives a redraw.
function withOrigin(png, also = '') {
  const text = Buffer.from('impeccable:prompt\0Origin: rendered by site/scripts/images.mjs in Chrome from the Cutalong mark\'s own geometry (src/renderer/src/cutalong/components/ui.tsx)' + also + ' and the brand tokens. Not generated by an image model; no stock or third-party imagery.', 'latin1')
  const chunk = Buffer.alloc(12 + text.length)
  chunk.writeUInt32BE(text.length, 0)
  chunk.write('tEXt', 4, 'latin1')
  text.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + text.length)) >>> 0, 8 + text.length)
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8)
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)])
}

// An .ico whose entries are PNGs, which every current browser reads.
function ico(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = 6 + entries.length * 16
  const dir = []
  for (const [size, png] of entries) {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4)
    e.writeUInt16LE(32, 6)
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    dir.push(e)
  }
  return Buffer.concat([header, ...dir, ...entries.map(([, png]) => png)])
}

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim()
    const require = createRequire(join(root, 'noop.js'))
    try {
      return await import(pathToFileURL(require.resolve('playwright')).href)
    } catch {
      console.error('images: Playwright is not installed. Run `npm i --no-save playwright` in site/, then try again.')
      process.exit(1)
    }
  }
}

export async function launch() {
  const path = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => existsSync(p))
  try {
    return await chromium.launch(path ? { executablePath: path } : {})
  } catch (err) {
    console.error(`images: could not start Chrome (${err.message.split('\n')[0]}). Set CHROME_PATH, or run \`npx playwright install chromium\`.`)
    process.exit(1)
  }
}

