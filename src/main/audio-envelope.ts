import type { Envelope } from '../shared/audio/snap'
import { FloatReader, platform } from './platform'

/**
 * The loudness of a recording, 100 times a second, measured locally with
 * ffmpeg: what lets the cut hear where words really start and stop.
 *
 * Audio is decoded to 16 kHz mono and read as it streams, one 10 ms frame at a
 * time, so an hour of recording costs about 1.4 MB of memory, not the
 * quarter of a gigabyte the raw samples would.
 */

const RATE = 16000

export async function loudnessEnvelope(
  ffmpeg: string,
  path: string,
  opts: {
    hopSec?: number
    startSec?: number
    durationSec?: number
    signal?: AbortSignal
    /**
     * Only the band voices fill, 250 Hz to 3.5 kHz: what several players'
     * recordings of one session share is the voice chat, under game sound
     * that is mostly lower or higher.
     */
    voice?: boolean
  } = {}
): Promise<Envelope> {
  const hopSec = opts.hopSec ?? 0.01
  const perFrame = Math.max(1, Math.round(RATE * hopSec))
  const window = [
    ...(opts.startSec ? ['-ss', opts.startSec.toFixed(3)] : []),
    ...(opts.durationSec ? ['-t', opts.durationSec.toFixed(3)] : [])
  ]
  const args = [
    '-hide_banner',
    '-nostats',
    ...window,
    '-i',
    path,
    '-vn',
    ...(opts.voice ? ['-af', 'highpass=f=250,lowpass=f=3500'] : []),
    '-ac',
    '1',
    '-ar',
    String(RATE),
    '-f',
    'f32le',
    '-'
  ]

  const out: number[] = []
  let sum = 0
  let count = 0
  let stderr = ''
  const floats = new FloatReader()
  const r = await platform().run(ffmpeg, args, {
    signal: opts.signal,
    onBytes: (chunk) => {
      for (const v of floats.push(chunk)) {
        sum += v * v
        if (++count === perFrame) {
          out.push(10 * Math.log10(sum / count + 1e-12))
          sum = 0
          count = 0
        }
      }
    },
    onStderr: (text) => (stderr = (stderr + text).slice(-4000))
  })
  if (count > 0) out.push(10 * Math.log10(sum / count + 1e-12))
  // No audio stream is not an error worth stopping for: nothing to listen to.
  if (r.code !== 0 && !/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(stderr)) {
    throw new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${r.code}`)
  }
  return { hopSec, db: Float32Array.from(out) }
}
