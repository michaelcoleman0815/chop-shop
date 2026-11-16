import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Test fixtures for learning from edits, and only that: nothing in the app
 * imports this file.
 *
 * The raw recordings are speech made with espeak-ng one word at a time and
 * laid out with known gaps, so every word's start and end is known to the
 * sample. They are checked in, small, under learn-fixtures/, with their word
 * lists, so the tests run on any computer with ffmpeg. Finished videos are
 * cut from them at test time by planted edit lists, with a music bed, sound
 * effects, a loudness change, a compressor and short fades or a crossfade at
 * the cuts, so every label the alignment recovers can be checked.
 *
 * To make the recordings again (needs espeak-ng): npm run fixtures:learn
 */

export const RATE = 22050
export const FIXTURES = join(__dirname, 'learn-fixtures')

export function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    candidates.splice(1, 0, require('ffmpeg-static') as string)
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

/** espeak-ng from the PATH, or null when it is not installed. */
export function findEspeak(): string | null {
  return spawnSync('espeak-ng', ['--version']).status === 0 ? 'espeak-ng' : null
}

export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

// ---------- The scripts ----------

export interface Voice {
  speed: number
  pitch: number
  variant?: string
}

/**
 * a is the creator's usual delivery; b and c are other takes of a line by the
 * same voice, a little slower and higher or faster and lower; d is someone
 * else. Every word is also said a little differently each time (see
 * buildSpeech), the way nobody says a word the same way twice.
 */
export const VOICES: Record<string, Voice> = {
  a: { speed: 165, pitch: 45 },
  b: { speed: 156, pitch: 52 },
  c: { speed: 174, pitch: 39 },
  d: { speed: 160, pitch: 55, variant: 'f3' }
}

export interface ScriptLine {
  text: string
  voice: keyof typeof VOICES
  /** Silence after the line, before the next. */
  pause: number
  /** A breath in the middle of that pause. */
  breath?: boolean
}

/**
 * A tech video's raw take: retakes with no spoken cue, a restart that backs
 * up a few words, ums, long pauses and breaths.
 */
export const TALK: ScriptLine[] = [
  {
    text: 'So today I want to show you the one setting I change on every camera.',
    voice: 'a',
    pause: 0.9,
    breath: true
  },
  { text: 'Um, most people never open the settings menu.', voice: 'a', pause: 0.52, breath: true },
  { text: "That's where the good stuff is.", voice: 'a', pause: 1.5, breath: true },
  { text: 'Here is the one I change before I shoot anything.', voice: 'b', pause: 1.1 },
  { text: 'Here is the one I change before I shoot anything.', voice: 'a', pause: 0.6 },
  { text: 'Turn off auto exposure, lock it, and your face', voice: 'a', pause: 0.7 },
  { text: 'lock it, and your face stops pulsing every time you move.', voice: 'a', pause: 0.8, breath: true },
  {
    text: 'It sounds small, uh, but it is the difference between footage that looks cheap and footage that looks shot.',
    voice: 'a',
    pause: 1.2
  },
  { text: 'The second setting is shutter speed.', voice: 'a', pause: 0.9 },
  { text: 'The second setting is shutter speed.', voice: 'c', pause: 0.7 },
  { text: 'Set it to double your frame rate, so fifty for twenty five frames.', voice: 'a', pause: 2, breath: true },
  { text: 'And the last one is white balance.', voice: 'b', pause: 0.8 },
  { text: 'And the last one is white balance.', voice: 'c', pause: 0.9 },
  { text: 'And the last one is white balance.', voice: 'a', pause: 0.5 },
  { text: 'Lock it to daylight and leave it there.', voice: 'a', pause: 0.6 },
  { text: 'Do it today, and tell me what changed.', voice: 'a', pause: 0.8 }
]

/** A different video altogether, and a voice-over line recorded on its own. */
export const OTHER: ScriptLine[] = [
  { text: 'First you want to heat the pan until it just starts to smoke.', voice: 'd', pause: 0.7 },
  { text: 'Then add the butter and let it foam before the eggs go in.', voice: 'd', pause: 0.8 },
  { text: 'Keep them moving, and pull the pan off while they still look wet.', voice: 'd', pause: 0.9 },
  { text: 'Links are in the description.', voice: 'd', pause: 0.6 }
]

