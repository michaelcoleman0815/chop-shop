// Renders the favicons, the app icons and the social cards from the Cutalong mark, in Chrome.
// Run it after changing the mark or the headline; the files it writes are committed, so a deploy needs no browser.
//
//   npm run images            (needs Playwright: npm i --no-save playwright, or a global install)
//   npm run images -- --cards only the link-preview cards, leaving the icons as they are
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
const jpg = (file) => `data:image/jpeg;base64,${readFileSync(join(ROOT, 'src', 'img', file)).toString('base64')}`
const cardsOnly = process.argv.includes('--cards')

// The mark's two colours: coral, which is the cut, and white on the icon's coral tile.
const CORAL = '#FF5A36'
const WHITE = '#FFFFFF'

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
for (const [name, size, opts] of cardsOnly ? [] : [
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
if (!cardsOnly) writeFileSync(join(PUBLIC, 'favicon.ico'), ico([[16, icons['icon-16']], [32, icons['icon-32']], [48, icons['icon-48']]]))

// ---- The link-preview cards, in Lined Script, on set: words on paper, the footage on the dark stage.
//
// A card is read small (a phone's chat shows it about 300 px wide), so it says as little as it can, large: what
// Cutalong is and the real cut it makes. The app showing the link names the address, so the card does not. The cut is the one the page opens on: the owner's laptop review,
// /takes, and its reply, word for word, with the still and its burned-in caption.

// The site's tokens (src/css/tokens.css), light look: Chrome draws OKLCH, so they are copied as they are.
const T = {
  paper: 'oklch(96.9% 0.006 85)', glow: 'oklch(99.4% 0.012 90)', card: 'oklch(99.6% 0.003 90)',
  ink: 'oklch(25% 0.014 272)', ink2: 'oklch(41% 0.014 272)', muted: 'oklch(50% 0.012 272)',
  stage: 'oklch(21% 0.016 272)', stage2: 'oklch(27% 0.016 272)', stageLine: 'oklch(36% 0.016 272)',
  onStage: 'oklch(96% 0.006 85)', onStageSoft: 'oklch(78% 0.01 272)',
  yellow: 'oklch(91% 0.14 100)', rev2: 'oklch(93.8% 0.03 240)', cut: CORAL
}

const mark = (size, ink = T.ink) => `<svg width="${size}" height="${(size * 52) / 64}" viewBox="0 0 64 52" aria-hidden="true"><rect x="2" y="4" width="44" height="18" rx="9" fill="${ink}"/><rect x="18" y="30" width="42" height="16" rx="8" fill="none" stroke="${CORAL}" stroke-width="5" stroke-dasharray="7 6"/></svg>`

const faces = `
    @font-face { font-family: Figtree; src: url("${font('figtree.woff2')}") format("woff2"); font-weight: 300 900; }
    @font-face { font-family: "Serif Accent"; src: url("${font('source-serif-4-display-italic.woff2')}") format("woff2"); font-style: italic; }
    @font-face { font-family: "Serif Text"; src: url("${font('source-serif-4-text.woff2')}") format("woff2"); }
    @font-face { font-family: "JetBrains Mono"; src: url("${font('jetbrains-mono.woff2')}") format("woff2"); }
    * { box-sizing: border-box; margin: 0; }
    body { color: ${T.ink}; font-family: Figtree; -webkit-font-smoothing: antialiased;
      background: radial-gradient(80% 90% at 22% 0%, ${T.glow}, transparent 70%), ${T.paper}; }
    .lockup { display: flex; align-items: center; gap: 14px; font-size: 34px; font-weight: 800; letter-spacing: -0.045em; }
    /* The accent: the serif's italic on a highlighter swipe, as the page's headline wears it. */
    .hl { white-space: nowrap; font-family: "Serif Accent"; font-style: italic; font-weight: 400; letter-spacing: -0.012em; font-size: 1.06em;
      padding: 0 0.08em; margin: 0 -0.04em; background: linear-gradient(176deg, transparent 0 50%, ${T.yellow} 50% 92%, transparent 92%); }
    .where { font-family: "JetBrains Mono"; font-size: 21px; color: ${T.muted}; letter-spacing: -0.01em; }`

function home(w, h) {
  const tall = h > 610
  // The v2 strip: the beats the cut kept, closed up, with the playhead (coral is the cut).
  const kept = [9, 6, 11, 7, 8, 12, 6, 9, 10, 7]
  let x = 0
  const beats = kept.map((bw) => { const i = `<i style="left:${x}%;width:${bw}%"></i>`; x += bw + 1; return i }).join('')
  return `<!doctype html><html><head><style>${faces}
    body { width: ${w}px; height: ${h}px; padding: ${tall ? 62 : 54}px 64px ${tall ? 58 : 50}px 72px; display: grid; grid-template-columns: minmax(0, 1fr) 486px; gap: 52px; }
    .words { display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
    h1 { font-weight: 800; font-size: ${tall ? 90 : 84}px; line-height: 0.98; letter-spacing: -0.05em; margin-top: 6px; }
    .lede { margin-top: 30px; font-size: 27px; line-height: 1.32; color: ${T.ink2}; letter-spacing: -0.012em; max-width: 21ch; }
    .stage { position: relative; display: flex; flex-direction: column; gap: 16px; padding: 18px; border-radius: 28px; background: ${T.stage}; color: ${T.onStage};
      box-shadow: 0 2px 4px oklch(30% 0.02 272 / 0.06), 0 34px 70px -30px oklch(20% 0.03 272 / 0.45); }
    .well { position: relative; flex: 1 1 auto; min-height: 0; border-radius: 18px; overflow: hidden; background: #0b0c10; }
    /* The still as the page shows it: the vertical frame over a soft, darkened copy of itself. */
    .well::before { content: ""; position: absolute; inset: -24px; background: url("${jpg('footage-talk.jpg')}") center / cover; filter: blur(22px) brightness(0.55) saturate(1.1); }
    .frame { position: absolute; top: 0; bottom: 0; left: 50%; aspect-ratio: 9 / 16; transform: translateX(-50%); background: url("${jpg('footage-talk.jpg')}") center / cover; }
    .burn { position: absolute; left: 0; right: 0; bottom: 15%; text-align: center; font-weight: 800; font-size: 25px; letter-spacing: -0.02em; color: #fff; text-shadow: 0 2px 12px rgb(0 0 0 / 0.55); }
    .ask { position: absolute; top: 30px; right: 30px; padding: 9px 16px; border-radius: 20px 20px 6px 20px; background: ${T.card}; color: ${T.ink}; font-family: "JetBrains Mono"; font-size: 20px; box-shadow: 0 8px 20px -8px rgb(0 0 0 / 0.5); }
    .reply { display: flex; gap: 12px; align-items: flex-start; font-family: "Serif Text"; font-size: 22px; line-height: 1.36; }
    .tile { flex: 0 0 34px; height: 34px; border-radius: 9px; background: ${T.card}; display: grid; place-items: center; margin-top: 1px; }
    .v2 { display: inline-flex; align-items: center; height: 26px; padding: 0 10px; margin-right: 8px; border-radius: 999px; background: ${T.rev2}; color: ${T.ink}; font: 700 15px/1 Figtree; vertical-align: 3px; }
    .strip { position: relative; height: 24px; }
    .strip i { position: absolute; top: 0; bottom: 0; border-radius: 6px; background: ${T.stage2}; box-shadow: inset 0 0 0 1px ${T.stageLine}; }
    .strip b { position: absolute; top: -6px; bottom: -6px; left: 31%; width: 3px; border-radius: 2px; background: ${T.cut}; }
  </style></head><body>
    <div class="words">
      <div class="lockup">${mark(44)}cutalong</div>
      <h1>The video editor you <span class="hl">talk to</span></h1>
      <p class="where">For Mac</p>
    </div>
    <div class="stage">
      <div class="well"><div class="frame"><span class="burn">Chromebook</span></div></div>
      <p class="ask">/takes</p>
      <div class="reply"><span class="tile">${mark(20)}</span><p><span class="v2">v2</span>runs 1:21, down from 1:35.</p></div>
      <div class="strip">${beats}<b></b></div>
    </div>
  </body></html>`
}

// A legal page's card: its name, large, and what it covers, under the lockup.
function doc(w, h, title, lede, path) {
  return `<!doctype html><html><head><style>${faces}
    body { width: ${w}px; height: ${h}px; padding: 64px 80px 60px; display: flex; flex-direction: column; justify-content: space-between; }
    h1 { font-weight: 800; font-size: 150px; line-height: 0.95; letter-spacing: -0.055em; }
    .lede { margin-top: 26px; max-width: 26ch; font-size: 36px; line-height: 1.28; color: ${T.ink2}; letter-spacing: -0.015em; text-wrap: balance; }
  </style></head><body>
    <div class="lockup">${mark(44)}cutalong</div>
    <div><h1>${title}</h1><p class="lede">${lede}</p></div>
    <p class="where">cutalong.io${path}</p>
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

// A job page's card: its heading and command beside the real panel the page shows for that job, the same
// panels the landing page's What you get draws (src/index.html), on paper or on the stage.
function job(w, h, { title, accent, command, path, panel, stage = false }) {
  return `<!doctype html><html><head><style>${faces}
    body { width: ${w}px; height: ${h}px; padding: 62px 64px 58px 72px; display: grid; grid-template-columns: minmax(0, 1fr) 470px; gap: 52px; }
    .words { display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
    h1 { font-weight: 800; font-size: 80px; line-height: 0.98; letter-spacing: -0.05em; }
    .say { display: inline-flex; align-self: flex-start; margin-top: 30px; padding: 10px 18px; border-radius: 999px; background: ${T.ink}; color: ${T.card}; font-family: "JetBrains Mono"; font-size: 24px; }
    .panel { align-self: center; display: flex; flex-direction: column; gap: 14px; padding: 28px; border-radius: 24px;
      background: ${stage ? T.stage : T.card}; color: ${stage ? T.onStage : T.ink};
      box-shadow: 0 1px 2px oklch(30% 0.02 272 / 0.06), 0 30px 60px -30px oklch(20% 0.03 272 / ${stage ? 0.45 : 0.28})${stage ? '' : `, inset 0 0 0 1px oklch(90.8% 0.007 80)`}; }
    .panel.blue { background: ${T.rev2}; box-shadow: 0 1px 2px oklch(30% 0.02 272 / 0.06), 0 30px 60px -30px oklch(20% 0.03 272 / 0.28); }
    .kick { display: flex; justify-content: space-between; font-size: 16px; font-weight: 700; color: ${T.muted}; }
    .line { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 8px; font-family: "Serif Text"; font-size: 21px; line-height: 1.35; }
    .line .n { font: 400 15px/1.9 Figtree; color: ${T.muted}; }
    .line s { color: ${T.muted}; text-decoration-color: ${T.cut}; text-decoration-thickness: 2px; }
    .line em { display: block; font-style: italic; font-size: 16px; color: ${T.ink2}; }
    .row { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 14px; align-items: baseline; padding: 14px 0; border-top: 1px solid oklch(90.8% 0.007 80); font-size: 21px; }
    .row:first-of-type { border-top: 0; padding-top: 0; }
    .row .mono, .mono { font-family: "JetBrains Mono"; font-size: 18px; color: ${T.ink2}; }
    .row.end { grid-template-columns: minmax(0, 1fr) auto; }
    .bubble { align-self: flex-end; padding: 10px 18px; border-radius: 20px 20px 6px 20px; background: ${T.card}; color: ${T.ink}; font-size: 20px; }
    .reply { font-family: "Serif Text"; font-size: 21px; line-height: 1.38; }
    .short { position: relative; align-self: center; width: 172px; aspect-ratio: 9 / 16; border-radius: 16px; background: url("${jpg('footage-short.jpg')}") center 30% / cover; }
    .short span { position: absolute; left: 0; right: 0; bottom: 18%; text-align: center; font-weight: 800; font-size: 19px; color: #fff; text-shadow: 0 2px 10px rgb(0 0 0 / 0.55); }
    .split { position: relative; display: grid; place-items: center; }
    .split .short { width: 236px; }
    .split .bubble { position: absolute; top: 4px; right: 0; box-shadow: 0 8px 20px -8px rgb(0 0 0 / 0.5); }
  </style></head><body>
    <div class="words">
      <div class="lockup">${mark(44)}cutalong</div>
      <div><h1>${title} <span class="hl">${accent}</span></h1><p class="say">${command}</p></div>
      <span></span>
    </div>
    <div class="panel${panel.blue ? ' blue' : ''}">${panel.html}</div>
  </body></html>`
}

// The real panels: the retake run, the slash menu's own words, the Shorts run, the clips and the vlog from the landing page.
const PANELS = {
  takes: { blue: true, html: `<p class="kick"><span>The script, v2</span><span>Blue pages</span></p>
    <p class="line"><span class="n">9</span><span><s>The RTX 5090 is the fastest graphics ca…</s></span></p>
    <p class="line"><span class="n">10</span><span><s>The RTX 5090 is the fa…</s></span></p>
    <p class="line"><span class="n">12</span><span><s>The RTX 5090 is the fastest graphics card you can b…</s></span></p>
    <p class="line"><span class="n">14</span><span>The RTX 5090 is the fastest graphics card you can buy right now.<em>the take that plays</em></span></p>
` },
  pauses: { html: `<p class="row"><span class="mono">/tighten</span><span>Pauses over 0.35 s and ums</span></p>
    <p class="row"><span class="mono">/snappy</span><span>Pauses over 0.15 s</span></p>` },
  shorts: { html: `<div class="split"><span class="short"><span>nine hundred bucks</span></span>
    <p class="bubble">Make it vertical and add captions</p></div>` },
  clips: { html: `<p class="row end"><span>The testimony that stands on its own</span><span class="mono">0:41</span></p>
    <p class="row end"><span>The question from the back row</span><span class="mono">0:58</span></p>
    <p class="row end"><span>Why the youth group meets on Tuesdays</span><span class="mono">0:33</span></p>
    <p class="row end"><span>The closing story</span><span class="mono">0:52</span></p>` },
  vlog: { html: `<p class="row"><span class="mono">Tease</span><span>The laughter at 13:40</span></p>
    <p class="row"><span class="mono">8:40</span><span>The café</span></p>
    <p class="row"><span class="mono">12:15</span><span>Up the ridge</span></p>
    <p class="row"><span class="mono">19:30</span><span>The estuary at dusk</span></p>
    <p class="row"><span class="mono">Close</span><span>You, saying it was the best day</span></p>` }
}

// ---- Drawn last, once everything above is defined.

// The link previews: the home page's for Open Graph (1200 x 630: Facebook, LinkedIn, iMessage, Slack, WhatsApp,
// Discord) and for X (1200 x 600), and one each for the legal pages. The build points each page at its own.
const FRAME = ', a still from the owner\'s own recording (src/img/footage-talk.jpg) that the landing page shows'
const cards = [
  ['og', 1200, 630, home, FRAME],
  ['twitter', 1200, 600, home, FRAME],
  ['og-privacy', 1200, 630, (w, h) => doc(w, h, 'Privacy', 'How Cutalong and this site handle your footage, your keys and your information.', '/privacy'), ''],
  ['og-terms', 1200, 630, (w, h) => doc(w, h, 'Terms', 'The terms for using Cutalong and this site.', '/terms'), ''],
  ['og-cut-retakes', 1200, 630, (w, h) => job(w, h, { title: 'Cut the retakes, keep the best', accent: 'take', command: '/takes', path: '/cut-retakes', panel: PANELS.takes }), ''],
  ['og-remove-pauses', 1200, 630, (w, h) => job(w, h, { title: 'Take out the pauses and the', accent: 'ums', command: '/tighten', path: '/remove-pauses', panel: PANELS.pauses }), ''],
  ['og-youtube-shorts', 1200, 630, (w, h) => job(w, h, { title: 'Turn a video into a', accent: 'Short', command: '/shorts', path: '/youtube-shorts', panel: PANELS.shorts, stage: true }), ', a still from the owner\'s own B-roll (src/img/footage-short.jpg) that the landing page shows'],
  ['og-clip-long-videos', 1200, 630, (w, h) => job(w, h, { title: 'One long recording, many', accent: 'clips', command: '/clipping', path: '/clip-long-videos', panel: PANELS.clips }), ''],
  ['og-vlog-editor', 1200, 630, (w, h) => job(w, h, { title: 'A day of clips, told as a', accent: 'story', command: '/vlog', path: '/vlog-editor', panel: PANELS.vlog }), '']
]
for (const [name, w, h, draw, origin] of cards) {
  writeFileSync(join(IMG, `${name}.png`), withOrigin(await shoot(draw(w, h), w, h, false), origin))
}

await browser.close()
console.log(`wrote ${cardsOnly ? '' : 'favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png, '}${cards.map(([n]) => `${n}.png`).join(', ')}`)
