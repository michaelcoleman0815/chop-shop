import { readFilledPause, unwordedStretches } from '../shared/audio/filled-pause'
import type { Span } from '../shared/audio/voiced'
import { isFiller } from '../shared/fillers'
import { FloatReader, platform } from './platform'
import type { HeardWord } from './whisper-parse'

/**
 * Every um, hmm and uh, heard on this computer for nothing: the free way to
 * what a paid transcriber writes down.
 *
 * After Whisper and its second listen, what is left is voiced sound no word
 * accounts for. Measured on the owner's own footage (docs/research/raw-footage.md,
 * "Fillers heard in the sound"), most of it is the edge of a word already
 * written, a breath, or a short noise Whisper calls "Yeah"; a few are fillers
 * it left out. So each stretch gets two votes:
 *
 * - The sound: unvoiced (a breath, a click, noise) is never a filler, and a
 *   vowel held steady at one pitch is one, whatever Whisper says (a long "uhhh").
 * - Whisper, listening to that stretch alone with fillers in its prompt: only
 *   a lone filler sound ("Hmm.", "Um.") is taken. A real word there is the
 *   edge of a word already written, and is left alone.
 */

/** The prompt for listening to a stretch alone: fillers written as said, so Whisper writes them too. */
export const FILLER_PROMPT = 'Um, uh, so, uh, I mean, um, hmm.'

export interface FillerListenOptions {
  /** Stretches looked at, at most, so a long noisy recording never takes long. */
  maxStretches: number
  /** Below this share of voiced frames, a stretch is breath or noise. */
  minVoiced: number
  /**
   * Seconds the listening may take, at most; the stretches after it are left
   * as they are. Each listen is a Whisper run of its own, which on a phone
   * can take seconds, so the transcript's own pass sets it (main/transcribe).
   */
  budgetSec?: number
}

export const DEFAULT_FILLER_LISTEN: FillerListenOptions = { maxStretches: 200, minVoiced: 0.5 }

/** A filler as written into the transcript: lowercase, its letters only. */
const fillerText = (text: string): string => text.toLowerCase().replace(/[^a-z]/g, '')

/**
 * The fillers to add to a transcript: never where a word already is, each
 * timed to the held part of its stretch.
 */
export async function listenForFillers(
  words: HeardWord[],
  voiced: Span[],
  deps: {
    /** The recording's samples over a span, 16 kHz mono. */
    samples: (span: Span) => Promise<Float32Array>
    /** Whisper on that span alone, with FILLER_PROMPT, its words on the span's clock. */
    listen: (span: Span) => Promise<HeardWord[]>
    rate?: number
    /** The clock, in milliseconds. */
    now?: () => number
  },
  opts: FillerListenOptions = DEFAULT_FILLER_LISTEN
): Promise<HeardWord[]> {
  const rate = deps.rate ?? 16000
  const stretches = unwordedStretches(words, voiced, { marginSec: 0.06, minSec: 0.15, maxSec: 1.6 }).slice(
    0,
    opts.maxStretches
  )
  const found: HeardWord[] = []
  const now = deps.now ?? Date.now
  const began = now()
  for (const s of stretches) {
    if (opts.budgetSec !== undefined && (now() - began) / 1000 >= opts.budgetSec) {
      console.log(`[stt] stopped listening for ums at ${s.startSec.toFixed(1)} s, out of time`)
      break
    }
    let reading
    try {
      reading = readFilledPause(await deps.samples(s), rate)
    } catch {
      continue
    }
    // Breath, a click, noise: not a voice, so not a filler, whatever Whisper would make of it.
    if (reading.voiced < opts.minVoiced || reading.endSec <= reading.startSec) continue
    const held = { startSec: s.startSec + reading.startSec, endSec: s.startSec + reading.endSec }
    if (reading.filled) {
      found.push({ text: reading.text, ...held, p: reading.confidence })
      continue
    }
    let heard: HeardWord[]
    try {
      heard = await deps.listen({ startSec: Math.max(0, s.startSec - 0.15), endSec: s.endSec + 0.15 })
    } catch {
      continue
    }
    const said = heard.filter((w) => fillerText(w.text).length > 0)
    if (said.length === 1 && isFiller(said[0].text)) found.push({ text: fillerText(said[0].text), ...held, p: said[0].p })
  }
  return found
}

/** A recording's samples over a span, as ffmpeg decodes them: 16 kHz mono floats. */
export async function readSamples(ffmpeg: string, path: string, span: Span): Promise<Float32Array> {
  const floats = new FloatReader()
  const parts: Float32Array[] = []
  const r = await platform().run(
    ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      '-ss',
      Math.max(0, span.startSec).toFixed(3),
      '-t',
      Math.max(0.01, span.endSec - span.startSec).toFixed(3),
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'f32le',
      '-'
    ],
    { onBytes: (chunk) => void parts.push(floats.push(chunk)) }
  )
  if (r.code !== 0) throw new Error(`ffmpeg exited with ${r.code}`)
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
