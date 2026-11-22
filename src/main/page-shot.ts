/**
 * The arithmetic of capturing a whole page a screen at a time: which link may
 * be opened, where to scroll for each screen, and how the screens are
 * stitched into one tall picture. No Electron here, so it can be tested.
 */

/** The first http or https link in what the person typed, or null. Links with a user name or password in them are refused. */
export function captureLink(text: string): URL | null {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text)
  if (!m) return null
  try {
    const url = new URL(m[0].replace(/[).,;!?]+$/, ''))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password) return null
    return url
  } catch {
    return null
  }
}

/** One screen of the page: where it is scrolled to, and which of its rows are new, in CSS pixels. */
export interface Tile {
  scrollY: number
  /** The first row of the screen that is not already in the picture. */
  from: number
  rows: number
}

/** Screens that cover a page of this height from the top, the last one scrolled only as far as the page goes. */
export function planTiles(pageHeight: number, viewport: number): Tile[] {
  const height = Math.max(0, Math.floor(pageHeight))
  const view = Math.max(1, Math.floor(viewport))
  const tiles: Tile[] = []
  let covered = 0
  while (covered < height) {
    const scrollY = Math.min(covered, Math.max(0, height - view))
    const from = covered - scrollY
    const rows = Math.min(view - from, height - covered)
    tiles.push({ scrollY, from, rows })
    covered += rows
  }
  return tiles
}

/** A screen as captured: raw 4-byte pixels, `width` by `height`, at the capture's scale. */
export interface Screen {
  pixels: Buffer
  width: number
  height: number
}

/**
 * The screens, one under the next, as one picture `width` wide. Each screen
 * gives the rows its tile says are new (scaled from CSS to device pixels);
 * where a screen came back short, its rows are left as they are.
 */
export function stitch(
  screens: { screen: Screen; tile: Tile }[],
  scale: number,
  width: number
): { pixels: Buffer; width: number; height: number } {
  const rowsOf = (t: Tile): [number, number] => [Math.round(t.from * scale), Math.round((t.from + t.rows) * scale)]
  const height = screens.reduce((sum, { tile }) => {
    const [a, b] = rowsOf(tile)
    return sum + (b - a)
  }, 0)
  const out = Buffer.alloc(width * height * 4)
  let y = 0
  for (const { screen, tile } of screens) {
    const [a, b] = rowsOf(tile)
    const copy = Math.min(width, screen.width) * 4
    for (let row = a; row < b; row++, y++) {
      if (row >= screen.height) continue
      const at = row * screen.width * 4
      screen.pixels.copy(out, y * width * 4, at, at + copy)
    }
  }
  return { pixels: out, width, height }
}

/** A loading failure from Chromium, as something a person can act on. */
export function explainLoad(error: string): string {
  if (/ERR_NAME_NOT_RESOLVED/.test(error)) return 'That address does not lead anywhere. Check the link.'
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(error)) return 'This computer is offline.'
  if (/ERR_CERT_/.test(error)) return 'The site’s certificate is not valid, so I did not open it.'
  if (/ERR_CONNECTION_(REFUSED|TIMED_OUT|RESET|CLOSED)|ERR_TIMED_OUT/.test(error)) return 'The site did not answer.'
  if (/ERR_BLOCKED|ERR_ACCESS_DENIED/.test(error)) return 'The site would not let me open it.'
  return 'I could not open that page.'
}

/** A page that answered with an error, as a sentence; null when it answered fine. */
export function explainStatus(code: number): string | null {
  if (!code || code < 400) return null
  if (code === 404 || code === 410) return 'There is no page at that link.'
  if (code === 401 || code === 403) return 'The site would not show that page to someone logged out.'
  if (code === 429) return 'The site is turning visitors away for now. Try again in a while.'
  return `The site answered with an error (${code}).`
}
