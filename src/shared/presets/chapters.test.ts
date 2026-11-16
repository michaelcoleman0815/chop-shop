import { describe, expect, it } from 'vitest'
import {
  applyOps,
  chaptersMetadata,
  chaptersText,
  commit,
  createDoc,
  currentCut,
  CutSchema,
  placeChapters,
  resolveCut,
  stamp,
  titleFrom,
  wordsFromTranscript,
  type EditDoc
} from '../edit'
import { chaptersCommand, chaptersOf, chaptersReply, describePlan, planChapters } from '.'

/**
 * A talk of six parts, four sentences each: a longer pause before each part,
 * and each part opening on what it is about after a word that only leads in.
 */
const PARTS = [
  'So the battery lasts two whole days.',
  'Okay, the camera is the real upgrade.',
  'Now the screen is brighter outside.',
  'Right, the price went up again.',
  'And charging takes forty minutes now.',
  'Overall I would buy this phone.'
]
function talk(): EditDoc {
  const said: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  PARTS.forEach((opening, p) => {
    const sentences = [opening, 'It is worth saying twice.', 'Here is how it holds up.', 'That is the short version.']
    sentences.forEach((sentence, s) => {
      for (const w of sentence.split(' ')) {
        said.push({ text: w, startSec: t, endSec: t + 0.35 })
        t += 0.45
      }
      // A breath between sentences, a longer pause between parts.
      t += s === sentences.length - 1 && p < PARTS.length - 1 ? 1.4 : 0.35
    })
  })
  return createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/a.mov', durationSec: Math.ceil(t) + 1, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(said, 's1')
  })
}

