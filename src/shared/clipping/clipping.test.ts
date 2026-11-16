import { describe, expect, it } from 'vitest'
import { currentCut, currentVersion, resolveCut, undoTarget } from '../edit'
import { PLANTED, PODCAST, SERVICE, STREAM, type Planted } from './fixtures'
import { factsOf, momentSpan } from './testing'
import { clippingAsked, readClipAsk } from './ask'
import { measureRecording, planRecording } from './plan'
import { fitPick, shapePicks } from './shape'
import { clipDoc } from './doc'
import { CLIP_PROFILES } from './profile'
import { clipsReply, type ClipsFound } from './reply'
import { overlapWith } from './leave-out'

/**
 * /clipping on three planted long recordings (shared/clipping/fixtures): a
 * 22-minute service, a 30-minute two-voice podcast and a 69-minute stream.
 * The truth is planted: where the worship set, the announcements, the
 * sponsor read and the BRB screen are, and which stories a clip has to find
 * whole, from their first concrete detail to their meaning.
 */

const ask = readClipAsk('')

function run(p: Planted, said = '', avoid: { startSec: number; endSec: number }[] = []) {
  const facts = factsOf(p)
  const a = readClipAsk(said)
  const plan = planRecording(facts, a, null)
  const picks = measureRecording(facts, plan, a, avoid)
  return { facts, plan, picks }
}

/** A planted span, by tag, every stretch of it. */
const spans = (p: ReturnType<typeof run>, tag: string) => p.facts.timeline.spans.filter((s) => s.tag === tag)

describe('what a clip never comes from', () => {
  it('leaves out the worship set, the closing song, the announcements, the giving and the goodbye of a service', () => {
    const r = run(SERVICE)
    expect(r.plan.profile.id).toBe('church')
    const kinds = r.plan.regions.map((x) => x.kind)
    expect(kinds).toEqual(expect.arrayContaining(['worship', 'announcements', 'giving', 'goodbye']))
    // Both songs, every sung line of them.
    for (const tag of ['worship', 'worship-2']) {
      for (const s of spans(r, tag)) {
        const sung = r.facts.timeline.words.filter((w) => w.tag === tag)
        const covered = sung.filter((w) => overlapWith(r.plan.regions, w.startSec, w.endSec) > 0)
        expect(covered.length / sung.length, `${tag} at ${s.startSec}`).toBe(1)
      }
    }
    for (const tag of ['announcements', 'giving']) {
      const said = r.facts.timeline.words.filter((w) => w.tag === tag)
      const covered = said.filter((w) => overlapWith(r.plan.regions, w.startSec, w.endSec) > 0)
      // The welcome before the first cue may stay; nearly every word of the notices goes.
      expect(covered.length / said.length, tag).toBeGreaterThan(0.8)
    }
    // Nothing a story says is left out.
    for (const m of SERVICE.moments) {
      const span = momentSpan(r.facts.timeline, m)
      expect(overlapWith(r.plan.regions, span.startSec, span.endSec), m.tag).toBe(0)
    }
  })

  it('leaves out a podcast’s warm-up, its sponsor read and its goodbye', () => {
    const r = run(PODCAST)
    expect(r.plan.profile.id).toBe('podcast')
    const byKind = Object.fromEntries(r.plan.regions.map((x) => [x.kind, x]))
    expect(byKind.warmup.startSec).toBe(0)
    const warm = spans(r, 'warmup')[0]
    expect(byKind.warmup.endSec).toBeGreaterThanOrEqual(warm.endSec - 0.5)
    const sponsor = spans(r, 'sponsor')[0]
    expect(byKind.sponsor.startSec).toBeLessThanOrEqual(sponsor.startSec + 0.01)
    expect(byKind.sponsor.endSec).toBeGreaterThanOrEqual(sponsor.endSec - 0.5)
    // "Okay, back to Jordan." is the show again, not the read.
    expect(byKind.sponsor.endSec).toBeLessThan(sponsor.endSec + 3)
    expect(byKind.goodbye.endSec).toBe(r.facts.durationSec)
  })

  it('leaves out a stream’s starting soon, its BRB and its ending screen, words heard over the music and all', () => {
    const r = run(STREAM)
    expect(r.plan.profile.id).toBe('livestream')
    const furniture = r.plan.regions.filter((x) => x.kind === 'furniture')
    expect(furniture.map((x) => x.label)).toEqual(['starting soon', 'a break', 'the ending screen'])
    for (const tag of ['starting-soon', 'brb', 'ending']) {
      const s = spans(r, tag)[0]
      expect(overlapWith(r.plan.regions, s.startSec, s.endSec), tag).toBeGreaterThan(s.endSec - s.startSec - 1)
    }
  })
})

