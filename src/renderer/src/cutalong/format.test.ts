import { describe, expect, it } from 'vitest'
import { elapsed, isAudioFile, isVideoFile } from './format'

describe('formatting', () => {
  it('reads a stopwatch the way people do', () => {
    expect(elapsed(0)).toBe('0s')
    expect(elapsed(12.9)).toBe('12s')
    expect(elapsed(544)).toBe('9m 4s')
    expect(elapsed(3720)).toBe('1h 2m')
  })

  it('tells sound files from footage', () => {
    expect(isAudioFile('lav.WAV')).toBe(true)
    expect(isAudioFile('voice.m4a')).toBe(true)
    expect(isAudioFile('MVI_9293.MP4')).toBe(false)
    expect(isVideoFile('2026-10-16 20-49-09.mp4')).toBe(true)
  })
})
