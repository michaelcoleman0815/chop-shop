import { describe, expect, it } from 'vitest'
import { EMPTY_BRAND } from '../../../shared/brand'
import { CREW, CREW_ORDER, crewLearned, doneLine, liveLine, logCrew, memberFor, memberForNote } from './crew'

describe('the crew', () => {
  it('has six members, each named once', () => {
    expect(CREW_ORDER).toHaveLength(6)
    expect(new Set(CREW_ORDER.map((id) => CREW[id].name)).size).toBe(6)
    // Coral is the cut: Snip wears it and no one else does.
    expect(CREW_ORDER.filter((id) => CREW[id].colour === 'coral')).toEqual(['snip'])
  })

  it('gives each stage the app reports to the member whose job it is', () => {
    expect(memberFor('Transcribing take-3.mov')).toBe('echo')
    expect(memberFor('Listening for the cuts')).toBe('echo')
    expect(memberFor('Lining up your audio')).toBe('echo')
    expect(memberFor('Reading the footage')).toBe('snip')
    expect(memberFor('Cutting it to length')).toBe('snip')
    expect(memberFor('Writing the description')).toBe('quill')
    expect(memberFor('Bringing in desk-broll.mp4')).toBe('scout')
    expect(memberFor('Looking for B-roll')).toBe('scout')
    expect(memberFor('Finding what changes on screen')).toBe('tint')
    expect(memberFor('Exporting 2 of 6: The hook')).toBe('reel')
    expect(memberFor('Writing the Premiere project')).toBe('reel')
    expect(memberFor('Watching the speaker')).toBe('reel')
    // Thinking is Cutalong's own, and a stage no one owns brings no one in.
    expect(memberFor('Thinking')).toBeNull()
    expect(memberFor('Something new')).toBeNull()
  })

  it('lines the crew up as a job runs, each once, with what they did last', () => {
    let log = logCrew(undefined, 'Bringing in a.mov')
    log = logCrew(log, 'Thinking')
    log = logCrew(log, 'Transcribing a.mov')
    log = logCrew(log, 'Listening for the cuts')
    const same = logCrew(log, 'Listening for the cuts')
    expect(same).toBe(log)
    expect(log).toEqual([
      { id: 'scout', stage: 'Bringing in a.mov' },
      { id: 'echo', stage: 'Listening for the cuts' }
    ])
  })

  it('says what a member is doing and what they did', () => {
    expect(liveLine({ id: 'echo', stage: 'Transcribing take-3.mov' })).toBe('Echo is transcribing take-3.mov')
    expect(doneLine({ id: 'echo', stage: 'Transcribing take-3.mov' })).toBe('Echo transcribed take-3.mov')
    expect(doneLine({ id: 'reel', stage: 'Exporting 6 of 6: The hook' })).toBe('Reel exported 6 of 6')
    expect(doneLine({ id: 'scout', stage: 'Bringing it in' })).toBe('Scout brought it in')
  })

  it('hands a note to the member it is for', () => {
    expect(memberForNote('Make the hook word bigger')).toBe('quill')
    expect(memberForNote('make it wide again')).toBe('reel')
    expect(memberForNote('Music is too loud here')).toBe('echo')
    expect(memberForNote('Warmer colour on the kitchen shot')).toBe('tint')
    expect(memberForNote('Tighten the intro')).toBe('snip')
  })

  it('knows only what a brand has really learned', () => {
    const none = crewLearned(EMPTY_BRAND)
    expect(Object.values(none).flat()).toEqual([])
    const some = crewLearned({
      ...EMPTY_BRAND,
      style: { pace: { secondsPerShot: 2.1 }, loudness: { lufs: -14 }, aspect: 'vertical' },
      broll: { prefer: ['@nasa'], block: [] }
    } as never)
    expect(some.snip.join(' ')).toMatch(/per shot/)
    expect(some.echo).toEqual(['-14 LUFS'])
    expect(some.reel).toEqual(['Vertical 9:16'])
    expect(some.scout).toEqual(['Looks in @nasa first'])
  })
})