describe('finding the clips by measuring', () => {
  for (const p of PLANTED) {
    it(`finds every planted moment of the ${p.kind} whole, and nothing where a clip never comes from`, () => {
      const r = run(p)
      for (const m of p.moments) {
        const span = momentSpan(r.facts.timeline, m)
        const hit = r.picks.find((c) => Math.abs(c.startSec - span.startSec) < 0.01)
        expect(hit, `${m.tag} starts at its first line`).toBeDefined()
        // It ends on its last line, or a beat after it, keeping the laugh at the punchline.
        const laugh = r.facts.timeline.laughter.find(
          (l) => l.startSec >= span.endSec && l.startSec <= span.endSec + 0.8
        )
        const ends = laugh ? [span.endSec, laugh.endSec] : [span.endSec]
        expect(
          ends.some((e) => Math.abs((hit?.endSec ?? 0) - e) < 0.01),
          `${m.tag} ends on its meaning`
        ).toBe(true)
      }
      for (const tag of p.never) {
        for (const s of spans(r, tag)) {
          for (const c of r.picks) {
            const overlap = Math.min(c.endSec, s.endSec) - Math.max(c.startSec, s.startSec)
            expect(overlap, `a clip at ${c.startSec} reaches into ${tag}`).toBeLessThanOrEqual(0)
          }
        }
      }
    })

    it(`keeps every clip of the ${p.kind} inside its length and on word boundaries`, () => {
      const r = run(p)
      const starts = new Set(r.facts.words.map((w) => w.startSec))
      const ends = new Set([...r.facts.words.map((w) => w.endSec), ...r.facts.timeline.laughter.map((l) => l.endSec)])
      expect(r.picks.length).toBeGreaterThan(0)
      for (const c of r.picks) {
        const len = c.endSec - c.startSec
        expect(len).toBeGreaterThanOrEqual(r.plan.bounds.minSec)
        expect(len).toBeLessThanOrEqual(r.plan.bounds.maxSec)
        expect(starts.has(c.startSec)).toBe(true)
        expect(ends.has(c.endSec)).toBe(true)
        expect(c.title.split(' ').length).toBeLessThanOrEqual(8)
        expect(c.title).not.toMatch(/[.!?,]$/)
      }
    })
  }

  it('returns fewer clips rather than padding the set with ordinary talk', () => {
    // Every planted recording asks for more clips than it holds moments.
    for (const p of PLANTED) {
      const r = run(p)
      expect(r.plan.count).toBeGreaterThan(p.moments.length)
      const tagged = r.picks.filter((c) =>
        r.facts.timeline.words.some((w) => w.startSec >= c.startSec && w.endSec <= c.endSec && w.tag)
      )
      expect(tagged.length).toBe(r.picks.length)
    }
  })

  it('gives the story a title from what it means, and its opening line as the hook', () => {
    const r = run(SERVICE)
    const grace = r.picks.find((c) => c.hook.startsWith('In the winter'))
    expect(grace?.title).toBe('What grace looks like')
    expect(grace?.kind).toBe('story')
    expect(grace?.reason).toMatch(/story told whole/)
  })

  it('finds only the funny parts when asked, with the laugh in each', () => {
    for (const p of [PODCAST, STREAM]) {
      const r = run(p, 'the funny parts')
      expect(r.picks.length).toBeGreaterThan(0)
      for (const c of r.picks) {
        expect(
          r.facts.timeline.laughter.some((l) => l.startSec >= c.startSec && l.endSec <= c.endSec + 0.01),
          c.title
        ).toBe(true)
      }
    }
  })

  it('finds the part about forgiveness, and only that', () => {
    const r = run(SERVICE, 'the part about forgiveness')
    expect(r.plan.count).toBe(1)
    expect(r.picks).toHaveLength(1)
    expect(r.picks[0].hook).toMatch(/^Two years ago/)
    expect(r.picks[0].kind).toBe('story')
    // A recording that never mentions it gives nothing, not the nearest thing.
    expect(run(PODCAST, 'the part about forgiveness').picks).toHaveLength(0)
  })

  it('finds as many as asked, best first', () => {
    const r = run(STREAM, '2')
    expect(r.picks).toHaveLength(2)
    expect(r.picks[0].score).toBeGreaterThanOrEqual(r.picks[1].score)
  })

  it('holds clips to the length asked for', () => {
    const r = run(PODCAST, '20 second clips')
    expect(r.plan.bounds).toMatchObject({ minSec: 13, maxSec: 20 })
    for (const c of r.picks) expect(c.endSec - c.startSec).toBeLessThanOrEqual(20)
  })

  it('finds new moments when asked again, never the ones already in the set', () => {
    const first = run(STREAM)
    const again = run(STREAM, 'more', first.picks)
    for (const c of again.picks) {
      for (const f of first.picks)
        expect(Math.min(c.endSec, f.endSec) - Math.max(c.startSec, f.startSec)).toBeLessThanOrEqual(0)
    }
  })

  it('takes seconds, not minutes, on a two-hour stream', () => {
    // The 69-minute stream twice over: the transcript is kept, so this is all of finding.
    const facts = factsOf(STREAM)
    const words = [
      ...facts.words,
      ...facts.words.map((w) => ({
        ...w,
        startSec: w.startSec + facts.durationSec,
        endSec: w.endSec + facts.durationSec
      }))
    ]
    const long = { ...facts, durationSec: facts.durationSec * 2, words, sounds: [], frozen: [], loudness: undefined }
    const t0 = performance.now()
    const plan = planRecording(long, ask, null)
    const picks = measureRecording(long, plan, ask)
    const ms = performance.now() - t0
    expect(long.durationSec).toBeGreaterThan(7200)
    expect(picks.length).toBeGreaterThan(0)
    expect(ms).toBeLessThan(3000)
  })
})

