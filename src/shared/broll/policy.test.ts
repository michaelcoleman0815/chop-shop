import { describe, expect, it } from 'vitest'
import {
  CC0,
  FAIR_USE,
  licenseFromUrl,
  logoLicense,
  NASA,
  OWN,
  openverseLicense,
  PEXELS,
  PIXABAY,
  UNKNOWN,
  UNSPLASH,
  wikimediaLicense
} from './license'
import { judge, sourceBlocked, stretchFor } from './policy'
import { overlap, stem, stems, words } from './text'
import type { Candidate, License } from './types'

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'x',
  source: 'openverse',
  kind: 'image',
  title: 'A laptop keyboard',
  author: 'Example',
  authorUrl: null,
  pageUrl: 'https://www.flickr.com/photos/example/1',
  mediaUrl: 'https://live.staticflickr.com/1/1.jpg',
  previewUrl: null,
  width: 1920,
  height: 1080,
  durationSec: null,
  bytes: null,
  license: CC0,
  tags: [],
  ...over
})

describe('words for matching', () => {
  it('stems plurals, -ing and -ed so they find each other', () => {
    expect(stem('keyboards')).toBe('keyboard')
    expect(stem('typing')).toBe(stem('type'))
    expect(stem('typed')).toBe('type')
    expect(stem('launches')).toBe(stem('launch'))
    expect(stem('batteries')).toBe('battery')
    expect(stem('running')).toBe('run')
    // Words that end in s without being plurals stay whole.
    expect(stem('news')).toBe('news')
    expect(stem('glass')).toBe('glass')
  })

  it('splits names the way files are named and drops what says nothing about the picture', () => {
    // "4K" is about the file, not the picture.
    expect(words('MacBookPro_4K-sunset01')).toEqual(['mac', 'book', 'pro', 'sunset01'])
    expect(words('stock footage of hands typing on a laptop at night')).toEqual(['hands', 'typing', 'laptop', 'night'])
    expect(words('IMG_0042 final v2 copy', { file: true })).toEqual([])
  })

  it('weighs what was searched for above what was said', () => {
    const want = [
      { stem: 'keyboard', weight: 2 },
      { stem: 'night', weight: 1 }
    ]
    expect(overlap(want, stems('keyboard close up'))).toBeCloseTo(2 / 3)
    expect(overlap(want, stems('night sky'))).toBeCloseTo(1 / 3)
    // Five letters in common counts for half; four do not.
    expect(overlap([{ stem: 'keyboard', weight: 1 }], ['keys'])).toBe(0)
    expect(overlap([{ stem: 'astronaut', weight: 1 }], ['astronomy'])).toBe(0.5)
  })
})

describe('licences, as each API writes them', () => {
  it('reads Openverse codes', () => {
    expect(openverseLicense('cc0').id).toBe('cc0')
    expect(openverseLicense('by', '2.0')).toMatchObject({ id: 'cc-by', name: 'CC BY 2.0', credit: true, monetized: 'yes', modify: true })
    expect(openverseLicense('by-nc-sa', '2.0')).toMatchObject({ id: 'cc-by-nc-sa', monetized: 'no' })
    expect(openverseLicense('by-nd', '4.0')).toMatchObject({ id: 'cc-by-nd', modify: false, monetized: 'yes' })
    expect(openverseLicense('sampling+').id).toBe('unknown')
  })

  it('reads licence links, the Internet Archive’s public domain one included', () => {
    expect(licenseFromUrl('http://creativecommons.org/publicdomain/zero/1.0/').id).toBe('cc0')
    expect(licenseFromUrl('http://creativecommons.org/licenses/publicdomain/').id).toBe('public-domain')
    expect(licenseFromUrl('https://creativecommons.org/publicdomain/mark/1.0/').id).toBe('pdm')
    expect(licenseFromUrl('https://creativecommons.org/licenses/by/4.0/')).toMatchObject({ id: 'cc-by', name: 'CC BY 4.0' })
    expect(licenseFromUrl('http://creativecommons.org/licenses/by-nc/3.0/')).toMatchObject({ id: 'cc-by-nc', monetized: 'no' })
    expect(licenseFromUrl('http://creativecommons.org/licenses/sampling+/1.0/').id).toBe('unknown')
    expect(licenseFromUrl(null).id).toBe('unknown')
  })

  it('reads Wikimedia’s short names and template codes', () => {
    expect(wikimediaLicense('CC BY-SA 4.0', 'cc-by-sa-4.0').id).toBe('cc-by-sa')
    expect(wikimediaLicense('Public domain', 'pd').id).toBe('public-domain')
    expect(wikimediaLicense('CC0', 'cc0').id).toBe('cc0')
    expect(wikimediaLicense('CC BY 2.0', null)).toMatchObject({ id: 'cc-by', name: 'CC BY 2.0' })
    expect(wikimediaLicense('GFDL', 'gfdl').id).toBe('unknown')
  })

  it('treats every logo as a trademark, and keeps the licence of a drawing that has one', () => {
    expect(logoLicense(null)).toMatchObject({ id: 'trademark', monetized: 'yes', modify: false })
    expect(logoLicense('CC-BY-NC-4.0').monetized).toBe('no')
    expect(logoLicense('GPL-3.0-only').id).toBe('copyleft')
    expect(logoLicense('custom', 'https://example.com/brand').monetized).toBe('your-call')
    expect(logoLicense('MIT').id).toBe('trademark')
  })
})

