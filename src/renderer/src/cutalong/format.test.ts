import { describe, expect, it } from 'vitest'
import { elapsed, isAudioFile, isVideoFile } from './format'

describe('formatting', () => {
  it('reads a stopwatch the way people do, its units spaced like every other time in the app', () => {
    expect(elapsed(0)).toBe('0 s')
    expect(elapsed(2)).toBe('2 s')
    expect(elapsed(12.9)).toBe('12 s')
    expect(elapsed(64)).toBe('1 min 4 s')
    expect(elapsed(544)).toBe('9 min 4 s')
    expect(elapsed(3720)).toBe('1 h 2 min')
  })

  it('tells sound files from footage', () => {
    expect(isAudioFile('lav.WAV')).toBe(true)
    expect(isAudioFile('voice.m4a')).toBe(true)
    expect(isAudioFile('MVI_9293.MP4')).toBe(false)
    expect(isVideoFile('2026-10-16 20-49-09.mp4')).toBe(true)
  })
})