describe('reading what is asked', () => {
  it('reads counts, lengths, kinds of moment and kinds of recording', () => {
    expect(readClipAsk('10')).toMatchObject({ count: 10, length: null })
    expect(readClipAsk('60 second clips')).toMatchObject({ count: null, length: { minSec: 40, maxSec: 60 } })
    expect(readClipAsk('ten clips under 30 seconds')).toMatchObject({ count: 10, length: { minSec: 12, maxSec: 30 } })
    expect(readClipAsk('about a minute each').length).toEqual({ minSec: 48, maxSec: 72 })
    expect(readClipAsk('30-45 seconds').length).toEqual({ minSec: 30, maxSec: 45 })
    expect(readClipAsk('the funny parts')).toMatchObject({ funny: true, topic: null })
    expect(readClipAsk('the part about forgiveness')).toMatchObject({ topic: 'forgiveness', single: true, count: null })
    expect(readClipAsk('3 clips about faith')).toMatchObject({ topic: 'faith', single: false, count: 3 })
    expect(readClipAsk('this stream').profile).toBe('livestream')
    expect(readClipAsk('the sermon').profile).toBe('church')
    // "as" is not "a second", and the recording is not a topic.
    expect(readClipAsk('clips of this stream as shorts')).toMatchObject({ length: null, topic: null })
  })

  it('hears a request for clips without the command, and nothing else', () => {
    for (const t of [
      'find clips',
      'Find the best moments',
      'clip this stream',
      'make 5 clips from this',
      'turn this into clips'
    ]) {
      expect(clippingAsked(t), t).not.toBeNull()
    }
    for (const t of [
      'make the intro shorter',
      'add this clip as b-roll',
      'cut the clip at 0:20',
      '/clipping',
      'clip it at the end'
    ]) {
      expect(clippingAsked(t), t).toBeNull()
    }
    expect(clippingAsked('clip this stream, the funny parts')).toMatchObject({ funny: true, profile: 'livestream' })
  })
})