describe('chapters', () => {
  it('writes running times the way YouTube reads them', () => {
    expect(stamp(0)).toBe('0:00')
    expect(stamp(9.99)).toBe('0:09')
    expect(stamp(65)).toBe('1:05')
    expect(stamp(3723.4)).toBe('1:02:03')
  })

  it('names a chapter from the words it opens with', () => {
    expect(titleFrom('So, the battery lasts two whole days. And more.'.split(' '))).toBe(
      'The battery lasts two whole days'
    )
    expect(titleFrom('Right, so here is the camera test, finally.'.split(' '))).toBe('Here is the camera test, finally')
    expect(titleFrom('Right now the price is lower.'.split(' '))).toBe('Right now the price is lower')
    expect(titleFrom(['Um,', 'okay.'])).toBe('Okay')
    // Cut short, a title ends at a comma, or before the words that lead on.
    expect(titleFrom('It sounds small, but it is the one that matters.'.split(' '))).toBe('It sounds small')
    expect(titleFrom('Most people never open the settings menu at all.'.split(' '))).toBe(
      'Most people never open the settings'
    )
    expect(titleFrom('This is the part where it gets good.'.split(' '))).toBe('This is the part')
  })

  it('keeps to YouTube’s rules: the first at 0:00, three at least, each ten seconds or more', () => {
    const starts = new Map([
      ['b1', 1.2],
      ['b2', 8],
      ['b3', 20],
      ['b4', 31],
      ['b5', 55]
    ])
    const titles = ['Intro', 'Too soon', 'Camera', 'Battery', 'Too late']
    const { chapters, problem } = placeChapters(
      titles.map((title, i) => ({ beat: `b${i + 1}`, title })),
      starts,
      60
    )
    expect(problem).toBeNull()
    expect(chaptersText(chapters)).toBe('0:00 Intro\n0:20 Camera\n0:31 Battery')
    // Too short a video, or too few left, says why in a sentence.
    expect(placeChapters([{ beat: 'b1', title: 'Intro' }], starts, 25).problem).toBe(
      'YouTube shows chapters only on videos of 30 seconds or more, and this one runs 0:25.'
    )
    expect(
      placeChapters(
        [
          { beat: 'b1', title: 'Intro' },
          { beat: 'b3', title: 'Camera' }
        ],
        starts,
        60
      ).problem
    ).toBe('YouTube needs at least 3 chapters of 10 seconds or more, and these make 2.')
  })

  it('plans a chapter where each part of the talk starts, named for what it is about', () => {
    const doc = talk()
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const planned = planChapters(doc)
    const placed = placeChapters(planned, new Map(resolved.beats.map((b) => [b.id, b.outStart])), resolved.durationSec)
    expect(placed.problem).toBeNull()
    expect(placed.chapters.map((c) => c.title)).toEqual([
      'The battery lasts two whole days',
      'The camera is the real upgrade',
      'The screen is brighter outside',
      'The price went up again',
      'Charging takes forty minutes now',
      'Overall I would buy this phone'
    ])
    // Each part's chapter starts on its first word.
    placed.chapters.slice(1).forEach((c, i) => {
      const first = resolved.words.find((w) => w.text === PARTS[i + 1].split(' ')[0] && w.beat === c.beat)
      expect(first, c.title).toBeDefined()
    })
  })

  it('reads /chapters, keeps chapters on their beats through a recut, and says what changed', () => {
    const doc = talk()
    const ctx = { words: doc.words, sources: doc.sources }
    const made = chaptersCommand(doc, '')
    expect('ops' in made).toBe(true)
    if (!('ops' in made)) return
    const v2 = commit(doc, made.ops, 'Chapters.').doc
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    const after = resolveCut(currentCut(v2), v2.words, v2.sources)
    expect(describePlan(made.ops, before, after, currentCut(v2))).toBe('The video has six chapters for YouTube.')
    // On its own again, it shows them rather than planning anew.
    expect(chaptersCommand(v2, '')).toEqual({ show: true })
    // Renaming the second.
    const renamed = chaptersCommand(v2, '2 Camera')
    if (!('ops' in renamed)) throw new Error('expected ops')
    const v3 = commit(v2, renamed.ops, 'Renamed.').doc
    const r3 = resolveCut(currentCut(v3), v3.words, v3.sources)
    expect(chaptersOf(currentCut(v3), r3).chapters[1].title).toBe('Camera')
    // Moving the camera part to the front: its chapter moves with it, and the first is still at 0:00.
    const cameraBeat = chaptersOf(currentCut(v3), r3).chapters[1].beat
    const moved = applyOps(currentCut(v3), [{ op: 'move', beat: cameraBeat, to: 0 }], ctx)
    const r4 = resolveCut(moved.cut, v3.words, v3.sources)
    const reply = chaptersReply(moved.cut, r4)
    expect(reply.lines.split('\n')[0]).toBe('0:00 Camera')
    expect(reply.shows).toBe(true)
    // Off, and the document still reads.
    const off = chaptersCommand(v3, 'off')
    if (!('ops' in off)) throw new Error('expected ops')
    const v4 = commit(v3, off.ops, 'Off.').doc
    expect(currentCut(v4).chapters).toBeUndefined()
    expect(CutSchema.parse(JSON.parse(JSON.stringify(currentCut(v3)))).chapters).toHaveLength(6)
  })

  it('refuses a chapter on a beat that is not there, in a sentence', () => {
    const doc = talk()
    const r = applyOps(currentCut(doc), [{ op: 'chapters', set: [{ beat: 'b99', title: 'Gone' }] }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected[0]?.reason).toBe('b99 is not a beat in this cut.')
  })

  it('says why when a video is too short for chapters', () => {
    const short = createDoc({
      id: 's',
      title: 't',
      source: { id: 's1', path: '/a.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript([{ text: 'Short.', startSec: 0.2, endSec: 0.8 }], 's1')
    })
    expect(chaptersCommand(short, '')).toEqual({
      say: 'YouTube shows chapters only on videos of 30 seconds or more, and this one runs 0:01.'
    })
  })

  it('carries the chapters into the video file as ffmpeg metadata', () => {
    const meta = chaptersMetadata(
      [
        { beat: 'b1', title: 'Intro', atSec: 0 },
        { beat: 'b3', title: 'Battery; and = more', atSec: 12.5 }
      ],
      30
    )
    expect(meta).toBe(
      ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=12500\ntitle=Intro\n' +
        '[CHAPTER]\nTIMEBASE=1/1000\nSTART=12500\nEND=30000\ntitle=Battery\\; and \\= more\n'
    )
  })
})