export interface TruthWord {
  text: string
  startSec: number
  endSec: number
  line: number
}

export interface Truth {
  rate: number
  durationSec: number
  lines: ScriptLine[]
  words: TruthWord[]
  breaths: { startSec: number; endSec: number }[]
}

// ---------- Making speech ----------

function readWav(buf: Buffer): Float32Array {
  let p = 12
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4)
    const size = buf.readUInt32LE(p + 4)
    if (id === 'data') {
      p += 8
      break
    }
    p += 8 + size
  }
  const n = Math.floor((buf.length - p) / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(p + 2 * i) / 32768
  return out
}

export function writeWav(path: string, samples: Float32Array, rate = RATE): void {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([head, data]))
}

/** One word from espeak-ng, trimmed to its sound. */
function speak(espeak: string, word: string, voice: Voice, cache: Map<string, Float32Array>): Float32Array {
  const text = word.replace(/[^\p{L}\p{N}']/gu, '')
  const key = `${text}|${voice.speed}|${voice.pitch}|${voice.variant ?? ''}`
  const hit = cache.get(key)
  if (hit) return hit
  const v = voice.variant ? `en-us+${voice.variant}` : 'en-us'
  const wav = execFileSync(espeak, ['--stdout', '-v', v, '-s', String(voice.speed), '-p', String(voice.pitch), text])
  const x = readWav(wav)
  let peak = 0
  for (const s of x) peak = Math.max(peak, Math.abs(s))
  const th = peak * 0.01
  let a = 0
  while (a < x.length && Math.abs(x[a]) <= th) a++
  let b = x.length - 1
  while (b > a && Math.abs(x[b]) <= th) b--
  const out = x.slice(a, b + 1)
  cache.set(key, out)
  return out
}

/** Pink-ish noise at a given RMS in dBFS: the room a recording sits in. */
export function roomTone(n: number, db: number, rand: () => number): Float32Array {
  const out = new Float32Array(n)
  let b0 = 0
  let b1 = 0
  let b2 = 0
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    out[i] = b0 + b1 + b2 + w * 0.1848
  }
  return scaleTo(out, db)
}

function rms(x: Float32Array): number {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / Math.max(1, x.length))
}

function scaleTo(x: Float32Array, db: number): Float32Array {
  const k = 10 ** (db / 20) / (rms(x) || 1)
  for (let i = 0; i < x.length; i++) x[i] *= k
  return x
}

/** A breath: noise shaped like an inhale, 0.22 to 0.3 s long, about -40 dBFS. */
function breath(rand: () => number, seconds: number): Float32Array {
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  let hp = 0
  let lp = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    const w = rand() * 2 - 1
    hp = 0.9 * (hp + w - prev)
    prev = w
    lp = lp + 0.55 * (hp - lp)
    const env = Math.sin((Math.PI * i) / n) ** 2
    out[i] = lp * env
  }
  return scaleTo(out, -40)
}

/** Lays a script out word by word: the recording and the exact time of every word in it. */
export function buildSpeech(
  espeak: string,
  lines: ScriptLine[],
  seed: number
): { samples: Float32Array; truth: Truth } {
  const rand = seeded(seed)
  const cache = new Map<string, Float32Array>()
  const parts: { at: number; x: Float32Array }[] = []
  const words: TruthWord[] = []
  const breaths: Truth['breaths'] = []
  let t = 0.6
  lines.forEach((line, li) => {
    const tokens = line.text.split(' ')
    tokens.forEach((tok, i) => {
      const base = VOICES[line.voice]
      const voice = {
        ...base,
        speed: base.speed + Math.round((rand() - 0.5) * 10),
        pitch: base.pitch + Math.round((rand() - 0.5) * 8)
      }
      const x = speak(espeak, tok, voice, cache)
      const at = Math.round(t * RATE)
      parts.push({ at, x })
      words.push({ text: tok, startSec: at / RATE, endSec: (at + x.length) / RATE, line: li })
      t = (at + x.length) / RATE
      if (i < tokens.length - 1) t += 0.04 + 0.04 * rand() + (/[,;]$/.test(tok) ? 0.2 : 0)
    })
    if (line.breath) {
      const len = line.pause < 0.6 ? 0.2 : 0.28
      const at = t + (line.pause - len) / 2
      parts.push({ at: Math.round(at * RATE), x: breath(rand, len) })
      breaths.push({ startSec: at, endSec: at + len })
    }
    t += line.pause
  })
  const total = Math.round((t + 0.6) * RATE)
  const samples = roomTone(total, -58, rand)
  for (const { at, x } of parts) for (let i = 0; i < x.length && at + i < total; i++) samples[at + i] += x[i]
  return { samples, truth: { rate: RATE, durationSec: total / RATE, lines, words, breaths } }
}

