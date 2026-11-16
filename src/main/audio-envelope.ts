import { spawn } from 'child_process'
import type { Envelope } from '../shared/audio/snap'

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
  opts: { hopSec?: number; startSec?: number; durationSec?: number; signal?: AbortSignal } = {}
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
    '-ac',
    '1',
    '-ar',
    String(RATE),
    '-f',
    'f32le',
    '-'
  ]

  return new Promise<Envelope>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal: opts.signal })
    const out: number[] = []
    let sum = 0
    let count = 0
    let carry: Buffer = Buffer.alloc(0)
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const whole = data.length - (data.length % 4)
      for (let i = 0; i < whole; i += 4) {
        const v = data.readFloatLE(i)
        sum += v * v
        if (++count === perFrame) {
          out.push(10 * Math.log10(sum / count + 1e-12))
          sum = 0
          count = 0
        }
      }
      carry = data.subarray(whole)
    })
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (count > 0) out.push(10 * Math.log10(sum / count + 1e-12))
      // No audio stream is not an error worth stopping for: nothing to listen to.
      if (
        code !== 0 &&
        !/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(stderr)
      ) {
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
        return
      }
      resolve({ hopSec, db: Float32Array.from(out) })
    })
  })
}
