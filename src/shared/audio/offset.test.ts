import { describe, expect, it } from 'vitest'
import { estimateOffset, shiftEnvelope, trustworthy } from './offset'
import type { Envelope } from './snap'

/** Speech-like loudness: syllables of random length and level, with pauses, 100 times a second. */
function speech(seconds: number, seed: number): Float32Array {
  let x = seed
  const rand = (): number => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 2147483648
  }
  const db = new Float32Array(Math.round(seconds * 100))
  let i = 0
  while (i < db.length) {
    const syllable = 8 + Math.floor(rand() * 22)
    const level = -32 + rand() * 18
    for (let j = 0; j < syllable && i < db.length; j++, i++) db[i] = level + Math.sin((j / syllable) * Math.PI) * 6
    const gap = rand() < 0.25 ? 30 + Math.floor(rand() * 50) : 2 + Math.floor(rand() * 8)
    for (let j = 0; j < gap && i < db.length; j++, i++) db[i] = -62 + rand() * 4
  }
  return db
}

const env = (db: Float32Array): Envelope => ({ hopSec: 0.01, db })

describe('lining up two recordings of the same talking', () => {
  it('finds where a camera clip sits inside a longer screen recording, to the hundredth', () => {
    const talk = speech(90, 7)
    // The screen recording starts 3.42 s earlier, runs on after, and hears the room differently.
    const lead = 342
    const screen = new Float32Array(lead + talk.length + 1500)
    const room = speech(screen.length / 100, 99)
    for (let i = 0; i < screen.length; i++) screen[i] = -58 + (room[i] + 62) * 0.05
    for (let i = 0; i < talk.length; i++) screen[lead + i] = talk[i] * 0.8 - 4
    // The camera hears 40 s of it, starting 20 s in, with its own noise floor.
    const camera = new Float32Array(4000)
    for (let i = 0; i < camera.length; i++) camera[i] = Math.max(-50, talk[2000 + i] + 3)

    const o = estimateOffset(env(camera), env(screen))
    expect(o).not.toBeNull()
    expect(Math.abs((o?.offsetSec ?? 0) - 23.42)).toBeLessThanOrEqual(0.02)
    expect(trustworthy(o)).toBe(true)
  })

  it('works the other way round, when the camera started first', () => {
    const talk = speech(60, 3)
    const camera = env(talk)
    const later = env(talk.slice(250))
    const o = estimateOffset(camera, later)
    expect(Math.abs((o?.offsetSec ?? 0) + 2.5)).toBeLessThanOrEqual(0.02)
    expect(trustworthy(o)).toBe(true)
  })

  it('is not sure when the two are different talking', () => {
    const o = estimateOffset(env(speech(40, 1)), env(speech(120, 2)))
    expect(trustworthy(o)).toBe(false)
  })

  it('says nothing for clips too short to tell', () => {
    expect(estimateOffset(env(speech(2, 1)), env(speech(60, 2)))).toBeNull()
  })

  it('lays the other recording onto the clip, silent outside it', () => {
    const shifted = shiftEnvelope(env(Float32Array.from([1, 2, 3, 4, 5])), 0.02, 0.05)
    expect(Array.from(shifted.db)).toEqual([3, 4, 5, -120, -120])
    expect(Array.from(shiftEnvelope(env(Float32Array.from([1, 2])), -0.01, 0.02).db)).toEqual([-120, 1])
  })
})
