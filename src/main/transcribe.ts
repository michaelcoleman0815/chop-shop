import { join } from 'path'
import { loudnessEnvelope } from './audio-envelope'
import { platform } from './platform'
import { parseWhisperJson, secondPass, tokensToWords } from './whisper-parse'
import { voicedRegions } from '../shared/audio/voiced'
import { whisperArgs, type VerbatimOptions, type WhisperModel } from './whisper-args'
import type { Transcript, TranscriptWord } from '../shared/types'

export type { VerbatimOptions, WhisperModel }

/**
 * Transcription with whisper.cpp, on the machine itself: a program on a Mac,
 * built into the app on a phone. The arguments, the reading of what it
 * writes and the second listen are the same on both (platform.ts).
 */

const MODEL_SIZES: Record<WhisperModel, number> = {
  'base.en': 148,
  'small.en': 488,
  'medium.en': 1533
}

/** Where whisper.cpp publishes its models. */
export const MODEL_URL = (model: WhisperModel): string =>
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`

export function modelPath(model: WhisperModel): string {
  return join(platform().paths.userData(), 'models', `ggml-${model}.bin`)
}

export function modelSizeMb(model: WhisperModel): number {
  return MODEL_SIZES[model]
}

export async function hasModel(model: WhisperModel): Promise<boolean> {
  return (await platform().files.stat(modelPath(model))) !== null
}

/**
 * Fetches a model from the whisper.cpp model repository, reporting 0-100.
 *
 * Resumes a partial file rather than restarting it where the platform can.
 * These are hundreds of megabytes and the download only lives as long as the
 * app does, so quitting mid-transfer is normal and should not cost the whole thing.
 */
export async function downloadModel(model: WhisperModel, onProgress: (percent: number) => void): Promise<string> {
  const dest = modelPath(model)
  if (await hasModel(model)) return dest
  await platform().files.mkdir(join(platform().paths.userData(), 'models'))
  await platform().download(MODEL_URL(model), dest, onProgress)
  onProgress(100)
  return dest
}

/** Whisper wants 16 kHz mono PCM; anything else is resampled internally anyway. */
async function extractAudio(
  videoPath: string,
  wavPath: string,
  durationSec: number,
  onProgress: (percent: number) => void,
  startSec = 0
): Promise<void> {
  let stderr = ''
  const r = await platform().run(
    platform().tool('ffmpeg'),
    [
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
    ],
    {
      onStdout: (text) => {
        for (const line of text.split('\n')) {
          const [key, value] = line.split('=')
          if (key === 'out_time_ms' && durationSec > 0) {
            const done = Number(value) / 1_000_000
            onProgress(Math.max(0, Math.min(100, (done / durationSec) * 100)))
          }
        }
      },
      onStderr: (text) => (stderr += text)
    }
  )
  if (r.code !== 0) throw new Error(stderr.trim() || `ffmpeg exit ${r.code}`)
}

/** Runs whisper to the end, reporting its progress from 0 to 100. */
async function runWhisper(bin: string, args: string[], onProgress: (percent: number) => void): Promise<void> {
  let stderr = ''
  // whisper prints a line per segment, and with -ml 1 that is one per word.
  // Everything it writes is read as it comes: a pipe nobody reads fills, and
  // the process blocks forever at 0% CPU, which looks exactly like a hang.
  const r = await platform().run(bin, args, {
    onStdout: (text) => {
      const match = /progress\s*=\s*(\d+)%/.exec(text)
      if (match) onProgress(Number(match[1]))
    },
    onStderr: (text) => {
      stderr = (stderr + text).slice(-8000)
      // whisper prints progress to stderr as it consumes the audio.
      const match = /progress\s*=\s*(\d+)%/.exec(text)
      if (match) onProgress(Number(match[1]))
    }
  })
  if (r.code !== 0) throw new Error(stderr.trim().slice(-400) || `whisper exit ${r.code}`)
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
  const host = platform()
  const bin = host.tool('whisper')
  // A computer runs whisper-cli from the app's resources; a phone has it built in.
  if (host.kind === 'computer' && !(await host.files.stat(bin))) {
    throw new Error('whisper-cli is missing. Run scripts/build-whisper.sh.')
  }
  const modelFile = modelPath(model)
  if (!(await host.files.stat(modelFile))) {
    throw new Error(`Model ${model} is not downloaded yet.`)
  }

  const dir = await host.files.tempDir('chopshop-stt-')
  try {
    const wav = join(dir, 'audio.wav')
    await extractAudio(
      videoPath,
      wav,
      durationSec,
      (p) => onProgress(Math.round(p * 0.12), 'Extracting audio'),
      startSec
    )

    onProgress(12, 'Transcribing')
    const prefix = join(dir, 'out')
    const until = verbatim ? 86 : 98
    await runWhisper(bin, whisperArgs({ model, modelFile, wav, prefix, verbatim }), (p) =>
      onProgress(12 + Math.round(p * ((until - 12) / 100)), 'Transcribing')
    )
    const json = parseWhisperJson(await host.files.readText(`${prefix}.json`))
    let heard = tokensToWords(json.transcription)

    if (verbatim && heard.length > 0) {
      // Listen again, alone, wherever there is voiced sound no word accounts
      // for: a take Whisper skipped, or swallowed into one stretched word.
      onProgress(until, 'Listening again')
      try {
        const voiced = voicedRegions(await loudnessEnvelope(host.tool('ffmpeg'), wav))
        let n = 0
        const pass = await secondPass(heard, voiced, async (span) => {
          const part = join(dir, `again-${++n}.wav`)
          await extractAudio(wav, part, span.endSec - span.startSec, () => undefined, span.startSec)
          const partPrefix = join(dir, `again-${n}`)
          await runWhisper(
            bin,
            whisperArgs({ model, modelFile, wav: part, prefix: partPrefix, verbatim }),
            () => undefined
          )
          const again = tokensToWords(parseWhisperJson(await host.files.readText(`${partPrefix}.json`)).transcription)
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
    await host.files.remove(dir).catch(() => undefined)
  }
}
