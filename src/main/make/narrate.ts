import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { MakeFormat, VoiceChoice } from '../../shared/make/schema'
import type { MakeServices, TimedWord } from './services'

/**
 * The narration, read in the chosen voice into one WAV file the edit is cut
 * from: Kokoro on this Mac one phrase at a time, or a service a section at a
 * time (each has its own limit on how much it reads at once). Pauses are put
 * between phrases and a longer breath between sections, so the cut has room
 * to dissolve. ElevenLabs' word timings come back with the sound and are
 * carried across the joins; the other voices are listened to afterwards.
 */

/** The sample rate every narration is written at. */
export const NARRATION_RATE = 48_000

/** Silence after a phrase, and between sections, in seconds. */
const PHRASE_GAP = 0.32
const SECTION_GAP = 0.8

/** Characters a service is given in one request: under every one's limit (OpenAI's is 4,096). */
const MAX_CHUNK_CHARS = 2400

/** How each format is read, for the voices that take directions. */
export const READING: Record<MakeFormat, string> = {
  documentary:
    'Read as a documentary narrator: calm, measured and warm, unhurried, with weight on dates and names and a breath between sentences.',
  explainer: 'Read as a friendly explainer narrator: bright, clear and conversational, with a smile in the voice, never rushed.'
}

/** A voice that runs on this Mac (main/make/kokoro.ts). */
export interface LocalVoice {
  /** Whether the model and the voice are downloaded already. */
  ready(voice: string): Promise<boolean>
  /** Downloads what is missing, reporting 0 to 1. */
  prepare(voice: string, onProgress: (fraction: number) => void, signal?: AbortSignal): Promise<void>
  /** One phrase as mono samples. */
  speak(text: string, voice: string, signal?: AbortSignal): Promise<{ samples: Float32Array; rate: number }>
}

export interface NarrateDeps {
  services: MakeServices
  local: LocalVoice
  ffmpeg: string
  dir: string
  signal?: AbortSignal
  onProgress?: (fraction: number, stage: string) => void
}

export interface Narrated {
  path: string
  durationSec: number
  /** The words with their times, when the voice gave them; null when they must be heard. */
  words: TimedWord[] | null
}

