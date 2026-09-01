import { spawn } from 'child_process'
import { promises as fs, createWriteStream, existsSync } from 'fs'
import { join } from 'path'
import { app, net } from 'electron'
import { FFMPEG_PATH } from './ffmpeg'
import { WHISPER_PATH } from './resources'
import { tokensToWords } from './whisper-parse'
import type { Transcript, TranscriptWord } from '../shared/types'

export type WhisperModel = 'base.en' | 'small.en' | 'medium.en'

const MODEL_SIZES: Record<WhisperModel, number> = {
  'base.en': 148,
  'small.en': 488,
  'medium.en': 1533
}

export function modelPath(model: WhisperModel): string {
  return join(app.getPath('userData'), 'models', `ggml-${model}.bin`)
}

export function modelSizeMb(model: WhisperModel): number {
  return MODEL_SIZES[model]
}

export function hasModel(model: WhisperModel): boolean {
  return existsSync(modelPath(model))
}

/**
 * Fetches a model from the whisper.cpp model repository, reporting 0-100.
 *
 * Resumes a partial file rather than restarting it. These are hundreds of
 * megabytes and the download only lives as long as the app does, so quitting
 * mid-transfer is normal and should not cost the whole thing.
 */
export async function downloadModel(
  model: WhisperModel,
  onProgress: (percent: number) => void
): Promise<string> {
  const dest = modelPath(model)
  if (existsSync(dest)) return dest
  await fs.mkdir(join(app.getPath('userData'), 'models'), { recursive: true })

  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`
  const tmp = `${dest}.part`

  let have = 0
  try {
    have = (await fs.stat(tmp)).size
  } catch {
    have = 0
  }

  const response = await net.fetch(url, have > 0 ? { headers: { Range: `bytes=${have}-` } } : {})
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status}`)
  }

  // A server that ignores the range header sends 200 and the whole file, so the
  // partial has to be discarded rather than appended to.
  const resuming = response.status === 206
  if (!resuming) have = 0

  const remaining = Number(response.headers.get('content-length') ?? 0)
  const total = have + remaining
  let received = have

  const out = createWriteStream(tmp, resuming ? { flags: 'a' } : { flags: 'w' })
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    out.write(Buffer.from(value))
    if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)))
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })

  const finalSize = (await fs.stat(tmp)).size
  if (total > 0 && finalSize < total) {
    // Leave the partial in place so the next attempt can pick up where this
    // one stopped.
    throw new Error(
      `Model download incomplete: ${Math.round(finalSize / 1e6)} of ${Math.round(total / 1e6)} MB.`
    )
  }

  await fs.rename(tmp, dest)
  onProgress(100)
  return dest
}

/** Whisper wants 16 kHz mono PCM; anything else is resampled internally anyway. */
async function extractAudio(
  videoPath: string,
  wavPath: string,
  durationSec: number,
  onProgress: (percent: number) => void
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-nostats',
      '-y',
      '-i',
      videoPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      wavPath
    ])
    let stderr = ''
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const [key, value] = line.split('=')
        if (key === 'out_time_ms' && durationSec > 0) {
          const done = Number(value) / 1_000_000
          onProgress(Math.max(0, Math.min(100, (done / durationSec) * 100)))
        }
      }
    })
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exit ${code}`))
    )
  })
}

export async function transcribe(
  videoPath: string,
  model: WhisperModel,
  durationSec: number,
  onProgress: (percent: number, stage: string) => void
): Promise<Transcript> {
  const bin = WHISPER_PATH()
  if (!existsSync(bin)) {
    throw new Error('whisper-cli is missing. Run scripts/build-whisper.sh.')
  }
  const modelFile = modelPath(model)
  if (!existsSync(modelFile)) {
    throw new Error(`Model ${model} is not downloaded yet.`)
  }

  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-stt-'))
  try {
    const wav = join(dir, 'audio.wav')
    await extractAudio(videoPath, wav, durationSec, (p) =>
      onProgress(Math.round(p * 0.12), 'Extracting audio')
    )

    onProgress(12, 'Transcribing')
    const prefix = join(dir, 'out')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, [
        '-m',
        modelFile,
        '-f',
        wav,
        '-oj',
        '-of',
        prefix,
        // One token per segment is what yields real per-word timings; without it
        // whisper spreads words evenly across a whole segment.
        '-ml',
        '1',
        // A token is not a word: alone, -ml 1 cuts "epileptic" into "epile" and
        // "ptic", and each fragment becomes its own caption. Splitting on word
        // boundaries instead is what makes word-level captions read as speech.
        // (-dtw was measured here too and changed no timing at all, so it is
        // not worth the memory it costs.)
        '-sow',
        // --print-progress is the only way to see how far along a long file is.
        // -np would suppress it along with everything else.
        '-pp'
      ])
      let stderr = ''
      // whisper prints a line per segment, and with -ml 1 that is one per word.
      // Nothing reading stdout means the 64KB pipe fills and the process blocks
      // forever at 0% CPU, which looks exactly like a hang.
      child.stdout.on('data', (d) => {
        const match = /progress\s*=\s*(\d+)%/.exec(d.toString())
        if (match) onProgress(12 + Math.round(Number(match[1]) * 0.86), 'Transcribing')
      })
      child.stderr.on('data', (d) => {
        const text = d.toString()
        stderr += text
        // whisper prints progress to stderr as it consumes the audio.
        const match = /progress\s*=\s*(\d+)%/.exec(text)
        if (match) onProgress(12 + Math.round(Number(match[1]) * 0.86), 'Transcribing')
      })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-400) || `whisper exit ${code}`))
      )
    })

    const json = JSON.parse(await fs.readFile(`${prefix}.json`, 'utf8'))
    const words = tokensToWords(json.transcription ?? [])
    onProgress(100, 'Done')

    return {
      words,
      text: words.map((w) => w.text).join(' '),
      language: json.result?.language ?? 'en'
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