// ---------- Reading and writing media ----------

export function decode(ffmpeg: string, path: string, rate = RATE): Float32Array {
  const out = execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', path, '-ac', '1', '-ar', String(rate), '-f', 'f32le', '-'],
    {
      maxBuffer: 1 << 30
    }
  )
  const x = new Float32Array(out.length / 4)
  for (let i = 0; i < x.length; i++) x[i] = out.readFloatLE(i * 4)
  return x
}

/** An audio-only recording, as a small AAC file. */
export function encodeAudio(ffmpeg: string, samples: Float32Array, out: string, work: string, kbps = 40): void {
  const wav = join(work, `enc-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
  writeWav(wav, samples)
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', `${kbps}k`, out])
  rmSync(wav, { force: true })
}

/**
 * A finished video: a small picture with B-roll cut in now and then, the
 * mix through a compressor, at 44.1 kHz AAC as an export would be.
 */
export function encodeVideo(
  ffmpeg: string,
  samples: Float32Array,
  out: string,
  work: string,
  opts: { broll?: [number, number][]; compress?: boolean } = {}
): void {
  const wav = join(work, `mix-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`)
  writeWav(wav, samples)
  const seconds = samples.length / RATE
  const windows = (opts.broll ?? []).map(([a, b]) => `between(t,${a},${b})`).join('+') || '0'
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x2a3540:s=320x180:r=25:d=${seconds.toFixed(3)}`,
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=320x180:r=25:d=${seconds.toFixed(3)}`,
    '-i',
    wav,
    '-filter_complex',
    `[0:v][1:v]overlay=enable='${windows}'[v];[2:a]${opts.compress === false ? 'anull' : 'acompressor=threshold=-20dB:ratio=3:attack=5:release=60:makeup=2'}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ar',
    '44100',
    '-shortest',
    out
  ])
  rmSync(wav, { force: true })
}

/** Runs a stretch of audio through ffmpeg's atempo: faster, same pitch. */
export function speedUp(ffmpeg: string, samples: Float32Array, factor: number, work: string): Float32Array {
  const wav = join(work, `tempo-${Date.now()}.wav`)
  writeWav(wav, samples)
  const out = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      wav,
      '-af',
      `atempo=${factor}`,
      '-ac',
      '1',
      '-ar',
      String(RATE),
      '-f',
      'f32le',
      '-'
    ],
    { maxBuffer: 1 << 28 }
  )
  rmSync(wav, { force: true })
  const x = new Float32Array(out.length / 4)
  for (let i = 0; i < x.length; i++) x[i] = out.readFloatLE(i * 4)
  return x
}

// ---------- Making a finished video ----------

/** A synthetic music bed: chords with overtones, a bass line, a soft kick and hats. */
export function musicBed(seconds: number, seed: number): Float32Array {
  const rand = seeded(seed)
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  const chords = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [130.81, 164.81, 196],
    [196, 246.94, 293.66]
  ]
  let hat = 0
  let hp = 0
  let prev = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const bar = Math.floor(t / 2) % chords.length
    const inBar = t % 2
    const swell = Math.min(1, inBar / 0.08) * (0.7 + 0.3 * Math.cos((Math.PI * inBar) / 2))
    let v = 0
    for (const f of chords[bar]) {
      v += Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t)
    }
    v += 1.2 * Math.sin(Math.PI * chords[bar][0] * t)
    const beat = t % 0.5
    v += 2.5 * Math.sin(2 * Math.PI * 58 * t) * Math.exp(-beat * 28)
    const w = rand() * 2 - 1
    hp = 0.6 * (hp + w - prev)
    prev = w
    if (t % 0.25 < 1 / RATE) hat = 1
    hat *= 0.9988
    v += 1.4 * hp * hat
    out[i] = v * swell
  }
  return scaleTo(out, 0)
}

