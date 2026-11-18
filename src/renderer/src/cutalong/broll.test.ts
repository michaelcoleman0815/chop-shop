import { describe, expect, it } from 'vitest'
import { CC0, FAIR_USE, OWN, openverseLicense } from '../../../shared/broll/license'
import { planFor, type MomentResult } from '../../../shared/broll/route'
import type { Candidate, Moment, Ranked } from '../../../shared/broll/types'
import { choiceLabel, offerReply, pickedAside, priceRange, swapWords, type BrollPick, type BrollWebAsk } from './broll'

/** How the chat and the editor offer B-roll: generic moments, made-up finds. */

const moment: Moment = {
  beat: 'b2',
  said: 'the keyboard on this new laptop feels great',
  search: 'laptop keyboard close up',
  topic: 'A laptop review',
  format: 'long',
  output: { width: 1920, height: 1080 },
  seconds: 4,
  niche: 'tech'
}

const cand = (over: Partial<Candidate>): Candidate => ({
  id: 'x',
  source: 'wikimedia',
  kind: 'image',
  title: 'Laptop keyboard close up',
  author: 'Example',
  authorUrl: null,
  pageUrl: 'https://commons.wikimedia.org/wiki/File:Keyboard.jpg',
  mediaUrl: 'https://upload.wikimedia.org/keyboard.jpg',
  previewUrl: null,
  width: 2560,
  height: 1440,
  durationSec: null,
  bytes: null,
  license: CC0,
  tags: [],
  ...over
})

const ranked = (c: Candidate, reason = 'a reason'): Ranked => ({ candidate: c, score: 0.8, reason })

/** A moment's result with the plan the router makes when nothing has a key and the web waits for a yes. */
function result(results: Ranked[], notes: string[] = []): MomentResult {
  const plan = planFor(moment, {
    available: {
      why: (id) =>
        id === 'web'
          ? 'it costs money and waits for your yes'
          : ['pexels', 'pixabay', 'unsplash'].includes(id)
            ? 'it needs a free key, added in Settings'
            : id === 'youtube' || id === 'own-uploads'
              ? 'yt-dlp is missing from this build'
              : null
    }
  })
  return { moment, plan, results, asked: [], notes }
}

describe('offering B-roll', () => {
  it('names each choice for what it is and where it is from', () => {
    expect(choiceLabel(cand({}))).toBe('Laptop keyboard close up · Wikimedia Commons')
    expect(choiceLabel(cand({ source: 'library', kind: 'video', license: OWN }))).toBe('Your clip: Laptop keyboard close up')
    expect(choiceLabel(cand({ source: 'logos', kind: 'logo', title: 'HTML5' }))).toBe('The HTML5 logo')
    expect(choiceLabel(cand({ title: 'A very long title that goes on and on about a keyboard in the night' }))).toMatch(/…/)
  })

  it('offers the best few as buttons, the reasons behind Details, and what a key would add', () => {
    const r = result([ranked(cand({ id: 'a' }), 'Wikimedia Commons photo, 1440p, no credit needed (CC0 1.0).'), ranked(cand({ id: 'b', source: 'openverse', license: openverseLicense('by', '2.0') }))])
    const reply = offerReply({ ...r, notes: ['Wikimedia Commons did not answer, so it was left out.'] }, { moment: 'The keyboard on this new laptop feels great.', where: 'thread' })
    expect(reply.text).toBe('For “The keyboard on this new laptop feels great”, here is B-roll to pick from.')
    expect(reply.actions.map((a) => [a.kind, a.primary])).toEqual([
      ['add-broll', true],
      ['add-broll', false]
    ])
    const pick = JSON.parse(reply.actions[0].payload ?? '') as BrollPick
    expect(pick).toMatchObject({ beat: 'b2', hint: 'laptop keyboard close up', seconds: 4, where: 'thread', candidate: { id: 'a' } })
    expect(reply.details[0]).toEqual({ label: 'Wikimedia Commons', value: 'Laptop keyboard close up: Wikimedia Commons photo, 1440p, no credit needed (CC0 1.0).' })
    expect(reply.aside).toBe('Whatever you pick is credited in the upload kit.')
    // What was left out, and what a key would add, are behind Details.
    expect(reply.details.slice(2)).toEqual([
      { label: 'Left out', value: 'Wikimedia Commons did not answer, so it was left out.' },
      { label: 'With a free key', value: 'I could also look on Pexels, Pixabay and Unsplash. Settings has the steps.' }
    ])
    // Without a yes to its price, the web is never offered unless Settings has it on and a price to show.
    expect(reply.actions.some((a) => a.kind === 'broll-web')).toBe(false)
  })

  it('offers the web as a button with its price, never as a search of its own', () => {
    const quote = { low: 0.034, high: 0.12, searches: 3, said: 'Looking on the web for this moment costs about 3 cents to 12 cents on your Anthropic account, for at most 3 web searches.' }
    const reply = offerReply(result([]), { moment: null, where: 'thread', webQuote: quote })
    expect(reply.text).toBe('I found no B-roll for “laptop keyboard close up”.')
    const web = reply.actions.find((a) => a.kind === 'broll-web')
    expect(web?.label).toBe('Look on the web too, 3 to 12 cents')
    expect(web?.primary).toBe(true)
    expect((JSON.parse(web?.payload ?? '') as BrollWebAsk).moment.search).toBe('laptop keyboard close up')
    expect(reply.aside).toContain('It runs only if you tap it.')
    expect(priceRange({ ...quote, low: 1.2, high: 2.4 })).toBe('$1.20 to $2.40')
  })

  it('says plainly when a choice is someone else’s, and what a pick took', () => {
    const steam = cand({ source: 'steam', kind: 'video', title: 'Example Quest: Launch Trailer', license: FAIR_USE, durationSec: 62 })
    const reply = offerReply(result([ranked(steam)]), { moment: null, where: 'panel' })
    expect(reply.aside).toContain('It is someone else’s: credited, a short stretch at most, and whether that is fair use is your call.')
    expect(JSON.parse(reply.actions[0].payload ?? '').where).toBe('panel')
    // The editor's panel is narrow: a compact label, and a sentence or two.
    expect(reply.actions[0].label).toBe('Example Quest: Launch… · Steam')
    expect(reply.brief).toBe('Here is other B-roll, best first. What is someone else’s is credited, and whether it is fair use is your call.')
    const asset = {
      kind: 'video' as const,
      path: '/a.mp4',
      title: 'Example Quest: Launch Trailer',
      durationSec: 8,
      width: 1920,
      height: 1080,
      origin: { type: 'video' as const, url: null, author: null, license: null, range: { startSec: 15, endSec: 23 }, credit: '“Example Quest: Launch Trailer” from Steam' }
    }
    expect(pickedAside(asset, steam)).toBe(
      'Only 0:15 to 0:23 of it is used. It is credited in the upload kit: “Example Quest: Launch Trailer” from Steam. Whether that is fair use is your call.'
    )
    expect(pickedAside(asset, cand({ source: 'library', license: OWN }))).toBeNull()
  })

  it('looks for other B-roll by what the beat cuts to now, or by what is said there', () => {
    expect(swapWords({ title: 'city_at-night' }, 'we drove home late')).toBe('city at night')
    expect(swapWords({ title: 'IMG_0042' }, 'we drove home late')).toBe('we drove home late')
    expect(swapWords(undefined, 'we drove home late that night with the windows down and music on')).toBe('we drove home late that night with the')
  })
})