describe('holding picked moments to the rules', () => {
  const facts = factsOf(SERVICE)
  const plan = planRecording(facts, ask, null)
  const ctx = { words: facts.words, sentences: plan.sentences, regions: plan.regions, bounds: plan.bounds }

  it('moves a sloppy pick onto words, and back inside its bounds', () => {
    const story = momentSpan(facts.timeline, SERVICE.moments[0])
    const fit = fitPick({ startSec: story.startSec - 4.2, endSec: story.endSec + 30 }, ctx)
    expect(fit).not.toBeNull()
    expect(facts.words.some((w) => w.startSec === fit!.startSec)).toBe(true)
    expect(facts.words.some((w) => w.endSec === fit!.endSec)).toBe(true)
    expect(fit!.endSec - fit!.startSec).toBeLessThanOrEqual(60)
  })

  it('never reaches into what was left out, and drops what lies inside it', () => {
    const worship = plan.regions.find((r) => r.kind === 'worship')!
    expect(fitPick({ startSec: worship.startSec + 10, endSec: worship.startSec + 50 }, ctx)).toBeNull()
    // Half in the announcements: only the part outside them is kept, or nothing.
    const notices = plan.regions.find((r) => r.kind === 'announcements')!
    const fit = fitPick({ startSec: notices.startSec + 5, endSec: notices.endSec + 80 }, ctx)
    if (fit) expect(overlapWith(plan.regions, fit.startSec, fit.endSec)).toBe(0)
  })

  it('keeps the better of two picks that overlap, and none that repeats a clip in the set', () => {
    const s = momentSpan(facts.timeline, SERVICE.moments[1])
    const a = { startSec: s.startSec, endSec: s.endSec, title: 'A', hook: '', reason: '', score: 90 }
    const b = { ...a, startSec: s.startSec + 5, title: 'B', score: 60 }
    expect(shapePicks([b, a], ctx).map((x) => x.title)).toEqual(['A'])
    expect(shapePicks([a], { ...ctx, avoid: [{ startSec: s.startSec, endSec: s.endSec }] })).toEqual([])
  })
})

