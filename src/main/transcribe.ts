import { spawn } from 'child_process'
import { promises as fs, createWriteStream, existsSync } from 'fs'
import { availableParallelism } from 'os'
import { join } from 'path'
import { app, net } from 'electron'
import { loudnessEnvelope } from './audio-envelope'
import { FFMPEG_PATH } from './ffmpeg'
import { helperScript, WHISPER_PATH } from './resources'
import { parseWhisperJson, secondPass, tokensToWords } from './whisper-parse'
import { voicedRegions } from '../shared/audio/voiced'
import { whisperArgs, type VerbatimOptions, type WhisperModel } from './whisper-args'
import type { Transcript, TranscriptWord } from '../shared/types'
import type { ToolSaid } from '../shared/failure'

export type { VerbatimOptions, WhisperModel }

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
export async function downloadModel(model: WhisperModel, onProgress: (percent: number) => void): Promise<string> {
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
    throw new Error(`Model download incomplete: ${Math.round(finalSize / 1e6)} of ${Math.round(total / 1e6)} MB.`)
  }

  await fs.rename(tmp, dest)
  onProgress(100)
  return dest
}

/** What ffmpeg says when a file has no sound to take, on 6.0, 6.1 and 7.0. */
const NO_SOUND = /does not contain any stream|matches no streams/i

