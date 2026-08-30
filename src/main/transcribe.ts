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

/** Fetches a model from the whisper.cpp model repository, reporting 0-100. */
export async function downloadModel(
  model: WhisperModel,
  onProgress: (percent: number) => void
): Promise<string> {
  const dest = modelPath(model)
  if (existsSync(dest)) return dest
  await fs.mkdir(join(app.getPath('userData'), 'models'), { recursive: true })

  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`
  const tmp = `${dest}.part`

  const response = await net.fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status}`)
  }

  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const out = createWriteStream(tmp)

  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    out.write(Buffer.from(value))
    if (total > 0) onProgress(Math.round((received / total) * 100))
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })

  await fs.rename(tmp, dest)
  onProgress(100)
  return dest
}

/** Whisper wants 16 kHz mono PCM; anything else is resampled internally anyway. */
async function extractAudio(videoPath: string, wavPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
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
    onProgress(5, 'Extracting audio')
    const wav = join(dir, 'audio.wav')
    await extractAudio(videoPath, wav)

    onProgress(15, 'Transcribing')
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
        '-np'
      ])
      let stderr = ''
      child.stderr.on('data', (d) => {
        const text = d.toString()
        stderr += text
        // whisper prints progress to stderr as it consumes the audio.
        const match = /progress\s*=\s*(\d+)%/.exec(text)
        if (match) onProgress(15 + Math.round(Number(match[1]) * 0.8), 'Transcribing')
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
