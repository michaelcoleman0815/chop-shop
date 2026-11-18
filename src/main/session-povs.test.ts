import { describe, expect, it, vi } from 'vitest'
import type { Envelope } from '../shared/audio/snap'
import { recording, voiceChat } from '../shared/pov/test-session'
import type { FileFacts, Roles } from './session'

vi.mock('./ffmpeg', () => ({ FFMPEG_PATH: 'ffmpeg', FFPROBE_PATH: 'ffprobe' }))

import { findSession, saidHome, saidSound } from './session-povs'

/**
 * Finding one gaming session among dropped files, from synthetic loudness:
 * three players' recordings of one voice chat, started at their own times,
 * and a fourth from another evening. Names and numbers are made up.
 */

const FRAME = 1 / 30
const chat = voiceChat(260, 21)
const strangers = voiceChat(260, 77)

const ENVELOPES: Record<string, Envelope> = {
  // The first player's own microphone is the loudest voice in their recording.
  '/in/Lantern run pov-1.mp4': recording(chat, 0, 200, 1, 9),
  '/in/Lantern run pov-2.mp4': recording(chat, 14.2, 190, 2),
  '/in/Lantern run pov-3.mp4': recording(chat, -6.55, 180, 3),
  '/in/Lantern run pov-4.mp4': recording(strangers, 0, 190, 4)
}

