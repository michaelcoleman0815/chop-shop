import { describe, expect, it } from 'vitest'
import {
  channelHabits,
  countFillers,
  describeHabits,
  endsSentence,
  formatOf,
  habitLines,
  isCallToAction,
  measureRun,
  type HeardWord,
  type VideoRun
} from './channel-habits'

/**
 * How a channel's videos run, from made-up videos only: every length, pace
 * and sentence here is invented for the test.
 */

/** Words said one after another at a steady pace, from a time. */
function say(text: string, fromSec: number, wordsPerMinute = 200): HeardWord[] {
  const each = 60 / wordsPerMinute
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ({ text: w, startSec: fromSec + i * each, endSec: fromSec + i * each + each * 0.8 }))
}

const SHORT_SCRIPT =
  'This lamp has one problem nobody talks about. It gets warm, um, really warm after an hour. ' +
  'I left it on all week to see how bad it gets. The base stays cool, so it is not dangerous, but the shade, like, ' +
  'gets hot to the touch. If that bothers you, the smaller one runs cooler. Follow for more.'

/** A made-up video's run, with only what a test cares about. */
function run(over: Partial<VideoRun> & { durationSec: number }): VideoRun {
  return {
    from: 'file',
    aspect: 'vertical',
    heard: 'whisper',
    unheard: null,
    words: 150,
    wordsPerMinute: 200,
    hook: { sec: 2.6, words: 9 },
    fillers: {},
    punctuated: true,
    ending: 'payoff',
    ...over
  }
}

describe('one video', () => {
  it('measures a Short heard word for word: its pace, its first sentence, its fillers and its end', () => {
    const words = say(SHORT_SCRIPT, 0.4)
    const r = measureRun({
      from: 'file',
      durationSec: words[words.length - 1].endSec + 0.5,
      aspect: 'vertical',
      heard: { by: 'whisper', stretches: [words] }
    })
    expect(formatOf(r)).toBe('short')
    expect(r.heard).toBe('whisper')
    expect(r.words).toBe(words.length)
    // The um is left out of the pace, so it reads the same as captions would.
    expect(r.wordsPerMinute).toBeGreaterThan(190)
    expect(r.wordsPerMinute).toBeLessThan(205)
    expect(r.hook).toEqual({ sec: expect.closeTo(2.34, 2), words: 8 })
    expect(r.fillers).toEqual({ um: 1, like: 1 })
    expect(r.punctuated).toBe(true)
    expect(r.ending).toBe('cta')
  })

  it('reads a long video from its opening and its end, and hears a payoff close', () => {
    const opening = say(SHORT_SCRIPT.replace(' Follow for more.', ''), 1)
    const end = say('And that is why I kept the bigger one. It is the better lamp.', 590)
    const r = measureRun({
      from: 'file',
      durationSec: 600,
      aspect: 'wide',
      heard: { by: 'whisper', stretches: [opening, end] }
    })
    expect(formatOf(r)).toBe('long')
    expect(r.ending).toBe('payoff')
    // Each stretch's pace, not the ten minutes between them.
    expect(r.wordsPerMinute).toBeGreaterThan(190)
  })

  it('keeps a quiet stretch from slowing the pace, and words misheard in it from speeding it up', () => {
    const forty = Array(40).fill('word').join(' ')
    const quiet = [...say(forty, 0), ...say(forty, 72)]
    const r = measureRun({ from: 'file', durationSec: 90, aspect: 'wide', heard: { by: 'whisper', stretches: [quiet] } })
    expect(r.wordsPerMinute).toBeGreaterThan(195)
    expect(r.wordsPerMinute).toBeLessThan(205)
    // Twenty-five words heard in two seconds of the quiet, as whisper can.
    const misheard = [...say(forty, 0), ...say(Array(25).fill('thanks').join(' '), 30, 750), ...say(forty, 72)]
    const m = measureRun({ from: 'file', durationSec: 90, aspect: 'wide', heard: { by: 'whisper', stretches: [misheard] } })
    expect(m.wordsPerMinute).toBeGreaterThan(195)
    expect(m.wordsPerMinute).toBeLessThan(205)
  })

  it('knows no end it did not hear, and no first sentence without full stops', () => {
    const captions = say('this lamp has one problem nobody talks about it gets warm really warm after an hour', 0.5)
    const r = measureRun({ from: 'link', durationSec: 300, aspect: null, heard: { by: 'captions', stretches: [captions] } })
    expect(r.punctuated).toBe(false)
    expect(r.hook).toBeNull()
    expect(r.ending).toBeNull()
    expect(r.fillers).toEqual({})
    const none = measureRun({ from: 'link', durationSec: 40, aspect: null, heard: { unheard: 'no-captions' } })
    expect(none).toMatchObject({ heard: null, unheard: 'no-captions', words: 0, wordsPerMinute: null, fillers: null })
  })

  it('leaves out music and applause as captions write them', () => {
    const words = [...say('[Music]', 0), ...say('Hello there. This is it.', 3), ...say('[Applause]', 5)]
    const r = measureRun({ from: 'link', durationSec: 6, aspect: 'vertical', heard: { by: 'captions', stretches: [words] } })
    expect(r.words).toBe(5)
    expect(r.hook?.words).toBe(2)
  })
})