/** Any sound file's bytes as 16-bit mono samples at the narration's rate, by ffmpeg. */
export function decodeToPcm(ffmpeg: string, bytes: Uint8Array, signal?: AbortSignal): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(NARRATION_RATE), 'pipe:1'],
      { signal, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited with ${code}`))
      const all = Buffer.concat(out)
      resolve(new Int16Array(all.buffer, all.byteOffset, Math.floor(all.length / 2)))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(Buffer.from(bytes))
  })
}

/** Float samples at any rate as 16-bit at the narration's rate, by plain linear resampling. */
export function toPcm(samples: Float32Array, rate: number): Int16Array {
  const n = Math.round((samples.length * NARRATION_RATE) / rate)
  const out = new Int16Array(n)
  const k = rate / NARRATION_RATE
  for (let i = 0; i < n; i++) {
    const x = i * k
    const i0 = Math.floor(x)
    const f = x - i0
    const a = samples[i0] ?? 0
    const b = samples[i0 + 1] ?? a
    const v = Math.max(-1, Math.min(1, a + (b - a) * f))
    out[i] = Math.round(v * 32767)
  }
  return out
}

/** A 16-bit mono WAV file of samples at the narration's rate. */
export function wavBytes(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(NARRATION_RATE, 24)
  header.writeUInt32LE(NARRATION_RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/** The phrases grouped as a service reads them: by section, and never more than its limit at once. */
export function chunksOf(phrases: string[], sections: number[]): { text: string; phrases: number[]; section: boolean }[] {
  const starts = new Set(sections)
  const chunks: { text: string; phrases: number[]; section: boolean }[] = []
  phrases.forEach((p, i) => {
    const last = chunks[chunks.length - 1]
    if (!last || starts.has(i) || last.text.length + p.length + 1 > MAX_CHUNK_CHARS)
      chunks.push({ text: p, phrases: [i], section: starts.has(i) && i > 0 })
    else {
      last.text += ` ${p}`
      last.phrases.push(i)
    }
  })
  return chunks
}

const silence = (sec: number): Int16Array => new Int16Array(Math.round(sec * NARRATION_RATE))

function join16(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Reads the narration and writes it to the edit's folder. */
export async function narrate(
  input: { phrases: string[]; sections: number[]; voice: VoiceChoice; format: MakeFormat },
  deps: NarrateDeps
): Promise<Narrated> {
  const { voice } = input
  const report = deps.onProgress ?? (() => undefined)
  const parts: Int16Array[] = []
  let words: TimedWord[] | null = null
  let clock = 0
  const push = (pcm: Int16Array): void => {
    parts.push(pcm)
    clock += pcm.length / NARRATION_RATE
  }

  if (voice.engine === 'local') {
    if (!(await deps.local.ready(voice.id)))
      await deps.local.prepare(voice.id, (f) => report(f * 0.3, 'Downloading the voice'), deps.signal)
    const starts = new Set(input.sections)
    for (const [i, phrase] of input.phrases.entries()) {
      if (deps.signal?.aborted) throw new Error('Stopped.')
      if (i > 0) push(silence(starts.has(i) ? SECTION_GAP : PHRASE_GAP))
      const spoken = await deps.local.speak(phrase, voice.id, deps.signal)
      push(toPcm(spoken.samples, spoken.rate))
      report(0.3 + (0.7 * (i + 1)) / input.phrases.length, 'Reading the script')
    }
  } else if (voice.engine === 'elevenlabs' || voice.engine === 'gemini' || voice.engine === 'openai') {
    const chunks = chunksOf(input.phrases, input.sections)
    words = voice.engine === 'elevenlabs' ? [] : null
    let voiceId = voice.id
    // An ElevenLabs voice named rather than given by id is found in the account's list.
    if (voice.engine === 'elevenlabs' && !/^[A-Za-z0-9]{20}$/.test(voiceId))
      voiceId = (await deps.services.elevenVoice(voice.name, deps.signal)) ?? voiceId
    for (const [k, chunk] of chunks.entries()) {
      if (deps.signal?.aborted) throw new Error('Stopped.')
      if (k > 0) push(silence(chunk.section ? SECTION_GAP : PHRASE_GAP))
      let audio: Uint8Array
      if (voice.engine === 'elevenlabs') {
        const said = await deps.services.elevenlabs(
          voiceId,
          chunk.text,
          { previous: chunks[k - 1]?.text, next: chunks[k + 1]?.text },
          deps.signal
        )
        audio = said.audio
        const offset = clock
        words?.push(...said.words.map((w) => ({ text: w.text, startSec: w.startSec + offset, endSec: w.endSec + offset })))
      } else if (voice.engine === 'gemini') {
        audio = await deps.services.gemini(chunk.text, voice.id, READING[input.format], deps.signal)
      } else {
        audio = await deps.services.openai(chunk.text, voice.id, READING[input.format], deps.signal)
      }
      push(await decodeToPcm(deps.ffmpeg, audio, deps.signal))
      report((k + 1) / chunks.length, 'Reading the script')
    }
  } else {
    throw new Error('Your own recording is the narration as it is; there is nothing to read.')
  }
  // A short tail of room, so the last word is never clipped by the fade.
  push(silence(0.6))
  const pcm = join16(parts)
  await fs.mkdir(deps.dir, { recursive: true })
  const name = createHash('sha256')
    .update(`${voice.engine}\u0000${voice.id}\u0000${input.phrases.join('\n')}`)
    .digest('hex')
    .slice(0, 16)
  const path = join(deps.dir, `narration-${name}.wav`)
  await fs.writeFile(path, wavBytes(pcm))
  return { path, durationSec: pcm.length / NARRATION_RATE, words }
}
