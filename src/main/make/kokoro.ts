import { createWriteStream, existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { G2P, loadLexicon } from './g2p'
import type { LocalVoice } from './narrate'

/**
 * Kokoro-82M (Apache-2.0) reading on this Mac with onnxruntime-node (MIT):
 * free, offline once downloaded, and nothing of the script goes anywhere.
 *
 * The model, its tokenizer and each voice are downloaded from Hugging Face
 * on first use, with progress, into Cutalong's own folder, and kept. The
 * words become phonemes here (g2p.ts, misaki's lexicons) rather than with
 * eSpeak, which is GPL. Each phrase is read on its own: input_ids are the
 * phonemes' ids with 0 at each end, style is the voice's row for that many
 * phonemes, and the model answers a 24 kHz waveform, the way kokoro-js
 * feeds the same export.
 *
 * Sources:
 *   https://huggingface.co/hexgrad/Kokoro-82M (weights and voices, Apache-2.0)
 *   https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX (the ONNX export, its tokenizer, voices/*.bin)
 *   https://github.com/hexgrad/misaki (the lexicons in resources/voices, Apache-2.0)
 *   https://onnxruntime.ai/docs/get-started/with-javascript/node.html
 */

export const KOKORO_REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main'

/** The 8-bit model: a quarter the size of the full one, read at the same speed or better on a CPU. */
export const KOKORO_MODEL = 'onnx/model_quantized.onnx'

/** The rate Kokoro reads at. */
export const KOKORO_RATE = 24_000

/** Phonemes the model takes at once, the two ends aside. */
const MAX_PHONEMES = 510

/** Each voice file is 510 rows of a 256-number style, one row for each phoneme count. */
const STYLE = 256

interface TensorLike {
  data: Float32Array | ArrayLike<number>
}
interface SessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, TensorLike>>
}
/** What Cutalong uses of onnxruntime-node, so tests can hand in their own. */
export interface Ort {
  InferenceSession: { create(path: string): Promise<SessionLike> }
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown
}

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>

export interface KokoroDeps {
  /** onnxruntime-node, loaded when first needed. */
  ort?: () => Promise<Ort>
  /** Electron's net.fetch in the app. */
  fetch?: Fetch
  /** Where misaki's lexicons are: resources/voices. */
  lexicons: string
}

/** The phonemes' ids by the tokenizer's vocabulary: the tokenizer.json model's vocab, or a config's. */
export function readVocab(json: unknown): Map<string, number> {
  const j = json as { model?: { vocab?: Record<string, number> }; vocab?: Record<string, number> }
  const vocab = j.model?.vocab ?? j.vocab
  if (!vocab || typeof vocab !== 'object') throw new Error('The voice’s tokenizer has no vocabulary.')
  return new Map(Object.entries(vocab).filter(([, id]) => Number.isInteger(id)))
}

/** Phonemes as the model's ids, 0 at each end; symbols it does not know are left out. */
export function idsFor(phonemes: string, vocab: Map<string, number>): number[] {
  const ids: number[] = [0]
  for (const ch of [...phonemes].slice(0, MAX_PHONEMES)) {
    const id = vocab.get(ch)
    if (id !== undefined) ids.push(id)
  }
  ids.push(0)
  return ids
}

/** The voice's style for a phrase of this many phonemes. */
export function styleFor(voice: Float32Array, phonemes: number): Float32Array {
  const rows = Math.floor(voice.length / STYLE)
  const row = Math.min(Math.max(phonemes, 0), rows - 1)
  return voice.slice(row * STYLE, row * STYLE + STYLE)
}