describe('fillers, sentences and endings', () => {
  it('tells “like” the filler from like the word by its comma', () => {
    const said = 'I like this lamp. It is, like, bright. You know, it works. Do you know why? I mean, it is cheap.'.split(' ')
    expect(countFillers(said, true)).toEqual({ like: 1, 'you know': 1, 'i mean': 1 })
    expect(countFillers(['Um,', 'so', 'uh', 'it', 'is', 'like', 'this', 'erm', 'yeah'], false)).toEqual({ um: 2, uh: 1 })
  })

  it('ends a sentence at a full stop, a question or an exclamation, never at an abbreviation', () => {
    expect(endsSentence('done.')).toBe(true)
    expect(endsSentence('why?')).toBe(true)
    expect(endsSentence('wow!')).toBe(true)
    expect(endsSentence('“really.”')).toBe(true)
    expect(endsSentence('Mr.')).toBe(false)
    expect(endsSentence('U.S.')).toBe(false)
    expect(endsSentence('J.')).toBe(false)
    expect(endsSentence('word,')).toBe(false)
  })

  it('hears a call to action, and a goodbye as no call to action', () => {
    expect(isCallToAction('If this helped, subscribe for the next one.')).toBe(true)
    expect(isCallToAction('Let me know in the comments which one you’d keep.')).toBe(true)
    expect(isCallToAction('See you in the next one.')).toBe(true)
    expect(isCallToAction('The link is down below.')).toBe(true)
    expect(isCallToAction('Thanks for watching.')).toBe(false)
    expect(isCallToAction('And that is why the smaller one wins.')).toBe(false)
    expect(isCallToAction('You can turn off notifications in settings.')).toBe(false)
  })

  it('calls a video short by its length and shape, as YouTube does', () => {
    expect(formatOf({ durationSec: 59, aspect: 'wide' })).toBe('short')
    expect(formatOf({ durationSec: 95, aspect: 'vertical' })).toBe('short')
    expect(formatOf({ durationSec: 95, aspect: 'wide' })).toBe('long')
    expect(formatOf({ durationSec: 95, aspect: null })).toBe('long')
    expect(formatOf({ durationSec: 200, aspect: 'vertical' })).toBe('long')
  })
})

/** Three made-up Shorts and two made-up long videos, all heard word for word. */
const CHANNEL = [
  { run: run({ durationSec: 34, wordsPerMinute: 196, hook: { sec: 2.2, words: 8 }, fillers: { like: 3 } }) },
  { run: run({ durationSec: 38.4, wordsPerMinute: 204, hook: { sec: 2.6, words: 9 } }) },
  { run: run({ durationSec: 47, wordsPerMinute: 210, hook: { sec: 3.1, words: 10 }, ending: 'cta' }) },
  { run: run({ durationSec: 360, aspect: 'wide', words: 400, wordsPerMinute: 190, hook: { sec: 4.4, words: 14 }, ending: 'cta' }) },
  { run: run({ durationSec: 450, aspect: 'wide', words: 420, wordsPerMinute: 186, hook: { sec: 5, words: 16 }, ending: 'cta' }) }
]