const facts = (path: string, durationSec = 190): FileFacts => ({
  path,
  name: path.replace(/^.*\//, ''),
  durationSec,
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  createdAt: null,
  speech: 0.5
})

const roles = (talking: string[], broll: string[] = []): Roles => ({
  talking,
  sound: [],
  broll,
  ignored: [],
  reply: 'Sorted.',
  by: 'claude'
})

const envelopeOf = async (path: string): Promise<Envelope> => {
  const e = ENVELOPES[path]
  if (!e) throw new Error('no sound')
  return e
}

const POVS = ['/in/Lantern run pov-1.mp4', '/in/Lantern run pov-2.mp4', '/in/Lantern run pov-3.mp4']

describe('saying which recording is yours', () => {
  const files = POVS.map((path) => ({ path, name: path.replace(/^.*\//, '') }))

  it('reads the name, the place or the number of the one you say is yours', () => {
    expect(saidHome('these are our povs, mine is pov-2', files)).toBe(POVS[1])
    expect(saidHome('My pov is the third one.', files)).toBe(POVS[2])
    expect(saidHome('I’m in pov 3', files)).toBe(POVS[2])
    expect(saidHome('pov-1 is me, cut it like a highlight', files)).toBe(POVS[0])
    expect(saidHome('cut between our views', files)).toBeNull()
  })

  it('reads a player’s name when the files are named after the players', () => {
    const named = ['/in/Mara.mp4', '/in/Teo.mp4', '/in/Ilse.mp4'].map((path) => ({ path, name: path.slice(4) }))
    expect(saidHome('I’m Teo, the others are my squad', named)).toBe('/in/Teo.mp4')
    expect(saidHome('Teo.mp4 is mine', named)).toBe('/in/Teo.mp4')
  })

  it('reads whose sound to use, apart from which view is yours', () => {
    expect(saidSound('mine is pov-1, use the sound from pov-3', files)).toBe(POVS[2])
    expect(saidHome('mine is pov-1, use the sound from pov-3', files)).toBe(POVS[0])
    expect(saidSound('I’m pov-2. Use pov-1’s audio', files)).toBe(POVS[0])
    expect(saidSound('mine is pov-2', files)).toBeNull()
  })
})

describe('finding one session among the files', () => {
  it('lines every player’s view up with yours, as you said which is yours, however the files were sorted', async () => {
    const files = POVS.map((p) => facts(p))
    // Sorted as one talking recording and two to cut to: the session takes them all.
    const r = await findSession(roles([POVS[1]], [POVS[0], POVS[2]]), files, 'our trio, three POVs. mine is pov-2', envelopeOf)
    expect(r.talking).toEqual([POVS[1]])
    expect(r.broll).toEqual([])
    const by = new Map((r.povs ?? []).map((p) => [p.path, p]))
    // Home's t is pov-1's t + 14.2 (it started 14.2 s before pov-2) and pov-3's t + 20.75.
    expect(Math.abs((by.get(POVS[0])?.offsetSec ?? 0) - 14.2)).toBeLessThan(FRAME)
    expect(Math.abs((by.get(POVS[2])?.offsetSec ?? 0) - 20.75)).toBeLessThan(FRAME)
    expect(r.reply).toBe(
      'This is one session from 3 players’ views: I lined Lantern run pov-1.mp4 and Lantern run pov-3.mp4 up with yours, Lantern run pov-2.mp4, by the voice chat. Lantern run pov-2.mp4 is yours, as you said.'
    )
  })

  it('takes the loudest microphone as yours when you don’t say, and says so', async () => {
    const files = POVS.map((p) => facts(p))
    const r = await findSession(roles(POVS), files, 'make a highlight of our lobby', envelopeOf)
    expect(r.talking).toEqual([POVS[0]])
    expect(r.povs?.map((p) => p.path)).toEqual([POVS[1], POVS[2]])
    expect(Math.abs((r.povs?.[0].offsetSec ?? 0) - -14.2)).toBeLessThan(FRAME)
    expect(Math.abs((r.povs?.[1].offsetSec ?? 0) - 6.55)).toBeLessThan(FRAME)
    expect(r.reply).toContain(
      'I took Lantern run pov-1.mp4 as yours, as its microphone is the loudest; if it isn’t, drop them again and say which one is yours.'
    )
  })

  it('says plainly which one is not of the session, and keeps it as footage to cut to', async () => {
    const all = [...POVS, '/in/Lantern run pov-4.mp4']
    const r = await findSession(roles(all), all.map((p) => facts(p)), 'four povs from tonight', envelopeOf)
    expect(r.povs?.map((p) => p.path)).toEqual([POVS[1], POVS[2]])
    expect(r.broll).toEqual(['/in/Lantern run pov-4.mp4'])
    expect(r.reply).toContain(
      'Lantern run pov-4.mp4 doesn’t line up with the others by ear, so it isn’t part of the session; it’s in as footage to cut to.'
    )
  })

  it('keeps your own sound under every view, or another player’s when you ask for it', async () => {
    const files = POVS.map((p) => facts(p))
    const mine = await findSession(roles(POVS), files, 'our povs, mine is pov-1', envelopeOf)
    expect(mine.sound).toEqual([])
    const theirs = await findSession(roles(POVS), files, 'our povs, mine is pov-1, use the sound from pov-3', envelopeOf)
    // Still a view to cut to, and the sound under every view, lined up as a recorder's is when the edit starts.
    expect(theirs.povs?.map((p) => p.path)).toEqual([POVS[1], POVS[2]])
    expect(theirs.sound).toEqual([POVS[2]])
    expect(theirs.reply).toContain('The sound under every view is Lantern run pov-3.mp4’s, as you asked.')
  })

  it('finds three talking recordings that line up as one session unasked, and says how to undo it', async () => {
    const plain = ['/in/2026-11-02 21-04-11.mp4', '/in/2026-11-02 21-04-40.mp4', '/in/clip.mp4']
    const env: Record<string, Envelope> = {
      [plain[0]]: ENVELOPES[POVS[0]],
      [plain[1]]: ENVELOPES[POVS[1]],
      [plain[2]]: ENVELOPES[POVS[2]]
    }
    const r = await findSession(roles(plain), plain.map((p) => facts(p)), '', async (p) => env[p])
    expect(r.povs?.length).toBe(2)
    expect(r.reply).toContain('If they aren’t one gaming session, drop them again and say what they are.')
  })

  it('leaves two cameras of one talk, or three said to be cameras, to the take sorting', async () => {
    const two = ['/in/A001.mp4', '/in/B001.mp4']
    const pair = await findSession(roles(two), two.map((p) => facts(p)), '', async (p) => ENVELOPES[POVS[two.indexOf(p)]])
    expect(pair.povs).toBeUndefined()
    const plain = ['/in/A001.mp4', '/in/B001.mp4', '/in/C001.mp4']
    const env: Record<string, Envelope> = { [plain[0]]: ENVELOPES[POVS[0]], [plain[1]]: ENVELOPES[POVS[1]], [plain[2]]: ENVELOPES[POVS[2]] }
    const cams = await findSession(roles(plain), plain.map((p) => facts(p)), 'three cameras of my talk', async (p) => env[p])
    expect(cams.povs).toBeUndefined()
    expect(cams.reply).toBe('Sorted.')
  })

  it('leaves files whose sound cannot be read as they were', async () => {
    const files = [...POVS.map((p) => facts(p)), facts('/in/broken pov.mp4')]
    const r = await findSession(roles([...POVS, '/in/broken pov.mp4']), files, 'our povs', envelopeOf)
    expect(r.povs?.length).toBe(2)
    expect(r.talking).toContain('/in/broken pov.mp4')
  })
})
