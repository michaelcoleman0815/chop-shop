import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { SFX_INFO, type SfxKind } from '../shared/edit'

/**
 * The built-in sound effects, made by ffmpeg from noise and tones, so nothing
 * is copied from anywhere: a whoosh is pink noise swept up and down through a
 * filter, a pop a short tone that rises, a click a few milliseconds of tone
 * and noise, a riser a climbing double tone over noise, a hit a falling boom
 * with a crack on top, a ding a few bell partials dying away. Each is made
 * once, peak-normalised to -1 dBFS, and kept in a folder, where the export
 * and the preview both play the same file.
 *
 * Also the person's own sounds: the files in their sounds folder, and how
 * much silence each starts with, so it lands on its moment.
 *
 * No Electron imports: the binary and folders arrive as arguments.
 */

/** Bumped whenever a recipe changes, so files made from an older one are made again. */
const RECIPE_VERSION = 1

/** The whoosh's filter sweep: up to its middle and back, as commands to a lowpass and a highpass. */
function sweep(sec: number): string {
  const steps = 28
  const at: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * sec
    const x = Math.sin((Math.PI * t) / sec)
    const lp = Math.round(500 + 6500 * x * x)
    const hp = Math.round(150 + 1100 * x * x)
    at.push(`${t.toFixed(3)} lowpass@lp f ${lp}, highpass@hp f ${hp}`)
  }
  return `asendcmd=c='${at.join(';')}'`
}

/** Each sound as an ffmpeg graph from nothing to [out], mono at 48 kHz. */
const RECIPES: Record<SfxKind, (sec: number) => string> = {
  whoosh: (sec) =>
    `anoisesrc=d=${sec}:c=pink:r=48000:a=0.9,asetnsamples=n=240,${sweep(sec)},` +
    `lowpass@lp=f=500:p=2,highpass@hp=f=150:p=2,volume='pow(sin(PI*t/${sec}),2)':eval=frame[out]`,
  pop: (sec) =>
    `aevalsrc=exprs='0.9*sin(2*PI*(380*t+2600*t*t))*exp(-t/0.022)*(1-exp(-t/0.0015))':s=48000:d=${sec}[out]`,
  click: (sec) =>
    `aevalsrc=exprs='((0.6*sin(2*PI*3200*t)+0.4*sin(2*PI*1700*t))*exp(-t/0.004)+0.3*(2*random(0)-1)*exp(-t/0.0015))':s=48000:d=${sec}[out]`,
  riser: (sec) =>
    // A tone climbing ten times in pitch, a second tone a hair above it, and noise, all swelling.
    `aevalsrc=exprs='(0.45*sin(2*PI*${((180 * sec) / Math.LN10).toFixed(4)}*(pow(10,t/${sec})-1))` +
    `+0.3*sin(2*PI*${((182 * sec) / Math.LN10).toFixed(4)}*(pow(10,t/${sec})-1))` +
    `+0.25*(2*random(0)-1))*pow(t/${sec},2)':s=48000:d=${sec},highpass=f=120,afade=t=out:st=${(sec - 0.02).toFixed(3)}:d=0.02[out]`,
  hit: (sec) =>
    // A boom falling from 110 Hz to 45 Hz, and a short crack over it.
    `aevalsrc=exprs='0.85*sin(2*PI*(45*t+5.2*(1-exp(-t/0.08))))*exp(-t/0.35)*(1-exp(-t/0.002))':s=48000:d=${sec}[boom];` +
    `aevalsrc=exprs='0.6*(2*random(0)-1)*exp(-t/0.02)':s=48000:d=${sec},lowpass=f=2500[crack];` +
    `[boom][crack]amix=inputs=2:normalize=0[out]`,
  ding: (sec) =>
    // Bell partials over C6, each dying away at its own rate.
    `aevalsrc=exprs='(sin(2*PI*1046.5*t)*exp(-t/0.6)+0.5*sin(2*PI*2103.5*t)*exp(-t/0.35)` +
    `+0.35*sin(2*PI*2888.3*t)*exp(-t/0.25)+0.2*sin(2*PI*4259.3*t)*exp(-t/0.15))*0.45*(1-exp(-t/0.002))':s=48000:d=${sec}[out]`
}

function run(ffmpeg: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', ...args])
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(err.trim().split('\n').slice(-2).join(' ')))))
  })
}