describe('the licence policy', () => {
  const ok = (l: License, over: Partial<Candidate> = {}): boolean => judge(cand({ license: l, ...over })).ok

  it('offers by default only what a monetized YouTube video can use', () => {
    expect(ok(CC0)).toBe(true)
    expect(ok(licenseFromUrl('https://creativecommons.org/publicdomain/mark/1.0/'))).toBe(true)
    expect(ok(openverseLicense('by', '4.0'))).toBe(true)
    expect(ok(PEXELS)).toBe(true)
    expect(ok(PIXABAY)).toBe(true)
    expect(ok(UNSPLASH)).toBe(true)
    expect(ok(NASA)).toBe(true)
    expect(ok(OWN, { source: 'library' })).toBe(true)
  })

  it('never offers anything non-commercial, unknown or copyleft', () => {
    expect(ok(openverseLicense('by-nc', '4.0'))).toBe(false)
    expect(ok(openverseLicense('by-nc-nd', '4.0'))).toBe(false)
    expect(ok(UNKNOWN)).toBe(false)
    expect(ok(logoLicense('GPL-3.0-only'), { source: 'logos', kind: 'logo' })).toBe(false)
    const v = judge(cand({ license: openverseLicense('by-nc', '4.0') }))
    expect(v).toMatchObject({ ok: false, by: 'license', trouble: 'non-commercial' })
    expect(judge(cand({ license: UNKNOWN }))).toMatchObject({ trouble: 'unclear' })
  })

  it('lets non-commercial through only when the person says the video is not monetized', () => {
    expect(judge(cand({ license: openverseLicense('by-nc', '4.0') }), { monetized: false }).ok).toBe(true)
    expect(judge(cand({ license: UNKNOWN }), { monetized: false }).ok).toBe(false)
  })

  it('offers no-derivatives only for a use that leaves it unchanged, and logos always as they are', () => {
    const nd = openverseLicense('by-nd', '4.0')
    expect(ok(nd)).toBe(false)
    expect(judge(cand({ license: nd }))).toMatchObject({ by: 'license', trouble: 'no-changes' })
    expect(judge(cand({ license: nd }), { use: 'unchanged' }).ok).toBe(true)
    expect(ok(logoLicense(null), { source: 'logos', kind: 'logo' })).toBe(true)
  })

  it('leaves share-alike out unless the person allows it', () => {
    const sa = openverseLicense('by-sa', '4.0')
    expect(ok(sa)).toBe(false)
    expect(judge(cand({ license: sa }))).toMatchObject({ by: 'license', trouble: 'share-alike' })
    expect(judge(cand({ license: sa }), { shareAlike: true }).ok).toBe(true)
  })

  it('offers other people’s clips, pages and posts as the person’s call, unless the channel uses only licensed material', () => {
    const v = judge(cand({ source: 'youtube', kind: 'video', license: FAIR_USE }))
    expect(v).toEqual({ ok: true, preferred: false, note: 'fair use is your call' })
    expect(judge(cand({ source: 'youtube', license: FAIR_USE }), { fairUse: false }).ok).toBe(false)
  })

  it('lets the never list win over everything, the person’s own material excepted', () => {
    expect(judge(cand({ license: CC0 }), { never: ['broll'] })).toMatchObject({ ok: false, by: 'never' })
    expect(judge(cand({ source: 'library', license: OWN }), { never: ['broll'] }).ok).toBe(true)
    expect(judge(cand({ source: 'own-uploads', kind: 'video', license: OWN }), { never: ['broll'] }).ok).toBe(true)
    const sfx = cand({ source: 'freesound', kind: 'audio', license: CC0, extra: { audio: 'sfx' } })
    expect(judge(sfx, { never: ['sfx'] }).ok).toBe(false)
    expect(judge(sfx, { never: ['music'] }).ok).toBe(true)
    // A library sound is the person's own, but a channel that never uses whooshes never gets one named so.
    const mine = { ...sfx, source: 'library' as const, license: OWN }
    expect(judge({ ...mine, title: 'Big whoosh 03' }, { never: ['sfx:whoosh'] }).ok).toBe(false)
    expect(judge({ ...mine, title: 'Mouse click' }, { never: ['sfx:whoosh'] }).ok).toBe(true)
    expect(judge(cand({ source: 'logos', kind: 'logo', license: logoLicense(null) }), { never: ['motion:logo'] }).ok).toBe(false)
  })

  it('lets the brand’s blocked sources win, whole sites, channels and single Bluesky accounts', () => {
    const block = { prefer: [], block: ['flickr.com'] }
    expect(judge(cand(), { brand: block })).toMatchObject({ ok: false, by: 'blocked' })
    const yt = cand({
      source: 'youtube',
      kind: 'video',
      license: FAIR_USE,
      pageUrl: 'https://www.youtube.com/watch?v=abc123def45',
      author: 'Reupload Central',
      extra: { handle: '@reuploadcentral', channelId: 'UCreuploadreuploadreup12', channelUrl: null }
    })
    expect(judge(yt, { brand: { prefer: [], block: ['@reuploadcentral'] } }).ok).toBe(false)
    expect(judge(yt, { brand: { prefer: [], block: ['@someoneelse'] } }).ok).toBe(true)
    const post = cand({ source: 'bluesky', kind: 'post', license: FAIR_USE, pageUrl: 'https://bsky.app/profile/a.bsky.social/post/1', extra: { handle: 'a.bsky.social' } })
    expect(judge(post, { brand: { prefer: [], block: ['https://bsky.app/profile/a.bsky.social'] } }).ok).toBe(false)
    expect(judge(post, { brand: { prefer: [], block: ['https://bsky.app/profile/b.bsky.social'] } }).ok).toBe(true)
    // A blocked whole site keeps its source from being asked; one blocked account does not.
    expect(sourceBlocked('pexels', ['pexels.com'])).toBe(true)
    expect(sourceBlocked('bluesky', ['bsky.app/profile/a.bsky.social'])).toBe(false)
    expect(sourceBlocked('bluesky', ['bsky.app'])).toBe(true)
  })

  it('marks what comes from a preferred source', () => {
    expect(judge(cand(), { brand: { prefer: ['flickr.com'], block: [] } })).toMatchObject({ ok: true, preferred: true })
  })
})

