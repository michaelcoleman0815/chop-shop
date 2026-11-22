import { join } from 'path'
import { FBANK_BINS, FBANK_RATE, fbank } from '../shared/speakers/fbank'
import { LEAST_SEC, speakersOf, stretchesOf, type Speakers, type SpokenWord } from '../shared/speakers/turns'
import { FloatReader, platform } from './platform'

/**
 * Who is talking, heard on this computer: each stretch of the transcript has
 * its voice fingerprinted by 3D-Speaker's CAM++ (an ONNX model, Apache-2.0,
 * as sherpa-onnx publishes it), run with onnxruntime-node, which the Mac and
 * Windows apps already carry for the voice that reads. The grouping into
 * speakers is shared/speakers. Nothing leaves the computer.
 *
 * The recording is read in pieces of PIECE_SEC, so an hour of it never sits
 * in memory at once.
 */

export const SPEAKER_MODEL = {
  file: '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
  mb: 30
}

export function speakerModelPath(): string {
  return join(platform().paths.userData(), 'models', SPEAKER_MODEL.file)
}

export async function hasSpeakerModel(): Promise<boolean> {
  return (await platform().files.stat(speakerModelPath())) !== null
}

/** Fetches the speaker model once, reporting 0-100. */
export async function downloadSpeakerModel(onProgress: (percent: number) => void = () => undefined): Promise<string> {
  const dest = speakerModelPath()
  if (await hasSpeakerModel()) return dest
  await platform().files.mkdir(join(platform().paths.userData(), 'models'))
  await platform().download(SPEAKER_MODEL.url, dest, onProgress)
  onProgress(100)
  return dest
}

/** The slice of onnxruntime-node this uses. */
export interface SpeakerSession {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: unknown }>>
}
export interface SpeakerOrt {
  InferenceSession: { create(path: string, opts?: Record<string, unknown>): Promise<SpeakerSession> }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
}

async function loadOrt(): Promise<SpeakerOrt> {
  try {
    // A runtime dependency with a native binary, loaded only when it is first needed.
    const name = 'onnxruntime-node'
    const m = (await import(/* @vite-ignore */ name)) as { default?: unknown; InferenceSession?: unknown }
    return (m.InferenceSession ? m : m.default) as unknown as SpeakerOrt
  } catch {
    throw new Error('Telling the speakers apart needs onnxruntime-node, which is missing from this build.')
  }
}

const sessions = new Map<string, Promise<SpeakerSession>>()
function sessionFor(ort: SpeakerOrt, model: string): Promise<SpeakerSession> {
  let s = sessions.get(model)
  if (!s) {
    s = ort.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
    s.catch(() => sessions.delete(model))
    sessions.set(model, s)
  }
  return s
}

/** How much of the recording is read at once. */
const PIECE_SEC = 300

/** A stretch of the recording at 16 kHz, mono, as floats. */
async function readSound(ffmpeg: string, path: string, startSec: number, sec: number, signal?: AbortSignal): Promise<Float32Array> {
  const chunks: Float32Array[] = []
  let total = 0
  const floats = new FloatReader()
  let stderr = ''
  const r = await platform().run(
    ffmpeg,
    ['-hide_banner', '-nostats', '-ss', startSec.toFixed(3), '-t', sec.toFixed(3), '-i', path, '-vn', '-ac', '1', '-ar', String(FBANK_RATE), '-f', 'f32le', '-'],
    {
      signal,
      onBytes: (bytes) => {
        const f = floats.push(bytes)
        chunks.push(f)
        total += f.length
      },
      onStderr: (t) => (stderr = (stderr + t).slice(-2000))
    }
  )
  if (r.code !== 0) throw new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${r.code}`)
  const out = new Float32Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export interface FindSpeakersOptions {
  /** How many people there are, when known. */
  speakers?: number
  signal?: AbortSignal
  /** 0 to 1. */
  onProgress?: (fraction: number) => void
  /** The model's file; the downloaded one when absent. */
  model?: string
  ort?: () => Promise<SpeakerOrt>
}

/** Who says each word of a recording's transcript. */
export async function findSpeakers(ffmpeg: string, path: string, words: SpokenWord[], opts: FindSpeakersOptions = {}): Promise<Speakers> {
  const stretches = stretchesOf(words)
  const prints: (Float32Array | null)[] = stretches.map(() => null)
  if (stretches.length === 0) return speakersOf(words, stretches, prints, opts)
  const ort = await (opts.ort ?? loadOrt)()
  const session = await sessionFor(ort, opts.model ?? speakerModelPath())
  const input = session.inputNames[0]
  const output = session.outputNames[0]

  // Stretches in pieces of the recording of at most PIECE_SEC.
  const pieces: number[][] = []
  stretches.forEach((s, i) => {
    const piece = pieces[pieces.length - 1]
    if (piece && s.endSec - stretches[piece[0]].startSec <= PIECE_SEC) piece.push(i)
    else pieces.push([i])
  })
  let done = 0
  for (const piece of pieces) {
    const from = stretches[piece[0]].startSec
    const to = stretches[piece[piece.length - 1]].endSec
    const sound = await readSound(ffmpeg, path, from, to - from + 0.05, opts.signal)
    for (const i of piece) {
      const s = stretches[i]
      if (s.endSec - s.startSec >= LEAST_SEC) {
        const a = Math.max(0, Math.round((s.startSec - from) * FBANK_RATE))
        const b = Math.min(sound.length, Math.round((s.endSec - from) * FBANK_RATE))
        const feats = fbank(sound.subarray(a, b))
        if (feats.frames > 0) {
          const result = await session.run({ [input]: new ort.Tensor('float32', feats.data, [1, feats.frames, FBANK_BINS]) })
          prints[i] = Float32Array.from(result[output].data as Float32Array)
        }
      }
      done++
      opts.onProgress?.(done / stretches.length)
    }
  }
  return speakersOf(words, stretches, prints, opts)
}