describe('a clip as an edit', () => {
  const source = { path: '/service.mp4', durationSec: 1400, width: 1920, height: 1080, fps: 30, audio: null }

  it('is the moment as it was said, then a finished short, so Undo goes back', () => {
    const facts = factsOf(SERVICE)
    const span = momentSpan(facts.timeline, SERVICE.moments[0])
    const words = facts.words.filter((w) => w.startSec >= span.startSec && w.endSec <= span.endSec)
    const doc = clipDoc({ id: 'c', title: 'What grace looks like', source, words, profile: CLIP_PROFILES.church })
    expect(doc.versions).toHaveLength(2)
    expect(doc.versions[0].summary).toBe('The moment as it was said, split into beats.')
    const cut = currentCut(doc)
    expect(cut.aspect).toBe('vertical')
    expect(cut.captions).toMatchObject({ on: true, wordsPerScreen: 2, position: 'chest' })
    expect(cut.tighten).toEqual({ maxGapSec: 1.5, padSec: 0.2, fillers: false })
    expect(currentVersion(doc).summary).toMatch(/^A finished short\. It's vertical now/)
    expect(undoTarget(doc)).toBe(1)
    expect(doc.profile).toBe('church')
    expect(doc.words.map((w) => w.text).join(' ')).toMatch(/^In the winter.*grace looks like\.$/)
  })

  it('keeps the pauses in a prayer, which a podcast would cut', () => {
    const facts = factsOf(SERVICE)
    const prayer = facts.timeline.words.filter((w) => w.tag === 'prayer')
    const pauses = (profile: (typeof CLIP_PROFILES)[keyof typeof CLIP_PROFILES]): number[] => {
      const doc = clipDoc({ id: 'p', title: 'Prayer', source, words: prayer, profile })
      const r = resolveCut(currentCut(doc), doc.words, doc.sources)
      return r.words.slice(1).map((w, i) => w.outStart - r.words[i].outEnd)
    }
    const planted = prayer
      .slice(1)
      .map((w, i) => w.startSec - prayer[i].endSec)
      .filter((g) => g > 1)
    expect(planted.length).toBeGreaterThanOrEqual(5)
    // Every pause of the prayer plays whole in a service's clip...
    expect(pauses(CLIP_PROFILES.church).filter((g) => g > 1.2).length).toBe(planted.length)
    // ...and a podcast's tightening would take them down to the words.
    expect(Math.max(...pauses(CLIP_PROFILES.podcast))).toBeLessThan(0.7)
  })

  it('keeps a podcast’s laughter, in the middle of a clip and at its end', () => {
    const facts = factsOf(PODCAST)
    const span = momentSpan(facts.timeline, PODCAST.moments[0])
    const words = facts.words.filter((w) => w.startSec >= span.startSec && w.endSec <= span.endSec)
    const laughter = facts.timeline.laughter
    const doc = clipDoc({ id: 'q', title: 'Q', source, words, profile: CLIP_PROFILES.podcast, laughter })
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    const laugh = laughter.find((l) => l.startSec > span.startSec && l.endSec < span.endSec)!
    // The source plays straight through the laugh: no piece boundary inside it.
    const through = r.pieces.some((p) => p.srcStart <= laugh.startSec + 0.01 && p.srcEnd >= laugh.endSec - 0.01)
    const seamless = r.pieces.every(
      (p, i) =>
        i === 0 ||
        Math.abs(p.srcStart - r.pieces[i - 1].srcEnd) < 0.01 ||
        p.srcStart > laugh.endSec ||
        r.pieces[i - 1].srcEnd < laugh.startSec
    )
    expect(through || seamless).toBe(true)
    const played = r.pieces.reduce(
      (n, p) => n + Math.max(0, Math.min(p.srcEnd, laugh.endSec) - Math.max(p.srcStart, laugh.startSec)),
      0
    )
    expect(played).toBeGreaterThan(laugh.endSec - laugh.startSec - 0.05)
  })

  it('follows the speaker when the recording knows where they are', () => {
    const facts = factsOf(STREAM)
    const span = momentSpan(facts.timeline, STREAM.moments[0])
    const words = facts.words.filter((w) => w.startSec >= span.startSec && w.endSec <= span.endSec)
    const subject = { hz: 2, from: span.startSec, x: [0.3, 0.3, 0.31] }
    const doc = clipDoc({
      id: 's',
      title: 'S',
      source: { ...source, subject },
      words,
      profile: CLIP_PROFILES.livestream,
      reframe: true
    })
    expect(currentCut(doc).reframe).toBe(true)
    expect(currentCut(doc).tighten).toBeNull()
  })
})

describe('what /clipping says', () => {
  const base: ClipsFound = { by: 'measured', model: null, recordings: [], clips: [], notes: [], timings: [], had: 0 }
  const rec = (path: string, extra = {}) => ({
    path,
    durationSec: 1320,
    profile: 'church' as const,
    left: [],
    words: 2400,
    ...extra
  })

  it('says how many clips there are, in a sentence, and how they were picked', () => {
    const facts = factsOf(SERVICE)
    const plan = planRecording(facts, ask, null)
    const picks = measureRecording(facts, plan, ask)
    const found: ClipsFound = {
      ...base,
      recordings: [rec('/s/service.mp4', { left: plan.regions })],
      clips: picks.map((p) => ({ ...p, source: '/s/service.mp4', doc: null as never }))
    }
    const reply = clipsReply(found, false)
    expect(reply.text).toBe('I found three clips in the service.')
    expect(reply.aside).toMatch(/^I left out the worship set, the announcements, the giving appeal and the goodbye\./)
    expect(reply.aside).toMatch(/sorted them by measuring/)
    expect(reply.chips).toHaveLength(3)
    expect(reply.chips[0]).toMatch(/^Sermon, 0:\d\d to 0:\d\d$/)
    expect(reply.details.map((d) => d.label)).toEqual(['Transcript', 'Left out', 'Picked by'])
    expect(reply.text + reply.aside).not.toMatch(/!/)
  })

  it('says when a recording is too short to clip, or has nobody talking in it', () => {
    expect(clipsReply({ ...base, recordings: [rec('/s/a.mp4', { durationSec: 48, none: 'short' })] }, false).text).toBe(
      "a.mp4 runs 0:48, too short to cut clips from: a clip runs 0:30 to 1:00, so it would be nearly the whole thing. Drop it without /clipping and I'll edit it as it is."
    )
    expect(clipsReply({ ...base, recordings: [rec('/s/b.mp4', { none: 'speechless' })] }, false).text).toBe(
      'I heard nobody talking in b.mp4, so there is nothing to clip: clips are cut on what is said.'
    )
  })

  it('counts two recordings apart', () => {
    const clip = (source: string) => ({
      source,
      startSec: 0,
      endSec: 40,
      title: 't',
      hook: 'h',
      reason: 'r',
      score: 50,
      doc: null as never
    })
    const found: ClipsFound = {
      ...base,
      recordings: [rec('/s/part one.mp4'), rec('/s/part two.mp4')],
      clips: [clip('/s/part one.mp4'), clip('/s/part one.mp4'), clip('/s/part two.mp4')]
    }
    expect(clipsReply(found, true).text).toBe('I found three clips: 2 in part one.mp4 and 1 in part two.mp4.')
    expect(clipsReply(found, true).chips).toContain('Captions in your brand')
    expect(clipsReply({ ...found, had: 4 }, true).text).toMatch(/^I found three more clips/)
  })
})
