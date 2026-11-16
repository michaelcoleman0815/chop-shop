import { BrowserWindow, nativeImage, session, type Session, type WebContents } from 'electron'
import { explainLoad, explainStatus, planTiles, stitch, type Screen, type Tile } from './page-shot'

/**
 * A page at a link the person gave, captured as one tall picture on this
 * computer. A hidden, offscreen window opens it in a private session that is
 * emptied before every capture, so what comes out is the page as it shows
 * to someone logged out: no cookies, no sign-in, nothing remembered. The page
 * is read a screen at a time and the screens are stitched into one picture.
 */

/** As wide as a phone shows a page, in CSS pixels. */
const WIDTH = 430
/**
 * Drawn at twice that, for sharp text in the frame. An offscreen window's
 * capturePage comes back at one pixel per point whatever its scale factor, so
 * the window is twice as wide and the page is zoomed to fill it.
 */
const ZOOM = 2
/** The window's height in points: a screen of 400 CSS pixels, low enough for any display. */
const VIEWPORT = 800
/** Pages longer than this are cut off: a showcase scrolls through the first few screens. */
const MAX_HEIGHT = 4800
const LOAD_TIMEOUT = 20_000

export interface PageCapture {
  png: Buffer
  width: number
  height: number
  title: string
  /** Where the page ended up after redirects. */
  url: string
}

let prepared: Session | null = null

/** The private session captures load in: in memory only, asking for nothing, downloading nothing. */
function captureSession(): Session {
  if (prepared) return prepared
  const ses = session.fromPartition('cutalong-capture', { cache: false })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (e) => e.preventDefault())
  // A plain Chrome user agent: some pages turn away anything that names Electron.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|Cutalong|chop-shop|Chop Shop)\/\S+/gi, ''))
  prepared = ses
  return ses
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Scrolls the page and resolves once it has painted there, with where it really is. */
async function scrollTo(wc: WebContents, y: number): Promise<number> {
  const at = await wc.executeJavaScript(
    `new Promise((r) => { window.scrollTo(0, ${Math.round(y)}); requestAnimationFrame(() => requestAnimationFrame(() => r(Math.round(window.scrollY)))) })`,
    true
  )
  await wait(120)
  return Number(at) || 0
}

let queue: Promise<unknown> = Promise.resolve()

/** One capture at a time: each one opens a window of its own. */
export function capturePage(url: string): Promise<PageCapture> {
  const run = queue.then(() => capture(url))
  queue = run.catch(() => undefined)
  return run
}

async function capture(url: string): Promise<PageCapture> {
  const ses = captureSession()
  // Logged out, every time: nothing a page set before is still there.
  await ses.clearStorageData()
  await ses.clearCache()
  const win = new BrowserWindow({
    show: false,
    width: WIDTH * ZOOM,
    height: VIEWPORT,
    useContentSize: true,
    enableLargerThanScreen: true,
    webPreferences: {
      session: ses,
      offscreen: true,
      zoomFactor: ZOOM,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  })
  const wc = win.webContents
  try {
    wc.setAudioMuted(true)
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    let settled = false
    // Redirects while it opens are the page's own; once open, it stays put.
    wc.on('will-navigate', (e) => {
      if (settled) e.preventDefault()
    })
    // The status the page itself answered with, after any redirects.
    let status = 0
    wc.on('did-navigate', (_e, _url, code) => {
      status = code
    })
    // No scrollbars in the picture.
    wc.on('dom-ready', () => {
      void wc.insertCSS('::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }')
    })
    const loaded = wc.loadURL(url).then(
      () => null,
      (err: Error) => err.message
    )
    const failed = await Promise.race([loaded, wait(LOAD_TIMEOUT).then(() => 'timeout')])
    if (failed && failed !== 'timeout') throw new Error(explainLoad(failed))
    const refused = explainStatus(status)
    if (refused) throw new Error(refused)
    if (!wc.getURL() || wc.getURL() === 'about:blank') throw new Error('The page did not open in time.')
    settled = true
    await wait(900)

    // Down the page once, so pictures that load as they come into view are there, then back up.
    const page = await wc.executeJavaScript(
      `(async () => {
        const tall = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)
        for (let y = 0; y < Math.min(tall(), ${MAX_HEIGHT}); y += innerHeight * 0.8) {
          window.scrollTo(0, y)
          await new Promise((r) => setTimeout(r, 140))
        }
        window.scrollTo(0, 0)
        await new Promise((r) => setTimeout(r, 400))
        return { height: tall(), view: innerHeight, title: document.title }
      })()`,
      true
    )
    const view = Math.max(1, Math.round(Number(page.view) || VIEWPORT / ZOOM))
    const height = Math.min(MAX_HEIGHT, Math.max(1, Math.round(Number(page.height) || view)))
    const screens: { screen: Screen; tile: Tile }[] = []
    let covered = 0
    for (const [i, planned] of planTiles(height, view).entries()) {
      const at = await scrollTo(wc, planned.scrollY)
      if (i === 1) {
        // Bars that stay on screen as it scrolls would repeat down the picture: after the first screen they go.
        await wc.executeJavaScript(
          `for (const el of document.querySelectorAll('body *')) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') el.style.setProperty('visibility', 'hidden', 'important') }`,
          true
        )
        await wait(120)
      }
      // Where the page really scrolled to decides which of its rows are new.
      const from = covered - at
      if (from < 0 || from >= view) break
      const rows = Math.min(view - from, height - covered)
      const shot = await win.capturePage(undefined, { stayHidden: true })
      const size = shot.getSize()
      if (size.width === 0 || size.height === 0) throw new Error('The page did not draw anything to capture.')
      screens.push({
        screen: { pixels: shot.toBitmap(), width: size.width, height: size.height },
        tile: { scrollY: at, from, rows }
      })
      covered += rows
      if (covered >= height) break
    }
    if (screens.length === 0) throw new Error('The page did not draw anything to capture.')
    const scale = screens[0].screen.width / WIDTH
    const picture = stitch(screens, scale, screens[0].screen.width)
    const png = nativeImage.createFromBitmap(picture.pixels, { width: picture.width, height: picture.height }).toPNG()
    return {
      png,
      width: picture.width,
      height: picture.height,
      title: String(page.title ?? '').trim(),
      url: wc.getURL()
    }
  } finally {
    win.destroy()
    void ses.clearStorageData()
  }
}
