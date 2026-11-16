import { spawn } from 'child_process'
import type { Envelope } from '../shared/audio/snap'
import { FeatureStream, SAMPLE_RATE, type Features } from '../shared/learn/features'

/**
 * Listens to a whole file once, on this computer: the loudness every 10 ms
 * (the same numbers loudnessEnvelope gives, so words snap the same way) and
 * the band energies the learning matches on, from one ffmpeg decode.
 *
 * The audio streams through at 16 kHz mono and is never held whole, so an
 * hour costs the 35 MB of features it produces rather than the 230 MB its
 * samples would. Takes the ffmpeg binary as an argument and never imports
 * Electron, so the tests can run it.
 */

export interface Heard {
  envelope: Envelope
  features: Features
  /** How long the audio actually runs. Zero when the file has no sound. */
  durationSec: number
}

const HOP = Math.round(SAMPLE_RATE * 0.01)

export async function listen(ffmpeg: string, path: string, signal?: AbortSignal): Promise<Heard> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    '-'
  ]
  return new Promise<Heard>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal })
    const stream = new FeatureStream()
    const db: number[] = []
    let sum = 0
    let count = 0
    let total = 0
    let carry: Buffer = Buffer.alloc(0)
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const whole = data.length - (data.length % 4)
      const samples = new Float32Array(whole / 4)
      for (let i = 0; i < whole; i += 4) {
        const v = data.readFloatLE(i)
        samples[i / 4] = v
        sum += v * v
        if (++count === HOP) {
          db.push(10 * Math.log10(sum / count + 1e-12))
          sum = 0
          count = 0
        }
      }
      total += samples.length
      stream.push(samples)
      carry = data.subarray(whole)
    })
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (count > 0) db.push(10 * Math.log10(sum / count + 1e-12))
      if (
        code !== 0 &&
        !/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(stderr)
      ) {
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
        return
      }
      resolve({
        envelope: { hopSec: 0.01, db: Float32Array.from(db) },
        features: stream.finish(),
        durationSec: total / SAMPLE_RATE
      })
    })
  })
}
