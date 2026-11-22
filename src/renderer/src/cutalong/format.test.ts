import { describe, expect, it } from 'vitest'
import { elapsed, fileUrl, isAudioFile, isVideoFile } from './format'

describe('formatting', () => {
  it('reads a stopwatch the way people do, its units spaced like every other time in the app', () => {
    expect(elapsed(0)).toBe('0 s')
    expect(elapsed(2)).toBe('2 s')
    expect(elapsed(12.9)).toBe('12 s')
    expect(elapsed(64)).toBe('1 min 4 s')
    expect(elapsed(544)).toBe('9 min 4 s')
    expect(elapsed(3720)).toBe('1 h 2 min')
  })

  it('gives a file an address by its path, on a Mac and on Windows', () => {
    expect(fileUrl('/Users/me/Movies/MVI 9293.MP4')).toBe('file:///Users/me/Movies/MVI%209293.MP4')
    expect(fileUrl('C:\\Users\\me\\Videos\\MVI 9293.MP4')).toBe('file:///C:/Users/me/Videos/MVI%209293.MP4')
    expect(fileUrl('D:/Footage/take #1.mov')).toBe('file:///D:/Footage/take%20%231.mov')
    expect(fileUrl('\\\\nas\\shoot\\take.mov')).toBe('file://nas/shoot/take.mov')
  })

  it('tells sound files from footage', () => {
    expect(isAudioFile('lav.WAV')).toBe(true)
    expect(isAudioFile('voice.m4a')).toBe(true)
    expect(isAudioFile('MVI_9293.MP4')).toBe(false)
    expect(isVideoFile('2026-10-16 20-49-09.mp4')).toBe(true)
  })
})
