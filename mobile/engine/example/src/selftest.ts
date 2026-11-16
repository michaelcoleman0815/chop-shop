import { Capacitor } from '@capacitor/core'
import type { EngineInfo } from 'cutalong-engine'
// The desktop app's own code, bundled as is: what builds whisper's arguments,
// reads its JSON, reads a probe and writes captions on the Mac does it here.
import { buildAss, DEFAULT_CAPTION_STYLE } from '../../../../src/main/captions'
import { readProbe } from '../../../../src/main/intake'
import { whisperArgs } from '../../../../src/main/whisper-args'
import { parseWhisperJson, tokensToWords } from '../../../../src/main/whisper-parse'
import desktopRenders from './desktop-renders.json'
import { colourClose, keyframeTimes, loudness, meanColour, meanColourOf, meanVolume, probe, type Facts } from './measure'
import { Engine, Host, run, stderrLines, stdoutLines, type RunOutcome } from './plugins'
import specs from './renders.json'

export interface Check {
  name: string
  ok: boolean
  ms: number
  detail: string
  skipped?: boolean
  data?: unknown
}

export interface Report {
  ok: boolean
  passed: number
  failed: number
  skipped: number
  platform: string
  device: unknown
  info: EngineInfo | null
  startedAt: string
  finishedAt: string
  ms: number
  numbers: Record<string, unknown>
  checks: Check[]
}

interface Sample {
  t: number
  x: number
  y: number
  w: number
  h: number
}

interface RenderSpec {
  name: string
  about: string
  args: string[]
  output: string
  /** Runs made first, whose outputs the render reads. */
  pre?: string[][]
  files?: Record<string, string>
  samples?: Sample[]
  tolerance?: number
  loudness?: boolean
  needs?: string
  stderrIncludes?: string[]
  /** No more than this many seconds between keyframes, from the start to the end. */
  keyframesWithin?: number
  /** The H.264 profile ffprobe should read on iOS, where the app asks for it. */
  profileOnIos?: string
  /** Written with -movflags +faststart (checked on the runner, which can read the atoms). */
  faststart?: boolean
  bytesBetween?: [number, number]
  desktop?: boolean
}

/**
 * The app's own export video settings, as phase 1 records them
 * (mobile/src: VideoToolbox and MediaCodec export profiles).
 */
export function exportVideo(platform: string): string[] {
  return platform === 'ios'
    ? ['-c:v', 'h264_videotoolbox', '-profile:v', 'high', '-b:v', '12000k', '-g', '60', '-pix_fmt', 'nv12']
    : ['-c:v', 'h264_mediacodec', '-b:v', '12000k', '-g', '60', '-pix_fmt', 'nv12']
}

interface Expected {
  probe: Record<string, Facts>
  preview: { file: string; t: number; rgb: number[]; late: { t: number; rgb: number[] } }
  renders: Record<string, { facts: Facts; samples: number[][]; loudness?: number }>
}

type Outcome = { ok: boolean; detail: string; data?: unknown; skipped?: boolean }

const CHECK_TIMEOUT_MS = 8 * 60 * 1000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const round = (n: number, d = 1): number => Math.round(n * 10 ** d) / 10 ** d

function timeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} took longer than ${ms / 1000} s`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/** A path inside a filter argument, as the desktop's filterPath escapes it. */
function forFilter(path: string): string {
  return path.replace(/\\/g, '/').replace(/[':]/g, '\\$&')
}

function fill(arg: string, dirs: Record<string, string>): string {
  let out = arg
  for (const [key, value] of Object.entries(dirs)) {
    // Inside a quoted filter argument the path is escaped for the filter.
    out = out.split(`'{${key}}`).join(`'${forFilter(value)}`)
    out = out.split(`{${key}}`).join(value)
  }
  return out
}

/**
 * The desktop renderer's encoder settings with libx264 swapped for the
 * phone's hardware encoder, which has no CRF: a bitrate by the quality the
 * CRF asked for. What the app builder's encoder profiles will do.
 */
export function useHardwareEncoder(args: string[], encoder: string): string[] {
  const out: string[] = []
  let crf: number | null = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-c:v' && args[i + 1] === 'libx264') {
      out.push('-c:v', encoder)
      i++
    } else if (a === '-preset') {
      i++
    } else if (a === '-crf') {
      crf = Number(args[++i])
    } else {
      out.push(a)
    }
  }
  if (crf !== null) {
    const rate = crf <= 14 ? '20M' : crf <= 20 ? '12M' : '5M'
    const at = out.indexOf('-pix_fmt')
    out.splice(at >= 0 ? at : out.length - 1, 0, '-b:v', rate)
  }
  return out
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/** How many of `want` appear in `got` in order (longest common subsequence). */
function inOrder(want: string[], got: string[]): { matched: number; pairs: [number, number][] } {
  const n = want.length
  const m = got.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = want[i] === got[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (want[i] === got[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return { matched: dp[0][0], pairs }
}

export async function runSelfTest(say: (line: string) => void): Promise<Report> {
  const started = new Date()
  const t0 = performance.now()
  const checks: Check[] = []
  const numbers: Record<string, unknown> = {}
  const platform = Capacitor.getPlatform()
  const info = await Engine.info()
  const device = await Host.device()
  const docs = info.documents
  const out = `${docs}/selftest-out`
  const work = `${info.cache}/selftest-work`
  // A report from an earlier run must not be taken for this one's.
  await Host.remove({ path: `${docs}/selftest.json` })
  await Host.remove({ path: out })
  await Host.remove({ path: work })
  await Host.writeText({ path: `${out}/.made`, text: '' })
  await Host.writeText({ path: `${work}/.made`, text: '' })
  const media = (await Host.prepareMedia()).dir
  const expect = JSON.parse((await Host.readText({ path: `${media}/expect.json` })).text) as Expected
  const h264 = platform === 'ios' ? 'h264_videotoolbox' : 'h264_mediacodec'
  const hevc = platform === 'ios' ? 'hevc_videotoolbox' : 'hevc_mediacodec'
  const dirs: Record<string, string> = { media, fonts: `${media}/fonts`, work, out, h264, hevc }

  async function check(name: string, fn: () => Promise<Outcome>): Promise<void> {
    say(`... ${name}`)
    await Host.writeText({ path: `${docs}/selftest-progress.txt`, text: `${new Date().toISOString()} ${name}\n` })
    const start = performance.now()
    let res: Outcome
    try {
      res = await timeout(fn(), CHECK_TIMEOUT_MS, name)
    } catch (e) {
      res = { ok: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` }
    }
    const c: Check = { name, ok: res.ok, ms: Math.round(performance.now() - start), detail: res.detail }
    if (res.skipped) c.skipped = true
    if (res.data !== undefined) c.data = res.data
    checks.push(c)
    say(`${c.skipped ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'} ${name} (${c.ms} ms): ${c.detail}`)
  }

  // ---- What the build has -------------------------------------------------

  await check('info', async () => {
    const problems: string[] = []
    if (info.platform !== platform) problems.push(`platform ${info.platform}, running on ${platform}`)
    if (info.ffmpegVersion !== '6.0') problems.push(`ffmpeg ${info.ffmpegVersion}, not 6.0`)
    if (!/^1\.8\./.test(info.whisperVersion)) problems.push(`whisper ${info.whisperVersion}, not 1.8.x`)
    const needed = platform === 'ios' ? ['h264_videotoolbox', 'hevc_videotoolbox'] : ['h264_mediacodec']
    for (const e of [...needed, 'libwebp', 'png', 'mjpeg']) if (!info.encoders.includes(e)) problems.push(`no ${e}`)
    if (!info.documents.startsWith('/') || !info.cache.startsWith('/')) problems.push('folders are not absolute paths')
    const hardware = info.encoders.filter((e) => /videotoolbox|mediacodec/.test(e))
    numbers.hardwareEncoders = hardware
    numbers.videoEncoders = info.encoders.length
    return {
      ok: problems.length === 0,
      detail: problems.join('; ') || `ffmpeg ${info.ffmpegVersion}, whisper ${info.whisperVersion}, hardware: ${hardware.join(', ')}; ${info.encoders.length} video encoders in all`,
      data: info
    }
  })

  await check('ffmpeg build (stdout as on the command line)', async () => {
    const problems: string[] = []
    const version = await run('ffmpeg', ['-version'])
    if (!/^ffmpeg version 6\.0 /.test(version.stdout)) problems.push(`-version says ${version.stdout.split('\n')[0]}`)
    const conf = await run('ffmpeg', ['-hide_banner', '-buildconf'])
    for (const want of ['--enable-libass', '--enable-libfreetype', '--enable-libfribidi', '--enable-libzimg', '--enable-libwebp', '--enable-libdav1d', '--enable-libopus'])
      if (!conf.stdout.includes(want)) problems.push(`not built with ${want}`)
    for (const never of ['--enable-gpl', '--enable-nonfree', 'libx264', 'libx265'])
      if (conf.stdout.includes(never)) problems.push(`built with ${never}`)
    const filters = await run('ffmpeg', ['-hide_banner', '-filters'])
    const has = (f: string): boolean => new RegExp(` ${f} `).test(filters.stdout)
    // The desktop renderer's, what src/main/intake.ts hasZscale reads, and
    // every filter the app's phone path records (phase 1), the blurred
    // background fill's gblur among them.
    const wanted = [
      'zscale', 'subtitles', 'ass', 'lut3d', 'lut1d', 'xfade', 'overlay', 'amix', 'sidechaincompress', 'loudnorm',
      'atempo', 'acrossfade', 'tonemap', 'colorchannelmixer', 'alimiter', 'afftdn', 'freezedetect', 'ebur128', 'zoompan',
      'acompressor', 'adelay', 'afade', 'aformat', 'anoisesrc', 'anull', 'apad', 'aresample', 'asendcmd', 'asetnsamples',
      'asetpts', 'astats', 'atrim', 'concat', 'crop', 'deesser', 'equalizer', 'fade', 'format', 'fps', 'highpass',
      'lowpass', 'noise', 'null', 'pan', 'scale', 'setpts', 'setsar', 'settb', 'split', 'tpad', 'trim', 'unsharp',
      'vignette', 'volume', 'volumedetect', 'gblur', 'pad', 'asplit'
    ]
    const missing = wanted.filter((f) => !has(f))
    if (missing.length) problems.push(`no ${missing.join(', ')} filter`)
    // GPL-only filters must not be here. The desktop's camera moves use
    // perspective (src/main/render/camera.ts), and its background fill may
    // use boxblur or eq: on the phone those need gblur, colorchannelmixer,
    // scale and crop instead.
    const gpl = ['perspective', 'eq', 'boxblur', 'hqdn3d', 'cropdetect'].filter(has)
    if (gpl.length) problems.push(`GPL-only filters in an LGPL build: ${gpl.join(', ')}`)
    numbers.filtersChecked = wanted.length
    return {
      ok: problems.length === 0 && version.code === 0 && filters.code === 0,
      detail:
        problems.join('; ') ||
        `LGPL build: ${conf.stdout.split('\n').filter((l) => l.includes('--enable-lib')).length} external libraries; all ${wanted.length} filters the renderer and the app use; no perspective, boxblur or eq (GPL-only)`
    }
  })

  await check('the codecs and formats the app uses', async () => {
    // Each list printed by ffmpeg, its names taken from the second column.
    const list = async (what: string): Promise<Set<string>> => {
      const r = await run('ffmpeg', ['-hide_banner', `-${what}`])
      return new Set(r.stdout.split('\n').map((l) => l.trim().split(/\s+/)[1]).filter(Boolean))
    }
    const encoders = await list('encoders')
    const decoders = await list('decoders')
    const muxers = await list('muxers')
    const demuxers = await list('demuxers')
    const want: Record<string, [Set<string>, string[]]> = {
      encoders: [encoders, ['aac', 'pcm_s16le', 'pcm_f32le', 'rawvideo', 'flac', 'mjpeg', 'libopus', 'png', 'libwebp', h264]],
      decoders: [decoders, ['h264', 'hevc', 'aac', 'alac', 'opus', 'amrnb', 'amrwb', 'mjpeg', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'flac', 'mp3float', 'vorbis', 'prores', 'png', 'webp', 'libdav1d']],
      muxers: [muxers, ['mp4', 'mov', 'ipod', 'matroska', 'wav', 'segment', 'f32le', 'rawvideo', 'null', 'image2', 'flac', 'ogg', 'opus', 'webm']],
      demuxers: [demuxers, ['mov,mp4,m4a,3gp,3g2,mj2', 'matroska,webm', 'wav', 'ogg', 'flac', 'mp3', 'aac', 'amr', 'image2', 'concat', 'f32le', 'rawvideo', 'avi']]
    }
    const problems: string[] = []
    for (const [what, [have, names]] of Object.entries(want)) {
      const lacking = names.filter((n) => !have.has(n))
      if (lacking.length) problems.push(`no ${lacking.join(', ')} among the ${what}`)
    }
    return {
      ok: problems.length === 0,
      detail:
        problems.join('; ') ||
        `encoders ${want.encoders[1].join(', ')}; decoders ${want.decoders[1].join(', ')}; muxers ${want.muxers[1].join(', ')}; demuxers ${want.demuxers[1].join(', ')}`
    }
  })

  // ---- ffprobe ---------------------------------------------------------------

  const probes: Record<string, string> = {}
  for (const [name, want] of Object.entries(expect.probe)) {
    await check(`probe ${name}`, async () => {
      const p = await probe(`${media}/${name}`)
      probes[name] = p.stdout
      const got = p.facts
      const problems: string[] = []
      if (Math.abs(got.duration - want.duration) > 0.05) problems.push(`duration ${got.duration}, expected ${want.duration}`)
      for (const k of ['codec', 'width', 'height', 'pix_fmt', 'rotation', 'color_transfer', 'color_primaries'] as const) {
        const a = got.video?.[k] ?? null
        const b = want.video?.[k] ?? null
        if (a !== b) problems.push(`video ${k} ${a}, expected ${b}`)
      }
      for (const k of ['codec', 'sample_rate', 'channels'] as const) {
        const a = got.audio?.[k] ?? null
        const b = want.audio?.[k] ?? null
        if (a !== b) problems.push(`audio ${k} ${a}, expected ${b}`)
      }
      // And as the desktop app reads it (src/main/intake.ts readProbe).
      const read = readProbe(p.json as Parameters<typeof readProbe>[0])
      if (name === 'hevc_portrait.mov' && !(read.width === 1080 && read.height === 1920 && read.rotation === 270))
        problems.push(`the app would read it as ${read.width}x${read.height} turned ${read.rotation}`)
      if (name === 'hlg_10bit.mov' && !(read.color === 'hlg' && read.bitDepth === 10))
        problems.push(`the app would read it as ${read.color}, ${read.bitDepth}-bit`)
      return {
        ok: problems.length === 0,
        detail: problems.join('; ') || `${got.video ? `${got.video.codec} ${got.video.width}x${got.video.height}${got.video.rotation ? ` rotation ${got.video.rotation}` : ''}${got.video.color_transfer ? ` ${got.video.color_transfer}` : ''} ` : ''}${got.audio ? `${got.audio.codec} ${got.audio.sample_rate} Hz ` : ''}${got.duration} s; the app reads ${read.width}x${read.height}, ${read.color}`,
        data: { facts: got, read }
      }
    })
  }

  await check('probes at once', async () => {
    const names = ['h264_1080p.mp4', 'hevc_portrait.mov', 'hlg_10bit.mov', 'speech.wav', 'still.webp', 'music.m4a']
    const runs = await Promise.all(names.map((n) => run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', `${media}/${n}`])))
    const problems: string[] = []
    runs.forEach((r, i) => {
      if (r.code !== 0) problems.push(`${names[i]} exited ${r.code}`)
      else if (probes[names[i]] !== undefined && r.stdout !== probes[names[i]]) problems.push(`${names[i]} printed something else at once than alone`)
      // Its lines, as 'line' events, are its stdout.
      if (stdoutLines(r).join('\n') !== r.stdout.replace(/\n$/, '')) problems.push(`${names[i]}'s lines are not its stdout`)
      if (r.lines.some((l) => l.id !== r.id)) problems.push(`${names[i]} heard another run's lines`)
    })
    return {
      ok: problems.length === 0,
      detail: problems.join('; ') || `${names.length} probes at once, each printing what it prints alone, ${runs.reduce((n, r) => n + r.lines.length, 0)} lines, none crossed`
    }
  })

  // ---- Renders -------------------------------------------------------------

  const renders: RenderSpec[] = [
    ...(specs.renders as RenderSpec[]),
    ...desktopRenders.renders.map((r) => ({
      ...(r as unknown as RenderSpec),
      ...(specs.desktop as Record<string, Partial<RenderSpec>>)[r.name],
      desktop: true
    }))
  ]
  for (const spec of renders) {
    await check(`render ${spec.name}`, async () => {
      if (spec.needs === 'hevc' && !info.encoders.includes(hevc))
        return { ok: true, skipped: true, detail: `${hevc} is not on this device` }
      for (const [file, text] of Object.entries(spec.files ?? {}))
        await Host.writeText({ path: `${work}/${file}`, text: fill(text, dirs) })
      const expand = (list: string[]): string[] =>
        list.flatMap((a) => (a === '{exportVideo}' ? exportVideo(platform) : [fill(a, dirs)]))
      for (const pre of spec.pre ?? []) {
        const p = await run('ffmpeg', expand(pre))
        if (p.code !== 0) return { ok: false, detail: `a run before it exited ${p.code}: ${p.stderr.trim().split('\n').slice(-4).join(' | ')}` }
      }
      let args = expand(spec.args)
      if (spec.desktop) args = useHardwareEncoder(args, h264)
      const r = await run('ffmpeg', args)
      const path = `${out}/${spec.output}`
      if (r.code !== 0) return { ok: false, detail: `exited ${r.code}: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}` }
      const problems: string[] = []
      for (const want of spec.stderrIncludes ?? []) if (!r.stderr.includes(want)) problems.push(`stderr lacks "${want}"`)
      const want = expect.renders[spec.name]
      const probed = await probe(path)
      const got = probed.facts
      if (want.facts.video || got.video) {
        for (const k of ['codec', 'width', 'height'] as const)
          if ((got.video?.[k] ?? null) !== (want.facts.video?.[k] ?? null))
            problems.push(`video ${k} ${got.video?.[k]}, expected ${want.facts.video?.[k]}`)
        if (got.video && /arib|smpte2084/.test(got.video.color_transfer ?? '')) problems.push(`still tagged ${got.video.color_transfer}`)
      }
      if (!!got.audio !== !!want.facts.audio) problems.push(got.audio ? 'has sound, expected none' : 'no sound')
      if (got.audio && want.facts.audio && got.audio.sample_rate !== want.facts.audio.sample_rate)
        problems.push(`sound at ${got.audio.sample_rate} Hz, expected ${want.facts.audio.sample_rate}`)
      if (got.audio && want.facts.audio && got.audio.codec !== want.facts.audio.codec)
        problems.push(`sound in ${got.audio.codec}, expected ${want.facts.audio.codec}`)
      if (spec.bytesBetween && !(got.bytes >= spec.bytesBetween[0] && got.bytes <= spec.bytesBetween[1]))
        problems.push(`${got.bytes} bytes, expected ${spec.bytesBetween[0]} to ${spec.bytesBetween[1]}`)
      let keyframes: number[] | undefined
      if (spec.keyframesWithin) {
        keyframes = await keyframeTimes(path)
        const ends = [...keyframes, got.duration]
        const gap = Math.max(...ends.slice(1).map((t, i) => t - ends[i]))
        if (keyframes.length < 2 || gap > spec.keyframesWithin)
          problems.push(`keyframes at ${keyframes.join(', ')} s: ${round(gap, 2)} s apart at most, asked for ${spec.keyframesWithin}`)
      }
      const profile = (probed.json.streams ?? []).find((s) => s.codec_type === 'video')?.profile
      if (spec.profileOnIos && platform === 'ios' && profile !== spec.profileOnIos)
        problems.push(`profile ${profile}, expected ${spec.profileOnIos}`)
      if (want.facts.duration > 0 && Math.abs(got.duration - want.facts.duration) > 0.12)
        problems.push(`${got.duration} s long, expected ${want.facts.duration}`)
      const tolerance = spec.tolerance ?? 16
      const colours: number[][] = []
      for (const [i, s] of (spec.samples ?? []).entries()) {
        const c = await meanColour(path, s.t, s.x, s.y, s.w, s.h)
        colours.push(c)
        if (!colourClose(c, want.samples[i], tolerance))
          problems.push(`at ${s.t} s (${s.x},${s.y}) rgb ${c.join(',')}, expected ${want.samples[i].join(',')} within ${tolerance}`)
      }
      let lufs: number | undefined
      if (spec.loudness) {
        lufs = await loudness(path)
        if (want.loudness === undefined || Math.abs(lufs - want.loudness) > 1.5)
          problems.push(`${lufs} LUFS, expected ${want.loudness}`)
      }
      return {
        ok: problems.length === 0,
        detail:
          problems.join('; ') ||
          `${got.video ? `${got.video.codec}${profile ? ` (${profile})` : ''} ${got.video.width}x${got.video.height} ` : ''}${got.audio ? `${got.audio.codec} ` : ''}${got.duration} s, ${got.bytes} bytes, in ${round(r.ms / 1000, 2)} s; ${colours.length} colours as on the runner${lufs !== undefined ? `, ${lufs} LUFS` : ''}${keyframes ? `; keyframes at ${keyframes.join(', ')} s` : ''}`,
        data: { args, facts: got, profile, colours, lufs, keyframes, ms: Math.round(r.ms) }
      }
    })
  }

  // ---- Raw output, as the app writes it: segment files, never stdout ----------------

  const part = (dir: string, i: number, ext: string): string => `${dir}/part${String(i).padStart(6, '0')}.${ext}`
  async function partSizes(dir: string, ext: string): Promise<number[]> {
    const sizes: number[] = []
    for (let i = 0; i < 100; i++) {
      const f = await Host.fileSize({ path: part(dir, i, ext) })
      if (!f.exists) break
      sizes.push(f.bytes)
    }
    return sizes
  }

  await check('raw sound in segment files (pcm_f32le, segment, f32le)', async () => {
    // As the app writes a long recording's sound: <cache>/cutalong/cutalong-raw-*/part%06d.f32le.
    const dir = `${info.cache}/cutalong/cutalong-raw-selftest-sound`
    await Host.remove({ path: dir })
    await Host.writeText({ path: `${dir}/.made`, text: '' })
    // 65 s of the music, looped: two whole 30 s parts and a short one.
    const r = await run('ffmpeg', [
      '-hide_banner', '-y', '-stream_loop', '-1', '-t', '65', '-i', `${media}/music.m4a`,
      '-map', '0:a:0', '-c:a', 'pcm_f32le', '-f', 'segment', '-segment_format', 'f32le', '-segment_time', '30', `${dir}/part%06d.f32le`
    ])
    if (r.code !== 0) return { ok: false, detail: `exited ${r.code}: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}` }
    const sizes = await partSizes(dir, 'f32le')
    const second = 48000 * 2 * 4
    const secs = sizes.map((b) => round(b / second, 3))
    const total = round(sizes.reduce((a, b) => a + b, 0) / second, 3)
    const problems: string[] = []
    if (sizes.length !== 3) problems.push(`${sizes.length} parts, expected 3`)
    if (Math.abs((secs[0] ?? 0) - 30) > 0.1 || Math.abs((secs[1] ?? 0) - 30) > 0.1) problems.push(`parts of ${secs.join(', ')} s`)
    // Each pass of a looped AAC file loses its priming, so 65 s asked comes out a little short.
    if (Math.abs(total - 65) > 0.5) problems.push(`${total} s in all, expected 65`)
    // What is in them is the music: three tones at 0.1 each, about -18.2 dB.
    const level = sizes.length > 1 ? await meanVolume(['-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', part(dir, 1, 'f32le')]) : NaN
    if (!(Math.abs(level + 18.2) < 1.5)) problems.push(`the second part is at ${level} dB, expected about -18.2`)
    return {
      ok: problems.length === 0,
      detail: problems.join('; ') || `${sizes.length} parts of ${secs.join(', ')} s (${total} s, ${sizes.reduce((a, b) => a + b, 0)} bytes), the music at ${level} dB, in ${round(r.ms / 1000, 2)} s`
    }
  })

  await check('raw video in segment files (rawvideo, segment)', async () => {
    const dir = `${info.cache}/cutalong/cutalong-raw-selftest-video`
    await Host.remove({ path: dir })
    await Host.writeText({ path: `${dir}/.made`, text: '' })
    const r = await run('ffmpeg', [
      '-hide_banner', '-y', '-i', `${media}/h264_1080p.mp4`, '-map', '0:v:0', '-vf', 'fps=10,scale=64:36,format=rgb24',
      '-c:v', 'rawvideo', '-f', 'segment', '-segment_format', 'rawvideo', '-segment_time', '2', `${dir}/part%06d.rgb`
    ])
    if (r.code !== 0) return { ok: false, detail: `exited ${r.code}: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}` }
    const sizes = await partSizes(dir, 'rgb')
    const frame = 64 * 36 * 3
    const frames = sizes.map((b) => b / frame)
    const problems: string[] = []
    if (sizes.length !== 5 || frames.some((n) => n !== 20)) problems.push(`parts of ${frames.join(', ')} frames, expected 5 of 20`)
    // The third part starts at 4 s, whose colour is 2040E0 (make_media.py).
    const colour = sizes.length > 2 ? await meanColourOf(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '64x36', '-i', part(dir, 2, 'rgb')]) : []
    if (!colourClose(colour, [0x20, 0x40, 0xe0], 16)) problems.push(`the third part starts rgb ${colour.join(',')}, expected 32,64,224`)
    return {
      ok: problems.length === 0,
      detail: problems.join('; ') || `${sizes.length} parts of ${frames.join(', ')} frames of 64x36 RGB, the third starting rgb ${colour.join(',')}, in ${round(r.ms / 1000, 2)} s`
    }
  })

  // ---- whisper ---------------------------------------------------------------

  // Where the app keeps its models (phase 1: <Documents>/Cutalong/models).
  const models = `${docs}/Cutalong/models`
  const truth = JSON.parse((await Host.readText({ path: `${media}/speech-truth.json` })).text) as {
    durationSec: number
    words: { text: string; startSec: number; endSec: number }[]
  }

  /**
   * Runs whisper as the app does, with the desktop's own arguments
   * (src/main/whisper-args.ts) and reads <prefix>.json with its parser
   * (src/main/whisper-parse.ts); then scores the words against what the
   * speech says, and when.
   */
  async function transcribe(model: 'base.en' | 'small.en', verbatim: boolean, key: string): Promise<Outcome> {
    const modelFile = `${models}/ggml-${model}.bin`
    if (!(await Host.fileSize({ path: modelFile })).exists) return { ok: false, detail: `no model at ${modelFile}` }
    const prefix = `${out}/speech-${model}${verbatim ? '-verbatim' : ''}`
    const args = whisperArgs({ model, modelFile, wav: `${media}/speech.wav`, prefix, verbatim: verbatim ? { names: ['Cutalong'] } : undefined })
    let progress = 0
    const r = await run('whisper', args, { onLine: (l) => void (/progress =/.test(l.line) && progress++) })
    if (r.code !== 0) return { ok: false, detail: `exited ${r.code}: ${r.stderr.trim().split('\n').slice(-4).join(' | ')}` }
    const json = parseWhisperJson((await Host.readText({ path: `${prefix}.json` })).text)
    const words = tokensToWords(json.transcription)
    const said = truth.words.filter((w) => wordsOf(w.text)[0])
    const want = said.map((w) => wordsOf(w.text)[0])
    const got = words.map((w) => wordsOf(w.text)[0] ?? '')
    const { matched, pairs } = inOrder(want, got)
    const errors = pairs.map(([i, j]) => Math.abs(words[j].startSec - said[i].startSec)).sort((a, b) => a - b)
    const median = errors.length ? errors[Math.floor(errors.length / 2)] : Infinity
    const ordered = words.every((w, i) => w.endSec >= w.startSec && (i === 0 || w.startSec >= words[i - 1].startSec - 0.01))
    const inside = words.every((w) => w.startSec >= 0 && w.endSec <= truth.durationSec + 0.5)
    const tokens = json.transcription.flatMap((s) => s.tokens ?? []).filter((t) => !/^\[_/.test(t.text))
    const aligned = tokens.filter((t) => typeof t.t_dtw === 'number' && t.t_dtw >= 0).length
    const backend = stderrLines(r).find((l) => /whisper_backend_init_gpu|using .* backend|no GPU found/i.test(l)) ?? ''
    const system = stderrLines(r).find((l) => l.startsWith('system_info')) ?? ''
    numbers[`${key}Seconds`] = round(r.ms / 1000, 2)
    numbers[`${key}Realtime`] = round(truth.durationSec / (r.ms / 1000), 2)
    numbers[`${key}Matched`] = `${matched} of ${want.length}`
    numbers[`${key}MedianStartError`] = round(median, 3)
    numbers[`${key}Words`] = words.map((w) => w.text).join(' ')
    if (!numbers.whisperBackend) numbers.whisperBackend = backend
    if (!numbers.whisperSystem) numbers.whisperSystem = system
    const problems: string[] = []
    if (matched / want.length < 0.8) problems.push(`heard ${matched} of ${want.length} words in order`)
    if (!(median < 0.6)) problems.push(`words start ${round(median, 2)} s from where they are said (median)`)
    if (!ordered) problems.push('word times go backwards')
    if (!inside) problems.push('word times fall outside the recording')
    if (progress === 0) problems.push('no progress lines')
    // -ojf and --dtw: every token with its aligned onset.
    if (verbatim && !(tokens.length > 0 && aligned / tokens.length > 0.8)) problems.push(`${aligned} of ${tokens.length} tokens have aligned onsets`)
    return {
      ok: problems.length === 0,
      detail:
        problems.join('; ') ||
        `${matched} of ${want.length} words in order in ${round(r.ms / 1000, 1)} s (${numbers[`${key}Realtime`]}x real time), starts ${round(median, 2)} s from the truth (median)${verbatim ? `, ${aligned} of ${tokens.length} tokens aligned` : ''}, ${progress} progress lines: "${words.map((w) => w.text).join(' ')}"`,
      data: { args, words, ms: Math.round(r.ms), backend, system }
    }
  }

  await check('whisper base.en for captions (-oj)', () => transcribe('base.en', false, 'whisper'))
  await check("whisper base.en as the app calls it (-ojf, prompt, --dtw, -nfa)", () => transcribe('base.en', true, 'whisperVerbatim'))
  await check("whisper small.en as the app calls it (-ojf, prompt, --dtw, -nfa)", () => transcribe('small.en', true, 'whisperSmall'))

  // ---- Cancel ----------------------------------------------------------------

  await check('cancel a long render', async () => {
    const running = run(
      'ffmpeg',
      ['-hide_banner', '-y', '-filter_complex', 'testsrc2=size=1920x1080:rate=30:duration=600[v];sine=duration=600[a]', '-map', '[v]', '-map', '[a]', '-c:v', h264, '-b:v', '8M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', `${work}/cancelled.mp4`],
      { id: 'long-render' }
    )
    await sleep(1000)
    const asked = performance.now()
    await Engine.cancel({ id: 'long-render' })
    const r = await running
    const stopped = performance.now() - asked
    numbers.cancelStopMs = Math.round(stopped)
    const frames = [...r.stderr.matchAll(/frame=\s*(\d+)/g)].map((m) => Number(m[1]))
    return {
      ok: r.code === 255 && stopped < 1500,
      detail: `exit ${r.code} ${Math.round(stopped)} ms after the cancel${frames.length ? `, after ${frames[frames.length - 1]} frames` : ''}`
    }
  })

  // ---- A 60 s 1080p render: time and memory -----------------------------------

  const backgrounds = ['3060C0', 'C03060', '30C060', 'C0C030', '6030C0', '30C0C0']
  const source60 = `${work}/source60.mp4`
  const export60 = `${out}/export60.mp4`
  await check('make a 60 s 1080p recording (hardware encoder)', async () => {
    const colours = backgrounds.map((c, i) => `color=c=0x${c}:s=1920x1080:r=30:d=10[b${i}]`).join(';')
    const joins = backgrounds.map((_, i) => `[b${i}]`).join('')
    const r = await run('ffmpeg', [
      '-hide_banner', '-y', '-filter_complex',
      `${colours};${joins}concat=n=6:v=1:a=0[bg];testsrc2=size=640x360:rate=30:duration=60[box];[bg][box]overlay=80:80,format=yuv420p[v];sine=frequency=220:duration=60:sample_rate=48000,aformat=channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', h264, '-b:v', '12M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', source60
    ])
    numbers.encode60Seconds = round(r.ms / 1000, 1)
    return { ok: r.code === 0, detail: r.code === 0 ? `in ${round(r.ms / 1000, 1)} s (${round(60 / (r.ms / 1000), 2)}x real time)` : `exited ${r.code}: ${r.stderr.slice(-300)}` }
  })

  await check('render 60 s of 1080p (captions, logo, loudness, hardware encoder)', async () => {
    const words = Array.from({ length: 110 }, (_, i) => ({ text: `word${i + 1}`, startSec: 0.5 + i * 0.5, endSec: 0.9 + i * 0.5 }))
    await Host.writeText({ path: `${work}/captions60.ass`, text: buildAss(words, 1920, 1080, DEFAULT_CAPTION_STYLE) })
    const baseline = await Host.memory()
    // Android can start its peak afresh; iOS cannot, so there the samples are all there is.
    const reset = (await Host.resetPeakMemory()).reset
    let peak = baseline.residentBytes
    let polling = true
    const poll = (async () => {
      while (polling) {
        try {
          peak = Math.max(peak, (await Host.memory()).residentBytes)
        } catch {
          // A sample missed is not a failure.
        }
        await sleep(250)
      }
    })()
    const r = await run('ffmpeg', [
      '-hide_banner', '-y', '-nostats', '-progress', 'pipe:1', '-i', source60, '-i', `${media}/logo.png`,
      '-filter_complex',
      // Sound ends in aformat, as the desktop's does: in ffmpeg 6.0 loudnorm
      // then aresample straight into aac cannot agree on a channel layout.
      `[0:v]subtitles='${forFilter(`${work}/captions60.ass`)}':fontsdir='${forFilter(`${media}/fonts`)}'[s];[s][1:v]overlay=x=W-w-40:y=40,format=yuv420p[v];[0:a]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a]`,
      '-map', '[v]', '-map', '[a]', '-c:v', h264, '-b:v', '10M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', export60
    ])
    polling = false
    await poll
    const after = await Host.memory()
    peak = Math.max(peak, after.residentBytes, reset ? after.peakBytes : 0)
    const progress = stdoutLines(r).filter((l) => l.startsWith('progress=')).length
    // The app shows an export's progress from these lines as they come: they
    // must arrive while the render runs, not all at its end.
    const arrivals = r.lines.filter((l) => l.stream === 'stdout' && l.line.startsWith('progress=')).map((l) => l.at)
    const early = arrivals.filter((at) => at < r.ms - 2000).length
    numbers.render60ProgressLines = progress
    numbers.render60FirstProgressMs = arrivals.length ? Math.round(arrivals[0]) : null
    const facts = r.code === 0 ? (await probe(export60)).facts : null
    numbers.render60Seconds = round(r.ms / 1000, 1)
    numbers.render60Realtime = round(60 / (r.ms / 1000), 2)
    numbers.render60BaselineMB = Math.round(baseline.residentBytes / 1048576)
    numbers.render60PeakMB = Math.round(peak / 1048576)
    numbers.render60PeakFrom = reset ? 'the kernel peak (VmHWM) since the render began, and samples every 250 ms' : 'samples every 250 ms (phys_footprint)'
    numbers.render60Bytes = facts?.bytes
    const problems: string[] = []
    if (r.code !== 0) problems.push(`exited ${r.code}: ${r.stderr.slice(-300)}`)
    if (facts && Math.abs(facts.duration - 60) > 0.2) problems.push(`${facts.duration} s long`)
    if (facts && (facts.video?.width !== 1920 || facts.video?.height !== 1080)) problems.push(`${facts.video?.width}x${facts.video?.height}`)
    if (!progress) problems.push('no -progress lines on stdout')
    else if (early < Math.min(5, progress - 1) || arrivals[0] > r.ms / 2)
      problems.push(`progress lines came late: ${early} of ${progress} more than 2 s before the end, the first after ${Math.round(arrivals[0])} ms of ${Math.round(r.ms)}`)
    return {
      ok: problems.length === 0,
      detail:
        problems.join('; ') ||
        `${round(r.ms / 1000, 1)} s (${numbers.render60Realtime}x real time), memory ${numbers.render60BaselineMB} MB before, ${numbers.render60PeakMB} MB at the peak; ${round((facts?.bytes ?? 0) / 1048576, 1)} MB out; ${progress} progress reports as it ran, the first after ${Math.round(arrivals[0])} ms`
    }
  })

  // ---- Preview: the WebView plays local files and seeks -------------------------

  /**
   * Plays a file in a <video> from Capacitor.convertFileSrc, as the app's
   * preview does, seeks, and reads the colour of a region of the frame
   * (x, y, w, h as fractions of the picture) from a canvas.
   */
  async function seekAndLook(path: string, t: number, want: number[], region = { x: 0.45, y: 0.4, w: 0.1, h: 0.2 }): Promise<Outcome> {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.src = Capacitor.convertFileSrc(path)
    document.getElementById('stage')?.appendChild(video)
    const once = (event: string, ms: number): Promise<void> =>
      timeout(
        new Promise<void>((resolve, reject) => {
          video.addEventListener(event, () => resolve(), { once: true })
          video.addEventListener('error', () => reject(new Error(`video error ${video.error?.code}: ${video.error?.message}`)), { once: true })
        }),
        ms,
        `${event} on ${path}`
      )
    try {
      const loading = performance.now()
      if (video.readyState < 1) await once('loadedmetadata', 20000)
      const loadMs = performance.now() - loading
      let played = 'played'
      try {
        await video.play()
        const playing = performance.now()
        while (video.currentTime < 0.3 && performance.now() - playing < 10000) await sleep(50)
        if (video.currentTime < 0.3) played = `stalled at ${round(video.currentTime, 2)} s`
        video.pause()
      } catch (e) {
        played = `would not play (${e instanceof Error ? e.name : String(e)})`
      }
      const seekAsked = performance.now()
      const seeked = once('seeked', 20000)
      video.currentTime = t
      await seeked
      const seekMs = performance.now() - seekAsked
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
      const W = 192
      const H = 108
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      ctx.drawImage(video, 0, 0, W, H)
      const px = ctx.getImageData(Math.round(region.x * W), Math.round(region.y * H), Math.round(region.w * W), Math.round(region.h * H)).data
      const rgb = [0, 1, 2].map((k) => {
        let sum = 0
        for (let i = k; i < px.length; i += 4) sum += px[i]
        return Math.round(sum / (px.length / 4))
      })
      const ranges = (r: TimeRanges): string => Array.from({ length: r.length }, (_, i) => `${round(r.start(i))}-${round(r.end(i))}`).join(',')
      const ok = played === 'played' && Math.abs(video.currentTime - t) < 0.1 && colourClose(rgb, want, 30)
      return {
        ok,
        detail: `${played}; metadata in ${Math.round(loadMs)} ms; at ${round(video.currentTime, 2)} s (asked ${t}) ${Math.round(seekMs)} ms after the seek, rgb ${rgb.join(',')} (expected ${want.join(',')}); duration ${round(video.duration)} s, buffered ${ranges(video.buffered)}, seekable ${ranges(video.seekable)}; ${video.src}`,
        data: { rgb, currentTime: video.currentTime, seekMs, loadMs, played, src: video.src }
      }
    } finally {
      video.removeAttribute('src')
      video.load()
      video.remove()
    }
  }

  await check('preview: play and seek a local file in the WebView', async () => {
    const r = await seekAndLook(`${media}/${expect.preview.file}`, expect.preview.t, expect.preview.rgb)
    numbers.previewSeekMs = Math.round((r.data as { seekMs: number } | undefined)?.seekMs ?? -1)
    return r
  })

  await check('preview: seek deep into the 60 s export (range requests)', async () => {
    const size = await Host.fileSize({ path: export60 })
    if (!size.exists) return { ok: false, detail: 'no 60 s export to play' }
    const hex = backgrounds[4]
    const want = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
    // Low in the middle: clear of the captions, the logo and the moving box.
    const r = await seekAndLook(export60, 45, want, { x: 0.45, y: 0.78, w: 0.1, h: 0.12 })
    numbers.previewDeepSeekMs = Math.round((r.data as { seekMs: number } | undefined)?.seekMs ?? -1)
    return { ...r, detail: `${r.detail}; file ${round(size.bytes / 1048576, 1)} MB` }
  })

  // ---- Photos and the importer -------------------------------------------------

  await check('saveToPhotos', async () => {
    const r = await Engine.saveToPhotos({ path: `${out}/trim-scale-crop-pad.mp4` })
    return { ok: r.saved, detail: r.saved ? 'saved' : `not saved: ${r.message}` }
  })

  await check('the importer copies a file in whole', async () => {
    const source = `${out}/xfade.mp4`
    const size = await Host.fileSize({ path: source })
    const copied = platform === 'android' ? await Host.galleryRoundTrip({ path: source }) : await Host.importFile({ path: source })
    // Run again on the same phone, the gallery and the importer number the name: "xfade (1).mp4".
    const ok = copied.bytes === size.bytes && /^xfade( \(\d+\))?\.mp4$/.test(copied.name) && copied.path !== source
    return {
      ok,
      detail: `${copied.name}, ${copied.bytes} of ${size.bytes} bytes, now at ${copied.path}${'uri' in copied ? ` (from ${(copied as { uri: string }).uri})` : ''}`
    }
  })

  const passed = checks.filter((c) => c.ok && !c.skipped).length
  const failed = checks.filter((c) => !c.ok).length
  const skipped = checks.filter((c) => c.skipped).length
  const report: Report = {
    ok: failed === 0,
    passed,
    failed,
    skipped,
    platform,
    device,
    info,
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    ms: Math.round(performance.now() - t0),
    numbers,
    checks
  }
  await Host.writeText({ path: `${docs}/selftest.json`, text: JSON.stringify(report, null, 1) })
  say(`${report.ok ? 'ALL PASSED' : `${failed} FAILED`}: ${passed} passed, ${failed} failed, ${skipped} skipped in ${round(report.ms / 1000)} s`)
  return report
}
