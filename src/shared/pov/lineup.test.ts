import { describe, expect, it } from 'vitest'
import { HOP, recording, sparseChat, voiceChat } from './test-session'
import { lineUpSession, loudestVoice, pairUp, sameSession, sliceEnvelope } from './lineup'

/**
 * Lining up a gaming session several players recorded, from synthetic
 * loudness: one voice chat shared by every recording, each recording's own
 * game noise over it, each started and stopped at its own time.
 */

const FRAME = 1 / 30

describe('lining up one session', () => {
  const chat = voiceChat(240, 7)

  it('lines every player’s recording up with yours within a frame, whatever time each started and stopped', () => {
    const home = recording(chat, 0, 200, 1, 6)
    const late = recording(chat, 31.47, 180, 2)
    const early = recording(chat, -12.83, 150, 3)
    const up = lineUpSession(
      [
        { path: 'home.mp4', env: home },
        { path: 'late.mp4', env: late },
        { path: 'early.mp4', env: early }
      ],
      'home.mp4'
    )
    expect(up.apart).toEqual([])
    const by = new Map(up.lined.map((l) => [l.path, l]))
    // Home's t is late's t - 31.47: it started 31.47 s into home.
    expect(Math.abs((by.get('late.mp4')?.offsetSec ?? 0) - -31.47)).toBeLessThan(FRAME)
    expect(Math.abs((by.get('early.mp4')?.offsetSec ?? 0) - 12.83)).toBeLessThan(FRAME)
    expect(by.get('late.mp4')?.via).toBeNull()
    expect(by.get('late.mp4')?.confidence).toBeGreaterThan(0.55)
  })

  it('says which one is not of this session', () => {
    const home = recording(chat, 0, 120, 1)
    const other = recording(voiceChat(240, 99), 0, 120, 4)
    const up = lineUpSession(
      [
        { path: 'home.mp4', env: home },
        { path: 'mine.mp4', env: recording(chat, 20, 90, 5) },
        { path: 'other.mp4', env: other }
      ],
      'home.mp4'
    )
    expect(up.lined.map((l) => l.path)).toEqual(['mine.mp4'])
    expect(up.apart).toEqual(['other.mp4'])
  })

  it('lines one up through another when it never overlaps yours', () => {
    // Each pair shares a minute: yours and the middle one, the middle one and the last.
    const chat = voiceChat(420, 7)
    const home = recording(chat, 0, 150, 1)
    const middle = recording(chat, 90, 210, 2)
    const after = recording(chat, 240, 170, 3)
    const up = lineUpSession(
      [
        { path: 'home.mp4', env: home },
        { path: 'middle.mp4', env: middle },
        { path: 'after.mp4', env: after }
      ],
      'home.mp4'
    )
    const by = new Map(up.lined.map((l) => [l.path, l]))
    expect(by.get('after.mp4')?.via).toBe('middle.mp4')
    expect(up.apart).toEqual([])
    expect(Math.abs((by.get('after.mp4')?.offsetSec ?? 0) - -240)).toBeLessThan(FRAME)
  })

  it('lines up an hour-long session whose recorders’ clocks drift, and says how far', () => {
    // One recorder's clock a ten-thousandth fast, as a cheap sound card's can be: matched over the
    // whole hour that blurs the match, so the line-up is found in stretches.
    const long = voiceChat(3100, 11)
    const home = recording(long, 0, 3000, 1)
    const steady = pairUp(home, recording(long, 5, 2950, 2))
    expect(sameSession(steady)).toBe(true)
    expect(steady?.sure).toBe(true)
    expect(Math.abs((steady?.offsetSec ?? 0) - -5)).toBeLessThan(FRAME)
    expect(Math.abs(steady?.driftSec ?? 1)).toBeLessThan(FRAME)
    const fast = pairUp(home, recording(long, 5, 2950, 3, 0, 1.0001))
    expect(sameSession(fast)).toBe(true)
    // Home's t is at (t - 5) * 1.0001 in it: in the middle of what they share, about 1480 s in, 0.148 s on.
    expect(Math.abs((fast?.offsetSec ?? 0) - (-5.0005 + 0.148))).toBeLessThan(FRAME)
    // They share about 2950 s, over which the line-up moves about 0.295 s.
    expect(Math.abs((fast?.driftSec ?? 0) - 0.295)).toBeLessThan(FRAME)
    // Twelve stretches checked, where both talk most, two in each sixth; with talk all along, every one agrees.
    expect(fast?.stretches).toEqual({ checked: 12, agreed: 12 })
  })

  it('lines up a long session where they hardly talk, from the minutes they do, and never another evening’s', () => {
    // An hour, talk only a sixteenth of the time; the other recording starts 13.5 minutes in, its clock 30 ppm fast.
    const quiet = sparseChat(3700, 1 / 16, 5)
    const home = recording(quiet, 0, 3600, 1)
    const late = pairUp(home, recording(quiet, 810, 2790, 2, 0, 1.00003))
    expect(late?.sure).toBe(true)
    expect(sameSession(late)).toBe(true)
    // Home's t is at (t - 810) * 1.00003 in it; in the middle of what they share, 2205 s in, that is -809.958.
    expect(Math.abs((late?.offsetSec ?? 0) - ((2205 - 810) * 1.00003 - 2205))).toBeLessThan(FRAME)
    expect(Math.abs((late?.driftSec ?? 0) - 2790 * 0.00003)).toBeLessThan(FRAME)
    expect(late?.stretches?.agreed).toBeGreaterThanOrEqual(6)
    // Another evening's recording, as quiet: no stretch of it agrees with anything, so it is not this session.
    const other = pairUp(home, recording(sparseChat(3700, 1 / 16, 99), 810, 2790, 3))
    expect(sameSession(other)).toBe(false)
    expect(other?.sure).toBe(false)
  })

  it('takes the loudest voice as yours', () => {
    const home = recording(chat, 0, 100, 1, 9)
    const quiet = recording(chat, 0, 100, 2)
    expect(loudestVoice([{ path: 'quiet.mp4', env: quiet }, { path: 'home.mp4', env: home }])).toBe('home.mp4')
  })

  it('slices an envelope to a stretch', () => {
    const env = { hopSec: HOP, db: new Float32Array(1000).map((_, i) => i) }
    const s = sliceEnvelope(env, 2, 1)
    expect(s.db.length).toBe(100)
    expect(s.db[0]).toBe(200)
  })
})