/** The loudest sample of a file, in dBFS. */
async function peakDb(ffmpeg: string, path: string): Promise<number> {
  const log = await run(ffmpeg, ['-i', path, '-af', 'volumedetect', '-f', 'null', '-'])
  const m = /max_volume: (-?\d+(?:\.\d+)?) dB/.exec(log)
  return m ? Number(m[1]) : 0
}

/** Makes a built-in sound in `dir`, once, and returns its path. */
export async function makeSfx(ffmpeg: string, kind: SfxKind, dir: string): Promise<string> {
  const path = join(dir, `${kind}-v${RECIPE_VERSION}.wav`)
  try {
    await fs.access(path)
    return path
  } catch {
    // Not made yet.
  }
  await fs.mkdir(dir, { recursive: true })
  const raw = join(dir, `${kind}-v${RECIPE_VERSION}.raw.wav`)
  const sec = SFX_INFO[kind].sec
  await run(ffmpeg, [
    '-y',
    '-filter_complex',
    RECIPES[kind](sec),
    '-map',
    '[out]',
    '-ac',
    '1',
    '-c:a',
    'pcm_f32le',
    raw
  ])
  const peak = await peakDb(ffmpeg, raw)
  // Stereo at 48 kHz, the same in both channels, its loudest sample at -1 dBFS. Written beside the final
  // name, then moved, so a half-made file is never used.
  const part = `${path}.part.wav`
  await run(ffmpeg, [
    '-y',
    '-i',
    raw,
    '-af',
    `volume=${(-1 - peak).toFixed(2)}dB,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=s16:sample_rates=48000`,
    '-t',
    sec.toFixed(3),
    part
  ])
  await fs.rename(part, path)
  await fs.rm(raw, { force: true })
  return path
}

/** Every built-in sound, made if need be, by kind. */
export async function makeAllSfx(ffmpeg: string, dir: string): Promise<Record<SfxKind, string>> {
  const out: Partial<Record<SfxKind, string>> = {}
  for (const kind of Object.keys(SFX_INFO) as SfxKind[]) out[kind] = await makeSfx(ffmpeg, kind, dir)
  return out as Record<SfxKind, string>
}

const SOUND_FILE = /\.(wav|mp3|m4a|aif|aiff|flac|ogg|caf)$/i

/** The sound files in a folder and the folders inside it, two levels down, by name. */
export async function listSounds(root: string): Promise<{ name: string; path: string }[]> {
  const found: { name: string; path: string }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const path = join(dir, e.name)
      if (e.isDirectory() && depth < 2) await walk(path, depth + 1)
      else if (e.isFile() && SOUND_FILE.test(e.name)) found.push({ name: basename(e.name, extname(e.name)), path })
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500)
}

/** The person's own sounds whose names hold every word of `query`, from the folders given, best first. */
export async function findSounds(query: string, roots: string[], limit = 8): Promise<{ name: string; path: string }[]> {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const all = (await Promise.all(roots.map(listSounds))).flat()
  const hits = all.filter((s) => words.every((w) => s.name.toLowerCase().includes(w)))
  // A name that is just the words comes first, then shorter names.
  const exact = (s: { name: string }): number => (s.name.toLowerCase() === words.join(' ') ? 0 : 1)
  return hits.sort((a, b) => exact(a) - exact(b) || a.name.length - b.name.length).slice(0, limit)
}

/**
 * What a sound file needs to land on its moment and sit at a known level:
 * how long the silence at its start runs, and its loudest sample.
 */
export async function readSound(
  ffmpeg: string,
  path: string
): Promise<{ leadSec: number; peakDb: number; durationSec: number }> {
  // Measured as the export plays it, in stereo: a mono file spread over both channels.
  const log = await run(ffmpeg, [
    '-i',
    path,
    '-af',
    'aformat=channel_layouts=stereo,silencedetect=n=-50dB:d=0.01,volumedetect',
    '-f',
    'null',
    '-'
  ])
  const starts = [...log.matchAll(/silence_start: (-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
  const ends = [...log.matchAll(/silence_end: (\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]))
  // Silence from the very start ends where the sound begins.
  const leadSec = starts.length && Math.abs(starts[0]) < 0.005 && ends.length ? ends[0] : 0
  const peak = /max_volume: (-?\d+(?:\.\d+)?) dB/.exec(log)
  const dur = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log)
  const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0
  return { leadSec, peakDb: peak ? Number(peak[1]) : 0, durationSec }
}