function whoosh(rand: () => number, seconds = 0.45): Float32Array {
  const n = Math.round(seconds * RATE)
  const out = new Float32Array(n)
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < n; i++) {
    const f = 500 + 3500 * (i / n)
    const r = 0.97
    const c = 2 * r * Math.cos((2 * Math.PI * f) / RATE)
    const y = (rand() * 2 - 1) * (1 - r) + c * y1 - r * r * y2
    y2 = y1
    y1 = y
    out[i] = y * Math.sin((Math.PI * i) / n) ** 2
  }
  return scaleTo(out, -22)
}

function pop(): Float32Array {
  const n = Math.round(0.06 * RATE)
  return Float32Array.from(
    { length: n },
    (_, i) => 0.25 * Math.sin((2 * Math.PI * 900 * i) / RATE) * Math.exp(-i / (0.012 * RATE))
  )
}

export interface EditPiece {
  /** Seconds in the recording. */
  rawStart: number
  rawEnd: number
  /** Which recording, when there are several. */
  rec?: number
  /** Overlap with the piece before, crossfaded: an audio J or L cut. */
  overlapSec?: number
  /** Played faster than recorded. */
  speed?: number
}

export interface PlantedPiece extends Required<Omit<EditPiece, 'overlapSec' | 'speed'>> {
  outStart: number
  outEnd: number
  speed: number
  /** Crossfaded into the piece before over this long. */
  overlapSec: number
}

export interface FinishedOptions {
  /** Music alone before the first piece. */
  leadSec?: number
  /** Bed level (RMS, dBFS) under the voice; null for no bed. */
  bedDb?: number | null
  /** Whole-mix gain, plus a dip over the middle fifth of the video. */
  gainDb?: number
  dipDb?: number
  /** Sound effects laid over these cuts (indexes of the piece that starts there). */
  sfxAt?: number[]
  /** A line recorded on its own, played after the last piece. */
  voiceOver?: Float32Array | null
  seed?: number
}

/**
 * Cuts a finished video's sound from recordings, sample-exact: each piece
 * with an 8 ms fade at each end, or crossfaded into the one before when it
 * overlaps it; then sound effects, a voice-over, a gain change and a music
 * bed over all of it.
 */