describe('the channel’s habits', () => {
  it('learns each format’s usual length, the pace, the hook, the fillers and the ending', () => {
    const h = channelHabits(CHANNEL)!
    expect(h.shorts).toMatchObject({ videos: 3, minSec: 34, maxSec: 47, medianSec: 38.4, wordsPerMinute: 204 })
    expect(h.long).toMatchObject({ videos: 2, minSec: 360, maxSec: 450, medianSec: 405, endings: { cta: 2, payoff: 0 } })
    expect(h.fillers.hesitations).toBe('cut')
    expect(h.fillers.kept).toEqual(['like'])
    expect(h.from).toEqual({ files: 5, links: 0 })
    expect(h.missing).toEqual([])
  })

  it('tells the planner in a line or two', () => {
    expect(habitLines(CHANNEL)).toEqual([
      'Their Shorts usually run 34–47 s (about 38), at about 205 words a minute, with a one-sentence hook of about 3 s.',
      'Their long videos usually run 6:00–7:30 (about 6:45), at about 190 words a minute, with a one-sentence hook of about 5 s, and end on a call to action. They cut ums and uhs and keep “like”.'
    ])
    // A single Short has no range to give.
    expect(habitLines([CHANNEL[0]])).toEqual([
      'Their Shorts run about 34 s, at about 195 words a minute, with a one-sentence hook of about 2 s. They keep “like”.'
    ])
  })

  it('says nothing at all when nothing has been learned', () => {
    expect(habitLines([])).toEqual([])
    expect(channelHabits([])).toBeNull()
    expect(describeHabits([])).toBeNull()
  })

  it('says it on the Brand page as a sentence, three facts and the numbers behind them', () => {
    const said = describeHabits(CHANNEL)!
    expect(said.sentence).toBe(
      'Your Shorts usually run 34–47 s (about 38) and your long videos 6:00–7:30 (about 6:45), at about 195 words a minute, with a one-sentence hook of about 3 s. You cut ums and uhs and keep “like”, and your long videos end on a call to action.'
    )
    expect(said.facts).toEqual(['38 s per Short', '6:45 per long video', '195 words a minute'])
    expect(said.details).toEqual([
      { label: 'Shorts', value: '34.0 s to 47.0 s, 38.4 s in the middle (3 videos)' },
      { label: 'Long videos', value: '6:00 to 7:30, 6:45 in the middle (2 videos)' },
      { label: 'Words a minute', value: '196 (Shorts 204, long videos 188)' },
      { label: 'First sentence', value: '3.1 s, 10 words' },
      { label: 'Ums and uhs', value: 'Cut: 0 in 1,270 words' },
      { label: 'Other fillers', value: '“like” 3 times, in 1,270 words' },
      { label: 'Long videos end', value: 'On a call to action, 2 of 2' },
      { label: 'Learned from', value: '5 files' }
    ])
    expect(said.missing).toEqual([])
  })

  it('takes the middle of many videos as the usual range, so one odd video does not set it', () => {
    const many = [30, 32, 33, 35, 36, 38, 40, 41, 44, 170].map((d) => ({ run: run({ durationSec: d }) }))
    const h = channelHabits(many)!
    expect(h.shorts).toMatchObject({ videos: 10, minSec: 30, maxSec: 44, medianSec: 37 })
  })

  it('learns length and pace from videos learned before, and says what they cannot give', () => {
    const before = {
      facts: { durationSec: 42, aspect: 'vertical' as const, speech: { words: 140, wordsPerMinute: 212 } },
      run: undefined
    }
    expect(habitLines([before])).toEqual(['Their Shorts run about 42 s, at about 210 words a minute.'])
    const said = describeHabits([before])!
    expect(said.missing[0]).toBe(
      'I learned this video before I listened for hooks, fillers and endings. Add it again and I’ll learn those too.'
    )
  })

  it('says plainly what links could not give', () => {
    const captioned = run({
      from: 'link',
      aspect: null,
      durationSec: 41,
      heard: 'captions',
      words: 140,
      hook: null,
      punctuated: false,
      ending: null
    })
    const silent = run({
      from: 'link',
      aspect: null,
      durationSec: 55,
      heard: null,
      unheard: 'no-captions',
      words: 0,
      wordsPerMinute: null,
      hook: null,
      fillers: null,
      punctuated: false,
      ending: null
    })
    const said = describeHabits([{ run: captioned }, { run: silent }])!
    expect(said.sentence).toBe('Your Shorts usually run 41–55 s (about 48), at about 200 words a minute.')
    expect(said.missing).toEqual([
      'One link had no captions in English, so I only have its length.',
      'Captions leave out most ums and uhs, so I can’t tell whether you cut them until I hear one of your video files.',
      'Your captions have no full stops, so I couldn’t tell where your first sentence ends.',
      'I haven’t seen one of your long videos yet, so I don’t know how long they run or how they end.'
    ])
    expect(said.details.find((d) => d.label === 'Learned from')?.value).toBe('2 links')
    // The planner hears only what was learned.
    expect(habitLines([{ run: captioned }, { run: silent }])).toEqual([
      'Their Shorts usually run 41–55 s (about 48), at about 200 words a minute.'
    ])
  })

  it('says when a file gave no words, or there was no model to hear them', () => {
    const quiet = run({
      durationSec: 30,
      heard: null,
      unheard: 'no-sound',
      words: 0,
      wordsPerMinute: null,
      hook: null,
      fillers: null,
      punctuated: false,
      ending: null
    })
    const said = describeHabits([{ run: quiet }, { run: { ...quiet, unheard: 'no-model' } }])!
    expect(said.sentence).toBe('Your Shorts run about 30 s.')
    expect(said.missing.slice(0, 2)).toEqual([
      'I couldn’t listen to one video: the transcription model isn’t downloaded, so I only have its length. Download it in Settings and add it again.',
      'I heard no words in one of these, so I only have its length.'
    ])
  })

  it('keeps ums and uhs when they are heard, and says so', () => {
    const umms = CHANNEL.map((v) => ({ run: { ...v.run, fillers: { um: 4, uh: 2 } } }))
    expect(channelHabits(umms)!.fillers.hesitations).toBe('kept')
    expect(habitLines(umms)[1]).toMatch(/ They keep ums and uhs\.$/)
  })

  it('does not call ums cut from too few words', () => {
    const few = [{ run: run({ durationSec: 30, words: 90 }) }]
    expect(channelHabits(few)!.fillers.hesitations).toBe('unknown')
    expect(describeHabits(few)!.missing[0]).toBe(
      'I’ve heard 90 of your words so far, too few to tell whether you cut ums and uhs.'
    )
  })
})
