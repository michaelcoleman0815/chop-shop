import { spawn } from 'child_process'
import { FrameBuilder, type Frames } from '../shared/audio/map'

/**
 * Listens to a recording once, as 16 kHz mono floats streamed from ffmpeg,
 * and measures every 10 ms frame: loudness (the same envelope the cut snaps
 * words to), zero crossings, pitch and how periodic the sound is. Only the
 * frame in progress is held, so an hour costs a few megabytes.
 */
export function listenFrames(ffmpeg: string, path: string, signal?: AbortSignal): Promise<Frames> {
  const args = ['-hide_banner', '-nostats', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']
  return new Promise<Frames>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal })
    const builder = new FrameBuilder()
    let carry: Buffer = Buffer.alloc(0)
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      const whole = data.length - (data.length % 4)
      // Copied out, since a Buffer's offset need not be aligned for floats.
      const floats = new Float32Array(whole / 4)
      for (let i = 0; i < floats.length; i++) floats[i] = data.readFloatLE(i * 4)
      builder.push(floats)
      carry = data.subarray(whole)
    })
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => {
      // No audio stream is not an error worth stopping for: nothing to hear.
      if (
        code !== 0 &&
        !/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(stderr)
      ) {
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
        return
      }
      resolve(builder.finish())
    })
  })
}