export function composeFinished(
  recordings: Float32Array[],
  pieces: EditPiece[],
  ffmpeg: string,
  work: string,
  opts: FinishedOptions = {}
): { samples: Float32Array; planted: PlantedPiece[]; voiceOver: { outStart: number; outEnd: number } | null } {
  const rand = seeded(opts.seed ?? 7)
  const fade = Math.round(0.008 * RATE)
  const lead = Math.round((opts.leadSec ?? 0) * RATE)
  const clips = pieces.map((p) => {
    const src = recordings[p.rec ?? 0]
    const x = src.slice(Math.round(p.rawStart * RATE), Math.round(p.rawEnd * RATE))
    return p.speed && p.speed !== 1 ? speedUp(ffmpeg, x, p.speed, work) : x
  })
  const planted: PlantedPiece[] = []
  let at = lead
  const starts: number[] = []
  pieces.forEach((p, i) => {
    const overlap = i > 0 ? Math.round((p.overlapSec ?? 0) * RATE) : 0
    at -= overlap
    starts.push(at)
    planted.push({
      rawStart: p.rawStart,
      rawEnd: p.rawEnd,
      rec: p.rec ?? 0,
      speed: p.speed ?? 1,
      overlapSec: overlap / RATE,
      outStart: at / RATE,
      outEnd: (at + clips[i].length) / RATE
    })
    at += clips[i].length
  })
  let voiceOver: { outStart: number; outEnd: number } | null = null
  const voAt = at + Math.round(0.4 * RATE)
  const total = (opts.voiceOver ? voAt + opts.voiceOver.length : at) + Math.round(0.8 * RATE)
  const mix = new Float32Array(total)
  clips.forEach((x, i) => {
    const overlapIn = i > 0 ? Math.round((pieces[i].overlapSec ?? 0) * RATE) : 0
    const overlapOut = i + 1 < pieces.length ? Math.round((pieces[i + 1].overlapSec ?? 0) * RATE) : 0
    for (let k = 0; k < x.length; k++) {
      let g = 1
      if (overlapIn > 0 && k < overlapIn) g = Math.sin((Math.PI / 2) * (k / overlapIn))
      else if (k < fade) g = k / fade
      const fromEnd = x.length - 1 - k
      if (overlapOut > 0 && fromEnd < overlapOut) g *= Math.cos((Math.PI / 2) * (1 - fromEnd / overlapOut))
      else if (fromEnd < fade) g *= fromEnd / fade
      mix[starts[i] + k] += x[k] * g
    }
  })
  if (opts.voiceOver) {
    mix.set(
      opts.voiceOver.map((v, k) => mix[voAt + k] + v),
      voAt
    )
    voiceOver = { outStart: voAt / RATE, outEnd: (voAt + opts.voiceOver.length) / RATE }
  }
  for (const i of opts.sfxAt ?? []) {
    const fx = i % 2 === 0 ? whoosh(rand) : pop()
    const centre = starts[i] - Math.round(fx.length / 2)
    for (let k = 0; k < fx.length; k++) if (centre + k >= 0 && centre + k < total) mix[centre + k] += fx[k]
  }
  // Loudness: louder overall, with a dip through the middle fifth.
  const gain = 10 ** ((opts.gainDb ?? 0) / 20)
  const dip = 10 ** ((opts.dipDb ?? 0) / 20)
  const d0 = Math.round(total * 0.4)
  const d1 = Math.round(total * 0.6)
  const ramp = Math.round(0.5 * RATE)
  for (let k = 0; k < total; k++) {
    let g = gain
    if (k > d0 - ramp && k < d1 + ramp) {
      const into = Math.min(1, (k - (d0 - ramp)) / ramp, (d1 + ramp - k) / ramp)
      g *= 1 + (dip - 1) * Math.max(0, into)
    }
    mix[k] *= g
  }
  if (opts.bedDb !== null) {
    const bed = musicBed(total / RATE, opts.seed ?? 7)
    const under = 10 ** ((opts.bedDb ?? -30) / 20)
    const intro = 10 ** (((opts.bedDb ?? -30) + 6) / 20)
    for (let k = 0; k < total; k++) mix[k] += bed[k] * (k < lead ? intro : under)
  }
  return { samples: mix, planted, voiceOver }
}

/** The words of a finished video, from the recordings' words and where each piece landed. */
export function finishedWords(
  truths: Truth[],
  planted: PlantedPiece[],
  extra: { words: TruthWord[]; shift: number } | null = null
): { text: string; startSec: number; endSec: number }[] {
  const out: { text: string; startSec: number; endSec: number }[] = []
  for (const p of planted) {
    for (const w of truths[p.rec].words) {
      if (w.startSec < p.rawStart - 1e-6 || w.endSec > p.rawEnd + 1e-6) continue
      out.push({
        text: w.text,
        startSec: p.outStart + (w.startSec - p.rawStart) / p.speed,
        endSec: p.outStart + (w.endSec - p.rawStart) / p.speed
      })
    }
  }
  if (extra)
    for (const w of extra.words)
      out.push({ text: w.text, startSec: w.startSec + extra.shift, endSec: w.endSec + extra.shift })
  return out.sort((a, b) => a.startSec - b.startSec)
}

// ---------- Writing the fixtures ----------

/** Where a decoded file's sound sits against the samples it was made from, in samples. */
function lagOf(original: Float32Array, decoded: Float32Array): number {
  const n = Math.min(original.length, decoded.length, RATE * 8)
  let best = { lag: 0, score: -Infinity }
  for (let lag = -2048; lag <= 2048; lag++) {
    let s = 0
    for (let i = 4096; i < n - 4096; i += 3) s += original[i] * (decoded[i + lag] ?? 0)
    if (s > best.score) best = { lag, score: s }
  }
  return best.lag
}

