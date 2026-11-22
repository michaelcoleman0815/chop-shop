import { describe, expect, it } from 'vitest'
import { captureLink, explainLoad, explainStatus, planTiles, stitch, type Screen } from './page-shot'

describe('capturing a whole page', () => {
  it('opens only http and https links, and never one with a password in it', () => {
    expect(captureLink('/screenshot https://example.com/post/1, rise')?.href).toBe('https://example.com/post/1')
    expect(captureLink('show this http://127.0.0.1:5288/page.html.')?.href).toBe('http://127.0.0.1:5288/page.html')
    expect(captureLink('file:///etc/passwd')).toBeNull()
    expect(captureLink('javascript:alert(1)')).toBeNull()
    expect(captureLink('https://user:secret@example.com/')).toBeNull()
    expect(captureLink('no link here')).toBeNull()
  })

  it('covers the page from the top, a screen at a time, the last one scrolled only as far as it goes', () => {
    expect(planTiles(1000, 400)).toEqual([
      { scrollY: 0, from: 0, rows: 400 },
      { scrollY: 400, from: 0, rows: 400 },
      { scrollY: 600, from: 200, rows: 200 }
    ])
    expect(planTiles(300, 400)).toEqual([{ scrollY: 0, from: 0, rows: 300 }])
    expect(planTiles(800, 400).reduce((n, t) => n + t.rows, 0)).toBe(800)
    expect(planTiles(0, 400)).toEqual([])
  })

  it('stitches the new rows of each screen, one under the next, at the capture’s scale', () => {
    // Screens of a page 5 rows tall, 2 rows a screen, at twice the size: each device row holds its page row's number.
    const screen = (scrollY: number): Screen => {
      const width = 2
      const height = 4
      const pixels = Buffer.alloc(width * height * 4)
      for (let row = 0; row < height; row++)
        pixels.fill(scrollY + Math.floor(row / 2), row * width * 4, (row + 1) * width * 4)
      return { pixels, width, height }
    }
    const tiles = planTiles(5, 2)
    const picture = stitch(
      tiles.map((tile) => ({ screen: screen(tile.scrollY), tile })),
      2,
      2
    )
    expect(picture.height).toBe(10)
    const rows = Array.from({ length: picture.height }, (_, y) => picture.pixels[y * picture.width * 4])
    expect(rows).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4])
  })

  it('says why a page could not be opened, in words a person can act on', () => {
    expect(explainLoad('ERR_NAME_NOT_RESOLVED (-105) loading https://nothing.invalid/')).toBe(
      'That address does not lead anywhere. Check the link.'
    )
    expect(explainLoad('ERR_CONNECTION_REFUSED (-102)')).toBe('The site did not answer.')
    expect(explainLoad('ERR_CERT_DATE_INVALID')).toMatch(/certificate/)
    expect(explainStatus(200)).toBeNull()
    expect(explainStatus(404)).toBe('There is no page at that link.')
    expect(explainStatus(403)).toBe('The site would not show that page to someone logged out.')
    expect(explainStatus(503)).toBe('The site answered with an error (503).')
  })
})
