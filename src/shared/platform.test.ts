import { describe, expect, it } from 'vitest'
import { signInBrowsers } from './platform'

/**
 * A video link that needs a sign-in borrows one from a browser through
 * yt-dlp. On Windows, Chrome, Edge and Brave lock theirs, so Settings offers
 * there, and the app keeps, only the browser whose sign-in can be read.
 */
describe('the browsers a sign-in can be borrowed from', () => {
  it('is Firefox alone on Windows', () => {
    expect(signInBrowsers('win32')).toEqual(['firefox'])
  })

  it('is every browser yt-dlp reads on a Mac, Safari among them', () => {
    const mac = signInBrowsers('darwin')
    for (const browser of ['chrome', 'safari', 'firefox', 'edge', 'brave']) expect(mac).toContain(browser)
  })
})
