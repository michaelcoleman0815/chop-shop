import { describe, expect, it } from 'vitest'
import {
  channelSearchUrl,
  describeSources,
  fromSource,
  orderFound,
  readSource,
  readSources,
  type FoundClip
} from './broll-sources'

describe('reading what was pasted', () => {
  it.each([
    ['@Veritasium', { kind: 'channel', handle: '@veritasium' }],
    ['https://www.youtube.com/@NASA/videos', { kind: 'channel', handle: '@nasa' }],
    ['youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ', { kind: 'channel', id: 'UCLA_DiR1FfKNvjuUpBHmylQ' }],
    ['https://m.youtube.com/c/Kurzgesagt', { kind: 'channel', name: 'Kurzgesagt' }],
    ['UCLA_DiR1FfKNvjuUpBHmylQ', { kind: 'channel', id: 'UCLA_DiR1FfKNvjuUpBHmylQ' }],
    ['pexels.com', { kind: 'site', host: 'pexels.com' }],
    ['https://www.vimeo.com/channels/staffpicks', { kind: 'site', host: 'vimeo.com' }],
    ['Lens Lab', { kind: 'channel', name: 'Lens Lab' }]
  ])('“%s”', (said, read) => {
    expect(readSource(said)).toMatchObject(read)
  })

  it('says why a video link is not a channel', () => {
    expect(readSource('https://www.youtube.com/watch?v=abc123')).toEqual({
      problem: '“https://www.youtube.com/watch?v=abc123” is a video, not a channel. Paste the channel’s link or its @handle.'
    })
  })

  it('keeps each source once and at most 30', () => {
    const lines = ['@nasa', 'youtube.com/@NASA', 'pexels.com', 'https://pexels.com/videos', ...Array.from({ length: 40 }, (_, i) => `site${i}.com`)]
    const r = readSources(lines)
    expect(r.sources.length).toBeLessThanOrEqual(30)
    expect(r.sources.filter((s) => s.kind === 'channel')).toHaveLength(1)
    expect(describeSources(readSources(['@nasa', 'pexels.com', 'vimeo.com']).sources)).toBe('1 channel and 2 websites')
  })

  it('searches inside a channel by its handle or id, and never a website', () => {
    expect(channelSearchUrl(readSource('@nasa') as never, 'rocket launch')).toBe(
      'https://www.youtube.com/@nasa/search?query=rocket%20launch'
    )
    expect(channelSearchUrl(readSource('pexels.com') as never, 'x')).toBeNull()
  })
})

const clip = (url: string, extra: Partial<FoundClip> = {}): FoundClip => ({
  url,
  title: url,
  author: null,
  durationSec: 20,
  ...extra
})

describe('which results come back', () => {
  const nasa = clip('https://www.youtube.com/watch?v=n1', { handle: '@NASA', author: 'NASA' })
  const spam = clip('https://www.youtube.com/watch?v=s1', {
    author: 'Reupload Central',
    channelUrl: 'https://www.youtube.com/channel/UCspamspamspamspamspam12',
    channelId: 'UCspamspamspamspamspam12'
  })
  const other = clip('https://www.youtube.com/watch?v=o1', { author: 'Nightfilm' })
  const site = clip('https://vimeo.com/123', { author: 'Someone' })

  it('matches a result to a channel by handle, id or name, and to a site by its host', () => {
    expect(fromSource(nasa, readSource('youtube.com/@nasa') as never)).toBe(true)
    expect(fromSource(spam, readSource('UCspamspamspamspamspam12') as never)).toBe(true)
    expect(fromSource(other, readSource('nightfilm') as never)).toBe(true)
    expect(fromSource(site, readSource('vimeo.com') as never)).toBe(true)
    expect(fromSource(other, readSource('vimeo.com') as never)).toBe(false)
  })

  it('never brings a blocked source back, and puts preferred ones first', () => {
    const lists = {
      prefer: readSources(['@nasa', 'vimeo.com']).sources,
      block: readSources(['youtube.com/channel/UCspamspamspamspamspam12']).sources
    }
    const r = orderFound([[nasa]], [other, spam, nasa, site], lists)
    expect(r.results.map((c) => c.url)).toEqual([nasa.url, site.url, other.url])
    expect(r.results.map((c) => c.preferred)).toEqual([true, true, false])
    expect(r.blocked).toBe(1)
  })
})
