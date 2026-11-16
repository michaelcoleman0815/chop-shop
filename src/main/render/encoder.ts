/**
 * How a render encodes its picture and sound.
 *
 * A computer encodes H.264 with libx264, as the Mac app always has. A phone's
 * ffmpeg is built without x264 (it is LGPL only), so it encodes with the
 * phone's own hardware: VideoToolbox on an iPhone, MediaCodec on Android.
 * Hardware encoders have no constant-quality mode that both share, so a
 * phone's export is given a bitrate for its size and frame rate instead,
 * the rates YouTube suggests for uploads, and the 4:2:0 layout both take
 * from memory (nv12). The filter graph is the same either way.
 */

export type Encoder =
  /** libx264, at a constant quality: the computer. */
  | { kind: 'x264' }
  /** h264_videotoolbox: an iPhone. */
  | { kind: 'videotoolbox' }
  /** h264_mediacodec: an Android phone. */
  | { kind: 'mediacodec' }

export const X264: Encoder = { kind: 'x264' }

export type EncodeQuality = 'preview' | 'final' | 'intermediate'

/** The hardware encoder a phone's ffmpeg has, from the engine's list of encoders; null when it has neither. */
export function phoneEncoder(encoders: string[]): Encoder | null {
  if (encoders.includes('h264_videotoolbox')) return { kind: 'videotoolbox' }
  if (encoders.includes('h264_mediacodec')) return { kind: 'mediacodec' }
  return null
}

/** The ffmpeg encoder's name for a kind. */
export function videoCodec(encoder: Encoder): string {
  return encoder.kind === 'x264' ? 'libx264' : encoder.kind === 'videotoolbox' ? 'h264_videotoolbox' : 'h264_mediacodec'
}

/**
 * Bits per second for a finished export of this size and rate: YouTube's
 * suggested upload rates for SDR, 12 Mb/s at 1080p up to 30 fps, 20 at
 * 1440p and 45 at 2160p, half as much again above 30 fps. Sizes between are
 * read off the line through those, by pixel count; smaller ones scale down
 * with their pixels to no less than 2 Mb/s.
 */
export function exportBitrate(width: number, height: number, fps: number): number {
  const pixels = Math.max(1, width * height)
  const steps: [number, number][] = [
    [1920 * 1080, 12e6],
    [2560 * 1440, 20e6],
    [3840 * 2160, 45e6]
  ]
  let rate: number
  if (pixels <= steps[0][0]) rate = (pixels / steps[0][0]) * steps[0][1]
  else if (pixels >= steps[2][0]) rate = (pixels / steps[2][0]) * steps[2][1]
  else {
    const [a, b] = pixels <= steps[1][0] ? [steps[0], steps[1]] : [steps[1], steps[2]]
    rate = a[1] + ((pixels - a[0]) / (b[0] - a[0])) * (b[1] - a[1])
  }
  if (fps > 31) rate *= 1.5
  return Math.max(2e6, Math.round(rate / 1e5) * 1e5)
}

/** A rate as ffmpeg reads it: 12000k. */
const kbps = (bits: number): string => `${Math.round(bits / 1000)}k`

/**
 * The arguments that encode one pass: video, pixel format and sound. A
 * chunk of a long cut (intermediate) is encoded again in the join, so it is
 * kept close to lossless: x264 at crf 12, or a hardware encoder at two and a
 * half times the export's rate, with its sound as PCM.
 */
export function encodeArgs(
  encoder: Encoder,
  quality: EncodeQuality,
  size: { width: number; height: number },
  fps: number
): string[] {
  if (encoder.kind === 'x264') {
    if (quality === 'intermediate')
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le']
    if (quality === 'preview')
      return [
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '26',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart'
      ]
    return [
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '18',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart'
    ]
  }
  const full = exportBitrate(size.width, size.height, fps)
  const rate = quality === 'intermediate' ? full * 2.5 : quality === 'preview' ? Math.max(2e6, full / 2) : full
  const video = [
    '-c:v',
    videoCodec(encoder),
    // VideoToolbox picks Main by itself; High is what x264 writes and what phones play.
    ...(encoder.kind === 'videotoolbox' ? ['-profile:v', 'high'] : []),
    '-b:v',
    kbps(rate),
    // A keyframe every two seconds, so the chat's player seeks quickly.
    '-g',
    String(Math.max(1, Math.round(fps * 2))),
    '-pix_fmt',
    'nv12'
  ]
  if (quality === 'intermediate') return [...video, '-c:a', 'pcm_s16le']
  return [...video, '-c:a', 'aac', '-b:a', quality === 'preview' ? '128k' : '192k', '-movflags', '+faststart']
}
