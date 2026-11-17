/**
 * The Mac's Skia (@napi-rs/canvas) as the phone's page sees it. The export
 * draws a grid's ground and labels with it (src/main/grid-render.ts), which
 * src/main/cut-render.ts reaches for, so the import stays; on a phone there
 * is no Skia, and what would draw with it is on the Mac for now, refused
 * before an export starts (host/limits.ts, host/api.ts phoneWork). Reached
 * anyway, it says so rather than drawing nothing.
 */
const onTheMac = (): never => {
  throw new Error('Drawing graphics for the export is on the Mac for now.')
}

export const createCanvas = onTheMac
export const loadImage = onTheMac
export const GlobalFonts = { registerFromPath: onTheMac }
export class Path2D {
  constructor() {
    onTheMac()
  }
}
