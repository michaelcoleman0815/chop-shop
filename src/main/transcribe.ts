import { join } from 'path'
import { loudnessEnvelope } from './audio-envelope'
import { FILLER_PROMPT, listenForFillers, readSamples } from './filler-listen'
import { platform } from './platform'
import { parseWhisperJson, secondPass, tokensToWords } from './whisper-parse'
import { voicedRegions } from '../shared/audio/voiced'
import { whisperArgs, type VerbatimOptions, type WhisperModel } from './whisper-args'
import type { Transcript, TranscriptWord } from '../shared/types'
import type { ToolSaid } from '../shared/failure'

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

/**
 * Threads for whisper where it runs on the CPU, as on Windows: about one a
 * core (half the processors Windows counts, which counts each core twice),
 * no fewer than whisper-cli's own four where there are four, and at most
 * eight. Its default of four leaves most of a newer PC idle. A Mac's
 * whisper runs on its GPU and keeps the default, and a phone's is built in
 * with its own. `os` is the platform's, as Node names it.
 */
export function whisperThreads(os: string, processors: number): number | undefined {
  if (os !== 'win32') return undefined
  return Math.max(Math.min(4, processors), Math.min(8, Math.floor(processors / 2)))
}

/** How Windows reports a program that ran an instruction the processor does not have. */
const ILLEGAL_INSTRUCTION = 0xc000001d

/** Runs whisper to the end, reporting its progress from 0 to 100. */
async function runWhisper(bin: string, args: string[], onProgress: (percent: number) => void): Promise<void> {
  let stderr = ''
  // whisper prints a line per segment, and with -ml 1 that is one per word.
  // Everything it writes is read as it comes: a pipe nobody reads fills, and
  // the process blocks forever at 0% CPU, which looks exactly like a hang.
  const host = platform()
  const r = await host.run(bin, args, {
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
  if (r.code !== 0) {
    // Its last lines whole, without the progress it printed on the way.
    const lines = stderr
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() && !/progress\s*=\s*\d+%/.test(l))
    const said = lines.slice(-12).join('\n') || `whisper-cli exited with code ${r.code}.`
    console.warn(`[stt] whisper stopped with code ${r.code}:\n${said}`)
    // whisper-cli for Windows is built for processors with AVX2, from about 2013 on.
    if (host.os === 'win32' && r.code !== null && r.code >>> 0 === ILLEGAL_INSTRUCTION) {
      const why =
        'This PC’s processor is too old for the transcription model: it needs AVX2, which processors from before about 2013 lack.'
      throw new WhisperFailed(said, why)
    }
    throw new WhisperFailed(said)
  }
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
  const host = platform()
  const bin = host.tool('whisper')
  // A computer runs whisper-cli from the app's resources; a phone has it built in.
  if (host.kind === 'computer' && !(await host.files.stat(bin))) {
    // What builds it, as helperScript in resources.ts says: its script on a Mac, its Node twin on Windows.
    const script = host.os === 'win32' ? 'node scripts/build-whisper.mjs' : 'scripts/build-whisper.sh'
    throw new Error(`whisper-cli is missing. Run ${script}.`)
  }
  const modelFile = modelPath(model)
  if (!(await host.files.stat(modelFile))) {
    throw new Error(`Model ${model} is not downloaded yet.`)
  }

  const dir = await host.files.tempDir('chopshop-stt-')
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
    const threads = whisperThreads(host.os, host.processors)
    await runWhisper(bin, whisperArgs({ model, modelFile, wav, prefix, verbatim, threads }), (p) =>
      onProgress(12 + Math.round(p * ((until - 12) / 100)), 'Transcribing')
    )
    const json = parseWhisperJson(await host.files.readText(`${prefix}.json`))
    let heard = tokensToWords(json.transcription)

    if (verbatim && verbatim.again !== false && heard.length > 0) {
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
            whisperArgs({ model, modelFile, wav: part, prefix: partPrefix, verbatim, threads }),
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
        // Then every um, hmm and uh still unwritten, heard in the sound and by Whisper alone (main/filler-listen).
        onProgress(98, 'Listening for ums')
        let m = 0
        const fillers = await listenForFillers(heard, voiced, {
          samples: (span) => readSamples(host.tool('ffmpeg'), wav, span),
          listen: async (span) => {
            const part = join(dir, `um-${++m}.wav`)
            await extractAudio(wav, part, span.endSec - span.startSec, () => undefined, span.startSec)
            const partPrefix = join(dir, `um-${m}`)
            await runWhisper(
              bin,
              whisperArgs({
                model,
                modelFile,
                wav: part,
                prefix: partPrefix,
                verbatim: { ...verbatim, prompt: FILLER_PROMPT },
                threads
              }),
              () => undefined
            )
            const alone = tokensToWords(parseWhisperJson(await host.files.readText(`${partPrefix}.json`)).transcription)
            return alone.map((w) => ({ ...w, startSec: w.startSec + span.startSec, endSec: w.endSec + span.startSec }))
          }
        })
        if (fillers.length > 0) {
          heard = [...heard, ...fillers].sort((a, b) => a.startSec - b.startSec)
          console.log(`[stt] heard ${fillers.length} filler${fillers.length === 1 ? '' : 's'} Whisper left out`)
        }
      } catch (err) {
        console.warn('[stt] the second listen failed, keeping the first:', err instanceof Error ? err.message : err)
      }
    }

    // whisper can let the last word run on past the end of the sound: no word ends after the audio does.
    const length = durationSec > 0 ? durationSec : Infinity
    const words: TranscriptWord[] = heard.map((w) => {
      const end = Math.min(w.endSec, length)
      return { text: w.text, startSec: Math.min(w.startSec, end) + startSec, endSec: end + startSec }
    })
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
