import { FrameBuilder, type Frames } from '../shared/audio/map'
import { FloatReader, platform } from './platform'

/**
 * Listens to a recording once, as 16 kHz mono floats streamed from ffmpeg,
 * and measures every 10 ms frame: loudness (the same envelope the cut snaps
 * words to), zero crossings, pitch and how periodic the sound is. Only the
 * frame in progress is held, so an hour costs a few megabytes.
 */
export async function listenFrames(ffmpeg: string, path: string, signal?: AbortSignal): Promise<Frames> {
  const args = ['-hide_banner', '-nostats', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']
  const builder = new FrameBuilder()
  const floats = new FloatReader()
  let stderr = ''
  const r = await platform().run(ffmpeg, args, {
    signal,
    onBytes: (chunk) => builder.push(floats.push(chunk)),
    onStderr: (text) => (stderr = (stderr + text).slice(-4000))
  })
  // No audio stream is not an error worth stopping for: nothing to hear.
  if (r.code !== 0 && !/does not contain any stream|matches no streams|Output file #0 does not contain/i.test(stderr)) {
    throw new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${r.code}`)
  }
  return builder.finish()
}