/** Makes the checked-in recordings and their word lists. */
export function writeSpeechFixtures(espeak: string, ffmpeg: string, dir = FIXTURES): void {
  mkdirSync(dir, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'cutalong-fixtures-'))
  try {
    for (const [name, lines, seed] of [
      ['talk', TALK, 11],
      ['other', OTHER, 23]
    ] as const) {
      const { samples, truth } = buildSpeech(espeak, lines, seed)
      const file = join(dir, `${name}.m4a`)
      encodeAudio(ffmpeg, samples, file, work)
      // Times as the decoded file has them, so the word list matches what is heard.
      const shift = lagOf(samples, decode(ffmpeg, file)) / RATE
      const moved = (t: number): number => Math.round((t + shift) * 1e5) / 1e5
      const fixed: Truth = {
        ...truth,
        words: truth.words.map((w) => ({ ...w, startSec: moved(w.startSec), endSec: moved(w.endSec) })),
        breaths: truth.breaths.map((b) => ({ startSec: moved(b.startSec), endSec: moved(b.endSec) }))
      }
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixed, null, 1) + '\n')
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export function readTruth(name: string, dir = FIXTURES): Truth {
  return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as Truth
}

// ---------- Planting an edit ----------

export interface EditSpec {
  /** Stretches of recording words kept, in finished order, as [first, last] word indexes (inclusive). */
  segments: [number, number][]
  /** Which recording each segment is from, when there are several. */
  recs?: number[]
  /** Room before the first word and after the last of each stretch, give or take `jitter`. */
  before: number
  after: number
  jitter: number
  /** Pauses inside a stretch longer than this are cut back to the room either side. */
  maxPauseSec: number
  /** Overlap a stretch with the one before (an audio J or L cut), with more room at that seam. */
  overlap?: { segment: number; seconds: number; before: number; after: number }
  /** Play one stretch faster. */
  speed?: { segment: number; factor: number }
}

/** Pieces for a planted edit, and which words of each recording it keeps ("rec:index"). */
export function plantEdit(truths: Truth[], spec: EditSpec, seed = 5): { pieces: EditPiece[]; kept: Set<string> } {
  const rand = seeded(seed)
  const jit = (): number => (rand() * 2 - 1) * spec.jitter
  const pieces: EditPiece[] = []
  const kept = new Set<string>()
  spec.segments.forEach(([a, b], si) => {
    const rec = spec.recs?.[si] ?? 0
    const words = truths[rec].words
    // Split where a pause is longer than the creator keeps.
    let from = a
    for (let i = a; i <= b; i++) {
      kept.add(`${rec}:${i}`)
      const last = i === b || words[i + 1].startSec - words[i].endSec > spec.maxPauseSec
      if (!last) continue
      const into = spec.overlap?.segment === si && from === a ? spec.overlap : null
      const outOf = spec.overlap?.segment === si + 1 && i === b ? spec.overlap : null
      pieces.push({
        rec,
        rawStart: words[from].startSec - (into ? into.before : spec.before + jit()),
        rawEnd: words[i].endSec + (outOf ? outOf.after : spec.after + jit()),
        overlapSec: into ? into.seconds : 0,
        speed: spec.speed?.segment === si ? spec.speed.factor : 1
      })
      from = i + 1
    }
  })
  return { pieces, kept }
}

/**
 * A transcript stand-in that hears the way a recogniser does: edges off by
 * tens of milliseconds, a few words missed or misheard, most ums dropped.
 */
export function hearLoosely(
  words: { text: string; startSec: number; endSec: number }[],
  seed: number,
  opts: { jitterSec?: number; drop?: number; mishear?: number; dropFillers?: boolean } = {}
): { text: string; startSec: number; endSec: number }[] {
  const rand = seeded(seed)
  const j = opts.jitterSec ?? 0.04
  const swaps: Record<string, string> = {
    the: 'a',
    to: 'too',
    it: 'at',
    and: 'an',
    is: 'his',
    your: 'you',
    settings: 'setting'
  }
  const out: { text: string; startSec: number; endSec: number }[] = []
  for (const w of words) {
    const bare = w.text.toLowerCase().replace(/[^a-z']/g, '')
    if (opts.dropFillers !== false && /^(um|uh)$/.test(bare) && rand() < 0.7) continue
    if (rand() < (opts.drop ?? 0.03)) continue
    let text = w.text
    if (rand() < (opts.mishear ?? 0.03)) text = swaps[bare] ?? `${bare}s`
    const g = (): number => Math.max(-2.5 * j, Math.min(2.5 * j, (rand() + rand() + rand() - 1.5) * 1.4 * j))
    const startSec = Math.max(0, w.startSec + g())
    out.push({ text, startSec, endSec: Math.max(startSec + 0.05, w.endSec + g()) })
  }
  return out
}
