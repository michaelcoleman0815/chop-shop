import Anthropic from '@anthropic-ai/sdk'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'fs'
import { parseWith, streamedAnswer, type ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import type { MakeServices, Picture, TimedWord } from './services'

/**
 * Stand-ins for the services a made video uses, for the end-to-end run of
 * the real app on a machine with no keys: pictures and clips made by ffmpeg,
 * voices read by espeak-ng, and Claude's answers written here and handed to
 * the real Anthropic SDK through its fetch, so the SDK parses them as it
 * would parse Claude's. Only an unpackaged app with CUTALONG_MAKE_STANDINS
 * set uses them (main/make/index.ts); nothing here ships in use.
 *
 * Every request a stand-in answers is written to the log, prompt and the
 * size of whatever picture went with it, so the run can check what was sent.
 */

const hash = (s: string): number => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16)

function run(bin: string, args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-1500)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err || `${bin} exited ${code}`))))
    child.stdin.on('error', () => undefined)
    child.stdin.end(input ?? Buffer.alloc(0))
  })
}

/** A service's time to answer, cut short by a stop as a real request is. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(Object.assign(new Error('Stopped.'), { kind: 'cancelled' }))
      },
      { once: true }
    )
  })
}

const hex = (n: number): string => `0x${(n & 0xffffff).toString(16).padStart(6, '0')}`

/** A picture for a prompt, made by ffmpeg: a gradient ground, a few shapes where a subject would be, grain. */
async function picture(ffmpeg: string, prompt: string, aspect: 'wide' | 'vertical'): Promise<Buffer> {
  const h = hash(prompt)
  const [w, ht] = aspect === 'vertical' ? [1080, 1920] : [1920, 1080]
  const cartoon = /cartoon|flat|explainer|toy|bright/i.test(prompt)
  const c0 = cartoon ? hex(0x4fa3e0 + (h % 0x303030)) : hex(0x8a6a45 + (h % 0x101010))
  const c1 = cartoon ? hex(0xf7d154 - (h % 0x202020)) : hex(0x23170e + (h % 0x080808))
  const boxes = [0, 1, 2]
    .map((k) => {
      const r = hash(`${prompt}:${k}`)
      const bw = Math.round(w * (0.12 + (r % 25) / 100))
      const bh = Math.round(ht * (0.2 + ((r >> 5) % 40) / 100))
      const x = Math.round((w - bw) * (((r >> 9) % 100) / 100))
      const y = Math.round((ht - bh) * (0.3 + ((r >> 13) % 60) / 100))
      const color = cartoon ? hex(r) : hex(0x3b2a1a + (r % 0x202020))
      return `drawbox=x=${x}:y=${y}:w=${bw}:h=${bh}:color=${color}@0.85:t=fill`
    })
    .join(',')
  return run(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `gradients=s=${w}x${ht}:c0=${c0}:c1=${c1}:seed=${h % 1000}:n=2:d=1`,
    '-vf',
    `${boxes},noise=alls=${cartoon ? 4 : 14}:allf=t,format=rgb24`,
    '-frames:v',
    '1',
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    'pipe:1'
  ])
}

/** A clip from its first frame, made by ffmpeg: the still panned across slowly, H.264. */
async function clipFrom(ffmpeg: string, first: Picture, seconds: number, aspect: 'wide' | 'vertical'): Promise<Buffer> {
  const [w, ht] = aspect === 'vertical' ? [1080, 1920] : [1920, 1080]
  const big = Math.round(w * 1.12)
  return run(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-i',
      'pipe:0',
      '-filter_complex',
      `[0:v]loop=loop=-1:size=1,fps=24,scale=${big}:-2,crop=${w}:${ht}:x='(iw-ow)*t/${seconds}':y='(ih-oh)/2',format=yuv420p,trim=duration=${seconds}[v]`,
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '26',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      'pipe:1'
    ],
    Buffer.from(first.data)
  )
}

/** A WAV file of a soft tone as long as the words would take to say: for a machine without espeak-ng. */
function toneWav(text: string): Buffer {
  const rate = 22050
  const words = text.split(/\s+/).filter(Boolean).length
  const n = Math.round(rate * Math.max(0.4, words * 0.36))
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 180) * 6000 * (0.6 + 0.4 * Math.sin(i / 900))), i * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

/** Spoken words as a WAV file, by espeak-ng, or a tone of the same length where it is not installed. */
async function speakWav(text: string, voice: string, rate = 155): Promise<Buffer> {
  try {
    return await run('espeak-ng', ['-v', voice, '-s', String(rate), '--stdout', text])
  } catch {
    return toneWav(text)
  }
}

/** A WAV file's first channel as float samples, and its rate. */
export function wavSamples(wav: Buffer): { samples: Float32Array; rate: number } {
  let i = 12
  let rate = 22050
  let channels = 1
  while (i + 8 <= wav.length) {
    const id = wav.toString('ascii', i, i + 4)
    const size = wav.readUInt32LE(i + 4)
    if (id === 'fmt ') {
      channels = wav.readUInt16LE(i + 10)
      rate = wav.readUInt32LE(i + 12)
    }
    if (id === 'data') {
      const end = Math.min(wav.length, i + 8 + (size === 0xffffffff || size === 0 ? wav.length : size))
      const n = Math.floor((end - i - 8) / (2 * channels))
      const out = new Float32Array(n)
      for (let k = 0; k < n; k++) out[k] = wav.readInt16LE(i + 8 + k * 2 * channels) / 32768
      return { samples: out, rate }
    }
    i += 8 + size + (size % 2)
  }
  return { samples: new Float32Array(0), rate }
}

