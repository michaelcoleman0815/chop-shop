import { describe, expect, it } from 'vitest'
import { encodeArgs, exportBitrate, phoneEncoder, videoCodec, X264, type Encoder } from './encoder'

const VT: Encoder = { kind: 'videotoolbox' }
const MC: Encoder = { kind: 'mediacodec' }

/** A command line's arguments, written as it would be typed. */
const args = (line: string): string[] => line.split(' ')

describe('encoding a render', () => {
  it('keeps the computer on exactly the x264 arguments it always had', () => {
    const size = { width: 1080, height: 1920 }
    expect(encodeArgs(X264, 'intermediate', size, 30)).toEqual(
      args('-c:v libx264 -preset veryfast -crf 12 -pix_fmt yuv420p -c:a pcm_s16le')
    )
    expect(encodeArgs(X264, 'preview', size, 30)).toEqual(
      args('-c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart')
    )
    expect(encodeArgs(X264, 'final', size, 30)).toEqual(
      args('-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart')
    )
    // The size and rate change nothing for x264: it encodes at a constant quality.
    expect(encodeArgs(X264, 'final', { width: 3840, height: 2160 }, 60)).toEqual(encodeArgs(X264, 'final', size, 30))
  })

  it('encodes an iPhone export with VideoToolbox, High profile, a bitrate for its size and nv12', () => {
    expect(encodeArgs(VT, 'final', { width: 1080, height: 1920 }, 30)).toEqual(
      args(
        '-c:v h264_videotoolbox -profile:v high -b:v 12000k -g 60 -pix_fmt nv12 -c:a aac -b:a 192k -movflags +faststart'
      )
    )
    expect(encodeArgs(VT, 'final', { width: 3840, height: 2160 }, 30)).toEqual(
      args(
        '-c:v h264_videotoolbox -profile:v high -b:v 45000k -g 60 -pix_fmt nv12 -c:a aac -b:a 192k -movflags +faststart'
      )
    )
  })

  it('encodes an Android export with MediaCodec, and chunks of a long cut at a rate fit to be encoded again', () => {
    expect(encodeArgs(MC, 'final', { width: 1920, height: 1080 }, 60)).toEqual(
      args('-c:v h264_mediacodec -b:v 18000k -g 120 -pix_fmt nv12 -c:a aac -b:a 192k -movflags +faststart')
    )
    expect(encodeArgs(MC, 'intermediate', { width: 1080, height: 1920 }, 30)).toEqual(
      args('-c:v h264_mediacodec -b:v 30000k -g 60 -pix_fmt nv12 -c:a pcm_s16le')
    )
    // A preview is half size, at half the rate a finished file of that size gets.
    expect(encodeArgs(MC, 'preview', { width: 540, height: 960 }, 30)).toEqual(
      args('-c:v h264_mediacodec -b:v 2000k -g 60 -pix_fmt nv12 -c:a aac -b:a 128k -movflags +faststart')
    )
  })

  it('gives bitrates by size and frame rate, the rates suggested for uploads', () => {
    expect(exportBitrate(1920, 1080, 30)).toBe(12e6)
    expect(exportBitrate(1080, 1920, 25)).toBe(12e6)
    expect(exportBitrate(1080, 1080, 30)).toBe(6.8e6)
    expect(exportBitrate(2560, 1440, 30)).toBe(20e6)
    expect(exportBitrate(3840, 2160, 30)).toBe(45e6)
    expect(exportBitrate(2160, 3840, 60)).toBe(67.5e6)
    expect(exportBitrate(1920, 1080, 60)).toBe(18e6)
    // Never starved, however small.
    expect(exportBitrate(320, 180, 30)).toBe(2e6)
    // Rising with the picture between the steps.
    expect(exportBitrate(3000, 1700, 30)).toBeGreaterThan(20e6)
    expect(exportBitrate(3000, 1700, 30)).toBeLessThan(45e6)
  })

  it('picks the phone encoder this build of ffmpeg has', () => {
    expect(phoneEncoder(['h264_videotoolbox', 'hevc_videotoolbox', 'mjpeg'])).toEqual(VT)
    expect(phoneEncoder(['h264_mediacodec', 'hevc_mediacodec'])).toEqual(MC)
    expect(phoneEncoder(['mpeg4', 'mjpeg'])).toBeNull()
    expect(videoCodec(X264)).toBe('libx264')
    expect(videoCodec(VT)).toBe('h264_videotoolbox')
    expect(videoCodec(MC)).toBe('h264_mediacodec')
  })
})
