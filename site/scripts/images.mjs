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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'src', 'public')
const IMG = join(ROOT, 'src', 'img')
const font = (file) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'src', 'fonts', file)).toString('base64')}`

const CORAL = '#FF5A36'
const WHITE = '#FFFFFF'
const INK = '#15161A'
const GROUND = '#F5F5F3'

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
  writeFileSync(join(IMG, `${name}.png`), withOrigin(await shoot(card(w, h), w, h, false)))
}

await browser.close()
console.log('wrote favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, og.png and twitter.png')

// ---- The social card: the lockup, the headline, and the edit the page shows.

function card(w, h) {
  const mark = (size, take, cut) => `<svg width="${size}" height="${(size * 52) / 64}" viewBox="0 0 64 52"><rect x="2" y="4" width="44" height="18" rx="9" fill="${take}"/><rect x="18" y="30" width="42" height="16" rx="8" fill="none" stroke="${cut}" stroke-width="5" stroke-dasharray="7 6"/></svg>`
  const beats = [[0, 5, 1], [5, 6, 0], [11, 7, 0], [18, 6, 0], [24, 4.5, 0], [28.5, 3, 0]]
    .map(([x, bw, on]) => `<i style="left:${x}%;width:calc(${bw}% - 4px);background:${on ? INK : '#E7E6E2'}"></i>`)
    .join('')
  return `<!doctype html><html><head><style>
    @font-face { font-family: Figtree; src: url("${font('figtree.woff2')}") format("woff2"); font-weight: 300 900; }
    @font-face { font-family: "JetBrains Mono"; src: url("${font('jetbrains-mono.woff2')}") format("woff2"); }
    * { box-sizing: border-box; margin: 0; }
    body { width: ${w}px; height: ${h}px; background: ${GROUND}; color: ${INK}; font-family: Figtree; padding: 72px 80px; display: flex; flex-direction: column; justify-content: space-between; -webkit-font-smoothing: antialiased; }
    .lockup { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 800; letter-spacing: -0.045em; }
    h1 { font-size: ${h > 610 ? 92 : 88}px; line-height: 0.98; font-weight: 700; letter-spacing: -0.045em; max-width: 13ch; }
    .row { display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; }
    .thread { width: 470px; display: flex; flex-direction: column; gap: 14px; }
    .bubble { align-self: flex-end; background: ${INK}; color: ${WHITE}; border-radius: 22px 22px 6px 22px; padding: 12px 18px; font-size: 21px; }
    .reply { display: flex; gap: 12px; align-items: flex-start; font-size: 21px; line-height: 1.4; }
    .avatar { flex: 0 0 38px; height: 38px; border-radius: 11px; background: ${CORAL}; display: grid; place-items: center; }
    .strip { position: relative; height: 30px; margin-top: 6px; }
    .strip i { position: absolute; top: 0; bottom: 0; border-radius: 8px; }
    .strip::before { content: ""; position: absolute; inset: 0; border: 1.5px dashed #D6D5D1; border-radius: 8px; }
    .strip b { position: absolute; top: -6px; bottom: -6px; left: 14%; width: 3px; border-radius: 2px; background: ${CORAL}; }
    .time { font-family: "JetBrains Mono"; font-size: 17px; color: #5E6068; }
  </style></head><body>
    <div class="lockup">${mark(44, INK, CORAL)}cutalong</div>
    <div class="row">
      <h1>The video editor you talk to</h1>
      <div class="thread">
        <p class="bubble">Cut the retakes and make it 10 minutes</p>
        <div class="reply"><span class="avatar">${mark(24, WHITE, WHITE)}</span><p>v2 is ready. It runs 9:58, down from 31:40.</p></div>
        <div class="strip">${beats}<b></b></div>
        <p class="time">9:58</p>
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
function withOrigin(png) {
  const text = Buffer.from('impeccable:prompt\0Origin: rendered by site/scripts/images.mjs in Chrome from the Cutalong mark\'s own geometry (src/renderer/src/cutalong/components/ui.tsx) and the brand tokens. Not generated by an image model; no stock or third-party imagery.', 'latin1')
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