describe('the stretch fetched from a video', () => {
  it('keeps someone else’s clip short: the shot, or 8 seconds, never past 30', () => {
    const clip = cand({ source: 'youtube', kind: 'video', license: FAIR_USE, durationSec: 600 })
    expect(stretchFor(clip)).toEqual({ startSec: 150, endSec: 158 })
    expect(stretchFor(clip, 5)).toEqual({ startSec: 150, endSec: 155 })
    expect(stretchFor(clip, 90)).toEqual({ startSec: 150, endSec: 180 })
    expect(stretchFor({ ...clip, range: { startSec: 10, endSec: 100 } })).toEqual({ startSec: 10, endSec: 40 })
    // A fair-use clip shorter than the shot is still only a stretch, all of it.
    expect(stretchFor({ ...clip, durationSec: 6 })).toEqual({ startSec: 0, endSec: 6 })
  })

  it('uses a short licensed clip whole and takes at most a minute of a long one', () => {
    expect(stretchFor(cand({ kind: 'video', license: PEXELS, durationSec: 14 }))).toBeNull()
    const film = cand({ source: 'archive', kind: 'video', license: CC0, durationSec: 742 })
    expect(stretchFor(film, 6)).toEqual({ startSec: 185.5, endSec: 191.5 })
    expect(stretchFor({ ...film, range: { startSec: 0, endSec: 300 } })).toEqual({ startSec: 0, endSec: 60 })
  })
})