/** espeak-ng's voice for one of Cutalong's: a man's or a woman's, British or American. */
const espeakVoice = (id: string): string =>
  /^b[mf]_/.test(id) ? (id.startsWith('bf') ? 'en-gb+f3' : 'en-gb') : /^af_|marin|puck|kore|rachel/i.test(id) ? 'en-us+f3' : 'en-us'

export function standInServices(ffmpeg: string, log: string): MakeServices {
  const note = (line: Record<string, unknown>): void => appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`)
  return {
    open: () => ({ google: true, fal: true, elevenlabs: false, openai: false }),
    models: {
      image: { google: 'stand-in image (ffmpeg)', fal: 'stand-in image (ffmpeg)' },
      clip: { google: 'stand-in clip (ffmpeg)', fal: 'stand-in clip (ffmpeg)' }
    },
    image: async (service, prompt, refs, opts) => {
      await wait(Number(process.env.CUTALONG_STANDIN_DELAY_MS ?? 0), opts.signal)
      note({ service, kind: 'image', prompt, refs: refs.map((r) => r.data.length), aspect: opts.aspect, size: opts.size })
      return { data: new Uint8Array(await picture(ffmpeg, prompt, opts.aspect)), mime: 'image/png' }
    },
    clip: async (service, prompt, first, opts) => {
      note({ service, kind: 'clip', prompt, first: first.data.length, seconds: opts.seconds })
      return { data: new Uint8Array(await clipFrom(ffmpeg, first, opts.seconds, opts.aspect)), mime: 'video/mp4' }
    },
    elevenlabs: async (voiceId, text) => {
      note({ service: 'elevenlabs', kind: 'speech', chars: text.length })
      const wav = await speakWav(text, espeakVoice(voiceId))
      const { samples, rate } = wavSamples(wav)
      const words = text.split(/\s+/).filter(Boolean)
      const per = samples.length / rate / Math.max(1, words.length)
      const timed: TimedWord[] = words.map((w, k) => ({ text: w, startSec: k * per, endSec: (k + 0.85) * per }))
      return { audio: new Uint8Array(wav), words: timed }
    },
    elevenVoice: async () => null,
    gemini: async (text, voice) => {
      note({ service: 'gemini', kind: 'speech', chars: text.length })
      return new Uint8Array(await speakWav(text, espeakVoice(voice)))
    },
    openai: async (text, voice) => {
      note({ service: 'openai', kind: 'speech', chars: text.length })
      return new Uint8Array(await speakWav(text, espeakVoice(voice)))
    }
  }
}

/** The voice on this Mac, stood in for by espeak-ng: always ready, nothing to download. */
export function standInVoice(): LocalVoice {
  return {
    ready: async () => true,
    prepare: async () => undefined,
    speak: async (text, voice) => wavSamples(await speakWav(text, espeakVoice(voice), 150))
  }
}

// ---------- Claude, answered here through the real SDK ----------

interface Scripts {
  documentary: { title: string; sections: { heading: string; paragraphs: string[] }[] }
  explainer: { title: string; sections: { heading: string; paragraphs: string[] }[] }
}

const MOVES = ['push-in', 'pan-right', 'ken-burns', 'pull-out', 'pan-left', 'drift', 'pan-up']

/** A shot list for numbered phrases, as Claude would answer it: a card first, stills, a clip or two, a map, titles. */
function shotsFor(user: string, documentary: boolean): Record<string, unknown> {
  const lines = [...user.matchAll(/^(\d+): (.*)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2] }))
  const maxClips = Number(/At most (\d+) clips/.exec(user)?.[1] ?? 0)
  const mapsAllowed = !/No maps\./.test(user)
  let clips = 0
  let mapped = false
  const shots = lines.map(({ n, text }, k) => {
    const blank = {
      phrase: n,
      kind: 'still',
      prompt: '',
      move: MOVES[k % MOVES.length],
      motion: '',
      characters: [] as string[],
      place: '',
      titleBig: '',
      titleSmall: '',
      graphic: '',
      text: [] as string[],
      values: [] as number[],
      items: [] as { label: string; value: string }[],
      callouts: [] as { label: string; value: string; x: number; y: number }[]
    }
    const year = /\b(1[89]\d\d)\b/.exec(text)?.[1]
    if (k === 0 && n === 0) return { ...blank, kind: 'card', titleBig: documentary ? 'Black Gold' : 'The Heart', titleSmall: documentary ? 'The 1950s oil boom' : 'How it pumps' }
    if (documentary && mapsAllowed && !mapped && k > 0 && /\b(Texas|Oklahoma|California|Long Beach|Signal Hill|Permian|Midland)\b/.test(text)) {
      mapped = true
      return { ...blank, kind: 'map', place: /Signal Hill|Long Beach|California/.test(text) ? 'California' : 'Texas' }
    }
    if (clips < maxClips && k % 6 === 3) {
      clips++
      return {
        ...blank,
        kind: 'clip',
        prompt: documentary ? `Oil gushing from a wooden derrick at dusk, workers stepping back, wide shot. ${text}` : `The cartoon heart beating, its chambers squeezing in turn. ${text}`,
        motion: documentary ? 'Oil sprays up and rains down; smoke drifts.' : 'The heart squeezes and relaxes twice.',
        characters: documentary ? ['the-wildcatter'] : ['hart']
      }
    }
    return {
      ...blank,
      prompt: documentary
        ? `A 1950s photograph: ${text.replace(/[.!?]+$/, '')}. Medium shot, hard afternoon light.`
        : `A bright flat cartoon scene: ${text.replace(/[.!?]+$/, '')}.`,
      characters: k % 3 === 1 ? [documentary ? 'the-wildcatter' : 'hart'] : [],
      titleBig: documentary && year && k > 0 ? year : '',
      titleSmall: '',
      callouts: !documentary && k % 4 === 2 ? [{ label: 'Left ventricle', value: '', x: 0.62, y: 0.58 }] : []
    }
  })
  return {
    style: documentary
      ? 'Photoreal 1950s archival photography on 35 mm black-and-white and early colour film, a 50 mm lens, hard sun, dust in the air, period clothes and machines, nothing modern.'
      : 'Bright flat 2D cartoon with soft shading, thick clean outlines, simple rounded shapes, a cheerful palette on plain pastel backgrounds.',
    palette: documentary ? 'sepia browns, oil black, faded sky blue' : 'coral red, sky blue, sunshine yellow, cream',
    era: documentary ? 'Texas and California, 1950 to 1959' : '',
    characters: documentary
      ? [{ id: 'the-wildcatter', name: 'the wildcatter', look: 'a tall lean man in his forties in a grey felt hat, rolled sleeves and work boots, oil on his hands' }]
      : [{ id: 'hart', name: 'Hart', look: 'a friendly cartoon heart with big round eyes, a wide smile and small white gloved hands' }],
    shots
  }
}

/** The answer to one request the SDK sends: its text, and the tokens it would have used. */
function answerFor(body: Record<string, unknown>, scripts: Scripts): { text: string; input: number; output: number } {
  const system = JSON.stringify(body.system ?? '')
  const messages = body.messages as { content: string }[]
  const user = typeof messages?.[0]?.content === 'string' ? messages[0].content : JSON.stringify(messages?.[0]?.content ?? '')
  const documentary = /cinematic documentary/.test(user) || (/the-wildcatter|1950s/.test(user) && !/explainer/.test(user))
  let out: unknown
  if (system.includes('You write narration scripts')) out = documentary ? scripts.documentary : scripts.explainer
  else if (system.includes('You plan the shots')) out = shotsFor(user, documentary)
  else if (system.includes('You rewrite one shot')) {
    const asked = /<asked>\n([\s\S]*?)\n<\/asked>/.exec(user)?.[1] ?? 'the same picture'
    out = { prompt: `${asked.charAt(0).toUpperCase()}${asked.slice(1)}, in the same scene and light, a 1950s photograph.`, move: 'push-in' }
  } else out = {}
  const text = JSON.stringify(out)
  return { text, input: Math.round(user.length / 4) + 1500, output: Math.round(text.length / 4) + 400 }
}

/** Claude for the end-to-end run: the real SDK, answered here. Each request is logged. */
export function standInClaude(scriptsFile: string, log: string): ParseCall {
  const scripts = JSON.parse(readFileSync(scriptsFile, 'utf8')) as Scripts
  const answer = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), service: 'claude', model: body.model, chars: String(init?.body ?? '').length })}\n`)
    const a = answerFor(body, scripts)
    return streamedAnswer(a.text, { model: String(body.model ?? ''), input: a.input, output: a.output })
  }
  return parseWith(new Anthropic({ apiKey: 'stand-in', fetch: answer as never, maxRetries: 0 }))
}

/** What whisper's stand-in hears in a narration read here: each phrase's words spread over its span. */
export function writeHeard(manifest: string, path: string, durationSec: number, read: { phrases: string[]; spans: { phrases: number[]; startSec: number; endSec: number }[] }): void {
  const words: TimedWord[] = []
  for (const span of read.spans) {
    const all = span.phrases.flatMap((p) => (read.phrases[p] ?? '').split(/\s+/).filter(Boolean))
    const per = (span.endSec - span.startSec) / Math.max(1, all.length)
    all.forEach((w, k) => words.push({ text: w, startSec: span.startSec + k * per, endSec: span.startSec + (k + 0.9) * per }))
  }
  let doc: { recordings: { name: string; durationSec: number; words: TimedWord[] }[] } = { recordings: [] }
  try {
    doc = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    // A first narration starts the manifest.
  }
  doc.recordings.push({ name: path, durationSec, words })
  writeFileSync(manifest, JSON.stringify(doc))
}