/** Downloads one file to `dest`, resuming a partial one, reporting 0 to 1. */
async function download(fetch: Fetch, url: string, dest: string, onProgress: (f: number) => void, signal?: AbortSignal): Promise<void> {
  if (existsSync(dest)) return
  const tmp = `${dest}.part`
  let have = 0
  try {
    have = (await fs.stat(tmp)).size
  } catch {
    have = 0
  }
  const res = await fetch(url, { ...(have > 0 ? { headers: { Range: `bytes=${have}-` } } : {}), signal })
  if (!res.ok || !res.body) throw new Error(`The voice could not be downloaded (HTTP ${res.status}).`)
  const resuming = res.status === 206
  if (!resuming) have = 0
  const total = have + Number(res.headers.get('content-length') ?? 0)
  let got = have
  const out = createWriteStream(tmp, { flags: resuming ? 'a' : 'w' })
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      got += value.byteLength
      if (!out.write(Buffer.from(value))) await new Promise<void>((r) => out.once('drain', () => r()))
      if (total > 0) onProgress(Math.min(0.99, got / total))
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end(() => resolve())
      out.on('error', reject)
    })
  }
  await fs.rename(tmp, dest)
}

/** onnxruntime-node, when this build has it. */
async function loadOrt(): Promise<Ort> {
  try {
    // A runtime dependency with a native binary: loaded only when a voice on this Mac first reads.
    const name = 'onnxruntime-node'
    return (await import(/* @vite-ignore */ name)) as unknown as Ort
  } catch {
    throw new Error('The voice on this Mac needs onnxruntime-node, which is missing from this build.')
  }
}

/** Kokoro on this Mac, keeping its files in `dir`. */
export function kokoroVoice(dir: string, deps: KokoroDeps): LocalVoice {
  const files = (voice: string): string[] => [join(dir, 'kokoro-q8.onnx'), join(dir, 'tokenizer.json'), join(dir, `${voice}.bin`)]
  let session: Promise<SessionLike> | null = null
  let vocab: Map<string, number> | null = null
  const g2p = new Map<'us' | 'gb', G2P>()
  const voices = new Map<string, Float32Array>()

  const ready = async (voice: string): Promise<boolean> => files(voice).every((f) => existsSync(f))

  return {
    ready,
    async prepare(voice, onProgress, signal) {
      if (!/^[a-z]{2}_[a-z]+$/.test(voice)) throw new Error('That is not one of the voices on this Mac.')
      if (!deps.fetch) throw new Error('The voice on this Mac is not downloaded yet.')
      await fs.mkdir(dir, { recursive: true })
      const [model, tokenizer, pack] = files(voice)
      // The model is most of it: 90 of every 100 parts.
      await download(deps.fetch, `${KOKORO_REPO}/${KOKORO_MODEL}`, model, (f) => onProgress(f * 0.9), signal)
      await download(deps.fetch, `${KOKORO_REPO}/tokenizer.json`, tokenizer, () => undefined, signal)
      await download(deps.fetch, `${KOKORO_REPO}/voices/${voice}.bin`, pack, (f) => onProgress(0.9 + f * 0.1), signal)
      onProgress(1)
    },
    async speak(text, voice, signal) {
      if (!(await ready(voice))) throw new Error('The voice on this Mac is not downloaded yet.')
      if (signal?.aborted) throw new Error('Stopped.')
      const ort = await (deps.ort ?? loadOrt)()
      const [model, tokenizer, pack] = files(voice)
      session ??= ort.InferenceSession.create(model)
      vocab ??= readVocab(JSON.parse(await fs.readFile(tokenizer, 'utf8')))
      const lang = voice.startsWith('b') ? 'gb' : 'us'
      let reader = g2p.get(lang)
      if (!reader) {
        reader = new G2P(loadLexicon(join(deps.lexicons, `misaki-${lang}.json.gz`)), lang === 'gb')
        g2p.set(lang, reader)
      }
      let style = voices.get(voice)
      if (!style) {
        const buf = await fs.readFile(pack)
        style = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
        voices.set(voice, style)
      }
      const ids = idsFor(reader.phonemes(text), vocab)
      const feeds = {
        input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
        style: new ort.Tensor('float32', styleFor(style, ids.length - 2), [1, STYLE]),
        speed: new ort.Tensor('float32', Float32Array.from([1]), [1])
      }
      const out = await (await session).run(feeds)
      const wave = out.waveform ?? Object.values(out)[0]
      if (!wave) throw new Error('The voice on this Mac read nothing.')
      return { samples: Float32Array.from(wave.data as ArrayLike<number>), rate: KOKORO_RATE }
    }
  }
}