/** Whisper wants 16 kHz mono PCM; anything else is resampled internally anyway. */
async function extractAudio(
  videoPath: string,
  wavPath: string,
  durationSec: number,
  onProgress: (percent: number) => void,
  startSec = 0
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
      // Both before -i, so the demuxer stops at the end of the window instead
      // of reading the rest of a two hour file to throw it away.
      ...(startSec > 0 ? ['-ss', startSec.toFixed(3)] : []),
      '-t',
      durationSec.toFixed(3),
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
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg exit ${code}`))))
  })
}

/**
 * Threads for whisper where it runs on the CPU, as on Windows: about one a
 * core (half the processors Windows counts, which counts each core twice),
 * no fewer than whisper-cli's own four where there are four, and at most
 * eight. Its default of four leaves most of a newer PC idle. A Mac's
 * whisper runs on its GPU and keeps the default.
 */
export function whisperThreads(platform = process.platform, processors = availableParallelism()): number | undefined {
  if (platform !== 'win32') return undefined
  return Math.max(Math.min(4, processors), Math.min(8, Math.floor(processors / 2)))
}

/** How Windows reports a program that ran an instruction the processor does not have. */
const ILLEGAL_INSTRUCTION = 0xc000001d

/** Runs whisper-cli to the end, reporting its progress from 0 to 100. */
function runWhisper(bin: string, args: string[], onProgress: (percent: number) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args)
    let stderr = ''
    // whisper prints a line per segment, and with -ml 1 that is one per word.
    // Nothing reading stdout means the 64KB pipe fills and the process blocks
    // forever at 0% CPU, which looks exactly like a hang.
    child.stdout.on('data', (d) => {
      const match = /progress\s*=\s*(\d+)%/.exec(d.toString())
      if (match) onProgress(Number(match[1]))
    })
    child.stderr.on('data', (d) => {
      const text = d.toString()
      stderr = (stderr + text).slice(-8000)
      // whisper prints progress to stderr as it consumes the audio.
      const match = /progress\s*=\s*(\d+)%/.exec(text)
      if (match) onProgress(Number(match[1]))
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      // Its last lines whole, without the progress it printed on the way.
      const lines = stderr
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.trim() && !/progress\s*=\s*\d+%/.test(l))
      const said = lines.slice(-12).join('\n') || `whisper-cli exited with code ${code}.`
      console.warn(`[stt] whisper stopped with code ${code}:\n${said}`)
      // whisper-cli for Windows is built for processors with AVX2, from about 2013 on.
      if (process.platform === 'win32' && code !== null && code >>> 0 === ILLEGAL_INSTRUCTION) {
        const why =
          'This PC’s processor is too old for the transcription model: it needs AVX2, which processors from before about 2013 lack.'
        reject(new WhisperFailed(said, why))
        return
      }
      reject(new WhisperFailed(said))
    })
  })
}

/**
 * Whisper stopped with an error. The message is a sentence anyone can read;
 * what whisper printed (a model that would not load, a file it could not
 * open) is kept in `said`, for Details (shared/failure).
 */
export class WhisperFailed extends Error implements ToolSaid {
  readonly tool = 'whisper'
  constructor(
    readonly said: string,
    message = 'The transcription model stopped before it finished.'
  ) {
    super(message)
    this.name = 'WhisperFailed'
  }
}

export async function transcribe(
  videoPath: string,
  model: WhisperModel,
  durationSec: number,
  onProgress: (percent: number, stage: string) => void,
  /**
   * Where the window starts in the source. Whisper only ever sees the extracted
   * window, so its timings start at zero and are shifted back onto the source
   * here — everything downstream addresses the original recording.
   */
  startSec = 0,
  verbatim?: VerbatimOptions
): Promise<Transcript> {
  const bin = WHISPER_PATH()
  if (!existsSync(bin)) {
    throw new Error(`whisper-cli is missing. Run ${helperScript('build-whisper')}.`)
  }
  const modelFile = modelPath(model)
  if (!existsSync(modelFile)) {
    throw new Error(`Model ${model} is not downloaded yet.`)
  }

  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-stt-'))
  try {
    const wav = join(dir, 'audio.wav')
    try {
      await extractAudio(
        videoPath,
        wav,
        durationSec,
        (p) => onProgress(Math.round(p * 0.12), 'Extracting audio'),
        startSec
      )
    } catch (err) {
      // A recording with no sound track has no words: none heard, rather than ffmpeg's own lines as the reply.
      if (err instanceof Error && NO_SOUND.test(err.message)) return { words: [], text: '', language: 'en' }
      throw err
    }

    onProgress(12, 'Transcribing')
    const prefix = join(dir, 'out')
    const until = verbatim && verbatim.again !== false ? 86 : 98
    const threads = whisperThreads()
    await runWhisper(bin, whisperArgs({ model, modelFile, wav, prefix, verbatim, threads }), (p) =>
      onProgress(12 + Math.round(p * ((until - 12) / 100)), 'Transcribing')
    )
    const json = parseWhisperJson(await fs.readFile(`${prefix}.json`))
    let heard = tokensToWords(json.transcription)

    if (verbatim && verbatim.again !== false && heard.length > 0) {
      // Listen again, alone, wherever there is voiced sound no word accounts
      // for: a take Whisper skipped, or swallowed into one stretched word.
      onProgress(until, 'Listening again')
      try {
        const voiced = voicedRegions(await loudnessEnvelope(FFMPEG_PATH, wav))
        let n = 0
        const pass = await secondPass(heard, voiced, async (span) => {
          const part = join(dir, `again-${++n}.wav`)
          await extractAudio(wav, part, span.endSec - span.startSec, () => undefined, span.startSec)
          const partPrefix = join(dir, `again-${n}`)
          await runWhisper(
            bin,
            whisperArgs({ model, modelFile, wav: part, prefix: partPrefix, verbatim, threads }),
            () => undefined
          )
          const again = tokensToWords(parseWhisperJson(await fs.readFile(`${partPrefix}.json`)).transcription)
          onProgress(Math.min(98, until + n), 'Listening again')
          return again.map((w) => ({ ...w, startSec: w.startSec + span.startSec, endSec: w.endSec + span.startSec }))
        })
        heard = pass.words
        if (pass.changed > 0) {
          console.log(`[stt] a second listen restored words in ${pass.changed} of ${pass.spans.length} places`)
        }
      } catch (err) {
        console.warn('[stt] the second listen failed, keeping the first:', err instanceof Error ? err.message : err)
      }
    }

    const words: TranscriptWord[] = heard.map((w) => ({
      text: w.text,
      startSec: w.startSec + startSec,
      endSec: w.endSec + startSec
    }))
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
