import { describe, expect, it } from 'vitest'
import { currentCut, currentVersion, resolveCut, undoTarget } from '../edit'
import { PLANTED, PODCAST, SERVICE, STREAM, type Planted } from './fixtures'
import { factsOf, momentSpan } from './testing'
import { readClipAsk } from './ask'
import { measureRecording, planRecording } from './plan'
import { fitPick, shapePicks } from './shape'
import { clipDoc } from './doc'
import { CLIP_PROFILES } from './profile'
import { clipsReply, recordingNames, type ClipsFound } from './reply'
import { leaveOut, overlapWith } from './leave-out'
import { sentencesOf } from './sentences'

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

  it('leaves out a short closing song wherever it falls against the half-minute windows', () => {
    const t = factsOf(SERVICE).timeline
    // Sung at the pace the generated service sang it, 83 s rather than the
    // 109 s the plan estimates: short enough to slip between the windows.
    const song = t.words.filter((w) => w.tag === 'worship-2')
    const a = song[0].startSec
    const b = song[song.length - 1].endSec
    const squeeze = (x: number): number => (x <= a ? x : x >= b ? x - (b - a) * 0.24 : a + (x - a) * 0.76)
    for (let shift = 0; shift < 30; shift += 5) {
      const words = t.words.map((w) => ({
        text: w.text,
        startSec: squeeze(w.startSec) + shift,
        endSec: squeeze(w.endSec) + shift
      }))
      const regions = leaveOut({
        words,
        sentences: sentencesOf(words),
        durationSec: t.durationSec + shift,
        profile: 'church'
      })
      const worship = regions.filter((r) => r.kind === 'worship')
      const sung = words.filter((_, i) => t.words[i].tag === 'worship-2')
      expect(
        sung.every((w) => overlapWith(worship, w.startSec, w.endSec) > 0),
        `${shift} s later`
      ).toBe(true)
      // The prayer before it is not the song: at most its amen, where the windows begin.
      const around = worship.filter((r) => r.endSec > sung[0].startSec && r.startSec < sung[sung.length - 1].endSec)
      expect(around.length).toBe(1)
      expect(around[0].startSec, `${shift} s later`).toBeGreaterThan(sung[0].startSec - 10)
    }
  })

  it('finds the worship set when the transcript wrote each line down only once or twice, as Whisper does', () => {
    // Whisper on the generated service wrote most choruses down once or
    // twice and left out the rest of their repeats, half a minute at a time.
    const t = factsOf(SERVICE).timeline
    const kept: typeof t.words = []
    let line: typeof t.words = []
    let last = ''
    let seen = 0
    const flush = (): void => {
      const text = line.map((w) => w.text).join(' ')
      seen = text === last ? seen + 1 : 1
      last = text
      if (seen <= 2) kept.push(...line)
      line = []
    }
    for (const [i, w] of t.words.entries()) {
      if (!w.tag?.startsWith('worship')) {
        if (line.length) flush()
        kept.push(w)
        continue
      }
      const prev = t.words[i - 1]
      if (line.length && prev && w.startSec - prev.endSec > 0.5) flush()
      line.push(w)
    }
    if (line.length) flush()
    const sung = (tag: string) => kept.filter((w) => w.tag === tag)
    expect(sung('worship').length).toBeLessThan(t.words.filter((w) => w.tag === 'worship').length * 0.6)
    // Named the way nothing in its name gives away what it is.
    const facts = {
      ...factsOf(SERVICE, '/rec/0412.mp4'),
      words: kept.map(({ text, startSec, endSec }) => ({ text, startSec, endSec }))
    }
    const plan = planRecording(facts, ask, null)
    expect(plan.profile.id).toBe('church')
    const worship = plan.regions.filter((r) => r.kind === 'worship')
    for (const tag of ['worship', 'worship-2'])
      expect(
        sung(tag).every((w) => overlapWith(worship, w.startSec, w.endSec) > 0),
        tag
      ).toBe(true)
    for (const m of SERVICE.moments) {
      const span = momentSpan(t, m)
      expect(overlapWith(plan.regions, span.startSec, span.endSec), m.tag).toBe(0)
    }
  })

  it('tells a service, a podcast and a stream apart by what is in them, whatever the files are called', () => {
    for (const p of PLANTED) {
      const facts = factsOf(p, '/rec/0412.mp4')
      expect(planRecording(facts, ask, null).profile.id, p.kind).toBe(p.kind)
    }
    // And by the name, when that is all there is to go on.
    const talk = factsOf(PODCAST, '/rec/Sunday_service-2026.mp4')
    expect(planRecording({ ...talk, words: talk.words.slice(0, 400) }, ask, null).profile.id).toBe('church')
  })

  it('does not take a preacher’s refrain, or a run of lines that start alike, for a song', () => {
    // Most of every line is the same seven words, and the refrain comes back
    // every other line: as repeated as speech gets, still new words each time.
    const lines: string[] = []
    const tails = [
      'carrying your father’s voice.',
      'with a speech ready.',
      'sure the door is locked.',
      'still sitting in the car.',
      'counting what you owe.',
      'tired of starting over.',
      'hoping nobody would notice.',
      'with forty dollars left.',
      'angry at the porch light.',
      'pretending you are fine.',
      'afraid of the table.',
      'rehearsing your sorry speech.'
    ]
    tails.forEach((tail, i) => {
      lines.push(`Some of you walked in here today ${tail}`)
      if (i % 2 === 1) lines.push('God is not finished with you.')
    })
    const words: { text: string; startSec: number; endSec: number }[] = []
    let at = 600
    for (const line of lines) {
      for (const w of line.split(' ')) {
        words.push({ text: w, startSec: at, endSec: at + 0.3 })
        at += 0.36
      }
      at += 0.6
    }
    expect(at - 600).toBeGreaterThan(60)
    const regions = leaveOut({ words, sentences: sentencesOf(words), durationSec: at + 60, profile: 'church' })
    expect(regions.filter((r) => r.kind === 'worship')).toEqual([])
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
    const first = run(SERVICE)
    const again = run(SERVICE, '2 more', first.picks)
    expect(again.picks.length).toBeGreaterThan(0)
    expect(again.picks.length).toBeLessThanOrEqual(2)
    for (const c of again.picks) {
      for (const f of first.picks)
        expect(Math.min(c.endSec, f.endSec) - Math.max(c.startSec, f.startSec)).toBeLessThanOrEqual(0)
      // Never opened on a run-up such as the reading's announcement.
      expect(c.hook).not.toMatch(/^(?:Our reading|Good morning)/)
    }
  })

  it('asked again, offers only what measures up to the clips already found, not talk to pad the set', () => {
    for (const p of [PODCAST, STREAM]) {
      const first = run(p)
      // Every planted moment was found the first time; what is left is the talk around them.
      expect(first.picks.length, p.kind).toBeGreaterThanOrEqual(p.moments.length)
      expect(run(p, 'more', first.picks).picks, p.kind).toEqual([])
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
})

describe('a clip on whole sentences', () => {
  // Sentences of a sermon, each word 0.3 s with a 0.1 s gap, and 0.5 s between sentences.
  const lines = [
    'And if you think it is about rules then you are wrong.',
    'But if you will study religion religion kills people.',
    'God saves people and religion never points you to God.',
    'Religion points you to religion and that is all it does.',
    'I do not want what you believe at all.',
    'I want what the word of God says about me.',
    'I represent heaven.',
    'I am a diplomat in this earth and I speak for him.'
  ]
  const words: { text: string; startSec: number; endSec: number }[] = []
  let t = 0
  for (const line of lines) {
    for (const w of line.split(' ')) {
      words.push({ text: w, startSec: t, endSec: t + 0.3 })
      t += 0.4
    }
    t += 0.5
  }
  const sentences = sentencesOf(words)
  const ctx = { words, sentences, regions: [], bounds: { minSec: 10, maxSec: 24 } }
  const at = (text: string, from = 0): number => words.findIndex((w, i) => i >= from && w.text === text)

  it('drops the tail of the last thought it would open on, and the first word of the next it would stop on', () => {
    // Picked from "you are wrong." to "…heaven. I", as Claude picked the Athens clip.
    const fit = fitPick({ startSec: words[at('you', 5)].startSec, endSec: words[at('I', at('heaven.'))].endSec }, ctx)!
    expect(fit.startSec).toBe(words[at('But')].startSec)
    expect(fit.endSec).toBe(words[at('heaven.')].endSec)
  })

  it('says which words, so a sentence squeezed onto one instant is cut after its last word', () => {
    // Whisper put "heaven." and the next sentence's "I" on one instant, as it did at the end of an Athens clip.
    const squeezed = words.map((x) => ({ ...x }))
    const heaven = squeezed.findIndex((x) => x.text === 'heaven.')
    squeezed[heaven + 1] = { ...squeezed[heaven + 1], startSec: squeezed[heaven].endSec, endSec: squeezed[heaven].endSec }
    const fit = fitPick(
      { startSec: squeezed[at('But')].startSec, endSec: squeezed[heaven].endSec },
      { ...ctx, words: squeezed, sentences: sentencesOf(squeezed), bounds: { minSec: 10, maxSec: 30 } }
    )!
    expect(squeezed[fit.toWord].text).toBe('heaven.')
    // By time alone, the squeezed "I" would have come in with it.
    const byTime = squeezed.filter((w) => w.startSec >= fit.startSec - 0.01 && w.endSec <= fit.endSec + 0.01)
    expect(byTime[byTime.length - 1].text).toBe('I')
    expect(squeezed.slice(fit.fromWord, fit.toWord + 1).at(-1)!.text).toBe('heaven.')
  })

  it('finishes the sentence it would stop in the middle of, when the length allows', () => {
    const end = at('word')
    const fit = fitPick({ startSec: words[at('But')].startSec, endSec: words[end].endSec }, ctx)!
    expect(fit.endSec).toBe(words[at('me.')].endSec)
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
    expect(fit!.endSec - fit!.startSec).toBeLessThanOrEqual(CLIP_PROFILES.church.maxSec)
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
    // The first clip of a set takes the first look: a square on black, three words at a time beneath it.
    expect(cut.captions).toMatchObject({ on: true, preset: 'sermon-box', wordsPerScreen: 3, position: 'bottom' })
    expect(cut.box).toEqual({ aspect: 1, top: 0.19 })
    // Chest-up from the top of the picture, past a stream's scripture banner, and graded low-key and muted.
    expect(cut.beats.every((b) => b.treatment.zoom === 1.43 && b.treatment.zoomAt === 0)).toBe(true)
    expect(cut.look).toMatchObject({ exposure: -0.5, saturation: -0.45 })
    // The next takes the next: full frame, the line landed big; then the quiet captions under a hook card.
    const second = currentCut(clipDoc({ id: 'c2', title: 'Grace', source, words, profile: CLIP_PROFILES.church, variant: 1 }))
    expect(second.captions.preset).toBe('sermon')
    expect(second.box).toBeUndefined()
    const third = currentCut(
      clipDoc({ id: 'c3', title: 'Grace', source, words, profile: CLIP_PROFILES.church, variant: 2, hook: 'Grace Found Her' })
    )
    expect(third.captions.preset).toBe('sermon-quiet')
    // Then one word at a time on a cold picture, a red line on black and white, and a 4:5 picture with the
    // sentence building: no two of the six alike in picture, captions or frame.
    const turn = (variant: number): ReturnType<typeof currentCut> =>
      currentCut(clipDoc({ id: `t${variant}`, title: 'Grace', source, words, profile: CLIP_PROFILES.church, variant }))
    expect(turn(3).captions.preset).toBe('sermon-word')
    expect(turn(3).look?.temperature).toBeLessThan(0)
    expect(turn(4).captions.preset).toBe('sermon-red')
    expect(turn(4).look?.saturation).toBe(-1)
    expect(turn(5).box).toEqual({ aspect: 0.8, top: 0.148 })
    expect(turn(6).captions.preset).toBe('sermon-box')
    const grades = [0, 1, 2, 3, 4, 5].map((v) => JSON.stringify(turn(v).look))
    expect(new Set(grades).size).toBe(6)
    expect(third.motion.map((m) => [m.kind, m.style, m.to, m.text[0]])).toEqual([['banner', 'card', '4s', 'Grace Found Her']])
    expect(cut.tighten).toEqual({ maxGapSec: 0.4, padSec: 0.1, fillers: false })
    expect(currentVersion(doc).summary).toMatch(/^A finished short\. It's vertical now/)
    expect(undoTarget(doc)).toBe(1)
    expect(doc.profile).toBe('church')
    expect(doc.words.map((w) => w.text).join(' ')).toMatch(/^In the winter.*grace looks like\.$/)
  })

  it('sets the words the speaker leans on in the accent, by id', () => {
    const words = [
      { text: 'More', startSec: 1, endSec: 1.3, key: true },
      { text: 'than', startSec: 1.4, endSec: 1.6, key: true },
      { text: 'enough.', startSec: 1.7, endSec: 2.2 }
    ]
    const doc = clipDoc({ id: 'k', title: 'Enough', source, words, profile: CLIP_PROFILES.church })
    expect(currentCut(doc).captions.keys).toEqual(['w1', 'w2'])
    const plain = clipDoc({ id: 'n', title: 'Enough', source, words: words.map(({ key: _k, ...w }) => w), profile: CLIP_PROFILES.church })
    expect(currentCut(plain).captions.keys).toBeUndefined()
  })

  it('cuts the pauses down to the words, as the most-watched sermon clips do', () => {
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
    // Silences over a quarter-second are cut in nearly every popular sermon clip (docs/research/sermon-clips.md),
    // so a service's clip takes even a prayer's pauses down to the words, as a podcast's does.
    expect(Math.max(...pauses(CLIP_PROFILES.church))).toBeLessThan(0.7)
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
    expect(reply.chips[0]).toMatch(/^Sermon, 0:\d\d to 0:\d\d each$/)
    expect(reply.details.map((d) => d.label)).toEqual(['Transcript', 'Left out', 'Picked by'])
    expect(reply.text + reply.aside).not.toMatch(/!/)
  })

  it('says measuring picked them when a model could not, and never that the model did', () => {
    const facts = factsOf(SERVICE)
    const plan = planRecording(facts, ask, null)
    const picks = measureRecording(facts, plan, ask)
    const fell: ClipsFound = {
      ...base,
      fellBack: true,
      notes: ["llama3.1:8b couldn't pick them (it returned no clips), so I sorted them by measuring."],
      recordings: [rec('/s/service.mp4', { left: plan.regions })],
      clips: picks.map((p) => ({ ...p, source: '/s/service.mp4', doc: null as never }))
    }
    const aside = clipsReply(fell, false).aside ?? ''
    expect(aside).toMatch(/so I sorted them by measuring\.$/)
    expect(aside).not.toMatch(/picked them/)
    expect(clipsReply(fell, false).details).toContainEqual({ label: 'Picked by', value: 'Measuring' })
  })

  it('says when a recording is too short to clip, or has nobody talking in it', () => {
    expect(clipsReply({ ...base, recordings: [rec('/s/a.mp4', { durationSec: 48, none: 'short' })] }, false).text).toBe(
      "a.mp4 runs 0:48, too short to cut clips from: a clip runs 0:30 to 1:30, so it would be nearly the whole thing. Drop it without /clipping and I'll edit it as it is."
    )
    expect(clipsReply({ ...base, recordings: [rec('/s/b.mp4', { none: 'speechless' })] }, false).text).toBe(
      'I heard nobody talking in b.mp4, so there is nothing to clip: clips are cut on what is said.'
    )
  })

  it('says why many short recordings give no clips in one sentence, not one each', () => {
    // A vlog's clips, asked for clips: fifty files under two minutes.
    const many = Array.from({ length: 50 }, (_, i) => rec(`/s/IMG_${1000 + i}.MOV`, { durationSec: 9, none: 'short' }))
    expect(clipsReply({ ...base, recordings: many }, false).text).toBe(
      "IMG_1000.MOV, IMG_1001.MOV, IMG_1002.MOV and 47 more each run under 2:00, too short to cut clips from. Drop them without /clipping and I'll edit them as they are."
    )
    const mixed = [
      rec('/s/a.mp4', { durationSec: 48, none: 'short' }),
      rec('/s/b.mp4', { durationSec: 30, none: 'short' }),
      rec('/s/c.mp4', { none: 'speechless' })
    ]
    expect(clipsReply({ ...base, recordings: mixed }, false).text).toBe(
      "a.mp4 and b.mp4 each run under 2:00, too short to cut clips from. Drop them without /clipping and I'll edit them as they are. I heard nobody talking in c.mp4, so there is nothing to clip: clips are cut on what is said."
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
    expect(clipsReply(found, true).chips).toEqual(['Sermon, 0:40 each', 'Vertical 9:16', 'Captions in your brand'])
    const mixed = { ...found, recordings: [rec('/s/part one.mp4'), rec('/s/part two.mp4', { profile: 'podcast' })] }
    expect(clipsReply(mixed, false).chips[0]).toBe('Sermon and podcast, 0:40 each')
    expect(clipsReply({ ...found, had: 4 }, true).text).toMatch(/^I found three more clips/)
  })

  it('tells two recordings with the same name apart, by their folders', () => {
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
    // Two weeks' services, each saved under the same name in its own folder.
    const a = '/Users/me/Services/Week 1/Sunday service.mp4'
    const b = '/Users/me/Services/Week 2/Sunday service.mp4'
    const found: ClipsFound = {
      ...base,
      recordings: [rec(a), rec(b)],
      clips: [clip(a), clip(a), clip(b), clip(b)]
    }
    const reply = clipsReply(found, false)
    expect(reply.text).toBe(
      'I found four clips: 2 in Week 1/Sunday service.mp4 and 2 in Week 2/Sunday service.mp4.'
    )
    expect(reply.details.map((d) => d.label)).toEqual([
      'Week 1/Sunday service.mp4',
      'Week 2/Sunday service.mp4',
      'Picked by'
    ])
    const short = clipsReply(
      { ...base, recordings: [rec(a, { durationSec: 50, none: 'short' }), rec(b, { durationSec: 40, none: 'short' })] },
      false
    )
    expect(short.text).toMatch(/^Week 1\/Sunday service\.mp4 and Week 2\/Sunday service\.mp4 each run under 2:00/)
    const one = clipsReply({ ...base, recordings: [rec(a), rec(b, { none: 'speechless' })], clips: [clip(a)] }, false)
    expect(one.text).toBe(
      'I found one clip in Week 1/Sunday service.mp4. I heard nobody talking in Week 2/Sunday service.mp4, so there is nothing to clip: clips are cut on what is said.'
    )
    // Names that differ already stay as they are.
    expect(recordingNames(['/a/x.mp4', '/b/y.mp4', '/c/d/y.mp4', '/c/e/y.mp4'])).toEqual(
      new Map([
        ['/a/x.mp4', 'x.mp4'],
        ['/b/y.mp4', 'b/y.mp4'],
        ['/c/d/y.mp4', 'd/y.mp4'],
        ['/c/e/y.mp4', 'e/y.mp4']
      ])
    )
  })
})
