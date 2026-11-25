import { describe, expect, it } from 'vitest'
import { cameraPlan, viewAt, windowAt } from './edit/camera'
import { pageRoom, screenLine, windowDuring, type ScreenReading } from './screen'

// A chat on screen with the speaker in a window on the right, read every two seconds, as Ali Abdaal walks one.
const line = (text: string, y: number): { text: string; box: [number, number, number, number] } => ({ text, box: [0.02, y, 0.5, 0.03] })
const page = [
  line('Good. Now we triage. For each of these, does it actually move the needle', 0.14),
  line('Starting with the Life one: finding a singing teacher and improving', 0.2),
  line('How do I triage this', 0.33),
  line('What does triage mean', 0.38)
]
const reading: ScreenReading = {
  everySec: 2,
  samples: [
    { t: 0, lines: [line('Jm', 0.5)], window: null },
    { t: 2, lines: page, window: [0.76, 0.23, 0.23, 0.55] },
    { t: 4, lines: page, window: [0.762, 0.226, 0.226, 0.552] },
    { t: 6, lines: page, window: null }
  ]
}

describe('what is on screen', () => {
  it('says a beat shows a page of words, where they lie, where the speaker is, and the line being talked about', () => {
    const said = 'starting with the life one finding a singing teacher'
    const out = screenLine(reading, 2, 6, said)!
    expect(out).toContain('a page of words over [0.02, 0.14, 0.50, 0.27]')
    expect(out).toContain('the speaker in a window at [0.76, 0.23, 0.23, 0.55]')
    expect(out).toMatch(/^.*talked about: "Starting with the Life one: finding a singing teacher and improving" \[0\.02, 0\.20, 0\.50, 0\.03\]/)
    // A beat over a picture with hardly a word in it says nothing.
    expect(screenLine(reading, 0, 0.5, said)).toBeNull()
  })

  it('finds the window the speaker is kept in only where most readings saw it', () => {
    expect(windowDuring(reading, 2, 4)).toEqual([0.762, 0.23, 0.23, 0.552])
    expect(windowDuring(reading, 0, 0.5)).toBeNull()
  })

  it('gives a camera on the page the room beside the window, and a glide on a phrase mid-line reads from the line’s start', () => {
    const room = pageRoom(reading, 2, 4)!
    expect(room.x).toBe(0)
    expect(room.w).toBeCloseTo(0.762 - 0.02, 9)
    expect(room.pageLeft).toBe(0.02)
    expect(pageRoom(reading, 0, 0.5)).toBeNull()
    // "does it actually move the needle", from a third of the way along the line.
    const phrase = { at: 0, x: 0.3, y: 0.13, w: 0.22, h: 0.05 }
    const plan = cameraPlan({ kind: 'focus', regions: [phrase] }, 3, null, 16 / 9, 16 / 9, room)
    const v = viewAt(plan, 2)
    const seen = windowAt(v, plan.fw, plan.fh)
    // In closer than the whole frame, the page's left edge in view, and the phrase clear of the window.
    expect(v.zoom).toBeGreaterThan(1.2)
    expect(seen.x).toBeLessThanOrEqual(0.02)
    expect((phrase.x + phrase.w - seen.x) / seen.w).toBeLessThan(0.762)
  })
})
